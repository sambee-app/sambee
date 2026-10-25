import type { ViewUpdate } from "@codemirror/view";
import { createTheme, ThemeProvider } from "@mui/material";
import { act, configure, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ViewerLeaveGuard, WorkspaceNavigationGuard } from "../../../hooks/useRoutedViewerEditing";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService from "../../../services/api";
import { authSession } from "../../../services/authSession";
import { loadDraft, snapshotRegisteredDrafts } from "../../../services/draftRecovery";
import { logger } from "../../../services/logger";
import { ExpiredEditLockError } from "../../../services/storageContracts";
import { createStorageBackedTestContentProviderRegistry, readBlobAsText } from "../../../test/helpers";
import { requireTestElement, requireTestValue, uninitializedTestCallback } from "../../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../../theme";
import { getDefaultTheme } from "../../../theme/themes";
import { highlightingService } from "../../../utils/highlightingService";
import * as markdownCodePreparation from "../../../utils/markdownCodePreparation";
import * as markdownDocumentPreview from "../../../utils/markdownDocumentPreview";
import * as markdownSyntaxPublication from "../../../utils/markdownSyntaxPublication";
import * as markdownSyntaxWorker from "../../../utils/markdownSyntaxWorker";
import type { PreparedCodeBlock } from "../../../utils/syntaxHighlighting";
import MarkdownViewer from "../MarkdownViewer";
import { MARKDOWN_VIEWER_CONTENT_AUTOFOCUS_DELAY_MS } from "../markdownEditorConstants";
import { normalizeMarkdownTableCellLineBreaks } from "../markdownTableCellLineBreaks";
import { RetainedMarkdownPreview, type RetainedMarkdownPreviewProps } from "../RetainedMarkdownPreview";
import { createViewerSearchTestDriver } from "./viewerSearchTestUtils";

const contentProviders = createStorageBackedTestContentProviderRegistry();

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

function render(ui: ReactNode) {
  return renderBase(ui, { wrapper: ContentProviderTestWrapper });
}

function RoutedMarkdownViewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const [guard, setGuard] = useState<ViewerLeaveGuard | null>(null);
  return (
    <>
      {guard ? <WorkspaceNavigationGuard guard={guard} /> : null}
      <MarkdownViewer
        connectionId="conn1"
        path="/docs/readme.md"
        onClose={() => void navigate("/browse")}
        navigation={{
          mode: new URLSearchParams(location.search).get("mode") === "edit" ? "edit" : "view",
          onGuardChange: setGuard,
          onModeChange: (mode, replace) => {
            const search = new URLSearchParams(location.search);
            if (mode === "edit") search.set("mode", "edit");
            else search.delete("mode");
            if (search.toString() !== new URLSearchParams(location.search).toString())
              void navigate({ search: search.toString() }, { replace });
          },
        }}
      />
    </>
  );
}

const { mockLoadMarkdownRichEditor } = vi.hoisted(() => ({
  mockLoadMarkdownRichEditor: vi.fn(),
}));

vi.mock("../loadMarkdownRichEditor", () => ({
  loadMarkdownRichEditor: mockLoadMarkdownRichEditor,
}));

configure({ asyncUtilTimeout: 5000 });

const mockMarkdownEditorBehavior = {
  canonicalMarkdownOverride: null as string | null,
  changeBeforeUserEdit: false,
  delayFocus: false,
  emitNonEditableInputBeforeInitialChange: false,
  emitUnannotatedDocChangeBeforeInitialChange: false,
  emitUnannotatedDocChangeOnMarkdownPropChange: false,
  completedUnannotatedDocChangesOnMarkdownPropChange: 0,
  focusEditableBeforeInitialChange: false,
  focusCurrentSearchResultCalls: 0,
  focusResetsScrollPosition: false,
  flushRejectError: null as Error | null,
  pendingSnapshot: null as Promise<void> | null,
  initialNormalizedMarkdown: null as string | null,
  lastSearchAutoNavigate: true,
  lastSearchOpen: false,
  lastSearchText: "",
  lastRestoredScrollTop: null as number | null,
  moveCaretToEndOnMarkdownPropChangeWhenFocused: false,
  onNormalizationStateChange: null as ((pending: boolean) => void) | null,
  preserveSelectionCalls: 0,
  restorePreservedSelectionCalls: 0,
  skipUserEdit: false,
  throwOnCanonicalExport: null as Error | null,
  throwOnInsertCodeBlock: false,
  throwOnRender: false,
};

const mockMarkdownEditorCommands = {
  createLink: vi.fn(),
  insertTable: vi.fn(),
  insertThematicBreak: vi.fn(),
  insertCodeBlock: vi.fn(),
  replaceAllSearchResults: vi.fn(),
  replaceCurrentSearchResult: vi.fn(),
  toggleBold: vi.fn(),
  toggleItalic: vi.fn(),
  toggleInlineCode: vi.fn(),
};

const mockEditLockInfo = {
  lock_id: "lock-1",
  lock_capability: "capability-1",
  operation_id: "operation-1",
  file_path: "/docs/readme.md",
  locked_by: "alice",
  locked_at: "2026-03-23T12:00:00Z",
};

const MockMarkdownRichEditor = forwardRef<
  {
    focus: () => void;
    captureSnapshot: () => Promise<{ revision: number; serialize: () => string }>;
    captureSnapshotSync: () => { revision: number; serialize: () => string };
    flushPendingEdits: () => Promise<void>;
    getCanonicalMarkdown: () => string;
    getPrimarySelectionText: () => string;
    preserveSelection: () => void;
    restorePreservedSelection: () => boolean;
    focusCurrentSearchResult: () => boolean;
    nextSearchResult: () => void;
    previousSearchResult: () => void;
    replaceAllSearchResults: () => void;
    replaceCurrentSearchResult: () => void;
    createLink: () => void;
    insertTable: () => void;
    insertThematicBreak: () => void;
    toggleBold: () => void;
    toggleItalic: () => void;
    toggleInlineCode: () => void;
    insertCodeBlock: () => void;
  },
  {
    markdown: string;
    onChange: (markdown: string) => void;
    onUserEdit?: (viewUpdate?: ViewUpdate) => void;
    onNormalizationStateChange?: (pending: boolean, error?: Error) => void;
    ariaLabel: string;
    autoFocus?: boolean;
    readOnly?: boolean;
    className?: string;
    searchText?: string;
    searchOpen?: boolean;
    searchAutoNavigate?: boolean;
    searchCaseSensitive?: boolean;
    searchRegexp?: boolean;
    searchReplaceText?: string;
    searchWholeWord?: boolean;
    onSearchStateChange?: (state: {
      searchText: string;
      searchMatches: number;
      currentMatch: number;
      isSearchOpen: boolean;
      isSearchable: boolean;
      isValid: boolean;
      viewMode: "rich-text" | "source" | "diff";
    }) => void;
  }
