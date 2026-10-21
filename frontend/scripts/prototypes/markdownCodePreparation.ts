export * from "../../src/utils/markdownCodePreparation";import type { CodePreviewFragment, CodePreviewModel } from "../../src/utils/markdownCodePreviewModel";
import {
  DOCUMENT_PUBLICATION_BATCH_ITEMS,
  DOCUMENT_RECORD_BATCH_ITEMS,
  DOCUMENT_TEXT_CHUNK_UNITS,
  type DocumentSyntaxWindow,
  type MarkdownDocumentRecord,
} from "../../src/utils/markdownDocumentPreviewModel";
import type { SyntaxRange } from "../../src/utils/syntaxHighlighting";

export const PREPARATION_CHUNK_ITEMS = 512;
export const PREPARATION_SOURCE_CHUNK_UNITS = 16_384;
const WORKER_PROGRESS_TIMEOUT_MS = 30_000;

export interface PreviewMatch {
  from: number;
  to: number;
}

export type PreparationRequest =
  | { type: "syntax-window"; generation: number; requestId: number; window: DocumentSyntaxWindow; offset: number }
  | { type: "prepare"; generation: number; blockCount: number; document?: boolean }
  | { type: "source"; generation: number; sequence: number; block: number; text: string; final: boolean }
  | { type: "run"; generation: number }
  | { type: "ack"; generation: number };

export type PreparationResponse =
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
  | { type: "complete"; generation: number; preparationMs: number; indexingMs: number; syntaxRanges?: number }
  | { type: "error"; generation: number; message: string };

interface WorkerPreparation {
  syntaxRanges: number;
  sourceChunks: number;
  largestSourceChunkUnits: number;
  sourceUnitsSent: number;
  models: CodePreviewModel[];
  matches: PreviewMatch[];
  preparationMs: number;
  indexingMs: number;
  clientAssemblyMs: number;
  chunks: number;
  largestChunkItems: number;
}

let worker: Worker | null = null;

