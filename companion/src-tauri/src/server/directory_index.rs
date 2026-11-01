//! Disk-backed directory storage. Managers own source binding, private storage, and worker admission.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::{char::canonical_combining_class, UnicodeNormalization};

pub const APPLICATION_ID: i64 = 1396853073;
pub const SCHEMA_VERSION: i64 = 1;
pub const NORMALIZATION_VERSION: i64 = 1;
pub const TRAVERSAL_VERSION: i64 = 1;
pub const MAX_QUERY_BYTES: usize = 4096;
pub const MAX_QUERY_TERMS: usize = 32;
pub const MAX_RESULT_LIMIT: usize = 200;
pub const ROW_BATCH_SIZE: usize = 256;
pub const PAGE_CACHE_KIB: i64 = 2048;
pub const SQL_BUSY_TIMEOUT: Duration = Duration::from_millis(250);
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
pub const SQL_PROGRESS_STEPS: i32 = 1000;
pub const SCHEMA: &str = include_str!("../../../../shared/directory-index/schema.sql");

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("Directory database operation failed. Check local storage and retry: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("Directory database filesystem operation failed. Check local storage and retry: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(&'static str),
    #[error("Directory search was cancelled or timed out. Retry the search.")]
    Interrupted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Smb,
    Local,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Smb => "smb",
            Self::Local => "local",
        }
    }
}

pub fn normalize_search_text(value: &str) -> String {
    value
        .nfkd()
        .filter(|character| canonical_combining_class(*character) == 0)
        .case_fold()
        .collect()
}

pub fn search_terms(query: &str) -> Result<Vec<String>, IndexError> {
    if query.len() > MAX_QUERY_BYTES {
        return Err(IndexError::Invalid(
            "Search text exceeds the UTF-8 byte limit. Shorten the search text.",
        ));
    }
    let terms: BTreeSet<_> = query
        .split_whitespace()
        .map(normalize_search_text)
        .filter(|term| !term.is_empty())
        .collect();
    if terms.len() > MAX_QUERY_TERMS {
        return Err(IndexError::Invalid("Search text has too many distinct terms. Remove some terms."));
    }
    Ok(terms.into_iter().collect())
}

pub fn single_term_rank(basename_key: &str, term: &str) -> i64 {
    if basename_key == term {
        return 0;
    }
    if basename_key.starts_with(term) {
        return 1;
    }
    if basename_key
        .char_indices()
        .any(|(offset, character)| !character.is_alphanumeric() && basename_key[offset + character.len_utf8()..].starts_with(term))
    {
        return 2;
    }
    3
}

pub fn validate_directory_path(path: &str) -> Result<(), IndexError> {
    if path.contains('\0') || path.split('/').any(|part| matches!(part, "" | "." | "..")) {
        return Err(IndexError::Invalid(
            "Directory path must be relative without empty, dot, parent, or NUL components.",
        ));
    }
    Ok(())
}

fn epoch_milliseconds() -> Result<i64, IndexError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| IndexError::Invalid("System clock is invalid. Correct the system clock."))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| IndexError::Invalid("System clock exceeds the supported timestamp range. Correct the system clock."))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryIndexMatch {
    pub path: String,
    pub matched_term_count: usize,
    pub match_rank: i64,
    pub depth: i64,
    pub path_key: String,
}

impl DirectoryIndexMatch {
    fn sort_key(&self) -> (Reverse<usize>, i64, i64, &str, &str) {
        (
            Reverse(self.matched_term_count),
            self.match_rank,
            self.depth,
            &self.path_key,
            &self.path,
        )
    }
}

