//! Authenticated, bounded live search with response-owned cancellation.

use std::cell::{Cell, RefCell};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::Response;
use axum::Json;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::sync::{mpsc, oneshot};
use tokio_util::io::ReaderStream;

use super::archive::{local_directory_entry, EffectiveLocalArchiveProjection, LocalArchiveReader};
use super::directory_index::IndexError;
use super::directory_traversal::{NativeIo, NativeRoot, TraversalIssue};
use super::errors::ApiError;
use super::filesystem_search_admission::{SearchLease, SearchStopHandle};
use super::filesystem_search_archive::{read_search_projection, visit_archive_matches, ArchiveSearchError, ArchiveSearchMatch};
use super::filesystem_search_contract::{
    limits, ArchiveState, Counts, FolderDepth, Item, Policy, Record, Request, Root, SearchLimits, Skip, SkipReason, SourceKind, Target,
    TerminalReason, MAX_SAFE_JSON_INTEGER,
};
use super::filesystem_search_matching::NameMatcher;
use super::filesystem_search_physical::{search_physical, PhysicalSearchEvent, PhysicalSearchOptions};
use super::models::{FileInfo, FileType};
use super::{auth, drives, AppState};

const LOCAL_SOURCE_PREFIX: &str = "local-drive:";
const AUTH_CHECK_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(super) struct SearchState {
    pairing: Arc<super::pairing::PairingState>,
    policy: Arc<super::directory_policy::DirectoryPolicyState>,
    admission: super::filesystem_search_admission::SearchAdmission,
    #[cfg(all(test, target_os = "linux"))]
    io: Arc<NativeIo>,
}

impl axum::extract::FromRef<Arc<AppState>> for SearchState {
    fn from_ref(state: &Arc<AppState>) -> Self {
        Self {
            pairing: state.pairing.clone(),
            policy: state.directory_policy.clone(),
            admission: state.filesystem_search_admission.clone(),
            #[cfg(all(test, target_os = "linux"))]
            io: Arc::new(NativeIo::default()),
        }
    }
}

#[derive(Default)]
struct Progress {
    directories: AtomicU64,
    unreadable: AtomicU64,
    unsafe_names: AtomicU64,
    large_archives: AtomicU64,
    unreadable_archives: AtomicU64,
    queue_limit: AtomicU64,
}

impl Progress {
    fn terminal(&self, reason: TerminalReason, matches: u64) -> Record {
        let fields = [
            (SkipReason::UnreadableDirectory, &self.unreadable),
            (SkipReason::UnsafeName, &self.unsafe_names),
            (SkipReason::ArchiveTooLarge, &self.large_archives),
            (SkipReason::ArchiveUnreadable, &self.unreadable_archives),
            (SkipReason::QueueLimit, &self.queue_limit),
        ];
        let skips: Vec<_> = fields
            .into_iter()
            .filter_map(|(reason, count)| {
                let count = count.load(Ordering::Relaxed);
                (count != 0).then_some(Skip { reason, count })
            })
            .collect();
        let skipped = skips.iter().map(|skip| skip.count).sum();
        Record::Terminal {
            reason,
            counts: Counts {
                matches,
                scanned_directories: self.directories.load(Ordering::Relaxed),
                skipped,
            },
            skips,
        }
    }

    fn issue(&self, issue: TraversalIssue) {
        match issue {
            TraversalIssue::UnsupportedEncoding
            | TraversalIssue::UnsupportedDirectoryName(_)
            | TraversalIssue::UnsafeTraversal
            | TraversalIssue::UnsafeDirectory(_) => &self.unsafe_names,
            _ => &self.unreadable,
        }
        .fetch_add(1, Ordering::Relaxed);
    }

    fn has_skips(&self) -> bool {
        self.unreadable.load(Ordering::Relaxed)
            + self.unsafe_names.load(Ordering::Relaxed)
            + self.large_archives.load(Ordering::Relaxed)
            + self.unreadable_archives.load(Ordering::Relaxed)
            + self.queue_limit.load(Ordering::Relaxed)
            > 0
    }
}

struct StopGuard {
    cancelled: Arc<AtomicBool>,
    stop: SearchStopHandle,
}

impl Drop for StopGuard {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Err(error) = self.stop.stopping() {
            log::error!("Could not mark a file search as stopping: {error}");
        }
    }
}

struct RecordReader {
    receiver: mpsc::Receiver<Vec<u8>>,
    current: Vec<u8>,
    position: usize,
    _guard: StopGuard,
}

