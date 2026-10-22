export const SOURCE_SEARCH_CHUNK_UNITS = 16_384;
export const SOURCE_SEARCH_RANGE_BATCH = 512;
export const SOURCE_SEARCH_TIMEOUT_MS = 2_000;

export type SourceSearchOperation = "count" | "next" | "previous" | "replace-one" | "replace-all";

export interface SourceSearchRange {
  from: number;
  to: number;
}

export interface SourceSearchQuery {
  wordChars: string;
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  literal: boolean;
}

export type SourceSearchRequest =
  | { type: "start"; operation: SourceSearchOperation; query: SourceSearchQuery; selection: { anchor: number; head: number } }
  | { type: "source"; text: string; complete: boolean }
  | { type: "ack" };

export type SourceSearchResponse =
  | { type: "ready" }
  | { type: "source-ack" }
  | { type: "ranges"; ranges: SourceSearchRange[] }
  | { type: "change"; from: number; to: number; insert: string; continued: boolean }
  | { type: "announcement"; text: string; continued: boolean }
  | { type: "complete"; selection?: { anchor: number; head: number }; userEvent?: string; announcements: string[] }
  | { type: "error"; message: string };
