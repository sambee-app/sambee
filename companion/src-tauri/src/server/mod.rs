//! Local drive HTTP API server.
//!
//! Embeds an axum HTTP server on `127.0.0.1:21549` that enables the Sambee
//! frontend to browse and manage local drives through the same API contract
//! used by the main Python backend for SMB shares.

pub mod archive;
pub mod archive_sessions;
pub mod auth;
pub mod directory_index;
mod directory_manager;
pub mod directory_policy;
mod directory_traversal;
pub mod drives;
pub mod edit_locks;
pub mod errors;
pub mod handlers;
pub mod links;
pub mod localization;
pub mod models;
pub mod pairing;
pub mod target_resolution;
pub mod watcher;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::http::{header, Method};
use axum::Router;
use log::{error, info};
use tauri::{AppHandle, Manager};
use tower_http::cors::{AllowOrigin, CorsLayer};

use self::archive_sessions::ArchiveSessionManager;
use self::auth::AuthState;
use self::directory_manager::LocalDirectoryManager;
use self::edit_locks::EditLockManager;
use self::localization::LocalizationState;
use self::pairing::PairingState;
use self::watcher::DirectoryWatcher;

/// The port the local HTTP server listens on.
pub const SERVER_PORT: u16 = 21549;

pub struct DownloadIntent {
    pub origin: String,
    pub drive: String,
    pub path: String,
    pub member_path: Option<String>,
    pub expires_at: Instant,
}

/// Shared application state accessible from all request handlers.
#[allow(dead_code)]
pub struct AppState {
    pub app: AppHandle,
    pub pairing: Arc<PairingState>,
    pub localization: Arc<LocalizationState>,
    pub auth: AuthState,
    pub archive_sessions: Arc<ArchiveSessionManager>,
    pub edit_locks: Arc<EditLockManager>,
    pub watcher: DirectoryWatcher,
    pub directory_indexes: Arc<LocalDirectoryManager>,
    pub directory_policy: Arc<directory_policy::DirectoryPolicyState>,
}

/// Start the local HTTP API server.
///
/// This spawns the axum server on a background Tokio task. It binds to
/// `127.0.0.1:21549` (localhost only — no remote access).
///
/// Designed to be called from the Tauri `setup()` hook.
pub fn start_server(app: AppHandle, pairing: Arc<PairingState>, localization: Arc<LocalizationState>) {
    tauri::async_runtime::spawn(async {
        if let Err(e) = run_server(app, pairing, localization).await {
            error!("Local API server failed: {e}");
        }
    });
}