impl Ord for DirectoryIndexMatch {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

impl PartialOrd for DirectoryIndexMatch {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct DirectoryIndexSearch {
    pub results: Vec<DirectoryIndexMatch>,
    pub total_matches: i64,
    pub directory_count: i64,
    pub accepted_revision: i64,
    pub coverage: String,
    pub last_verified_at_ms: Option<i64>,
    pub query_plan: &'static str,
}

pub struct DirectoryIndex {
    path: PathBuf,
    writer: Connection,
}

impl DirectoryIndex {
    pub fn open(path: &Path, source_kind: SourceKind, source_identity: &serde_json::Value) -> Result<Self, IndexError> {
        let created = !path.try_exists()?;
        let mut writer = Connection::open(path)?;
        writer.busy_timeout(SQL_BUSY_TIMEOUT)?;
        if created {
            writer.execute_batch(SCHEMA)?;
            let now = epoch_milliseconds()?;
            let transaction = writer.transaction()?;
            transaction.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')", [])?;
            transaction.execute(
                "INSERT INTO source_metadata(id, source_kind, source_identity, normalization_version, traversal_version, selected_generation, committed_at_ms, last_access_at_ms) VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
                params![source_kind.as_str(), source_identity.to_string(), NORMALIZATION_VERSION, TRAVERSAL_VERSION, now, now],
            )?;
            transaction.commit()?;
        }
        let application_id: i64 = writer.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let schema_version: i64 = writer.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application_id != APPLICATION_ID || schema_version != SCHEMA_VERSION {
            return Err(IndexError::Invalid(
                "Directory database schema is unsupported. Rebuild this source index.",
            ));
        }
        let (kind, identity, normalization, traversal): (String, String, i64, i64) = writer.query_row(
            "SELECT source_kind, source_identity, normalization_version, traversal_version FROM source_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if kind != source_kind.as_str()
            || serde_json::from_str::<serde_json::Value>(&identity).ok().as_ref() != Some(source_identity)
            || normalization != NORMALIZATION_VERSION
            || traversal != TRAVERSAL_VERSION
        {
            return Err(IndexError::Invalid(
                "Directory database source or policy does not match. Rebuild this source index.",
            ));
        }
        let integrity: String = writer.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if integrity != "ok" || writer.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() {
            return Err(IndexError::Invalid(
                "Directory database integrity check failed. Rebuild this source index.",
            ));
        }
        writer.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;")?;
        writer.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
        let transaction = writer.transaction()?;
        transaction.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)", [])?;
        transaction.execute(
            "UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1",
            [epoch_milliseconds()?],
        )?;
        transaction.execute(
            "DELETE FROM generations WHERE state = 'candidate' AND id <> (SELECT selected_generation FROM source_metadata WHERE id = 1)",
            [],
        )?;
        transaction.commit()?;
        Ok(Self {
            path: path.to_path_buf(),
            writer,
        })
    }

    fn advance_revision(transaction: &rusqlite::Transaction<'_>) -> Result<(), IndexError> {
        let revision: i64 = transaction.query_row("SELECT accepted_revision FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        let next = revision.checked_add(1).ok_or(IndexError::Invalid(
            "Directory-index revision is exhausted. Rebuild this source index.",
        ))?;
        transaction.execute(
            "UPDATE source_metadata SET accepted_revision = ?, committed_at_ms = ? WHERE id = 1",
            params![next, epoch_milliseconds()?],
        )?;
        Ok(())
    }

