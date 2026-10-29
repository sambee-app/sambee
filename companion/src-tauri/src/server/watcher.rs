//! Filesystem watcher for real-time directory change notifications.
//!
//! Uses the `notify` crate to watch directories that WebSocket clients have
//! subscribed to. Events are debounced per directory and broadcast to all
//! connected clients via a `tokio::sync::broadcast` channel.
//!
//! Subscriber counting ensures that watchers are started only when the first
//! client subscribes and stopped when the last client unsubscribes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use log::{info, warn};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{broadcast, mpsc, Mutex};

/// Debounce window — coalesce rapid filesystem events into a single notification.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(300);

/// Check for deleted targets even when the native watcher reports no event.
const TARGET_CHECK_INTERVAL: Duration = Duration::from_secs(1);

/// Maximum number of pending events in the broadcast channel.
const BROADCAST_CAPACITY: usize = 256;

#[cfg(test)]
mod tests {
    use super::DirectoryWatcher;

    const EVENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    #[tokio::test]
    async fn rejects_missing_and_wrong_type_targets_without_a_watcher() {
        let root = tempfile::tempdir().expect("temporary drive root");
        let watcher = DirectoryWatcher::new();
        let missing = watcher.subscribe("test", "missing", root.path()).await.expect_err("missing target");
        assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
        std::fs::write(root.path().join("file"), b"content").expect("write test file");
        let wrong_type = watcher
            .subscribe("test", "file", root.path())
            .await
            .expect_err("non-directory target");
        assert_eq!(wrong_type.kind(), std::io::ErrorKind::NotADirectory);
        assert!(watcher.entries.lock().await.is_empty());
    }

    #[tokio::test]
    async fn invalidates_and_retires_a_deleted_directory() {
        assert_deleted_directory_is_retired(false, false).await;
    }

    #[tokio::test]
    async fn invalidates_and_retires_a_deleted_directory_without_native_events() {
        assert_deleted_directory_is_retired(true, false).await;
    }

    #[tokio::test]
    async fn invalidates_and_retires_a_directory_replaced_by_a_file_without_native_events() {
        assert_deleted_directory_is_retired(true, true).await;
    }

    async fn assert_deleted_directory_is_retired(disable_native_events: bool, replace_with_file: bool) {
        use notify::Watcher;

        let root = tempfile::tempdir().expect("temporary drive root");
        let target = root.path().join("watched");
        std::fs::create_dir(&target).expect("create watched directory");
        let watcher = DirectoryWatcher::new();
        let mut events = watcher.subscribe_events();
        watcher.subscribe("test", "watched", root.path()).await.expect("subscribe");
        if disable_native_events {
            watcher
                .entries
                .lock()
                .await
                .get_mut("test:watched")
                .expect("watch entry")
                ._watcher
                .unwatch(&target.canonicalize().expect("canonical target"))
                .expect("disable native events");
        }
        std::fs::remove_dir(&target).expect("remove watched directory");
        if replace_with_file {
            std::fs::write(&target, b"replacement").expect("replace directory with file");
        }
        let event = tokio::time::timeout(EVENT_TIMEOUT, events.recv())
            .await
            .expect("deletion notification")
            .expect("event");
        assert_eq!(event.drive, "test");
        assert_eq!(event.path, "watched");
        assert!(watcher.entries.lock().await.is_empty());
        assert!(matches!(events.try_recv(), Err(tokio::sync::broadcast::error::TryRecvError::Empty)));
        watcher.unsubscribe("test", "watched").await;
        if replace_with_file {
            std::fs::remove_file(&target).expect("remove replacement file");
        }
        std::fs::create_dir(&target).expect("recreate watched directory");
        watcher.subscribe("test", "watched", root.path()).await.expect("subscribe again");
        assert_eq!(watcher.entries.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn dropping_manager_releases_watcher_state() {
        let root = tempfile::tempdir().expect("temporary drive root");
        let watcher = DirectoryWatcher::new();
        watcher.subscribe("test", "", root.path()).await.expect("subscribe");
        let entries = std::sync::Arc::downgrade(&watcher.entries);
        drop(watcher);
        assert!(entries.upgrade().is_none());
    }
}

/// A directory change notification sent to WebSocket clients.
#[derive(Clone, Debug)]
pub struct DirectoryChangeEvent {
    /// The drive identifier (e.g. `"c"`, `"root"`).
    pub drive: String,
    /// The relative directory path that changed.
    pub path: String,
}

/// Tracks a single watched directory.
struct WatchEntry {
    /// The filesystem watcher — dropped to stop watching.
    _watcher: RecommendedWatcher,
    /// Number of WebSocket clients subscribed to this directory.
    subscriber_count: usize,
    /// Abort handle for the debounce task (cancelled on drop).
    _debounce_handle: tokio::task::JoinHandle<()>,
}

impl Drop for WatchEntry {
    fn drop(&mut self) {
        self._debounce_handle.abort();
    }
}

/// Manages filesystem watchers with subscriber counting and debouncing.
///
/// Each unique `{drive}:{path}` gets one OS-level watcher, shared across
/// all WebSocket clients viewing that directory. When directory contents
/// change, the watcher sends a [`DirectoryChangeEvent`] through the
/// broadcast channel after a short debounce window.
pub struct DirectoryWatcher {
    /// Active watchers keyed by `"drive:path"`.
    entries: Arc<Mutex<HashMap<String, WatchEntry>>>,
    /// Broadcast sender — each WS handler subscribes its own receiver.
    event_tx: broadcast::Sender<DirectoryChangeEvent>,
}

impl DirectoryWatcher {
    /// Create a new watcher manager.
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            event_tx: tx,
        }
    }

