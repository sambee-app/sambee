//! Sambee Companion — Tauri application setup and plugin wiring.
//!
//! Registers all Tauri plugins (deep-link, single-instance, store, shell,
//! http) and sets up the system tray, deep-link handling,
//! and the full edit lifecycle.

mod app_registry;
mod commands;
mod http_client;
mod logging;
mod proxy_auth;
mod server;
mod sync;
mod token;
mod uri;

pub use server::directory_index;

use log::{debug, error, info, warn};
use std::sync::{Arc, RwLock};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconId},
    Emitter, Manager,
};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::http_client::SambeeHttpClientStore;
use crate::server::localization::LocalizationState;
use crate::server::pairing::PairingState;
use crate::sync::operations::{OperationStatus, OperationStore, PendingAppSelections, PendingConfirmations, DEFAULT_MAX_FILE_SIZE_MB};
use crate::uri::{sanitized_uri_for_logging, SambeeUri};

#[derive(Clone, Debug, serde::Serialize)]
pub struct PendingAppPickerRequest {
    pub extension: String,
    pub request_id: String,
    pub force_picker: bool,
}

#[derive(Clone, Default)]
pub struct PendingMainWindowAppPicker(pub Arc<RwLock<Option<PendingAppPickerRequest>>>);

impl PendingMainWindowAppPicker {
    pub fn set(&self, request: PendingAppPickerRequest) {
        if let Ok(mut lock) = self.0.write() {
            *lock = Some(request);
        }
    }

    pub fn get(&self) -> Option<PendingAppPickerRequest> {
        self.0.read().ok().and_then(|lock| lock.clone())
    }

    pub fn take(&self) -> Option<PendingAppPickerRequest> {
        self.0.write().ok().and_then(|mut lock| lock.take())
    }

    pub fn clear(&self) {
        if let Ok(mut lock) = self.0.write() {
            *lock = None;
        }
    }
}

/// ID used for the system tray icon, allowing retrieval via `app.tray_by_id()`.
const TRAY_ICON_ID: &str = "sambee-main";

/// Human-readable name used for the OS autostart entry.
const AUTOSTART_APP_NAME: &str = "Sambee Companion";

/// CLI flag added when the app is launched automatically at sign-in.
const AUTOSTART_LAUNCH_ARG: &str = "--from-autostart";

/// Tray menu item ID for the "Preferences…" item.
const TRAY_MENU_PREFERENCES: &str = "preferences";

/// Tray menu item ID for the "Quit" item.
const TRAY_MENU_QUIT: &str = "quit";

/// Label of the webview window created for the preferences / app-picker UI.
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// Label of the dedicated pairing approval window.
const PAIRING_WINDOW_LABEL: &str = "pairing";

/// Width (logical pixels) of the preferences window.
const PREFERENCES_WIDTH: f64 = 520.0;

/// Height (logical pixels) of the preferences window.
const PREFERENCES_HEIGHT: f64 = 560.0;

/// Width (logical pixels) of the pairing approval window.
const PAIRING_WIDTH: f64 = 460.0;

/// Height (logical pixels) of the pairing approval window.
const PAIRING_HEIGHT: f64 = 500.0;

/// Width (logical pixels) of the app picker window.
pub(crate) const APP_PICKER_WIDTH: f64 = 420.0;

/// Initial height (logical pixels) of the app picker window before the webview resizes it.
pub(crate) const APP_PICKER_INITIAL_HEIGHT: f64 = 320.0;

/// Delay before emitting UI events to a newly-created main window.
pub(crate) const MAIN_WINDOW_CREATED_EVENT_DELAY_MS: u64 = 400;

/// Delay before emitting UI events to an already-open main window.
pub(crate) const MAIN_WINDOW_REUSED_EVENT_DELAY_MS: u64 = 50;

/// Delay before re-asserting focus on the main window.
const MAIN_WINDOW_FOCUS_RETRY_DELAY_MS: u64 = 150;

/// Time to keep the pairing window temporarily above other windows.
const PAIRING_ALWAYS_ON_TOP_MS: u64 = 1500;

/// Delay before hiding the pairing window after success is shown.
const PAIRING_SUCCESS_AUTO_HIDE_DELAY_MS: u64 = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// Theme state — stores the latest theme received from the web app
// ─────────────────────────────────────────────────────────────────────────────

/// Shared state holding the current base64-encoded theme string.
///
/// Updated whenever a deep-link URI contains a `theme` parameter.
/// Emitted to every new window so it can apply the correct CSS variables.
#[derive(Clone, Default)]
pub struct ThemeState(pub Arc<RwLock<Option<String>>>);

impl ThemeState {
    //
    // get
    //
    /// Read the current theme string (base64-encoded JSON).
    pub fn get(&self) -> Option<String> {
        self.0.read().ok().and_then(|g| g.clone())
    }