    pub fn write_paths(&mut self, paths: impl IntoIterator<Item = String>, generation_id: Option<i64>) -> Result<(), IndexError> {
        let mut iterator = paths.into_iter();
        loop {
            let batch: Vec<_> = iterator.by_ref().take(ROW_BATCH_SIZE).collect();
            if batch.is_empty() {
                return Ok(());
            }
            let transaction = self.writer.transaction()?;
            let selected: i64 =
                transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
            let target = generation_id.unwrap_or(selected);
            if generation_id.is_some() {
                let state: String = transaction.query_row("SELECT state FROM generations WHERE id = ?", [target], |row| row.get(0))?;
                if !matches!(state.as_str(), "building" | "candidate") {
                    return Err(IndexError::Invalid(
                        "Scan generation is no longer active. Discard this batch and request verification.",
                    ));
                }
            }
            {
                let mut statement = transaction.prepare("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(generation_id, path) DO NOTHING")?;
                for path in batch {
                    validate_directory_path(&path)?;
                    let depth = i64::try_from(path.bytes().filter(|byte| *byte == b'/').count())
                        .map_err(|_| IndexError::Invalid("Directory depth exceeds the supported range."))?;
                    let dot = path.split('/').any(|part| part.starts_with('.'));
                    statement.execute(params![
                        target,
                        path,
                        normalize_search_text(&path),
                        normalize_search_text(path.rsplit('/').next().unwrap_or(&path)),
                        depth,
                        dot
                    ])?;
                }
            }
            if target == selected {
                Self::advance_revision(&transaction)?;
            }
            transaction.commit()?;
        }
    }

    pub fn begin_verification(&mut self) -> Result<i64, IndexError> {
        self.writer
            .execute("INSERT INTO generations(state, coverage) VALUES ('candidate', 'partial')", [])?;
        Ok(self.writer.last_insert_rowid())
    }

