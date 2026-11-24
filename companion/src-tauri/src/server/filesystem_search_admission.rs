//! Process-local search slots, owned by workers until cleanup completes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type Key = (String, String);

#[derive(Default)]
struct State {
    next_id: u64,
    active: HashMap<Key, HashMap<u64, bool>>,
}

#[derive(Clone, Default)]
pub struct SearchAdmission {
    state: Arc<Mutex<State>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionError {
    Running,
    Stopping,
    Invalid,
    Unavailable,
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Running => "A search is already running for this source. Stop it or try again shortly.",
            Self::Stopping => "The previous search is still stopping. Try again shortly.",
            Self::Invalid => "Search admission requires a paired site, a drive, and a positive limit.",
            Self::Unavailable => "Search admission is unavailable. Restart Companion and try again.",
        })
    }
}

impl std::error::Error for AdmissionError {}

impl SearchAdmission {
    pub fn admit(&self, origin: &str, drive: &str, limit: usize) -> Result<SearchLease, AdmissionError> {
        if origin.is_empty() || drive.is_empty() || limit == 0 {
            return Err(AdmissionError::Invalid);
        }
        let key = (origin.to_owned(), drive.to_owned());
        let mut state = self.state.lock().map_err(|_| AdmissionError::Unavailable)?;
        if let Some(active) = state.active.get(&key) {
            if active.len() >= limit {
                return Err(if active.values().all(|stopping| *stopping) {
                    AdmissionError::Stopping
                } else {
                    AdmissionError::Running
                });
            }
        }
        let identifier = state.next_id;
        state.next_id = identifier.checked_add(1).ok_or(AdmissionError::Unavailable)?;
        state.active.entry(key.clone()).or_default().insert(identifier, false);
        Ok(SearchLease {
            admission: self.clone(),
            key,
            identifier,
        })
    }
}

pub struct SearchLease {
    admission: SearchAdmission,
    key: Key,
    identifier: u64,
}

impl SearchLease {
    pub fn stop_handle(&self) -> SearchStopHandle {
        SearchStopHandle {
            admission: self.admission.clone(),
            key: self.key.clone(),
            identifier: self.identifier,
        }
    }
}

#[derive(Clone)]
pub struct SearchStopHandle {
    admission: SearchAdmission,
    key: Key,
    identifier: u64,
}

impl SearchStopHandle {
    pub fn stopping(&self) -> Result<bool, AdmissionError> {
        let mut state = self.admission.state.lock().map_err(|_| AdmissionError::Unavailable)?;
        match state
            .active
            .get_mut(&self.key)
            .and_then(|entries| entries.get_mut(&self.identifier))
        {
            Some(active) => {
                *active = true;
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

impl Drop for SearchLease {
    fn drop(&mut self) {
        let Ok(mut state) = self.admission.state.lock() else {
            log::error!("Search admission is unavailable during worker cleanup. Restart Companion before starting another search.");
            return;
        };
        if let Some(active) = state.active.get_mut(&self.key) {
            active.remove(&self.identifier);
            if active.is_empty() {
                state.active.remove(&self.key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn stopping_keeps_a_slot_until_the_worker_drops_it() {
        let admission = SearchAdmission::default();
        let lease = admission.admit("https://site", "drive", 1).unwrap();
        let stop = lease.stop_handle();
        assert!(matches!(admission.admit("https://site", "drive", 1), Err(AdmissionError::Running)));
        assert!(stop.stopping().unwrap());
        assert!(matches!(admission.admit("https://site", "drive", 1), Err(AdmissionError::Stopping)));
        drop(lease);
        assert!(!stop.stopping().unwrap());
        assert!(admission.admit("https://site", "drive", 1).is_ok());
    }

    #[test]
    fn sites_and_drives_are_independent_and_new_limits_apply_to_new_requests() {
        let admission = SearchAdmission::default();
        let first = admission.admit("https://site", "drive", 2).unwrap();
        let second = admission.admit("https://site", "drive", 2).unwrap();
        let _other_site = admission.admit("https://other", "drive", 1).unwrap();
        let _other_drive = admission.admit("https://site", "other", 1).unwrap();
        first.stop_handle().stopping().unwrap();
        assert!(matches!(admission.admit("https://site", "drive", 1), Err(AdmissionError::Running)));
        second.stop_handle().stopping().unwrap();
        assert!(matches!(admission.admit("https://site", "drive", 1), Err(AdmissionError::Stopping)));
    }

    #[test]
    fn simultaneous_starts_are_atomic() {
        let admission = SearchAdmission::default();
        let gate = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let admission = admission.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    admission.admit("https://site", "drive", 1).ok()
                })
            })
            .collect();
        let leases: Vec<_> = handles.into_iter().filter_map(|handle| handle.join().unwrap()).collect();
        assert_eq!(leases.len(), 1);
    }
}
