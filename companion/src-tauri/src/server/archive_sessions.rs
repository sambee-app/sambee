//! Short-lived lifecycle state for Companion-owned local archive executions.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::archive::{
    ArchiveCreationManifestState, LocalArchiveCreationExecutionPlan, LocalArchiveCreationResult, LocalArchiveEntry, LocalArchiveError,
    LocalArchiveExtractionDestinationResult, LocalArchiveExtractionDestinationStatus, LocalArchiveExtractionMemberError,
    LocalArchiveExtractionResult, LocalArchiveReadEntry, LocalArchiveReadError, LocalArchiveReader, LocalArchiveTargetWritePolicy,
};
use super::errors::ApiError;
use super::models::ArchiveContractVersion;
pub const ARCHIVE_SESSION_TIMEOUT: Duration = Duration::from_secs(120);
pub const ARCHIVE_SESSION_STALE_REVISION_CODE: &str = "archive_execution_stale_revision";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveSessionKind {
    Create,
    Extract,
}

impl ArchiveSessionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Extract => "extract",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveSessionPhase {
    Accepted,
    Streaming,
    AwaitingUserDecision,
    Completed,
    Cancelled,
    Failed,
}

impl ArchiveSessionPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Streaming => "streaming",
            Self::AwaitingUserDecision => "awaiting_user_decision",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchiveSessionPendingDecision {
    pub source_session_id: String,
    pub delivery_sequence: u64,
    pub decision_revision: u64,
    pub member_path: String,
    pub source_size: u64,
    pub source_modified_at: Option<DateTime<Utc>>,
    pub target_path: Option<String>,
    pub target_size: Option<u64>,
    pub target_modified_at: Option<DateTime<Utc>>,
    pub is_directory: bool,
    pub member_error: Option<LocalArchiveExtractionMemberError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveSessionProgress {
    Creation(LocalArchiveCreationResult),
    Extraction(LocalArchiveExtractionResult),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArchiveSessionDecisionAction {
    Skip,
    SkipAll,
    Replace,
    ReplaceAll,
    ReplaceOlder,
    Rename,
    Retry,
    Ignore,
}

/// One explicit source-owned phase for a retained local ZIP extraction reader.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LiveLocalArchiveSourcePhase {
    Ready,
    Current,
    StreamingCurrent,
    AwaitingResult,
    AwaitingDecision,
    ResolvingDecision,
    Completed,
    Cancelled,
    Failed,
}

/// One delivery leased to a destination from the retained local ZIP reader.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LiveLocalArchiveSourceMember {
    pub entry: LocalArchiveReadEntry,
    pub delivery_sequence: u64,
}

#[derive(Clone, Debug)]
struct ClaimedLiveSourceDecision {
    action: ArchiveSessionDecisionAction,
    target_path: Option<String>,
}

/// Process-local extraction source state. It is intentionally non-serializable.
pub(crate) struct LiveLocalArchiveSourceSession {
    source_session_id: String,
    reader: LocalArchiveReader,
    phase: LiveLocalArchiveSourcePhase,
    current: Option<LiveLocalArchiveSourceMember>,
    redelivery_available: bool,
    current_target_path: Option<String>,
    current_target_policy: LocalArchiveTargetWritePolicy,
    global_target_policy: LocalArchiveTargetWritePolicy,
    next_delivery_sequence: u64,
    next_decision_revision: u64,
    pending_decision_revision: Option<u64>,
    pending_decision_target_path: Option<String>,
    pending_decision_target_size: Option<u64>,
    pending_decision_target_modified_at: Option<DateTime<Utc>>,
    pending_decision_message: Option<String>,
    pending_member_error: bool,
    claimed_decision: Option<ClaimedLiveSourceDecision>,
    aggregate: LocalArchiveExtractionResult,
    selected_member_roots: Option<Vec<String>>,
    projected_entries: Option<Vec<LocalArchiveReadEntry>>,
    projected_entry_index: usize,
}

impl LiveLocalArchiveSourceSession {
    #[cfg(test)]
    pub(crate) fn open(archive_path: &std::path::Path) -> Result<Self, LocalArchiveError> {
        Self::open_with_selection(archive_path, None)
    }

    pub(crate) fn open_with_selection(
        archive_path: &std::path::Path,
        selected_member_roots: Option<Vec<String>>,
    ) -> Result<Self, LocalArchiveError> {
        Ok(Self {
            source_session_id: Uuid::new_v4().to_string(),
            reader: LocalArchiveReader::open_pinned(archive_path)?,
            phase: LiveLocalArchiveSourcePhase::Ready,
            current: None,
            redelivery_available: false,
            current_target_path: None,
            current_target_policy: LocalArchiveTargetWritePolicy::Ask,
            global_target_policy: LocalArchiveTargetWritePolicy::Ask,
            next_delivery_sequence: 1,
            next_decision_revision: 1,
            pending_decision_revision: None,
            pending_decision_target_path: None,
            pending_decision_target_size: None,
            pending_decision_target_modified_at: None,
            pending_decision_message: None,
            pending_member_error: false,
            claimed_decision: None,
            aggregate: LocalArchiveExtractionResult::default(),
            selected_member_roots,
            projected_entries: None,
            projected_entry_index: 0,
        })
    }

    pub(crate) fn phase(&self) -> LiveLocalArchiveSourcePhase {
        self.phase
    }

    pub(crate) fn source_session_id(&self) -> &str {
        &self.source_session_id
    }

    pub(crate) fn aggregate(&self) -> LocalArchiveExtractionResult {
        self.aggregate
    }

    pub(crate) fn current(&self) -> Option<&LiveLocalArchiveSourceMember> {
        self.current.as_ref()
    }

    pub(crate) fn current_target_path(&self) -> Result<String, LocalArchiveError> {
        let current = self
            .current
            .as_ref()
            .ok_or_else(|| Self::invalid_state("Archive source member is unavailable"))?;
        if let Some(target_path) = &self.current_target_path {
            return Ok(target_path.clone());
        }
        Ok(current.entry.path.clone())
    }

    pub(crate) fn current_target_policy(&self) -> LocalArchiveTargetWritePolicy {
        self.current_target_policy
    }

    pub(crate) fn pending_member_error(&self) -> bool {
        self.pending_member_error
    }

    pub(crate) fn pending_decision_revision(&self) -> Option<u64> {
        self.pending_decision_revision
    }

    pub(crate) fn pending_decision_target_path(&self) -> Option<&str> {
        self.pending_decision_target_path.as_deref()
    }

    pub(crate) fn pending_decision_target_size(&self) -> Option<u64> {
        self.pending_decision_target_size
    }

    pub(crate) fn pending_decision_target_modified_at(&self) -> Option<DateTime<Utc>> {
        self.pending_decision_target_modified_at
    }

    pub(crate) fn pending_decision_message(&self) -> Option<&str> {
        self.pending_decision_message.as_deref()
    }

