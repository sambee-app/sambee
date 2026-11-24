//! Independent breadth-first live traversal using the native safe reader.

use std::cell::Cell;
use std::collections::HashSet;

use super::directory_index::IndexError;
use super::directory_traversal::{source_error, NativeFileMetadata, NativeRoot, NativeSearchChild, TraversalIssue};
use super::filesystem_search_contract::{FolderDepth, ItemType};
use super::filesystem_search_frontier::{FrontierError, SearchFrontier};
use super::filesystem_search_matching::NameMatcher;

const ZIP_EXTENSION: &str = "zip";

pub enum PhysicalSearchEvent {
    Directory {
        path: String,
    },
    File {
        path: String,
        metadata: NativeFileMetadata,
    },
    Archive {
        path: String,
        file: Result<std::fs::File, IndexError>,
    },
    Issue(TraversalIssue),
    ScannedDirectory,
}

#[derive(Default)]
pub struct PhysicalSearchSummary {
    pub scanned_directories: u64,
    pub skipped: u64,
    pub queue_limit_reached: bool,
}

pub struct PhysicalSearchOptions<'a> {
    pub root: &'a str,
    pub folder_depth: FolderDepth,
    pub item_type: ItemType,
    pub search_archives: bool,
    pub matcher: &'a NameMatcher,
}

fn archive_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(ZIP_EXTENSION))
}

