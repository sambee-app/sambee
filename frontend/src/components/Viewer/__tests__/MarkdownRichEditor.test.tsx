import { EditorView } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { authSession } from "../../../services/authSession";
import { createDraftCheckpointController, DRAFT_TRANSITION_FLUSH_MS } from "../../../services/draftCheckpoint";
import { loadDraft } from "../../../services/draftRecovery";
import type { MarkdownEditorThemeOptions } from "../../Editor/buildMarkdownEditorTheme";
import MarkdownRichEditor, { type MarkdownRichEditorHandle, type MarkdownRichEditorSearchState } from "../MarkdownRichEditor";

const TEST_MARKDOWN_THEME: MarkdownEditorThemeOptions = {
  activeLineBackground: "rgba(244, 196, 48, 0.18)",
  borderColor: "rgba(31, 38, 43, 0.16)",
  isDarkMode: false,
  linkColor: "rgb(194, 68, 0)",
  selectionBackground: "rgba(194, 68, 0, 0.18)",
  surfaceBackground: "rgb(251, 249, 244)",
  tableAlternateRowBackground: "rgb(245, 243, 238)",
  tableBackground: "rgb(251, 249, 244)",
  tableBorderColor: "rgb(212, 196, 174)",
  tableHeaderBackground: "rgb(234, 232, 227)",
  tableHeaderText: "rgb(31, 38, 43)",
  textColor: "rgb(31, 38, 43)",
};

function appendNestedEditorTarget(editor: HTMLElement): HTMLElement {
  const editorRoot = editor.closest(".cm-editor");

  if (!(editorRoot instanceof HTMLElement)) {
    throw new Error("Expected the CodeMirror editor root to be rendered");
  }

  const nestedEditor = document.createElement("div");
  nestedEditor.className = "tbl-cell-editor";

  const nestedEditable = document.createElement("div");
  nestedEditable.contentEditable = "true";
  nestedEditable.setAttribute("role", "textbox");
  nestedEditor.appendChild(nestedEditable);
  editorRoot.appendChild(nestedEditor);

  return nestedEditable;
}

function signalClipboardPreflight(nested: HTMLElement, clipboardEvent: string): void {
  const root = nested.closest(".tbl-table-widget")?.closest(".cm-editor");
  if (!root) throw new Error("Expected the root Markdown editor around a real table widget");
  root.addEventListener(clipboardEvent, (event) => event.stopImmediatePropagation(), { capture: true, once: true });
  nested.dispatchEvent(new Event(clipboardEvent, { bubbles: true }));
}