    //
    // set
    //
    /// Store a new theme and broadcast it to all open webview windows.
    pub fn set(&self, app: &tauri::AppHandle, theme: String) {
        if let Ok(mut lock) = self.0.write() {
            *lock = Some(theme.clone());
        }
        // Broadcast to all windows so every UI surface picks up the new theme
        let _ = app.emit("apply-theme", &theme);
        info!("Theme updated and broadcast to all windows");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-link handler
// ─────────────────────────────────────────────────────────────────────────────

//
// handle_deep_links
//
/// Process one or more `sambee://` URIs received via deep-link.
///
/// Called both on cold start (if the app was launched via a URI) and when a
/// running instance receives a forwarded URI from the single-instance plugin.
fn handle_deep_links(app: &tauri::AppHandle, urls: Vec<url::Url>) {
    for raw_url in urls {
        info!("Received deep-link URI: {}", crate::uri::sanitized_uri_for_logging(&raw_url));

        match SambeeUri::parse(&raw_url) {
            Ok(parsed) => {
                info!(
                    "Parsed URI: server={}, conn_id={}, path={}",
                    parsed.server, parsed.conn_id, parsed.path
                );

                // Apply theme from the URI if present
                if let Some(ref theme_b64) = parsed.theme {
                    if let Some(theme_state) = app.try_state::<ThemeState>() {
                        theme_state.set(app, theme_b64.clone());
                    }
                }

                // Kick off the full edit lifecycle asynchronously
                let app_handle = app.clone();
                let launch_server = parsed.server.clone();
                tauri::async_runtime::spawn(async move {
                    let notification_handle = app_handle.clone();
                    if let Err(e) = start_edit_lifecycle(app_handle, parsed).await {
                        error!("Edit lifecycle failed: {e}");
                        if let Some(status) = e.browser_status {
                            let _ = commands::open_file::open_sambee_status_page(
                                notification_handle.clone(),
                                launch_server,
                                status.to_string(),
                            );
                        }
                        let _ = notification_handle.emit("notification", serde_json::json!({ "message": e.to_string() }));
                    }
                });
            }
            Err(e) => {
                warn!("Ignoring invalid deep-link URI: {e}");
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit lifecycle
// ─────────────────────────────────────────────────────────────────────────────

//
// start_edit_lifecycle
//
/// Orchestrate the full edit lifecycle for a single file.
///
/// 1. Exchange URI token → session JWT
///    1.5 Fetch file info (for size check + conflict baseline)
/// 2. Acquire edit lock
/// 3. Download file to temp
/// 4. Show app picker (emit event to main window)
/// 5. Open file in native app
/// 6. Spawn "Done Editing" window
/// 7. Start file status polling + heartbeat
#[derive(Debug, Clone)]
struct StartEditLifecycleError {
    message: String,
    browser_status: Option<&'static str>,
}

impl StartEditLifecycleError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            browser_status: None,
        }
    }

    fn auth_failed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            browser_status: Some("auth_failed"),
        }
    }
}

impl std::fmt::Display for StartEditLifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<String> for StartEditLifecycleError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

fn classify_startup_token_exchange_error(error: token::TokenExchangeError) -> StartEditLifecycleError {
    match error {
        token::TokenExchangeError::ProxyAuthenticationRequired { message, .. } => StartEditLifecycleError::auth_failed(message),
        token::TokenExchangeError::HttpStatus {
            status: 401 | 403 | 407,
            message,
            ..
        } => StartEditLifecycleError::auth_failed(message),
        other => StartEditLifecycleError::new(other.to_string()),
    }
}

fn classify_startup_proxy_auth_error(error: proxy_auth::ProxyAuthRetryError) -> StartEditLifecycleError {
    match error {
        proxy_auth::ProxyAuthRetryError::Operation(message) => StartEditLifecycleError::new(message),
        proxy_auth::ProxyAuthRetryError::Authentication(message) => StartEditLifecycleError::auth_failed(message),
        proxy_auth::ProxyAuthRetryError::StillBlockedAfterReauth { .. } => StartEditLifecycleError::auth_failed(error.to_string()),
    }
}

async fn start_edit_lifecycle(app: tauri::AppHandle, uri: SambeeUri) -> Result<(), StartEditLifecycleError> {
    let http_clients = app
        .try_state::<SambeeHttpClientStore>()
        .ok_or_else(|| "HTTP client store not available".to_string())?
        .inner()
        .clone();

    // 1. Exchange URI token for session JWT
    info!("Step 1: Exchanging URI token...");
    let session_token = match token::exchange_uri_token_with_store(&uri.server, &uri.token, &http_clients).await {
        Ok(token) => token,
        Err(token::TokenExchangeError::ProxyAuthenticationRequired { message, .. }) => {
            warn!("{message}");
            proxy_auth::authenticate_reverse_proxy(&app, &uri.server, &http_clients)
                .await
                .map_err(StartEditLifecycleError::auth_failed)?;
            match token::exchange_uri_token_with_store(&uri.server, &uri.token, &http_clients).await {
                Ok(token) => token,
                Err(token::TokenExchangeError::ProxyAuthenticationRequired { .. }) => {
                    return Err(StartEditLifecycleError::auth_failed(
                        "Authentication completed, but no usable backend cookie was available for Companion requests. Check the reverse proxy cookie domain and path settings."
                            .to_string(),
                    ));
                }
                Err(e) => return Err(classify_startup_token_exchange_error(e)),
            }
        }
        Err(e) => return Err(classify_startup_token_exchange_error(e)),
    };

    // 1.5. Fetch file info for size check and conflict detection baseline
    info!("Step 1.5: Fetching file info...");
    let file_info = proxy_auth::retry_if_proxy_auth_required(&app, &uri.server, &http_clients, "File metadata lookup", || async {
        commands::file_info::get_file_info_with_store(&http_clients, &uri.server, &uri.conn_id, &uri.path, None, Some(&session_token)).await
    })
    .await;

    match &file_info {
        Ok(info) => debug!(
            "Step 1.5 completed successfully: name='{}', file_type='{}', size={:?}, modified_at={:?}, mime_type={:?}",
            info.name, info.file_type, info.size, info.modified_at, info.mime_type
        ),
        Err(err) => debug!(
            "Step 1.5 completed with error: {}; should_abort_safety_check={}",
            err,
            err.should_abort_safety_check()
        ),
    }

    if let Err(ref err) = file_info {
        if err.should_abort_safety_check() {
            return Err(classify_startup_proxy_auth_error(err.clone()));
        }

        debug!("Continuing without file metadata because the lookup error is non-fatal");
    }

    // Store server-side modified_at for later conflict detection
    let server_last_modified = file_info.as_ref().ok().and_then(|info| info.modified_at.clone());
    debug!("Conflict baseline after Step 1.5: server_last_modified={:?}", server_last_modified);

    // Check file size against threshold
    if let Ok(ref info) = file_info {
        if let Some(size_bytes) = info.size {
            debug!(
                "Evaluating large-file gate: size_bytes={}, limit_mb={}",
                size_bytes, DEFAULT_MAX_FILE_SIZE_MB
            );

            if let Some(size_mb) = sync::operations::exceeds_size_limit(size_bytes, DEFAULT_MAX_FILE_SIZE_MB) {
                info!(
                    "File {} is {} MB (limit {} MB) — requesting confirmation",
                    info.name, size_mb, DEFAULT_MAX_FILE_SIZE_MB
                );

                let confirm_id = uuid::Uuid::new_v4().to_string();
                let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

                // Register the pending confirmation
                if let Some(pending) = app.try_state::<PendingConfirmations>() {
                    pending.insert(confirm_id.clone(), tx);
                }

                // Emit event to frontend for user confirmation
                match app.emit(
                    "confirm-large-file",
                    serde_json::json!({
                        "confirm_id": confirm_id,
                        "filename": info.name,
                        "size_mb": size_mb,
                        "limit_mb": DEFAULT_MAX_FILE_SIZE_MB,
                    }),
                ) {
                    Ok(()) => debug!("Large-file confirmation event emitted successfully"),
                    Err(e) => warn!("Failed to emit large-file confirmation event: {e}"),
                }

                // Wait for user response (blocks lifecycle until dialog answered)
                debug!("Waiting for large-file confirmation response: confirm_id={confirm_id}");
                let proceed = match rx.await {
                    Ok(proceed) => {
                        debug!("Large-file confirmation resolved: confirm_id={}, proceed={}", confirm_id, proceed);
                        proceed
                    }
                    Err(e) => {
                        warn!(
                            "Large-file confirmation channel closed before a response was received for {}: {e}",
                            confirm_id
                        );
                        false
                    }
                };
                if !proceed {
                    info!("User cancelled large file download for {}", info.name);
                    return Ok(());
                }
                info!("User confirmed large file download for {}", info.name);
            } else {
                debug!(
                    "Large-file gate not triggered: size_bytes={} is within the {} MB limit",
                    size_bytes, DEFAULT_MAX_FILE_SIZE_MB
                );
            }
        } else {
            debug!("File info returned no size; skipping large-file gate");
        }
    } else {
        debug!("Skipping large-file gate because file metadata is unavailable");
    }

    // 2. Acquire edit lock
    info!("Step 2: Acquiring edit lock...");
    debug!("Proceeding from Step 1.5 to Step 2");
    let lock_context = match proxy_auth::retry_if_proxy_auth_required(&app, &uri.server, &http_clients, "Edit lock acquisition", || async {
        commands::upload::acquire_lock_with_store(&http_clients, &uri.server, &uri.conn_id, &uri.path, &session_token).await
    })
    .await
    {
        Ok(lock_context) => {
            debug!(
                "Step 2 completed successfully: lock_id={}, server_operation_id={}",
                lock_context.lock_id, lock_context.operation_id
            );
            lock_context
        }
        Err(err) => {
            warn!("Step 2 failed during lock acquisition: {err}");
            return Err(classify_startup_proxy_auth_error(err));
        }
    };

    // 3. Download file to local temp
    info!("Step 3: Downloading file...");
    let expected_download_size = file_info.as_ref().ok().and_then(|info| info.size);
    debug!("Starting Step 3 with expected_download_size={expected_download_size:?}");
    let download_result = proxy_auth::retry_if_proxy_auth_required(&app, &uri.server, &http_clients, "File download", || async {
        commands::download::download_file_with_store(
            &http_clients,
            &uri.server,
            &uri.conn_id,
            &uri.path,
            &lock_context,
            expected_download_size,
        )
        .await
    })
    .await
    .inspect_err(|_e| {
        // Release lock on download failure (best-effort)
        let srv = uri.server.clone();
        let cid = uri.conn_id.clone();
        let p = uri.path.clone();
        let held_lock_context = lock_context.clone();
        let clients = http_clients.clone();
        tauri::async_runtime::spawn(async move {
            let _ = commands::upload::release_lock_with_store(&clients, &srv, &cid, &p, &held_lock_context).await;
        });
    })
    .map_err(classify_startup_proxy_auth_error)?;

    debug!(
        "Step 3 completed successfully: operation_id={}, local_path='{}', original_mtime={:?}",
        download_result.operation_id,
        download_result.local_path.display(),
        download_result.original_mtime
    );

    // 4. Create FileOperation and persist
    let operation = sync::operations::FileOperation {
        id: download_result.operation_id,
        server_url: uri.server.clone(),
        connection_id: uri.conn_id.clone(),
        remote_path: uri.path.clone(),
        local_path: download_result.local_path.clone(),
        downloaded_at: std::time::SystemTime::now(),
        original_mtime: download_result.original_mtime,
        status: OperationStatus::Editing,
        opened_with_app: None,
        lock_context: Some(lock_context.clone()),
        server_last_modified,
    };

    // Persist sidecar
    if let Err(e) = sync::operations::save_operation_sidecar(&operation) {
        warn!("Failed to persist operation sidecar: {e}");
    }

    // Add to in-memory store
    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;
    store.add(operation.clone());

    // Refresh tray menu to show the new operation
    refresh_tray_menu(&app);

    // 5. Show app picker, then open file in the selected native app
    info!("Step 5: Showing app picker...");

    // Extract file extension from the remote path (without leading dot)
    let file_extension = std::path::Path::new(&uri.path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_string();

    let selection = match commands::open_file::prompt_for_app_selection(&app, &file_extension, uri.force_picker).await {
        Ok(selection) => selection,
        Err(e) => {
            let _ = commands::upload::release_lock_with_store(&http_clients, &uri.server, &uri.conn_id, &uri.path, &lock_context).await;
            let _ = sync::recycle::recycle_file(&download_result.local_path);
            store.remove(operation.id);
            refresh_tray_menu(&app);
            if let Err(sidecar_err) = sync::operations::remove_operation_sidecar(&operation) {
                warn!("Failed to remove sidecar after app picker failure: {sidecar_err}");
            }
            return Err(e.into());
        }
    };

    let (app_executable, app_handler_id, app_display_name) = match selection {
        Some(selected) => {
            info!(
                "User selected app: {} ({}) handler={:?}",
                selected.name, selected.executable, selected.handler_id
            );
            (selected.executable, selected.handler_id, selected.name)
        }
        None => {
            // User cancelled — release lock and clean up
            info!("User cancelled app picker — aborting edit lifecycle");
            let _ = commands::upload::release_lock_with_store(&http_clients, &uri.server, &uri.conn_id, &uri.path, &lock_context).await;
            store.remove(operation.id);
            refresh_tray_menu(&app);
            if let Err(e) = sync::operations::remove_operation_sidecar(&operation) {
                warn!("Failed to remove sidecar after cancel: {e}");
            }
            return Ok(());
        }
    };

    info!("Step 5b: Opening file in {}...", app_display_name);
    if let Err(e) =
        commands::open_file::open_in_native_app(&app, &download_result.local_path, &app_executable, app_handler_id.as_deref()).await
    {
        let _ = commands::upload::release_lock_with_store(&http_clients, &uri.server, &uri.conn_id, &uri.path, &lock_context).await;
        let _ = sync::recycle::recycle_file(&download_result.local_path);
        store.remove(operation.id);
        refresh_tray_menu(&app);
        if let Err(sidecar_err) = sync::operations::remove_operation_sidecar(&operation) {
            warn!("Failed to remove sidecar after open failure: {sidecar_err}");
        }
        return Err(e.into());
    }

    // Update the operation with the selected app
    store.update_app(&operation.id, &app_display_name);

    // 6. Spawn Done Editing window
    info!("Step 6: Spawning Done Editing window...");
    let window_label = commands::open_file::spawn_done_editing_window(&app, &operation, &app_display_name)?;

    // Send the current theme to the new Done Editing window
    if let Some(theme_state) = app.try_state::<ThemeState>() {
        if let Some(theme_b64) = theme_state.get() {
            let wl = window_label.clone();
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                let _ = app2.emit_to(&wl, "apply-theme", &theme_b64);
            });
        }
    }

