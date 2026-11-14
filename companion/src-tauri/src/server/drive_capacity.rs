//! Bounded non-blocking capacity cache for Companion local drives.
//!
//! Queries filesystem metadata counters (`statvfs` on Unix, `GetDiskFreeSpaceExW`
//! on Windows) with at most two probes in flight per process. Both the owned
//! semaphore permit and the per-drive in-flight guard move into the
//! `tokio::task::spawn_blocking` closure so a wedged mount holds its slot until
//! the OS thread exits and never spawns duplicate blocking threads.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::drives::{self, FilesystemCapacityResult};
use super::models::{DriveCapacityAvailability, DriveCapacityItem, DriveCapacityListing, DriveInfo, DriveSpaceSemantics, DriveType};

const MAX_PROBES_IN_FLIGHT: usize = 2;
const STORAGE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const STORAGE_STALE_DURATION: Duration = Duration::from_secs(180);
const PROBE_STAGGER: Duration = Duration::from_millis(150);
const PROBE_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL_RETRY_BACKOFF: Duration = Duration::from_secs(15);
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(60);

type CapacityQueryFn = dyn Fn(&Path, DriveType) -> FilesystemCapacityResult + Send + Sync;
type DrivesSourceFn = dyn Fn() -> Vec<(DriveInfo, PathBuf)> + Send + Sync;

#[derive(Clone, Debug)]
struct CachedDriveCapacity {
    semantics: DriveSpaceSemantics,
    available_bytes: Option<u64>,
    total_bytes: Option<u64>,
    actual_free_bytes: Option<u64>,
    sampled_at: Option<DateTime<Utc>>,
    sampled_instant: Option<Instant>,
    retry_not_before: Option<Instant>,
    consecutive_failures: u32,
    in_flight: bool,
    failure_availability: Option<DriveCapacityAvailability>,
    failure_message: Option<String>,
}

impl Default for CachedDriveCapacity {
    fn default() -> Self {
        Self {
            semantics: drives::platform_space_semantics(),
            available_bytes: None,
            total_bytes: None,
            actual_free_bytes: None,
            sampled_at: None,
            sampled_instant: None,
            retry_not_before: None,
            consecutive_failures: 0,
            in_flight: false,
            failure_availability: None,
            failure_message: None,
        }
    }
}

struct DriveInFlightGuard {
    coordinator: Arc<DriveCapacityCoordinator>,
    drive_id: String,
}

impl Drop for DriveInFlightGuard {
    fn drop(&mut self) {
        self.coordinator.clear_in_flight(&self.drive_id);
    }
}

pub struct DriveCapacityCoordinator {
    entries: Mutex<HashMap<String, CachedDriveCapacity>>,
    semaphore: Arc<Semaphore>,
    query_fn: Arc<CapacityQueryFn>,
    drives_source_fn: Arc<DrivesSourceFn>,
}

impl DriveCapacityCoordinator {
    pub fn new() -> Arc<Self> {
        Self::with_dependencies(
            Arc::new(drives::query_filesystem_capacity),
            Arc::new(drives::cached_drives_with_roots),
        )
    }