    /// Get a new broadcast receiver for change events.
    ///
    /// Each WebSocket connection should call this once to receive
    /// notifications for all watched directories.
    pub fn subscribe_events(&self) -> broadcast::Receiver<DirectoryChangeEvent> {
        self.event_tx.subscribe()
    }

    /// Start watching a directory (or increment the subscriber count).
    ///
    /// - `drive` — drive identifier (e.g. `"c"`, `"root"`).
    /// - `path`  — relative directory path within the drive.
    /// - `root`  — absolute filesystem root of the drive.
    pub async fn subscribe(&self, drive: &str, path: &str, root: &Path) -> std::io::Result<()> {
        let key = format!("{drive}:{path}");
        let mut entries = self.entries.lock().await;

        // Increment count if already watching
        if let Some(entry) = entries.get_mut(&key) {
            entry.subscriber_count += 1;
            info!("Watcher: added subscriber for {key} (count: {})", entry.subscriber_count);
            return Ok(());
        }

        let canonical_root = root.canonicalize()?;

        // Resolve the filesystem path to watch
        let watch_path = if path.is_empty() {
            canonical_root.clone()
        } else {
            let joined = canonical_root.join(path);
            let canonical = joined.canonicalize()?;
            if !canonical.starts_with(&canonical_root) {
                return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
            }
            canonical
        };

        if !watch_path.is_dir() {
            return Err(std::io::Error::from(std::io::ErrorKind::NotADirectory));
        }

        // ── Debounce channel ──────────────────────────────────────────────
        // The notify callback fires on an OS thread. It pushes into an mpsc
        // channel; a tokio task drains it after the debounce window and then
        // broadcasts the aggregated event.
        let (debounce_tx, mut debounce_rx) = mpsc::channel::<()>(32);
        let broadcast_tx = self.event_tx.clone();
        let drive_owned = drive.to_string();
        let path_owned = path.to_string();
        let watched_path = watch_path.clone();
        let watched_entries = Arc::downgrade(&self.entries);
        let watched_key = key.clone();

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| match res {
            Ok(event) => match event.kind {
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                    let _ = debounce_tx.try_send(());
                }
                _ => {}
            },
            Err(e) => warn!("Watcher error: {e}"),
        })
        .map_err(std::io::Error::other)?;

        watcher
            .watch(&watch_path, RecursiveMode::NonRecursive)
            .map_err(|error| match error.kind {
                notify::ErrorKind::Io(error) => error,
                notify::ErrorKind::PathNotFound => std::io::Error::from(std::io::ErrorKind::NotFound),
                _ => std::io::Error::other(error),
            })?;

        let debounce_handle = tokio::spawn(async move {
            loop {
                let changed = match tokio::time::timeout(TARGET_CHECK_INTERVAL, debounce_rx.recv()).await {
                    Ok(Some(())) => {
                        tokio::time::sleep(DEBOUNCE_DURATION).await;
                        while debounce_rx.try_recv().is_ok() {}
                        true
                    }
                    Ok(None) => break,
                    Err(_) => false,
                };

                let retired = match watched_path.metadata() {
                    Ok(metadata) => !metadata.is_dir(),
                    Err(error) => matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory),
                };
                if retired {
                    if let Some(entries) = watched_entries.upgrade() {
                        entries.lock().await.remove(&watched_key);
                    }
                }

                if changed || retired {
                    let _ = broadcast_tx.send(DirectoryChangeEvent {
                        drive: drive_owned.clone(),
                        path: path_owned.clone(),
                    });
                }
                if retired {
                    break;
                }
            }
        });

        info!("Watcher: started watching {key} at {}", watch_path.display());

        entries.insert(
            key,
            WatchEntry {
                _watcher: watcher,
                subscriber_count: 1,
                _debounce_handle: debounce_handle,
            },
        );

        Ok(())
    }

    /// Decrement the subscriber count and stop watching when it reaches zero.
    pub async fn unsubscribe(&self, drive: &str, path: &str) {
        let key = format!("{drive}:{path}");
        let mut entries = self.entries.lock().await;

        if let Some(entry) = entries.get_mut(&key) {
            entry.subscriber_count -= 1;
            if entry.subscriber_count == 0 {
                // Dropping the entry stops the watcher (and its debounce task)
                entries.remove(&key);
                info!("Watcher: stopped watching {key} (last subscriber left)");
            } else {
                info!("Watcher: removed subscriber for {key} (count: {})", entry.subscriber_count);
            }
        }
    }
}
