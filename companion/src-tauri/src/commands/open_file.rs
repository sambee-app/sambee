//! Tauri command for opening a downloaded file in a native application
//! and spawning the "Done Editing" window.
//!
//! Also includes conflict detection: before uploading, the companion
//! re-checks the server-side `modified_at` and shows a conflict dialog
//! if the file was modified by another user during the edit session.

use std::fs;
use std::path::Path;
use std::time::SystemTime;

use log::{debug, error, info, warn};
use serde::Serialize;
use serde_json::Value as JsonValue;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreBuilder;

use crate::app_registry::{get_registry, NativeApp};
use crate::http_client::{is_proxy_auth_required_error, SambeeHttpClientStore};
use crate::sync::operations::{
    CompanionLockContext, FileOperation, OperationStatus, OperationStore, PendingAppSelections, SelectedApp, FILE_POLL_INTERVAL_SECS,
    HEARTBEAT_INTERVAL_SECS,
};

const APP_PREFERENCES_STORE_FILE: &str = "app-preferences.json";
const APP_PREFERENCES_KEY: &str = "appPreferences";

fn launch_explicit_app(app: &AppHandle, app_executable: &str, path_str: &str) -> Result<(), String> {
    let _child = app.shell().command(app_executable).arg(path_str).spawn().map_err(|e| {
        error!("Failed to launch {}: {e}", app_executable);
        format!("Failed to launch {app_executable}: {e}")
    })?;

    debug!("Process spawned successfully for {}", app_executable);
    Ok(())
}

#[cfg(target_os = "windows")]
fn should_skip_explicit_windows_launch(app_executable: &str, handler_id: Option<&str>) -> bool {
    let normalized_executable = app_executable.replace('/', "\\").to_ascii_lowercase();
    let has_opaque_handler = handler_id.is_some_and(|value| !value.is_empty() && value.contains(':'));
    has_opaque_handler || normalized_executable.contains("\\windowsapps\\")
}

fn normalize_executable_for_matching(executable: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        executable.replace('/', "\\").to_ascii_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        executable.to_string()
    }
}

fn selected_app_from_native_app(app: &NativeApp) -> SelectedApp {
    SelectedApp {
        executable: app.executable.to_string_lossy().to_string(),
        handler_id: app.handler_id.clone(),
        name: app.name.clone(),
    }
}

fn select_preferred_app_from_candidates(preferred_executable: Option<&str>, apps: &[NativeApp]) -> Option<SelectedApp> {
    let preferred_executable = preferred_executable?.trim();
    if preferred_executable.is_empty() {
        return None;
    }

    let normalized_preference = normalize_executable_for_matching(preferred_executable);
    apps.iter()
        .find(|app| normalize_executable_for_matching(&app.executable.to_string_lossy()) == normalized_preference)
        .map(selected_app_from_native_app)
}

