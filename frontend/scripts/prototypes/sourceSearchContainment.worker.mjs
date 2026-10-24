import { history, undo } from "@codemirror/commands";
import { findNext, findPrevious, replaceAll, replaceNext, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";

export function executeSourceSearchProof(request) {
  let state = EditorState.create({ doc: request.source, extensions: [search(), history()] });
  const query = new SearchQuery({ search: request.query, regexp: true, literal: true, replace: request.replace ?? "" });
  if (!query.valid) throw new Error("Invalid source-search expression");
  state = state.update({ effects: setSearchQuery.of(query), selection: request.selection ?? { anchor: 0 } }).state;
  let edits = 0;
  const target = {
    get state() {
      return state;
    },
    plugin: () => null,
    dispatch: (transaction) => {
      const applied = transaction.state ? transaction : state.update(transaction);
      if (applied.docChanged) edits += 1;
      state = applied.state;
    },
  };
  let count = null;
  if (["count", "active-range", "visible-matches"].includes(request.operation)) {
    count = 0;
    const bounds = request.operation === "visible-matches" ? [0, state.doc.length] : [];
    const cursor = query.getCursor(state, ...bounds);
    for (let result = cursor.next(); !result.done; result = cursor.next()) count += 1;
  } else {
    const command = { next: findNext, previous: findPrevious, "replace-one": replaceNext, "replace-all": replaceAll }[request.operation];
    if (!command) throw new Error("Unknown source-search operation");
    command(target);
  }
  const content = state.doc.toString();
  const selection = { from: state.selection.main.from, to: state.selection.main.to };
  const changes = edits;
  const undone = request.operation === "replace-all" && undo(target);
  return { content, selection, count, edits: changes, undone, undoContent: state.doc.toString() };
}

if (typeof globalThis.postMessage === "function") {
  globalThis.onmessage = (event) => {
    try {
      globalThis.postMessage({ result: executeSourceSearchProof(event.data) });
    } catch (error) {
      globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  globalThis.postMessage({ ready: true });
}
