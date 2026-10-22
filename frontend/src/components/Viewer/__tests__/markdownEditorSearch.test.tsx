import { findNext, findPrevious, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  buildPassiveSearchHighlightExtension,
  PASSIVE_SEARCH_MATCH_CLASS,
  PASSIVE_SELECTED_SEARCH_MATCH_CLASS,
} from "../../Editor/buildCodeMirrorSearchHighlights";
import { buildCommonEditorExtensions } from "../../Editor/buildCommonEditorExtensions";
import { SourceTextEditor } from "../../Editor/SourceTextEditor";
import type { SourceTextEditorHandle } from "../../Editor/sourceTextEditorTypes";
import {
  getCodeMirrorFindReplaceMetrics as getRootSearchMetrics,
  shouldAutoNavigateCodeMirrorFindReplace as shouldAutoNavigateSearch,
  updateCodeMirrorFindReplaceQuery as updateRootSearchQuery,
} from "../codeMirrorFindReplace";

const DEFAULT_SEARCH_OPTIONS = {
  caseSensitive: false,
  regexp: false,
  replace: "",
  wholeWord: false,
};

describe("codeMirrorFindReplace", () => {
  it("counts root-editor matches and tracks the active match across navigation", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="alpha\nbeta alpha"
        extensions={buildCommonEditorExtensions()}
        ariaLabel="Search editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Search editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "alpha" });

    expect(findNext(view)).toBe(true);

    await waitFor(() => {
      expect(getRootSearchMetrics(view)).toMatchObject({
        matches: 2,
        currentMatch: 1,
        searchText: "alpha",
        isSearchable: true,
      });
    });

    expect(findNext(view)).toBe(true);

    await waitFor(() => {
      expect(getRootSearchMetrics(view).currentMatch).toBe(2);
    });

    expect(findPrevious(view)).toBe(true);

    await waitFor(() => {
      expect(getRootSearchMetrics(view).currentMatch).toBe(1);
    });
  });

  it("keeps search metrics rooted in the editor view even when focus moves elsewhere", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <>
        <SourceTextEditor
          ref={editorRef}
          value="alpha\nbeta alpha"
          extensions={buildCommonEditorExtensions()}
          ariaLabel="Search editor"
          onChange={() => {}}
        />
        <input aria-label="External focus target" />
      </>
    );

    const editor = await screen.findByLabelText("Search editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "alpha" });
    expect(findNext(view)).toBe(true);

    const input = await screen.findByLabelText("External focus target");
    await user.click(input);

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
      expect(getRootSearchMetrics(view)).toMatchObject({
        matches: 2,
        currentMatch: 1,
        searchText: "alpha",
      });
    });

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "" });

    await waitFor(() => {
      expect(getRootSearchMetrics(view)).toMatchObject({
        matches: 0,
        currentMatch: 0,
        searchText: "",
      });
    });
  });

  it("only auto-navigates when a newly opened or changed search request asks for it", () => {
    const alphaOpen = { caseSensitive: false, regexp: false, searchText: "alpha", searchOpen: true, wholeWord: false };
    const alphaClosed = { ...alphaOpen, searchOpen: false };
    const betaOpen = { ...alphaOpen, searchText: "beta" };

    expect(shouldAutoNavigateSearch(null, alphaOpen, true)).toBe(true);
    expect(shouldAutoNavigateSearch(alphaOpen, alphaOpen, true)).toBe(false);
    expect(shouldAutoNavigateSearch(alphaClosed, alphaOpen, true)).toBe(true);
    expect(shouldAutoNavigateSearch(alphaOpen, betaOpen, true)).toBe(true);
    expect(shouldAutoNavigateSearch(null, alphaOpen, false)).toBe(false);
  });

  it("highlights passive matches while typing before native search navigation selects one", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="alpha\nbeta alpha"
        extensions={[...buildCommonEditorExtensions({ highlightSelectionMatches: false }), buildPassiveSearchHighlightExtension()]}
        ariaLabel="Search editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Search editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "alpha" });

    await waitFor(() => {
      expect(editor.querySelectorAll(`.${PASSIVE_SEARCH_MATCH_CLASS}`)).toHaveLength(2);
      expect(editor.querySelectorAll(`.${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`)).toHaveLength(0);
    });

    expect(findNext(view)).toBe(true);

    await waitFor(() => {
      expect(editor.querySelectorAll(`.${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`)).toHaveLength(1);
      expect(editor.querySelectorAll(`.${PASSIVE_SEARCH_MATCH_CLASS}`)).toHaveLength(2);
      expect(editor.querySelectorAll(".cm-selectionMatch")).toHaveLength(0);
    });
  });

  it("treats the first contained match as current when the main selection is broader than the search hit", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="* list 1\n* list 2\n* list 3"
        extensions={[...buildCommonEditorExtensions({ highlightSelectionMatches: false }), buildPassiveSearchHighlightExtension()]}
        ariaLabel="Search editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Search editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({
      selection: EditorSelection.range(0, 8),
    });

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "li" });

    await waitFor(() => {
      expect(getRootSearchMetrics(view)).toMatchObject({
        matches: 3,
        currentMatch: 1,
        searchText: "li",
      });
      expect(editor.querySelectorAll(`.${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`)).toHaveLength(1);
    });

    expect(findNext(view)).toBe(true);

    await waitFor(() => {
      expect(getRootSearchMetrics(view).currentMatch).toBe(2);
    });
  });

  it("keeps a current-match decoration when the search panel is open and the current match is only contained by the selection", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="* list 1\n* list 2\n* list 3"
        extensions={[...buildCommonEditorExtensions({ highlightSelectionMatches: false }), buildPassiveSearchHighlightExtension()]}
        ariaLabel="Search editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Search editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({
      selection: EditorSelection.range(0, 8),
    });

    expect(openSearchPanel(view)).toBe(true);
    expect(searchPanelOpen(view.state)).toBe(true);

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "li" });

    await waitFor(() => {
      expect(getRootSearchMetrics(view)).toMatchObject({
        matches: 3,
        currentMatch: 1,
        searchText: "li",
      });
      expect(editor.querySelectorAll(`.${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`)).toHaveLength(1);
      expect(editor.querySelectorAll(`.${PASSIVE_SEARCH_MATCH_CLASS}`)).toHaveLength(1);
    });
  });

  it("honors case-sensitive, whole-word, and regular-expression query options", async () => {
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="Alpha alpha alphabet alpha2"
        extensions={buildCommonEditorExtensions()}
        ariaLabel="Search editor"
        onChange={() => {}}
      />
    );

    await screen.findByLabelText("Search editor");
    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, searchText: "alpha", wholeWord: true });
    expect(getRootSearchMetrics(view)).toMatchObject({ isValid: true, matches: 2 });

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, caseSensitive: true, searchText: "alpha", wholeWord: true });
    expect(getRootSearchMetrics(view)).toMatchObject({ isValid: true, matches: 1 });

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, regexp: true, searchText: "alpha\\d" });
    expect(getRootSearchMetrics(view)).toMatchObject({ isValid: true, matches: 0 });
    expect(getRootSearchMetrics(view).error).toMatch(/worker/i);

    updateRootSearchQuery(view, { ...DEFAULT_SEARCH_OPTIONS, regexp: true, searchText: "(" });
    expect(getRootSearchMetrics(view)).toMatchObject({ isValid: false, matches: 0 });
  });
});
