import { act, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageLoadPhase } from "../../../hooks/useCachedImageGallery";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService from "../../../services/api";
import { createStorageBackedTestContentProviderRegistry, readBlobAsText } from "../../../test/helpers";
import { SambeeThemeProvider } from "../../../theme";
import ImageViewer from "../ImageViewer";
import { downloadViewerBlob } from "../viewerContent";

const contentProviders = createStorageBackedTestContentProviderRegistry();

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

function render(ui: ReactNode) {
  return renderBase(ui, { wrapper: ContentProviderTestWrapper });
}

vi.mock("yet-another-react-lightbox", () => ({
  __esModule: true,
  default: ({
    slides,
    index,
    carousel,
    render: lightboxRender,
  }: {
    slides: Array<{ src: string }>;
    index: number;
    carousel?: { imageProps?: (slide: { src: string }) => Record<string, unknown> };
    render?: { slideHeader?: (props: { slide: { src: string } }) => React.ReactNode };
  }) => {
    const slide = slides[index];
    const imageProps = slide ? carousel?.imageProps?.(slide) : undefined;

    return (
      <div data-testid="image-lightbox" data-current-src={slide?.src ?? ""}>
        {slide && <img alt="" data-testid="lightbox-image" src={slide.src} {...imageProps} />}
        {slide && lightboxRender?.slideHeader?.({ slide })}
      </div>
    );
  },
}));

vi.mock("yet-another-react-lightbox/plugins/fullscreen", () => ({
  __esModule: true,
  default: {},
}));

vi.mock("yet-another-react-lightbox/plugins/zoom", () => ({
  __esModule: true,
  default: {},
}));

const createGalleryMock = () => ({
  currentIndex: 0,
  setCurrentIndex: vi.fn(),
  currentPath: "/images/photo.jpg",
  filename: "photo.jpg",
  imageCacheRef: { current: new Map() },
  getCachedImageSrc: (_index: number): string | undefined => undefined,
  getCachedImageBlob: (): Blob | undefined => undefined,
  loadingStates: new Map(),
  errorStates: new Map(),
  currentImageLoadPhase: "ready" as ImageLoadPhase,
  imageSourceRevision: 0,
  showLoadingSpinner: false,
  canRetryCurrentImage: false,
  markImageAsDecoded: vi.fn(),
  markImageDecodeFailed: vi.fn(),
  cancelCurrentImageLoad: vi.fn(),
  retryCurrentImage: vi.fn(),
});

const mockUseCachedImageGallery = vi.fn(createGalleryMock);

vi.mock("../../../hooks/useCachedImageGallery", () => ({
  useCachedImageGallery: () => mockUseCachedImageGallery(),
}));

vi.mock("../../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getImageBlob: vi.fn(),
  },
}));

