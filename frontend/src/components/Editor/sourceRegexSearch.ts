import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import { type ChangeSpec, StateEffect, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  SOURCE_SEARCH_CHUNK_UNITS,
  SOURCE_SEARCH_RANGE_BATCH,
  SOURCE_SEARCH_TIMEOUT_MS,
  type SourceSearchOperation,
  type SourceSearchRange,
  type SourceSearchRequest,
  type SourceSearchResponse,
} from "./sourceRegexSearchProtocol";
import { beginSourceReplacementFeedback, isHeavySourceReplacement, isSourceReplacementPending } from "./sourceReplacementFeedback";

export const sourceRegexSearchUpdated = StateEffect.define<null>();

type NavigationOperation = "next" | "previous";

interface RegexSearchSession {
  document: Text;
  query: SearchQuery;
  ranges: SourceSearchRange[];
  pending: boolean;
  error?: string;
  cancel: () => void;
  enqueueNavigation?: (operation: NavigationOperation) => boolean;
}

const sessions = new WeakMap<EditorView, RegexSearchSession>();

export const sourceRegexSearchLifecycle = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {}

    update(update: ViewUpdate) {
      const session = sessions.get(this.view);
      if (session && (update.docChanged || !session.query.eq(getSearchQuery(update.state)))) disposeSourceRegexSearch(this.view);
    }

    destroy() {
      disposeSourceRegexSearch(this.view);
    }
  }
);

export function disposeSourceRegexSearch(view: EditorView): void {
  sessions.get(view)?.cancel();
  sessions.delete(view);
}

export function getSourceRegexSearch(view: EditorView): RegexSearchSession {
  const query = getSearchQuery(view.state);
  const existing = sessions.get(view);
  if (existing?.document === view.state.doc && existing.query.eq(query)) return existing;
  existing?.cancel();
  const session: RegexSearchSession = { document: view.state.doc, query, ranges: [], pending: true, cancel: () => {} };
  sessions.set(view, session);
  if (query.valid && query.regexp) run(view, session, "count");
  else session.pending = false;
  return session;
}

export function runSourceRegexSearchCommand(view: EditorView, operation: Exclude<SourceSearchOperation, "count">): boolean {
  if (!getSearchQuery(view.state).regexp) return false;
  if (!getSearchQuery(view.state).valid) return true;
  if ((operation === "replace-one" || operation === "replace-all") && view.state.readOnly) return true;
  if ((operation === "replace-one" || operation === "replace-all") && isSourceReplacementPending(view)) return true;
  const session = getSourceRegexSearch(view);
  if ((operation === "next" || operation === "previous") && session.enqueueNavigation?.(operation)) return true;
  session.cancel();
  run(view, session, operation);
  return true;
}

