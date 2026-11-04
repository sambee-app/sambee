use std::collections::BTreeMap;

use super::*;
use crate::server::localization::LocalizationState;
use crate::server::models::LocalizationSyncRequest;
use crate::server::pairing::{PairingState, SettingsAuthority};
use crate::ThemeState;
use base64::Engine;
use tauri::Emitter;

const SETTINGS_VERSION: u32 = 1;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PrimaryColor {
    main: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    id: String,
    mode: String,
    primary: PrimaryColor,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Localization {
    language: String,
    regional_locale: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Section<T> {
    version: u32,
    marker: String,
    user_scope: Option<String>,
    pub(super) payload: T,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Applied<T> {
    pub(super) section: Section<T>,
    origin: String,
    backend_identity: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedSettings {
    theme: Option<Applied<Theme>>,
    localization: Option<Applied<Localization>>,
    pub(super) directory_index: Option<Applied<DirectoryPolicy>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    companion_id: uuid::Uuid,
    challenge: String,
    origin: String,
    backend_identity: String,
    switch_user: bool,
    theme: Option<Section<Theme>>,
    localization: Option<Section<Localization>>,
    directory_index: Option<Section<DirectoryPolicy>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsGrantDelivery {
    pub version: u32,
    pub grant: String,
}

#[derive(Serialize)]
pub struct SectionStatus {
    version: u32,
    marker: String,
    user_scope: Option<String>,
    origin: String,
    backend_identity: String,
    result: &'static str,
}

#[derive(Serialize)]
pub struct CompanionSettingsStatus {
    version: u32,
    companion_id: uuid::Uuid,
    status: &'static str,
    authoritative_origin: Option<String>,
    authority_generation: u64,
    challenge: Option<String>,
    sections: BTreeMap<&'static str, SectionStatus>,
    results: BTreeMap<&'static str, &'static str>,
    message: Option<String>,
}

fn status_of<T>(applied: &Applied<T>) -> SectionStatus {
    SectionStatus {
        version: applied.section.version,
        marker: applied.section.marker.clone(),
        user_scope: applied.section.user_scope.clone(),
        origin: applied.origin.clone(),
        backend_identity: applied.backend_identity.clone(),
        result: "synchronized",
    }
}

fn validate_marker<T>(section: &Section<T>, user: bool) -> Result<(), ApiError> {
    if section.version != SETTINGS_VERSION {
        return Err(failure(
            "Settings section version is unsupported. Update the browser and Companion.",
        ));
    }
    if user {
        if section.marker.len() != 64
            || !section.marker.bytes().all(|byte| byte.is_ascii_hexdigit())
            || section
                .user_scope
                .as_ref()
                .is_none_or(|scope| uuid::Uuid::parse_str(scope).is_err())
        {
            return Err(failure("User settings marker or scope is invalid. Request a new grant."));
        }
    } else if section.user_scope.is_some()
        || section
            .marker
            .parse::<i64>()
            .ok()
            .is_none_or(|revision| !(0..=MAX_WIRE_INTEGER).contains(&revision))
    {
        return Err(failure("Directory settings revision is invalid. Request a new grant."));
    }
    Ok(())
}

fn require_authority<'a>(
    pairing: &'a PairingState,
    origin: &str,
    generation: Option<u64>,
) -> Result<MutexGuard<'a, SettingsAuthority>, ApiError> {
    let authority = pairing.settings_authority().map_err(|message| failure(&message))?;
    if authority.origin.as_deref() != Some(origin)
        || !pairing.is_origin_paired(origin)
        || generation.is_some_and(|generation| generation != authority.generation)
    {
        return Err(ApiError::ConflictWithCode {
            code: "settings_authority_conflict",
            message: format!(
                "Settings authority is {}. Pair the intended server again or refresh settings status.",
                authority.origin.as_deref().unwrap_or("not selected")
            ),
        });
    }
    Ok(authority)
}

fn directory_section_changed(
    old: Option<&Applied<DirectoryPolicy>>,
    section: &Section<DirectoryPolicy>,
    origin: &str,
    identity: &str,
) -> Result<bool, ApiError> {
    let Some(old) = old.filter(|old| old.origin == origin && old.backend_identity == identity) else {
        return Ok(true);
    };
    if old.section.marker.parse::<i64>().ok() > section.marker.parse::<i64>().ok() {
        return Err(failure("Directory policy revision moved backwards. Refresh server policy."));
    }
    if old.section.marker == section.marker {
        if old.section.payload != section.payload {
            return Err(failure("Directory policy changed without a revision. Correct server policy."));
        }
        return Ok(false);
    }
    Ok(true)
}

impl Receipt {
    fn validate(&self) -> Result<(), ApiError> {
        validate_origin(&self.origin)?;
        if self.version != SETTINGS_VERSION
            || self.backend_identity.len() != 64
            || !self.backend_identity.bytes().all(|byte| byte.is_ascii_hexdigit())
            || (self.theme.is_none() && self.localization.is_none() && self.directory_index.is_none())
        {
            return Err(failure(
                "Settings receipt is invalid or unsupported. Update the browser and Companion, then retry.",
            ));
        }
        if let Some(section) = &self.theme {
            validate_marker(section, true)?;
            let theme = &section.payload;
            let color = theme.primary.main.as_bytes();
            if theme.id.is_empty()
                || theme.id.len() > 128
                || !matches!(theme.mode.as_str(), "light" | "dark")
                || !matches!(color.len(), 7 | 9)
                || color[0] != b'#'
                || !color[1..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err(failure("Theme settings are invalid. Correct the server theme and retry."));
            }
        }
        if let Some(section) = &self.localization {
            validate_marker(section, true)?;
            let locale = &section.payload.regional_locale;
            if !matches!(section.payload.language.as_str(), "browser" | "en" | "en-XA")
                || locale.is_empty()
                || locale.len() > 128
                || (locale != "browser"
                    && !locale.split('-').enumerate().all(|(index, part)| {
                        (if index == 0 {
                            (2..=3).contains(&part.len())
                        } else {
                            (2..=8).contains(&part.len())
                        }) && part.bytes().all(|byte| {
                            if index == 0 {
                                byte.is_ascii_alphabetic()
                            } else {
                                byte.is_ascii_alphanumeric()
                            }
                        })
                    }))
            {
                return Err(failure(
                    "Localization settings are invalid. Correct the server preferences and retry.",
                ));
            }
        }
        if let (Some(theme), Some(localization)) = (&self.theme, &self.localization) {
            if theme.user_scope != localization.user_scope {
                return Err(failure("User settings sections have different scopes. Request a new grant."));
            }
        }
        if let Some(section) = &self.directory_index {
            validate_marker(section, false)?;
            section
                .payload
                .validate()
                .map_err(|_| failure("Directory settings are invalid. Correct server policy and retry."))?;
        }
        Ok(())
    }
}

impl ManagedSettings {
    fn validate_user_update(&self, receipt: &Receipt) -> Result<(), ApiError> {
        let scope = self
            .theme
            .as_ref()
            .and_then(|section| section.section.user_scope.as_ref())
            .or_else(|| self.localization.as_ref().and_then(|section| section.section.user_scope.as_ref()));
        let incoming_scope = receipt
            .theme
            .as_ref()
            .and_then(|section| section.user_scope.as_ref())
            .or_else(|| receipt.localization.as_ref().and_then(|section| section.user_scope.as_ref()));
        let same_server = self
            .theme
            .as_ref()
            .is_some_and(|section| section.origin == receipt.origin && section.backend_identity == receipt.backend_identity)
            || self
                .localization
                .as_ref()
                .is_some_and(|section| section.origin == receipt.origin && section.backend_identity == receipt.backend_identity);
        if same_server && scope.is_some() && incoming_scope.is_some() && scope != incoming_scope && !receipt.switch_user {
            return Err(ApiError::ConflictWithCode {
                code: "settings_user_scope_conflict",
                message: "Background delivery cannot change the active user. Sign in again or change a preference.".to_owned(),
            });
        }
        Ok(())
    }

    pub(super) fn validate(&self) -> Result<(), ApiError> {
        let empty = |origin: &str, identity: &str| Receipt {
            version: SETTINGS_VERSION,
            companion_id: uuid::Uuid::nil(),
            challenge: String::new(),
            origin: origin.to_owned(),
            backend_identity: identity.to_owned(),
            switch_user: false,
            theme: None,
            localization: None,
            directory_index: None,
        };
        if let Some(applied) = &self.theme {
            Receipt {
                theme: Some(applied.section.clone()),
                ..empty(&applied.origin, &applied.backend_identity)
            }
            .validate()?;
        }
        if let Some(applied) = &self.localization {
            Receipt {
                localization: Some(applied.section.clone()),
                ..empty(&applied.origin, &applied.backend_identity)
            }
            .validate()?;
        }
        if let Some(applied) = &self.directory_index {
            Receipt {
                directory_index: Some(applied.section.clone()),
                ..empty(&applied.origin, &applied.backend_identity)
            }
            .validate()?;
        }
        Ok(())
    }
}

impl DirectoryPolicyState {
    pub fn restore_managed(&self, app: &AppHandle, pairing: &PairingState, localization: &LocalizationState) -> Result<(), ApiError> {
        let state = self.available_state()?;
        let legacy = state
            .stored
            .managed
            .directory_index
            .as_ref()
            .map(|section| section.origin.as_str())
            .or_else(|| state.stored.approved.as_ref().map(|receipt| receipt.origin.as_str()));
        pairing.migrate_settings_authority(legacy).map_err(|message| failure(&message))?;
        let managed_theme = state.stored.managed.theme.is_some();
        drop(state);
        let result = self.restore_user_sections(
            |theme| {
                app.state::<ThemeState>()
                    .set_managed(app, encode_theme(theme)?)
                    .map_err(|message| failure(&message))
            },
            |origin, payload| apply_localization(app, localization, origin, payload),
        );
        app.state::<ThemeState>().initialize_managed_theme(managed_theme);
        result
    }

    fn restore_user_sections(
        &self,
        apply_theme: impl FnOnce(&Theme) -> Result<(), ApiError>,
        apply_locale: impl FnOnce(&str, &Localization) -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        let mut state = self.available_state()?;
        let mut first_error = None;
        let theme_result = state
            .stored
            .managed
            .theme
            .as_ref()
            .map(|section| apply_theme(&section.section.payload));
        let locale_result = state
            .stored
            .managed
            .localization
            .as_ref()
            .map(|section| apply_locale(&section.origin, &section.section.payload));
        for (name, result) in [("theme", theme_result), ("localization", locale_result)] {
            match result {
                Some(Ok(())) => {
                    state.failed_sections.remove(name);
                }
                Some(Err(error)) => {
                    state.failed_sections.insert(name, error.to_string());
                    first_error.get_or_insert(error);
                }
                None => {}
            }
        }
        state.message = state.failed_sections.values().next().cloned();
        state.status = if state.failed_sections.is_empty() {
            "applied"
        } else {
            "settings_failed"
        };
        first_error.map_or(Ok(()), Err)
    }

    pub fn settings_status(&self, origin: Option<&str>, pairing: &PairingState) -> Result<CompanionSettingsStatus, ApiError> {
        let authority = pairing.settings_authority().map_err(|message| failure(&message))?;
        let state = self.available_state()?;
        let pending = self
            .settings_pending
            .lock()
            .map_err(|_| failure("Settings challenge is unavailable. Restart the Companion."))?;
        let challenge = pending
            .as_ref()
            .filter(|(_, pending_origin, generation, created)| {
                origin == Some(pending_origin.as_str())
                    && authority.origin.as_deref() == origin
                    && *generation == authority.generation
                    && created.elapsed() < CHALLENGE_TIMEOUT
            })
            .map(|(value, _, _, _)| value.clone());
        let mut sections = BTreeMap::new();
        if let Some(section) = &state.stored.managed.theme {
            sections.insert("theme", status_of(section));
        }
        if let Some(section) = &state.stored.managed.localization {
            sections.insert("localization", status_of(section));
        }
        if let Some(section) = &state.stored.managed.directory_index {
            sections.insert("directory_index", status_of(section));
        }
        let results = ["theme", "localization", "directory_index"]
            .into_iter()
            .map(|name| {
                let result = if state.failed_sections.contains_key(name) {
                    "delivery_failed"
                } else if sections.contains_key(name) {
                    "synchronized"
                } else {
                    "defaults_active"
                };
                if let Some(section) = sections.get_mut(name) {
                    section.result = result;
                }
                (name, result)
            })
            .collect();
        Ok(CompanionSettingsStatus {
            version: SETTINGS_VERSION,
            companion_id: state.stored.companion_id,
            status: if state.blocked {
                "delivery_failed"
            } else if origin.is_some() && authority.origin.as_deref() != origin {
                "authority_conflict"
            } else if state.status == "settings_failed" || !state.failed_sections.is_empty() {
                "delivery_failed"
            } else if sections.is_empty() {
                "defaults_active"
            } else {
                "synchronized"
            },
            authoritative_origin: authority.origin.clone(),
            authority_generation: authority.generation,
            challenge,
            sections,
            results,
            message: state.message.clone(),
        })
    }

    pub fn settings_challenge(&self, origin: &str, pairing: &PairingState) -> Result<CompanionSettingsStatus, ApiError> {
        validate_origin(origin)?;
        {
            let authority = require_authority(pairing, origin, None)?;
            let state = self.available_state()?;
            if state.blocked {
                return Err(failure(
                    "Settings storage is invalid. Restore private settings storage and restart the Companion.",
                ));
            }
            let mut pending = self
                .settings_pending
                .lock()
                .map_err(|_| failure("Settings challenge is unavailable. Restart the Companion."))?;
            *pending = Some((
                format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
                origin.to_owned(),
                authority.generation,
                Instant::now(),
            ));
        }
        self.settings_status(Some(origin), pairing)
    }

    pub async fn redeem_settings(
        self: &Arc<Self>,
        origin: &str,
        delivery: SettingsGrantDelivery,
        pairing: &PairingState,
        app: &AppHandle,
        localization: &LocalizationState,
    ) -> Result<CompanionSettingsStatus, ApiError> {
        if delivery.version != SETTINGS_VERSION {
            return Err(ApiError::bad_request_code(
                "Settings protocol is unsupported. Update the browser and Companion.",
                "settings_update_required",
            ));
        }
        if delivery.grant.is_empty() || delivery.grant.len() > MAX_GRANT_BYTES {
            return Err(failure("Settings grant size is invalid. Request a new grant."));
        }
        let _redemption = self.redemption.lock().await;
        let (challenge, generation, companion_id) = {
            let authority = require_authority(pairing, origin, None)?;
            let state = self.available_state()?;
            let mut pending = self
                .settings_pending
                .lock()
                .map_err(|_| failure("Settings challenge is unavailable. Restart the Companion."))?;
            let (challenge, pending_origin, generation, created) = pending
                .take()
                .ok_or_else(|| failure("Settings challenge is missing. Request a new challenge."))?;
            if pending_origin != origin
                || authority.origin.as_deref() != Some(origin)
                || generation != authority.generation
                || created.elapsed() >= CHALLENGE_TIMEOUT
            {
                return Err(failure("Settings authority or challenge changed. Refresh settings status."));
            }
            (challenge, generation, state.stored.companion_id)
        };
        let receipt: Receipt = Self::fetch_settings_receipt(origin, companion_id, &challenge, &delivery.grant).await?;
        receipt.validate()?;
        if receipt.companion_id != companion_id || receipt.challenge != challenge || receipt.origin != origin {
            return Err(failure("Settings receipt does not match this request. Request a new grant."));
        }
        {
            let _authority = require_authority(pairing, origin, Some(generation))?;
            self.apply_settings(receipt, app, localization)?;
        }
        self.settings_status(Some(origin), pairing)
    }

    pub fn record_settings_error(&self, message: String) -> Result<(), ApiError> {
        let mut state = self.available_state()?;
        state.status = "settings_failed";
        state.message = Some(message);
        Ok(())
    }

    async fn fetch_settings_receipt(origin: &str, companion_id: uuid::Uuid, challenge: &str, grant: &str) -> Result<Receipt, ApiError> {
        let parsed = validate_origin(origin)?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REDEMPTION_TIMEOUT);
        if parsed.scheme() == "http" {
            builder = builder.no_proxy();
            if parsed.host_str() == Some("localhost") {
                let port = parsed
                    .port_or_known_default()
                    .ok_or_else(|| failure("Settings origin has no port."))?;
                builder = builder.resolve_to_addrs(
                    "localhost",
                    &[
                        std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port),
                        std::net::SocketAddr::new(std::net::Ipv6Addr::LOCALHOST.into(), port),
                    ],
                );
            }
        }
        let mut response = builder.build().map_err(|_| failure("Settings client cannot start. Restart the Companion."))?
            .post(format!("{origin}/api/admin/settings/companion/grants/redeem"))
            .json(&serde_json::json!({"version": SETTINGS_VERSION, "companion_id": companion_id, "challenge": challenge, "origin": origin, "grant": grant}))
            .send().await.map_err(|_| failure("Settings backend is unavailable. Check the connection and retry."))?;
        if matches!(response.status().as_u16(), 404 | 426) {
            return Err(ApiError::bad_request_code(
                "The backend settings protocol is incompatible. Update Sambee and Companion.",
                "settings_update_required",
            ));
        }
        if !response.status().is_success() {
            return Err(failure(
                "Backend refused settings delivery. Sign in again and retry. Redirects are not permitted.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("Settings receipt could not be read. Retry delivery."))?
        {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(failure("Settings receipt exceeds the response limit."));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| {
            ApiError::bad_request_code(
                "Settings receipt is incompatible. Update Sambee and Companion.",
                "settings_update_required",
            )
        })
    }

    fn apply_settings(&self, receipt: Receipt, app: &AppHandle, localization: &LocalizationState) -> Result<(), ApiError> {
        self.apply_settings_with(
            receipt,
            |theme| {
                app.state::<ThemeState>()
                    .set_managed(app, encode_theme(theme)?)
                    .map_err(|message| failure(&message))
            },
            |origin, payload| apply_localization(app, localization, origin, payload),
        )
    }

    fn apply_settings_with(
        &self,
        receipt: Receipt,
        apply_theme: impl FnOnce(&Theme) -> Result<(), ApiError>,
        apply_locale: impl FnOnce(&str, &Localization) -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| failure("Settings state is unavailable. Restart the Companion."))?;
        state.stored.managed.validate_user_update(&receipt)?;
        let retry_directory = state.failed_sections.contains_key("directory_index");
        let retry_theme = state.failed_sections.contains_key("theme");
        let retry_locale = state.failed_sections.contains_key("localization");
        for (name, supplied) in [
            ("theme", receipt.theme.is_some()),
            ("localization", receipt.localization.is_some()),
            ("directory_index", receipt.directory_index.is_some()),
        ] {
            if supplied {
                state
                    .failed_sections
                    .insert(name, "Settings delivery has not completed. Retry delivery.".to_owned());
            }
        }
        let mut proposed = state.stored.clone();
        let identity = receipt.backend_identity.clone();
        let origin = receipt.origin.clone();
        if let Some(section) = receipt.directory_index {
            if directory_section_changed(proposed.managed.directory_index.as_ref(), &section, &origin, &identity)? || retry_directory {
                proposed.managed.directory_index = Some(Applied {
                    section: section.clone(),
                    origin: origin.clone(),
                    backend_identity: identity.clone(),
                });
                self.manager
                    .upgrade()
                    .ok_or_else(|| failure("Directory manager is unavailable. Restart the Companion."))?
                    .apply_policy_with_persistence(section.payload, || self.persist_with_recovery(&mut state, &proposed))
                    .map_err(|error| failure(&format!("Directory settings were not applied. {error}")))?;
                state.stored = proposed.clone();
            }
            state.failed_sections.remove("directory_index");
        }
        if let Some(section) = receipt.theme {
            let unchanged = proposed.managed.theme.as_ref().is_some_and(|old| {
                old.origin == origin
                    && old.backend_identity == identity
                    && old.section.marker == section.marker
                    && old.section.user_scope == section.user_scope
            });
            if !unchanged || retry_theme {
                let payload = section.payload.clone();
                proposed.managed.theme = Some(Applied {
                    section,
                    origin: origin.clone(),
                    backend_identity: identity.clone(),
                });
                self.persist_with_recovery(&mut state, &proposed)
                    .map_err(|error| failure(&format!("Theme settings were not saved. {error}")))?;
                if let Err(error) = apply_theme(&payload) {
                    save(&self.directory, &state.stored)?;
                    return Err(error);
                }
                state.stored = proposed.clone();
            }
            state.failed_sections.remove("theme");
        }
        if let Some(section) = receipt.localization {
            let unchanged = proposed.managed.localization.as_ref().is_some_and(|old| {
                old.origin == origin
                    && old.backend_identity == identity
                    && old.section.marker == section.marker
                    && old.section.user_scope == section.user_scope
            });
            if !unchanged || retry_locale {
                proposed.managed.localization = Some(Applied {
                    section: section.clone(),
                    origin: origin.clone(),
                    backend_identity: identity,
                });
                self.persist_with_recovery(&mut state, &proposed)
                    .map_err(|error| failure(&format!("Localization settings were not saved. {error}")))?;
                if let Err(error) = apply_locale(&origin, &section.payload) {
                    save(&self.directory, &state.stored)?;
                    return Err(error);
                }
                state.stored = proposed;
            }
            state.failed_sections.remove("localization");
        }
        state.message = state.failed_sections.values().next().cloned();
        state.status = if state.failed_sections.is_empty() {
            "applied"
        } else {
            "settings_failed"
        };
        Ok(())
    }
}

fn apply_localization(app: &AppHandle, localization: &LocalizationState, origin: &str, payload: &Localization) -> Result<(), ApiError> {
    let (current, _) = localization
        .apply_managed_update(
            app,
            origin,
            LocalizationSyncRequest {
                language: payload.language.clone(),
                regional_locale: payload.regional_locale.clone(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
        )
        .map_err(|message| failure(&message))?;
    app.emit("localization-updated", &current)
        .map_err(|_| failure("Localization broadcast failed. Restart the Companion."))
}

fn encode_theme(theme: &Theme) -> Result<String, ApiError> {
    let json = serde_json::to_string(theme).map_err(|_| failure("Theme cannot be encoded. Correct the server theme."))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(json.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt() -> Receipt {
        Receipt {
            version: SETTINGS_VERSION,
            companion_id: uuid::Uuid::new_v4(),
            challenge: "a".repeat(64),
            origin: "https://sambee.example".to_owned(),
            backend_identity: "b".repeat(64),
            switch_user: true,
            theme: Some(Section {
                version: SETTINGS_VERSION,
                marker: "c".repeat(64),
                user_scope: Some(uuid::Uuid::new_v4().to_string()),
                payload: Theme {
                    id: "sambee-light".to_owned(),
                    mode: "light".to_owned(),
                    primary: PrimaryColor {
                        main: "#F4C430".to_owned(),
                    },
                },
            }),
            localization: None,
            directory_index: Some(Section {
                version: SETTINGS_VERSION,
                marker: "0".to_owned(),
                user_scope: None,
                payload: DirectoryPolicy::defaults().unwrap(),
            }),
        }
    }

    #[test]
    fn directory_revisions_are_idempotent_and_scoped_to_backend_identity() {
        let receipt = receipt();
        let mut section = receipt.directory_index.unwrap();
        section.marker = "5".to_owned();
        let previous = Applied {
            section: section.clone(),
            origin: receipt.origin.clone(),
            backend_identity: receipt.backend_identity.clone(),
        };
        assert!(!directory_section_changed(Some(&previous), &section, &receipt.origin, &receipt.backend_identity).unwrap());
        section.marker = "4".to_owned();
        assert!(directory_section_changed(Some(&previous), &section, &receipt.origin, &receipt.backend_identity).is_err());
        assert!(directory_section_changed(Some(&previous), &section, &receipt.origin, &"e".repeat(64)).unwrap());
        assert!(directory_section_changed(Some(&previous), &section, "https://new.example", &receipt.backend_identity).unwrap());
        section.marker = "6".to_owned();
        assert!(directory_section_changed(Some(&previous), &section, &receipt.origin, &receipt.backend_identity).unwrap());
        section.marker = "5".to_owned();
        section.payload.page_cache_kib += 1;
        assert!(directory_section_changed(Some(&previous), &section, &receipt.origin, &receipt.backend_identity).is_err());
    }

    #[test]
    fn background_updates_cannot_switch_the_applied_user() {
        let mut receipt = receipt();
        let managed = ManagedSettings {
            theme: Some(Applied {
                section: receipt.theme.clone().unwrap(),
                origin: receipt.origin.clone(),
                backend_identity: receipt.backend_identity.clone(),
            }),
            ..ManagedSettings::default()
        };
        receipt.switch_user = false;
        assert!(managed.validate_user_update(&receipt).is_ok());
        receipt.theme.as_mut().unwrap().user_scope = Some(uuid::Uuid::new_v4().to_string());
        assert!(managed.validate_user_update(&receipt).is_err());
        receipt.switch_user = true;
        assert!(managed.validate_user_update(&receipt).is_ok());
        receipt.switch_user = false;
        receipt.backend_identity = "e".repeat(64);
        assert!(managed.validate_user_update(&receipt).is_ok());
    }

    #[test]
    fn authority_is_rechecked_for_inflight_delivery_and_repair() {
        let pairing = PairingState::new();
        pairing.set_test_authority(Some("https://sambee.example"));
        let generation = require_authority(&pairing, "https://sambee.example", None).unwrap().generation;
        assert!(require_authority(&pairing, "https://sambee.example", Some(generation)).is_ok());
        pairing.set_test_authority(Some("https://sambee.example"));
        assert!(require_authority(&pairing, "https://sambee.example", Some(generation)).is_err());
        pairing.set_test_authority(Some("https://new.example"));
        assert!(pairing.is_origin_paired("https://sambee.example"));
        assert!(require_authority(&pairing, "https://sambee.example", None).is_err());
        pairing.set_test_authority(None);
        assert!(require_authority(&pairing, "https://new.example", None).is_err());
    }

    #[test]
    fn validates_all_supplied_sections_before_application() {
        let mut valid = receipt();
        assert!(valid.validate().is_ok());
        valid.theme.as_mut().unwrap().payload.primary.main = "url(unsafe)".to_owned();
        assert!(valid.validate().is_err());
        valid = receipt();
        valid.directory_index.as_mut().unwrap().marker = "-1".to_owned();
        assert!(valid.validate().is_err());
    }

    #[test]
    fn accepts_stored_browser_localization_but_refuses_mixed_user_scopes() {
        let mut value = receipt();
        value.localization = Some(Section {
            version: SETTINGS_VERSION,
            marker: "d".repeat(64),
            user_scope: value.theme.as_ref().unwrap().user_scope.clone(),
            payload: Localization {
                language: "browser".to_owned(),
                regional_locale: "browser".to_owned(),
            },
        });
        assert!(value.validate().is_ok());
        value.localization.as_mut().unwrap().user_scope = Some(uuid::Uuid::new_v4().to_string());
        assert!(value.validate().is_err());
    }

    #[test]
    fn theme_encoding_uses_the_existing_native_theme_payload() {
        let theme = receipt().theme.unwrap().payload;
        let encoded = encode_theme(&theme).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        assert!(serde_json::from_slice::<Theme>(&bytes).unwrap() == theme);
    }

    #[tokio::test]
    async fn pairing_authorizes_challenges_without_policy_approval_and_repair_invalidates_them() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let pairing = PairingState::new();
        pairing.set_test_authority(Some("https://sambee.example"));
        let first = policy.settings_challenge("https://sambee.example", &pairing).unwrap();
        assert!(first.challenge.is_some());
        assert!(policy.settings_challenge("https://older.example", &pairing).is_err());
        pairing.set_test_authority(Some("https://sambee.example"));
        assert!(policy
            .settings_status(Some("https://sambee.example"), &pairing)
            .unwrap()
            .challenge
            .is_none());
        pairing.set_test_authority(Some("https://new.example"));
        let conflict = policy.settings_status(Some("https://sambee.example"), &pairing).unwrap();
        assert_eq!(conflict.status, "authority_conflict");
        assert_eq!(conflict.authoritative_origin.as_deref(), Some("https://new.example"));
        pairing.set_test_authority(None);
        assert!(policy.settings_challenge("https://new.example", &pairing).is_err());
    }

    #[tokio::test]
    async fn failed_restore_retries_matching_sections_after_storage_recovers() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let pairing = PairingState::new();
        let mut desired = receipt();
        desired.localization = Some(Section {
            version: SETTINGS_VERSION,
            marker: "d".repeat(64),
            user_scope: desired.theme.as_ref().unwrap().user_scope.clone(),
            payload: Localization {
                language: "en".to_owned(),
                regional_locale: "en-GB".to_owned(),
            },
        });
        pairing.set_test_authority(Some(&desired.origin));
        {
            let mut state = policy.state.lock().unwrap();
            state.stored.managed = ManagedSettings {
                theme: Some(Applied {
                    section: desired.theme.clone().unwrap(),
                    origin: desired.origin.clone(),
                    backend_identity: desired.backend_identity.clone(),
                }),
                localization: Some(Applied {
                    section: desired.localization.clone().unwrap(),
                    origin: desired.origin.clone(),
                    backend_identity: desired.backend_identity.clone(),
                }),
                directory_index: Some(Applied {
                    section: desired.directory_index.clone().unwrap(),
                    origin: desired.origin.clone(),
                    backend_identity: desired.backend_identity.clone(),
                }),
            };
            save(&policy.directory, &state.stored).unwrap();
        }
        let storage = temporary.path().join("runtime-settings");
        std::fs::write(&storage, b"not a directory").unwrap();
        let apply_theme = |payload: &Theme| {
            std::fs::write(storage.join("theme.json"), serde_json::to_vec(payload).unwrap())
                .map_err(|error| failure(&format!("Theme storage is unavailable. Check local storage: {error}")))
        };
        let apply_locale = |_: &str, payload: &Localization| {
            std::fs::write(storage.join("localization.json"), serde_json::to_vec(payload).unwrap())
                .map_err(|error| failure(&format!("Localization storage is unavailable. Check local storage: {error}")))
        };
        assert!(policy.restore_user_sections(apply_theme, apply_locale).is_err());
        let failed = policy.settings_status(None, &pairing).unwrap();
        assert_eq!(failed.status, "delivery_failed");
        assert_eq!(failed.sections["theme"].result, "delivery_failed");
        assert_eq!(failed.sections["localization"].result, "delivery_failed");

        let mut directory_only = desired.clone();
        directory_only.theme = None;
        directory_only.localization = None;
        policy
            .apply_settings_with(
                directory_only,
                |_| panic!("Theme was not supplied"),
                |_, _| panic!("Localization was not supplied"),
            )
            .unwrap();
        let unrelated = policy.settings_status(None, &pairing).unwrap();
        assert_eq!(unrelated.status, "delivery_failed");
        assert!(unrelated.message.is_some());
        assert_eq!(unrelated.sections["theme"].result, "delivery_failed");
        assert_eq!(unrelated.sections["localization"].result, "delivery_failed");

        desired.directory_index = None;
        assert!(policy.apply_settings_with(desired.clone(), apply_theme, apply_locale).is_err());
        assert_eq!(
            policy.settings_status(None, &pairing).unwrap().sections["theme"].result,
            "delivery_failed"
        );
        std::fs::remove_file(&storage).unwrap();
        std::fs::create_dir(&storage).unwrap();
        policy.apply_settings_with(desired.clone(), apply_theme, apply_locale).unwrap();
        let recovered = policy.settings_status(None, &pairing).unwrap();
        assert_eq!(recovered.status, "synchronized");
        assert!(recovered.message.is_none());
        for name in ["theme", "localization"] {
            assert_eq!(recovered.sections[name].result, "synchronized");
            assert_eq!(recovered.sections[name].marker, failed.sections[name].marker);
        }
        assert!(
            serde_json::from_slice::<Theme>(&std::fs::read(storage.join("theme.json")).unwrap()).unwrap()
                == desired.theme.as_ref().unwrap().payload
        );
        assert!(
            serde_json::from_slice::<Localization>(&std::fs::read(storage.join("localization.json")).unwrap()).unwrap()
                == desired.localization.as_ref().unwrap().payload
        );
        policy
            .apply_settings_with(
                desired,
                |_| panic!("A synchronized theme must not be reapplied"),
                |_, _| panic!("Synchronized localization must not be reapplied"),
            )
            .unwrap();
    }

    #[tokio::test]
    async fn managed_sections_survive_restart_independently_of_legacy_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let path = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        let mut stored = policy.state.lock().unwrap().stored.clone();
        let desired = receipt();
        stored.managed.theme = Some(Applied {
            section: desired.theme.unwrap(),
            origin: desired.origin.clone(),
            backend_identity: desired.backend_identity.clone(),
        });
        stored.managed.directory_index = Some(Applied {
            section: desired.directory_index.unwrap(),
            origin: desired.origin,
            backend_identity: desired.backend_identity,
        });
        save(&path, &stored).unwrap();
        drop(policy);
        let reopened = DirectoryPolicyState::open(path, &manager).unwrap();
        let pairing = PairingState::new();
        pairing.set_test_authority(Some("https://sambee.example"));
        let status = reopened.settings_status(None, &pairing).unwrap();
        assert_eq!(status.sections["theme"].marker, "c".repeat(64));
        assert_eq!(status.sections["directory_index"].marker, "0");
        assert!(!status.sections.contains_key("localization"));
    }
}
