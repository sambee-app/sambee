//! Pairing protocol — Bluetooth-style numeric comparison.
//!
//! Establishes a shared secret between the Sambee frontend and the companion
//! via a one-time user-confirmed exchange. The secret is stored in the OS
//! keychain and used to authenticate all subsequent API requests.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use log::{info, warn};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::DownloadIntent;

#[derive(Clone, Copy)]
pub enum VerifiedOriginRecordReason {
    PairingCompleted,
    RecoveredFromAuthenticatedRequest,
}

/// Keyring service name for storing pairing secrets.
const KEYRING_SERVICE: &str = "sambee-companion";

/// Reserved keyring account used to persist the list of paired origins.
const KEYRING_PAIRED_ORIGINS_ACCOUNT: &str = "__paired_origins__";
const KEYRING_SETTINGS_AUTHORITY_ACCOUNT: &str = "__settings_authority__";

#[derive(Default)]
pub struct SettingsAuthority {
    pub origin: Option<String>,
    pub generation: u64,
}

/// Maximum age of a pending pairing before it expires.
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);

/// Short global cooldown between pairing-window creations.
const PAIRING_WINDOW_COOLDOWN: Duration = Duration::from_secs(5);

/// Allow only one pending pairing at a time so arbitrary sites cannot fan out
/// native approval windows concurrently.
const MAX_PENDING_PAIRINGS: usize = 1;

#[derive(Debug, thiserror::Error)]
pub enum PairingInitiateError {
    #[error("{0}")]
    Validation(String),

    #[error("{0}")]
    RateLimited(String),
}

/// Tracks in-flight pairing attempts and completed pairings.
#[allow(dead_code)]
pub struct PairingState {
    /// Pending pairings awaiting confirmation.
    pending: Mutex<HashMap<String, PendingPairing>>,
    /// Timestamp of the last pairing-window creation.
    last_initiated_at: Mutex<Option<Instant>>,
    /// Origins that have completed pairing (cached from keychain).
    paired_origins: Mutex<Vec<String>>,
    authority: Mutex<SettingsAuthority>,
    pub(crate) download_intents: Mutex<HashMap<String, DownloadIntent>>,

    pairing_window_cooldown: Duration,
    max_pending_pairings: usize,
}

/// A pairing attempt in progress.
#[allow(dead_code)]
struct PendingPairing {
    /// The browser's nonce.
    nonce_browser: Vec<u8>,
    /// The companion's nonce.
    nonce_companion: Vec<u8>,
    /// When this pairing was initiated.
    created_at: Instant,
    /// The origin that initiated the pairing (from HTTP Origin header).
    origin: String,
    /// Whether the companion side has been confirmed by the user.
    companion_confirmed: bool,
}