async fn run_server(
    app: AppHandle,
    pairing: Arc<PairingState>,
    localization: Arc<LocalizationState>,
) -> Result<(), Box<dyn std::error::Error>> {
    archive::cleanup_stale_temporary_archive_downloads()?;
    let directory_indexes = LocalDirectoryManager::new(app.path().app_cache_dir()?.join("directory-index").join("sqlite"))?;
    let directory_policy =
        directory_policy::DirectoryPolicyState::open(app.path().app_config_dir()?.join("directory-index-policy"), &directory_indexes)
            .map_err(|_| {
                std::io::Error::other("Approved directory policy storage is unavailable. Correct private configuration storage.")
            })?;
    app.manage(Arc::clone(&directory_policy));
    directory_policy
        .protect_storage(directory_indexes.storage_directory())
        .map_err(|_| {
            std::io::Error::other(
                "Approved policy storage cannot be protected. Correct private configuration storage and restart the companion.",
            )
        })?;
    let state = Arc::new(AppState {
        app,
        pairing,
        localization,
        auth: AuthState::new(),
        archive_sessions: Arc::new(ArchiveSessionManager::new()),
        edit_locks: Arc::new(EditLockManager::new()),
        watcher: DirectoryWatcher::new(),
        directory_indexes,
        directory_policy,
    });

    let app = build_router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Local API server listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

/// Build the axum [`Router`] with all routes and middleware.
fn build_router(state: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            origin.to_str().ok().map(auth::is_allowed_browser_origin_for_cors).unwrap_or(false)
        }))
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ORIGIN,
            header::HeaderName::from_static("x-companion-secret"),
            header::HeaderName::from_static("x-companion-timestamp"),
        ]);

    let public_routes = Router::new()
        .route(
            "/api/download-intents/{token}",
            axum::routing::get(handlers::redeem_download_intent),
        )
        .route("/api/health", axum::routing::get(handlers::health))
        .route("/api/pair/status", axum::routing::get(handlers::pair_status))
        .route("/api/pair/initiate", axum::routing::post(handlers::pair_initiate))
        .route("/api/pair/confirm", axum::routing::post(handlers::pair_confirm))
        .route("/api/pair/cancel", axum::routing::post(handlers::pair_cancel));

    let authenticated_routes = Router::new()
        .route("/api/directory-index/policy", axum::routing::get(handlers::directory_policy_status))
        .route(
            "/api/directory-index/policy/challenge",
            axum::routing::post(handlers::directory_policy_challenge),
        )
        .route(
            "/api/directory-index/policy/redeem",
            axum::routing::post(handlers::directory_policy_redeem),
        )
        .route("/api/download-intents", axum::routing::post(handlers::create_download_intent))
        .route("/api/pair/test", axum::routing::post(handlers::test_pairing))
        .route("/api/pair/current", axum::routing::delete(handlers::delete_current_pairing))
        .route("/api/localization", axum::routing::post(handlers::sync_localization))
        .route("/api/drives", axum::routing::get(handlers::list_drives))
        .route("/api/browse/{drive}/list", axum::routing::get(handlers::browse_list))
        .route(
            "/api/browse/{drive}/archive/v2/list",
            axum::routing::get(handlers::browse_list_v2_archive),
        )
        .route(
            "/api/browse/{drive}/link-targets",
            axum::routing::get(handlers::browse_list_link_targets),
        )
        .route("/api/browse/{drive}/info", axum::routing::get(handlers::browse_info))
        .route(
            "/api/browse/{drive}/resolve-activation",
            axum::routing::get(handlers::browse_resolve_activation),
        )
        .route("/api/browse/{drive}/item", axum::routing::delete(handlers::browse_delete))
        .route(
            "/api/browse/{drive}/empty-directory",
            axum::routing::delete(handlers::browse_delete_empty_directory),
        )
        .route("/api/browse/{drive}/rename", axum::routing::post(handlers::browse_rename))
        .route("/api/browse/{drive}/create", axum::routing::post(handlers::browse_create))
        .merge(transfer_routes().with_state::<Arc<AppState>>(()))
        .route("/api/browse/{drive}/open", axum::routing::post(handlers::browse_open))
        .route(
            "/api/browse/{drive}/directories",
            axum::routing::get(handlers::browse_search_directories),
        )
        .route("/api/browse/{drive}/lock", axum::routing::post(handlers::browse_acquire_edit_lock))
        .route(
            "/api/browse/{drive}/lock/heartbeat",
            axum::routing::post(handlers::browse_heartbeat_edit_lock),
        )
        .route(
            "/api/browse/{drive}/lock",
            axum::routing::delete(handlers::browse_release_edit_lock),
        )
        .route(
            "/api/browse/{drive}/lock-status",
            axum::routing::get(handlers::browse_edit_lock_status),
        )
        .route("/api/browse/{drive}/upload", axum::routing::post(handlers::browse_upload))
        .route(
            "/api/browse/{drive}/download-selection",
            axum::routing::post(handlers::browse_download_selection),
        )
        .route(
            "/api/browse/{drive}/archive/download-selection",
            axum::routing::post(handlers::browse_download_zip_selection),
        )
        .route(
            "/api/browse/{drive}/archive/v2/relay/creation",
            axum::routing::post(handlers::browse_relay_v2_archive_creation),
        )
        .route(
            "/api/browse/{drive}/archive/v2/executions",
            axum::routing::post(handlers::browse_start_v2_archive_execution),
        )
        .route(
            "/api/browse/{drive}/archive/v2/executions/{execution_id}",
            axum::routing::get(handlers::browse_get_v2_archive_execution),
        )
        .route(
            "/api/browse/{drive}/archive/v2/executions/{execution_id}/cancellation",
            axum::routing::post(handlers::browse_cancel_v2_archive_execution),
        )
        .route(
            "/api/browse/{drive}/archive/v2/executions/{execution_id}/decision",
            axum::routing::post(handlers::browse_decide_v2_archive_execution),
        )
        .route(
            "/api/browse/{drive}/archive/v2/relay/extraction",
            axum::routing::post(handlers::browse_relay_v2_archive_extraction),
        )
        .route(
            "/api/browse/{drive}/archive/v2/relay/extraction/{operation_id}/decision",
            axum::routing::post(handlers::browse_decide_v2_relay_extraction),
        )
        .route(
            "/api/browse/{drive}/archive/v2/relay/extraction/{operation_id}/status",
            axum::routing::get(handlers::browse_get_v2_relay_extraction_status),
        )
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth::require_auth));

    // Viewer routes support both header-based and query-param auth so that
    // URLs can be used directly in <img src> / <iframe> attributes.
    let viewer_routes = Router::new()
        .route("/api/viewer/{drive}/file", axum::routing::get(handlers::viewer_file))
        .route("/api/viewer/{drive}/download", axum::routing::get(handlers::viewer_download))
        .route(
            "/api/viewer/{drive}/archive/v2/member",
            axum::routing::get(handlers::viewer_v2_archive_member),
        )
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth::require_auth_or_query));

    // WebSocket route — uses query-param auth (browser WS API has no custom headers).
    let ws_routes = Router::new().route("/api/ws", axum::routing::get(handlers::ws_upgrade));

    Router::new()
        .merge(public_routes)
        .merge(authenticated_routes)
        .merge(viewer_routes)
        .merge(ws_routes)
        .layer(cors)
        .with_state(state)
}

fn transfer_routes() -> Router {
    Router::new()
        .route(
            "/api/browse/{drive}/transfer-attempts/{attempt_id}/cancel",
            axum::routing::post(handlers::browse_cancel_transfer_attempt),
        )
        .route("/api/browse/{drive}/copy", axum::routing::post(handlers::browse_copy))
        .route("/api/browse/{drive}/move", axum::routing::post(handlers::browse_move))
        .route(
            "/api/browse/{drive}/transfer-stream",
            axum::routing::post(handlers::browse_stream_transfer),
        )
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    use super::transfer_routes;

    #[tokio::test]
    async fn transfer_stream_route_is_registered() {
        let response = transfer_routes()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/browse/test-drive/transfer-stream?path=target.txt")
                    .body(Body::empty())
                    .expect("request should be valid"),
            )
            .await
            .expect("router should handle the request");

        assert_eq!(response.status(), axum::http::StatusCode::METHOD_NOT_ALLOWED);
    }
}
