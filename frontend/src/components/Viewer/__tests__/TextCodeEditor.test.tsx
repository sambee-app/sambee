import { undo } from "@codemirror/commands";
import { getSearchQuery, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView, type ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildPassiveSearchHighlightExtension } from "../../Editor/buildCodeMirrorSearchHighlights";
import type { TextEditorThemeOptions } from "../../Editor/buildTextEditorTheme";
import { findSelectedCodeMirrorSearchMatch } from "../../Editor/codeMirrorSearchMatches";
import { runSourceRegexSearchCommand, sourceRegexSearchLifecycle } from "../../Editor/sourceRegexSearch";
import { SOURCE_SEARCH_TIMEOUT_MS, type SourceSearchResponse } from "../../Editor/sourceRegexSearchProtocol";
import { getCodeMirrorFindReplaceMetrics } from "../codeMirrorFindReplace";
import { TextCodeEditor, type TextCodeEditorHandle } from "../TextCodeEditor";

const TEST_TEXT_THEME: TextEditorThemeOptions = {
  accentColor: "rgb(194, 68, 0)",
  activeLineBackground: "rgba(244, 196, 48, 0.18)",
  borderColor: "rgba(31, 38, 43, 0.16)",
  isDarkMode: false,
  otherSearchMatchBackground: "rgba(244, 196, 48, 0.18)",
  currentSearchMatchBackground: "rgba(244, 196, 48, 0.42)",
  selectionBackground: "rgba(194, 68, 0, 0.18)",
  surfaceBackground: "rgb(251, 249, 244)",
  textColor: "rgb(31, 38, 43)",
};

function mockSearchWorkers() {
  const location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage?: (event: { data: SourceSearchResponse }) => void;
    postMessage = vi.fn();
    terminate = vi.fn();
    addEventListener = vi.fn();
    constructor() {
      workers.push(this);
    }
    emit(message: SourceSearchResponse) {
      this.onmessage?.({ data: message });
    }
  }
  vi.stubGlobal("Worker", MockWorker);
  return {
    workers,
    restore: () => {
      vi.unstubAllGlobals();
      location.mockRestore();
    },
  };
}

