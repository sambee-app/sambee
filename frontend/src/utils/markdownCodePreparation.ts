import { normalizeMarkdownTableCellLineBreaks } from "../components/Viewer/markdownTableCellLineBreaks";
import { error as logError, info as logInfo } from "../services/logger";
import {
  type DocumentPreparationTimings,
  PREPARATION_CHUNK_ITEMS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  type PreviewMatch,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";
import type { CodePreviewFragment, CodePreviewModel } from "./markdownCodePreviewModel";
import {
  DOCUMENT_PUBLICATION_BATCH_ITEMS,
  DOCUMENT_PUBLICATION_BATCH_UNITS,
  DOCUMENT_RECORD_BATCH_ITEMS,
  DOCUMENT_TEXT_CHUNK_UNITS,
  type DocumentSyntaxWindow,
  type MarkdownDocumentRecord,
} from "./markdownDocumentPreviewModel";
import type { SyntaxRange } from "./syntaxHighlighting";

export {
  PREPARATION_CHUNK_ITEMS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  type PreviewMatch,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";

const NORMALIZATION_GENERATION = 0;

export async function normalizeMarkdownSource(source: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (typeof Worker === "undefined") {
    logInfo(
      "Web Workers are unavailable; Markdown load normalization will run on the main thread",
      { operation: "normalize" },
      "MarkdownViewer"
    );
    return normalizeMarkdownTableCellLineBreaks(source);
  }
  const result = await prepareCodePreviewInWorker(
    [source],
    NORMALIZATION_GENERATION,
    signal,
    (diagnostic) => {
      logError(
        diagnostic.message,
        diagnostic.context,
        diagnostic.component,
        diagnostic.error ? new Error(diagnostic.error.message) : undefined
      );
    },
    undefined,
    { normalizeSourceOnly: true }
  );
  signal.throwIfAborted();
  if (result.normalizedSource === undefined) throw new Error("Markdown normalization worker returned no canonical source");
  return result.normalizedSource;
}

interface WorkerPreparation {
  documentTimings?: DocumentPreparationTimings;
  transportTimings?: { startupToFirstAckMs: number; sourceTransferMs: number };
  syntaxSession?: ReturnType<typeof createDocumentSyntaxSession>;
  normalizedSource?: string;
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

export function createDocumentSyntaxSession(generation: number, ownedWorker?: Worker) {
  const current = ownedWorker ?? worker;
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
      if (ownedWorker) current.terminate();
    },
    page(window: DocumentSyntaxWindow, offset: number) {
      return new Promise<Extract<PreparationResponse, { type: "syntax-page" }>>((resolve, reject) => {
        if (disposed || failure || pending) {
          reject(failure ?? new Error(disposed ? "Document syntax session disposed" : "Document syntax request overlaps"));
          return;
        }
        pending = { id: ++nextId, resolve, reject };
        timer = setTimeout(() => fail(new Error("Document syntax request exceeded its progress timeout")), WORKER_PROGRESS_TIMEOUT_MS);
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

export function prepareCodePreviewInWorker(
  blocks: string[],
  generation: number,
  signal: AbortSignal,
  onDiagnostic: (diagnostic: Extract<PreparationResponse, { type: "diagnostic" }>) => void,
  onDocumentChunk?: (records: readonly MarkdownDocumentRecord[]) => Promise<void>,
  options: { normalizeSourceOnly?: boolean; isolated?: boolean; canonicalSource?: boolean } = {}
): Promise<WorkerPreparation> {
  if (signal.aborted) return Promise.reject(new DOMException("Preparation cancelled", "AbortError"));
  if (typeof Worker === "undefined")
    return Promise.reject(new Error("Worker preparation is unavailable; no main-thread fallback was used"));
  return new Promise((resolve, reject) => {
    const transportStart = performance.now();
    let firstSourceAck: number | undefined;
    let sourceTransferMs = 0;
    let current: Worker;
    try {
      if (options.normalizeSourceOnly || options.isolated || !worker) {
        current = new Worker(new URL("./markdownCodePreparation.worker.ts", import.meta.url), { type: "module" });
        if (!options.normalizeSourceOnly && !options.isolated) worker = current;
      } else current = worker;
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
    const normalizedParts: string[] = [];
    let normalizedFinal = false;
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
      watchdog = setTimeout(() => fail(new Error("Worker preparation made no progress before its timeout")), WORKER_PROGRESS_TIMEOUT_MS);
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
        if (response.type === "normalized-source") {
          if (
            !options.normalizeSourceOnly ||
            !sourceComplete ||
            normalizedFinal ||
            response.sequence !== normalizedParts.length + 1 ||
            typeof response.text !== "string" ||
            response.text.length > PREPARATION_SOURCE_CHUNK_UNITS ||
            typeof response.final !== "boolean" ||
            (!response.final && !response.text.length)
          )
            throw new Error("Invalid normalized Markdown source chunk");
          normalizedParts.push(response.text);
          normalizedFinal = response.final;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type === "document-chunk") {
          if (
            !onDocumentChunk ||
            response.records.length > DOCUMENT_PUBLICATION_BATCH_ITEMS ||
            response.records.some(
              (record) => (record.kind === "text" || record.kind === "attribute") && record.value.length > DOCUMENT_TEXT_CHUNK_UNITS
            ) ||
            response.records.reduce(
              (units, record) => units + (record.kind === "text" || record.kind === "attribute" ? record.value.length : 0),
              0
            ) > DOCUMENT_PUBLICATION_BATCH_UNITS
          )
            throw new Error("Invalid Markdown document batch");
          await onDocumentChunk(response.records);
          if (settled) return;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type === "source-ack") {
          firstSourceAck ??= performance.now();
          if (sourceComplete || response.sequence !== sourceSequence) throw new Error("Invalid source acknowledgement");
          if (sourceBlock === blocks.length) {
            sourceTransferMs = performance.now() - firstSourceAck;
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
        if (options.normalizeSourceOnly && !normalizedFinal)
          throw new Error("Markdown normalization completed before its final source chunk");
        settled = true;
        cleanup();
        if (options.normalizeSourceOnly) current.terminate();
        resolve({
          syntaxSession: options.isolated && onDocumentChunk ? createDocumentSyntaxSession(generation, current) : undefined,
          normalizedSource: options.normalizeSourceOnly ? normalizedParts.join("") : undefined,
          syntaxRanges: response.syntaxRanges ?? 0,
          sourceChunks,
          largestSourceChunkUnits,
          sourceUnitsSent,
          models: blocks.map((text, index) => ({ text, ranges: ranges[index], fragments: fragments[index] })),
          matches,
          preparationMs: response.preparationMs,
          indexingMs: response.indexingMs,
          documentTimings: response.documentTimings,
          transportTimings: { startupToFirstAckMs: (firstSourceAck ?? performance.now()) - transportStart, sourceTransferMs },
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
        normalizeSourceOnly: options.normalizeSourceOnly,
        canonicalSource: options.canonicalSource,
      } satisfies PreparationRequest);
    } catch (error) {
      fail(error);
    }
  });
}