    pub(crate) fn pending_decision(&self) -> Result<Option<ArchiveSessionPendingDecision>, LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingDecision {
            return Ok(None);
        }
        let current = self
            .current
            .as_ref()
            .ok_or_else(|| Self::invalid_state("Archive source member is unavailable"))?;
        let decision_revision = self
            .pending_decision_revision
            .ok_or_else(|| Self::invalid_state("Archive source decision revision is unavailable"))?;
        let member_error = if self.pending_member_error {
            Some(LocalArchiveExtractionMemberError {
                member_path: current.entry.path.clone(),
                target_path: self
                    .pending_decision_target_path
                    .clone()
                    .ok_or_else(|| Self::invalid_state("Archive source error target is unavailable"))?,
                message: self
                    .pending_decision_message
                    .clone()
                    .ok_or_else(|| Self::invalid_state("Archive source error message is unavailable"))?,
                partial_output: true,
            })
        } else {
            None
        };
        Ok(Some(ArchiveSessionPendingDecision {
            source_session_id: self.source_session_id.clone(),
            delivery_sequence: current.delivery_sequence,
            decision_revision,
            member_path: current.entry.path.clone(),
            source_size: current.entry.uncompressed_size,
            source_modified_at: current.entry.modified_at,
            target_path: self.pending_decision_target_path.clone(),
            target_size: self.pending_decision_target_size,
            target_modified_at: self.pending_decision_target_modified_at,
            is_directory: current.entry.is_directory,
            member_error,
        }))
    }

    pub(crate) fn set_pending_decision_details(
        &mut self,
        target_path: Option<String>,
        message: Option<String>,
        target_size: Option<u64>,
        target_modified_at: Option<DateTime<Utc>>,
    ) -> Result<(), LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingDecision {
            return Err(Self::invalid_state("Archive source is not awaiting a decision"));
        }
        self.pending_decision_target_path = target_path;
        self.pending_decision_message = message;
        self.pending_decision_target_size = target_size;
        self.pending_decision_target_modified_at = target_modified_at;
        Ok(())
    }

    pub(crate) fn pause_for_decision(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        self.current_for(delivery_sequence)?;
        if !matches!(
            self.phase,
            LiveLocalArchiveSourcePhase::Current | LiveLocalArchiveSourcePhase::AwaitingResult
        ) {
            return Err(Self::invalid_state("Archive source member cannot await a decision"));
        }
        self.pending_member_error = false;
        self.pending_decision_target_path = None;
        self.pending_decision_target_size = None;
        self.pending_decision_target_modified_at = None;
        self.pending_decision_message = None;
        self.pending_decision_revision = Some(self.next_decision_revision);
        self.next_decision_revision = self
            .next_decision_revision
            .checked_add(1)
            .ok_or_else(|| Self::invalid_state("Archive decision revision overflowed"))?;
        self.phase = LiveLocalArchiveSourcePhase::AwaitingDecision;
        Ok(())
    }

    pub(crate) fn pause_for_member_error(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        self.current_for(delivery_sequence)?;
        if !matches!(
            self.phase,
            LiveLocalArchiveSourcePhase::StreamingCurrent | LiveLocalArchiveSourcePhase::AwaitingResult
        ) {
            return Err(Self::invalid_state("Archive source member cannot await a retry decision"));
        }
        self.pending_member_error = true;
        self.pending_decision_target_path = None;
        self.pending_decision_target_size = None;
        self.pending_decision_target_modified_at = None;
        self.pending_decision_message = None;
        self.pending_decision_revision = Some(self.next_decision_revision);
        self.next_decision_revision = self
            .next_decision_revision
            .checked_add(1)
            .ok_or_else(|| Self::invalid_state("Archive decision revision overflowed"))?;
        self.phase = LiveLocalArchiveSourcePhase::AwaitingDecision;
        Ok(())
    }

    pub(crate) fn resolve_collision(
        &mut self,
        action: ArchiveSessionDecisionAction,
        target_path: Option<&str>,
    ) -> Result<(), LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingDecision {
            return Err(Self::invalid_state("Archive source is not awaiting a collision decision"));
        }
        if self.pending_member_error {
            return Err(Self::invalid_state("Archive source is awaiting a member error decision"));
        }
        let is_directory = self
            .current
            .as_ref()
            .map(|current| current.entry.is_directory)
            .ok_or_else(|| Self::invalid_state("Archive source member is unavailable"))?;
        match action {
            ArchiveSessionDecisionAction::Skip => return self.skip_current(),
            ArchiveSessionDecisionAction::SkipAll => {
                self.global_target_policy = LocalArchiveTargetWritePolicy::Skip;
                return self.skip_current();
            }
            ArchiveSessionDecisionAction::Replace => self.current_target_policy = LocalArchiveTargetWritePolicy::Replace,
            ArchiveSessionDecisionAction::ReplaceAll => {
                self.global_target_policy = LocalArchiveTargetWritePolicy::Replace;
                self.current_target_policy = LocalArchiveTargetWritePolicy::Replace;
            }
            ArchiveSessionDecisionAction::ReplaceOlder => {
                self.global_target_policy = LocalArchiveTargetWritePolicy::ReplaceOlder;
                self.current_target_policy = LocalArchiveTargetWritePolicy::ReplaceOlder;
            }
            ArchiveSessionDecisionAction::Rename => {
                let target_path = target_path.ok_or_else(|| Self::invalid_state("Archive rename target is unavailable"))?;
                super::archive::validate_local_extraction_member_path(target_path, is_directory)?;
                let target_path = target_path.trim_end_matches('/').to_string();
                self.current_target_path = Some(target_path);
                self.current_target_policy = LocalArchiveTargetWritePolicy::Ask;
            }
            ArchiveSessionDecisionAction::Retry | ArchiveSessionDecisionAction::Ignore => {
                return Err(Self::invalid_state("Archive decision is not valid for a collision"));
            }
        }
        self.redeliver_current()
    }

    pub(crate) fn resolve_member_error(&mut self, action: ArchiveSessionDecisionAction) -> Result<(), LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingDecision {
            return Err(Self::invalid_state("Archive source is not awaiting a member error decision"));
        }
        if !self.pending_member_error {
            return Err(Self::invalid_state("Archive source is awaiting a collision decision"));
        }
        match action {
            ArchiveSessionDecisionAction::Retry => self.redeliver_current(),
            ArchiveSessionDecisionAction::Ignore => {
                self.record_skipped()?;
                self.current = None;
                self.current_target_path = None;
                self.current_target_policy = self.global_target_policy;
                self.pending_decision_revision = None;
                self.pending_decision_target_path = None;
                self.pending_decision_message = None;
                self.pending_member_error = false;
                self.phase = LiveLocalArchiveSourcePhase::Ready;
                Ok(())
            }
            _ => Err(Self::invalid_state("Archive decision is not valid for a member error")),
        }
    }

    /// Fence a validated decision while its destination transition is in flight.
    pub(crate) fn claim_decision(
        &mut self,
        source_session_id: &str,
        delivery_sequence: u64,
        decision_revision: u64,
        action: ArchiveSessionDecisionAction,
        member_path: &str,
        target_path: Option<&str>,
    ) -> Result<(), LocalArchiveError> {
        let current = self.current_for(delivery_sequence)?;
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingDecision
            || self.source_session_id != source_session_id
            || self.pending_decision_revision != Some(decision_revision)
            || current.entry.path != member_path
        {
            return Err(Self::invalid_state(
                "Archive decision does not match the current live source delivery",
            ));
        }
        let action_is_member_error_resolution =
            matches!(action, ArchiveSessionDecisionAction::Retry | ArchiveSessionDecisionAction::Ignore);
        if self.pending_member_error != action_is_member_error_resolution {
            return Err(Self::invalid_state(
                "Archive decision is not allowed for the current live source member",
            ));
        }
        if matches!(action, ArchiveSessionDecisionAction::Rename) {
            let target_path = target_path.ok_or_else(|| Self::invalid_state("Archive rename target is unavailable"))?;
            super::archive::validate_local_extraction_member_path(target_path, current.entry.is_directory)?;
        } else if target_path.is_some() {
            return Err(Self::invalid_state("Only archive rename decisions may include a target path"));
        }
        self.claimed_decision = Some(ClaimedLiveSourceDecision {
            action,
            target_path: target_path.map(str::to_owned),
        });
        self.phase = LiveLocalArchiveSourcePhase::ResolvingDecision;
        Ok(())
    }

    /// Apply the decision only after the destination accepts its matching transition.
    pub(crate) fn finalize_claimed_decision(&mut self) -> Result<(), LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::ResolvingDecision {
            return Err(Self::invalid_state("Archive source decision is not in flight"));
        }
        let claimed_decision = self
            .claimed_decision
            .take()
            .ok_or_else(|| Self::invalid_state("Archive source claimed decision is unavailable"))?;
        self.phase = LiveLocalArchiveSourcePhase::AwaitingDecision;
        match claimed_decision.action {
            ArchiveSessionDecisionAction::Retry | ArchiveSessionDecisionAction::Ignore => {
                self.resolve_member_error(claimed_decision.action)
            }
            _ => self.resolve_collision(claimed_decision.action, claimed_decision.target_path.as_deref()),
        }
    }

    /// Advance the central-directory reader only after the preceding member is terminal.
    pub(crate) fn next_member(&mut self) -> Result<Option<LiveLocalArchiveSourceMember>, LocalArchiveError> {
        if self.phase != LiveLocalArchiveSourcePhase::Ready {
            return Err(Self::invalid_state("Archive source is not ready for the next member"));
        }
        if self.projected_entries.is_none() {
            let projection = self.reader.effective_projection()?;
            for _ in 0..projection.skipped_entries {
                self.record_source_terminal(true)?;
            }
            let entries = if let Some(roots) = &self.selected_member_roots {
                if roots.iter().any(|root| {
                    !projection.entries.iter().any(|entry| {
                        let path = entry.path.trim_end_matches('/');
                        path == root || path.starts_with(&format!("{root}/"))
                    })
                }) {
                    return Err(LocalArchiveError::UnknownExtractionMember);
                }
                projection
                    .entries
                    .into_iter()
                    .filter(|entry| {
                        let path = entry.path.trim_end_matches('/');
                        roots.iter().any(|root| path == root || path.starts_with(&format!("{root}/")))
                    })
                    .collect()
            } else {
                projection.entries
            };
            self.projected_entries = Some(entries);
        }
        loop {
            let entries = self
                .projected_entries
                .as_ref()
                .ok_or_else(|| Self::invalid_state("Archive source projection is unavailable"))?;
            if self.projected_entry_index >= entries.len() {
                self.phase = LiveLocalArchiveSourcePhase::Completed;
                return Ok(None);
            }
            let entry = entries[self.projected_entry_index].clone();
            self.projected_entry_index = self
                .projected_entry_index
                .checked_add(1)
                .ok_or_else(|| Self::invalid_state("Archive source projection index overflowed"))?;
            if !entry.is_safe || !entry.has_supported_file_type {
                self.record_source_terminal(true)?;
                continue;
            }
            if entry.encrypted || !matches!(entry.compression_method, 0 | 8 | 12) {
                self.record_source_terminal(true)?;
                if entry.encrypted {
                    self.aggregate.encrypted_members_skipped =
                        Self::checked_increment(self.aggregate.encrypted_members_skipped, "Archive encrypted skip count overflowed")?;
                } else {
                    self.aggregate.unsupported_compression_members_skipped = Self::checked_increment(
                        self.aggregate.unsupported_compression_members_skipped,
                        "Archive unsupported compression skip count overflowed",
                    )?;
                }
                continue;
            }
            if let Err(error) = self.reader.validate_entry(entry.clone()) {
                self.handle_entry_validation_error(error)?;
                continue;
            }
            let delivery_sequence = self.next_delivery_sequence;
            self.next_delivery_sequence = self
                .next_delivery_sequence
                .checked_add(1)
                .ok_or_else(|| Self::invalid_state("Archive member delivery sequence overflowed"))?;
            let member = LiveLocalArchiveSourceMember { entry, delivery_sequence };
            self.current = Some(member.clone());
            self.redelivery_available = false;
            self.claimed_decision = None;
            self.current_target_path = None;
            self.current_target_policy = self.global_target_policy;
            self.pending_decision_revision = None;
            self.pending_decision_target_path = None;
            self.pending_decision_message = None;
            self.pending_member_error = false;
            self.phase = LiveLocalArchiveSourcePhase::Current;
            return Ok(Some(member));
        }
    }

    /// Return a new member or the single redelivery authorized by a resolved live decision.
    pub(crate) fn next_destination_member(&mut self) -> Result<Option<LiveLocalArchiveSourceMember>, LocalArchiveError> {
        if self.phase == LiveLocalArchiveSourcePhase::Current && self.redelivery_available {
            self.redelivery_available = false;
            return Ok(self.current.clone());
        }
        self.next_member()
    }

    fn handle_entry_validation_error(&mut self, error: LocalArchiveReadError) -> Result<(), LocalArchiveError> {
        match error {
            LocalArchiveReadError::SourceChanged => {
                self.phase = LiveLocalArchiveSourcePhase::Failed;
                Err(LocalArchiveError::ArchiveSourceChanged)
            }
            LocalArchiveReadError::Io(error) => {
                self.phase = LiveLocalArchiveSourcePhase::Failed;
                Err(LocalArchiveError::Io(error))
            }
            _ => self.record_source_terminal(false),
        }
    }

    pub(crate) fn mark_directory_delivery_ready(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        let current = self.current_for(delivery_sequence)?;
        if !current.entry.is_directory || self.phase != LiveLocalArchiveSourcePhase::Current {
            return Err(Self::invalid_state("Archive source directory delivery is invalid"));
        }
        self.mark_destination_result_ready(delivery_sequence)
    }

    /// Allow a destination to return a source-content-independent result, such as a collision skip.
    pub(crate) fn mark_destination_result_ready(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        self.current_for(delivery_sequence)?;
        if self.phase != LiveLocalArchiveSourcePhase::Current {
            return Err(Self::invalid_state("Archive source member is not ready for a destination result"));
        }
        self.phase = LiveLocalArchiveSourcePhase::AwaitingResult;
        Ok(())
    }

    /// Stream the current regular member from the pinned source and verify it before accepting a destination result.
    pub(crate) fn stream_current_member(
        &mut self,
        delivery_sequence: u64,
        output: &mut impl std::io::Write,
        cancellation_requested: &AtomicBool,
    ) -> Result<(), LocalArchiveError> {
        let current = self.current_for(delivery_sequence)?.clone();
        if current.entry.is_directory || self.phase != LiveLocalArchiveSourcePhase::Current {
            return Err(Self::invalid_state("Archive source member is not ready to stream"));
        }
        self.phase = LiveLocalArchiveSourcePhase::StreamingCurrent;
        match self
            .reader
            .stream_entry_with_cancellation(current.entry, output, || cancellation_requested.load(Ordering::Acquire))
        {
            Ok(()) => {
                self.phase = LiveLocalArchiveSourcePhase::AwaitingResult;
                Ok(())
            }
            Err(error) => {
                let error = LocalArchiveError::from(error);
                if matches!(error, LocalArchiveError::ArchiveRead(LocalArchiveReadError::Cancelled)) {
                    self.phase = LiveLocalArchiveSourcePhase::Cancelled;
                    return Err(LocalArchiveError::Cancelled);
                }
                if matches!(error, LocalArchiveError::ArchiveRead(LocalArchiveReadError::SourceChanged)) {
                    self.phase = LiveLocalArchiveSourcePhase::Failed;
                    return Err(LocalArchiveError::ArchiveSourceChanged);
                }
                Err(error)
            }
        }
    }

    /// Accept one transient destination outcome after source streaming completed successfully.
    pub(crate) fn apply_destination_result(
        &mut self,
        delivery_sequence: u64,
        result: &LocalArchiveExtractionDestinationResult,
    ) -> Result<(), LocalArchiveError> {
        let current = self.current_for(delivery_sequence)?;
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingResult || current.entry.path != result.member_path {
            return Err(Self::invalid_state("Archive destination result does not match the current member"));
        }
        match result.status {
            LocalArchiveExtractionDestinationStatus::Directory => {
                if !current.entry.is_directory || result.extracted_bytes != 0 {
                    return Err(Self::invalid_state("Archive directory result is invalid"));
                }
                self.record_completed(result)?;
            }
            LocalArchiveExtractionDestinationStatus::Extracted => {
                if current.entry.is_directory || result.extracted_bytes != current.entry.uncompressed_size {
                    return Err(Self::invalid_state("Archive file result is invalid"));
                }
                self.record_completed(result)?;
            }
            LocalArchiveExtractionDestinationStatus::Skipped | LocalArchiveExtractionDestinationStatus::Ignored => {
                self.record_skipped()?;
            }
        }
        self.current = None;
        self.redelivery_available = false;
        self.claimed_decision = None;
        self.current_target_path = None;
        self.current_target_policy = self.global_target_policy;
        self.pending_decision_revision = None;
        self.pending_decision_target_path = None;
        self.pending_decision_message = None;
        self.pending_member_error = false;
        self.phase = LiveLocalArchiveSourcePhase::Ready;
        Ok(())
    }

    /// End the source session without inventing a member outcome after an unknown destination result.
    pub(crate) fn destination_outcome_unknown(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        self.current_for(delivery_sequence)?;
        if !matches!(
            self.phase,
            LiveLocalArchiveSourcePhase::Current
                | LiveLocalArchiveSourcePhase::StreamingCurrent
                | LiveLocalArchiveSourcePhase::AwaitingResult
        ) {
            return Err(Self::invalid_state("Archive source has no dispatched destination write"));
        }
        self.phase = LiveLocalArchiveSourcePhase::Failed;
        Ok(())
    }

    /// Record one confirmed destination failure for the known current member and end the source session.
    pub(crate) fn fail_current_member(&mut self, delivery_sequence: u64) -> Result<(), LocalArchiveError> {
        self.current_for(delivery_sequence)?;
        if self.phase != LiveLocalArchiveSourcePhase::AwaitingResult {
            return Err(Self::invalid_state("Archive source is not awaiting a destination result"));
        }
        self.record_source_terminal(false)?;
        self.current = None;
        self.redelivery_available = false;
        self.claimed_decision = None;
        self.phase = LiveLocalArchiveSourcePhase::Failed;
        Ok(())
    }

    /// Stop the retained source without fabricating an unconfirmed member outcome.
    pub(crate) fn abort(&mut self) {
        self.phase = LiveLocalArchiveSourcePhase::Failed;
    }

    fn current_for(&self, delivery_sequence: u64) -> Result<&LiveLocalArchiveSourceMember, LocalArchiveError> {
        self.current
            .as_ref()
            .filter(|current| current.delivery_sequence == delivery_sequence)
            .ok_or_else(|| Self::invalid_state("Archive source delivery is stale or unavailable"))
    }

    fn redeliver_current(&mut self) -> Result<(), LocalArchiveError> {
        let current = self
            .current
            .as_mut()
            .ok_or_else(|| Self::invalid_state("Archive source member is unavailable"))?;
        current.delivery_sequence = self.next_delivery_sequence;
        self.next_delivery_sequence = self
            .next_delivery_sequence
            .checked_add(1)
            .ok_or_else(|| Self::invalid_state("Archive member delivery sequence overflowed"))?;
        self.pending_decision_revision = None;
        self.pending_decision_target_path = None;
        self.pending_decision_message = None;
        self.redelivery_available = true;
        self.claimed_decision = None;
        self.phase = LiveLocalArchiveSourcePhase::Current;
        Ok(())
    }

    fn record_source_terminal(&mut self, skipped: bool) -> Result<(), LocalArchiveError> {
        self.aggregate.members_processed = Self::checked_increment(self.aggregate.members_processed, "Archive member count overflowed")?;
        if skipped {
            self.aggregate.members_skipped =
                Self::checked_increment(self.aggregate.members_skipped, "Archive skipped member count overflowed")?;
        } else {
            self.aggregate.members_failed =
                Self::checked_increment(self.aggregate.members_failed, "Archive failed member count overflowed")?;
        }
        Ok(())
    }

    fn record_completed(&mut self, result: &LocalArchiveExtractionDestinationResult) -> Result<(), LocalArchiveError> {
        self.aggregate.members_processed = Self::checked_increment(self.aggregate.members_processed, "Archive member count overflowed")?;
        self.aggregate.members_completed =
            Self::checked_increment(self.aggregate.members_completed, "Archive completed member count overflowed")?;
        self.aggregate.directories_created = Self::checked_add(
            self.aggregate.directories_created,
            result.directories_created,
            "Archive directory count overflowed",
        )?;
        if result.status == LocalArchiveExtractionDestinationStatus::Directory {
            return Ok(());
        }
        self.aggregate.files_extracted =
            Self::checked_increment(self.aggregate.files_extracted, "Archive extracted file count overflowed")?;
        self.aggregate.extracted_bytes = Self::checked_add(
            self.aggregate.extracted_bytes,
            result.extracted_bytes,
            "Archive extracted byte count overflowed",
        )?;
        if result.replaced {
            self.aggregate.files_replaced = Self::checked_increment(self.aggregate.files_replaced, "Archive replacement count overflowed")?;
        }
        Ok(())
    }

    fn record_skipped(&mut self) -> Result<(), LocalArchiveError> {
        self.aggregate.members_processed = Self::checked_increment(self.aggregate.members_processed, "Archive member count overflowed")?;
        self.aggregate.members_skipped =
            Self::checked_increment(self.aggregate.members_skipped, "Archive skipped member count overflowed")?;
        Ok(())
    }

    fn skip_current(&mut self) -> Result<(), LocalArchiveError> {
        self.record_skipped()?;
        self.current = None;
        self.redelivery_available = false;
        self.claimed_decision = None;
        self.current_target_path = None;
        self.current_target_policy = self.global_target_policy;
        self.pending_decision_revision = None;
        self.pending_decision_target_path = None;
        self.pending_decision_message = None;
        self.pending_member_error = false;
        self.phase = LiveLocalArchiveSourcePhase::Ready;
        Ok(())
    }

    fn checked_increment(value: u64, message: &str) -> Result<u64, LocalArchiveError> {
        Self::checked_add(value, 1, message)
    }

    fn checked_add(value: u64, increment: u64, message: &str) -> Result<u64, LocalArchiveError> {
        value.checked_add(increment).ok_or_else(|| Self::invalid_state(message))
    }

    fn invalid_state(message: &str) -> LocalArchiveError {
        LocalArchiveError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, message))
    }
}

