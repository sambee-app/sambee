import type { FileEntry } from "../types";

const WINDOWS_SHORTCUT_EXTENSION = ".lnk";

/** Identifies explicit local links and Windows shortcuts discovered from their filename. */
export function isShortcutFile(file: FileEntry): boolean {
  return file.link_kind !== undefined || file.name.toLowerCase().endsWith(WINDOWS_SHORTCUT_EXTENSION);
}

/** Return a shared explanation for an archive member that cannot be read. */
export function getArchiveMemberUnavailableMessageKey(
  file: FileEntry
):
  | "fileBrowser.archiveMembers.encrypted"
  | "fileBrowser.archiveMembers.unsupportedCompression"
  | "fileBrowser.archiveMembers.unavailable"
  | null {
  if (file.archive_entry_state === undefined || file.is_readable) return null;
  if (file.archive_entry_state === "blocked") return "fileBrowser.archiveMembers.encrypted";
  if (file.archive_entry_state === "unavailable") return "fileBrowser.archiveMembers.unsupportedCompression";
  return "fileBrowser.archiveMembers.unavailable";
}
