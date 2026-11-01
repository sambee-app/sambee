//! Local-owner consent and direct redemption of backend-issued directory policy grants.

#[cfg(unix)]
use std::fs::File;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use super::directory_manager::{DirectoryPolicy, LocalDirectoryManager, MAX_WIRE_INTEGER};
use super::errors::ApiError;

const POLICY_VERSION: u32 = 1;
const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(120);
const APPROVAL_COOLDOWN: Duration = Duration::from_secs(5);
const REDEMPTION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 16_384;
const MAX_GRANT_BYTES: usize = 8192;
const MAX_ORIGIN_BYTES: usize = 2048;
const MAX_POLICY_FILE_BYTES: u64 = 65_536;
const POLICY_FILE: &str = "approved-policy.json";
const POLICY_STAGE_FILE: &str = "approved-policy.pending";
static PROTECTED_NATIVE_STORAGE: OnceLock<Vec<PathBuf>> = OnceLock::new();

fn canonical_storage_path(path: &Path) -> Result<PathBuf, ApiError> {
    let mut existing = path;
    let mut suffix = Vec::new();
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(existing.file_name().ok_or_else(|| failure("Mutation path is invalid."))?);
                existing = existing.parent().ok_or_else(|| failure("Mutation path is invalid."))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut resolved = existing.canonicalize()?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

#[cfg(not(windows))]
fn storage_path_starts_with(path: &Path, parent: &Path) -> Result<bool, ApiError> {
    Ok(path.starts_with(parent))
}

#[cfg(windows)]
fn storage_path_starts_with(path: &Path, parent: &Path) -> Result<bool, ApiError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN};

    let mut components = path.components();
    for parent_component in parent.components() {
        let Some(component) = components.next() else {
            return Ok(false);
        };
        let candidate: Vec<u16> = component.as_os_str().encode_wide().collect();
        let expected: Vec<u16> = parent_component.as_os_str().encode_wide().collect();
        if i32::try_from(candidate.len()).is_err() || i32::try_from(expected.len()).is_err() {
            return Err(failure(
                "Native storage path is too long to compare safely. Select a shorter storage path.",
            ));
        }
        let comparison = unsafe { CompareStringOrdinal(&candidate, &expected, true) };
        if comparison == CSTR_EQUAL {
            continue;
        }
        if comparison == CSTR_LESS_THAN || comparison == CSTR_GREATER_THAN {
            return Ok(false);
        }
        return Err(failure(
            "Native storage path comparison failed. Retry after correcting the storage path.",
        ));
    }
    Ok(true)
}

fn ensure_outside_policy_storage(path: &Path, protected: &Path) -> Result<(), ApiError> {
    let resolved = canonical_storage_path(path)?;
    let protected = canonical_storage_path(protected)?;
    if storage_path_starts_with(&resolved, &protected)? || storage_path_starts_with(&protected, &resolved)? {
        return Err(ApiError::forbidden_code(
            "Companion internal storage can change only through native controls. Select a different file or directory.",
            "directory_policy_storage_protected",
        ));
    }
    Ok(())
}

pub(super) fn ensure_mutation_allowed(path: &Path) -> Result<(), ApiError> {
    if let Some(roots) = PROTECTED_NATIVE_STORAGE.get() {
        for protected in roots {
            ensure_outside_policy_storage(path, protected)?;
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyReceipt {
    version: u32,
    companion_id: uuid::Uuid,
    challenge: String,
    origin: String,
    backend_identity: String,
    revision: i64,
    policy: DirectoryPolicy,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedPolicy {
    version: u32,
    companion_id: uuid::Uuid,
    approved: Option<PolicyReceipt>,
}

struct PendingChallenge {
    value: String,
    origin: String,
    created: Instant,
    approved: bool,
    redeeming: bool,
}
struct PolicyState {
    stored: PersistedPolicy,
    pending: Option<PendingChallenge>,
    last_requested: Option<Instant>,
    prompt_active: bool,
    status: &'static str,
    message: Option<String>,
    blocked: bool,
}

#[derive(Serialize)]
pub struct DirectoryPolicyStatus {
    pub version: u32,
    pub companion_id: uuid::Uuid,
    pub status: &'static str,
    pub owner_origin: Option<String>,
    pub backend_identity: Option<String>,
    pub effective_revision: Option<i64>,
    pub policy: DirectoryPolicy,
    pub challenge: Option<String>,
    pub approved: bool,
    pub message: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyGrantDelivery {
    pub grant: String,
}

pub struct DirectoryPolicyState {
    directory: PathBuf,
    _lease: std::fs::File,
    state: Mutex<PolicyState>,
    manager: Weak<LocalDirectoryManager>,
}

struct PolicyRedemptionOwnership {
    policy: Arc<DirectoryPolicyState>,
    challenge: String,
}

impl Drop for PolicyRedemptionOwnership {
    fn drop(&mut self) {
        if let Ok(mut state) = self.policy.state.lock() {
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.value == self.challenge && pending.redeeming)
            {
                state.pending = None;
                state.status = "failed";
                state.message =
                    Some("Policy redemption failed. Existing approved policy remains active. Request a new approval grant.".to_owned());
            }
        }
    }
}

fn failure(message: &str) -> ApiError {
    ApiError::BadRequest(message.to_owned())
}

fn validate_origin(origin: &str) -> Result<url::Url, ApiError> {
    if origin.len() > MAX_ORIGIN_BYTES {
        return Err(failure("Policy origin is too long."));
    }
    let parsed = url::Url::parse(origin).map_err(|_| failure("Policy origin is invalid."))?;
    let loopback = match parsed.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(failure("Policy redemption requires HTTPS, or HTTP on a loopback host."));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || parsed.origin().ascii_serialization() != origin
    {
        return Err(failure("Policy origin must contain only the scheme, host and optional port."));
    }
    Ok(parsed)
}

fn validate_private_file(path: &Path) -> Result<(), ApiError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| failure("Approved policy storage is unavailable. Check private configuration storage."))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(failure("Approved policy storage must be a private regular file without links."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err(failure(
                "Approved policy storage must belong to the current user with mode 0600 and no hard links.",
            ));
        }
    }
    Ok(())
}

fn private_directory(directory: &Path) -> Result<(), ApiError> {
    for ancestor in directory.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(failure("Approved policy storage must not use symbolic links."))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(failure(
                    "Approved policy directory cannot be checked. Correct private configuration storage.",
                ))
            }
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|_| failure("Approved policy directory cannot be created. Correct private configuration storage."))?;
    let metadata = std::fs::symlink_metadata(directory).map_err(|_| failure("Approved policy directory cannot be checked."))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("Approved policy storage is not a private directory."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
            return Err(failure("Approved policy directory must belong to the current user with mode 0700."));
        }
    }
    Ok(())
}