    // 7. Start background tasks
    info!("Step 7: Starting file polling and heartbeat...");
    commands::open_file::start_file_status_polling(
        &app,
        window_label.clone(),
        download_result.local_path,
        download_result.original_mtime,
    );

    commands::open_file::start_heartbeat_task(&app, window_label, operation.id, uri.server, uri.conn_id, uri.path, lock_context);

    info!("Edit lifecycle started successfully for operation {}", operation.id);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// System tray
// ─────────────────────────────────────────────────────────────────────────────

//
// setup_system_tray
//
/// Build the system tray icon with a context menu.
///
/// Assigns the tray ID [`TRAY_ICON_ID`] so it can be retrieved later
/// via `app.tray_by_id()` for dynamic menu rebuilds.
fn setup_system_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let prefs = MenuItem::with_id(app, TRAY_MENU_PREFERENCES, "Preferences…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT, "Quit Sambee Companion", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&prefs, &quit])?;

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(
            app.default_window_icon()
                .cloned()
                .unwrap_or_else(|| tauri::image::Image::new(&[], 0, 0)),
        )
        .tooltip("Sambee Companion")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id() == TRAY_MENU_QUIT {
                info!("Quit requested from system tray");
                app.exit(0);
            } else if event.id() == TRAY_MENU_PREFERENCES {
                info!("Preferences requested from system tray");
                show_preferences_window(app);
            }
        })
        .build(app)?;

    Ok(())
}

