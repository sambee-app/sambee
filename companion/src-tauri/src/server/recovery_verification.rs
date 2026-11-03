//! Fixture-only local API controls, excluded from ordinary and release builds.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::{routing::post, Json, Router};
use serde_json::{json, Value};

use super::AppState;

pub(super) const ROOT_ENV: &str = "SAMBEE_RECOVERY_ROOT";
const TOKEN_ENV: &str = "SAMBEE_RECOVERY_TOKEN";
const TOKEN_HEADER: &str = "x-recovery-token";
const DRIVE: &str = "recovery-verification";
const SHUTDOWN_RESPONSE_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

fn fixture(headers: &HeaderMap) -> Result<PathBuf, (StatusCode, &'static str)> {
    let token = std::env::var(TOKEN_ENV).map_err(|_| (StatusCode::NOT_FOUND, "Verification is not configured."))?;
    if token.is_empty() || headers.get(TOKEN_HEADER).and_then(|value| value.to_str().ok()) != Some(token.as_str()) {
        return Err((StatusCode::UNAUTHORIZED, "Verification token is not valid."));
    }
    std::env::var_os(ROOT_ENV)
        .map(PathBuf::from)
        .ok_or((StatusCode::NOT_FOUND, "Verification fixture is not configured."))
}

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/__verification/{action}", post(control))
}

async fn control(
    State(state): State<Arc<AppState>>,
    Path(action): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, String)> {
    let root = fixture(&headers).map_err(|(status, message)| (status, message.to_owned()))?;
    let failure = |_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Verification operation failed. Inspect the recovery report.".to_owned(),
        )
    };
    match action.as_str() {
        "search" => {
            let response = state
                .directory_indexes
                .search(DRIVE.into(), root, "reports".into(), false)
                .await
                .map_err(failure)?;
            return Ok(Json(json!(response)));
        }
        "lose" | "restore" => state
            .directory_indexes
            .verification_watcher_loss(DRIVE, action == "restore")
            .map_err(failure)?,
        "subscribe" => state
            .watcher
            .subscribe(DRIVE, "", &root)
            .await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Fixture subscription failed.".into()))?,
        "unsubscribe" => state.watcher.unsubscribe(DRIVE, "").await,
        "stop" | "shutdown" => {
            if !state.directory_indexes.verification_stop(DRIVE).map_err(failure)? {
                return Ok(Json(json!({"stopped": false})));
            }
            state.watcher.unsubscribe(DRIVE, "").await;
            if action == "shutdown" {
                let app = state.app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(SHUTDOWN_RESPONSE_DELAY).await;
                    app.exit(0);
                });
            }
            return Ok(Json(json!({"stopped": true})));
        }
        _ => return Err((StatusCode::NOT_FOUND, "Unknown verification action.".into())),
    }
    Ok(Json(
        json!({"ok": true, "subscriptions": state.watcher.verification_subscription_count().await}),
    ))
}