fn resolve_preferred_app_selection(app: &AppHandle, extension: &str) -> Option<SelectedApp> {
    let store = match StoreBuilder::new(app, APP_PREFERENCES_STORE_FILE).build() {
        Ok(store) => store,
        Err(err) => {
            warn!("Failed to open native app preference store: {err}");
            return None;
        }
    };

    let preferences_value = store.get(APP_PREFERENCES_KEY)?;

    let preferred_executable = match preferences_value {
        JsonValue::Object(preferences) => preferences.get(extension).and_then(JsonValue::as_str).map(str::to_owned),
        _ => {
            warn!("Invalid native app preference payload in store; expected object at key '{APP_PREFERENCES_KEY}'");
            return None;
        }
    };

    let apps = get_registry().apps_for_extension(extension);
    let selection = select_preferred_app_from_candidates(preferred_executable.as_deref(), &apps);

    if selection.is_none() && preferred_executable.is_some() {
        warn!(
            "Saved preferred app for extension '{}' is no longer available; falling back to picker",
            extension
        );
    }

    selection
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit context (sent to the Done Editing window)
// ─────────────────────────────────────────────────────────────────────────────

/// Context payload emitted to the "Done Editing" webview window.
#[derive(Clone, serde::Serialize)]
pub struct EditContext {
    /// UUID identifying this edit operation.
    pub operation_id: String,
    /// Display filename (e.g. "report-copy.docx").
    pub filename: String,
    /// Display name of the native application.
    pub app_name: String,
    /// Base Sambee server URL used to reopen the browser on lifecycle failures.
    pub server_url: String,
}

fn build_browser_status_url(server_url: &str, status: &str) -> Result<String, String> {
    match status {
        "renewal_required" | "auth_failed" | "lock_lost" | "recovery_required" => {}
        _ => return Err(format!("Unsupported companion status '{status}'")),
    }

    let mut url = url::Url::parse(server_url.trim_end_matches('/')).map_err(|e| format!("Invalid server URL '{server_url}': {e}"))?;
    url.set_path("/browse");
    url.set_query(Some(&format!("companion_status={status}")));
    url.set_fragment(None);
    Ok(url.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Done Editing window dimensions
// ─────────────────────────────────────────────────────────────────────────────

/// Width of the Done Editing window in logical pixels.
const DONE_EDITING_WIDTH: f64 = 340.0;

/// Height of the Done Editing window in logical pixels.
const DONE_EDITING_HEIGHT: f64 = 200.0;

/// Margin from the top-left screen edge for the first window (logical pixels).
const DONE_EDITING_MARGIN: f64 = 24.0;

/// Vertical offset between cascaded windows (logical pixels).
const DONE_EDITING_CASCADE_STEP: f64 = 32.0;

/// Label prefix for Done Editing windows (used to count open instances).
pub(crate) const DONE_EDITING_LABEL_PREFIX: &str = "done-editing-";

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthRetryReason {
    Upload,
    Conflict,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FinishEditingResult {
    Completed,
    Conflict {
        operation_id: String,
        filename: String,
        download_modified: String,
        server_modified: String,
        server_url: String,
    },
    AuthRetry {
        reason: AuthRetryReason,
    },
    RenewalRequired {
        message: String,
    },
    AuthFailed {
        message: String,
    },
    LockLost {
        message: String,
    },
    RecoveryRequired {
        message: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ConflictResolutionResult {
    Completed,
    AuthRetry { reason: AuthRetryReason },
    RenewalRequired { message: String },
    AuthFailed { message: String },
    LockLost { message: String },
    RecoveryRequired { message: String },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RecoveryUploadResult {
    Completed { message: String },
    AuthRetry { reason: AuthRetryReason },
    RenewalRequired { message: String },
    AuthFailed { message: String },
    LockLost { message: String },
    RecoveryRequired { message: String },
}

fn reset_operation_for_auth_retry(store: &OperationStore, app: &AppHandle, op_id: uuid::Uuid) {
    store.update_status(op_id, OperationStatus::Editing);
    crate::refresh_tray_menu(app);
}

fn require_lock_context(operation: &FileOperation) -> Result<CompanionLockContext, String> {
    operation.lock_context.clone().ok_or_else(|| {
        format!(
            "Edit session for '{}' is missing the server lock context required by the current companion protocol. Reopen the file from the browser and try again.",
            operation.filename()
        )
    })
}

fn lock_context_needs_renewal(lock_context: &CompanionLockContext) -> bool {
    let now = chrono::Utc::now().timestamp();
    now.saturating_sub(lock_context.token_issued_at_epoch_seconds) >= lock_context.renew_after_seconds as i64
}

fn finish_result_from_lifecycle_error(error: &str) -> Option<FinishEditingResult> {
    let message = super::upload::lifecycle_error_message(error)?.to_string();
    if super::upload::is_renewal_required_error(error) {
        Some(FinishEditingResult::RenewalRequired { message })
    } else if super::upload::is_auth_failed_error(error) {
        Some(FinishEditingResult::AuthFailed { message })
    } else if super::upload::is_lock_lost_error(error) {
        Some(FinishEditingResult::LockLost { message })
    } else if super::upload::is_capability_mismatch_error(error) || super::upload::is_recovery_required_error(error) {
        Some(FinishEditingResult::RecoveryRequired { message })
    } else {
        None
    }
}

fn conflict_result_from_lifecycle_error(error: &str) -> Option<ConflictResolutionResult> {
    let message = super::upload::lifecycle_error_message(error)?.to_string();
    if super::upload::is_renewal_required_error(error) {
        Some(ConflictResolutionResult::RenewalRequired { message })
    } else if super::upload::is_auth_failed_error(error) {
        Some(ConflictResolutionResult::AuthFailed { message })
    } else if super::upload::is_lock_lost_error(error) {
        Some(ConflictResolutionResult::LockLost { message })
    } else if super::upload::is_capability_mismatch_error(error) || super::upload::is_recovery_required_error(error) {
        Some(ConflictResolutionResult::RecoveryRequired { message })
    } else {
        None
    }
}

fn recovery_result_from_lifecycle_error(error: &str) -> Option<RecoveryUploadResult> {
    let message = super::upload::lifecycle_error_message(error)?.to_string();
    if super::upload::is_renewal_required_error(error) {
        Some(RecoveryUploadResult::RenewalRequired { message })
    } else if super::upload::is_auth_failed_error(error) {
        Some(RecoveryUploadResult::AuthFailed { message })
    } else if super::upload::is_lock_lost_error(error) {
        Some(RecoveryUploadResult::LockLost { message })
    } else if super::upload::is_capability_mismatch_error(error) || super::upload::is_recovery_required_error(error) {
        Some(RecoveryUploadResult::RecoveryRequired { message })
    } else {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/// Returns true if the given window label belongs to a Done Editing window.
pub(crate) fn is_done_editing_window_label(label: &str) -> bool {
    label.starts_with(DONE_EDITING_LABEL_PREFIX)
}

/// Returns the operation ID encoded into a Done Editing window label.
fn operation_id_from_window_label(window_label: &str) -> Result<uuid::Uuid, String> {
    let operation_id = window_label
        .strip_prefix(DONE_EDITING_LABEL_PREFIX)
        .ok_or_else(|| format!("Window '{window_label}' is not a Done Editing window"))?;

    operation_id
        .parse()
        .map_err(|_| format!("Window '{window_label}' has an invalid operation ID"))
}

#[tauri::command]
pub fn get_done_editing_context(app: AppHandle, window_label: String) -> Result<EditContext, String> {
    let op_id = operation_id_from_window_label(&window_label)?;

    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;

    let operation = store.get(op_id).ok_or_else(|| format!("Operation {op_id} not found"))?;

    let app_name = operation
        .opened_with_app
        .clone()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Unknown app".to_string());

    Ok(EditContext {
        operation_id: operation.id.to_string(),
        filename: operation.filename().to_string(),
        app_name,
        server_url: operation.server_url.clone(),
    })
}

#[tauri::command]
pub fn open_sambee_status_page(app: AppHandle, server_url: String, status: String) -> Result<(), String> {
    let status_url = build_browser_status_url(&server_url, &status)?;

    #[allow(deprecated)] // tauri-plugin-opener is not yet adopted
    app.shell().open(&status_url, None).map_err(|e| {
        error!("Failed to open Sambee status page {}: {e}", status_url);
        format!("Failed to open Sambee in your browser: {e}")
    })?;

    info!("Opened Sambee status page for status={status}");
    Ok(())
}

//
// open_in_native_app
//
/// Open a local file in the specified native application.
///
/// Uses `tauri_plugin_shell` `open()` API. Falls back to the system default
/// if `app_executable` is empty.
pub async fn open_in_native_app(app: &AppHandle, local_path: &Path, app_executable: &str, handler_id: Option<&str>) -> Result<(), String> {
    let path_str = local_path.to_str().ok_or_else(|| "Invalid file path encoding".to_string())?;

    debug!(
        "open_in_native_app: executable={:?}, handler_id={:?}, path={:?}, exists={}",
        app_executable,
        handler_id,
        path_str,
        local_path.exists()
    );

    if app_executable.is_empty() {
        // Use system default via xdg-open / open / start
        debug!("Opening with system default: {}", local_path.display());
        #[allow(deprecated)] // tauri-plugin-opener is not yet adopted
        app.shell().open(path_str, None).map_err(|e| {
            error!("shell.open() failed for {}: {e}", local_path.display());
            format!("Failed to open file with system default: {e}")
        })?;
        debug!("shell.open() succeeded for {}", local_path.display());
    } else {
        debug!("Opening with {}: {}", app_executable, local_path.display());

        // On Windows, use IAssocHandler::Invoke() which properly handles both
        // traditional Win32 applications and UWP/Store apps (e.g. Windows
        // Photos). UWP apps cannot be launched via CreateProcess — they
        // require activation through the Windows Shell infrastructure.
        #[cfg(target_os = "windows")]
        {
            let extension = local_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let preferred_handler_id = handler_id.filter(|value| !value.is_empty()).unwrap_or(app_executable);

            debug!(
                "Windows: attempting shell handler invocation for extension={:?}, handler={:?}",
                extension, preferred_handler_id
            );

            match crate::app_registry::windows::invoke_assoc_handler(extension, preferred_handler_id, path_str) {
                Ok(()) => {
                    debug!("IAssocHandler::Invoke() succeeded for {}", local_path.display());
                }
                Err(handler_err) => {
                    warn!("IAssocHandler invocation failed for {:?}: {}", preferred_handler_id, handler_err);

                    if should_skip_explicit_windows_launch(app_executable, handler_id) {
                        warn!(
                            "Skipping direct launch fallback for Windows packaged handler {:?}; trying system shell open instead",
                            preferred_handler_id
                        );

                        #[allow(deprecated)] // tauri-plugin-opener is not yet adopted
                        app.shell().open(path_str, None).map_err(|e| {
                            error!(
                                "Packaged-app shell.open() fallback failed for {} after handler invoke error: {e}",
                                local_path.display()
                            );
                            format!("Failed to open file after packaged-app handler fallback: {e}")
                        })?;

                        warn!(
                            "Used system shell.open() fallback for {} after packaged-handler invoke failure",
                            local_path.display()
                        );
                        return Ok(());
                    }

                    match launch_explicit_app(app, app_executable, path_str) {
                        Ok(()) => {
                            debug!("Direct launch fallback succeeded for {}", local_path.display());
                        }
                        Err(launch_err) => {
                            warn!(
                                "Direct launch fallback failed ({}), falling back to system default shell open",
                                launch_err
                            );

                            // Final fallback: delegate to the OS default handler.
                            debug!("Fallback: opening {:?} via system default (shell open)", path_str);
                            #[allow(deprecated)] // tauri-plugin-opener is not yet adopted
                            app.shell().open(path_str, None).map_err(|e| {
                                error!("Fallback shell.open() also failed for {}: {e}", local_path.display());
                                format!("Failed to open file: {e}")
                            })?;
                            debug!("Fallback shell.open() succeeded for {}", local_path.display());
                        }
                    }
                }
            }
        }

        // On non-Windows platforms, spawn the application directly
        #[cfg(not(target_os = "windows"))]
        {
            launch_explicit_app(app, app_executable, path_str)?;
        }
    }

    Ok(())
}

/// Show the companion app picker for a file extension and wait for the user's selection.
pub async fn prompt_for_app_selection(app: &AppHandle, extension: &str, force_picker: bool) -> Result<Option<SelectedApp>, String> {
    if !force_picker {
        if let Some(selection) = resolve_preferred_app_selection(app, extension) {
            debug!("Resolved preferred app without showing picker for extension '{}'", extension);
            return Ok(Some(selection));
        }
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let pending = app
        .try_state::<PendingAppSelections>()
        .ok_or_else(|| "PendingAppSelections not available".to_string())?;
    let pending_picker = app
        .try_state::<crate::PendingMainWindowAppPicker>()
        .ok_or_else(|| "PendingMainWindowAppPicker not available".to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<SelectedApp>>();
    pending.insert(request_id.clone(), tx);
    pending_picker.set(crate::PendingAppPickerRequest {
        extension: extension.to_string(),
        request_id: request_id.clone(),
        force_picker,
    });

    let newly_created = match crate::ensure_main_window(
        app,
        crate::native_i18n::NativeLocale::from_app(app).text("appPickerTitle"),
        crate::APP_PICKER_WIDTH,
        crate::APP_PICKER_INITIAL_HEIGHT,
    ) {
        Ok(created) => {
            debug!(
                "Main window ready for app picker: newly_created={}, request_id={}, extension='{}'",
                created, request_id, extension
            );
            created
        }
        Err(err) => {
            pending_picker.clear();
            let _ = pending.respond(&request_id, None);
            return Err(format!("Failed to ensure main window for app picker: {err}"));
        }
    };

    let delay_ms = if newly_created {
        crate::MAIN_WINDOW_CREATED_EVENT_DELAY_MS
    } else {
        crate::MAIN_WINDOW_REUSED_EVENT_DELAY_MS
    };
    let app_for_emit = app.clone();
    let request_id_for_emit = request_id.clone();
    let extension_for_emit = extension.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        if let Some(win) = app_for_emit.get_webview_window(crate::MAIN_WINDOW_LABEL) {
            let _ = win.set_focus();
        }

        match app_for_emit.emit_to(
            crate::MAIN_WINDOW_LABEL,
            "show-app-picker",
            serde_json::json!({
                "extension": extension_for_emit,
                "request_id": request_id_for_emit,
                "force_picker": force_picker,
            }),
        ) {
            Ok(()) => debug!("App picker event emitted successfully"),
            Err(err) => warn!("Failed to emit app picker event: {err}"),
        }

        if let Some(theme_state) = app_for_emit.try_state::<crate::ThemeState>() {
            if let Some(theme) = theme_state.get() {
                let _ = app_for_emit.emit_to(crate::MAIN_WINDOW_LABEL, "apply-theme", &theme);
            }
        }
    });

    debug!("Waiting for app picker selection: request_id={request_id}");
    let selection = match rx.await {
        Ok(selection) => {
            debug!(
                "App picker selection resolved: request_id={}, selected={}",
                request_id,
                selection.is_some()
            );
            selection
        }
        Err(err) => {
            warn!(
                "App picker selection channel closed before a response was received for {}: {err}",
                request_id
            );
            None
        }
    };

    if let Some(win) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let _ = win.hide();
    }

    Ok(selection)
}

//
// spawn_done_editing_window
//
/// Create and show the "Done Editing" webview window for an active operation.
///
/// The window is always-on-top, non-resizable, non-closable, and non-minimizable.
/// It emits an `edit-context` event so the frontend knows which file is being edited.
pub fn spawn_done_editing_window(app: &AppHandle, operation: &FileOperation, app_display_name: &str) -> Result<String, String> {
    let window_label = format!("{}{}", DONE_EDITING_LABEL_PREFIX, operation.id);

    // Count existing Done Editing windows for cascade positioning
    let existing_count = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(DONE_EDITING_LABEL_PREFIX))
        .count() as f64;

    let pos_x = DONE_EDITING_MARGIN;
    let pos_y = DONE_EDITING_MARGIN + existing_count * DONE_EDITING_CASCADE_STEP;

    let _window = tauri::WebviewWindowBuilder::new(app, &window_label, tauri::WebviewUrl::App("/done-editing".into()))
        .title(crate::native_i18n::NativeLocale::from_app(app).text("editingTitle"))
        .inner_size(DONE_EDITING_WIDTH, DONE_EDITING_HEIGHT)
        .position(pos_x, pos_y)
        .resizable(false)
        .maximizable(false)
        .fullscreen(false)
        .always_on_top(true)
        .closable(false)
        .minimizable(false)
        .build()
        .map_err(|e| format!("Failed to create Done Editing window: {e}"))?;

    // Send edit context to the window
    let context = EditContext {
        operation_id: operation.id.to_string(),
        filename: operation.filename().to_string(),
        app_name: app_display_name.to_string(),
        server_url: operation.server_url.clone(),
    };

    // Use a short delay to ensure the window is ready to receive events
    let window_label_clone = window_label.clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Err(e) = app_clone.emit_to(&window_label_clone, "edit-context", &context) {
            warn!("Failed to emit edit-context: {e}");
        }
    });

    info!("Spawned Done Editing window: {} for {}", window_label, operation.filename());

    Ok(window_label)
}

//
// start_file_status_polling
//
/// Start a background task that polls the temp file's mtime every 2 seconds
/// and emits `file-status` events to the Done Editing window.
pub fn start_file_status_polling(app: &AppHandle, window_label: String, local_path: std::path::PathBuf, original_mtime: SystemTime) {
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let interval = std::time::Duration::from_secs(FILE_POLL_INTERVAL_SECS);

        loop {
            tokio::time::sleep(interval).await;

            // Check if the window still exists
            if app_clone.get_webview_window(&window_label).is_none() {
                info!("File status polling stopped: window {} closed", window_label);
                break;
            }

            // Read current mtime
            let current_mtime = match fs::metadata(&local_path).and_then(|m| m.modified()) {
                Ok(mtime) => mtime,
                Err(_) => continue,
            };

            let status = if current_mtime != original_mtime {
                // File has been modified — format the time
                let time_str = format_system_time(current_mtime);
                serde_json::json!({ "kind": "modified", "modifiedAt": time_str })
            } else {
                serde_json::json!({ "kind": "unchanged" })
            };

            let _ = app_clone.emit_to(&window_label, "file-status", &status);
        }
    });
}

//
// start_heartbeat_task
//
/// Start a background task that sends lock heartbeats every 30 seconds.
///
/// Stops when the Done Editing window is closed.
pub fn start_heartbeat_task(
    app: &AppHandle,
    window_label: String,
    operation_id: uuid::Uuid,
    server_url: String,
    connection_id: String,
    remote_path: String,
    initial_lock_context: CompanionLockContext,
) {
    let app_clone = app.clone();
    let http_clients = app.try_state::<SambeeHttpClientStore>().map(|state| state.inner().clone());
    let operation_store = app.try_state::<OperationStore>().map(|state| state.inner().clone());

    tauri::async_runtime::spawn(async move {
        let interval = std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
        let mut current_lock_context = initial_lock_context;

        loop {
            tokio::time::sleep(interval).await;

            // Stop if window is gone
            if app_clone.get_webview_window(&window_label).is_none() {
                info!("Heartbeat stopped: window {} closed", window_label);
                break;
            }

            if let Some(ref store) = operation_store {
                if let Some(operation) = store.get(operation_id) {
                    if let Some(lock_context) = operation.lock_context {
                        current_lock_context = lock_context;
                    }
                }
            }

            if lock_context_needs_renewal(&current_lock_context) {
                let renewed_context_result = if let Some(ref clients) = http_clients {
                    crate::proxy_auth::retry_if_proxy_auth_required(&app_clone, &server_url, clients, "Operation session renew", || async {
                        super::upload::renew_operation_session_with_store(
                            clients,
                            &server_url,
                            &connection_id,
                            &remote_path,
                            &current_lock_context,
                        )
                        .await
                    })
                    .await
                } else {
                    super::upload::renew_operation_session(&server_url, &connection_id, &remote_path, &current_lock_context)
                        .await
                        .map_err(crate::proxy_auth::ProxyAuthRetryError::Operation)
                };

                match renewed_context_result {
                    Ok(renewed_context) => {
                        current_lock_context = renewed_context.clone();
                        if let Some(ref store) = operation_store {
                            store.update_lock_context(operation_id, renewed_context.clone());
                            if let Some(updated_operation) = store.get(operation_id) {
                                if let Err(error) = crate::sync::operations::save_operation_sidecar(&updated_operation) {
                                    warn!(
                                        "Failed to persist renewed lock context for {}: {error}",
                                        updated_operation.filename()
                                    );
                                }
                            }
                        }
                    }
                    Err(error) => {
                        if let crate::proxy_auth::ProxyAuthRetryError::Operation(operation_error) = &error {
                            if let Some(message) = super::upload::lifecycle_error_message(operation_error) {
                                warn!("Stopping heartbeat after operation session renewal hard failure: {message}");
                                let _ = app_clone.emit("notification", serde_json::json!({ "message": message }));
                                break;
                            }
                        }

                        warn!("Operation session renewal failed (will retry next interval): {error}");
                    }
                }
            }

            let result = if let Some(ref clients) = http_clients {
                let heartbeat_lock_context = current_lock_context.clone();
                crate::proxy_auth::retry_if_proxy_auth_required(&app_clone, &server_url, clients, "Lock heartbeat", || async {
                    super::upload::send_heartbeat_with_store(clients, &server_url, &connection_id, &remote_path, &heartbeat_lock_context)
                        .await
                })
                .await
            } else {
                super::upload::send_heartbeat(&server_url, &connection_id, &remote_path, &current_lock_context)
                    .await
                    .map_err(crate::proxy_auth::ProxyAuthRetryError::Operation)
            };

            match result {
                Ok(()) => {}
                Err(e) => {
                    if let crate::proxy_auth::ProxyAuthRetryError::Operation(operation_error) = &e {
                        if let Some(message) = super::upload::lifecycle_error_message(operation_error) {
                            warn!("Stopping heartbeat after lock lifecycle hard failure: {message}");
                            let _ = app_clone.emit("notification", serde_json::json!({ "message": message }));
                            break;
                        }
                    }

                    warn!("Heartbeat failed (will retry next interval): {e}");
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands (invoked from the frontend)
// ─────────────────────────────────────────────────────────────────────────────

//
// finish_editing
//
/// Tauri command: user confirmed "Done Editing".
///
/// If the file is modified → upload, release lock, recycle, close window.
/// If unchanged → release lock, recycle, close window.
#[tauri::command]
pub async fn finish_editing(app: AppHandle, operation_id: String) -> Result<FinishEditingResult, String> {
    let op_id: uuid::Uuid = operation_id.parse().map_err(|_| "Invalid operation ID".to_string())?;

    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;

    let operation = store.get(op_id).ok_or_else(|| format!("Operation {op_id} not found"))?;

    let window_label = format!("done-editing-{}", operation.id);
    let local_path = operation.local_path.clone();
    let server_url = operation.server_url.clone();
    let connection_id = operation.connection_id.clone();
    let remote_path = operation.remote_path.clone();
    let original_mtime = operation.original_mtime;
    let filename = operation.filename();
    let lock_context = require_lock_context(&operation)?;
    let http_clients = app
        .try_state::<SambeeHttpClientStore>()
        .ok_or_else(|| "HTTP client store not available".to_string())?
        .inner()
        .clone();

    // Check if file was modified
    let current_mtime = fs::metadata(&local_path).and_then(|m| m.modified()).unwrap_or(original_mtime);

    let is_modified = current_mtime != original_mtime;

    if is_modified {
        // ── Conflict detection ─────────────────────────────────────────
        // Before uploading, check if the server-side file was modified
        // by another user while we held our lock.
        if let Some(ref download_modified_at) = operation.server_last_modified {
            let conflict_check_lock_context = lock_context.clone();
            match crate::proxy_auth::retry_if_proxy_auth_required(&app, &server_url, &http_clients, "Conflict check", || async {
                super::file_info::get_file_info_with_store(
                    &http_clients,
                    &server_url,
                    &connection_id,
                    &remote_path,
                    Some(&conflict_check_lock_context),
                    None,
                )
                .await
            })
            .await
            {
                Ok(current_info) => {
                    if let Some(ref current_modified) = current_info.modified_at {
                        if current_modified != download_modified_at {
                            // Server file changed since our download → conflict!
                            warn!(
                                "Conflict detected for {}: download_modified={}, server_modified={}",
                                filename, download_modified_at, current_modified
                            );
                            return Ok(FinishEditingResult::Conflict {
                                operation_id: operation.id.to_string(),
                                filename: filename.to_string(),
                                download_modified: download_modified_at.to_string(),
                                server_modified: current_modified.to_string(),
                                server_url: server_url.clone(),
                            });
                        }
                    }
                }
                Err(e) => {
                    if e.should_abort_safety_check() {
                        return Err(format!(
                            "Conflict check could not reach the Sambee backend after reauthentication. Upload was cancelled to avoid overwriting a newer server version: {e}"
                        ));
                    }

                    warn!("Conflict check failed (proceeding with upload): {e}");
                }
            }
        }

        // Upload the file
        info!("Uploading modified file: {}", local_path.display());
        store.update_status(op_id, OperationStatus::Uploading(0.0));
        crate::refresh_tray_menu(&app);

        match super::upload::upload_file_with_store(
            &http_clients,
            &app,
            &window_label,
            &server_url,
            &connection_id,
            &remote_path,
            &local_path,
            &lock_context,
        )
        .await
        {
            Ok(_resp) => {
                info!("Upload successful for {}", filename);
            }
            Err(e) => {
                if is_proxy_auth_required_error(&e) {
                    crate::proxy_auth::authenticate_reverse_proxy(&app, &server_url, &http_clients).await?;
                    reset_operation_for_auth_retry(&store, &app, op_id);
                    return Ok(FinishEditingResult::AuthRetry {
                        reason: AuthRetryReason::Upload,
                    });
                }
                if let Some(result) = finish_result_from_lifecycle_error(&e) {
                    reset_operation_for_auth_retry(&store, &app, op_id);
                    return Ok(result);
                }
                error!("Upload failed for {}: {e}", filename);
                store.update_status(op_id, OperationStatus::UploadFailed(e.clone()));
                crate::refresh_tray_menu(&app);
                return Err(format!("Upload failed: {e}"));
            }
        }
    }

    // Release lock (best-effort)
    let release_lock_context = lock_context.clone();
    let _ = crate::proxy_auth::retry_if_proxy_auth_required(&app, &server_url, &http_clients, "Lock release", || async {
        super::upload::release_lock_with_store(&http_clients, &server_url, &connection_id, &remote_path, &release_lock_context).await
    })
    .await;

    // Move temp file to recycle bin
    let _ = crate::sync::recycle::recycle_file(&local_path);

    // Update status
    store.update_status(op_id, OperationStatus::Completed);
    crate::refresh_tray_menu(&app);

    // Close the Done Editing window
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.destroy();
    }

    // Send notification
    let message = if is_modified {
        format!("✓ {} — saved to server.", filename)
    } else {
        format!("✓ {} — no changes, lock released.", filename)
    };

    let _ = app.emit("notification", serde_json::json!({ "message": message }));

    info!("Edit session completed: {}", filename);
    Ok(FinishEditingResult::Completed)
}

//
// discard_editing
//
/// Tauri command: user confirmed "Discard Changes".
///
/// Releases lock, moves temp file to recycle bin, closes window.
#[tauri::command]
pub async fn discard_editing(app: AppHandle, operation_id: String) -> Result<String, String> {
    let op_id: uuid::Uuid = operation_id.parse().map_err(|_| "Invalid operation ID".to_string())?;

    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;

    let operation = store.get(op_id).ok_or_else(|| format!("Operation {op_id} not found"))?;

    let window_label = format!("done-editing-{}", operation.id);
    let local_path = operation.local_path.clone();
    let server_url = operation.server_url.clone();
    let connection_id = operation.connection_id.clone();
    let remote_path = operation.remote_path.clone();
    let filename = operation.filename();
    let lock_context = operation.lock_context.clone();
    let http_clients = app
        .try_state::<SambeeHttpClientStore>()
        .ok_or_else(|| "HTTP client store not available".to_string())?
        .inner()
        .clone();

    // Release lock (best-effort)
    if let Some(lock_context) = lock_context {
        let _ = crate::proxy_auth::retry_if_proxy_auth_required(&app, &server_url, &http_clients, "Lock release", || async {
            super::upload::release_lock_with_store(&http_clients, &server_url, &connection_id, &remote_path, &lock_context).await
        })
        .await;
    } else {
        warn!(
            "Discarding '{}' without server lock release because the operation is missing the required lock context",
            filename
        );
    }

    // Move temp file to recycle bin
    let _ = crate::sync::recycle::recycle_file(&local_path);

    // Update status
    store.update_status(op_id, OperationStatus::Discarded);
    crate::refresh_tray_menu(&app);

    // Close the Done Editing window
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.destroy();
    }

    let message = format!("{} — changes discarded (recoverable for 7 days).", filename);
    let _ = app.emit("notification", serde_json::json!({ "message": message }));

    info!("Edit session discarded: {}", filename);
    Ok(message)
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict resolution commands
// ─────────────────────────────────────────────────────────────────────────────

//
// resolve_conflict_overwrite
//
/// Tauri command: user chose "Overwrite" in the conflict dialog.
///
/// Skips the conflict check and force-uploads the local file.
#[tauri::command]
pub async fn resolve_conflict_overwrite(app: AppHandle, operation_id: String) -> Result<ConflictResolutionResult, String> {
    upload_and_finish(&app, &operation_id, None).await
}

//
// resolve_conflict_save_copy
//
/// Tauri command: user chose "Save as Copy" in the conflict dialog.
///
/// Uploads the local file to a different path on the server, preserving
/// both the current server version and the user's local edits.
/// Copy path: `{stem} (conflict copy).{ext}` or `{name} (conflict copy)`.
#[tauri::command]
pub async fn resolve_conflict_save_copy(app: AppHandle, operation_id: String) -> Result<ConflictResolutionResult, String> {
    let op_id: uuid::Uuid = operation_id.parse().map_err(|_| "Invalid operation ID".to_string())?;

    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;

    let operation = store.get(op_id).ok_or_else(|| format!("Operation {op_id} not found"))?;

    let copy_path = make_conflict_copy_path(&operation.remote_path);
    info!("Saving conflict copy: {} → {}", operation.remote_path, copy_path);

    upload_and_finish(&app, &operation_id, Some(&copy_path)).await
}

//
// upload_and_finish
//
/// Shared helper: upload a file (optionally to a different path) then
/// release lock, recycle, close window, notify.
async fn upload_and_finish(
    app: &AppHandle,
    operation_id: &str,
    upload_path_override: Option<&str>,
) -> Result<ConflictResolutionResult, String> {
    let op_id: uuid::Uuid = operation_id.parse().map_err(|_| "Invalid operation ID".to_string())?;

    let store = app
        .try_state::<OperationStore>()
        .ok_or_else(|| "Operation store not available".to_string())?;

    let operation = store.get(op_id).ok_or_else(|| format!("Operation {op_id} not found"))?;

    let window_label = format!("done-editing-{}", operation.id);
    let local_path = operation.local_path.clone();
    let server_url = operation.server_url.clone();
    let connection_id = operation.connection_id.clone();
    let remote_path = upload_path_override.unwrap_or(&operation.remote_path);
    let filename = operation.filename();
    let lock_context = require_lock_context(&operation)?;
    let http_clients = app
        .try_state::<SambeeHttpClientStore>()
        .ok_or_else(|| "HTTP client store not available".to_string())?
        .inner()
        .clone();

    // Upload
    store.update_status(op_id, OperationStatus::Uploading(0.0));
    crate::refresh_tray_menu(app);
    match super::upload::upload_file_with_store(
        &http_clients,
        app,
        &window_label,
        &server_url,
        &connection_id,
        remote_path,
        &local_path,
        &lock_context,
    )
    .await
    {
        Ok(_) => {
            info!("Upload successful (conflict resolved) for {}", filename);
        }
        Err(e) => {
            if is_proxy_auth_required_error(&e) {
                crate::proxy_auth::authenticate_reverse_proxy(app, &server_url, &http_clients).await?;
                reset_operation_for_auth_retry(&store, app, op_id);
                return Ok(ConflictResolutionResult::AuthRetry {
                    reason: AuthRetryReason::Conflict,
                });
            }
            if let Some(result) = conflict_result_from_lifecycle_error(&e) {
                reset_operation_for_auth_retry(&store, app, op_id);
                return Ok(result);
            }
            error!("Upload failed for {}: {e}", filename);
            store.update_status(op_id, OperationStatus::UploadFailed(e.clone()));
            crate::refresh_tray_menu(app);
            return Err(format!("Upload failed: {e}"));
        }
    }

    // Release lock
    let release_lock_context = lock_context.clone();
    let _ = crate::proxy_auth::retry_if_proxy_auth_required(app, &server_url, &http_clients, "Lock release", || async {
        super::upload::release_lock_with_store(
            &http_clients,
            &server_url,
            &connection_id,
            &operation.remote_path, // Always release lock on the original path
            &release_lock_context,
        )
        .await
    })
    .await;

    // Recycle temp file
    let _ = crate::sync::recycle::recycle_file(&local_path);

    store.update_status(op_id, OperationStatus::Completed);
    crate::refresh_tray_menu(app);

    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.destroy();
    }

    let message = if upload_path_override.is_some() {
        format!("✓ {} — saved as copy on server.", filename)
    } else {
        format!("✓ {} — saved to server (overwritten).", filename)
    };
    let _ = app.emit("notification", serde_json::json!({ "message": message }));

    info!("Conflict resolved for {}", filename);
    Ok(ConflictResolutionResult::Completed)
}

//
// make_conflict_copy_path
//
/// Generate a server path for a conflict copy.
///
/// `/docs/report.docx` → `/docs/report (conflict copy).docx`
/// `/docs/Makefile` → `/docs/Makefile (conflict copy)`
fn make_conflict_copy_path(remote_path: &str) -> String {
    // Split into directory + filename
    let (dir, name) = match remote_path.rfind('/') {
        Some(pos) => (&remote_path[..=pos], &remote_path[pos + 1..]),
        None => ("", remote_path),
    };

    // Split filename into stem + extension
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let stem = &name[..dot];
            let ext = &name[dot..];
            format!("{dir}{stem} (conflict copy){ext}")
        }
        _ => format!("{dir}{name} (conflict copy)"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Large-file confirmation
// ─────────────────────────────────────────────────────────────────────────────

//
// confirm_large_download
//
/// Tauri command: user responded to the large-file warning dialog.
///
/// Signals the pending lifecycle to proceed (`true`) or abort (`false`).
#[tauri::command]
pub fn confirm_large_download(app: AppHandle, confirm_id: String, proceed: bool) -> Result<(), String> {
    let pending = app
        .try_state::<crate::sync::operations::PendingConfirmations>()
        .ok_or_else(|| "PendingConfirmations not available".to_string())?;

    if pending.respond(&confirm_id, proceed) {
        info!("Large download confirmation {}: proceed={}", confirm_id, proceed);
        Ok(())
    } else {
        warn!("No pending confirmation found for {}", confirm_id);
        Err(format!("No pending confirmation: {confirm_id}"))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// App picker response
// ─────────────────────────────────────────────────────────────────────────────

//
// respond_app_selection
//
/// Tauri command: user selected an app (or cancelled) in the app picker dialog.
///
/// When the user picks an app, `executable` and `app_name` are provided.
/// When the user cancels, `executable` is an empty string, which signals
/// cancellation to the waiting lifecycle.
#[tauri::command]
pub fn respond_app_selection(
    app: AppHandle,
    request_id: String,
    executable: String,
    app_name: String,
    handler_id: Option<String>,
) -> Result<(), String> {
    let pending = app
        .try_state::<crate::sync::operations::PendingAppSelections>()
        .ok_or_else(|| "PendingAppSelections not available".to_string())?;

    if let Some(pending_picker) = app.try_state::<crate::PendingMainWindowAppPicker>() {
        pending_picker.clear();
    }

    let selection = if executable.is_empty() {
        None
    } else {
        Some(crate::sync::operations::SelectedApp {
            executable,
            handler_id,
            name: app_name,
        })
    };

    if pending.respond(&request_id, selection) {
        info!("App selection received for request {}", request_id);
        Ok(())
    } else {
        warn!("No pending app selection found for {}", request_id);
        Err(format!("No pending app selection: {request_id}"))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup recovery commands
// ─────────────────────────────────────────────────────────────────────────────

/// Payload describing a leftover operation from a previous session.
#[derive(Clone, Serialize)]
pub struct LeftoverInfo {
    /// Path to the operation directory.
    pub operation_dir: String,
    /// Filename of the temp file (display name).
    pub filename: String,
    /// Server URL from the sidecar.
    pub server_url: String,
    /// Remote path on the server.
    pub remote_path: String,
    /// Connection ID from the sidecar.
    pub connection_id: String,
    /// Last modified time of the local file (formatted).
    pub local_modified: String,
}

//
// recovery_upload
//
/// Tauri command: user chose "Upload to Server" for a leftover file.
///
/// Re-exchanges a session (or uses existing token), uploads, then recycles.
#[tauri::command]
pub async fn recovery_upload(app: AppHandle, operation_dir: String) -> Result<RecoveryUploadResult, String> {
    let sidecar_path = std::path::PathBuf::from(&operation_dir).join(crate::sync::operations::SIDECAR_FILENAME);

    let op = crate::sync::operations::load_operation_sidecar(&sidecar_path)?;
    let filename = op.filename().to_string();
    let local_path = op.local_path.clone();
    let lock_context = require_lock_context(&op)?;
    let http_clients = app
        .try_state::<SambeeHttpClientStore>()
        .ok_or_else(|| "HTTP client store not available".to_string())?
        .inner()
        .clone();

    // Attempt upload with existing token (may fail if expired)
    let upload_result = super::upload::upload_file_with_store(
        &http_clients,
        &app,
        "main", // no Done Editing window for recovery
        &op.server_url,
        &op.connection_id,
        &op.remote_path,
        &local_path,
        &lock_context,
    )
    .await;

    match upload_result {
        Ok(_) => {
            let _ = crate::sync::recycle::recycle_file(&local_path);
            let message = format!("✓ {} — recovered and uploaded to server.", filename);
            let _ = app.emit("notification", serde_json::json!({ "message": &message }));
            info!("Recovery upload successful: {}", filename);
            Ok(RecoveryUploadResult::Completed { message })
        }
        Err(e) => {
            if is_proxy_auth_required_error(&e) {
                crate::proxy_auth::authenticate_reverse_proxy(&app, &op.server_url, &http_clients).await?;
                return Ok(RecoveryUploadResult::AuthRetry {
                    reason: AuthRetryReason::Upload,
                });
            }
            if let Some(result) = recovery_result_from_lifecycle_error(&e) {
                return Ok(result);
            }
            error!("Recovery upload failed for {}: {e}", filename);
            Err(format!("Upload failed: {e}"))
        }
    }
}

//
// recovery_discard
//
/// Tauri command: user chose "Discard" for a leftover file.
///
/// Moves the temp file to the recycle bin.
#[tauri::command]
pub async fn recovery_discard(_app: AppHandle, operation_dir: String) -> Result<String, String> {
    let sidecar_path = std::path::PathBuf::from(&operation_dir).join(crate::sync::operations::SIDECAR_FILENAME);

    let op = crate::sync::operations::load_operation_sidecar(&sidecar_path)?;
    let filename = op.filename().to_string();

    let _ = crate::sync::recycle::recycle_file(&op.local_path);
    info!("Recovery discard: {}", filename);

    Ok(format!("{} — discarded (recoverable for 7 days).", filename))
}

//
// recovery_dismiss
//
/// Tauri command: user chose "Keep for Later" for a leftover file.
///
/// Does nothing — the file stays in place for the next startup scan.
#[tauri::command]
pub async fn recovery_dismiss(_app: AppHandle, operation_dir: String) -> Result<String, String> {
    info!("Recovery dismissed: {}", operation_dir);
    Ok("Kept for later".to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

//
// format_system_time
//
/// Format a `SystemTime` as `HH:MM:SS` (UTC).
fn format_system_time(time: SystemTime) -> String {
    use std::time::UNIX_EPOCH;

    let secs = time.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

//
// has_active_operations
//
/// Returns `true` if any file-editing operation is currently active.
///
/// Used by the frontend auto-updater to avoid installing an update while
/// the user is in the middle of editing a file.
#[tauri::command]
pub fn has_active_operations(app: AppHandle) -> bool {
    let Some(store) = app.try_state::<OperationStore>() else {
        return false;
    };
    !store.active_operations().is_empty()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::time::{Duration, UNIX_EPOCH};

    fn encoded_lifecycle_error(code: &str, message: &str) -> String {
        super::super::upload::classify_lifecycle_error(&format!(r#"{{"detail":{{"code":"{code}","message":"{message}"}}}}"#))
            .expect("expected structured lifecycle error")
    }

    //
    // test_format_system_time
    //
    #[test]
    fn test_format_system_time() {
        // 1_770_853_822 secs since epoch → time of day = 23:50:22 UTC
        let time = UNIX_EPOCH + Duration::from_secs(1_770_853_822);
        let formatted = format_system_time(time);
        assert_eq!(formatted, "23:50:22");
    }

    #[test]
    fn selects_preferred_app_from_candidates() {
        let apps = vec![
            NativeApp {
                name: "LibreOffice Writer".to_string(),
                executable: "/usr/bin/libreoffice".into(),
                handler_id: Some("writer-handler".to_string()),
                icon: None,
                is_default: true,
                is_recommended: true,
            },
            NativeApp {
                name: "OnlyOffice".to_string(),
                executable: "/opt/onlyoffice/desktopeditors".into(),
                handler_id: None,
                icon: None,
                is_default: false,
                is_recommended: true,
            },
        ];

        let selection =
            select_preferred_app_from_candidates(Some("/opt/onlyoffice/desktopeditors"), &apps).expect("expected preferred app selection");

        assert_eq!(selection.name, "OnlyOffice");
        assert_eq!(selection.executable, "/opt/onlyoffice/desktopeditors");
        assert_eq!(selection.handler_id, None);
    }

    #[test]
    fn ignores_missing_preferred_app_candidates() {
        let apps = vec![NativeApp {
            name: "LibreOffice Writer".to_string(),
            executable: "/usr/bin/libreoffice".into(),
            handler_id: Some("writer-handler".to_string()),
            icon: None,
            is_default: true,
            is_recommended: true,
        }];

        assert!(select_preferred_app_from_candidates(Some("/missing/app"), &apps).is_none());
        assert!(select_preferred_app_from_candidates(None, &apps).is_none());
    }

    //
    // test_format_system_time_midnight
    //
    #[test]
    fn test_format_system_time_midnight() {
        // Exact midnight
        let time = UNIX_EPOCH + Duration::from_secs(86400 * 20000);
        let formatted = format_system_time(time);
        assert_eq!(formatted, "00:00:00");
    }

    //
    // test_edit_context_serialize
    //
    #[test]
    fn test_edit_context_serialize() {
        let ctx = EditContext {
            operation_id: "abc-123".to_string(),
            filename: "report-copy.docx".to_string(),
            app_name: "LibreOffice Writer".to_string(),
            server_url: "https://sambee.example.test".to_string(),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        assert!(json.contains("report-copy.docx"));
        assert!(json.contains("LibreOffice Writer"));
        assert!(json.contains("sambee.example.test"));
    }

    #[test]
    fn test_build_browser_status_url_accepts_supported_status() {
        let url = build_browser_status_url("https://sambee.example.test/app/", "lock_lost").unwrap();
        assert_eq!(url, "https://sambee.example.test/browse?companion_status=lock_lost");
    }

    #[test]
    fn test_build_browser_status_url_rejects_unsupported_status() {
        let err = build_browser_status_url("https://sambee.example.test", "unknown_status").unwrap_err();
        assert!(err.contains("Unsupported companion status"));
    }

    #[test]
    fn test_lock_context_needs_renewal_after_threshold() {
        let now = Utc::now().timestamp();
        let lock_context = CompanionLockContext {
            lock_id: "lock-1".to_string(),
            operation_id: "op-1".to_string(),
            lock_capability: "cap-1".to_string(),
            operation_token: "token-1".to_string(),
            renew_after_seconds: 600,
            token_issued_at_epoch_seconds: now - 600,
        };

        assert!(lock_context_needs_renewal(&lock_context));
    }

    #[test]
    fn test_lock_context_needs_renewal_before_threshold() {
        let now = Utc::now().timestamp();
        let lock_context = CompanionLockContext {
            lock_id: "lock-1".to_string(),
            operation_id: "op-1".to_string(),
            lock_capability: "cap-1".to_string(),
            operation_token: "token-1".to_string(),
            renew_after_seconds: 600,
            token_issued_at_epoch_seconds: now - 599,
        };

        assert!(!lock_context_needs_renewal(&lock_context));
    }

    #[test]
    fn test_finish_result_maps_capability_mismatch_to_recovery_required() {
        let encoded = encoded_lifecycle_error("capability_mismatch", "wrong capability");

        match finish_result_from_lifecycle_error(&encoded) {
            Some(FinishEditingResult::RecoveryRequired { message }) => assert_eq!(message, "wrong capability"),
            _ => panic!("expected recovery-required finish result"),
        }
    }

    #[test]
    fn test_conflict_result_maps_auth_failed() {
        let encoded = encoded_lifecycle_error("auth_failed", "sign in again");

        match conflict_result_from_lifecycle_error(&encoded) {
            Some(ConflictResolutionResult::AuthFailed { message }) => assert_eq!(message, "sign in again"),
            _ => panic!("expected auth-failed conflict result"),
        }
    }

    #[test]
    fn test_recovery_result_maps_lock_lost() {
        let encoded = encoded_lifecycle_error("lock_lost", "lock disappeared");

        match recovery_result_from_lifecycle_error(&encoded) {
            Some(RecoveryUploadResult::LockLost { message }) => assert_eq!(message, "lock disappeared"),
            _ => panic!("expected lock-lost recovery result"),
        }
    }

    #[test]
    fn test_operation_id_from_window_label_rejects_wrong_prefix() {
        let err = operation_id_from_window_label("editor-window").unwrap_err();
        assert!(err.contains("is not a Done Editing window"));
    }

    #[test]
    fn test_operation_id_from_window_label_rejects_invalid_uuid() {
        let err = operation_id_from_window_label("done-editing-not-a-uuid").unwrap_err();
        assert!(err.contains("invalid operation ID"));
    }

    //
    // test_conflict_copy_path_with_extension
    //
    #[test]
    fn test_conflict_copy_path_with_extension() {
        assert_eq!(make_conflict_copy_path("/docs/report.docx"), "/docs/report (conflict copy).docx");
    }

    //
    // test_conflict_copy_path_no_extension
    //
    #[test]
    fn test_conflict_copy_path_no_extension() {
        assert_eq!(make_conflict_copy_path("/docs/Makefile"), "/docs/Makefile (conflict copy)");
    }

    //
    // test_conflict_copy_path_nested
    //
    #[test]
    fn test_conflict_copy_path_nested() {
        assert_eq!(
            make_conflict_copy_path("/deep/nested/data.csv"),
            "/deep/nested/data (conflict copy).csv"
        );
    }
}
