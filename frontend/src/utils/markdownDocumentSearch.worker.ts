import { Text } from "@codemirror/state";
import { PREPARATION_SOURCE_CHUNK_UNITS } from "./markdownCodePreparationProtocol";
import { createMarkdownDocumentModel, markdownDocumentRecords } from "./markdownDocumentPreviewModel";
import { createDocumentSearchIndex, documentSearchMatches } from "./markdownDocumentSearch";
import {
  DOCUMENT_SEARCH_PROGRESS_MATCHES,
  DOCUMENT_SEARCH_WINDOW,
  type DocumentMatch,
  type DocumentSearchRequest,
  type DocumentSearchResponse,
} from "./markdownDocumentSearchWorker";

let parts: string[] = [];
let sequence = 0;
let received = false;
let index: Text | null = null;
let acknowledge: (() => void) | null = null;
let active: number | null = null;
let cached: { key: string; count: number; offset: number; matches: DocumentMatch[] } | null = null;
const send = (response: DocumentSearchResponse) => postMessage(response);

async function search(request: Extract<DocumentSearchRequest, { type: "search" }>) {
  if (!index || active !== null) throw new Error("Document search worker is not ready");
  if (!Number.isSafeInteger(request.ordinal) || request.ordinal < 0) throw new Error("Invalid document match ordinal");
  active = request.id;
  try {
    const key = JSON.stringify([request.query, !!request.options.caseSensitive, !!request.options.regexp, !!request.options.wholeWord]);
    if (
      cached?.key === key &&
      (cached.count === 0 || (request.ordinal >= cached.offset && request.ordinal < cached.offset + cached.matches.length))
    ) {
      send({ type: "result", id: request.id, ...cached });
      return;
    }
    const knownCount = cached?.key === key ? cached.count : null;
    const offset = Math.floor(request.ordinal / DOCUMENT_SEARCH_WINDOW) * DOCUMENT_SEARCH_WINDOW;
    const matches: DocumentMatch[] = [];
    let count = 0;
    for (const match of documentSearchMatches(index, request.query, request.options)) {
      if (count >= offset && matches.length < DOCUMENT_SEARCH_WINDOW) matches.push(match);
      count += 1;
      if (knownCount !== null && count >= offset + DOCUMENT_SEARCH_WINDOW) break;
      if (count % DOCUMENT_SEARCH_PROGRESS_MATCHES === 0)
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
          send({ type: "progress", id: request.id, count });
        });
    }
    cached = { key, count: knownCount ?? count, offset, matches };
    send({ type: "result", id: request.id, ...cached });
  } finally {
    active = null;
    acknowledge = null;
  }
}

globalThis.onmessage = (event: MessageEvent<DocumentSearchRequest>) => {
  const request = event.data;
  const run = async () => {
    if (request.type === "init") {
      if (index || received || parts.length) throw new Error("Document search worker already initialized");
      send({ type: "source-ack", sequence: 0 });
    } else if (request.type === "source") {
      if (
        received ||
        request.sequence !== sequence + 1 ||
        typeof request.text !== "string" ||
        request.text.length > PREPARATION_SOURCE_CHUNK_UNITS
      )
        throw new Error("Invalid document search source chunk");
      sequence = request.sequence;
      parts.push(request.text);
      if (!request.final) {
        send({ type: "source-ack", sequence });
        return;
      }
      received = true;
      const source = parts.join("");
      parts = [];
      const parseStarted = performance.now();
      const model = await createMarkdownDocumentModel(source);
      const parseMs = performance.now() - parseStarted;
      const indexStarted = performance.now();
      const built = createDocumentSearchIndex(markdownDocumentRecords(model));
      index = Text.of(built.text.split("\n"));
      send({ type: "ready", textUnits: index.length, segments: built.segments.length, parseMs, indexMs: performance.now() - indexStarted });
    } else if (request.type === "search") await search(request);
    else if (request.type === "ack" && request.id === active) {
      const resume = acknowledge;
      acknowledge = null;
      resume?.();
    }
  };
  void run().catch((error: unknown) => send({ type: "error", message: error instanceof Error ? error.message : String(error) }));
};
