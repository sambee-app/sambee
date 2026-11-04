use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use log::{info, warn};
use tauri::{AppHandle, Manager};

use super::models::{CompanionLocalizationState, LocalizationSyncRequest};

const LOCALIZATION_STATE_FILE: &str = "browser-localization.json";

#[derive(Default)]
pub struct LocalizationState {
    current: Mutex<Option<CompanionLocalizationState>>,
}

impl LocalizationState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_from_disk(&self, app: &AppHandle) {
        let Some(path) = localization_state_path(app) else {
            return;
        };

        let loaded = match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<CompanionLocalizationState>(&content) {
                Ok(state) => Some(state),
                Err(err) => {
                    warn!("Failed to parse localization state from {}: {err}", path.display());
                    None
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                warn!("Failed to read localization state from {}: {err}", path.display());
                None
            }
        };

        if let Ok(mut current) = self.current.lock() {
            *current = loaded;
        }
    }

    pub fn get_current(&self) -> Option<CompanionLocalizationState> {
        self.current.lock().ok().and_then(|current| current.clone())
    }

    pub fn apply_managed_update(
        &self,
        app: &AppHandle,
        source_origin: &str,
        update: LocalizationSyncRequest,
    ) -> Result<(CompanionLocalizationState, bool), String> {
        let incoming = CompanionLocalizationState {
            language: update.language,
            regional_locale: update.regional_locale,
            updated_at: chrono::DateTime::parse_from_rfc3339(&update.updated_at)
                .map_err(|error| format!("Localization timestamp is invalid. Retry delivery: {error}"))?
                .with_timezone(&Utc),
            source_origin: source_origin.to_owned(),
        };
        let mut current = self
            .current
            .lock()
            .map_err(|_| "Localization state is unavailable. Restart the Companion.".to_owned())?;
        persist_state(app, &incoming)?;
        *current = Some(incoming.clone());
        info!("Applied managed localization from {source_origin}");
        Ok((incoming, true))
    }
}

fn localization_state_path(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().app_data_dir().ok()?;
    Some(path.join(LOCALIZATION_STATE_FILE))
}

fn persist_state(app: &AppHandle, state: &CompanionLocalizationState) -> Result<(), String> {
    let path = localization_state_path(app).ok_or_else(|| "Failed to resolve app data directory".to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create localization state directory: {err}"))?;
    }

    let serialized = serde_json::to_string_pretty(state).map_err(|err| format!("Failed to serialize localization state: {err}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "Localization storage has no parent. Check application storage.".to_owned())?;
    let mut stage =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| format!("Localization staging file cannot be created: {error}"))?;
    stage
        .write_all(serialized.as_bytes())
        .and_then(|_| stage.as_file().sync_all())
        .map_err(|error| format!("Localization cannot be written durably. Check application storage: {error}"))?;
    stage
        .persist(&path)
        .map_err(|error| format!("Localization cannot be selected. Check application storage: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, TimeZone};

    fn build_state(language: &str, regional_locale: &str, updated_at: DateTime<Utc>, source_origin: &str) -> CompanionLocalizationState {
        CompanionLocalizationState {
            language: language.to_string(),
            regional_locale: regional_locale.to_string(),
            updated_at,
            source_origin: source_origin.to_string(),
        }
    }

    #[test]
    fn newer_timestamp_wins() {
        let state = LocalizationState::new();
        let old = build_state(
            "en",
            "en-US",
            Utc.with_ymd_and_hms(2026, 3, 22, 10, 0, 0).unwrap(),
            "https://old.test",
        );
        let new = build_state(
            "en-XA",
            "en-GB",
            Utc.with_ymd_and_hms(2026, 3, 22, 10, 5, 0).unwrap(),
            "https://new.test",
        );

        *state.current.lock().unwrap() = Some(old);

        let current = state.current.lock().unwrap().clone().unwrap();
        assert_eq!(current.language, "en");

        {
            let mut slot = state.current.lock().unwrap();
            let existing = slot.as_ref().unwrap();
            assert!(existing.updated_at < new.updated_at);
            *slot = Some(new.clone());
        }

        assert_eq!(state.get_current(), Some(new));
    }

    #[test]
    fn older_timestamp_is_ignored() {
        let state = LocalizationState::new();
        let current = build_state(
            "en-XA",
            "ja-JP",
            Utc.with_ymd_and_hms(2026, 3, 22, 11, 0, 0).unwrap(),
            "https://current.test",
        );
        let stale = build_state(
            "en",
            "en-US",
            Utc.with_ymd_and_hms(2026, 3, 22, 10, 0, 0).unwrap(),
            "https://stale.test",
        );

        *state.current.lock().unwrap() = Some(current.clone());

        let existing = state.get_current().unwrap();
        assert!(existing.updated_at > stale.updated_at);
        assert_eq!(existing, current);
    }
}