#[derive(Clone)]
pub struct ArchiveSessionDecision {
    pub source_session_id: String,
    pub delivery_sequence: u64,
    pub decision_revision: u64,
    pub member_path: String,
    pub action: ArchiveSessionDecisionAction,
    pub target_path: Option<String>,
}

pub(crate) struct ArchiveSessionDecisionState {
    pub phase: ArchiveSessionPhase,
    pub revision: u64,
    pub pending_decision: Option<ArchiveSessionPendingDecision>,
}

pub(crate) enum ArchiveSessionCompletion {
    ExtractionCompletedLive {
        result: LocalArchiveExtractionResult,
    },
    AwaitingLiveCollision {
        result: LocalArchiveExtractionResult,
    },
    CreationCompleted {
        result: LocalArchiveCreationResult,
        state: ArchiveCreationManifestState,
    },
}

#[derive(Clone, Debug)]
pub struct ArchiveSessionStatus {
    pub execution_id: String,
    pub contract_version: ArchiveContractVersion,
    pub kind: ArchiveSessionKind,
    pub phase: ArchiveSessionPhase,
    pub revision: u64,
    pub cancellation_requested: bool,
    pub progress: ArchiveSessionProgress,
    pub total_members: Option<u64>,
    pub total_bytes: Option<u64>,
    pub result: Option<ArchiveSessionProgress>,
    pub error: Option<String>,
    pub pending_decision: Option<ArchiveSessionPendingDecision>,
}

#[derive(Clone)]
pub(crate) enum ArchiveSessionWork {
    Creation {
        source_paths: Vec<PathBuf>,
        target_path: PathBuf,
    },
    Extraction {
        archive_path: PathBuf,
        destination_path: PathBuf,
        selected_member_roots: Option<Vec<String>>,
    },
}

pub(crate) struct PreparedLocalArchiveCreation {
    pub source_paths: Vec<PathBuf>,
    pub target_path: PathBuf,
    pub entries: Vec<LocalArchiveEntry>,
    pub execution_plan: LocalArchiveCreationExecutionPlan,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) enum CreationPreWriteAction {
    RemoveFirstSource,
    ModifyFirstSource,
    Cancel,
}

#[cfg(test)]
impl CreationPreWriteAction {
    pub(crate) fn apply(self, source_paths: &[PathBuf], cancellation_requested: &AtomicBool) -> Result<(), LocalArchiveError> {
        if matches!(self, Self::Cancel) {
            cancellation_requested.store(true, Ordering::Release);
            return Ok(());
        }
        let source_path = source_paths.first().ok_or(LocalArchiveError::UnsupportedSource)?;
        match self {
            Self::RemoveFirstSource => std::fs::remove_file(source_path).map_err(LocalArchiveError::Io),
            Self::ModifyFirstSource => std::fs::write(source_path, b"changed source").map_err(LocalArchiveError::Io),
            Self::Cancel => unreachable!("cancellation action returns above"),
        }
    }
}

impl ArchiveSessionWork {
    fn kind(&self) -> ArchiveSessionKind {
        match self {
            Self::Creation { .. } => ArchiveSessionKind::Create,
            Self::Extraction { .. } => ArchiveSessionKind::Extract,
        }
    }

    fn initial_progress(&self) -> ArchiveSessionProgress {
        match self {
            Self::Creation { .. } => ArchiveSessionProgress::Creation(LocalArchiveCreationResult {
                files_created: 0,
                directories_created: 0,
                source_bytes: 0,
            }),
            Self::Extraction { .. } => ArchiveSessionProgress::Extraction(LocalArchiveExtractionResult {
                members_processed: 0,
                members_completed: 0,
                members_skipped: 0,
                encrypted_members_skipped: 0,
                unsupported_compression_members_skipped: 0,
                members_failed: 0,
                files_extracted: 0,
                directories_created: 0,
                extracted_bytes: 0,
                files_replaced: 0,
            }),
        }
    }
}

struct ArchiveSession {
    execution_id: String,
    contract_version: ArchiveContractVersion,
    drive: String,
    owner_origin: String,
    kind: ArchiveSessionKind,
    phase: ArchiveSessionPhase,
    revision: u64,
    drive_root: PathBuf,
    work: ArchiveSessionWork,
    creation_plan: Option<LocalArchiveCreationExecutionPlan>,
    creation_manifest_entries: Option<Vec<LocalArchiveEntry>>,
    creation_state: Option<ArchiveCreationManifestState>,
    live_extraction: Option<Arc<Mutex<LiveLocalArchiveSourceSession>>>,
    cancellation_requested: Arc<AtomicBool>,
    progress: ArchiveSessionProgress,
    result: Option<ArchiveSessionProgress>,
    error: Option<String>,
    expires_at: Option<Instant>,
}

impl ArchiveSession {
    fn totals(&self) -> Option<(u64, u64)> {
        match self.kind {
            ArchiveSessionKind::Create => self.creation_manifest_entries.as_ref().map(|entries| {
                (
                    entries.len() as u64,
                    entries.iter().fold(0_u64, |total, entry| total.saturating_add(entry.source_size)),
                )
            }),
            ArchiveSessionKind::Extract => None,
        }
    }

    fn status(&self) -> ArchiveSessionStatus {
        let (total_members, total_bytes) = self.totals().map_or((None, None), |(members, bytes)| (Some(members), Some(bytes)));
        ArchiveSessionStatus {
            execution_id: self.execution_id.clone(),
            contract_version: self.contract_version,
            kind: self.kind,
            phase: self.phase,
            revision: self.revision,
            cancellation_requested: self.cancellation_requested.load(Ordering::Acquire),
            progress: self.progress,
            total_members,
            total_bytes,
            result: self.result,
            error: self.error.clone(),
            pending_decision: None,
        }
    }

    fn complete(&mut self, result: Result<ArchiveSessionCompletion, LocalArchiveError>) {
        match result {
            Ok(ArchiveSessionCompletion::ExtractionCompletedLive { result }) => {
                let result = ArchiveSessionProgress::Extraction(result);
                self.progress = result;
                self.phase = ArchiveSessionPhase::Completed;
                self.result = Some(result);
            }
            Ok(ArchiveSessionCompletion::AwaitingLiveCollision { result }) => {
                self.progress = ArchiveSessionProgress::Extraction(result);
                self.phase = ArchiveSessionPhase::AwaitingUserDecision;
                self.revision += 1;
                self.expires_at = Some(Instant::now() + ARCHIVE_SESSION_TIMEOUT);
                return;
            }
            Ok(ArchiveSessionCompletion::CreationCompleted { result, state }) => {
                let result = ArchiveSessionProgress::Creation(result);
                self.creation_state = Some(state);
                self.progress = result;
                self.phase = ArchiveSessionPhase::Completed;
                self.result = Some(result);
            }
            Err(LocalArchiveError::Cancelled) => {
                self.phase = ArchiveSessionPhase::Cancelled;
            }
            Err(error) => {
                self.phase = ArchiveSessionPhase::Failed;
                self.error = Some(error.to_string());
            }
        }
        self.revision += 1;
        self.live_extraction = None;
        self.expires_at = Some(Instant::now() + ARCHIVE_SESSION_TIMEOUT);
    }
}

pub struct ArchiveSessionManager {
    sessions: Mutex<HashMap<String, ArchiveSession>>,
    relay_live_sources: Mutex<HashMap<String, RelayLiveLocalArchiveSource>>,
    opening_relay_source_ids: Arc<StdMutex<HashSet<String>>>,
    closed_relay_source_ids: Mutex<HashSet<String>>,
    expired_relay_capabilities: Mutex<HashMap<String, ExpiredRelayLiveLocalArchiveSource>>,
    #[cfg(test)]
    phase_transitions: Mutex<HashMap<String, Vec<ArchiveSessionPhase>>>,
    #[cfg(test)]
    pending_decisions: Mutex<HashMap<String, String>>,
}

struct RelayLiveLocalArchiveSource {
    drive: String,
    owner_origin: String,
    archive_path: PathBuf,
    server_url: String,
    operation_token: String,
    source: Arc<Mutex<LiveLocalArchiveSourceSession>>,
    cancellation_requested: Arc<AtomicBool>,
    expires_at: Option<Instant>,
}

pub(crate) struct RelayLiveSourceDetails {
    pub(crate) drive: String,
    pub(crate) owner_origin: String,
    pub(crate) archive_path: PathBuf,
    pub(crate) server_url: String,
    pub(crate) operation_token: String,
    pub(crate) selected_member_roots: Option<Vec<String>>,
}

struct RelaySourceOpeningReservation {
    operation_id: Option<String>,
    opening_ids: Arc<StdMutex<HashSet<String>>>,
}

impl RelaySourceOpeningReservation {
    fn reserve(opening_ids: Arc<StdMutex<HashSet<String>>>, operation_id: &str) -> Option<Self> {
        let mut ids = opening_ids.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let inserted = ids.insert(operation_id.to_string());
        drop(ids);
        inserted.then(|| Self {
            operation_id: Some(operation_id.to_string()),
            opening_ids,
        })
    }
}

impl Drop for RelaySourceOpeningReservation {
    fn drop(&mut self) {
        if let Some(operation_id) = self.operation_id.take() {
            self.opening_ids
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&operation_id);
        }
    }
}

struct ExpiredRelayLiveLocalArchiveSource {
    drive: String,
    owner_origin: String,
    server_url: String,
    operation_token: String,
    expires_at: Instant,
}

pub(crate) struct ExpiredRelaySourceCapability {
    pub(crate) operation_id: String,
    pub(crate) server_url: String,
    pub(crate) operation_token: String,
}

/// Test-only compatibility executor for direct-local archive session coverage.
#[cfg(test)]
pub struct FixtureDirectLocalInvocation {
    state_store: Arc<ArchiveSessionManager>,
}

#[cfg(test)]
impl FixtureDirectLocalInvocation {
    pub fn new(state_store: Arc<ArchiveSessionManager>) -> Self {
        Self { state_store }
    }
}