fn save(directory: &Path, stored: &PersistedPolicy) -> Result<(), ApiError> {
    private_directory(directory)?;
    let destination = directory.join(POLICY_FILE);
    if destination
        .try_exists()
        .map_err(|_| failure("Approved policy file cannot be checked."))?
    {
        validate_private_file(&destination)?;
    }
    let stage = directory.join(POLICY_STAGE_FILE);
    if stage
        .try_exists()
        .map_err(|_| failure("Approved policy staging file cannot be checked."))?
    {
        validate_private_file(&stage)?;
        std::fs::remove_file(&stage).map_err(|_| failure("Stale policy staging data cannot be removed."))?;
    }
    let bytes = serde_json::to_vec(stored).map_err(|_| failure("Approved policy cannot be serialized."))?;
    if bytes.len() as u64 > MAX_POLICY_FILE_BYTES {
        return Err(failure("Approved policy exceeds its storage limit."));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&stage)
        .map_err(|_| failure("Approved policy staging data cannot be created."))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| failure("Approved policy could not be written durably. Correct configuration storage and retry."))?;
    drop(file);
    std::fs::rename(&stage, &destination)
        .map_err(|_| failure("Approved policy could not be selected. Correct configuration storage and retry."))?;
    #[cfg(unix)]
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| failure("Approved policy directory could not be synchronized. Check configuration storage."))?;
    Ok(())
}

fn load(path: &Path) -> Result<PersistedPolicy, ApiError> {
    validate_private_file(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| failure("Approved policy cannot be read."))?;
    let mut bytes = Vec::new();
    file.take(MAX_POLICY_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("Approved policy cannot be read."))?;
    if bytes.len() as u64 > MAX_POLICY_FILE_BYTES {
        return Err(failure(
            "Approved policy storage exceeds its limit. Reset the owner in native preferences.",
        ));
    }
    let stored: PersistedPolicy = serde_json::from_slice(&bytes)
        .map_err(|_| failure("Approved policy storage is invalid. Reset the owner in native preferences."))?;
    if stored.version != POLICY_VERSION {
        return Err(failure(
            "Approved policy storage version is unsupported. Reset the owner in native preferences.",
        ));
    }
    if let Some(receipt) = &stored.approved {
        validate_origin(&receipt.origin)?;
        if receipt.companion_id != stored.companion_id
            || receipt.version != POLICY_VERSION
            || !(0..=MAX_WIRE_INTEGER).contains(&receipt.revision)
            || receipt.backend_identity.len() != 64
            || !receipt.backend_identity.bytes().all(|byte| byte.is_ascii_hexdigit())
            || receipt.challenge.len() != 64
            || !receipt.challenge.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(failure(
                "Approved policy binding is invalid. Reset the owner in native preferences.",
            ));
        }
        receipt
            .policy
            .validate()
            .map_err(|_| failure("Approved policy values are invalid. Reset the owner in native preferences."))?;
    }
    Ok(stored)
}

impl DirectoryPolicyState {
    pub(super) fn protect_storage(&self, index_namespace: &Path) -> Result<(), ApiError> {
        let configuration = self
            .directory
            .parent()
            .ok_or_else(|| failure("Native policy storage has no configuration parent."))?;
        let roots = vec![canonical_storage_path(configuration)?, canonical_storage_path(index_namespace)?];
        if let Some(existing) = PROTECTED_NATIVE_STORAGE.get() {
            if existing == &roots {
                return Ok(());
            }
            return Err(failure(
                "Policy storage protection is already bound to another directory. Restart the companion.",
            ));
        }
        PROTECTED_NATIVE_STORAGE
            .set(roots)
            .map_err(|_| failure("Policy storage protection changed during initialization. Restart the companion."))
    }