//
// ensure_main_window
//
/// Ensure the main webview window exists, creating it if needed.
///
/// Returns `true` if the window was newly created (caller should delay
/// event emission to let the webview initialize), `false` if it already
/// existed.
pub(crate) fn ensure_main_window(app: &tauri::AppHandle, title: &str, width: f64, height: f64) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = win.set_title(title);
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
        let _ = win.set_resizable(false);
        let _ = win.set_maximizable(false);
        let _ = win.set_minimizable(false);
        let _ = win.set_closable(true);
        let _ = win.set_decorations(true);
        let _ = win.set_always_on_top(true);
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(false);
    }

    tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, tauri::WebviewUrl::App("/".into()))
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(true)
        .fullscreen(false)
        .decorations(true)
        .always_on_top(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to create main window: {e}"))?;

    Ok(true)
}

//
// show_preferences_window
//
/// Create (or focus) the main webview window and emit "show-preferences"
/// so the Preact frontend switches to the Preferences view.
pub(crate) fn show_preferences_window(app: &tauri::AppHandle) {
    // Re-use the existing main window if it is already open
    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = win.set_resizable(false);
        let _ = win.set_maximizable(false);
        let _ = win.set_minimizable(true);
        let _ = win.set_closable(true);
        let _ = win.set_decorations(true);
        let _ = win.set_always_on_top(false);
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: PREFERENCES_WIDTH,
            height: PREFERENCES_HEIGHT,
        }));
        let _ = win.set_title("Sambee Companion \u{2014} Preferences");
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit_to(MAIN_WINDOW_LABEL, "show-preferences", ());
        return;
    }

    // Create a new window for the preferences panel
    match tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, tauri::WebviewUrl::App("/".into()))
        .title("Sambee Companion — Preferences")
        .inner_size(PREFERENCES_WIDTH, PREFERENCES_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(true)
        .closable(true)
        .fullscreen(false)
        .center()
        .build()
    {
        Ok(_win) => {
            // Emit after a short delay so the webview is ready to receive events
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, "show-preferences", ());

                // Also send the current theme
                if let Some(theme_state) = app_handle.try_state::<ThemeState>() {
                    if let Some(theme) = theme_state.get() {
                        let _ = app_handle.emit_to(MAIN_WINDOW_LABEL, "apply-theme", &theme);
                    }
                }
            });
        }
        Err(e) => {
            error!("Failed to create preferences window: {e}");
        }
    }
}

