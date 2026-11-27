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
pub mod drive_capacity;
pub mod drives;
pub mod edit_locks;
pub mod errors;
mod filesystem_search_admission;
mod filesystem_search_archive;
pub mod filesystem_search_contract;
mod filesystem_search_frontier;
pub mod filesystem_search_matching;
mod filesystem_search_physical;
mod filesystem_search_service;
pub mod handlers;
pub mod links;
pub mod localization;
pub mod models;
pub mod pairing;
#[cfg(feature = "recovery-verification")]
mod recovery_verification;
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
    pub drive_capacity: Arc<drive_capacity::DriveCapacityCoordinator>,
    filesystem_search_admission: filesystem_search_admission::SearchAdmission,
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
    let namespace = app.path().app_cache_dir()?.join("directory-index").join("sqlite");
    #[cfg(feature = "recovery-verification")]
    let namespace = std::env::var_os(recovery_verification::ROOT_ENV)
        .map(|root| std::path::PathBuf::from(root).with_extension("cache"))
        .unwrap_or(namespace);
    let directory_indexes = LocalDirectoryManager::new(namespace)?;
    let policy_namespace = app.path().app_config_dir()?.join("directory-index-policy");
    #[cfg(feature = "recovery-verification")]
    let policy_namespace = std::env::var_os(recovery_verification::ROOT_ENV)
        .map(|root| std::path::PathBuf::from(root).with_extension("policy"))
        .unwrap_or(policy_namespace);
    let directory_policy = directory_policy::DirectoryPolicyState::open(policy_namespace, &directory_indexes)
        .map_err(|_| std::io::Error::other("Approved directory policy storage is unavailable. Correct private configuration storage."))?;
    app.manage(Arc::clone(&directory_policy));
    if let Err(error) = directory_policy.restore_managed(&app, &pairing, &localization) {
        log::warn!("Managed settings could not be restored; local search remains available: {error}");
        if let Err(record_error) = directory_policy.record_settings_error(error.to_string()) {
            log::warn!("Settings recovery failure could not be recorded: {record_error}");
        }
    }
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
        drive_capacity: drive_capacity::DriveCapacityCoordinator::new(),
        filesystem_search_admission: filesystem_search_admission::SearchAdmission::default(),
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
        .route("/api/settings", axum::routing::get(handlers::companion_settings_status))
        .route(
            "/api/settings/challenge",
            axum::routing::post(handlers::companion_settings_challenge),
        )
        .route("/api/settings/redeem", axum::routing::post(handlers::companion_settings_redeem))
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
        .route("/api/drives/capacity", axum::routing::get(handlers::list_drives_capacity))
        .route("/api/browse/{drive}/list", axum::routing::get(handlers::browse_list))
        .merge(filesystem_search_routes())
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
        .merge(delete_routes())
        .route("/api/browse/{drive}/rename", axum::routing::post(handlers::browse_rename))
        .route("/api/browse/{drive}/create", axum::routing::post(handlers::browse_create))
        .merge(transfer_routes())
        .route("/api/browse/{drive}/open", axum::routing::post(handlers::browse_open))
        .route(
            "/api/browse/{drive}/directories",
            axum::routing::get(handlers::browse_search_directories),
        )
        .route(
            "/api/browse/{drive}/directories/status",
            axum::routing::get(handlers::directory_search_status),
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
        .layer(axum::middleware::from_fn_with_state(state.pairing.clone(), auth::require_auth));

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

    let router = Router::new()
        .merge(public_routes)
        .merge(authenticated_routes)
        .merge(viewer_routes)
        .merge(ws_routes)
        .layer(cors)
        .with_state(Arc::clone(&state));
    #[cfg(feature = "recovery-verification")]
    let router = router.merge(recovery_verification::routes().with_state(state));
    router
}

fn filesystem_search_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    filesystem_search_service::SearchState: axum::extract::FromRef<S>,
{
    Router::new().route(
        "/api/browse/{drive}/filesystem-search",
        axum::routing::post(filesystem_search_service::start),
    )
}