impl ArchiveSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            relay_live_sources: Mutex::new(HashMap::new()),
            opening_relay_source_ids: Arc::new(StdMutex::new(HashSet::new())),
            closed_relay_source_ids: Mutex::new(HashSet::new()),
            expired_relay_capabilities: Mutex::new(HashMap::new()),
            #[cfg(test)]
            phase_transitions: Mutex::new(HashMap::new()),
            #[cfg(test)]
            pending_decisions: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    async fn recorded_phase_transitions(&self, execution_id: &str) -> Vec<String> {
        self.phase_transitions
            .lock()
            .await
            .get(execution_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(ArchiveSessionPhase::as_str)
            .map(str::to_string)
            .collect()
    }

    #[cfg(test)]
    async fn record_phase_transition(&self, execution_id: &str, phase: ArchiveSessionPhase) {
        if let Some(transitions) = self.phase_transitions.lock().await.get_mut(execution_id) {
            transitions.push(phase);
        }
    }

    #[cfg(test)]
    async fn recorded_pending_decision(&self, execution_id: &str) -> Option<String> {
        self.pending_decisions.lock().await.get(execution_id).cloned()
    }

    #[cfg(test)]
    async fn record_pending_decision(&self, execution_id: &str, decision: &ArchiveSessionPendingDecision) {
        let category = if decision.member_error.is_some() {
            "member_error"
        } else {
            "collision"
        };
        self.pending_decisions
            .lock()
            .await
            .insert(execution_id.to_string(), category.to_string());
    }

    fn remove_expired(sessions: &mut HashMap<String, ArchiveSession>) {
        let now = Instant::now();
        sessions.retain(|_, session| {
            (session.kind == ArchiveSessionKind::Extract && session.phase == ArchiveSessionPhase::AwaitingUserDecision)
                || session.expires_at.is_none_or(|expires_at| expires_at > now)
        });
    }

    async fn expire_relay_sources(&self) {
        let now = Instant::now();
        self.expired_relay_capabilities
            .lock()
            .await
            .retain(|_, source| source.expires_at > now);
        let expired_sources = {
            let mut sources = self.relay_live_sources.lock().await;
            let expired_ids = sources
                .iter()
                .filter(|(_, source)| source.expires_at.is_some_and(|expires_at| expires_at <= now))
                .map(|(operation_id, _)| operation_id.clone())
                .collect::<Vec<_>>();
            expired_ids
                .into_iter()
                .filter_map(|operation_id| {
                    sources.remove(&operation_id).map(|source| {
                        (
                            operation_id,
                            source.source,
                            source.cancellation_requested,
                            ExpiredRelayLiveLocalArchiveSource {
                                drive: source.drive,
                                owner_origin: source.owner_origin,
                                server_url: source.server_url,
                                operation_token: source.operation_token,
                                expires_at: now + ARCHIVE_SESSION_TIMEOUT,
                            },
                        )
                    })
                })
                .collect::<Vec<_>>()
        };
        if !expired_sources.is_empty() {
            let mut closed_source_ids = self.closed_relay_source_ids.lock().await;
            let mut expired_capabilities = self.expired_relay_capabilities.lock().await;
            for (operation_id, live_source, cancellation_requested, source) in expired_sources {
                cancellation_requested.store(true, Ordering::Release);
                live_source.lock().await.abort();
                closed_source_ids.insert(operation_id.clone());
                expired_capabilities.insert(operation_id, source);
            }
        }
    }

    pub(crate) async fn take_expired_relay_capability(
        &self,
        operation_id: &str,
        drive: &str,
        owner_origin: &str,
    ) -> Option<(String, String)> {
        self.expire_relay_sources().await;
        let mut expired_capabilities = self.expired_relay_capabilities.lock().await;
        expired_capabilities.retain(|_, source| source.expires_at > Instant::now());
        let belongs_to_request = expired_capabilities
            .get(operation_id)
            .is_some_and(|source| source.drive == drive && source.owner_origin == owner_origin);
        belongs_to_request
            .then(|| expired_capabilities.remove(operation_id))
            .flatten()
            .map(|source| (source.server_url, source.operation_token))
    }

    pub(crate) async fn expire_relay_live_source(&self, operation_id: &str) -> Option<ExpiredRelaySourceCapability> {
        let now = Instant::now();
        let source = {
            let mut sources = self.relay_live_sources.lock().await;
            if sources
                .get(operation_id)
                .is_some_and(|source| source.expires_at.is_some_and(|expires_at| expires_at <= now))
            {
                sources.remove(operation_id)
            } else {
                None
            }
        }?;
        source.cancellation_requested.store(true, Ordering::Release);
        source.source.lock().await.abort();
        self.closed_relay_source_ids.lock().await.insert(operation_id.to_string());
        Some(ExpiredRelaySourceCapability {
            operation_id: operation_id.to_string(),
            server_url: source.server_url,
            operation_token: source.operation_token,
        })
    }

    /// Open the retained local ZIP reader for one mixed relay operation exactly once.
    #[cfg(test)]
    pub(crate) async fn start_relay_live_source(
        &self,
        operation_id: &str,
        drive: &str,
        owner_origin: &str,
        archive_path: PathBuf,
        server_url: &str,
        operation_token: &str,
    ) -> Result<(Arc<Mutex<LiveLocalArchiveSourceSession>>, Arc<AtomicBool>), ApiError> {
        self.start_relay_live_source_with_opener(
            operation_id,
            RelayLiveSourceDetails {
                drive: drive.to_string(),
                owner_origin: owner_origin.to_string(),
                archive_path,
                server_url: server_url.to_string(),
                operation_token: operation_token.to_string(),
                selected_member_roots: None,
            },
            |source_path| LiveLocalArchiveSourceSession::open(&source_path),
        )
        .await
    }

    /// Open a retained local ZIP reader bound to backend-authorized member roots.
    pub(crate) async fn start_relay_live_source_with_selection(
        &self,
        operation_id: &str,
        details: RelayLiveSourceDetails,
    ) -> Result<(Arc<Mutex<LiveLocalArchiveSourceSession>>, Arc<AtomicBool>), ApiError> {
        let selected_member_roots = details.selected_member_roots.clone();
        self.start_relay_live_source_with_opener(operation_id, details, move |source_path| {
            LiveLocalArchiveSourceSession::open_with_selection(&source_path, selected_member_roots)
        })
        .await
    }

    async fn start_relay_live_source_with_opener<Open>(
        &self,
        operation_id: &str,
        details: RelayLiveSourceDetails,
        open: Open,
    ) -> Result<(Arc<Mutex<LiveLocalArchiveSourceSession>>, Arc<AtomicBool>), ApiError>
    where
        Open: FnOnce(PathBuf) -> Result<LiveLocalArchiveSourceSession, LocalArchiveError> + Send + 'static,
    {
        self.expire_relay_sources().await;
        if self.closed_relay_source_ids.lock().await.contains(operation_id)
            || self.expired_relay_capabilities.lock().await.contains_key(operation_id)
        {
            return Err(ApiError::conflict_message("Archive relay source expired and cannot be resumed"));
        }
        let _opening_reservation = {
            let sources = self.relay_live_sources.lock().await;
            if let Some(existing) = sources.get(operation_id) {
                if existing.drive != details.drive
                    || existing.owner_origin != details.owner_origin
                    || existing.archive_path != details.archive_path
                    || existing.server_url != details.server_url
                    || existing.operation_token != details.operation_token
                {
                    return Err(ApiError::Forbidden("Archive relay source does not match its operation".to_string()));
                }
                return Err(ApiError::conflict_message("Archive relay source has already started"));
            }
            RelaySourceOpeningReservation::reserve(self.opening_relay_source_ids.clone(), operation_id)
                .ok_or_else(|| ApiError::conflict_message("Archive relay source has already started"))?
        };
        let source_path = details.archive_path.clone();
        let (source, _opening_reservation) = match tokio::task::spawn_blocking(move || {
            let source = open(source_path)?;
            Ok::<_, LocalArchiveError>((source, _opening_reservation))
        })
        .await
        {
            Ok(Ok(source)) => source,
            Ok(Err(error)) => return Err(ApiError::Internal(error.to_string())),
            Err(error) => return Err(ApiError::Internal(format!("Local archive relay source task failed: {error}"))),
        };
        let source = Arc::new(Mutex::new(source));
        let cancellation_requested = Arc::new(AtomicBool::new(false));
        let closed_source_ids = self.closed_relay_source_ids.lock().await;
        if closed_source_ids.contains(operation_id) {
            source.lock().await.abort();
            return Err(ApiError::conflict_message("Archive relay source expired and cannot be resumed"));
        }
        self.relay_live_sources.lock().await.insert(
            operation_id.to_string(),
            RelayLiveLocalArchiveSource {
                drive: details.drive,
                owner_origin: details.owner_origin,
                archive_path: details.archive_path,
                server_url: details.server_url,
                operation_token: details.operation_token,
                source: source.clone(),
                cancellation_requested: cancellation_requested.clone(),
                expires_at: None,
            },
        );
        drop(closed_source_ids);
        Ok((source, cancellation_requested))
    }

    pub(crate) async fn remove_relay_live_source(&self, operation_id: &str) {
        let source = self.relay_live_sources.lock().await.remove(operation_id);
        if let Some(source) = source {
            source.cancellation_requested.store(true, Ordering::Release);
            source.source.lock().await.abort();
        }
    }

    pub(crate) async fn fail_relay_live_source(&self, operation_id: &str) {
        self.closed_relay_source_ids.lock().await.insert(operation_id.to_string());
        self.remove_relay_live_source(operation_id).await;
    }

    pub(crate) async fn confirm_relay_source_terminalized(&self, operation_id: &str) {
        self.closed_relay_source_ids.lock().await.remove(operation_id);
        self.expired_relay_capabilities.lock().await.remove(operation_id);
    }

    pub(crate) async fn arm_relay_live_source_expiry(&self, operation_id: &str) -> Result<(), ApiError> {
        let mut sources = self.relay_live_sources.lock().await;
        let source = sources
            .get_mut(operation_id)
            .ok_or_else(|| ApiError::NotFound("Archive relay source not found or expired".to_string()))?;
        source.expires_at = Some(Instant::now() + ARCHIVE_SESSION_TIMEOUT);
        Ok(())
    }

    pub(crate) async fn disarm_relay_live_source_expiry(&self, operation_id: &str) -> Result<(), ApiError> {
        let mut sources = self.relay_live_sources.lock().await;
        let source = sources
            .get_mut(operation_id)
            .ok_or_else(|| ApiError::NotFound("Archive relay source not found or expired".to_string()))?;
        source.expires_at = None;
        Ok(())
    }

    pub(crate) async fn expire_paused_extraction(&self, execution_id: &str) {
        let source = {
            let mut sessions = self.sessions.lock().await;
            let Some(session) = sessions.get_mut(execution_id) else {
                return;
            };
            if session.kind != ArchiveSessionKind::Extract
                || session.phase != ArchiveSessionPhase::AwaitingUserDecision
                || session.expires_at.is_none_or(|expires_at| expires_at > Instant::now())
            {
                return;
            }
            session.cancellation_requested.store(true, Ordering::Release);
            session.phase = ArchiveSessionPhase::Failed;
            session.revision += 1;
            session.error = Some("Archive extraction session timed out".to_string());
            session.expires_at = Some(Instant::now() + ARCHIVE_SESSION_TIMEOUT);
            session.live_extraction.take()
        };
        if let Some(source) = source {
            source.lock().await.abort();
        }
    }

    pub(crate) async fn relay_live_source(
        &self,
        operation_id: &str,
        drive: &str,
        owner_origin: &str,
    ) -> Result<(Arc<Mutex<LiveLocalArchiveSourceSession>>, Arc<AtomicBool>), ApiError> {
        self.expire_relay_sources().await;
        let mut sources = self.relay_live_sources.lock().await;
        let source = sources
            .get_mut(operation_id)
            .filter(|source| source.drive == drive && source.owner_origin == owner_origin)
            .ok_or_else(|| ApiError::NotFound("Archive relay source not found or expired".to_string()))?;
        Ok((source.source.clone(), source.cancellation_requested.clone()))
    }

    pub(crate) async fn relay_live_capability(
        &self,
        operation_id: &str,
        drive: &str,
        owner_origin: &str,
    ) -> Result<(String, String), ApiError> {
        self.expire_relay_sources().await;
        self.relay_live_sources
            .lock()
            .await
            .get(operation_id)
            .filter(|source| source.drive == drive && source.owner_origin == owner_origin)
            .map(|source| (source.server_url.clone(), source.operation_token.clone()))
            .ok_or_else(|| ApiError::NotFound("Archive relay source not found or expired".to_string()))
    }

    #[cfg(test)]
    pub async fn create_extraction(
        &self,
        drive: String,
        owner_origin: String,
        drive_root: PathBuf,
        archive_path: PathBuf,
        destination_path: PathBuf,
    ) -> ArchiveSessionStatus {
        self.create_extraction_with_selection(drive, owner_origin, drive_root, archive_path, destination_path, None)
            .await
    }

    pub async fn create_extraction_with_selection(
        &self,
        drive: String,
        owner_origin: String,
        drive_root: PathBuf,
        archive_path: PathBuf,
        destination_path: PathBuf,
        selected_member_roots: Option<Vec<String>>,
    ) -> ArchiveSessionStatus {
        self.create(
            drive,
            owner_origin,
            drive_root,
            ArchiveSessionWork::Extraction {
                archive_path,
                destination_path,
                selected_member_roots,
            },
            None,
        )
        .await
    }

    #[cfg(test)]
    pub async fn create_creation(
        &self,
        drive: String,
        owner_origin: String,
        drive_root: PathBuf,
        source_paths: Vec<PathBuf>,
        target_path: PathBuf,
    ) -> ArchiveSessionStatus {
        self.create(
            drive,
            owner_origin,
            drive_root,
            ArchiveSessionWork::Creation { source_paths, target_path },
            None,
        )
        .await
    }

    pub async fn create_prepared_creation(
        &self,
        drive: String,
        owner_origin: String,
        drive_root: PathBuf,
        prepared: PreparedLocalArchiveCreation,
    ) -> ArchiveSessionStatus {
        self.create(
            drive,
            owner_origin,
            drive_root,
            ArchiveSessionWork::Creation {
                source_paths: prepared.source_paths,
                target_path: prepared.target_path,
            },
            Some((prepared.entries, prepared.execution_plan)),
        )
        .await
    }

    async fn create(
        &self,
        drive: String,
        owner_origin: String,
        drive_root: PathBuf,
        work: ArchiveSessionWork,
        creation_plan: Option<(Vec<LocalArchiveEntry>, LocalArchiveCreationExecutionPlan)>,
    ) -> ArchiveSessionStatus {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        let execution_id = Uuid::new_v4().to_string();
        let session = ArchiveSession {
            execution_id: execution_id.clone(),
            contract_version: ArchiveContractVersion::V2,
            drive,
            owner_origin,
            kind: work.kind(),
            phase: ArchiveSessionPhase::Accepted,
            revision: 0,
            drive_root,
            progress: work.initial_progress(),
            work,
            creation_plan: creation_plan.as_ref().map(|(_, plan)| plan.clone()),
            creation_manifest_entries: creation_plan.map(|(entries, _)| entries),
            creation_state: None,
            live_extraction: None,
            cancellation_requested: Arc::new(AtomicBool::new(false)),
            result: None,
            error: None,
            expires_at: None,
        };
        let status = session.status();
        sessions.insert(execution_id, session);
        #[cfg(test)]
        self.phase_transitions
            .lock()
            .await
            .insert(status.execution_id.clone(), vec![ArchiveSessionPhase::Accepted]);
        status
    }

    pub async fn get(&self, drive: &str, owner_origin: &str, execution_id: &str) -> Result<ArchiveSessionStatus, ApiError> {
        self.status_with_live_decision(drive, owner_origin, execution_id, false).await
    }

    /// Read an in-memory session only when it is pinned to the V2 contract.
    pub async fn get_v2(&self, drive: &str, owner_origin: &str, execution_id: &str) -> Result<ArchiveSessionStatus, ApiError> {
        self.status_with_live_decision(drive, owner_origin, execution_id, true).await
    }

    async fn status_with_live_decision(
        &self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
        require_v2: bool,
    ) -> Result<ArchiveSessionStatus, ApiError> {
        let (mut status, source) = {
            let mut sessions = self.sessions.lock().await;
            Self::remove_expired(&mut sessions);
            let session = sessions
                .get(execution_id)
                .filter(|session| {
                    session.drive == drive
                        && session.owner_origin == owner_origin
                        && (!require_v2 || session.contract_version == ArchiveContractVersion::V2)
                })
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            (session.status(), session.live_extraction.clone())
        };
        if status.kind == ArchiveSessionKind::Extract && status.phase == ArchiveSessionPhase::AwaitingUserDecision {
            let source = source.ok_or_else(|| ApiError::conflict_message("Live archive extraction source is unavailable"))?;
            status.pending_decision = source
                .lock()
                .await
                .pending_decision()
                .map_err(|error| ApiError::conflict_message(error.to_string()))?;
        }
        Ok(status)
    }

    #[cfg(test)]
    pub(crate) async fn session_kind(&self, execution_id: &str) -> Result<ArchiveSessionKind, ApiError> {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        sessions
            .get(execution_id)
            .map(|session| session.kind)
            .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))
    }

    pub(crate) async fn direct_local_creation_plan(
        &self,
        execution_id: &str,
    ) -> Result<Option<(Vec<LocalArchiveEntry>, LocalArchiveCreationExecutionPlan)>, ApiError> {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        sessions
            .get(execution_id)
            .map(|session| session.creation_manifest_entries.clone().zip(session.creation_plan.clone()))
            .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))
    }

    pub(crate) async fn direct_local_creation_work(&self, execution_id: &str) -> Result<(PathBuf, Vec<PathBuf>, PathBuf), ApiError> {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        let session = sessions
            .get(execution_id)
            .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
        let ArchiveSessionWork::Creation { source_paths, target_path } = &session.work else {
            return Err(ApiError::conflict_message("Archive execution is not a creation operation"));
        };
        Ok((session.drive_root.clone(), source_paths.clone(), target_path.clone()))
    }

    pub(crate) async fn direct_local_extraction_work(&self, execution_id: &str) -> Result<(PathBuf, PathBuf, PathBuf), ApiError> {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        let session = sessions
            .get(execution_id)
            .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
        let ArchiveSessionWork::Extraction {
            archive_path,
            destination_path,
            ..
        } = &session.work
        else {
            return Err(ApiError::conflict_message("Archive execution is not an extraction operation"));
        };
        Ok((session.drive_root.clone(), archive_path.clone(), destination_path.clone()))
    }

    pub(crate) async fn start_state(&self, execution_id: &str) -> Result<(PathBuf, ArchiveSessionWork, Arc<AtomicBool>, ()), ApiError> {
        let (drive_root, work, cancellation_requested, checkpoint) = {
            let mut sessions = self.sessions.lock().await;
            Self::remove_expired(&mut sessions);
            let session = sessions
                .get_mut(execution_id)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            if session.phase != ArchiveSessionPhase::Accepted {
                return Err(ApiError::conflict_message("Archive execution has already started"));
            }
            session.phase = ArchiveSessionPhase::Streaming;
            session.revision += 1;
            (
                session.drive_root.clone(),
                session.work.clone(),
                session.cancellation_requested.clone(),
                (),
            )
        };
        #[cfg(test)]
        self.record_phase_transition(execution_id, ArchiveSessionPhase::Streaming).await;
        Ok((drive_root, work, cancellation_requested, checkpoint))
    }

    /// Open and retain a local archive source outside the manager mutex, then start its live session.
    pub(crate) async fn start_live_extraction(
        &self,
        execution_id: &str,
    ) -> Result<
        (
            PathBuf,
            PathBuf,
            PathBuf,
            Arc<AtomicBool>,
            Arc<Mutex<LiveLocalArchiveSourceSession>>,
        ),
        ApiError,
    > {
        let (archive_path, selected_member_roots) = {
            let mut sessions = self.sessions.lock().await;
            Self::remove_expired(&mut sessions);
            let session = sessions
                .get_mut(execution_id)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            if session.kind != ArchiveSessionKind::Extract || session.phase != ArchiveSessionPhase::Accepted {
                return Err(ApiError::conflict_message("Archive execution has already started"));
            }
            let ArchiveSessionWork::Extraction {
                archive_path,
                selected_member_roots,
                ..
            } = &session.work
            else {
                return Err(ApiError::conflict_message("Archive execution is not an extraction operation"));
            };
            let archive_path = archive_path.clone();
            let selected_member_roots = selected_member_roots.clone();
            session.phase = ArchiveSessionPhase::Streaming;
            session.revision += 1;
            (archive_path, selected_member_roots)
        };
        #[cfg(test)]
        self.record_phase_transition(execution_id, ArchiveSessionPhase::Streaming).await;
        let source =
            tokio::task::spawn_blocking(move || LiveLocalArchiveSourceSession::open_with_selection(&archive_path, selected_member_roots))
                .await
                .map_err(|error| ApiError::Internal(format!("Local archive source task failed: {error}")))?
                .map_err(|error| ApiError::Internal(error.to_string()))?;
        let source = Arc::new(Mutex::new(source));
        let (drive_root, archive_path, destination_path, cancellation_requested) = {
            let mut sessions = self.sessions.lock().await;
            Self::remove_expired(&mut sessions);
            let session = sessions
                .get_mut(execution_id)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            if session.kind != ArchiveSessionKind::Extract || session.phase != ArchiveSessionPhase::Streaming {
                return Err(ApiError::conflict_message("Archive execution is no longer accepting a live source"));
            }
            let ArchiveSessionWork::Extraction {
                archive_path,
                destination_path,
                ..
            } = &session.work
            else {
                return Err(ApiError::conflict_message("Archive execution is not an extraction operation"));
            };
            session.live_extraction = Some(source.clone());
            (
                session.drive_root.clone(),
                archive_path.clone(),
                destination_path.clone(),
                session.cancellation_requested.clone(),
            )
        };
        Ok((drive_root, archive_path, destination_path, cancellation_requested, source))
    }
}

