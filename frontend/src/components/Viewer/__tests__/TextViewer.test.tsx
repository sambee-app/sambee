import { act, cleanup, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, type ReactNode, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoveLocationFragment } from "../../../hooks/useRemoveLocationFragment";
import { type ViewerLeaveGuard, WorkspaceNavigationGuard } from "../../../hooks/useRoutedViewerEditing";
import i18n from "../../../i18n";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService, { ExpiredEditLockError } from "../../../services/api";
import { authSession } from "../../../services/authSession";
import { loadDraft, snapshotRegisteredDrafts } from "../../../services/draftRecovery";
import { createStorageBackedTestContentProviderRegistry, readBlobAsText } from "../../../test/helpers";
import { SambeeThemeProvider } from "../../../theme";
import { CODEMIRROR_FIND_HISTORY_STORAGE_KEY, CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY } from "../codeMirrorFindReplaceConstants";

const contentProviders = createStorageBackedTestContentProviderRegistry();

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

function render(ui: ReactNode) {
  return renderBase(ui, { wrapper: ContentProviderTestWrapper });
}

interface MockTextCodeEditorProps {
  ariaLabel: string;
  className?: string;
  onChange: (text: string) => void;
  onSearchStateChange?: (state: {
    currentMatch: number;
    isSearchOpen: boolean;
    isSearchable: boolean;
    isValid: boolean;
    searchMatches: number;
    searchText: string;
    viewMode: "source";
  }) => void;
  onUserEdit?: () => void;
  readOnly?: boolean;
  searchOpen?: boolean;
  searchCaseSensitive?: boolean;
  searchRegexp?: boolean;
  searchReplaceText?: string;
  searchText?: string;
  searchWholeWord?: boolean;
  text: string;
}

const { mockSetWordWrapEnabled, mockTextEditorCommands, useTextEditorMaxFileSizeBytesPreferenceMock, useTextEditorWordWrapPreferenceMock } =
  vi.hoisted(() => ({
    mockSetWordWrapEnabled: vi.fn(),
    mockTextEditorCommands: {
      nextSearchResult: vi.fn(),
      previousSearchResult: vi.fn(),
      replaceAllSearchResults: vi.fn(),
      replaceCurrentSearchResult: vi.fn(),
    },
    useTextEditorMaxFileSizeBytesPreferenceMock: vi.fn<
      typeof import("../../../pages/FileBrowser/preferences").useTextEditorMaxFileSizeBytesPreference
    >(() => [52_428_800, vi.fn()]),
    useTextEditorWordWrapPreferenceMock: vi.fn(() => [false, mockSetWordWrapEnabled] as const),
  }));

vi.mock("../../../pages/FileBrowser/preferences", () => ({
  useTextEditorMaxFileSizeBytesPreference: useTextEditorMaxFileSizeBytesPreferenceMock,
  useTextEditorWordWrapPreference: useTextEditorWordWrapPreferenceMock,
}));

vi.mock("../TextCodeEditor", () => {
  const MockTextCodeEditor = forwardRef(function MockTextCodeEditor(props: MockTextCodeEditorProps, ref) {
    const latestTextRef = useRef(props.text);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    latestTextRef.current = props.text;

    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
      captureSnapshotSync: () => {
        const editor = textareaRef.current;
        if (!editor) throw new Error("Expected the mounted mock text editor");
        const content = editor.value;
        return { revision: 0, serialize: () => content };
      },
      captureSnapshot: async () => {
        const content = latestTextRef.current;
        return { revision: 0, serialize: () => content };
      },
      flushPendingEdits: vi.fn().mockResolvedValue(undefined),
      getCanonicalText: () => latestTextRef.current,
      getPrimarySelectionText: () => "",
      preserveSelection: vi.fn(),
      restorePreservedSelection: vi.fn().mockReturnValue(true),
      focusCurrentSearchResult: vi.fn().mockReturnValue(true),
      nextSearchResult: mockTextEditorCommands.nextSearchResult,
      previousSearchResult: mockTextEditorCommands.previousSearchResult,
      replaceAllSearchResults: mockTextEditorCommands.replaceAllSearchResults,
      replaceCurrentSearchResult: mockTextEditorCommands.replaceCurrentSearchResult,
    }));

    useEffect(() => {
      props.onSearchStateChange?.({
        searchText: props.searchText ?? "",
        searchMatches: props.searchText ? 2 : 0,
        currentMatch: props.searchText ? 1 : 0,
        isSearchOpen: props.searchOpen ?? false,
        isSearchable: true,
        isValid: true,
        viewMode: "source",
      });
    }, [props.onSearchStateChange, props.searchOpen, props.searchText]);

    return (
      <textarea
        ref={textareaRef}
        aria-label={props.ariaLabel}
        className={props.className}
        readOnly={props.readOnly}
        value={props.text}
        onChange={(event) => {
          latestTextRef.current = event.target.value;
          props.onUserEdit?.();
          props.onChange(event.target.value);
        }}
      />
    );
  });

  return { TextCodeEditor: MockTextCodeEditor };
});