#[allow(dead_code)]
impl PairingState {
    pub fn settings_authority(&self) -> Result<MutexGuard<'_, SettingsAuthority>, String> {
        self.authority
            .lock()
            .map_err(|_| "Settings authority is unavailable. Restart the Companion.".to_owned())
    }

    fn set_settings_authority(&self, origin: Option<&str>, removed_origin: Option<&str>) -> Result<(), String> {
        let mut authority = self.settings_authority()?;
        if removed_origin.is_some_and(|removed| authority.origin.as_deref() != Some(removed)) {
            return Ok(());
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_SETTINGS_AUTHORITY_ACCOUNT)
            .map_err(|error| format!("Settings authority storage is unavailable. Check the keychain: {error}"))?;
        let serialized = serde_json::to_string(&origin).map_err(|error| format!("Settings authority cannot be encoded: {error}"))?;
        entry
            .set_password(&serialized)
            .map_err(|error| format!("Settings authority cannot be stored. Check the keychain: {error}"))?;
        authority.origin = origin.map(str::to_owned);
        authority.generation = authority.generation.wrapping_add(1);
        Ok(())
    }

    pub fn migrate_settings_authority(&self, legacy_origin: Option<&str>) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_SETTINGS_AUTHORITY_ACCOUNT)
            .map_err(|error| format!("Settings authority storage is unavailable: {error}"))?;
        match entry.get_password() {
            Ok(value) => {
                let origin: Option<String> = serde_json::from_str(&value)
                    .map_err(|error| format!("Settings authority is invalid. Pair the intended server again: {error}"))?;
                let valid = origin.filter(|origin| self.is_origin_paired(origin));
                self.set_settings_authority(valid.as_deref(), None)
            }
            Err(keyring::Error::NoEntry) => {
                let origins = self.get_paired_origins();
                let selected = legacy_origin
                    .filter(|origin| origins.iter().any(|paired| paired == origin))
                    .or_else(|| if origins.len() == 1 { Some(origins[0].as_str()) } else { None });
                self.set_settings_authority(selected, None)
            }
            Err(error) => Err(format!("Settings authority cannot be read. Unlock the keychain: {error}")),
        }
    }

    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            last_initiated_at: Mutex::new(None),
            paired_origins: Mutex::new(Vec::new()),
            authority: Mutex::new(SettingsAuthority::default()),
            download_intents: Mutex::new(HashMap::new()),
            pairing_window_cooldown: PAIRING_WINDOW_COOLDOWN,
            max_pending_pairings: MAX_PENDING_PAIRINGS,
        }
    }

    #[cfg(test)]
    pub(crate) fn set_test_authority(&self, origin: Option<&str>) {
        if let Some(origin) = origin {
            let mut origins = self.paired_origins.lock().unwrap();
            if !origins.iter().any(|paired| paired == origin) {
                origins.push(origin.to_owned());
            }
        }
        let mut authority = self.settings_authority().unwrap();
        authority.origin = origin.map(str::to_owned);
        authority.generation += 1;
    }

    #[cfg(test)]
    fn new_with_limits(pairing_window_cooldown: Duration, max_pending_pairings: usize) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            last_initiated_at: Mutex::new(None),
            paired_origins: Mutex::new(Vec::new()),
            authority: Mutex::new(SettingsAuthority::default()),
            download_intents: Mutex::new(HashMap::new()),
            pairing_window_cooldown,
            max_pending_pairings,
        }
    }

    /// Check if any origin is currently paired.
    pub fn has_any_pairing(&self) -> bool {
        let origins = self.paired_origins.lock().unwrap();
        !origins.is_empty()
    }

    /// Check if a specific origin is paired.
    pub fn is_origin_paired(&self, origin: &str) -> bool {
        let origins = self.paired_origins.lock().unwrap();
        origins.contains(&origin.to_string())
    }

    /// Return all currently paired origins.
    pub fn get_paired_origins(&self) -> Vec<String> {
        let origins = self.paired_origins.lock().unwrap();
        origins.clone()
    }

    /// Record an origin that has proven it holds a valid pairing secret.
    pub fn record_verified_origin(&self, origin: &str, reason: VerifiedOriginRecordReason) {
        let mut origins = self.paired_origins.lock().unwrap();
        if origins.iter().any(|entry| entry == origin) {
            return;
        }

        origins.push(origin.to_string());
        if let Err(e) = store_paired_origins_in_keychain(&origins) {
            warn!("Failed to persist paired origins list after auth for {origin}: {e}");
        }

        match reason {
            VerifiedOriginRecordReason::PairingCompleted => {
                info!("Recorded paired origin during pairing completion: {origin}");
            }
            VerifiedOriginRecordReason::RecoveredFromAuthenticatedRequest => {
                info!("Recovered paired origin from successful authenticated request: {origin}");
            }
        }
    }

    /// Start a new pairing: store the browser nonce, generate companion nonce,
    /// return the pairing ID and companion nonce.
    pub fn initiate(&self, nonce_browser_hex: &str, origin: &str) -> Result<(String, String, String), PairingInitiateError> {
        let nonce_browser = hex::decode(nonce_browser_hex)
            .map_err(|_| PairingInitiateError::Validation("Invalid hex encoding for nonce_browser".to_string()))?;

        if nonce_browser.len() != 32 {
            return Err(PairingInitiateError::Validation(
                "nonce_browser must be 32 bytes (64 hex chars)".to_string(),
            ));
        }

        // Clean up expired pairings before applying guardrails.
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.created_at.elapsed() < PAIRING_TIMEOUT);

        if pending.values().any(|pairing| pairing.origin == origin) {
            return Err(PairingInitiateError::RateLimited(
                "A pairing request for this origin is already waiting for approval".to_string(),
            ));
        }

        if pending.len() >= self.max_pending_pairings {
            return Err(PairingInitiateError::RateLimited(
                "Another pairing request is already waiting for approval".to_string(),
            ));
        }

        let mut last_initiated_at = self.last_initiated_at.lock().unwrap();
        if let Some(last_request_at) = *last_initiated_at {
            let elapsed = last_request_at.elapsed();
            if elapsed < self.pairing_window_cooldown {
                let retry_after_seconds = (self.pairing_window_cooldown - elapsed).as_secs().max(1);
                return Err(PairingInitiateError::RateLimited(format!(
                    "Pairing was requested too recently. Try again in {retry_after_seconds} second(s)"
                )));
            }
        }

        // Generate companion nonce (32 random bytes)
        let nonce_companion: Vec<u8> = (0..32).map(|_| rand_byte()).collect();
        let nonce_companion_hex = hex::encode(&nonce_companion);

        // Compute pairing code: SHA-256(nonce_browser || nonce_companion), first 6 hex chars uppercased
        let code = compute_pairing_code(&nonce_browser, &nonce_companion);

        let pairing_id = Uuid::new_v4().to_string();

        pending.insert(
            pairing_id.clone(),
            PendingPairing {
                nonce_browser,
                nonce_companion,
                created_at: Instant::now(),
                origin: origin.to_string(),
                companion_confirmed: false,
            },
        );
        *last_initiated_at = Some(Instant::now());

        info!("Pairing initiated: id={pairing_id}, origin={origin}, code={code}");

        Ok((pairing_id, nonce_companion_hex, code))
    }

    /// Check whether an origin currently has a non-expired pending pairing.
    pub fn has_pending_pairing_for_origin(&self, origin: &str) -> bool {
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.created_at.elapsed() < PAIRING_TIMEOUT);
        pending.values().any(|pairing| pairing.origin == origin)
    }

    /// Mark the companion side of a pairing as confirmed by the user.
    pub fn companion_confirm(&self, pairing_id: &str) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap();
        let pairing = pending
            .get_mut(pairing_id)
            .ok_or_else(|| "Unknown or expired pairing".to_string())?;

        if pairing.created_at.elapsed() >= PAIRING_TIMEOUT {
            pending.remove(pairing_id);
            return Err("Pairing has expired".to_string());
        }

        pairing.companion_confirmed = true;
        info!("Pairing companion-confirmed: id={pairing_id}");
        Ok(())
    }

    /// Mark the companion side of a pairing as rejected by the user.
    pub fn companion_reject(&self, pairing_id: &str) {
        let mut pending = self.pending.lock().unwrap();
        pending.remove(pairing_id);
        info!("Pairing companion-rejected: id={pairing_id}");
    }

    /// Cancel a pending pairing from the browser side, scoped to the initiating origin.
    pub fn cancel(&self, pairing_id: &str, origin: &str) -> Result<(), String> {
        let mut pending = self.pending.lock().unwrap();
        pending.retain(|_, p| p.created_at.elapsed() < PAIRING_TIMEOUT);

        let pairing = pending.get(pairing_id).ok_or_else(|| "Unknown or expired pairing".to_string())?;

        if pairing.origin != origin {
            return Err("Pairing does not belong to this origin".to_string());
        }

        pending.remove(pairing_id);
        info!("Pairing browser-cancelled: id={pairing_id}, origin={origin}");
        Ok(())
    }

    /// Complete the pairing: verify the companion confirmed, generate shared secret,
    /// store it in the keychain, and return it to the browser.
    pub fn confirm(&self, pairing_id: &str, origin: &str) -> Result<String, String> {
        let mut pending = self.pending.lock().unwrap();

        let pairing = pending.get(pairing_id).ok_or_else(|| "Unknown or expired pairing".to_string())?;

        if pairing.origin != origin {
            return Err("Pairing does not belong to this origin".to_string());
        }

        let pairing = pending.remove(pairing_id).ok_or_else(|| "Unknown or expired pairing".to_string())?;

        if pairing.created_at.elapsed() >= PAIRING_TIMEOUT {
            return Err("Pairing has expired".to_string());
        }

        if !pairing.companion_confirmed {
            // Put it back — the frontend confirmed but the companion hasn't yet
            let id = pairing_id.to_string();
            pending.insert(id, pairing);
            return Err("Waiting for companion confirmation".to_string());
        }

        drop(pending); // Release lock before keychain operations

        // Generate shared secret
        let secret_bytes: Vec<u8> = (0..32).map(|_| rand_byte()).collect();
        let secret_hex = hex::encode(&secret_bytes);

        // Store in OS keychain
        if let Err(e) = store_secret_in_keychain(&pairing.origin, &secret_hex) {
            warn!("Failed to store secret in keychain: {e}");
            return Err(format!("Failed to store pairing secret: {e}"));
        }

        // Add to cached paired origins
        self.record_verified_origin(&pairing.origin, VerifiedOriginRecordReason::PairingCompleted);

        self.set_settings_authority(Some(&pairing.origin), None)?;

        info!("Pairing completed: origin={}", pairing.origin);
        Ok(secret_hex)
    }

    /// Load paired origins from the keychain on startup.
    pub fn load_from_keychain(&self) {
        let stored_origins = match load_paired_origins_from_keychain() {
            Ok(origins) => origins,
            Err(e) => {
                warn!("Failed to load paired origins from keychain: {e}");
                Vec::new()
            }
        };

        let mut verified_origins = Vec::new();
        for origin in stored_origins {
            if get_secret_from_keychain(&origin).is_ok() {
                verified_origins.push(origin);
            } else {
                warn!("Skipping paired origin without readable secret in keychain");
            }
        }

        if let Ok(mut origins) = self.paired_origins.lock() {
            *origins = verified_origins.clone();
        }

        if let Err(e) = store_paired_origins_in_keychain(&verified_origins) {
            warn!("Failed to resync paired origins list in keychain: {e}");
        }

        info!("Pairing state initialized with {} paired origin(s)", verified_origins.len());
    }

    /// Retrieve the stored secret for an origin from the keychain.
    pub fn get_secret_for_origin(&self, origin: &str) -> Option<String> {
        get_secret_from_keychain(origin).ok()
    }

    /// Get a pending pairing by ID (for the companion UI to display the code).
    pub fn get_pending_code(&self, pairing_id: &str) -> Option<String> {
        let pending = self.pending.lock().unwrap();
        pending
            .get(pairing_id)
            .map(|p| compute_pairing_code(&p.nonce_browser, &p.nonce_companion))
    }

    /// Get all pending pairing IDs and their origins (for the companion UI).
    pub fn get_pending_pairings(&self) -> Vec<(String, String, String)> {
        let pending = self.pending.lock().unwrap();
        pending
            .iter()
            .filter(|(_, p)| p.created_at.elapsed() < PAIRING_TIMEOUT && !p.companion_confirmed)
            .map(|(id, p)| {
                let code = compute_pairing_code(&p.nonce_browser, &p.nonce_companion);
                (id.clone(), p.origin.clone(), code)
            })
            .collect()
    }

    /// Get the initiating origin for a pending pairing ID.
    pub fn get_pending_origin(&self, pairing_id: &str) -> Option<String> {
        let pending = self.pending.lock().unwrap();
        pending
            .get(pairing_id)
            .filter(|pairing| pairing.created_at.elapsed() < PAIRING_TIMEOUT)
            .map(|pairing| pairing.origin.clone())
    }

    /// Remove pairing for a specific origin.
    pub fn unpair(&self, origin: &str) -> Result<(), String> {
        self.set_settings_authority(None, Some(origin))?;
        // Remove from keychain
        if let Err(e) = delete_secret_from_keychain(origin) {
            warn!("Failed to remove secret from keychain for {origin}: {e}");
        }

        // Remove from cached list
        let mut origins = self.paired_origins.lock().unwrap();
        origins.retain(|o| o != origin);
        self.download_intents.lock().unwrap().retain(|_, intent| intent.origin != origin);
        if let Err(e) = store_paired_origins_in_keychain(&origins) {
            warn!("Failed to persist paired origins list after unpair: {e}");
        }

        info!("Unpaired origin: {origin}");
        Ok(())
    }
}