describe("MarkdownRichEditor", () => {
  it.each([true, false])("captures only final composition text with publication before compositionend %s", async (publishedBeforeEnd) => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Nested composition"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const view = nested && EditorView.findFromDOM(nested);
    const handle = editorRef.current;
    if (!nested || !view || !handle) throw new Error("Expected a mounted nested composition editor");
    nested.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(() => handle.captureSnapshotSync()).toThrow(/composition/);
    await expect(handle.captureSnapshot()).rejects.toMatchObject({ name: "InvalidStateError" });
    nested.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "intermediate", isComposing: true })
    );
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "intermediate" }, userEvent: "input.type.compose" });
    });
    await waitFor(() => expect(handle.getCanonicalMarkdown()).toContain("intermediate"));
    await expect(handle.captureSnapshot()).rejects.toMatchObject({ name: "InvalidStateError" });
    const publishFinal = async () => {
      nested.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "finished", isComposing: true })
      );
      await act(async () => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "finished" }, userEvent: "input.type.compose" });
      });
    };
    if (publishedBeforeEnd) {
      await publishFinal();
      await waitFor(() => expect(handle.getCanonicalMarkdown()).toContain("finished"));
    }
    nested.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "finished" }));
    const snapshot = handle.captureSnapshot();
    if (!publishedBeforeEnd) await publishFinal();

    expect((await snapshot).serialize()).toContain("finished");
    expect((await snapshot).serialize()).not.toContain("intermediate");
    expect(handle.captureSnapshotSync().serialize()).toContain("finished");
  });

  it("does not acknowledge a finished composition while its root publication is stalled", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Stalled composition"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const root = nested?.closest(".tbl-table-widget")?.closest<HTMLElement>(".cm-editor");
    const view = nested && EditorView.findFromDOM(nested);
    const rootView = root && EditorView.findFromDOM(root);
    const handle = editorRef.current;
    if (!nested || !view || !rootView || !handle) throw new Error("Expected mounted nested and root editors");
    const dispatch = vi.spyOn(rootView, "dispatch").mockImplementation(() => {});
    const controller = new AbortController();
    try {
      nested.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      nested.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "finished", isComposing: true })
      );
      await act(async () => {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "finished" }, userEvent: "input.type.compose" });
      });
      nested.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "finished" }));
      expect(() => handle.captureSnapshotSync()).toThrow(/publishing/);
      const captured = vi.fn();
      const pending = handle.captureSnapshot(controller.signal).then(captured);
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await Promise.resolve();
      expect(captured).not.toHaveBeenCalled();
      expect(handle.getCanonicalMarkdown()).not.toContain("finished");
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      dispatch.mockRestore();
    }
  });

  it("captures unchanged source after an empty nested composition ends", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Empty composition"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const handle = editorRef.current;
    if (!nested || !handle) throw new Error("Expected a mounted nested editor");
    const original = await handle.captureSnapshot();
    nested.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await expect(handle.captureSnapshot()).rejects.toMatchObject({ name: "InvalidStateError" });
    nested.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));

    const snapshot = await handle.captureSnapshot();
    expect(snapshot.serialize()).toBe(original.serialize());
    expect(snapshot.revision).toBe(original.revision);
  });

  it.each([
    { whitespace: " ", clipboardEvent: null, inputType: "insertText" },
    { whitespace: "\t", clipboardEvent: null, inputType: "insertText" },
    { whitespace: "\n", clipboardEvent: null, inputType: "insertText" },
    { whitespace: " ", clipboardEvent: "paste", inputType: "insertFromPaste" },
    { whitespace: " ", clipboardEvent: "cut", inputType: "deleteByCut" },
  ])("captures the unchanged root after $inputType with whitespace $whitespace", async ({ whitespace, clipboardEvent, inputType }) => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Nested Markdown"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const nestedView = nested && EditorView.findFromDOM(nested);
    const handle = editorRef.current;
    if (!nested || !nestedView || !handle) throw new Error("Expected a mounted nested table editor");
    if (clipboardEvent === "cut") {
      nestedView.dispatch({ changes: { from: nestedView.state.doc.length, insert: whitespace }, userEvent: "input" });
    }
    const original = await handle.captureSnapshot();
    if (clipboardEvent) {
      signalClipboardPreflight(nested, clipboardEvent);
    }
    nested.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data: whitespace }));
    nestedView.dispatch({
      changes:
        clipboardEvent === "cut"
          ? { from: nestedView.state.doc.length - whitespace.length, to: nestedView.state.doc.length }
          : { from: nestedView.state.doc.length, insert: whitespace },
      userEvent: "input",
    });
    await Promise.resolve();
    vi.useFakeTimers();
    try {
      const [snapshot] = await Promise.all([handle.captureSnapshot(), vi.advanceTimersByTimeAsync(DRAFT_TRANSITION_FLUSH_MS)]);
      expect(snapshot.serialize()).toBe(original.serialize());
      expect(snapshot.revision).toBe(original.revision);
      expect(handle.getCanonicalMarkdown()).toBe(original.serialize());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    nestedView.dispatch({ changes: { from: 0, to: nestedView.state.doc.length, insert: "recovered" }, userEvent: "input" });
    expect((await handle.captureSnapshot()).serialize()).toContain("recovered");
  });

  it.each([null, "paste"])("does not acknowledge an older unpublished input after clipboard preflight %j", async (clipboardEvent) => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Nested Markdown"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const nestedView = nested && EditorView.findFromDOM(nested);
    const handle = editorRef.current;
    if (!nested || !nestedView || !handle) throw new Error("Expected a mounted nested table editor");
    appendNestedEditorTarget(screen.getByLabelText("Nested Markdown")).dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "pending" })
    );
    if (clipboardEvent) signalClipboardPreflight(nested, clipboardEvent);
    nested.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: clipboardEvent ? "insertFromPaste" : "insertText", data: " " })
    );
    nestedView.dispatch({ changes: { from: nestedView.state.doc.length, insert: " " }, userEvent: "input" });
    vi.useFakeTimers();
    try {
      await Promise.all([
        expect(handle.captureSnapshot()).rejects.toMatchObject({ name: "TimeoutError" }),
        vi.advanceTimersByTimeAsync(DRAFT_TRANSITION_FLUSH_MS),
      ]);
      expect(handle.getCanonicalMarkdown()).toContain("foo");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { inputType: "insertText", interveningChange: false },
    { inputType: "deleteByCut", interveningChange: false },
    { inputType: "insertFromPaste", interveningChange: true },
  ])(
    "keeps clipboard input pending for $inputType with intervening change $interveningChange",
    async ({ inputType, interveningChange }) => {
      const user = userEvent.setup();
      const editorRef = createRef<MarkdownRichEditorHandle>();
      render(
        <MarkdownRichEditor
          ref={editorRef}
          markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
          ariaLabel="Nested Markdown"
          theme={TEST_MARKDOWN_THEME}
          onChange={() => {}}
        />
      );
      await user.click(await screen.findByText("foo"));
      await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
      const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
      const nestedView = nested && EditorView.findFromDOM(nested);
      const rootView = EditorView.findFromDOM(screen.getByLabelText("Nested Markdown"));
      const handle = editorRef.current;
      if (!nested || !nestedView || !rootView || !handle) throw new Error("Expected mounted root and nested editors");
      const dispatch = vi.spyOn(rootView, "dispatch").mockImplementation(() => {});
      try {
        signalClipboardPreflight(nested, "paste");
        if (interveningChange) {
          nestedView.dispatch({ changes: { from: 0, to: nestedView.state.doc.length, insert: "unpublished" }, userEvent: "input" });
          await Promise.resolve();
        }
        nested.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data: " " }));
        nestedView.dispatch({ changes: { from: nestedView.state.doc.length, insert: " " }, userEvent: "input" });
        vi.useFakeTimers();
        await Promise.all([
          expect(handle.captureSnapshot()).rejects.toMatchObject({ name: "TimeoutError" }),
          vi.advanceTimersByTimeAsync(DRAFT_TRANSITION_FLUSH_MS),
        ]);
        expect(handle.getCanonicalMarkdown()).toContain("foo");
        expect(handle.getCanonicalMarkdown()).not.toContain("unpublished");
      } finally {
        vi.useRealTimers();
        dispatch.mockRestore();
      }
    }
  );

  it("captures an edit published by the real nested table editor", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"Intro\n\n| A |\n| - |\n| foo |\n\ntail"}
        ariaLabel="Nested Markdown"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    await user.click(await screen.findByText("foo"));
    await waitFor(() => expect(document.querySelector(".tbl-cell-editor .cm-content")).not.toBeNull());
    const nested = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const nestedView = nested && EditorView.findFromDOM(nested);
    if (!nested || !nestedView) throw new Error("Expected the real nested CodeMirror editor");
    nested.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "changed" }));
    const snapshot = editorRef.current?.captureSnapshot();
    nestedView.dispatch({ changes: { from: 0, to: nestedView.state.doc.length, insert: "changed" }, userEvent: "input" });

    expect((await snapshot)?.serialize()).toContain("changed");
    expect((await snapshot)?.serialize()).not.toContain("foo");
  });

  it("keeps snapshot source and canonical table formatting stable across later edits", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const markdown = "Intro\n\n| A |\n| - |\n| foo<br />bar |\n\ntail";
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={markdown}
        ariaLabel="Snapshot Markdown"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    const editor = await screen.findByLabelText("Snapshot Markdown");
    const snapshot = await editorRef.current?.captureSnapshot();
    expect(snapshot?.serialize()).toBe(markdown);

    await user.click(editor);
    await user.keyboard("{Control>}{End}{/Control}!");
    const latest = await editorRef.current?.captureSnapshot();
    expect(snapshot?.serialize()).toBe(markdown);
    expect(latest?.revision).toBeGreaterThan(snapshot?.revision ?? -1);
    expect(latest?.serialize()).toContain("foo<br />bar");
    expect(latest?.serialize()).toContain("!");
  });

  it("persists a latest-revision checkpoint only after nested Markdown publication", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    authSession.setAuthenticated(
      { access_token: "test", token_type: "bearer", user_id: "editor-snapshot-user", username: "snapshot-user" },
      false
    );
    const controller = createDraftCheckpointController("snapshot-connection", "/note.md", "markdown");
    try {
      render(
        <MarkdownRichEditor
          ref={editorRef}
          markdown="alpha"
          ariaLabel="Snapshot Markdown"
          theme={TEST_MARKDOWN_THEME}
          onChange={() => {}}
        />
      );
      const editor = await screen.findByLabelText("Snapshot Markdown");
      const nested = appendNestedEditorTarget(editor);
      nested.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "!" }));
      const handle = editorRef.current;
      if (!handle) throw new Error("Expected a mounted Markdown editor");
      controller.request(1, async (signal) => {
        const snapshot = await handle.captureSnapshot(signal);
        expect(snapshot.revision).toBe(1);
        return { baseline: "alpha", content: snapshot.serialize() };
      });
      let acknowledged = false;
      const flush = controller.flush().then((outcome) => {
        acknowledged = outcome.saved;
        return outcome;
      });
      await Promise.resolve();
      expect(acknowledged).toBe(false);
      expect(loadDraft("snapshot-connection", "/note.md", "markdown")).toBeNull();
      await user.click(editor);
      await user.keyboard("!");

      await expect(flush).resolves.toEqual({ saved: true, revision: 1 });
      expect(loadDraft("snapshot-connection", "/note.md", "markdown")?.content).toBe(handle.getCanonicalMarkdown());
      expect(loadDraft("snapshot-connection", "/note.md", "markdown")?.content).toContain("!");
    } finally {
      controller.dispose();
      authSession.clear();
      sessionStorage.clear();
    }
  });

  it("cancels a pending snapshot without cancelling shared nested publication", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor ref={editorRef} markdown="alpha" ariaLabel="Snapshot Markdown" theme={TEST_MARKDOWN_THEME} onChange={() => {}} />
    );
    const editor = await screen.findByLabelText("Snapshot Markdown");
    appendNestedEditorTarget(editor).dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "!" }));
    const abort = new AbortController();
    const cancelled = editorRef.current?.captureSnapshot(abort.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const current = editorRef.current?.captureSnapshot();
    abort.abort();
    await rejection;
    await user.click(editor);
    await user.keyboard("!");

    expect((await current)?.serialize()).toContain("!");
  });

  it("rejects a pending snapshot when its editor unmounts instead of returning empty source", async () => {
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const { unmount } = render(
      <MarkdownRichEditor ref={editorRef} markdown="alpha" ariaLabel="Snapshot Markdown" theme={TEST_MARKDOWN_THEME} onChange={() => {}} />
    );
    const editor = await screen.findByLabelText("Snapshot Markdown");
    appendNestedEditorTarget(editor).dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "!" }));
    const snapshot = editorRef.current?.captureSnapshot();
    const rejection = expect(snapshot).rejects.toThrow(/disposed/);
    unmount();

    await rejection;
  });

  it("reconfigures ordinary Markdown line wrapping", async () => {
    const { rerender } = render(
      <MarkdownRichEditor
        ariaLabel="Markdown editor"
        lineWrapping={true}
        markdown="A long line"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    expect(editor).toHaveClass("cm-lineWrapping");

    rerender(
      <MarkdownRichEditor
        ariaLabel="Markdown editor"
        lineWrapping={false}
        markdown="A long line"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );

    await waitFor(() => {
      expect(editor).not.toHaveClass("cm-lineWrapping");
    });
    expect(editor).toHaveTextContent("A long line");
  });

  it("reports source-mode search state and navigates matches", async () => {
    const states: MarkdownRichEditorSearchState[] = [];

    render(
      <MarkdownRichEditor
        markdown="alpha\nbeta alpha"
        ariaLabel="Markdown editor"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
        searchText="alpha"
        searchOpen={true}
        onSearchStateChange={(state) => {
          states.push(state);
        }}
      />
    );

    await waitFor(() => {
      expect(states.length).toBeGreaterThan(0);
    });

    const latestState = states.at(-1);
    expect(latestState).toMatchObject({
      searchText: "alpha",
      isSearchOpen: true,
      isSearchable: true,
      viewMode: "source",
    });
    expect(latestState?.searchMatches).toBe(2);
  });

  it("replaces the active match and all remaining matches through the command bridge", async () => {
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(
      <>
        <input aria-label="Replace" />
        <MarkdownRichEditor
          ref={editorRef}
          markdown="alpha beta alpha"
          ariaLabel="Markdown editor"
          theme={TEST_MARKDOWN_THEME}
          onChange={() => {}}
          searchOpen={true}
          searchReplaceText="done"
          searchText="alpha"
        />
      </>
    );

    await screen.findByLabelText("Markdown editor");

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalMarkdown()).toBe("alpha beta alpha");
    });

    const replaceInput = screen.getByRole("textbox", { name: "Replace" });
    replaceInput.focus();
    editorRef.current?.replaceCurrentSearchResult();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalMarkdown()).toBe("done beta alpha");
    });
    expect(replaceInput).toHaveFocus();

    editorRef.current?.replaceAllSearchResults();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalMarkdown()).toBe("done beta done");
    });
    expect(replaceInput).toHaveFocus();
  });

  it("supports the command bridge methods", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(
      <MarkdownRichEditor ref={editorRef} markdown="alpha" ariaLabel="Markdown editor" theme={TEST_MARKDOWN_THEME} onChange={onChange} />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    await user.click(editor);

    editorRef.current?.createLink();

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    expect(editorRef.current?.getCanonicalMarkdown()).toContain("[");
    editorRef.current?.insertTable();
    expect(editorRef.current?.getCanonicalMarkdown()).toContain("|   |   |");
    expect(editorRef.current?.getCanonicalMarkdown()).toContain("| - | - |");
    expect(editorRef.current?.getCanonicalMarkdown()).not.toContain("Column 1");
    editorRef.current?.toggleInlineCode();
    editorRef.current?.insertCodeBlock();
    editorRef.current?.insertThematicBreak();
  });

  it("toggles bold and italic Markdown delimiters", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(
      <MarkdownRichEditor ref={editorRef} markdown="text" ariaLabel="Markdown editor" theme={TEST_MARKDOWN_THEME} onChange={() => {}} />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}");

    editorRef.current?.toggleBold();
    expect(editorRef.current?.getCanonicalMarkdown()).toBe("**text**");

    editorRef.current?.toggleBold();
    expect(editorRef.current?.getCanonicalMarkdown()).toBe("text");

    editorRef.current?.toggleItalic();
    expect(editorRef.current?.getCanonicalMarkdown()).toBe("*text*");

    editorRef.current?.toggleItalic();
    expect(editorRef.current?.getCanonicalMarkdown()).toBe("text");
  });

  it("keeps canonical table-cell breaks at the editor boundary", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={["| Column |", "| --- |", "| foo<br />bar |", "", "tail"].join("\n")}
        ariaLabel="Markdown editor"
        theme={TEST_MARKDOWN_THEME}
        onChange={onChange}
      />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    await user.click(editor);
    await user.keyboard("!");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    expect(editorRef.current?.getCanonicalMarkdown()).toContain("foo<br />bar");
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("foo<br />bar");
    expect(onChange.mock.calls.at(-1)?.[0]).not.toContain("foo<br>bar");
  });

  it("preserves unrelated markdown formatting while adapting table-cell breaks for the editor", async () => {
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const markdown = ["Outside <br /> stays literal.", "", "- one", "- two", "", "| A |", "| - |", "| foo<br />bar |", ""].join("\n");

    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={markdown}
        diffMarkdown={markdown}
        ariaLabel="Markdown editor"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );

    await screen.findByLabelText("Markdown editor");

    expect(editorRef.current?.getCanonicalMarkdown()).toBe(markdown);
  });

  it("keeps focus in the editor when tabbing indentation in markdown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(<MarkdownRichEditor ref={editorRef} markdown="" ariaLabel="Markdown editor" theme={TEST_MARKDOWN_THEME} onChange={onChange} />);

    const editor = await screen.findByLabelText("Markdown editor");
    await user.click(editor);

    await user.keyboard("{Tab}");

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalMarkdown()).toBe("  ");
    });

    expect(document.activeElement).toBe(editor);

    await user.keyboard("{Shift>}{Tab}{/Shift}");

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalMarkdown()).toBe("");
    });

    expect(document.activeElement).toBe(editor);
  });

  it("waits for the next root publication after a nested table edit signal", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const editorRef = createRef<MarkdownRichEditorHandle>();

    render(
      <MarkdownRichEditor ref={editorRef} markdown="alpha" ariaLabel="Markdown editor" theme={TEST_MARKDOWN_THEME} onChange={onChange} />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    const nestedEditable = appendNestedEditorTarget(editor);

    nestedEditable.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "x" }));

    let flushResolved = false;
    const flushPromise = editorRef.current?.flushPendingEdits().then(() => {
      flushResolved = true;
    });

    await Promise.resolve();
    expect(flushResolved).toBe(false);

    await user.click(editor);
    await user.keyboard("!");

    await flushPromise;

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    expect(flushResolved).toBe(true);
    expect(editorRef.current?.getCanonicalMarkdown()).toContain("!");
  });

  it("keeps root search metrics and navigation authoritative while focus is inside a nested table editor subtree", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const states: MarkdownRichEditorSearchState[] = [];

    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown="alpha\nbeta alpha"
        ariaLabel="Markdown editor"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
        searchText="alpha"
        searchOpen={true}
        onSearchStateChange={(state) => {
          states.push(state);
        }}
      />
    );

    const editor = await screen.findByLabelText("Markdown editor");
    const nestedEditable = appendNestedEditorTarget(editor);
    nestedEditable.focus();
    await user.click(nestedEditable);

    await waitFor(() => {
      expect(states.at(-1)).toMatchObject({
        searchText: "alpha",
        searchMatches: 2,
        currentMatch: 1,
        isSearchOpen: true,
      });
    });

    editorRef.current?.nextSearchResult();

    await waitFor(() => {
      expect(states.at(-1)?.currentMatch).toBe(2);
      expect(states.at(-1)?.searchMatches).toBe(2);
    });

    editorRef.current?.previousSearchResult();

    await waitFor(() => {
      expect(states.at(-1)?.currentMatch).toBe(1);
      expect(states.at(-1)?.searchMatches).toBe(2);
    });
  });
});
