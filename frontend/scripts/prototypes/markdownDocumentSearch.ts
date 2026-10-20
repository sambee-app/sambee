import type { DocumentSearchOptions } from "../../src/utils/markdownDocumentSearch";
import { PREPARATION_SOURCE_CHUNK_UNITS } from "./markdownCodePreparation";

export const DOCUMENT_SEARCH_WINDOW = 64;
export const DOCUMENT_SEARCH_PROGRESS_MATCHES = 512;
export const DOCUMENT_SEARCH_TIMEOUT_MS = 2_000;

export interface DocumentMatch {
  from: number;
  to: number;
}
export interface DocumentSearchResult {
  count: number;
  offset: number;
  matches: DocumentMatch[];
}
export type DocumentSearchRequest =
  | { type: "init" }
  | { type: "source"; sequence: number; text: string; final: boolean }
  | { type: "search"; id: number; query: string; options: DocumentSearchOptions; ordinal: number }
  | { type: "ack"; id: number };
export type DocumentSearchResponse =
  | { type: "source-ack"; sequence: number }
  | { type: "ready"; textUnits: number; segments: number; parseMs: number; indexMs: number }
  | { type: "progress"; id: number; count: number }
  | ({ type: "result"; id: number } & DocumentSearchResult)
  | { type: "error"; message: string };

export function createDocumentSearchSession(source: string) {
  let sourceText: string | null = source;
  let worker: Worker | null = null;
  let ready = false;
  let nextId = 0;
  let cancel: (() => void) | null = null;
  let status: Record<string, unknown> = { complete: false, lowerBound: 0, count: null, error: null, cachedMatches: 0 };
  const dispose = () => {
    cancel?.();
    worker?.terminate();
    worker = null;
    ready = false;
    sourceText = null;
    status = { complete: false, disposed: true, cachedMatches: 0 };
  };
  return {
    dispose,
    stats: () => status,
    search(query: string, options: DocumentSearchOptions, signal: AbortSignal, ordinal = 0): Promise<DocumentSearchResult> {
      cancel?.();
      if (signal.aborted) return Promise.reject(signal.reason);
      if (sourceText === null) return Promise.reject(new Error("Document search session disposed"));
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) return Promise.reject(new Error("Invalid document match ordinal"));
      const id = ++nextId;
      status = { complete: false, lowerBound: 0, count: null, error: null, cachedMatches: 0 };
      return new Promise((resolve, reject) => {
        let current: Worker;
        try {
          if (typeof Worker === "undefined") throw new Error("Document search requires a worker; no main-thread fallback was used");
          worker ??= new Worker(new URL("./markdownDocumentSearch.worker.ts", import.meta.url), { type: "module" });
          current = worker;
        } catch (error) {
          status = { ...status, error: error instanceof Error ? error.message : String(error) };
          reject(error);
          return;
        }
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        let sequence = 0;
        let sourceOffset = 0;
        let sourceComplete = false;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          current.onmessage = null;
          current.onerror = null;
          current.removeEventListener("messageerror", decodeFailure);
          if (cancel === abort) cancel = null;
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          current.terminate();
          if (worker === current) {
            worker = null;
            ready = false;
          }
          status = {
            ...status,
            complete: false,
            count: null,
            cachedMatches: 0,
            error: error instanceof Error ? error.message : String(error),
          };
          reject(error);
        };
        const abort = () => fail(new DOMException("Document search superseded", "AbortError"));
        const decodeFailure = () => fail(new Error("Document search result could not be decoded"));
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => fail(new Error("Document search exceeded its prototype progress deadline; worker terminated")),
            DOCUMENT_SEARCH_TIMEOUT_MS
          );
        };
        const send = (request: DocumentSearchRequest) => {
          current.postMessage(request);
        };
        const run = () => send({ type: "search", id, query, options, ordinal });
        cancel = abort;
        signal.addEventListener("abort", abort, { once: true });
        current.addEventListener("messageerror", decodeFailure);
        current.onerror = (event) => {
          event.preventDefault();
          fail(new Error(`Document search worker failed: ${event.message}`));
        };
        current.onmessage = (event: MessageEvent<DocumentSearchResponse>) => {
          if (settled) return;
          try {
            const response = event.data;
            if (response.type === "error") {
              fail(new Error(response.message));
              return;
            }
            arm();
            if (response.type === "source-ack") {
              if (ready || sourceComplete || response.sequence !== sequence)
                throw new Error("Invalid document search source acknowledgement");
              const text = sourceText!.slice(sourceOffset, sourceOffset + PREPARATION_SOURCE_CHUNK_UNITS);
              sourceOffset += text.length;
              const final = sourceOffset === sourceText!.length;
              sourceComplete = final;
              send({ type: "source", sequence: ++sequence, text, final });
              return;
            }
            if (response.type === "ready") {
              ready = true;
              status = { ...status, textUnits: response.textUnits, segments: response.segments, parseMs: response.parseMs, indexMs: response.indexMs };
              run();
              return;
            }
            if (response.id !== id) return;
            if (response.type === "progress") {
              status = { ...status, lowerBound: response.count };
              send({ type: "ack", id });
              return;
            }
            if (
              response.type !== "result" ||
              !Number.isSafeInteger(response.count) ||
              response.count < 0 ||
              response.matches.length > DOCUMENT_SEARCH_WINDOW
            )
              throw new Error("Invalid document search result");
            status = {
              ...status,
              complete: true,
              count: response.count,
              lowerBound: response.count,
              error: null,
              cachedMatches: response.matches.length,
            };
            settled = true;
            cleanup();
            resolve(response);
          } catch (error) {
            fail(error);
          }
        };
        arm();
        try {
          if (ready) run();
          else send({ type: "init" });
        } catch (error) {
          fail(error);
        }
      });
    },
  };
}
