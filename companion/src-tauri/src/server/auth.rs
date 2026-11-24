//! HMAC-SHA256 authentication middleware for the local API server.
//!
//! Validates requests by checking the `X-Companion-Secret` header, which
//! must contain `HMAC-SHA256(shared_secret, timestamp)`, and the
//! `X-Companion-Timestamp` header which carries the timestamp string.
//! Requests with timestamps deviating more than 30 seconds are rejected.
//!
//! Viewer endpoints also support query-parameter auth (`hmac` + `ts` params)
//! for use in `<img src>` / `<iframe>` contexts where headers can't be set.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::Request;
use axum::http::Uri;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use log::warn;
use serde::Deserialize;
use sha2::Sha256;
use url::Url;

use super::errors::ApiError;
use super::pairing::PairingState;
use super::AppState;

/// Name of the header carrying the HMAC value.
const SECRET_HEADER: &str = "x-companion-secret";

/// Name of the header carrying the timestamp used in the HMAC.
const TIMESTAMP_HEADER: &str = "x-companion-timestamp";

/// Maximum clock skew allowed (seconds).
const MAX_TIMESTAMP_SKEW: u64 = 30;

pub(super) const AUTH_PROTOCOL_VERSION: u32 = 2;
pub(super) const AUTH_SIGNATURE_MISMATCH_CODE: &str = "companion_auth_signature_mismatch";
pub(super) const BROWSER_UPDATE_REQUIRED_CODE: &str = "companion_browser_update_required";
pub(super) const PAIRING_NOT_FOUND_CODE: &str = "companion_pairing_not_found";

/// Request context included in authentication warning logs.
pub(super) struct AuthLogContext<'a> {
    pub(super) auth_transport: &'a str,
    pub(super) method: &'a str,
    pub(super) path: &'a str,
}

/// Query parameters for viewer URL auth (fallback when headers aren't set).
#[derive(Deserialize, Default)]
struct AuthQueryParams {
    hmac: Option<String>,
    ts: Option<String>,
    /// Origin identifier for query-param auth (the paired origin).
    origin: Option<String>,
}

/// Cached HMAC validation state (holds no secrets itself — retrieves from keychain on demand).
pub struct AuthState {
    // No persistent state needed — secrets are in the keychain
    // and origins are validated per-request.
}

impl AuthState {
    pub fn new() -> Self {
        Self {}
    }
}

/// Parse and normalize a browser origin to its exact serialized form.
pub fn normalize_browser_origin(origin: &str) -> Option<String> {
    let Ok(url) = Url::parse(origin) else {
        return None;
    };

    match url.scheme() {
        "http" | "https" => Some(url.origin().ascii_serialization()),
        _ => None,
    }
}

