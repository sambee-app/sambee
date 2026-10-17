import type { ViewUpdate } from "@codemirror/view";
import { act, configure, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService from "../../../services/api";
import { authSession } from "../../../services/authSession";
import { createStorageBackedTestContentProviderRegistry, readBlobAsText } from "../../../test/helpers";
import { SambeeThemeProvider } from "../../../theme";
import MarkdownViewer from "../MarkdownViewer";
import { normalizeMarkdownTableCellLineBreaks } from "../markdownTableCellLineBreaks";
import { createViewerSearchTestDriver } from "./viewerSearchTestUtils";

const contentProviders = createStorageBackedTestContentProviderRegistry();

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

function render(ui: ReactNode) {
  return renderBase(ui, { wrapper: ContentProviderTestWrapper });
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
  initialNormalizedMarkdown: null as string | null,
  lastSearchAutoNavigate: true,
  lastSearchOpen: false,
  lastSearchText: "",
  lastRestoredScrollTop: null as number | null,
  moveCaretToEndOnMarkdownPropChangeWhenFocused: false,
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
      expect(document.querySelectorAll('mark[data-text-search-current="true"]').length).toBeGreaterThan(0);
    },
  });

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
    vi.spyOn(apiService, "writeTextWithEditLock").mockImplementation(async (connectionId, path, content, _lockInfo, options) => {
      await apiService.saveTextFile(connectionId, path, content, {
        filename: path.split("/").pop() ?? path,
        mimeType: options.mimeType,
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
    mockMarkdownEditorBehavior.initialNormalizedMarkdown = null;
    mockMarkdownEditorBehavior.lastSearchAutoNavigate = true;
    mockMarkdownEditorBehavior.lastSearchOpen = false;
    mockMarkdownEditorBehavior.lastSearchText = "";
    mockMarkdownEditorBehavior.lastRestoredScrollTop = null;
    mockMarkdownEditorBehavior.moveCaretToEndOnMarkdownPropChangeWhenFocused = false;
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

  it("exits edit mode on Escape without closing the viewer or prompting when nothing changed", async () => {
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

    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(releaseSpy).toHaveBeenCalledWith("conn1", "/docs/readme.md", expect.objectContaining(mockEditLockInfo));
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
      expect(screen.getByText("Unable to enter edit mode. Failed to acquire edit lock.: Lock conflict")).toBeInTheDocument();
    });
    expect(screen.queryByRole("textbox", { name: "Markdown editor" })).not.toBeInTheDocument();
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
    let resolveSave: (() => void) | null = null;
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

  it("fails closed when flushing pending editor edits fails before save", async () => {
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
    mockMarkdownEditorBehavior.flushRejectError = new Error("Flush failed");

    renderViewer();

    await screen.findByText("Readme");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
    fireEvent.change(editor, { target: { value: "# Updated\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Failed to save markdown changes.: Flush failed")).toBeInTheDocument();
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Markdown editor" })).toBeInTheDocument();
    expect(releaseSpy).not.toHaveBeenCalledWith("conn1", "/docs/readme.md");
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

  it("searches rendered markdown and navigates between matches", async () => {
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("# Alpha\n\nAlpha beta alpha\n");

    renderViewer();

    await screen.findByText("Alpha");
    await viewerSearch.expectFirstMatchActive({
      searchTerm: "alpha",
      expectedCounterText: "1 / 3",
    });

    await waitFor(() => {
      expect(document.querySelectorAll('mark[data-text-search-highlight="true"]').length).toBe(3);
    });

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
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("sam**bee** sambee\n");

    renderViewer();

    await screen.findByText("sambee", { exact: false });
    await viewerSearch.openSearch("sambee");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    expect(document.querySelectorAll('mark[data-text-search-highlight="true"]').length).toBe(3);

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

  it("discards and closes from the unsaved changes dialog", async () => {
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
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("saves from the unsaved changes dialog before closing the viewer", async () => {
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
      expect(onClose).toHaveBeenCalledTimes(1);
    });
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

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
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

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
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

    const editor = await screen.findByRole("textbox", { name: "Markdown editor" });
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
