//! Reverse-proxy authentication via a Companion-owned Tauri webview.
//!
//! This is used only when token exchange indicates that an interactive proxy or
//! SSO layer intercepted the backend API request. The user authenticates in the
//! webview, then Rust reads the webview cookie store and seeds the shared
//! reqwest client store.

use std::fmt;
use std::future::Future;

use log::{debug, info, warn};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::http_client::{is_proxy_auth_required_error, SambeeHttpClientStore};

pub(crate) const PROXY_AUTH_WINDOW_LABEL: &str = "proxy-auth";
const PROXY_AUTH_WINDOW_WIDTH: f64 = 720.0;
const PROXY_AUTH_WINDOW_HEIGHT: f64 = 760.0;
const PROXY_AUTH_TIMEOUT_SECS: u64 = 300;
const PROXY_AUTH_POLL_MS: u64 = 500;
const PROXY_AUTH_CHECK_PATH: &str = "/api/companion/proxy-auth-check";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyAuthRetryError {
    Operation(String),
    Authentication(String),
    StillBlockedAfterReauth { operation_name: String },
}

impl ProxyAuthRetryError {
    pub fn is_still_blocked_after_reauth(&self) -> bool {
        matches!(self, Self::StillBlockedAfterReauth { .. })
    }

    pub fn should_abort_safety_check(&self) -> bool {
        matches!(self, Self::Authentication(_) | Self::StillBlockedAfterReauth { .. })
    }

    pub fn into_user_message(self) -> String {
        match self {
            Self::Operation(message) | Self::Authentication(message) => message,
            Self::StillBlockedAfterReauth { operation_name } => still_blocked_after_reauth_message(&operation_name),
        }
    }
}

impl From<ProxyAuthRetryError> for String {
    fn from(error: ProxyAuthRetryError) -> Self {
        error.into_user_message()
    }
}

impl fmt::Display for ProxyAuthRetryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Operation(message) | Self::Authentication(message) => formatter.write_str(message),
            Self::StillBlockedAfterReauth { operation_name } => formatter.write_str(&still_blocked_after_reauth_message(operation_name)),
        }
    }
}

fn still_blocked_after_reauth_message(operation_name: &str) -> String {
    format!(
        "{operation_name} still could not reach the Sambee backend after reauthentication. Check the reverse proxy cookie domain and path settings."
    )
}

/// Open an auth webview and store backend-origin cookies when auth completes.
pub async fn authenticate_reverse_proxy(
    app: &tauri::AppHandle,
    server_url: &str,
    http_clients: &SambeeHttpClientStore,
) -> Result<(), String> {
    let probe_url = build_probe_url(server_url)?;
    let probe = url::Url::parse(&probe_url).map_err(|e| format!("Invalid proxy auth probe URL '{probe_url}': {e}"))?;

    if let Some(existing) = app.get_webview_window(PROXY_AUTH_WINDOW_LABEL) {
        let _ = existing.destroy();
    }

    info!("Opening reverse-proxy authentication window for {server_url}");
    let window = WebviewWindowBuilder::new(app, PROXY_AUTH_WINDOW_LABEL, WebviewUrl::External(probe.clone()))
        .title(crate::native_i18n::NativeLocale::from_app(app).text("authenticationTitle"))
        .inner_size(PROXY_AUTH_WINDOW_WIDTH, PROXY_AUTH_WINDOW_HEIGHT)
        .resizable(true)
        .center()
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to open authentication window: {e}"))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(PROXY_AUTH_TIMEOUT_SECS);

    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(PROXY_AUTH_POLL_MS)).await;

        let Some(current_window) = app.get_webview_window(PROXY_AUTH_WINDOW_LABEL) else {
            return Err("Authentication window was closed before sign-in completed".to_string());
        };

        match current_window.url() {
            Ok(current_url) if same_auth_probe(&current_url, &probe) => {
                let cookies = current_window
                    .cookies_for_url(probe.clone())
                    .map_err(|e| format!("Failed to read authentication cookies from webview: {e}"))?;
                let cookie_count = http_clients.store_webview_cookies(server_url, cookies)?;

                let _ = current_window.destroy();

                if cookie_count == 0 {
                    return Err(
                        "Authentication completed, but no backend cookies were available for Companion requests. Check the reverse proxy cookie domain and path settings."
                            .to_string(),
                    );
                }

                info!("Reverse-proxy authentication completed for {server_url}");
                return Ok(());
            }
            Ok(_) => {}
            Err(e) => warn!("Could not read authentication window URL yet: {e}"),
        }
    }

    let _ = window.destroy();
    Err("Timed out waiting for reverse-proxy authentication to complete".to_string())
}