fn transfer_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    handlers::DirectoryMutationState: axum::extract::FromRef<S>,
{
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

fn delete_routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    handlers::DirectoryMutationState: axum::extract::FromRef<S>,
{
    Router::new()
        .route("/api/browse/{drive}/item", axum::routing::delete(handlers::browse_delete))
        .route("/api/browse/{drive}/file", axum::routing::delete(handlers::browse_delete_file))
        .route(
            "/api/browse/{drive}/empty-directory",
            axum::routing::delete(handlers::browse_delete_empty_directory),
        )
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        response::Response,
        Router,
    };
    use tower::ServiceExt;

    use super::{delete_routes, errors, transfer_routes};

    fn deletion_fixture() -> (tempfile::TempDir, String, Router) {
        let temporary = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let root = temporary.path().join("drive");
        std::fs::create_dir(&root).unwrap();
        let drive = format!("delete-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(drive.clone(), root);
        let indexes = super::directory_manager::LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let router = delete_routes().with_state(super::handlers::DirectoryMutationState(indexes));
        (temporary, drive, router)
    }

    async fn delete(router: &Router, drive: &str, route: &str, path: &str) -> Response {
        router
            .clone()
            .oneshot(
                Request::delete(format!("/api/browse/{drive}/{route}?path={path}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn assert_delete_error(response: Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["code"], code);
    }

    #[cfg(windows)]
    fn windows_test_symlink_created(result: std::io::Result<()>) -> bool {
        use windows::Win32::Foundation::ERROR_PRIVILEGE_NOT_HELD;

        if result
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD.0 as i32))
        {
            eprintln!("Windows does not permit symbolic link creation. Enable Developer Mode to run this test.");
            return false;
        }
        result.unwrap();
        true
    }

    #[tokio::test]
    async fn delete_routes_remove_files_but_only_item_removes_directories() {
        let (temporary, drive, router) = deletion_fixture();
        let root = temporary.path().join("drive");
        std::fs::create_dir(root.join("tree")).unwrap();
        std::fs::write(root.join("tree/child"), b"keep").unwrap();

        assert_delete_error(
            delete(&router, &drive, "file", "tree").await,
            StatusCode::CONFLICT,
            errors::NOT_A_FILE_CODE,
        )
        .await;
        assert_eq!(std::fs::read(root.join("tree/child")).unwrap(), b"keep");
        for route in ["file", "item"] {
            std::fs::write(root.join("ordinary"), b"remove").unwrap();
            assert_eq!(delete(&router, &drive, route, "ordinary").await.status(), StatusCode::NO_CONTENT);
            assert!(!root.join("ordinary").exists());
            for path in ["", ".", "..", "tree/.", "tree/", "tree/../ordinary"] {
                assert_eq!(
                    delete(&router, &drive, route, path).await.status(),
                    StatusCode::BAD_REQUEST,
                    "{route}: {path}"
                );
            }
        }
        assert_eq!(delete(&router, &drive, "item", "tree").await.status(), StatusCode::NO_CONTENT);
        assert!(!root.join("tree").exists());
    }

    #[tokio::test]
    async fn delete_file_distinguishes_a_missing_entry_from_an_unavailable_location() {
        let (temporary, drive, router) = deletion_fixture();
        let unavailable = format!("unavailable-{}", uuid::Uuid::new_v4());
        super::drives::register_test_drive_path(unavailable.clone(), temporary.path().join("unavailable"));
        let unknown = format!("unknown-{}", uuid::Uuid::new_v4());
        for (drive, path, code) in [
            (&drive, "missing", errors::ITEM_NOT_FOUND_CODE),
            (&drive, "missing/child", errors::FILE_UNAVAILABLE_CODE),
            (&unavailable, "child", errors::FILE_UNAVAILABLE_CODE),
            (&unknown, "child", errors::FILE_UNAVAILABLE_CODE),
        ] {
            assert_delete_error(delete(&router, drive, "file", path).await, StatusCode::NOT_FOUND, code).await;
        }
    }

    #[tokio::test]
    async fn empty_directory_delete_does_not_remove_contents() {
        let (temporary, drive, router) = deletion_fixture();
        let root = temporary.path().join("drive");
        let directory = root.join("directory");
        std::fs::create_dir(&directory).unwrap();
        let child = directory.join("child");
        std::fs::write(&child, b"keep").unwrap();

        let response = delete(&router, &drive, "empty-directory", "directory").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["detail"].as_str().unwrap().starts_with("Directory is not empty:"));
        assert_eq!(std::fs::read(&child).unwrap(), b"keep");
        assert_eq!(
            delete(&router, &drive, "empty-directory", "directory/child").await.status(),
            StatusCode::CONFLICT
        );
        std::fs::remove_file(child).unwrap();
        assert_eq!(
            delete(&router, &drive, "empty-directory", "directory").await.status(),
            StatusCode::NO_CONTENT
        );
        assert!(!directory.exists());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn empty_directory_delete_does_not_follow_links_or_junctions() {
        let (temporary, drive, router) = deletion_fixture();
        let root = temporary.path().join("drive");
        let inside = root.join("inside");
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&inside).unwrap();
        std::fs::create_dir_all(outside.join("empty")).unwrap();

        for (name, target) in [("inside-link", &inside), ("outside-link", &outside)] {
            let link = root.join(name);
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &link).unwrap();
            #[cfg(windows)]
            {
                let result = std::process::Command::new("cmd")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(target)
                    .output()
                    .unwrap();
                assert!(result.status.success(), "Junction creation failed: {result:?}");
            }
            assert_eq!(
                delete(&router, &drive, "empty-directory", name).await.status(),
                StatusCode::CONFLICT
            );
            assert!(std::fs::symlink_metadata(link).is_ok());
        }
        assert!(inside.is_dir());
        assert_eq!(
            delete(&router, &drive, "empty-directory", "outside-link/empty").await.status(),
            StatusCode::FORBIDDEN
        );
        assert!(outside.join("empty").is_dir());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn delete_routes_unlink_file_links_without_removing_the_target() {
        let (temporary, drive, router) = deletion_fixture();
        let root = temporary.path().join("drive");
        let target = root.join("original");
        let link = root.join("link");
        std::fs::write(&target, b"keep").unwrap();

        #[cfg(unix)]
        use std::os::unix::fs::symlink as symlink_file;
        #[cfg(windows)]
        use std::os::windows::fs::symlink_file;

        for route in ["item", "file"] {
            for source in [&target, &root.join("missing")] {
                #[cfg(unix)]
                symlink_file(source, &link).unwrap();
                #[cfg(windows)]
                if !windows_test_symlink_created(symlink_file(source, &link)) {
                    return;
                }
                assert_eq!(delete(&router, &drive, route, "link").await.status(), StatusCode::NO_CONTENT);
                assert_eq!(std::fs::symlink_metadata(&link).unwrap_err().kind(), std::io::ErrorKind::NotFound);
                assert_eq!(std::fs::read(&target).unwrap(), b"keep");
            }
        }
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn delete_routes_do_not_follow_directory_links_or_junctions() {
        let (temporary, drive, router) = deletion_fixture();
        let root = temporary.path().join("drive");
        let outside = temporary.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("child"), b"keep").unwrap();
        let inside = root.join("inside");
        std::fs::create_dir(&inside).unwrap();
        std::fs::write(inside.join("child"), b"keep").unwrap();
        let link = root.join("link");

        #[cfg(unix)]
        let cases = [(&inside, "item"), (&outside, "item"), (&outside, "file")];
        #[cfg(windows)]
        let cases = [(&inside, "item"), (&outside, "item")];

        for (target, route) in cases {
            #[cfg(unix)]
            std::os::unix::fs::symlink(target, &link).unwrap();
            #[cfg(windows)]
            {
                let result = std::process::Command::new("cmd")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(target)
                    .output()
                    .unwrap();
                assert!(result.status.success(), "Junction creation failed: {result:?}");
            }

            if target == &outside {
                assert_delete_error(
                    delete(&router, &drive, "file", "link/child").await,
                    StatusCode::FORBIDDEN,
                    errors::FILE_ACCESS_DENIED_CODE,
                )
                .await;
                assert_eq!(delete(&router, &drive, "item", "link/child").await.status(), StatusCode::FORBIDDEN);
            }

            #[cfg(windows)]
            {
                assert_delete_error(
                    delete(&router, &drive, "file", "link").await,
                    StatusCode::CONFLICT,
                    errors::NOT_A_FILE_CODE,
                )
                .await;
                assert!(std::fs::symlink_metadata(&link).is_ok());
            }
            assert_eq!(delete(&router, &drive, route, "link").await.status(), StatusCode::NO_CONTENT);
            assert_eq!(std::fs::symlink_metadata(&link).unwrap_err().kind(), std::io::ErrorKind::NotFound);
            assert_eq!(std::fs::read(target.join("child")).unwrap(), b"keep");
        }

        #[cfg(windows)]
        if windows_test_symlink_created(std::os::windows::fs::symlink_dir(&inside, &link)) {
            assert_delete_error(
                delete(&router, &drive, "file", "link").await,
                StatusCode::CONFLICT,
                errors::NOT_A_FILE_CODE,
            )
            .await;
            assert_eq!(delete(&router, &drive, "item", "link").await.status(), StatusCode::NO_CONTENT);
            assert_eq!(std::fs::symlink_metadata(&link).unwrap_err().kind(), std::io::ErrorKind::NotFound);
            assert_eq!(std::fs::read(inside.join("child")).unwrap(), b"keep");
        }
    }

    #[tokio::test]
    async fn transfer_stream_route_is_registered() {
        let temporary = tempfile::tempdir().unwrap();
        let indexes = super::directory_manager::LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let response = transfer_routes()
            .with_state(super::handlers::DirectoryMutationState(indexes))
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
