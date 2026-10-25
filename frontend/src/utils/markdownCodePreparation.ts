import type { Root } from "mdast";
import { normalizeMarkdownTableCellLineBreaks } from "../components/Viewer/markdownTableCellLineBreaks";
import { error as logError, info as logInfo } from "../services/logger";
import {
  INLINE_MARKDOWN_NORMALIZATION_MAX_UNITS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";
import { createMarkdownTreeReceiver } from "./markdownPreparedTree";

export {
  INLINE_MARKDOWN_NORMALIZATION_MAX_UNITS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";

const NORMALIZATION_GENERATION = 0;
const EDIT_PREPARATION_PREFIX = "sambee:edit-preparation";

function measureEditPreparation(stage: string, start: number, detail: Record<string, number | boolean | null>): void {
  const name = `${EDIT_PREPARATION_PREFIX}:${stage}`;
  performance.clearMeasures(name);
  performance.measure(name, { start, detail });
}

export interface MarkdownEditNormalizationSnapshot {
  readonly generation: number;
  readonly source: string;
  readonly baseline?: string;
  readonly preserveOnly?: boolean;
  readonly normalizedSource: string;
}

export function createMarkdownEditNormalization(
  onDiagnostic: (diagnostic: Extract<PreparationResponse, { type: "diagnostic" }>) => void,
  onNormalized?: (snapshot: MarkdownEditNormalizationSnapshot) => void,
  onFailure?: (error: Error) => void
) {
  type Request = { generation: number; source: string; baseline?: string; preserveOnly?: boolean; requestedAt: number };
  type Job = { controller: AbortController; done: Promise<void> };
  let generation = NORMALIZATION_GENERATION;
  let latest: Request | null = null;
  let pending: Request | null = null;
  let active: Job | null = null;
  let snapshot: MarkdownEditNormalizationSnapshot | null = null;
  let failure: Error | null = null;
  let disposed = false;

  const assertLive = () => {
    if (disposed) throw new DOMException("Markdown edit normalization was disposed", "AbortError");
  };

  const startPending = () => {
    if (disposed || active || !pending) return;
    const request = pending;
    pending = null;
    const startedAt = performance.now();
    const detail = {
      generation: request.generation,
      sourceUnits: request.source.length,
      baselineUnits: request.baseline?.length ?? 0,
      preserveOnly: request.preserveOnly === true,
    };
    measureEditPreparation("queue", request.requestedAt, detail);
    const controller = new AbortController();
    const job: Job = { controller, done: Promise.resolve() };
    active = job;
    job.done = (async () => {
      try {
        const result = await prepareCodePreviewInWorker(
          [request.source],
          request.generation,
          controller.signal,
          (diagnostic) => {
            if (!disposed && latest === request) onDiagnostic(diagnostic);
          },
          { preserveTableSource: request.baseline, preserveOnly: request.preserveOnly }
        );
        if (!disposed && latest === request) {
          const { requestedAt: _requestedAt, ...identity } = request;
          snapshot = Object.freeze({ ...identity, normalizedSource: result.normalizedSource });
          onNormalized?.(snapshot);
        }
      } catch (error) {
        if (!disposed && latest === request) {
          failure = error instanceof Error ? error : new Error(String(error));
          onFailure?.(failure);
        }
      } finally {
        measureEditPreparation("job", startedAt, { ...detail, current: latest === request, disposed });
        active = null;
        startPending();
      }
    })();
  };

  const captureSnapshotSync = (): MarkdownEditNormalizationSnapshot => {
    assertLive();
    if (failure) throw failure;
    if (!snapshot || snapshot.generation !== latest?.generation) {
      throw new DOMException(
        "Markdown normalization has not finished publishing. Retry after the current edit finishes.",
        "InvalidStateError"
      );
    }
    return snapshot;
  };

  return {
    request(source: string, baseline?: string, preserveOnly = false): number {
      assertLive();
      latest = {
        source,
        generation: ++generation,
        requestedAt: performance.now(),
        ...(baseline === undefined ? {} : { baseline }),
        ...(preserveOnly ? { preserveOnly } : {}),
      };
      pending = latest;
      snapshot = null;
      failure = null;
      startPending();
      return generation;
    },
    captureSnapshotSync,
    async flush(signal?: AbortSignal): Promise<MarkdownEditNormalizationSnapshot> {
      signal?.throwIfAborted();
      assertLive();
      while (active) {
        const completion = active.done;
        if (!signal) await completion;
        else {
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              signal.removeEventListener("abort", abort);
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            void completion.then(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            });
          });
        }
        signal?.throwIfAborted();
        assertLive();
      }
      return captureSnapshotSync();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      latest = null;
      pending = null;
      snapshot = null;
      failure = null;
      active?.controller.abort();
    },
  };
}

