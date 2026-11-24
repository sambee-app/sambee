//! Search the existing ZIP browse projection in one pass.

use std::collections::HashMap;

use super::archive::{EffectiveLocalArchiveProjection, LocalArchiveReadEntry, LocalArchiveReadError, LocalArchiveReader};
use super::filesystem_search_contract::{limits, FolderDepth, ItemType};
use super::filesystem_search_matching::NameMatcher;

pub struct ArchiveSearchMatch<'a> {
    pub path: &'a str,
    pub is_directory: bool,
    pub entry: Option<&'a LocalArchiveReadEntry>,
}

#[derive(Debug, thiserror::Error)]
pub enum ArchiveSearchError<E> {
    #[error("The search folder is not in this archive. Select a folder and try again.")]
    RootMissing,
    #[error("The ZIP has too much metadata to search. Search a smaller ZIP or browse it instead.")]
    TooLarge,
    #[error("The ZIP could not be read. Check the archive and try again: {0}")]
    Archive(LocalArchiveReadError),
    #[error("{0}")]
    Worker(E),
}

pub fn read_search_projection<E>(
    reader: &mut LocalArchiveReader,
    mut check: impl FnMut() -> Result<(), E>,
) -> Result<EffectiveLocalArchiveProjection, ArchiveSearchError<E>> {
    check().map_err(ArchiveSearchError::Worker)?;
    let size = reader.central_directory_size();
    check().map_err(ArchiveSearchError::Worker)?;
    if size > u64::try_from(limits().zip_central_directory_bytes).expect("Search ZIP limit must fit in u64") {
        return Err(ArchiveSearchError::TooLarge);
    }
    let projection = reader.effective_projection().map_err(ArchiveSearchError::Archive)?;
    check().map_err(ArchiveSearchError::Worker)?;
    Ok(projection)
}

