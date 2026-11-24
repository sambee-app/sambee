//! Memory-bounded breadth-first queue for live-search directories.

use std::collections::VecDeque;

use super::filesystem_search_contract::limits;

#[derive(Debug, PartialEq, Eq)]
pub enum FrontierError {
    InvalidPath,
    Full,
}

pub struct PendingDirectory {
    pub path: String,
    pub expected_id: Option<Vec<u8>>,
    cost: usize,
}

#[derive(Default)]
pub struct SearchFrontier {
    pending: VecDeque<PendingDirectory>,
    bytes: usize,
}

impl SearchFrontier {
    pub fn enqueue(&mut self, path: String, expected_id: Option<Vec<u8>>) -> Result<(), FrontierError> {
        if !path.is_empty() && super::directory_index::validate_directory_path(&path).is_err() {
            return Err(FrontierError::InvalidPath);
        }
        let cost = path
            .len()
            .checked_add(expected_id.as_ref().map_or(0, Vec::len))
            .and_then(|bytes| bytes.checked_add(limits().pending_directory_entry_bytes))
            .ok_or(FrontierError::Full)?;
        if cost > limits().pending_directory_bytes.saturating_sub(self.bytes) {
            return Err(FrontierError::Full);
        }
        self.pending.push_back(PendingDirectory { path, expected_id, cost });
        self.bytes += cost;
        Ok(())
    }

    pub fn pop(&mut self) -> Option<PendingDirectory> {
        let pending = self.pending.pop_front()?;
        self.bytes -= pending.cost;
        Some(pending)
    }

    #[cfg(test)]
    pub fn pending_bytes(&self) -> usize {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontier_preserves_order_identity_and_utf8_accounting() {
        let mut frontier = SearchFrontier::default();
        frontier.enqueue("alpha".to_owned(), Some(b"identity".to_vec())).unwrap();
        frontier.enqueue("é".to_owned(), Some(b"id".to_vec())).unwrap();
        assert_eq!(
            frontier.pending_bytes(),
            2 * limits().pending_directory_entry_bytes + "alpha".len() + b"identity".len() + "é".len() + 2
        );
        let first = frontier.pop().unwrap();
        assert_eq!(
            (first.path.as_str(), first.expected_id.as_deref()),
            ("alpha", Some(b"identity".as_slice()))
        );
        frontier.enqueue("alpha/child".to_owned(), None).unwrap();
        assert_eq!(frontier.pop().unwrap().path, "é");
        assert_eq!(frontier.pop().unwrap().path, "alpha/child");
        assert!(frontier.pop().is_none());
        assert_eq!(frontier.pending_bytes(), 0);
    }

    #[test]
    fn frontier_rejects_overflow_without_dropping_existing_directories() {
        let mut frontier = SearchFrontier::default();
        let count = limits().pending_directory_bytes / (limits().pending_directory_entry_bytes + 1);
        for _ in 0..count {
            frontier.enqueue("x".to_owned(), None).unwrap();
        }
        let before = frontier.pending_bytes();
        assert_eq!(frontier.enqueue("x".to_owned(), None), Err(FrontierError::Full));
        assert_eq!(frontier.pending_bytes(), before);
        for _ in 0..count {
            assert_eq!(frontier.pop().unwrap().path, "x");
        }
        assert!(frontier.pop().is_none());
        assert_eq!(frontier.enqueue("../outside".to_owned(), None), Err(FrontierError::InvalidPath));
    }
}