>(
  (
    {
      markdown,
      onChange,
      onUserEdit,
      onNormalizationStateChange,
      ariaLabel,
      readOnly = false,
      className,
      searchText = "",
      searchOpen = false,
      searchAutoNavigate = true,
      onSearchStateChange,
    },
    ref
  ) => {
    if (mockMarkdownEditorBehavior.throwOnRender) {
      throw new Error("Editor render failed");
    }

    mockMarkdownEditorBehavior.lastSearchOpen = searchOpen;
    mockMarkdownEditorBehavior.lastSearchText = searchText;
    mockMarkdownEditorBehavior.lastSearchAutoNavigate = searchAutoNavigate;
    mockMarkdownEditorBehavior.onNormalizationStateChange = onNormalizationStateChange ?? null;

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const toolbarButtonRef = useRef<HTMLButtonElement | null>(null);
    const previousMarkdownRef = useRef(markdown);
    const latestMarkdownRef = useRef(markdown);
    const preservedSelectionRef = useRef<{
      type: "textarea";
      start: number;
      end: number;
      direction: "forward" | "backward" | "none";
      scrollTop: number;
    } | null>(null);
    const [currentMatch, setCurrentMatch] = useState(0);

    useEffect(() => {
      if (!searchOpen || !searchText) {
        setCurrentMatch(0);
        return;
      }

      setCurrentMatch(1);
    }, [searchOpen, searchText]);

    useEffect(() => {
      onSearchStateChange?.({
        searchText,
        searchMatches: searchText ? 2 : 0,
        currentMatch: searchText ? currentMatch : 0,
        isSearchOpen: searchOpen,
        isSearchable: true,
        isValid: true,
        viewMode: "rich-text",
      });
    }, [currentMatch, onSearchStateChange, searchOpen, searchText]);

    useEffect(() => {
      if (mockMarkdownEditorBehavior.focusEditableBeforeInitialChange) {
        textareaRef.current?.focus();
      }

      if (mockMarkdownEditorBehavior.emitNonEditableInputBeforeInitialChange && toolbarButtonRef.current) {
        toolbarButtonRef.current.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }

      if (mockMarkdownEditorBehavior.emitUnannotatedDocChangeBeforeInitialChange) {
        onUserEdit?.({ transactions: [{ isUserEvent: () => false }] } as unknown as ViewUpdate);
      }

      if (mockMarkdownEditorBehavior.initialNormalizedMarkdown !== null) {
        onChange(mockMarkdownEditorBehavior.initialNormalizedMarkdown);
      }
    }, [onChange, onUserEdit]);

    useEffect(() => {
      latestMarkdownRef.current = markdown;
      const textarea = textareaRef.current;

      if (previousMarkdownRef.current !== markdown && mockMarkdownEditorBehavior.emitUnannotatedDocChangeOnMarkdownPropChange) {
        onUserEdit?.({ transactions: [{ isUserEvent: () => false }] } as unknown as ViewUpdate);
        onChange(markdown);
        queueMicrotask(() => {
          mockMarkdownEditorBehavior.completedUnannotatedDocChangesOnMarkdownPropChange += 1;
        });
      }

      if (
        !textarea ||
        previousMarkdownRef.current === markdown ||
        !mockMarkdownEditorBehavior.moveCaretToEndOnMarkdownPropChangeWhenFocused ||
        document.activeElement !== textarea
      ) {
        previousMarkdownRef.current = markdown;
        return;
      }

      textarea.setSelectionRange(markdown.length, markdown.length);
      previousMarkdownRef.current = markdown;
    }, [markdown, onChange, onUserEdit]);

    useImperativeHandle(ref, () => ({
      focus: () => {
        if (mockMarkdownEditorBehavior.delayFocus) {
          window.setTimeout(() => {
            if (mockMarkdownEditorBehavior.focusResetsScrollPosition && textareaRef.current) {
              textareaRef.current.scrollTop = 0;
            }
            textareaRef.current?.focus({ preventScroll: true });
          }, 72);
          return;
        }

        if (mockMarkdownEditorBehavior.focusResetsScrollPosition && textareaRef.current) {
          textareaRef.current.scrollTop = 0;
        }

        textareaRef.current?.focus({ preventScroll: true });
      },
      preserveSelection: () => {
        mockMarkdownEditorBehavior.preserveSelectionCalls += 1;
        const textarea = textareaRef.current;

        if (!textarea) {
          preservedSelectionRef.current = null;
          return;
        }

        preservedSelectionRef.current = {
          type: "textarea",
          start: textarea.selectionStart,
          end: textarea.selectionEnd,
          direction: textarea.selectionDirection ?? "none",
          scrollTop: textarea.scrollTop,
        };
      },
      restorePreservedSelection: () => {
        mockMarkdownEditorBehavior.restorePreservedSelectionCalls += 1;
        const textarea = textareaRef.current;

        if (!textarea) {
          return false;
        }

        textarea.focus({ preventScroll: true });

        if (!preservedSelectionRef.current) {
          return document.activeElement === textarea;
        }

        textarea.setSelectionRange(
          preservedSelectionRef.current.start,
          preservedSelectionRef.current.end,
          preservedSelectionRef.current.direction
        );
        textarea.scrollTop = preservedSelectionRef.current.scrollTop;
        mockMarkdownEditorBehavior.lastRestoredScrollTop = preservedSelectionRef.current.scrollTop;
        const restored = document.activeElement === textarea;

        if (restored) {
          preservedSelectionRef.current = null;
        }

        return restored;
      },
      captureSnapshot: async () => {
        if (mockMarkdownEditorBehavior.flushRejectError) throw mockMarkdownEditorBehavior.flushRejectError;
        const content = normalizeMarkdownTableCellLineBreaks(
          mockMarkdownEditorBehavior.canonicalMarkdownOverride ?? latestMarkdownRef.current
        );
        await mockMarkdownEditorBehavior.pendingSnapshot;
        return {
          revision: 0,
          serialize: () => {
            if (mockMarkdownEditorBehavior.throwOnCanonicalExport) throw mockMarkdownEditorBehavior.throwOnCanonicalExport;
            return content;
          },
        };
      },
      captureSnapshotSync: () => {
        if (mockMarkdownEditorBehavior.flushRejectError) throw mockMarkdownEditorBehavior.flushRejectError;
        const content = mockMarkdownEditorBehavior.canonicalMarkdownOverride ?? textareaRef.current?.value ?? latestMarkdownRef.current;
        return {
          revision: 0,
          serialize: () => {
            if (mockMarkdownEditorBehavior.throwOnCanonicalExport) throw mockMarkdownEditorBehavior.throwOnCanonicalExport;
            return content;
          },
        };
      },
      flushPendingEdits: () => {
        if (mockMarkdownEditorBehavior.flushRejectError) {
          return Promise.reject(mockMarkdownEditorBehavior.flushRejectError);
        }

        return Promise.resolve();
      },
      getCanonicalMarkdown: () => {
        if (mockMarkdownEditorBehavior.throwOnCanonicalExport) {
          throw mockMarkdownEditorBehavior.throwOnCanonicalExport;
        }

        return mockMarkdownEditorBehavior.canonicalMarkdownOverride ?? latestMarkdownRef.current;
      },
      getPrimarySelectionText: () => {
        const textarea = textareaRef.current;

        if (!textarea) {
          return "";
        }

        const { value, selectionStart: start, selectionEnd: end } = textarea;

        if (start === end) {
          return "";
        }

        return value.slice(start, end);
      },
      focusCurrentSearchResult: () => {
        mockMarkdownEditorBehavior.focusCurrentSearchResultCalls += 1;
        const textarea = textareaRef.current;

        if (!textarea) {
          return false;
        }

        textarea.focus({ preventScroll: true });
        return document.activeElement === textarea;
      },
      nextSearchResult: () => {
        if (!searchText) {
          return;
        }

        setCurrentMatch((previousMatch) => (previousMatch >= 2 ? 1 : previousMatch + 1));
      },
      previousSearchResult: () => {
        if (!searchText) {
          return;
        }

        setCurrentMatch((previousMatch) => (previousMatch <= 1 ? 2 : previousMatch - 1));
      },
      replaceCurrentSearchResult: () => {
        mockMarkdownEditorCommands.replaceCurrentSearchResult();
      },
      replaceAllSearchResults: () => {
        mockMarkdownEditorCommands.replaceAllSearchResults();
      },
      createLink: () => {
        mockMarkdownEditorCommands.createLink();
      },
      insertTable: () => {
        mockMarkdownEditorCommands.insertTable();
      },
      insertThematicBreak: () => {
        mockMarkdownEditorCommands.insertThematicBreak();
      },
      toggleBold: () => {
        mockMarkdownEditorCommands.toggleBold();
      },
      toggleItalic: () => {
        mockMarkdownEditorCommands.toggleItalic();
      },
      toggleInlineCode: () => {
        mockMarkdownEditorCommands.toggleInlineCode();
      },
      insertCodeBlock: () => {
        if (mockMarkdownEditorBehavior.throwOnInsertCodeBlock) {
          throw new Error("Insert code block failed");
        }

        mockMarkdownEditorCommands.insertCodeBlock();
      },
    }));

    return (
      <div
        className={className}
        onChangeCapture={(event) => {
          if (!mockMarkdownEditorBehavior.skipUserEdit) {
            return;
          }

          const target = event.target;
          if (target instanceof HTMLTextAreaElement) {
            onUserEdit?.();
          }
        }}
      >
        <button ref={toolbarButtonRef} type="button">
          Toolbar action
        </button>
        <textarea
          ref={textareaRef}
          aria-label={ariaLabel}
          value={markdown}
          readOnly={readOnly}
          onChange={(event) => {
            if (mockMarkdownEditorBehavior.skipUserEdit) {
              onChange(event.target.value);
              return;
            }

            if (mockMarkdownEditorBehavior.changeBeforeUserEdit) {
              onChange(event.target.value);
              onUserEdit?.();
              return;
            }

            onUserEdit?.();
            onChange(event.target.value);
          }}
        />
      </div>
    );
  }
);

MockMarkdownRichEditor.displayName = "MockMarkdownRichEditor";