    pub fn with_dependencies(query_fn: Arc<CapacityQueryFn>, drives_source_fn: Arc<DrivesSourceFn>) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(MAX_PROBES_IN_FLIGHT)),
            query_fn,
            drives_source_fn,
        })
    }

    #[cfg(test)]
    pub fn available_permits(&self) -> usize {
        self.semaphore.available_permits()
    }

    #[cfg(test)]
    pub fn is_drive_in_flight(&self, drive_id: &str) -> bool {
        self.entries
            .lock()
            .expect("drive capacity mutex should not be poisoned")
            .get(drive_id)
            .is_some_and(|entry| entry.in_flight)
    }

    fn clear_in_flight(&self, drive_id: &str) {
        if let Ok(mut guard) = self.entries.lock() {
            if let Some(entry) = guard.get_mut(drive_id) {
                entry.in_flight = false;
            }
        }
    }

    fn compute_backoff(failures: u32) -> Duration {
        if failures == 0 {
            return Duration::ZERO;
        }
        let shift = failures.saturating_sub(1).min(4);
        let secs = INITIAL_RETRY_BACKOFF.as_secs().saturating_mul(1u64 << shift);
        Duration::from_secs(secs.min(MAX_RETRY_BACKOFF.as_secs()))
    }

    fn should_schedule_probe(entry: &CachedDriveCapacity, now: Instant) -> bool {
        if entry.in_flight {
            return false;
        }
        if let Some(not_before) = entry.retry_not_before {
            if now < not_before {
                return false;
            }
        }
        match entry.sampled_instant {
            None => true,
            Some(sampled) => now.saturating_duration_since(sampled) >= STORAGE_REFRESH_INTERVAL,
        }
    }

    fn record_outcome(&self, drive_id: &str, outcome: FilesystemCapacityResult, now_instant: Instant, now_utc: DateTime<Utc>) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        let entry = guard.entry(drive_id.to_string()).or_default();
        match outcome {
            FilesystemCapacityResult::Available {
                total_bytes,
                available_bytes,
                actual_free_bytes,
                semantics,
            } => {
                entry.semantics = semantics;
                entry.total_bytes = Some(total_bytes);
                entry.available_bytes = Some(available_bytes);
                entry.actual_free_bytes = actual_free_bytes;
                entry.sampled_at = Some(now_utc);
                entry.sampled_instant = Some(now_instant);
                entry.consecutive_failures = 0;
                entry.retry_not_before = None;
                entry.failure_availability = None;
                entry.failure_message = None;
            }
            FilesystemCapacityResult::Failed { availability, message } => {
                entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
                entry.retry_not_before = Some(now_instant + Self::compute_backoff(entry.consecutive_failures));
                entry.failure_availability = Some(availability);
                entry.failure_message = Some(message);
            }
        }
    }

    fn spawn_probe(
        self: &Arc<Self>,
        drive_id: String,
        root: PathBuf,
        drive_type: DriveType,
        in_flight_guard: DriveInFlightGuard,
        stagger_delay: Duration,
    ) {
        let coordinator = Arc::clone(self);
        let query_fn = Arc::clone(&self.query_fn);
        tokio::spawn(async move {
            if !stagger_delay.is_zero() {
                tokio::time::sleep(stagger_delay).await;
            }
            let Ok(permit): Result<OwnedSemaphorePermit, _> = Arc::clone(&coordinator.semaphore).acquire_owned().await else {
                drop(in_flight_guard);
                return;
            };

            let blocking_handle = tokio::task::spawn_blocking(move || {
                let _owned_permit = permit;
                let _owned_in_flight_guard = in_flight_guard;
                query_fn(&root, drive_type)
            });

            match tokio::time::timeout(PROBE_WAIT_TIMEOUT, blocking_handle).await {
                Ok(Ok(outcome)) => {
                    coordinator.record_outcome(&drive_id, outcome, Instant::now(), Utc::now());
                }
                Ok(Err(_join_error)) => {
                    coordinator.record_outcome(
                        &drive_id,
                        FilesystemCapacityResult::Failed {
                            availability: DriveCapacityAvailability::Unavailable,
                            message: "Drive capacity worker failed unexpectedly.".to_string(),
                        },
                        Instant::now(),
                        Utc::now(),
                    );
                }
                Err(_elapsed) => {
                    coordinator.record_outcome(
                        &drive_id,
                        FilesystemCapacityResult::Failed {
                            availability: DriveCapacityAvailability::Timeout,
                            message: "Drive capacity check timed out; worker slot remains owned until completion.".to_string(),
                        },
                        Instant::now(),
                        Utc::now(),
                    );
                }
            }
        });
    }

    /// Return the current RAM-only snapshot immediately and schedule non-blocking probes for due drives.
    pub fn snapshot(self: &Arc<Self>) -> DriveCapacityListing {
        self.snapshot_at(Instant::now(), Utc::now())
    }

    pub fn snapshot_at(self: &Arc<Self>, now_instant: Instant, now_utc: DateTime<Utc>) -> DriveCapacityListing {
        let discovered = (self.drives_source_fn)();
        let mut to_spawn: Vec<(String, PathBuf, DriveType, DriveInFlightGuard, Duration)> = Vec::new();
        let mut items = Vec::with_capacity(discovered.len());

        {
            let mut guard = self.entries.lock().expect("drive capacity mutex should not be poisoned");

            let mut stagger_index: u32 = 0;
            for (drive, root) in discovered {
                let entry = guard.entry(drive.id.clone()).or_default();
                if Self::should_schedule_probe(entry, now_instant) {
                    entry.in_flight = true;
                    let delay = PROBE_STAGGER.saturating_mul(stagger_index);
                    stagger_index = stagger_index.saturating_add(1);
                    let in_flight_guard = DriveInFlightGuard {
                        coordinator: Arc::clone(self),
                        drive_id: drive.id.clone(),
                    };
                    to_spawn.push((drive.id.clone(), root, drive.drive_type, in_flight_guard, delay));
                }

                items.push(Self::build_item(&drive, entry, now_instant));
            }
        }

        for (drive_id, root, drive_type, in_flight_guard, delay) in to_spawn {
            self.spawn_probe(drive_id, root, drive_type, in_flight_guard, delay);
        }

        DriveCapacityListing {
            generated_at: now_utc,
            items,
        }
    }

    fn build_item(drive: &DriveInfo, entry: &CachedDriveCapacity, now_instant: Instant) -> DriveCapacityItem {
        let age_duration = entry.sampled_instant.map(|sampled| now_instant.saturating_duration_since(sampled));
        let age_seconds = age_duration.map(|d| (d.as_secs_f64() * 10.0).round() / 10.0);
        let is_stale = age_duration.is_some_and(|d| d > STORAGE_STALE_DURATION);

        match (entry.total_bytes, entry.available_bytes, entry.sampled_instant) {
            (Some(total_bytes), Some(available_bytes), Some(_)) => {
                if let Some(failure_avail) = entry.failure_availability {
                    DriveCapacityItem {
                        id: drive.id.clone(),
                        name: drive.name.clone(),
                        drive_type: drive.drive_type,
                        availability: failure_avail,
                        semantics: entry.semantics,
                        available_bytes: Some(available_bytes),
                        total_bytes: Some(total_bytes),
                        actual_free_bytes: entry.actual_free_bytes,
                        sampled_at: entry.sampled_at,
                        age_seconds,
                        is_stale: true,
                        message: entry.failure_message.clone(),
                    }
                } else if is_stale {
                    DriveCapacityItem {
                        id: drive.id.clone(),
                        name: drive.name.clone(),
                        drive_type: drive.drive_type,
                        availability: DriveCapacityAvailability::Stale,
                        semantics: entry.semantics,
                        available_bytes: Some(available_bytes),
                        total_bytes: Some(total_bytes),
                        actual_free_bytes: entry.actual_free_bytes,
                        sampled_at: entry.sampled_at,
                        age_seconds,
                        is_stale: true,
                        message: Some("Last local-drive capacity reading is older than 180 seconds.".to_string()),
                    }
                } else {
                    DriveCapacityItem {
                        id: drive.id.clone(),
                        name: drive.name.clone(),
                        drive_type: drive.drive_type,
                        availability: DriveCapacityAvailability::Available,
                        semantics: entry.semantics,
                        available_bytes: Some(available_bytes),
                        total_bytes: Some(total_bytes),
                        actual_free_bytes: entry.actual_free_bytes,
                        sampled_at: entry.sampled_at,
                        age_seconds,
                        is_stale: false,
                        message: None,
                    }
                }
            }
            _ => {
                let availability = entry.failure_availability.unwrap_or(DriveCapacityAvailability::Collecting);
                let message = entry
                    .failure_message
                    .clone()
                    .or_else(|| Some("Checking local-drive capacity.".to_string()));
                DriveCapacityItem {
                    id: drive.id.clone(),
                    name: drive.name.clone(),
                    drive_type: drive.drive_type,
                    availability,
                    semantics: entry.semantics,
                    available_bytes: None,
                    total_bytes: None,
                    actual_free_bytes: None,
                    sampled_at: None,
                    age_seconds: None,
                    is_stale: false,
                    message,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn cached_capacity_obeys_refresh_interval_and_does_not_repeat_discovery() {
        let discovery_calls = Arc::new(AtomicUsize::new(0));
        let query_calls = Arc::new(AtomicUsize::new(0));

        let discovery_counter = Arc::clone(&discovery_calls);
        let drives_fn = Arc::new(move || {
            discovery_counter.fetch_add(1, Ordering::SeqCst);
            vec![(
                DriveInfo {
                    id: "root".to_string(),
                    name: "Root (Disk)".to_string(),
                    drive_type: DriveType::Fixed,
                },
                PathBuf::from("/"),
            )]
        });

        let query_counter = Arc::clone(&query_calls);
        let query_fn = Arc::new(move |_root: &Path, _dtype: DriveType| {
            query_counter.fetch_add(1, Ordering::SeqCst);
            FilesystemCapacityResult::Available {
                total_bytes: 100 * 1024 * 1024 * 1024,
                available_bytes: 25 * 1024 * 1024 * 1024,
                actual_free_bytes: None,
                semantics: DriveSpaceSemantics::PosixUnprivilegedBlocks,
            }
        });

        let coordinator = DriveCapacityCoordinator::with_dependencies(query_fn, drives_fn);
        let t0 = Instant::now();
        let u0 = Utc::now();

        let initial = coordinator.snapshot_at(t0, u0);
        assert_eq!(initial.items.len(), 1);
        assert_eq!(initial.items[0].availability, DriveCapacityAvailability::Collecting);

        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(query_calls.load(Ordering::SeqCst), 1);

        // Multiple polls inside 60s return cached reading without spawning new probes
        let cached = coordinator.snapshot_at(t0 + Duration::from_secs(15), u0);
        assert_eq!(cached.items[0].availability, DriveCapacityAvailability::Available);
        assert_eq!(cached.items[0].available_bytes, Some(25 * 1024 * 1024 * 1024));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(query_calls.load(Ordering::SeqCst), 1);

        // Stale transition after 180s when not yet refreshed
        let stale = coordinator.snapshot_at(t0 + Duration::from_secs(185), u0);
        assert_eq!(stale.items[0].availability, DriveCapacityAvailability::Stale);
        assert!(stale.items[0].is_stale);
    }

    #[tokio::test]
    async fn wedged_mount_retains_owned_semaphore_permit_and_in_flight_guard_until_thread_exit() {
        let started = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let invocations = Arc::new(AtomicUsize::new(0));

        let started_clone = Arc::clone(&started);
        let release_clone = Arc::clone(&release);
        let invocations_clone = Arc::clone(&invocations);

        let query_fn = Arc::new(move |root: &Path, _dtype: DriveType| {
            if root == Path::new("/wedged") {
                invocations_clone.fetch_add(1, Ordering::SeqCst);
                started_clone.wait();
                release_clone.wait();
            }
            FilesystemCapacityResult::Available {
                total_bytes: 500_000,
                available_bytes: 250_000,
                actual_free_bytes: None,
                semantics: DriveSpaceSemantics::PosixUnprivilegedBlocks,
            }
        });

        let drives_fn = Arc::new(|| {
            vec![
                (
                    DriveInfo {
                        id: "wedged".to_string(),
                        name: "Wedged Mount".to_string(),
                        drive_type: DriveType::Network,
                    },
                    PathBuf::from("/wedged"),
                ),
                (
                    DriveInfo {
                        id: "healthy".to_string(),
                        name: "Healthy Disk".to_string(),
                        drive_type: DriveType::Fixed,
                    },
                    PathBuf::from("/healthy"),
                ),
            ]
        });

        let coordinator = DriveCapacityCoordinator::with_dependencies(query_fn, drives_fn);
        let _ = coordinator.snapshot();

        // Wait until the wedged OS thread is inside the blocking syscall
        tokio::task::spawn_blocking(move || {
            started.wait();
        })
        .await
        .unwrap();

        // Wait for healthy drive (staggered 150ms) to finish while wedged remains blocked
        tokio::time::sleep(Duration::from_millis(250)).await;

        // Wedged drive still holds 1 of the 2 permits and its per-drive in-flight guard; healthy drive succeeded!
        assert_eq!(coordinator.available_permits(), 1);
        assert!(coordinator.is_drive_in_flight("wedged"));
        assert!(!coordinator.is_drive_in_flight("healthy"));

        let partial = coordinator.snapshot();
        let healthy_item = partial.items.iter().find(|d| d.id == "healthy").unwrap();
        assert_eq!(healthy_item.availability, DriveCapacityAvailability::Available);
        // Repeated snapshots never spawn a duplicate thread for the wedged mount!
        assert_eq!(invocations.load(Ordering::SeqCst), 1);

        // Release the wedged OS thread and verify permit & guard return cleanly
        tokio::task::spawn_blocking(move || {
            release.wait();
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(coordinator.available_permits(), 2);
        assert!(!coordinator.is_drive_in_flight("wedged"));
    }

    #[test]
    fn unsupported_virtual_drive_zero_blocks_reports_unsupported_not_zero_free_space() {
        let coordinator = DriveCapacityCoordinator::with_dependencies(
            Arc::new(|_root, _dtype| FilesystemCapacityResult::Failed {
                availability: DriveCapacityAvailability::Unsupported,
                message: "Capacity is not available for this virtual drive.".to_string(),
            }),
            Arc::new(|| {
                vec![(
                    DriveInfo {
                        id: "cloud".to_string(),
                        name: "Cloud Drive".to_string(),
                        drive_type: DriveType::Virtual,
                    },
                    PathBuf::from("/cloud"),
                )]
            }),
        );
        coordinator.record_outcome(
            "cloud",
            FilesystemCapacityResult::Failed {
                availability: DriveCapacityAvailability::Unsupported,
                message: "Capacity is not available for this virtual drive.".to_string(),
            },
            Instant::now(),
            Utc::now(),
        );
        let snap = coordinator.snapshot();
        assert_eq!(snap.items[0].availability, DriveCapacityAvailability::Unsupported);
        assert_eq!(snap.items[0].available_bytes, None);
        assert_eq!(snap.items[0].total_bytes, None);
    }

    #[test]
    fn real_current_platform_statvfs_reports_positive_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let res = drives::query_filesystem_capacity(temp.path(), DriveType::Fixed);
        match res {
            FilesystemCapacityResult::Available {
                total_bytes,
                available_bytes,
                ..
            } => {
                assert!(total_bytes > 0);
                assert!(available_bytes <= total_bytes);
            }
            other => panic!("Expected Available capacity on temp dir, got {other:?}"),
        }
    }
}
