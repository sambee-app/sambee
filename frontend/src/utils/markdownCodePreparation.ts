import type { Root } from "mdast";
import { normalizeMarkdownTableCellLineBreaks } from "../components/Viewer/markdownTableCellLineBreaks";
import { error as logError, info as logInfo } from "../services/logger";
import {
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";
import { createMarkdownTreeReceiver } from "./markdownPreparedTree";

export {
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "./markdownCodePreparationProtocol";

const NORMALIZATION_GENERATION = 0;

export async function normalizeMarkdownSource(source: string, signal: AbortSignal, onPrepared?: (tree: Root) => void): Promise<string> {
  signal.throwIfAborted();
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
  options: { prepareTree?: boolean } = {}
): Promise<{ normalizedSource: string; preparedTree?: Root; preparationMs: number }> {
  if (signal.aborted) return Promise.reject(new DOMException("Preparation cancelled", "AbortError"));
  if (blocks.length !== 1) return Promise.reject(new Error("Markdown normalization requires one source document"));
  if (typeof Worker === "undefined")
    return Promise.reject(new Error("Worker preparation is unavailable; no main-thread fallback was used"));
  return new Promise((resolve, reject) => {
    let current: Worker;
    try {
      current = new Worker(new URL("./markdownCodePreparation.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }
    const source = blocks[0];
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
          normalizedParts.push(response.text);
          normalizedFinal = response.final;
          current.postMessage({ type: "ack", generation } satisfies PreparationRequest);
          return;
        }
        if (response.type === "source-ack") {
          if (sourceComplete || response.sequence !== sourceSequence) throw new Error("Invalid source acknowledgement");
          if (sourceFinal) {
            sourceComplete = true;
            current.postMessage({ type: "run", generation } satisfies PreparationRequest);
            return;
          }
          const text = source.slice(sourceOffset, sourceOffset + PREPARATION_SOURCE_CHUNK_UNITS);
          sourceOffset += text.length;
          sourceFinal = sourceOffset === source.length;
          sourceSequence += 1;
          current.postMessage({
            type: "source",
            generation,
            sequence: sourceSequence,
            block: 0,
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
        settled = true;
        cleanup();
        resolve({ normalizedSource: normalizedParts.join(""), preparedTree, preparationMs: response.preparationMs });
      } catch (error) {
        fail(error);
      }
    };
    armWatchdog();
    try {
      current.postMessage({ type: "prepare", generation, prepareTree: options.prepareTree } satisfies PreparationRequest);
    } catch (error) {
      fail(error);
    }
  });
}