describe("test-only retained Markdown host", () => {
  afterEach(() => vi.restoreAllMocks());

  const props = { onExternalLink: () => {}, resolveLink: (href: string) => href };
  const createResult = () => ({
    syntaxSession: { dispose: vi.fn(), page: vi.fn() },
    syntaxRanges: 0,
    sourceChunks: 1,
    largestSourceChunkUnits: 1,
    sourceUnitsSent: 1,
    models: [],
    matches: [],
    preparationMs: 0,
    indexingMs: 0,
    clientAssemblyMs: 0,
    chunks: 1,
    largestChunkItems: 1,
  });
  const createView = () => ({
    consume: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn(),
    dispose: vi.fn(),
    stats: vi.fn().mockReturnValue({}),
    search: vi.fn(),
    jump: vi.fn(),
  });

  it("aborts its document job and disposes a syntax session that arrives after unmount", async () => {
    const view = createView();
    const result = createResult();
    vi.spyOn(markdownDocumentPreview, "mountMarkdownDocument").mockResolvedValue(view);
    let complete!: (value: typeof result) => void;
    const prepare = vi.fn<RetainedMarkdownPreviewProps["prepareDocument"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const host = render(
      <div>
        <div>
          <RetainedMarkdownPreview {...props} prepareDocument={prepare} generation={{ id: 10, source: "canonical" }} />
        </div>
      </div>
    );
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    const request = requireTestValue(prepare.mock.calls[0])[0];
    expect(request).toEqual(expect.objectContaining({ source: "canonical", generation: 10 }));
    await request.onRecords([{ kind: "text", id: 1, parent: 0, value: "canonical", from: 0 }]);
    expect(view.consume).toHaveBeenCalledWith([{ kind: "text", id: 1, parent: 0, value: "canonical", from: 0 }]);
    expect(document.head.textContent).toContain("markdown-retained-10");
    host.unmount();
    expect(request.signal.aborted).toBe(true);
    expect(view.dispose).toHaveBeenCalledOnce();
    await act(async () => complete(result));
    expect(result.syntaxSession.dispose).toHaveBeenCalledOnce();
    expect(view.finish).not.toHaveBeenCalled();
    expect(document.head.textContent).not.toContain("markdown-retained-10");
  });

  it("does not retain an earlier generation's failure and disposes a completed session", async () => {
    const view = createView();
    const result = createResult();
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(markdownDocumentPreview, "mountMarkdownDocument").mockResolvedValue(view);
    const prepare = vi
      .fn<RetainedMarkdownPreviewProps["prepareDocument"]>()
      .mockRejectedValueOnce(new Error("document failed"))
      .mockResolvedValueOnce(result);
    const host = render(
      <div>
        <div>
          <RetainedMarkdownPreview {...props} prepareDocument={prepare} generation={{ id: 11, source: "first" }} />
        </div>
      </div>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("document failed");
    host.rerender(
      <div>
        <div>
          <RetainedMarkdownPreview {...props} prepareDocument={prepare} generation={{ id: 12, source: "second" }} />
        </div>
      </div>
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(host.container.querySelector('[data-markdown-retained-state="complete"]')).not.toBeNull());
    expect(view.finish).toHaveBeenCalledWith(expect.any(Number), 0, result.syntaxSession);
    host.unmount();
    expect(result.syntaxSession.dispose).toHaveBeenCalledOnce();
  });
});

describe("MarkdownViewer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shares canonical unsaved Markdown rather than rendered HTML or stale draft state", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.stubGlobal("navigator", { share, canShare: () => true });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    );
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Saved\n");
    const raw = vi
      .spyOn(apiService, "getOriginalFileBlob")
      .mockResolvedValue(new Blob(["# Saved\n"], { type: "application/octet-stream" }));
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const onClose = vi.fn();
    renderViewerWithProps({ onClose });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    mockMarkdownEditorBehavior.canonicalMarkdownOverride = "# Latest unsaved\n";
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share as text" }));
    expect(share).toHaveBeenCalledExactlyOnceWith({ text: "# Latest unsaved\n" });
    expect(apiService.writeTextWithEditLock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const savedChoice = screen.getByRole("menuitem", { name: "Share as file" });
    await waitFor(() => expect(savedChoice).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(savedChoice);
    expect(await readBlobAsText(share.mock.calls[1]?.[0]?.files[0])).toBe("# Saved\n");
    expect(apiService.writeTextWithEditLock).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
    raw.mockResolvedValueOnce(new Blob(["# Latest unsaved\n"], { type: "application/octet-stream" }));
    fireEvent.change(editor, { target: { value: "# Latest unsaved\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
    share.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const updatedChoice = screen.getByRole("menuitem", { name: "Share as file" });
    await waitFor(() => expect(updatedChoice).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(updatedChoice);
    expect(await readBlobAsText(share.mock.calls[2]?.[0]?.files[0])).toBe("# Latest unsaved\n");
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    await screen.findByText(/"reason": "NotAllowedError"/);
    await userEvent.keyboard("{Escape}");
    const details = await screen.findByRole("button", { name: "Details" });
    await waitFor(() => expect(details).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });
  const viewerSearch = createViewerSearchTestDriver({
    assertCurrentMatchActive: () => {
      expect(
        [...CSS.highlights.entries()].some(
          ([name, ranges]) => name.startsWith("markdown-search-") && name.endsWith("-current") && ranges.size === 1
        )
      ).toBe(true);
    },
  });

  function enableSearchHighlights() {
    vi.stubGlobal("CSS", { highlights: new Map<string, Set<Range>>() });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      }
    );
  }

  function suppressExpectedRenderCrashNoise(message: string): () => void {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const combinedMessage = args.map((value) => (value instanceof Error ? value.message : String(value))).join(" ");

      if (combinedMessage.includes(message)) {
        return;
      }
    });

    const handleWindowError = (event: ErrorEvent) => {
      if (event.error instanceof Error && event.error.message === message) {
        event.preventDefault();
      }
    };

    window.addEventListener("error", handleWindowError);

    return () => {
      window.removeEventListener("error", handleWindowError);
      consoleErrorSpy.mockRestore();
    };
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("access_token", "mock-token");
    vi.restoreAllMocks();
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.spyOn(apiService, "writeTextWithEditLock").mockImplementation(async (connectionId, path, content, _lockInfo, options) => {
      await apiService.saveTextFile(connectionId, path, content, {
        filename: path.split("/").pop() ?? path,
        mimeType: requireTestValue(options).mimeType,
      });
    });
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValue(mockEditLockInfo);
    mockLoadMarkdownRichEditor.mockReset();
    mockLoadMarkdownRichEditor.mockResolvedValue({ default: MockMarkdownRichEditor });
    mockMarkdownEditorBehavior.changeBeforeUserEdit = false;
    mockMarkdownEditorBehavior.canonicalMarkdownOverride = null;
    mockMarkdownEditorBehavior.delayFocus = false;
    mockMarkdownEditorBehavior.emitNonEditableInputBeforeInitialChange = false;
    mockMarkdownEditorBehavior.emitUnannotatedDocChangeBeforeInitialChange = false;
    mockMarkdownEditorBehavior.emitUnannotatedDocChangeOnMarkdownPropChange = false;
    mockMarkdownEditorBehavior.completedUnannotatedDocChangesOnMarkdownPropChange = 0;
    mockMarkdownEditorBehavior.focusEditableBeforeInitialChange = false;
    mockMarkdownEditorBehavior.focusCurrentSearchResultCalls = 0;
    mockMarkdownEditorBehavior.focusResetsScrollPosition = false;
    mockMarkdownEditorBehavior.flushRejectError = null;
    mockMarkdownEditorBehavior.pendingSnapshot = null;
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = null;
    mockMarkdownEditorBehavior.lastSearchAutoNavigate = true;
    mockMarkdownEditorBehavior.lastSearchOpen = false;
    mockMarkdownEditorBehavior.lastSearchText = "";
    mockMarkdownEditorBehavior.lastRestoredScrollTop = null;
    mockMarkdownEditorBehavior.moveCaretToEndOnMarkdownPropChangeWhenFocused = false;
    mockMarkdownEditorBehavior.onNormalizationStateChange = null;
    mockMarkdownEditorBehavior.preserveSelectionCalls = 0;
    mockMarkdownEditorBehavior.restorePreservedSelectionCalls = 0;
    mockMarkdownEditorBehavior.skipUserEdit = false;
    mockMarkdownEditorBehavior.throwOnCanonicalExport = null;
    mockMarkdownEditorBehavior.throwOnInsertCodeBlock = false;
    mockMarkdownEditorBehavior.throwOnRender = false;
    mockMarkdownEditorCommands.createLink.mockReset();
    mockMarkdownEditorCommands.insertTable.mockReset();
    mockMarkdownEditorCommands.insertThematicBreak.mockReset();
    mockMarkdownEditorCommands.insertCodeBlock.mockReset();
    mockMarkdownEditorCommands.replaceAllSearchResults.mockReset();
    mockMarkdownEditorCommands.replaceCurrentSearchResult.mockReset();
    mockMarkdownEditorCommands.toggleBold.mockReset();
    mockMarkdownEditorCommands.toggleItalic.mockReset();
    mockMarkdownEditorCommands.toggleInlineCode.mockReset();
  });

  function renderViewer() {
    return renderViewerWithProps();
  }

  function renderViewerWithProps({ onClose = () => {}, isReadOnly = false }: { onClose?: () => void; isReadOnly?: boolean } = {}) {
    return render(
      <SambeeThemeProvider>
        <MarkdownViewer connectionId="conn1" path="/docs/readme.md" onClose={onClose} isReadOnly={isReadOnly} />
      </SambeeThemeProvider>
    );
  }

  it("prints read-only previews and reports native dialog failures without changing content", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Printable preview");
    const print = vi
      .spyOn(window, "print")
      .mockImplementationOnce(() => {
        throw new Error("Printing blocked");
      })
      .mockImplementation(() => {});
    renderViewerWithProps({ isReadOnly: true });
    await screen.findByRole("heading", { name: "Printable preview" });
    const button = screen.getByRole("button", { name: "Print" });
    await userEvent.click(button);
    expect(await screen.findByText("The print dialog couldn't open. Try Print from your browser menu.")).toBeInTheDocument();
    await userEvent.click(button);
    expect(print).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("The print dialog couldn't open. Try Print from your browser menu.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Printable preview" })).toBeInTheDocument();
  });

  it("doesn't offer preview printing while editing", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Printable preview");
    renderViewer();
    await screen.findByRole("heading", { name: "Printable preview" });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save" });
    expect(screen.queryByRole("button", { name: "Print" })).not.toBeInTheDocument();
  });

  it("restores native print scroll and selection and releases its lifecycle listeners", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("```js\nconst printed = 1;\n```\n");
    const { unmount } = renderViewer();
    const code = await screen.findByText("const printed = 1;");
    const viewport = screen.getByTestId("markdown-viewer-content");
    const pre = code.closest("pre")!;
    viewport.focus();
    viewport.scrollTop = 120;
    pre.scrollLeft = 48;
    const selection = window.getSelection()!;
    const range = new Range();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    act(() => window.dispatchEvent(new Event("beforeprint")));
    viewport.scrollTop = 0;
    pre.scrollLeft = 0;
    selection.removeAllRanges();
    act(() => window.dispatchEvent(new Event("afterprint")));
    await waitFor(() => {
      expect(viewport.scrollTop).toBe(120);
      expect(pre.scrollLeft).toBe(48);
      expect(selection.toString()).toBe(selected);
    });
    unmount();
    const frame = vi.spyOn(window, "requestAnimationFrame");
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("afterprint"));
    expect(frame).not.toHaveBeenCalled();
    selection.removeAllRanges();
  });

  it("reports a local normalization failure without blaming the server", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Preview");
    vi.spyOn(markdownCodePreparation, "normalizeMarkdownSource").mockRejectedValue(new Error("Markdown worker initialization failed"));
    renderViewer();

    expect(await screen.findByText("Failed to load markdown file: Markdown worker initialization failed")).toBeInTheDocument();
    expect(screen.queryByText(/Server is busy/)).not.toBeInTheDocument();
  });

  it("prepares collected requests only after their semantic code blocks commit without a collection parse", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("> ```js title\n> const x=1;\n> ```\n\n```\nplain\n```\n");
    const measure = vi.spyOn(performance, "measure");
    const prepare = vi.spyOn(highlightingService, "prepare").mockImplementation((requests) => {
      const code = document.querySelectorAll('[data-markdown-search-root="true"] pre code');
      expect([...code].map((element) => element.textContent)).toEqual(["const x=1;\n", "plain\n"]);
      expect(requests).toEqual([
        { text: "const x=1;", label: "js" },
        { text: "plain", label: null },
      ]);
      return Promise.resolve(requests.map(() => ({ ranges: [] })));
    });
    renderViewer();
    await screen.findByText("const x=1;");
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(measure.mock.calls.some(([name]) => name === "sambee:preview-preparation:collection-parse")).toBe(false);
  });

  it("keeps plain text, selection and search usable when syntax preparation fails", async () => {
    enableSearchHighlights();
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Preview\n\n```js\nconst x=1; const x=2;\n```\n");
    let rejectPreparation!: (error: Error) => void;
    const prepare = vi.spyOn(markdownSyntaxWorker, "prepareMarkdownSyntax").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPreparation = reject;
        })
    );
    const publish = vi.spyOn(markdownSyntaxPublication, "publishMarkdownSyntax");
    renderViewer();
    const code = await screen.findByText("const x=1; const x=2;");
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    await viewerSearch.openSearch("const x");
    await screen.findByText("1 / 2");
    const root = document.querySelector('[data-markdown-search-root="true"]');
    const viewport = screen.getByTestId("markdown-viewer-content");
    viewport.scrollTop = 123;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    try {
      await act(async () => rejectPreparation(new Error("Syntax worker response could not be decoded")));
      expect(document.querySelector('[data-markdown-search-root="true"]')).toBe(root);
      expect(root?.querySelector("code")).toBe(code);
      expect(code.textContent).toBe("const x=1; const x=2;\n");
      expect(selection.toString()).toBe(selected);
      expect(viewport.scrollTop).toBe(123);
      expect(screen.getByRole("heading", { name: "Preview" })).toBeInTheDocument();
      expect(screen.queryByText(/Failed to load markdown file/)).not.toBeInTheDocument();
      expect(publish).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Next match" }));
      expect(await screen.findByText("2 / 2")).toBeInTheDocument();
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      selection.removeAllRanges();
    }
  });

  it.each([2, 3])("publishes only the latest of %s documents after obsolete results arrive", async (documentCount) => {
    const documents = [
      { path: "/docs/readme.md", label: "js", text: "const old=1;" },
      { path: "/docs/replacement.md", label: "python", text: "print(2)" },
      { path: "/docs/latest.md", label: "rust", text: "let latest = 3;" },
    ].slice(0, documentCount);
    const load = vi.spyOn(apiService, "getFileContent");
    for (const document of documents) load.mockResolvedValueOnce(`\`\`\`${document.label}\n${document.text}\n\`\`\``);
    const completions: ((results: readonly PreparedCodeBlock[]) => void)[] = [];
    const prepare = vi.spyOn(highlightingService, "prepare").mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
    const publish = vi.spyOn(markdownSyntaxPublication, "publishMarkdownSyntax").mockReturnValue(vi.fn());
    const viewer = renderViewer();
    for (const [index, document] of documents.entries()) {
      if (index > 0)
        viewer.rerender(
          <SambeeThemeProvider>
            <MarkdownViewer connectionId="conn1" path={document.path} onClose={() => {}} />
          </SambeeThemeProvider>
        );
      await screen.findByText(document.text);
      await waitFor(() => expect(prepare).toHaveBeenCalledTimes(index + 1));
      expect(prepare.mock.calls[index]![0]).toEqual([{ text: document.text, label: document.label }]);
    }
    for (let index = documents.length - 2; index >= 0; index -= 1) {
      expect(prepare.mock.calls[index]![1]!.aborted).toBe(true);
      await act(async () => completions[index]!([{ ranges: [] }]));
    }
    expect(publish).not.toHaveBeenCalled();
    const latest = documents[documents.length - 1]!;
    expect(prepare.mock.calls[documents.length - 1]![1]!.aborted).toBe(false);
    await act(async () => completions[documents.length - 1]!([{ ranges: [] }]));
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0]![2].requests).toEqual([{ text: latest.text, label: latest.label }]);
    expect(publish.mock.calls[0]![0].querySelector("code")?.textContent).toBe(`${latest.text}\n`);
  });

  it("preserves the semantic DOM, active logical match and scroll when syntax becomes available", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("```js\nconst x=1; const x=2;\n```");
    let finish!: (results: readonly PreparedCodeBlock[]) => void;
    const prepare = vi.spyOn(highlightingService, "prepare").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    renderViewer();
    await screen.findByText("const x=1; const x=2;");
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const search = await viewerSearch.openSearch("missing");
    fireEvent.change(search, { target: { value: "const x" } });
    await screen.findByText("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await screen.findByText("2 / 2");
    const root = document.querySelector('[data-markdown-search-root="true"]')!;
    const scroll = root.parentElement!;
    scroll.scrollTop = 123;
    const scrollIntoView = vi.fn();
    const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      await act(async () =>
        finish([
          {
            ranges: [
              { from: 0, to: 5, categories: ["keyword"] },
              { from: 11, to: 16, categories: ["keyword"] },
            ],
          },
        ])
      );
      expect(document.querySelector('[data-markdown-search-root="true"]')).toBe(root);
      expect(root.querySelector("code")?.textContent).toBe("const x=1; const x=2;\n");
      expect(document.querySelectorAll(".sambee-syntax-keyword")).toHaveLength(0);
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
      expect(scroll.scrollTop).toBe(123);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledTimes(1);
      fireEvent.change(search, { target: { value: "x=2" } });
      expect(await screen.findByText("1 / 1")).toBeInTheDocument();
    } finally {
      if (previousScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it.each(["dark", "custom-alpha"])("changes %s preview colors without reprocessing content or resetting native state", async (variant) => {
    const load = vi.spyOn(apiService, "getFileContent").mockResolvedValue("```js\nconst x=1; const x=2;\n```");
    const prepare = vi.spyOn(highlightingService, "prepare").mockResolvedValue([{ ranges: [{ from: 0, to: 5, categories: ["keyword"] }] }]);
    const dispose = vi.fn();
    const publish = vi.spyOn(markdownSyntaxPublication, "publishMarkdownSyntax").mockReturnValue(dispose);
    const onClose = vi.fn();
    const tree = (theme: ReturnType<typeof createTheme>) => (
      <SambeeThemeProvider>
        <ThemeProvider theme={theme}>
          <MarkdownViewer connectionId="conn1" path="/docs/readme.md" onClose={onClose} />
        </ThemeProvider>
      </SambeeThemeProvider>
    );
    const viewer = render(tree(createTheme()));
    await screen.findByText("const x=1; const x=2;");
    await waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const search = await viewerSearch.openSearch("const x");
    await screen.findByText("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await screen.findByText("2 / 2");
    const root = document.querySelector<HTMLElement>('[data-markdown-search-root="true"]')!;
    const code = root.querySelector("code")!;
    const node = code.firstChild;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    const scroll = root.parentElement!;
    scroll.scrollTop = 123;
    const keyword = variant === "dark" ? "#80cbc4" : "#12ab3478";

    viewer.rerender(
      tree(
        createTheme({
          palette: {
            mode: "dark",
            syntax: { ...getDefaultTheme("dark").components!.syntax!, keyword },
          },
        })
      )
    );

    await waitFor(() => expect(root.style.getPropertyValue("--sambee-syntax-keyword")).toBe(keyword));
    expect(document.querySelector('[data-markdown-search-root="true"]')).toBe(root);
    expect(code.firstChild).toBe(node);
    expect(selection.toString()).toBe("const x=1; const x=2;\n");
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(scroll.scrollTop).toBe(123);
    expect(load).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    selection.removeAllRanges();
    fireEvent.change(search, { target: { value: "x=2" } });
    expect(await screen.findByText("1 / 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    viewer.unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("preserves native selection without replacing the preview when syntax becomes available", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("```js\nconst x=1;\n```");
    let finish!: (results: readonly PreparedCodeBlock[]) => void;
    vi.spyOn(highlightingService, "prepare").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    renderViewer();
    await screen.findByText("const x=1;");
    const root = document.querySelector('[data-markdown-search-root="true"]')!;
    const range = document.createRange();
    range.selectNodeContents(root.querySelector("code")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => finish([{ ranges: [{ from: 0, to: 5, categories: ["keyword"] }] }]));
    expect(document.querySelector('[data-markdown-search-root="true"]')).toBe(root);
    expect(selection.toString()).toBe("const x=1;\n");
    act(() => {
      selection.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.querySelector('[data-markdown-search-root="true"]')).toBe(root);
    expect(root.querySelector("code")?.textContent).toBe("const x=1;\n");
  });

  it("aborts obsolete syntax preparation on unmount and ignores a late result", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("```js\nconst x=1;\n```");
    let finish!: (results: readonly PreparedCodeBlock[]) => void;
    const prepare = vi.spyOn(highlightingService, "prepare").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const { unmount } = renderViewer();
    await screen.findByText("const x=1;");
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    const signal = prepare.mock.calls[0]![1]!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => finish([{ ranges: [{ from: 0, to: 5, categories: ["keyword"] }] }]));
    expect(document.querySelector(".sambee-syntax-keyword")).toBeNull();
  });

  it.each(["Back", "Close"])("leaves clean editing with %s and serializes rapid re-entry behind lock release", async (action) => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    let finishRelease!: () => void;
    const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    release.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        })
    );
    const viewer = "/viewer?file=smb%2Fdemo%2Fdocs%2Freadme.md&viewer=markdown";
    const router = createMemoryRouter([{ path: "/viewer", element: <RoutedMarkdownViewer /> }], {
      initialEntries: [viewer, `${viewer}&mode=edit`],
    });
    render(
      <SambeeThemeProvider>
        <RouterProvider router={router} />
      </SambeeThemeProvider>
    );
    await screen.findByRole("textbox", { name: "Markdown editor" });
    const blocked = vi.fn();
    const unsubscribe = router.subscribe((state) => {
      if ([...state.blockers.values()].some((blocker) => blocker.state === "blocked")) blocked();
    });
    try {
      if (action === "Back") await act(() => router.navigate(-1));
      else fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(router.state.location.search).not.toContain("mode=edit");
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveAttribute("readonly");

      await act(() => router.navigate(action === "Back" ? 1 : -1));
      expect(router.state.location.search).toContain("mode=edit");
      expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishRelease();
      });
      await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(2));
      await screen.findByRole("textbox", { name: "Markdown editor" });
      expect(blocked).not.toHaveBeenCalled();

      await act(() => router.navigate(-1));
      await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribe();
    }
  });

  it("opens an edit bookmark and guards dirty Back with Cancel and Discard", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    const router = createMemoryRouter(
      [
        { path: "/browse", element: <div>Files</div> },
        { path: "/viewer", element: <RoutedMarkdownViewer /> },
      ],
      { initialEntries: ["/browse", "/viewer?file=smb%2Fdemo%2Fdocs%2Freadme.md&viewer=markdown&mode=edit"] }
    );
    render(
      <SambeeThemeProvider>
        <RouterProvider router={router} />
      </SambeeThemeProvider>
    );
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Unsaved\n" } });
    await act(() => router.navigate(-1));
    let dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(router.state.location.pathname).toBe("/viewer");
    expect(editor).toHaveValue("# Unsaved\n");
    expect(release).not.toHaveBeenCalled();
    await act(() => router.navigate(-1));
    dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not expose markdown edit mode for read-only connections", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    const acquireLockSpy = vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });

    renderViewerWithProps({ isReadOnly: true });

    await screen.findByText("Readme");
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByText("Browse and preview content, but block writes and edit flows through Sambee.")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "e" });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
    });

    expect(acquireLockSpy).not.toHaveBeenCalled();
  });

  it("loads virtual markdown through its provider and blocks editing", async () => {
    const virtualSource = {
      kind: "virtual" as const,
      path: "docs/readme.md",
      location: {
        kind: "virtual" as const,
        providerId: "zip",
        connectionId: "conn1",
        source: { kind: "physical" as const, connectionId: "conn1", path: "archives/backup.zip" },
        path: "docs",
      },
    };
    const getArchiveMemberSpy = vi
      .spyOn(apiService, "getArchiveMember")
      .mockResolvedValue(new Blob(["# Virtual Readme\n"], { type: "text/markdown" }));
    const getFileContentSpy = vi.spyOn(apiService, "getFileContent").mockResolvedValue("physical content");
    const acquireLockSpy = vi.spyOn(apiService, "acquireEditLock");

    render(
      <SambeeThemeProvider>
        <MarkdownViewer connectionId="conn1" path="docs/readme.md" onClose={() => {}} virtualSource={virtualSource} />
      </SambeeThemeProvider>
    );

    await screen.findByText("Virtual Readme");
    expect(getArchiveMemberSpy).toHaveBeenCalledWith("conn1", "archives/backup.zip", "docs/readme.md", {
      download: undefined,
      request: { kind: "text" },
      signal: expect.anything(),
    });
    expect(getFileContentSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(acquireLockSpy).not.toHaveBeenCalled();
  });

  it("enters edit mode and acquires a lock for server-backed markdown files", async () => {
    const getFileContentSpy = vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    const acquireLockSpy = vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveFocus();
    });
    expect(acquireLockSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md");
    expect(getFileContentSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["pagehide", "registered"])("captures current Markdown before React publication on %s", async (trigger) => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["# Readme\n"], { type: "text/markdown" }));
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    renderViewer();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Older React draft\n" } });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const draftKey = `sambee_oidc_draft:test-user:conn1:markdown:${encodeURIComponent("/docs/readme.md")}`;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("Expected the native textarea value setter");
    valueSetter.call(editor, "# Latest editor revision\n");
    mockMarkdownEditorBehavior.canonicalMarkdownOverride = "# Latest editor revision\n";
    act(() => {
      if (trigger === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else snapshotRegisteredDrafts();
    });
    expect(loadDraft("conn1", "/docs/readme.md", "markdown")).toMatchObject({
      baseline: "# Readme\n",
      content: "# Latest editor revision\n",
    });
    await waitFor(() => expect(storage.mock.calls.filter(([key]) => key === draftKey).length).toBeGreaterThanOrEqual(2));
    expect(
      storage.mock.calls
        .filter(([key]) => key === draftKey)
        .every(([, value]) => JSON.parse(value).content === "# Latest editor revision\n")
    ).toBe(true);
    expect(loadDraft("conn1", "/docs/readme.md", "markdown")?.content).toBe("# Latest editor revision\n");
    expect(apiService.saveTextFile).not.toHaveBeenCalled();
  });

  it.each(["capture", "serialization", "storage"])("preserves the last recovery checkpoint on %s failure", async (failure) => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(authSession, "refreshIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["# Readme\n"], { type: "text/markdown" }));
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    renderViewer();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Acknowledged draft\n" } });
    act(() => {
      snapshotRegisteredDrafts();
    });
    const acknowledged = loadDraft("conn1", "/docs/readme.md", "markdown");
    expect(acknowledged?.content).toBe("# Acknowledged draft\n");
    fireEvent.change(editor, { target: { value: "# Newer draft\n" } });
    const error = new DOMException("The latest snapshot is unavailable", "InvalidStateError");
    if (failure === "capture") mockMarkdownEditorBehavior.flushRejectError = error;
    if (failure === "serialization") mockMarkdownEditorBehavior.throwOnCanonicalExport = error;
    const storage =
      failure === "storage"
        ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw error;
          })
        : null;
    try {
      act(() => {
        window.dispatchEvent(new Event("pagehide"));
        snapshotRegisteredDrafts();
      });
      expect(loadDraft("conn1", "/docs/readme.md", "markdown")).toEqual(acknowledged);
      expect(editor).toHaveValue("# Newer draft\n");
      expect(apiService.saveTextFile).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    } finally {
      mockMarkdownEditorBehavior.flushRejectError = null;
      mockMarkdownEditorBehavior.throwOnCanonicalExport = null;
      storage?.mockRestore();
    }
    act(() => {
      snapshotRegisteredDrafts();
    });
    expect(loadDraft("conn1", "/docs/readme.md", "markdown")?.content).toBe("# Newer draft\n");
  });

  it("retries recovery after normalization completes without changing the published draft", async () => {
    const token = { access_token: "mock-token", token_type: "bearer", user_id: "test-user", username: "test-user" };
    authSession.setAuthenticated(token, false);
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(authSession, "refreshIfNeeded").mockResolvedValue(undefined);
    vi.spyOn(authSession, "requestRefresh").mockResolvedValue(token);
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["# Readme\n"], { type: "text/markdown" }));
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const { unmount } = renderViewer();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Acknowledged draft\n" } });
      act(() => snapshotRegisteredDrafts());
      const acknowledged = loadDraft("conn1", "/docs/readme.md", "markdown");
      expect(acknowledged?.content).toBe("# Acknowledged draft\n");
      act(() => {
        mockMarkdownEditorBehavior.flushRejectError = new DOMException("Normalization pending", "InvalidStateError");
        mockMarkdownEditorBehavior.onNormalizationStateChange?.(true);
        fireEvent.change(editor, { target: { value: "# Latest | draft\n" } });
      });
      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(loadDraft("conn1", "/docs/readme.md", "markdown")).toEqual(acknowledged);

      act(() => {
        mockMarkdownEditorBehavior.flushRejectError = null;
        mockMarkdownEditorBehavior.onNormalizationStateChange?.(false);
      });
      await act(async () => vi.advanceTimersByTimeAsync(249));
      expect(loadDraft("conn1", "/docs/readme.md", "markdown")).toEqual(acknowledged);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(loadDraft("conn1", "/docs/readme.md", "markdown")).toMatchObject({
        baseline: "# Readme\n",
        content: "# Latest | draft\n",
      });
      expect(editor).toHaveValue("# Latest | draft\n");
      expect(apiService.saveTextFile).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("clears the local draft when Markdown returns to its saved baseline", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    renderViewer();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    const draftKey = `sambee_oidc_draft:test-user:conn1:markdown:${encodeURIComponent("/docs/readme.md")}`;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });

    await waitFor(() => expect(sessionStorage.getItem(draftKey)).not.toBeNull());

    fireEvent.change(editor, { target: { value: "# Readme\n" } });

    await waitFor(() => expect(sessionStorage.getItem(draftKey)).toBeNull());
  });

  it("shows a saved markdown viewer behind a recovered draft decision", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    sessionStorage.setItem(
      `sambee_oidc_draft:test-user:conn1:markdown:${encodeURIComponent("/docs/readme.md")}`,
      JSON.stringify({ baseline: "# Readme\n", content: "# Local draft\n", createdAt: Date.now(), updatedAt: Date.now() })
    );

    renderViewer();

    expect(await screen.findByText("Readme")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Unsaved local draft available" }), { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Resume editing" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    expect(editor).toHaveValue("# Local draft\n");
    expect(screen.getByRole("status", { name: /unsaved changes/i })).toBeInTheDocument();
  });

  it("offers recovery when the draft baseline differs from the saved markdown", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Current saved file\n");
    sessionStorage.setItem(
      `sambee_oidc_draft:test-user:conn1:markdown:${encodeURIComponent("/docs/readme.md")}`,
      JSON.stringify({ baseline: "# Earlier saved file\n", content: "# Local draft\n", createdAt: Date.now(), updatedAt: Date.now() })
    );

    renderViewer();

    expect(await screen.findByText("Current saved file")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();
  });

  it("keeps the Markdown recovery dialog open after an edit lock failure", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockRejectedValueOnce(new Error("locked"));
    sessionStorage.setItem(
      `sambee_oidc_draft:test-user:conn1:markdown:${encodeURIComponent("/docs/readme.md")}`,
      JSON.stringify({ baseline: "# Readme\n", content: "# Local draft\n", createdAt: Date.now(), updatedAt: Date.now() })
    );

    renderViewer();

    await userEvent.setup().click(await screen.findByRole("button", { name: "Resume editing" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume editing" })).toBeEnabled();
  });

  it("runs bold and italic shortcuts while Markdown editing has focus", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce(mockEditLockInfo);

    renderViewer();

    await screen.findByText("Readme");
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "b", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "i", ctrlKey: true });

    expect(mockMarkdownEditorCommands.toggleBold).toHaveBeenCalledTimes(1);
    expect(mockMarkdownEditorCommands.toggleItalic).toHaveBeenCalledTimes(1);
  });

  it("shows only Markdown editor shortcuts from the edit toolbar Help menu and F1", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce(mockEditLockInfo);

    renderViewer();

    await screen.findByText("Readme");
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Help" }));
    await userEvent.setup().click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));

    expect(await screen.findByRole("heading", { name: "Markdown editor shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Bold")).toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Toggle fullscreen")).not.toBeInTheDocument();

    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Markdown editor shortcuts" })).not.toBeInTheDocument();
    });
    editor.focus();
    fireEvent.keyDown(editor, { key: "F1" });

    expect(await screen.findByRole("heading", { name: "Markdown editor shortcuts" })).toBeInTheDocument();
  });

  it("keeps question marks as Markdown input and limits preview Help to viewer shortcuts", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce(mockEditLockInfo);

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.keyDown(document, { key: "?" });

    expect(await screen.findByRole("heading", { name: "Markdown viewer shortcuts" })).toBeInTheDocument();
    expect(screen.queryByText("Bold")).not.toBeInTheDocument();

    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Markdown viewer shortcuts" })).not.toBeInTheDocument();
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    await userEvent.setup().click(editor);
    await userEvent.setup().keyboard("?");

    expect(editor).toHaveValue("# Readme\n?");
    expect(screen.queryByRole("heading", { name: "Markdown editor shortcuts" })).not.toBeInTheDocument();
  });

  it("retries loading the editor after a transient module-load failure", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockLoadMarkdownRichEditor.mockRejectedValueOnce(new Error("Loading editor failed")).mockResolvedValueOnce({
      default: MockMarkdownRichEditor,
    });

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByText("Editor failed to load")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry editor" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });
    expect(mockLoadMarkdownRichEditor).toHaveBeenCalledTimes(2);
  });

  it("resets the viewer scroll position when entering edit mode", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n\nLine 2\n\nLine 3\n\nLine 4\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });

    renderViewer();

    await screen.findByText("Readme");

    const contentContainer = screen.getByTestId("markdown-viewer-content");

    contentContainer.scrollTop = 240;

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });

    expect(contentContainer.scrollTop).toBe(0);
  });

  it("closes exactly once on Escape from viewer content", async () => {
    const onClose = vi.fn();
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    renderViewerWithProps({ onClose });
    await screen.findByText("Readme");
    const content = screen.getByTestId("markdown-viewer-content");
    content.focus();

    fireEvent.keyDown(content, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("blurs toolbar focus on the first Escape and closes once on the next", async () => {
    const onClose = vi.fn();
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    renderViewerWithProps({ onClose });
    await screen.findByText("Readme");
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();

    fireEvent.keyDown(close, { key: "Escape" });
    expect(close).not.toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByTestId("markdown-viewer-content"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each(["Escape", "Close"])("exits edit mode on %s without closing the viewer or prompting when nothing changed", async (action) => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewerWithProps({ onClose });

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    await waitFor(() => {
      expect(editor).toHaveFocus();
    });

    if (action === "Escape") {
      fireEvent.keyDown(editor, { key: "Escape" });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", expect.objectContaining(mockEditLockInfo));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("renders only the close button in the top bar while editing", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce(mockEditLockInfo);

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await screen.findByRole("textbox", { name: "Markdown editor" });

    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("shows an error and stays in read-only mode when entering edit mode fails", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockRejectedValueOnce(new Error("Lock conflict"));

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Lock conflict");
      expect(screen.getByRole("alert").closest(".MuiSnackbar-root")).not.toBeNull();
    });
    expect(screen.getByRole("button", { name: "Retry editing" })).toBeEnabled();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
  });

  it("uses the shared lock toast, delayed retry feedback, and persistent read-only badge", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    const acquire = vi.spyOn(apiService, "acquireEditLock").mockRejectedValueOnce({ response: { status: 409 } });
    const timeout = vi.spyOn(window, "setTimeout");
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const retry = await screen.findByRole("button", { name: "Retry editing" });
    const toast = screen.getByRole("status");
    expect(toast.closest(".MuiSnackbar-root")).not.toBeNull();
    expect(toast).toHaveTextContent("This file is being edited in another session.");
    expect(within(toast).getByRole("img", { name: "Retry editing" })).toBeInTheDocument();
    const dismiss = timeout.mock.calls.find(([, delay]) => delay === 15_000)?.[0];
    if (typeof dismiss !== "function") throw new Error("Expected the shared 15-second dismissal timer");
    act(() => dismiss());
    await waitFor(() => expect(toast).not.toBeInTheDocument());
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(retry).toBeEnabled();
    acquire.mockRejectedValueOnce({ response: { status: 409 } });
    fireEvent.click(retry);
    const repeatedNotice = await screen.findByRole("status");
    expect(repeatedNotice).toHaveTextContent("This file is being edited in another session.");
    fireEvent.click(within(repeatedNotice).getByRole("button", { name: "Close" }));
    let finish: ((value: typeof mockEditLockInfo) => void) | undefined;
    acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    timeout.mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(3));
    const feedback = timeout.mock.calls.find(([, delay]) => delay === 200)?.[0];
    if (typeof feedback !== "function") throw new Error("Expected delayed acquisition feedback");
    act(() => feedback());
    expect(screen.getByRole("status", { name: "Checking write access..." }).closest(".MuiAlert-root")).toBeNull();
    expect(retry).toBeDisabled();
    fireEvent.keyDown(document, { ctrlKey: true, key: "r" });
    expect(acquire).toHaveBeenCalledTimes(3);
    if (!finish) throw new Error("Expected a pending lock retry");
    await act(async () => finish?.(mockEditLockInfo));
    expect(await screen.findByRole("textbox", { name: "Markdown editor" })).not.toHaveAttribute("readonly");
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
  });

  it("deduplicates transient heartbeat warnings and clears them on recovery", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    const heartbeatRequest = vi.spyOn(apiService, "heartbeatEditLock").mockRejectedValue(new Error("Disconnected"));
    const interval = vi.spyOn(window, "setInterval");
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    if (typeof heartbeat !== "function") throw new Error("Expected heartbeat interval");
    await act(async () => heartbeat());
    const warning = screen.getByRole("status");
    expect(warning).toHaveTextContent("Could not refresh the edit lock");
    expect(warning.closest(".MuiSnackbar-root")).not.toBeNull();
    fireEvent.click(within(warning).getByRole("button", { name: "Close" }));
    await act(async () => heartbeat());
    expect(screen.queryByText(/Could not refresh the edit lock/)).not.toBeInTheDocument();
    expect(editor).not.toHaveAttribute("readonly");
    heartbeatRequest.mockResolvedValueOnce(undefined);
    await act(async () => heartbeat());
    await act(async () => heartbeat());
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh the edit lock");
    heartbeatRequest.mockResolvedValue(undefined);
    await act(async () => heartbeat());
    expect(screen.queryByText(/Could not refresh the edit lock/)).not.toBeInTheDocument();
  });

  it.each(["Keep my draft", "Use saved file"])(
    "preserves the draft after lock loss and resolves remote changes with %s",
    async (choice) => {
      const read = vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
      vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
      vi.spyOn(apiService, "heartbeatEditLock").mockRejectedValueOnce(new ExpiredEditLockError());
      const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
      const interval = vi.spyOn(window, "setInterval");
      renderViewer();
      await screen.findByText("Readme");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
      fireEvent.change(editor, { target: { value: "# Retained draft\n" } });
      const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (typeof heartbeat !== "function") throw new Error("Expected heartbeat interval");
      await act(async () => heartbeat());
      expect(editor).toHaveAttribute("readonly");
      expect(editor).toHaveValue("# Retained draft\n");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(release).toHaveBeenCalledTimes(1);
      read.mockResolvedValue("# External change\n");
      fireEvent.click(screen.getByRole("button", { name: "Retry editing" }));
      const dialog = await screen.findByRole("dialog", { name: "File changed" });
      expect(editor).toHaveAttribute("readonly");
      fireEvent.click(within(dialog).getByRole("button", { name: choice }));
      await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
      expect(editor).toHaveValue(choice === "Keep my draft" ? "# Retained draft\n" : "# External change\n");
      expect(screen.queryByText("Read only")).not.toBeInTheDocument();
    }
  );

  it.each([false, true])(
    "compares the normalized saved source on lock retry without inventing a conflict (editor normalization: %s)",
    async (editorNormalization) => {
      vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
      vi.spyOn(markdownCodePreparation, "normalizeMarkdownSource").mockResolvedValue("# Readme\n\n");
      if (editorNormalization) mockMarkdownEditorBehavior.initialNormalizedMarkdown = "# Readme\n\n\n";
      vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
      vi.spyOn(apiService, "heartbeatEditLock").mockRejectedValueOnce(new ExpiredEditLockError());
      vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
      const interval = vi.spyOn(window, "setInterval");
      renderViewer();
      await screen.findByText("Readme");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      });
      const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
      fireEvent.change(editor, { target: { value: "# Retained draft\n" } });
      const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (typeof heartbeat !== "function") throw new Error("Expected heartbeat interval");
      await act(async () => heartbeat());
      expect(editor).toHaveAttribute("readonly");
      expect(editor).toHaveValue("# Retained draft\n");
      fireEvent.click(screen.getByRole("button", { name: "Retry editing" }));
      await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
      expect(screen.queryByRole("dialog", { name: "File changed" })).not.toBeInTheDocument();
      expect(editor).toHaveValue("# Retained draft\n");
      expect(markdownCodePreparation.normalizeMarkdownSource).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps lock loss inside an active unsaved-changes dialog and restores the toast after Cancel", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "heartbeatEditLock").mockRejectedValueOnce(new ExpiredEditLockError());
    const interval = vi.spyOn(window, "setInterval");
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Retained draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    const heartbeat = interval.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    if (typeof heartbeat !== "function") throw new Error("Expected heartbeat interval");
    await act(async () => heartbeat());
    expect(within(dialog).getByRole("status")).toHaveTextContent("The edit lock is no longer active");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(document.querySelector(".MuiSnackbar-root")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.querySelector(".MuiSnackbar-root")).not.toBeNull());
    expect(editor).toHaveValue("# Retained draft\n");
    expect(editor).toHaveAttribute("readonly");
  });

  it("shows each failed Save in a toast without discarding edits or stealing focus", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("# Readme\n");
    vi.spyOn(apiService, "saveTextFile").mockRejectedValue(new Error("Disk full"));
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Unsaved\n" } });
    for (const attempt of [1, 2]) {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const failure = await screen.findByRole("alert");
      expect(failure).toHaveTextContent("Disk full");
      expect(failure.closest(".MuiSnackbar-root")).not.toBeNull();
      expect(apiService.saveTextFile).toHaveBeenCalledTimes(attempt);
      fireEvent.click(within(failure).getByRole("button", { name: "Close" }));
      expect(editor).toHaveValue("# Unsaved\n");
      expect(editor).not.toHaveAttribute("readonly");
    }
  });

  it("saves markdown changes and stays in edit mode", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", "# Updated\n", {
        filename: "readme.md",
        mimeType: "text/markdown;charset=utf-8",
      });
    });

    expect(await screen.findByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
  });

  it("saves canonical editor export instead of stale outer draft state", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.canonicalMarkdownOverride = "# Canonical\n";

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Stale draft\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", "# Canonical\n", {
        filename: "readme.md",
        mimeType: "text/markdown;charset=utf-8",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveValue("# Canonical\n");
    });
  });

  it("shows save-time Markdown normalization in the open editor", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "* first\n* second\n\n1. first\n2. second\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const normalizedMarkdown = "- first\n- second\n\n1. first\n1. second\n";

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", normalizedMarkdown, {
        filename: "readme.md",
        mimeType: "text/markdown;charset=utf-8",
      });
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveValue(normalizedMarkdown);
    });
  });

  it("remains pristine after an unannotated editor reformat following Ctrl+S", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.canonicalMarkdownOverride = "# Canonical\n";
    mockMarkdownEditorBehavior.emitUnannotatedDocChangeOnMarkdownPropChange = true;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(editor).toHaveValue("# Canonical\n");
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(mockMarkdownEditorBehavior.completedUnannotatedDocChangesOnMarkdownPropChange).toBeGreaterThan(0);
    });

    mockMarkdownEditorBehavior.canonicalMarkdownOverride = null;
    fireEvent.change(editor, { target: { value: "# Canonical\n\nNext edit\n" } });

    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("restores focus to the editor after save even when editor focus is delayed", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.delayFocus = true;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toHaveFocus();
    });
  });

  it("does not flip the editor surface to read-only during a stay-in-editor save", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    let resolveSave: () => void = uninitializedTestCallback;
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
    expect(editor.readOnly).toBe(false);

    resolveSave?.();

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });
  });

  it("preserves the caret position after saving", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    editor.focus();
    editor.setSelectionRange(3, 3);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(3);
      expect(editor.selectionEnd).toBe(3);
    });
  });

  it("restores the preserved caret after save even if the refreshed editor content moves it to the end", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.moveCaretToEndOnMarkdownPropChangeWhenFocused = true;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    editor.focus();
    editor.setSelectionRange(3, 3);

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(3);
      expect(editor.selectionEnd).toBe(3);
    });
  });

  it("restores focus to the editor after saving with Ctrl+S", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    editor.focus();

    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", "# Updated\n", {
        filename: "readme.md",
        mimeType: "text/markdown;charset=utf-8",
      });
      expect(editor).toHaveFocus();
    });
  });

  it("shows an error and stays in edit mode when saving fails", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockRejectedValueOnce(new Error("Disk full"));
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to save markdown changes.: Disk full")).toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
  });

  it.each([
    new Error("Flush failed"),
    new DOMException("Markdown publication timed out", "TimeoutError"),
    new DOMException("Finish the current input method composition before saving or creating a recovery snapshot.", "InvalidStateError"),
  ])("retains edits and permits retry when snapshot capture fails: %s", async (failure) => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.flushRejectError = failure;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText(`Failed to save markdown changes.: ${failure.message}`)).toBeInTheDocument();
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(editor).toHaveValue("# Updated\n");
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
    mockMarkdownEditorBehavior.flushRejectError = null;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    expect(editor).toHaveValue("# Updated\n");
  });

  it.each([
    { latest: "# Newer unsaved\n", pending: false },
    { latest: "# Saved\n", pending: false },
    { latest: "# Newer unsaved\n", pending: true },
  ])("acknowledges Markdown Save without losing current draft $latest with normalization pending $pending", async ({ latest, pending }) => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["# Saved\n"], { type: "text/markdown" }));
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    let finishWrite: (() => void) | undefined;
    const save = vi.spyOn(apiService, "saveTextFile").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Saved\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "# Newer unsaved\n" } });
    if (latest === "# Saved\n") fireEvent.change(editor, { target: { value: latest } });
    if (pending) mockMarkdownEditorBehavior.flushRejectError = new DOMException("Normalization pending", "InvalidStateError");
    if (!finishWrite) throw new Error("Expected a pending Markdown write");
    await act(async () => {
      finishWrite?.();
    });

    expect(editor).toHaveValue(latest);
    expect(screen.queryByText(/Failed to save markdown changes/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    if (latest !== "# Saved\n") {
      const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    } else {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    }
    expect(await screen.findByRole("heading", { name: "Saved" })).toBeInTheDocument();
  });

  it("keeps edits made during snapshot preparation dirty after saving the captured revision", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["# Captured\n"], { type: "text/markdown" }));
    const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    const save = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    let finishSnapshot!: () => void;
    mockMarkdownEditorBehavior.pendingSnapshot = new Promise<void>((resolve) => {
      finishSnapshot = resolve;
    });
    renderViewer();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Captured\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "# Newer while preparing\n" } });
    await act(async () => {
      finishSnapshot();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(save).toHaveBeenCalledExactlyOnceWith("conn1", "/docs/readme.md", "# Captured\n", {
      filename: "readme.md",
      mimeType: "text/markdown;charset=utf-8",
    });
    expect(editor).toHaveValue("# Newer while preparing\n");
    expect(screen.getByRole("status", { name: /unsaved changes/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(release).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("heading", { name: "Captured" })).toBeInTheDocument();
    expect(save).toHaveBeenCalledOnce();
  });

  it("preserves newer edits after a delayed write fails and retries the latest snapshot", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    const release = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    let failWrite: ((reason: Error) => void) | undefined;
    const save = vi
      .spyOn(apiService, "saveTextFile")
      .mockResolvedValue()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failWrite = reject;
          })
      );
    renderViewer();
    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# First snapshot\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[2]).toBe("# First snapshot\n");
    fireEvent.change(editor, { target: { value: "# Newer unsaved\n" } });
    const rejectWrite = failWrite;
    if (!rejectWrite) throw new Error("Expected a pending Markdown write");
    await act(async () => rejectWrite(new Error("Disk full")));
    expect(await screen.findByText("Failed to save markdown changes.: Disk full")).toBeInTheDocument();
    expect(editor).toHaveValue("# Newer unsaved\n");
    expect(editor).not.toHaveAttribute("readonly");
    expect(release).not.toHaveBeenCalled();
    fireEvent.click(
      requireTestValue(screen.getAllByRole("button", { name: "Close" }).find((button) => !button.closest(".MuiSnackbar-root")))
    );
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]?.[2]).toBe("# Newer unsaved\n");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("heading", { name: "Newer unsaved" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
  });

  it("fails closed when canonical markdown export throws before save", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.throwOnCanonicalExport = new Error("Export failed");

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to save markdown changes.: Export failed")).toBeInTheDocument();
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
  });

  it("shows the backend read-only detail when a stale client save is rejected with 403", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "saveTextFile").mockRejectedValueOnce({
      response: {
        data: { detail: "Connection is read-only" },
        status: 403,
      },
    });
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Connection is read-only")).toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
  });

  it("does not steal search focus when delayed preview autofocus runs", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("alpha beta\n");
    const callbacks: (() => void)[] = [];
    const originalTimeout = setTimeout;
    const timer = vi.spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === MARKDOWN_VIEWER_CONTENT_AUTOFOCUS_DELAY_MS && typeof callback === "function") {
        callbacks.push(() => callback(...args));
      }
      return originalTimeout(callback, delay, ...args);
    });
    try {
      renderViewer();
      await screen.findByText("alpha beta");
      const search = await viewerSearch.openSearch("alpha");
      expect(search).toHaveFocus();
      expect(callbacks.length).toBeGreaterThan(0);
      act(() => {
        for (const callback of callbacks) callback();
      });
      expect(search).toHaveFocus();
      fireEvent.change(search, { target: { value: "beta" } });
      expect(await screen.findByText("1 / 1")).toBeInTheDocument();
    } finally {
      timer.mockRestore();
    }
  });

  it("restores open search after leaving edit mode in a progressively rendered preview", async () => {
    enableSearchHighlights();
    const paragraphCount = 1500;
    const markdown = `# Search fixture\n\n${"needle ordinary paragraph text for the search fixture.\n\n".repeat(paragraphCount)}`;
    vi.spyOn(apiService, "getFileContent").mockResolvedValue(markdown);
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob([markdown], { type: "text/markdown" }));
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });
    const closeViewerButton = screen.getByRole("button", { name: "Close" });
    await viewerSearch.openSearch("needle");
    fireEvent.click(closeViewerButton);

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.querySelector('[data-markdown-publication="complete"]')).not.toBeNull());
    expect(screen.getByDisplayValue("needle")).toBeInTheDocument();
    expect(await screen.findByText(`1 / ${paragraphCount}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next match" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByText(`2 / ${paragraphCount}`)).toBeInTheDocument();
  });

  it("searches rendered markdown and navigates between matches", async () => {
    enableSearchHighlights();
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");

    renderViewer();

    await screen.findByText("Alpha");
    await viewerSearch.expectFirstMatchActive({
      searchTerm: "alpha",
      expectedCounterText: "1 / 3",
    });

    expect(document.querySelectorAll('mark[data-text-search-highlight="true"]')).toHaveLength(0);

    await viewerSearch.expectRefinedSearchKeepsCurrentMatchActive({
      refinedSearchTerm: "al",
      expectedCounterText: "1 / 3",
    });

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));

    await waitFor(() => {
      expect(screen.getByText("2 / 3")).toBeInTheDocument();
    });
  });

  it("treats cross-inline markdown text as a single search match", async () => {
    enableSearchHighlights();
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("sam**bee** sambee\n");

    renderViewer();

    await screen.findByText("sambee", { exact: false });
    await viewerSearch.openSearch("sambee");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    const current = [...CSS.highlights.entries()].find(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current"));
    expect(requireTestValue([...current![1]][0]).toString()).toBe("sambee");
    expect(document.querySelectorAll('mark[data-text-search-highlight="true"]')).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));

    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });
  });

  it("opens rendered markdown links in a new tab while in viewer mode", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("[Docs](https://example.com/docs)\n");

    renderViewer();

    const link = await screen.findByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders canonical table-cell br tags as visual line breaks only inside table cells", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("Outside <br /> stays literal.\n\n| A |\n| - |\n| foo<br />bar |\n");

    renderViewer();

    expect(await screen.findByText("Outside <br /> stays literal.")).toBeInTheDocument();

    const tableCell = screen.getByRole("cell", { name: /foo\s+bar/ });
    expect(tableCell.querySelectorAll("br")).toHaveLength(1);

    const viewerRoot = tableCell.closest('[data-markdown-search-root="true"]');
    if (!(viewerRoot instanceof HTMLElement)) {
      throw new Error("Expected viewer root to exist");
    }

    expect(viewerRoot.querySelectorAll("br")).toHaveLength(1);
  });

  it("does not rewrite inline code containing br text inside a table cell into DOM breaks", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("| A |\n| - |\n| `foo <br /> bar` |\n");

    renderViewer();

    const codeElement = await screen.findByText("foo <br /> bar");
    expect(codeElement.tagName).toBe("CODE");

    const tableCell = codeElement.closest("td");
    if (!(tableCell instanceof HTMLTableCellElement)) {
      throw new Error("Expected code element to be inside a table cell");
    }

    expect(tableCell.querySelectorAll("br")).toHaveLength(0);
  });

  it("preserves mixed inline formatting while rendering table-cell br tags structurally", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("| A |\n| - |\n| *Alpha*<br />[Docs](https://example.com/docs) |\n");

    renderViewer();

    const emphasis = await screen.findByText("Alpha");
    expect(emphasis.tagName).toBe("EM");

    const link = screen.getByRole("link", { name: "Docs" });
    const tableCell = link.closest("td");
    if (!(tableCell instanceof HTMLTableCellElement)) {
      throw new Error("Expected link to be inside a table cell");
    }

    expect(tableCell.querySelectorAll("br")).toHaveLength(1);
    expect(link).toHaveAttribute("href", "https://example.com/docs");
  });

  it("opens a markdown link on the first click even before viewer autofocus settles", async () => {
    const windowOpenSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("[Docs](https://example.com/docs)\n");

    renderViewer();

    const link = await screen.findByRole("link", { name: "Docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");

    // The onClick handler on external links calls window.open() directly,
    // ensuring the link opens even if the browser misses the native
    // <a target="_blank"> navigation due to mid-event React re-renders.
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(windowOpenSpy).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");

    windowOpenSpy.mockRestore();
  });

  it("restores viewer focus after opening an external markdown link so shortcuts still work", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("[Docs](https://example.com/docs)\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce(mockEditLockInfo);

    renderViewer();

    const viewerContent = screen.getByTestId("markdown-viewer-content");
    await within(viewerContent).findByRole("link", { name: "Docs" });
    expect(viewerContent).toHaveAttribute("tabindex", "0");

    await waitFor(() => {
      expect(viewerContent).toHaveFocus();
    });

    const link = within(viewerContent).getByRole("link", { name: "Docs" });
    link.focus();
    expect(link).toHaveFocus();

    fireEvent.click(link);

    await waitFor(() => {
      expect(viewerContent).toHaveFocus();
    });

    fireEvent.keyDown(document, { key: "e" });

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });
  });

  it("keeps edit mode open when discard confirmation is rejected", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(unsavedDialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    expect(await screen.findByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("prompts on Escape after a real edit even if the editor reports change before user-edit", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    mockMarkdownEditorBehavior.changeBeforeUserEdit = true;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });

    await screen.findByLabelText("Unsaved changes");

    fireEvent.keyDown(editor, { key: "Escape" });

    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(unsavedDialog).toBeInTheDocument();

    fireEvent.click(within(unsavedDialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    expect(await screen.findByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
  });

  it("restores the caret position after cancelling the unsaved changes dialog", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });

    editor.focus();
    editor.setSelectionRange(3, 3);

    fireEvent.keyDown(editor, { key: "Escape" });

    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(unsavedDialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(editor).toHaveFocus();
    });

    expect(editor.selectionStart).toBe(3);
    expect(editor.selectionEnd).toBe(3);
  });

  it("preserves editor state before opening the unsaved changes dialog", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Updated\n" } });

    editor.focus();
    editor.setSelectionRange(3, 3);
    editor.scrollTop = 220;

    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
      expect(mockMarkdownEditorBehavior.preserveSelectionCalls).toBeGreaterThan(0);
    });
  });

  it("shows an unsaved indicator in the header when the markdown draft is dirty", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });

    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "# Readme\nUpdated\n" } });

    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("does not mark the document dirty from a non-editable mount event before the initial editor normalization change", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.emitNonEditableInputBeforeInitialChange = true;
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = "# Readme\n\n";

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await screen.findByRole("textbox", { name: "Markdown editor" });

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("treats an unannotated mount-time document change as initial baseline synchronization", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.emitUnannotatedDocChangeBeforeInitialChange = true;
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = "# Readme\n\n";

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });

    fireEvent.change(editor, { target: { value: "# Readme\n\nUpdated\n" } });

    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("does not mark the document dirty when autofocus happens before the initial editor normalization change", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.focusEditableBeforeInitialChange = true;
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = "# Readme\n\n";

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await screen.findByRole("textbox", { name: "Markdown editor" });

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("seeds legacy table-cell br variants from canonical markdown without a false dirty state", async () => {
    const loadedMarkdown = ["| Column |", "| --- |", "| foo<BR>bar |"].join("\n");
    const canonicalMarkdown = normalizeMarkdownTableCellLineBreaks(loadedMarkdown);

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce(loadedMarkdown);
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = canonicalMarkdown;

    renderViewer();

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;

    expect(editor.value).toBe(canonicalMarkdown);

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });

    fireEvent.change(editor, { target: { value: `${canonicalMarkdown}\nEdited\n` } });

    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("normalizes malformed closing br tags in table cells before rendering and editor re-entry", async () => {
    const loadedMarkdown = ["| Column |", "| --- |", "| foo</br>bar |", ""].join("\n");
    const canonicalMarkdown = normalizeMarkdownTableCellLineBreaks(loadedMarkdown);

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce(loadedMarkdown);
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = canonicalMarkdown;

    renderViewer();

    const tableCell = await screen.findByRole("cell", { name: /foo\s+bar/ });
    expect(tableCell.querySelectorAll("br")).toHaveLength(1);
    expect(tableCell.textContent).toBe("foo\nbar");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;

    expect(editor.value).toBe(canonicalMarkdown);
    expect(editor.value).not.toContain("</br>");

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("seeds numeric table-cell newline entities from canonical markdown without a false dirty state", async () => {
    const loadedMarkdown = ["| Left | Right |", "| --- | --- |", "| foo&#10;bar | baz&#x000A;qux |"].join("\n");
    const canonicalMarkdown = normalizeMarkdownTableCellLineBreaks(loadedMarkdown);

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce(loadedMarkdown);
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = canonicalMarkdown;

    renderViewer();

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;

    expect(editor.value).toBe(canonicalMarkdown);

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("keeps already-canonical table-cell markdown pristine on the first no-op publication", async () => {
    const loadedMarkdown = ["| Column |", "| --- |", "| foo<br />bar |", ""].join("\n");
    const canonicalMarkdown = normalizeMarkdownTableCellLineBreaks(loadedMarkdown);

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce(loadedMarkdown);
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = canonicalMarkdown;

    renderViewer();

    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = (await screen.findByRole("textbox", { name: "Markdown editor" })) as HTMLTextAreaElement;

    expect(editor.value).toBe(canonicalMarkdown);

    await waitFor(() => {
      expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
    });
  });

  it("keeps the unsaved indicator when the editor change event arrives without a user-edit callback", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    mockMarkdownEditorBehavior.skipUserEdit = true;

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    await waitFor(() => {
      expect(editor).toHaveFocus();
    });
    fireEvent.change(editor, { target: { value: "# Readme\nUpdated\n" } });

    expect(await screen.findByLabelText("Unsaved changes")).toBeInTheDocument();
  });

  it("prompts again after dismissing the unsaved changes dialog with Escape", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });

    fireEvent.keyDown(editor, { key: "Escape" });
    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await waitFor(() => {
      expect(within(unsavedDialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    });
    expect(within(unsavedDialog).getByRole("button", { name: "Cancel" })).toHaveClass("MuiButton-outlined");
    expect(within(unsavedDialog).getByRole("button", { name: "Discard" })).toHaveClass("MuiButton-contained", "MuiButton-colorError");
    expect(within(unsavedDialog).getByRole("button", { name: "Save" })).toHaveClass("MuiButton-contained", "MuiButton-colorPrimary");

    fireEvent.keyDown(unsavedDialog, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    });

    const editorAfterDismiss = await screen.findByRole("textbox", { name: "Markdown editor" });
    await waitFor(() => {
      expect(document.activeElement).not.toBeNull();
    });

    expect(releaseSpy).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement ?? editorAfterDismiss, { key: "Escape" });

    const reopenedUnsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    await waitFor(() => {
      expect(within(reopenedUnsavedDialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    });

    expect(reopenedUnsavedDialog).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("discards to the viewer and requires a second Close to close the viewer", async () => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewerWithProps({ onClose });

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(unsavedDialog).getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(releaseSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", expect.objectContaining(mockEditLockInfo));
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    });
    expect(await screen.findByText("Readme")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("saves to the viewer and requires a second Close to close the viewer", async () => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const saveSpy = vi.spyOn(apiService, "saveTextFile").mockResolvedValue();
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewerWithProps({ onClose });

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const unsavedDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(unsavedDialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", "# Updated\n", {
        filename: "readme.md",
        mimeType: "text/markdown;charset=utf-8",
      });
      expect(releaseSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", expect.objectContaining(mockEditLockInfo));
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    });
    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each(["Cancel", "failed Save"])("keeps Markdown editing after Close and %s", async (choice) => {
    const onClose = vi.fn();
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    const releaseSpy = vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    if (choice === "failed Save") {
      vi.mocked(apiService.writeTextWithEditLock).mockRejectedValueOnce(new Error("Save failed"));
    }
    renderViewerWithProps({ onClose });

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: choice === "Cancel" ? "Cancel" : "Save" }));

    if (choice === "Cancel") {
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument());
    } else {
      await waitFor(() => expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled());
      expect(dialog).toBeInTheDocument();
    }
    expect(editor).toHaveValue("# Updated\n");
    expect(editor).not.toHaveAttribute("readonly");
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends heartbeat requests while an edit lock is held", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Readme\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValueOnce({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.md",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    const heartbeatSpy = vi.spyOn(apiService, "heartbeatEditLock").mockResolvedValue();
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    await waitFor(() => {
      expect(setIntervalSpy).toHaveBeenCalled();
    });

    const heartbeatIntervalCall = setIntervalSpy.mock.calls.find((call) => call[1] === 30_000);
    const heartbeatCallback = heartbeatIntervalCall?.[0];
    expect(typeof heartbeatCallback).toBe("function");

    await act(async () => {
      await (heartbeatCallback as TimerHandler & (() => Promise<void> | void))();
    });

    await waitFor(() => {
      expect(heartbeatSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", expect.objectContaining(mockEditLockInfo));
    });
  });

  it("closes search instead of the viewer when Escape is pressed in the search input", async () => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");

    renderViewerWithProps({ onClose });

    await screen.findByText("Alpha");
    await viewerSearch.expectEscapeClosesSearch({
      searchTerm: "alpha",
      assertViewerStillOpen: () => {
        expect(onClose).not.toHaveBeenCalled();
      },
    });
  });

  it("closes shortcuts help on Escape without closing the markdown viewer", async () => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");

    renderViewerWithProps({ onClose });

    await screen.findByText("Alpha");

    fireEvent.keyDown(document, { key: "?" });

    await waitFor(() => {
      expect(screen.getByText("Markdown viewer shortcuts")).toBeInTheDocument();
    });

    const searchInput = screen.getByRole("searchbox");
    await waitFor(() => expect(searchInput).toHaveFocus());
    fireEvent.keyDown(searchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("Markdown viewer shortcuts")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("searches markdown while editing and navigates between matches", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    await viewerSearch.openSearch("alpha");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));

    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });
  });

  it("seeds edit-mode search from the current editor selection without moving it", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = requireTestElement(await screen.findByRole("textbox", { name: "Markdown editor" }), HTMLTextAreaElement);
    const selectionStart = editor.value.indexOf("beta");
    const selectionEnd = selectionStart + "beta".length;

    editor.focus();
    editor.setSelectionRange(selectionStart, selectionEnd);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search (⇅ for history)")).toHaveValue("beta");
      expect(mockMarkdownEditorBehavior.lastSearchText).toBe("beta");
      expect(editor.selectionStart).toBe(selectionStart);
      expect(editor.selectionEnd).toBe(selectionEnd);
    });
  });

  it("reseeds edit-mode search from the latest selection when reopening search", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = requireTestElement(await screen.findByRole("textbox", { name: "Markdown editor" }), HTMLTextAreaElement);
    const betaStart = editor.value.indexOf("beta");
    const betaEnd = betaStart + "beta".length;

    editor.focus();
    editor.setSelectionRange(betaStart, betaEnd);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    const firstSearchInput = await screen.findByPlaceholderText("Search (⇅ for history)");

    await waitFor(() => {
      expect(firstSearchInput).toHaveValue("beta");
    });

    fireEvent.keyDown(firstSearchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search (⇅ for history)")).not.toBeInTheDocument();
    });

    const alphaStart = editor.value.lastIndexOf("alpha");
    const alphaEnd = alphaStart + "alpha".length;

    editor.focus();
    editor.setSelectionRange(alphaStart, alphaEnd);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search (⇅ for history)")).toHaveValue("alpha");
      expect(mockMarkdownEditorBehavior.lastSearchText).toBe("alpha");
      expect(editor.selectionStart).toBe(alphaStart);
      expect(editor.selectionEnd).toBe(alphaEnd);
    });
  });

  it("clears the search input when reopening edit-mode search without a selection", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = requireTestElement(await screen.findByRole("textbox", { name: "Markdown editor" }), HTMLTextAreaElement);
    const betaStart = editor.value.indexOf("beta");
    const betaEnd = betaStart + "beta".length;

    editor.focus();
    editor.setSelectionRange(betaStart, betaEnd);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    const firstSearchInput = await screen.findByPlaceholderText("Search (⇅ for history)");

    await waitFor(() => {
      expect(firstSearchInput).toHaveValue("beta");
    });

    fireEvent.keyDown(firstSearchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search (⇅ for history)")).not.toBeInTheDocument();
    });

    editor.focus();
    editor.setSelectionRange(betaEnd, betaEnd);

    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    const reopenedSearchInput = await screen.findByPlaceholderText("Search (⇅ for history)");

    await waitFor(() => {
      expect(reopenedSearchInput).toHaveFocus();
      expect(reopenedSearchInput).toHaveValue("");
      expect(mockMarkdownEditorBehavior.lastSearchAutoNavigate).toBe(false);
    });
  });

  it("returns focus to the active editor match when edit-mode search is dismissed with Escape", async () => {
    const onClose = vi.fn();

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewerWithProps({ onClose });

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    const searchInput = await viewerSearch.openSearch("alpha");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(searchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search (⇅ for history)")).not.toBeInTheDocument();
      expect(editor).toHaveFocus();
    });

    expect(mockMarkdownEditorBehavior.focusCurrentSearchResultCalls).toBeGreaterThan(0);
    expect(mockMarkdownEditorBehavior.lastSearchOpen).toBe(false);
    expect(mockMarkdownEditorBehavior.lastSearchText).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search (⇅ for history)")).toHaveValue("");
      expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();
    });
  });

  it("keeps focus in the search input while typing in edit-mode search", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    const searchInput = await screen.findByPlaceholderText("Search (⇅ for history)");
    fireEvent.change(searchInput, { target: { value: "alpha" } });

    await waitFor(() => {
      expect(searchInput).toHaveFocus();
      expect(searchInput).toHaveValue("alpha");
      expect(mockMarkdownEditorBehavior.lastSearchText).toBe("alpha");
      expect(mockMarkdownEditorBehavior.lastSearchAutoNavigate).toBe(false);
    });
  });

  it("opens find and replace with Ctrl+H and keeps F3 navigation available from the panel", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "h", ctrlKey: true });

    const findInput = await screen.findByRole("textbox", { name: "Find" });
    const replaceInput = await screen.findByRole("textbox", { name: "Replace" });
    await waitFor(() => {
      expect(findInput).toHaveFocus();
    });

    fireEvent.change(findInput, { target: { value: "alpha" } });

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(findInput, { altKey: true, key: "c" });
    fireEvent.keyDown(findInput, { altKey: true, key: "w" });
    fireEvent.keyDown(findInput, { altKey: true, key: "r" });

    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Match whole word" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use regular expression" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(findInput, { key: "F3" });

    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: "F3", shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.change(replaceInput, { target: { value: "done" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace current match" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));

    expect(mockMarkdownEditorCommands.replaceCurrentSearchResult).toHaveBeenCalledTimes(1);
    expect(mockMarkdownEditorCommands.replaceAllSearchResults).toHaveBeenCalledTimes(1);
  });

  it("does not restore preview highlights after exiting edit mode when edit search was already closed", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    const searchInput = await viewerSearch.openSearch("alpha");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(searchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search (⇅ for history)")).not.toBeInTheDocument();
      expect(editor).toHaveFocus();
    });

    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
      expect(document.querySelectorAll('mark[data-text-search-highlight="true"]').length).toBe(0);
    });
  });

  it("triggers inline code formatting from the markdown shortcut", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "e", ctrlKey: true });

    expect(mockMarkdownEditorCommands.toggleInlineCode).toHaveBeenCalledTimes(1);
  });

  it("opens the create-link dialog from the markdown shortcut", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });

    expect(mockMarkdownEditorCommands.createLink).toHaveBeenCalledTimes(1);
  });

  it("inserts a table from the markdown shortcut", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "t", ctrlKey: true, altKey: true });

    expect(mockMarkdownEditorCommands.insertTable).toHaveBeenCalledTimes(1);
  });

  it("inserts a thematic break from the markdown shortcut", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "h", ctrlKey: true, altKey: true });

    await waitFor(() => {
      expect(mockMarkdownEditorCommands.insertThematicBreak).toHaveBeenCalledTimes(1);
    });
  });

  it("inserts a code block from the markdown shortcut", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "E", ctrlKey: true, shiftKey: true });

    expect(mockMarkdownEditorCommands.insertCodeBlock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a markdown editor render crash without closing the viewer", async () => {
    const restoreCrashNoiseSuppression = suppressExpectedRenderCrashNoise("Editor render failed");

    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    mockMarkdownEditorBehavior.throwOnRender = true;

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await vi.dynamicImportSettled();

    await screen.findByText("Editor unavailable");

    mockMarkdownEditorBehavior.throwOnRender = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry editor" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    });

    restoreCrashNoiseSuppression();
  });

  it("shows a recoverable error when a markdown editor command throws", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n");
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    mockMarkdownEditorBehavior.throwOnInsertCodeBlock = true;

    renderViewer();

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await vi.dynamicImportSettled();
    await screen.findByRole("textbox", { name: "Markdown editor" });

    fireEvent.keyDown(document, { key: "E", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("Failed to run Insert code block. Insert code block failed")).toBeInTheDocument();
    });
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
  });
});
