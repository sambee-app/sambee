import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { EditorView, type ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildPassiveSearchHighlightExtension } from "../../Editor/buildCodeMirrorSearchHighlights";
import type { TextEditorThemeOptions } from "../../Editor/buildTextEditorTheme";
import { findSelectedCodeMirrorSearchMatch } from "../../Editor/codeMirrorSearchMatches";
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

describe("TextCodeEditor", () => {
  it("bounds decoration cursors to the viewport with or without cached metrics", () => {
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
      expect(cursor.mock.calls.every(([, from, to]) => from === 0 && to === 20)).toBe(true);
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