vi.mock("../../../services/logger", () => ({
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../viewerContent", () => ({ downloadViewerBlob: vi.fn() }));

describe("ImageViewer", () => {
  beforeEach(() => {
    mockUseCachedImageGallery.mockReset();
    mockUseCachedImageGallery.mockReturnValue(createGalleryMock());

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("min-width"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("shows a read-only badge in the toolbar when opened in read-only mode", () => {
    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} isReadOnly={true} />
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("shares the retained displayed conversion instead of fetching the stored original", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    const displayed = new Blob(["displayed PNG"], { type: "image/png" });
    mockUseCachedImageGallery.mockReturnValue({ ...createGalleryMock(), filename: "photo.heic", getCachedImageBlob: () => displayed });
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      render(
        <SambeeThemeProvider>
          <ImageViewer connectionId="conn-1" path="photo.heic" onClose={() => {}} />
        </SambeeThemeProvider>
      );
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(share).toHaveBeenCalledExactlyOnceWith({
        files: [expect.objectContaining({ name: "photo.png", type: "image/png", size: displayed.size })],
        title: "photo.png",
      });
      expect(await readBlobAsText(share.mock.calls[0]?.[0]?.files[0])).toBe("displayed PNG");
      expect(apiService.getImageBlob).not.toHaveBeenCalled();
      await act(async () => {});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("blocks stale image bytes during replacement and downloads the exact failed displayed attachment", async () => {
    const share = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
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
    const onClose = vi.fn();
    const gallery = {
      ...createGalleryMock(),
      currentImageLoadPhase: "ready" as ImageLoadPhase,
      getCachedImageBlob: () => new Blob(["displayed original JPEG"], { type: "image/jpeg" }),
    };
    const original = gallery.getCachedImageBlob();
    gallery.getCachedImageBlob = () => original;
    mockUseCachedImageGallery.mockImplementation(() => gallery);
    const viewer = (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
      </SambeeThemeProvider>
    );
    try {
      const { rerender } = render(viewer);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
      expect(await readBlobAsText(share.mock.calls[0]?.[0]?.files[0])).toBe("displayed original JPEG");
      for (const phase of ["fetching", "error"] as const) {
        gallery.currentImageLoadPhase = phase;
        rerender(
          <SambeeThemeProvider>
            <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
          </SambeeThemeProvider>
        );
        const button = screen.getByRole("button", { name: "Share" });
        expect(button).toBeDisabled();
        fireEvent.click(button);
        expect(share).toHaveBeenCalledTimes(1);
      }
      const replacement = new Blob(["replacement resized PNG"], { type: "image/png" });
      gallery.getCachedImageBlob = () => replacement;
      gallery.currentImageLoadPhase = "ready";
      rerender(
        <SambeeThemeProvider>
          <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
        </SambeeThemeProvider>
      );
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      const details = await screen.findByRole("button", { name: "Details" });
      const attachment = share.mock.calls[1]?.[0]?.files[0];
      expect(attachment).toMatchObject({ name: "photo.png", type: "image/png" });
      expect(await readBlobAsText(attachment)).toBe("replacement resized PNG");
      fireEvent.click(details);
      await screen.findByText(/"reason": "NotAllowedError"/);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await screen.findByRole("button", { name: "Details" });
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      expect(downloadViewerBlob).toHaveBeenCalledWith(attachment, "photo.png");
      expect(apiService.getImageBlob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("updates a preloaded slide source before marking it decoded", () => {
    const markImageAsDecoded = vi.fn();
    const gallery = {
      ...createGalleryMock(),
      currentImageLoadPhase: "decoding" as const,
      imageSourceRevision: 0,
      markImageAsDecoded,
      getCachedImageSrc: () => undefined,
    };
    mockUseCachedImageGallery.mockImplementation(() => gallery);

    const { rerender } = render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="archive/image.png" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", expect.stringContaining("data:image/png"));

    gallery.imageSourceRevision = 1;
    gallery.getCachedImageSrc = () => "blob:preloaded-image";
    rerender(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="archive/image.png" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    const image = screen.getByTestId("lightbox-image");
    expect(image).toHaveAttribute("src", "blob:preloaded-image");
    fireEvent.load(image);
    expect(markImageAsDecoded).toHaveBeenCalledWith(0, "blob:preloaded-image");
  });

  it("requests the next virtual page when the gallery reaches its loaded tail", () => {
    const onLoadMoreItems = vi.fn();

    render(
      <SambeeThemeProvider>
        <ImageViewer
          connectionId="conn-1"
          path="images/photo.jpg"
          onClose={() => {}}
          images={["images/photo.jpg"]}
          hasMoreItems={true}
          onLoadMoreItems={onLoadMoreItems}
        />
      </SambeeThemeProvider>
    );

    expect(onLoadMoreItems).toHaveBeenCalledOnce();
  });

  it("closes shortcuts help on Escape without closing the viewer", async () => {
    const onClose = vi.fn();

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "?" });

    await waitFor(() => {
      expect(screen.getByText("Image viewer shortcuts")).toBeInTheDocument();
    });

    const searchInput = screen.getByRole("searchbox");
    await waitFor(() => expect(searchInput).toHaveFocus());
    fireEvent.keyDown(searchInput, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("Image viewer shortcuts")).not.toBeInTheDocument();
    });

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders slide sources from the hook cache accessor instead of the raw cache ref", () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      imageCacheRef: { current: new Map([[0, "blob:stale-ref"]]) },
      getCachedImageSrc: (index: number) => (index === 0 ? "blob:fresh-accessor" : undefined),
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} images={["/images/photo.jpg"]} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("image-lightbox")).toHaveAttribute("data-current-src", "blob:fresh-accessor");
  });

  it("marks an image ready only after its native load event", () => {
    const markImageAsDecoded = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      currentImageLoadPhase: "decoding",
      getCachedImageSrc: () => "blob:decoded-image",
      markImageAsDecoded,
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} images={["/images/photo.jpg"]} />
      </SambeeThemeProvider>
    );

    expect(markImageAsDecoded).not.toHaveBeenCalled();
    fireEvent.load(screen.getByTestId("lightbox-image"));
    expect(markImageAsDecoded).toHaveBeenCalledWith(0, "blob:decoded-image");
  });

  it("hides the lightbox error placeholder while showing the shared image error", () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "Failed to load image"]]),
      currentImageLoadPhase: "error",
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/invalid.psd" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Failed to load image")).toBeInTheDocument();
    expect(screen.getByTestId("image-lightbox").parentElement).toHaveClass("image-viewer-load-error");
  });

  it("offers manual retry only for recoverable image errors", () => {
    const retryCurrentImage = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "Server is busy. Please wait a moment and try again."]]),
      currentImageLoadPhase: "error",
      canRetryCurrentImage: true,
      retryCurrentImage,
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryCurrentImage).toHaveBeenCalledOnce();
  });

  it("does not offer retry for a local preview policy error", () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "This image format requires server-side conversion."]]),
      currentImageLoadPhase: "error",
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="local-conn-1" path="/images/photo.psd" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows cancel feedback only after slow image loading and invokes cancellation", () => {
    vi.useFakeTimers();
    const cancelCurrentImageLoad = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      currentImageLoadPhase: "fetching",
      loadingStates: new Map([[0, true]]),
      showLoadingSpinner: true,
      cancelCurrentImageLoad,
    });

    render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("image-loading-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("image-loading-status")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText("Preparing image")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelCurrentImageLoad).toHaveBeenCalledOnce();
  });
});