/// Create (or focus) the dedicated pairing window and emit `show-pairing`
/// so the pairing UI displays the current approval request.
pub(crate) fn show_pairing_window(app: &tauri::AppHandle, pairing_id: &str, origin: &str, pairing_code: &str) {
    let newly_created = if let Some(win) = app.get_webview_window(PAIRING_WINDOW_LABEL) {
        let _ = win.set_decorations(true);
        let _ = win.set_always_on_top(true);
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: PAIRING_WIDTH,
            height: PAIRING_HEIGHT,
        }));
        let _ = win.set_title("Sambee Companion — Pairing Request");
        let _ = win.center();
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        false
    } else {
        match tauri::WebviewWindowBuilder::new(app, PAIRING_WINDOW_LABEL, tauri::WebviewUrl::App("/pairing".into()))
            .title("Sambee Companion — Pairing Request")
            .inner_size(PAIRING_WIDTH, PAIRING_HEIGHT)
            .resizable(false)
            .maximizable(false)
            .fullscreen(false)
            .always_on_top(true)
            .center()
            .focused(true)
            .build()
        {
            Ok(_) => true,
            Err(e) => {
                error!("Failed to create pairing window: {e}");
                return;
            }
        }
    };

    let delay_ms = if newly_created {
        MAIN_WINDOW_CREATED_EVENT_DELAY_MS
    } else {
        MAIN_WINDOW_REUSED_EVENT_DELAY_MS
    };

    let app_handle = app.clone();
    let pairing_id = pairing_id.to_string();
    let origin = origin.to_string();
    let pairing_code = pairing_code.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        if let Some(win) = app_handle.get_webview_window(PAIRING_WINDOW_LABEL) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();

            tokio::time::sleep(std::time::Duration::from_millis(MAIN_WINDOW_FOCUS_RETRY_DELAY_MS)).await;
            let _ = win.set_focus();

            let _ = app_handle.emit_to(
                PAIRING_WINDOW_LABEL,
                "show-pairing",
                serde_json::json!({
                    "pairing_id": pairing_id,
                    "origin": origin,
                    "pairing_code": pairing_code,
                }),
            );

            if let Some(theme_state) = app_handle.try_state::<ThemeState>() {
                if let Some(theme) = theme_state.get() {
                    let _ = app_handle.emit_to(PAIRING_WINDOW_LABEL, "apply-theme", &theme);
                }
            }

            tokio::time::sleep(std::time::Duration::from_millis(PAIRING_ALWAYS_ON_TOP_MS)).await;
            let _ = win.set_always_on_top(false);
        }
    });
}