pub fn search_physical(
    source: &NativeRoot,
    options: &PhysicalSearchOptions<'_>,
    mut check: impl FnMut() -> Result<(), IndexError>,
    mut receive: impl FnMut(PhysicalSearchEvent) -> Result<(), IndexError>,
) -> Result<PhysicalSearchSummary, IndexError> {
    let mut frontier = SearchFrontier::default();
    frontier.enqueue(options.root.to_owned(), None).map_err(|error| match error {
        FrontierError::InvalidPath => IndexError::Invalid("Search root is invalid. Select a folder and try again."),
        FrontierError::Full => IndexError::Invalid("Search root exceeds the folder queue limit. Select a smaller folder and try again."),
    })?;
    let mut summary = PhysicalSearchSummary::default();
    let mut is_root = true;
    while let Some(pending) = frontier.pop() {
        check()?;
        let parent = match source.open_parent_for_scan(&pending.path) {
            Ok(parent) => parent,
            Err(error) if !is_root => match source_error(error) {
                IndexError::SourceItem(code) => {
                    summary.skipped += 1;
                    receive(PhysicalSearchEvent::Issue(match code {
                        "access_denied" => TraversalIssue::AccessDenied,
                        _ => TraversalIssue::ScanFailed,
                    }))?;
                    continue;
                }
                error => return Err(error),
            },
            Err(error) => return Err(error),
        };
        if pending
            .expected_id
            .as_ref()
            .is_some_and(|expected| *expected != parent.identity.file_id())
        {
            summary.skipped += 1;
            receive(PhysicalSearchEvent::Issue(TraversalIssue::ScanFailed))?;
            continue;
        }
        let mut excluded_mounts = HashSet::new();
        let mut queue_full = false;
        let mut callback_failed = false;
        let file_choice = Cell::new(None);
        let mut include_file = |name: &str| {
            let matched = !matches!(options.item_type, ItemType::Directories) && options.matcher.matches(name);
            let archive = options.search_archives && archive_name(name);
            file_choice.set((matched || archive).then_some((matched, archive)));
            matched || archive
        };
        let read = parent.children_for_search(&mut include_file, |entry| {
            check().inspect_err(|_| callback_failed = true)?;
            match entry {
                Ok(None) => {}
                Ok(Some(NativeSearchChild::Directory((name, same_mount, expected_id)))) => {
                    let path = if pending.path.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{name}", pending.path)
                    };
                    if !matches!(options.item_type, ItemType::Files) && options.matcher.matches(&name) {
                        receive(PhysicalSearchEvent::Directory { path: path.clone() }).inspect_err(|_| callback_failed = true)?;
                    }
                    if !same_mount {
                        excluded_mounts.insert(name);
                    } else if matches!(options.folder_depth, FolderDepth::Recursive) {
                        match frontier.enqueue(path, expected_id) {
                            Ok(()) => {}
                            Err(FrontierError::Full) => {
                                queue_full = true;
                                return Err(IndexError::Interrupted);
                            }
                            Err(FrontierError::InvalidPath) => {
                                summary.skipped += 1;
                                receive(PhysicalSearchEvent::Issue(TraversalIssue::UnsafeTraversal))
                                    .inspect_err(|_| callback_failed = true)?;
                            }
                        }
                    }
                }
                Ok(Some(NativeSearchChild::File(name, metadata))) => {
                    let Some((matched, archive)) = file_choice.take() else {
                        return Err(IndexError::Invalid(
                            "Search file metadata was not selected. Start a new search and try again.",
                        ));
                    };
                    let path = if pending.path.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{name}", pending.path)
                    };
                    if matched {
                        receive(PhysicalSearchEvent::File {
                            path: path.clone(),
                            metadata,
                        })
                        .inspect_err(|_| callback_failed = true)?;
                    }
                    if archive {
                        check().inspect_err(|_| callback_failed = true)?;
                        let file = parent.open_search_file(&name);
                        receive(PhysicalSearchEvent::Archive { path, file }).inspect_err(|_| callback_failed = true)?;
                    }
                }
                Err(TraversalIssue::UnsafeDirectory(name)) if excluded_mounts.remove(&name) => {}
                Err(issue) => {
                    summary.skipped += 1;
                    receive(PhysicalSearchEvent::Issue(issue)).inspect_err(|_| callback_failed = true)?;
                }
            }
            Ok(())
        });
        if queue_full {
            summary.queue_limit_reached = true;
            return Ok(summary);
        }
        if callback_failed {
            return match read {
                Err(error) => Err(error),
                Ok(()) => Err(IndexError::Invalid("Search callback failed. Start a new search and try again.")),
            };
        }
        match read {
            Ok(()) => {
                summary.scanned_directories += 1;
                receive(PhysicalSearchEvent::ScannedDirectory)?;
            }
            Err(IndexError::SourceItem(code)) if !is_root => {
                summary.skipped += 1;
                receive(PhysicalSearchEvent::Issue(match code {
                    "access_denied" => TraversalIssue::AccessDenied,
                    _ => TraversalIssue::ScanFailed,
                }))?;
            }
            Err(error) => return Err(error),
        }
        is_root = false;
    }
    Ok(summary)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn visits_files_breadth_first_and_discovers_unmatched_archives() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("folder")).unwrap();
        fs::create_dir(temporary.path().join("folder/deeper")).unwrap();
        fs::write(temporary.path().join("top.txt"), b"a").unwrap();
        fs::write(temporary.path().join("folder/nested.txt"), b"bb").unwrap();
        fs::write(temporary.path().join("folder/deeper/end.txt"), b"ccc").unwrap();
        fs::write(temporary.path().join("other.ZIP"), b"zip").unwrap();
        let source = NativeRoot::open(temporary.path()).unwrap();
        let matcher = NameMatcher::new("*.txt", false).unwrap();
        let options = PhysicalSearchOptions {
            root: "",
            folder_depth: FolderDepth::Recursive,
            item_type: ItemType::Files,
            search_archives: true,
            matcher: &matcher,
        };
        let mut files = Vec::new();
        let mut archives = Vec::new();
        let summary = search_physical(
            &source,
            &options,
            || Ok(()),
            |event| {
                match event {
                    PhysicalSearchEvent::File { path, metadata } => files.push((path, metadata.size)),
                    PhysicalSearchEvent::Archive { path, file } => {
                        assert!(file.is_ok());
                        archives.push(path);
                    }
                    PhysicalSearchEvent::Directory { path } => panic!("Unexpected directory: {path}"),
                    PhysicalSearchEvent::Issue(issue) => panic!("Unexpected issue: {issue:?}"),
                    PhysicalSearchEvent::ScannedDirectory => {}
                }
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            files,
            vec![
                ("top.txt".to_owned(), 1),
                ("folder/nested.txt".to_owned(), 2),
                ("folder/deeper/end.txt".to_owned(), 3),
            ]
        );
        assert_eq!(archives, vec!["other.ZIP"]);
        assert_eq!(summary.scanned_directories, 3);
        assert_eq!(summary.skipped, 0);
    }

    #[test]
    fn current_folder_stops_before_children_and_checks_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("folder")).unwrap();
        fs::write(temporary.path().join("folder/hidden.txt"), b"x").unwrap();
        fs::write(temporary.path().join("root.txt"), b"x").unwrap();
        let source = NativeRoot::open(temporary.path()).unwrap();
        let matcher = NameMatcher::new("*", false).unwrap();
        let options = PhysicalSearchOptions {
            root: "",
            folder_depth: FolderDepth::Current,
            item_type: ItemType::All,
            search_archives: false,
            matcher: &matcher,
        };
        let mut paths = HashSet::new();
        let summary = search_physical(
            &source,
            &options,
            || Ok(()),
            |event| {
                match event {
                    PhysicalSearchEvent::Directory { path } | PhysicalSearchEvent::File { path, .. } => {
                        paths.insert(path);
                    }
                    PhysicalSearchEvent::ScannedDirectory => {}
                    _ => panic!("Unexpected search event"),
                }
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(paths, HashSet::from(["folder".to_owned(), "root.txt".to_owned()]));
        assert_eq!(summary.scanned_directories, 1);
        assert!(matches!(
            search_physical(&source, &options, || Err(IndexError::Interrupted), |_| Ok(())),
            Err(IndexError::Interrupted)
        ));
    }

    #[test]
    fn callback_failures_are_not_treated_as_unreadable_descendants() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("folder")).unwrap();
        fs::write(temporary.path().join("folder/file.txt"), b"x").unwrap();
        let source = NativeRoot::open(temporary.path()).unwrap();
        let matcher = NameMatcher::new("*", false).unwrap();
        let options = PhysicalSearchOptions {
            root: "",
            folder_depth: FolderDepth::Recursive,
            item_type: ItemType::Files,
            search_archives: false,
            matcher: &matcher,
        };
        assert!(matches!(
            search_physical(
                &source,
                &options,
                || Ok(()),
                |event| match event {
                    PhysicalSearchEvent::File { .. } => Err(IndexError::SourceItem("callback_failure")),
                    _ => Ok(()),
                }
            ),
            Err(IndexError::SourceItem("callback_failure"))
        ));
    }

    #[test]
    fn replaced_or_removed_descendant_is_partial_not_followed() {
        for replace in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let parking = tempfile::tempdir().unwrap();
            let folder = temporary.path().join("folder");
            fs::create_dir(&folder).unwrap();
            fs::write(folder.join("original.txt"), b"x").unwrap();
            let source = NativeRoot::open(temporary.path()).unwrap();
            let matcher = NameMatcher::new("*", false).unwrap();
            let options = PhysicalSearchOptions {
                root: "",
                folder_depth: FolderDepth::Recursive,
                item_type: ItemType::All,
                search_archives: false,
                matcher: &matcher,
            };
            let mut rows = Vec::new();
            let summary = search_physical(
                &source,
                &options,
                || Ok(()),
                |event| {
                    match event {
                        PhysicalSearchEvent::Directory { path } if path == "folder" => {
                            fs::rename(&folder, parking.path().join("moved")).unwrap();
                            if replace {
                                fs::create_dir(&folder).unwrap();
                                fs::write(folder.join("replacement.txt"), b"x").unwrap();
                            }
                        }
                        PhysicalSearchEvent::File { path, .. } => rows.push(path),
                        _ => {}
                    }
                    Ok(())
                },
            )
            .unwrap();
            assert!(rows.is_empty());
            assert_eq!(summary.skipped, 1);
        }
    }

    #[test]
    fn wide_tree_stops_when_the_frontier_reaches_its_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let entry_bytes = super::super::filesystem_search_contract::limits().pending_directory_entry_bytes + 8 + "dir-00000".len();
        let count = super::super::filesystem_search_contract::limits().pending_directory_bytes / entry_bytes + 1;
        for number in 0..count {
            fs::create_dir(temporary.path().join(format!("dir-{number:05}"))).unwrap();
        }
        let source = NativeRoot::open(temporary.path()).unwrap();
        let matcher = NameMatcher::new("*", false).unwrap();
        let options = PhysicalSearchOptions {
            root: "",
            folder_depth: FolderDepth::Recursive,
            item_type: ItemType::Directories,
            search_archives: false,
            matcher: &matcher,
        };
        let summary = search_physical(&source, &options, || Ok(()), |_| Ok(())).unwrap();
        assert!(summary.queue_limit_reached);
    }
}
