import type { MarkdownTreeRecord } from "./markdownPreparedTree";

export const PREPARATION_SOURCE_CHUNK_UNITS = 16_384;
export const WORKER_PROGRESS_TIMEOUT_MS = 30_000;

export type PreparationRequest =
  | { type: "prepare"; generation: number; prepareTree?: boolean; preserveTableSource?: boolean; preserveOnly?: boolean }
  | { type: "source"; generation: number; sequence: number; block: number; text: string; final: boolean }
  | { type: "run"; generation: number }
  | { type: "ack"; generation: number };

export type PreparationResponse =
  | { type: "normalized-source"; generation: number; sequence: number; text: string; final: boolean }
  | { type: "tree-chunk"; generation: number; sequence: number; records: MarkdownTreeRecord[]; final: boolean }
  | { type: "source-ack"; generation: number; sequence: number }
  | {
      type: "diagnostic";
      generation: number;
      message: string;
      context?: Record<string, unknown>;
      component?: string;
      error?: { message: string; name: string };
    }
  | { type: "complete"; generation: number; preparationMs: number; normalizationMs?: number; preservationMs?: number }
  | { type: "error"; generation: number; message: string };