/// Notify the dedicated pairing window that the current pairing completed.
pub(crate) fn show_pairing_success(app: &tauri::AppHandle) {
    let _ = app.emit_to(PAIRING_WINDOW_LABEL, "pairing-completed", ());

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(PAIRING_SUCCESS_AUTO_HIDE_DELAY_MS)).await;

        if let Some(win) = app_handle.get_webview_window(PAIRING_WINDOW_LABEL) {
            let _ = win.hide();
        }
    });
}

//
// refresh_tray_menu
//
/// Rebuild the system tray context menu to reflect active operations.
///
/// Displays one menu item per active file (status + filename), plus
/// a separator and the "Quit" item at the bottom.
pub(crate) fn refresh_tray_menu(app: &tauri::AppHandle) {
    let tray = match app.tray_by_id(&TrayIconId::new(TRAY_ICON_ID)) {
        Some(t) => t,
        None => {
            warn!("Cannot refresh tray menu: tray not found");
            return;
        }
    };

    let store = match app.try_state::<OperationStore>() {
        Some(s) => s,
        None => return,
    };

    let active = store.active_operations();

    // Build menu items.  We silently skip any items that fail to construct.
    let mut items: Vec<MenuItem<tauri::Wry>> = Vec::new();

    if active.is_empty() {
        if let Ok(item) = MenuItem::with_id(app, "no-ops", "No active operations", false, None::<&str>) {
            items.push(item);
        }
    } else {
        for op in &active {
            let label = match &op.status {
                OperationStatus::Editing => format!("Editing: {}", op.filename()),
                OperationStatus::Uploading(pct) => {
                    format!("Uploading ({:.0}%): {}", pct * 100.0, op.filename())
                }
                OperationStatus::UploadFailed(_) => {
                    format!("Upload failed: {}", op.filename())
                }
                OperationStatus::Downloading => format!("Downloading: {}", op.filename()),
                _ => op.filename().to_string(),
            };

            // Use the operation id as the menu item id (display-only, no action)
            if let Ok(item) = MenuItem::with_id(app, op.id.to_string(), &label, false, None::<&str>) {
                items.push(item);
            }
        }
    }

    // Build the final menu with Preferences + Quit at the end
    if let Ok(prefs) = MenuItem::with_id(app, TRAY_MENU_PREFERENCES, "Preferences…", true, None::<&str>) {
        items.push(prefs);
    }
    if let Ok(quit) = MenuItem::with_id(app, TRAY_MENU_QUIT, "Quit Sambee Companion", true, None::<&str>) {
        items.push(quit);
    }

    // Collect references for Menu::with_items
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();

    match Menu::with_items(app, &refs) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                warn!("Failed to update tray menu: {e}");
            }
        }
        Err(e) => warn!("Failed to build tray menu: {e}"),
    }
}