import TextViewer from "../TextViewer";

function RoutedTextViewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const [guard, setGuard] = useState<ViewerLeaveGuard | null>(null);
  const removeFragment = useEffectEvent(useRemoveLocationFragment());
  useEffect(() => {
    if (location.hash.includes("flow=")) removeFragment(["flow"]);
  }, [location.hash]);
  return (
    <>
      {guard ? <WorkspaceNavigationGuard guard={guard} /> : null}
      <TextViewer
        connectionId="conn1"
        path="/docs/readme.txt"
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

function renderRoutedViewer(edit = false, fragment = false) {
  const router = createMemoryRouter(
    [
      { path: "/browse", element: <div>Files</div> },
      { path: "/viewer", element: <RoutedTextViewer /> },
    ],
    {
      initialEntries: [
        "/browse",
        {
          pathname: "/viewer",
          search: `?file=smb%2Fdemo%2Fdocs%2Freadme.txt&viewer=text${edit ? "&mode=edit" : ""}`,
          hash: fragment ? "#flow=opaque&keep=1" : "",
          state: { returnTo: "/browse" },
        },
      ],
    }
  );
  render(
    <SambeeThemeProvider>
      <RouterProvider router={router} />
    </SambeeThemeProvider>
  );
  return router;
}

function renderViewer({ onClose = vi.fn(), isReadOnly = false }: { onClose?: () => void; isReadOnly?: boolean } = {}) {
  return render(
    <SambeeThemeProvider>
      <TextViewer connectionId="conn1" path="/docs/readme.txt" onClose={onClose} isReadOnly={isReadOnly} />
    </SambeeThemeProvider>
  );
}

async function enterEditMode(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(apiService.acquireEditLock).toHaveBeenCalledWith("conn1", "/docs/readme.txt");
  });
  const editor = await screen.findByRole("textbox", { name: "Text editor" });
  await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
  return editor;
}