    fn available_state(&self) -> Result<MutexGuard<'_, PolicyState>, ApiError> {
        self.state.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => ApiError::TooManyRequests(
                "Approved policy storage is being updated. Wait for the current operation, then refresh policy status.".to_owned(),
            ),
            TryLockError::Poisoned(_) => failure("Policy owner state is unavailable. Restart the companion."),
        })
    }

    pub fn open(directory: PathBuf, manager: &Arc<LocalDirectoryManager>) -> Result<Arc<Self>, ApiError> {
        private_directory(&directory)?;
        let path = directory.join(POLICY_FILE);
        let lease = super::directory_index::acquire_storage(&path).map_err(|_| failure("Approved policy storage is owned by another instance or unavailable. Close the other companion instance and check private configuration storage."))?;
        let blank = || PersistedPolicy {
            version: POLICY_VERSION,
            companion_id: uuid::Uuid::new_v4(),
            approved: None,
        };
        let (stored, blocked) = if path.try_exists().map_err(|_| failure("Approved policy cannot be checked."))? {
            match load(&path) {
                Ok(stored) => (stored, false),
                Err(_) => (blank(), true),
            }
        } else {
            let stored = blank();
            save(&directory, &stored)?;
            (stored, false)
        };
        if let Some(receipt) = &stored.approved {
            manager
                .apply_policy(receipt.policy.clone())
                .map_err(|_| failure("Approved policy cannot be applied. Restart the companion."))?;
        }
        Ok(Arc::new(Self {
            directory,
            _lease: lease,
            manager: Arc::downgrade(manager),
            state: Mutex::new(PolicyState {
                status: if blocked {
                    "failed"
                } else if stored.approved.is_some() {
                    "applied"
                } else {
                    "unowned"
                },
                stored,
                pending: None,
                last_requested: None,
                prompt_active: false,
                message: blocked.then(|| {
                    "Approved policy storage is invalid. Reset the owner in native preferences before accepting another policy.".to_owned()
                }),
                blocked,
            }),
        }))
    }

    pub fn status(&self, origin: Option<&str>) -> Result<DirectoryPolicyStatus, ApiError> {
        let mut state = self.available_state()?;
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.created.elapsed() >= CHALLENGE_TIMEOUT && !pending.redeeming)
        {
            state.pending = None;
            state.status = if state.stored.approved.is_some() { "applied" } else { "unowned" };
        }
        let receipt = state.stored.approved.as_ref();
        let permitted_pending = state.pending.as_ref().filter(|pending| origin == Some(pending.origin.as_str()));
        let conflict = origin.is_some_and(|origin| receipt.is_some_and(|receipt| receipt.origin != origin));
        Ok(DirectoryPolicyStatus {
            version: POLICY_VERSION,
            companion_id: state.stored.companion_id,
            status: if conflict { "owner_conflict" } else { state.status },
            owner_origin: receipt.map(|receipt| receipt.origin.clone()),
            backend_identity: receipt.map(|receipt| receipt.backend_identity.clone()),
            effective_revision: receipt.map(|receipt| receipt.revision),
            policy: match receipt {
                Some(receipt) => receipt.policy.clone(),
                None => DirectoryPolicy::defaults().map_err(|_| failure("Default directory policy is unavailable."))?,
            },
            challenge: permitted_pending.map(|pending| pending.value.clone()),
            approved: permitted_pending.is_some_and(|pending| pending.approved),
            message: state.message.clone(),
        })
    }

    fn create_challenge(&self, origin: &str) -> Result<bool, ApiError> {
        validate_origin(origin)?;
        let mut state = self.available_state()?;
        if state.blocked {
            return Err(failure("Policy ownership is blocked. Reset the owner in native preferences."));
        }
        if state.prompt_active {
            return Err(ApiError::TooManyRequests(
                "A local policy prompt is still open. Complete or close that prompt before requesting another approval.".to_owned(),
            ));
        }
        if state.stored.approved.as_ref().is_some_and(|owner| owner.origin != origin) {
            return Err(ApiError::Conflict(serde_json::json!(
                "Another backend owns directory-index policy. Reset that owner in native preferences before changing it."
            )));
        }
        if let Some(pending) = &state.pending {
            if pending.created.elapsed() < CHALLENGE_TIMEOUT || pending.redeeming {
                return Err(ApiError::TooManyRequests(
                    "A policy approval is already pending. Complete it or wait for expiry.".to_owned(),
                ));
            }
        }
        if state.last_requested.is_some_and(|last| last.elapsed() < APPROVAL_COOLDOWN) {
            return Err(ApiError::TooManyRequests(
                "Policy approval was requested too recently. Wait briefly and retry.".to_owned(),
            ));
        }
        let approved = state.stored.approved.is_some();
        state.pending = Some(PendingChallenge {
            value: format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple()),
            origin: origin.to_owned(),
            created: Instant::now(),
            approved,
            redeeming: false,
        });
        state.last_requested = Some(Instant::now());
        state.status = if approved { "pending_delivery" } else { "pending_local_approval" };
        state.message = None;
        Ok(!approved)
    }

    pub fn challenge(self: &Arc<Self>, origin: &str, app: &AppHandle) -> Result<DirectoryPolicyStatus, ApiError> {
        if self.create_challenge(origin)? {
            let weak = Arc::downgrade(self);
            let challenge = self
                .status(Some(origin))?
                .challenge
                .ok_or_else(|| failure("Policy challenge is unavailable."))?;
            self.state
                .lock()
                .map_err(|_| failure("Policy owner state is unavailable."))?
                .prompt_active = true;
            app.dialog()
                .message(format!(
                    "Allow {origin} to manage directory-index resource settings on this computer? Choose No to keep the current policy."
                ))
                .title("Directory-Index Policy Owner")
                .buttons(MessageDialogButtons::YesNo)
                .show(move |approved| {
                    if let Some(policy) = weak.upgrade() {
                        if let Ok(mut state) = policy.state.lock() {
                            state.prompt_active = false;
                            if let Some(pending) = state.pending.as_mut() {
                                if pending.value == challenge && pending.created.elapsed() < CHALLENGE_TIMEOUT {
                                    if approved {
                                        pending.approved = true;
                                        state.status = "pending_delivery";
                                    } else {
                                        state.pending = None;
                                        state.status = "denied";
                                    }
                                }
                            }
                        }
                    }
                });
        }
        self.status(Some(origin))
    }

    async fn fetch_receipt(origin: &str, companion_id: uuid::Uuid, challenge: &str, grant: &str) -> Result<PolicyReceipt, ApiError> {
        let parsed = validate_origin(origin)?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REDEMPTION_TIMEOUT);
        if parsed.scheme() == "http" {
            builder = builder.no_proxy();
            if parsed.host_str() == Some("localhost") {
                let port = parsed
                    .port_or_known_default()
                    .ok_or_else(|| failure("Policy origin has no valid port."))?;
                builder = builder.resolve_to_addrs(
                    "localhost",
                    &[
                        std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port),
                        std::net::SocketAddr::new(std::net::Ipv6Addr::LOCALHOST.into(), port),
                    ],
                );
            }
        }
        let client = builder.build().map_err(|_| failure("Policy redemption client cannot start."))?;
        let mut response = client
            .post(format!("{origin}/api/admin/settings/directory-index/companion/grants/redeem"))
            .json(&serde_json::json!({"companion_id": companion_id, "challenge": challenge, "origin": origin, "grant": grant}))
            .send()
            .await
            .map_err(|_| {
                failure("Backend policy redemption is unavailable. Check the approved backend connection and request a new grant.")
            })?;
        if !response.status().is_success() {
            return Err(failure("Backend refused policy redemption. Check current administrator access and request a new grant. Redirects are not permitted."));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("Backend policy receipt could not be read. Request a new grant."))?
        {
            if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
                return Err(failure("Backend policy receipt exceeds its response limit."));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| failure("Backend policy receipt is invalid. Request a new grant from a compatible backend."))
    }

    fn persist_with_recovery(&self, state: &mut PolicyState, stored: &PersistedPolicy) -> Result<(), super::directory_index::IndexError> {
        if save(&self.directory, stored).is_err() {
            if save(&self.directory, &state.stored).is_err() {
                state.blocked = true;
                state.status = "failed";
                state.message = Some(
                    "Policy storage could not be restored. Correct configuration storage, then reset the owner in native preferences."
                        .to_owned(),
                );
            }
            return Err(super::directory_index::IndexError::Invalid(
                "Approved directory policy cannot be stored durably. Correct configuration storage and retry.",
            ));
        }
        Ok(())
    }

    fn select_receipt(&self, receipt: PolicyReceipt) -> Result<(), ApiError> {
        let mut state = self.state.lock().map_err(|_| failure("Policy owner state is unavailable."))?;
        let pending = state
            .pending
            .as_ref()
            .ok_or_else(|| failure("Policy approval was reset before redemption completed."))?;
        if pending.value != receipt.challenge
            || pending.origin != receipt.origin
            || !pending.redeeming
            || !pending.approved
            || pending.created.elapsed() >= CHALLENGE_TIMEOUT
        {
            return Err(failure("Policy approval was replaced or expired before redemption completed."));
        }
        if receipt.version != POLICY_VERSION
            || receipt.companion_id != state.stored.companion_id
            || !(0..=MAX_WIRE_INTEGER).contains(&receipt.revision)
            || receipt.backend_identity.len() != 64
            || !receipt.backend_identity.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(failure(
                "Backend policy receipt does not match this companion. Request a new grant.",
            ));
        }
        receipt
            .policy
            .validate()
            .map_err(|_| failure("Backend policy contains unsupported resource values."))?;
        if let Some(owner) = &state.stored.approved {
            if owner.origin != receipt.origin || owner.backend_identity != receipt.backend_identity || receipt.revision < owner.revision {
                return Err(ApiError::Conflict(serde_json::json!("Policy owner identity changed or its revision moved backwards. Reset the owner in native preferences before accepting it.")));
            }
            if owner.revision == receipt.revision && owner.policy != receipt.policy {
                return Err(failure("Backend returned different policy values for the same revision. Request a new grant after correcting the backend policy."));
            }
        }
        let stored = PersistedPolicy {
            version: POLICY_VERSION,
            companion_id: state.stored.companion_id,
            approved: Some(receipt.clone()),
        };
        let manager = self
            .manager
            .upgrade()
            .ok_or_else(|| failure("Directory manager is unavailable. Restart the companion."))?;
        manager
            .apply_policy_with_persistence(receipt.policy, || self.persist_with_recovery(&mut state, &stored))
            .map_err(|error| failure(&format!("Approved policy was not applied. {error}")))?;
        state.stored = stored;
        state.pending = None;
        state.status = "applied";
        state.message = None;
        Ok(())
    }

    pub async fn redeem(self: &Arc<Self>, origin: &str, delivery: PolicyGrantDelivery) -> Result<DirectoryPolicyStatus, ApiError> {
        if delivery.grant.is_empty() || delivery.grant.len() > MAX_GRANT_BYTES {
            return Err(failure("Policy grant size is invalid. Request a new grant."));
        }
        let (companion_id, challenge) = {
            let mut state = self.available_state()?;
            let companion_id = state.stored.companion_id;
            let pending = state
                .pending
                .as_mut()
                .ok_or_else(|| failure("No policy challenge is pending. Request approval first."))?;
            if pending.origin != origin || !pending.approved || pending.created.elapsed() >= CHALLENGE_TIMEOUT || pending.redeeming {
                return Err(ApiError::Conflict(serde_json::json!("Policy challenge is not approved, expired, or already being redeemed. Complete local approval or request a new challenge.")));
            }
            pending.redeeming = true;
            let challenge = pending.value.clone();
            state.status = "redeeming";
            (companion_id, challenge)
        };
        let policy = Arc::clone(self);
        let origin = origin.to_owned();
        let ownership = PolicyRedemptionOwnership {
            policy: Arc::clone(&policy),
            challenge: challenge.clone(),
        };
        tokio::spawn(async move {
            let _ownership = ownership;
            let outcome = match Self::fetch_receipt(&origin, companion_id, &challenge, &delivery.grant).await {
                Ok(receipt) => {
                    let selection = Arc::clone(&policy);
                    match tokio::task::spawn_blocking(move || selection.select_receipt(receipt)).await {
                        Ok(outcome) => outcome,
                        Err(_) => Err(failure("Policy storage worker failed. Restart the companion.")),
                    }
                }
                Err(error) => Err(error),
            };
            if let Err(error) = outcome {
                let mut state = policy.state.lock().map_err(|_| failure("Policy owner state is unavailable."))?;
                if state.pending.as_ref().is_some_and(|pending| pending.value == challenge) {
                    state.pending = None;
                    state.status = "failed";
                    if !state.blocked {
                        state.message = Some(
                            "Policy redemption failed. Existing approved policy remains active. Request a new approval grant.".to_owned(),
                        );
                    }
                }
                return Err(error);
            }
            policy.status(Some(&origin))
        })
        .await
        .map_err(|_| failure("Policy redemption worker failed. Restart the companion."))?
    }

    fn reset(&self) -> Result<(), ApiError> {
        let mut state = self.state.lock().map_err(|_| failure("Policy owner state is unavailable."))?;
        let manager = self
            .manager
            .upgrade()
            .ok_or_else(|| failure("Directory manager is unavailable. Restart the companion before resetting its policy owner."))?;
        let defaults = DirectoryPolicy::defaults().map_err(|_| failure("Default policy is unavailable."))?;
        let stored = PersistedPolicy {
            version: POLICY_VERSION,
            companion_id: state.stored.companion_id,
            approved: None,
        };
        manager
            .apply_policy_with_persistence(defaults, || self.persist_with_recovery(&mut state, &stored))
            .map_err(|error| failure(&format!("Default policy was not applied. {error}")))?;
        state.stored = stored;
        state.pending = None;
        state.status = "unowned";
        state.blocked = false;
        state.message = None;
        Ok(())
    }
}

