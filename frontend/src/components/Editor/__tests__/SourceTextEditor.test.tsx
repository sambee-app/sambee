import { type CompletionSource, startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildCommonEditorExtensions } from "../buildCommonEditorExtensions";
import { getSelectionLineSegments, resolveOpaqueSelectionBackground } from "../buildEditorSelectionLayer";
import {
  buildMarkdownAutocompleteUi,
  createMarkdownSnippetAutocompleter,
  MARKDOWN_SNIPPET_COMPLETIONS,
} from "../buildMarkdownAutocomplete";
import { buildMarkdownEditorExtensions } from "../buildMarkdownEditorExtensions";
import type { MarkdownEditorThemeOptions } from "../buildMarkdownEditorTheme";
import { buildTextEditorTheme, type TextEditorThemeOptions } from "../buildTextEditorTheme";
import { SourceTextEditor } from "../SourceTextEditor";
import type { SourceTextEditorHandle } from "../sourceTextEditorTypes";

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

const TEST_TEXT_THEME: TextEditorThemeOptions = {
  activeLineBackground: TEST_MARKDOWN_THEME.activeLineBackground,
  accentColor: TEST_MARKDOWN_THEME.linkColor,
  borderColor: TEST_MARKDOWN_THEME.borderColor,
  currentSearchMatchBackground: "rgba(244, 196, 48, 0.32)",
  isDarkMode: false,
  otherSearchMatchBackground: "rgba(244, 196, 48, 0.18)",
  selectionBackground: TEST_MARKDOWN_THEME.selectionBackground,
  surfaceBackground: TEST_MARKDOWN_THEME.surfaceBackground,
  textColor: TEST_MARKDOWN_THEME.textColor,
};