/// Return true for local development origins served from loopback hosts.
pub fn is_loopback_dev_origin(origin: &str) -> bool {
    let Some(normalized_origin) = normalize_browser_origin(origin) else {
        return false;
    };

    let Ok(url) = Url::parse(&normalized_origin) else {
        return false;
    };

    let Some(host) = url.host_str() else {
        return false;
    };

    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// Return true when the origin is a valid browser origin that may access the localhost API via CORS.
pub fn is_allowed_browser_origin_for_cors(origin: &str) -> bool {
    if is_loopback_dev_origin(origin) {
        return true;
    }

    normalize_browser_origin(origin).is_some()
}

/// Parse and normalize a browser origin or reject it as invalid.
pub fn require_normalized_browser_origin(origin: &str) -> Result<String, ApiError> {
    normalize_browser_origin(origin)
        .ok_or_else(|| ApiError::Forbidden("Origin is not allowed to access the companion bootstrap API".to_string()))
}

fn signature_payload(origin: &str, timestamp: &str, method: &str, uri: &Uri) -> String {
    let mut parameters: Vec<(String, String)> = url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .filter(|(key, _)| !matches!(key.as_ref(), "hmac" | "ts" | "origin"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    parameters.sort();
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(parameters.iter().map(|(key, value)| (key, value)))
        .finish();
    let target = if query.is_empty() {
        uri.path().to_string()
    } else {
        format!("{}?{query}", uri.path())
    };
    format!("{origin}\n{timestamp}\n{method}\n{target}")
}

fn is_legacy_browser_signature(secret: &str, timestamp: &str, signature: &str) -> bool {
    let Ok(signature_bytes) = hex::decode(signature) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(timestamp.as_bytes());
    mac.verify_slice(&signature_bytes).is_ok()
}

/// Axum middleware that validates HMAC-authenticated requests.
///
/// Extracts the `Origin` header to determine which pairing secret to use,
/// then verifies the HMAC in `X-Companion-Secret` against the shared secret.
pub async fn require_auth(State(pairing): State<Arc<PairingState>>, request: Request<axum::body::Body>, next: Next) -> Response {
    let log_context = AuthLogContext {
        auth_transport: "header",
        method: request.method().as_str(),
        path: request.uri().path(),
    };

    match extract_auth_credentials(&request) {
        Ok((origin, hmac_value, timestamp_str)) => {
            match validate_hmac(&pairing, &origin, &hmac_value, &timestamp_str, request.uri(), &log_context) {
                Ok(()) => next.run(request).await,
                Err(e) => e.into_response(),
            }
        }
        Err(e) => e.into_response(),
    }
}

/// Axum middleware that validates requests via headers OR query-param fallback.
///
/// First tries header-based auth (Origin + X-Companion-Secret + X-Companion-Timestamp).
/// If headers are missing, falls back to query params (`hmac`, `ts`, `origin`).
/// Used for viewer endpoints where the URL is used in `<img src>` attributes.
pub async fn require_auth_or_query(State(state): State<Arc<AppState>>, request: Request<axum::body::Body>, next: Next) -> Response {
    // Try header-based auth first
    let header_log_context = AuthLogContext {
        auth_transport: "header",
        method: request.method().as_str(),
        path: request.uri().path(),
    };
    if let Ok((origin, hmac_value, timestamp_str)) = extract_auth_credentials(&request) {
        return match validate_hmac(
            &state.pairing,
            &origin,
            &hmac_value,
            &timestamp_str,
            request.uri(),
            &header_log_context,
        ) {
            Ok(()) => next.run(request).await,
            Err(e) => e.into_response(),
        };
    }

    // Fall back to query-param auth
    let query: AuthQueryParams = Query::try_from_uri(request.uri()).map(|q| q.0).unwrap_or_default();

    let Some(hmac_value) = query.hmac else {
        return ApiError::Forbidden("Missing authentication (headers or query params)".to_string()).into_response();
    };

    let Some(timestamp_str) = query.ts else {
        return ApiError::Forbidden("Missing timestamp in query params".to_string()).into_response();
    };

    // For query-param auth, we need the origin in the query string since
    // browser resource requests (img src) don't include Origin headers.
    let origin = query.origin.unwrap_or_default();
    if origin.is_empty() {
        return ApiError::Forbidden("Missing origin in query params".to_string()).into_response();
    }

    let query_log_context = AuthLogContext {
        auth_transport: "query",
        method: request.method().as_str(),
        path: request.uri().path(),
    };

    match validate_hmac(
        &state.pairing,
        &origin,
        &hmac_value,
        &timestamp_str,
        request.uri(),
        &query_log_context,
    ) {
        Ok(()) => next.run(request).await,
        Err(e) => e.into_response(),
    }
}

/// Extract auth credentials from request headers.
fn extract_auth_credentials(request: &Request<axum::body::Body>) -> Result<(String, String, String), ApiError> {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .and_then(normalize_browser_origin)
        .ok_or_else(|| ApiError::Forbidden("Missing Origin header".to_string()))?;

    let hmac_value = request
        .headers()
        .get(SECRET_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::Forbidden("Missing X-Companion-Secret header".to_string()))?;

    let timestamp_str = request
        .headers()
        .get(TIMESTAMP_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::Forbidden("Missing X-Companion-Timestamp header".to_string()))?;

    Ok((origin, hmac_value, timestamp_str))
}

/// Validate HMAC credentials against the stored secret for an origin.
///
/// Called from middleware and also from the WebSocket upgrade handler.
pub(super) fn validate_hmac_public(
    state: &AppState,
    origin: &str,
    hmac_value: &str,
    timestamp_str: &str,
    uri: &Uri,
    log_context: &AuthLogContext,
) -> Result<(), ApiError> {
    validate_hmac(&state.pairing, origin, hmac_value, timestamp_str, uri, log_context)
}

/// Validate HMAC credentials against the stored secret for an origin.
fn validate_hmac(
    pairing: &PairingState,
    origin: &str,
    hmac_value: &str,
    timestamp_str: &str,
    uri: &Uri,
    log_context: &AuthLogContext,
) -> Result<(), ApiError> {
    let origin = require_normalized_browser_origin(origin)?;

    // Get shared secret for this origin from pairing state
    let secret = pairing.get_secret_for_origin(&origin).ok_or_else(|| {
        warn!(
            "Auth rejected: no pairing found for origin {origin}; transport={}; method={}; path={}",
            log_context.auth_transport, log_context.method, log_context.path,
        );
        ApiError::forbidden_code("Not paired with this origin", PAIRING_NOT_FOUND_CODE)
    })?;

    // Validate timestamp (within ±MAX_TIMESTAMP_SKEW seconds)
    let timestamp: u64 = timestamp_str
        .parse()
        .map_err(|_| ApiError::Forbidden("Invalid timestamp format".to_string()))?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let diff = now.abs_diff(timestamp);

    if diff > MAX_TIMESTAMP_SKEW {
        let direction = if timestamp > now { "future" } else { "past" };
        warn!(
            "Auth rejected: timestamp skew {diff}s exceeds {MAX_TIMESTAMP_SKEW}s; transport={}; method={}; path={}; origin={origin}; server_ts={now}; request_ts={timestamp}; direction={direction}",
            log_context.auth_transport,
            log_context.method,
            log_context.path,
        );
        return Err(ApiError::Forbidden("Request timestamp too old or too new".to_string()));
    }

    // Verify HMAC.
    // The secret is a hex string (e.g. "a1b2c3..."). Both sides use the
    // UTF-8 bytes of this string as the HMAC key (matching the frontend's
    // `TextEncoder.encode(secret)`).
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| ApiError::Internal("HMAC initialization failed".to_string()))?;
    mac.update(signature_payload(&origin, timestamp_str, log_context.method, uri).as_bytes());

    let expected = hex::encode(mac.finalize().into_bytes());

    if expected != hmac_value {
        if is_legacy_browser_signature(&secret, timestamp_str, hmac_value) {
            warn!(
                "Auth rejected: outdated browser signature for origin {origin}; transport={}; method={}; path={}",
                log_context.auth_transport, log_context.method, log_context.path,
            );
            return Err(ApiError::forbidden_code(
                "Sambee browser is out of date. Reload the page.",
                BROWSER_UPDATE_REQUIRED_CODE,
            ));
        }
        warn!(
            "Auth rejected: HMAC mismatch for origin {origin}; transport={}; method={}; path={}; server_ts={now}; request_ts={timestamp}",
            log_context.auth_transport, log_context.method, log_context.path,
        );
        return Err(ApiError::forbidden_code("Invalid authentication", AUTH_SIGNATURE_MISMATCH_CODE));
    }

    if !pairing.is_origin_paired(&origin) {
        pairing.record_verified_origin(
            &origin,
            crate::server::pairing::VerifiedOriginRecordReason::RecoveredFromAuthenticatedRequest,
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        is_allowed_browser_origin_for_cors, is_legacy_browser_signature, is_loopback_dev_origin, normalize_browser_origin,
        signature_payload,
    };
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    #[test]
    fn signature_is_scoped_to_method_path_and_query() {
        let uri = "/api/viewer/root/file?path=notes%2Fone.txt&origin=https%3A%2F%2Fexample.test&ts=123&hmac=secret"
            .parse()
            .unwrap();
        assert_eq!(
            signature_payload("https://example.test", "123", "GET", &uri),
            "https://example.test\n123\nGET\n/api/viewer/root/file?path=notes%2Fone.txt"
        );
        assert_ne!(
            signature_payload("https://example.test", "123", "GET", &uri),
            signature_payload("https://example.test", "123", "DELETE", &uri)
        );
    }

    #[test]
    fn signature_matches_browser_test_vector() {
        let uri = "/api/viewer/root/file?z=2&A=1".parse().unwrap();
        let mut mac = Hmac::<Sha256>::new_from_slice(b"shared-secret").unwrap();
        mac.update(signature_payload("http://localhost:3000", "1700000000", "GET", &uri).as_bytes());
        assert_eq!(
            hex::encode(mac.finalize().into_bytes()),
            "2213e964861fc8d4db9ae41c96188ce038ed113c0d064d8d6c96c5314c033d33"
        );
    }

    #[test]
    fn identifies_legacy_browser_signature_without_accepting_it_as_current() {
        let mut mac = Hmac::<Sha256>::new_from_slice(b"shared-secret").unwrap();
        mac.update(b"1700000000");
        let legacy_signature = hex::encode(mac.finalize().into_bytes());

        assert!(is_legacy_browser_signature("shared-secret", "1700000000", &legacy_signature));
        assert!(!is_legacy_browser_signature("other-secret", "1700000000", &legacy_signature));
        assert!(!is_legacy_browser_signature("shared-secret", "1700000001", &legacy_signature));
        assert!(!is_legacy_browser_signature("shared-secret", "1700000000", "invalid"));
    }

    #[test]
    fn normalizes_browser_origins_exactly() {
        assert_eq!(
            normalize_browser_origin("https://Sambee.Example.com:8443").as_deref(),
            Some("https://sambee.example.com:8443")
        );
        assert_eq!(
            normalize_browser_origin("http://localhost:5173").as_deref(),
            Some("http://localhost:5173")
        );
    }

    #[test]
    fn recognizes_typical_loopback_dev_origins() {
        assert!(is_loopback_dev_origin("http://localhost:5173"));
        assert!(is_loopback_dev_origin("http://127.0.0.1:3000"));
        assert!(is_loopback_dev_origin("https://localhost:8443"));
        assert!(!is_loopback_dev_origin("https://sambee.example.com"));
    }

    #[test]
    fn cors_allows_valid_browser_origins_and_rejects_non_http_origins() {
        assert!(is_allowed_browser_origin_for_cors("https://sambee.example.com"));
        assert!(is_allowed_browser_origin_for_cors("http://127.0.0.1:5173"));
        assert!(!is_allowed_browser_origin_for_cors("file:///tmp/index.html"));
        assert!(!is_allowed_browser_origin_for_cors("not-an-origin"));
    }
}