/// Compute the 6-character pairing code from both nonces.
fn compute_pairing_code(nonce_browser: &[u8], nonce_companion: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(nonce_browser);
    hasher.update(nonce_companion);
    let hash = hasher.finalize();
    hex::encode(&hash[..3]).to_uppercase()
}

// ─── Keychain operations ─────────────────────────────────────────────────────

/// Store a pairing secret in the OS keychain.
fn store_secret_in_keychain(origin: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, origin).map_err(|e| format!("Keyring entry creation failed: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| format!("Keyring set_password failed: {e}"))?;
    Ok(())
}

/// Persist the list of paired origins in the OS keychain.
fn store_paired_origins_in_keychain(origins: &[String]) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_PAIRED_ORIGINS_ACCOUNT).map_err(|e| format!("Keyring entry creation failed: {e}"))?;
    let serialized = serde_json::to_string(origins).map_err(|e| format!("Failed to serialize paired origins: {e}"))?;
    entry
        .set_password(&serialized)
        .map_err(|e| format!("Keyring set_password failed: {e}"))?;
    Ok(())
}

/// Load the persisted list of paired origins from the OS keychain.
fn load_paired_origins_from_keychain() -> Result<Vec<String>, String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_PAIRED_ORIGINS_ACCOUNT).map_err(|e| format!("Keyring entry creation failed: {e}"))?;
    let serialized = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
        Err(e) => return Err(format!("Keyring get_password failed: {e}")),
    };

    serde_json::from_str(&serialized).map_err(|e| format!("Failed to deserialize paired origins: {e}"))
}

