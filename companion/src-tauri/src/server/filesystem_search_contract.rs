//! Wire types and shared resource limits for live file-system search.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use super::filesystem_search_matching::NameMatcher;
use super::models::FileInfo;

const CONTRACT: &str = include_str!("../../../../shared/filesystem-search/contract.json");

#[derive(Debug, Deserialize)]
pub struct Limits {
    pub query_utf8_bytes: usize,
    pub zip_central_directory_bytes: usize,
    pub pending_directory_bytes: usize,
    pub pending_directory_entry_bytes: usize,
    pub result_batch_items: usize,
    pub stream_record_bytes: usize,
    pub queued_batches: usize,
    pub skip_reason_types: usize,
}

#[derive(Deserialize)]
struct Contract {
    version: u8,
    limits: Limits,
    policy_defaults: Policy,
    policy_bounds: PolicyBounds,
}

fn contract() -> &'static Contract {
    static CONTRACT_DATA: OnceLock<Contract> = OnceLock::new();
    let contract = CONTRACT_DATA.get_or_init(|| serde_json::from_str(CONTRACT).expect("Embedded file-search contract must be valid"));
    assert_eq!(contract.version, 1, "Unsupported file-search contract version");
    assert!(
        [
            contract.limits.query_utf8_bytes,
            contract.limits.zip_central_directory_bytes,
            contract.limits.pending_directory_bytes,
            contract.limits.pending_directory_entry_bytes,
            contract.limits.result_batch_items,
            contract.limits.stream_record_bytes,
            contract.limits.queued_batches,
            contract.limits.skip_reason_types,
        ]
        .iter()
        .all(|value| *value > 0),
        "Embedded file-search contract limits must be positive"
    );
    assert!(
        contract.policy_bounds.valid() && contract.policy_bounds.contains(contract.policy_defaults),
        "Embedded search policy bounds and defaults must be valid"
    );
    contract
}

pub fn limits() -> &'static Limits {
    &contract().limits
}

pub(super) const MAX_SAFE_JSON_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyRange {
    min: u64,
    max: u64,
}

impl PolicyRange {
    fn valid(&self) -> bool {
        self.min > 0 && self.min <= self.max && self.max <= MAX_SAFE_JSON_INTEGER
    }

    fn contains(&self, value: u64) -> bool {
        (self.min..=self.max).contains(&value)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyBounds {
    concurrent_searches: PolicyRange,
    max_seconds: PolicyRange,
    max_results: PolicyRange,
}

impl PolicyBounds {
    fn valid(&self) -> bool {
        self.concurrent_searches.valid() && self.max_seconds.valid() && self.max_results.valid()
    }

    fn contains(&self, policy: Policy) -> bool {
        u64::try_from(policy.concurrent_searches).is_ok_and(|value| self.concurrent_searches.contains(value))
            && self.max_seconds.contains(policy.max_seconds)
            && self.max_results.contains(policy.max_results)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub concurrent_searches: usize,
    pub max_seconds: u64,
    pub max_results: u64,
}

impl Policy {
    pub fn validate(&self) -> bool {
        contract().policy_bounds.contains(*self)
    }
}

pub fn default_policy() -> Policy {
    contract().policy_defaults
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub kind: SourceKind,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Smb,
    Local,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Root {
    Directory { path: String },
    Archive { path: String, member_path: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderDepth {
    Current,
    Recursive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    All,
    Files,
    Directories,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u8,
    pub source: Source,
    pub root: Root,
    pub query: String,
    pub case_sensitive: bool,
    pub folder_depth: FolderDepth,
    pub item_type: ItemType,
    pub search_archives: bool,
}

impl Request {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("File-system search version is unsupported. Update the client and retry.");
        }
        if self.source.id.is_empty() || self.source.id.chars().count() > 256 {
            return Err("Search source is invalid. Select a source and retry.");
        }
        if self.query.len() > limits().query_utf8_bytes {
            return Err("Search term is too long. Use a shorter term and retry.");
        }
        NameMatcher::new(&self.query, self.case_sensitive)?;
        let validate_path = |path: &str| {
            if !path.is_empty() && super::directory_index::validate_directory_path(path).is_err() {
                Err("Search root is invalid. Select a folder and retry.")
            } else {
                Ok(())
            }
        };
        match &self.root {
            Root::Directory { path } => validate_path(path)?,
            Root::Archive { path, member_path } => {
                if path.is_empty() {
                    return Err("Search archive is invalid. Select an archive and retry.");
                }
                validate_path(path)?;
                validate_path(member_path)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Physical { path: String },
    Archive { archive_path: String, member_path: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub entry: FileInfo,
    pub target: Target,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_state: Option<ArchiveState>,
}

impl Item {
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid_path = |path: &str| !path.is_empty() && super::directory_index::validate_directory_path(path).is_ok();
        let path = match &self.target {
            Target::Physical { path } => {
                if self.archive_state.is_some() {
                    return Err("Physical search results cannot have an archive state.");
                }
                path
            }
            Target::Archive { archive_path, member_path } => {
                if !valid_path(archive_path) {
                    return Err("Archive search target is invalid.");
                }
                match &self.archive_state {
                    Some(state) if self.entry.is_readable == matches!(state, ArchiveState::Readable) => {}
                    _ => return Err("Archive result state is invalid."),
                }
                member_path
            }
        };
        if !valid_path(path) || self.entry.path != *path || path.rsplit('/').next() != Some(self.entry.name.as_str()) {
            return Err("Search result metadata does not match its target.");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveState {
    Readable,
    Blocked,
    Unavailable,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchLimits {
    pub max_seconds: u64,
    pub max_results: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Counts {
    pub matches: u64,
    pub scanned_directories: u64,
    pub skipped: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    UnreadableDirectory,
    UnsafeName,
    ArchiveTooLarge,
    ArchiveUnreadable,
    QueueLimit,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Skip {
    pub reason: SkipReason,
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalReason {
    Complete,
    PartialCoverage,
    TimeLimit,
    ResultLimit,
    SourceFailure,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Record {
    Start {
        version: u8,
        request_id: String,
        limits: SearchLimits,
    },
    Batch {
        results: Vec<Item>,
    },
    Terminal {
        reason: TerminalReason,
        counts: Counts,
        skips: Vec<Skip>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_uses_all_shared_bounds() {
        let bounds = &contract().policy_bounds;
        let mut policy = default_policy();
        policy.concurrent_searches = usize::try_from(bounds.concurrent_searches.max).unwrap();
        policy.max_seconds = bounds.max_seconds.max;
        policy.max_results = bounds.max_results.max;
        assert!(policy.validate());
        policy.max_results += 1;
        assert!(!policy.validate());
        policy = default_policy();
        policy.concurrent_searches = 0;
        assert!(!policy.validate());
        policy = default_policy();
        policy.max_seconds = 0;
        assert!(!policy.validate());
    }

    #[test]
    fn shared_wire_fixtures_are_readable() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../shared/filesystem-search/stream-fixtures.json")).unwrap();
        for value in fixtures["requests"].as_array().unwrap() {
            let request: Request = serde_json::from_value(value.clone()).unwrap();
            request.validate().unwrap();
        }
        for value in fixtures["stream"].as_array().unwrap() {
            let record: Record = serde_json::from_value(value.clone()).unwrap();
            if let Record::Batch { results } = record {
                for item in results {
                    item.validate().unwrap();
                }
            }
        }
    }
}
