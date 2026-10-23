import { undo } from "@codemirror/commands";
import { getSearchQuery } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authSession } from "../../../services/authSession";
import { createDraftCheckpointController, DRAFT_TRANSITION_FLUSH_MS } from "../../../services/draftCheckpoint";
import { loadDraft } from "../../../services/draftRecovery";
import type { PreparationRequest, PreparationResponse } from "../../../utils/markdownCodePreparation";
import type { MarkdownEditorThemeOptions } from "../../Editor/buildMarkdownEditorTheme";
import { getCodeMirrorFindReplaceMetrics } from "../codeMirrorFindReplace";
import MarkdownRichEditor, {
  MARKDOWN_SOURCE_MEASURES,
  type MarkdownRichEditorHandle,
  type MarkdownRichEditorSearchState,
} from "../MarkdownRichEditor";
import { normalizeMarkdownTableCellLineBreaks, preserveUnchangedMarkdownTableSource } from "../markdownTableCellLineBreaks";

class EditNormalizationWorker extends EventTarget {
  static instances: EditNormalizationWorker[] = [];
  static hold = false;
  onmessage: ((event: MessageEvent<PreparationResponse>) => void) | null = null;
  source = "";
  baseline = "";
  preserveTableSource = false;
  preserveOnly = false;
  generation = 0;
  terminated = false;
  constructor() {
    super();
    EditNormalizationWorker.instances.push(this);
  }
  postMessage(message: PreparationRequest) {
    queueMicrotask(() => {
      if (this.terminated) return;
      this.generation = message.generation;
      if (message.type === "prepare") {
        this.preserveTableSource = message.preserveTableSource === true;
        this.preserveOnly = message.preserveOnly === true;
        this.receive({ type: "source-ack", generation: this.generation, sequence: 0 });
      } else if (message.type === "source") {
        if (message.block === 0) this.source += message.text;
        else this.baseline += message.text;
        this.receive({ type: "source-ack", generation: this.generation, sequence: message.sequence });
      } else if (message.type === "run" && !EditNormalizationWorker.hold) this.complete();
    });
  }
  receive(response: PreparationResponse) {
    this.onmessage?.(new MessageEvent("message", { data: response }));
  }
  complete() {
    const normalized = this.preserveOnly ? this.source : normalizeMarkdownTableCellLineBreaks(this.source);
    this.receive({
      type: "normalized-source",
      generation: this.generation,
      sequence: 1,
      text: this.preserveTableSource ? preserveUnchangedMarkdownTableSource(this.baseline, normalized) : normalized,
      final: true,
    });
    this.receive({ type: "complete", generation: this.generation, preparationMs: 1 });
  }
  terminate() {
    this.terminated = true;
  }
}

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
  let location: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    EditNormalizationWorker.instances = [];
    EditNormalizationWorker.hold = false;
    vi.stubGlobal("Worker", EditNormalizationWorker);
    location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
  });
  afterEach(() => {
    location.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps edits pending until only the latest worker revision is published and flushed", async () => {
    EditNormalizationWorker.hold = true;
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const onChange = vi.fn();
    const onNormalizationStateChange = vi.fn();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown="start"
        ariaLabel="Worker Markdown"
        theme={TEST_MARKDOWN_THEME}
        onChange={onChange}
        onNormalizationStateChange={onNormalizationStateChange}
      />
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Worker Markdown"));
    const handle = editorRef.current;
    if (!view || !handle) throw new Error("Expected a mounted Markdown editor");
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "| A |\n| - |\n| first<br>second |\n" }, userEvent: "input" })
    );
    await waitFor(() => expect(EditNormalizationWorker.instances[0].source).toContain("first<br>second"));
    expect(onNormalizationStateChange).toHaveBeenLastCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(() => handle.captureSnapshotSync()).toThrow(/normalization/);
    const captured = handle.captureSnapshot();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "latest" }, userEvent: "input" }));
    await act(async () => EditNormalizationWorker.instances[0].complete());
    await waitFor(() => expect(EditNormalizationWorker.instances[1].source).toContain("latest"));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => EditNormalizationWorker.instances[1].complete());
    const snapshot = await captured;
    expect(snapshot.serialize()).toContain("first<br />second");
    expect(snapshot.serialize()).toContain("latest");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onNormalizationStateChange).toHaveBeenLastCalledWith(false);
    expect(view.state.doc.toString()).toContain("first<br>second");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " newer" }, userEvent: "input" }));
    expect(snapshot.serialize()).not.toContain("newer");
    expect(() => handle.captureSnapshotSync()).toThrow(/normalization/);
  });

  it("keeps failed normalization dirty and retries only on an explicit snapshot request", async () => {
    EditNormalizationWorker.hold = true;
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const onChange = vi.fn();
    const onNormalizationStateChange = vi.fn();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown="start"
        ariaLabel="Failed worker"
        theme={TEST_MARKDOWN_THEME}
        onChange={onChange}
        onNormalizationStateChange={onNormalizationStateChange}
      />
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Failed worker"));
    const handle = editorRef.current;
    if (!view || !handle) throw new Error("Expected the Markdown editor");
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "first<br>second" }, userEvent: "input" }));
    await waitFor(() => expect(EditNormalizationWorker.instances[0].source).toContain("first<br>second"));
    const worker = EditNormalizationWorker.instances[0];
    await act(async () => worker.receive({ type: "error", generation: worker.generation, message: "normalization unavailable" }));
    expect(onNormalizationStateChange).toHaveBeenLastCalledWith(true, expect.objectContaining({ message: "normalization unavailable" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(() => handle.captureSnapshotSync()).toThrow("normalization unavailable");
    expect(EditNormalizationWorker.instances).toHaveLength(1);
    const retry = handle.captureSnapshot();
    await waitFor(() => expect(EditNormalizationWorker.instances[1].source).toContain("first<br>second"));
    await act(async () => EditNormalizationWorker.instances[1].complete());
    expect((await retry).serialize()).toBe("first<br>second");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toContain("first<br>second");
  });

  it("cancels held normalization on an external document update without replaying a late result", async () => {
    EditNormalizationWorker.hold = true;
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const onChange = vi.fn();
    const { rerender } = render(
      <MarkdownRichEditor ref={editorRef} markdown="first" ariaLabel="Switching worker" theme={TEST_MARKDOWN_THEME} onChange={onChange} />
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Switching worker"));
    if (!view) throw new Error("Expected the Markdown editor");
    act(() =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "| A |\n| - |\n| first<br>second |\n" }, userEvent: "input" })
    );
    await waitFor(() => expect(EditNormalizationWorker.instances[0].source).toContain("first<br>second"));
    const worker = EditNormalizationWorker.instances[0];
    const late = worker.onmessage;
    const cancelled = expect(editorRef.current?.captureSnapshot()).rejects.toMatchObject({ name: "AbortError" });
    rerender(
      <MarkdownRichEditor
        ref={editorRef}
        markdown="different document"
        ariaLabel="Switching worker"
        theme={TEST_MARKDOWN_THEME}
        onChange={onChange}
      />
    );
    await cancelled;
    expect(worker.terminated).toBe(true);
    await act(async () =>
      late?.(new MessageEvent("message", { data: { type: "error", generation: worker.generation, message: "obsolete" } }))
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("different document");
    expect(editorRef.current?.captureSnapshotSync().serialize()).toBe("different document");
  });

  it("prepares immutable source-preserving bytes again when only the baseline changes", async () => {
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const markdown = "Intro\n\n| A |\n| - |\n| foo |\n";
    const oldBaseline = "Before\n\n| A |\n| --- |\n| foo |\n";
    const newBaseline = "Before\n\n| A |\n| ----- |\n| foo |\n";
    const { rerender } = render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={markdown}
        diffMarkdown={oldBaseline}
        ariaLabel="Baseline snapshot"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    const handle = editorRef.current;
    if (!handle) throw new Error("Expected the Markdown editor");
    const original = await handle.captureSnapshot();
    expect(original.serialize()).toBe(preserveUnchangedMarkdownTableSource(oldBaseline, markdown));
    EditNormalizationWorker.hold = true;
    rerender(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={markdown}
        diffMarkdown={newBaseline}
        ariaLabel="Baseline snapshot"
        theme={TEST_MARKDOWN_THEME}
        onChange={() => {}}
      />
    );
    expect(() => handle.captureSnapshotSync()).toThrow(/normalization/);
    await waitFor(() => expect(EditNormalizationWorker.instances.at(-1)?.baseline).toBe(newBaseline));
    await act(async () => EditNormalizationWorker.instances.at(-1)?.complete());
    expect(handle.captureSnapshotSync().serialize()).toBe(preserveUnchangedMarkdownTableSource(newBaseline, markdown));
    expect(original.serialize()).toBe(preserveUnchangedMarkdownTableSource(oldBaseline, markdown));
  });

  it("normalizes whole-document Save snapshots through the worker after the typing fast path", async () => {
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor ref={editorRef} markdown="start" ariaLabel="Canonical Save" theme={TEST_MARKDOWN_THEME} onChange={() => {}} />
    );
    const view = EditorView.findFromDOM(screen.getByLabelText("Canonical Save"));
    if (!view) throw new Error("Expected the Markdown editor");
    act(() =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: "* first\n* second\n\n1. first\n2. second\n" },
        userEvent: "input",
      })
    );
    const snapshot = await editorRef.current?.captureSnapshot();
    expect(snapshot?.serialize()).toBe("- first\n- second\n\n1. first\n1. second\n");
    expect(EditNormalizationWorker.instances).toHaveLength(1);
    expect(EditNormalizationWorker.instances[0].terminated).toBe(true);
  });

  it("does not replay a canonical echo over an edit delivered before passive effects", () => {
    const onChange = vi.fn();
    function ControlledEditor({ markdown }: { markdown: string }) {
      useLayoutEffect(() => {
        if (markdown !== "initial updated") return;
        const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Rapid canonical editor" }));
        if (!view) throw new Error("Expected a mounted Markdown editor");
        view.dispatch({ changes: { from: view.state.doc.length, insert: " next" } });
      }, [markdown]);
      return <MarkdownRichEditor markdown={markdown} ariaLabel="Rapid canonical editor" theme={TEST_MARKDOWN_THEME} onChange={onChange} />;
    }
    const { rerender } = render(<ControlledEditor markdown="initial" />);
    const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Rapid canonical editor" }));
    if (!view) throw new Error("Expected a mounted Markdown editor");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " updated" } }));
    rerender(<ControlledEditor markdown="initial updated" />);
    expect(view.state.doc.toString()).toBe("initial updated next");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("measures normalization and synchronous parent updates without retaining document content", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const measure = vi.spyOn(performance, "measure");
    const clearMeasures = vi.spyOn(performance, "clearMeasures");
    try {
      render(<MarkdownRichEditor markdown="alpha" ariaLabel="Measured Markdown" theme={TEST_MARKDOWN_THEME} onChange={onChange} />);
      await user.click(await screen.findByLabelText("Measured Markdown"));
      await user.keyboard("!");
      const canonical = onChange.mock.calls.at(-1)?.[0];
      expect(canonical).toContain("!");
      for (const name of Object.values(MARKDOWN_SOURCE_MEASURES)) {
        expect(clearMeasures).toHaveBeenCalledWith(name);
        expect(measure).toHaveBeenCalledWith(name, {
          start: expect.any(Number),
          detail: { documentUnits: canonical.length, canonicalUnits: canonical.length },
        });
      }
    } finally {
      measure.mockRestore();
      clearMeasures.mockRestore();
    }
  });

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

  it.each([false, true])("flushes an identical composition commit only without unpublished DOM text %s", async (unpublishedDom) => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    render(
      <MarkdownRichEditor
        ref={editorRef}
        markdown={"| A |\n| - |\n| foo |"}
        ariaLabel="Repeated composition"
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
    const input = () =>
      nested.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, inputType: "insertCompositionText", data: "finished", isComposing: true })
      );
    input();
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "finished" }, userEvent: "input.type.compose" });
    });
    await waitFor(() => expect(handle.getCanonicalMarkdown()).toContain("finished"));
    input();
    const root = nested.closest(".tbl-table-widget")?.closest<HTMLElement>(".cm-editor");
    const rootView = root && EditorView.findFromDOM(root);
    if (!rootView) throw new Error("Expected the root Markdown editor");
    const dispatch = unpublishedDom ? vi.spyOn(rootView, "dispatch").mockImplementation(() => {}) : null;
    if (unpublishedDom) {
      const line = nested.querySelector(".cm-line");
      if (!line) throw new Error("Expected nested editor text");
      line.textContent = "not published";
    }
    nested.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "finished" }));
    try {
      if (unpublishedDom) {
        const controller = new AbortController();
        const pending = handle.captureSnapshot(controller.signal);
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        controller.abort();
        await rejected;
      } else expect((await handle.captureSnapshot()).serialize()).toContain("finished");
    } finally {
      dispatch?.mockRestore();
    }
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

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "restores the same nested cell without focusing the root after pending edit %s and capture after blur %s",
    async (editAfterCapture, captureAfterBlur) => {
      const user = userEvent.setup();
      const editorRef = createRef<MarkdownRichEditorHandle>();
      render(
        <MarkdownRichEditor
          ref={editorRef}
          markdown={"| A |\n| - |\n| foo |\n"}
          ariaLabel="Preserved table focus"
          theme={TEST_MARKDOWN_THEME}
          onChange={() => {}}
        />
      );
      const root = EditorView.findFromDOM(screen.getByLabelText("Preserved table focus"));
      await user.click(await screen.findByText("foo"));
      const content = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
      const nested = content && EditorView.findFromDOM(content);
      const handle = editorRef.current;
      if (!root || !nested || !handle) throw new Error("Expected root and nested Markdown editors");
      expect(root).not.toBe(nested);
      const rootFocus = vi.spyOn(root, "focus");
      await waitFor(() => expect(nested.hasFocus).toBe(true));
      await act(async () => nested.dispatch({ selection: { anchor: 1, head: 2 } }));
      const capturedSelection = nested.state.selection;
      if (!captureAfterBlur) handle.preserveSelection();
      const button = document.createElement("button");
      document.body.append(button);
      try {
        button.focus();
        if (captureAfterBlur) handle.preserveSelection();
        if (editAfterCapture) {
          await act(async () => nested.dispatch({ changes: { from: nested.state.doc.length, insert: "!" }, selection: { anchor: 4 } }));
        } else {
          await act(async () => nested.dispatch({ selection: { anchor: 0 } }));
        }
        const expectedSelection = editAfterCapture ? nested.state.selection : capturedSelection;
        rootFocus.mockClear();
        act(() => expect(handle.restorePreservedSelection()).toBe(true));
        expect(nested.hasFocus).toBe(true);
        expect(nested.state.selection.eq(expectedSelection)).toBe(true);
        expect(rootFocus).not.toHaveBeenCalled();
        expect(document.querySelector(".tbl-cell-editor .cm-content")).toBe(content);
      } finally {
        rootFocus.mockRestore();
        button.remove();
      }
    }
  );

  it.each([false, true])("forgets nested focus after external document replacement %s or root focus", async (replaceDocument) => {
    const user = userEvent.setup();
    const editorRef = createRef<MarkdownRichEditorHandle>();
    const props = { ref: editorRef, ariaLabel: "Root focus fallback", theme: TEST_MARKDOWN_THEME, onChange: () => {} };
    const { rerender } = render(<MarkdownRichEditor {...props} markdown={"| A |\n| - |\n| foo |\n\nparagraph"} />);
    const root = EditorView.findFromDOM(screen.getByLabelText("Root focus fallback"));
    await user.click(await screen.findByText("foo"));
    const content = document.querySelector<HTMLElement>(".tbl-cell-editor .cm-content");
    const nested = content && EditorView.findFromDOM(content);
    const handle = editorRef.current;
    if (!root || !nested || !handle) throw new Error("Expected root and nested Markdown editors");
    await waitFor(() => expect(nested.hasFocus).toBe(true));
    handle.preserveSelection();
    if (replaceDocument) rerender(<MarkdownRichEditor {...props} markdown="replacement" />);
    else
      await act(async () => {
        root.dispatch({ selection: { anchor: root.state.doc.length } });
        root.focus();
      });
    const nestedFocus = vi.spyOn(nested, "focus");
    const button = document.createElement("button");
    document.body.append(button);
    try {
      button.focus();
      handle.preserveSelection();
      act(() => expect(handle.restorePreservedSelection()).toBe(true));
      expect(root.hasFocus).toBe(true);
      expect(nestedFocus).not.toHaveBeenCalled();
    } finally {
      nestedFocus.mockRestore();
      button.remove();
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

  it.each(["dark", "custom-alpha"])("preserves Markdown identity, search and undo across a %s theme change", async (variant) => {
    const markdown = "# alpha\n\n".repeat(120);
    const onChange = vi.fn();
    const props = { ariaLabel: "Theme Markdown", markdown, theme: TEST_MARKDOWN_THEME, onChange, searchOpen: true, searchText: "alpha" };
    const { rerender } = render(<MarkdownRichEditor {...props} />);
    const editor = await screen.findByLabelText("Theme Markdown");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("Expected a mounted Markdown editor");
    await act(async () => {
      view.dispatch({ changes: { from: markdown.length, insert: "draft" }, selection: { anchor: 2, head: 7 } });
    });
    const doc = view.state.doc;
    const selection = view.state.selection;
    const query = getSearchQuery(view.state);
    const metrics = getCodeMirrorFindReplaceMetrics(view);
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.scrollLeft = 30;
    onChange.mockClear();

    rerender(
      <MarkdownRichEditor
        {...props}
        markdown={doc.toString()}
        theme={{
          ...TEST_MARKDOWN_THEME,
          isDarkMode: true,
          textColor: "rgb(240, 242, 244)",
          surfaceBackground: variant === "dark" ? "rgb(24, 26, 28)" : "rgba(24, 26, 28, 0.8)",
          selectionBackground: "rgba(60, 180, 210, 0.4)",
        }}
      />
    );

    await waitFor(() => expect(view.state.facet(EditorView.darkTheme)).toBe(true));
    expect(EditorView.findFromDOM(screen.getByLabelText("Theme Markdown"))).toBe(view);
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
    expect(view.state.doc.toString()).toBe(markdown);
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