/// Retrieve a pairing secret from the OS keychain.
fn get_secret_from_keychain(origin: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, origin).map_err(|e| format!("Keyring entry creation failed: {e}"))?;
    entry.get_password().map_err(|e| format!("Keyring get_password failed: {e}"))
}

/// Delete a pairing secret from the OS keychain.
#[allow(dead_code)]
fn delete_secret_from_keychain(origin: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, origin).map_err(|e| format!("Keyring entry creation failed: {e}"))?;
    entry.delete_credential().map_err(|e| format!("Keyring delete failed: {e}"))
}

/// Generate a single random byte using a simple entropy source.
///
/// Uses `uuid::Uuid::new_v4()` as a source of randomness since we already
/// depend on the `uuid` crate. For security-critical randomness in production,
/// consider the `getrandom` crate directly.
fn rand_byte() -> u8 {
    // Use the first byte of a v4 UUID as a random byte source
    Uuid::new_v4().as_bytes()[0]
}

#[cfg(test)]
mod tests {
    use std::thread::sleep;

    use super::*;

    const NONCE_A: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const NONCE_B: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
    const NONCE_C: &str = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    #[test]
    fn rejects_second_pending_pairing_for_same_origin() {
        let pairing = PairingState::new_with_limits(Duration::ZERO, 1);

        pairing.initiate(NONCE_A, "https://sambee.example").unwrap();

        let err = pairing.initiate(NONCE_B, "https://sambee.example").unwrap_err();
        assert!(matches!(err, PairingInitiateError::RateLimited(_)));
        assert!(err.to_string().contains("already waiting for approval"));
    }