impl ArchiveSessionManager {
    pub(crate) async fn decision_state(
        &self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
    ) -> Result<ArchiveSessionDecisionState, ApiError> {
        let (phase, revision, source) = {
            let mut sessions = self.sessions.lock().await;
            ArchiveSessionManager::remove_expired(&mut sessions);
            let session = sessions
                .get(execution_id)
                .filter(|session| session.drive == drive && session.owner_origin == owner_origin)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            (session.phase, session.revision, session.live_extraction.clone())
        };
        let pending_decision = match source {
            Some(source) => source
                .lock()
                .await
                .pending_decision()
                .map_err(|error| ApiError::conflict_message(error.to_string()))?,
            None => None,
        };
        Ok(ArchiveSessionDecisionState {
            phase,
            revision,
            pending_decision,
        })
    }

    pub(crate) async fn resume_live_extraction(
        &self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
        expected_revision: u64,
        decision: ArchiveSessionDecision,
    ) -> Result<
        (
            PathBuf,
            PathBuf,
            Arc<AtomicBool>,
            Arc<Mutex<LiveLocalArchiveSourceSession>>,
            ArchiveSessionStatus,
        ),
        ApiError,
    > {
        let (drive_root, destination_path, cancellation_requested, source) = {
            let mut sessions = self.sessions.lock().await;
            Self::remove_expired(&mut sessions);
            let session = sessions
                .get_mut(execution_id)
                .filter(|session| session.drive == drive && session.owner_origin == owner_origin)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            if session.revision != expected_revision {
                return Err(ApiError::conflict_code(
                    "Archive execution changed before the decision could be applied",
                    ARCHIVE_SESSION_STALE_REVISION_CODE,
                ));
            }
            if session.phase != ArchiveSessionPhase::AwaitingUserDecision {
                return Err(ApiError::conflict_message("Archive execution is not awaiting a user decision"));
            }
            let source = session
                .live_extraction
                .clone()
                .ok_or_else(|| ApiError::Internal("Live archive extraction source is unavailable".to_string()))?;
            let ArchiveSessionWork::Extraction { destination_path, .. } = &session.work else {
                return Err(ApiError::conflict_message("Archive execution is not an extraction operation"));
            };
            (
                session.drive_root.clone(),
                destination_path.clone(),
                session.cancellation_requested.clone(),
                source,
            )
        };
        {
            let mut source = source.lock().await;
            let pending = source
                .pending_decision()
                .map_err(|error| ApiError::conflict_message(error.to_string()))?
                .ok_or_else(|| ApiError::conflict_message("Archive extraction decision details are unavailable"))?;
            if pending.source_session_id != decision.source_session_id
                || pending.delivery_sequence != decision.delivery_sequence
                || pending.decision_revision != decision.decision_revision
                || pending.member_path != decision.member_path
            {
                return Err(ApiError::conflict_message(
                    "Archive decision does not match the current live source delivery",
                ));
            }
            if pending.member_error.is_some() {
                source
                    .resolve_member_error(decision.action)
                    .map_err(|error| ApiError::BadRequest(error.to_string()))?;
            } else {
                source
                    .resolve_collision(decision.action, decision.target_path.as_deref())
                    .map_err(|error| ApiError::BadRequest(error.to_string()))?;
            }
        }
        let status = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(execution_id)
                .filter(|session| session.drive == drive && session.owner_origin == owner_origin)
                .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
            if session.revision != expected_revision || session.phase != ArchiveSessionPhase::AwaitingUserDecision {
                return Err(ApiError::conflict_message(
                    "Archive execution changed before the decision could be applied",
                ));
            }
            session.phase = ArchiveSessionPhase::Streaming;
            session.revision += 1;
            session.expires_at = None;
            session.status()
        };
        #[cfg(test)]
        self.record_phase_transition(execution_id, ArchiveSessionPhase::Streaming).await;
        Ok((drive_root, destination_path, cancellation_requested, source, status))
    }
}

impl ArchiveSessionManager {
    pub async fn cancel(
        &self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
        expected_revision: u64,
    ) -> Result<ArchiveSessionStatus, ApiError> {
        let mut sessions = self.sessions.lock().await;
        Self::remove_expired(&mut sessions);
        let session = sessions
            .get_mut(execution_id)
            .filter(|session| session.drive == drive && session.owner_origin == owner_origin)
            .ok_or_else(|| ApiError::NotFound("Archive execution not found or expired".to_string()))?;
        if session.revision != expected_revision {
            return Err(ApiError::conflict_code(
                "Archive execution changed before cancellation could be applied",
                ARCHIVE_SESSION_STALE_REVISION_CODE,
            ));
        }
        if session.phase == ArchiveSessionPhase::AwaitingUserDecision {
            session.cancellation_requested.store(true, Ordering::Release);
            session.phase = ArchiveSessionPhase::Cancelled;
            session.revision += 1;
            session.live_extraction = None;
            session.expires_at = Some(Instant::now() + ARCHIVE_SESSION_TIMEOUT);
        } else if !session.phase.is_terminal() {
            session.cancellation_requested.store(true, Ordering::Release);
            session.revision += 1;
        }
        let status = session.status();
        let _terminal_phase = status.phase.is_terminal().then_some(status.phase);
        drop(sessions);
        #[cfg(test)]
        if let Some(phase) = _terminal_phase {
            self.record_phase_transition(execution_id, phase).await;
        }
        Ok(status)
    }

    pub(crate) async fn complete(&self, execution_id: &str, result: Result<ArchiveSessionCompletion, LocalArchiveError>) -> bool {
        let mut sessions = self.sessions.lock().await;
        let _completion = if let Some(session) = sessions.get_mut(execution_id) {
            session.complete(result);
            Some((session.phase, session.live_extraction.clone()))
        } else {
            None
        };
        drop(sessions);
        let awaiting_decision = matches!(_completion, Some((ArchiveSessionPhase::AwaitingUserDecision, _)));
        #[cfg(test)]
        if let Some((phase, source)) = _completion {
            self.record_phase_transition(execution_id, phase).await;
            if phase == ArchiveSessionPhase::AwaitingUserDecision {
                if let Some(source) = source {
                    if let Ok(Some(pending_decision)) = source.lock().await.pending_decision() {
                        self.record_pending_decision(execution_id, &pending_decision).await;
                    }
                }
            }
        }
        awaiting_decision
    }

    pub(crate) async fn record_creation_plan(
        &self,
        execution_id: &str,
        entries: Vec<LocalArchiveEntry>,
        execution_plan: LocalArchiveCreationExecutionPlan,
    ) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(execution_id) {
            session.creation_manifest_entries = Some(entries);
            session.creation_plan = Some(execution_plan);
        }
    }

    pub(crate) async fn update_progress(&self, execution_id: &str, progress: ArchiveSessionProgress) {
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(execution_id) {
            if session.phase == ArchiveSessionPhase::Streaming
                && std::mem::discriminant(&session.progress) == std::mem::discriminant(&progress)
            {
                session.progress = progress;
                session.revision += 1;
            }
        }
    }
}

#[cfg(test)]
impl FixtureDirectLocalInvocation {
    pub async fn start(&self, execution_id: &str) -> Result<(), ApiError> {
        crate::server::handlers::start_direct_local_archive_session(self.state_store.clone(), execution_id).await
    }

    #[cfg(test)]
    async fn start_with_creation_pre_write_action(&self, execution_id: &str, action: CreationPreWriteAction) -> Result<(), ApiError> {
        crate::server::handlers::start_direct_local_archive_session_with_creation_pre_write_action(
            self.state_store.clone(),
            execution_id,
            action,
        )
        .await
    }

