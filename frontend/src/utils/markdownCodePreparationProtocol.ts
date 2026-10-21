import type { CodePreviewFragment } from "./markdownCodePreviewModel";
import type { DocumentSyntaxWindow, MarkdownDocumentRecord } from "./markdownDocumentPreviewModel";
import type { SyntaxRange } from "./syntaxHighlighting";

export const PREPARATION_CHUNK_ITEMS = 512;
export const PREPARATION_SOURCE_CHUNK_UNITS = 16_384;
export const WORKER_PROGRESS_TIMEOUT_MS = 30_000;

export interface DocumentPreparationTimings {
  modelMs: number;
  recordsMs: number;
  acknowledgementWaitMs: number;
  syntaxMs: number;
  records: number;
  batches: number;
}

export interface PreviewMatch {
  from: number;
  to: number;
}

export type PreparationRequest =
  | { type: "syntax-window"; generation: number; requestId: number; window: DocumentSyntaxWindow; offset: number }
  | {
      type: "prepare";
      generation: number;
      blockCount: number;
      document?: boolean;
      normalizeSourceOnly?: boolean;
      canonicalSource?: boolean;
    }
  | { type: "source"; generation: number; sequence: number; block: number; text: string; final: boolean }
  | { type: "run"; generation: number }
  | { type: "ack"; generation: number };

export type PreparationResponse =
  | { type: "normalized-source"; generation: number; sequence: number; text: string; final: boolean }
  | {
      type: "syntax-page";
      generation: number;
      requestId: number;
      records: Extract<MarkdownDocumentRecord, { kind: "syntax" }>[];
      next: number | null;
    }
  | { type: "document-chunk"; generation: number; records: MarkdownDocumentRecord[] }
  | { type: "source-ack"; generation: number; sequence: number }
  | {
      type: "diagnostic";
      generation: number;
      message: string;
      context?: Record<string, unknown>;
      component?: string;
      error?: { message: string; name: string };
    }
  | { type: "chunk"; generation: number; block: number; ranges: SyntaxRange[]; fragments: CodePreviewFragment[]; matches: PreviewMatch[] }
  | {
      type: "complete";
      generation: number;
      preparationMs: number;
      indexingMs: number;
      syntaxRanges?: number;
      documentTimings?: DocumentPreparationTimings;
    }
  | { type: "error"; generation: number; message: string };
