//! HTTP request handlers for the local API server.
//!
//! Each handler mirrors the corresponding endpoint in the Sambee Python
//! backend, producing identical JSON response shapes.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::{Path as FsPath, PathBuf};
use std::pin::Pin;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{OriginalUri, Path, Query, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use log::{info, warn};
use reqwest::{Client, Response as ReqwestResponse};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::JoinSet;
use tokio_util::io::{ReaderStream, SyncIoBridge};

use crate::http_client::{classify_proxy_auth_intercept, log_request_error, SambeeHttpClientStore};
use crate::{commands, show_pairing_success, show_pairing_window};

use super::archive::{
    build_local_archive_manifest_for_remote_target, build_local_archive_manifest_for_remote_target_with_cancellation,
    build_local_archive_manifest_with_cancellation, canonicalize_local_archive_member_roots, create_local_archive_relay_writer,
    create_local_archive_with_execution_plan_progress_and_state, create_local_extraction_root, create_temporary_local_archive,
    create_temporary_local_zip_selection, ensure_local_extraction_directory, local_archive_target_write_policy_from_wire,
    prepare_local_archive_target_output, project_local_archive_creation_manifest, resolve_companion_archive_inspection_topology_plan,
    resolve_companion_archive_topology_plan, stream_validated_local_archive_entry, validate_local_extraction_member_path,
    ArchiveCreationManifest, ArchiveCreationManifestState, ArchiveDirectoryListingPresentation, ArchiveInspectionCoordinator,
    ArchiveInspectionPlan, ArchiveInspectionPresentation, ArchiveMemberReadDelivery, ArchiveMemberReadPresentation,
    CompanionArchiveBinding, CompanionArchiveExecutionDriver, CompanionArchiveOperationKind, CompanionArchiveRelayPurpose,
    CompanionArchiveTopology, CompanionArchiveTopologyPlan, LocalArchiveCreationExecutionPlan, LocalArchiveCreationResult,
    LocalArchiveDirectoryOutput, LocalArchiveEntry, LocalArchiveError, LocalArchiveExtractionDestinationResult,
    LocalArchiveInspectionSource, LocalArchiveReadError, LocalArchiveRelayChunk, LocalArchiveTargetOutput, ARCHIVE_COPY_BUFFER_SIZE,
    TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED,
};
use super::archive_sessions::{
    ArchiveSessionCompletion, ArchiveSessionKind, ArchiveSessionManager, ArchiveSessionProgress, ArchiveSessionStatus, ArchiveSessionWork,
    ExpiredRelaySourceCapability, LiveLocalArchiveSourcePhase, LiveLocalArchiveSourceSession, PreparedLocalArchiveCreation,
    RelayLiveSourceDetails, ARCHIVE_SESSION_TIMEOUT,
};
use super::auth;
use super::drives;
use super::edit_locks::EDIT_LOCK_LOST_CODE;
use super::errors::{
    ApiError, ArchiveV2Error, ArchiveV2Json, ArchiveV2NoQuery, ArchiveV2Query, ARCHIVE_SOURCE_CHANGED_CODE,
    LOCAL_ARCHIVE_CREATION_PARTIAL_CODE, LOCAL_LINK_TARGET_ACCESS_DENIED_CODE, LOCAL_LINK_TARGET_MISSING_CODE,
    LOCAL_LINK_TARGET_UNMAPPED_DRIVE_CODE, LOCAL_LINK_TARGET_UNRESOLVABLE_CODE, LOCAL_LINK_TARGET_UNSUPPORTED_TYPE_CODE,
    PAIR_CONFIRMATION_PENDING_CODE, RECENT_FILE_NATIVE_LAUNCH_FAILED_CODE, RECENT_FILE_TARGET_MISSING_CODE,
    RECENT_FILE_TARGET_NOT_FILE_CODE,
};
use super::links::{resolve_activation_target, LinkResolutionError};
use super::models::*;
use super::pairing::{PairingInitiateError, PairingState};
use super::target_resolution::{
    resolve_target_mutation, resolve_target_mutation_attempt, ContentTransferPlan, TargetMutationAttempt, TargetResolutionDisposition,
    TargetResolutionPolicy, TargetSnapshot,
};
use super::{AppState, DownloadIntent};

/// Characters forbidden in file/directory names (matches backend validation).
const FORBIDDEN_NAME_CHARS: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
/// Prefix used by the frontend for synthetic local-drive connection IDs.
const LOCAL_DRIVE_PREFIX: &str = "local-drive:";
/// Maximum number of potentially blocking local target resolutions per batch.
const LINK_TARGET_RESOLUTION_CONCURRENCY: usize = 4;
const ARCHIVE_RELAY_IDEMPOTENCY_HEADER: &str = "Idempotency-Key";
const ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS: usize = 2;
const TRANSFER_RECEIPT_TTL: Duration = Duration::from_secs(5 * 60);
const TRANSFER_COPY_BUFFER_SIZE: usize = 1024 * 1024;
const ACTIVE_DOCUMENT_MIME_TYPES: &[&str] = &["text/html", "application/xhtml+xml", "image/svg+xml"];

fn is_active_document_mime_type(mime_type: &str) -> bool {
    ACTIVE_DOCUMENT_MIME_TYPES.contains(&mime_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase().as_str())
}

fn active_document_disposition(filename: &str) -> String {
    let encoded: String = filename
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect();
    format!("attachment; filename*=UTF-8''{encoded}")
}

struct TransferReceipt {
    expires_at: Instant,
    fingerprint: String,
    outcome: TransferReceiptOutcome,
}

#[derive(Clone)]
enum TransferReceiptOutcome {
    Result(ContentTransferResult),
    Error(TransferReceiptError),
}

#[derive(Clone)]
struct TransferReceiptError {
    status: StatusCode,
    detail: serde_json::Value,
    code: Option<&'static str>,
}

enum TransferReceiptEntry {
    Complete(TransferReceipt),
    InFlight {
        fingerprint: String,
        waiters: Vec<oneshot::Sender<TransferReceiptOutcome>>,
    },
}

enum TransferReceiptLookup {
    Owner,
    Cached(TransferReceiptOutcome),
    Wait(oneshot::Receiver<TransferReceiptOutcome>),
}

static TRANSFER_RECEIPTS: LazyLock<Mutex<HashMap<String, TransferReceiptEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static TRANSFER_CANCELLATIONS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(test)]
static INSPECTION_RESOLVER_CALL_COUNT: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static INSPECTION_RESOLVER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[cfg(any(windows, test))]
const WINDOWS_EXTENDED_PATH_PREFIX: &str = "\\\\?\\";
#[cfg(any(windows, test))]
const WINDOWS_EXTENDED_UNC_PATH_PREFIX: &str = "\\\\?\\UNC\\";
#[cfg(any(windows, test))]
const WINDOWS_UNC_PATH_PREFIX: &str = "\\\\";

fn resolve_companion_archive_topology(
    kind: CompanionArchiveOperationKind,
    source_is_local: bool,
    destination_is_local: bool,
) -> Result<CompanionArchiveTopology, ApiError> {
    resolve_companion_archive_topology_plan(kind, source_is_local, destination_is_local)
        .map(|plan| plan.topology)
        .map_err(map_local_archive_error)
}

fn require_archive_v2_contract_version(contract_version: ArchiveContractVersion) -> Result<(), ApiError> {
    if contract_version != ArchiveContractVersion::V2 {
        return Err(ApiError::BadRequest("Unsupported archive contract version".to_string()));
    }
    Ok(())
}

fn resolve_companion_inspection_coordinator(
    topology_plan: CompanionArchiveTopologyPlan,
    plan: ArchiveInspectionPlan,
) -> Result<ArchiveInspectionCoordinator, ApiError> {
    #[cfg(test)]
    INSPECTION_RESOLVER_CALL_COUNT.fetch_add(1, Ordering::Relaxed);
    if matches!(
        (
            topology_plan.kind,
            topology_plan.driver,
            topology_plan.topology,
            topology_plan.source_is_local,
            topology_plan.destination_is_local,
            topology_plan.binding,
        ),
        (
            CompanionArchiveOperationKind::Inspect,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::LocalInspection,
            true,
            None,
            CompanionArchiveBinding::LocalInspection,
        )
    ) {
        Ok(ArchiveInspectionCoordinator::from_plan(plan))
    } else {
        Err(ApiError::Internal(
            "Archive inspection topology did not resolve to a compatible Companion binding".to_string(),
        ))
    }
}

#[cfg(test)]
fn inspection_resolver_call_count() -> usize {
    INSPECTION_RESOLVER_CALL_COUNT.load(Ordering::Relaxed)
}

#[cfg(test)]
fn reset_inspection_resolver_call_count() {
    INSPECTION_RESOLVER_CALL_COUNT.store(0, Ordering::Relaxed);
}

fn resolve_local_archive_inspection_coordinator(
    archive_path: PathBuf,
    presentation: ArchiveInspectionPresentation,
) -> Result<ArchiveInspectionCoordinator, ApiError> {
    let topology_plan = resolve_companion_archive_inspection_topology_plan(true).map_err(map_local_archive_error)?;
    let plan = ArchiveInspectionPlan::from_local_source(LocalArchiveInspectionSource::from_archive_path(archive_path), presentation)
        .map_err(map_local_archive_read_error)?;
    resolve_companion_inspection_coordinator(topology_plan, plan)
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

/// Query parameters for WebSocket authentication.
///
/// The browser WebSocket API does not support custom headers, so HMAC
/// credentials are passed as query parameters on the upgrade request.
#[derive(Deserialize)]
pub struct WsAuthParams {
    hmac: Option<String>,
    ts: Option<String>,
    origin: Option<String>,
}

/// `GET /api/ws` — WebSocket endpoint for real-time directory change notifications.
///
/// Authenticates via query parameters (`hmac`, `ts`, `origin`), then upgrades
/// to a WebSocket connection. Uses the same JSON protocol as the backend:
///
/// **Client → Companion:**
/// - `{"action": "subscribe", "connection_id": "local-drive:c", "path": "some/dir"}`
/// - `{"action": "unsubscribe", "connection_id": "local-drive:c", "path": "some/dir"}`
/// - `{"action": "ping"}`
///
/// **Companion → Client:**
/// - `{"type": "subscribed", "connection_id": "...", "path": "..."}`
/// - `{"type": "unsubscribed", "connection_id": "...", "path": "..."}`
/// - `{"type": "directory_changed", "connection_id": "...", "path": "..."}`
/// - `{"type": "pong"}`
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    Query(params): Query<WsAuthParams>,
) -> Result<Response, ApiError> {
    let hmac_val = params.hmac.ok_or_else(|| ApiError::Forbidden("Missing hmac query param".into()))?;
    let ts_val = params.ts.ok_or_else(|| ApiError::Forbidden("Missing ts query param".into()))?;
    let origin_val = params
        .origin
        .ok_or_else(|| ApiError::Forbidden("Missing origin query param".into()))?;

    let log_context = auth::AuthLogContext {
        auth_transport: "query",
        method: "GET",
        path: "/api/ws",
    };

    auth::validate_hmac_public(&state, &origin_val, &hmac_val, &ts_val, &uri, &log_context)?;

    Ok(ws.on_upgrade(move |socket| handle_ws_connection(socket, state)))
}

/// Handle a single WebSocket connection after the upgrade.
async fn handle_ws_connection(mut socket: WebSocket, state: Arc<AppState>) {
    info!("WebSocket client connected");
    let mut rx = state.watcher.subscribe_events();
    let mut subscriptions: HashSet<String> = HashSet::new();

    loop {
        tokio::select! {
            // ── Incoming message from the client ──────────────────────────
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(e) = handle_ws_message(
                            &text, &mut socket, &state, &mut subscriptions,
                        ).await {
                            warn!("WS message handling error: {e}");
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    // Ignore binary/ping/pong frames
                    _ => {}
                }
            }
            // ── Outgoing notification from the watcher ────────────────────
            event = rx.recv() => {
                if let Ok(event) = event {
                    let key = format!("{}:{}", event.drive, event.path);
                    if subscriptions.contains(&key) {
                        let payload = serde_json::json!({
                            "type": "directory_changed",
                            "connection_id": format!("{LOCAL_DRIVE_PREFIX}{}", event.drive),
                            "path": event.path,
                        });
                        if socket
                            .send(Message::Text(payload.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        }
    }

    // Cleanup: unsubscribe from all watched directories
    for key in &subscriptions {
        if let Some((drive, path)) = key.split_once(':') {
            state.watcher.unsubscribe(drive, path).await;
        }
    }
    info!("WebSocket client disconnected");
}

/// Process a single incoming WebSocket text message.
async fn handle_ws_message(
    text: &str,
    socket: &mut WebSocket,
    state: &Arc<AppState>,
    subscriptions: &mut HashSet<String>,
) -> Result<(), String> {
    let data: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("Invalid JSON: {e}"))?;

    let action = data.get("action").and_then(|v| v.as_str());
    let conn_id = data.get("connection_id").and_then(|v| v.as_str());
    let path = data.get("path").and_then(|v| v.as_str()).unwrap_or("");

    match (action, conn_id) {
        (Some("subscribe"), Some(connection_id)) => {
            let drive = connection_id.strip_prefix(LOCAL_DRIVE_PREFIX).unwrap_or(connection_id);
            let normalized_path = match normalize_drive_relative_path(drive, path) {
                Ok(normalized) => normalized,
                Err(e) => {
                    warn!("WS subscribe failed for {drive}:{path}: {e}");
                    return Ok(());
                }
            };
            let key = format!("{drive}:{normalized_path}");

            if let Some(root) = drives::resolve_drive_path(drive) {
                match state.watcher.subscribe(drive, &normalized_path, &root).await {
                    Ok(()) => {
                        subscriptions.insert(key);
                        let reply = serde_json::json!({
                            "type": "subscribed",
                            "connection_id": connection_id,
                            "path": normalized_path,
                        });
                        socket
                            .send(Message::Text(reply.to_string().into()))
                            .await
                            .map_err(|e| format!("Send failed: {e}"))?;
                    }
                    Err(e) => {
                        warn!("WS subscribe failed for {key}: {e}");
                    }
                }
            } else {
                warn!("WS subscribe: unknown drive '{drive}'");
            }
        }
        (Some("unsubscribe"), Some(connection_id)) => {
            let drive = connection_id.strip_prefix(LOCAL_DRIVE_PREFIX).unwrap_or(connection_id);
            let normalized_path = match normalize_drive_relative_path(drive, path) {
                Ok(normalized) => normalized,
                Err(e) => {
                    warn!("WS unsubscribe failed for {drive}:{path}: {e}");
                    return Ok(());
                }
            };
            let key = format!("{drive}:{normalized_path}");

            if subscriptions.remove(&key) {
                state.watcher.unsubscribe(drive, &normalized_path).await;
            }

            let reply = serde_json::json!({
                "type": "unsubscribed",
                "connection_id": connection_id,
                "path": normalized_path,
            });
            let _ = socket.send(Message::Text(reply.to_string().into())).await;
        }
        (Some("ping"), _) => {
            let reply = serde_json::json!({"type": "pong"});
            let _ = socket.send(Message::Text(reply.to_string().into())).await;
        }
        _ => {}
    }

    Ok(())
}

// ─── Health ──────────────────────────────────────────────────────────────────

/// `GET /api/health` — unauthenticated health check.
pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        paired: state.pairing.has_any_pairing(),
        auth_protocol_version: auth::AUTH_PROTOCOL_VERSION,
    })
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PairInitiateRequest {
    pub nonce_browser: String,
    pub origin: Option<String>,
}

/// `POST /api/pair/initiate` — start a pairing exchange.
pub async fn pair_initiate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PairInitiateRequest>,
) -> Result<Json<PairInitiateResponse>, ApiError> {
    let origin = extract_origin(&headers).or_else(|_| extract_origin_from_pair_initiate_request(&body))?;

    let (pairing_id, nonce_companion, code) = state.pairing.initiate(&body.nonce_browser, &origin).map_err(|err| match err {
        PairingInitiateError::Validation(msg) => ApiError::BadRequest(msg),
        PairingInitiateError::RateLimited(msg) => ApiError::TooManyRequests(msg),
    })?;

    show_pairing_window(&state.app, &pairing_id, &origin, &code);

    // The companion UI will be notified of the pending pairing via
    // PairingState::get_pending_pairings() and show the code in a native dialog.
    // That flow is triggered by a Tauri event (handled separately).
    log::info!("Pairing code for UI display: {code}");

    Ok(Json(PairInitiateResponse {
        pairing_id,
        nonce_companion,
    }))
}

#[derive(Deserialize)]
pub struct PairConfirmRequest {
    pub pairing_id: String,
    pub origin: Option<String>,
}

/// `POST /api/pair/confirm` — complete a pairing after dual confirmation.
pub async fn pair_confirm(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PairConfirmRequest>,
) -> Result<Json<PairConfirmResponse>, ApiError> {
    let origin = resolve_pair_confirm_origin(&headers, body.origin.as_deref())?;
    let secret = state.pairing.confirm(&body.pairing_id, &origin).map_err(map_pair_confirm_error)?;

    show_pairing_success(&state.app);

    Ok(Json(PairConfirmResponse { secret }))
}

/// `POST /api/localization` — synchronize browser localization to the companion.
pub async fn sync_localization(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<LocalizationSyncRequest>,
) -> Result<Json<LocalizationSyncResponse>, ApiError> {
    let origin = extract_origin(&headers)?;
    let (current, applied) = state
        .localization
        .apply_update(&state.app, &origin, body)
        .map_err(ApiError::BadRequest)?;

    if applied {
        let _ = state.app.emit("localization-updated", &current);
    }

    Ok(Json(LocalizationSyncResponse { applied, state: current }))
}

#[derive(Deserialize)]
pub struct PairStatusQuery {
    pub origin: Option<String>,
}

/// `GET /api/pair/status` — pairing status for the current browser origin.
pub async fn pair_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PairStatusQuery>,
) -> Json<PairStatusResponse> {
    let origin = resolve_pair_status_origin(&headers, query.origin.as_deref()).ok();
    Json(build_pair_status_response(&state.pairing, origin.as_deref()))
}

#[derive(Deserialize)]
pub struct PairCancelRequest {
    pub pairing_id: String,
    pub origin: Option<String>,
}

/// `POST /api/pair/cancel` — explicitly cancel a pending browser-side pairing.
pub async fn pair_cancel(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<PairCancelRequest>,
) -> Result<StatusCode, ApiError> {
    let origin = resolve_pair_cancel_origin(&headers, body.origin.as_deref())?;

    state.pairing.cancel(&body.pairing_id, &origin).map_err(ApiError::BadRequest)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/pair/current` — remove the current browser origin's pairing.
pub async fn delete_current_pairing(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<StatusCode, ApiError> {
    let origin = extract_origin(&headers)?;
    state.pairing.unpair(&origin).map_err(ApiError::BadRequest)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/pair/test` — validate the current browser's authenticated pairing.
pub async fn test_pairing(State(_state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<PairTestResponse>, ApiError> {
    let origin = extract_origin(&headers)?;

    Ok(Json(PairTestResponse {
        status: "success".to_string(),
        message: format!("Pairing with {origin} is working."),
        origin,
    }))
}

// ─── Drives ──────────────────────────────────────────────────────────────────

/// `GET /api/drives` — list all accessible drives/volumes.
pub async fn list_drives() -> Json<Vec<DriveInfo>> {
    Json(drives::enumerate_drives())
}

// ─── Browse ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct ArchiveListQuery {
    pub archive_path: String,
    pub virtual_path: Option<String>,
    pub cursor: Option<String>,
    pub page_size: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveV2ListQuery {
    pub contract_version: ArchiveContractVersion,
    pub archive_path: String,
    pub virtual_path: Option<String>,
    pub cursor: Option<String>,
    pub page_size: Option<usize>,
}

/// `GET /api/browse/{drive}/list` — list directory contents.
pub async fn browse_list(Path(drive): Path<String>, Query(query): Query<BrowseQuery>) -> Result<Json<DirectoryListing>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    let relative = query.path.as_deref().unwrap_or("");
    let normalized_relative = normalize_drive_relative_path(&drive, relative)?;
    let full_path = resolve_safe_path(&base_path, &drive, relative)?;

    let mut items = Vec::new();

    let mut entries = tokio::fs::read_dir(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;

    while let Some(entry) = entries.next_entry().await.map_err(ApiError::Io)? {
        match build_file_info(&entry, &normalized_relative).await {
            Ok(info) => items.push(info),
            Err(e) => {
                // Skip entries we can't stat (e.g., broken symlinks)
                log::debug!("Skipping entry {:?}: {e}", entry.file_name());
            }
        }
    }

    let total = items.len();

    Ok(Json(DirectoryListing {
        path: normalized_relative,
        items,
        total,
    }))
}

/// Shared implementation for a bounded virtual ZIP directory page.
pub async fn browse_list_archive(
    Path(drive): Path<String>,
    Query(query): Query<ArchiveListQuery>,
) -> Result<Json<ArchiveDirectoryListing>, ApiError> {
    if query.archive_path.trim().is_empty() {
        return Err(ApiError::BadRequest("Archive path is required".to_string()));
    }
    let page_size = query.page_size.unwrap_or(100);
    if !(1..=500).contains(&page_size) {
        return Err(ApiError::BadRequest(
            "Archive listing page size must be between 1 and 500".to_string(),
        ));
    }
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let archive_path = resolve_safe_path(&base_path, &drive, &query.archive_path)?;
    let metadata = tokio::fs::metadata(&archive_path)
        .await
        .map_err(|error| map_io_error(error, &archive_path))?;
    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Archive path must identify a regular file".to_string()));
    }
    let virtual_path = query.virtual_path.unwrap_or_default();
    let presentation = ArchiveDirectoryListingPresentation::new(
        query.archive_path,
        metadata.len(),
        metadata.modified().ok().map(DateTime::<Utc>::from),
        virtual_path,
        query.cursor,
        page_size,
    );
    let listing = tokio::task::spawn_blocking(move || {
        resolve_local_archive_inspection_coordinator(archive_path, ArchiveInspectionPresentation::DirectoryListing(presentation))?
            .directory_listing()
            .map_err(map_local_archive_read_error)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("Local archive listing task failed: {error}")))??;
    Ok(Json(listing))
}

/// `GET /api/browse/{drive}/archive/v2/list` — list a V2 local archive directory.
pub async fn browse_list_v2_archive(
    Path(drive): Path<String>,
    ArchiveV2Query(query): ArchiveV2Query<ArchiveV2ListQuery>,
) -> Result<Json<ArchiveDirectoryListing>, ArchiveV2Error> {
    let _contract_version = query.contract_version;
    browse_list_archive(
        Path(drive),
        Query(ArchiveListQuery {
            archive_path: query.archive_path,
            virtual_path: query.virtual_path,
            cursor: query.cursor,
            page_size: query.page_size,
        }),
    )
    .await
    .map_err(ArchiveV2Error::from)
}

/// `GET /api/browse/{drive}/link-targets` — resolve display-safe target metadata for links in one directory.
///
/// This intentionally runs separately from directory listing so unavailable
/// link targets never delay the file browser's initial render.
pub async fn browse_list_link_targets(
    Path(drive): Path<String>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<LinkTargetListing>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let relative = query.path.as_deref().unwrap_or("");
    let normalized_relative = normalize_drive_relative_path(&drive, relative)?;
    let full_path = resolve_safe_path(&base_path, &drive, relative)?;
    let mut entries = tokio::fs::read_dir(&full_path)
        .await
        .map_err(|error| map_io_error(error, &full_path))?;
    let mut pending = JoinSet::new();
    let mut items = Vec::new();

    while let Some(entry) = entries.next_entry().await.map_err(ApiError::Io)? {
        let source_path = entry.path();
        let is_link = match source_link_kind(&source_path).await {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                log::debug!("Skipping link target metadata for {:?}: {error}", entry.file_name());
                false
            }
        };
        if !is_link {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let source_relative_path = if normalized_relative.is_empty() {
            name
        } else {
            format!("{normalized_relative}/{name}")
        };

        if pending.len() >= LINK_TARGET_RESOLUTION_CONCURRENCY {
            collect_link_target_resolution(&mut pending, &mut items).await?;
        }
        pending.spawn_blocking(move || resolve_link_target_metadata(source_relative_path, source_path));
    }

    while !pending.is_empty() {
        collect_link_target_resolution(&mut pending, &mut items).await?;
    }

    items.sort_by(|left: &LinkTargetResolution, right: &LinkTargetResolution| left.source_path.cmp(&right.source_path));
    Ok(Json(LinkTargetListing { items }))
}

/// `GET /api/browse/{drive}/info` — get metadata for a single file/directory.
pub async fn browse_info(Path(drive): Path<String>, Query(query): Query<BrowseQuery>) -> Result<Json<FileInfo>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    let relative = query.path.as_deref().unwrap_or("");
    let normalized_relative = normalize_drive_relative_path(&drive, relative)?;
    let source_path = resolve_drive_relative_source_path(&base_path, &drive, relative)?;
    let full_path = resolve_safe_path(&base_path, &drive, relative)?;

    let metadata = tokio::fs::metadata(&full_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found_code(format!("Path not found: {}", full_path.display()), RECENT_FILE_TARGET_MISSING_CODE)
        } else {
            map_io_error(error, &full_path)
        }
    })?;

    let name = source_path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let file_type = if metadata.is_dir() { FileType::Directory } else { FileType::File };

    let size = if metadata.is_file() { Some(metadata.len()) } else { None };

    let mime_type = if metadata.is_file() {
        mime_guess::from_path(&full_path).first().map(|m| m.to_string())
    } else {
        None
    };

    let is_hidden = name.starts_with('.');
    let link_kind = source_link_kind(&source_path)
        .await
        .map_err(|error| map_io_error(error, &source_path))?;

    Ok(Json(FileInfo {
        name,
        path: normalized_relative,
        file_type,
        size,
        mime_type,
        created_at: system_time_to_chrono(metadata.created().ok()),
        modified_at: system_time_to_chrono(metadata.modified().ok()),
        is_readable: true, // We can read it if we could stat it
        is_hidden,
        link_kind,
    }))
}

/// `GET /api/browse/{drive}/resolve-activation` — resolve a local entry before opening it.
///
/// The response always uses a canonical path rooted in an exposed local drive,
/// including when a filesystem link or Windows shortcut points to another drive.
pub async fn browse_resolve_activation(
    Path(drive): Path<String>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<ActivationResolution>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let relative = query.path.as_deref().unwrap_or("");
    let source_path = resolve_activation_source_path(&base_path, &drive, relative)?;
    let target_path = tokio::task::spawn_blocking(move || resolve_activation_target(&source_path))
        .await
        .map_err(|error| ApiError::Internal(format!("Link resolution task failed: {error}")))?
        .map_err(map_link_resolution_error)?;

    if classify_link_target(&target_path).await? == LinkTargetType::Other {
        return Err(ApiError::bad_request_code(
            "The link target is not a regular file or directory",
            LOCAL_LINK_TARGET_UNSUPPORTED_TYPE_CODE,
        ));
    }

    let (target_drive_id, target_relative_path) = drives::drive_for_path(&target_path).ok_or_else(|| {
        ApiError::forbidden_code(
            "The link target is not on an accessible local drive",
            LOCAL_LINK_TARGET_UNMAPPED_DRIVE_CODE,
        )
    })?;
    let target_relative = target_relative_path.to_string_lossy().replace('\\', "/");
    let item = build_file_info_from_path(&target_path, &target_relative).await?;

    Ok(Json(ActivationResolution {
        drive_id: target_drive_id,
        path: target_relative,
        item,
    }))
}

// ─── Viewer ──────────────────────────────────────────────────────────────────

const DOWNLOAD_INTENT_TTL: Duration = Duration::from_secs(90);
const MAX_DOWNLOAD_INTENTS: usize = 1024;

#[derive(Deserialize)]
pub struct DownloadIntentRequest {
    drive: String,
    path: String,
    member_path: Option<String>,
}

#[derive(Serialize)]
pub struct DownloadIntentResponse {
    url: String,
}

pub async fn create_download_intent(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<DownloadIntentRequest>,
) -> Result<Json<DownloadIntentResponse>, ApiError> {
    let origin = extract_origin(&headers)?;
    if request.path.is_empty() || request.member_path.as_deref() == Some("") {
        return Err(ApiError::BadRequest(
            "A file path and nonempty member path are required".to_string(),
        ));
    }
    let base_path =
        drives::resolve_drive_path(&request.drive).ok_or_else(|| ApiError::NotFound("Download drive is unavailable".to_string()))?;
    let file_path = resolve_safe_path(&base_path, &request.drive, &request.path)?;
    if !tokio::fs::metadata(&file_path)
        .await
        .map_err(|error| map_io_error(error, &file_path))?
        .is_file()
    {
        return Err(ApiError::BadRequest("Download source must be a regular file".to_string()));
    }
    if let Some(member_path) = &request.member_path {
        let presentation = ArchiveMemberReadPresentation::new(member_path.clone(), true);
        tokio::task::spawn_blocking(move || {
            resolve_local_archive_inspection_coordinator(file_path, ArchiveInspectionPresentation::MemberRead(presentation))
                .and_then(|coordinator| coordinator.validated_member_read().map_err(map_local_archive_read_error))
        })
        .await
        .map_err(|error| ApiError::Internal(format!("Archive download validation failed: {error}")))??;
    }

    let token = uuid::Uuid::new_v4().to_string();
    let mut intents = state
        .pairing
        .download_intents
        .lock()
        .map_err(|_| ApiError::Internal("Download intents unavailable".to_string()))?;
    intents.retain(|_, intent| intent.expires_at > Instant::now());
    if intents.len() >= MAX_DOWNLOAD_INTENTS {
        return Err(ApiError::TooManyRequests("Too many active download intents".to_string()));
    }
    intents.insert(
        token.clone(),
        DownloadIntent {
            origin,
            drive: request.drive,
            path: request.path,
            member_path: request.member_path,
            expires_at: Instant::now() + DOWNLOAD_INTENT_TTL,
        },
    );
    Ok(Json(DownloadIntentResponse {
        url: format!("/api/download-intents/{token}"),
    }))
}

fn consume_download_intent(intents: &Mutex<HashMap<String, DownloadIntent>>, token: &str) -> Result<DownloadIntent, ApiError> {
    intents
        .lock()
        .map_err(|_| ApiError::Internal("Download intents unavailable".to_string()))?
        .remove(token)
        .filter(|intent| intent.expires_at > Instant::now())
        .ok_or_else(|| ApiError::NotFound("Download expired or unavailable".to_string()))
}

pub async fn redeem_download_intent(State(state): State<Arc<AppState>>, Path(token): Path<String>) -> Result<Response<Body>, ApiError> {
    let intent = consume_download_intent(&state.pairing.download_intents, &token)?;
    if !state.pairing.is_origin_paired(&intent.origin) {
        return Err(ApiError::NotFound("Download expired or unavailable".to_string()));
    }
    let mut response = if let Some(member_path) = intent.member_path {
        viewer_archive_member(
            Path(intent.drive),
            Query(ArchiveMemberQuery {
                archive_path: intent.path,
                member_path,
                download: true,
            }),
        )
        .await?
    } else {
        viewer_download(
            Path(intent.drive),
            Query(ViewerQuery {
                path: Some(intent.path),
                viewport_width: None,
                viewport_height: None,
                no_resizing: None,
            }),
        )
        .await?
    };
    response
        .headers_mut()
        .insert("Cache-Control", HeaderValue::from_static("private, no-store"));
    response
        .headers_mut()
        .insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    Ok(response)
}

#[derive(Deserialize)]
pub struct ViewerQuery {
    pub path: Option<String>,
    /// Ignored — companion serves raw files without server-side resizing.
    #[serde(default)]
    #[allow(dead_code)]
    pub viewport_width: Option<u32>,
    /// Ignored — companion serves raw files without server-side resizing.
    #[serde(default)]
    #[allow(dead_code)]
    pub viewport_height: Option<u32>,
    /// Ignored — companion always serves the original file.
    #[serde(default)]
    #[allow(dead_code)]
    pub no_resizing: Option<bool>,
}

#[derive(Deserialize)]
pub struct ArchiveMemberQuery {
    pub archive_path: String,
    pub member_path: String,
    #[serde(default)]
    pub download: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveV2MemberQuery {
    pub contract_version: ArchiveContractVersion,
    pub archive_path: String,
    pub member_path: String,
    #[serde(default)]
    pub download: bool,
}

/// Default MIME type for files we can't identify.
const FALLBACK_MIME: &str = "application/octet-stream";

/// `GET /api/viewer/{drive}/file` — stream a file for inline viewing.
///
/// Sets `Content-Type` from extension (via `mime_guess`) and downloads active documents.
pub async fn viewer_file(Path(drive): Path<String>, Query(query): Query<ViewerQuery>) -> Result<Response<Body>, ApiError> {
    let (full_path, mime_type) = resolve_viewer_path(&drive, &query)?;

    let file = File::open(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let filename = full_path.file_name().unwrap_or_default().to_string_lossy();
    let disposition = if is_active_document_mime_type(&mime_type) {
        active_document_disposition(&filename)
    } else {
        format!("inline; filename=\"{filename}\"")
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", &mime_type)
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Disposition",
            HeaderValue::from_str(&disposition).unwrap_or_else(|_| HeaderValue::from_static("inline")),
        )
        .body(body)
        .map_err(|e| ApiError::Internal(format!("Failed to build response: {e}")))
}

/// `GET /api/viewer/{drive}/download` — stream a file as a download.
///
/// Sets `Content-Disposition: attachment` so browsers trigger a file-save dialog.
pub async fn viewer_download(Path(drive): Path<String>, Query(query): Query<ViewerQuery>) -> Result<Response<Body>, ApiError> {
    let (full_path, mime_type) = resolve_viewer_path(&drive, &query)?;

    let metadata = tokio::fs::metadata(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;

    let file = File::open(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;
    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let filename = full_path.file_name().unwrap_or_default().to_string_lossy();
    let disposition = format!("attachment; filename=\"{filename}\"");

    let content_length = metadata.len();

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", &mime_type)
        .header(
            "Content-Disposition",
            HeaderValue::from_str(&disposition).unwrap_or_else(|_| HeaderValue::from_static("attachment")),
        )
        .header("Content-Length", content_length)
        .body(body)
        .map_err(|e| ApiError::Internal(format!("Failed to build response: {e}")))
}

#[derive(Deserialize)]
struct CompanionDownloadSessionToken {
    token: String,
}

#[derive(Deserialize)]
struct CompanionDownloadSessionLimit {
    size_limit_bytes: u64,
}

#[derive(Deserialize)]
pub struct LocalZipSelectionDownloadRequest {
    archive_path: String,
    paths: Vec<String>,
}

async fn temporary_download_limit(state: &AppState, headers: &HeaderMap, drive: &str) -> Result<u64, ApiError> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("Bearer ") && value.len() > "Bearer ".len())
        .ok_or_else(|| ApiError::Forbidden("Browser authentication is required for downloads".to_string()))?;
    let server_url = normalize_archive_server_url(&extract_origin(headers)?)?;
    let clients = state
        .app
        .try_state::<SambeeHttpClientStore>()
        .map(|clients| clients.inner().clone())
        .ok_or_else(|| ApiError::Internal("Companion backend HTTP client is unavailable".to_string()))?;
    let client = clients.client_for_server_no_redirects(&server_url).map_err(ApiError::Internal)?;
    let session_url = format!("{server_url}/api/browse/companion-download/session");
    let session: CompanionDownloadSessionToken = decode_archive_relay_json(
        client
            .post(&session_url)
            .header("authorization", authorization)
            .json(&serde_json::json!({ "drive": drive }))
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error("Download session issue", "POST", &session_url, &error)))?,
        "download session",
    )
    .await?;
    let consume_url = format!("{session_url}/{}/consume", session.token);
    let limit: CompanionDownloadSessionLimit = decode_archive_relay_json(
        client
            .post(&consume_url)
            .header("authorization", authorization)
            .json(&serde_json::json!({ "drive": drive }))
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error("Download session consume", "POST", &consume_url, &error)))?,
        "download size limit",
    )
    .await?;
    Ok(limit.size_limit_bytes)
}

struct TemporaryArchiveReader {
    file: File,
    _directory: tempfile::TempDir,
}

struct DownloadPreparationGuard(Arc<AtomicBool>);

impl Drop for DownloadPreparationGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl AsyncRead for TemporaryArchiveReader {
    fn poll_read(mut self: Pin<&mut Self>, context: &mut Context<'_>, buffer: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.file).poll_read(context, buffer)
    }
}

pub async fn browse_download_selection(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    Json(paths): Json<Vec<String>>,
) -> Result<Response<Body>, ApiError> {
    if paths.is_empty() {
        return Err(ApiError::BadRequest("Download selection cannot be empty".to_string()));
    }
    let drive_root = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let sources = paths
        .iter()
        .map(|path| resolve_safe_path(&drive_root, &drive, path))
        .collect::<Result<Vec<_>, _>>()?;
    let canonical_root = std::fs::canonicalize(&drive_root).map_err(ApiError::Io)?;
    let parent = sources[0].parent();
    if parent.is_none_or(|parent| !parent.starts_with(&canonical_root))
        || sources.iter().any(|source| source.parent() != parent)
        || sources.iter().collect::<HashSet<_>>().len() != sources.len()
    {
        return Err(ApiError::BadRequest(
            "Download selections must be distinct items in one directory".to_string(),
        ));
    }
    let size_limit = temporary_download_limit(&state, &headers, &drive).await?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _guard = DownloadPreparationGuard(cancelled.clone());
    let (directory, archive_path) = tokio::task::spawn_blocking(move || {
        let entries = build_local_archive_manifest_for_remote_target_with_cancellation(&sources, || cancelled.load(Ordering::Relaxed))?;
        create_temporary_local_archive(&entries, size_limit, || cancelled.load(Ordering::Relaxed))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("Download archive task failed: {error}")))?
    .map_err(map_temporary_archive_error)?;
    temporary_archive_response(directory, archive_path).await
}

pub async fn browse_download_zip_selection(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LocalZipSelectionDownloadRequest>,
) -> Result<Response<Body>, ApiError> {
    if body.paths.is_empty() {
        return Err(ApiError::BadRequest("Download selection cannot be empty".to_string()));
    }
    let drive_root = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let archive_path = resolve_safe_path(&drive_root, &drive, &body.archive_path)?;
    let size_limit = temporary_download_limit(&state, &headers, &drive).await?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let _guard = DownloadPreparationGuard(cancelled.clone());
    let (directory, output_path) = tokio::task::spawn_blocking(move || {
        create_temporary_local_zip_selection(&archive_path, &body.paths, size_limit, || cancelled.load(Ordering::Relaxed))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("ZIP selection download task failed: {error}")))?
    .map_err(map_temporary_archive_error)?;
    temporary_archive_response(directory, output_path).await
}

async fn temporary_archive_response(directory: tempfile::TempDir, archive_path: PathBuf) -> Result<Response<Body>, ApiError> {
    let file = File::open(&archive_path).await.map_err(ApiError::Io)?;
    let size = file.metadata().await.map_err(ApiError::Io)?.len();
    let body = Body::from_stream(ReaderStream::new(TemporaryArchiveReader {
        file,
        _directory: directory,
    }));
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", "attachment; filename=\"Sambee-download.zip\"")
        .header("Content-Length", size)
        .body(body)
        .map_err(|error| ApiError::Internal(format!("Failed to build download response: {error}")))
}

fn map_temporary_archive_error(error: LocalArchiveError) -> ApiError {
    fn exceeds_limit(error: &LocalArchiveError) -> bool {
        match error {
            LocalArchiveError::Io(io_error) | LocalArchiveError::Zip(zip::result::ZipError::Io(io_error)) => {
                io_error.to_string() == TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED
            }
            LocalArchiveError::PartialArchiveOutput(inner) => exceeds_limit(inner),
            _ => false,
        }
    }

    if exceeds_limit(&error) {
        ApiError::PayloadTooLarge(TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED.to_string())
    } else {
        map_local_archive_error(error)
    }
}

/// Shared implementation for a parser-validated archive member stream.
struct VerifiedArchiveStream {
    reader: tokio::io::DuplexStream,
    completion: oneshot::Receiver<Result<(), std::io::Error>>,
}

impl AsyncRead for VerifiedArchiveStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buffer: &mut ReadBuf<'_>) -> Poll<Result<(), std::io::Error>> {
        let before = buffer.filled().len();
        match Pin::new(&mut self.reader).poll_read(cx, buffer) {
            Poll::Ready(Ok(())) if buffer.filled().len() == before => match Pin::new(&mut self.completion).poll(cx) {
                Poll::Ready(Ok(result)) => Poll::Ready(result),
                Poll::Ready(Err(_)) => Poll::Ready(Err(std::io::Error::other("Archive stream ended unexpectedly"))),
                Poll::Pending => Poll::Pending,
            },
            other => other,
        }
    }
}

pub async fn viewer_archive_member(Path(drive): Path<String>, Query(query): Query<ArchiveMemberQuery>) -> Result<Response<Body>, ApiError> {
    if query.archive_path.trim().is_empty() || query.member_path.trim().is_empty() {
        return Err(ApiError::BadRequest("Archive and member paths are required".to_string()));
    }
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let archive_path = resolve_safe_path(&base_path, &drive, &query.archive_path)?;
    let metadata = tokio::fs::metadata(&archive_path)
        .await
        .map_err(|error| map_io_error(error, &archive_path))?;
    if !metadata.is_file() {
        return Err(ApiError::BadRequest("Archive path must identify a regular file".to_string()));
    }

    let member_path = query.member_path.replace('\\', "/");
    let inspection_path = archive_path.clone();
    let presentation = ArchiveMemberReadPresentation::new(member_path, query.download);
    let (member, validated_member) = tokio::task::spawn_blocking(move || {
        resolve_local_archive_inspection_coordinator(inspection_path, ArchiveInspectionPresentation::MemberRead(presentation))
            .and_then(|coordinator| coordinator.validated_member_read().map_err(map_local_archive_read_error))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("Local archive validation task failed: {error}")))??;
    if member.delivery == ArchiveMemberReadDelivery::PreviewUnavailable {
        return Err(ApiError::PayloadTooLarge(
            "Archive member exceeds the inline preview size limit".to_string(),
        ));
    }
    let validated_member =
        validated_member.ok_or_else(|| ApiError::Internal("Archive inspection did not produce a streaming descriptor".to_string()))?;

    let expected_size = validated_member.uncompressed_size;
    let (writer, reader) = tokio::io::duplex(ARCHIVE_COPY_BUFFER_SIZE);
    let (completion_sender, completion) = oneshot::channel();
    tokio::task::spawn_blocking(move || {
        let mut output = SyncIoBridge::new(writer);
        let result = stream_validated_local_archive_entry(validated_member, &mut output);
        drop(output);
        if let Err(error) = &result {
            warn!("Local archive member stream failed: {error}");
        }
        let _ = completion_sender.send(result.map_err(|error| std::io::Error::other(error.to_string())));
    });

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", &member.content_type)
        .header("Content-Length", expected_size)
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Disposition",
            if is_active_document_mime_type(&member.content_type) {
                HeaderValue::from_str(&active_document_disposition(
                    member.member_path.rsplit('/').next().unwrap_or("download"),
                ))
                .unwrap_or_else(|_| HeaderValue::from_static("attachment"))
            } else {
                HeaderValue::from_str(&member.content_disposition).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
            },
        )
        .body(Body::from_stream(ReaderStream::new(VerifiedArchiveStream { reader, completion })))
        .map_err(|error| ApiError::Internal(format!("Failed to build archive member response: {error}")))
}

/// `GET /api/viewer/{drive}/archive/v2/member` — stream a V2 local archive member.
pub async fn viewer_v2_archive_member(
    Path(drive): Path<String>,
    ArchiveV2Query(query): ArchiveV2Query<ArchiveV2MemberQuery>,
) -> Result<Response<Body>, ArchiveV2Error> {
    let _contract_version = query.contract_version;
    viewer_archive_member(
        Path(drive),
        Query(ArchiveMemberQuery {
            archive_path: query.archive_path,
            member_path: query.member_path,
            download: query.download,
        }),
    )
    .await
    .map_err(ArchiveV2Error::from)
}

/// Resolve drive + query path for viewer endpoints, returning the full path and MIME type.
fn resolve_viewer_path(drive: &str, query: &ViewerQuery) -> Result<(PathBuf, String), ApiError> {
    let base_path = drives::resolve_drive_path(drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    let relative = query.path.as_deref().unwrap_or("");
    let full_path = resolve_safe_path(&base_path, drive, relative)?;

    // Viewer endpoints must target files, not directories
    let metadata = std::fs::metadata(&full_path).map_err(|e| map_io_error(e, &full_path))?;
    if metadata.is_dir() {
        return Err(ApiError::BadRequest("Cannot view a directory".to_string()));
    }

    let mime_type = mime_guess::from_path(&full_path)
        .first()
        .map(|m| m.to_string())
        .unwrap_or_else(|| FALLBACK_MIME.to_string());

    Ok((full_path, mime_type))
}

// ─── Write Operations ────────────────────────────────────────────────────────

/// `DELETE /api/browse/{drive}/item` — delete a file or directory.
///
/// Directories are removed recursively. Refuses to delete the drive root.
pub async fn browse_delete(Path(drive): Path<String>, Query(query): Query<BrowseQuery>) -> Result<StatusCode, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    let relative = normalize_drive_relative_path(&drive, query.path.as_deref().unwrap_or(""))?;
    if relative.is_empty() {
        return Err(ApiError::BadRequest("Cannot delete the drive root".to_string()));
    }

    let full_path = resolve_safe_path(&base_path, &drive, &relative)?;

    let metadata = tokio::fs::metadata(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;

    if metadata.is_dir() {
        tokio::fs::remove_dir_all(&full_path)
            .await
            .map_err(|e| map_io_error(e, &full_path))?;
    } else {
        tokio::fs::remove_file(&full_path).await.map_err(|e| map_io_error(e, &full_path))?;
    }

    log::info!("Deleted: {}", full_path.display());
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/browse/{drive}/empty-directory` — remove one empty directory.
pub async fn browse_delete_empty_directory(Path(drive): Path<String>, Query(query): Query<BrowseQuery>) -> Result<StatusCode, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let relative = normalize_drive_relative_path(&drive, query.path.as_deref().unwrap_or(""))?;
    if relative.is_empty() {
        return Err(ApiError::BadRequest("Cannot delete the drive root".to_string()));
    }
    let directory = resolve_safe_path(&base_path, &drive, &relative)?;
    let metadata = tokio::fs::symlink_metadata(&directory)
        .await
        .map_err(|error| map_io_error(error, &directory))?;
    if !metadata.is_dir() {
        return Err(ApiError::conflict_message(format!(
            "Target is not a directory: {}",
            directory.display()
        )));
    }
    match tokio::fs::remove_dir(&directory).await {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => Err(ApiError::conflict_message(format!(
            "Directory is not empty: {}",
            directory.display()
        ))),
        Err(error) => Err(map_io_error(error, &directory)),
    }
}

#[derive(Deserialize)]
pub struct RenameRequest {
    pub path: String,
    pub new_name: String,
}

/// `POST /api/browse/{drive}/rename` — rename a file or directory.
///
/// Returns the updated `FileInfo` for the renamed item.
pub async fn browse_rename(Path(drive): Path<String>, Json(body): Json<RenameRequest>) -> Result<Json<FileInfo>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    validate_name(&body.new_name)?;

    let relative_path = normalize_drive_relative_path(&drive, &body.path)?;

    if relative_path.is_empty() {
        return Err(ApiError::BadRequest("Cannot rename the drive root".to_string()));
    }

    let full_path = resolve_safe_path(&base_path, &drive, &body.path)?;

    let parent = full_path
        .parent()
        .ok_or_else(|| ApiError::BadRequest("Cannot determine parent directory".to_string()))?;
    let new_full_path = parent.join(&body.new_name);

    if new_full_path.exists() {
        let candidate_is_source = new_full_path != full_path
            && !tokio::fs::symlink_metadata(&new_full_path)
                .await
                .map_err(|error| map_io_error(error, &new_full_path))?
                .file_type()
                .is_symlink();
        #[cfg(unix)]
        let same_source = if candidate_is_source
            && full_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.to_lowercase() == body.new_name.to_lowercase())
        {
            use std::os::unix::fs::MetadataExt;

            let source = tokio::fs::metadata(&full_path)
                .await
                .map_err(|error| map_io_error(error, &full_path))?;
            let target = tokio::fs::metadata(&new_full_path)
                .await
                .map_err(|error| map_io_error(error, &new_full_path))?;
            let mut entries = tokio::fs::read_dir(parent).await.map_err(|error| map_io_error(error, parent))?;
            let mut exact_target_exists = false;
            while let Some(entry) = entries.next_entry().await.map_err(|error| map_io_error(error, parent))? {
                if entry.file_name().to_str() == Some(body.new_name.as_str()) {
                    exact_target_exists = true;
                    break;
                }
            }
            source.dev() == target.dev() && source.ino() == target.ino() && !exact_target_exists
        } else {
            false
        };
        #[cfg(not(unix))]
        let same_source = candidate_is_source
            && tokio::fs::canonicalize(&new_full_path)
                .await
                .map_err(|error| map_io_error(error, &new_full_path))?
                == full_path;
        if !same_source {
            return Err(ApiError::conflict_message(format!(
                "An item named '{}' already exists",
                body.new_name
            )));
        }
    }

    tokio::fs::rename(&full_path, &new_full_path)
        .await
        .map_err(|e| map_io_error(e, &full_path))?;

    // Build the new relative path for the response
    let parent_relative = relative_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
    let new_relative = if parent_relative.is_empty() {
        body.new_name.clone()
    } else {
        format!("{parent_relative}/{}", body.new_name)
    };

    let info = build_file_info_from_path(&new_full_path, &new_relative).await?;

    log::info!("Renamed: {} -> {}", full_path.display(), new_full_path.display());
    Ok(Json(info))
}

#[derive(Deserialize)]
pub struct CreateItemRequest {
    pub parent_path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: FileType,
}

/// `POST /api/browse/{drive}/create` — create a new file or directory.
///
/// Returns the `FileInfo` for the newly created item.
pub async fn browse_create(Path(drive): Path<String>, Json(body): Json<CreateItemRequest>) -> Result<Json<FileInfo>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    validate_name(&body.name)?;

    let parent_relative = normalize_drive_relative_path(&drive, &body.parent_path)?;
    let parent_path = resolve_safe_path(&base_path, &drive, &body.parent_path)?;

    if !parent_path.is_dir() {
        return Err(ApiError::NotFound(format!("Parent directory not found: {parent_relative}")));
    }

    let new_path = parent_path.join(&body.name);
    if new_path.exists() {
        return Err(ApiError::conflict_message(format!("An item named '{}' already exists", body.name)));
    }

    match body.item_type {
        FileType::Directory => {
            tokio::fs::create_dir(&new_path).await.map_err(|e| map_io_error(e, &new_path))?;
        }
        FileType::File => {
            File::create(&new_path).await.map_err(|e| map_io_error(e, &new_path))?;
        }
    }

    let new_relative = if parent_relative.is_empty() {
        body.name.clone()
    } else {
        format!("{}/{}", parent_relative, body.name)
    };

    let info = build_file_info_from_path(&new_path, &new_relative).await?;

    log::info!("Created: {}", new_path.display());
    Ok(Json(info))
}

#[derive(Deserialize)]
pub struct CopyMoveRequest {
    pub source_path: String,
    pub dest_path: String,
    /// When set to a different local-drive ID, the destination is resolved
    /// on that drive instead of the source drive.
    pub dest_connection_id: Option<String>,
    pub target_resolution_policy: Option<String>,
    pub overwrite: Option<bool>,
    pub idempotency_key: String,
    #[serde(default)]
    pub transfer_attempt_id: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ContentTransferEffects {
    source: &'static str,
    destination: &'static str,
}

#[derive(Clone, Serialize)]
pub struct ContentTransferError {
    code: &'static str,
    detail: String,
}

#[derive(Clone, Serialize)]
pub struct ContentTransferResult {
    status: &'static str,
    effects: ContentTransferEffects,
    replaced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ContentTransferError>,
}

fn completed_transfer_result(source: &'static str, destination: &'static str) -> ContentTransferResult {
    ContentTransferResult {
        status: "completed",
        effects: ContentTransferEffects { source, destination },
        replaced: false,
        error: None,
    }
}

fn completed_with_source_retained_transfer_result() -> ContentTransferResult {
    ContentTransferResult {
        status: "completed_with_source_retained",
        effects: ContentTransferEffects {
            source: "unchanged",
            destination: "mutated",
        },
        replaced: false,
        error: Some(ContentTransferError {
            code: "source_delete_failed",
            detail: "Destination was created but the original could not be removed.".to_string(),
        }),
    }
}

fn skipped_transfer_result() -> ContentTransferResult {
    ContentTransferResult {
        status: "skipped",
        effects: ContentTransferEffects {
            source: "unchanged",
            destination: "unchanged",
        },
        replaced: false,
        error: None,
    }
}

fn cancelled_transfer_result() -> ContentTransferResult {
    ContentTransferResult {
        status: "cancelled",
        effects: ContentTransferEffects {
            source: "unchanged",
            destination: "unchanged",
        },
        replaced: false,
        error: None,
    }
}

fn source_changed_transfer_result(destination_mutated: bool) -> ContentTransferResult {
    ContentTransferResult {
        status: "failed",
        effects: ContentTransferEffects {
            source: "unchanged",
            destination: if destination_mutated { "mutated" } else { "unchanged" },
        },
        replaced: false,
        error: Some(ContentTransferError {
            code: "source_changed",
            detail: "Source changed before destination commit".to_string(),
        }),
    }
}

fn transfer_fingerprint(body: &CopyMoveRequest) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        body.source_path,
        body.dest_path,
        body.dest_connection_id.as_deref().unwrap_or_default(),
        body.target_resolution_policy.as_deref().unwrap_or_default(),
        body.overwrite.unwrap_or(false)
    )
}

fn transfer_receipt_key(operation: &str, source_drive: &str, idempotency_key: &str) -> String {
    format!("{operation}\u{1f}{source_drive}\u{1f}{idempotency_key}")
}

fn reserve_transfer_receipt(operation: &str, source_drive: &str, body: &CopyMoveRequest) -> Result<TransferReceiptLookup, ApiError> {
    let key = body.idempotency_key.as_str();
    uuid::Uuid::parse_str(key).map_err(|_| ApiError::BadRequest("idempotency_key must be a UUID".to_string()))?;
    let receipt_key = transfer_receipt_key(operation, source_drive, key);
    let fingerprint = transfer_fingerprint(body);
    let mut receipts = TRANSFER_RECEIPTS
        .lock()
        .map_err(|_| ApiError::Internal("Transfer receipt store is unavailable".to_string()))?;
    let now = Instant::now();
    receipts.retain(|_, receipt| match receipt {
        TransferReceiptEntry::Complete(receipt) => receipt.expires_at > now,
        TransferReceiptEntry::InFlight { .. } => true,
    });
    match receipts.get_mut(&receipt_key) {
        Some(TransferReceiptEntry::Complete(receipt)) if receipt.fingerprint == fingerprint => {
            Ok(TransferReceiptLookup::Cached(receipt.outcome.clone()))
        }
        Some(TransferReceiptEntry::InFlight {
            fingerprint: active_fingerprint,
            waiters,
        }) if *active_fingerprint == fingerprint => {
            let (sender, receiver) = oneshot::channel();
            waiters.push(sender);
            Ok(TransferReceiptLookup::Wait(receiver))
        }
        Some(_) => Err(ApiError::conflict_message("Idempotency key conflicts with its transfer request")),
        None => {
            receipts.insert(
                receipt_key,
                TransferReceiptEntry::InFlight {
                    fingerprint,
                    waiters: Vec::new(),
                },
            );
            Ok(TransferReceiptLookup::Owner)
        }
    }
}

fn replay_transfer_outcome(outcome: TransferReceiptOutcome) -> Result<Json<ContentTransferResult>, ApiError> {
    match outcome {
        TransferReceiptOutcome::Result(result) => Ok(Json(result)),
        TransferReceiptOutcome::Error(error) => Err(replay_transfer_error(error)),
    }
}

fn transfer_receipt_error(error: &ApiError) -> TransferReceiptError {
    match error {
        ApiError::NotFound(message) => TransferReceiptError {
            status: StatusCode::NOT_FOUND,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::NotFoundWithCode { message, code } => TransferReceiptError {
            status: StatusCode::NOT_FOUND,
            detail: serde_json::Value::String(message.clone()),
            code: Some(code),
        },
        ApiError::BadRequest(message) => TransferReceiptError {
            status: StatusCode::BAD_REQUEST,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::BadRequestWithCode { message, code } => TransferReceiptError {
            status: StatusCode::BAD_REQUEST,
            detail: serde_json::Value::String(message.clone()),
            code: Some(code),
        },
        ApiError::UnprocessableContent(message) => TransferReceiptError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::Forbidden(message) => TransferReceiptError {
            status: StatusCode::FORBIDDEN,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::ForbiddenWithCode { message, code } => TransferReceiptError {
            status: StatusCode::FORBIDDEN,
            detail: serde_json::Value::String(message.clone()),
            code: Some(code),
        },
        ApiError::TooManyRequests(message) => TransferReceiptError {
            status: StatusCode::TOO_MANY_REQUESTS,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::PayloadTooLarge(message) => TransferReceiptError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::Conflict(detail) => TransferReceiptError {
            status: StatusCode::CONFLICT,
            detail: detail.clone(),
            code: None,
        },
        ApiError::ConflictWithCode { message, code } => TransferReceiptError {
            status: StatusCode::CONFLICT,
            detail: serde_json::Value::String(message.clone()),
            code: Some(code),
        },
        ApiError::Io(error) => TransferReceiptError {
            status: match error.kind() {
                std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
                std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            },
            detail: serde_json::Value::String(error.to_string()),
            code: None,
        },
        ApiError::Internal(message) => TransferReceiptError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: serde_json::Value::String(message.clone()),
            code: None,
        },
        ApiError::InternalWithCode { message, code } => TransferReceiptError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: serde_json::Value::String(message.clone()),
            code: Some(code),
        },
    }
}

fn replay_transfer_error(error: TransferReceiptError) -> ApiError {
    let detail = error.detail;
    let message = detail.as_str().unwrap_or_default().to_string();
    match (error.status, error.code) {
        (StatusCode::NOT_FOUND, Some(code)) => ApiError::NotFoundWithCode { message, code },
        (StatusCode::NOT_FOUND, None) => ApiError::NotFound(message),
        (StatusCode::BAD_REQUEST, Some(code)) => ApiError::BadRequestWithCode { message, code },
        (StatusCode::BAD_REQUEST, None) => ApiError::BadRequest(message),
        (StatusCode::UNPROCESSABLE_ENTITY, None) => ApiError::UnprocessableContent(message),
        (StatusCode::FORBIDDEN, Some(code)) => ApiError::ForbiddenWithCode { message, code },
        (StatusCode::FORBIDDEN, None) => ApiError::Forbidden(message),
        (StatusCode::TOO_MANY_REQUESTS, None) => ApiError::TooManyRequests(message),
        (StatusCode::PAYLOAD_TOO_LARGE, None) => ApiError::PayloadTooLarge(message),
        (StatusCode::CONFLICT, Some(code)) => ApiError::ConflictWithCode { message, code },
        (StatusCode::CONFLICT, None) => ApiError::Conflict(detail),
        (StatusCode::INTERNAL_SERVER_ERROR, Some(code)) => ApiError::InternalWithCode { message, code },
        _ => ApiError::Internal(message),
    }
}

fn complete_transfer_receipt(operation: &str, source_drive: &str, body: &CopyMoveRequest, outcome: TransferReceiptOutcome) {
    let key = body.idempotency_key.as_str();
    let receipt_key = transfer_receipt_key(operation, source_drive, key);
    if let Ok(mut receipts) = TRANSFER_RECEIPTS.lock() {
        let Some(entry) = receipts.remove(&receipt_key) else {
            return;
        };
        let (fingerprint, waiters) = match entry {
            TransferReceiptEntry::InFlight { fingerprint, waiters } => (fingerprint, waiters),
            TransferReceiptEntry::Complete(receipt) => (receipt.fingerprint, Vec::new()),
        };
        for waiter in waiters {
            let _ = waiter.send(outcome.clone());
        }
        receipts.insert(
            receipt_key,
            TransferReceiptEntry::Complete(TransferReceipt {
                expires_at: Instant::now() + TRANSFER_RECEIPT_TTL,
                fingerprint,
                outcome,
            }),
        );
    }
}

fn outcome_unknown_transfer_result() -> ContentTransferResult {
    ContentTransferResult {
        status: "outcome_unknown",
        effects: ContentTransferEffects {
            source: "unknown",
            destination: "unknown",
        },
        replaced: false,
        error: Some(ContentTransferError {
            code: "transport",
            detail: "Transfer ended before a factual outcome could be recorded".to_string(),
        }),
    }
}

struct TransferReceiptReservation {
    receipt_key: Option<String>,
}

impl TransferReceiptReservation {
    fn for_request(operation: &str, source_drive: &str, body: &CopyMoveRequest) -> Self {
        Self {
            receipt_key: Some(transfer_receipt_key(operation, source_drive, &body.idempotency_key)),
        }
    }
}

impl Drop for TransferReceiptReservation {
    fn drop(&mut self) {
        let Some(receipt_key) = &self.receipt_key else {
            return;
        };
        let Ok(mut receipts) = TRANSFER_RECEIPTS.lock() else {
            return;
        };
        let Some(entry) = receipts.remove(receipt_key) else {
            return;
        };
        let TransferReceiptEntry::InFlight { fingerprint, waiters } = entry else {
            receipts.insert(receipt_key.clone(), entry);
            return;
        };
        let outcome = TransferReceiptOutcome::Result(outcome_unknown_transfer_result());
        for waiter in waiters {
            let _ = waiter.send(outcome.clone());
        }
        receipts.insert(
            receipt_key.clone(),
            TransferReceiptEntry::Complete(TransferReceipt {
                expires_at: Instant::now() + TRANSFER_RECEIPT_TTL,
                fingerprint,
                outcome,
            }),
        );
    }
}

fn finalize_transfer_result(
    operation: &str,
    source_drive: &str,
    body: &CopyMoveRequest,
    result: ContentTransferResult,
) -> Json<ContentTransferResult> {
    complete_transfer_receipt(operation, source_drive, body, TransferReceiptOutcome::Result(result.clone()));
    Json(result)
}

struct TransferCancellationReservation {
    attempt_id: Option<String>,
    cancellation: Option<Arc<AtomicBool>>,
}

impl TransferCancellationReservation {
    fn for_request(body: &CopyMoveRequest) -> Self {
        let Some(attempt_id) = body.transfer_attempt_id.clone() else {
            return Self {
                attempt_id: None,
                cancellation: None,
            };
        };
        let cancellation = TRANSFER_CANCELLATIONS
            .lock()
            .expect("transfer cancellation registry lock must not be poisoned")
            .entry(attempt_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone();
        Self {
            attempt_id: Some(attempt_id),
            cancellation: Some(cancellation),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.load(Ordering::Acquire))
    }
}

impl Drop for TransferCancellationReservation {
    fn drop(&mut self) {
        let (Some(attempt_id), Some(cancellation)) = (&self.attempt_id, &self.cancellation) else {
            return;
        };
        if let Ok(mut cancellations) = TRANSFER_CANCELLATIONS.lock() {
            if cancellations
                .get(attempt_id)
                .is_some_and(|active| Arc::ptr_eq(active, cancellation))
            {
                cancellations.remove(attempt_id);
            }
        }
    }
}

/// `POST /api/browse/{drive}/transfer-attempts/{attempt_id}/cancel`.
pub async fn browse_cancel_transfer_attempt(Path((_drive, attempt_id)): Path<(String, String)>) -> StatusCode {
    if let Ok(cancellations) = TRANSFER_CANCELLATIONS.lock() {
        if let Some(cancellation) = cancellations.get(&attempt_id) {
            cancellation.store(true, Ordering::Release);
        }
    }
    StatusCode::NO_CONTENT
}

/// `POST /api/browse/{drive}/copy` — copy one regular file.
///
/// Supports cross-drive copy when `dest_connection_id` specifies a
/// different local drive (e.g. copying from drive C to drive D).
pub async fn browse_copy(Path(drive): Path<String>, Json(body): Json<CopyMoveRequest>) -> Result<Json<ContentTransferResult>, ApiError> {
    match reserve_transfer_receipt("copy", &drive, &body)? {
        TransferReceiptLookup::Owner => {}
        TransferReceiptLookup::Cached(outcome) => return replay_transfer_outcome(outcome),
        TransferReceiptLookup::Wait(receiver) => {
            let outcome = receiver
                .await
                .map_err(|_| ApiError::Internal("Transfer owner ended before publishing a result".to_string()))?;
            return replay_transfer_outcome(outcome);
        }
    }
    let _reservation = TransferReceiptReservation::for_request("copy", &drive, &body);
    let cancellation = TransferCancellationReservation::for_request(&body);
    if cancellation.is_cancelled() {
        return Ok(finalize_transfer_result("copy", &drive, &body, cancelled_transfer_result()));
    }
    match execute_browse_copy(&drive, &body, cancellation.cancellation.as_deref()).await {
        Ok(result) => Ok(finalize_transfer_result("copy", &drive, &body, result)),
        Err(error) => {
            complete_transfer_receipt("copy", &drive, &body, TransferReceiptOutcome::Error(transfer_receipt_error(&error)));
            Err(error)
        }
    }
}

async fn execute_browse_copy(
    drive: &str,
    body: &CopyMoveRequest,
    cancellation: Option<&AtomicBool>,
) -> Result<ContentTransferResult, ApiError> {
    if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
        return Ok(cancelled_transfer_result());
    }
    let base_path = drives::resolve_drive_path(drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let (dest_drive, dest_base) = resolve_dest_drive(drive, &body.dest_connection_id)?;

    validate_copy_move_paths(&body.source_path, &body.dest_path)?;

    let source = resolve_safe_path(&base_path, drive, &body.source_path)?;
    let dest = resolve_safe_path_for_new(&dest_base, &dest_drive, &body.dest_path)?;

    let source_meta = tokio::fs::metadata(&source).await.map_err(|e| map_io_error(e, &source))?;

    if !source_meta.is_file() {
        return Err(ApiError::BadRequest(
            "Directory transfers must be coordinated by the client".to_string(),
        ));
    }

    let resolution =
        match resolve_local_regular_file_transfer(&source, &dest, &source_meta, copy_move_target_policy(body)?, cancellation).await {
            Ok(resolution) => resolution,
            Err(LocalTransferWriteError::Io(error)) => return Err(map_io_error(error, &source)),
            Err(LocalTransferWriteError::SourceChanged) => return Ok(source_changed_transfer_result(false)),
            Err(LocalTransferWriteError::Cancelled) => return Ok(cancelled_transfer_result()),
            Err(LocalTransferWriteError::TargetChanged) => {
                return Err(build_conflict_error(&source, &dest, &body.source_path, &body.dest_path).await);
            }
            Err(LocalTransferWriteError::OutcomeUnknown) => return Ok(outcome_unknown_transfer_result()),
        };
    if matches!(
        resolution.disposition,
        TargetResolutionDisposition::CreateNew | TargetResolutionDisposition::ReplaceExisting
    ) {
        debug_assert!(
            resolution.result.is_some(),
            "a committed target mutation must return its stage result"
        );
    }
    if resolution.disposition == TargetResolutionDisposition::AwaitCollision && resolution.target == TargetSnapshot::Missing {
        return Err(ApiError::Internal(
            "Target disappeared during the final collision observation; retry the transfer with a new idempotency key".to_string(),
        ));
    }
    match resolution.disposition {
        TargetResolutionDisposition::Skip => Ok(skipped_transfer_result()),
        TargetResolutionDisposition::CreateNew | TargetResolutionDisposition::ReplaceExisting => {
            log::info!("Copied: {} -> {}", source.display(), dest.display());
            Ok(ContentTransferResult {
                replaced: resolution.replaced,
                ..completed_transfer_result("unchanged", "mutated")
            })
        }
        TargetResolutionDisposition::AwaitCollision => Err(build_conflict_error(&source, &dest, &body.source_path, &body.dest_path).await),
    }
}

/// `POST /api/browse/{drive}/move` — move an item within its local drive.
pub async fn browse_move(Path(drive): Path<String>, Json(body): Json<CopyMoveRequest>) -> Result<Json<ContentTransferResult>, ApiError> {
    match reserve_transfer_receipt("move", &drive, &body)? {
        TransferReceiptLookup::Owner => {}
        TransferReceiptLookup::Cached(outcome) => return replay_transfer_outcome(outcome),
        TransferReceiptLookup::Wait(receiver) => {
            let outcome = receiver
                .await
                .map_err(|_| ApiError::Internal("Transfer owner ended before publishing a result".to_string()))?;
            return replay_transfer_outcome(outcome);
        }
    }
    let _reservation = TransferReceiptReservation::for_request("move", &drive, &body);
    let cancellation = TransferCancellationReservation::for_request(&body);
    if cancellation.is_cancelled() {
        return Ok(finalize_transfer_result("move", &drive, &body, cancelled_transfer_result()));
    }
    match execute_browse_move(&drive, &body, cancellation.cancellation.as_deref()).await {
        Ok(result) => Ok(finalize_transfer_result("move", &drive, &body, result)),
        Err(error) => {
            complete_transfer_receipt("move", &drive, &body, TransferReceiptOutcome::Error(transfer_receipt_error(&error)));
            Err(error)
        }
    }
}

async fn execute_browse_move(
    drive: &str,
    body: &CopyMoveRequest,
    cancellation: Option<&AtomicBool>,
) -> Result<ContentTransferResult, ApiError> {
    if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
        return Ok(cancelled_transfer_result());
    }
    let base_path = drives::resolve_drive_path(drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let (dest_drive, dest_base) = resolve_dest_drive(drive, &body.dest_connection_id)?;
    validate_copy_move_paths(&body.source_path, &body.dest_path)?;
    let source = resolve_safe_path(&base_path, drive, &body.source_path)?;
    let source_meta = tokio::fs::metadata(&source).await.map_err(|error| map_io_error(error, &source))?;
    if !source_meta.is_file() {
        return Err(ApiError::BadRequest(
            "Directory transfers must be coordinated by the client".to_string(),
        ));
    }
    if base_path != dest_base {
        let copy_result = execute_browse_copy(drive, body, cancellation).await?;
        if copy_result.status != "completed" {
            return Ok(copy_result);
        }
        if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
            return Ok(completed_with_source_retained_transfer_result());
        }
        let delete_result = tokio::fs::remove_file(&source).await;
        return Ok(match delete_result {
            Ok(()) => ContentTransferResult {
                replaced: copy_result.replaced,
                ..completed_transfer_result("mutated", "mutated")
            },
            Err(error) => {
                log::warn!(
                    "Copied '{}' across drives but could not remove the original: {error}",
                    source.display()
                );
                ContentTransferResult {
                    replaced: copy_result.replaced,
                    ..completed_with_source_retained_transfer_result()
                }
            }
        });
    }

    let dest = resolve_safe_path_for_new(&dest_base, &dest_drive, &body.dest_path)?;
    let resolution =
        match resolve_local_regular_file_transfer(&source, &dest, &source_meta, copy_move_target_policy(body)?, cancellation).await {
            Ok(resolution) => resolution,
            Err(LocalTransferWriteError::Io(error)) => return Err(map_io_error(error, &source)),
            Err(LocalTransferWriteError::SourceChanged) => return Ok(source_changed_transfer_result(false)),
            Err(LocalTransferWriteError::Cancelled) => return Ok(cancelled_transfer_result()),
            Err(LocalTransferWriteError::TargetChanged) => {
                return Err(build_conflict_error(&source, &dest, &body.source_path, &body.dest_path).await);
            }
            Err(LocalTransferWriteError::OutcomeUnknown) => return Ok(outcome_unknown_transfer_result()),
        };
    match resolution.disposition {
        TargetResolutionDisposition::Skip => return Ok(skipped_transfer_result()),
        TargetResolutionDisposition::AwaitCollision => {
            return Err(build_conflict_error(&source, &dest, &body.source_path, &body.dest_path).await);
        }
        TargetResolutionDisposition::CreateNew | TargetResolutionDisposition::ReplaceExisting => {}
    }
    if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
        return Ok(completed_with_source_retained_transfer_result());
    }
    Ok(match tokio::fs::remove_file(&source).await {
        Ok(()) => ContentTransferResult {
            replaced: resolution.replaced,
            ..completed_transfer_result("mutated", "mutated")
        },
        Err(error) => {
            log::warn!("Copied '{}' but could not remove the original: {error}", source.display());
            ContentTransferResult {
                replaced: resolution.replaced,
                ..completed_with_source_retained_transfer_result()
            }
        }
    })
}

#[derive(Deserialize)]
pub struct StreamTransferQuery {
    path: String,
    target_resolution_policy: Option<String>,
    expected_size: u64,
    source_modified_at: Option<String>,
}

/// `POST /api/browse/{drive}/transfer-stream` — publish a streamed new file.
///
/// This endpoint owns only destination mutation. It writes request bytes to a
/// private sibling stage and publishes through the requested target policy,
/// leaving an interrupted relay without partial output.
pub async fn browse_stream_transfer(
    Path(drive): Path<String>,
    Query(query): Query<StreamTransferQuery>,
    body: Body,
) -> Result<Json<ContentTransferResult>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let destination = resolve_safe_path_for_new(&base_path, &drive, &query.path)?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ApiError::BadRequest("Transfer destination is invalid".to_string()))?;
    validate_name(name)?;
    let target_policy = parse_target_resolution_policy(query.target_resolution_policy.as_deref())?;
    let source_modified_at = parse_stream_source_modified_at(query.source_modified_at.as_deref());
    let target_metadata = match tokio::fs::symlink_metadata(&destination).await {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(map_io_error(error, &destination)),
    };
    let disposition = resolve_target_mutation(target_policy, source_modified_at, target_snapshot(target_metadata.as_ref()));
    match disposition {
        TargetResolutionDisposition::Skip => return Ok(Json(skipped_transfer_result())),
        TargetResolutionDisposition::AwaitCollision => {
            return Err(ApiError::conflict_message(format!("Destination already exists: {}", query.path)));
        }
        TargetResolutionDisposition::CreateNew | TargetResolutionDisposition::ReplaceExisting => {}
    }

    match stage_local_request_body_with_target_policy(
        &destination,
        body,
        query.expected_size,
        disposition == TargetResolutionDisposition::ReplaceExisting,
        Some((target_policy, source_modified_at)),
    )
    .await
    {
        Ok((bytes_written, replaced)) => {
            log::info!(
                "Published cross-provider transfer destination: {} ({} bytes)",
                destination.display(),
                bytes_written
            );
            Ok(Json(ContentTransferResult {
                replaced,
                ..completed_transfer_result("unchanged", "mutated")
            }))
        }
        Err(LocalTransferWriteError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(Json(skipped_transfer_result())),
        Err(LocalTransferWriteError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(ApiError::conflict_message(format!("Destination already exists: {}", query.path)))
        }
        Err(LocalTransferWriteError::TargetChanged) => {
            Err(ApiError::conflict_message(format!("Destination already exists: {}", query.path)))
        }
        Err(LocalTransferWriteError::OutcomeUnknown) => Ok(Json(outcome_unknown_transfer_result())),
        Err(LocalTransferWriteError::Io(error)) if error.kind() == std::io::ErrorKind::InvalidData => {
            Err(ApiError::UnprocessableContent(error.to_string()))
        }
        Err(LocalTransferWriteError::Io(error)) => Err(map_io_error(error, &destination)),
        Err(LocalTransferWriteError::SourceChanged | LocalTransferWriteError::Cancelled) => Err(ApiError::Internal(
            "Unexpected local transfer state while publishing a stream".to_string(),
        )),
    }
}

#[cfg(test)]
async fn stage_local_request_body(
    destination: &FsPath,
    body: Body,
    expected_size: u64,
    replace_existing: bool,
) -> Result<u64, std::io::Error> {
    Ok(
        stage_local_request_body_with_target_policy(destination, body, expected_size, replace_existing, None)
            .await
            .map_err(LocalTransferWriteError::into_io_error)?
            .0,
    )
}

async fn stage_local_request_body_with_target_policy(
    destination: &FsPath,
    mut body: Body,
    expected_size: u64,
    replace_existing: bool,
    target_policy: Option<(TargetResolutionPolicy, Option<DateTime<Utc>>)>,
) -> Result<(u64, bool), LocalTransferWriteError> {
    let parent = destination
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Transfer target has no parent"))?;
    let target_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Transfer target name is not valid UTF-8"))?;
    tokio::fs::create_dir_all(parent).await?;
    let stage = parent.join(format!(".{target_name}.sambee-stage-{}", uuid::Uuid::new_v4()));

    let result: Result<(u64, bool), LocalTransferWriteError> = async {
        let mut output = OpenOptions::new().write(true).create_new(true).open(&stage).await?;
        let mut bytes_written = 0;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|error| std::io::Error::other(format!("Transfer request body failed: {error}")))?;
            if let Ok(data) = frame.into_data() {
                if data.len() as u64 > expected_size.saturating_sub(bytes_written) {
                    return Err(LocalTransferWriteError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("Transfer source size mismatch: expected {expected_size} bytes but received more"),
                    )));
                }
                output.write_all(&data).await?;
                bytes_written += data.len() as u64;
            }
        }
        if bytes_written != expected_size {
            return Err(LocalTransferWriteError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Transfer source size mismatch: expected {expected_size} bytes but received {bytes_written} bytes"),
            )));
        }
        output.flush().await?;
        output.sync_data().await?;
        drop(output);
        let target_metadata = match tokio::fs::symlink_metadata(destination).await {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let final_replace_existing = match target_policy {
            Some((policy, source_modified_at)) => {
                match resolve_target_mutation(policy, source_modified_at, target_snapshot(target_metadata.as_ref())) {
                    TargetResolutionDisposition::CreateNew => false,
                    TargetResolutionDisposition::ReplaceExisting => true,
                    TargetResolutionDisposition::Skip => {
                        return Err(LocalTransferWriteError::Io(std::io::Error::new(
                            std::io::ErrorKind::WouldBlock,
                            "Transfer policy skips the current destination",
                        )));
                    }
                    TargetResolutionDisposition::AwaitCollision => {
                        return Err(LocalTransferWriteError::Io(std::io::Error::from(std::io::ErrorKind::AlreadyExists)));
                    }
                }
            }
            None => replace_existing,
        };
        let outcome = promote_staged_local_file_with_recovery(&stage, destination, final_replace_existing).await?;
        Ok((bytes_written, outcome.replaced()))
    }
    .await;

    if let Err(cleanup_error) = tokio::fs::remove_file(&stage).await {
        if cleanup_error.kind() != std::io::ErrorKind::NotFound {
            warn!("Failed to discard local transfer stage '{}': {cleanup_error}", stage.display());
        }
    }
    result
}

// ─── Direct Open ─────────────────────────────────────────────────────────────

/// Request body for the `POST /api/browse/{drive}/open` endpoint.
#[derive(Deserialize)]
pub struct OpenRequest {
    /// Relative path of the file to open.
    pub path: String,
    /// Whether to force the native app picker instead of auto-using a saved app.
    #[serde(default)]
    pub force_picker: bool,
}

/// `POST /api/browse/{drive}/open` — open a local file through the companion app picker.
///
/// This keeps local-drive Ctrl+Enter behavior aligned with SMB native editing
/// while still opening the real on-disk file directly, without a temp-copy
/// lifecycle.
pub async fn browse_open(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Json(body): Json<OpenRequest>,
) -> Result<StatusCode, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let file_path = resolve_safe_path(&base_path, &drive, &body.path)?;

    let metadata = tokio::fs::metadata(&file_path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found_code(format!("Path not found: {}", file_path.display()), RECENT_FILE_TARGET_MISSING_CODE)
        } else {
            map_io_error(error, &file_path)
        }
    })?;
    if !metadata.is_file() {
        return Err(ApiError::bad_request_code(
            format!("Not a file: {}", file_path.display()),
            RECENT_FILE_TARGET_NOT_FILE_CODE,
        ));
    }

    let extension = file_path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    let selection = commands::open_file::prompt_for_app_selection(&state.app, extension, body.force_picker)
        .await
        .map_err(ApiError::Internal)?;

    let Some(selected_app) = selection else {
        log::info!("User cancelled app picker for local file: {}", file_path.display());
        return Ok(StatusCode::NO_CONTENT);
    };

    commands::open_file::open_in_native_app(&state.app, &file_path, &selected_app.executable, selected_app.handler_id.as_deref())
        .await
        .map_err(|error| ApiError::internal_code(error, RECENT_FILE_NATIVE_LAUNCH_FAILED_CODE))?;

    log::info!(
        "Opened local file with selected app: {} ({})",
        file_path.display(),
        selected_app.name
    );
    Ok(StatusCode::NO_CONTENT)
}

// ─── Archive Creation ───────────────────────────────────────────────────────

fn archive_creation_response(result: LocalArchiveCreationResult) -> ArchiveCreationResponse {
    ArchiveCreationResponse {
        files_created: result.files_created,
        directories_created: result.directories_created,
        source_bytes: result.source_bytes,
    }
}

#[derive(Serialize)]
struct ArchiveCreationMemberCompletion<'a> {
    archive_path: &'a str,
    status: &'static str,
    source_bytes: u64,
}

#[derive(Serialize)]
struct ArchiveRelayFailure<'a> {
    message: &'a str,
}

struct ArchiveRelayTransport {
    client: Client,
    relay_url: String,
    operation_token: String,
}

type ArchiveRelayBinding = CompanionArchiveRelayPurpose;

impl ArchiveRelayTransport {
    fn new(client: Client, relay_url: String, operation_token: String) -> Self {
        Self {
            client,
            relay_url,
            operation_token,
        }
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}/{}", self.relay_url, path))
            .bearer_auth(&self.operation_token)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("{}/{}", self.relay_url, path))
            .bearer_auth(&self.operation_token)
    }

    fn put(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .put(format!("{}/{}", self.relay_url, path))
            .bearer_auth(&self.operation_token)
    }

    async fn begin<T: DeserializeOwned>(&self, request_context: &str) -> Result<T, ApiError> {
        decode_archive_relay_json(
            self.post("begin")
                .send()
                .await
                .map_err(|error| ApiError::Internal(log_request_error(request_context, "POST", self.url(), &error)))?,
            "start",
        )
        .await
    }

    async fn complete_with_json<T: Serialize + ?Sized>(&self, payload: &T, request_context: &str) -> Result<(), ApiError> {
        self.post_json_without_result("complete", payload, request_context, "complete")
            .await
    }

    async fn post_json_without_result<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
        request_context: &str,
        action: &str,
    ) -> Result<(), ApiError> {
        let idempotency_key = uuid::Uuid::new_v4().to_string();
        let response = self
            .send_acknowledgement(
                || {
                    self.post(path)
                        .header(ARCHIVE_RELAY_IDEMPOTENCY_HEADER, &idempotency_key)
                        .json(payload)
                },
                request_context,
            )
            .await?;
        relay_archive_response(response, action).await
    }

    async fn post_json_once_without_result<T: Serialize + ?Sized>(
        &self,
        path: &str,
        payload: &T,
        request_context: &str,
        action: &str,
    ) -> Result<(), ApiError> {
        let response = self
            .post(path)
            .json(payload)
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error(request_context, "POST", self.url(), &error)))?;
        relay_archive_response(response, action).await
    }

    async fn send_acknowledgement(
        &self,
        request: impl Fn() -> reqwest::RequestBuilder,
        request_context: &str,
    ) -> Result<ReqwestResponse, ApiError> {
        let mut last_error = None;
        for _ in 0..ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS {
            match request().send().await {
                Ok(response) => return Ok(response),
                Err(error) => last_error = Some(error),
            }
        }
        let error = last_error.expect("relay acknowledgement attempts should run at least once");
        Err(ApiError::Internal(log_request_error(request_context, "POST", self.url(), &error)))
    }

    async fn fail(&self, message: &str, request_context: &str) -> Result<(), ApiError> {
        self.post_json_once_without_result("fail", &ArchiveRelayFailure { message }, request_context, "record failure")
            .await
    }

    fn url(&self) -> &str {
        &self.relay_url
    }
}

fn archive_relay_transport(
    state: &AppState,
    headers: &HeaderMap,
    server_url: &str,
    operation_id: &str,
    operation_token: String,
    binding: ArchiveRelayBinding,
) -> Result<ArchiveRelayTransport, ApiError> {
    let operation_id =
        uuid::Uuid::parse_str(operation_id).map_err(|_| ApiError::BadRequest("Archive operation ID is invalid".to_string()))?;
    let server_url = normalize_archive_server_url(server_url)?;
    if url::Url::parse(&server_url)
        .map_err(|_| ApiError::BadRequest("Archive server URL is invalid".to_string()))?
        .origin()
        .ascii_serialization()
        != extract_origin(headers)?
    {
        return Err(ApiError::Forbidden(
            "Archive server URL must match the paired browser origin".to_string(),
        ));
    }
    let http_clients = state
        .app
        .try_state::<SambeeHttpClientStore>()
        .map(|clients| clients.inner().clone())
        .ok_or_else(|| ApiError::Internal("Companion backend HTTP client is unavailable".to_string()))?;
    let client = http_clients
        .client_for_server_no_redirects(&server_url)
        .map_err(ApiError::Internal)?;
    Ok(ArchiveRelayTransport::new(
        client,
        archive_relay_url(&server_url, operation_id, binding),
        operation_token,
    ))
}

#[derive(Deserialize)]
struct ArchiveCompanionCapabilityResponse {
    token: String,
    selected_member_paths: Option<Vec<String>>,
}

struct ArchiveRelayCapability {
    server_url: String,
    operation_token: String,
    selected_member_paths: Option<Vec<String>>,
}

async fn mint_archive_relay_capability(
    state: &AppState,
    headers: &HeaderMap,
    operation_id: &str,
) -> Result<ArchiveRelayCapability, ApiError> {
    let operation_id =
        uuid::Uuid::parse_str(operation_id).map_err(|_| ApiError::BadRequest("Archive operation ID is invalid".to_string()))?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.starts_with("Bearer ") && value.len() > "Bearer ".len())
        .ok_or_else(|| ApiError::Forbidden("Browser authentication is required to start archive extraction".to_string()))?;
    let server_url = normalize_archive_server_url(&extract_origin(headers)?)?;
    let http_clients = state
        .app
        .try_state::<SambeeHttpClientStore>()
        .map(|clients| clients.inner().clone())
        .ok_or_else(|| ApiError::Internal("Companion backend HTTP client is unavailable".to_string()))?;
    let client = http_clients
        .client_for_server_no_redirects(&server_url)
        .map_err(ApiError::Internal)?;
    let capability_url = format!("{server_url}/api/archive/v2/operations/{operation_id}/companion-session");
    let response = client
        .post(&capability_url)
        .header("authorization", authorization)
        .send()
        .await
        .map_err(|error| {
            ApiError::Internal(log_request_error(
                "Archive relay capability request",
                "POST",
                &capability_url,
                &error,
            ))
        })?;
    let capability: ArchiveCompanionCapabilityResponse = decode_archive_relay_json(response, "mint archive relay capability").await?;
    Ok(ArchiveRelayCapability {
        server_url,
        operation_token: capability.token,
        selected_member_paths: capability.selected_member_paths,
    })
}

async fn fail_expired_relay_source(state: &AppState, headers: &HeaderMap, operation_id: &str, drive: &str) -> Result<bool, ApiError> {
    let owner_origin = extract_origin(headers)?;
    let Some((server_url, operation_token)) = state
        .archive_sessions
        .take_expired_relay_capability(operation_id, drive, &owner_origin)
        .await
    else {
        return Ok(false);
    };
    let transport = archive_relay_transport(
        state,
        headers,
        &server_url,
        operation_id,
        operation_token,
        ArchiveRelayBinding::LocalZipToSmbExtract,
    )?;
    if let Err(error) = ArchiveExtractionRelay::from_transport(transport).fail().await {
        warn!("Unable to report expired Companion archive relay source {operation_id}: {error}");
    } else {
        state.archive_sessions.confirm_relay_source_terminalized(operation_id).await;
    }
    Ok(true)
}

fn schedule_paused_relay_source_expiry(state: Arc<AppState>, operation_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(ARCHIVE_SESSION_TIMEOUT).await;
        if let Some(capability) = state.archive_sessions.expire_relay_live_source(&operation_id).await {
            if let Err(error) = report_expired_relay_source(&state, capability).await {
                warn!("Unable to report expired Companion archive relay source: {error}");
            }
        }
    });
}

async fn report_expired_relay_source(state: &AppState, capability: ExpiredRelaySourceCapability) -> Result<(), ApiError> {
    let operation_id = uuid::Uuid::parse_str(&capability.operation_id)
        .map_err(|_| ApiError::Internal("Expired archive relay source has an invalid operation ID".to_string()))?;
    let server_url = normalize_archive_server_url(&capability.server_url)?;
    let http_clients = state
        .app
        .try_state::<SambeeHttpClientStore>()
        .map(|clients| clients.inner().clone())
        .ok_or_else(|| ApiError::Internal("Companion backend HTTP client is unavailable".to_string()))?;
    let client = http_clients
        .client_for_server_no_redirects(&server_url)
        .map_err(ApiError::Internal)?;
    ArchiveExtractionRelay::from_transport(ArchiveRelayTransport::new(
        client,
        archive_relay_url(&server_url, operation_id, ArchiveRelayBinding::LocalZipToSmbExtract),
        capability.operation_token,
    ))
    .fail()
    .await?;
    state
        .archive_sessions
        .confirm_relay_source_terminalized(&capability.operation_id)
        .await;
    Ok(())
}

async fn report_relay_source_failure(state: &AppState, relay: &ArchiveExtractionRelay, operation_id: &str, context: &str) {
    if let Err(error) = relay.fail().await {
        warn!("Unable to report failed Companion archive relay {context} {operation_id}: {error}");
    } else {
        state.archive_sessions.confirm_relay_source_terminalized(operation_id).await;
    }
}

struct ArchiveCreationRelay {
    transport: ArchiveRelayTransport,
}

#[cfg(test)]
enum ArchiveCreationAdapterBinding {
    RemoteSourceToLocalDestination {
        manifest: ArchiveCreationManifest,
        drive_root: PathBuf,
        target_path: PathBuf,
    },
    LocalSourceToRemoteDestination {
        entries: Vec<LocalArchiveEntry>,
    },
}

#[cfg(test)]
impl ArchiveCreationAdapterBinding {
    fn topology_plan(&self) -> Result<CompanionArchiveTopologyPlan, ApiError> {
        match self {
            Self::RemoteSourceToLocalDestination { .. } => {
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, false, true)
            }
            Self::LocalSourceToRemoteDestination { .. } => {
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, false)
            }
        }
        .map_err(map_local_archive_error)
    }

    fn prepare(self) -> Result<PreparedArchiveCreationBinding, ApiError> {
        match self {
            Self::RemoteSourceToLocalDestination {
                manifest,
                drive_root,
                target_path,
            } => Ok(PreparedArchiveCreationBinding::RemoteSourceToLocalDestination {
                manifest,
                drive_root,
                target_path,
            }),
            Self::LocalSourceToRemoteDestination { entries } => {
                let manifest = project_local_archive_creation_manifest(&entries).map_err(map_local_archive_error)?;
                Ok(PreparedArchiveCreationBinding::LocalSourceToRemoteDestination { entries, manifest })
            }
        }
    }
}

enum PreparedArchiveCreationBinding {
    RemoteSourceToLocalDestination {
        manifest: ArchiveCreationManifest,
        drive_root: PathBuf,
        target_path: PathBuf,
    },
    LocalSourceToRemoteDestination {
        entries: Vec<LocalArchiveEntry>,
        manifest: ArchiveCreationManifest,
    },
}

#[derive(Clone)]
struct DirectLocalCreationBinding {
    drive_root: PathBuf,
    source_paths: Vec<PathBuf>,
    target_path: PathBuf,
    prepared_plan: Option<(Vec<LocalArchiveEntry>, LocalArchiveCreationExecutionPlan)>,
    #[cfg(test)]
    pre_write_action: Option<super::archive_sessions::CreationPreWriteAction>,
}

enum CompanionArchiveCreationPlan {
    DirectLocal {
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
        binding: DirectLocalCreationBinding,
    },
    #[cfg(test)]
    DirectLocalDeferred {
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
    },
    Relay {
        relay: ArchiveCreationRelay,
        binding: PreparedArchiveCreationBinding,
    },
    RelayPreflightFailure {
        relay: ArchiveCreationRelay,
        error: ApiError,
    },
}

enum CompanionArchiveCreationResult {
    DirectLocalStarted,
    Relay(ArchiveCreationResponse),
}

enum DirectLocalCreationWorkerEvent {
    Plan {
        entries: Vec<LocalArchiveEntry>,
        execution_plan: LocalArchiveCreationExecutionPlan,
    },
    Progress(ArchiveSessionProgress),
}

/// Select and execute the Companion-owned creation adapter for one immutable topology plan.
struct CompanionArchiveCreationCoordinator {
    plan: CompanionArchiveCreationPlan,
}

impl CompanionArchiveCreationCoordinator {
    fn into_plan(self) -> CompanionArchiveCreationPlan {
        self.plan
    }

    fn direct_local(state_store: Arc<ArchiveSessionManager>, execution_id: String, binding: DirectLocalCreationBinding) -> Self {
        Self {
            plan: CompanionArchiveCreationPlan::DirectLocal {
                state_store,
                execution_id,
                binding,
            },
        }
    }

    async fn direct_local_from_session(state_store: Arc<ArchiveSessionManager>, execution_id: String) -> Result<Self, ApiError> {
        let (drive_root, source_paths, target_path) = state_store.direct_local_creation_work(&execution_id).await?;
        let Some((entries, execution_plan)) = state_store.direct_local_creation_plan(&execution_id).await? else {
            #[cfg(not(test))]
            return Err(ApiError::Internal(
                "Direct-local creation preflight plan is unavailable".to_string(),
            ));
            #[cfg(test)]
            return Ok(Self {
                plan: CompanionArchiveCreationPlan::DirectLocalDeferred { state_store, execution_id },
            });
        };
        Ok(Self::direct_local(
            state_store,
            execution_id,
            DirectLocalCreationBinding {
                drive_root,
                source_paths,
                target_path,
                prepared_plan: Some((entries, execution_plan)),
                #[cfg(test)]
                pre_write_action: None,
            },
        ))
    }

    fn relay(relay: ArchiveCreationRelay, binding: PreparedArchiveCreationBinding) -> Self {
        Self {
            plan: CompanionArchiveCreationPlan::Relay { relay, binding },
        }
    }

    fn relay_preflight_failure(relay: ArchiveCreationRelay, error: ApiError) -> Self {
        Self {
            plan: CompanionArchiveCreationPlan::RelayPreflightFailure { relay, error },
        }
    }

    async fn execute(self) -> Result<CompanionArchiveCreationResult, ApiError> {
        match self.plan {
            CompanionArchiveCreationPlan::DirectLocal {
                state_store,
                execution_id,
                binding,
            } => {
                Self::execute_direct_local(state_store, execution_id, binding).await?;
                Ok(CompanionArchiveCreationResult::DirectLocalStarted)
            }
            #[cfg(test)]
            CompanionArchiveCreationPlan::DirectLocalDeferred { state_store, execution_id } => {
                Self::execute_direct_local_deferred(state_store, execution_id).await?;
                Ok(CompanionArchiveCreationResult::DirectLocalStarted)
            }
            CompanionArchiveCreationPlan::Relay { relay, binding } => {
                Self::execute_relay(relay, binding).await.map(CompanionArchiveCreationResult::Relay)
            }
            CompanionArchiveCreationPlan::RelayPreflightFailure { relay, error } => {
                execute_archive_relay(async { Err(error) }, relay.fail()).await
            }
        }
    }

    fn relay_result(result: CompanionArchiveCreationResult) -> Result<ArchiveCreationResponse, ApiError> {
        match result {
            CompanionArchiveCreationResult::Relay(result) => Ok(result),
            CompanionArchiveCreationResult::DirectLocalStarted => Err(ApiError::Internal(
                "Archive creation topology did not produce a relay result".to_string(),
            )),
        }
    }

    async fn execute_relay(
        relay: ArchiveCreationRelay,
        binding: PreparedArchiveCreationBinding,
    ) -> Result<ArchiveCreationResponse, ApiError> {
        let result = execute_archive_relay(
            async {
                match binding {
                    PreparedArchiveCreationBinding::RemoteSourceToLocalDestination {
                        manifest,
                        drive_root,
                        target_path,
                    } => match create_smb_archive_manifest_locally(&relay, &drive_root, &target_path, manifest).await {
                        Ok(result) => Ok(result),
                        Err(error)
                            if target_path.exists()
                                && !is_archive_relay_cancellation(&error)
                                && !is_archive_relay_source_changed(&error)
                                && !is_archive_relay_collision(&error)
                                && !is_archive_relay_transport_failure(&error) =>
                        {
                            Err(ApiError::internal_code(
                                "Archive creation failed after creating incomplete output",
                                LOCAL_ARCHIVE_CREATION_PARTIAL_CODE,
                            ))
                        }
                        Err(error) => Err(error),
                    },
                    PreparedArchiveCreationBinding::LocalSourceToRemoteDestination { entries, manifest } => {
                        create_local_archive_for_smb_destination(&relay, entries, manifest).await
                    }
                }
            },
            relay.fail(),
        )
        .await?;
        relay.complete(&result).await?;
        Ok(result)
    }

    async fn execute_direct_local(
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
        binding: DirectLocalCreationBinding,
    ) -> Result<(), ApiError> {
        let (_, work, cancellation_requested, _) = state_store.start_state(&execution_id).await?;
        if !matches!(work, ArchiveSessionWork::Creation { .. }) {
            return Err(ApiError::conflict_message("Archive execution is not a creation operation"));
        }
        Self::spawn_direct_local_creation(state_store, execution_id, binding, cancellation_requested);
        Ok(())
    }

    #[cfg(test)]
    async fn execute_direct_local_deferred(state_store: Arc<ArchiveSessionManager>, execution_id: String) -> Result<(), ApiError> {
        let (drive_root, work, cancellation_requested, _) = state_store.start_state(&execution_id).await?;
        let ArchiveSessionWork::Creation { source_paths, target_path } = work else {
            return Err(ApiError::conflict_message("Archive execution is not a creation operation"));
        };
        Self::spawn_direct_local_creation(
            state_store,
            execution_id,
            DirectLocalCreationBinding {
                drive_root,
                source_paths,
                target_path,
                prepared_plan: None,
                pre_write_action: None,
            },
            cancellation_requested,
        );
        Ok(())
    }

    fn spawn_direct_local_creation(
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
        binding: DirectLocalCreationBinding,
        cancellation_requested: Arc<AtomicBool>,
    ) {
        tokio::spawn(async move {
            let (event_sender, mut event_receiver) = mpsc::unbounded_channel();
            let mut archive_task = tokio::task::spawn_blocking(move || {
                if cancellation_requested.load(Ordering::Acquire) {
                    return Err(LocalArchiveError::Cancelled);
                }
                let (entries, execution_plan) = match binding.prepared_plan {
                    Some(plan) => plan,
                    None => {
                        let entries = build_local_archive_manifest_with_cancellation(&binding.source_paths, &binding.target_path, || {
                            cancellation_requested.load(Ordering::Acquire)
                        })?;
                        let execution_plan = LocalArchiveCreationExecutionPlan::from_entries(&entries)?;
                        let _ = event_sender.send(DirectLocalCreationWorkerEvent::Plan {
                            entries: entries.clone(),
                            execution_plan: execution_plan.clone(),
                        });
                        (entries, execution_plan)
                    }
                };
                #[cfg(test)]
                if let Some(action) = binding.pre_write_action {
                    action.apply(&binding.source_paths, &cancellation_requested)?;
                }
                create_local_archive_with_execution_plan_progress_and_state(
                    &binding.drive_root,
                    &binding.target_path,
                    &entries,
                    execution_plan,
                    || cancellation_requested.load(Ordering::Acquire),
                    |progress| {
                        let _ = event_sender.send(DirectLocalCreationWorkerEvent::Progress(ArchiveSessionProgress::Creation(progress)));
                    },
                )
                .map(|(result, state)| ArchiveSessionCompletion::CreationCompleted { result, state })
            });
            let result = loop {
                tokio::select! {
                    Some(event) = event_receiver.recv() => match event {
                        DirectLocalCreationWorkerEvent::Plan { entries, execution_plan } => {
                            state_store.record_creation_plan(&execution_id, entries, execution_plan).await;
                        }
                        DirectLocalCreationWorkerEvent::Progress(progress) => state_store.update_progress(&execution_id, progress).await,
                    },
                    result = &mut archive_task => {
                        while let Ok(event) = event_receiver.try_recv() {
                            match event {
                                DirectLocalCreationWorkerEvent::Plan { entries, execution_plan } => {
                                    state_store.record_creation_plan(&execution_id, entries, execution_plan).await;
                                }
                                DirectLocalCreationWorkerEvent::Progress(progress) => state_store.update_progress(&execution_id, progress).await,
                            }
                        }
                        break result
                            .map_err(|error| LocalArchiveError::Io(std::io::Error::other(format!("Archive execution task failed: {error}"))))
                            .and_then(|result| result);
                    }
                }
            };
            state_store.complete(&execution_id, result).await;
        });
    }
}

fn resolve_companion_creation_coordinator(
    topology_plan: CompanionArchiveTopologyPlan,
    plan: CompanionArchiveCreationPlan,
) -> Result<CompanionArchiveCreationCoordinator, ApiError> {
    let binding_matches_topology = matches!(
        (
            topology_plan.kind,
            topology_plan.driver,
            topology_plan.topology,
            topology_plan.source_is_local,
            topology_plan.destination_is_local,
            topology_plan.binding,
            &plan,
        ),
        (
            CompanionArchiveOperationKind::Create,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::LocalToLocal,
            true,
            Some(true),
            CompanionArchiveBinding::LocalToLocal,
            CompanionArchiveCreationPlan::DirectLocal { .. }
        ) | (
            CompanionArchiveOperationKind::Create,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::SmbToLocal,
            false,
            Some(true),
            CompanionArchiveBinding::SmbToLocalRelay,
            CompanionArchiveCreationPlan::Relay { .. }
        ) | (
            CompanionArchiveOperationKind::Create,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::LocalToSmb,
            true,
            Some(false),
            CompanionArchiveBinding::LocalToSmbRelay,
            CompanionArchiveCreationPlan::Relay { .. }
        ) | (
            CompanionArchiveOperationKind::Create,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::SmbToLocal,
            false,
            Some(true),
            CompanionArchiveBinding::SmbToLocalRelay,
            CompanionArchiveCreationPlan::RelayPreflightFailure { .. }
        ) | (
            CompanionArchiveOperationKind::Create,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::LocalToSmb,
            true,
            Some(false),
            CompanionArchiveBinding::LocalToSmbRelay,
            CompanionArchiveCreationPlan::RelayPreflightFailure { .. }
        )
    );
    #[cfg(test)]
    let binding_matches_topology = binding_matches_topology
        || matches!(
            (
                topology_plan.kind,
                topology_plan.driver,
                topology_plan.topology,
                topology_plan.source_is_local,
                topology_plan.destination_is_local,
                topology_plan.binding,
                &plan,
            ),
            (
                CompanionArchiveOperationKind::Create,
                CompanionArchiveExecutionDriver::Companion,
                CompanionArchiveTopology::LocalToLocal,
                true,
                Some(true),
                CompanionArchiveBinding::LocalToLocal,
                CompanionArchiveCreationPlan::DirectLocalDeferred { .. }
            )
        );
    if binding_matches_topology {
        Ok(CompanionArchiveCreationCoordinator { plan })
    } else {
        Err(ApiError::Internal(
            "Archive creation topology did not resolve to a compatible Companion binding".to_string(),
        ))
    }
}

async fn execute_archive_relay<T>(
    operation: impl Future<Output = Result<T, ApiError>>,
    failure_report: impl Future<Output = Result<(), ApiError>>,
) -> Result<T, ApiError> {
    match operation.await {
        Ok(result) => Ok(result),
        Err(error) => {
            let _ = failure_report.await;
            Err(error)
        }
    }
}

#[cfg(test)]
struct FixtureArchiveCreationInvocation {
    relay: ArchiveCreationRelay,
    binding: ArchiveCreationAdapterBinding,
}

#[cfg(test)]
impl FixtureArchiveCreationInvocation {
    async fn execute(self) -> Result<ArchiveCreationResponse, ApiError> {
        let topology_plan = self.binding.topology_plan()?;
        let coordinator = match self.binding.prepare() {
            Ok(binding) => CompanionArchiveCreationCoordinator::relay(self.relay, binding),
            Err(error) => CompanionArchiveCreationCoordinator::relay_preflight_failure(self.relay, error),
        };
        let result = resolve_companion_creation_coordinator(topology_plan, coordinator.into_plan())?
            .execute()
            .await?;
        CompanionArchiveCreationCoordinator::relay_result(result)
    }
}

impl ArchiveCreationRelay {
    fn from_transport(transport: ArchiveRelayTransport) -> Self {
        Self { transport }
    }

    async fn begin_remote_source(&self) -> Result<ArchiveCreationManifest, ApiError> {
        let manifest: ArchiveCreationManifest = self.transport.begin("Archive creation start").await?;
        ArchiveCreationManifest::from_entries(manifest.entries).map_err(map_local_archive_error)
    }

    async fn begin_local_source(&self, manifest: &ArchiveCreationManifest) -> Result<(), ApiError> {
        self.transport
            .post_json_once_without_result("begin", manifest, "Archive creation start", "start")
            .await
    }

    async fn read_source_member(&self, archive_path: &str) -> Result<ReqwestResponse, ApiError> {
        self.transport
            .get("member")
            .query(&[("archive_path", archive_path)])
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error("Archive member relay", "GET", self.transport.url(), &error)))
    }

    async fn complete_source_member(&self, archive_path: &str, status: &'static str, source_bytes: u64) -> Result<(), ApiError> {
        let payload = ArchiveCreationMemberCompletion {
            archive_path,
            status,
            source_bytes,
        };
        self.transport
            .post_json_without_result("member-complete", &payload, "Archive creation member completion", "complete member")
            .await
    }

    async fn stream_source_member(&self, archive_path: &str, source: reqwest::Body) -> Result<ReqwestResponse, ApiError> {
        self.transport
            .put("member")
            .query(&[("archive_path", archive_path)])
            .body(source)
            .send()
            .await
            .map_err(|error| {
                ApiError::Internal(log_request_error(
                    "Archive creation member relay",
                    "PUT",
                    self.transport.url(),
                    &error,
                ))
            })
    }

    async fn complete(&self, result: &ArchiveCreationResponse) -> Result<(), ApiError> {
        self.transport.complete_with_json(result, "Archive creation completion").await
    }

    async fn fail(&self) -> Result<(), ApiError> {
        self.transport
            .fail("Companion local archive creation failed", "Archive creation failure")
            .await
    }
}

#[cfg(test)]
pub(crate) async fn start_direct_local_archive_session(
    state_store: Arc<ArchiveSessionManager>,
    execution_id: &str,
) -> Result<(), ApiError> {
    match state_store.session_kind(execution_id).await? {
        super::archive_sessions::ArchiveSessionKind::Create => {
            resolve_companion_creation_coordinator(
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, true)
                    .map_err(map_local_archive_error)?,
                CompanionArchiveCreationCoordinator::direct_local_from_session(state_store, execution_id.to_string())
                    .await?
                    .into_plan(),
            )?
            .execute()
            .await?;
        }
        super::archive_sessions::ArchiveSessionKind::Extract => {
            resolve_companion_extraction_coordinator(
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Extract, true, true)
                    .map_err(map_local_archive_error)?,
                CompanionArchiveExtractionCoordinator::direct_local_from_session(state_store, execution_id.to_string())
                    .await?
                    .into_plan(),
            )?
            .execute()
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn start_direct_local_archive_session_with_creation_pre_write_action(
    state_store: Arc<ArchiveSessionManager>,
    execution_id: &str,
    pre_write_action: super::archive_sessions::CreationPreWriteAction,
) -> Result<(), ApiError> {
    let (drive_root, source_paths, target_path) = state_store.direct_local_creation_work(execution_id).await?;
    let preflight_sources = source_paths.clone();
    let preflight_target = target_path.clone();
    let entries = tokio::task::spawn_blocking(move || {
        build_local_archive_manifest_with_cancellation(&preflight_sources, &preflight_target, || false)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("Local archive validation task failed: {error}")))?
    .map_err(map_local_archive_error)?;
    let execution_plan = LocalArchiveCreationExecutionPlan::from_entries(&entries).map_err(map_local_archive_error)?;
    state_store
        .record_creation_plan(execution_id, entries.clone(), execution_plan.clone())
        .await;
    resolve_companion_creation_coordinator(
        resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, true).map_err(map_local_archive_error)?,
        CompanionArchiveCreationCoordinator::direct_local(
            state_store,
            execution_id.to_string(),
            DirectLocalCreationBinding {
                drive_root,
                source_paths,
                target_path,
                prepared_plan: Some((entries, execution_plan)),
                pre_write_action: Some(pre_write_action),
            },
        )
        .into_plan(),
    )?
    .execute()
    .await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn decide_direct_local_archive_session(
    state_store: Arc<ArchiveSessionManager>,
    drive: &str,
    owner_origin: &str,
    execution_id: &str,
    expected_revision: u64,
    decision: super::archive_sessions::ArchiveSessionDecision,
) -> Result<ArchiveSessionStatus, ApiError> {
    resolve_companion_extraction_coordinator(
        resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Extract, true, true).map_err(map_local_archive_error)?,
        CompanionArchiveExtractionCoordinator::direct_local_from_session(state_store, execution_id.to_string())
            .await?
            .into_plan(),
    )?
    .decide(drive, owner_origin, execution_id, expected_revision, decision)
    .await
}

struct ArchiveExtractionRelay {
    transport: ArchiveRelayTransport,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ArchiveRelayDestinationStatus {
    Directory,
    Extracted,
    Skipped,
    AwaitingCollision,
}

struct ArchiveRelayDestinationResult {
    status: ArchiveRelayDestinationStatus,
    target_path: String,
    directories_created: u64,
    extracted_bytes: u64,
    replaced: bool,
    target_size: Option<u64>,
    target_modified_at: Option<DateTime<Utc>>,
}

impl ArchiveRelayDestinationResult {
    fn directory(target_path: String, directories_created: u64) -> Self {
        Self {
            status: ArchiveRelayDestinationStatus::Directory,
            target_path,
            directories_created,
            extracted_bytes: 0,
            replaced: false,
            target_size: None,
            target_modified_at: None,
        }
    }

    fn extracted(target_path: String, directories_created: u64, extracted_bytes: u64, replaced: bool) -> Self {
        Self {
            status: ArchiveRelayDestinationStatus::Extracted,
            target_path,
            directories_created,
            extracted_bytes,
            replaced,
            target_size: None,
            target_modified_at: None,
        }
    }

    fn skipped(target_path: String) -> Self {
        Self {
            status: ArchiveRelayDestinationStatus::Skipped,
            target_path,
            directories_created: 0,
            extracted_bytes: 0,
            replaced: false,
            target_size: None,
            target_modified_at: None,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveArchiveExtractionMember {
    source_session_id: String,
    delivery_sequence: u64,
    member_path: String,
    is_directory: bool,
    uncompressed_size: u64,
    modified_at: Option<DateTime<Utc>>,
    target_path: Option<String>,
    collision_policy: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct LiveRemoteSourceStatus {
    phase: String,
    aggregate_counters: LiveRemoteSourceAggregate,
    pending_decision: Option<LiveRemoteSourcePendingDecision>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct LiveRemoteSourcePendingDecision {
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct LiveRemoteSourceAggregate {
    members_processed: u64,
    members_completed: u64,
    members_skipped: u64,
    members_failed: u64,
    files_extracted: u64,
    directories_created: u64,
    extracted_bytes: u64,
    files_replaced: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct LiveArchiveDestinationWriteResult<'a> {
    source_session_id: &'a str,
    delivery_sequence: u64,
    member_path: &'a str,
    status: ArchiveRelayDestinationStatus,
    extracted_bytes: u64,
    directories_created: u64,
    replaced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_modified_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct LiveLocalSourceDestinationWriteResult {
    source_session_id: String,
    delivery_sequence: u64,
    member_path: String,
    status: String,
    #[serde(default)]
    extracted_bytes: u64,
    #[serde(default)]
    directories_created: u64,
    #[serde(default)]
    replaced: bool,
    target_path: Option<String>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct LiveLocalSourceExtractionSummary<'a> {
    source_session_id: &'a str,
    members_processed: u64,
    members_completed: u64,
    members_skipped: u64,
    members_failed: u64,
    files_extracted: u64,
    directories_created: u64,
    extracted_bytes: u64,
    files_replaced: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct LiveLocalSourceDestinationDecision<'a> {
    source_session_id: &'a str,
    delivery_sequence: u64,
    decision_revision: u64,
    action: &'a str,
    member_path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_path: Option<&'a str>,
}

impl ArchiveExtractionRelay {
    fn from_transport(transport: ArchiveRelayTransport) -> Self {
        Self { transport }
    }

    async fn begin_live_remote_source(&self) -> Result<(), ApiError> {
        decode_archive_relay_json(
            self.transport.post("live/begin").send().await.map_err(|error| {
                ApiError::Internal(log_request_error(
                    "Live archive extraction start",
                    "POST",
                    self.transport.url(),
                    &error,
                ))
            })?,
            "start live extraction",
        )
        .await
        .map(|_: serde_json::Value| ())
    }

    async fn next_live_remote_source_member(&self) -> Result<Option<LiveArchiveExtractionMember>, ApiError> {
        let response = self
            .transport
            .get("live/next-member")
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error("Live archive next member", "GET", self.transport.url(), &error)))?;
        decode_archive_relay_json(response, "read next member").await
    }

    async fn read_live_remote_source_member(&self, member: &LiveArchiveExtractionMember) -> Result<ReqwestResponse, ApiError> {
        self.transport
            .get("live/current-member")
            .query(&[
                ("source_session_id", member.source_session_id.as_str()),
                ("delivery_sequence", &member.delivery_sequence.to_string()),
            ])
            .send()
            .await
            .map_err(|error| ApiError::Internal(log_request_error("Live archive member relay", "GET", self.transport.url(), &error)))
    }

    async fn live_remote_source_status(&self) -> Result<LiveRemoteSourceStatus, ApiError> {
        let response = self.transport.get("live/status").send().await.map_err(|error| {
            ApiError::Internal(log_request_error(
                "Live archive extraction status",
                "GET",
                self.transport.url(),
                &error,
            ))
        })?;
        decode_archive_relay_json(response, "read live extraction status").await
    }

    async fn complete_live_remote_source_member(
        &self,
        member: &LiveArchiveExtractionMember,
        result: ArchiveRelayDestinationResult,
    ) -> Result<LiveRemoteSourceStatus, ApiError> {
        let payload = LiveArchiveDestinationWriteResult {
            source_session_id: &member.source_session_id,
            delivery_sequence: member.delivery_sequence,
            member_path: &member.member_path,
            status: result.status,
            extracted_bytes: result.extracted_bytes,
            directories_created: result.directories_created,
            replaced: result.replaced,
            target_path: Some(&result.target_path),
            target_size: result.target_size,
            target_modified_at: result.target_modified_at,
        };
        let response = self.transport.post("live/result").json(&payload).send().await.map_err(|error| {
            ApiError::Internal(log_request_error(
                "Live archive member result",
                "POST",
                self.transport.url(),
                &error,
            ))
        })?;
        decode_archive_relay_json(response, "complete live member").await
    }

    async fn complete_live_remote_source(&self) -> Result<LiveRemoteSourceStatus, ApiError> {
        let response = self.transport.post("live/complete").send().await.map_err(|error| {
            ApiError::Internal(log_request_error(
                "Live archive extraction completion",
                "POST",
                self.transport.url(),
                &error,
            ))
        })?;
        decode_archive_relay_json(response, "complete live extraction").await
    }

    async fn begin_live_local_source_destination(&self) -> Result<(), ApiError> {
        let response = self.transport.post("live/destination-begin").send().await.map_err(|error| {
            ApiError::Internal(log_request_error(
                "Live archive destination start",
                "POST",
                self.transport.url(),
                &error,
            ))
        })?;
        relay_archive_response(response, "start live destination").await
    }

    async fn write_live_local_source_destination_member(
        &self,
        source: Arc<AsyncMutex<LiveLocalArchiveSourceSession>>,
        cancellation_requested: Arc<AtomicBool>,
        source_session_id: String,
        member: super::archive_sessions::LiveLocalArchiveSourceMember,
        target_path: String,
        collision_policy: &'static str,
    ) -> Result<LiveLocalSourceDestinationWriteResult, ApiError> {
        let modified_at = member.entry.modified_at.map(|value| value.to_rfc3339());
        let query = [
            ("source_session_id", source_session_id.clone()),
            ("delivery_sequence", member.delivery_sequence.to_string()),
            ("member_path", member.entry.path.clone()),
            ("target_path", target_path),
            ("is_directory", member.entry.is_directory.to_string()),
            ("collision_policy", collision_policy.to_string()),
        ];
        if member.entry.is_directory {
            {
                let mut source = source.lock().await;
                source
                    .mark_directory_delivery_ready(member.delivery_sequence)
                    .map_err(map_local_archive_error)?;
            }
            let response = self
                .transport
                .put("live/destination-member")
                .query(&query)
                .send()
                .await
                .map_err(|error| {
                    ApiError::Internal(log_request_error(
                        "Live archive directory relay",
                        "PUT",
                        self.transport.url(),
                        &error,
                    ))
                })?;
            return decode_archive_relay_json(response, "write live directory").await;
        }
        let (writer, reader) = tokio::io::duplex(ARCHIVE_COPY_BUFFER_SIZE * 2);
        let stream_source = source.clone();
        let stream_cancellation_requested = cancellation_requested.clone();
        let sequence = member.delivery_sequence;
        let writer_task = tokio::task::spawn_blocking(move || -> Result<(), LocalArchiveError> {
            let mut source = stream_source.blocking_lock();
            let mut output = SyncIoBridge::new(writer);
            source.stream_current_member(sequence, &mut output, &stream_cancellation_requested)?;
            output.flush().map_err(LocalArchiveError::Io)
        });
        let request = self.transport.put("live/destination-member").query(&query);
        let request = if let Some(modified_at) = modified_at {
            request.query(&[("modified_at", modified_at)])
        } else {
            request
        };
        let response = request.body(reqwest::Body::wrap_stream(ReaderStream::new(reader))).send().await;
        let writer_result = writer_task
            .await
            .map_err(|error| ApiError::Internal(format!("Live archive member streaming task failed: {error}")))?;
        if let Err(error) = writer_result {
            if matches!(error, LocalArchiveError::Cancelled) {
                return Err(map_local_archive_error(error));
            }
            if !is_retryable_live_archive_stream_failure(&error) {
                return Err(map_local_archive_error(error));
            }
            return Ok(LiveLocalSourceDestinationWriteResult {
                source_session_id,
                delivery_sequence: member.delivery_sequence,
                member_path: member.entry.path,
                status: "awaiting_retry".to_string(),
                extracted_bytes: 0,
                directories_created: 0,
                replaced: false,
                target_path: None,
                message: Some(format!("Live archive member streaming failed: {error}")),
            });
        }
        let response = response
            .map_err(|error| ApiError::Internal(log_request_error("Live archive member relay", "PUT", self.transport.url(), &error)))?;
        decode_archive_relay_json(response, "write live member").await
    }

    async fn complete_live_local_source_destination(
        &self,
        source_session_id: &str,
        aggregate: super::archive::LocalArchiveExtractionResult,
    ) -> Result<(), ApiError> {
        let payload = LiveLocalSourceExtractionSummary {
            source_session_id,
            members_processed: aggregate.members_processed,
            members_completed: aggregate.members_completed,
            members_skipped: aggregate.members_skipped,
            members_failed: aggregate.members_failed,
            files_extracted: aggregate.files_extracted,
            directories_created: aggregate.directories_created,
            extracted_bytes: aggregate.extracted_bytes,
            files_replaced: aggregate.files_replaced,
        };
        let response = self
            .transport
            .post("live/destination-complete")
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                ApiError::Internal(log_request_error(
                    "Live archive destination completion",
                    "POST",
                    self.transport.url(),
                    &error,
                ))
            })?;
        relay_archive_response(response, "complete live destination").await
    }

    async fn decide_live_local_source_destination(
        &self,
        source_session_id: &str,
        delivery_sequence: u64,
        decision_revision: u64,
        action: &str,
        member_path: &str,
        target_path: Option<&str>,
    ) -> Result<(), ApiError> {
        let payload = LiveLocalSourceDestinationDecision {
            source_session_id,
            delivery_sequence,
            decision_revision,
            action,
            member_path,
            target_path,
        };
        let response = self
            .transport
            .post("live/destination-decision")
            .json(&payload)
            .send()
            .await
            .map_err(|error| {
                ApiError::Internal(log_request_error(
                    "Live archive destination decision",
                    "POST",
                    self.transport.url(),
                    &error,
                ))
            })?;
        relay_archive_response(response, "resolve live destination decision").await
    }

    fn source_read_error(&self, error: &reqwest::Error) -> String {
        log_request_error("Archive member relay", "GET", self.transport.url(), error)
    }

    async fn fail(&self) -> Result<(), ApiError> {
        self.transport
            .post_json_once_without_result(
                "live/fail",
                &ArchiveRelayFailure {
                    message: "Companion local archive extraction failed",
                },
                "Archive extraction failure",
                "record live extraction failure",
            )
            .await
    }
}

enum CompanionArchiveExtractionPlan {
    DirectLocal {
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
    },
}

enum CompanionArchiveExtractionResult {
    DirectLocalStarted,
}

enum DirectLiveExtractionRun {
    Completed(super::archive::LocalArchiveExtractionResult),
    AwaitingCollision {
        result: super::archive::LocalArchiveExtractionResult,
    },
}

/// Select and execute the Companion-owned extraction adapter for one immutable topology plan.
struct CompanionArchiveExtractionCoordinator {
    plan: CompanionArchiveExtractionPlan,
}

impl CompanionArchiveExtractionCoordinator {
    fn into_plan(self) -> CompanionArchiveExtractionPlan {
        self.plan
    }

    fn direct_local(state_store: Arc<ArchiveSessionManager>, execution_id: String) -> Self {
        Self {
            plan: CompanionArchiveExtractionPlan::DirectLocal { state_store, execution_id },
        }
    }

    async fn direct_local_from_session(state_store: Arc<ArchiveSessionManager>, execution_id: String) -> Result<Self, ApiError> {
        state_store.direct_local_extraction_work(&execution_id).await?;
        Ok(Self::direct_local(state_store, execution_id))
    }

    async fn execute(self) -> Result<CompanionArchiveExtractionResult, ApiError> {
        match self.plan {
            CompanionArchiveExtractionPlan::DirectLocal { state_store, execution_id } => {
                Self::execute_direct_local(state_store, execution_id).await?;
                Ok(CompanionArchiveExtractionResult::DirectLocalStarted)
            }
        }
    }

    async fn decide(
        self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
        expected_revision: u64,
        decision: super::archive_sessions::ArchiveSessionDecision,
    ) -> Result<ArchiveSessionStatus, ApiError> {
        match self.plan {
            CompanionArchiveExtractionPlan::DirectLocal { state_store, .. } => {
                let decision_state = state_store.decision_state(drive, owner_origin, execution_id).await?;
                if decision_state.revision != expected_revision {
                    return Err(ApiError::conflict_code(
                        "Archive execution changed before the decision could be applied",
                        super::archive_sessions::ARCHIVE_SESSION_STALE_REVISION_CODE,
                    ));
                }
                if decision_state.phase != super::archive_sessions::ArchiveSessionPhase::AwaitingUserDecision {
                    return Err(ApiError::conflict_message("Archive execution is not awaiting a user decision"));
                }
                let pending_decision = decision_state
                    .pending_decision
                    .ok_or_else(|| ApiError::Internal("Archive extraction decision details are unavailable".to_string()))?;
                if pending_decision.member_path != decision.member_path {
                    return Err(ApiError::conflict_message("Archive decision does not match the pending member"));
                }
                let is_member_error = pending_decision.member_error.is_some();
                let is_directory = pending_decision.is_directory;
                if !matches!(
                    (is_member_error, decision.action),
                    (false, super::archive_sessions::ArchiveSessionDecisionAction::Skip)
                        | (false, super::archive_sessions::ArchiveSessionDecisionAction::SkipAll)
                        | (false, super::archive_sessions::ArchiveSessionDecisionAction::Replace)
                        | (false, super::archive_sessions::ArchiveSessionDecisionAction::ReplaceAll)
                        | (false, super::archive_sessions::ArchiveSessionDecisionAction::ReplaceOlder)
                        | (false, super::archive_sessions::ArchiveSessionDecisionAction::Rename)
                        | (true, super::archive_sessions::ArchiveSessionDecisionAction::Retry)
                        | (true, super::archive_sessions::ArchiveSessionDecisionAction::Ignore)
                ) {
                    return Err(ApiError::conflict_message("Archive decision is not allowed for the pending member"));
                }
                if matches!(decision.action, super::archive_sessions::ArchiveSessionDecisionAction::Rename) {
                    let target_path = decision
                        .target_path
                        .as_deref()
                        .ok_or_else(|| ApiError::BadRequest("Archive rename decisions require a target path".to_string()))?;
                    validate_local_extraction_member_path(target_path, is_directory)
                        .map_err(|_| ApiError::BadRequest("Archive rename target is invalid".to_string()))?;
                } else if decision.target_path.is_some() {
                    return Err(ApiError::BadRequest(
                        "Only archive rename decisions may include a target path".to_string(),
                    ));
                }
                let (drive_root, destination_path, cancellation_requested, source, status) = state_store
                    .resume_live_extraction(drive, owner_origin, execution_id, expected_revision, decision)
                    .await?;
                Self::spawn_direct_local_extraction(
                    state_store,
                    execution_id.to_string(),
                    drive_root,
                    destination_path,
                    cancellation_requested,
                    source,
                );
                Ok(status)
            }
        }
    }
}

fn resolve_companion_extraction_coordinator(
    topology_plan: CompanionArchiveTopologyPlan,
    plan: CompanionArchiveExtractionPlan,
) -> Result<CompanionArchiveExtractionCoordinator, ApiError> {
    let binding_matches_topology = matches!(
        (
            topology_plan.kind,
            topology_plan.driver,
            topology_plan.topology,
            topology_plan.source_is_local,
            topology_plan.destination_is_local,
            topology_plan.binding,
            &plan,
        ),
        (
            CompanionArchiveOperationKind::Extract,
            CompanionArchiveExecutionDriver::Companion,
            CompanionArchiveTopology::LocalToLocal,
            true,
            Some(true),
            CompanionArchiveBinding::LocalToLocal,
            CompanionArchiveExtractionPlan::DirectLocal { .. }
        )
    );
    if binding_matches_topology {
        Ok(CompanionArchiveExtractionCoordinator { plan })
    } else {
        Err(ApiError::Internal(
            "Archive extraction topology did not resolve to a compatible Companion binding".to_string(),
        ))
    }
}

impl CompanionArchiveExtractionCoordinator {
    async fn execute_direct_local(state_store: Arc<ArchiveSessionManager>, execution_id: String) -> Result<(), ApiError> {
        let (drive_root, _archive_path, destination_path, cancellation_requested, source) =
            match state_store.start_live_extraction(&execution_id).await {
                Ok(state) => state,
                Err(error) => {
                    state_store
                        .complete(&execution_id, Err(LocalArchiveError::Io(std::io::Error::other(error.to_string()))))
                        .await;
                    return Ok(());
                }
            };
        Self::spawn_direct_local_extraction(
            state_store,
            execution_id,
            drive_root,
            destination_path,
            cancellation_requested,
            source,
        );
        Ok(())
    }

    fn spawn_direct_local_extraction(
        state_store: Arc<ArchiveSessionManager>,
        execution_id: String,
        drive_root: PathBuf,
        destination_path: PathBuf,
        cancellation_requested: Arc<AtomicBool>,
        source: Arc<AsyncMutex<super::archive_sessions::LiveLocalArchiveSourceSession>>,
    ) {
        tokio::spawn(async move {
            let worker_source = source.clone();
            let result = tokio::task::spawn_blocking(move || {
                extract_live_local_archive(&drive_root, &destination_path, &cancellation_requested, &worker_source).map(|result| {
                    match result {
                        DirectLiveExtractionRun::Completed(result) => ArchiveSessionCompletion::ExtractionCompletedLive { result },
                        DirectLiveExtractionRun::AwaitingCollision { result } => ArchiveSessionCompletion::AwaitingLiveCollision { result },
                    }
                })
            })
            .await
            .map_err(|error| LocalArchiveError::Io(std::io::Error::other(format!("Archive execution task failed: {error}"))))
            .and_then(|result| result);
            if result.is_err() {
                let progress = source.lock().await.aggregate();
                state_store
                    .update_progress(&execution_id, ArchiveSessionProgress::Extraction(progress))
                    .await;
            }
            let awaiting_decision = state_store.complete(&execution_id, result).await;
            if awaiting_decision {
                let state_store = state_store.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(ARCHIVE_SESSION_TIMEOUT).await;
                    state_store.expire_paused_extraction(&execution_id).await;
                });
            }
        });
    }
}

fn extract_live_local_archive(
    drive_root: &FsPath,
    destination_path: &FsPath,
    cancellation_requested: &AtomicBool,
    source: &AsyncMutex<super::archive_sessions::LiveLocalArchiveSourceSession>,
) -> Result<DirectLiveExtractionRun, LocalArchiveError> {
    create_local_extraction_root(drive_root, destination_path)?;
    loop {
        if cancellation_requested.load(Ordering::Acquire) {
            return Err(LocalArchiveError::Cancelled);
        }
        let member = {
            let mut source = source.blocking_lock();
            source.next_destination_member()?
        };
        let Some(member) = member else {
            return Ok(DirectLiveExtractionRun::Completed(source.blocking_lock().aggregate()));
        };
        let (relative_target_path, target_policy) = {
            let source = source.blocking_lock();
            (source.current_target_path()?, source.current_target_policy())
        };
        let target_path = destination_path.join(&relative_target_path);
        let target_path_text = target_path.to_string_lossy().to_string();
        let result = if member.entry.is_directory {
            let directories_created = match ensure_local_extraction_directory(drive_root, destination_path, &target_path)? {
                LocalArchiveDirectoryOutput::Ready { directories_created } => directories_created,
                LocalArchiveDirectoryOutput::AwaitCollision { target } => {
                    return pause_live_local_collision(source, &member, relative_target_path, target);
                }
            };
            let mut source = source.blocking_lock();
            source.mark_directory_delivery_ready(member.delivery_sequence)?;
            LocalArchiveExtractionDestinationResult {
                member_path: member.entry.path,
                status: super::archive::LocalArchiveExtractionDestinationStatus::Directory,
                target_path: target_path_text,
                extracted_bytes: 0,
                directories_created,
                replaced: false,
                renamed: false,
            }
        } else {
            match prepare_local_archive_target_output(drive_root, destination_path, &target_path, target_policy, member.entry.modified_at)?
            {
                LocalArchiveTargetOutput::Ready {
                    mut file,
                    replaced,
                    directories_created,
                } => {
                    if let Err(error) =
                        source
                            .blocking_lock()
                            .stream_current_member(member.delivery_sequence, &mut file, cancellation_requested)
                    {
                        if matches!(error, LocalArchiveError::Cancelled) {
                            return Err(error);
                        }
                        if !is_retryable_live_archive_stream_failure(&error) {
                            return Err(error);
                        }
                        let mut source = source.blocking_lock();
                        source.pause_for_member_error(member.delivery_sequence)?;
                        source.set_pending_decision_details(Some(relative_target_path.clone()), Some(error.to_string()), None, None)?;
                        return Ok(DirectLiveExtractionRun::AwaitingCollision {
                            result: source.aggregate(),
                        });
                    }
                    LocalArchiveExtractionDestinationResult {
                        member_path: member.entry.path,
                        status: super::archive::LocalArchiveExtractionDestinationStatus::Extracted,
                        target_path: target_path_text,
                        extracted_bytes: member.entry.uncompressed_size,
                        directories_created,
                        replaced,
                        renamed: false,
                    }
                }
                LocalArchiveTargetOutput::Skip => {
                    source.blocking_lock().mark_destination_result_ready(member.delivery_sequence)?;
                    LocalArchiveExtractionDestinationResult {
                        member_path: member.entry.path,
                        status: super::archive::LocalArchiveExtractionDestinationStatus::Skipped,
                        target_path: target_path_text,
                        extracted_bytes: 0,
                        directories_created: 0,
                        replaced: false,
                        renamed: false,
                    }
                }
                LocalArchiveTargetOutput::AwaitCollision { target } => {
                    return pause_live_local_collision(source, &member, relative_target_path, target);
                }
            }
        };
        source.blocking_lock().apply_destination_result(member.delivery_sequence, &result)?;
    }
}

fn is_retryable_live_archive_stream_failure(error: &LocalArchiveError) -> bool {
    matches!(error, LocalArchiveError::ArchiveRead(LocalArchiveReadError::MemberIntegrityFailure))
}

fn pause_live_local_collision(
    source: &AsyncMutex<super::archive_sessions::LiveLocalArchiveSourceSession>,
    member: &super::archive_sessions::LiveLocalArchiveSourceMember,
    target_path: String,
    target: super::archive::LocalArchiveConflictTarget,
) -> Result<DirectLiveExtractionRun, LocalArchiveError> {
    let mut source = source.blocking_lock();
    source.pause_for_decision(member.delivery_sequence)?;
    source.set_pending_decision_details(Some(target_path), None, target.size, target.modified_at)?;
    Ok(DirectLiveExtractionRun::AwaitingCollision {
        result: source.aggregate(),
    })
}

async fn execute_relay_creation_to_local_destination(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    body: ArchiveV2RelayCreationLocalDestinationRequest,
) -> Result<Json<ArchiveCreationResponse>, ApiError> {
    let _contract_version = body.contract_version;
    match resolve_companion_archive_topology(CompanionArchiveOperationKind::Create, false, true)? {
        CompanionArchiveTopology::SmbToLocal => {}
        _ => {
            return Err(ApiError::Internal(
                "Archive topology resolution returned an invalid creation owner".to_string(),
            ))
        }
    }
    if body.target_path.trim().is_empty()
        || body.server_url.trim().is_empty()
        || body.operation_id.trim().is_empty()
        || body.operation_token.trim().is_empty()
    {
        return Err(ApiError::BadRequest(
            "Archive target, server, operation, and operation token are required".to_string(),
        ));
    }
    let transport = archive_relay_transport(
        &state,
        &headers,
        &body.server_url,
        &body.operation_id,
        body.operation_token.clone(),
        ArchiveRelayBinding::SmbToLocalZipCreate,
    )?;
    let drive_root = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let target_path = resolve_safe_path_for_new(&drive_root, &drive, &body.target_path)?;
    if target_path.exists() {
        return Err(ApiError::conflict_message("Archive output already exists"));
    }
    let relay = ArchiveCreationRelay::from_transport(transport);
    let manifest = relay.begin_remote_source().await?;
    let result = resolve_companion_creation_coordinator(
        resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, false, true).map_err(map_local_archive_error)?,
        CompanionArchiveCreationCoordinator::relay(
            relay,
            PreparedArchiveCreationBinding::RemoteSourceToLocalDestination {
                manifest,
                drive_root,
                target_path,
            },
        )
        .into_plan(),
    )?
    .execute()
    .await?;
    let result = CompanionArchiveCreationCoordinator::relay_result(result)?;

    Ok(Json(result))
}

async fn execute_relay_creation_from_local_source(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    body: ArchiveV2RelayCreationLocalSourceRequest,
) -> Result<Json<ArchiveCreationResponse>, ApiError> {
    let _contract_version = body.contract_version;
    match resolve_companion_archive_topology(CompanionArchiveOperationKind::Create, true, false)? {
        CompanionArchiveTopology::LocalToSmb => {}
        _ => {
            return Err(ApiError::Internal(
                "Archive topology resolution returned an invalid creation owner".to_string(),
            ))
        }
    }
    if body.source_paths.is_empty()
        || body.target_path.trim().is_empty()
        || body.server_url.trim().is_empty()
        || body.operation_id.trim().is_empty()
        || body.operation_token.trim().is_empty()
    {
        return Err(ApiError::BadRequest(
            "Archive sources, target, server, operation, and operation token are required".to_string(),
        ));
    }
    let transport = archive_relay_transport(
        &state,
        &headers,
        &body.server_url,
        &body.operation_id,
        body.operation_token,
        ArchiveRelayBinding::LocalToSmbZipCreate,
    )?;
    let drive_root = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let sources = body
        .source_paths
        .iter()
        .map(|source_path| resolve_safe_path(&drive_root, &drive, source_path))
        .collect::<Result<Vec<_>, _>>()?;
    let entries = tokio::task::spawn_blocking(move || build_local_archive_manifest_for_remote_target(&sources))
        .await
        .map_err(|error| ApiError::Internal(format!("Local archive validation task failed: {error}")))?
        .map_err(map_local_archive_error)?;
    let relay = ArchiveCreationRelay::from_transport(transport);
    let coordinator = match project_local_archive_creation_manifest(&entries).map_err(map_local_archive_error) {
        Ok(manifest) => CompanionArchiveCreationCoordinator::relay(
            relay,
            PreparedArchiveCreationBinding::LocalSourceToRemoteDestination { entries, manifest },
        ),
        Err(error) => CompanionArchiveCreationCoordinator::relay_preflight_failure(relay, error),
    };
    let result = resolve_companion_creation_coordinator(
        resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, false).map_err(map_local_archive_error)?,
        coordinator.into_plan(),
    )?
    .execute()
    .await?;
    let result = CompanionArchiveCreationCoordinator::relay_result(result)?;
    Ok(Json(result))
}

/// `POST /api/browse/{drive}/archive/v2/relay/creation` — run one scoped mixed creation operation.
pub async fn browse_relay_v2_archive_creation(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2RelayCreationRequest>,
) -> Result<Json<ArchiveCreationResponse>, ArchiveV2Error> {
    match body {
        ArchiveV2RelayCreationRequest::LocalDestination(body) => {
            execute_relay_creation_to_local_destination(State(state), Path(drive), headers, body)
                .await
                .map_err(ArchiveV2Error::from)
        }
        ArchiveV2RelayCreationRequest::LocalSource(body) => {
            execute_relay_creation_from_local_source(State(state), Path(drive), headers, body)
                .await
                .map_err(ArchiveV2Error::from)
        }
    }
}

async fn create_local_archive_for_smb_destination(
    relay: &ArchiveCreationRelay,
    entries: Vec<LocalArchiveEntry>,
    manifest: ArchiveCreationManifest,
) -> Result<ArchiveCreationResponse, ApiError> {
    let mut creation_state = ArchiveCreationManifestState::new(manifest.clone());
    relay.begin_local_source(&manifest).await?;

    for (entry, manifest_entry) in entries.into_iter().zip(&manifest.entries) {
        let archive_path = manifest_entry.archive_path.clone();
        let source = if entry.is_directory {
            reqwest::Body::default()
        } else {
            super::archive::revalidate_local_archive_creation_source(&entry).map_err(map_local_archive_error)?;
            let source_file = File::open(&entry.source_path)
                .await
                .map_err(|error| map_io_error(error, &entry.source_path))?;
            reqwest::Body::wrap_stream(ReaderStream::new(source_file))
        };
        let response = relay.stream_source_member(&archive_path, source).await?;
        relay_archive_response(response, "write archive member").await?;
        creation_state.record_expected(&archive_path).map_err(map_local_archive_error)?;
    }
    creation_state
        .terminal_summary()
        .map(archive_creation_response)
        .map_err(map_local_archive_error)
}

async fn create_smb_archive_manifest_locally(
    relay: &ArchiveCreationRelay,
    drive_root: &FsPath,
    target_path: &FsPath,
    manifest: ArchiveCreationManifest,
) -> Result<ArchiveCreationResponse, ApiError> {
    let mut creation_state = ArchiveCreationManifestState::new(manifest.clone());
    let root_drive = drive_root.to_path_buf();
    let target = target_path.to_path_buf();
    let writer_manifest = manifest.clone();
    let mut writer = tokio::task::spawn_blocking(move || create_local_archive_relay_writer(&root_drive, &target, writer_manifest))
        .await
        .map_err(|error| ApiError::Internal(format!("Local archive creation task failed: {error}")))?
        .map_err(map_local_archive_error)?;

    for entry in manifest.entries {
        if entry.is_directory {
            let archive_path = entry.archive_path;
            let report_path = archive_path.clone();
            writer = tokio::task::spawn_blocking(move || writer.add_directory(&archive_path))
                .await
                .map_err(|error| ApiError::Internal(format!("Local archive directory task failed: {error}")))?
                .map_err(map_local_archive_error)?;
            relay.complete_source_member(&report_path, "directory", 0).await?;
            creation_state.record_expected(&report_path).map_err(map_local_archive_error)?;
            continue;
        }

        let archive_path = entry.archive_path;
        let member_path = archive_path.clone();
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        let write_task = tokio::task::spawn_blocking(move || writer.write_file(&archive_path, receiver));
        let mut response = relay.read_source_member(&member_path).await?;
        if !response.status().is_success() {
            let _ = sender.send(LocalArchiveRelayChunk::Failed).await;
            let _ = write_task.await;
            relay_archive_response(response, "read member").await?;
            return Err(ApiError::Internal("Archive member read failed".to_string()));
        }
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    for chunk in chunk.chunks(ARCHIVE_COPY_BUFFER_SIZE) {
                        sender
                            .send(LocalArchiveRelayChunk::Data(chunk.to_vec()))
                            .await
                            .map_err(|_| ApiError::Internal("Local archive writer stopped accepting source data".to_string()))?;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.send(LocalArchiveRelayChunk::Failed).await;
                    let _ = write_task.await;
                    return Err(ApiError::Internal(log_request_error(
                        "Archive member relay",
                        "GET",
                        relay.transport.url(),
                        &error,
                    )));
                }
            }
        }
        sender
            .send(LocalArchiveRelayChunk::Complete)
            .await
            .map_err(|_| ApiError::Internal("Local archive writer stopped accepting source data".to_string()))?;
        drop(sender);
        writer = write_task
            .await
            .map_err(|error| ApiError::Internal(format!("Local archive member task failed: {error}")))?
            .map_err(map_local_archive_error)?;
        relay.complete_source_member(&member_path, "created", entry.source_size).await?;
        creation_state.record_expected(&member_path).map_err(map_local_archive_error)?;
    }

    tokio::task::spawn_blocking(move || writer.finish())
        .await
        .map_err(|error| ApiError::Internal(format!("Local archive finalization task failed: {error}")))?
        .map_err(map_local_archive_error)?;
    creation_state
        .terminal_summary()
        .map(archive_creation_response)
        .map_err(map_local_archive_error)
}

/// Start a V2-pinned cancellable local archive execution.
async fn start_v2_local_archive_execution(
    state: Arc<AppState>,
    drive: String,
    headers: HeaderMap,
    body: ArchiveV2ExecutionStartRequest,
) -> Result<ArchiveExecutionResponse, ApiError> {
    let owner_origin = extract_origin(&headers)?;
    let execution = match body {
        ArchiveV2ExecutionStartRequest::Create {
            contract_version,
            source_paths,
            target_path,
        } => {
            require_archive_v2_contract_version(contract_version)?;
            match resolve_companion_archive_topology(CompanionArchiveOperationKind::Create, true, true)? {
                CompanionArchiveTopology::LocalToLocal => {}
                _ => {
                    return Err(ApiError::Internal(
                        "Archive topology resolution returned an invalid creation owner".to_string(),
                    ))
                }
            }
            let (base_path, source_paths, target_path) = resolve_local_archive_creation_request(&drive, &source_paths, &target_path)?;
            let preflight_sources = source_paths.clone();
            let preflight_target = target_path.clone();
            let entries = tokio::task::spawn_blocking(move || {
                build_local_archive_manifest_with_cancellation(&preflight_sources, &preflight_target, || false)
            })
            .await
            .map_err(|error| ApiError::Internal(format!("Local archive validation task failed: {error}")))?
            .map_err(map_local_archive_error)?;
            let execution_plan = LocalArchiveCreationExecutionPlan::from_entries(&entries).map_err(map_local_archive_error)?;
            state
                .archive_sessions
                .create_prepared_creation(
                    drive.clone(),
                    owner_origin.clone(),
                    base_path,
                    PreparedLocalArchiveCreation {
                        source_paths,
                        target_path,
                        entries,
                        execution_plan,
                    },
                )
                .await
        }
        ArchiveV2ExecutionStartRequest::Extract {
            contract_version,
            archive_path,
            destination_path,
            destination_drive,
            selected_member_paths,
        } => {
            require_archive_v2_contract_version(contract_version)?;
            match resolve_companion_archive_topology(CompanionArchiveOperationKind::Extract, true, true)? {
                CompanionArchiveTopology::LocalToLocal => {}
                _ => {
                    return Err(ApiError::Internal(
                        "Archive topology resolution returned an invalid extraction owner".to_string(),
                    ))
                }
            }
            let (base_path, archive_path, destination_path) =
                resolve_local_archive_extraction_request(&drive, destination_drive.as_deref(), &archive_path, &destination_path)?;
            let selected_member_roots = canonicalize_local_archive_member_roots(selected_member_paths).map_err(map_local_archive_error)?;
            state
                .archive_sessions
                .create_extraction_with_selection(
                    drive.clone(),
                    owner_origin.clone(),
                    base_path,
                    archive_path,
                    destination_path,
                    selected_member_roots,
                )
                .await
        }
    };
    match execution.kind {
        super::archive_sessions::ArchiveSessionKind::Create => {
            let result = resolve_companion_creation_coordinator(
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, true)
                    .map_err(map_local_archive_error)?,
                CompanionArchiveCreationCoordinator::direct_local_from_session(
                    state.archive_sessions.clone(),
                    execution.execution_id.clone(),
                )
                .await?
                .into_plan(),
            )?
            .execute()
            .await?;
            if !matches!(result, CompanionArchiveCreationResult::DirectLocalStarted) {
                return Err(ApiError::Internal(
                    "Archive creation topology did not start a direct-local session".to_string(),
                ));
            }
        }
        super::archive_sessions::ArchiveSessionKind::Extract => {
            let result = resolve_companion_extraction_coordinator(
                resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Extract, true, true)
                    .map_err(map_local_archive_error)?,
                CompanionArchiveExtractionCoordinator::direct_local_from_session(
                    state.archive_sessions.clone(),
                    execution.execution_id.clone(),
                )
                .await?
                .into_plan(),
            )?
            .execute()
            .await?;
            if !matches!(result, CompanionArchiveExtractionResult::DirectLocalStarted) {
                return Err(ApiError::Internal(
                    "Archive extraction topology did not start a direct-local session".to_string(),
                ));
            }
        }
    }
    let execution = state.archive_sessions.get(&drive, &owner_origin, &execution.execution_id).await?;
    Ok(archive_execution_response(execution))
}

/// `POST /api/browse/{drive}/archive/v2/executions` — start a V2 direct-local execution.
pub async fn browse_start_v2_archive_execution(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2ExecutionStartRequest>,
) -> Result<Json<ArchiveExecutionResponse>, ArchiveV2Error> {
    Ok(Json(start_v2_local_archive_execution(state, drive, headers, body).await?))
}

/// `GET /api/browse/{drive}/archive/v2/executions/{execution_id}` — retrieve V2 local lifecycle state.
pub async fn browse_get_v2_archive_execution(
    State(state): State<Arc<AppState>>,
    Path((drive, execution_id)): Path<(String, String)>,
    headers: HeaderMap,
    _query: ArchiveV2NoQuery,
) -> Result<Json<ArchiveExecutionResponse>, ArchiveV2Error> {
    let execution = state
        .archive_sessions
        .get_v2(&drive, &extract_origin(&headers)?, &execution_id)
        .await?;
    let response = archive_execution_response(execution);
    Ok(Json(response))
}

/// Request cancellation at the next V2 local archive member boundary.
async fn cancel_v2_local_archive_execution(
    state: Arc<AppState>,
    drive: String,
    execution_id: String,
    headers: HeaderMap,
    expected_revision: u64,
) -> Result<ArchiveExecutionResponse, ApiError> {
    let execution = state
        .archive_sessions
        .cancel(&drive, &extract_origin(&headers)?, &execution_id, expected_revision)
        .await?;
    Ok(archive_execution_response(execution))
}

/// `POST /api/browse/{drive}/archive/v2/executions/{execution_id}/cancellation` — cancel a V2 local execution.
pub async fn browse_cancel_v2_archive_execution(
    State(state): State<Arc<AppState>>,
    Path((drive, execution_id)): Path<(String, String)>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2ExecutionCancellationRequest>,
) -> Result<Json<ArchiveExecutionResponse>, ArchiveV2Error> {
    let ArchiveV2ExecutionCancellationRequest {
        contract_version,
        expected_revision,
    } = body;
    require_archive_v2_contract_version(contract_version)?;
    Ok(Json(
        cancel_v2_local_archive_execution(state, drive, execution_id, headers, expected_revision).await?,
    ))
}

/// Apply a V2 decision to a paused local extraction execution.
async fn decide_v2_local_archive_execution(
    state: Arc<AppState>,
    drive: String,
    execution_id: String,
    headers: HeaderMap,
    body: ArchiveV2ExecutionDecisionRequest,
) -> Result<ArchiveExecutionResponse, ApiError> {
    let ArchiveV2ExecutionDecisionRequest {
        contract_version,
        expected_revision,
        source_session_id,
        delivery_sequence,
        decision_revision,
        member_path,
        action,
        target_path,
    } = body;
    require_archive_v2_contract_version(contract_version)?;
    let action = match action {
        ArchiveExecutionDecisionAction::Skip => super::archive_sessions::ArchiveSessionDecisionAction::Skip,
        ArchiveExecutionDecisionAction::SkipAll => super::archive_sessions::ArchiveSessionDecisionAction::SkipAll,
        ArchiveExecutionDecisionAction::Replace => super::archive_sessions::ArchiveSessionDecisionAction::Replace,
        ArchiveExecutionDecisionAction::ReplaceAll => super::archive_sessions::ArchiveSessionDecisionAction::ReplaceAll,
        ArchiveExecutionDecisionAction::ReplaceOlder => super::archive_sessions::ArchiveSessionDecisionAction::ReplaceOlder,
        ArchiveExecutionDecisionAction::Rename => super::archive_sessions::ArchiveSessionDecisionAction::Rename,
        ArchiveExecutionDecisionAction::Retry => super::archive_sessions::ArchiveSessionDecisionAction::Retry,
        ArchiveExecutionDecisionAction::Ignore => super::archive_sessions::ArchiveSessionDecisionAction::Ignore,
    };
    let execution = resolve_companion_extraction_coordinator(
        resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Extract, true, true).map_err(map_local_archive_error)?,
        CompanionArchiveExtractionCoordinator::direct_local_from_session(state.archive_sessions.clone(), execution_id.clone())
            .await?
            .into_plan(),
    )?
    .decide(
        &drive,
        &extract_origin(&headers)?,
        &execution_id,
        expected_revision,
        super::archive_sessions::ArchiveSessionDecision {
            source_session_id,
            delivery_sequence,
            decision_revision,
            member_path,
            action,
            target_path,
        },
    )
    .await?;
    Ok(archive_execution_response(execution))
}

/// `POST /api/browse/{drive}/archive/v2/executions/{execution_id}/decision` — decide a V2 local extraction pause.
pub async fn browse_decide_v2_archive_execution(
    State(state): State<Arc<AppState>>,
    Path((drive, execution_id)): Path<(String, String)>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2ExecutionDecisionRequest>,
) -> Result<Json<ArchiveExecutionResponse>, ArchiveV2Error> {
    Ok(Json(
        decide_v2_local_archive_execution(state, drive, execution_id, headers, body).await?,
    ))
}

async fn execute_relay_extraction_from_local_source(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    body: ArchiveV2RelayExtractionLocalSourceRequest,
) -> Result<Json<ArchiveExtractionResponse>, ApiError> {
    let _contract_version = body.contract_version;
    match resolve_companion_archive_topology(CompanionArchiveOperationKind::Extract, true, false)? {
        CompanionArchiveTopology::LocalToSmb => {}
        _ => {
            return Err(ApiError::Internal(
                "Archive topology resolution returned an invalid extraction owner".to_string(),
            ))
        }
    }
    if body.archive_path.trim().is_empty() || body.operation_id.trim().is_empty() {
        return Err(ApiError::BadRequest("Archive and operation are required".to_string()));
    }
    if fail_expired_relay_source(&state, &headers, &body.operation_id, &drive).await? {
        return Err(ApiError::conflict_message("Archive relay source expired and is unavailable"));
    }
    let capability = mint_archive_relay_capability(&state, &headers, &body.operation_id).await?;
    let selected_member_roots = canonicalize_local_archive_member_roots(capability.selected_member_paths)
        .map_err(|error| ApiError::Internal(format!("Archive capability contains invalid selected member paths: {error}")))?;
    let transport = archive_relay_transport(
        &state,
        &headers,
        &capability.server_url,
        &body.operation_id,
        capability.operation_token.clone(),
        ArchiveRelayBinding::LocalZipToSmbExtract,
    )?;
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let archive_path = resolve_safe_path(&base_path, &drive, &body.archive_path)?;
    let relay = ArchiveExtractionRelay::from_transport(transport);
    let owner_origin = extract_origin(&headers)?;
    let (source, cancellation_requested) = state
        .archive_sessions
        .start_relay_live_source_with_selection(
            &body.operation_id,
            RelayLiveSourceDetails {
                drive: drive.clone(),
                owner_origin,
                archive_path,
                server_url: capability.server_url.clone(),
                operation_token: capability.operation_token.clone(),
                selected_member_roots,
            },
        )
        .await?;
    let result = match extract_local_archive_to_smb_destination_live(&relay, source, cancellation_requested).await {
        Ok(result) => result,
        Err(error) => {
            state.archive_sessions.fail_relay_live_source(&body.operation_id).await;
            report_relay_source_failure(&state, &relay, &body.operation_id, "extraction").await;
            return Err(error);
        }
    };
    if result.phase.is_none() {
        state.archive_sessions.remove_relay_live_source(&body.operation_id).await;
    } else {
        state.archive_sessions.arm_relay_live_source_expiry(&body.operation_id).await?;
        schedule_paused_relay_source_expiry(state.clone(), body.operation_id.clone());
    }
    Ok(Json(result))
}

/// `POST /api/browse/{drive}/archive/v2/relay/extraction/{operation_id}/decision` — resolve a retained local ZIP source decision.
pub async fn browse_decide_v2_relay_extraction(
    State(state): State<Arc<AppState>>,
    Path((drive, operation_id)): Path<(String, String)>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2RelayExtractionDecisionRequest>,
) -> Result<Json<ArchiveExtractionResponse>, ArchiveV2Error> {
    if body.member_path.trim().is_empty() {
        return Err(ApiError::BadRequest("Archive member is required".to_string()).into());
    }
    if fail_expired_relay_source(&state, &headers, &operation_id, &drive)
        .await
        .map_err(ArchiveV2Error::from)?
    {
        return Err(ApiError::conflict_message("Archive relay source expired and is unavailable").into());
    }
    let action = match body.action.as_str() {
        "skip" => super::archive_sessions::ArchiveSessionDecisionAction::Skip,
        "skip_all" => super::archive_sessions::ArchiveSessionDecisionAction::SkipAll,
        "replace" => super::archive_sessions::ArchiveSessionDecisionAction::Replace,
        "replace_all" => super::archive_sessions::ArchiveSessionDecisionAction::ReplaceAll,
        "replace_older" => super::archive_sessions::ArchiveSessionDecisionAction::ReplaceOlder,
        "rename" => super::archive_sessions::ArchiveSessionDecisionAction::Rename,
        "retry" => super::archive_sessions::ArchiveSessionDecisionAction::Retry,
        "ignore" => super::archive_sessions::ArchiveSessionDecisionAction::Ignore,
        _ => return Err(ApiError::BadRequest("Archive decision action is invalid".to_string()).into()),
    };
    let owner_origin = extract_origin(&headers).map_err(ArchiveV2Error::from)?;
    let (source, cancellation_requested) = state
        .archive_sessions
        .relay_live_source(&operation_id, &drive, &owner_origin)
        .await
        .map_err(ArchiveV2Error::from)?;
    let (server_url, operation_token) = state
        .archive_sessions
        .relay_live_capability(&operation_id, &drive, &owner_origin)
        .await
        .map_err(ArchiveV2Error::from)?;
    if matches!(action, super::archive_sessions::ArchiveSessionDecisionAction::Rename) {
        if body.target_path.is_none() {
            return Err(ApiError::BadRequest("Archive rename decisions require a target path".to_string()).into());
        }
    } else if body.target_path.is_some() {
        return Err(ApiError::BadRequest("Only archive rename decisions may include a target path".to_string()).into());
    }
    let transport = archive_relay_transport(
        &state,
        &headers,
        &server_url,
        &operation_id,
        operation_token,
        ArchiveRelayBinding::LocalZipToSmbExtract,
    )
    .map_err(ArchiveV2Error::from)?;
    let relay = ArchiveExtractionRelay::from_transport(transport);
    {
        let mut source = source.lock().await;
        source
            .claim_decision(
                &body.source_session_id,
                body.delivery_sequence,
                body.decision_revision,
                action,
                &body.member_path,
                body.target_path.as_deref(),
            )
            .map_err(map_local_archive_error)
            .map_err(ArchiveV2Error::from)?;
    }
    if let Err(error) = state.archive_sessions.disarm_relay_live_source_expiry(&operation_id).await {
        source.lock().await.abort();
        state.archive_sessions.fail_relay_live_source(&operation_id).await;
        report_relay_source_failure(&state, &relay, &operation_id, "decision expiry").await;
        return Err(ArchiveV2Error::from(error));
    }
    if let Err(error) = relay
        .decide_live_local_source_destination(
            &body.source_session_id,
            body.delivery_sequence,
            body.decision_revision,
            &body.action,
            &body.member_path,
            body.target_path.as_deref(),
        )
        .await
    {
        source.lock().await.abort();
        state.archive_sessions.fail_relay_live_source(&operation_id).await;
        report_relay_source_failure(&state, &relay, &operation_id, "decision").await;
        return Err(ArchiveV2Error::from(error));
    }
    if let Err(error) = source.lock().await.finalize_claimed_decision() {
        source.lock().await.abort();
        state.archive_sessions.fail_relay_live_source(&operation_id).await;
        report_relay_source_failure(&state, &relay, &operation_id, "decision finalization").await;
        return Err(ArchiveV2Error::from(map_local_archive_error(error)));
    }
    let result = match extract_local_archive_to_smb_destination_live(&relay, source, cancellation_requested).await {
        Ok(result) => result,
        Err(error) => {
            state.archive_sessions.fail_relay_live_source(&operation_id).await;
            report_relay_source_failure(&state, &relay, &operation_id, "decision").await;
            return Err(ArchiveV2Error::from(error));
        }
    };
    if result.phase.is_none() {
        state.archive_sessions.remove_relay_live_source(&operation_id).await;
    } else {
        state.archive_sessions.arm_relay_live_source_expiry(&operation_id).await?;
        schedule_paused_relay_source_expiry(state.clone(), operation_id.clone());
    }
    Ok(Json(result))
}

/// `GET /api/browse/{drive}/archive/v2/relay/extraction/{operation_id}/status` — read the retained local ZIP source state.
pub async fn browse_get_v2_relay_extraction_status(
    State(state): State<Arc<AppState>>,
    Path((drive, operation_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ArchiveV2Error> {
    let owner_origin = extract_origin(&headers).map_err(ArchiveV2Error::from)?;
    let (source, _) = state
        .archive_sessions
        .relay_live_source(&operation_id, &drive, &owner_origin)
        .await
        .map_err(ArchiveV2Error::from)?;
    let source = source.lock().await;
    let aggregate = source.aggregate();
    let phase = match source.phase() {
        LiveLocalArchiveSourcePhase::Ready => "ready",
        LiveLocalArchiveSourcePhase::Current => "current",
        LiveLocalArchiveSourcePhase::StreamingCurrent => "streaming_current",
        LiveLocalArchiveSourcePhase::AwaitingResult => "awaiting_result",
        LiveLocalArchiveSourcePhase::AwaitingDecision => "awaiting_decision",
        LiveLocalArchiveSourcePhase::ResolvingDecision => "resolving_decision",
        LiveLocalArchiveSourcePhase::Completed => "completed",
        LiveLocalArchiveSourcePhase::Cancelled => "cancelled",
        LiveLocalArchiveSourcePhase::Failed => "failed",
    };
    let pending_decision = if source.phase() == LiveLocalArchiveSourcePhase::AwaitingDecision {
        let current = source
            .current()
            .ok_or_else(|| ArchiveV2Error::from(ApiError::conflict_message("Archive source member is unavailable")))?;
        if source.pending_member_error() {
            serde_json::json!({
                "revision": source.pending_decision_revision(),
                "kind": "member_error",
                "member_path": current.entry.path,
                "target_path": source.pending_decision_target_path(),
                "message": source.pending_decision_message(),
                "delivery_sequence": current.delivery_sequence,
                "is_directory": current.entry.is_directory,
                "allowed_actions": ["retry", "ignore"],
            })
        } else {
            let target_path = source
                .pending_decision_target_path()
                .ok_or_else(|| ArchiveV2Error::from(ApiError::conflict_message("Archive collision target is unavailable")))?;
            serde_json::json!({
                "revision": source.pending_decision_revision(),
                "kind": "collision",
                "member_path": current.entry.path,
                "delivery_sequence": current.delivery_sequence,
                "is_directory": current.entry.is_directory,
                "allowed_actions": ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
                "source": {
                    "path": current.entry.path,
                    "size": current.entry.uncompressed_size,
                    "modified_at": current.entry.modified_at,
                },
                "target": {
                    "path": target_path,
                    "size": source.pending_decision_target_size(),
                    "modified_at": source.pending_decision_target_modified_at(),
                },
            })
        }
    } else {
        serde_json::Value::Null
    };
    Ok(Json(serde_json::json!({
        "source_session_id": source.source_session_id(),
        "phase": phase,
        "aggregate_counters": {
            "members_processed": aggregate.members_processed,
            "members_completed": aggregate.members_completed,
            "members_skipped": aggregate.members_skipped,
            "members_failed": aggregate.members_failed,
            "files_extracted": aggregate.files_extracted,
            "directories_created": aggregate.directories_created,
            "extracted_bytes": aggregate.extracted_bytes,
            "files_replaced": aggregate.files_replaced,
        },
        "pending_decision": pending_decision,
    })))
}

fn live_source_collision_policy(policy: super::archive::LocalArchiveTargetWritePolicy) -> &'static str {
    match policy {
        super::archive::LocalArchiveTargetWritePolicy::Ask => "ask",
        super::archive::LocalArchiveTargetWritePolicy::Skip => "skip",
        super::archive::LocalArchiveTargetWritePolicy::Replace => "replace",
        super::archive::LocalArchiveTargetWritePolicy::ReplaceOlder => "replace_older",
    }
}

fn live_local_source_pending_response(
    aggregate: super::archive::LocalArchiveExtractionResult,
) -> Result<ArchiveExtractionResponse, ApiError> {
    Ok(archive_extraction_response(aggregate, Some("awaiting_user_decision")))
}

async fn extract_local_archive_to_smb_destination_live(
    relay: &ArchiveExtractionRelay,
    source: Arc<AsyncMutex<LiveLocalArchiveSourceSession>>,
    cancellation_requested: Arc<AtomicBool>,
) -> Result<ArchiveExtractionResponse, ApiError> {
    relay.begin_live_local_source_destination().await?;
    loop {
        let next_member = {
            let mut source = source.lock().await;
            source.next_destination_member().map_err(map_local_archive_error)?
        };
        let Some(member) = next_member else {
            let (aggregate, source_session_id) = {
                let source = source.lock().await;
                (source.aggregate(), source.source_session_id().to_string())
            };
            relay.complete_live_local_source_destination(&source_session_id, aggregate).await?;
            return Ok(archive_extraction_response(aggregate, None));
        };
        let (source_session_id, target_path, collision_policy) = {
            let source = source.lock().await;
            (
                source.source_session_id().to_string(),
                source.current_target_path().map_err(map_local_archive_error)?,
                live_source_collision_policy(source.current_target_policy()),
            )
        };
        let result = relay
            .write_live_local_source_destination_member(
                source.clone(),
                cancellation_requested.clone(),
                source_session_id.clone(),
                member.clone(),
                target_path,
                collision_policy,
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let mut source = source.lock().await;
                source
                    .destination_outcome_unknown(member.delivery_sequence)
                    .map_err(map_local_archive_error)?;
                return Err(error);
            }
        };
        if result.source_session_id != source_session_id
            || result.delivery_sequence != member.delivery_sequence
            || result.member_path != member.entry.path
        {
            let mut source = source.lock().await;
            source
                .destination_outcome_unknown(member.delivery_sequence)
                .map_err(map_local_archive_error)?;
            return Err(ApiError::Internal(
                "Live archive destination result did not match its source delivery".to_string(),
            ));
        }
        let mut source = source.lock().await;
        match result.status.as_str() {
            "directory" | "extracted" | "skipped" | "ignored" => {
                let status = match result.status.as_str() {
                    "directory" => super::archive::LocalArchiveExtractionDestinationStatus::Directory,
                    "extracted" => super::archive::LocalArchiveExtractionDestinationStatus::Extracted,
                    "skipped" => super::archive::LocalArchiveExtractionDestinationStatus::Skipped,
                    "ignored" => super::archive::LocalArchiveExtractionDestinationStatus::Ignored,
                    _ => unreachable!(),
                };
                source
                    .apply_destination_result(
                        member.delivery_sequence,
                        &LocalArchiveExtractionDestinationResult {
                            member_path: result.member_path,
                            status,
                            target_path: result.target_path.unwrap_or_default(),
                            extracted_bytes: result.extracted_bytes,
                            directories_created: result.directories_created,
                            replaced: result.replaced,
                            renamed: false,
                        },
                    )
                    .map_err(map_local_archive_error)?;
            }
            "awaiting_collision" | "awaiting_retry" => {
                if result.status == "awaiting_retry" {
                    source
                        .pause_for_member_error(member.delivery_sequence)
                        .map_err(map_local_archive_error)?;
                } else {
                    source
                        .pause_for_decision(member.delivery_sequence)
                        .map_err(map_local_archive_error)?;
                }
                source
                    .set_pending_decision_details(result.target_path.clone(), result.message.clone(), None, None)
                    .map_err(map_local_archive_error)?;
                let aggregate = source.aggregate();
                return live_local_source_pending_response(aggregate);
            }
            "fatal" => {
                source
                    .fail_current_member(member.delivery_sequence)
                    .map_err(map_local_archive_error)?;
                return Err(ApiError::Internal(
                    result.message.unwrap_or_else(|| "Live archive destination failed".to_string()),
                ));
            }
            _ => {
                source
                    .destination_outcome_unknown(member.delivery_sequence)
                    .map_err(map_local_archive_error)?;
                return Err(ApiError::Internal(
                    "Live archive destination returned an invalid status".to_string(),
                ));
            }
        }
        if source.phase() == LiveLocalArchiveSourcePhase::Failed {
            return Err(ApiError::Internal("Live archive source terminated unexpectedly".to_string()));
        }
    }
}

async fn execute_relay_extraction_to_local_destination(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    body: ArchiveV2RelayExtractionLocalDestinationRequest,
) -> Result<Json<ArchiveExtractionResponse>, ApiError> {
    let _contract_version = body.contract_version;
    match resolve_companion_archive_topology(CompanionArchiveOperationKind::Extract, false, true)? {
        CompanionArchiveTopology::SmbToLocal => {}
        _ => {
            return Err(ApiError::Internal(
                "Archive topology resolution returned an invalid extraction owner".to_string(),
            ))
        }
    }
    if body.destination_path.trim().is_empty() || body.operation_id.trim().is_empty() {
        return Err(ApiError::BadRequest("Destination and operation are required".to_string()));
    }
    let capability = mint_archive_relay_capability(&state, &headers, &body.operation_id).await?;
    let transport = archive_relay_transport(
        &state,
        &headers,
        &capability.server_url,
        &body.operation_id,
        capability.operation_token,
        ArchiveRelayBinding::SmbZipToLocalExtract,
    )?;
    let drive_root = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let destination_path = resolve_safe_path_for_new(&drive_root, &drive, &body.destination_path)?;
    let relay = ArchiveExtractionRelay::from_transport(transport);
    Ok(Json(
        execute_archive_relay(
            extract_smb_archive_to_local_live(&relay, drive_root, destination_path),
            relay.fail(),
        )
        .await?,
    ))
}

/// `POST /api/browse/{drive}/archive/v2/relay/extraction` — run one scoped mixed extraction operation.
pub async fn browse_relay_v2_archive_extraction(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    ArchiveV2Json(body): ArchiveV2Json<ArchiveV2RelayExtractionRequest>,
) -> Result<Json<ArchiveExtractionResponse>, ArchiveV2Error> {
    match body {
        ArchiveV2RelayExtractionRequest::LocalSource(body) => {
            execute_relay_extraction_from_local_source(State(state), Path(drive), headers, body)
                .await
                .map_err(ArchiveV2Error::from)
        }
        ArchiveV2RelayExtractionRequest::LocalDestination(body) => {
            execute_relay_extraction_to_local_destination(State(state), Path(drive), headers, body)
                .await
                .map_err(ArchiveV2Error::from)
        }
    }
}

async fn extract_smb_archive_to_local_live(
    relay: &ArchiveExtractionRelay,
    drive_root: PathBuf,
    destination_path: PathBuf,
) -> Result<ArchiveExtractionResponse, ApiError> {
    relay.begin_live_remote_source().await?;
    let root = destination_path.clone();
    let root_drive = drive_root.clone();
    let _root_created = tokio::task::spawn_blocking(move || create_local_extraction_root(&root_drive, &root))
        .await
        .map_err(|error| ApiError::Internal(format!("Local archive root task failed: {error}")))?
        .map_err(map_local_archive_error)?;
    loop {
        let Some(member) = relay.next_live_remote_source_member().await? else {
            return Ok(live_remote_source_response(relay.complete_live_remote_source().await?));
        };
        validate_local_extraction_member_path(&member.member_path, member.is_directory).map_err(map_local_archive_error)?;
        let relative_target_path = member.target_path.as_deref().unwrap_or(&member.member_path);
        validate_local_extraction_member_path(relative_target_path, member.is_directory).map_err(map_local_archive_error)?;
        let target_policy = local_archive_target_write_policy_from_wire(member.collision_policy.as_deref())
            .ok_or_else(|| ApiError::Internal("Live archive relay returned an invalid collision policy".to_string()))?;
        let target_path = destination_path.join(relative_target_path);
        let target_path_text = target_path.to_string_lossy().to_string();
        if member.is_directory {
            let output = tokio::task::spawn_blocking({
                let drive_root = drive_root.clone();
                let destination_path = destination_path.clone();
                let target_path = target_path.clone();
                move || ensure_local_extraction_directory(&drive_root, &destination_path, &target_path)
            })
            .await
            .map_err(|error| ApiError::Internal(format!("Local archive directory task failed: {error}")))?
            .map_err(map_local_archive_error)?;
            let directories_created = match output {
                LocalArchiveDirectoryOutput::Ready { directories_created } => directories_created,
                LocalArchiveDirectoryOutput::AwaitCollision { target } => {
                    let status = relay
                        .complete_live_remote_source_member(
                            &member,
                            ArchiveRelayDestinationResult {
                                status: ArchiveRelayDestinationStatus::AwaitingCollision,
                                target_path: relative_target_path.to_string(),
                                directories_created: 0,
                                extracted_bytes: 0,
                                replaced: false,
                                target_size: target.size,
                                target_modified_at: target.modified_at,
                            },
                        )
                        .await?;
                    return Ok(live_remote_source_response(status));
                }
            };
            relay
                .complete_live_remote_source_member(
                    &member,
                    ArchiveRelayDestinationResult::directory(target_path_text, directories_created),
                )
                .await?;
            continue;
        }
        let output = tokio::task::spawn_blocking({
            let drive_root = drive_root.clone();
            let destination_path = destination_path.clone();
            let target_path = target_path.clone();
            let modified_at = member.modified_at;
            move || prepare_local_archive_target_output(&drive_root, &destination_path, &target_path, target_policy, modified_at)
        })
        .await
        .map_err(|error| ApiError::Internal(format!("Local archive file task failed: {error}")))?
        .map_err(map_local_archive_error)?;
        let (file, replaced, directories_created) = match output {
            LocalArchiveTargetOutput::Ready {
                file,
                replaced,
                directories_created,
            } => (file, replaced, directories_created),
            LocalArchiveTargetOutput::Skip => {
                relay
                    .complete_live_remote_source_member(&member, ArchiveRelayDestinationResult::skipped(target_path_text))
                    .await?;
                continue;
            }
            LocalArchiveTargetOutput::AwaitCollision { target } => {
                let status = relay
                    .complete_live_remote_source_member(
                        &member,
                        ArchiveRelayDestinationResult {
                            status: ArchiveRelayDestinationStatus::AwaitingCollision,
                            target_path: relative_target_path.to_string(),
                            directories_created: 0,
                            extracted_bytes: 0,
                            replaced: false,
                            target_size: target.size,
                            target_modified_at: target.modified_at,
                        },
                    )
                    .await?;
                return Ok(live_remote_source_response(status));
            }
        };
        let mut output = File::from_std(file);
        let mut response = relay.read_live_remote_source_member(&member).await?;
        relay_archive_response_status(&response, "read live member")?;
        let mut member_bytes = 0_u64;
        while let Some(chunk) = match response.chunk().await {
            Ok(chunk) => chunk,
            Err(error) => {
                let stream_error = ApiError::Internal(relay.source_read_error(&error));
                match relay.live_remote_source_status().await {
                    Ok(status)
                        if status.phase == "awaiting_decision"
                            && status
                                .pending_decision
                                .as_ref()
                                .is_some_and(|decision| decision.kind == "member_error") =>
                    {
                        return Ok(live_remote_source_response(status));
                    }
                    Ok(_) | Err(_) => return Err(stream_error),
                }
            }
        } {
            if chunk.len() as u64 > member.uncompressed_size.saturating_sub(member_bytes) {
                return Err(ApiError::Internal("Live archive member exceeds its declared size".to_string()));
            }
            write_local_archive_member_chunk(&mut output, &chunk, &mut member_bytes)
                .await
                .map_err(|error| ApiError::Internal(error.to_string()))?;
        }
        output.flush().await.map_err(|error| ApiError::Internal(error.to_string()))?;
        if member_bytes != member.uncompressed_size {
            return Err(ApiError::Internal(
                "Live archive member size does not match its declared size".to_string(),
            ));
        }
        relay
            .complete_live_remote_source_member(
                &member,
                ArchiveRelayDestinationResult::extracted(target_path_text, directories_created, member_bytes, replaced),
            )
            .await?;
    }
}

fn live_remote_source_response(status: LiveRemoteSourceStatus) -> ArchiveExtractionResponse {
    archive_extraction_response(
        super::archive::LocalArchiveExtractionResult {
            members_processed: status.aggregate_counters.members_processed,
            members_completed: status.aggregate_counters.members_completed,
            members_skipped: status.aggregate_counters.members_skipped,
            members_failed: status.aggregate_counters.members_failed,
            files_extracted: status.aggregate_counters.files_extracted,
            directories_created: status.aggregate_counters.directories_created,
            extracted_bytes: status.aggregate_counters.extracted_bytes,
            files_replaced: status.aggregate_counters.files_replaced,
        },
        (status.phase == "awaiting_decision").then_some("awaiting_user_decision"),
    )
}

fn archive_extraction_response(
    aggregate: super::archive::LocalArchiveExtractionResult,
    phase: Option<&'static str>,
) -> ArchiveExtractionResponse {
    ArchiveExtractionResponse {
        members_processed: aggregate.members_processed,
        members_completed: aggregate.members_completed,
        members_skipped: aggregate.members_skipped,
        members_failed: aggregate.members_failed,
        files_extracted: aggregate.files_extracted,
        directories_created: aggregate.directories_created,
        extracted_bytes: aggregate.extracted_bytes,
        files_replaced: aggregate.files_replaced,
        phase,
    }
}

fn relay_archive_response_status(response: &ReqwestResponse, action: &str) -> Result<(), ApiError> {
    if response.status().is_success() {
        Ok(())
    } else {
        Err(ApiError::Internal(format!(
            "Archive relay could not {action}: backend returned HTTP {}",
            response.status()
        )))
    }
}

async fn write_local_archive_member_chunk<W>(output: &mut W, chunk: &[u8], accepted_bytes: &mut u64) -> Result<(), std::io::Error>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut offset = 0;
    while offset < chunk.len() {
        let accepted = output.write(&chunk[offset..]).await?;
        if accepted == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "Local archive output accepted no bytes",
            ));
        }
        if accepted > chunk.len() - offset {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Local archive output reported an invalid byte count",
            ));
        }
        offset = offset
            .checked_add(accepted)
            .ok_or_else(|| std::io::Error::other("Local archive chunk write overflow"))?;
        *accepted_bytes = accepted_bytes
            .checked_add(accepted as u64)
            .ok_or_else(|| std::io::Error::other("Local archive member size overflow"))?;
    }
    Ok(())
}

async fn decode_archive_relay_json<T: DeserializeOwned>(response: ReqwestResponse, action: &str) -> Result<T, ApiError> {
    if !response.status().is_success() {
        relay_archive_response(response, action).await?;
        return Err(ApiError::Internal("Archive relay returned an unexpected success state".to_string()));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| ApiError::Internal(format!("Archive relay returned an invalid {action} response: {error}")))
}

fn normalize_archive_server_url(value: &str) -> Result<String, ApiError> {
    let mut url = url::Url::parse(value.trim()).map_err(|_| ApiError::BadRequest("Archive server URL is invalid".to_string()))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::BadRequest("Archive server URL is invalid".to_string()));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ApiError::BadRequest(
            "Archive server URL must not contain query parameters or a fragment".to_string(),
        ));
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn archive_relay_url(server_url: &str, operation_id: uuid::Uuid, binding: ArchiveRelayBinding) -> String {
    format!(
        "{server_url}/api/archive/v2/operations/{operation_id}/relay/{}",
        binding.operation_segment()
    )
}

async fn relay_archive_response(response: ReqwestResponse, action: &str) -> Result<(), ApiError> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.text().await.unwrap_or_default();
    if let Some(message) = classify_proxy_auth_intercept("Archive relay", Some(status), content_type.as_deref(), &body) {
        return Err(ApiError::Forbidden(message));
    }
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| value.get("detail").and_then(serde_json::Value::as_str).map(str::to_owned));
    let message = match detail {
        Some(detail) => format!("Archive relay could not {action}: backend returned HTTP {status}: {detail}"),
        None => format!("Archive relay could not {action}: backend returned HTTP {status}"),
    };
    match status {
        reqwest::StatusCode::CONFLICT => Err(ApiError::conflict_message(message)),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => Err(ApiError::Forbidden(message)),
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY => Err(ApiError::BadRequest(message)),
        _ => Err(ApiError::Internal(message)),
    }
}

fn is_archive_relay_cancellation(error: &ApiError) -> bool {
    match error {
        ApiError::Conflict(serde_json::Value::String(message))
        | ApiError::ConflictWithCode { message, .. }
        | ApiError::BadRequest(message)
        | ApiError::Internal(message)
        | ApiError::Forbidden(message) => message.contains("was cancelled"),
        _ => false,
    }
}

fn is_archive_relay_source_changed(error: &ApiError) -> bool {
    match error {
        ApiError::Conflict(serde_json::Value::String(message))
        | ApiError::ConflictWithCode { message, .. }
        | ApiError::BadRequest(message)
        | ApiError::Internal(message)
        | ApiError::Forbidden(message) => message.contains("source changed"),
        _ => false,
    }
}

fn is_archive_relay_collision(error: &ApiError) -> bool {
    match error {
        ApiError::Conflict(serde_json::Value::String(message)) | ApiError::ConflictWithCode { message, .. } => {
            message.contains("output already exists")
        }
        _ => false,
    }
}

fn is_archive_relay_transport_failure(error: &ApiError) -> bool {
    match error {
        ApiError::Conflict(serde_json::Value::String(message))
        | ApiError::ConflictWithCode { message, .. }
        | ApiError::BadRequest(message)
        | ApiError::BadRequestWithCode { message, .. }
        | ApiError::Internal(message)
        | ApiError::InternalWithCode { message, .. }
        | ApiError::Forbidden(message)
        | ApiError::ForbiddenWithCode { message, .. } => message.contains("HTTP"),
        ApiError::Io(_) => true,
        _ => false,
    }
}

fn map_local_archive_error(error: LocalArchiveError) -> ApiError {
    match error {
        LocalArchiveError::TargetExists | LocalArchiveError::ExtractionTargetExists => {
            ApiError::conflict_message("Archive output already exists")
        }
        LocalArchiveError::ArchiveSourceChanged => {
            ApiError::conflict_code("Archive source changed since extraction began", ARCHIVE_SOURCE_CHANGED_CODE)
        }
        LocalArchiveError::TargetInsideSource => {
            ApiError::BadRequest("Archive output cannot be inside a selected source directory".to_string())
        }
        LocalArchiveError::UnsafeEntryPath
        | LocalArchiveError::TargetOutsideRoot
        | LocalArchiveError::DuplicateEntryPath
        | LocalArchiveError::EmptyCreationManifest
        | LocalArchiveError::InvalidDirectorySourceSize
        | LocalArchiveError::UnknownCreationMember
        | LocalArchiveError::UnknownExtractionMember
        | LocalArchiveError::InvalidCreationOutcome
        | LocalArchiveError::ConflictingCreationOutcome
        | LocalArchiveError::IncompleteCreationManifest
        | LocalArchiveError::UnsupportedSource => ApiError::BadRequest(error.to_string()),
        LocalArchiveError::Cancelled => ApiError::BadRequest("Archive creation was cancelled".to_string()),
        LocalArchiveError::PartialArchiveOutput(error) => {
            warn!("Local archive creation left partial output: {error}");
            ApiError::internal_code(
                "Archive creation failed after creating incomplete output",
                LOCAL_ARCHIVE_CREATION_PARTIAL_CODE,
            )
        }
        LocalArchiveError::Io(error) => ApiError::Io(error),
        LocalArchiveError::Zip(error) => {
            warn!("Local archive creation failed while writing ZIP data: {error}");
            ApiError::Internal("Local archive creation failed".to_string())
        }
        LocalArchiveError::ArchiveRead(error) => map_local_archive_read_error(error),
    }
}

fn map_local_archive_read_error(error: super::archive::LocalArchiveReadError) -> ApiError {
    warn!("Local archive could not be parsed: {error}");
    ApiError::BadRequest(error.to_string())
}

// ─── Directory Search ────────────────────────────────────────────────────────

/// Maximum number of directory results to return per query.
const MAX_SEARCH_RESULTS: usize = 50;

/// Maximum number of directories to index per drive.
///
/// Prevents runaway recursion on very large or deep filesystems.
const MAX_DIRECTORY_SCAN: usize = 100_000;

/// Query parameters for directory search.
#[derive(Deserialize)]
pub struct DirectorySearchQuery {
    /// Search query string (case-insensitive substring match on path).
    pub q: Option<String>,
    /// Whether to include directories with dot-prefixed path segments.
    pub include_dot_directories: Option<bool>,
}

/// `GET /api/browse/{drive}/directories` — search for directories on a local drive.
///
/// Recursively walks the drive, collects directory paths, and returns those
/// matching the query string `q`. Produces the same JSON shape as the
/// backend's `DirectorySearchResult`.
///
/// Unlike the backend, this does not maintain a persistent cache — it walks
/// the filesystem on each request. For typical local drives this is fast
/// enough (< 1s for tens of thousands of directories).
pub async fn browse_search_directories(
    Path(drive): Path<String>,
    Query(query): Query<DirectorySearchQuery>,
) -> Result<Json<DirectorySearchResult>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;

    let canonical_base = std::fs::canonicalize(&base_path).map_err(|e| ApiError::NotFound(format!("Drive root inaccessible: {e}")))?;

    let q = query.q.unwrap_or_default();
    let include_dot_directories = query.include_dot_directories.unwrap_or(false);

    // Walk the directory tree and collect directory paths
    let directories = tokio::task::spawn_blocking({
        let base = canonical_base.clone();
        move || walk_directories(&base, MAX_DIRECTORY_SCAN, include_dot_directories)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("Directory scan task failed: {e}")))?;

    let directory_count = directories.len();

    // Filter by query (case-insensitive substring match)
    let (results, total_matches) = if q.is_empty() {
        (Vec::new(), 0)
    } else {
        let q_lower = q.to_lowercase();
        let matching: Vec<String> = directories
            .into_iter()
            .filter(|path| path.to_lowercase().contains(&q_lower))
            .collect();
        let total = matching.len();
        let truncated = matching.into_iter().take(MAX_SEARCH_RESULTS).collect();
        (truncated, total)
    };

    Ok(Json(DirectorySearchResult {
        results,
        total_matches,
        cache_state: "ready".to_string(),
        directory_count,
    }))
}

/// Recursively walk a directory tree and collect relative directory paths.
///
/// Optionally skips hidden directories (starting with `.`) and stops after
/// `max_dirs` directories to prevent runaway scans on very large filesystems.
fn walk_directories(base: &std::path::Path, max_dirs: usize, include_dot_directories: bool) -> Vec<String> {
    let mut result = Vec::new();
    let mut stack: Vec<PathBuf> = vec![base.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if result.len() >= max_dirs {
            break;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable directories
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // Skip hidden directories
            if !include_dot_directories && name_str.starts_with('.') {
                continue;
            }

            // Build relative path
            if let Ok(rel) = path.strip_prefix(base) {
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                result.push(rel_str);
                stack.push(path);
            }

            if result.len() >= max_dirs {
                break;
            }
        }
    }

    result.sort();
    result
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/// Query parameters for the upload endpoint.
#[derive(Deserialize)]
pub struct UploadQuery {
    /// Destination path (relative to drive root) where the file will be written.
    pub path: String,
    /// Browser editor lease context. All three values are required when any is supplied.
    pub editor_operation_id: Option<String>,
    pub editor_lock_id: Option<String>,
    pub editor_lock_capability: Option<String>,
}

/// Query parameters used to identify the file covered by an edit lock.
#[derive(Deserialize)]
pub struct EditLockPathQuery {
    pub path: String,
}

async fn validate_editor_write_target(dest: &FsPath) -> Result<(), ApiError> {
    match tokio::fs::metadata(dest).await {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(ApiError::BadRequest("Editor writes cannot replace a directory".to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io_error(error, dest)),
    }
}

fn lock_response(lock: super::edit_locks::LocalEditLock) -> EditLockResponse {
    EditLockResponse {
        lock_id: lock.lock_id,
        lock_capability: lock.lock_capability,
        operation_id: lock.operation_id,
        file_path: lock.file_path,
        locked_by: lock.locked_by,
        locked_at: lock.locked_at.to_rfc3339(),
    }
}

async fn check_editor_write_access(path: &FsPath) -> Result<(), ApiError> {
    if !tokio::fs::metadata(path)
        .await
        .map_err(|error| map_io_error(error, path))?
        .is_file()
    {
        return Err(ApiError::BadRequest("Edit locks require an existing regular file".to_string()));
    }
    let probe = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(|error| map_io_error(error, path))?;
    drop(probe);
    Ok(())
}

/// `POST /api/browse/{drive}/lock` — acquire an exclusive local editor lease.
pub async fn browse_acquire_edit_lock(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Query(query): Query<EditLockPathQuery>,
    headers: HeaderMap,
) -> Result<Json<EditLockResponse>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let path = normalize_drive_relative_path(&drive, &query.path)?;
    let full_path = resolve_safe_path(&base_path, &drive, &query.path)?;
    check_editor_write_access(&full_path).await?;
    let lock = state.edit_locks.acquire(&drive, &path, extract_origin(&headers)?).await?;
    Ok(Json(lock_response(lock)))
}

/// `POST /api/browse/{drive}/lock/heartbeat` — renew an active local editor lease.
pub async fn browse_heartbeat_edit_lock(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Query(query): Query<EditLockPathQuery>,
    headers: HeaderMap,
    Json(control): Json<EditLockControlRequest>,
) -> Result<StatusCode, ApiError> {
    let path = normalize_drive_relative_path(&drive, &query.path)?;
    state
        .edit_locks
        .heartbeat(
            &drive,
            &path,
            &extract_origin(&headers)?,
            &control.operation_id,
            &control.lock_id,
            &control.lock_capability,
        )
        .await?;
    Ok(StatusCode::OK)
}

/// `DELETE /api/browse/{drive}/lock` — release an active local editor lease.
pub async fn browse_release_edit_lock(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Query(query): Query<EditLockPathQuery>,
    headers: HeaderMap,
    Json(control): Json<EditLockControlRequest>,
) -> Result<StatusCode, ApiError> {
    let path = normalize_drive_relative_path(&drive, &query.path)?;
    state
        .edit_locks
        .release(
            &drive,
            &path,
            &extract_origin(&headers)?,
            &control.operation_id,
            &control.lock_id,
            &control.lock_capability,
        )
        .await?;
    Ok(StatusCode::OK)
}

/// `GET /api/browse/{drive}/lock-status` — return display-safe local lease state.
pub async fn browse_edit_lock_status(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Query(query): Query<EditLockPathQuery>,
) -> Result<Json<EditLockStatusResponse>, ApiError> {
    let path = normalize_drive_relative_path(&drive, &query.path)?;
    let response = match state.edit_locks.status(&drive, &path).await {
        Some(lock) => EditLockStatusResponse {
            locked: true,
            locked_by: Some(lock.locked_by),
            locked_at: Some(lock.locked_at.to_rfc3339()),
        },
        None => EditLockStatusResponse {
            locked: false,
            locked_by: None,
            locked_at: None,
        },
    };
    Ok(Json(response))
}

/// `POST /api/browse/{drive}/upload` — upload a file to a local drive.
///
/// Accepts multipart form data with a single file field named `file`.
/// Writes the file to the specified `path` on the drive.
/// Returns `UploadResponse` matching the backend's contract.
pub async fn browse_upload(
    State(state): State<Arc<AppState>>,
    Path(drive): Path<String>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    mut multipart: axum::extract::Multipart,
) -> Result<Json<UploadResponse>, ApiError> {
    let base_path = drives::resolve_drive_path(&drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let normalized_path = normalize_drive_relative_path(&drive, &query.path)?;
    let dest = resolve_safe_path_for_new(&base_path, &drive, &query.path)?;

    let has_editor_lock_context =
        query.editor_operation_id.is_some() || query.editor_lock_id.is_some() || query.editor_lock_capability.is_some();
    if has_editor_lock_context {
        let operation_id = query
            .editor_operation_id
            .as_deref()
            .ok_or_else(|| ApiError::BadRequest("Missing browser editor lock context".to_string()))?;
        let lock_id = query
            .editor_lock_id
            .as_deref()
            .ok_or_else(|| ApiError::BadRequest("Missing browser editor lock context".to_string()))?;
        let lock_capability = query
            .editor_lock_capability
            .as_deref()
            .ok_or_else(|| ApiError::BadRequest("Missing browser editor lock context".to_string()))?;
        validate_editor_write_target(&dest).await?;
        state
            .edit_locks
            .validate(
                &drive,
                &normalized_path,
                &extract_origin(&headers)?,
                operation_id,
                lock_id,
                lock_capability,
            )
            .await
            .map_err(|error| match error {
                ApiError::NotFoundWithCode { .. } => ApiError::not_found_code("Edit lock not found or expired", EDIT_LOCK_LOST_CODE),
                other => other,
            })?;
    }

    // Read the file field from the multipart body
    let mut file_data: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Invalid multipart data: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::Internal(format!("Failed to read upload data: {e}")))?;
            file_data = Some(bytes.to_vec());
            break;
        }
    }

    let data = file_data.ok_or_else(|| ApiError::BadRequest("Missing 'file' field in multipart data".to_string()))?;

    // Ensure parent directory exists
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| map_io_error(e, parent))?;
    }

    let size = data.len() as u64;
    tokio::fs::write(&dest, &data).await.map_err(|e| map_io_error(e, &dest))?;

    // Read metadata for the response
    let last_modified = tokio::fs::metadata(&dest).await.ok().and_then(|m| m.modified().ok()).map(|t| {
        let dt: DateTime<Utc> = t.into();
        dt.to_rfc3339()
    });

    log::info!("Uploaded {} bytes to {}", size, dest.display());

    Ok(Json(UploadResponse {
        status: "ok".to_string(),
        path: normalized_path,
        size,
        last_modified,
    }))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Resolve the destination drive for cross-drive copy/move operations.
///
/// If `dest_connection_id` is `None` or refers to the same drive, returns
/// the source `base_path`. If it refers to a different local drive, resolves
/// and returns that drive's root path.
fn resolve_dest_drive(source_drive: &str, dest_connection_id: &Option<String>) -> Result<(String, PathBuf), ApiError> {
    let dest_drive_id = match dest_connection_id {
        Some(conn_id) => {
            // Extract drive ID from "local-drive:X" format
            conn_id.strip_prefix(LOCAL_DRIVE_PREFIX).unwrap_or(conn_id).to_string()
        }
        None => {
            let base =
                drives::resolve_drive_path(source_drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {source_drive}")))?;
            return Ok((source_drive.to_string(), base));
        }
    };

    // Same drive — no cross-drive operation needed
    if dest_drive_id == source_drive {
        let base = drives::resolve_drive_path(source_drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {source_drive}")))?;
        return Ok((source_drive.to_string(), base));
    }

    let base = drives::resolve_drive_path(&dest_drive_id)
        .ok_or_else(|| ApiError::NotFound(format!("Unknown destination drive: {dest_drive_id}")))?;
    Ok((dest_drive_id, base))
}

fn normalize_drive_relative_path(drive: &str, path: &str) -> Result<String, ApiError> {
    let normalized = path.replace('\\', "/");

    if drive.len() == 1 {
        let bytes = normalized.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let requested_drive = normalized[..1].to_ascii_lowercase();
            let active_drive = drive.to_ascii_lowercase();

            if requested_drive == active_drive {
                return Ok(normalized[2..].trim_start_matches('/').to_string());
            }

            return Err(ApiError::BadRequest(format!(
                "Path targets drive {requested_drive}, not drive {active_drive}"
            )));
        }
    }

    Ok(normalized.trim_start_matches('/').to_string())
}

/// Resolve a relative path against a base path, preventing path traversal.
fn resolve_safe_path(base: &std::path::Path, drive: &str, relative: &str) -> Result<PathBuf, ApiError> {
    let full = resolve_drive_relative_source_path(base, drive, relative)?;

    // Verify the resolved path is still under the base.
    let canonical_base = std::fs::canonicalize(base).map_err(|e| ApiError::NotFound(format!("Drive root inaccessible: {e}")))?;

    let canonical_full = std::fs::canonicalize(&full).map_err(|e| map_io_error(e, &full))?;

    if !canonical_full.starts_with(&canonical_base) {
        return Err(ApiError::Forbidden("Path is outside the drive boundary".to_string()));
    }

    Ok(canonical_full)
}

/// Build an uncanonicalized path under a drive root after rejecting traversal.
fn resolve_drive_relative_source_path(base: &std::path::Path, drive: &str, relative: &str) -> Result<PathBuf, ApiError> {
    let clean = normalize_drive_relative_path(drive, relative)?;

    for component in clean.split('/') {
        if component == ".." {
            return Err(ApiError::BadRequest("Path traversal not allowed".to_string()));
        }
    }

    let full = if clean.is_empty() { base.to_path_buf() } else { base.join(&clean) };
    Ok(full)
}

/// Validate an activation source without resolving its links.
///
/// Resolution is deliberately deferred to `resolve_activation_target` so a
/// valid link may cross to another exposed local drive. Other browse actions
/// continue to use `resolve_safe_path` and therefore remain root-bound.
fn resolve_activation_source_path(base: &std::path::Path, drive: &str, relative: &str) -> Result<PathBuf, ApiError> {
    resolve_drive_relative_source_path(base, drive, relative)
}

fn map_link_resolution_error(error: LinkResolutionError) -> ApiError {
    match error {
        LinkResolutionError::TargetMissing => ApiError::not_found_code("The link target no longer exists", LOCAL_LINK_TARGET_MISSING_CODE),
        LinkResolutionError::TargetAccessDenied => {
            ApiError::forbidden_code("The link target is not accessible", LOCAL_LINK_TARGET_ACCESS_DENIED_CODE)
        }
        LinkResolutionError::Unresolvable(message) => ApiError::bad_request_code(message, LOCAL_LINK_TARGET_UNRESOLVABLE_CODE),
    }
}

async fn source_link_kind(path: &std::path::Path) -> Result<Option<LinkKind>, std::io::Error> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if metadata.file_type().is_symlink() {
        return Ok(Some(LinkKind::FilesystemLink));
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;

        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            return Ok(Some(LinkKind::FilesystemLink));
        }
        if path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("lnk")) {
            return Ok(Some(LinkKind::WindowsShortcut));
        }
    }

    Ok(None)
}

fn classify_link_target_metadata(metadata: &std::fs::Metadata) -> LinkTargetType {
    if metadata.is_dir() {
        LinkTargetType::Directory
    } else if metadata.is_file() {
        LinkTargetType::File
    } else {
        LinkTargetType::Other
    }
}

async fn classify_link_target(path: &std::path::Path) -> Result<LinkTargetType, ApiError> {
    let metadata = tokio::fs::metadata(path).await.map_err(|error| map_io_error(error, path))?;
    Ok(classify_link_target_metadata(&metadata))
}

fn link_target_state_from_error(error: LinkResolutionError) -> LinkTargetState {
    match error {
        LinkResolutionError::TargetMissing => LinkTargetState::Missing,
        LinkResolutionError::TargetAccessDenied => LinkTargetState::AccessDenied,
        LinkResolutionError::Unresolvable(_) => LinkTargetState::Unresolvable,
    }
}

fn link_target_state_from_io_error(error: &std::io::Error) -> LinkTargetState {
    match error.kind() {
        std::io::ErrorKind::NotFound => LinkTargetState::Missing,
        std::io::ErrorKind::PermissionDenied => LinkTargetState::AccessDenied,
        _ => LinkTargetState::Unresolvable,
    }
}

fn display_target_path(path: &std::path::Path) -> String {
    let path = path.to_string_lossy();

    #[cfg(windows)]
    {
        normalize_windows_display_path(&path)
    }

    #[cfg(not(windows))]
    {
        path.into_owned()
    }
}

#[cfg(any(windows, test))]
fn normalize_windows_display_path(path: &str) -> String {
    if let Some(unc_path) = path.strip_prefix(WINDOWS_EXTENDED_UNC_PATH_PREFIX) {
        return format!("{WINDOWS_UNC_PATH_PREFIX}{unc_path}");
    }

    path.strip_prefix(WINDOWS_EXTENDED_PATH_PREFIX).unwrap_or(path).to_string()
}

fn resolve_link_target_metadata(source_path: String, source: PathBuf) -> LinkTargetResolution {
    let target_path = match resolve_activation_target(&source) {
        Ok(path) => path,
        Err(error) => {
            return LinkTargetResolution {
                source_path,
                state: link_target_state_from_error(error),
                target: None,
            };
        }
    };
    let metadata = match std::fs::metadata(&target_path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return LinkTargetResolution {
                source_path,
                state: link_target_state_from_io_error(&error),
                target: None,
            };
        }
    };
    let target_type = classify_link_target_metadata(&metadata);
    let target_name = target_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty());
    let (state, target_display_path) = if drives::drive_for_path(&target_path).is_some() {
        (LinkTargetState::Resolved, Some(display_target_path(&target_path)))
    } else {
        (LinkTargetState::UnmappedDrive, None)
    };

    LinkTargetResolution {
        source_path,
        state,
        target: target_name.map(|name| LinkTargetInfo {
            name,
            path: target_display_path,
            target_type,
        }),
    }
}

async fn collect_link_target_resolution(
    pending: &mut JoinSet<LinkTargetResolution>,
    items: &mut Vec<LinkTargetResolution>,
) -> Result<(), ApiError> {
    if let Some(result) = pending.join_next().await {
        let item = result.map_err(|error| ApiError::Internal(format!("Link target resolution task failed: {error}")))?;
        items.push(item);
    }
    Ok(())
}

/// Build a `FileInfo` from a `DirEntry`.
async fn build_file_info(entry: &tokio::fs::DirEntry, parent_path: &str) -> Result<FileInfo, std::io::Error> {
    let filesystem_path = entry.path();
    let link_kind = source_link_kind(&filesystem_path).await?;
    let (metadata, is_readable) = match tokio::fs::metadata(&filesystem_path).await {
        Ok(metadata) => (metadata, true),
        Err(metadata_error) => {
            let fallback = tokio::fs::symlink_metadata(&filesystem_path).await?;
            if !fallback.file_type().is_symlink() {
                return Err(metadata_error);
            }
            // Preserve a broken link in the listing so activation can report
            // its classified resolution error instead of making it disappear.
            (fallback, false)
        }
    };
    let name = entry.file_name().to_string_lossy().to_string();

    let entry_path = if parent_path.is_empty() {
        name.clone()
    } else {
        format!("{parent_path}/{name}")
    };

    let file_type = if metadata.is_dir() { FileType::Directory } else { FileType::File };

    let size = if metadata.is_file() { Some(metadata.len()) } else { None };

    let mime_type = if metadata.is_file() {
        mime_guess::from_path(&name).first().map(|m| m.to_string())
    } else {
        None
    };

    let is_hidden = name.starts_with('.');

    Ok(FileInfo {
        name,
        path: entry_path,
        file_type,
        size,
        mime_type,
        created_at: system_time_to_chrono(metadata.created().ok()),
        modified_at: system_time_to_chrono(metadata.modified().ok()),
        is_readable,
        is_hidden,
        link_kind,
    })
}

/// Convert `std::time::SystemTime` to `chrono::DateTime<Utc>`.
fn system_time_to_chrono(time: Option<std::time::SystemTime>) -> Option<DateTime<Utc>> {
    time.map(DateTime::<Utc>::from)
}

/// Extract the `Origin` header value from a request's headers.
fn extract_origin(headers: &HeaderMap) -> Result<String, ApiError> {
    headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .and_then(auth::normalize_browser_origin)
        .ok_or_else(|| ApiError::BadRequest("Missing Origin header".to_string()))
}

fn extract_origin_from_pair_initiate_request(body: &PairInitiateRequest) -> Result<String, ApiError> {
    extract_normalized_request_origin(body.origin.as_deref(), "Missing origin in pairing request")
}

fn extract_origin_from_pair_confirm_request(body_origin: Option<&str>) -> Result<String, ApiError> {
    extract_normalized_request_origin(body_origin, "Missing origin in pairing request")
}

fn extract_normalized_request_origin(request_origin: Option<&str>, missing_message: &str) -> Result<String, ApiError> {
    request_origin
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .and_then(auth::normalize_browser_origin)
        .ok_or_else(|| ApiError::BadRequest(missing_message.to_string()))
}

fn build_pair_status_response(pairing: &PairingState, current_origin: Option<&str>) -> PairStatusResponse {
    let (current_origin_paired, status) = current_origin.map_or((false, PublicPairingStatus::Unpaired), |origin| {
        let paired = pairing.get_secret_for_origin(origin).is_some();
        if paired && !pairing.is_origin_paired(origin) {
            pairing.record_verified_origin(
                origin,
                crate::server::pairing::VerifiedOriginRecordReason::RecoveredFromAuthenticatedRequest,
            );
        }

        let status = if paired {
            PublicPairingStatus::Paired
        } else if pairing.has_pending_pairing_for_origin(origin) {
            PublicPairingStatus::PendingLocalApproval
        } else {
            PublicPairingStatus::Unpaired
        };

        (paired, status)
    });

    PairStatusResponse {
        current_origin: current_origin.map(ToOwned::to_owned),
        current_origin_paired,
        status,
    }
}

fn resolve_pair_cancel_origin(headers: &HeaderMap, request_origin: Option<&str>) -> Result<String, ApiError> {
    extract_origin(headers).or_else(|_| extract_normalized_request_origin(request_origin, "Missing origin in pairing cancel request"))
}

fn resolve_pair_confirm_origin(headers: &HeaderMap, request_origin: Option<&str>) -> Result<String, ApiError> {
    extract_origin(headers).or_else(|_| extract_origin_from_pair_confirm_request(request_origin))
}

fn resolve_pair_status_origin(headers: &HeaderMap, request_origin: Option<&str>) -> Result<String, ApiError> {
    extract_origin(headers).or_else(|_| extract_normalized_request_origin(request_origin, "Missing origin in pairing status request"))
}

fn map_pair_confirm_error(message: String) -> ApiError {
    if message == "Waiting for companion confirmation" {
        return ApiError::conflict_code(message, PAIR_CONFIRMATION_PENDING_CODE);
    }

    ApiError::BadRequest(message)
}

/// Map an I/O error to an appropriate API error with context.
fn map_io_error(err: std::io::Error, path: &std::path::Path) -> ApiError {
    let path_display = path.display();
    match err.kind() {
        std::io::ErrorKind::NotFound => ApiError::NotFound(format!("Path not found: {path_display}")),
        std::io::ErrorKind::PermissionDenied => ApiError::Forbidden(format!("Permission denied: {path_display}")),
        _ => ApiError::Io(err),
    }
}

/// Validate a file/directory name for forbidden characters and patterns.
///
/// Matches the backend validation in `browser.py` — rejects empty names,
/// `.`/`..`, names containing `\/:*?"<>|`, and names ending with space or period.
fn validate_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty() {
        return Err(ApiError::BadRequest("Name cannot be empty".to_string()));
    }
    if name == "." || name == ".." {
        return Err(ApiError::BadRequest(format!("Invalid name: '{name}'")));
    }
    if name.contains(FORBIDDEN_NAME_CHARS) {
        return Err(ApiError::BadRequest(format!("Name contains forbidden characters: '{name}'")));
    }
    if name.ends_with(' ') || name.ends_with('.') {
        return Err(ApiError::BadRequest("Name cannot end with a space or period".to_string()));
    }
    Ok(())
}

/// Validate source/dest paths for copy/move operations.
fn validate_copy_move_paths(source: &str, dest: &str) -> Result<(), ApiError> {
    if source.is_empty() || dest.is_empty() {
        return Err(ApiError::BadRequest("Source and destination paths cannot be empty".to_string()));
    }
    if source == dest {
        return Err(ApiError::BadRequest("Source and destination paths are the same".to_string()));
    }
    // Prevent copying/moving a directory into itself
    let dest_with_sep = format!("{dest}/");
    if dest_with_sep.starts_with(&format!("{source}/")) {
        return Err(ApiError::BadRequest("Cannot copy or move a directory into itself".to_string()));
    }
    Ok(())
}

/// Resolve a path that may not exist yet (for copy/move destinations).
///
/// Unlike `resolve_safe_path`, this validates the *parent* directory exists
/// and checks the full path stays within the drive boundary.
fn resolve_safe_path_for_new(base: &std::path::Path, drive: &str, relative: &str) -> Result<PathBuf, ApiError> {
    let clean = normalize_drive_relative_path(drive, relative)?;

    for component in clean.split('/') {
        if component == ".." {
            return Err(ApiError::BadRequest("Path traversal not allowed".to_string()));
        }
    }

    let full = if clean.is_empty() { base.to_path_buf() } else { base.join(&clean) };

    // Verify the parent exists and the path is within bounds
    let canonical_base = std::fs::canonicalize(base).map_err(|e| ApiError::NotFound(format!("Drive root inaccessible: {e}")))?;

    if let Some(parent) = full.parent() {
        if parent.exists() {
            let canonical_parent = std::fs::canonicalize(parent).map_err(|e| map_io_error(e, parent))?;
            if !canonical_parent.starts_with(&canonical_base) {
                return Err(ApiError::Forbidden("Path is outside the drive boundary".to_string()));
            }
        }
    }

    Ok(full)
}

fn resolve_local_archive_extraction_request(
    drive: &str,
    destination_drive: Option<&str>,
    archive_path: &str,
    destination_path: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), ApiError> {
    if archive_path.trim().is_empty() || destination_path.trim().is_empty() {
        return Err(ApiError::BadRequest("Archive and destination paths are required".to_string()));
    }
    let source_base_path = drives::resolve_drive_path(drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let archive_path = resolve_safe_path(&source_base_path, drive, archive_path)?;
    let destination_drive = destination_drive.unwrap_or(drive);
    let destination_base_path =
        drives::resolve_drive_path(destination_drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {destination_drive}")))?;
    let destination_path = resolve_safe_path_for_new(&destination_base_path, destination_drive, destination_path)?;
    Ok((destination_base_path, archive_path, destination_path))
}

fn resolve_local_archive_creation_request(
    drive: &str,
    source_paths: &[String],
    target_path: &str,
) -> Result<(PathBuf, Vec<PathBuf>, PathBuf), ApiError> {
    if source_paths.is_empty() || target_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "Archive creation requires source paths and a target path".to_string(),
        ));
    }
    let base_path = drives::resolve_drive_path(drive).ok_or_else(|| ApiError::NotFound(format!("Unknown drive: {drive}")))?;
    let source_paths = source_paths
        .iter()
        .map(|source_path| resolve_safe_path(&base_path, drive, source_path))
        .collect::<Result<Vec<_>, _>>()?;
    let target_path = resolve_safe_path_for_new(&base_path, drive, target_path)?;
    let Some(parent) = target_path.parent() else {
        return Err(ApiError::BadRequest("Archive target path is invalid".to_string()));
    };
    if !parent.is_dir() {
        return Err(ApiError::BadRequest("Archive target parent directory does not exist".to_string()));
    }
    Ok((base_path, source_paths, target_path))
}

fn archive_execution_response(execution: ArchiveSessionStatus) -> ArchiveExecutionResponse {
    let progress = execution.result.unwrap_or(execution.progress);
    let is_creation = execution.kind == ArchiveSessionKind::Create;
    let mut response = ArchiveExecutionResponse {
        contract_version: execution.contract_version,
        execution_id: execution.execution_id,
        kind: execution.kind.as_str().to_string(),
        phase: execution.phase.as_str().to_string(),
        revision: execution.revision,
        progress: ArchiveExecutionProgress {
            completed_members: 0,
            total_members: is_creation.then_some(execution.total_members).flatten(),
            skipped_members: 0,
            failed_members: 0,
            processed_bytes: 0,
            total_bytes: is_creation.then_some(execution.total_bytes).flatten(),
        },
        cancellation_requested: execution.cancellation_requested,
        aggregate_counters: None,
        directories_created: None,
        files_created: None,
        source_bytes: None,
        error: execution.error,
        pending_decision: execution.pending_decision.map(|pending| match pending.member_error {
            Some(error) => ArchiveExecutionPendingDecision::MemberError {
                kind: "member_error",
                source_session_id: pending.source_session_id,
                delivery_sequence: pending.delivery_sequence,
                decision_revision: pending.decision_revision,
                member_path: pending.member_path,
                target_path: error.target_path,
                message: error.message,
                partial_output: error.partial_output,
                allowed_actions: vec!["retry".to_string(), "ignore".to_string()],
            },
            None => ArchiveExecutionPendingDecision::Collision {
                kind: "collision",
                source_session_id: pending.source_session_id,
                delivery_sequence: pending.delivery_sequence,
                decision_revision: pending.decision_revision,
                member_path: pending.member_path.clone(),
                is_directory: pending.is_directory,
                allowed_actions: vec![
                    "skip".to_string(),
                    "skip_all".to_string(),
                    "replace".to_string(),
                    "replace_all".to_string(),
                    "replace_older".to_string(),
                    "rename".to_string(),
                ],
                source: super::models::ArchiveExecutionConflictItem {
                    path: pending.member_path.clone(),
                    size: Some(pending.source_size),
                    modified_at: pending.source_modified_at,
                },
                target: super::models::ArchiveExecutionConflictItem {
                    path: pending.target_path.unwrap_or(pending.member_path),
                    size: pending.target_size,
                    modified_at: pending.target_modified_at,
                },
            },
        }),
    };
    match progress {
        ArchiveSessionProgress::Creation(progress) => {
            response.files_created = Some(progress.files_created);
            response.directories_created = Some(progress.directories_created);
            response.source_bytes = Some(progress.source_bytes);
            response.progress.completed_members = progress.files_created.saturating_add(progress.directories_created);
            response.progress.processed_bytes = progress.source_bytes;
        }
        ArchiveSessionProgress::Extraction(progress) => {
            response.aggregate_counters = Some(ArchiveExtractionAggregate {
                members_processed: progress.members_processed,
                members_completed: progress.members_completed,
                members_skipped: progress.members_skipped,
                members_failed: progress.members_failed,
                files_extracted: progress.files_extracted,
                directories_created: progress.directories_created,
                extracted_bytes: progress.extracted_bytes,
                files_replaced: progress.files_replaced,
            });
            response.progress.completed_members = progress.members_completed;
            response.progress.skipped_members = progress.members_skipped;
            response.progress.failed_members = progress.members_failed;
            response.progress.processed_bytes = progress.extracted_bytes;
        }
    }
    response
}

/// Build a `FileInfo` from an absolute path and its relative representation.
async fn build_file_info_from_path(path: &std::path::Path, relative: &str) -> Result<FileInfo, ApiError> {
    let metadata = tokio::fs::metadata(path).await.map_err(|e| map_io_error(e, path))?;

    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

    let file_type = if metadata.is_dir() { FileType::Directory } else { FileType::File };

    let size = if metadata.is_file() { Some(metadata.len()) } else { None };

    let mime_type = if metadata.is_file() {
        mime_guess::from_path(path).first().map(|m| m.to_string())
    } else {
        None
    };

    let is_hidden = name.starts_with('.');

    Ok(FileInfo {
        name,
        path: relative.to_string(),
        file_type,
        size,
        mime_type,
        created_at: system_time_to_chrono(metadata.created().ok()),
        modified_at: system_time_to_chrono(metadata.modified().ok()),
        is_readable: true,
        is_hidden,
        link_kind: None,
    })
}

/// Build a `ConflictInfo` 409 error from source and destination paths.
async fn build_conflict_error(source: &std::path::Path, dest: &std::path::Path, source_rel: &str, dest_rel: &str) -> ApiError {
    // Try to build ConflictInfo with metadata; fall back to plain message
    let source_info = build_file_info_from_path(source, source_rel).await;
    let dest_info = build_file_info_from_path(dest, dest_rel).await;

    match (source_info, dest_info) {
        (Ok(incoming), Ok(existing)) => {
            let conflict = ConflictInfo {
                existing_file: existing,
                incoming_file: incoming,
            };
            ApiError::Conflict(
                serde_json::to_value(conflict).unwrap_or_else(|_| serde_json::Value::String("Destination already exists".to_string())),
            )
        }
        _ => ApiError::conflict_message(format!("Destination already exists: {dest_rel}")),
    }
}

fn parse_target_resolution_policy(target_resolution_policy: Option<&str>) -> Result<TargetResolutionPolicy, ApiError> {
    Ok(match target_resolution_policy {
        None => {
            return Ok(TargetResolutionPolicy::Ask);
        }
        Some("ask") => TargetResolutionPolicy::Ask,
        Some("skip") => TargetResolutionPolicy::Skip,
        Some("replace") => TargetResolutionPolicy::Replace,
        Some("replace_older") => TargetResolutionPolicy::ReplaceOlder,
        _ => return Err(ApiError::BadRequest("target_resolution_policy is invalid".to_string())),
    })
}

fn parse_stream_source_modified_at(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .filter(|timestamp| timestamp.offset().local_minus_utc() == 0)
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

fn copy_move_target_policy(body: &CopyMoveRequest) -> Result<TargetResolutionPolicy, ApiError> {
    let resolved = if body.target_resolution_policy.is_none() && body.overwrite.unwrap_or(false) {
        TargetResolutionPolicy::Replace
    } else {
        parse_target_resolution_policy(body.target_resolution_policy.as_deref())?
    };
    if let Some(overwrite) = body.overwrite {
        if overwrite != matches!(resolved, TargetResolutionPolicy::Replace) {
            return Err(ApiError::BadRequest(
                "overwrite conflicts with target_resolution_policy".to_string(),
            ));
        }
    }
    Ok(resolved)
}

fn target_snapshot(metadata: Option<&std::fs::Metadata>) -> TargetSnapshot {
    match metadata {
        None => TargetSnapshot::Missing,
        Some(metadata) if metadata.is_file() => TargetSnapshot::RegularFile {
            modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
        },
        Some(_) => TargetSnapshot::Other,
    }
}

enum LocalTransferWriteError {
    Io(std::io::Error),
    SourceChanged,
    Cancelled,
    TargetChanged,
    OutcomeUnknown,
}

impl LocalTransferWriteError {
    #[cfg(test)]
    fn into_io_error(self) -> std::io::Error {
        match self {
            Self::Io(error) => error,
            Self::SourceChanged => std::io::Error::other("Transfer source changed during publication"),
            Self::Cancelled => std::io::Error::new(std::io::ErrorKind::Interrupted, "Transfer cancelled"),
            Self::TargetChanged => std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            Self::OutcomeUnknown => std::io::Error::other("Transfer destination outcome is unknown"),
        }
    }
}

impl From<std::io::Error> for LocalTransferWriteError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
enum LocalPromotionError {
    Io(std::io::Error),
    TargetDisappeared,
    OutcomeUnknown,
}

#[derive(Clone, Copy)]
enum LocalPromotionOutcome {
    Created,
    Replaced,
}

impl LocalPromotionOutcome {
    fn replaced(self) -> bool {
        matches!(self, Self::Replaced)
    }
}

async fn copy_local_file_contents(input: &mut File, output: &mut File, cancellation: Option<&AtomicBool>) -> Result<(), std::io::Error> {
    let mut buffer = vec![0; TRANSFER_COPY_BUFFER_SIZE];
    loop {
        if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "Transfer cancelled"));
        }
        let bytes_read = input.read(&mut buffer).await?;
        if bytes_read == 0 {
            return Ok(());
        }
        output.write_all(&buffer[..bytes_read]).await?;
    }
}

async fn resolve_local_regular_file_transfer(
    source: &FsPath,
    dest: &FsPath,
    expected_source: &std::fs::Metadata,
    policy: TargetResolutionPolicy,
    cancellation: Option<&AtomicBool>,
) -> Result<super::target_resolution::TargetMutationResolution<()>, LocalTransferWriteError> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(LocalTransferWriteError::Io)?;
    }
    resolve_target_mutation_attempt(
        ContentTransferPlan {
            source_modified_at: expected_source.modified().ok().map(DateTime::<Utc>::from),
            policy,
            replacement_supported: true,
        },
        || async {
            match tokio::fs::symlink_metadata(dest).await {
                Ok(metadata) => Ok(target_snapshot(Some(&metadata))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(TargetSnapshot::Missing),
                Err(error) => Err(LocalTransferWriteError::Io(error)),
            }
        },
        |disposition| async move {
            let replacing = disposition == TargetResolutionDisposition::ReplaceExisting;
            match copy_regular_file_exclusively(source, dest, expected_source, policy, cancellation, replacing).await {
                Ok(outcome) => Ok(TargetMutationAttempt::Committed {
                    result: (),
                    replaced: outcome.replaced(),
                }),
                Err(LocalTransferWriteError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Ok(TargetMutationAttempt::TargetExistsBeforeMutation)
                }
                Err(error) => Err(error),
            }
        },
    )
    .await
}

async fn copy_regular_file_exclusively(
    source: &std::path::Path,
    dest: &std::path::Path,
    expected_source: &std::fs::Metadata,
    policy: TargetResolutionPolicy,
    cancellation: Option<&AtomicBool>,
    replace_existing: bool,
) -> Result<LocalPromotionOutcome, LocalTransferWriteError> {
    let parent = dest.parent().ok_or_else(|| {
        LocalTransferWriteError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Transfer target has no parent",
        ))
    })?;
    let target_name = dest.file_name().and_then(|name| name.to_str()).ok_or_else(|| {
        LocalTransferWriteError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Transfer target name is not valid UTF-8",
        ))
    })?;
    let stage = parent.join(format!(".{target_name}.sambee-stage-{}", uuid::Uuid::new_v4()));

    let result = async {
        if cancellation.is_some_and(|active| active.load(Ordering::Acquire)) {
            return Err(LocalTransferWriteError::Cancelled);
        }
        let mut input = File::open(source).await.map_err(LocalTransferWriteError::Io)?;
        let opened_source = input.metadata().await.map_err(LocalTransferWriteError::Io)?;
        if !same_regular_file_snapshot(expected_source, &opened_source) {
            return Err(LocalTransferWriteError::SourceChanged);
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stage)
            .await
            .map_err(LocalTransferWriteError::Io)?;
        copy_local_file_contents(&mut input, &mut output, cancellation)
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::Interrupted {
                    LocalTransferWriteError::Cancelled
                } else {
                    LocalTransferWriteError::Io(error)
                }
            })?;
        output.flush().await.map_err(LocalTransferWriteError::Io)?;
        output.sync_data().await.map_err(LocalTransferWriteError::Io)?;
        drop(output);
        let current_source = tokio::fs::metadata(source).await.map_err(LocalTransferWriteError::Io)?;
        if !same_regular_file_snapshot(&opened_source, &current_source) {
            return Err(LocalTransferWriteError::SourceChanged);
        }
        let target_metadata = match tokio::fs::symlink_metadata(dest).await {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(LocalTransferWriteError::Io(error)),
        };
        let final_disposition = resolve_target_mutation(
            policy,
            expected_source.modified().ok().map(DateTime::<Utc>::from),
            target_snapshot(target_metadata.as_ref()),
        );
        let expected_disposition = if replace_existing {
            TargetResolutionDisposition::ReplaceExisting
        } else {
            TargetResolutionDisposition::CreateNew
        };
        if final_disposition != expected_disposition {
            return Err(LocalTransferWriteError::Io(std::io::Error::from(std::io::ErrorKind::AlreadyExists)));
        }
        promote_staged_local_file_with_recovery(&stage, dest, replace_existing).await
    }
    .await;

    if let Err(cleanup_error) = tokio::fs::remove_file(&stage).await {
        if cleanup_error.kind() != std::io::ErrorKind::NotFound {
            warn!("Failed to discard local transfer stage '{}': {cleanup_error}", stage.display());
        }
    }
    result
}

async fn promote_staged_local_file_with_recovery(
    stage: &FsPath,
    destination: &FsPath,
    replace_existing: bool,
) -> Result<LocalPromotionOutcome, LocalTransferWriteError> {
    match promote_staged_local_file(stage, destination, replace_existing).await {
        Ok(()) if replace_existing => Ok(LocalPromotionOutcome::Replaced),
        Ok(()) => Ok(LocalPromotionOutcome::Created),
        Err(LocalPromotionError::TargetDisappeared) if replace_existing => {
            match promote_staged_local_file(stage, destination, false).await {
                Ok(()) => Ok(LocalPromotionOutcome::Created),
                Err(LocalPromotionError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Err(LocalTransferWriteError::TargetChanged)
                }
                Err(error) => Err(map_local_promotion_error(error, destination).await),
            }
        }
        Err(error) => Err(map_local_promotion_error(error, destination).await),
    }
}

async fn map_local_promotion_error(error: LocalPromotionError, destination: &FsPath) -> LocalTransferWriteError {
    match error {
        LocalPromotionError::Io(error) => match tokio::fs::symlink_metadata(destination).await {
            Ok(metadata) if !metadata.is_file() => LocalTransferWriteError::TargetChanged,
            Ok(_) => LocalTransferWriteError::Io(error),
            Err(observation_error) if observation_error.kind() == std::io::ErrorKind::NotFound => LocalTransferWriteError::Io(error),
            Err(_) => LocalTransferWriteError::OutcomeUnknown,
        },
        LocalPromotionError::TargetDisappeared => LocalTransferWriteError::TargetChanged,
        LocalPromotionError::OutcomeUnknown => LocalTransferWriteError::OutcomeUnknown,
    }
}

#[cfg(unix)]
async fn promote_staged_local_file(stage: &FsPath, destination: &FsPath, replace_existing: bool) -> Result<(), LocalPromotionError> {
    if replace_existing {
        tokio::fs::rename(stage, destination).await.map_err(LocalPromotionError::Io)
    } else {
        rename_noreplace(stage, destination).await.map_err(LocalPromotionError::Io)
    }
}

#[cfg(windows)]
async fn promote_staged_local_file(stage: &FsPath, destination: &FsPath, replace_existing: bool) -> Result<(), LocalPromotionError> {
    if !replace_existing {
        return tokio::fs::hard_link(stage, destination).await.map_err(LocalPromotionError::Io);
    }

    use std::os::windows::ffi::OsStrExt;
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND};
    use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    let stage = stage.to_path_buf();
    let destination = destination.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let stage_wide = stage.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let destination_wide = destination.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<_>>();
        unsafe {
            ReplaceFileW(
                PCWSTR(destination_wide.as_ptr()),
                PCWSTR(stage_wide.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        }
        .map_err(|error| error.code())
    })
    .await
    .map_err(|_| LocalPromotionError::OutcomeUnknown)?
    .map_err(|code| {
        if code == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) || code == HRESULT::from_win32(ERROR_PATH_NOT_FOUND.0) {
            LocalPromotionError::TargetDisappeared
        } else {
            LocalPromotionError::Io(std::io::Error::other(format!("ReplaceFileW failed: {code}")))
        }
    })
}

#[cfg(all(not(unix), not(windows)))]
async fn promote_staged_local_file(stage: &FsPath, destination: &FsPath, replace_existing: bool) -> Result<(), LocalPromotionError> {
    if replace_existing {
        tokio::fs::rename(stage, destination).await.map_err(LocalPromotionError::Io)
    } else {
        tokio::fs::hard_link(stage, destination).await.map_err(LocalPromotionError::Io)
    }
}

#[cfg(unix)]
fn same_regular_file_snapshot(expected: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    expected.is_file()
        && current.is_file()
        && expected.dev() == current.dev()
        && expected.ino() == current.ino()
        && expected.len() == current.len()
        && expected.modified().ok() == current.modified().ok()
}

#[cfg(not(unix))]
fn same_regular_file_snapshot(expected: &std::fs::Metadata, current: &std::fs::Metadata) -> bool {
    expected.is_file() && current.is_file() && expected.len() == current.len() && expected.modified().ok() == current.modified().ok()
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
async fn rename_noreplace(source: &FsPath, destination: &FsPath) -> Result<(), std::io::Error> {
    let source = source.to_path_buf();
    let destination = destination.to_path_buf();
    tokio::task::spawn_blocking(move || rename_noreplace_sync(&source, &destination))
        .await
        .map_err(|error| std::io::Error::other(format!("No-replace promotion task failed: {error}")))?
}

#[cfg(target_os = "linux")]
fn rename_noreplace_sync(source: &FsPath, destination: &FsPath) -> Result<(), std::io::Error> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Stage path contains a null byte"))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Destination path contains a null byte"))?;
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "macos")]
fn rename_noreplace_sync(source: &FsPath, destination: &FsPath) -> Result<(), std::io::Error> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Stage path contains a null byte"))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Destination path contains a null byte"))?;
    let result = unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
async fn rename_noreplace(source: &FsPath, destination: &FsPath) -> Result<(), std::io::Error> {
    // Windows rename fails when the destination already exists.
    tokio::fs::rename(source, destination).await
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
async fn rename_noreplace(_source: &FsPath, _destination: &FsPath) -> Result<(), std::io::Error> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "The local platform does not provide a no-replace rename",
    ))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn editor_access_probe_preserves_existing_content() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("notes.txt");
        tokio::fs::write(&path, b"existing content").await.unwrap();
        super::check_editor_write_access(&path).await.expect("writable file should pass");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"existing content");
    }

    #[tokio::test]
    async fn editor_access_probe_does_not_create_missing_files() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("missing.txt");
        assert!(matches!(
            super::check_editor_write_access(&path).await,
            Err(crate::server::errors::ApiError::NotFound(_))
        ));
        assert!(!path.exists());
        assert!(matches!(
            super::check_editor_write_access(directory.path()).await,
            Err(crate::server::errors::ApiError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn editor_access_probe_rejects_read_only_files() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("notes.txt");
        tokio::fs::write(&path, b"read-only content").await.unwrap();
        let original_permissions = tokio::fs::metadata(&path).await.unwrap().permissions();
        let mut read_only_permissions = original_permissions.clone();
        read_only_permissions.set_readonly(true);
        tokio::fs::set_permissions(&path, read_only_permissions).await.unwrap();
        let result = super::check_editor_write_access(&path).await;
        tokio::fs::set_permissions(&path, original_permissions).await.unwrap();
        assert!(matches!(result, Err(crate::server::errors::ApiError::Forbidden(_))));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"read-only content");
    }

    #[tokio::test]
    async fn local_rename_changes_only_case_for_files_and_directories() {
        let directory = tempfile::tempdir().expect("temporary drive should be created");
        let drive = format!("rename-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());

        for (old_name, new_name, is_directory) in [("A.PDF", "A.pdf", false), ("FOLDER", "folder", true)] {
            let source = directory.path().join(old_name);
            if is_directory {
                tokio::fs::create_dir(&source).await.expect("source directory should be created");
            } else {
                tokio::fs::write(&source, b"content").await.expect("source file should be created");
            }

            let response = super::browse_rename(
                axum::extract::Path(drive.clone()),
                axum::Json(super::RenameRequest {
                    path: old_name.to_string(),
                    new_name: new_name.to_string(),
                }),
            )
            .await
            .expect("case-only rename should succeed");

            assert_eq!(response.0.name, new_name);
            assert_eq!(response.0.path, new_name);
            assert!(directory.path().join(new_name).exists());
        }
    }

    #[tokio::test]
    async fn local_rename_rejects_a_different_existing_item() {
        let directory = tempfile::tempdir().expect("temporary drive should be created");
        let drive = format!("rename-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        tokio::fs::write(directory.path().join("source.txt"), b"source")
            .await
            .expect("source should be created");
        tokio::fs::write(directory.path().join("target.txt"), b"target")
            .await
            .expect("target should be created");

        let response = super::browse_rename(
            axum::extract::Path(drive),
            axum::Json(super::RenameRequest {
                path: "source.txt".to_string(),
                new_name: "target.txt".to_string(),
            }),
        )
        .await;

        assert!(matches!(response, Err(crate::server::errors::ApiError::Conflict(_))));
        assert_eq!(tokio::fs::read(directory.path().join("source.txt")).await.unwrap(), b"source");
        assert_eq!(tokio::fs::read(directory.path().join("target.txt")).await.unwrap(), b"target");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_rename_rejects_aliases_to_the_source() {
        let directory = tempfile::tempdir().expect("temporary drive should be created");
        let drive = format!("rename-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let source = directory.path().join("source.txt");
        tokio::fs::write(&source, b"source").await.expect("source should be created");
        std::fs::hard_link(&source, directory.path().join("hard-link.txt")).expect("hard link should be created");
        std::os::unix::fs::symlink(&source, directory.path().join("symbolic-link.txt")).expect("symbolic link should be created");

        for alias in ["hard-link.txt", "symbolic-link.txt"] {
            let response = super::browse_rename(
                axum::extract::Path(drive.clone()),
                axum::Json(super::RenameRequest {
                    path: "source.txt".to_string(),
                    new_name: alias.to_string(),
                }),
            )
            .await;

            assert!(matches!(response, Err(crate::server::errors::ApiError::Conflict(_))));
            assert!(source.exists());
            assert!(directory.path().join(alias).exists());
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn local_rename_rejects_case_variant_hard_link() {
        let directory = tempfile::tempdir().expect("temporary drive should be created");
        let drive = format!("rename-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let source = directory.path().join("A.PDF");
        let target = directory.path().join("A.pdf");
        tokio::fs::write(&source, b"source").await.expect("source should be created");
        std::fs::hard_link(&source, &target).expect("case-variant hard link should be created");

        let response = super::browse_rename(
            axum::extract::Path(drive),
            axum::Json(super::RenameRequest {
                path: "A.PDF".to_string(),
                new_name: "A.pdf".to_string(),
            }),
        )
        .await;

        assert!(matches!(response, Err(crate::server::errors::ApiError::Conflict(_))));
        assert!(source.exists());
        assert!(target.exists());
    }

    #[tokio::test]
    async fn active_viewer_files_are_downloaded() {
        let directory = tempfile::tempdir().expect("temporary viewer directory should be created");
        let drive_id = format!("test-drive-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive_id.clone(), directory.path().to_path_buf());

        for filename in ["page.html", "icon.svg", "page.xhtml", "r\u{e9}sum\u{e9} draft.html", "readme.txt"] {
            std::fs::write(directory.path().join(filename), b"content").expect("viewer file should be created");
            let response = super::viewer_file(
                axum::extract::Path(drive_id.clone()),
                axum::extract::Query(super::ViewerQuery {
                    path: Some(filename.to_string()),
                    viewport_width: None,
                    viewport_height: None,
                    no_resizing: None,
                }),
            )
            .await
            .expect("viewer response should succeed");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            let disposition = response.headers()["content-disposition"].to_str().unwrap();
            assert_eq!(disposition.starts_with("attachment"), filename != "readme.txt");
            if filename == "r\u{e9}sum\u{e9} draft.html" {
                assert_eq!(disposition, "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20draft.html");
            }
        }
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn active_archive_members_are_downloaded() {
        let _resolver_test_guard = super::INSPECTION_RESOLVER_TEST_LOCK
            .lock()
            .expect("inspection resolver test lock should not be poisoned");
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let archive_path = directory.path().join("archive.zip");
        let mut archive = zip::ZipWriter::new(std::fs::File::create(&archive_path).expect("archive should be created"));
        for filename in [
            "page.html",
            "icon.svg",
            "page.xhtml",
            "r\u{e9}sum\u{e9} \"draft\".html",
            "readme.txt",
        ] {
            archive
                .start_file(filename, zip::write::SimpleFileOptions::default())
                .expect("entry should start");
            std::io::Write::write_all(&mut archive, b"content").expect("entry should be written");
        }
        archive.finish().expect("archive should finish");
        let drive_id = format!("test-drive-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive_id.clone(), directory.path().to_path_buf());

        for filename in [
            "page.html",
            "icon.svg",
            "page.xhtml",
            "r\u{e9}sum\u{e9} \"draft\".html",
            "readme.txt",
        ] {
            let response = super::viewer_archive_member(
                axum::extract::Path(drive_id.clone()),
                axum::extract::Query(super::ArchiveMemberQuery {
                    archive_path: "archive.zip".to_string(),
                    member_path: filename.to_string(),
                    download: false,
                }),
            )
            .await
            .expect("archive member response should succeed");
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            let disposition = response.headers()["content-disposition"].to_str().unwrap();
            assert_eq!(disposition.starts_with("attachment"), filename != "readme.txt");
            if filename == "r\u{e9}sum\u{e9} \"draft\".html" {
                assert_eq!(disposition, "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22.html");
            }
        }
    }

    use super::{
        archive_creation_response, archive_execution_response, browse_list_archive, browse_stream_transfer, build_file_info,
        build_pair_status_response, classify_link_target, complete_transfer_receipt, copy_regular_file_exclusively, execute_archive_relay,
        extract_local_archive_to_smb_destination_live, extract_smb_archive_to_local_live, inspection_resolver_call_count,
        is_retryable_live_archive_stream_failure, map_local_archive_error, map_temporary_archive_error, normalize_drive_relative_path,
        normalize_windows_display_path, replay_transfer_outcome, reserve_transfer_receipt, reset_inspection_resolver_call_count,
        resolve_companion_archive_topology, resolve_companion_creation_coordinator, resolve_companion_extraction_coordinator,
        resolve_companion_inspection_coordinator, resolve_drive_relative_source_path, resolve_link_target_metadata,
        resolve_local_archive_inspection_coordinator, resolve_pair_cancel_origin, resolve_pair_confirm_origin, resolve_pair_status_origin,
        resolve_safe_path, source_link_kind, transfer_receipt_error, validate_editor_write_target, viewer_archive_member,
        write_local_archive_member_chunk, ArchiveCreationAdapterBinding, ArchiveCreationMemberCompletion, ArchiveCreationRelay,
        ArchiveExtractionRelay, ArchiveListQuery, ArchiveMemberQuery, ArchiveRelayBinding, ArchiveRelayFailure, ArchiveRelayTransport,
        CompanionArchiveCreationPlan, CompanionArchiveExtractionPlan, CopyMoveRequest, FixtureArchiveCreationInvocation,
        LocalPromotionOutcome, LocalTransferWriteError, StreamTransferQuery, TransferCancellationReservation, TransferReceiptLookup,
        TransferReceiptOutcome, TransferReceiptReservation, ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS, INSPECTION_RESOLVER_TEST_LOCK,
    };
    use crate::server::archive::{
        build_local_archive_manifest, build_local_archive_manifest_for_remote_target, create_local_archive, create_temporary_local_archive,
        resolve_companion_archive_inspection_topology_plan, resolve_companion_archive_topology_plan, ArchiveCreationManifest,
        ArchiveCreationManifestMember, ArchiveDirectoryListingPresentation, ArchiveInspectionPlan, ArchiveInspectionPresentation,
        CompanionArchiveBinding, CompanionArchiveExecutionDriver, CompanionArchiveOperationKind, CompanionArchiveTopology,
        CompanionArchiveTopologyPlan, LocalArchiveCreationResult, LocalArchiveEntry, LocalArchiveError, LocalArchiveExtractionMemberError,
        LocalArchiveExtractionResult, LocalArchiveInspectionSource, LocalArchiveReadError, ARCHIVE_INLINE_PREVIEW_MAX_BYTES,
    };
    use crate::server::archive_sessions::{
        ArchiveSessionKind, ArchiveSessionManager, ArchiveSessionPendingDecision, ArchiveSessionPhase, ArchiveSessionProgress,
        ArchiveSessionStatus, LiveLocalArchiveSourcePhase, LiveLocalArchiveSourceSession,
    };
    use crate::server::errors::{ApiError, LOCAL_ARCHIVE_CREATION_PARTIAL_CODE};
    use crate::server::models::{
        ArchiveContractVersion, ArchiveCreationResponse, FileType, LinkKind, LinkTargetState, LinkTargetType, PublicPairingStatus,
    };
    use crate::server::pairing::{PairingState, VerifiedOriginRecordReason};
    use crate::server::target_resolution::TargetResolutionPolicy;

    #[test]
    fn local_download_intent_can_be_redeemed_only_once() {
        let intents = std::sync::Mutex::new(std::collections::HashMap::from([(
            "ticket".to_string(),
            crate::server::DownloadIntent {
                origin: "https://example.com".to_string(),
                drive: "test".to_string(),
                path: "report.txt".to_string(),
                member_path: None,
                expires_at: std::time::Instant::now() + std::time::Duration::from_secs(90),
            },
        )]));
        assert!(super::consume_download_intent(&intents, "ticket").is_ok());
        assert!(matches!(
            super::consume_download_intent(&intents, "ticket"),
            Err(ApiError::NotFound(_))
        ));
    }

    #[test]
    fn unpair_revokes_only_its_download_intents() {
        let pairing = PairingState::new();
        *pairing.download_intents.lock().unwrap() = std::collections::HashMap::from([
            (
                "revoked".to_string(),
                crate::server::DownloadIntent {
                    origin: "https://first.example".to_string(),
                    drive: "test".to_string(),
                    path: "report.txt".to_string(),
                    member_path: None,
                    expires_at: std::time::Instant::now() + std::time::Duration::from_secs(90),
                },
            ),
            (
                "kept".to_string(),
                crate::server::DownloadIntent {
                    origin: "https://second.example".to_string(),
                    drive: "test".to_string(),
                    path: "report.txt".to_string(),
                    member_path: None,
                    expires_at: std::time::Instant::now() + std::time::Duration::from_secs(90),
                },
            ),
        ]);
        pairing.unpair("https://first.example").unwrap();
        pairing.record_verified_origin("https://first.example", VerifiedOriginRecordReason::PairingCompleted);
        assert!(matches!(
            super::consume_download_intent(&pairing.download_intents, "revoked"),
            Err(ApiError::NotFound(_))
        ));
        assert!(super::consume_download_intent(&pairing.download_intents, "kept").is_ok());
    }

    #[tokio::test]
    async fn archive_stream_reports_validation_failure_after_reader_eof() {
        let (writer, reader) = tokio::io::duplex(8);
        let (sender, completion) = tokio::sync::oneshot::channel();
        drop(writer);
        sender.send(Err(std::io::Error::other("ZIP checksum mismatch"))).unwrap();
        let mut stream = super::VerifiedArchiveStream { reader, completion };
        let mut bytes = Vec::new();
        let error = tokio::io::AsyncReadExt::read_to_end(&mut stream, &mut bytes).await.unwrap_err();
        assert!(error.to_string().contains("ZIP checksum mismatch"));
    }

    #[test]
    fn temporary_archive_cap_reports_payload_too_large() {
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("sample.txt"), b"sample content").unwrap();
        let entries = build_local_archive_manifest_for_remote_target(&[source.path().join("sample.txt")]).unwrap();
        let error = create_temporary_local_archive(&entries, 10, || false).unwrap_err();
        assert!(matches!(map_temporary_archive_error(error), ApiError::PayloadTooLarge(_)));
    }
    use axum::body::{to_bytes, Body};
    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
    use axum::response::IntoResponse;
    use chrono::{DateTime, Utc};
    use std::collections::{HashSet, VecDeque};
    use std::fs;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use std::pin::Pin;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
    use tokio::sync::{oneshot, Mutex};
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};
    const NONCE_A: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[tokio::test]
    async fn transfer_receipt_reservation_waits_for_and_replays_the_owner_result() {
        let body = CopyMoveRequest {
            source_path: "source.txt".to_string(),
            dest_path: "target.txt".to_string(),
            dest_connection_id: None,
            target_resolution_policy: Some("ask".to_string()),
            overwrite: None,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            transfer_attempt_id: None,
        };

        assert!(matches!(
            reserve_transfer_receipt("copy", "test-drive", &body).expect("first request should reserve"),
            TransferReceiptLookup::Owner
        ));
        let reservation = TransferReceiptReservation::for_request("copy", "test-drive", &body);
        let waiter = match reserve_transfer_receipt("copy", "test-drive", &body).expect("duplicate should wait") {
            TransferReceiptLookup::Wait(waiter) => waiter,
            _ => panic!("duplicate request must wait for the owner"),
        };
        let result = super::completed_transfer_result("unchanged", "mutated");
        complete_transfer_receipt("copy", "test-drive", &body, TransferReceiptOutcome::Result(result.clone()));
        drop(reservation);

        assert!(matches!(
            waiter.await.expect("owner should release waiter"),
            TransferReceiptOutcome::Result(waited) if waited.status == "completed"
        ));
        assert!(matches!(
            reserve_transfer_receipt("copy", "test-drive", &body).expect("completed result should replay"),
            TransferReceiptLookup::Cached(TransferReceiptOutcome::Result(cached)) if cached.status == "completed"
        ));
    }

    #[tokio::test]
    async fn transfer_receipt_replays_a_known_conflict_error() {
        let body = CopyMoveRequest {
            source_path: "source.txt".to_string(),
            dest_path: "target.txt".to_string(),
            dest_connection_id: None,
            target_resolution_policy: Some("ask".to_string()),
            overwrite: None,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            transfer_attempt_id: None,
        };

        assert!(matches!(
            reserve_transfer_receipt("copy", "test-drive", &body).expect("first request should reserve"),
            TransferReceiptLookup::Owner
        ));
        let waiter = match reserve_transfer_receipt("copy", "test-drive", &body).expect("duplicate should wait") {
            TransferReceiptLookup::Wait(waiter) => waiter,
            _ => panic!("duplicate request must wait for the owner"),
        };
        let error = ApiError::conflict_message("Destination already exists");
        complete_transfer_receipt(
            "copy",
            "test-drive",
            &body,
            TransferReceiptOutcome::Error(transfer_receipt_error(&error)),
        );

        assert!(matches!(
            waiter.await.expect("owner should release waiter"),
            TransferReceiptOutcome::Error(_)
        ));
        let cached = match reserve_transfer_receipt("copy", "test-drive", &body).expect("known error should replay") {
            TransferReceiptLookup::Cached(outcome) => outcome,
            _ => panic!("completed error should be cached"),
        };
        let replayed = match replay_transfer_outcome(cached) {
            Err(error) => error,
            Ok(_) => panic!("conflict receipt should replay as an error"),
        };
        assert_eq!(replayed.into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn move_route_validates_the_source_drive() {
        let response = super::browse_move(
            Path("missing-drive".to_string()),
            axum::Json(CopyMoveRequest {
                source_path: "source.txt".to_string(),
                dest_path: "target.txt".to_string(),
                dest_connection_id: None,
                target_resolution_policy: Some("ask".to_string()),
                overwrite: None,
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                transfer_attempt_id: None,
            }),
        )
        .await;

        assert!(matches!(response, Err(ApiError::NotFound(_))));
    }

    #[tokio::test]
    async fn cross_drive_move_removes_source_after_destination_commit() {
        let source_directory = tempfile::tempdir().expect("source directory should be created");
        let destination_directory = tempfile::tempdir().expect("destination directory should be created");
        let source_drive = format!("source-{}", uuid::Uuid::new_v4());
        let destination_drive = format!("destination-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(source_drive.clone(), source_directory.path().to_path_buf());
        super::drives::register_test_drive_path(destination_drive.clone(), destination_directory.path().to_path_buf());
        let source = source_directory.path().join("report.txt");
        tokio::fs::write(&source, b"report").await.expect("source should be written");

        let result = super::execute_browse_move(
            &source_drive,
            &CopyMoveRequest {
                source_path: "report.txt".to_string(),
                dest_path: "incoming/report.txt".to_string(),
                dest_connection_id: Some(format!("local-drive:{destination_drive}")),
                target_resolution_policy: Some("ask".to_string()),
                overwrite: None,
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                transfer_attempt_id: None,
            },
            None,
        )
        .await
        .expect("cross-drive copy should succeed");

        assert_eq!(result.status, "completed");
        assert_eq!(result.effects.source, "mutated");
        assert_eq!(result.effects.destination, "mutated");
        assert!(!source.exists());
        assert_eq!(
            tokio::fs::read(destination_directory.path().join("incoming/report.txt"))
                .await
                .expect("destination should exist"),
            b"report"
        );
    }

    #[tokio::test]
    async fn directory_copy_is_rejected_before_destination_mutation() {
        let source_directory = tempfile::tempdir().expect("source directory should be created");
        let destination_directory = tempfile::tempdir().expect("destination directory should be created");
        let source_drive = format!("source-{}", uuid::Uuid::new_v4());
        let destination_drive = format!("destination-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(source_drive.clone(), source_directory.path().to_path_buf());
        super::drives::register_test_drive_path(destination_drive.clone(), destination_directory.path().to_path_buf());
        tokio::fs::create_dir(source_directory.path().join("documents"))
            .await
            .expect("source directory should be written");

        let result = super::execute_browse_copy(
            &source_drive,
            &CopyMoveRequest {
                source_path: "documents".to_string(),
                dest_path: "incoming/documents".to_string(),
                dest_connection_id: Some(format!("local-drive:{destination_drive}")),
                target_resolution_policy: Some("ask".to_string()),
                overwrite: None,
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                transfer_attempt_id: None,
            },
            None,
        )
        .await;

        assert!(matches!(result, Err(ApiError::BadRequest(message)) if message.contains("Directory transfers")));
        assert!(!destination_directory.path().join("incoming/documents").exists());
    }

    #[tokio::test]
    async fn directory_copy_rejects_every_policy_before_existing_target_handling() {
        let source_directory = tempfile::tempdir().expect("source directory should be created");
        let destination_directory = tempfile::tempdir().expect("destination directory should be created");
        let source_drive = format!("source-{}", uuid::Uuid::new_v4());
        let destination_drive = format!("destination-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(source_drive.clone(), source_directory.path().to_path_buf());
        super::drives::register_test_drive_path(destination_drive.clone(), destination_directory.path().to_path_buf());
        let source = source_directory.path().join("documents");
        let destination = destination_directory.path().join("incoming/documents");
        tokio::fs::create_dir(&source).await.expect("source directory should be written");
        tokio::fs::create_dir_all(&destination)
            .await
            .expect("existing destination directory should be written");
        tokio::fs::write(destination.join("retained.txt"), b"existing")
            .await
            .expect("existing destination content should be written");

        for policy in ["ask", "skip", "replace", "replace_older"] {
            let result = super::execute_browse_copy(
                &source_drive,
                &CopyMoveRequest {
                    source_path: "documents".to_string(),
                    dest_path: "incoming/documents".to_string(),
                    dest_connection_id: Some(format!("local-drive:{destination_drive}")),
                    target_resolution_policy: Some(policy.to_string()),
                    overwrite: None,
                    idempotency_key: uuid::Uuid::new_v4().to_string(),
                    transfer_attempt_id: None,
                },
                None,
            )
            .await;

            assert!(matches!(result, Err(ApiError::BadRequest(message)) if message.contains("Directory transfers")));
        }

        assert!(source.exists());
        assert_eq!(
            tokio::fs::read(destination.join("retained.txt"))
                .await
                .expect("existing destination content should be retained"),
            b"existing"
        );
    }

    #[tokio::test]
    async fn directory_move_is_rejected_before_source_or_destination_mutation() {
        let source_directory = tempfile::tempdir().expect("source directory should be created");
        let destination_directory = tempfile::tempdir().expect("destination directory should be created");
        let source_drive = format!("source-{}", uuid::Uuid::new_v4());
        let destination_drive = format!("destination-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(source_drive.clone(), source_directory.path().to_path_buf());
        super::drives::register_test_drive_path(destination_drive.clone(), destination_directory.path().to_path_buf());
        let source = source_directory.path().join("documents");
        tokio::fs::create_dir(&source).await.expect("source directory should be written");

        let result = super::execute_browse_move(
            &source_drive,
            &CopyMoveRequest {
                source_path: "documents".to_string(),
                dest_path: "incoming/documents".to_string(),
                dest_connection_id: Some(format!("local-drive:{destination_drive}")),
                target_resolution_policy: Some("ask".to_string()),
                overwrite: None,
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                transfer_attempt_id: None,
            },
            None,
        )
        .await;

        assert!(matches!(result, Err(ApiError::BadRequest(message)) if message.contains("Directory transfers")));
        assert!(source.exists());
        assert!(!destination_directory.path().join("incoming/documents").exists());
    }

    #[tokio::test]
    async fn local_streamed_destination_publishes_only_after_complete_body() {
        let corpus_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../archive-contract/v2/fixtures/browser-file-publish-scenarios-v2.json");
        let corpus: serde_json::Value = serde_json::from_slice(&std::fs::read(corpus_path).unwrap()).unwrap();
        let scenario = &corpus["staged_publish"];
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let target = directory.path().join(scenario["target_path"].as_str().unwrap());
        tokio::fs::create_dir_all(target.parent().unwrap()).await.unwrap();

        let bytes_written = super::stage_local_request_body(
            &target,
            Body::from(scenario["contents"].as_str().unwrap().to_owned()),
            scenario["expected_size"].as_u64().unwrap(),
            false,
        )
        .await
        .expect("streamed destination should publish");

        assert_eq!(bytes_written, scenario["expected_size"].as_u64().unwrap());
        assert_eq!(
            tokio::fs::read(&target).await.expect("target should exist"),
            scenario["contents"].as_str().unwrap().as_bytes()
        );
        let entries = std::fs::read_dir(target.parent().unwrap())
            .expect("directory should be readable")
            .count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn recovered_create_promotion_is_not_reported_as_a_replacement() {
        assert!(!LocalPromotionOutcome::Created.replaced());
        assert!(LocalPromotionOutcome::Replaced.replaced());
    }

    #[tokio::test]
    async fn local_streamed_destination_skips_replace_older_without_source_mtime() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let target = directory.path().join("target.txt");
        tokio::fs::write(&target, b"existing").await.expect("target should be written");

        let error = super::stage_local_request_body_with_target_policy(
            &target,
            Body::from("incoming"),
            8,
            true,
            Some((TargetResolutionPolicy::ReplaceOlder, None)),
        )
        .await
        .expect_err("missing source mtime must skip an existing target");

        assert!(matches!(error, LocalTransferWriteError::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        assert_eq!(tokio::fs::read(&target).await.expect("target should remain"), b"existing");
    }

    #[tokio::test]
    async fn streamed_transfer_handler_skips_existing_replace_older_without_source_mtime() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let drive = format!("stream-skip-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let target = directory.path().join("target.txt");
        tokio::fs::write(&target, b"existing").await.expect("target should be written");

        let response = browse_stream_transfer(
            Path(drive),
            Query(StreamTransferQuery {
                path: "target.txt".to_string(),
                target_resolution_policy: Some("replace_older".to_string()),
                expected_size: 8,
                source_modified_at: None,
            }),
            Body::from("incoming"),
        )
        .await
        .expect("missing source timestamp should skip rather than fail");

        assert_eq!(response.0.status, "skipped");
        assert_eq!(tokio::fs::read(&target).await.expect("target should remain"), b"existing");
    }

    #[tokio::test]
    async fn streamed_transfer_handler_skips_existing_replace_older_with_a_malformed_source_timestamp() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let drive = format!("stream-malformed-timestamp-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let target = directory.path().join("target.txt");
        tokio::fs::write(&target, b"existing").await.expect("target should be written");

        let response = browse_stream_transfer(
            Path(drive),
            Query(StreamTransferQuery {
                path: "target.txt".to_string(),
                target_resolution_policy: Some("replace_older".to_string()),
                expected_size: 8,
                source_modified_at: Some("not-a-timestamp".to_string()),
            }),
            Body::from("incoming"),
        )
        .await
        .expect("malformed source timestamp should skip rather than fail");

        assert_eq!(response.0.status, "skipped");
        assert_eq!(tokio::fs::read(&target).await.expect("target should remain"), b"existing");
    }

    #[tokio::test]
    async fn streamed_transfer_handler_replace_older_requires_a_strictly_newer_source() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let drive = format!("stream-replace-older-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let target = directory.path().join("target.txt");
        tokio::fs::write(&target, b"existing").await.expect("target should be written");
        let target_mtime = DateTime::<Utc>::from(
            tokio::fs::metadata(&target)
                .await
                .expect("target metadata should be readable")
                .modified()
                .expect("target modification time should be readable"),
        );

        for source_modified_at in [target_mtime - chrono::Duration::seconds(1), target_mtime] {
            let response = browse_stream_transfer(
                Path(drive.clone()),
                Query(StreamTransferQuery {
                    path: "target.txt".to_string(),
                    target_resolution_policy: Some("replace_older".to_string()),
                    expected_size: 8,
                    source_modified_at: Some(source_modified_at.to_rfc3339()),
                }),
                Body::from("incoming"),
            )
            .await
            .expect("older or equal source should be skipped rather than fail");

            assert_eq!(response.0.status, "skipped");
            assert_eq!(tokio::fs::read(&target).await.expect("target should remain"), b"existing");
        }

        let response = browse_stream_transfer(
            Path(drive),
            Query(StreamTransferQuery {
                path: "target.txt".to_string(),
                target_resolution_policy: Some("replace_older".to_string()),
                expected_size: 8,
                source_modified_at: Some((target_mtime + chrono::Duration::seconds(1)).to_rfc3339()),
            }),
            Body::from("incoming"),
        )
        .await
        .expect("newer source should replace the target");

        assert_eq!(response.0.status, "completed");
        assert!(response.0.replaced);
        assert_eq!(tokio::fs::read(&target).await.expect("target should be replaced"), b"incoming");
    }

    #[tokio::test]
    async fn streamed_transfer_handler_reports_a_replaced_target() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let drive = format!("stream-replace-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), directory.path().to_path_buf());
        let target = directory.path().join("target.txt");
        tokio::fs::write(&target, b"existing").await.expect("target should be written");

        let response = browse_stream_transfer(
            Path(drive),
            Query(StreamTransferQuery {
                path: "target.txt".to_string(),
                target_resolution_policy: Some("replace".to_string()),
                expected_size: 8,
                source_modified_at: None,
            }),
            Body::from("incoming"),
        )
        .await
        .expect("replacement should succeed");

        assert_eq!(response.0.status, "completed");
        assert!(response.0.replaced);
        assert_eq!(tokio::fs::read(&target).await.expect("target should be replaced"), b"incoming");
    }

    #[tokio::test]
    async fn local_streamed_destination_discards_a_truncated_body() {
        let corpus_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../archive-contract/v2/fixtures/browser-file-publish-scenarios-v2.json");
        let corpus: serde_json::Value = serde_json::from_slice(&std::fs::read(corpus_path).unwrap()).unwrap();
        let scenario = &corpus["staged_publish"];
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let target = directory.path().join(scenario["target_path"].as_str().unwrap());
        tokio::fs::create_dir_all(target.parent().unwrap()).await.unwrap();

        let error = super::stage_local_request_body(
            &target,
            Body::from(scenario["truncated_contents"].as_str().unwrap().to_owned()),
            scenario["expected_size"].as_u64().unwrap(),
            false,
        )
        .await
        .expect_err("truncated body must not publish a destination");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(!target.exists());
        let entries = std::fs::read_dir(target.parent().unwrap())
            .expect("directory should be readable")
            .count();
        assert_eq!(
            entries,
            scenario["expected_artifacts_after_size_mismatch"].as_u64().unwrap() as usize
        );
    }

    #[tokio::test]
    async fn local_streamed_destination_rejects_an_oversized_body_before_publish() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let target = directory.path().join("target.txt");

        let error = super::stage_local_request_body(&target, Body::from("too long"), 3, false)
            .await
            .expect_err("oversized body must not publish a destination");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("received more"));
        assert!(!target.exists());
        let entries = std::fs::read_dir(directory.path()).expect("directory should be readable").count();
        assert_eq!(entries, 0);
    }

    #[tokio::test]
    async fn local_staged_copy_rejects_a_source_replaced_before_opening() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let source = directory.path().join("source.txt");
        let replacement = directory.path().join("replacement.txt");
        let target = directory.path().join("target.txt");
        tokio::fs::write(&source, b"original").await.expect("source should be written");
        let expected = tokio::fs::metadata(&source).await.expect("source metadata should be read");
        tokio::fs::write(&replacement, b"replacement-content")
            .await
            .expect("replacement should be written");
        tokio::fs::rename(&replacement, &source).await.expect("source should be replaced");

        assert!(matches!(
            copy_regular_file_exclusively(&source, &target, &expected, TargetResolutionPolicy::Ask, None, false).await,
            Err(LocalTransferWriteError::SourceChanged)
        ));
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn local_staged_file_copy_cancellation_leaves_target_absent() {
        let directory = tempfile::tempdir().expect("temporary transfer directory should be created");
        let source = directory.path().join("source.txt");
        let target = directory.path().join("target.txt");
        tokio::fs::write(&source, b"content").await.expect("source should be written");
        let expected = tokio::fs::metadata(&source).await.expect("source metadata should be read");
        let cancellation = AtomicBool::new(true);

        assert!(matches!(
            copy_regular_file_exclusively(&source, &target, &expected, TargetResolutionPolicy::Ask, Some(&cancellation), false).await,
            Err(LocalTransferWriteError::Cancelled)
        ));
        assert!(!target.exists());
        assert!(std::fs::read_dir(directory.path())
            .expect("temporary directory should be readable")
            .all(|entry| !entry
                .expect("directory entry should be readable")
                .file_name()
                .to_string_lossy()
                .starts_with(".target.txt.sambee-stage-")));
    }

    #[tokio::test]
    async fn cancel_transfer_attempt_marks_the_active_reservation() {
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let body = CopyMoveRequest {
            source_path: "source.txt".to_string(),
            dest_path: "target.txt".to_string(),
            dest_connection_id: None,
            target_resolution_policy: Some("ask".to_string()),
            overwrite: None,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            transfer_attempt_id: Some(attempt_id.clone()),
        };
        let reservation = TransferCancellationReservation::for_request(&body);

        let status = super::browse_cancel_transfer_attempt(Path(("test-drive".to_string(), attempt_id))).await;

        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(reservation.is_cancelled());
    }

    fn relay_control_payload_example(name: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/relay-control-payloads-v2.json"
        ))
        .expect("relay control payload fixture should be valid JSON");
        assert_eq!(fixture["version"], 2);
        fixture["payloads"]
            .as_array()
            .expect("relay control payload fixture should contain payloads")
            .iter()
            .find(|payload| payload["name"] == name)
            .unwrap_or_else(|| panic!("relay control payload fixture should define {name}"))["example"]
            .clone()
    }

    fn expected_topology_trace(case_name: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .find(|case| case["name"] == case_name)
            .unwrap_or_else(|| panic!("topology trace fixture should define {case_name}"))["expected_trace"]
            .clone()
    }

    #[test]
    fn companion_topology_fixtures_resolve_through_the_production_plan() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        for case in fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .chain(
                fixture["trajectory_cases"]
                    .as_array()
                    .expect("topology trace fixture should define trajectory cases"),
            )
        {
            let (source_is_local, destination_is_local, expected_topology) =
                match case["topology"].as_str().expect("fixture topology must be a string") {
                    "local_to_local" => (true, true, CompanionArchiveTopology::LocalToLocal),
                    "smb_to_local" => (false, true, CompanionArchiveTopology::SmbToLocal),
                    "local_to_smb" => (true, false, CompanionArchiveTopology::LocalToSmb),
                    "smb_to_smb" => continue,
                    topology => panic!("unsupported fixture topology {topology}"),
                };
            let kind = match case["operation"].as_str().expect("fixture operation must be a string") {
                "create" => CompanionArchiveOperationKind::Create,
                "extract" => CompanionArchiveOperationKind::Extract,
                operation => panic!("unsupported fixture operation {operation}"),
            };
            assert_eq!(
                resolve_companion_archive_topology(kind, source_is_local, destination_is_local).unwrap(),
                expected_topology
            );
        }
    }

    #[test]
    fn companion_inspection_resolver_accepts_only_a_local_inspection_plan() {
        let _resolver_test_guard = INSPECTION_RESOLVER_TEST_LOCK
            .lock()
            .expect("inspection resolver test lock should not be poisoned");
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let source = directory.path().join("source.txt");
        let target = directory.path().join("archive.zip");
        std::fs::write(&source, b"source").expect("source file should be written");
        let entries = build_local_archive_manifest(&[source], &target).expect("archive manifest should be built");
        create_local_archive(directory.path(), &target, &entries, || false).expect("archive should be created");

        let coordinator = resolve_local_archive_inspection_coordinator(
            target.clone(),
            ArchiveInspectionPresentation::DirectoryListing(ArchiveDirectoryListingPresentation::new(
                "archive.zip".to_string(),
                0,
                None,
                String::new(),
                None,
                10,
            )),
        )
        .expect("local inspection route binding should resolve");
        assert_eq!(
            coordinator
                .directory_listing()
                .expect("directory listing should succeed")
                .items
                .len(),
            1
        );

        let plan = ArchiveInspectionPlan::from_local_source(
            LocalArchiveInspectionSource::from_archive_path(target),
            ArchiveInspectionPresentation::DirectoryListing(ArchiveDirectoryListingPresentation::new(
                "archive.zip".to_string(),
                0,
                None,
                String::new(),
                None,
                10,
            )),
        )
        .expect("inspection plan should be built");
        let inspection_topology =
            resolve_companion_archive_inspection_topology_plan(true).expect("local inspection topology should resolve");
        assert_eq!(inspection_topology.kind, CompanionArchiveOperationKind::Inspect);
        assert_eq!(inspection_topology.driver, CompanionArchiveExecutionDriver::Companion);
        assert_eq!(inspection_topology.topology, CompanionArchiveTopology::LocalInspection);
        assert!(inspection_topology.source_is_local);
        assert_eq!(inspection_topology.destination_is_local, None);
        assert_eq!(inspection_topology.binding, CompanionArchiveBinding::LocalInspection);
        let incompatible_binding = CompanionArchiveTopologyPlan {
            binding: CompanionArchiveBinding::LocalToLocal,
            ..inspection_topology
        };
        assert!(resolve_companion_inspection_coordinator(incompatible_binding, plan.clone()).is_err());
        let create_topology = resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, true)
            .expect("creation topology should resolve");
        assert!(resolve_companion_inspection_coordinator(create_topology, plan).is_err());
        assert!(resolve_companion_archive_inspection_topology_plan(false).is_err());
    }

    #[test]
    fn companion_operation_resolvers_reject_incomplete_topology_contracts() {
        let state_store = Arc::new(ArchiveSessionManager::new());
        let creation_plan = CompanionArchiveCreationPlan::DirectLocalDeferred {
            state_store: state_store.clone(),
            execution_id: "creation".to_string(),
        };
        let extraction_plan = CompanionArchiveExtractionPlan::DirectLocal {
            state_store,
            execution_id: "extraction".to_string(),
        };
        let creation_topology = resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Create, true, true)
            .expect("creation topology should resolve");
        let extraction_topology = resolve_companion_archive_topology_plan(CompanionArchiveOperationKind::Extract, true, true)
            .expect("extraction topology should resolve");

        assert!(resolve_companion_creation_coordinator(
            CompanionArchiveTopologyPlan {
                binding: CompanionArchiveBinding::LocalToSmbRelay,
                ..creation_topology
            },
            creation_plan,
        )
        .is_err());
        assert!(resolve_companion_extraction_coordinator(
            CompanionArchiveTopologyPlan {
                source_is_local: false,
                ..extraction_topology
            },
            extraction_plan,
        )
        .is_err());
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn companion_archive_inspection_routes_invoke_the_production_resolver() {
        let _resolver_test_guard = INSPECTION_RESOLVER_TEST_LOCK
            .lock()
            .expect("inspection resolver test lock should not be poisoned");
        reset_inspection_resolver_call_count();
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let target = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&target).expect("archive should be created"));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive.start_file("source.txt", options).expect("source entry should start");
        archive.write_all(b"source").expect("source entry should be written");
        archive.start_file("nested/readme.txt", options).expect("nested entry should start");
        archive.write_all(b"nested").expect("nested entry should be written");
        archive.finish().expect("archive should finish");
        let drive_id = format!("test-drive-{}", uuid::Uuid::new_v4());
        crate::server::drives::register_test_drive_path(drive_id.clone(), directory.path().to_path_buf());
        let archive_path = "archive.zip".to_string();

        let listing = browse_list_archive(
            Path(drive_id.clone()),
            Query(ArchiveListQuery {
                archive_path: archive_path.clone(),
                virtual_path: None,
                cursor: None,
                page_size: Some(10),
            }),
        )
        .await
        .expect("archive listing route should succeed");
        assert!(listing.0.items.iter().any(|item| item.name == "source.txt"));
        let nested_archive_path = listing
            .0
            .items
            .iter()
            .find(|item| item.file_type == FileType::Directory)
            .expect("root archive listing should contain a directory")
            .path
            .clone();
        assert_eq!(inspection_resolver_call_count(), 1);

        let virtual_listing = browse_list_archive(
            Path(drive_id.clone()),
            Query(ArchiveListQuery {
                archive_path: archive_path.clone(),
                virtual_path: Some(nested_archive_path.clone()),
                cursor: None,
                page_size: Some(10),
            }),
        )
        .await
        .expect("nested archive listing route should succeed");
        assert_eq!(virtual_listing.0.path, nested_archive_path);
        assert_eq!(virtual_listing.0.items.len(), 1);
        assert_eq!(virtual_listing.0.items[0].name, "readme.txt");
        assert_eq!(inspection_resolver_call_count(), 2);

        let member_response = viewer_archive_member(
            Path(drive_id.clone()),
            Query(ArchiveMemberQuery {
                archive_path: archive_path.clone(),
                member_path: "source.txt".to_string(),
                download: false,
            }),
        )
        .await
        .expect("archive member route should succeed");
        assert_eq!(member_response.headers()["content-type"], "text/plain");
        assert_eq!(member_response.headers()["content-length"], "6");
        assert_eq!(to_bytes(member_response.into_body(), usize::MAX).await.unwrap(), "source");
        assert_eq!(inspection_resolver_call_count(), 3);

        let invalid_cursor = browse_list_archive(
            Path(drive_id.clone()),
            Query(ArchiveListQuery {
                archive_path: archive_path.clone(),
                virtual_path: None,
                cursor: Some("not-a-cursor".to_string()),
                page_size: Some(10),
            }),
        )
        .await
        .expect_err("invalid archive cursor should be rejected");
        assert!(matches!(invalid_cursor, ApiError::BadRequest(message) if message.contains("cursor is invalid")));
        assert_eq!(inspection_resolver_call_count(), 4);

        let missing_member = viewer_archive_member(
            Path(drive_id.clone()),
            Query(ArchiveMemberQuery {
                archive_path: archive_path.clone(),
                member_path: "missing.txt".to_string(),
                download: false,
            }),
        )
        .await
        .expect_err("unknown archive member should be rejected");
        assert!(matches!(missing_member, ApiError::BadRequest(message) if message.contains("member was not found")));
        assert_eq!(inspection_resolver_call_count(), 5);

        let unavailable_target = directory.path().join("unavailable.zip");
        std::fs::copy(&target, &unavailable_target).expect("archive should be copied for codec mutation");
        mark_zip_member_codec_unavailable(&unavailable_target);
        let unavailable_member = viewer_archive_member(
            Path(drive_id.clone()),
            Query(ArchiveMemberQuery {
                archive_path: "unavailable.zip".to_string(),
                member_path: "source.txt".to_string(),
                download: false,
            }),
        )
        .await
        .expect_err("unavailable archive member should be rejected");
        assert!(matches!(unavailable_member, ApiError::BadRequest(message) if message.contains("unavailable codec")));
        assert_eq!(inspection_resolver_call_count(), 6);

        let encrypted_target = directory.path().join("encrypted.zip");
        std::fs::copy(&target, &encrypted_target).expect("archive should be copied for encryption mutation");
        mark_zip_member_encrypted(&encrypted_target);
        let encrypted_member = viewer_archive_member(
            Path(drive_id.clone()),
            Query(ArchiveMemberQuery {
                archive_path: "encrypted.zip".to_string(),
                member_path: "source.txt".to_string(),
                download: false,
            }),
        )
        .await
        .expect_err("encrypted archive member should be rejected");
        assert!(matches!(encrypted_member, ApiError::BadRequest(message) if message.contains("blocked feature")));
        assert_eq!(inspection_resolver_call_count(), 7);

        let large_source = directory.path().join("large.txt");
        let large_target = directory.path().join("large.zip");
        std::fs::write(&large_source, vec![b'x'; (ARCHIVE_INLINE_PREVIEW_MAX_BYTES + 1) as usize])
            .expect("large source file should be written");
        let large_entries = build_local_archive_manifest(&[large_source], &large_target).expect("large archive manifest should be built");
        create_local_archive(directory.path(), &large_target, &large_entries, || false).expect("large archive should be created");
        let oversized_preview = viewer_archive_member(
            Path(drive_id),
            Query(ArchiveMemberQuery {
                archive_path: "large.zip".to_string(),
                member_path: "large.txt".to_string(),
                download: false,
            }),
        )
        .await
        .expect_err("oversized archive preview should be rejected");
        assert!(matches!(oversized_preview, ApiError::PayloadTooLarge(message) if message.contains("inline preview size limit")));
        assert_eq!(inspection_resolver_call_count(), 8);
    }

    fn mark_zip_member_codec_unavailable(archive_path: &std::path::Path) {
        update_zip_member_header_u16(archive_path, 8, 10, 99);
    }

    fn mark_zip_member_encrypted(archive_path: &std::path::Path) {
        update_zip_member_header_u16(archive_path, 6, 8, 1);
    }

    fn update_zip_member_header_u16(
        archive_path: &std::path::Path,
        local_header_offset: usize,
        central_directory_offset: usize,
        value: u16,
    ) {
        const LOCAL_HEADER: &[u8; 4] = b"PK\x03\x04";
        const CENTRAL_DIRECTORY_HEADER: &[u8; 4] = b"PK\x01\x02";

        let mut archive = std::fs::read(archive_path).expect("archive should be readable for codec mutation");
        for offset in 0..archive.len().saturating_sub(3) {
            let signature = &archive[offset..offset + 4];
            let method_offset = if signature == LOCAL_HEADER {
                offset + local_header_offset
            } else if signature == CENTRAL_DIRECTORY_HEADER {
                offset + central_directory_offset
            } else {
                continue;
            };
            archive[method_offset..method_offset + 2].copy_from_slice(&value.to_le_bytes());
        }
        std::fs::write(archive_path, archive).expect("mutated archive should be written");
    }

    #[derive(Clone)]
    struct FixtureRelayServer {
        url: String,
        playback: Arc<Mutex<FixtureRelayPlayback>>,
    }

    struct FixtureRelayPlayback {
        remaining: VecDeque<serde_json::Value>,
        expected_traffic: Vec<serde_json::Value>,
        expected_responses: Vec<serde_json::Value>,
        observed_traffic: Vec<serde_json::Value>,
        observed_responses: Vec<serde_json::Value>,
    }

    struct FailingRelayBody {
        state: u8,
    }

    impl FailingRelayBody {
        fn new() -> Self {
            Self { state: 0 }
        }
    }

    impl AsyncRead for FailingRelayBody {
        fn poll_read(mut self: Pin<&mut Self>, context: &mut Context<'_>, buffer: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
            if self.state == 0 {
                self.state = 1;
                buffer.put_slice(b"entry");
                return Poll::Ready(Ok(()));
            }
            if self.state == 1 {
                self.state = 2;
                context.waker().wake_by_ref();
                return Poll::Pending;
            }
            Poll::Ready(Err(std::io::Error::other("simulated relay body failure")))
        }
    }

    impl FixtureRelayServer {
        async fn assert_consumed(&self) {
            let playback = self.playback.lock().await;
            assert!(playback.remaining.is_empty(), "fixture relay playback has unconsumed responses");
            assert_eq!(playback.observed_traffic.len(), playback.expected_traffic.len());
            assert!(
                playback
                    .expected_traffic
                    .iter()
                    .zip(&playback.observed_traffic)
                    .all(|(expected, observed)| fixture_request_matches(expected, observed)),
                "fixture relay traffic must match every static request definition"
            );
            assert_eq!(playback.observed_responses, playback.expected_responses);
        }
    }

    fn fixture_request_matches(expected: &serde_json::Value, observed: &serde_json::Value) -> bool {
        ["method", "path", "query", "body", "body_hex"]
            .iter()
            .all(|field| expected.get(*field).is_none() || expected[*field] == "*" || expected[*field] == observed[*field])
    }

    async fn fixture_relay_handler(
        State(playback): State<Arc<Mutex<FixtureRelayPlayback>>>,
        method: Method,
        uri: Uri,
        body: axum::body::Bytes,
    ) -> axum::response::Response {
        let json_body = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .filter(serde_json::Value::is_object);
        let observed = serde_json::json!({
            "method": method.as_str(),
            "path": uri.path(),
            "query": uri.query(),
            "body": if body.is_empty() {
                "empty"
            } else if json_body.is_some() {
                "json"
            } else {
                "bytes"
            },
            "body_hex": hex::encode(&body),
            "json": json_body,
        });
        let step = {
            let mut playback = playback.lock().await;
            playback.observed_traffic.push(observed.clone());
            playback.remaining.pop_front()
        };
        let Some(step) = step else {
            return (StatusCode::INTERNAL_SERVER_ERROR, "unexpected relay request").into_response();
        };
        if !fixture_request_matches(&step["request"], &observed) {
            eprintln!("fixture relay request mismatch: expected {}, observed {observed}", step["request"]);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "relay request does not match fixture: expected {}, observed {observed}",
                    step["request"]
                ),
            )
                .into_response();
        }
        let response = &step["response"];
        {
            let mut playback = playback.lock().await;
            playback.observed_responses.push(response.clone());
        }
        let status = response["status"]
            .as_u64()
            .and_then(|value| StatusCode::from_u16(value as u16).ok())
            .expect("fixture response status should be valid");
        let body = response
            .get("json")
            .map(serde_json::Value::to_string)
            .or_else(|| response.get("text").and_then(serde_json::Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let truncated_stream = response["truncated_stream"].as_bool() == Some(true);
        if truncated_stream {
            let mut response = axum::response::Response::new(super::Body::from_stream(super::ReaderStream::new(FailingRelayBody::new())));
            *response.status_mut() = status;
            return response;
        }
        let mut response = (status, body).into_response();
        if step["response"].get("json").is_some() {
            response
                .headers_mut()
                .insert(axum::http::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        response
    }

    async fn spawn_fixture_relay_server(case_name: &str) -> FixtureRelayServer {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        let case = fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .find(|case| case["name"] == case_name)
            .unwrap_or_else(|| panic!("topology trace fixture should define {case_name}"));
        spawn_fixture_relay_playback(
            case["relay_playback"]
                .as_array()
                .unwrap_or_else(|| panic!("topology trace fixture should define relay playback for {case_name}"))
                .clone(),
        )
        .await
    }

    async fn spawn_fixture_relay_playback(steps: Vec<serde_json::Value>) -> FixtureRelayServer {
        let playback = Arc::new(Mutex::new(FixtureRelayPlayback {
            expected_traffic: steps.iter().map(|step| step["request"].clone()).collect(),
            expected_responses: steps.iter().map(|step| step["response"].clone()).collect(),
            remaining: steps.into(),
            observed_traffic: Vec::new(),
            observed_responses: Vec::new(),
        }));
        let app = axum::Router::new()
            .fallback(axum::routing::any(fixture_relay_handler))
            .with_state(playback.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture relay server should bind");
        let address = listener.local_addr().expect("fixture relay server should have an address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("fixture relay server should remain available");
        });
        FixtureRelayServer {
            url: format!("http://{address}"),
            playback,
        }
    }

    fn mixed_creation_trajectory_cases() -> Vec<serde_json::Value> {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        fixture["trajectory_cases"]
            .as_array()
            .expect("topology trace fixture should define trajectory cases")
            .iter()
            .filter(|case| case["operation"] == "create" && matches!(case["topology"].as_str(), Some("smb_to_local" | "local_to_smb")))
            .cloned()
            .collect()
    }

    fn creation_corpus_scenario(name: &str) -> serde_json::Value {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/creation-trajectory-scenarios-v2.json"
        ))
        .expect("creation trajectory corpus should be valid JSON");
        corpus["scenarios"]
            .as_array()
            .expect("creation corpus should define scenarios")
            .iter()
            .find(|scenario| scenario["name"] == name)
            .unwrap_or_else(|| panic!("creation corpus should define {name}"))
            .clone()
    }

    fn mixed_creation_trace(manifest: &ArchiveCreationManifest, result: &ArchiveCreationResponse) -> serde_json::Value {
        serde_json::json!({
            "owner": "companion",
            "manifest_snapshot": manifest.entries.iter().map(|entry| entry.archive_path.as_str()).collect::<Vec<_>>(),
            "phase_transitions": ["streaming", "completed"],
            "pending_decision": null,
            "member_outcomes": manifest.entries.iter().map(|entry| entry.archive_path.as_str()).collect::<Vec<_>>(),
            "terminal_summary": {
                "files_created": result.files_created,
                "directories_created": result.directories_created,
                "source_bytes": result.source_bytes,
            },
            "error_category": null,
        })
    }

    fn mixed_creation_failure_trace(manifest: &ArchiveCreationManifest, error_category: &str) -> serde_json::Value {
        serde_json::json!({
            "owner": "companion",
            "manifest_snapshot": manifest.entries.iter().map(|entry| entry.archive_path.as_str()).collect::<Vec<_>>(),
            "phase_transitions": ["streaming", if error_category == "cancelled" { "cancelled" } else { "failed" }],
            "pending_decision": null,
            "member_outcomes": [],
            "terminal_summary": null,
            "error_category": error_category,
        })
    }

    fn mixed_relay_error_category(error: &ApiError) -> &'static str {
        let message = match error {
            ApiError::Conflict(serde_json::Value::String(message)) => message.clone(),
            ApiError::ConflictWithCode { message, .. }
            | ApiError::BadRequest(message)
            | ApiError::BadRequestWithCode { message, .. }
            | ApiError::Internal(message)
            | ApiError::InternalWithCode { message, .. }
            | ApiError::Forbidden(message)
            | ApiError::ForbiddenWithCode { message, .. } => message.clone(),
            _ => error.to_string(),
        };
        if message.contains("was cancelled") {
            "cancelled"
        } else if message.contains("source changed") {
            "source_changed"
        } else if message.contains("partial") || message.contains("incomplete output") {
            "partial_write"
        } else if message.contains("output already exists") {
            "collision"
        } else if message.contains("HTTP") {
            "transport_failure"
        } else {
            "invalid_input"
        }
    }

    struct FailingLocalArchiveWriter {
        accepted_before_error: usize,
        accepted: usize,
    }

    impl tokio::io::AsyncWrite for FailingLocalArchiveWriter {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            _context: &mut std::task::Context<'_>,
            buffer: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            if self.accepted >= self.accepted_before_error {
                return std::task::Poll::Ready(Err(std::io::Error::other("injected local write failure")));
            }
            let accepted = buffer.len().min(self.accepted_before_error - self.accepted);
            self.accepted += accepted;
            std::task::Poll::Ready(Ok(accepted))
        }

        fn poll_flush(self: std::pin::Pin<&mut Self>, _context: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: std::pin::Pin<&mut Self>, _context: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn local_relay_write_reports_partial_only_after_bytes_are_accepted() {
        let mut zero_byte_writer = FailingLocalArchiveWriter {
            accepted_before_error: 0,
            accepted: 0,
        };
        let mut zero_byte_accepted = 0;
        assert!(
            write_local_archive_member_chunk(&mut zero_byte_writer, b"entry", &mut zero_byte_accepted)
                .await
                .is_err()
        );
        assert_eq!(zero_byte_accepted, 0);

        let mut partial_writer = FailingLocalArchiveWriter {
            accepted_before_error: 2,
            accepted: 0,
        };
        let mut partial_accepted = 0;
        assert!(
            write_local_archive_member_chunk(&mut partial_writer, b"entry", &mut partial_accepted)
                .await
                .is_err()
        );
        assert_eq!(partial_accepted, 2);
    }

    #[test]
    fn topology_trace_fixture_assigns_mixed_execution_to_companion_relay_coordinators() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        assert_eq!(fixture["version"], 2);
        assert_eq!(
            fixture["adapter_faults"],
            serde_json::json!([
                "malformed_input",
                "collision",
                "partial_write",
                "cancellation",
                "source_changed",
                "transport_failure"
            ])
        );
        let companion_topologies = fixture["topologies"]
            .as_array()
            .expect("topology trace fixture should define topologies")
            .iter()
            .filter(|topology| topology["owner"] == "companion")
            .map(|topology| topology["name"].as_str().expect("topology name should be a string"))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            companion_topologies,
            std::collections::HashSet::from(["local_to_local", "smb_to_local", "local_to_smb"])
        );
        for topology in fixture["topologies"]
            .as_array()
            .expect("topology trace fixture should define topologies")
            .iter()
            .filter(|topology| topology["name"] == "smb_to_local" || topology["name"] == "local_to_smb")
        {
            assert!(topology["exercises"]
                .as_array()
                .expect("mixed topology must declare execution seams")
                .contains(&serde_json::json!("companion_relay_coordinator")));
            assert!(topology["exercises"]
                .as_array()
                .expect("mixed topology must declare execution seams")
                .contains(&serde_json::json!("relay_transport")));
        }
        let fixture_cases = fixture["cases"].as_array().expect("topology trace fixture should define cases");
        let required_mixed_extraction_faults = [
            "malformed_input",
            "collision",
            "partial_write",
            "cancellation",
            "source_changed",
            "transport_failure",
        ];
        for topology in ["smb_to_local", "local_to_smb"] {
            let declared_faults = fixture_cases
                .iter()
                .filter(|case| case["operation"] == "extract" && case["topology"] == topology)
                .filter_map(|case| case["fault"].as_str())
                .collect::<std::collections::HashSet<_>>();
            assert!(required_mixed_extraction_faults.iter().all(|fault| declared_faults.contains(fault)));
        }
        let creation_corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/creation-trajectory-scenarios-v2.json"
        ))
        .expect("creation trajectory corpus should be valid JSON");
        let extraction_corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/extraction-trajectory-scenarios-v2.json"
        ))
        .expect("extraction trajectory corpus should be valid JSON");
        let corpus_scenarios = [("create", &creation_corpus), ("extract", &extraction_corpus)];
        for (operation, corpus) in corpus_scenarios {
            let expected_scenarios = corpus["scenarios"]
                .as_array()
                .expect("trajectory corpus should define scenarios")
                .iter()
                .filter_map(|scenario| scenario["name"].as_str())
                .collect::<std::collections::HashSet<_>>();
            for topology in ["local_to_local", "smb_to_local", "local_to_smb"] {
                let declared_scenarios = fixture["trajectory_cases"]
                    .as_array()
                    .expect("topology trace fixture should define trajectory cases")
                    .iter()
                    .filter(|case| case["operation"] == operation && case["topology"] == topology)
                    .filter_map(|case| case["scenario"].as_str())
                    .collect::<std::collections::HashSet<_>>();
                assert_eq!(declared_scenarios, expected_scenarios);
            }
        }
    }

    #[test]
    fn v2_relay_binding_fixture_matches_companion_route_bindings() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../archive-contract/v2/fixtures/relay-bindings-v2.json"))
                .expect("relay binding fixture should be valid JSON");
        assert_eq!(fixture["version"], 2);
        let fixture_bindings = fixture["bindings"]
            .as_array()
            .expect("relay binding fixture should define bindings")
            .iter()
            .map(|binding| {
                (
                    binding["purpose"].as_str().expect("relay purpose should be a string"),
                    binding["kind"].as_str().expect("relay kind should be a string"),
                    binding["source"].as_str().expect("relay source should be a string"),
                    binding["destination"].as_str().expect("relay destination should be a string"),
                )
            })
            .collect::<HashSet<_>>();
        assert_eq!(fixture_bindings.len(), fixture["bindings"].as_array().unwrap().len());
        assert_eq!(
            fixture_bindings.iter().map(|(purpose, _, _, _)| *purpose).collect::<HashSet<_>>(),
            HashSet::from([
                ArchiveRelayBinding::LocalZipToSmbExtract.capability_purpose(),
                ArchiveRelayBinding::SmbZipToLocalExtract.capability_purpose(),
                ArchiveRelayBinding::SmbToLocalZipCreate.capability_purpose(),
                ArchiveRelayBinding::LocalToSmbZipCreate.capability_purpose(),
            ])
        );

        let resolved_bindings = [CompanionArchiveOperationKind::Create, CompanionArchiveOperationKind::Extract]
            .into_iter()
            .flat_map(|kind| {
                [(true, false), (false, true)]
                    .into_iter()
                    .map(move |(source_is_local, destination_is_local)| {
                        let purpose = ArchiveRelayBinding::resolve(kind, source_is_local, destination_is_local)
                            .expect("mixed topology should have a relay binding");
                        (
                            purpose.capability_purpose(),
                            match kind {
                                CompanionArchiveOperationKind::Create => "create",
                                CompanionArchiveOperationKind::Extract => "extract",
                                CompanionArchiveOperationKind::Inspect => unreachable!("inspection is not a relay operation"),
                            },
                            if source_is_local { "local" } else { "smb" },
                            if destination_is_local { "local" } else { "smb" },
                        )
                    })
            })
            .collect::<HashSet<_>>();
        assert_eq!(resolved_bindings, fixture_bindings);

        for kind in [CompanionArchiveOperationKind::Create, CompanionArchiveOperationKind::Extract] {
            assert!(ArchiveRelayBinding::resolve(kind, true, true).is_err());
            assert!(ArchiveRelayBinding::resolve(kind, false, false).is_err());
        }
    }

    async fn spawn_archive_relay_transport_test_server() -> String {
        let app = axum::Router::new()
            .route("/begin", axum::routing::post(|| async { (StatusCode::OK, "invalid JSON") }))
            .route(
                "/member-complete",
                axum::routing::post(|| async { (StatusCode::OK, "ignored response") }),
            )
            .route("/fail", axum::routing::post(|| async { StatusCode::CONFLICT }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("relay transport test server should bind");
        let address = listener.local_addr().expect("relay transport test server should have an address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("relay transport test server should remain available");
        });
        format!("http://{address}")
    }

    async fn spawn_dropped_acknowledgement_server() -> (String, oneshot::Receiver<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("dropped acknowledgement test server should bind");
        let address = listener
            .local_addr()
            .expect("dropped acknowledgement test server should have an address");
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let mut requests = Vec::new();
            for attempt in 0..ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS {
                let (mut stream, _) = listener
                    .accept()
                    .await
                    .expect("dropped acknowledgement test server should accept a request");
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let bytes_read = stream
                        .read(&mut buffer)
                        .await
                        .expect("dropped acknowledgement test server should read a request");
                    assert_ne!(bytes_read, 0, "request must include complete headers");
                    request.extend_from_slice(&buffer[..bytes_read]);
                }
                requests.push(String::from_utf8(request).expect("relay request headers should be UTF-8"));
                if attempt + 1 == ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .await
                        .expect("dropped acknowledgement test server should respond to retry");
                }
            }
            sender
                .send(requests)
                .expect("test should receive captured acknowledgement requests");
        });
        (format!("http://{address}"), receiver)
    }

    #[tokio::test]
    async fn archive_relay_transport_handles_acknowledgements_and_response_errors() {
        let transport = ArchiveRelayTransport::new(
            reqwest::Client::new(),
            spawn_archive_relay_transport_test_server().await,
            "test-token".to_string(),
        );

        transport
            .post_json_without_result(
                "member-complete",
                &serde_json::json!({"archive_path": "readme.txt", "status": "created", "source_bytes": 5}),
                "Archive creation member completion",
                "complete member",
            )
            .await
            .expect("successful acknowledgements must not require a response body");

        let begin_error = transport
            .begin::<serde_json::Value>("Archive start")
            .await
            .expect_err("a begin response must contain valid JSON");
        assert!(matches!(begin_error, ApiError::Internal(message) if message.contains("invalid start response")));

        let failure_error = transport
            .fail("Archive relay failed", "Archive failure")
            .await
            .expect_err("a failed acknowledgement must retain its HTTP classification");
        assert!(
            matches!(failure_error, ApiError::Conflict(message) if message.as_str().is_some_and(|value| value.contains("record failure")))
        );
    }

    #[tokio::test]
    async fn archive_relay_transport_reuses_idempotency_key_after_dropped_acknowledgement_response() {
        let (relay_url, captured_requests) = spawn_dropped_acknowledgement_server().await;
        let transport = ArchiveRelayTransport::new(reqwest::Client::new(), relay_url, "test-token".to_string());

        transport
            .post_json_without_result(
                "member-complete",
                &serde_json::json!({"archive_path": "readme.txt", "status": "created", "source_bytes": 5}),
                "Archive creation member completion",
                "complete member",
            )
            .await
            .expect("a dropped acknowledgement response should retry successfully");

        let requests = captured_requests
            .await
            .expect("dropped acknowledgement test server should capture both requests");
        assert_eq!(requests.len(), ARCHIVE_RELAY_ACKNOWLEDGEMENT_ATTEMPTS);
        let idempotency_keys = requests
            .iter()
            .map(|request| {
                request
                    .lines()
                    .find_map(|line| line.strip_prefix("idempotency-key: "))
                    .expect("acknowledgement should include an idempotency key")
            })
            .collect::<Vec<_>>();
        assert_eq!(idempotency_keys[0], idempotency_keys[1]);
        assert!(uuid::Uuid::parse_str(idempotency_keys[0]).is_ok());
    }

    #[allow(dead_code)]
    async fn spawn_remote_creation_source_server() -> String {
        let app = axum::Router::new()
            .route(
                "/begin",
                axum::routing::post(|| async {
                    axum::Json(serde_json::json!({
                        "entries": [{
                            "archive_path": "source.txt",
                            "is_directory": false,
                            "source_size": 6,
                            "source_modified_at": null
                        }]
                    }))
                }),
            )
            .route("/member", axum::routing::get(|| async { (StatusCode::OK, "source") }))
            .route("/member-complete", axum::routing::post(|| async { StatusCode::NO_CONTENT }))
            .route("/complete", axum::routing::post(|| async { StatusCode::NO_CONTENT }))
            .route("/fail", axum::routing::post(|| async { StatusCode::NO_CONTENT }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("relay source test server should bind");
        let address = listener.local_addr().expect("relay source test server should have an address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("relay source test server should remain available");
        });
        format!("http://{address}")
    }

    #[allow(dead_code)]
    async fn spawn_remote_creation_destination_server() -> String {
        let app = axum::Router::new()
            .route("/begin", axum::routing::post(|| async { StatusCode::NO_CONTENT }))
            .route(
                "/member",
                axum::routing::put(|_: axum::body::Bytes| async { StatusCode::NO_CONTENT }),
            )
            .route("/complete", axum::routing::post(|| async { StatusCode::NO_CONTENT }))
            .route("/fail", axum::routing::post(|| async { StatusCode::NO_CONTENT }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("relay destination test server should bind");
        let address = listener.local_addr().expect("relay destination test server should have an address");
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("relay destination test server should remain available");
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn actual_relay_creation_coordinator_executes_both_mixed_topologies() {
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let remote_target = directory.path().join("from-smb.zip");
        let remote_playback = spawn_fixture_relay_server("create_smb_to_local_success").await;
        let remote_manifest = ArchiveCreationManifest::from_entries(vec![ArchiveCreationManifestMember {
            archive_path: "source.txt".to_string(),
            is_directory: false,
            source_size: 6,
            source_modified_at: None,
        }])
        .expect("test manifest should be valid");
        let remote_result = FixtureArchiveCreationInvocation {
            relay: ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                reqwest::Client::new(),
                remote_playback.url.clone(),
                "test-token".to_string(),
            )),
            binding: ArchiveCreationAdapterBinding::RemoteSourceToLocalDestination {
                manifest: remote_manifest.clone(),
                drive_root: directory.path().to_path_buf(),
                target_path: remote_target.clone(),
            },
        }
        .execute()
        .await
        .expect("SMB-to-local creation coordinator should complete");
        let remote_expected = expected_topology_trace("create_smb_to_local_success");
        assert_eq!(mixed_creation_trace(&remote_manifest, &remote_result), remote_expected);
        assert!(remote_target.is_file());
        remote_playback.assert_consumed().await;

        let local_source = directory.path().join("local-source.txt");
        std::fs::write(&local_source, b"local source").expect("local source should be written");
        let local_entries =
            build_local_archive_manifest_for_remote_target(&[local_source]).expect("local source should produce a valid creation manifest");
        let local_playback = spawn_fixture_relay_server("create_local_to_smb_success").await;
        let local_result = FixtureArchiveCreationInvocation {
            relay: ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                reqwest::Client::new(),
                local_playback.url.clone(),
                "test-token".to_string(),
            )),
            binding: ArchiveCreationAdapterBinding::LocalSourceToRemoteDestination {
                entries: local_entries.clone(),
            },
        }
        .execute()
        .await
        .expect("local-to-SMB creation coordinator should complete");
        let local_expected = expected_topology_trace("create_local_to_smb_success");
        let local_manifest = ArchiveCreationManifest::from_entries(
            local_entries
                .iter()
                .map(|entry| ArchiveCreationManifestMember {
                    archive_path: entry.archive_path.clone(),
                    is_directory: entry.is_directory,
                    source_size: entry.source_size,
                    source_modified_at: entry.source_modified_at.clone(),
                })
                .collect(),
        )
        .expect("local creation manifest should be valid");
        assert_eq!(mixed_creation_trace(&local_manifest, &local_result), local_expected);
        local_playback.assert_consumed().await;
    }

    #[tokio::test]
    async fn actual_relay_creation_coordinator_dispatches_every_mixed_fault() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        let cases = fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .filter(|case| {
                case["operation"] == "create"
                    && matches!(case["topology"].as_str(), Some("smb_to_local" | "local_to_smb"))
                    && case["fault"].is_string()
            })
            .cloned()
            .collect::<Vec<_>>();
        let expected_cases = cases
            .iter()
            .map(|case| case["name"].as_str().expect("fault case must have a name"))
            .collect::<std::collections::HashSet<_>>();
        let dispatched_cases = [
            "create_smb_to_local_malformed_input",
            "create_smb_to_local_collision",
            "create_smb_to_local_partial_write",
            "create_smb_to_local_cancellation",
            "create_smb_to_local_source_changed",
            "create_smb_to_local_transport_failure",
            "create_local_to_smb_malformed_input",
            "create_local_to_smb_collision",
            "create_local_to_smb_partial_write",
            "create_local_to_smb_cancellation",
            "create_local_to_smb_source_changed",
            "create_local_to_smb_transport_failure",
        ]
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            dispatched_cases, expected_cases,
            "mixed creation dispatcher must cover every declared fault"
        );

        for case in cases {
            let case_name = case["name"].as_str().expect("fault case must have a name");
            let fault = case["fault"].as_str().expect("fault case must name a fault");
            let topology = case["topology"].as_str().expect("fault case must name a topology");
            let playback = spawn_fixture_relay_playback(
                case["relay_playback"]
                    .as_array()
                    .expect("mixed creation fault must define passive relay playback")
                    .clone(),
            )
            .await;
            let directory = tempfile::tempdir().expect("temporary archive directory should be created");
            let (manifest, result) = if topology == "smb_to_local" {
                let relay = ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                    reqwest::Client::new(),
                    playback.url.clone(),
                    "test-token".to_string(),
                ));
                match relay.begin_remote_source().await {
                    Ok(manifest) => {
                        let target_path = directory.path().join("target.zip");
                        if fault == "collision" {
                            std::fs::write(&target_path, b"existing").expect("collision target should be written");
                        }
                        let result = FixtureArchiveCreationInvocation {
                            relay,
                            binding: ArchiveCreationAdapterBinding::RemoteSourceToLocalDestination {
                                manifest: manifest.clone(),
                                drive_root: directory.path().to_path_buf(),
                                target_path,
                            },
                        }
                        .execute()
                        .await;
                        (manifest, result)
                    }
                    Err(error) => (ArchiveCreationManifest { entries: Vec::new() }, Err(error)),
                }
            } else {
                let source = directory.path().join("entry.txt");
                std::fs::write(&source, b"entry").expect("local source should be written");
                let entries = if fault == "malformed_input" {
                    vec![LocalArchiveEntry {
                        source_path: source.clone(),
                        archive_path: "../entry.txt".to_string(),
                        is_directory: false,
                        source_size: 5,
                        source_modified_at: None,
                    }]
                } else {
                    build_local_archive_manifest_for_remote_target(std::slice::from_ref(&source))
                        .expect("local source should produce a creation manifest")
                };
                if fault == "source_changed" {
                    std::fs::write(&source, b"changed entry").expect("local source should change after manifest construction");
                }
                let manifest = ArchiveCreationManifest::from_entries(
                    entries
                        .iter()
                        .map(|entry| ArchiveCreationManifestMember {
                            archive_path: entry.archive_path.clone(),
                            is_directory: entry.is_directory,
                            source_size: entry.source_size,
                            source_modified_at: entry.source_modified_at.clone(),
                        })
                        .collect(),
                )
                .unwrap_or(ArchiveCreationManifest { entries: Vec::new() });
                let result = FixtureArchiveCreationInvocation {
                    relay: ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                        reqwest::Client::new(),
                        playback.url.clone(),
                        "test-token".to_string(),
                    )),
                    binding: ArchiveCreationAdapterBinding::LocalSourceToRemoteDestination { entries },
                }
                .execute()
                .await;
                (manifest, result)
            };
            let error = result.expect_err("fault fixture should fail creation");
            let category = mixed_relay_error_category(&error);
            assert_eq!(
                category,
                case["expected_trace"]["error_category"]
                    .as_str()
                    .expect("fault trace must name an error category")
            );
            assert_eq!(
                mixed_creation_failure_trace(&manifest, category),
                case["expected_trace"],
                "{case_name} must match its complete fixture trace"
            );
            playback.assert_consumed().await;
        }
    }

    #[tokio::test]
    async fn mixed_creation_trajectory_matrix_dispatches_actual_coordinators() {
        let trajectories = mixed_creation_trajectory_cases();
        let topology_fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        let expected_cases = topology_fixture["trajectory_cases"]
            .as_array()
            .expect("topology trace fixture should define trajectory cases")
            .iter()
            .filter(|case| case["operation"] == "create" && matches!(case["topology"].as_str(), Some("smb_to_local" | "local_to_smb")))
            .map(|case| {
                (
                    case["topology"].as_str().expect("trajectory topology must be a string"),
                    case["scenario"].as_str().expect("trajectory scenario must be a string"),
                )
            })
            .collect::<std::collections::HashSet<_>>();
        let dispatched_cases = trajectories
            .iter()
            .map(|case| {
                (
                    case["topology"].as_str().expect("mixed topology must be a string"),
                    case["scenario"].as_str().expect("mixed scenario must be a string"),
                )
            })
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            dispatched_cases, expected_cases,
            "mixed fixture must cover every creation trajectory"
        );

        for trajectory in trajectories {
            let scenario_name = trajectory["scenario"].as_str().expect("trajectory should name a scenario");
            let scenario = creation_corpus_scenario(scenario_name);
            let directory = tempfile::tempdir().expect("temporary archive directory should be created");
            let playback = spawn_fixture_relay_playback(
                trajectory["relay_playback"]
                    .as_array()
                    .expect("mixed creation trajectory should define passive relay playback")
                    .clone(),
            )
            .await;
            let (manifest, result) = if trajectory["topology"] == "smb_to_local" {
                let manifest = ArchiveCreationManifest::from_entries(
                    scenario["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|entry| ArchiveCreationManifestMember {
                            archive_path: entry["archive_path"].as_str().unwrap().to_string(),
                            is_directory: entry["is_directory"].as_bool().unwrap(),
                            source_size: entry["source_size"].as_u64().unwrap(),
                            source_modified_at: None,
                        })
                        .collect(),
                )
                .expect("corpus creation manifest should be valid");
                let result = FixtureArchiveCreationInvocation {
                    relay: ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                        reqwest::Client::new(),
                        playback.url.clone(),
                        "test-token".to_string(),
                    )),
                    binding: ArchiveCreationAdapterBinding::RemoteSourceToLocalDestination {
                        manifest: manifest.clone(),
                        drive_root: directory.path().to_path_buf(),
                        target_path: directory.path().join("target.zip"),
                    },
                }
                .execute()
                .await;
                (manifest, result)
            } else {
                let source_root = directory.path().join("source");
                std::fs::create_dir(&source_root).expect("source root should be created");
                let mut source_paths = Vec::new();
                for entry in scenario["entries"].as_array().unwrap() {
                    let archive_path = entry["archive_path"].as_str().unwrap();
                    let source_path = source_root.join(archive_path);
                    if entry["is_directory"].as_bool().unwrap() {
                        std::fs::create_dir_all(&source_path).expect("source directory should be created");
                    } else {
                        std::fs::create_dir_all(source_path.parent().unwrap()).expect("source parent should be created");
                        std::fs::write(&source_path, vec![b'x'; entry["source_size"].as_u64().unwrap() as usize])
                            .expect("source file should be written");
                    }
                    let top_level = source_root.join(archive_path.split('/').next().unwrap());
                    if !source_paths.contains(&top_level) {
                        source_paths.push(top_level);
                    }
                }
                let entries =
                    build_local_archive_manifest_for_remote_target(&source_paths).expect("corpus local sources should produce a manifest");
                let manifest = ArchiveCreationManifest::from_entries(
                    entries
                        .iter()
                        .map(|entry| ArchiveCreationManifestMember {
                            archive_path: entry.archive_path.clone(),
                            is_directory: entry.is_directory,
                            source_size: entry.source_size,
                            source_modified_at: entry.source_modified_at.clone(),
                        })
                        .collect(),
                )
                .expect("corpus local creation manifest should be valid");
                let result = FixtureArchiveCreationInvocation {
                    relay: ArchiveCreationRelay::from_transport(ArchiveRelayTransport::new(
                        reqwest::Client::new(),
                        playback.url.clone(),
                        "test-token".to_string(),
                    )),
                    binding: ArchiveCreationAdapterBinding::LocalSourceToRemoteDestination { entries },
                }
                .execute()
                .await;
                (manifest, result)
            };
            let expected = &trajectory["expected_trace"];
            let trace = match result {
                Ok(result) => mixed_creation_trace(&manifest, &result),
                Err(error) => mixed_creation_failure_trace(&manifest, mixed_relay_error_category(&error)),
            };
            assert_eq!(
                trace, *expected,
                "creation trajectory {scenario_name} must match its complete fixture trace"
            );
            playback.assert_consumed().await;
        }
    }

    #[allow(dead_code)]
    fn streaming_relay_operation(checkpoint_json: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "phase": "streaming",
            "destination_path": "output",
            "checkpoint_json": checkpoint_json.to_string(),
            "pending_decision_json": null
        })
    }

    #[tokio::test]
    async fn smb_to_local_live_relay_writes_one_source_owned_member() {
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let destination_path = directory.path().join("from-smb");
        let playback = spawn_fixture_relay_playback(vec![
            serde_json::json!({
                "request": {"method": "POST", "path": "/live/begin", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {"sourceSessionId": "source-1"}}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/next-member", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {
                    "sourceSessionId": "source-1",
                    "deliverySequence": 1,
                    "memberPath": "entry.txt",
                    "isDirectory": false,
                    "uncompressedSize": 5,
                    "modifiedAt": null,
                    "targetPath": null,
                    "collisionPolicy": null
                }}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/current-member", "query": "*", "body": "empty"},
                "response": {"status": 200, "text": "entry"}
            }),
            serde_json::json!({
                "request": {"method": "POST", "path": "/live/result", "query": null, "body": "json"},
                "response": {"status": 200, "json": {
                    "phase": "ready",
                    "aggregate_counters": {
                        "members_processed": 1,
                        "members_completed": 1,
                        "members_skipped": 0,
                        "members_failed": 0,
                        "files_extracted": 1,
                        "directories_created": 1,
                        "extracted_bytes": 5,
                        "files_replaced": 0
                    }
                }}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/next-member", "query": null, "body": "empty"},
                "response": {"status": 200, "json": null}
            }),
            serde_json::json!({
                "request": {"method": "POST", "path": "/live/complete", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {
                    "phase": "completed",
                    "aggregate_counters": {
                        "members_processed": 1,
                        "members_completed": 1,
                        "members_skipped": 0,
                        "members_failed": 0,
                        "files_extracted": 1,
                        "directories_created": 1,
                        "extracted_bytes": 5,
                        "files_replaced": 0
                    }
                }}
            }),
        ])
        .await;

        let relay = ArchiveExtractionRelay::from_transport(ArchiveRelayTransport::new(
            reqwest::Client::new(),
            playback.url.clone(),
            "test-token".to_string(),
        ));
        let result = extract_smb_archive_to_local_live(&relay, directory.path().to_path_buf(), destination_path.clone())
            .await
            .expect("SMB-to-local live relay should complete");

        assert_eq!(
            (
                result.members_processed,
                result.files_extracted,
                result.members_skipped,
                result.extracted_bytes
            ),
            (1, 1, 0, 5)
        );
        assert_eq!(fs::read(destination_path.join("entry.txt")).unwrap(), b"entry");
        let playback_state = playback.playback.lock().await;
        assert_eq!(playback_state.observed_traffic[3]["json"]["source_session_id"], "source-1");
        assert_eq!(playback_state.observed_traffic[3]["json"]["delivery_sequence"], 1);
        assert_eq!(playback_state.observed_traffic[3]["json"]["member_path"], "entry.txt");
        drop(playback_state);
        playback.assert_consumed().await;
    }

    #[tokio::test]
    async fn local_to_smb_live_relay_pauses_the_retained_source_for_a_destination_collision() {
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let archive_path = directory.path().join("source.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).expect("archive should be created"));
        archive
            .start_file(
                "selected.txt",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .expect("archive entry should start");
        archive.write_all(b"selected").expect("archive entry should be written");
        archive.finish().expect("archive should finish");

        let source = Arc::new(tokio::sync::Mutex::new(
            LiveLocalArchiveSourceSession::open(&archive_path).expect("local archive source should open"),
        ));
        let source_session_id = source.lock().await.source_session_id().to_string();
        let destination_member_query = format!(
            "source_session_id={source_session_id}&delivery_sequence=1&member_path=selected.txt&target_path=selected.txt&is_directory=false&collision_policy=ask&modified_at=1980-01-01T00%3A00%3A00%2B00%3A00"
        );
        let playback = spawn_fixture_relay_playback(vec![
            serde_json::json!({
                "request": {"method": "POST", "path": "/live/destination-begin", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {}}
            }),
            serde_json::json!({
                "request": {
                    "method": "PUT",
                    "path": "/live/destination-member",
                    "query": destination_member_query,
                    "body": "bytes",
                    "body_hex": "73656c6563746564"
                },
                "response": {"status": 200, "json": {
                    "source_session_id": source_session_id,
                    "delivery_sequence": 1,
                    "member_path": "selected.txt",
                    "status": "awaiting_collision",
                    "extracted_bytes": 0,
                    "directories_created": 0,
                    "replaced": false,
                    "target_path": "output/selected.txt",
                    "message": "Archive target already exists"
                }}
            }),
        ])
        .await;
        let relay = ArchiveExtractionRelay::from_transport(ArchiveRelayTransport::new(
            reqwest::Client::new(),
            playback.url.clone(),
            "test-token".to_string(),
        ));

        let result = extract_local_archive_to_smb_destination_live(&relay, source.clone(), Arc::new(AtomicBool::new(false)))
            .await
            .expect("a destination collision should pause the local source");

        assert_eq!(result.phase, Some("awaiting_user_decision"));
        let source = source.lock().await;
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::AwaitingDecision);
        assert_eq!(source.pending_decision_target_path(), Some("output/selected.txt"));
        assert_eq!(source.pending_decision_message(), Some("Archive target already exists"));
        drop(source);
        playback.assert_consumed().await;
    }

    #[tokio::test]
    async fn smb_to_local_live_relay_recovers_source_integrity_failure_from_live_status() {
        let directory = tempfile::tempdir().expect("temporary archive directory should be created");
        let destination_path = directory.path().join("from-smb");
        let playback = spawn_fixture_relay_playback(vec![
            serde_json::json!({
                "request": {"method": "POST", "path": "/live/begin", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {"sourceSessionId": "source-1"}}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/next-member", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {
                    "sourceSessionId": "source-1",
                    "deliverySequence": 1,
                    "memberPath": "entry.txt",
                    "isDirectory": false,
                    "uncompressedSize": 5,
                    "modifiedAt": null,
                    "targetPath": null,
                    "collisionPolicy": null
                }}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/current-member", "query": "*", "body": "empty"},
                "response": {"status": 200, "text": "entry", "truncated_stream": true}
            }),
            serde_json::json!({
                "request": {"method": "GET", "path": "/live/status", "query": null, "body": "empty"},
                "response": {"status": 200, "json": {
                    "phase": "awaiting_decision",
                    "aggregate_counters": {
                        "members_processed": 0,
                        "members_completed": 0,
                        "members_skipped": 0,
                        "members_failed": 0,
                        "files_extracted": 0,
                        "directories_created": 0,
                        "extracted_bytes": 0,
                        "files_replaced": 0
                    },
                    "pending_decision": {"kind": "member_error"}
                }}
            }),
        ])
        .await;

        let relay = ArchiveExtractionRelay::from_transport(ArchiveRelayTransport::new(
            reqwest::Client::new(),
            playback.url.clone(),
            "test-token".to_string(),
        ));
        let result = extract_smb_archive_to_local_live(&relay, directory.path().to_path_buf(), destination_path)
            .await
            .expect("source integrity failure should surface the live retry decision");

        assert_eq!(result.phase, Some("awaiting_user_decision"));
        assert_eq!(result.members_processed, 0);
        playback.assert_consumed().await;
    }

    #[tokio::test]
    async fn extraction_relay_reports_failure_to_live_endpoint() {
        let playback = spawn_fixture_relay_playback(vec![serde_json::json!({
            "request": {"method": "POST", "path": "/live/fail", "query": null, "body": "json"},
            "response": {"status": 200, "json": streaming_relay_operation(serde_json::json!({
                "aggregate_counters": {
                    "members_processed": 0,
                    "members_completed": 0,
                    "members_skipped": 0,
                    "members_failed": 0,
                    "files_extracted": 0,
                    "directories_created": 0,
                    "extracted_bytes": 0,
                    "files_replaced": 0
                }
            }))}
        })])
        .await;
        let relay = ArchiveExtractionRelay::from_transport(ArchiveRelayTransport::new(
            reqwest::Client::new(),
            playback.url.clone(),
            "test-token".to_string(),
        ));

        relay.fail().await.expect("live extraction failure should be reported");

        playback.assert_consumed().await;
    }

    #[tokio::test]
    async fn archive_relay_failure_envelope_preserves_execution_error() {
        let error = execute_archive_relay(
            async { Err::<(), _>(ApiError::BadRequest("Archive operation failed".to_string())) },
            async { Err::<(), _>(ApiError::Internal("Failure reporting also failed".to_string())) },
        )
        .await
        .expect_err("the relay execution error must not be replaced by a failure-report error");

        assert!(matches!(error, ApiError::BadRequest(message) if message == "Archive operation failed"));
    }

    #[test]
    fn serializes_v2_creation_control_payloads() {
        assert_eq!(
            serde_json::to_value(ArchiveCreationMemberCompletion {
                archive_path: "docs/readme.txt",
                status: "created",
                source_bytes: 5,
            })
            .unwrap(),
            relay_control_payload_example("creation_member_completion")
        );
        assert_eq!(
            serde_json::to_value(archive_creation_response(LocalArchiveCreationResult {
                files_created: 1,
                directories_created: 1,
                source_bytes: 5,
            }))
            .unwrap(),
            relay_control_payload_example("creation_summary")
        );
        assert_eq!(
            serde_json::to_value(ArchiveRelayFailure {
                message: "Archive relay failed",
            })
            .unwrap(),
            relay_control_payload_example("failure")
        );
    }

    #[test]
    fn derives_creation_summary_from_manifest() {
        let manifest = ArchiveCreationManifest::from_entries(vec![
            ArchiveCreationManifestMember {
                archive_path: "docs".to_string(),
                is_directory: true,
                source_size: 0,
                source_modified_at: None,
            },
            ArchiveCreationManifestMember {
                archive_path: "docs/readme.txt".to_string(),
                is_directory: false,
                source_size: 7,
                source_modified_at: None,
            },
        ])
        .expect("manifest entries should be valid");

        let summary = manifest.summary().expect("manifest totals should be representable");

        assert_eq!(summary.files_created, 1);
        assert_eq!(summary.directories_created, 1);
        assert_eq!(summary.source_bytes, 7);
    }

    #[test]
    fn archive_execution_response_emits_contract_progress_counters() {
        let progress = ArchiveSessionProgress::Extraction(LocalArchiveExtractionResult {
            members_processed: 5,
            members_completed: 2,
            members_skipped: 3,
            members_failed: 0,
            files_extracted: 2,
            directories_created: 1,
            extracted_bytes: 12,
            files_replaced: 0,
        });
        let response = archive_execution_response(ArchiveSessionStatus {
            execution_id: "execution-id".to_string(),
            contract_version: ArchiveContractVersion::V2,
            kind: ArchiveSessionKind::Extract,
            phase: ArchiveSessionPhase::Streaming,
            revision: 4,
            cancellation_requested: false,
            progress,
            total_members: Some(6),
            total_bytes: Some(24),
            result: None,
            error: None,
            pending_decision: None,
        });

        let serialized = serde_json::to_value(response).expect("archive execution response should serialize");
        assert_eq!(serialized["contract_version"], "v2");
        assert_eq!(
            serialized["progress"],
            serde_json::json!({
                "completedMembers": 2,
                "skippedMembers": 3,
                "failedMembers": 0,
                "processedBytes": 12,
            })
        );
        assert_eq!(
            serialized["aggregate_counters"],
            serde_json::json!({
                "members_processed": 5,
                "members_completed": 2,
                "members_skipped": 3,
                "members_failed": 0,
                "files_extracted": 2,
                "directories_created": 1,
                "extracted_bytes": 12,
                "files_replaced": 0,
            })
        );
    }

    #[test]
    fn archive_execution_response_serializes_a_paused_member_error() {
        let response = archive_execution_response(ArchiveSessionStatus {
            execution_id: "execution-id".to_string(),
            contract_version: ArchiveContractVersion::V2,
            kind: ArchiveSessionKind::Extract,
            phase: ArchiveSessionPhase::AwaitingUserDecision,
            revision: 4,
            cancellation_requested: false,
            progress: ArchiveSessionProgress::Extraction(LocalArchiveExtractionResult {
                members_processed: 0,
                members_completed: 0,
                members_skipped: 0,
                members_failed: 0,
                files_extracted: 0,
                directories_created: 1,
                extracted_bytes: 0,
                files_replaced: 0,
            }),
            total_members: None,
            total_bytes: None,
            result: None,
            error: None,
            pending_decision: Some(ArchiveSessionPendingDecision {
                source_session_id: "source-session-id".to_string(),
                delivery_sequence: 7,
                decision_revision: 3,
                member_path: "source.txt".to_string(),
                source_size: 0,
                source_modified_at: None,
                target_path: None,
                target_size: None,
                target_modified_at: None,
                is_directory: false,
                member_error: Some(LocalArchiveExtractionMemberError {
                    member_path: "source.txt".to_string(),
                    target_path: "output/source.txt".to_string(),
                    message: "archive member integrity check failed".to_string(),
                    partial_output: true,
                }),
            }),
        });

        let serialized = serde_json::to_value(response).expect("archive execution response should serialize");
        assert_eq!(
            serialized["pendingDecision"],
            serde_json::json!({
                "kind": "member_error",
                "source_session_id": "source-session-id",
                "delivery_sequence": 7,
                "decision_revision": 3,
                "member_path": "source.txt",
                "target_path": "output/source.txt",
                "message": "archive member integrity check failed",
                "partial_output": true,
                "allowed_actions": ["retry", "ignore"],
            })
        );
        assert_eq!(serialized["aggregate_counters"]["directories_created"], 1);
    }

    #[test]
    fn archive_execution_response_serializes_a_pending_directory_collision_decision() {
        let response = archive_execution_response(ArchiveSessionStatus {
            execution_id: "execution-id".to_string(),
            contract_version: ArchiveContractVersion::V2,
            kind: ArchiveSessionKind::Extract,
            phase: ArchiveSessionPhase::AwaitingUserDecision,
            revision: 4,
            cancellation_requested: false,
            progress: ArchiveSessionProgress::Extraction(LocalArchiveExtractionResult::default()),
            total_members: None,
            total_bytes: None,
            result: None,
            error: None,
            pending_decision: Some(ArchiveSessionPendingDecision {
                source_session_id: "source-session-id".to_string(),
                delivery_sequence: 7,
                decision_revision: 3,
                member_path: "source".to_string(),
                source_size: 0,
                source_modified_at: None,
                target_path: Some("renamed".to_string()),
                target_size: None,
                target_modified_at: None,
                is_directory: true,
                member_error: None,
            }),
        });

        let serialized = serde_json::to_value(response).expect("archive execution response should serialize");
        assert_eq!(
            serialized["pendingDecision"],
            serde_json::json!({
                "kind": "collision",
                "source_session_id": "source-session-id",
                "delivery_sequence": 7,
                "decision_revision": 3,
                "member_path": "source",
                "is_directory": true,
                "allowed_actions": ["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"],
                "source": {
                    "path": "source",
                    "size": 0,
                    "modified_at": null,
                },
                "target": {
                    "path": "renamed",
                    "size": null,
                    "modified_at": null,
                },
            })
        );
    }

    #[tokio::test]
    async fn permits_missing_editor_write_targets_but_rejects_directories() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let target = directory.path().join("recreated.md");

        validate_editor_write_target(&target)
            .await
            .expect("a missing editor target should be recreatable");

        tokio::fs::create_dir(&target).await.expect("target directory should be created");
        let response = validate_editor_write_target(&target)
            .await
            .expect_err("an editor write must not replace a directory")
            .into_response();
        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn maps_partial_local_archive_creation_to_a_stable_error_code() {
        let response = map_local_archive_error(LocalArchiveError::PartialArchiveOutput(Box::new(LocalArchiveError::Io(
            std::io::Error::other("source read failed"),
        ))))
        .into_response();

        assert_eq!(response.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body should be readable");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).expect("response body should be JSON"),
            serde_json::json!({
                "detail": "Archive creation failed after creating incomplete output",
                "code": LOCAL_ARCHIVE_CREATION_PARTIAL_CODE,
            })
        );
    }

    #[test]
    fn only_payload_integrity_failures_are_retryable_for_live_extraction() {
        assert!(is_retryable_live_archive_stream_failure(&LocalArchiveError::ArchiveRead(
            LocalArchiveReadError::MemberIntegrityFailure,
        )));
        assert!(!is_retryable_live_archive_stream_failure(&LocalArchiveError::ArchiveSourceChanged));
        assert!(!is_retryable_live_archive_stream_failure(&LocalArchiveError::Io(
            std::io::Error::other("relay body closed",)
        )));
    }

    #[test]
    fn normalizes_windows_extended_paths_for_display() {
        assert_eq!(
            normalize_windows_display_path(r"\\?\C:\Users\Sambee\report.pdf"),
            r"C:\Users\Sambee\report.pdf"
        );
        assert_eq!(
            normalize_windows_display_path(r"\\?\UNC\server\share\report.pdf"),
            r"\\server\share\report.pdf"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_a_broken_symbolic_link_for_activation_error_handling() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let link = directory.path().join("missing-target");
        symlink(directory.path().join("does-not-exist"), &link).expect("symbolic link should be created");
        let mut entries = tokio::fs::read_dir(directory.path()).await.expect("directory should be readable");
        let entry = entries
            .next_entry()
            .await
            .expect("directory entry should be readable")
            .expect("symbolic link should be listed");
        let info = build_file_info(&entry, "")
            .await
            .expect("broken symbolic link should have fallback metadata");

        assert_eq!(info.name, "missing-target");
        assert_eq!(info.file_type, FileType::File);
        assert!(!info.is_readable);
        assert_eq!(info.link_kind, Some(LinkKind::FilesystemLink));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_a_directory_symbolic_link_as_a_directory() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let target = directory.path().join("target-directory");
        let link = directory.path().join("directory-link");
        std::fs::create_dir(&target).expect("target directory should be created");
        symlink(&target, &link).expect("symbolic link should be created");
        let mut entries = tokio::fs::read_dir(directory.path()).await.expect("directory should be readable");
        let entry = loop {
            let entry = entries
                .next_entry()
                .await
                .expect("directory entry should be readable")
                .expect("directory symbolic link should be listed");
            if entry.file_name() == "directory-link" {
                break entry;
            }
        };

        let info = build_file_info(&entry, "")
            .await
            .expect("directory symbolic link should have target metadata");

        assert_eq!(info.name, "directory-link");
        assert_eq!(info.file_type, FileType::Directory);
        assert!(info.is_readable);
        assert_eq!(info.link_kind, Some(LinkKind::FilesystemLink));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserves_symlink_source_identity_for_browse_info() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let target = directory.path().join("target.txt");
        let link = directory.path().join("source-link");
        std::fs::write(&target, "target").expect("temporary file should be written");
        symlink(&target, &link).expect("symbolic link should be created");

        let source_path = resolve_drive_relative_source_path(directory.path(), "", "source-link").expect("source path should be valid");
        let resolved_path = resolve_safe_path(directory.path(), "", "source-link").expect("target should remain in the drive");

        assert_eq!(source_path, link);
        assert_eq!(
            source_link_kind(&source_path).await.expect("source should be readable"),
            Some(LinkKind::FilesystemLink)
        );
        assert_eq!(resolved_path, std::fs::canonicalize(target).expect("target should canonicalize"));
    }

    #[cfg(unix)]
    #[test]
    fn returns_target_path_only_for_an_exposed_drive() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let target = directory.path().join("report.txt");
        let link = directory.path().join("report-link");
        std::fs::write(&target, "report").expect("target file should be created");
        symlink(&target, &link).expect("symbolic link should be created");

        let resolution = resolve_link_target_metadata("report-link".to_string(), link);

        assert_eq!(resolution.source_path, "report-link");
        assert!(matches!(
            resolution.state,
            LinkTargetState::Resolved | LinkTargetState::UnmappedDrive
        ));
        assert_eq!(
            resolution.target,
            Some(crate::server::models::LinkTargetInfo {
                name: "report.txt".to_string(),
                path: if resolution.state == LinkTargetState::Resolved {
                    Some(
                        std::fs::canonicalize(target)
                            .expect("target should canonicalize")
                            .to_string_lossy()
                            .to_string(),
                    )
                } else {
                    None
                },
                target_type: LinkTargetType::File,
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn classifies_non_file_non_directory_targets_as_other() {
        assert_eq!(
            classify_link_target(std::path::Path::new("/dev/null"))
                .await
                .expect("device metadata should be readable"),
            LinkTargetType::Other
        );
    }

    #[test]
    fn normalizes_same_drive_absolute_windows_paths() {
        assert_eq!(normalize_drive_relative_path("d", r"d:\temp").unwrap(), "temp");
        assert_eq!(normalize_drive_relative_path("d", "d:/temp").unwrap(), "temp");
        assert_eq!(normalize_drive_relative_path("d", "d:temp").unwrap(), "temp");
    }

    #[test]
    fn rejects_absolute_paths_for_different_windows_drive() {
        let err = normalize_drive_relative_path("d", r"c:\temp").unwrap_err();
        assert!(format!("{err}").contains("Path targets drive c, not drive d"));
    }

    #[test]
    fn pair_status_reports_pending_local_approval_for_current_origin() {
        let pairing = PairingState::new();
        pairing.initiate(NONCE_A, "https://sambee.example").unwrap();

        let response = build_pair_status_response(&pairing, Some("https://sambee.example"));

        assert_eq!(response.current_origin.as_deref(), Some("https://sambee.example"));
        assert!(!response.current_origin_paired);
        assert_eq!(response.status, PublicPairingStatus::PendingLocalApproval);
    }

    #[test]
    fn resolve_pair_cancel_origin_prefers_header_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("https://sambee.example"));

        let origin = resolve_pair_cancel_origin(&headers, Some("https://fallback.example")).unwrap();

        assert_eq!(origin, "https://sambee.example");
    }

    #[test]
    fn resolve_pair_cancel_origin_falls_back_to_request_body() {
        let headers = HeaderMap::new();

        let origin = resolve_pair_cancel_origin(&headers, Some("https://Sambee.Example:8443")).unwrap();

        assert_eq!(origin, "https://sambee.example:8443");
    }

    #[test]
    fn resolve_pair_confirm_origin_falls_back_to_request_body() {
        let headers = HeaderMap::new();

        let origin = resolve_pair_confirm_origin(&headers, Some("https://fallback.example")).unwrap();

        assert_eq!(origin, "https://fallback.example");
    }

    #[test]
    fn resolve_pair_status_origin_falls_back_to_query_origin() {
        let headers = HeaderMap::new();

        let origin = resolve_pair_status_origin(&headers, Some("https://Sambee.Example")).unwrap();

        assert_eq!(origin, "https://sambee.example");
    }
}