describe("TextViewer", () => {
  it("opens directly for editing and closes to the file list in one step", async () => {
    const onClose = vi.fn();
    renderViewer({ onClose });
    await enterEditMode();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
  });

  it("opens a legacy view route directly for editing without changing history", async () => {
    const router = renderRoutedViewer();
    await enterEditMode();
    expect(router.state.location.search).not.toContain("mode=edit");
    await act(() => router.navigate(-1));
    expect(await screen.findByText("Files")).toBeInTheDocument();
  });

  it("saves and completes a dirty Close directly", async () => {
    const onClose = vi.fn();
    renderViewer({ onClose });
    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "direct edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1);
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {});
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    useTextEditorMaxFileSizeBytesPreferenceMock.mockReturnValue([52_428_800, vi.fn()]);
    vi.spyOn(apiService, "supportsEditLocks").mockReturnValue(true);
    vi.spyOn(apiService, "getFileContent").mockResolvedValue("hello world");
    vi.spyOn(apiService, "acquireEditLock").mockResolvedValue({
      lock_id: "lock-1",
      lock_capability: "capability-1",
      operation_id: "operation-1",
      file_path: "/docs/readme.txt",
      locked_by: "alice",
      locked_at: "2026-03-23T12:00:00Z",
    });
    vi.spyOn(apiService, "releaseEditLock").mockResolvedValue();
    vi.spyOn(apiService, "writeTextWithEditLock").mockResolvedValue();
    vi.spyOn(apiService, "downloadFile").mockResolvedValue();
    vi.spyOn(apiService, "getFileBlob").mockResolvedValue(new Blob(["test"]));
    mockTextEditorCommands.nextSearchResult.mockReset();
    mockTextEditorCommands.previousSearchResult.mockReset();
    mockTextEditorCommands.replaceAllSearchResults.mockReset();
    mockTextEditorCommands.replaceCurrentSearchResult.mockReset();
    mockSetWordWrapEnabled.mockReset();
  });

  it("shares current unsaved editor text separately from the saved attachment", async () => {
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
    const raw = vi
      .spyOn(apiService, "getOriginalFileBlob")
      .mockResolvedValue(new Blob(["saved bytes"], { type: "application/octet-stream" }));
    renderViewer();
    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "unsaved text" } });
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share as text" }));
    expect(share).toHaveBeenCalledExactlyOnceWith({ text: "unsaved text" });
    expect(apiService.writeTextWithEditLock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const fileChoice = screen.getByRole("menuitem", { name: "Share as file" });
    await waitFor(() => expect(fileChoice).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(fileChoice);
    expect(share).toHaveBeenLastCalledWith({
      files: [expect.objectContaining({ name: "readme.txt", type: "text/plain", size: 11 })],
      title: "readme.txt",
    });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(apiService.writeTextWithEditLock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
    const previousAttachment = share.mock.calls[1]?.[0]?.files[0];
    expect(await readBlobAsText(previousAttachment)).toBe("saved bytes");
    raw.mockResolvedValueOnce(new Blob(["unsaved text"], { type: "application/octet-stream" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(raw).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const savedChoice = screen.getByRole("menuitem", { name: "Share as file" });
    await waitFor(() => expect(savedChoice).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(savedChoice);
    expect(share).toHaveBeenLastCalledWith({
      files: [expect.objectContaining({ name: "readme.txt", type: "text/plain", size: 12 })],
      title: "readme.txt",
    });
    expect(share.mock.calls[2]?.[0]?.files[0]).not.toBe(previousAttachment);
    expect(await readBlobAsText(share.mock.calls[2]?.[0]?.files[0])).toBe("unsaved text");
    await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
  });

  it.each(["file", "text"])("closes only sharing Details on Escape after a %s failure", async (mode) => {
    const user = userEvent.setup();
    const share = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
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
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["saved bytes"], { type: "text/plain" }));
    const onClose = vi.fn();
    renderViewer({ onClose });
    await screen.findByRole("textbox", { name: "Text editor" });
    await user.click(screen.getByRole("button", { name: "Share" }));
    const choice = screen.getByRole("menuitem", { name: mode === "file" ? "Share as file" : "Share as text" });
    await waitFor(() => expect(choice).not.toHaveAttribute("aria-disabled", "true"));
    await user.click(choice);
    await user.click(await screen.findByRole("button", { name: "Details" }));
    await screen.findByText(/"reason": "NotAllowedError"/);
    await user.keyboard("{Escape}");
    const details = await screen.findByRole("button", { name: "Details" });
    await waitFor(() => expect(details).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Text editor" })).toBeInTheDocument();
    if (mode === "file") expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("toggles word wrap with Alt+Z after automatic activation", async () => {
    renderViewer();

    const editor = await enterEditMode();
    editor.focus();
    fireEvent.keyDown(editor, { altKey: true, key: "z" });

    expect(mockSetWordWrapEnabled).toHaveBeenCalledWith(true);
  });

  it("loads virtual text through its provider and blocks editing", async () => {
    const virtualSource = {
      kind: "virtual" as const,
      path: "docs/notes.txt",
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
      .mockResolvedValue(new Blob(["virtual text"], { type: "text/plain" }));
    const getFileContentSpy = vi.spyOn(apiService, "getFileContent");
    const acquireLockSpy = vi.spyOn(apiService, "acquireEditLock");

    render(
      <SambeeThemeProvider>
        <TextViewer connectionId="conn1" path="docs/notes.txt" onClose={vi.fn()} virtualSource={virtualSource} />
      </SambeeThemeProvider>
    );

    expect(await screen.findByRole("textbox", { name: "Text editor" })).toHaveValue("virtual text");
    expect(getArchiveMemberSpy).toHaveBeenCalledWith("conn1", "archives/backup.zip", "docs/notes.txt", {
      download: undefined,
      request: { kind: "text" },
      signal: expect.anything(),
    });
    expect(getFileContentSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(acquireLockSpy).not.toHaveBeenCalled();
  });

  it("does not reload the file when the active translation changes", async () => {
    const originalLanguage = i18n.language;
    renderViewer();

    await screen.findByRole("textbox", { name: "Text editor" });
    await enterEditMode();
    expect(apiService.getFileContent).toHaveBeenCalledTimes(2);

    await act(async () => {
      await i18n.changeLanguage(originalLanguage === "de" ? "en" : "de");
    });

    expect(apiService.getFileContent).toHaveBeenCalledTimes(2);

    await act(async () => {
      await i18n.changeLanguage(originalLanguage);
    });
  });

  it.each(["newer unsaved revision", "saved revision"])("acknowledges only saved content while the current draft is %s", async (latest) => {
    vi.spyOn(apiService, "getThemes").mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    vi.spyOn(apiService, "getOriginalFileBlob").mockResolvedValue(new Blob(["saved revision"], { type: "text/plain" }));
    let finishWrite: (() => void) | undefined;
    vi.mocked(apiService.writeTextWithEditLock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    renderViewer();
    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "saved revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1));
    expect(editor).not.toHaveAttribute("readonly");
    fireEvent.change(editor, { target: { value: "newer unsaved revision" } });
    if (latest === "saved revision") fireEvent.change(editor, { target: { value: latest } });
    if (!finishWrite) throw new Error("Expected a pending file write");
    await act(async () => {
      finishWrite?.();
    });

    expect(editor).toHaveValue(latest);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    if (latest !== "saved revision") {
      const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    } else {
      expect(screen.queryByRole("dialog", { name: "Unsaved changes" })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
  });

  it("closes exactly once on Escape from the viewer dialog", async () => {
    const onClose = vi.fn();
    renderViewer({ onClose });
    await screen.findByRole("textbox", { name: "Text editor" });
    const dialog = screen.getByRole("dialog");
    dialog.focus();

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("blurs toolbar focus on the first Escape and closes once on the next", async () => {
    const onClose = vi.fn();
    renderViewer({ onClose });
    await screen.findByRole("textbox", { name: "Text editor" });
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();

    fireEvent.keyDown(close, { key: "Escape" });
    expect(close).not.toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each(["Close", "Escape"])("closes the editor directly on %s", async (action) => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    const editor = await enterEditMode();
    if (action === "Escape") {
      editor.focus();
      fireEvent.keyDown(editor, { key: "Escape" });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
  });

  it.each(["Save", "Discard"])("closes directly after Close and %s", async (choice) => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "updated text" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: choice }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(choice === "Save" ? 1 : 0);
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
  });

  it.each(["Cancel", "failed Save"])("keeps text editing after Close and %s", async (choice) => {
    const onClose = vi.fn();
    if (choice === "failed Save") {
      vi.mocked(apiService.writeTextWithEditLock).mockRejectedValueOnce(new Error("Save failed"));
    }
    renderViewer({ onClose });

    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "updated text" } });
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
    expect(editor).toHaveValue("updated text");
    expect(editor).not.toHaveAttribute("readonly");
    expect(apiService.releaseEditLock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["Back", "Close"])("leaves clean editing with %s after releasing the lock", async (action) => {
    const user = userEvent.setup();
    const router = renderRoutedViewer();
    await enterEditMode();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    let finishRelease!: () => void;
    vi.mocked(apiService.releaseEditLock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        })
    );
    const blocked = vi.fn();
    const unsubscribe = router.subscribe((state) => {
      if ([...state.blockers.values()].some((blocker) => blocker.state === "blocked")) blocked();
    });
    try {
      if (action === "Back") await act(() => router.navigate(-1));
      else await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
      expect(router.state.location.pathname).toBe(action === "Back" ? "/browse" : "/viewer");
      expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishRelease();
      });
      expect(await screen.findByText("Files")).toBeInTheDocument();
      await act(() => router.navigate(action === "Back" ? 1 : -1));
      await enterEditMode();
      await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribe();
    }
  });

  it("guards routed Back, preserves a cancelled draft, and continues Discard", async () => {
    const router = renderRoutedViewer();
    await enterEditMode();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    const routedEditor = screen.getByRole("textbox", { name: "Text editor" });
    fireEvent.change(routedEditor, { target: { value: "unsaved routed text" } });
    await act(() => router.navigate(-1));
    let dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(routedEditor).toHaveValue("unsaved routed text");
    expect(router.state.location.pathname).toBe("/viewer");
    expect(apiService.releaseEditLock).not.toHaveBeenCalled();
    await act(() => router.navigate(-1));
    dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await screen.findByText("Files");
    await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
    await act(() => router.navigate(1));
    await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(2));
  });

  it.each(["acquired", "failed"])("retries editing after Back and Forward during a late %s acquisition", async (result) => {
    const acquire = vi.mocked(apiService.acquireEditLock);
    const lock = await acquire.getMockImplementation()!("conn1", "/docs/readme.txt");
    let finish!: (value: typeof lock) => void;
    let fail!: (error: Error) => void;
    acquire.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        })
    );
    const router = renderRoutedViewer(true);
    await screen.findByRole("textbox", { name: "Text editor" });
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    await act(() => router.navigate(-1));
    await screen.findByText("Files");
    await act(async () => {
      if (result === "acquired") finish(lock);
      else fail(new Error("Cancelled acquisition failed"));
    });
    await act(() => router.navigate(1));
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(result === "acquired" ? 1 : 0);
    expect(router.state.location.pathname).toBe("/viewer");
  });

  it("acquires a fresh edit session for an editor bookmark", async () => {
    const router = renderRoutedViewer(true);
    await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    expect(router.state.location.search).toContain("mode=edit");
  });

  it.each(["Save", "failed Save"])("guards Back with %s after router-safe fragment cleanup", async (choice) => {
    const router = renderRoutedViewer(false, true);
    await waitFor(() => expect(router.state.location.hash).toBe("#keep=1"));
    expect(router.state.location.state).toEqual({ returnTo: "/browse" });
    await enterEditMode();
    const editor = screen.getByRole("textbox", { name: "Text editor" });
    fireEvent.change(editor, { target: { value: "updated routed text" } });
    const unload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, unload);
    expect(unload.defaultPrevented).toBe(true);
    if (choice === "failed Save") vi.mocked(apiService.writeTextWithEditLock).mockRejectedValueOnce(new Error("Save failed"));
    let release!: () => void;
    if (choice === "Save")
      vi.mocked(apiService.releaseEditLock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
    await act(() => router.navigate(-1));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1));
    if (choice === "Save") {
      await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
      expect(router.state.location.pathname).toBe("/viewer");
      await act(async () => {
        release();
      });
      await screen.findByText("Files");
      expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
      expect(router.state.location.pathname).toBe("/browse");
      await act(() => router.navigate(1));
      expect(router.state.location.hash).toBe("#keep=1");
    } else {
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled());
      expect(router.state.location.pathname).toBe("/viewer");
      expect(editor).toHaveValue("updated routed text");
      expect(apiService.releaseEditLock).not.toHaveBeenCalled();
    }
  });

  it("leaves during acquisition and releases a late lock without restoring the old route", async () => {
    const acquire = vi.mocked(apiService.acquireEditLock);
    const lock = await acquire.getMockImplementation()!("conn1", "/docs/readme.txt");
    let finish!: (value: typeof lock) => void;
    acquire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const router = renderRoutedViewer(true);
    await waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    await act(() => router.navigate("/browse"));
    expect(await screen.findByText("Files")).toBeInTheDocument();
    await act(async () => {
      finish(lock);
    });
    await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe("/browse");
  });

  it("enters edit mode and saves text changes", async () => {
    renderViewer();

    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "updated text" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(apiService.writeTextWithEditLock).toHaveBeenCalledWith(
        "conn1",
        "/docs/readme.txt",
        "updated text",
        { lock_id: "lock-1", lock_capability: "capability-1", operation_id: "operation-1" },
        { mimeType: undefined }
      );
    });
  });

  it("keeps a read-only connection usable without attempting a lock", async () => {
    renderViewer({ isReadOnly: true });
    const editor = await screen.findByRole("textbox", { name: "Text editor" });
    expect(editor).toHaveAttribute("readonly");
    expect(apiService.acquireEditLock).not.toHaveBeenCalled();
    editor.focus();
    fireEvent.keyDown(editor, { altKey: true, key: "z" });
    expect(mockSetWordWrapEnabled).toHaveBeenCalledWith(true);
    fireEvent.keyDown(editor, { ctrlKey: true, key: "h" });
    expect(screen.queryByRole("textbox", { name: "Replace" })).not.toBeInTheDocument();
  });

  it.each([409, 403, 503])("opens read-only after access failure %s without repeatedly acquiring", async (status) => {
    vi.mocked(apiService.acquireEditLock).mockRejectedValueOnce({ response: { status } });
    renderViewer();
    const editor = await screen.findByRole("textbox", { name: "Text editor" });
    await waitFor(() => expect(screen.getByText("Read only")).toBeInTheDocument());
    expect(editor).toHaveAttribute("readonly");
    expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry editing" }) !== null).toBe(status !== 403);
  });

  it("retries a contended lock and uses a fresh baseline", async () => {
    vi.mocked(apiService.acquireEditLock).mockRejectedValueOnce({ response: { status: 409 } });
    renderViewer();
    fireEvent.click(await screen.findByRole("button", { name: "Retry editing" }));
    vi.mocked(apiService.getFileContent).mockResolvedValue("new saved content");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveValue("new saved content");
    expect(screen.queryByRole("status", { name: /unsaved changes/i })).not.toBeInTheDocument();
  });

  it.each(["Use saved file", "Keep my draft"])("requires a changed-baseline decision after lock loss: %s", async (choice) => {
    renderViewer();
    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "my unsaved draft" } });
    vi.mocked(apiService.writeTextWithEditLock).mockRejectedValueOnce(new ExpiredEditLockError());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const retry = await screen.findByRole("button", { name: "Retry editing" });
    expect(editor).toHaveAttribute("readonly");
    expect(editor).toHaveValue("my unsaved draft");
    expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1);
    vi.mocked(apiService.getFileContent).mockResolvedValue("another user's revision");
    fireEvent.click(retry);
    const dialog = await screen.findByRole("dialog", { name: "File changed" });
    expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: choice }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "File changed" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveValue(choice === "Keep my draft" ? "my unsaved draft" : "another user's revision");
    expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(1);
  });

  it("does not acquire for a retained transitioning presentation", async () => {
    render(<SambeeThemeProvider><TextViewer connectionId="conn1" path="/docs/readme.txt" onClose={vi.fn()} isTransitioning /></SambeeThemeProvider>);
    await screen.findByRole("textbox", { name: "Text editor" });
    expect(apiService.acquireEditLock).not.toHaveBeenCalled();
  });

  it.each(["pagehide", "registered"])("captures current editor text before React publication on %s", async (trigger) => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    renderViewer();
    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "older React draft" } });
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const draftKey = `sambee_oidc_draft:test-user:conn1:text:${encodeURIComponent("/docs/readme.txt")}`;
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!valueSetter) throw new Error("Expected the native textarea value setter");
    valueSetter.call(editor, "latest editor revision");
    act(() => {
      if (trigger === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else snapshotRegisteredDrafts();
    });
    expect(loadDraft("conn1", "/docs/readme.txt", "text")).toMatchObject({ baseline: "hello world", content: "latest editor revision" });
    await waitFor(() => expect(storage.mock.calls.filter(([key]) => key === draftKey).length).toBeGreaterThanOrEqual(2));
    expect(
      storage.mock.calls.filter(([key]) => key === draftKey).every(([, value]) => JSON.parse(value).content === "latest editor revision")
    ).toBe(true);
    expect(loadDraft("conn1", "/docs/readme.txt", "text")?.content).toBe("latest editor revision");
    expect(apiService.writeTextWithEditLock).not.toHaveBeenCalled();
  });

  it("clears the local draft when text returns to its saved baseline", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    renderViewer();

    const editor = await enterEditMode();
    const draftKey = `sambee_oidc_draft:test-user:conn1:text:${encodeURIComponent("/docs/readme.txt")}`;
    fireEvent.change(editor, { target: { value: "updated text" } });

    await waitFor(() => expect(sessionStorage.getItem(draftKey)).not.toBeNull());

    fireEvent.change(editor, { target: { value: "hello world" } });

    await waitFor(() => expect(sessionStorage.getItem(draftKey)).toBeNull());
  });

  it("clears a draft storage warning after a later snapshot succeeds", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    renderViewer();

    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "x".repeat(2 * 1024 * 1024 + 1) } });

    expect(await screen.findByText("Draft recovery is unavailable because this edit is too large.")).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "updated text" } });

    await waitFor(() => {
      expect(screen.queryByText("Draft recovery is unavailable because this edit is too large.")).not.toBeInTheDocument();
    });
  });

  it("shows a saved-file viewer behind an explicit recovered draft decision", async () => {
    const userIdSpy = vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    sessionStorage.setItem(
      `sambee_oidc_draft:test-user:conn1:text:${encodeURIComponent("/docs/readme.txt")}`,
      JSON.stringify({ baseline: "hello world", content: "local draft", createdAt: Date.now(), updatedAt: Date.now() })
    );
    renderViewer();

    expect(await screen.findByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("hello world")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Unsaved local draft available" }), { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resume editing" }));
    await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveValue("local draft"));
    expect(screen.getByRole("status", { name: /unsaved changes/i })).toBeInTheDocument();
    userIdSpy.mockRestore();
  });

  it("retains the recovery dialog when the edit lock cannot be acquired", async () => {
    vi.spyOn(authSession, "getUserId").mockReturnValue("test-user");
    vi.spyOn(apiService, "acquireEditLock").mockRejectedValueOnce(new Error("locked"));
    sessionStorage.setItem(
      `sambee_oidc_draft:test-user:conn1:text:${encodeURIComponent("/docs/readme.txt")}`,
      JSON.stringify({ baseline: "hello world", content: "local draft", createdAt: Date.now(), updatedAt: Date.now() })
    );
    renderViewer();

    await userEvent.click(await screen.findByRole("button", { name: "Resume editing" }));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(screen.getByRole("heading", { name: "Unsaved local draft available" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume editing" })).toBeEnabled();
  });

  it("shows only Text editor shortcuts from the edit toolbar Help menu", async () => {
    const user = userEvent.setup();
    renderViewer();

    await enterEditMode();

    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));

    expect(await screen.findByRole("heading", { name: "Text editor shortcuts" })).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Replace")).toBeInTheDocument();
    expect(screen.queryByText("viewer.shortcuts.replace")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.getByText("Toggle fullscreen")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Text editor shortcuts" })).not.toBeInTheDocument();
    });

    const editor = screen.getByRole("textbox", { name: "Text editor" });
    editor.focus();
    fireEvent.keyDown(editor, { key: "F1" });

    expect(await screen.findByRole("heading", { name: "Text editor shortcuts" })).toBeInTheDocument();
  });

  it("falls back to read-only large-file mode when the configured limit is exceeded", async () => {
    useTextEditorMaxFileSizeBytesPreferenceMock.mockReturnValue([4, vi.fn()]);
    vi.spyOn(apiService, "getFileContent").mockResolvedValueOnce("this content is too large");

    renderViewer();

    expect(await screen.findByText(/exceeds your Text Editor limit/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(apiService.acquireEditLock).not.toHaveBeenCalled();
  });

  it("resets field history navigation when reopening find and replace", async () => {
    localStorage.setItem(CODEMIRROR_FIND_HISTORY_STORAGE_KEY, JSON.stringify(["recent find"]));
    localStorage.setItem(CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY, JSON.stringify(["recent replace"]));
    renderViewer();

    const editor = await enterEditMode();
    fireEvent.keyDown(editor, { ctrlKey: true, key: "h" });

    const findInput = await screen.findByRole("textbox", { name: "Find" });
    const replaceInput = screen.getByRole("textbox", { name: "Replace" });
    fireEvent.keyDown(findInput, { key: "ArrowUp" });
    fireEvent.keyDown(replaceInput, { key: "ArrowUp" });

    expect(findInput).toHaveValue("recent find");
    expect(replaceInput).toHaveValue("recent replace");

    fireEvent.click(within(screen.getByTestId("code-mirror-find-replace-popover")).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Find" })).not.toBeInTheDocument();
    });

    fireEvent.keyDown(editor, { ctrlKey: true, key: "h" });

    const reopenedFindInput = await screen.findByRole("textbox", { name: "Find" });
    const reopenedReplaceInput = screen.getByRole("textbox", { name: "Replace" });
    expect(reopenedFindInput).toHaveValue("");
    expect(reopenedReplaceInput).toHaveValue("");

    fireEvent.keyDown(reopenedFindInput, { key: "ArrowDown" });
    fireEvent.keyDown(reopenedReplaceInput, { key: "ArrowDown" });

    expect(reopenedFindInput).toHaveValue("");
    expect(reopenedReplaceInput).toHaveValue("");
  });

  it("opens shared find and replace controls and keeps navigation shortcuts active", async () => {
    const user = userEvent.setup();
    localStorage.setItem(CODEMIRROR_FIND_HISTORY_STORAGE_KEY, JSON.stringify(["recent find"]));
    localStorage.setItem(CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY, JSON.stringify(["recent replace"]));
    renderViewer();

    const editor = await enterEditMode();

    fireEvent.keyDown(editor, { ctrlKey: true, key: "h" });

    const findInput = await screen.findByRole("textbox", { name: "Find" });
    const replaceInput = await screen.findByRole("textbox", { name: "Replace" });

    expect(findInput).toHaveAttribute("placeholder", "Search (⇅ for history)");
    expect(replaceInput).toHaveAttribute("placeholder", "Replace (⇅ for history)");
    expect(findInput).toHaveValue("");
    expect(replaceInput).toHaveValue("");
    expect(screen.getByTestId("code-mirror-find-replace-popover")).toBeInTheDocument();

    await waitFor(() => {
      expect(findInput).toHaveFocus();
    });
    await user.keyboard("{Tab}");
    expect(replaceInput).toHaveFocus();

    fireEvent.keyDown(replaceInput, { key: "ArrowDown" });
    expect(replaceInput).toHaveValue("");
    fireEvent.keyDown(replaceInput, { key: "ArrowUp" });
    expect(replaceInput).toHaveValue("recent replace");
    fireEvent.keyDown(replaceInput, { key: "ArrowDown" });
    expect(replaceInput).toHaveValue("");

    fireEvent.change(replaceInput, { target: { value: "draft replacement" } });
    fireEvent.keyDown(replaceInput, { key: "ArrowUp" });
    expect(replaceInput).toHaveValue("recent replace");
    fireEvent.keyDown(replaceInput, { key: "ArrowDown" });
    expect(replaceInput).toHaveValue("draft replacement");

    findInput.focus();
    fireEvent.keyDown(findInput, { key: "ArrowDown" });
    expect(findInput).toHaveValue("");
    fireEvent.keyDown(findInput, { key: "ArrowUp" });
    expect(findInput).toHaveValue("recent find");
    fireEvent.keyDown(findInput, { key: "ArrowDown" });
    expect(findInput).toHaveValue("");

    fireEvent.change(findInput, { target: { value: "hello" } });
    fireEvent.keyDown(findInput, { key: "ArrowUp" });
    expect(findInput).toHaveValue("recent find");
    fireEvent.keyDown(findInput, { key: "ArrowDown" });
    expect(findInput).toHaveValue("hello");

    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });

    fireEvent.keyDown(findInput, { altKey: true, key: "c" });
    fireEvent.keyDown(findInput, { altKey: true, key: "w" });
    fireEvent.keyDown(findInput, { altKey: true, key: "r" });
    fireEvent.keyDown(findInput, { key: "F3" });
    fireEvent.keyDown(findInput, { key: "F3", shiftKey: true });

    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Match whole word" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use regular expression" })).toHaveAttribute("aria-pressed", "true");
    expect(mockTextEditorCommands.nextSearchResult).toHaveBeenCalledTimes(1);
    expect(mockTextEditorCommands.previousSearchResult).toHaveBeenCalledTimes(1);

    await user.hover(screen.getByRole("button", { name: "Next match" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Next match (F3)");

    await user.unhover(screen.getByRole("button", { name: "Next match" }));
    await user.hover(screen.getByRole("button", { name: "Match case" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Toggle case-sensitive matching (Alt+C)");

    const replaceAllButton = screen.getByRole("button", { name: "Replace all" });
    replaceAllButton.focus();
    await user.keyboard("{Tab}");
    expect(findInput).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(replaceAllButton).toHaveFocus();

    fireEvent.change(replaceInput, { target: { value: "goodbye" } });
    replaceInput.focus();
    fireEvent.keyDown(replaceInput, { key: "Enter" });
    expect(replaceInput).toHaveFocus();
    fireEvent.keyDown(replaceInput, { altKey: true, ctrlKey: true, key: "Enter" });
    expect(replaceInput).toHaveFocus();

    expect(mockTextEditorCommands.replaceCurrentSearchResult).toHaveBeenCalledTimes(1);
    expect(mockTextEditorCommands.replaceAllSearchResults).toHaveBeenCalledTimes(1);
  });
});