function run(view: EditorView, session: RegexSearchSession, operation: SourceSearchOperation): void {
  const { document, query } = session;
  let selection = view.state.selection;
  const isNavigation = operation === "next" || operation === "previous";
  const navigationQueue = new Map<number, NavigationOperation>();
  let nextNavigation = 0;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sourceOffset = 0;
  let stopped = false;
  const ranges: SourceSearchRange[] = [];
  const changes: { from: number; to: number; chunks: string[] }[] = [];
  const announcements: string[][] = [];
  session.pending = true;
  session.error = undefined;
  const current = () => sessions.get(view) === session && view.state.doc === document && query.eq(getSearchQuery(view.state));
  const releaseReplacementBuffers = () => {
    changes.length = 0;
    announcements.length = 0;
  };
  const stopTransport = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    navigationQueue.clear();
    session.enqueueNavigation = undefined;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.removeEventListener("messageerror", decodeFailure);
      worker.terminate();
      worker = undefined;
    }
  };
  const feedback =
    operation === "replace-all"
      ? beginSourceReplacementFeedback(view, () => {
          stopTransport();
          releaseReplacementBuffers();
          if (session.pending && current() && selection !== view.state.selection) {
            session.error = "Source search was cancelled because the selection changed. Try again.";
          }
          session.pending = false;
        })
      : undefined;
  const cancel = () => {
    stopTransport();
    feedback?.dispose();
    releaseReplacementBuffers();
  };
  session.cancel = cancel;
  if (isNavigation) {
    session.enqueueNavigation = (next) => {
      if (stopped || !current() || selection !== view.state.selection) return false;
      navigationQueue.set(nextNavigation++, next);
      return true;
    };
  }
  const notify = () => {
    queueMicrotask(() => {
      if (current()) view.dispatch({ effects: sourceRegexSearchUpdated.of(null) });
    });
  };
  const fail = (message: string) => {
    cancel();
    if (!current()) return;
    session.pending = false;
    session.error = message;
    notify();
  };
  const decodeFailure = () => fail("Source-search response could not be decoded. Try again.");
  const send = (message: SourceSearchRequest) => {
    clearTimeout(timer);
    timer = setTimeout(() => fail("Source search timed out. Simplify the expression or try again."), SOURCE_SEARCH_TIMEOUT_MS);
    worker?.postMessage(message);
  };
  if (operation !== "count") notify();
  try {
    worker = new Worker(new URL("./sourceRegexSearch.worker.ts", import.meta.url), { type: "module" });
    worker.onerror = (event) => {
      event.preventDefault();
      fail("Source-search worker failed. Try the search again.");
    };
    worker.addEventListener("messageerror", decodeFailure);
    worker.onmessage = (event: MessageEvent<SourceSearchResponse>) => {
      if (stopped) return;
      if (!current() || (operation !== "count" && selection !== view.state.selection)) {
        cancel();
        if (current()) {
          session.pending = false;
          session.error = "Source search was cancelled because the selection changed. Try again.";
          notify();
        }
        return;
      }
      try {
        const message = event.data;
        if (message.type === "ready") {
          send({
            type: "start",
            operation,
            query: {
              wordChars: view.state.languageDataAt<string>("wordChars", selection.main.head).join(""),
              search: query.search,
              replace: query.replace,
              literal: query.literal,
              caseSensitive: query.caseSensitive,
              wholeWord: query.wholeWord,
            },
            selection: { anchor: selection.main.anchor, head: selection.main.head },
          });
        } else if (message.type === "source-ack") {
          const text = document.sliceString(sourceOffset, Math.min(document.length, sourceOffset + SOURCE_SEARCH_CHUNK_UNITS));
          sourceOffset += text.length;
          send({ type: "source", text, complete: sourceOffset === document.length });
        } else if (message.type === "ranges") {
          if (message.ranges.length > SOURCE_SEARCH_RANGE_BATCH) throw new Error("Source-search range batch exceeded its bound");
          for (const range of message.ranges) {
            if (
              !Number.isInteger(range.from) ||
              !Number.isInteger(range.to) ||
              range.from < 0 ||
              range.to < range.from ||
              range.to > document.length
            ) {
              throw new Error("Source search returned an invalid match range");
            }
            ranges.push(range);
          }
          send({ type: "ack" });
        } else if (message.type === "change") {
          if (
            message.insert.length > SOURCE_SEARCH_CHUNK_UNITS ||
            message.from < 0 ||
            message.to < message.from ||
            message.to > document.length
          ) {
            throw new Error("Source search returned an invalid replacement chunk");
          }
          if (message.continued) {
            const previous = changes.at(-1);
            if (!previous || previous.from !== message.from || previous.to !== message.to)
              throw new Error("Source-search replacement lost a chunk");
            previous.chunks.push(message.insert);
          } else changes.push({ from: message.from, to: message.to, chunks: [message.insert] });
          send({ type: "ack" });
        } else if (message.type === "announcement") {
          if (message.text.length > SOURCE_SEARCH_CHUNK_UNITS) throw new Error("Source-search announcement exceeded its chunk bound");
          if (message.continued) {
            const previous = announcements.at(-1);
            if (!previous) throw new Error("Source-search announcement lost a chunk");
            previous.push(message.text);
          } else announcements.push([message.text]);
          send({ type: "ack" });
        } else if (message.type === "error") fail(message.message);
        else if (message.type === "complete") {
          if (!isNavigation) stopTransport();
          if (operation === "count") {
            session.pending = false;
            session.ranges = ranges;
            notify();
          } else {
            const plan: ChangeSpec[] = changes.map((change) => ({ from: change.from, to: change.to, insert: change.chunks.join("") }));
            const commit = () => {
              session.pending = isNavigation && navigationQueue.size > 0;
              if (!current() || selection !== view.state.selection || (plan.length > 0 && view.state.readOnly)) return;
              const commitStart = performance.now();
              view.dispatch({
                changes: plan,
                selection: message.selection,
                scrollIntoView: Boolean(message.selection),
                effects: announcements.map((chunks) => EditorView.announce.of(chunks.join(""))),
                userEvent: message.userEvent,
              });
              performance.clearMeasures("sambee:source-search:commit");
              performance.measure("sambee:source-search:commit", {
                start: commitStart,
                detail: { operation, documentUnits: document.length, changes: plan.length },
              });
              if (isNavigation && current() && navigationQueue.size > 0) {
                selection = view.state.selection;
                const [index, next] = navigationQueue.entries().next().value!;
                navigationQueue.delete(index);
                operation = next;
                session.pending = true;
                send({
                  type: "navigate",
                  operation,
                  selection: { anchor: selection.main.anchor, head: selection.main.head },
                  wordChars: view.state.languageDataAt<string>("wordChars", selection.main.head).join(""),
                });
              } else {
                stopTransport();
                if (current() && session.ranges.length === 0) run(view, session, "count");
              }
            };
            if (feedback) {
              const insertedUnits = changes.reduce(
                (total, change) => total + change.chunks.reduce((units, chunk) => units + chunk.length, 0),
                0
              );
              feedback.apply(commit, isHeavySourceReplacement(document.length, changes.length, insertedUnits), (error) =>
                fail(error instanceof Error ? error.message : "Source replacement failed. Try Replace All again.")
              );
            } else {
              try {
                commit();
              } finally {
                releaseReplacementBuffers();
              }
            }
          }
        } else throw new Error("Unexpected source-search worker response");
      } catch (error) {
        fail(error instanceof Error ? error.message : "Source-search response failed");
      }
    };
    timer = setTimeout(() => fail("Source-search worker did not start. Try again."), SOURCE_SEARCH_TIMEOUT_MS);
  } catch {
    fail("Source search requires a working dedicated worker in this browser.");
  }
}