    pub async fn decide(
        &self,
        drive: &str,
        owner_origin: &str,
        execution_id: &str,
        expected_revision: u64,
        decision: ArchiveSessionDecision,
    ) -> Result<ArchiveSessionStatus, ApiError> {
        crate::server::handlers::decide_direct_local_archive_session(
            self.state_store.clone(),
            drive,
            owner_origin,
            execution_id,
            expected_revision,
            decision,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tempfile::tempdir;

    use super::{
        ArchiveSessionDecision, ArchiveSessionDecisionAction, ArchiveSessionManager, ArchiveSessionPhase, ArchiveSessionProgress,
        FixtureDirectLocalInvocation, LiveLocalArchiveSourcePhase, LiveLocalArchiveSourceSession, RelayLiveSourceDetails,
    };
    use crate::server::archive::{
        build_local_archive_manifest, create_local_archive, LocalArchiveError, LocalArchiveExtractionDestinationResult,
        LocalArchiveExtractionDestinationStatus, LocalArchiveReadError,
    };
    use zip::write::{SimpleFileOptions, ZipWriter};

    fn is_transport_failure(error: &str) -> bool {
        let normalized = error.to_ascii_lowercase();
        [
            "no such file or directory",
            "the system cannot find the file specified",
            "access is denied",
            "permission denied",
        ]
        .iter()
        .any(|message| normalized.contains(message))
    }

    fn expected_trace(case_name: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .find(|case| case["name"] == case_name)
            .unwrap_or_else(|| panic!("topology trace fixture should define {case_name}"))["expected_trace"]
            .clone()
    }

    async fn direct_local_trace(
        manager: &ArchiveSessionManager,
        execution_id: &str,
        status: &super::ArchiveSessionStatus,
        manifest_snapshot: Vec<&str>,
        member_outcomes: Vec<&str>,
    ) -> serde_json::Value {
        let terminal_summary = match status.result {
            Some(ArchiveSessionProgress::Creation(result)) => serde_json::json!({
                "files_created": result.files_created,
                "directories_created": result.directories_created,
                "source_bytes": result.source_bytes,
            }),
            Some(ArchiveSessionProgress::Extraction(result)) => serde_json::json!({
                "files_extracted": result.files_extracted,
                "files_skipped": result.members_skipped,
                "extracted_bytes": result.extracted_bytes,
            }),
            None => serde_json::Value::Null,
        };
        serde_json::json!({
            "owner": "companion",
            "manifest_snapshot": manifest_snapshot,
            "phase_transitions": manager.recorded_phase_transitions(execution_id).await,
            "pending_decision": manager.recorded_pending_decision(execution_id).await,
            "member_outcomes": member_outcomes,
            "terminal_summary": terminal_summary,
            "error_category": match status.phase {
                ArchiveSessionPhase::Cancelled => serde_json::Value::String("cancelled".to_string()),
                ArchiveSessionPhase::Failed => serde_json::Value::String(
                    if status.error.as_deref().is_some_and(|error| error.contains("source changed")) {
                        "source_changed"
                    } else if status.error.as_deref().is_some_and(|error| error.contains("partial output")) {
                        "partial_write"
                    } else if status.error.as_deref().is_some_and(|error| error.contains("output already exists")) {
                        "collision"
                    } else if status.error.as_deref().is_some_and(is_transport_failure) {
                        "transport_failure"
                    } else {
                        "invalid_input"
                    }
                    .to_string(),
                ),
                ArchiveSessionPhase::AwaitingUserDecision if status.pending_decision.as_ref().is_some_and(|decision| decision.member_error.is_some()) => {
                    serde_json::Value::String("partial_write".to_string())
                }
                _ => serde_json::Value::Null,
            },
        })
    }

    async fn direct_local_creation_trace(
        manager: &ArchiveSessionManager,
        execution_id: &str,
        status: &super::ArchiveSessionStatus,
    ) -> serde_json::Value {
        let (manifest_snapshot, member_outcomes) = {
            let sessions = manager.sessions.lock().await;
            let session = sessions
                .get(execution_id)
                .expect("creation session should remain available while its trace is read");
            let mut manifest_snapshot = session
                .creation_manifest_entries
                .as_ref()
                .map(|entries| entries.iter().map(|entry| entry.archive_path.clone()).collect::<Vec<_>>())
                .unwrap_or_default();
            let mut member_outcomes = session
                .creation_state
                .as_ref()
                .map(|state| state.completed_member_paths().map(str::to_owned).collect::<Vec<_>>())
                .unwrap_or_default();
            manifest_snapshot.sort();
            member_outcomes.sort();
            (manifest_snapshot, member_outcomes)
        };
        direct_local_trace(
            manager,
            execution_id,
            status,
            manifest_snapshot.iter().map(String::as_str).collect(),
            member_outcomes.iter().map(String::as_str).collect(),
        )
        .await
    }

    async fn wait_for_terminal_session(manager: &ArchiveSessionManager, execution_id: &str) -> super::ArchiveSessionStatus {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("local archive session should terminate")
    }

    #[test]
    fn live_source_session_requires_verified_stream_before_accepting_results() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("first.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"first").unwrap();
        archive.start_file("second.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"second").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let first = source.next_member().unwrap().unwrap();
        assert_eq!(first.entry.path, "first.txt");
        assert_eq!(first.delivery_sequence, 1);
        let first_result = LocalArchiveExtractionDestinationResult {
            member_path: first.entry.path.clone(),
            status: LocalArchiveExtractionDestinationStatus::Extracted,
            target_path: "first.txt".to_string(),
            extracted_bytes: first.entry.uncompressed_size,
            directories_created: 0,
            replaced: false,
            renamed: false,
        };
        assert!(source.apply_destination_result(first.delivery_sequence, &first_result).is_err());

        let mut contents = Vec::new();
        source
            .stream_current_member(first.delivery_sequence, &mut contents, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(contents, b"first");
        source.apply_destination_result(first.delivery_sequence, &first_result).unwrap();

        let second = source.next_member().unwrap().unwrap();
        assert_eq!(second.entry.path, "second.txt");
        assert_eq!(second.delivery_sequence, 2);
        let aggregate = source.aggregate();
        assert_eq!(aggregate.members_processed, 1);
        assert_eq!(aggregate.members_completed, 1);
        assert_eq!(aggregate.members_skipped, 0);
        assert_eq!(aggregate.members_failed, 0);
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Current);
    }

    #[test]
    fn live_source_session_limits_delivery_to_selected_member_roots() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("docs/readme.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"readme").unwrap();
        archive.start_file("private/secret.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"secret").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open_with_selection(&archive_path, Some(vec!["docs".to_string()])).unwrap();
        let member = source.next_member().unwrap().unwrap();
        assert_eq!(member.entry.path, "docs/readme.txt");
        let mut contents = Vec::new();
        source
            .stream_current_member(member.delivery_sequence, &mut contents, &AtomicBool::new(false))
            .unwrap();
        source
            .apply_destination_result(
                member.delivery_sequence,
                &LocalArchiveExtractionDestinationResult {
                    member_path: member.entry.path,
                    status: LocalArchiveExtractionDestinationStatus::Extracted,
                    target_path: "docs/readme.txt".to_string(),
                    extracted_bytes: contents.len() as u64,
                    directories_created: 0,
                    replaced: false,
                    renamed: false,
                },
            )
            .unwrap();

        assert!(source.next_member().unwrap().is_none());
    }

    #[test]
    fn invalid_directory_header_is_source_failed_before_the_next_member_is_delivered() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.add_directory("folder/", SimpleFileOptions::default()).unwrap();
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut archive_bytes = fs::read(&archive_path).unwrap();
        archive_bytes[..4].copy_from_slice(b"BAD!");
        fs::write(&archive_path, archive_bytes).unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let member = source.next_member().unwrap().unwrap();

        assert_eq!(member.entry.path, "entry.txt");
        assert_eq!(member.delivery_sequence, 1);
        assert_eq!(source.aggregate().members_failed, 1);
        assert_eq!(source.aggregate().members_processed, 1);
    }

    #[test]
    fn source_only_unavailable_members_report_skip_reasons() {
        const CENTRAL_FLAGS_OFFSET: usize = 8;
        const CENTRAL_COMPRESSION_OFFSET: usize = 10;
        const ENCRYPTED_FLAG: u16 = 1;
        const UNSUPPORTED_COMPRESSION: u16 = 99;

        for encrypted in [true, false] {
            let directory = tempdir().unwrap();
            let archive_path = directory.path().join("archive.zip");
            let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
            archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
            archive.write_all(b"entry").unwrap();
            archive.finish().unwrap();

            let mut archive_bytes = fs::read(&archive_path).unwrap();
            let central_offset = archive_bytes
                .windows(b"PK\x01\x02".len())
                .position(|bytes| bytes == b"PK\x01\x02")
                .unwrap();
            let (field_offset, value) = if encrypted {
                (CENTRAL_FLAGS_OFFSET, ENCRYPTED_FLAG)
            } else {
                (CENTRAL_COMPRESSION_OFFSET, UNSUPPORTED_COMPRESSION)
            };
            let encoded = value.to_le_bytes();
            let offset = central_offset + field_offset;
            archive_bytes[offset..offset + encoded.len()].copy_from_slice(&encoded);
            fs::write(&archive_path, archive_bytes).unwrap();

            let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
            assert!(source.next_member().unwrap().is_none());
            assert_eq!(source.aggregate().members_skipped, 1);
            assert_eq!(source.aggregate().encrypted_members_skipped, u64::from(encrypted));
            assert_eq!(source.aggregate().unsupported_compression_members_skipped, u64::from(!encrypted));
            assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Completed);
        }
    }

    #[test]
    fn source_change_during_entry_validation_is_terminal_and_uncounted() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        assert!(matches!(
            source.handle_entry_validation_error(LocalArchiveReadError::SourceChanged),
            Err(LocalArchiveError::ArchiveSourceChanged)
        ));
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Failed);
        assert_eq!(source.aggregate(), Default::default());
        assert!(source.next_member().is_err());
    }