export async function normalizeMarkdownSource(source: string, signal: AbortSignal, onPrepared?: (tree: Root) => void): Promise<string> {
  signal.throwIfAborted();
  if (source.length <= INLINE_MARKDOWN_NORMALIZATION_MAX_UNITS) {
    return normalizeMarkdownTableCellLineBreaks(source, onPrepared ? (_source, tree) => onPrepared(tree) : undefined);
  }
  if (typeof Worker === "undefined") {
    logInfo(
      "Web Workers are unavailable; Markdown load normalization will run on the main thread",
      { operation: "normalize" },
      "MarkdownViewer"
    );
    return normalizeMarkdownTableCellLineBreaks(source, onPrepared ? (_source, tree) => onPrepared(tree) : undefined);
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
    { prepareTree: Boolean(onPrepared) }
  );
  signal.throwIfAborted();
  if (onPrepared) {
    if (!result.preparedTree) throw new Error("Markdown normalization worker returned no canonical tree");
    onPrepared(result.preparedTree);
  }
  return result.normalizedSource;
}

export function prepareCodePreviewInWorker(
  blocks: readonly string[],
  generation: number,
  signal: AbortSignal,
  onDiagnostic: (diagnostic: Extract<PreparationResponse, { type: "diagnostic" }>) => void,
  options: { prepareTree?: boolean; preserveTableSource?: string; preserveOnly?: boolean } = {}
): Promise<{ normalizedSource: string; preparedTree?: Root; preparationMs: number }> {
  if (signal.aborted) return Promise.reject(new DOMException("Preparation cancelled", "AbortError"));
  const initialSource = blocks[0];
  if (blocks.length !== 1 || initialSource === undefined)
    return Promise.reject(new Error("Markdown normalization requires one source document"));
  if (options.prepareTree && options.preserveTableSource !== undefined)
    return Promise.reject(new Error("Source-preserving edit preparation cannot also prepare a preview tree"));
  if (options.preserveOnly && options.preserveTableSource === undefined)
    return Promise.reject(new Error("Source-preservation-only preparation requires a baseline"));
  if (typeof Worker === "undefined")
    return Promise.reject(new Error("Worker preparation is unavailable; no main-thread fallback was used"));
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let current: Worker;
    try {
      current = new Worker(new URL("./markdownCodePreparation.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }
    const sources = options.preserveTableSource === undefined ? [initialSource] : [initialSource, options.preserveTableSource];
    const measured = options.preserveTableSource !== undefined;
    const detail = {
      generation,
      sourceUnits: initialSource.length,
      baselineUnits: options.preserveTableSource?.length ?? 0,
      preserveOnly: options.preserveOnly === true,
    };
    let transferStartedAt = startedAt;
    let runAt = startedAt;
    let resultStartedAt: number | undefined;
    let sourceBlock = 0;
    let sourceOffset = 0;
    let sourceSequence = 0;
    let sourceFinal = false;
    let sourceComplete = false;
    const normalizedParts: string[] = [];
    let normalizedFinal = false;
    const treeReceiver = options.prepareTree ? createMarkdownTreeReceiver() : null;
    let treeFinal = false;
    let treeSequence = 0;
    let treeDelivery: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(watchdog);
      clearTimeout(treeDelivery);
      signal.removeEventListener("abort", abort);
      current.onmessage = null;
      current.onerror = null;
      current.removeEventListener("messageerror", decodeFailure);
      current.terminate();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
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
    current.onmessage = (event: MessageEvent<PreparationResponse>) => {
      if (settled || event.data.generation !== generation) return;
      const response = event.data;
      try {
        armWatchdog();
        if (response.type === "tree-chunk") {
          if (
            !treeReceiver ||
            !normalizedFinal ||
            treeFinal ||
            response.sequence !== treeSequence + 1 ||
            typeof response.final !== "boolean"
          )
            throw new Error("Invalid canonical Markdown tree sequence");
          treeReceiver.consume(response.records);
          treeSequence = response.sequence;
          treeFinal = response.final;
          treeDelivery = setTimeout(() => {
            if (!settled) {
              try {
                current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
              } catch (error) {
                fail(error);
              }
            }
          }, 0);
          return;
        }
        if (response.type === "normalized-source") {
          if (
            !sourceComplete ||
            normalizedFinal ||
            response.sequence !== normalizedParts.length + 1 ||
            typeof response.text !== "string" ||
            response.text.length > PREPARATION_SOURCE_CHUNK_UNITS ||
            typeof response.final !== "boolean" ||
            (!response.final && !response.text.length)
          )
            throw new Error("Invalid normalized Markdown source chunk");
          if (resultStartedAt === undefined) {
            resultStartedAt = performance.now();
            if (measured) measureEditPreparation("run-to-result", runAt, detail);
          }
          normalizedParts.push(response.text);
          normalizedFinal = response.final;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type === "source-ack") {
          if (sourceComplete || response.sequence !== sourceSequence) throw new Error("Invalid source acknowledgement");
          if (response.sequence === 0) {
            if (measured) measureEditPreparation("startup", startedAt, detail);
            transferStartedAt = performance.now();
          }
          if (sourceFinal) {
            if (measured) measureEditPreparation(sourceBlock === 0 ? "source-transfer" : "baseline-transfer", transferStartedAt, detail);
            if (sourceBlock === sources.length - 1) {
              sourceComplete = true;
              runAt = performance.now();
              current.postMessage({ type: "run", generation } satisfies PreparationRequest);
              return;
            }
            sourceBlock += 1;
            sourceOffset = 0;
            transferStartedAt = performance.now();
          }
          const source = sources[sourceBlock];
          if (source === undefined) throw new Error("Markdown worker requested an unavailable source block");
          const text = source.slice(sourceOffset, sourceOffset + PREPARATION_SOURCE_CHUNK_UNITS);
          sourceOffset += text.length;
          sourceFinal = sourceOffset === source.length;
          sourceSequence += 1;
          current.postMessage({
            type: "source",
            generation,
            sequence: sourceSequence,
            block: sourceBlock,
            text,
            final: sourceFinal,
          } satisfies PreparationRequest);
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
        if (response.type !== "complete") throw new Error("Unexpected preparation response");
        if (!normalizedFinal) throw new Error("Markdown normalization completed before its final source chunk");
        if (treeReceiver && !treeFinal) throw new Error("Markdown normalization completed before its final tree chunk");
        const preparedTree = treeReceiver?.finish();
        if (measured) {
          if (resultStartedAt !== undefined) measureEditPreparation("result-delivery", resultStartedAt, detail);
          measureEditPreparation("transport", startedAt, {
            ...detail,
            sourceChunks: sourceSequence,
            resultChunks: normalizedParts.length,
            workerPreparationMs: response.preparationMs,
            workerNormalizationMs: response.normalizationMs ?? null,
            workerPreservationMs: response.preservationMs ?? null,
          });
        }
        settled = true;
        cleanup();
        resolve({ normalizedSource: normalizedParts.join(""), preparedTree, preparationMs: response.preparationMs });
      } catch (error) {
        fail(error);
      }
    };
    armWatchdog();
    try {
      current.postMessage({
        type: "prepare",
        generation,
        prepareTree: options.prepareTree,
        ...(options.preserveTableSource === undefined ? {} : { preserveTableSource: true }),
        ...(options.preserveOnly ? { preserveOnly: true } : {}),
      } satisfies PreparationRequest);
    } catch (error) {
      fail(error);
    }
  });
}
