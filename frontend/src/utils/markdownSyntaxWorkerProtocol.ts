import type { CodeBlockRequest, PlainTextReason, SyntaxRange } from "./syntaxHighlighting";

export const SYNTAX_SOURCE_CHUNK_UNITS = 16_384;
export const SYNTAX_RESULT_PAGE_RANGES = 512;
export const SYNTAX_WORKER_PROGRESS_TIMEOUT_MS = 30_000;

export type SyntaxWorkerRequest =
  | { type: "source"; block: number; text: string; label: CodeBlockRequest["label"]; final: boolean }
  | { type: "ack" };

export type SyntaxWorkerResponse =
  | { type: "source-ack" }
  | { type: "ranges"; block: number; ranges: SyntaxRange[] }
  | { type: "complete"; block: number; reason?: PlainTextReason }
  | { type: "diagnostic"; message: string; context?: Record<string, unknown>; component?: string; error?: string }
  | { type: "error"; message: string };