pub fn visit_archive_matches<'a, E>(
    projection: &'a EffectiveLocalArchiveProjection,
    root: &str,
    depth: FolderDepth,
    item_type: ItemType,
    matcher: &NameMatcher,
    mut check: impl FnMut() -> Result<(), E>,
    mut receive: impl FnMut(ArchiveSearchMatch<'a>) -> Result<(), E>,
) -> Result<(), ArchiveSearchError<E>> {
    check().map_err(ArchiveSearchError::Worker)?;
    if !root.is_empty() && !projection.directories().contains(root) {
        return Err(ArchiveSearchError::RootMissing);
    }
    let prefix = if root.is_empty() { String::new() } else { format!("{root}/") };
    let matches = |path: &str| {
        let Some(remainder) = path.strip_prefix(&prefix) else {
            return false;
        };
        if remainder.is_empty() || matches!(depth, FolderDepth::Current) && remainder.contains('/') {
            return false;
        }
        matcher.matches(remainder.rsplit('/').next().unwrap_or(""))
    };
    if !matches!(item_type, ItemType::Directories) {
        for entry in projection.entries.iter().filter(|entry| !entry.is_directory) {
            check().map_err(ArchiveSearchError::Worker)?;
            if matches(&entry.path) {
                receive(ArchiveSearchMatch {
                    path: &entry.path,
                    is_directory: false,
                    entry: Some(entry),
                })
                .map_err(ArchiveSearchError::Worker)?;
            }
        }
    }
    if !matches!(item_type, ItemType::Files) {
        let explicit: HashMap<_, _> = projection
            .entries
            .iter()
            .filter(|entry| entry.is_directory)
            .map(|entry| (entry.path.as_str(), entry))
            .collect();
        let mut representatives = HashMap::new();
        for entry in &projection.entries {
            check().map_err(ArchiveSearchError::Worker)?;
            for (offset, _) in entry.path.match_indices('/') {
                check().map_err(ArchiveSearchError::Worker)?;
                representatives.entry(&entry.path[..offset]).or_insert(entry);
            }
        }
        for path in projection.directories() {
            check().map_err(ArchiveSearchError::Worker)?;
            if matches(path) {
                receive(ArchiveSearchMatch {
                    path,
                    is_directory: true,
                    entry: explicit.get(path.as_str()).or_else(|| representatives.get(path.as_str())).copied(),
                })
                .map_err(ArchiveSearchError::Worker)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs::File;
    use std::io::Write;
    use zip::write::{SimpleFileOptions, ZipWriter};

    #[test]
    fn archive_scope_and_item_type_use_the_browse_projection() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("archive.zip");
        let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
        for name in ["root.txt", "folder/nested.txt", "folder/deeper/item.txt"] {
            writer.start_file(name, SimpleFileOptions::default()).unwrap();
            writer.write_all(b"data").unwrap();
        }
        writer.finish().unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();
        let projection = read_search_projection(&mut reader, || Ok::<_, ()>(())).unwrap();
        let matcher = NameMatcher::new("*", false).unwrap();
        let run = |root, depth, item_type| {
            let mut rows = HashSet::new();
            visit_archive_matches(
                &projection,
                root,
                depth,
                item_type,
                &matcher,
                || Ok::<_, ()>(()),
                |entry| {
                    if !entry.is_directory {
                        assert_eq!(entry.entry.unwrap().uncompressed_size, 4);
                    }
                    rows.insert((entry.path.to_owned(), entry.is_directory));
                    Ok(())
                },
            )
            .unwrap();
            rows
        };
        assert_eq!(
            run("folder", FolderDepth::Current, ItemType::All),
            HashSet::from([("folder/nested.txt".to_owned(), false), ("folder/deeper".to_owned(), true)])
        );
        assert_eq!(
            run("folder", FolderDepth::Recursive, ItemType::Files),
            HashSet::from([
                ("folder/nested.txt".to_owned(), false),
                ("folder/deeper/item.txt".to_owned(), false)
            ])
        );
        assert_eq!(
            run("", FolderDepth::Recursive, ItemType::Directories),
            HashSet::from([("folder".to_owned(), true), ("folder/deeper".to_owned(), true)])
        );
        assert!(matches!(
            visit_archive_matches(
                &projection,
                "missing",
                FolderDepth::Recursive,
                ItemType::All,
                &matcher,
                || Ok::<_, ()>(()),
                |_| Ok(())
            ),
            Err(ArchiveSearchError::RootMissing)
        ));
        assert!(matches!(
            visit_archive_matches(
                &projection,
                "",
                FolderDepth::Recursive,
                ItemType::All,
                &matcher,
                || Err("cancelled"),
                |_| Ok(())
            ),
            Err(ArchiveSearchError::Worker("cancelled"))
        ));
    }

    #[test]
    fn inferred_directory_metadata_uses_the_browse_representative() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("archive.zip");
        let mut writer = ZipWriter::new(File::create(&path).unwrap());
        writer.start_file("folder/file.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"data").unwrap();
        writer.finish().unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&path).unwrap();
        let page = reader.directory_page("", None, 10).unwrap();
        let expected = page.entries.iter().find(|entry| entry.path == "folder").unwrap().modified_at;
        let mut reader = LocalArchiveReader::open_pinned(&path).unwrap();
        let projection = read_search_projection(&mut reader, || Ok::<_, ()>(())).unwrap();
        let matcher = NameMatcher::new("folder", false).unwrap();
        let mut actual = None;
        visit_archive_matches(
            &projection,
            "",
            FolderDepth::Current,
            ItemType::Directories,
            &matcher,
            || Ok::<_, ()>(()),
            |entry| {
                actual = Some(entry.entry.unwrap().modified_at);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(actual, Some(expected));
    }

    #[test]
    fn archive_search_uses_the_effective_duplicate_and_checks_between_entries() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("archive.zip");
        let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
        writer.start_file("duplicate1.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"old").unwrap();
        writer.start_file("duplicate2.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"latest").unwrap();
        writer.finish().unwrap();
        let mut bytes = std::fs::read(&archive_path).unwrap();
        let from = b"duplicate2.txt";
        let to = b"duplicate1.txt";
        let mut replacements = 0;
        for offset in 0..=bytes.len() - from.len() {
            if &bytes[offset..offset + from.len()] == from {
                bytes[offset..offset + from.len()].copy_from_slice(to);
                replacements += 1;
            }
        }
        assert_eq!(replacements, 2);
        std::fs::write(&archive_path, bytes).unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();
        let projection = read_search_projection(&mut reader, || Ok::<_, ()>(())).unwrap();
        let matcher = NameMatcher::new("duplicate1", false).unwrap();
        let mut sizes = Vec::new();
        visit_archive_matches(
            &projection,
            "",
            FolderDepth::Recursive,
            ItemType::Files,
            &matcher,
            || Ok::<_, ()>(()),
            |entry| {
                sizes.push(entry.entry.unwrap().uncompressed_size);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(sizes, vec![6]);

        let mut checks = 0;
        assert!(matches!(
            visit_archive_matches(
                &projection,
                "",
                FolderDepth::Recursive,
                ItemType::Files,
                &matcher,
                || {
                    checks += 1;
                    if checks == 2 {
                        Err("cancelled")
                    } else {
                        Ok(())
                    }
                },
                |_| Ok(()),
            ),
            Err(ArchiveSearchError::Worker("cancelled"))
        ));
    }

    #[test]
    fn oversized_archive_is_rejected_before_projection() {
        let temporary = tempfile::tempdir().unwrap();
        let archive_path = temporary.path().join("archive.zip");
        let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
        for number in 0..400 {
            writer
                .start_file(format!("item-{number:05}.txt"), SimpleFileOptions::default())
                .unwrap();
        }
        writer.finish().unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();
        assert!(matches!(
            read_search_projection(&mut reader, || Ok::<_, ()>(())),
            Err(ArchiveSearchError::TooLarge)
        ));
        assert_eq!(reader.next_entry().unwrap().unwrap().path, "item-00000.txt");
    }

    #[test]
    fn archive_projection_enforces_the_exact_metadata_limit() {
        const CENTRAL_HEADER_BYTES: usize = 46;
        for over_limit in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let archive_path = temporary.path().join("archive.zip");
            let mut writer = ZipWriter::new(File::create(&archive_path).unwrap());
            let name = "a".repeat(limits().zip_central_directory_bytes - CENTRAL_HEADER_BYTES + usize::from(over_limit));
            writer.start_file(name, SimpleFileOptions::default()).unwrap();
            writer.finish().unwrap();
            let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();
            assert_eq!(
                reader.central_directory_size(),
                u64::try_from(limits().zip_central_directory_bytes + usize::from(over_limit)).unwrap()
            );
            let projection = read_search_projection(&mut reader, || Ok::<_, ()>(()));
            if over_limit {
                assert!(matches!(projection, Err(ArchiveSearchError::TooLarge)));
            } else {
                assert_eq!(projection.unwrap().entries.len(), 1);
            }
        }
    }
}
