import contract from "../../../shared/filesystem-search/contract.json";
import type { ArchiveEntryState, FileInfo } from "../types";

export const COMPANION_SEARCH_UPDATE_REQUIRED = "companion_search_update_required";

/** Failures the client detects itself. Each code maps to a translated status message. */
export const FILESYSTEM_SEARCH_CLIENT_ERRORS = ["invalid_data", "response_too_large", "incomplete", "start_failed"] as const;
export type FilesystemSearchClientError = (typeof FILESYSTEM_SEARCH_CLIENT_ERRORS)[number];

export function isFilesystemSearchClientError(value: unknown): value is FilesystemSearchClientError {
  return (FILESYSTEM_SEARCH_CLIENT_ERRORS as readonly unknown[]).includes(value);
}
export const FILESYSTEM_SEARCH_QUERY_MAX_BYTES = contract.limits.query_utf8_bytes;

// This small set matches the whitespace list in the shared directory-index Unicode contract.
const SEARCH_WHITESPACE = new Set(
  "\u0009\u000a\u000b\u000c\u000d\u001c\u001d\u001e\u001f\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"
);

export function validateFilesystemSearchQuery(query: string): "empty" | "too-long" | null {
  if (new TextEncoder().encode(query).length > FILESYSTEM_SEARCH_QUERY_MAX_BYTES) return "too-long";
  if ([...query].every((character) => SEARCH_WHITESPACE.has(character))) return "empty";
  return null;
}

export type FilesystemSearchRequest = {
  version: 1;
  source: { kind: "smb" | "local"; id: string };
  root: { kind: "directory"; path: string } | { kind: "archive"; path: string; member_path: string };
  query: string;
  case_sensitive: boolean;
  folder_depth: "current" | "recursive";
  item_type: "all" | "files" | "directories";
  search_archives: boolean;
};

export type FilesystemSearchTarget = { kind: "physical"; path: string } | { kind: "archive"; archive_path: string; member_path: string };

export type FilesystemSearchItem = {
  entry: FileInfo;
  target: FilesystemSearchTarget;
  archive_state?: ArchiveEntryState;
};

export type FilesystemSearchSkipReason =
  | "unreadable_directory"
  | "unsafe_name"
  | "archive_too_large"
  | "archive_unreadable"
  | "queue_limit";

export type FilesystemSearchRecord =
  | { type: "start"; version: 1; request_id: string; limits: { max_seconds: number; max_results: number } }
  | { type: "batch"; results: FilesystemSearchItem[] }
  | {
      type: "terminal";
      reason: "complete" | "partial_coverage" | "time_limit" | "result_limit" | "source_failure";
      counts: { matches: number; scanned_directories: number; skipped: number };
      skips: { reason: FilesystemSearchSkipReason; count: number }[];
    };