export function createDocumentSyntaxSession(generation: number) {
  const current = worker;
  if (!current) throw new Error("Document syntax worker is unavailable");
  let nextId = 0;
  let pending: {
    id: number;
    resolve: (page: Extract<PreparationResponse, { type: "syntax-page" }>) => void;
    reject: (error: Error) => void;
  } | null = null;
  let disposed = false;
  let failure: Error | null = null;
  let timer: ReturnType<typeof setTimeout>;
  const fail = (error: Error) => {
    failure = error;
    clearTimeout(timer);
    const request = pending;
    pending = null;
    request?.reject(error);
    current.terminate();
    if (worker === current) worker = null;
  };
  const message = (event: MessageEvent<PreparationResponse>) => {
    if (event.data.generation !== generation || disposed) return;
    if (event.data.type === "error") {
      fail(new Error(event.data.message));
      return;
    }
    if (event.data.type !== "syntax-page" || event.data.requestId !== pending?.id) return;
    if (event.data.records.length > DOCUMENT_RECORD_BATCH_ITEMS) {
      fail(new Error("Document syntax page exceeded its record bound"));
      return;
    }
    clearTimeout(timer);
    const request = pending;
    pending = null;
    request.resolve(event.data);
  };
  const error = (event: ErrorEvent) => {
    event.preventDefault();
    fail(new Error(`Document syntax worker failed: ${event.message}`));
  };
  const decode = () => fail(new Error("Document syntax page could not be decoded"));
  current.addEventListener("message", message);
  current.addEventListener("error", error);
  current.addEventListener("messageerror", decode);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      const request = pending;
      pending = null;
      request?.reject(new DOMException("Document syntax session disposed", "AbortError"));
      current.removeEventListener("message", message);
      current.removeEventListener("error", error);
      current.removeEventListener("messageerror", decode);
    },
    page(window: DocumentSyntaxWindow, offset: number) {
      return new Promise<Extract<PreparationResponse, { type: "syntax-page" }>>((resolve, reject) => {
        if (disposed || failure || pending) {
          reject(failure ?? new Error(disposed ? "Document syntax session disposed" : "Document syntax request overlaps"));
          return;
        }
        pending = { id: ++nextId, resolve, reject };
        timer = setTimeout(
          () => fail(new Error("Document syntax request exceeded its prototype progress timeout")),
          WORKER_PROGRESS_TIMEOUT_MS
        );
        try {
          current.postMessage({ type: "syntax-window", generation, requestId: nextId, window, offset } satisfies PreparationRequest);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}

export function shutdownCodePreviewWorker(): void {
  worker?.terminate();
  worker = null;
}

/** P1 execution probe; successful jobs reuse grammars, aborted jobs destroy their worker. */
export function prepareCodePreviewInWorker(
  blocks: string[],
  generation: number,
  signal: AbortSignal,
  onDiagnostic: (diagnostic: Extract<PreparationResponse, { type: "diagnostic" }>) => void,
  onDocumentChunk?: (records: readonly MarkdownDocumentRecord[]) => Promise<void>
): Promise<WorkerPreparation> {
  if (signal.aborted) return Promise.reject(new DOMException("Preparation cancelled", "AbortError"));
  if (typeof Worker === "undefined")
    return Promise.reject(new Error("Worker preparation is unavailable; no main-thread fallback was used"));
  return new Promise((resolve, reject) => {
    let current: Worker;
    try {
      worker ??= new Worker(new URL("./markdownCodePreparation.worker.ts", import.meta.url), { type: "module" });
      current = worker;
    } catch (error) {
      reject(error);
      return;
    }
    const ranges = blocks.map(() => [] as SyntaxRange[]);
    const fragments = blocks.map(() => [] as CodePreviewFragment[]);
    const matches: PreviewMatch[] = [];
    const offsets: number[] = [];
    let offset = 0;
    for (const block of blocks) {
      offsets.push(offset);
      offset += block.length;
    }
    let chunks = 0;
    let sourceBlock = 0;
    let sourceOffset = 0;
    let sourceSequence = 0;
    let sourceComplete = false;
    let sourceChunks = 0;
    let largestSourceChunkUnits = 0;
    let sourceUnitsSent = 0;
    let largestChunkItems = 0;
    let clientAssemblyMs = 0;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", abort);
      current.onmessage = null;
      current.onerror = null;
      current.removeEventListener("messageerror", decodeFailure);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      current.terminate();
      if (worker === current) worker = null;
      reject(error);
    };
    const abort = () => fail(new DOMException("Worker preparation cancelled", "AbortError"));
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => fail(new Error("Worker preparation made no progress before its prototype timeout")),
        WORKER_PROGRESS_TIMEOUT_MS
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    current.onerror = (event) => {
      event.preventDefault();
      fail(new Error(`Worker preparation failed: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`));
    };
    const decodeFailure = () => fail(new Error("Worker preparation result could not be decoded"));
    current.addEventListener("messageerror", decodeFailure);
    current.onmessage = async (event: MessageEvent<PreparationResponse>) => {
      if (settled || event.data.generation !== generation) return;
      const response = event.data;
      try {
        armWatchdog();
        if (response.type === "document-chunk") {
          if (
            !onDocumentChunk ||
            response.records.length > DOCUMENT_PUBLICATION_BATCH_ITEMS ||
            response.records.some(
              (record) => (record.kind === "text" || record.kind === "attribute") && record.value.length > DOCUMENT_TEXT_CHUNK_UNITS
            )
          )
            throw new Error("Invalid Markdown document batch");
          await onDocumentChunk(response.records);
          if (settled) return;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type === "source-ack") {
          if (sourceComplete || response.sequence !== sourceSequence) throw new Error("Invalid source acknowledgement");
          if (sourceBlock === blocks.length) {
            sourceComplete = true;
            current.postMessage({ type: "run", generation } satisfies PreparationRequest);
            return;
          }
          const block = sourceBlock;
          const text = blocks[block].slice(sourceOffset, sourceOffset + PREPARATION_SOURCE_CHUNK_UNITS);
          sourceOffset += text.length;
          const final = sourceOffset === blocks[block].length;
          if (final) {
            sourceBlock += 1;
            sourceOffset = 0;
          }
          sourceChunks += 1;
          largestSourceChunkUnits = Math.max(largestSourceChunkUnits, text.length);
          sourceUnitsSent += text.length;
          sourceSequence += 1;
          current.postMessage({ type: "source", generation, sequence: sourceSequence, block, text, final } satisfies PreparationRequest);
          return;
        }
        if (response.type === "diagnostic") {
          onDiagnostic(response);
          return;
        }
        if (response.type === "error") {
          fail(new Error(response.message));
          return;
        }
        if (response.type === "chunk") {
          const start = performance.now();
          if (!Number.isInteger(response.block) || response.block < 0 || response.block >= blocks.length)
            throw new Error("Invalid preparation block");
          const count = response.ranges.length + response.fragments.length + response.matches.length;
          if (count > PREPARATION_CHUNK_ITEMS) throw new Error("Preparation result exceeded its chunk bound");
          for (const range of response.ranges) ranges[response.block].push(range);
          for (const fragment of response.fragments) fragments[response.block].push(fragment);
          for (const match of response.matches)
            matches.push({ from: offsets[response.block] + match.from, to: offsets[response.block] + match.to });
          chunks += 1;
          largestChunkItems = Math.max(largestChunkItems, count);
          clientAssemblyMs += performance.now() - start;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type !== "complete") throw new Error("Unexpected preparation response");
        settled = true;
        cleanup();
        resolve({
          syntaxRanges: response.syntaxRanges ?? 0,
          sourceChunks,
          largestSourceChunkUnits,
          sourceUnitsSent,
          models: blocks.map((text, index) => ({ text, ranges: ranges[index], fragments: fragments[index] })),
          matches,
          preparationMs: response.preparationMs,
          indexingMs: response.indexingMs,
          clientAssemblyMs,
          chunks,
          largestChunkItems,
        });
      } catch (error) {
        fail(error);
      }
    };
    armWatchdog();
    try {
      current.postMessage({
        type: "prepare",
        generation,
        blockCount: blocks.length,
        document: Boolean(onDocumentChunk),
      } satisfies PreparationRequest);
    } catch (error) {
      fail(error);
    }
  });
}
