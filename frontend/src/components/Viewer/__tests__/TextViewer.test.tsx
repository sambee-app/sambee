import { act, fireEvent, render as renderBase, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, type ReactNode, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react";
import { createMemoryRouter, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoveLocationFragment } from "../../../hooks/useRemoveLocationFragment";
import { type ViewerLeaveGuard, WorkspaceNavigationGuard } from "../../../hooks/useRoutedViewerEditing";
import i18n from "../../../i18n";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService from "../../../services/api";
import { authSession } from "../../../services/authSession";
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
    useTextEditorMaxFileSizeBytesPreferenceMock: vi.fn(() => [52_428_800, vi.fn()] as const),
    useTextEditorWordWrapPreferenceMock: vi.fn(() => [false, mockSetWordWrapEnabled] as const),
  }));

vi.mock("../../../pages/FileBrowser/preferences", () => ({
  useTextEditorMaxFileSizeBytesPreference: useTextEditorMaxFileSizeBytesPreferenceMock,
  useTextEditorWordWrapPreference: useTextEditorWordWrapPreferenceMock,
}));

vi.mock("../TextCodeEditor", () => {
  const MockTextCodeEditor = forwardRef(function MockTextCodeEditor(props: MockTextCodeEditorProps, ref) {
    const latestTextRef = useRef(props.text);

    latestTextRef.current = props.text;

    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
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
        searchText: props.searchText,
        searchMatches: props.searchText ? 2 : 0,
        currentMatch: props.searchText ? 1 : 0,
        isSearchOpen: props.searchOpen,
        isSearchable: true,
        isValid: true,
        viewMode: "source",
      });
    }, [props.onSearchStateChange, props.searchOpen, props.searchText]);

    return (
      <textarea
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

function renderViewer({ onClose = vi.fn() }: { onClose?: () => void } = {}) {
  return render(
    <SambeeThemeProvider>
      <TextViewer connectionId="conn1" path="/docs/readme.txt" onClose={onClose} />
    </SambeeThemeProvider>
  );
}

async function enterEditMode(): Promise<HTMLElement> {
  const editButton = await screen.findByRole("button", { name: /^edit$/i });

  await waitFor(() => {
    expect(editButton).toBeEnabled();
  });

  fireEvent.click(editButton);

  await waitFor(() => {
    expect(apiService.acquireEditLock).toHaveBeenCalledWith("conn1", "/docs/readme.txt");
  });

  return screen.getByRole("textbox", { name: "Text editor" });
}

describe("TextViewer", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("toggles word wrap with Alt+Z while viewing read-only text", async () => {
    renderViewer();

    const editor = await screen.findByRole("textbox", { name: "Text editor" });
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
    expect(apiService.getFileContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      await i18n.changeLanguage(originalLanguage === "de" ? "en" : "de");
    });

    expect(apiService.getFileContent).toHaveBeenCalledTimes(1);

    await act(async () => {
      await i18n.changeLanguage(originalLanguage);
    });
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

  it.each(["Close", "Escape"])("returns to the viewer on %s and closes it on the next Close", async (action) => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    const editor = await enterEditMode();
    if (action === "Escape") {
      editor.focus();
      fireEvent.keyDown(editor, { key: "Escape" });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }

    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it.each(["Save", "Discard"])("returns to the text viewer after Close and %s", async (choice) => {
    const onClose = vi.fn();
    renderViewer({ onClose });

    const editor = await enterEditMode();
    fireEvent.change(editor, { target: { value: "updated text" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: choice }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^edit$/i })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveValue(choice === "Save" ? "updated text" : "hello world");
    expect(apiService.writeTextWithEditLock).toHaveBeenCalledTimes(choice === "Save" ? 1 : 0);
    expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
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

  it.each(["Back", "Close"])("leaves clean editing with %s and serializes rapid re-entry behind lock release", async (action) => {
    const router = renderRoutedViewer();
    await enterEditMode();
    await waitFor(() => expect(router.state.location.search).toContain("mode=edit"));
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
      else fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
      expect(router.state.location.search).not.toContain("mode=edit");
      expect(screen.getByRole("textbox", { name: "Text editor" })).toHaveAttribute("readonly");

      await act(() => router.navigate(action === "Back" ? 1 : -1));
      expect(router.state.location.search).toContain("mode=edit");
      expect(apiService.acquireEditLock).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishRelease();
      });
      await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
      expect(blocked).not.toHaveBeenCalled();

      await act(() => router.navigate(-1));
      await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(2));
    } finally {
      unsubscribe();
    }
  });

  it("guards routed Back, preserves a cancelled draft, and continues Discard", async () => {
    const router = renderRoutedViewer();
    await enterEditMode();
    await waitFor(() => expect(router.state.location.search).toContain("mode=edit"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text editor" })).not.toHaveAttribute("readonly"));
    const routedEditor = screen.getByRole("textbox", { name: "Text editor" });
    fireEvent.change(routedEditor, { target: { value: "unsaved routed text" } });
    await act(() => router.navigate(-1));
    let dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(routedEditor).toHaveValue("unsaved routed text");
    expect(router.state.location.search).toContain("mode=edit");
    expect(apiService.releaseEditLock).not.toHaveBeenCalled();
    await act(() => router.navigate(-1));
    dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(router.state.location.search).not.toContain("mode=edit"));
    await waitFor(() => expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1));
    await act(() => router.navigate(1));
    await waitFor(() => expect(apiService.acquireEditLock).toHaveBeenCalledTimes(2));
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
    await waitFor(() => expect(router.state.location.search).toContain("mode=edit"));
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
      expect(router.state.location.search).toContain("mode=edit");
      await act(async () => {
        release();
      });
      await waitFor(() => expect(router.state.location.search).not.toContain("mode=edit"));
      expect(apiService.releaseEditLock).toHaveBeenCalledTimes(1);
      await act(() => router.navigate(-1));
      expect(router.state.location.pathname).toBe("/browse");
      await act(() => router.navigate(1));
      expect(router.state.location.hash).toBe("#keep=1");
    } else {
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled());
      expect(router.state.location.search).toContain("mode=edit");
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
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
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
    expect(screen.queryByText("Toggle fullscreen")).not.toBeInTheDocument();

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
    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeDisabled();
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