//
// emit_leftover_operations
//
/// Load sidecars for leftover operations and emit a "leftover-operations"
/// event to the main window so the frontend can show recovery dialogs.
fn emit_leftover_operations(app: &tauri::AppHandle, leftovers: Vec<(std::path::PathBuf, std::path::PathBuf)>) {
    let mut infos: Vec<commands::open_file::LeftoverInfo> = Vec::new();

    for (op_dir, sidecar_path) in &leftovers {
        match sync::operations::load_operation_sidecar(sidecar_path) {
            Ok(op) => {
                // Get local file's last modified time for display
                let local_modified = op
                    .local_path
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(format_system_time_iso)
                    .unwrap_or_else(|| "unknown".to_string());

                infos.push(commands::open_file::LeftoverInfo {
                    operation_dir: op_dir.to_string_lossy().to_string(),
                    filename: op.filename().to_string(),
                    server_url: op.server_url.clone(),
                    remote_path: op.remote_path.clone(),
                    connection_id: op.connection_id.clone(),
                    local_modified,
                });
            }
            Err(e) => {
                warn!("Failed to load sidecar {}: {e}", sidecar_path.display());
            }
        }
    }

    if !infos.is_empty() {
        info!("Emitting {} leftover operation(s) to frontend", infos.len());
        let _ = app.emit("leftover-operations", &infos);
    }
}