describe("TextCodeEditor", () => {
  it("retains an unchanged regex session when passive decorations are reconfigured", () => {
    const mock = mockSearchWorkers();
    const extensions = () => [search(), sourceRegexSearchLifecycle, buildPassiveSearchHighlightExtension()];
    const view = new EditorView({ state: EditorState.create({ doc: "aa", extensions: extensions() }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      view.dispatch({ effects: StateEffect.reconfigure.of(extensions()) });
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(true);
      expect(mock.workers).toHaveLength(1);
      expect(mock.workers[0].terminate).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      mock.restore();
    }
    expect(mock.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it("publishes exact regex counts only after the final worker batch without recounting selection changes", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(true);
      const worker = mock.workers[0];
      worker.emit({ type: "ready" });
      expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ wordChars: "" }) }));
      worker.emit({ type: "source-ack" });
      worker.emit({
        type: "ranges",
        ranges: [
          { from: 0, to: 2 },
          { from: 3, to: 5 },
        ],
      });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 0, pending: true });
      worker.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      view.dispatch({ selection: { anchor: 3, head: 5 } });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 2, currentMatch: 2, pending: false });
      expect(mock.workers).toHaveLength(1);
      expect(cursor).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      cursor.mockRestore();
      view.destroy();
      mock.restore();
    }
  });

  it("allows pending navigation but rejects a replacement after selection changes away and back", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      expect(runSourceRegexSearchCommand(view, "next")).toBe(true);
      expect(mock.workers[0].terminate).toHaveBeenCalledOnce();
      mock.workers[1].emit({ type: "complete", selection: { anchor: 0, head: 2 }, announcements: [] });
      expect(view.state.selection.main.to).toBe(2);
      runSourceRegexSearchCommand(view, "replace-all");
      const worker = mock.workers.at(-1)!;
      worker.emit({ type: "change", from: 0, to: 2, insert: "replacement", continued: false });
      expect(view.state.doc.toString()).toBe("aa aa");
      view.dispatch({ selection: { anchor: 3 } });
      view.dispatch({ selection: { anchor: 0, head: 2 } });
      worker.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe("aa aa");
      expect(getCodeMirrorFindReplaceMetrics(view).error).toMatch(/selection changed/);
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("terminates a stalled regex worker and permits a fresh-worker retry", async () => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aaaa!", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "(a+)+$", regexp: true })) });
      mock.workers[0].emit({ type: "ready" });
      await vi.advanceTimersByTimeAsync(SOURCE_SEARCH_TIMEOUT_MS);
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ pending: false, matches: 0 });
      expect(getCodeMirrorFindReplaceMetrics(view).error).toMatch(/timed out/);
      expect(mock.workers[0].terminate).toHaveBeenCalledOnce();
      runSourceRegexSearchCommand(view, "next");
      expect(mock.workers).toHaveLength(2);
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ pending: true, error: undefined });
    } finally {
      view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("discards buffered replacements after a document or query revision changes", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      runSourceRegexSearchCommand(view, "replace-all");
      const staleDocument = mock.workers.at(-1)!;
      staleDocument.emit({ type: "change", from: 0, to: 2, insert: "wrong", continued: false });
      view.dispatch({ changes: { from: 0, insert: "new " } });
      staleDocument.emit({ type: "complete", announcements: [] });
      expect(view.state.doc.toString()).toBe("new aa aa");
      runSourceRegexSearchCommand(view, "replace-all");
      const staleQuery = mock.workers.at(-1)!;
      staleQuery.emit({ type: "change", from: 4, to: 6, insert: "wrong", continued: false });
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "new", regexp: true })) });
      staleQuery.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe("new aa aa");
      expect(staleDocument.terminate).toHaveBeenCalledOnce();
      expect(staleQuery.terminate).toHaveBeenCalledOnce();
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("passes native language word characters to the regex worker", () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({
        doc: "$alpha alpha",
        extensions: [search(), buildPassiveSearchHighlightExtension(), EditorState.languageData.of(() => [{ wordChars: "$" }])],
      }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", regexp: true, wholeWord: true })) });
      mock.workers[0].emit({ type: "ready" });
      expect(mock.workers[0].postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ wordChars: "$" }) })
      );
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("does not execute regex cursors on the main thread while worker results are pending", () => {
    const location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener() {}
        terminate() {}
      }
    );
    const view = new EditorView({
      state: EditorState.create({ doc: "aaaa!", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "(a+)+$", regexp: true })) });
      view.dispatch({ selection: { anchor: 0, head: 4 } });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 0, pending: true });
      expect(cursor).not.toHaveBeenCalled();
    } finally {
      cursor.mockRestore();
      view.destroy();
      vi.unstubAllGlobals();
      location.mockRestore();
    }
  });

  it("bounds cold decoration cursors to the selection or viewport and reuses warm metrics", () => {
    const passiveHighlights = buildPassiveSearchHighlightExtension();
    const view = new EditorView({
      state: EditorState.create({ doc: "word\n".repeat(6_000), extensions: [search(), passiveHighlights] }),
    });
    Object.defineProperty(view, "visibleRanges", { configurable: true, get: () => [{ from: 0, to: 20 }] });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    const refreshViewport = () => {
      const plugin = view.plugin(
        passiveHighlights as ViewPlugin<{
          update: (update: Pick<ViewUpdate, "view" | "state" | "startState" | "docChanged" | "selectionSet" | "viewportChanged">) => void;
        }>
      );
      if (!plugin) throw new Error("Expected passive search decorations");
      plugin.update({ view, state: view.state, startState: view.state, docChanged: false, selectionSet: false, viewportChanged: true });
    };
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "word" })) });
      for (const index of [0, 2_999, 5_999]) view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
      refreshViewport();
      expect(cursor.mock.calls.length).toBeGreaterThan(0);
      expect(
        cursor.mock.calls.every(
          ([, from, to]) => (from === 0 && to === 20) || [0, 2_999, 5_999].some((index) => from === index * 5 && to === index * 5 + 4)
        )
      ).toBe(true);
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(6_000);
      cursor.mockClear();
      for (const index of [0, 2_999, 5_999]) view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
      refreshViewport();
      expect(cursor.mock.calls.every(([, from, to]) => from === 0 && to === 20)).toBe(true);
    } finally {
      cursor.mockRestore();
      view.destroy();
    }
  });

  it("locates a contained active match with logarithmic range access", () => {
    const ranges = Array.from({ length: 60_000 }, (_, index) => ({ from: index * 5, to: index * 5 + 4 }));
    let reads = 0;
    const indexed = new Proxy(ranges, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(findSelectedCodeMirrorSearchMatch(indexed, { from: 299_990, to: 300_000 })).toBe(59_998);
    expect(reads).toBeLessThan(20);
    expect(findSelectedCodeMirrorSearchMatch(ranges, { from: 1, to: 4 })).toBe(-1);
    expect(findSelectedCodeMirrorSearchMatch([], { from: 0, to: 0 })).toBe(-1);
  });

  it("reuses counts across selection changes and invalidates them on edits or query changes", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "word ".repeat(6_000), extensions: [search()] }) });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "word" })) });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(6_000);
      const initialCalls = cursor.mock.calls.length;
      for (const index of [0, 2_999, 5_999]) {
        view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
        expect(getCodeMirrorFindReplaceMetrics(view).currentMatch).toBe(index + 1);
      }
      expect(cursor).toHaveBeenCalledTimes(initialCalls);
      view.dispatch({ selection: { anchor: 1, head: 9 } });
      expect(getCodeMirrorFindReplaceMetrics(view).currentMatch).toBe(2);
      expect(cursor).toHaveBeenCalledTimes(initialCalls);
      view.dispatch({ changes: { from: 0, to: 5, insert: "" } });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(5_999);
      expect(cursor.mock.calls.length).toBeGreaterThan(initialCalls);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "missing" })) });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(0);
    } finally {
      cursor.mockRestore();
      view.destroy();
    }
  });
  it("captures source snapshots and rejects capture after cancellation or unmount", async () => {
    const editorRef = createRef<TextCodeEditorHandle>();
    const { unmount } = render(
      <TextCodeEditor
        ref={editorRef}
        ariaLabel="Snapshot text"
        filename="notes.txt"
        text="latest text"
        theme={TEST_TEXT_THEME}
        onChange={() => {}}
      />
    );
    await screen.findByLabelText("Snapshot text");
    const handle = editorRef.current;
    if (!handle) throw new Error("Expected a mounted text editor");
    const snapshot = await handle.captureSnapshot();
    expect(handle.captureSnapshotSync().serialize()).toBe("latest text");
    const editor = screen.getByLabelText("Snapshot text");
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(() => handle.captureSnapshotSync()).toThrow(/composition/);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(snapshot.serialize()).toBe("latest text");
    const abort = new AbortController();
    abort.abort();
    await expect(handle.captureSnapshot(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    unmount();

    expect(snapshot.serialize()).toBe("latest text");
    expect(() => handle.captureSnapshotSync()).toThrow(/disposed/);
    await expect(handle.captureSnapshot()).rejects.toThrow(/disposed/);
  });

  it.each(["dark", "custom-alpha"])("preserves editor identity, search and undo across a %s theme change", async (variant) => {
    const text = "const alpha = 1;\n".repeat(120);
    const onChange = vi.fn();
    const props = {
      ariaLabel: "Theme text",
      filename: "sample.js",
      text,
      theme: TEST_TEXT_THEME,
      onChange,
      searchOpen: true,
      searchText: "alpha",
    };
    const { rerender } = render(<TextCodeEditor {...props} />);
    const editor = await screen.findByLabelText("Theme text");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("Expected a mounted text editor");
    await act(async () => {
      view.dispatch({ changes: { from: text.length, insert: "// draft" }, selection: { anchor: 6, head: 11 } });
    });
    const doc = view.state.doc;
    const selection = view.state.selection;
    const query = getSearchQuery(view.state);
    const metrics = getCodeMirrorFindReplaceMetrics(view);
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.scrollLeft = 30;
    onChange.mockClear();

    rerender(
      <TextCodeEditor
        {...props}
        text={doc.toString()}
        theme={{
          ...TEST_TEXT_THEME,
          isDarkMode: true,
          textColor: "rgb(240, 242, 244)",
          surfaceBackground: variant === "dark" ? "rgb(24, 26, 28)" : "rgba(24, 26, 28, 0.8)",
          selectionBackground: "rgba(60, 180, 210, 0.4)",
        }}
      />
    );

    await waitFor(() => expect(view.state.facet(EditorView.darkTheme)).toBe(true));
    expect(EditorView.findFromDOM(screen.getByLabelText("Theme text"))).toBe(view);
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection).toBe(selection);
    expect(getSearchQuery(view.state)).toBe(query);
    expect(getCodeMirrorFindReplaceMetrics(view)).toEqual(metrics);
    expect(view.scrollDOM.scrollTop).toBe(240);
    expect(view.scrollDOM.scrollLeft).toBe(30);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(text);
  });

  it("reconfigures line wrapping without recreating the editor", async () => {
    const { rerender } = render(
      <TextCodeEditor
        ariaLabel="Text editor"
        filename="notes.txt"
        lineWrapping={false}
        onChange={() => {}}
        text="A long line"
        theme={TEST_TEXT_THEME}
      />
    );

    const editor = await screen.findByLabelText("Text editor");
    expect(editor).not.toHaveClass("cm-lineWrapping");

    rerender(
      <TextCodeEditor
        ariaLabel="Text editor"
        filename="notes.txt"
        lineWrapping={true}
        onChange={() => {}}
        text="A long line"
        theme={TEST_TEXT_THEME}
      />
    );

    await waitFor(() => {
      expect(editor).toHaveClass("cm-lineWrapping");
    });
    expect(editor).toHaveTextContent("A long line");
  });

  it("replaces the selected and remaining CodeMirror search matches", async () => {
    const editorRef = createRef<TextCodeEditorHandle>();

    render(
      <TextCodeEditor
        ref={editorRef}
        ariaLabel="Text editor"
        filename="notes.txt"
        onChange={() => {}}
        searchOpen={true}
        searchReplaceText="done"
        searchText="alpha"
        text="alpha beta alpha"
        theme={TEST_TEXT_THEME}
      />
    );

    const editor = await screen.findByLabelText("Text editor");

    expect(editor.closest(".cm-editor")?.querySelector(".cm-selectionLayer")).not.toBeNull();
    expect(editor.closest(".cm-editor")?.querySelector(".sambee-editor-selection-layer")).not.toBeNull();

    editorRef.current?.replaceCurrentSearchResult();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalText()).toBe("done beta alpha");
    });

    editorRef.current?.replaceAllSearchResults();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalText()).toBe("done beta done");
    });
  });
});