pub async fn retry_if_proxy_auth_required<T, F, Fut>(
    app: &tauri::AppHandle,
    server_url: &str,
    http_clients: &SambeeHttpClientStore,
    operation_name: &str,
    mut operation: F,
) -> Result<T, ProxyAuthRetryError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    debug!("Starting operation '{operation_name}'");

    match operation().await {
        Ok(result) => {
            debug!("Operation '{operation_name}' completed without reverse-proxy reauthentication");
            Ok(result)
        }
        Err(err) if is_proxy_auth_required_error(&err) => {
            warn!("{operation_name} requires reverse-proxy reauthentication: {err}");
            authenticate_reverse_proxy(app, server_url, http_clients)
                .await
                .map_err(ProxyAuthRetryError::Authentication)?;

            let retry_result = operation().await;
            match &retry_result {
                Ok(_) => debug!("Operation '{operation_name}' completed after reverse-proxy reauthentication"),
                Err(retry_err) => {
                    debug!("Operation '{operation_name}' retry after reverse-proxy reauthentication returned error: {retry_err}")
                }
            }

            classify_after_reauth_retry(operation_name, retry_result)
        }
        Err(err) => {
            debug!("Operation '{operation_name}' failed without triggering reverse-proxy reauthentication: {err}");
            Err(ProxyAuthRetryError::Operation(err))
        }
    }
}

fn classify_after_reauth_retry<T>(operation_name: &str, result: Result<T, String>) -> Result<T, ProxyAuthRetryError> {
    match result {
        Err(retry_err) if is_proxy_auth_required_error(&retry_err) => Err(ProxyAuthRetryError::StillBlockedAfterReauth {
            operation_name: operation_name.to_string(),
        }),
        Ok(result) => Ok(result),
        Err(err) => Err(ProxyAuthRetryError::Operation(err)),
    }
}

fn build_probe_url(server_url: &str) -> Result<String, String> {
    let mut url = url::Url::parse(server_url.trim_end_matches('/')).map_err(|e| format!("Invalid server URL '{server_url}': {e}"))?;
    url.set_path(PROXY_AUTH_CHECK_PATH);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn same_auth_probe(current_url: &url::Url, probe_url: &url::Url) -> bool {
    current_url.scheme() == probe_url.scheme()
        && current_url.host_str() == probe_url.host_str()
        && current_url.port_or_known_default() == probe_url.port_or_known_default()
        && current_url.path() == probe_url.path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_probe_url_replaces_path() {
        let probe = build_probe_url("https://sambee.example.com/app?x=1#frag").unwrap();
        assert_eq!(probe, "https://sambee.example.com/api/companion/proxy-auth-check");
    }

    #[test]
    fn test_same_auth_probe_ignores_query() {
        let probe = url::Url::parse("https://sambee.example.com/api/companion/proxy-auth-check").unwrap();
        let current = url::Url::parse("https://sambee.example.com/api/companion/proxy-auth-check?done=1").unwrap();
        assert!(same_auth_probe(&current, &probe));
    }

    #[test]
    fn test_still_blocked_after_reauth_message_and_helper() {
        let error = ProxyAuthRetryError::StillBlockedAfterReauth {
            operation_name: "File metadata lookup".to_string(),
        };

        assert!(error.is_still_blocked_after_reauth());
        assert!(error.should_abort_safety_check());
        assert_eq!(
            error.to_string(),
            "File metadata lookup still could not reach the Sambee backend after reauthentication. Check the reverse proxy cookie domain and path settings."
        );
    }

    #[test]
    fn test_authentication_error_aborts_safety_check() {
        let error = ProxyAuthRetryError::Authentication("Authentication window was closed before sign-in completed".to_string());

        assert!(error.should_abort_safety_check());
        assert!(!error.is_still_blocked_after_reauth());
    }

    #[test]
    fn test_operation_error_does_not_abort_safety_check() {
        let error = ProxyAuthRetryError::Operation("ordinary metadata failure".to_string());

        assert!(!error.should_abort_safety_check());
        assert!(!error.is_still_blocked_after_reauth());
    }

    #[test]
    fn test_classify_after_reauth_retry_preserves_operation_error() {
        let result = classify_after_reauth_retry::<()>("Conflict check", Err("ordinary failure".to_string()));

        assert_eq!(result, Err(ProxyAuthRetryError::Operation("ordinary failure".to_string())));
    }

    #[test]
    fn test_classify_after_reauth_retry_marks_proxy_auth_failure() {
        let result = classify_after_reauth_retry::<()>(
            "Conflict check",
            Err(crate::http_client::format_proxy_auth_required_message(
                "Conflict check",
                "HTML login page returned",
            )),
        );

        assert_eq!(
            result,
            Err(ProxyAuthRetryError::StillBlockedAfterReauth {
                operation_name: "Conflict check".to_string(),
            })
        );
    }
}
