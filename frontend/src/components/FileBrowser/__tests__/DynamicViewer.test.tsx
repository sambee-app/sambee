import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../../../hooks/useKeyboardShortcuts";
import { useContentProviderRegistry } from "../../../pages/FileBrowser/contentProviders";
import { createStorageBackedTestContentProviderRegistry } from "../../../test/helpers";
import type { ViewerComponentLoadResult, ViewerComponentProps } from "../../../utils/FileTypeRegistry";
import { DynamicViewer } from "../DynamicViewer";

const { mockGetViewerComponentLoadResult, mockLogger } = vi.hoisted(() => ({
  mockGetViewerComponentLoadResult: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../../../services/logger", () => ({
  logger: mockLogger,
}));

vi.mock("../../../utils/FileTypeRegistry", async () => {
  const actual = await vi.importActual<typeof import("../../../utils/FileTypeRegistry")>("../../../utils/FileTypeRegistry");
  return {
    ...actual,
    getViewerComponentLoadResult: mockGetViewerComponentLoadResult,
  };
});

describe("DynamicViewer", () => {
  const defaultProps = {
    connectionId: "conn-1",
    contentProviders: createStorageBackedTestContentProviderRegistry(),
    viewInfo: {
      path: "/docs/file.pdf",
      mimeType: "application/pdf",
      sessionId: "session-1",
    },
    onClose: vi.fn(),
    onIndexChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails clearly when a viewer reads content providers without a context boundary", () => {
    expect(() => renderHook(() => useContentProviderRegistry())).toThrow(
      "useContentProviderRegistry must be used within a ContentProviderRegistryContext.Provider"
    );
  });

  it("provides its explicit registry to the loaded viewer", async () => {
    const contentProviders = createStorageBackedTestContentProviderRegistry();
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer() {
        return <div data-testid="provider-registry">{useContentProviderRegistry() === contentProviders ? "matched" : "mismatched"}</div>;
      },
    });

    render(<DynamicViewer {...defaultProps} contentProviders={contentProviders} />);

    expect(await screen.findByTestId("provider-registry")).toHaveTextContent("matched");
  });

  it("renders the loaded viewer component", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer() {
        return <div data-testid="loaded-viewer">Loaded Viewer</div>;
      },
    });

    render(<DynamicViewer {...defaultProps} />);

    expect(await screen.findByTestId("loaded-viewer")).toBeInTheDocument();
  });

  it("does not show an intermediate dialog while the viewer module loads", () => {
    mockGetViewerComponentLoadResult.mockReturnValue(new Promise(() => {}));

    render(<DynamicViewer {...defaultProps} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("forwards an archive source to the loaded viewer component", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer({ virtualSource }: ViewerComponentProps) {
        return <div data-testid="loaded-viewer">{virtualSource?.location.source.path}</div>;
      },
    });

    render(
      <DynamicViewer
        {...defaultProps}
        viewInfo={{
          ...defaultProps.viewInfo,
          virtualSource: {
            kind: "virtual",
            path: "images/photo.png",
            location: {
              kind: "virtual",
              providerId: "zip",
              connectionId: "conn-1",
              source: { kind: "physical", connectionId: "conn-1", path: "archives/backup.zip" },
              path: "images",
            },
          },
        }}
      />
    );

    expect(await screen.findByTestId("loaded-viewer")).toHaveTextContent("archives/backup.zip");
  });

  it("shows a failure dialog when the viewer module cannot be loaded", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "failed",
      error: new Error("Loading chunk 42 failed"),
    });

    render(<DynamicViewer {...defaultProps} />);

    expect(await screen.findByRole("dialog", { name: /viewer unavailable/i })).toBeInTheDocument();
    expect(screen.getByText(/loading chunk 42 failed/i)).toBeInTheDocument();
    expect(screen.getByText(/the file browser is still available/i)).toBeInTheDocument();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "DynamicViewer: Viewer component failed to load",
      expect.objectContaining({
        errorMessage: "Loading chunk 42 failed",
        isLikelyAssetLoadFailure: true,
        mimeType: "application/pdf",
        path: "/docs/file.pdf",
        sessionId: "session-1",
      }),
      "viewer",
      expect.any(Error)
    );
  });

  it("retries loading the viewer component from the failure dialog", async () => {
    mockGetViewerComponentLoadResult
      .mockResolvedValueOnce({
        status: "failed",
        error: new Error("Loading chunk 42 failed"),
      })
      .mockResolvedValueOnce({
        status: "loaded",
        component: function LoadedViewer() {
          return <div data-testid="loaded-viewer">Loaded Viewer</div>;
        },
      });

    render(<DynamicViewer {...defaultProps} />);

    const retryButton = await screen.findByRole("button", { name: /retry/i });
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(mockGetViewerComponentLoadResult).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId("loaded-viewer")).toBeInTheDocument();
  });

  it("keeps the error dialog in place during a delayed module retry", async () => {
    let finishLoad!: (result: ViewerComponentLoadResult) => void;
    mockGetViewerComponentLoadResult
      .mockResolvedValueOnce({ status: "failed", error: new Error("Loading chunk failed") })
      .mockReturnValueOnce(
        new Promise<ViewerComponentLoadResult>((resolve) => {
          finishLoad = resolve;
        })
      );
    render(<DynamicViewer {...defaultProps} />);
    const dialog = await screen.findByRole("dialog", { name: /viewer unavailable/i });

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(screen.getByRole("dialog", { name: /viewer unavailable/i })).toBe(dialog);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    await act(async () => finishLoad({ status: "loaded", component: () => <div data-testid="loaded-viewer">Loaded</div> }));
    expect(screen.getByTestId("loaded-viewer")).toBeInTheDocument();
  });

  it("shows an unsupported dialog when no viewer exists", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({ status: "unsupported" });

    render(<DynamicViewer {...defaultProps} />);

    expect(await screen.findByRole("dialog", { name: /viewer unsupported/i })).toBeInTheDocument();
    expect(screen.getByText(/does not have an available viewer/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("reuses the loaded module when the viewed path changes", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer() {
        return <div data-testid="loaded-viewer">Loaded Viewer</div>;
      },
    });

    const { rerender } = render(<DynamicViewer {...defaultProps} />);

    expect(await screen.findByTestId("loaded-viewer")).toBeInTheDocument();
    expect(mockGetViewerComponentLoadResult).toHaveBeenCalledTimes(1);

    rerender(
      <DynamicViewer
        {...defaultProps}
        viewInfo={{
          ...defaultProps.viewInfo,
          path: "/docs/other-file.pdf",
        }}
      />
    );

    expect(screen.getByTestId("loaded-viewer")).toBeInTheDocument();
    expect(mockGetViewerComponentLoadResult).toHaveBeenCalledTimes(1);
  });

  it("does not reload the image viewer when its explicit viewer ID stays the same across MIME types", async () => {
    const unmounted = vi.fn();
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer({ path }: ViewerComponentProps) {
        useEffect(() => unmounted, []);
        return <div data-testid="loaded-viewer">{path}</div>;
      },
    });
    const { rerender } = render(
      <DynamicViewer {...defaultProps} viewInfo={{ ...defaultProps.viewInfo, viewerId: "image", mimeType: "image/png" }} />
    );
    await screen.findByTestId("loaded-viewer");
    rerender(
      <DynamicViewer
        {...defaultProps}
        viewInfo={{ ...defaultProps.viewInfo, viewerId: "image", mimeType: "image/jpeg", path: "other.jpg" }}
      />
    );
    expect(screen.getByTestId("loaded-viewer")).toHaveTextContent("other.jpg");
    expect(mockGetViewerComponentLoadResult).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("retains the outgoing viewer and its resource until the replacement module is loaded", async () => {
    let finishLoad!: (result: ViewerComponentLoadResult) => void;
    const unmounted = vi.fn();
    mockGetViewerComponentLoadResult
      .mockResolvedValueOnce({
        status: "loaded",
        component: function LoadedViewer({ path, isTransitioning }: ViewerComponentProps) {
          useEffect(() => unmounted, []);
          return (
            <div data-testid="outgoing-viewer" data-pending={isTransitioning}>
              {path}
            </div>
          );
        },
      })
      .mockReturnValueOnce(
        new Promise<ViewerComponentLoadResult>((resolve) => {
          finishLoad = resolve;
        })
      );
    const { rerender } = render(<DynamicViewer {...defaultProps} />);
    await screen.findByTestId("outgoing-viewer");
    rerender(
      <DynamicViewer
        {...defaultProps}
        viewInfo={{ ...defaultProps.viewInfo, viewerId: "image", path: "next.png", mimeType: "image/png" }}
      />
    );
    expect(screen.getByTestId("outgoing-viewer")).toHaveTextContent("/docs/file.pdf");
    expect(screen.getByTestId("outgoing-viewer")).toHaveAttribute("data-pending", "true");
    expect(unmounted).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () =>
      finishLoad({
        status: "loaded",
        component: function Incoming({ path }) {
          return <div data-testid="incoming-viewer">{path}</div>;
        },
      })
    );
    expect(screen.getByTestId("incoming-viewer")).toHaveTextContent("next.png");
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it.each(["text", "markdown", "image", "pdf"] as const)(
    "renders only the selected %s resource without a hidden candidate",
    async (viewerId) => {
      mockGetViewerComponentLoadResult.mockResolvedValue({
        status: "loaded",
        component: function Content({ path }: ViewerComponentProps) {
          return <div data-testid="displayed-content">{path}</div>;
        },
      });
      const view = (path: string) => <DynamicViewer {...defaultProps} viewInfo={{ ...defaultProps.viewInfo, viewerId, path }} />;
      const { rerender } = render(view("original"));
      await screen.findByTestId("displayed-content");
      rerender(view("missing"));
      expect(screen.getAllByTestId("displayed-content")).toHaveLength(1);
      expect(screen.getByTestId("displayed-content")).toHaveTextContent("missing");
      rerender(view("newer"));
      expect(screen.getByTestId("displayed-content")).toHaveTextContent("newer");
    }
  );

  it("suspends outgoing shortcuts and gallery callbacks while metadata resolves but allows Escape to cancel", async () => {
    const download = vi.fn();
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer({ path, isTransitioning, onCurrentIndexChange, navigation }: ViewerComponentProps) {
        useKeyboardShortcuts({ shortcuts: [{ description: "Save", id: "download", keys: "d", handler: download }] });
        return (
          <div
            data-testid="loaded-viewer"
            data-pending={isTransitioning}
            data-gallery={Boolean(onCurrentIndexChange)}
            data-mode={navigation?.mode}
          >
            {path}
          </div>
        );
      },
    });
    const { rerender } = render(<DynamicViewer {...defaultProps} />);
    await screen.findByTestId("loaded-viewer");
    rerender(<DynamicViewer {...defaultProps} isPending navigation={{ mode: "edit", onModeChange: vi.fn(), onGuardChange: vi.fn() }} />);
    expect(screen.getByTestId("loaded-viewer")).toHaveAttribute("data-pending", "true");
    expect(screen.getByTestId("loaded-viewer")).toHaveAttribute("data-gallery", "false");
    fireEvent.keyDown(document, { key: "d" });
    expect(download).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    rerender(<DynamicViewer {...defaultProps} />);
    fireEvent.keyDown(document, { key: "d" });
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("allows Escape once while metadata waits in the same viewer type", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function Content({ path }: ViewerComponentProps) {
        return <div data-testid="displayed-content">{path}</div>;
      },
    });
    const { rerender } = render(<DynamicViewer {...defaultProps} />);
    await screen.findByTestId("displayed-content");
    rerender(<DynamicViewer {...defaultProps} isPending viewInfo={{ ...defaultProps.viewInfo, path: "replacement.txt" }} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("displayed-content")).toHaveTextContent(defaultProps.viewInfo.path);
  });

  it("retains the selection key with its matching image index until metadata is ready", async () => {
    mockGetViewerComponentLoadResult.mockResolvedValue({
      status: "loaded",
      component: function LoadedViewer({ currentIndex, navigation }: ViewerComponentProps) {
        return <div data-testid="selection" data-index={currentIndex} data-key={navigation?.selectionKey} />;
      },
    });
    const navigation = { mode: "view" as const, onModeChange: vi.fn(), onGuardChange: vi.fn(), selectionKey: "opening" };
    const viewInfo = { ...defaultProps.viewInfo, viewerId: "image" as const, currentIndex: 0 };
    const { rerender } = render(<DynamicViewer {...defaultProps} viewInfo={viewInfo} navigation={navigation} />);
    const selection = await screen.findByTestId("selection");

    rerender(<DynamicViewer {...defaultProps} viewInfo={viewInfo} isPending navigation={{ ...navigation, selectionKey: "next" }} />);
    expect(selection).toHaveAttribute("data-index", "0");
    expect(selection).toHaveAttribute("data-key", "opening");

    rerender(
      <DynamicViewer {...defaultProps} viewInfo={{ ...viewInfo, currentIndex: 1 }} navigation={{ ...navigation, selectionKey: "next" }} />
    );
    expect(screen.getByTestId("selection")).toBe(selection);
    expect(selection).toHaveAttribute("data-index", "1");
    expect(selection).toHaveAttribute("data-key", "next");
  });
});