//
// format_system_time_iso
//
/// Format a `SystemTime` as an ISO 8601-ish string (UTC).
fn format_system_time_iso(time: std::time::SystemTime) -> String {
    let secs = time.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();

    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Approximate date from epoch days (good enough for display)
    let (year, month, day) = epoch_days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

//
// epoch_days_to_ymd
//
/// Convert days since Unix epoch to (year, month, day).
///
/// Uses a simplified civil calendar algorithm. Accurate for dates
/// well past 2100.
fn epoch_days_to_ymd(epoch_days: u64) -> (u64, u64, u64) {
    // Algorithm from Howard Hinnant's chrono-compatible date library
    let z = epoch_days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

fn should_prevent_implicit_last_window_exit(exit_code: Option<i32>) -> bool {
    exit_code.is_none()
}

fn format_argv_for_logging(argv: &[String]) -> String {
    let sanitized = argv
        .iter()
        .map(|arg| match url::Url::parse(arg) {
            Ok(url) if url.scheme() == "sambee" => sanitized_uri_for_logging(&url),
            _ => arg.clone(),
        })
        .collect::<Vec<_>>();

    format!("{sanitized:?}")
}

// ─────────────────────────────────────────────────────────────────────────────
// App builder
// ─────────────────────────────────────────────────────────────────────────────

//
// run
//
/// Build and launch the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(e) = logging::init() {
        eprintln!("Warning: file logging unavailable ({e}), falling back to stderr");
        env_logger::init();
    }

    let mut builder = tauri::Builder::default();

    // Single-instance plugin must be registered first (with deep-link forwarding)
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            info!("Single-instance: re-opened with argv={}", format_argv_for_logging(&argv));

            // argv[1..] may contain deep-link URIs forwarded from the new instance
            let urls: Vec<url::Url> = argv
                .iter()
                .skip(1)
                .filter_map(|arg| url::Url::parse(arg).ok())
                .filter(|u| u.scheme() == "sambee")
                .collect();

            if !urls.is_empty() {
                handle_deep_links(app, urls);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name(AUTOSTART_APP_NAME)
                .args([AUTOSTART_LAUNCH_ARG])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(OperationStore::new())
        .manage(ThemeState::default())
        .manage(PendingConfirmations::default())
        .manage(PendingAppSelections::default())
        .manage(PendingMainWindowAppPicker::default())
        .manage(SambeeHttpClientStore::default())
        .manage(Arc::new(PairingState::new()))
        .manage(Arc::new(LocalizationState::new()))
        .invoke_handler(tauri::generate_handler![
            server::directory_policy::get_native_directory_policy_status,
            server::directory_policy::reset_native_directory_policy_owner,
            commands::app_picker::get_apps_for_file,
            commands::app_picker::consume_pending_app_picker,
            commands::localization::get_synced_localization,
            commands::open_file::get_done_editing_context,
            commands::open_file::open_sambee_status_page,
            commands::open_file::finish_editing,
            commands::open_file::discard_editing,
            commands::open_file::resolve_conflict_overwrite,
            commands::open_file::resolve_conflict_save_copy,
            commands::open_file::confirm_large_download,
            commands::open_file::respond_app_selection,
            commands::open_file::recovery_upload,
            commands::open_file::recovery_discard,
            commands::open_file::recovery_dismiss,
            commands::open_file::has_active_operations,
            commands::pairing::confirm_pending_pairing,
            commands::pairing::reject_pending_pairing,
            commands::pairing::get_paired_origins,
            commands::pairing::unpair_origin,
            commands::update::check_for_companion_update,
            commands::update::install_companion_update,
            commands::window::hide_window,
            logging::log_from_frontend,
        ])
        .setup(|app| {
            // Register deep-link scheme at runtime (Linux + Windows dev mode)
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                app.deep_link().register_all()?;
            }

            // Set up system tray
            if let Err(e) = setup_system_tray(app) {
                error!("Failed to set up system tray: {e}");
            }

            // Run recycle bin cleanup on startup
            let cleaned = sync::recycle::cleanup_expired();
            if cleaned > 0 {
                info!("Startup: cleaned {cleaned} expired recycled file(s)");
            }

            // Scan for leftover operations from previous sessions
            let leftovers = sync::temp::scan_leftover_operations();
            if !leftovers.is_empty() {
                info!("Startup: found {} leftover operation(s) from previous sessions", leftovers.len());
                // Emit recovery info to the main window after a short delay
                // (window must be ready to receive events)
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                    emit_leftover_operations(&app_handle, leftovers);
                });
            }

            // Start the local companion HTTP server with shared pairing state
            let pairing_state = app.state::<Arc<PairingState>>().inner().clone();
            let localization_state = app.state::<Arc<LocalizationState>>().inner().clone();
            pairing_state.load_from_keychain();
            localization_state.load_from_disk(app.handle());
            server::start_server(app.handle().clone(), pairing_state, localization_state);

            // Process deep-link if app was cold-started via a URI
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_deep_links(app.handle(), urls);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Intercept close on companion UI windows: hide instead of quitting
            // so the tray app keeps running and windows can be reused.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW_LABEL {
                    api.prevent_close();

                    if let Some(pending_picker) = window
                        .app_handle()
                        .try_state::<PendingMainWindowAppPicker>()
                        .and_then(|state| state.get())
                    {
                        if let Some(pending) = window.app_handle().try_state::<PendingAppSelections>() {
                            if pending.respond(&pending_picker.request_id, None) {
                                info!(
                                    "App picker close intercepted — cancelled pending request {}",
                                    pending_picker.request_id
                                );
                            } else {
                                warn!(
                                    "App picker close intercepted but no pending selection found for {}",
                                    pending_picker.request_id
                                );
                            }
                        }

                        if let Some(state) = window.app_handle().try_state::<PendingMainWindowAppPicker>() {
                            state.clear();
                        }
                    }

                    let _ = window.hide();
                    info!("Companion window '{}' close intercepted — hidden to tray", window.label());
                } else if window.label() == PAIRING_WINDOW_LABEL {
                    api.prevent_close();
                    let _ = window.hide();
                    info!("Companion window '{}' close intercepted — hidden to tray", window.label());
                } else if commands::open_file::is_done_editing_window_label(window.label()) {
                    api.prevent_close();
                    info!(
                        "Done Editing window '{}' close intercepted — waiting for explicit action",
                        window.label()
                    );
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Sambee Companion")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if should_prevent_implicit_last_window_exit(code) {
                    info!("Preventing implicit app exit after the last window was destroyed");
                    api.prevent_exit();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevents_exit_when_last_window_is_destroyed() {
        assert!(should_prevent_implicit_last_window_exit(None));
    }

    #[test]
    fn allows_explicit_exit_requests() {
        assert!(!should_prevent_implicit_last_window_exit(Some(0)));
    }

    #[test]
    fn redacts_single_instance_sambee_uri_args() {
        let argv = vec![
            "C:\\Program Files\\Sambee Companion\\sambee-companion.exe".to_string(),
            "sambee://open/?server=https%3A%2F%2Fsambee.example.com&token=secret&connId=abc&path=%2Fdocs%2Ffile.pdf&theme=encoded"
                .to_string(),
        ];

        let formatted = format_argv_for_logging(&argv);

        assert!(formatted.contains("token=%3Credacted%3E"));
        assert!(formatted.contains("theme=%3Cpresent%3E"));
        assert!(!formatted.contains("token=secret"));
        assert!(!formatted.contains("theme=encoded"));
        assert!(formatted.contains("sambee-companion.exe"));
    }

    #[test]
    fn keeps_non_uri_single_instance_args_readable() {
        let argv = vec!["sambee-companion.exe".to_string(), "--from-autostart".to_string()];

        assert_eq!(format_argv_for_logging(&argv), "[\"sambee-companion.exe\", \"--from-autostart\"]");
    }

    #[test]
    fn classifies_token_exchange_unauthorized_as_auth_failed() {
        let error = classify_startup_token_exchange_error(token::TokenExchangeError::HttpStatus {
            status: 401,
            body_preview: "Invalid or expired URI token".to_string(),
            message: "Token exchange failed (HTTP 401): Invalid or expired URI token".to_string(),
        });

        assert_eq!(error.browser_status, Some("auth_failed"));
    }

    #[test]
    fn classifies_proxy_auth_retry_abort_as_auth_failed() {
        let error = classify_startup_proxy_auth_error(proxy_auth::ProxyAuthRetryError::StillBlockedAfterReauth {
            operation_name: "Edit lock acquisition".to_string(),
        });

        assert_eq!(error.browser_status, Some("auth_failed"));
    }
}