    #[test]
    fn directory_collision_skip_finalizes_the_current_delivery() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.add_directory("folder/", SimpleFileOptions::default()).unwrap();
        archive.start_file("folder/entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let directory_member = source.next_member().unwrap().unwrap();
        source.pause_for_decision(directory_member.delivery_sequence).unwrap();
        source.resolve_collision(ArchiveSessionDecisionAction::Skip, None).unwrap();

        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Ready);
        assert_eq!(source.aggregate().members_skipped, 1);
        let member = source.next_member().unwrap().unwrap();
        assert_eq!(member.entry.path, "folder/entry.txt");
        assert_eq!(member.delivery_sequence, 2);
    }

    #[test]
    fn collision_decision_redelivers_once_and_rejects_duplicates() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let member = source.next_member().unwrap().unwrap();
        source.pause_for_decision(member.delivery_sequence).unwrap();
        let decision_revision = source.pending_decision_revision().unwrap();
        let source_session_id = source.source_session_id().to_string();
        source
            .claim_decision(
                &source_session_id,
                member.delivery_sequence,
                decision_revision,
                ArchiveSessionDecisionAction::Replace,
                &member.entry.path,
                None,
            )
            .unwrap();

        assert!(source
            .claim_decision(
                &source_session_id,
                member.delivery_sequence,
                decision_revision,
                ArchiveSessionDecisionAction::Replace,
                &member.entry.path,
                None,
            )
            .is_err());
        assert!(source.next_destination_member().is_err());
        source.finalize_claimed_decision().unwrap();
        let redelivery = source.next_destination_member().unwrap().unwrap();
        assert_eq!(redelivery.entry.path, member.entry.path);
        assert_eq!(redelivery.delivery_sequence, member.delivery_sequence + 1);
        assert_eq!(source.aggregate(), Default::default());
        assert!(source.next_destination_member().is_err());
        assert_eq!(source.current().unwrap().delivery_sequence, redelivery.delivery_sequence);
    }

    #[test]
    fn directory_rename_does_not_rewrite_descendant_targets() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.add_directory("folder/", SimpleFileOptions::default()).unwrap();
        archive.start_file("folder/entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let directory_member = source.next_member().unwrap().unwrap();
        source.pause_for_decision(directory_member.delivery_sequence).unwrap();
        source
            .resolve_collision(ArchiveSessionDecisionAction::Rename, Some("renamed-folder"))
            .unwrap();
        assert_eq!(source.current_target_path().unwrap(), "renamed-folder");
        let renamed_delivery = source.current().unwrap().delivery_sequence;
        source.mark_directory_delivery_ready(renamed_delivery).unwrap();
        source
            .apply_destination_result(
                renamed_delivery,
                &LocalArchiveExtractionDestinationResult {
                    member_path: "folder".to_string(),
                    status: LocalArchiveExtractionDestinationStatus::Directory,
                    target_path: "renamed-folder".to_string(),
                    extracted_bytes: 0,
                    directories_created: 1,
                    replaced: false,
                    renamed: true,
                },
            )
            .unwrap();

        let member = source.next_member().unwrap().unwrap();
        assert_eq!(member.entry.path, "folder/entry.txt");
        assert_eq!(source.current_target_path().unwrap(), "folder/entry.txt");
    }

    #[test]
    fn cancellation_stops_current_stream_without_a_member_outcome() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let member = source.next_member().unwrap().unwrap();
        let cancellation_requested = AtomicBool::new(true);
        let mut output = Vec::new();

        assert!(matches!(
            source.stream_current_member(member.delivery_sequence, &mut output, &cancellation_requested),
            Err(LocalArchiveError::Cancelled)
        ));
        assert!(output.is_empty());
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Cancelled);
        assert_eq!(source.aggregate(), super::LocalArchiveExtractionResult::default());
    }

    #[tokio::test]
    async fn failed_relay_source_is_fenced_and_cannot_reopen() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = ArchiveSessionManager::new();
        let operation_id = "operation-id";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";
        let (source, cancellation_requested) = manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path.clone(), server_url, operation_token)
            .await
            .unwrap();

        manager.fail_relay_live_source(operation_id).await;

        assert!(cancellation_requested.load(Ordering::Acquire));
        assert_eq!(source.lock().await.phase(), LiveLocalArchiveSourcePhase::Failed);
        assert!(manager.relay_live_source(operation_id, drive, owner_origin).await.is_err());
        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path, server_url, operation_token)
            .await
            .is_err());

        manager.confirm_relay_source_terminalized(operation_id).await;
        assert!(!manager.closed_relay_source_ids.lock().await.contains(operation_id));
    }

    #[tokio::test]
    async fn duplicate_relay_start_rejects_without_aborting_the_live_source() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = ArchiveSessionManager::new();
        let operation_id = "operation-id";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";
        let (source, cancellation_requested) = manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path.clone(), server_url, operation_token)
            .await
            .unwrap();

        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path, server_url, operation_token)
            .await
            .is_err());
        assert!(!cancellation_requested.load(Ordering::Acquire));
        assert_eq!(source.lock().await.phase(), LiveLocalArchiveSourcePhase::Ready);
        assert!(manager.relay_live_source(operation_id, drive, owner_origin).await.is_ok());
    }

    #[tokio::test]
    async fn concurrent_relay_starts_open_the_pinned_source_once() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = Arc::new(ArchiveSessionManager::new());
        let open_count = Arc::new(AtomicUsize::new(0));
        let (open_started_sender, open_started_receiver) = mpsc::sync_channel(1);
        let (continue_open_sender, continue_open_receiver) = mpsc::sync_channel(1);
        let operation_id = "operation-id";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";

        let first_manager = manager.clone();
        let first_archive_path = archive_path.clone();
        let first_open_count = open_count.clone();
        let first_start = tokio::spawn(async move {
            first_manager
                .start_relay_live_source_with_opener(
                    operation_id,
                    RelayLiveSourceDetails {
                        drive: drive.to_string(),
                        owner_origin: owner_origin.to_string(),
                        archive_path: first_archive_path,
                        server_url: server_url.to_string(),
                        operation_token: operation_token.to_string(),
                        selected_member_roots: None,
                    },
                    move |source_path| {
                        first_open_count.fetch_add(1, Ordering::AcqRel);
                        open_started_sender.send(()).unwrap();
                        continue_open_receiver.recv().unwrap();
                        LiveLocalArchiveSourceSession::open(&source_path)
                    },
                )
                .await
        });
        tokio::task::spawn_blocking(move || open_started_receiver.recv().unwrap())
            .await
            .unwrap();

        let second_open_count = open_count.clone();
        assert!(manager
            .start_relay_live_source_with_opener(
                operation_id,
                RelayLiveSourceDetails {
                    drive: drive.to_string(),
                    owner_origin: owner_origin.to_string(),
                    archive_path,
                    server_url: server_url.to_string(),
                    operation_token: operation_token.to_string(),
                    selected_member_roots: None,
                },
                move |source_path| {
                    second_open_count.fetch_add(1, Ordering::AcqRel);
                    LiveLocalArchiveSourceSession::open(&source_path)
                },
            )
            .await
            .is_err());
        assert_eq!(open_count.load(Ordering::Acquire), 1);

        continue_open_sender.send(()).unwrap();
        assert!(first_start.await.unwrap().is_ok());
        assert_eq!(open_count.load(Ordering::Acquire), 1);
    }

    #[tokio::test]
    async fn relay_source_failure_during_open_discards_the_pinned_source() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = Arc::new(ArchiveSessionManager::new());
        let (open_started_sender, open_started_receiver) = mpsc::sync_channel(1);
        let (continue_open_sender, continue_open_receiver) = mpsc::sync_channel(1);
        let operation_id = "operation-id";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";

        let opening_manager = manager.clone();
        let opening_archive_path = archive_path.clone();
        let opening = tokio::spawn(async move {
            opening_manager
                .start_relay_live_source_with_opener(
                    operation_id,
                    RelayLiveSourceDetails {
                        drive: drive.to_string(),
                        owner_origin: owner_origin.to_string(),
                        archive_path: opening_archive_path,
                        server_url: server_url.to_string(),
                        operation_token: operation_token.to_string(),
                        selected_member_roots: None,
                    },
                    move |source_path| {
                        open_started_sender.send(()).unwrap();
                        continue_open_receiver.recv().unwrap();
                        LiveLocalArchiveSourceSession::open(&source_path)
                    },
                )
                .await
        });
        tokio::task::spawn_blocking(move || open_started_receiver.recv().unwrap())
            .await
            .unwrap();

        manager.fail_relay_live_source(operation_id).await;
        continue_open_sender.send(()).unwrap();

        assert!(opening.await.unwrap().is_err());
        assert!(manager.relay_live_source(operation_id, drive, owner_origin).await.is_err());
        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path, server_url, operation_token)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancelled_relay_start_keeps_its_opening_reservation_until_open_finishes() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = Arc::new(ArchiveSessionManager::new());
        let (open_started_sender, open_started_receiver) = mpsc::sync_channel(1);
        let (continue_open_sender, continue_open_receiver) = mpsc::sync_channel(1);
        let (open_finished_sender, open_finished_receiver) = mpsc::sync_channel(1);
        let operation_id = "operation-id";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";

        let opening_manager = manager.clone();
        let opening_archive_path = archive_path.clone();
        let opening = tokio::spawn(async move {
            opening_manager
                .start_relay_live_source_with_opener(
                    operation_id,
                    RelayLiveSourceDetails {
                        drive: drive.to_string(),
                        owner_origin: owner_origin.to_string(),
                        archive_path: opening_archive_path,
                        server_url: server_url.to_string(),
                        operation_token: operation_token.to_string(),
                        selected_member_roots: None,
                    },
                    move |source_path| {
                        open_started_sender.send(()).unwrap();
                        continue_open_receiver.recv().unwrap();
                        let source = LiveLocalArchiveSourceSession::open(&source_path);
                        open_finished_sender.send(()).unwrap();
                        source
                    },
                )
                .await
        });
        tokio::task::spawn_blocking(move || open_started_receiver.recv().unwrap())
            .await
            .unwrap();

        opening.abort();
        let opening_result = opening.await;
        assert!(opening_result.is_err_and(|error| error.is_cancelled()));
        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path.clone(), server_url, operation_token)
            .await
            .is_err());

        continue_open_sender.send(()).unwrap();
        tokio::task::spawn_blocking(move || open_finished_receiver.recv().unwrap())
            .await
            .unwrap();
        while manager
            .opening_relay_source_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(operation_id)
        {
            tokio::task::yield_now().await;
        }

        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path, server_url, operation_token)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn expired_relay_source_is_fenced_and_emits_failure_capability_once() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let manager = ArchiveSessionManager::new();
        let operation_id = "expired-operation";
        let drive = "c";
        let owner_origin = "https://sambee.example";
        let server_url = "https://server.example";
        let operation_token = "operation-token";
        let (source, cancellation_requested) = manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path.clone(), server_url, operation_token)
            .await
            .unwrap();
        manager.arm_relay_live_source_expiry(operation_id).await.unwrap();
        manager.disarm_relay_live_source_expiry(operation_id).await.unwrap();

        assert!(manager.expire_relay_live_source(operation_id).await.is_none());
        assert!(manager.relay_live_source(operation_id, drive, owner_origin).await.is_ok());

        manager.relay_live_sources.lock().await.get_mut(operation_id).unwrap().expires_at = Some(Instant::now() - Duration::from_secs(1));

        let expired = manager.expire_relay_live_source(operation_id).await.into_iter().collect::<Vec<_>>();

        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].operation_id, operation_id);
        assert_eq!(expired[0].server_url, server_url);
        assert_eq!(expired[0].operation_token, operation_token);
        assert!(cancellation_requested.load(Ordering::Acquire));
        assert_eq!(source.lock().await.phase(), LiveLocalArchiveSourcePhase::Failed);
        assert!(manager.relay_live_source(operation_id, drive, owner_origin).await.is_err());
        assert!(manager.expire_relay_live_source(operation_id).await.is_none());
        assert!(manager
            .start_relay_live_source(operation_id, drive, owner_origin, archive_path, server_url, operation_token)
            .await
            .is_err());
    }

    #[test]
    fn member_integrity_failure_retains_the_live_source_for_ignore() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut archive_bytes = fs::read(&archive_path).unwrap();
        let central_directory_offset = archive_bytes
            .windows(4)
            .rposition(|bytes| bytes == b"PK\x01\x02")
            .expect("archive should contain a central-directory record");
        archive_bytes[central_directory_offset + 16..central_directory_offset + 20].copy_from_slice(&0_u32.to_le_bytes());
        fs::write(&archive_path, archive_bytes).unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let member = source.next_member().unwrap().unwrap();
        let mut output = Vec::new();
        assert!(matches!(
            source.stream_current_member(member.delivery_sequence, &mut output, &AtomicBool::new(false)),
            Err(LocalArchiveError::ArchiveRead(LocalArchiveReadError::MemberIntegrityFailure))
        ));
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::StreamingCurrent);
        assert!(source
            .apply_destination_result(
                member.delivery_sequence,
                &LocalArchiveExtractionDestinationResult {
                    member_path: member.entry.path.clone(),
                    status: LocalArchiveExtractionDestinationStatus::Extracted,
                    target_path: member.entry.path.clone(),
                    extracted_bytes: member.entry.uncompressed_size,
                    directories_created: 0,
                    replaced: false,
                    renamed: false,
                }
            )
            .is_err());
        assert!(source.next_member().is_err());

        source.pause_for_member_error(member.delivery_sequence).unwrap();
        source
            .set_pending_decision_details(Some(member.entry.path.clone()), Some("CRC mismatch".to_string()), None, None)
            .unwrap();
        let decision = source.pending_decision().unwrap().unwrap();
        assert_eq!(decision.source_session_id, source.source_session_id());
        assert_eq!(decision.delivery_sequence, member.delivery_sequence);
        assert_eq!(decision.decision_revision, 1);
        assert!(decision.member_error.is_some());

        source.resolve_member_error(ArchiveSessionDecisionAction::Ignore).unwrap();
        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Ready);
        let aggregate = source.aggregate();
        assert_eq!(aggregate.members_processed, 1);
        assert_eq!(aggregate.members_completed, 0);
        assert_eq!(aggregate.members_skipped, 1);
        assert_eq!(aggregate.members_failed, 0);
        assert!(source.next_member().unwrap().is_none());
    }

    #[test]
    fn aborting_a_live_source_does_not_replay_or_count_its_current_member() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("archive.zip");
        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        archive.start_file("entry.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"entry").unwrap();
        archive.finish().unwrap();

        let mut source = LiveLocalArchiveSourceSession::open(&archive_path).unwrap();
        let member = source.next_member().unwrap().unwrap();
        source.abort();

        assert_eq!(source.phase(), LiveLocalArchiveSourcePhase::Failed);
        assert!(source.next_member().is_err());
        let aggregate = source.aggregate();
        assert_eq!(aggregate.members_processed, 0);
        assert_eq!(aggregate.members_completed, 0);
        assert_eq!(aggregate.members_skipped, 0);
        assert_eq!(aggregate.members_failed, 0);
        assert_eq!(member.delivery_sequence, 1);
    }

    #[tokio::test]
    async fn cancellation_requires_current_revision_and_reaches_terminal_state() {
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                PathBuf::from("/drive"),
                PathBuf::from("/drive/archive.zip"),
                PathBuf::from("/drive/output"),
            )
            .await;

        assert_eq!(session.phase, ArchiveSessionPhase::Accepted);
        assert!(manager
            .cancel("c", "https://sambee.example", &session.execution_id, session.revision + 1)
            .await
            .is_err());

        assert!(manager.get("c", "https://other.example", &session.execution_id).await.is_err());

        let cancelled = manager
            .cancel("c", "https://sambee.example", &session.execution_id, session.revision)
            .await
            .unwrap();
        assert_eq!(cancelled.revision, 1);
        assert!(cancelled.cancellation_requested);

        manager
            .complete(&session.execution_id, Err(super::LocalArchiveError::Cancelled))
            .await;
        let terminal = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
        assert_eq!(terminal.phase, ArchiveSessionPhase::Cancelled);
        assert_eq!(terminal.revision, 2);
    }

    #[tokio::test]
    async fn creation_progress_updates_are_visible_with_a_new_revision() {
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_creation(
                "c".to_string(),
                "https://sambee.example".to_string(),
                PathBuf::from("/drive"),
                vec![PathBuf::from("/drive/source.txt")],
                PathBuf::from("/drive/archive.zip"),
            )
            .await;

        {
            let mut sessions = manager.sessions.lock().await;
            let state = sessions.get_mut(&session.execution_id).unwrap();
            state.phase = ArchiveSessionPhase::Streaming;
            state.revision = 1;
        }

        manager
            .update_progress(
                &session.execution_id,
                ArchiveSessionProgress::Creation(super::LocalArchiveCreationResult {
                    files_created: 1,
                    directories_created: 1,
                    source_bytes: 5,
                }),
            )
            .await;

        let updated = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
        assert_eq!(updated.revision, 2);
        assert!(matches!(
            updated.progress,
            ArchiveSessionProgress::Creation(progress) if progress.files_created == 1 && progress.source_bytes == 5
        ));
    }

    #[tokio::test]
    async fn starts_a_creation_session_and_reports_its_typed_terminal_result() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("archive.zip");
        fs::write(&source, b"source").unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_creation(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                vec![source],
                target.clone(),
            )
            .await;

        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("archive creation session should terminate");

        assert_eq!(status.phase, ArchiveSessionPhase::Completed);
        assert!(matches!(
            status.result,
            Some(ArchiveSessionProgress::Creation(progress)) if progress.files_created == 1 && progress.source_bytes == 6
        ));
        let sessions = manager.sessions.lock().await;
        let creation_state = sessions
            .get(&session.execution_id)
            .and_then(|session| session.creation_state.as_ref())
            .expect("completed creation sessions must retain their manifest outcome ledger");
        assert_eq!(
            creation_state.terminal_summary().unwrap(),
            super::LocalArchiveCreationResult {
                files_created: 1,
                directories_created: 0,
                source_bytes: 6,
            }
        );
        assert!(target.is_file());
        let expected = expected_trace("create_local_to_local_success");
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &status, vec!["source.txt"], vec!["source.txt"]).await,
            expected
        );
    }

    #[tokio::test]
    async fn direct_local_extraction_coordinator_matches_shared_success_trace() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let archive_path = directory.path().join("archive.zip");
        let destination = directory.path().join("output");
        fs::write(&source, b"source").unwrap();
        let entries = build_local_archive_manifest(&[source], &archive_path).unwrap();
        create_local_archive(directory.path(), &archive_path, &entries, || false).unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                archive_path,
                destination.clone(),
            )
            .await;

        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("direct local archive extraction should terminate");

        let expected = expected_trace("extract_local_to_local_success");
        assert!(matches!(
            completed.result,
            Some(ArchiveSessionProgress::Extraction(progress))
                if progress.files_extracted == expected["terminal_summary"]["files_extracted"]
                    && progress.extracted_bytes == expected["terminal_summary"]["extracted_bytes"]
        ));
        assert_eq!(fs::read(destination.join("source.txt")).unwrap(), b"source");
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &completed, vec!["source.txt"], vec!["source.txt"]).await,
            expected
        );
    }

    #[tokio::test]
    async fn direct_local_malformed_archive_matches_shared_trace() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("not-an-archive.bin");
        fs::write(&archive_path, b"not a ZIP archive").unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                archive_path,
                directory.path().join("output"),
            )
            .await;
        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let failed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("malformed local archive should terminate");

        assert_eq!(failed.phase, ArchiveSessionPhase::Failed);
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &failed, vec![], vec![]).await,
            expected_trace("extract_local_to_local_malformed_input")
        );
    }

    #[tokio::test]
    async fn direct_local_missing_archive_source_matches_transport_failure_trace() {
        let directory = tempdir().unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                directory.path().join("unavailable.zip"),
                directory.path().join("output"),
            )
            .await;
        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let failed = wait_for_terminal_session(&manager, &session.execution_id).await;

        assert_eq!(failed.phase, ArchiveSessionPhase::Failed);
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &failed, vec![], vec![]).await,
            expected_trace("extract_local_to_local_transport_failure")
        );
    }

    #[tokio::test]
    async fn direct_local_extraction_cancellation_matches_shared_trace() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let archive_path = directory.path().join("archive.zip");
        fs::write(&source, b"source").unwrap();
        let entries = build_local_archive_manifest(&[source], &archive_path).unwrap();
        create_local_archive(directory.path(), &archive_path, &entries, || false).unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                archive_path,
                directory.path().join("output"),
            )
            .await;
        manager
            .cancel("c", "https://sambee.example", &session.execution_id, session.revision)
            .await
            .unwrap();
        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let cancelled = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled local archive extraction should terminate");

        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &cancelled, vec!["source.txt"], vec![]).await,
            expected_trace("extract_local_to_local_cancellation")
        );
    }

    #[tokio::test]
    async fn cancelled_creation_session_does_not_create_its_target() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("archive.zip");
        fs::write(&source, b"source").unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_creation(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                vec![source],
                target.clone(),
            )
            .await;

        manager
            .cancel("c", "https://sambee.example", &session.execution_id, session.revision)
            .await
            .unwrap();
        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let status = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled archive creation session should terminate");

        assert_eq!(status.phase, ArchiveSessionPhase::Cancelled);
        assert!(!target.exists());
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &status, vec!["source.txt"], vec![]).await,
            expected_trace("create_cancellation")
        );
    }

    #[tokio::test]
    async fn direct_local_creation_faults_dispatch_every_fixture_case() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../archive-contract/v2/fixtures/topology-execution-traces-v2.json"
        ))
        .expect("topology trace fixture should be valid JSON");
        let expected_cases = fixture["cases"]
            .as_array()
            .expect("topology trace fixture should define cases")
            .iter()
            .filter(|case| case["operation"] == "create" && case["topology"] == "local_to_local" && case["fault"].is_string())
            .map(|case| case["name"].as_str().expect("fault case must have a name"))
            .collect::<std::collections::HashSet<_>>();
        let dispatched_cases = [
            "create_local_to_local_malformed_input",
            "create_local_to_local_collision",
            "create_local_to_local_partial_write",
            "create_cancellation",
            "create_local_to_local_source_changed",
            "create_local_to_local_transport_failure",
        ]
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
        assert_eq!(
            dispatched_cases, expected_cases,
            "direct-local creation dispatcher must cover every declared fault"
        );

        for case_name in dispatched_cases {
            let directory = tempdir().expect("temporary archive directory should be created");
            let source = directory.path().join("entry.txt");
            std::fs::write(&source, b"entry").expect("source should be written");
            let target = directory.path().join("archive.zip");
            let manager = Arc::new(ArchiveSessionManager::new());
            let (source_paths, target, action) = match case_name {
                "create_local_to_local_malformed_input" => (vec![PathBuf::new()], target, None),
                "create_local_to_local_collision" => {
                    std::fs::write(&target, b"existing").expect("collision target should be written");
                    (vec![source], target, None)
                }
                "create_local_to_local_partial_write" => (vec![source], target, Some(super::CreationPreWriteAction::RemoveFirstSource)),
                "create_cancellation" => {
                    let source = directory.path().join("source.txt");
                    std::fs::write(&source, b"source").expect("cancellation source should be written");
                    (vec![source], target, Some(super::CreationPreWriteAction::Cancel))
                }
                "create_local_to_local_source_changed" => (vec![source], target, Some(super::CreationPreWriteAction::ModifyFirstSource)),
                "create_local_to_local_transport_failure" => {
                    (vec![source], directory.path().join("missing-parent").join("archive.zip"), None)
                }
                _ => unreachable!("fixture set was asserted above"),
            };
            let session = manager
                .create_creation(
                    "c".to_string(),
                    "https://sambee.example".to_string(),
                    directory.path().to_path_buf(),
                    source_paths,
                    target,
                )
                .await;
            let coordinator = FixtureDirectLocalInvocation::new(manager.clone());
            match action {
                Some(action) => coordinator
                    .start_with_creation_pre_write_action(&session.execution_id, action)
                    .await
                    .expect("creation session should start"),
                None => coordinator
                    .start(&session.execution_id)
                    .await
                    .expect("creation session should start"),
            }
            let status = wait_for_terminal_session(&manager, &session.execution_id).await;
            assert_eq!(
                direct_local_creation_trace(&manager, &session.execution_id, &status).await,
                expected_trace(case_name),
                "{case_name} must be traced by the direct-local session coordinator"
            );
        }
    }

    #[tokio::test]
    async fn collision_decision_requires_ownership_and_current_revision_then_resumes() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, b"archive contents").unwrap();
        let archive_path = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &archive_path).unwrap();
        create_local_archive(directory.path(), &archive_path, &entries, || false).unwrap();
        let destination = directory.path().join("output");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("source.txt"), b"existing contents").unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                archive_path,
                destination.clone(),
            )
            .await;

        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let paused = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase == ArchiveSessionPhase::AwaitingUserDecision {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("archive extraction session should pause for a collision");
        let pending = paused.pending_decision.expect("collision decision should remain live");
        assert_eq!(pending.member_path, "source.txt");
        assert!(FixtureDirectLocalInvocation::new(manager.clone())
            .decide(
                "c",
                "https://sambee.example",
                &session.execution_id,
                paused.revision + 1,
                ArchiveSessionDecision {
                    source_session_id: pending.source_session_id.clone(),
                    delivery_sequence: pending.delivery_sequence,
                    decision_revision: pending.decision_revision,
                    member_path: "source.txt".to_string(),
                    action: ArchiveSessionDecisionAction::ReplaceOlder,
                    target_path: None
                },
            )
            .await
            .is_err());
        assert!(FixtureDirectLocalInvocation::new(manager.clone())
            .decide(
                "c",
                "https://other.example",
                &session.execution_id,
                paused.revision,
                ArchiveSessionDecision {
                    source_session_id: pending.source_session_id.clone(),
                    delivery_sequence: pending.delivery_sequence,
                    decision_revision: pending.decision_revision,
                    member_path: "source.txt".to_string(),
                    action: ArchiveSessionDecisionAction::Skip,
                    target_path: None
                },
            )
            .await
            .is_err());

        let resumed = FixtureDirectLocalInvocation::new(manager.clone())
            .decide(
                "c",
                "https://sambee.example",
                &session.execution_id,
                paused.revision,
                ArchiveSessionDecision {
                    source_session_id: pending.source_session_id,
                    delivery_sequence: pending.delivery_sequence,
                    decision_revision: pending.decision_revision,
                    member_path: "source.txt".to_string(),
                    action: ArchiveSessionDecisionAction::Skip,
                    target_path: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(resumed.phase, ArchiveSessionPhase::Streaming);
        let completed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("resumed archive extraction should terminate");
        assert_eq!(completed.phase, ArchiveSessionPhase::Completed);
        assert!(matches!(
            completed.result,
            Some(ArchiveSessionProgress::Extraction(progress)) if progress.members_skipped == 1
        ));
        let expected = expected_trace("extract_collision");
        assert_eq!(fs::read(destination.join("source.txt")).unwrap(), b"existing contents");
        assert_eq!(
            direct_local_trace(&manager, &session.execution_id, &completed, vec!["source.txt"], vec!["source.txt"]).await,
            expected
        );
    }

    #[tokio::test]
    async fn collision_rename_validates_its_target_and_extracts_without_overwriting() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, b"archive contents").unwrap();
        let archive_path = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &archive_path).unwrap();
        create_local_archive(directory.path(), &archive_path, &entries, || false).unwrap();
        let destination = directory.path().join("output");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("source.txt"), b"existing contents").unwrap();
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                directory.path().to_path_buf(),
                archive_path,
                destination.clone(),
            )
            .await;

        FixtureDirectLocalInvocation::new(manager.clone())
            .start(&session.execution_id)
            .await
            .unwrap();
        let paused = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase == ArchiveSessionPhase::AwaitingUserDecision {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("archive extraction session should pause for a collision");
        let pending = paused.pending_decision.expect("collision decision should remain live");
        assert!(FixtureDirectLocalInvocation::new(manager.clone())
            .decide(
                "c",
                "https://sambee.example",
                &session.execution_id,
                paused.revision,
                ArchiveSessionDecision {
                    source_session_id: pending.source_session_id.clone(),
                    delivery_sequence: pending.delivery_sequence,
                    decision_revision: pending.decision_revision,
                    member_path: "source.txt".to_string(),
                    action: ArchiveSessionDecisionAction::Rename,
                    target_path: Some("../outside.txt".to_string())
                },
            )
            .await
            .is_err());

        FixtureDirectLocalInvocation::new(manager.clone())
            .decide(
                "c",
                "https://sambee.example",
                &session.execution_id,
                paused.revision,
                ArchiveSessionDecision {
                    source_session_id: pending.source_session_id,
                    delivery_sequence: pending.delivery_sequence,
                    decision_revision: pending.decision_revision,
                    member_path: "source.txt".to_string(),
                    action: ArchiveSessionDecisionAction::Rename,
                    target_path: Some("renamed.txt".to_string()),
                },
            )
            .await
            .unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
                if status.phase.is_terminal() {
                    return status;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("renamed archive extraction should terminate");
        assert_eq!(completed.phase, ArchiveSessionPhase::Completed);
        assert_eq!(fs::read(destination.join("source.txt")).unwrap(), b"existing contents");
        assert_eq!(fs::read(destination.join("renamed.txt")).unwrap(), b"archive contents");
    }

    #[tokio::test]
    async fn cancellation_transitions_a_paused_session_to_terminal() {
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                PathBuf::from("/drive"),
                PathBuf::from("/drive/archive.zip"),
                PathBuf::from("/drive/output"),
            )
            .await;
        {
            let mut sessions = manager.sessions.lock().await;
            let state = sessions.get_mut(&session.execution_id).unwrap();
            state.phase = ArchiveSessionPhase::AwaitingUserDecision;
            state.revision = 2;
        }

        let cancelled = manager
            .cancel("c", "https://sambee.example", &session.execution_id, 2)
            .await
            .unwrap();
        assert_eq!(cancelled.phase, ArchiveSessionPhase::Cancelled);
        assert!(cancelled.cancellation_requested);
        assert_eq!(cancelled.revision, 3);
    }

    #[tokio::test]
    async fn expiry_terminalizes_a_paused_session_without_resuming_its_source() {
        let manager = Arc::new(ArchiveSessionManager::new());
        let session = manager
            .create_extraction(
                "c".to_string(),
                "https://sambee.example".to_string(),
                PathBuf::from("/drive"),
                PathBuf::from("/drive/archive.zip"),
                PathBuf::from("/drive/output"),
            )
            .await;
        {
            let mut sessions = manager.sessions.lock().await;
            let state = sessions.get_mut(&session.execution_id).unwrap();
            state.phase = ArchiveSessionPhase::AwaitingUserDecision;
            state.expires_at = Some(Instant::now() - Duration::from_secs(1));
        }

        assert!(manager.sessions.lock().await.contains_key(&session.execution_id));

        manager.expire_paused_extraction(&session.execution_id).await;

        let expired = manager.get("c", "https://sambee.example", &session.execution_id).await.unwrap();
        assert_eq!(expired.phase, ArchiveSessionPhase::Failed);
        assert!(expired.cancellation_requested);
    }
}