describe("SourceTextEditor", () => {
  it("does not serialize again when a controlled parent echoes the latest edit", () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    const onChange = vi.fn();
    const { rerender } = render(<SourceTextEditor ref={editorRef} value="initial" ariaLabel="Controlled editor" onChange={onChange} />);
    const view = editorRef.current?.getView();
    if (!view) throw new Error("Expected a mounted editor");
    const transaction = view.state.update({ changes: { from: 7, insert: " updated" } });
    const serialize = vi.spyOn(transaction.state.doc, "toString");
    try {
      view.dispatch(transaction);
      expect(onChange).toHaveBeenLastCalledWith("initial updated", expect.anything());
      expect(serialize).toHaveBeenCalledOnce();
      serialize.mockClear();
      rerender(<SourceTextEditor ref={editorRef} value="initial updated" ariaLabel="Controlled editor" onChange={onChange} />);
      expect(serialize).not.toHaveBeenCalled();
      expect(view.state.doc).toBe(transaction.state.doc);
      rerender(<SourceTextEditor ref={editorRef} value="external" ariaLabel="Controlled editor" onChange={onChange} />);
      expect(view.state.doc.toString()).toBe("external");
      expect(onChange).toHaveBeenCalledOnce();
    } finally {
      serialize.mockRestore();
    }
  });

  it("rejects snapshots throughout an active composition, including before its first change", () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    render(<SourceTextEditor ref={editorRef} value="initial" ariaLabel="Composition editor" onChange={() => {}} />);
    const handle = editorRef.current;
    const view = handle?.getView();
    if (!handle || !view) throw new Error("Expected a mounted source editor");
    const original = handle.captureSnapshot();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(view.compositionStarted).toBe(true);
    expect(view.composing).toBe(false);
    expect(() => handle.captureSnapshot()).toThrow(/composition/);
    view.dispatch({ changes: { from: view.state.doc.length, insert: " composed" }, userEvent: "input.type.compose" });
    expect(() => handle.captureSnapshot()).toThrow(/composition/);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "composed" }));

    expect(view.compositionStarted).toBe(false);
    expect(handle.captureSnapshot().serialize()).toBe("initial composed");
    expect(original.serialize()).toBe("initial");
  });

  it("captures an immutable revision without serializing the source during capture", () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    const { unmount } = render(<SourceTextEditor ref={editorRef} value="initial" ariaLabel="Snapshot editor" onChange={() => {}} />);
    const handle = editorRef.current;
    const view = handle?.getView();
    if (!handle || !view) throw new Error("Expected a mounted editor");
    const serialize = vi.spyOn(view.state.doc, "toString");
    try {
      const snapshot = handle.captureSnapshot();
      expect(serialize).not.toHaveBeenCalled();
      expect(snapshot.revision).toBe(0);
      expect(Object.isFrozen(snapshot)).toBe(true);
      view.dispatch({ changes: { from: view.state.doc.length, insert: " updated" } });
      const latest = handle.captureSnapshot();
      expect(latest.revision).toBeGreaterThan(snapshot.revision);
      expect(snapshot.serialize()).toBe("initial");
      expect(latest.serialize()).toBe("initial updated");
      unmount();
      expect(snapshot.serialize()).toBe("initial");
      expect(() => handle.captureSnapshot()).toThrow(/disposed/);
    } finally {
      serialize.mockRestore();
    }
  });

  it("includes external document replacements in snapshot revisions", () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    const onChange = vi.fn();
    const { rerender } = render(<SourceTextEditor ref={editorRef} value="initial" ariaLabel="Snapshot editor" onChange={onChange} />);
    const first = editorRef.current?.captureSnapshot();
    rerender(<SourceTextEditor ref={editorRef} value="replacement" ariaLabel="Snapshot editor" onChange={onChange} />);
    const latest = editorRef.current?.captureSnapshot();

    expect(first?.serialize()).toBe("initial");
    expect(latest?.serialize()).toBe("replacement");
    expect(latest?.revision).toBeGreaterThan(first?.revision ?? -1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("scrolls the viewport with Ctrl+Arrow keys without changing the selection", async () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    const initialValue = "Editor content";

    render(
      <SourceTextEditor
        ref={editorRef}
        value={initialValue}
        extensions={buildCommonEditorExtensions()}
        ariaLabel="Viewport scroll editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Viewport scroll editor");
    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    Object.defineProperties(view.scrollDOM, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 40, writable: true },
    });
    view.dispatch({ selection: EditorSelection.range(2, 10) });
    const selectionBeforeScroll = view.state.selection.main.toJSON();

    const downEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "ArrowDown" });
    editor.dispatchEvent(downEvent);

    expect(downEvent.defaultPrevented).toBe(true);
    expect(view.scrollDOM.scrollTop).toBe(40 + view.defaultLineHeight);
    expect(view.state.selection.main.toJSON()).toEqual(selectionBeforeScroll);
    expect(view.state.doc.toString()).toBe(initialValue);

    view.scrollDOM.scrollTop = 400;
    const bottomEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "ArrowDown" });
    editor.dispatchEvent(bottomEvent);

    expect(bottomEvent.defaultPrevented).toBe(true);
    expect(view.scrollDOM.scrollTop).toBe(400);

    view.scrollDOM.scrollTop = 0;
    const topEvent = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "ArrowUp" });
    editor.dispatchEvent(topEvent);

    expect(topEvent.defaultPrevented).toBe(true);
    expect(view.scrollDOM.scrollTop).toBe(0);
  });

  it("moves an empty cursor by one visual line before scrolling would hide it", async () => {
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="First line\nSecond line"
        extensions={buildCommonEditorExtensions()}
        ariaLabel="Edge cursor editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Edge cursor editor");
    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    Object.defineProperties(view.scrollDOM, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 40, writable: true },
    });
    view.dispatch({ selection: EditorSelection.cursor(2) });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ bottom: view.defaultLineHeight + 1, left: 0, right: 1, top: 1 });
    vi.spyOn(view, "moveVertically").mockReturnValue(EditorSelection.cursor(12));

    editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "ArrowDown" }));

    expect(view.moveVertically).toHaveBeenCalledWith(expect.objectContaining({ head: 2 }), true, view.defaultLineHeight - 1);
    expect(view.state.selection.main.head).toBe(12);
    expect(view.scrollDOM.scrollTop).toBe(40 + view.defaultLineHeight);
  });

  it("normalizes dispatched multiple selections to the primary selection", async () => {
    const editorRef = createRef<SourceTextEditorHandle>();

    render(<SourceTextEditor ref={editorRef} value="First line\nSecond line" ariaLabel="Single selection editor" onChange={() => {}} />);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(12)], 1) });

    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.head).toBe(12);
  });

  it("renders the initial value and reports user edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<SourceTextEditor value="Hello" ariaLabel="Source editor" onChange={onChange} />);

    const editor = await screen.findByLabelText("Source editor");
    await user.click(editor);
    await user.keyboard("!");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });

    expect(onChange.mock.lastCall?.[0]).toContain("!");
  });

  it("preserves and restores selection through the imperative handle", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(<SourceTextEditor ref={editorRef} value="Hello world" ariaLabel="Source editor" onChange={() => {}} />);

    const editor = await screen.findByLabelText("Source editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view || !editorRef.current) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: { anchor: 0, head: 5 } });
    editorRef.current.preserveSelection();
    view.dispatch({ selection: { anchor: 11, head: 11 } });

    expect(editorRef.current.restorePreservedSelection()).toBe(true);
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(5);
  });

  it("preserves the caret when reconfiguring line wrapping", async () => {
    const editorRef = createRef<SourceTextEditorHandle>();
    const longLine = "x".repeat(10_000);

    const { rerender } = render(
      <SourceTextEditor ref={editorRef} value={longLine} extensions={[]} ariaLabel="Wrapping source editor" onChange={() => {}} />
    );

    const editor = await screen.findByLabelText("Wrapping source editor");
    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.cursor(longLine.length) });

    rerender(
      <SourceTextEditor
        ref={editorRef}
        value={longLine}
        extensions={[EditorView.lineWrapping]}
        ariaLabel="Wrapping source editor"
        onChange={() => {}}
      />
    );

    await waitFor(() => {
      expect(editor).toHaveClass("cm-lineWrapping");
      expect(view.state.selection.main.head).toBe(longLine.length);
    });
  });

  it("retains undo history across controlled value updates", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    const ControlledEditor = () => {
      const [value, setValue] = useState("Hello");

      return (
        <SourceTextEditor
          ref={editorRef}
          value={value}
          extensions={buildCommonEditorExtensions()}
          ariaLabel="Controlled source editor"
          onChange={(nextValue) => setValue(nextValue)}
        />
      );
    };

    render(<ControlledEditor />);

    const editor = await screen.findByLabelText("Controlled source editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    await user.keyboard("!");

    await waitFor(() => {
      expect(editor.textContent).toContain("Hello!");
    });

    expect(editorRef.current?.runCommand(undo)).toBe(true);

    await waitFor(() => {
      expect(editor.textContent).toContain("Hello");
      expect(editor.textContent).not.toContain("Hello!");
    });
  });

  it("applies custom content attributes to the editable element", async () => {
    render(
      <SourceTextEditor
        value="Hello"
        ariaLabel="Source editor"
        contentAttributes={{ spellcheck: "true", autocapitalize: "sentences" }}
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Source editor");

    expect(editor).toHaveAttribute("spellcheck", "true");
    expect(editor).toHaveAttribute("autocapitalize", "sentences");
  });

  it("closes bracket pairs while typing", async () => {
    const user = userEvent.setup();

    render(<SourceTextEditor value="" extensions={buildCommonEditorExtensions()} ariaLabel="Bracket editor" onChange={() => {}} />);

    const editor = await screen.findByLabelText("Bracket editor");
    await user.click(editor);
    await user.keyboard("(");

    await waitFor(() => {
      expect(editor.textContent).toBe("()");
    });
  });

  it("registers the expected markdown snippets", () => {
    expect(MARKDOWN_SNIPPET_COMPLETIONS.some((completion) => completion.label === "task")).toBe(true);
    expect(MARKDOWN_SNIPPET_COMPLETIONS.some((completion) => completion.label === "link")).toBe(true);
  });

  it("allows a language-data autocomplete provider to coexist with markdown snippets", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();
    const markdownLanguageSupport = markdown({ codeLanguages: languages });
    const sentinelAutocomplete: CompletionSource = (context) => {
      if (!context.explicit) {
        return null;
      }

      return {
        from: context.pos,
        options: [{ label: "sentinel-provider", type: "keyword" }],
      };
    };

    render(
      <SourceTextEditor
        ref={editorRef}
        value=""
        extensions={[
          buildMarkdownAutocompleteUi(),
          markdownLanguageSupport,
          markdownLanguageSupport.language.data.of({ autocomplete: createMarkdownSnippetAutocompleter() }),
          markdownLanguageSupport.language.data.of({ autocomplete: sentinelAutocomplete }),
        ]}
        ariaLabel="Autocomplete editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Autocomplete editor");
    await user.click(editor);

    expect(editorRef.current?.runCommand(startCompletion)).toBe(true);

    await waitFor(() => {
      expect(screen.getByText("sentinel-provider")).toBeInTheDocument();
      expect(screen.getByText("task")).toBeInTheDocument();
    });
  });

  it("shows table-size completions after typing a pipe on an empty line", async () => {
    const user = userEvent.setup();

    render(
      <SourceTextEditor
        value=""
        extensions={buildMarkdownEditorExtensions(TEST_MARKDOWN_THEME)}
        ariaLabel="Table autocomplete editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Table autocomplete editor");
    await user.click(editor);
    await user.keyboard("|");

    await waitFor(() => {
      expect(screen.getByText(/2×2/)).toBeInTheDocument();
      expect(screen.getByText(/3×3/)).toBeInTheDocument();
      expect(screen.queryByText(/^table$/i)).not.toBeInTheDocument();
    });
  });

  it("uses inline selection decorations for Markdown", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value={["sfd", "* list 1", "  * list 1.1"].join("\n")}
        extensions={buildMarkdownEditorExtensions(TEST_MARKDOWN_THEME)}
        ariaLabel="Markdown selection editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Markdown selection editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.range(0, 14) });

    await waitFor(() => {
      const editorRoot = editor.closest(".cm-editor");

      expect(editorRoot?.querySelector(".cm-selectionLayer")).not.toBeNull();
      expect(editorRoot?.querySelector(".sambee-editor-selection-layer")).not.toBeNull();
      expect(editorRoot?.querySelector(".sambee-editor-selection-range")).not.toBeNull();
      expect(editorRoot).toHaveClass("sambee-editor-has-selection");
    });
  });

  it("hides the active-line highlight while text is selected", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="Selected text"
        extensions={buildMarkdownEditorExtensions(TEST_MARKDOWN_THEME)}
        ariaLabel="Selection active-line editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Selection active-line editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });

    await waitFor(() => {
      const activeLine = editor.closest(".cm-editor")?.querySelector(".cm-activeLine");

      if (!(activeLine instanceof HTMLElement)) {
        throw new Error("Expected active line to be rendered");
      }

      expect(window.getComputedStyle(activeLine).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
  });

  it("includes empty lines in markdown selection segments", () => {
    const state = EditorState.create({ doc: ["alpha", "", "beta"].join("\n") });

    expect(getSelectionLineSegments(state.doc, { from: 0, to: state.doc.length })).toEqual([
      { from: 0, to: 5, emptyLine: false },
      { from: 6, to: 6, emptyLine: true },
      { from: 7, to: 11, emptyLine: false },
    ]);
  });

  it("resolves translucent selection colors against the editor surface", () => {
    expect(resolveOpaqueSelectionBackground("rgb(251, 249, 244)", "rgba(194, 68, 0, 0.18)")).toBe("rgb(241, 216, 200)");
    expect(resolveOpaqueSelectionBackground("rgb(251, 249, 244)", "rgb(194, 68, 0)")).toBe("rgb(194, 68, 0)");
  });

  it("preserves unparseable CSS selection colors", () => {
    expect(resolveOpaqueSelectionBackground("rgb(251, 249, 244)", "var(--selection-background)")).toBe("var(--selection-background)");
  });

  it("uses inline selection decorations for plain text editors", async () => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value={["Line 1", "2", "", "5", "", "7"].join("\n")}
        extensions={[...buildCommonEditorExtensions(), ...buildTextEditorTheme(TEST_TEXT_THEME)]}
        ariaLabel="Plain text selection editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Plain text selection editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.range(0, 11) });

    await waitFor(() => {
      const editorRoot = editor.closest(".cm-editor");

      expect(editorRoot?.querySelector(".cm-selectionLayer")).not.toBeNull();
      expect(editorRoot?.querySelector(".sambee-editor-selection-layer")).not.toBeNull();
      expect(editorRoot?.querySelector(".sambee-editor-selection-range")).not.toBeNull();
      expect(editorRoot).toHaveClass("sambee-editor-has-selection");
    });
  });

  it.each([
    ["Markdown", buildMarkdownEditorExtensions(TEST_MARKDOWN_THEME)],
    ["plain text", [...buildCommonEditorExtensions(), ...buildTextEditorTheme(TEST_TEXT_THEME)]],
  ])("does not clip the empty-line selection overlay for %s", async (_editorType, extensions) => {
    const user = userEvent.setup();
    const editorRef = createRef<SourceTextEditorHandle>();

    render(
      <SourceTextEditor
        ref={editorRef}
        value="First line\n\nSecond line"
        extensions={extensions}
        ariaLabel="Selection clipping editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Selection clipping editor");
    await user.click(editor);

    const view = editorRef.current?.getView();

    if (!view) {
      throw new Error("Expected editor view to be available");
    }

    view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });

    await waitFor(() => {
      const selectionLayer = editor.closest(".cm-editor")?.querySelector(".sambee-editor-selection-layer");

      if (!(selectionLayer instanceof HTMLElement)) {
        throw new Error("Expected empty-line selection layer to be rendered");
      }

      expect(window.getComputedStyle(selectionLayer).clipPath).toBe("none");
    });
  });

  it("applies the markdown theme colors to text, links, and the active line", async () => {
    const user = userEvent.setup();

    render(
      <SourceTextEditor
        value="* what's [text](https://stuff)"
        extensions={buildMarkdownEditorExtensions(TEST_MARKDOWN_THEME)}
        ariaLabel="Markdown themed editor"
        onChange={() => {}}
      />
    );

    const editor = await screen.findByLabelText("Markdown themed editor");
    await user.click(editor);

    const editorRoot = editor.closest(".cm-editor");
    const activeLine = editorRoot?.querySelector(".cm-activeLine");
    const linkToken = Array.from(editor.querySelectorAll("span")).find((element) => element.textContent?.includes("https://stuff"));

    if (!(editorRoot instanceof HTMLElement) || !(activeLine instanceof HTMLElement) || !(linkToken instanceof HTMLElement)) {
      throw new Error("Expected themed CodeMirror elements to be rendered");
    }

    expect(window.getComputedStyle(editor).color).toBe(TEST_MARKDOWN_THEME.textColor);
    expect(window.getComputedStyle(activeLine).backgroundColor).toBe(TEST_MARKDOWN_THEME.activeLineBackground);
    expect(linkToken).toHaveClass("sambee-syntax-link");
    expect(window.getComputedStyle(editor.closest(".cm-editor")!).getPropertyValue("--sambee-syntax-link").replaceAll(" ", "")).toBe(
      TEST_MARKDOWN_THEME.linkColor.replaceAll(" ", "")
    );
  });
});