impl AsyncRead for RecordReader {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.position == self.current.len() {
            match self.receiver.poll_recv(cx) {
                Poll::Ready(Some(bytes)) => {
                    self.current = bytes;
                    self.position = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
        let length = buf.remaining().min(self.current.len() - self.position);
        buf.put_slice(&self.current[self.position..self.position + length]);
        self.position += length;
        Poll::Ready(Ok(()))
    }
}

enum WorkerMessage {
    Item(Item),
    Finished(TerminalReason),
}

#[derive(Clone)]
struct SearchContext {
    policy: Policy,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    progress: Arc<Progress>,
    pairing: Arc<super::pairing::PairingState>,
    origin: String,
}

fn check(cancelled: &AtomicBool, deadline: Instant, emitted: &Cell<u64>, policy: Policy) -> Result<(), IndexError> {
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline || emitted.get() >= policy.max_results {
        Err(IndexError::Interrupted)
    } else {
        Ok(())
    }
}

fn entry(path: String, directory: bool, size: Option<u64>, modified_at: Option<chrono::DateTime<chrono::Utc>>, readable: bool) -> FileInfo {
    let name = path.rsplit('/').next().unwrap_or_default().to_owned();
    FileInfo {
        is_hidden: name.starts_with('.'),
        mime_type: (!directory)
            .then(|| mime_guess::from_path(&name).first().map(|mime| mime.to_string()))
            .flatten(),
        name,
        path,
        file_type: if directory { FileType::Directory } else { FileType::File },
        size: size.filter(|value| *value <= MAX_SAFE_JSON_INTEGER),
        created_at: None,
        modified_at,
        is_readable: readable,
        link_kind: None,
    }
}

fn archive_item(archive_path: &str, found: ArchiveSearchMatch<'_>) -> Item {
    let state = if found.is_directory {
        ArchiveState::Readable
    } else if found.entry.is_some_and(|value| value.encrypted) {
        ArchiveState::Blocked
    } else if found.entry.is_some_and(|value| local_directory_entry(value).is_available) {
        ArchiveState::Readable
    } else {
        ArchiveState::Unavailable
    };
    let readable = matches!(state, ArchiveState::Readable);
    Item {
        entry: entry(
            found.path.to_owned(),
            found.is_directory,
            found.entry.filter(|_| !found.is_directory).map(|value| value.uncompressed_size),
            found.entry.and_then(|value| value.modified_at),
            readable,
        ),
        target: Target::Archive {
            archive_path: archive_path.to_owned(),
            member_path: found.path.to_owned(),
        },
        archive_state: Some(state),
    }
}

fn open_archive(source: &NativeRoot, path: &str) -> Result<LocalArchiveReader, IndexError> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let file = source.open_parent_for_scan(parent)?.open_search_file(name)?;
    LocalArchiveReader::from_pinned_file(file).map_err(|error| {
        log::debug!("Search could not open a ZIP: {error}");
        IndexError::SourceItem("archive_unreadable")
    })
}

fn project_archive(
    source: &NativeRoot,
    path: &str,
    check: impl FnMut() -> Result<(), IndexError>,
) -> Result<EffectiveLocalArchiveProjection, ArchiveSearchError<IndexError>> {
    let mut reader = open_archive(source, path).map_err(ArchiveSearchError::Worker)?;
    read_search_projection(&mut reader, check)
}

fn emit(sender: &mpsc::Sender<WorkerMessage>, item: Item, emitted: &Cell<u64>) -> Result<(), IndexError> {
    if item.validate().is_err() {
        return Err(IndexError::Invalid("Search produced an invalid result."));
    }
    sender
        .blocking_send(WorkerMessage::Item(item))
        .map_err(|_| IndexError::Interrupted)?;
    emitted.set(emitted.get() + 1);
    Ok(())
}

fn worker(
    base: std::path::PathBuf,
    request: Request,
    sender: mpsc::Sender<WorkerMessage>,
    ready: oneshot::Sender<Result<(), &'static str>>,
    _lease: SearchLease,
    io: Arc<NativeIo>,
    context: SearchContext,
) {
    let SearchContext {
        policy,
        deadline,
        cancelled,
        progress,
        pairing,
        origin,
    } = context;
    let emitted = Cell::new(0);
    let check = || {
        if !pairing.is_origin_paired(&origin) {
            return Err(IndexError::Interrupted);
        }
        check(&cancelled, deadline, &emitted, policy)
    };
    if check().is_err() {
        let _ = ready.send(Err("The search authorization ended. Pair the site and try again."));
        return;
    }
    let source = match NativeRoot::open_with_io(&base, io) {
        Ok(source) => source,
        Err(error) => {
            log::debug!("Search source could not be opened: {error}");
            let _ = ready.send(Err("The search source cannot be read safely. Check the drive and try again."));
            return;
        }
    };
    let matcher = match NameMatcher::new(&request.query, request.case_sensitive) {
        Ok(matcher) => matcher,
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    };
    let projection = match &request.root {
        Root::Directory { path } => {
            if source.open_parent_for_scan(path).is_err() {
                let _ = ready.send(Err("The search folder cannot be read safely. Check the folder and try again."));
                return;
            }
            None
        }
        Root::Archive { path, member_path } => match project_archive(&source, path, check) {
            Ok(projection) if member_path.is_empty() || projection.directories().contains(member_path) => Some(projection),
            Ok(_) => {
                let _ = ready.send(Err("The search folder is not in this archive. Select a folder and try again."));
                return;
            }
            Err(ArchiveSearchError::TooLarge) => {
                let _ = ready.send(Err("The ZIP has too much metadata to search. Browse it or select a smaller ZIP."));
                return;
            }
            Err(_) => {
                let message = if Instant::now() >= deadline {
                    "The search time limit was reached while opening the source. Try again."
                } else if !pairing.is_origin_paired(&origin) {
                    "The search authorization ended. Pair the site and try again."
                } else {
                    "The search archive cannot be read safely. Check the ZIP and try again."
                };
                let _ = ready.send(Err(message));
                return;
            }
        },
    };
    if check().is_err() {
        let _ = ready.send(Err("The search time limit was reached while opening the source. Try again."));
        return;
    }
    if ready.send(Ok(())).is_err() {
        return;
    }
    let result = match &request.root {
        Root::Archive { path, member_path } => visit_archive_matches(
            projection.as_ref().expect("Archive projection is ready"),
            member_path,
            request.folder_depth,
            request.item_type,
            &matcher,
            check,
            |found| emit(&sender, archive_item(path, found), &emitted),
        )
        .map_err(|_| IndexError::Interrupted),
        Root::Directory { path } => {
            let options = PhysicalSearchOptions {
                root: path,
                folder_depth: request.folder_depth,
                item_type: request.item_type,
                search_archives: request.search_archives,
                matcher: &matcher,
            };
            let callback = RefCell::new(|event| -> Result<(), IndexError> {
                match event {
                    PhysicalSearchEvent::Directory { path } => {
                        let info = entry(path.clone(), true, None, None, true);
                        emit(
                            &sender,
                            Item {
                                entry: info,
                                target: Target::Physical { path },
                                archive_state: None,
                            },
                            &emitted,
                        )?;
                    }
                    PhysicalSearchEvent::File { path, metadata } => {
                        let time = chrono::DateTime::from_timestamp(metadata.modified_seconds, metadata.modified_nanoseconds);
                        let info = entry(path.clone(), false, Some(metadata.size), time, true);
                        emit(
                            &sender,
                            Item {
                                entry: info,
                                target: Target::Physical { path },
                                archive_state: None,
                            },
                            &emitted,
                        )?;
                    }
                    PhysicalSearchEvent::Archive { path, file } => {
                        check()?;
                        let projection = match file {
                            Ok(file) => match LocalArchiveReader::from_pinned_file(file) {
                                Ok(mut reader) => read_search_projection(&mut reader, check),
                                Err(error) => Err(ArchiveSearchError::Archive(error)),
                            },
                            Err(error) => Err(ArchiveSearchError::Worker(error)),
                        };
                        match projection {
                            Ok(projection) => {
                                visit_archive_matches(
                                    &projection,
                                    "",
                                    FolderDepth::Recursive,
                                    request.item_type,
                                    &matcher,
                                    check,
                                    |found| emit(&sender, archive_item(&path, found), &emitted),
                                )
                                .map_err(|_| IndexError::Interrupted)?;
                            }
                            Err(ArchiveSearchError::TooLarge) => {
                                progress.large_archives.fetch_add(1, Ordering::Relaxed);
                            }
                            Err(ArchiveSearchError::Worker(IndexError::Interrupted)) => return Err(IndexError::Interrupted),
                            Err(_) => {
                                progress.unreadable_archives.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    PhysicalSearchEvent::Issue(issue) => progress.issue(issue),
                    PhysicalSearchEvent::ScannedDirectory => {
                        progress.directories.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Ok(())
            });
            search_physical(&source, &options, check, |event| (callback.borrow_mut())(event)).map(|summary| {
                if summary.queue_limit_reached {
                    progress.queue_limit.fetch_add(1, Ordering::Relaxed);
                }
            })
        }
    };
    let reason = if emitted.get() >= policy.max_results {
        TerminalReason::ResultLimit
    } else if Instant::now() >= deadline {
        TerminalReason::TimeLimit
    } else if result.is_err() {
        TerminalReason::SourceFailure
    } else if progress.has_skips() {
        TerminalReason::PartialCoverage
    } else {
        TerminalReason::Complete
    };
    let _ = sender.blocking_send(WorkerMessage::Finished(reason));
}

fn encode(record: &Record) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec(record)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Start one search on a paired origin and authorized local drive.
pub(super) async fn start(
    State(state): State<SearchState>,
    Path(drive): Path<String>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> Result<Response, ApiError> {
    request.validate().map_err(|message| ApiError::BadRequest(message.to_owned()))?;
    if !matches!(request.source.kind, SourceKind::Local) || request.source.id != format!("{LOCAL_SOURCE_PREFIX}{drive}") {
        return Err(ApiError::BadRequest(
            "The search source does not match the selected drive. Select the drive and try again.".into(),
        ));
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(auth::normalize_browser_origin)
        .ok_or_else(|| ApiError::Forbidden("A paired site is required. Pair the site and try again.".into()))?;
    let base = drives::resolve_drive_path(&drive)
        .ok_or_else(|| ApiError::NotFound("The drive is unavailable. Reconnect it and try again.".into()))?;
    let base = tokio::fs::canonicalize(base)
        .await
        .map_err(|_| ApiError::NotFound("The drive is unavailable. Reconnect it and try again.".into()))?;
    let policy = state.policy.filesystem_search_policy()?;
    let deadline = Instant::now() + Duration::from_secs(policy.max_seconds);
    let lease = state
        .admission
        .admit(&origin, &drive, policy.concurrent_searches)
        .map_err(|error| ApiError::TooManyRequests(error.to_string()))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = StopGuard {
        cancelled: cancelled.clone(),
        stop: lease.stop_handle(),
    };
    let progress = Arc::new(Progress::default());
    let (sender, receiver) = mpsc::channel(1);
    let (ready_sender, ready_receiver) = oneshot::channel();
    let context = SearchContext {
        policy,
        deadline,
        cancelled,
        progress,
        pairing: state.pairing.clone(),
        origin,
    };
    let worker_context = context.clone();
    #[cfg(all(test, target_os = "linux"))]
    let worker_io = state.io.clone();
    #[cfg(not(all(test, target_os = "linux")))]
    let worker_io = Arc::new(NativeIo::default());
    tokio::task::spawn_blocking(move || worker(base, request, sender, ready_sender, lease, worker_io, worker_context));
    match tokio::time::timeout_at(deadline.into(), ready_receiver).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(message))) => return Err(ApiError::BadRequest(message.to_owned())),
        Ok(Err(_)) => {
            return Err(ApiError::Internal(
                "The search worker stopped. Restart Companion and try again.".into(),
            ))
        }
        Err(_) => {
            return Err(ApiError::BadRequest(
                "The search time limit was reached while opening the source. Try again.".into(),
            ))
        }
    }
    let reader = stream_records(receiver, guard, context);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(ReaderStream::new(reader)))
        .map_err(|_| ApiError::Internal("The search response could not be created. Try again.".into()))
}

fn stream_records(mut receiver: mpsc::Receiver<WorkerMessage>, guard: StopGuard, context: SearchContext) -> RecordReader {
    let SearchContext {
        policy,
        deadline,
        cancelled,
        progress,
        pairing,
        origin,
    } = context;
    let (output, output_receiver) = mpsc::channel(limits().queued_batches.saturating_sub(1).max(1));
    let stop = guard.stop.clone();
    let reader = RecordReader {
        receiver: output_receiver,
        current: Vec::new(),
        position: 0,
        _guard: guard,
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    tokio::spawn(async move {
        let start = Record::Start {
            version: 1,
            request_id,
            limits: SearchLimits {
                max_seconds: policy.max_seconds,
                max_results: policy.max_results,
            },
        };
        let Ok(start) = encode(&start) else { return };
        if output.send(start).await.is_err() {
            return;
        }
        let mut delivered = 0;
        let mut interval = tokio::time::interval(AUTH_CHECK_INTERVAL);
        let reason = 'stream: loop {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline.into()) => break TerminalReason::TimeLimit,
                _ = interval.tick() => {
                    if cancelled.load(Ordering::Acquire) {
                        return;
                    }
                    if !pairing.is_origin_paired(&origin) {
                        break TerminalReason::SourceFailure;
                    }
                }
                message = receiver.recv() => match message {
                    Some(WorkerMessage::Item(item)) => {
                        if !pairing.is_origin_paired(&origin) {
                            break TerminalReason::SourceFailure;
                        }
                        let Ok(bytes) = encode(&Record::Batch { results: vec![item] }) else { break TerminalReason::SourceFailure };
                        if bytes.len() > limits().stream_record_bytes { break TerminalReason::SourceFailure; }
                        loop {
                            tokio::select! {
                                biased;
                                _ = tokio::time::sleep_until(deadline.into()) => break 'stream TerminalReason::TimeLimit,
                                _ = interval.tick() => {
                                    if cancelled.load(Ordering::Acquire) { return; }
                                    if !pairing.is_origin_paired(&origin) {
                                        break 'stream TerminalReason::SourceFailure;
                                    }
                                },
                                permit = output.reserve() => match permit {
                                    Ok(permit) => {
                                        if !pairing.is_origin_paired(&origin) {
                                            break 'stream TerminalReason::SourceFailure;
                                        }
                                        permit.send(bytes);
                                        break;
                                    }
                                    Err(_) => return,
                                },
                            }
                        }
                        delivered += 1;
                    }
                    Some(WorkerMessage::Finished(reason)) => break reason,
                    None => break TerminalReason::SourceFailure,
                }
            }
        };
        cancelled.store(true, Ordering::Release);
        if let Err(error) = stop.stopping() {
            log::error!("Could not mark a file search as stopping: {error}");
        }
        receiver.close();
        if let Ok(terminal) = encode(&progress.terminal(reason, delivered)) {
            let _ = output.send(terminal).await;
        }
    });
    reader
}

#[cfg(all(test, target_os = "linux"))]
pub(super) async fn search_for_index_isolation_test(base: &std::path::Path) -> Vec<String> {
    let (items, reason, _) = tests::run(
        base,
        tests::request(serde_json::json!({"kind": "directory", "path": ""}), "recursive", "*.txt", false),
        super::filesystem_search_contract::default_policy(),
    )
    .await;
    assert!(matches!(reason, TerminalReason::Complete));
    let mut paths: Vec<_> = items.into_iter().map(|item| item.entry.path).collect();
    paths.sort_unstable();
    paths
}

#[cfg(all(test, target_os = "linux"))]
pub(super) async fn cancel_search_for_index_isolation_test(base: &std::path::Path) {
    use tokio::io::AsyncBufReadExt;

    let admission = super::filesystem_search_admission::SearchAdmission::default();
    let lease = admission.admit("https://site", "drive", 1).unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let guard = StopGuard {
        cancelled: cancelled.clone(),
        stop: lease.stop_handle(),
    };
    let pairing = Arc::new(super::pairing::PairingState::new());
    pairing.set_test_authority(Some("https://site"));
    let policy = super::filesystem_search_contract::default_policy();
    let deadline = Instant::now() + Duration::from_secs(policy.max_seconds);
    let progress = Arc::new(Progress::default());
    let (sender, receiver) = mpsc::channel(1);
    let (ready, ready_rx) = oneshot::channel();
    let io = Arc::new(NativeIo::default());
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (resume_tx, resume_rx) = std::sync::mpsc::channel();
    *io.search_read_gate.lock().unwrap() = Some(super::directory_traversal::SearchReadGate {
        relative: "child".to_owned(),
        entered: entered_tx,
        resume: resume_rx,
    });
    let base = base.to_owned();
    let context = SearchContext {
        policy,
        deadline,
        cancelled: cancelled.clone(),
        progress,
        pairing,
        origin: "https://site".to_owned(),
    };
    let worker_context = context.clone();
    let task = tokio::task::spawn_blocking(move || {
        worker(
            base,
            tests::request(serde_json::json!({"kind": "directory", "path": ""}), "recursive", "*.txt", false),
            sender,
            ready,
            lease,
            io,
            worker_context,
        )
    });
    ready_rx.await.unwrap().unwrap();
    let mut reader = tokio::io::BufReader::new(stream_records(receiver, guard, context));
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(3)).unwrap())
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(3), async {
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(serde_json::from_str::<Record>(&line).unwrap(), Record::Start { .. }));
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(serde_json::from_str::<Record>(&line).unwrap(), Record::Batch { .. }));
    })
    .await
    .unwrap();
    drop(reader);
    assert!(cancelled.load(Ordering::Acquire));
    assert!(matches!(
        admission.admit("https://site", "drive", 1),
        Err(super::filesystem_search_admission::AdmissionError::Stopping)
    ));
    resume_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), task).await.unwrap().unwrap();
    assert!(admission.admit("https://site", "drive", 1).is_ok());
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    pub(super) fn request(root: serde_json::Value, depth: &str, query: &str, archives: bool) -> Request {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "source": {"kind": "local", "id": "local-drive:test"},
            "root": root,
            "query": query,
            "case_sensitive": false,
            "folder_depth": depth,
            "item_type": "files",
            "search_archives": archives
        }))
        .unwrap()
    }

    fn zip(path: &std::path::Path) {
        let mut writer = ZipWriter::new(File::create(path).unwrap());
        for path in ["top.txt", "folder/nested.txt"] {
            writer.start_file(path, SimpleFileOptions::default()).unwrap();
            writer.write_all(b"data").unwrap();
        }
        writer.finish().unwrap();
    }

    pub(super) async fn run(base: &std::path::Path, request: Request, policy: Policy) -> (Vec<Item>, TerminalReason, Arc<Progress>) {
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let (sender, mut receiver) = mpsc::channel(1);
        let (ready, ready_rx) = oneshot::channel();
        let progress = Arc::new(Progress::default());
        let base = base.to_owned();
        let pairing = Arc::new(super::super::pairing::PairingState::new());
        pairing.set_test_authority(Some("https://site"));
        let context = SearchContext {
            policy,
            deadline: Instant::now() + Duration::from_secs(policy.max_seconds),
            cancelled: Arc::new(AtomicBool::new(false)),
            progress: progress.clone(),
            pairing,
            origin: "https://site".to_owned(),
        };
        let task = tokio::task::spawn_blocking(move || worker(base, request, sender, ready, lease, Arc::new(NativeIo::default()), context));
        ready_rx.await.unwrap().unwrap();
        let mut items = Vec::new();
        let reason = loop {
            match receiver.recv().await.unwrap() {
                WorkerMessage::Item(item) => items.push(item),
                WorkerMessage::Finished(reason) => break reason,
            }
        };
        task.await.unwrap();
        (items, reason, progress)
    }

    #[tokio::test]
    async fn paired_http_search_streams_and_disconnect_releases_slot_after_cleanup() {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        use std::time::{SystemTime, UNIX_EPOCH};

        const ORIGIN: &str = "https://search-test.example";
        const WAIT: Duration = Duration::from_secs(3);

        let directory = tempfile::tempdir_in(".").unwrap();
        let root = directory.path().join("drive");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("child")).unwrap();
        fs::write(root.join("first.txt"), b"first").unwrap();
        fs::write(root.join("child/second.txt"), b"second").unwrap();
        let drive = format!("search-http-{}", uuid::Uuid::new_v4());
        super::super::drives::register_test_drive_path(drive.clone(), root);

        let pairing = Arc::new(super::super::pairing::PairingState::new_with_memory_keychain());
        let (id, _, _) = pairing.initiate(&"ab".repeat(32), ORIGIN).unwrap();
        pairing.companion_confirm(&id).unwrap();
        let secret = pairing.confirm(&id, ORIGIN).unwrap();
        let manager = super::super::directory_manager::LocalDirectoryManager::new(directory.path().join("cache")).unwrap();
        let policy = super::super::directory_policy::DirectoryPolicyState::open(directory.path().join("policy"), &manager).unwrap();
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let io = Arc::new(NativeIo::default());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        *io.search_read_gate.lock().unwrap() = Some(super::super::directory_traversal::SearchReadGate {
            relative: "child".to_owned(),
            entered: entered_tx,
            resume: resume_rx,
        });
        let state = SearchState {
            pairing: pairing.clone(),
            policy,
            admission,
            io,
        };
        let router = super::super::filesystem_search_routes()
            .layer(axum::middleware::from_fn_with_state(pairing, auth::require_auth))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().http1_only().build().unwrap();
        let path = format!("/api/browse/{drive}/filesystem-search");
        let url = format!("http://{address}{path}");
        let body = serde_json::json!({
            "version": 1,
            "source": {"kind": "local", "id": format!("local-drive:{drive}")},
            "root": {"kind": "directory", "path": ""},
            "query": "*.txt", "case_sensitive": false, "folder_depth": "recursive",
            "item_type": "files", "search_archives": false
        });
        let send = |valid: bool| {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs().to_string();
            let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
            mac.update(format!("{ORIGIN}\n{timestamp}\nPOST\n{path}").as_bytes());
            let signature = if valid {
                hex::encode(mac.finalize().into_bytes())
            } else {
                "invalid".to_owned()
            };
            client
                .post(&url)
                .header("origin", ORIGIN)
                .header("x-companion-timestamp", timestamp)
                .header("x-companion-secret", signature)
                .json(&body)
                .send()
        };
        assert_eq!(send(false).await.unwrap().status(), reqwest::StatusCode::FORBIDDEN);
        let mut response = send(true).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "application/x-ndjson");
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(WAIT).unwrap())
            .await
            .unwrap();
        let mut received = Vec::new();
        let records = tokio::time::timeout(WAIT, async {
            loop {
                received.extend_from_slice(&response.chunk().await.unwrap().expect("stream ended before its first result"));
                let lines: Vec<_> = received.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()).collect();
                if lines.len() >= 2 && received.ends_with(b"\n") {
                    break lines
                        .iter()
                        .map(|line| serde_json::from_slice::<Record>(line).unwrap())
                        .collect::<Vec<_>>();
                }
            }
        })
        .await
        .expect("search did not stream a result before the next directory scan");
        assert!(matches!(records.first(), Some(Record::Start { .. })));
        assert!(matches!(&records[1], Record::Batch { results } if results.len() == 1 && results[0].entry.path == "first.txt"));
        let running = send(true).await.unwrap();
        assert_eq!(running.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
        assert!(running.text().await.unwrap().contains("already running"));

        drop(response);
        tokio::time::timeout(WAIT, async {
            loop {
                let response = send(true).await.unwrap();
                assert_eq!(response.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
                if response.text().await.unwrap().contains("still stopping") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("server did not detect the client disconnect");
        resume_tx.send(()).unwrap();
        let response = tokio::time::timeout(WAIT, async {
            loop {
                let response = send(true).await.unwrap();
                if response.status() == reqwest::StatusCode::OK {
                    break response;
                }
                assert_eq!(response.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("worker did not release its search slot");
        let body = response.text().await.unwrap();
        let records: Vec<Record> = body.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert!(matches!(
            records.last(),
            Some(Record::Terminal {
                reason: TerminalReason::Complete,
                counts: Counts { matches: 2, .. },
                ..
            })
        ));
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn discovered_archives_are_recursive_but_archive_root_uses_requested_depth() {
        let directory = tempfile::tempdir().unwrap();
        zip(&directory.path().join("archive.zip"));
        let policy = super::super::filesystem_search_contract::default_policy();
        let (items, reason, _) = run(
            directory.path(),
            request(serde_json::json!({"kind":"directory","path":""}), "current", "*.txt", true),
            policy,
        )
        .await;
        assert!(matches!(reason, TerminalReason::Complete));
        let mut paths: Vec<_> = items.iter().map(|item| item.entry.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["folder/nested.txt", "top.txt"]);
        assert!(items.iter().all(|item| matches!(item.target, Target::Archive { .. })));

        let (items, reason, _) = run(
            directory.path(),
            request(
                serde_json::json!({"kind":"archive","path":"archive.zip","member_path":""}),
                "current",
                "*.txt",
                false,
            ),
            policy,
        )
        .await;
        assert!(matches!(reason, TerminalReason::Complete));
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].entry.path, "top.txt");
    }

    #[tokio::test]
    async fn exact_result_limit_and_unreadable_archives_are_reported() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("one.txt"), b"x").unwrap();
        fs::write(directory.path().join("two.txt"), b"x").unwrap();
        fs::write(directory.path().join("broken.zip"), b"x").unwrap();
        let mut policy = super::super::filesystem_search_contract::default_policy();
        policy.max_results = 1;
        let (items, reason, _) = run(
            directory.path(),
            request(serde_json::json!({"kind":"directory","path":""}), "current", "*.txt", false),
            policy,
        )
        .await;
        assert_eq!(items.len(), 1);
        assert!(matches!(reason, TerminalReason::ResultLimit));
        policy.max_results = 500;
        let (items, reason, progress) = run(
            directory.path(),
            request(serde_json::json!({"kind":"directory","path":""}), "current", "*.txt", true),
            policy,
        )
        .await;
        assert_eq!(items.len(), 2);
        assert!(matches!(reason, TerminalReason::PartialCoverage));
        assert_eq!(progress.unreadable_archives.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn hidden_files_and_hidden_ancestors_follow_browse() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir(directory.path().join(".hidden")).unwrap();
        fs::write(directory.path().join(".hidden/visible.txt"), b"x").unwrap();
        fs::write(directory.path().join(".hidden/.secret.txt"), b"x").unwrap();
        let (items, reason, _) = run(
            directory.path(),
            request(serde_json::json!({"kind":"directory","path":""}), "recursive", "*.txt", false),
            super::super::filesystem_search_contract::default_policy(),
        )
        .await;
        assert!(matches!(reason, TerminalReason::Complete));
        assert_eq!(items.len(), 2);
        for item in items {
            assert_eq!(item.entry.is_hidden, item.entry.name.starts_with('.'));
        }
    }

    #[tokio::test]
    async fn missing_root_returns_an_error_before_any_result() {
        let directory = tempfile::tempdir().unwrap();
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let (sender, mut receiver) = mpsc::channel(1);
        let (ready, ready_rx) = oneshot::channel();
        let pairing = Arc::new(super::super::pairing::PairingState::new());
        pairing.set_test_authority(Some("https://site"));
        let base = directory.path().to_owned();
        let context = SearchContext {
            policy: super::super::filesystem_search_contract::default_policy(),
            deadline: Instant::now() + Duration::from_secs(2),
            cancelled: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Progress::default()),
            pairing,
            origin: "https://site".to_owned(),
        };
        let task = tokio::task::spawn_blocking(move || {
            worker(
                base,
                request(serde_json::json!({"kind":"directory","path":"missing"}), "recursive", "*", false),
                sender,
                ready,
                lease,
                Arc::new(NativeIo::default()),
                context,
            )
        });
        assert!(ready_rx.await.unwrap().is_err());
        assert!(receiver.recv().await.is_none());
        task.await.unwrap();
        assert!(admission.admit("https://site", "drive", 1).is_ok());
    }

    #[tokio::test]
    async fn deadline_streams_terminal_before_worker_cleanup() {
        use tokio::io::AsyncBufReadExt;
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = StopGuard {
            cancelled: cancelled.clone(),
            stop: lease.stop_handle(),
        };
        let (sender, receiver) = mpsc::channel(1);
        let pairing = Arc::new(super::super::pairing::PairingState::new());
        pairing.set_test_authority(Some("https://site"));
        let reader = stream_records(
            receiver,
            guard,
            SearchContext {
                policy: super::super::filesystem_search_contract::default_policy(),
                deadline: Instant::now() + Duration::from_millis(100),
                cancelled: cancelled.clone(),
                progress: Arc::new(Progress::default()),
                pairing,
                origin: "https://site".to_owned(),
            },
        );
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(serde_json::from_str::<Record>(&line).unwrap(), Record::Start { .. }));
        sender
            .send(WorkerMessage::Item(Item {
                entry: entry("file.txt".into(), false, Some(1), None, true),
                target: Target::Physical { path: "file.txt".into() },
                archive_state: None,
            }))
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(serde_json::from_str::<Record>(&line).unwrap(), Record::Batch { .. }));
        line.clear();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            serde_json::from_str::<Record>(&line).unwrap(),
            Record::Terminal {
                reason: TerminalReason::TimeLimit,
                counts: Counts { matches: 1, .. },
                ..
            }
        ));
        assert!(cancelled.load(Ordering::Acquire));
        assert!(matches!(
            admission.admit("https://site", "drive", 1),
            Err(super::super::filesystem_search_admission::AdmissionError::Stopping)
        ));
        drop(lease);
        assert!(admission.admit("https://site", "drive", 1).is_ok());
    }

    #[tokio::test]
    async fn revoked_pairing_stops_before_queued_results_are_streamed() {
        use tokio::io::AsyncBufReadExt;
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = StopGuard {
            cancelled: cancelled.clone(),
            stop: lease.stop_handle(),
        };
        let (sender, receiver) = mpsc::channel(1);
        sender
            .send(WorkerMessage::Item(Item {
                entry: entry("private.txt".into(), false, Some(1), None, true),
                target: Target::Physical {
                    path: "private.txt".into(),
                },
                archive_state: None,
            }))
            .await
            .unwrap();
        let reader = stream_records(
            receiver,
            guard,
            SearchContext {
                policy: super::super::filesystem_search_contract::default_policy(),
                deadline: Instant::now() + Duration::from_secs(2),
                cancelled: cancelled.clone(),
                progress: Arc::new(Progress::default()),
                pairing: Arc::new(super::super::pairing::PairingState::new()),
                origin: "https://site".to_owned(),
            },
        );
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(serde_json::from_str::<Record>(&line).unwrap(), Record::Start { .. }));
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<Record>(&line).unwrap(),
            Record::Terminal {
                reason: TerminalReason::SourceFailure,
                counts: Counts { matches: 0, .. },
                ..
            }
        ));
        assert!(cancelled.load(Ordering::Acquire));
        drop(lease);
    }

    #[test]
    fn archive_state_matches_browse_capabilities() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("archive.zip");
        zip(&path);
        let mut reader = LocalArchiveReader::open_pinned(&path).unwrap();
        let mut member = reader.next_entry().unwrap().unwrap();
        for (encrypted, method, expected) in [
            (false, 0, "readable"),
            (false, 8, "readable"),
            (false, 12, "readable"),
            (false, 99, "unavailable"),
            (true, 0, "blocked"),
        ] {
            member.encrypted = encrypted;
            member.compression_method = method;
            let item = archive_item(
                "archive.zip",
                ArchiveSearchMatch {
                    path: &member.path,
                    is_directory: false,
                    entry: Some(&member),
                },
            );
            assert_eq!(serde_json::to_value(item.archive_state).unwrap(), expected);
        }
    }

    #[test]
    fn oversized_file_metadata_does_not_break_the_javascript_wire_contract() {
        assert_eq!(
            entry("large".into(), false, Some(MAX_SAFE_JSON_INTEGER), None, true).size,
            Some(MAX_SAFE_JSON_INTEGER)
        );
        assert_eq!(entry("large".into(), false, Some(MAX_SAFE_JSON_INTEGER + 1), None, true).size, None);
    }

    #[test]
    fn archive_open_rejects_replaced_symlink_and_fifo() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        zip(&outside.path().join("archive.zip"));
        symlink(outside.path().join("archive.zip"), directory.path().join("archive.zip")).unwrap();
        let source = NativeRoot::open(directory.path()).unwrap();
        assert!(open_archive(&source, "archive.zip").is_err());
        let fifo = directory.path().join("fifo.zip");
        let fifo_name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        assert!(open_archive(&source, "fifo.zip").is_err());
    }

    #[tokio::test]
    async fn disconnect_marks_stopping_until_worker_releases_lease() {
        let admission = super::super::filesystem_search_admission::SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = StopGuard {
            cancelled: cancelled.clone(),
            stop: lease.stop_handle(),
        };
        let (_sender, receiver) = mpsc::channel(1);
        let reader = RecordReader {
            receiver,
            current: Vec::new(),
            position: 0,
            _guard: guard,
        };
        drop(reader);
        assert!(cancelled.load(Ordering::Acquire));
        assert!(matches!(
            admission.admit("https://site", "drive", 1),
            Err(super::super::filesystem_search_admission::AdmissionError::Stopping)
        ));
        drop(lease);
        assert!(admission.admit("https://site", "drive", 1).is_ok());
    }
}
