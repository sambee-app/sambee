import { findNext, findPrevious, replaceAll, replaceNext, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState, type Text, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  SOURCE_SEARCH_CHUNK_UNITS,
  SOURCE_SEARCH_RANGE_BATCH,
  type SourceSearchRequest,
  type SourceSearchResponse,
} from "./sourceRegexSearchProtocol";

let request: Extract<SourceSearchRequest, { type: "start" }> | undefined;
let chunks: string[] = [];
let output: Generator<SourceSearchResponse> | undefined;
let navigationState: EditorState | undefined;

function* execute(): Generator<SourceSearchResponse> {
  if (!request) throw new Error("Source search started without a request");
  const query = new SearchQuery({ ...request.query, regexp: true });
  if (!query.valid) throw new Error("Invalid source-search expression");
  let state =
    navigationState ??
    EditorState.create({
      doc: chunks.join(""),
      extensions: [search(), EditorState.languageData.of(() => [{ wordChars: request?.query.wordChars ?? "" }])],
    });
  chunks = [];
  state = state.update({ effects: setSearchQuery.of(query), selection: request.selection }).state;
  if (request.operation === "count") {
    const cursor = query.getCursor(state);
    let ranges = [];
    for (let match = cursor.next(); !match.done; match = cursor.next()) {
      ranges.push({ from: match.value.from, to: match.value.to });
      if (ranges.length === SOURCE_SEARCH_RANGE_BATCH) {
        yield { type: "ranges", ranges };
        ranges = [];
      }
    }
    if (ranges.length) yield { type: "ranges", ranges };
    yield { type: "complete", announcements: [] };
    return;
  }
  let transaction: Transaction | undefined;
  const target = {
    get state() {
      return state;
    },
    plugin: () => null,
    dispatch: (spec: TransactionSpec) => {
      transaction = state.update(spec);
    },
  };
  const commands = { next: findNext, previous: findPrevious, "replace-one": replaceNext, "replace-all": replaceAll };
  commands[request.operation](target as unknown as EditorView);
  if (request.operation === "next" || request.operation === "previous") navigationState = transaction?.state ?? state;
  if (!transaction) {
    yield { type: "complete", announcements: [] };
    return;
  }
  const changes: { from: number; to: number; inserted: Text }[] = [];
  transaction.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    changes.push({ from, to, inserted });
  }, true);
  for (const { from, to, inserted } of changes) {
    for (let offset = 0; offset < inserted.length || offset === 0; offset += SOURCE_SEARCH_CHUNK_UNITS) {
      yield {
        type: "change",
        from,
        to,
        insert: inserted.sliceString(offset, Math.min(inserted.length, offset + SOURCE_SEARCH_CHUNK_UNITS)),
        continued: offset > 0,
      };
    }
  }
  const selection = transaction.selection?.main;
  for (const effect of transaction.effects) {
    if (!effect.is(EditorView.announce)) continue;
    for (let offset = 0; offset < effect.value.length; offset += SOURCE_SEARCH_CHUNK_UNITS) {
      yield { type: "announcement", text: effect.value.slice(offset, offset + SOURCE_SEARCH_CHUNK_UNITS), continued: offset > 0 };
    }
  }
  yield {
    type: "complete",
    selection: selection ? { anchor: selection.anchor, head: selection.head } : undefined,
    userEvent: transaction.annotation(Transaction.userEvent),
    announcements: [],
  };
}

function publishNext(): void {
  const next = output?.next();
  if (next && !next.done) globalThis.postMessage(next.value);
}

globalThis.onmessage = (event: MessageEvent<SourceSearchRequest>) => {
  try {
    const message = event.data;
    if (message.type === "start") {
      request = message;
      chunks = [];
      navigationState = undefined;
      globalThis.postMessage({ type: "source-ack" } satisfies SourceSearchResponse);
    } else if (message.type === "navigate") {
      if (!navigationState || !request || (request.operation !== "next" && request.operation !== "previous"))
        throw new Error("Source navigation requires a prepared navigation document");
      request = {
        ...request,
        operation: message.operation,
        selection: message.selection,
        query: { ...request.query, wordChars: message.wordChars },
      };
      output = execute();
      publishNext();
    } else if (message.type === "source") {
      if (message.text.length > SOURCE_SEARCH_CHUNK_UNITS) throw new Error("Source-search transfer exceeded its chunk bound");
      chunks.push(message.text);
      if (message.complete) {
        output = execute();
        publishNext();
      } else globalThis.postMessage({ type: "source-ack" } satisfies SourceSearchResponse);
    } else publishNext();
  } catch (error) {
    output = undefined;
    chunks = [];
    navigationState = undefined;
    globalThis.postMessage({ type: "error", message: error instanceof Error ? error.message : "Source search failed" });
  }
};

globalThis.postMessage({ type: "ready" } satisfies SourceSearchResponse);