    #[test]
    fn rejects_new_pairing_while_another_origin_is_pending() {
        let pairing = PairingState::new_with_limits(Duration::ZERO, 1);

        pairing.initiate(NONCE_A, "https://sambee.example").unwrap();

        let err = pairing.initiate(NONCE_B, "https://other.example").unwrap_err();
        assert!(matches!(err, PairingInitiateError::RateLimited(_)));
        assert!(err.to_string().contains("Another pairing request"));
    }

    #[test]
    fn enforces_short_cooldown_between_pairing_windows() {
        let pairing = PairingState::new_with_limits(Duration::from_millis(50), 1);

        let (pairing_id, _, _) = pairing.initiate(NONCE_A, "https://sambee.example").unwrap();
        pairing.cancel(&pairing_id, "https://sambee.example").unwrap();

        let err = pairing.initiate(NONCE_B, "https://sambee.example").unwrap_err();
        assert!(matches!(err, PairingInitiateError::RateLimited(_)));
        assert!(err.to_string().contains("too recently"));

        sleep(Duration::from_millis(60));

        let result = pairing.initiate(NONCE_C, "https://sambee.example");
        assert!(result.is_ok());
    }

    #[test]
    fn returns_origin_for_pending_pairing_id() {
        let pairing = PairingState::new_with_limits(Duration::ZERO, 1);

        let (pairing_id, _, _) = pairing.initiate(NONCE_A, "https://sambee.example").unwrap();

        assert_eq!(pairing.get_pending_origin(&pairing_id).as_deref(), Some("https://sambee.example"));
        assert!(pairing.get_pending_origin("missing-id").is_none());
    }

    #[test]
    fn rejects_confirm_for_different_origin() {
        let pairing = PairingState::new_with_limits(Duration::ZERO, 1);

        let (pairing_id, _, _) = pairing.initiate(NONCE_A, "https://sambee.example").unwrap();
        pairing.companion_confirm(&pairing_id).unwrap();

        let err = pairing.confirm(&pairing_id, "https://other.example").unwrap_err();
        assert!(err.contains("does not belong to this origin"));
        assert_eq!(pairing.get_pending_origin(&pairing_id).as_deref(), Some("https://sambee.example"));
    }

    #[test]
    fn unpair_removes_only_the_requested_origin() {
        let pairing = PairingState::new_with_limits(Duration::ZERO, 1);

        pairing.record_verified_origin("https://sambee.example", VerifiedOriginRecordReason::PairingCompleted);
        pairing.record_verified_origin("https://other.example", VerifiedOriginRecordReason::PairingCompleted);

        pairing.unpair("https://sambee.example").unwrap();

        assert_eq!(pairing.get_paired_origins(), vec!["https://other.example".to_string()]);
    }
}