    pub fn finish_generation(&mut self, generation_id: i64, issue_count: i64) -> Result<bool, IndexError> {
        if issue_count < 0 {
            return Err(IndexError::Invalid("Coverage issue count must not be negative."));
        }
        let transaction = self.writer.transaction()?;
        let state: String = transaction.query_row("SELECT state FROM generations WHERE id = ?", [generation_id], |row| row.get(0))?;
        if !matches!(state.as_str(), "candidate" | "building") {
            return Err(IndexError::Invalid("Generation is not an active build or verification candidate."));
        }
        if issue_count > 0 {
            transaction.execute(
                "UPDATE generations SET issue_count = ?, coverage = 'partial' WHERE id = ?",
                params![issue_count, generation_id],
            )?;
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute("UPDATE generations SET state = 'retired' WHERE id = (SELECT selected_generation FROM source_metadata WHERE id = 1) AND id <> ?", [generation_id])?;
        transaction.execute(
            "UPDATE generations SET state = 'accepted', coverage = 'complete', issue_count = 0 WHERE id = ?",
            [generation_id],
        )?;
        transaction.execute(
            "UPDATE source_metadata SET selected_generation = ?, last_verified_at_ms = ? WHERE id = 1",
            params![generation_id, epoch_milliseconds()?],
        )?;
        Self::advance_revision(&transaction)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        include_dot: bool,
        cancelled: &Arc<AtomicBool>,
        force_scan: bool,
    ) -> Result<DirectoryIndexSearch, IndexError> {
        let terms = search_terms(query)?;
        if !(1..=MAX_RESULT_LIMIT).contains(&limit) {
            return Err(IndexError::Invalid("Directory result limit is outside the supported range."));
        }
        let started = Instant::now();
        let interrupted = || cancelled.load(Ordering::Acquire) || started.elapsed() >= QUERY_TIMEOUT;
        if interrupted() {
            return Err(IndexError::Interrupted);
        }
        let mut connection = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let cancellation = Arc::clone(cancelled);
        connection.progress_handler(
            SQL_PROGRESS_STEPS,
            Some(move || cancellation.load(Ordering::Acquire) || started.elapsed() >= QUERY_TIMEOUT),
        )?;
        connection.busy_timeout(SQL_BUSY_TIMEOUT)?;
        connection.execute_batch("PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;")?;
        connection.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
        let transaction = connection.transaction()?;
        let (generation, revision, verified): (i64, i64, Option<i64>) = transaction.query_row(
            "SELECT selected_generation, accepted_revision, last_verified_at_ms FROM source_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let (directory_count, coverage): (i64, String) = transaction.query_row(
            "SELECT indexed_count, coverage FROM generations WHERE id = ?",
            [generation],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut response = DirectoryIndexSearch {
            results: Vec::new(),
            total_matches: 0,
            directory_count,
            accepted_revision: revision,
            coverage,
            last_verified_at_ms: verified,
            query_plan: "empty",
        };
        if terms.is_empty() {
            return Ok(response);
        }
        let trigram = !force_scan && terms.iter().all(|term| term.chars().count() >= 3);
        response.query_plan = if trigram { "trigram" } else { "scan" };
        let mut sql = String::from(
            "SELECT path, path_key, basename_key, depth FROM directories WHERE generation_id = ? AND (? OR has_dot_directory = 0)",
        );
        if trigram {
            sql.push_str(" AND id IN (SELECT rowid FROM directory_fts WHERE directory_fts MATCH ?)");
        }
        let expression = terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = transaction.prepare(&sql)?;
        let mut rows = if trigram {
            statement.query(params![generation, include_dot, expression])?
        } else {
            statement.query(params![generation, include_dot])?
        };
        let mut best = BinaryHeap::with_capacity(limit);
        while let Some(row) = rows.next()? {
            if interrupted() {
                return Err(IndexError::Interrupted);
            }
            let path_key: String = row.get(1)?;
            let basename_key: String = row.get(2)?;
            let matched: Vec<_> = terms.iter().filter(|term| path_key.contains(term.as_str())).collect();
            if matched.is_empty() {
                continue;
            }
            response.total_matches = response
                .total_matches
                .checked_add(1)
                .ok_or(IndexError::Invalid("Directory match count exceeds the supported range."))?;
            let result = DirectoryIndexMatch {
                path: row.get(0)?,
                matched_term_count: matched.len(),
                match_rank: matched.iter().map(|term| single_term_rank(&basename_key, term)).min().unwrap_or(3),
                depth: row.get(3)?,
                path_key,
            };
            if best.len() < limit {
                best.push(result);
            } else if best.peek().is_some_and(|worst| result < *worst) {
                best.pop();
                best.push(result);
            }
        }
        response.results = best.into_sorted_vec();
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURES: &str = include_str!("../../../../shared/directory-index/search-fixtures.json");

    #[test]
    fn shared_fixtures_match_scan_and_trigram() {
        let fixtures: serde_json::Value = serde_json::from_str(FIXTURES).unwrap();
        for case in fixtures["normalization"].as_array().unwrap() {
            assert_eq!(
                normalize_search_text(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixtures["queries"].as_array().unwrap() {
            let mut expected: Vec<_> = case["terms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|term| term.as_str().unwrap().to_owned())
                .collect();
            expected.sort();
            assert_eq!(search_terms(case["query"].as_str().unwrap()).unwrap(), expected);
        }
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("source.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        index
            .write_paths(
                fixtures["paths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().unwrap().to_owned()),
                None,
            )
            .unwrap();
        for case in fixtures["searches"].as_array().unwrap() {
            for force_scan in [false, true] {
                let response = index
                    .search(
                        case["query"].as_str().unwrap(),
                        MAX_RESULT_LIMIT,
                        case["include_dot"].as_bool().unwrap(),
                        &Arc::new(AtomicBool::new(false)),
                        force_scan,
                    )
                    .unwrap();
                assert_eq!(response.total_matches, case["count"].as_i64().unwrap());
                let expected: Vec<_> = case["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().unwrap())
                    .collect();
                assert_eq!(response.results.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), expected);
            }
        }
    }

    #[test]
    fn candidate_failure_selection_reopen_and_source_binding() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index.write_paths(["old/alpha".into()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let accepted = index.search("alpha", 10, false, &Arc::new(AtomicBool::new(false)), false).unwrap();
        let candidate = index.begin_verification().unwrap();
        index.write_paths(["new/beta".into()], Some(candidate)).unwrap();
        assert!(!index.finish_generation(candidate, 1).unwrap());
        assert_eq!(
            index.search("alpha", 10, false, &Arc::new(AtomicBool::new(false)), false).unwrap(),
            accepted
        );
        assert!(index.finish_generation(candidate, 0).unwrap());
        assert!(index.write_paths(["late/beta".into()], Some(candidate)).is_err());
        drop(index);
        assert!(DirectoryIndex::open(&path, SourceKind::Smb, &identity).is_err());
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert_eq!(
            index
                .search("beta", 10, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            1
        );
    }

    #[test]
    fn count_has_no_discovery_cutoff() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths((0..100_001).map(|number| format!("directory-{number:06}")), None)
            .unwrap();
        let response = index
            .search("directory", 3, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(response.total_matches, 100_001);
        assert_eq!(response.directory_count, 100_001);
        assert_eq!(response.results.len(), 3);
        index.finish_generation(1, 0).unwrap();
        drop(index);
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert_eq!(
            index
                .search("100000", 3, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .results[0]
                .path,
            "directory-100000"
        );
    }

    #[test]
    fn schema_rollback_and_fts_cleanup() {
        let mut database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        database
            .execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')", [])
            .unwrap();
        let transaction = database.transaction().unwrap();
        transaction.execute("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, 'alpha', 'alpha', 'alpha', 0, 0)", []).unwrap();
        transaction.rollback().unwrap();
        assert_eq!(
            database
                .query_row::<i64, _, _>("SELECT indexed_count FROM generations", [], |row| row.get(0))
                .unwrap(),
            0
        );
        database.execute("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, 'alpha', 'alpha', 'alpha', 0, 0)", []).unwrap();
        database.execute("DELETE FROM generations WHERE id = 1", []).unwrap();
        assert_eq!(
            database
                .query_row::<i64, _, _>("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn literal_queries_colliding_keys_cancellation_and_limits() {
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("source.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        index
            .write_paths(["a%/_*/\"quoted\"".into(), "Straße".into(), "STRASSE".into()], None)
            .unwrap();
        assert_eq!(
            index
                .search("a% _* \"quoted\"", 10, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            1
        );
        assert_eq!(
            index
                .search("strasse", 10, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            2
        );
        assert!(matches!(
            index.search("strasse", 10, false, &Arc::new(AtomicBool::new(true)), false),
            Err(IndexError::Interrupted)
        ));
        assert!(search_terms(&"x".repeat(MAX_QUERY_BYTES + 1)).is_err());
        assert!(search_terms(
            &(0..=MAX_QUERY_TERMS)
                .map(|number| format!("term{number}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .is_err());
        for path in ["", "/alpha", "alpha/", "a//b", "a/./b", "a/../b", "a\0b"] {
            assert!(index.write_paths([path.to_owned()], None).is_err());
        }
    }

    #[test]
    #[ignore = "Requires the backend test interpreter; run this compatibility test explicitly."]
    fn opens_python_created_database_through_source_validation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let executable = std::env::var_os("SAMBEE_INDEX_TEST_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("backend/.venv/bin/python"));
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("python.sqlite3");
        let status = std::process::Command::new(executable)
            .env("PYTHONPATH", root.join("backend"))
            .args(["-c", "import sys; from pathlib import Path; from app.services.directory_index import DirectoryIndex; store = DirectoryIndex(Path(sys.argv[1]), source_kind='local', source_identity={'root': 'fixture'}); store.open(); store.write_paths(['alpha/beta', 'beta', 'neither']); store.finish_generation(1); store.close()"])
            .arg(&path).status().expect("Backend test interpreter could not run. Set SAMBEE_INDEX_TEST_PYTHON to its executable path.");
        assert!(status.success());
        assert!(DirectoryIndex::open(&path, SourceKind::Smb, &json!({"root": "fixture"})).is_err());
        let index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let response = index
            .search("alpha beta", 10, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(response.total_matches, 2);
        assert_eq!(response.directory_count, 3);
        assert_eq!(response.results[0].path, "alpha/beta");
    }
}
