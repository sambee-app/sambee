import { error as logError } from "../services/logger";
import { MAX_STATIC_BLOCK_LENGTH } from "./codeMirrorHighlightingCore";
import { highlightingService } from "./highlightingService";
import {
  SYNTAX_RESULT_PAGE_RANGES,
  SYNTAX_SOURCE_CHUNK_UNITS,
  SYNTAX_WORKER_PROGRESS_TIMEOUT_MS,
  type SyntaxWorkerRequest,
  type SyntaxWorkerResponse,
} from "./markdownSyntaxWorkerProtocol";
import type { CodeBlockRequest, PreparedCodeBlock, SyntaxRange } from "./syntaxHighlighting";

export function prepareMarkdownSyntax(blocks: readonly CodeBlockRequest[], signal: AbortSignal): Promise<readonly PreparedCodeBlock[]> {
  if (signal.aborted) return Promise.reject(new DOMException("Syntax preparation cancelled", "AbortError"));
  if (!blocks.length) return Promise.resolve([]);
  if (typeof Worker === "undefined") return highlightingService.prepare(blocks, signal);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./markdownSyntax.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }
    const results: PreparedCodeBlock[] = [];
    let block = 0;
    let workerBlock = 0;
    let offset = 0;
    let ranges: SyntaxRange[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let delivery: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(delivery);
      signal.removeEventListener("abort", abort);
      worker.removeEventListener("message", message);
      worker.removeEventListener("error", error);
      worker.removeEventListener("messageerror", decode);
      worker.terminate();
    };
    const fail = (failure: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure);
    };
    const abort = () => fail(new DOMException("Syntax preparation cancelled", "AbortError"));
    const error = (event: ErrorEvent) => {
      event.preventDefault();
      fail(new Error(`Syntax worker failed; retaining plain text: ${event.message}`));
    };
    const decode = () => fail(new Error("Syntax worker response could not be decoded; retaining plain text"));
    const send = (request: SyntaxWorkerRequest) => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error("Syntax worker made no progress; retaining plain text")), SYNTAX_WORKER_PROGRESS_TIMEOUT_MS);
      try {
        worker.postMessage(request);
      } catch (failure) {
        fail(failure);
      }
    };
    const source = () => {
      if (settled) return;
      while (block < blocks.length && blocks[block].text.length > MAX_STATIC_BLOCK_LENGTH) {
        results.push({ reason: "block-too-large" });
        block += 1;
      }
      if (block === blocks.length) {
        settled = true;
        cleanup();
        resolve(results);
        return;
      }
      const request = blocks[block];
      const text = request.text.slice(offset, offset + SYNTAX_SOURCE_CHUNK_UNITS);
      offset += text.length;
      send({ type: "source", block: workerBlock, text, label: request.label, final: offset === request.text.length });
    };
    const message = (event: MessageEvent<SyntaxWorkerResponse>) => {
      if (settled || signal.aborted) return;
      try {
        const response = event.data;
        if (response.type === "diagnostic") {
          logError(response.message, response.context, response.component, response.error ? new Error(response.error) : undefined);
        } else if (response.type === "error") {
          fail(new Error(response.message));
        } else if (response.type === "source-ack") {
          source();
        } else if (response.type === "ranges") {
          if (response.block !== workerBlock || response.ranges.length > SYNTAX_RESULT_PAGE_RANGES)
            throw new Error("Invalid syntax result page");
          for (const range of response.ranges) {
            if (range.from < (ranges.at(-1)?.to ?? 0) || range.to <= range.from || range.to > blocks[block].text.length)
              throw new Error("Invalid syntax result offsets");
            ranges.push(range);
          }
          clearTimeout(delivery);
          delivery = setTimeout(() => send({ type: "ack" }), 0);
        } else if (response.type === "complete") {
          if (response.block !== workerBlock) throw new Error("Obsolete syntax block result");
          results.push(response.reason ? { reason: response.reason } : { ranges });
          ranges = [];
          offset = 0;
          block += 1;
          workerBlock += 1;
          source();
        }
      } catch (failure) {
        fail(failure);
      }
    };
    worker.addEventListener("message", message);
    worker.addEventListener("error", error);
    worker.addEventListener("messageerror", decode);
    signal.addEventListener("abort", abort, { once: true });
    source();
  });
}