#[tauri::command]
pub fn get_native_directory_policy_status(app: AppHandle) -> Result<DirectoryPolicyStatus, String> {
    app.try_state::<Arc<DirectoryPolicyState>>()
        .ok_or_else(|| "Directory policy is not ready. Wait briefly and retry.".to_owned())?
        .status(None)
        .map_err(|_| "Directory policy state is unavailable. Restart the companion.".to_owned())
}

#[tauri::command]
pub async fn reset_native_directory_policy_owner(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if window.label() != crate::MAIN_WINDOW_LABEL {
        return Err("Policy owner reset is available only in native preferences.".to_owned());
    }
    let managed = app
        .try_state::<Arc<DirectoryPolicyState>>()
        .ok_or_else(|| "Directory policy is not ready. Wait briefly and retry.".to_owned())?;
    let policy = Arc::clone(managed.inner());
    tokio::task::spawn_blocking(move || policy.reset())
        .await
        .map_err(|_| "Policy owner reset worker failed. Restart the companion.".to_owned())?
        .map_err(|_| "Policy owner could not be reset. Check private configuration storage.".to_owned())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn failed_policy_storage_preserves_old_owner_and_blocks_ambiguous_delivery() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let directory = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(directory.clone(), &manager).unwrap();
        let before = std::fs::read(directory.join(POLICY_FILE)).unwrap();
        policy.create_challenge("https://sambee.example").unwrap();
        let (companion_id, challenge) = {
            let mut state = policy.state.lock().unwrap();
            let pending = state.pending.as_mut().unwrap();
            pending.approved = true;
            pending.redeeming = true;
            let challenge = pending.value.clone();
            (state.stored.companion_id, challenge)
        };
        std::fs::create_dir(directory.join(POLICY_STAGE_FILE)).unwrap();
        let mut proposed = DirectoryPolicy::defaults().unwrap();
        proposed.page_cache_kib = 64;
        assert!(policy
            .select_receipt(PolicyReceipt {
                version: POLICY_VERSION,
                companion_id,
                challenge,
                origin: "https://sambee.example".to_owned(),
                backend_identity: "b".repeat(64),
                revision: 1,
                policy: proposed
            })
            .is_err());
        assert_eq!(std::fs::read(directory.join(POLICY_FILE)).unwrap(), before);
        let state = policy.state.lock().unwrap();
        assert!(state.blocked);
        assert!(state.stored.approved.is_none());
        assert!(state.message.as_deref().unwrap().contains("Correct configuration storage"));
    }

    #[tokio::test]
    async fn unavailable_manager_cannot_clear_durable_policy_owner() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let path = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        let stored = PersistedPolicy {
            version: POLICY_VERSION,
            companion_id: policy.status(None).unwrap().companion_id,
            approved: Some(PolicyReceipt {
                version: POLICY_VERSION,
                companion_id: policy.status(None).unwrap().companion_id,
                challenge: "a".repeat(64),
                origin: "https://sambee.example".to_owned(),
                backend_identity: "b".repeat(64),
                revision: 1,
                policy: DirectoryPolicy::defaults().unwrap(),
            }),
        };
        save(&path, &stored).unwrap();
        policy.state.lock().unwrap().stored = stored;
        let before = std::fs::read(path.join(POLICY_FILE)).unwrap();
        drop(manager);
        assert!(policy.reset().is_err());
        assert_eq!(std::fs::read(path.join(POLICY_FILE)).unwrap(), before);
        assert_eq!(policy.status(None).unwrap().owner_origin.as_deref(), Some("https://sambee.example"));
    }

    use super::*;

    #[test]
    fn origins_require_exact_https_or_loopback_http() {
        for origin in [
            "https://sambee.example",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            assert!(validate_origin(origin).is_ok());
        }
        for origin in [
            "http://remote.example",
            "https://user:password@sambee.example",
            "https://sambee.example/path",
            "https://sambee.example?query=1",
            "https://sambee.example/",
        ] {
            assert!(validate_origin(origin).is_err());
        }
    }

    #[test]
    fn deliveries_reject_browser_policy_and_origin_extras() {
        assert!(
            serde_json::from_value::<PolicyGrantDelivery>(serde_json::json!({"grant": "token", "policy": {"disk_budget_bytes": 1}}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<PolicyGrantDelivery>(serde_json::json!({"grant": "token", "origin": "https://other.example"}))
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_storage_components_use_ordinal_unicode_case_comparison() {
        let protected = Path::new("C:\\Users\\\u{00c5}sa\\cache");
        assert!(storage_path_starts_with(Path::new("c:\\users\\\u{00e5}SA\\CACHE\\new"), protected).unwrap());
        assert!(!storage_path_starts_with(Path::new("C:\\Users\\\u{00e5}sa\\cache-other"), protected).unwrap());
        assert!(storage_path_starts_with(protected, Path::new("c:\\USERS\\\u{00e5}sa")).unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn windows_unicode_case_alias_cannot_mutate_native_storage() {
        let temporary = tempfile::tempdir().unwrap();
        let protected = temporary.path().join("\u{00c5}policy");
        std::fs::create_dir(&protected).unwrap();
        let alias = temporary.path().join("\u{00e5}POLICY").join("new.json");
        assert!(ensure_outside_policy_storage(&alias, &protected).is_err());
    }

    #[test]
    fn file_mutations_cannot_replace_policy_files_or_their_parent_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let protected = temporary.path().join("private-policy");
        std::fs::create_dir(&protected).unwrap();
        std::fs::write(protected.join(POLICY_FILE), b"approved").unwrap();
        let protected = protected.canonicalize().unwrap();
        for path in [
            protected.clone(),
            protected.join(POLICY_FILE),
            protected.join("new/receipt.json"),
            temporary.path().to_path_buf(),
        ] {
            assert!(ensure_outside_policy_storage(&path, &protected).is_err());
        }
        assert!(ensure_outside_policy_storage(&temporary.path().join("ordinary/new.json"), &protected).is_ok());
        assert!(ensure_outside_policy_storage(&temporary.path().join("private-policy-other"), &protected).is_ok());
        #[cfg(unix)]
        {
            let alias = temporary.path().join("alias");
            std::os::unix::fs::symlink(&protected, &alias).unwrap();
            assert!(ensure_outside_policy_storage(&alias.join(POLICY_FILE), &protected).is_err());
            assert!(ensure_outside_policy_storage(&alias.join("new/receipt.json"), &protected).is_err());
        }
    }

    #[tokio::test]
    async fn native_storage_binding_protects_configuration_and_index_database_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("index-cache");
        let manager = LocalDirectoryManager::new(namespace.clone()).unwrap();
        let configuration = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(configuration.join("policy"), &manager).unwrap();
        policy.protect_storage(&namespace).unwrap();
        for path in [
            configuration.join("preferences.json"),
            policy.directory.join(POLICY_FILE),
            namespace.join("source.sqlite3"),
            namespace.clone(),
        ] {
            assert!(ensure_mutation_allowed(&path).is_err());
        }
        assert!(ensure_mutation_allowed(&temporary.path().join("ordinary.txt")).is_ok());
        #[cfg(windows)]
        assert!(ensure_mutation_allowed(&PathBuf::from(namespace.to_str().unwrap().to_ascii_uppercase())).is_err());
    }

    #[tokio::test]
    async fn native_owner_is_single_and_pending_approvals_are_bounded() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        assert!(policy.create_challenge("https://sambee.example").unwrap());
        assert!(policy.create_challenge("https://other.example").is_err());
        let status = policy.status(Some("https://sambee.example")).unwrap();
        assert_eq!(status.status, "pending_local_approval");
        assert!(!status.approved);
        assert!(policy.status(Some("https://other.example")).unwrap().challenge.is_none());
        assert!(policy
            .redeem("https://sambee.example", PolicyGrantDelivery { grant: "token".into() })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn policy_storage_lease_is_held_until_the_actual_owner_exits() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let path = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        let retained = Arc::clone(&policy);
        assert!(DirectoryPolicyState::open(path.clone(), &manager).is_err());
        drop(policy);
        assert!(DirectoryPolicyState::open(path.clone(), &manager).is_err());
        drop(retained);
        assert!(DirectoryPolicyState::open(path, &manager).is_ok());
    }

    #[tokio::test]
    async fn status_and_approval_do_not_wait_for_a_blocked_storage_writer() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let held = policy.state.lock().unwrap();
        assert!(matches!(policy.status(None), Err(ApiError::TooManyRequests(_))));
        assert!(matches!(
            policy.create_challenge("https://sambee.example"),
            Err(ApiError::TooManyRequests(_))
        ));
        drop(held);
        assert!(policy.status(None).is_ok());
    }

    #[tokio::test]
    async fn expired_challenge_does_not_release_an_outstanding_native_prompt() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        policy.create_challenge("https://sambee.example").unwrap();
        {
            let mut state = policy.state.lock().unwrap();
            state.pending.as_mut().unwrap().created -= CHALLENGE_TIMEOUT;
            state.last_requested = None;
            state.prompt_active = true;
        }
        assert!(policy.status(None).unwrap().challenge.is_none());
        assert!(policy.create_challenge("https://sambee.example").is_err());
        policy.reset().unwrap();
        assert!(policy.create_challenge("https://sambee.example").is_err());
        policy.state.lock().unwrap().prompt_active = false;
        assert!(policy.create_challenge("https://sambee.example").unwrap());
    }

    #[tokio::test]
    async fn persisted_owner_and_policy_survive_restart_and_native_reset() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let path = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        let companion_id = policy.status(None).unwrap().companion_id;
        let receipt = PolicyReceipt {
            version: POLICY_VERSION,
            companion_id,
            challenge: "a".repeat(64),
            origin: "https://sambee.example".into(),
            backend_identity: "b".repeat(64),
            revision: 7,
            policy: DirectoryPolicy::defaults().unwrap(),
        };
        save(
            &path,
            &PersistedPolicy {
                version: POLICY_VERSION,
                companion_id,
                approved: Some(receipt),
            },
        )
        .unwrap();
        drop(policy);
        let reopened = DirectoryPolicyState::open(path, &manager).unwrap();
        assert_eq!(reopened.status(None).unwrap().effective_revision, Some(7));
        assert!(reopened.create_challenge("https://other.example").is_err());
        reopened.reset().unwrap();
        assert_eq!(reopened.status(None).unwrap().owner_origin, None);
        assert_eq!(reopened.status(None).unwrap().companion_id, companion_id);
    }

    #[tokio::test]
    async fn invalid_stored_policy_requires_native_reset_without_overwriting_it() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let path = temporary.path().join("configuration");
        let policy = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        drop(policy);
        std::fs::write(path.join(POLICY_FILE), b"invalid policy").unwrap();
        let reopened = DirectoryPolicyState::open(path.clone(), &manager).unwrap();
        assert_eq!(reopened.status(None).unwrap().status, "failed");
        assert!(reopened.create_challenge("https://sambee.example").is_err());
        assert_eq!(std::fs::read(path.join(POLICY_FILE)).unwrap(), b"invalid policy");
        reopened.reset().unwrap();
        assert_eq!(reopened.status(None).unwrap().status, "unowned");
    }

    #[tokio::test]
    async fn direct_receipt_is_applied_only_after_local_approval() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://localhost:{}", listener.local_addr().unwrap().port());
        policy.create_challenge(&origin).unwrap();
        let status = policy.status(Some(&origin)).unwrap();
        let mut values = DirectoryPolicy::defaults().unwrap();
        values.page_cache_kib = 1024;
        let receipt = PolicyReceipt {
            version: POLICY_VERSION,
            companion_id: status.companion_id,
            challenge: status.challenge.unwrap(),
            origin: origin.clone(),
            backend_identity: "b".repeat(64),
            revision: 3,
            policy: values.clone(),
        };
        let server = tokio::spawn(async move {
            let router = axum::Router::new().route(
                "/api/admin/settings/directory-index/companion/grants/redeem",
                axum::routing::post(move || {
                    let receipt = receipt.clone();
                    async move { axum::Json(receipt) }
                }),
            );
            axum::serve(listener, router).await.unwrap();
        });
        assert!(policy
            .redeem(&origin, PolicyGrantDelivery { grant: "opaque".into() })
            .await
            .is_err());
        policy.state.lock().unwrap().pending.as_mut().unwrap().approved = true;
        let applied = policy
            .redeem(&origin, PolicyGrantDelivery { grant: "opaque".into() })
            .await
            .unwrap();
        assert_eq!(applied.effective_revision, Some(3));
        assert_eq!(applied.policy, values);
        assert_eq!(applied.status, "applied");
        server.abort();
    }

    #[tokio::test]
    async fn redirects_are_not_followed_and_failed_delivery_keeps_policy() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let redirect_hits = Arc::clone(&hits);
        let target = format!("{origin}/redirected");
        let server = tokio::spawn(async move {
            let router = axum::Router::new()
                .route(
                    "/api/admin/settings/directory-index/companion/grants/redeem",
                    axum::routing::post(move || {
                        let target = target.clone();
                        async move { axum::response::Redirect::temporary(&target) }
                    }),
                )
                .route(
                    "/redirected",
                    axum::routing::get(move || {
                        redirect_hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        async { "unsafe" }
                    }),
                );
            axum::serve(listener, router).await.unwrap();
        });
        let result = DirectoryPolicyState::fetch_receipt(&origin, uuid::Uuid::new_v4(), &"a".repeat(64), "opaque").await;
        assert!(result.is_err());
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn cancelled_http_request_does_not_cancel_admitted_redemption() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        policy.create_challenge(&origin).unwrap();
        policy.state.lock().unwrap().pending.as_mut().unwrap().approved = true;
        let status = policy.status(Some(&origin)).unwrap();
        let receipt = PolicyReceipt {
            version: POLICY_VERSION,
            companion_id: status.companion_id,
            challenge: status.challenge.unwrap(),
            origin: origin.clone(),
            backend_identity: "b".repeat(64),
            revision: 3,
            policy: DirectoryPolicy::defaults().unwrap(),
        };
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let server_entered = Arc::clone(&entered);
        let server_release = Arc::clone(&release);
        let server = tokio::spawn(async move {
            let router = axum::Router::new().route(
                "/api/admin/settings/directory-index/companion/grants/redeem",
                axum::routing::post(move || {
                    let entered = Arc::clone(&server_entered);
                    let release = Arc::clone(&server_release);
                    let receipt = receipt.clone();
                    async move {
                        entered.notify_one();
                        release.notified().await;
                        axum::Json(receipt)
                    }
                }),
            );
            axum::serve(listener, router).await.unwrap();
        });
        let request_policy = Arc::clone(&policy);
        let request = tokio::spawn(async move { request_policy.redeem(&origin, PolicyGrantDelivery { grant: "opaque".into() }).await });
        entered.notified().await;
        request.abort();
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match policy.status(None) {
                    Ok(status) if status.status == "applied" => break,
                    Ok(_) | Err(ApiError::TooManyRequests(_)) => tokio::task::yield_now().await,
                    Err(error) => panic!("Unexpected policy status: {error:?}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(policy.status(None).unwrap().effective_revision, Some(3));
        server.abort();
    }

    #[tokio::test]
    async fn oversized_receipt_is_refused_and_ownership_cleans_up() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        policy.create_challenge(&origin).unwrap();
        policy.state.lock().unwrap().pending.as_mut().unwrap().approved = true;
        let server = tokio::spawn(async move {
            let router = axum::Router::new().route(
                "/api/admin/settings/directory-index/companion/grants/redeem",
                axum::routing::post(|| async { "x".repeat(MAX_RESPONSE_BYTES + 1) }),
            );
            axum::serve(listener, router).await.unwrap();
        });
        assert!(policy
            .redeem(&origin, PolicyGrantDelivery { grant: "opaque".into() })
            .await
            .is_err());
        assert_eq!(policy.status(None).unwrap().status, "failed");
        assert!(policy.state.lock().unwrap().pending.is_none());
        assert!(policy.status(None).unwrap().owner_origin.is_none());
        server.abort();
    }

    #[tokio::test]
    async fn invalid_bindings_and_changed_values_at_the_same_revision_are_refused() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let policy = DirectoryPolicyState::open(temporary.path().join("configuration"), &manager).unwrap();
        let origin = "https://sambee.example";
        policy.create_challenge(origin).unwrap();
        {
            let mut state = policy.state.lock().unwrap();
            let pending = state.pending.as_mut().unwrap();
            pending.approved = true;
            pending.redeeming = true;
        }
        let status = policy.status(Some(origin)).unwrap();
        let receipt = PolicyReceipt {
            version: POLICY_VERSION,
            companion_id: status.companion_id,
            challenge: status.challenge.unwrap(),
            origin: origin.into(),
            backend_identity: "a".repeat(64),
            revision: 3,
            policy: DirectoryPolicy::defaults().unwrap(),
        };
        let mut wrong_companion = receipt.clone();
        wrong_companion.companion_id = uuid::Uuid::new_v4();
        let mut wrong_challenge = receipt.clone();
        wrong_challenge.challenge = "b".repeat(64);
        let mut wrong_origin = receipt.clone();
        wrong_origin.origin = "https://other.example".into();
        let mut wrong_identity = receipt.clone();
        wrong_identity.backend_identity = "z".repeat(64);
        let mut unsafe_revision = receipt.clone();
        unsafe_revision.revision = MAX_WIRE_INTEGER + 1;
        let mut invalid_policy = receipt.clone();
        invalid_policy.policy.page_cache_kib = 1;
        for invalid in [
            wrong_companion,
            wrong_challenge,
            wrong_origin,
            wrong_identity,
            unsafe_revision,
            invalid_policy,
        ] {
            assert!(policy.select_receipt(invalid).is_err());
            assert!(load(&policy.directory.join(POLICY_FILE)).unwrap().approved.is_none());
        }
        policy.select_receipt(receipt.clone()).unwrap();
        policy.state.lock().unwrap().last_requested = None;
        policy.create_challenge(origin).unwrap();
        let mut changed = receipt.clone();
        changed.challenge = policy.status(Some(origin)).unwrap().challenge.unwrap();
        changed.policy.page_cache_kib = 1024;
        policy.state.lock().unwrap().pending.as_mut().unwrap().redeeming = true;
        assert!(policy.select_receipt(changed).is_err());
        assert_eq!(
            load(&policy.directory.join(POLICY_FILE)).unwrap().approved.unwrap().policy,
            receipt.policy
        );
    }
}
