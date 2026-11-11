import { act, createEvent, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const transitionPreference = vi.hoisted(() => ({ value: "carousel" as "carousel" | "none" | undefined }));
const lightboxZoom = vi.hoisted(() => ({ zoom: 1, changeZoom: vi.fn() }));

vi.mock("../../../services/userSettingsStore", () => ({
  useCurrentUserSetting: () => ({ confirmedValue: transitionPreference.value }),
}));

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

async function render(ui: ReactNode) {
  return act(async () => renderBase(ui, { wrapper: ContentProviderTestWrapper }));
}

vi.mock("yet-another-react-lightbox", () => ({
  __esModule: true,
  default: ({
    slides,
    index,
    carousel,
    render: lightboxRender,
    close,
    controller,
    animation,
    zoom,
  }: {
    slides: Array<{ src: string }>;
    index: number;
    carousel?: { imageProps?: (slide: { src: string }) => Record<string, unknown> };
    render?: { slideHeader?: (props: { slide: { src: string } }) => React.ReactNode };
    close?: () => void;
    controller?: { closeOnEscape?: boolean };
    animation?: { navigation?: number; swipe?: number };
    zoom?: { ref?: { current: typeof lightboxZoom | null } };
  }) => {
    useLayoutEffect(() => {
      const ref = zoom?.ref;
      if (!ref) return;
      ref.current = lightboxZoom;
      return () => {
        ref.current = null;
      };
    }, [zoom?.ref]);
    const slide = slides[index];
    const imageProps = slide ? carousel?.imageProps?.(slide) : undefined;

    return (
      <section
        aria-label="Image lightbox"
        tabIndex={-1}
        data-testid="image-lightbox"
        data-current-src={slide?.src ?? ""}
        data-navigation-duration={animation?.navigation}
        data-swipe-duration={animation?.swipe}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (controller?.closeOnEscape ?? true)) {
            event.stopPropagation();
            close?.();
          }
        }}
      >
        {slide && <img alt="" data-testid="lightbox-image" src={slide.src} {...imageProps} />}
        {slide && lightboxRender?.slideHeader?.({ slide })}
      </section>
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
  pinCachedImage: vi.fn(() => vi.fn()),
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ArrowLeft", "ArrowRight"])("leaves %s to the lightbox while zoomed", async (key) => {
    const gallery = createGalleryMock();
    mockUseCachedImageGallery.mockReturnValue(gallery);
    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" images={["/images/photo.jpg", "/images/next.jpg"]} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    lightboxZoom.zoom = 2;
    const lightbox = screen.getByTestId("image-lightbox");
    const lightboxKeyDown = vi.fn();
    lightbox.addEventListener("keydown", lightboxKeyDown);
    const event = createEvent.keyDown(lightbox, { key });
    fireEvent(lightbox, event);
    expect(lightboxKeyDown).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(gallery.setCurrentIndex).not.toHaveBeenCalled();
  });

  it.each(["Retry", "Cancel"] as const)("keeps the requested target selected during pointer activation of %s", async (action) => {
    if (action === "Cancel") vi.useFakeTimers();
    const images = ["/images/photo.jpg", "/images/next.jpg"];
    const blob = new Blob(["image"], { type: "image/jpeg" });
    const gallery = {
      ...createGalleryMock(),
      getCachedImageSrc: (index: number) => (index === 0 ? "blob:first" : undefined),
      getCachedImageBlob: () => blob,
    };
    mockUseCachedImageGallery.mockImplementation(() => gallery);
    const viewer = () => (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path={images[0]!} images={images} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer());
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "ArrowRight" });
    gallery.currentIndex = 1;
    gallery.currentPath = images[1]!;
    gallery.filename = "next.jpg";
    gallery.currentImageLoadPhase = action === "Retry" ? "error" : "fetching";
    gallery.errorStates = action === "Retry" ? new Map([[1, "Failed to load image"]]) : new Map();
    gallery.canRetryCurrentImage = action === "Retry";
    gallery.showLoadingSpinner = action === "Cancel";
    rerender(viewer());
    if (action === "Cancel") {
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }
    gallery.setCurrentIndex.mockClear();
    const button = screen.getByRole("button", { name: action });
    fireEvent.pointerDown(button);
    expect(gallery.setCurrentIndex).not.toHaveBeenCalled();
    fireEvent.pointerUp(button);
    fireEvent.click(button);
    expect(action === "Retry" ? gallery.retryCurrentImage : gallery.cancelCurrentImageLoad).toHaveBeenCalledOnce();
    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "blob:first");
  });

  it("ignores an older decode completion while the latest target is still decoding", async () => {
    const images = ["/first.jpg", "/second.jpg", "/last.jpg"];
    const sources = ["blob:first", "blob:second", "blob:last"];
    const blob = new Blob(["image"], { type: "image/jpeg" });
    const gallery = {
      ...createGalleryMock(),
      currentPath: images[0]!,
      filename: "first.jpg",
      getCachedImageSrc: (index: number) => sources[index],
      getCachedImageBlob: () => blob,
    };
    mockUseCachedImageGallery.mockImplementation(() => gallery);
    const viewer = () => (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path={images[0]!} images={images} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer());
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "ArrowRight" });
    gallery.currentIndex = 1;
    gallery.currentPath = images[1]!;
    gallery.filename = "second.jpg";
    gallery.currentImageLoadPhase = "decoding";
    rerender(viewer());
    let finishOlderDecode!: () => void;
    const olderDecode = new Promise<void>((resolve) => {
      finishOlderDecode = resolve;
    });
    const pending = screen.getByTestId("pending-image-decode");
    Object.defineProperty(pending, "decode", { value: () => olderDecode });
    fireEvent.load(pending);
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "End" });
    gallery.currentIndex = 2;
    gallery.currentPath = images[2]!;
    gallery.filename = "last.jpg";
    rerender(viewer());
    await act(async () => finishOlderDecode());
    expect(gallery.markImageAsDecoded).toHaveBeenCalledWith(1, "blob:second");
    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "blob:first");
    expect(screen.getByTestId("pending-image-decode")).toHaveAttribute("src", "blob:last");
    fireEvent.load(screen.getByTestId("pending-image-decode"));
    await act(async () => {});
    expect(gallery.markImageAsDecoded).toHaveBeenCalledWith(2, "blob:last");
    gallery.currentImageLoadPhase = "ready";
    rerender(viewer());
    await waitFor(() => expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "blob:last"));
  });

  it.each(["none", undefined] as const)("disables discrete animation without changing touch animation (%s)", async (preference) => {
    transitionPreference.value = preference;
    const gallery = createGalleryMock();
    mockUseCachedImageGallery.mockReturnValue(gallery);
    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" images={["/images/photo.jpg", "/images/next.jpg"]} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    const lightbox = screen.getByTestId("image-lightbox");
    fireEvent.keyDown(lightbox, { key: "ArrowRight" });
    expect(lightbox).toHaveAttribute("data-navigation-duration", "0");
    expect(lightbox).toHaveAttribute("data-swipe-duration", "400");
    const next = screen.getByRole("button", { name: "Next" });
    const touch = createEvent.pointerDown(next);
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    fireEvent(next, touch);
    fireEvent.click(next);
    expect(lightbox).toHaveAttribute("data-navigation-duration", "400");
    expect(lightbox).toHaveAttribute("data-swipe-duration", "400");
    fireEvent.keyDown(next, { key: "Enter" });
    fireEvent.click(next);
    expect(lightbox).toHaveAttribute("data-navigation-duration", "0");
  });

  it("loads all remaining archive pages for End, including pages without images", async () => {
    const onLoadMoreItems = vi.fn();
    const gallery = createGalleryMock();
    mockUseCachedImageGallery.mockReturnValue(gallery);
    const images = ["/0.jpg", "/1.jpg"];
    const virtualSource = {
      kind: "virtual" as const,
      path: "/0.jpg",
      location: {
        kind: "virtual" as const,
        providerId: "zip",
        connectionId: "conn-1",
        source: { kind: "physical" as const, connectionId: "conn-1", path: "/images.zip" },
        path: "",
      },
    };
    const viewer = (loading: boolean, more: boolean, error: string | null = null) => (
      <SambeeThemeProvider>
        <ImageViewer
          connectionId="conn-1"
          path="/0.jpg"
          images={[...images]}
          virtualSource={virtualSource}
          onClose={() => {}}
          hasMoreItems={more}
          isLoadingMoreItems={loading}
          loadMoreError={error}
          onLoadMoreItems={onLoadMoreItems}
        />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer(false, true));
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "End" });
    expect(onLoadMoreItems).toHaveBeenCalledTimes(1);
    rerender(viewer(true, true));
    rerender(viewer(false, true));
    expect(onLoadMoreItems).toHaveBeenCalledTimes(2);
    rerender(viewer(true, true));
    images.push("/2.jpg");
    rerender(viewer(false, false));
    expect(gallery.setCurrentIndex).toHaveBeenLastCalledWith(2);
  });

  it("stops a failed End intent and cancels pending desktop navigation when a gesture starts", async () => {
    const gallery = createGalleryMock();
    mockUseCachedImageGallery.mockReturnValue(gallery);
    const onLoadMoreItems = vi.fn();
    const images = ["/0.jpg", "/1.jpg"];
    const viewer = (loading: boolean, error: string | null = null) => (
      <SambeeThemeProvider>
        <ImageViewer
          connectionId="conn-1"
          path="/0.jpg"
          images={images}
          onClose={() => {}}
          hasMoreItems
          isLoadingMoreItems={loading}
          loadMoreError={error}
          onLoadMoreItems={onLoadMoreItems}
        />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer(false));
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "End" });
    rerender(viewer(true));
    rerender(viewer(false, "The archive listing failed."));
    expect(screen.getByRole("alert")).toHaveTextContent("Try End again");
    expect(onLoadMoreItems).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "ArrowRight" });
    expect(gallery.setCurrentIndex).toHaveBeenLastCalledWith(1);
    fireEvent.pointerDown(screen.getByTestId("image-lightbox"));
    expect(gallery.setCurrentIndex).toHaveBeenLastCalledWith(0);
  });

  it("retains the decoded image and filename until the latest requested target is ready", async () => {
    const images = ["/images/photo.jpg", "/images/second.jpg", "/images/last.jpg"];
    const blob = new Blob(["image"], { type: "image/jpeg" });
    const gallery = {
      ...createGalleryMock(),
      getCachedImageSrc: (index: number) => (index === 0 ? "blob:first" : (undefined as string | undefined)),
      getCachedImageBlob: () => blob,
    };
    mockUseCachedImageGallery.mockImplementation(() => gallery);
    const viewer = () => (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path={images[0]!} images={images} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer());
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "ArrowRight" });
    gallery.currentIndex = 1;
    gallery.currentPath = images[1]!;
    gallery.filename = "second.jpg";
    gallery.currentImageLoadPhase = "fetching";
    rerender(viewer());
    expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "blob:first");
    expect(screen.getByText("photo.jpg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "End" });
    expect(gallery.setCurrentIndex).toHaveBeenLastCalledWith(2);
    gallery.currentIndex = 2;
    gallery.currentPath = images[2]!;
    gallery.filename = "last.jpg";
    gallery.currentImageLoadPhase = "ready";
    gallery.getCachedImageSrc = (index) => (index === 2 ? "blob:last" : undefined);
    gallery.imageSourceRevision++;
    rerender(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path={images[0]!} images={images} onClose={() => {}} />
      </SambeeThemeProvider>
    );
    await waitFor(() => expect(screen.getByTestId("lightbox-image")).toHaveAttribute("src", "blob:last"));
    expect(screen.getByText("last.jpg")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "Home" });
    expect(gallery.setCurrentIndex).toHaveBeenLastCalledWith(0);
  });

  beforeEach(() => {
    transitionPreference.value = "carousel";
    lightboxZoom.zoom = 1;
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

  it("closes exactly once on Escape from lightbox content", async () => {
    const onClose = vi.fn();
    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
      </SambeeThemeProvider>
    );

    screen.getByRole("dialog").focus();
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("blurs toolbar focus on the first Escape and closes once on the next", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} />
      </SambeeThemeProvider>
    );
    const close = screen.getByRole("button", { name: "Close" });
    await act(async () => close.focus());

    await user.keyboard("{Escape}");
    expect(close).not.toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a read-only badge in the toolbar when opened in read-only mode", async () => {
    await render(
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
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      filename: "photo.heic",
      getCachedImageSrc: () => "blob:displayed-image",
      getCachedImageBlob: () => displayed,
    });
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
      await render(
        <SambeeThemeProvider>
          <ImageViewer connectionId="conn-1" path="photo.heic" onClose={() => {}} />
        </SambeeThemeProvider>
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Share" }));
      });
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
    const user = userEvent.setup();
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
      getCachedImageSrc: () => "blob:displayed-image",
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
      const { rerender } = await render(viewer);
      await user.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
      await act(async () => {
        expect(await readBlobAsText(share.mock.calls[0]?.[0]?.files[0])).toBe("displayed original JPEG");
      });
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
      await user.click(screen.getByRole("button", { name: "Share" }));
      const details = await screen.findByRole("button", { name: "Details" });
      const attachment = share.mock.calls[1]?.[0]?.files[0];
      expect(attachment).toMatchObject({ name: "photo.png", type: "image/png" });
      await act(async () => {
        expect(await readBlobAsText(attachment)).toBe("replacement resized PNG");
      });
      await user.click(details);
      await screen.findByText(/"reason": "NotAllowedError"/);
      await user.keyboard("{Escape}");
      await screen.findByRole("button", { name: "Details" });
      expect(onClose).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Download" }));
      expect(downloadViewerBlob).toHaveBeenCalledWith(attachment, "photo.png");
      expect(apiService.getImageBlob).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("updates a preloaded slide source before marking it decoded", async () => {
    const markImageAsDecoded = vi.fn();
    const gallery = {
      ...createGalleryMock(),
      currentImageLoadPhase: "decoding" as const,
      imageSourceRevision: 0,
      markImageAsDecoded,
      getCachedImageSrc: (): string | undefined => undefined,
    };
    mockUseCachedImageGallery.mockImplementation(() => gallery);

    const { rerender } = await render(
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

  it("requests the next virtual page when the gallery reaches its loaded tail", async () => {
    const onLoadMoreItems = vi.fn();

    await render(
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

  it.each(["ArrowLeft", "ArrowRight"])("leaves Alt+%s to browser history and handles plain arrows in the viewer", async (key) => {
    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} />
      </SambeeThemeProvider>
    );
    const lightbox = screen.getByTestId("image-lightbox");
    const lightboxKeyDown = vi.fn((event: Event) => event.preventDefault());
    lightbox.addEventListener("keydown", lightboxKeyDown);

    const historyKey = createEvent.keyDown(lightbox, { key, altKey: true });
    fireEvent(lightbox, historyKey);
    expect(lightboxKeyDown).not.toHaveBeenCalled();
    expect(historyKey.defaultPrevented).toBe(false);

    const galleryKey = createEvent.keyDown(lightbox, { key });
    fireEvent(lightbox, galleryKey);
    expect(lightboxKeyDown).not.toHaveBeenCalled();
    expect(mockUseCachedImageGallery.mock.results[0]?.value.setCurrentIndex).toHaveBeenCalled();
    expect(galleryKey.defaultPrevented).toBe(true);
  });

  it("keeps the lightbox mounted while route navigation becomes pending and completes", async () => {
    const onClose = vi.fn();
    const viewer = (isTransitioning: boolean) => (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} isTransitioning={isTransitioning} />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer(false));
    const lightbox = screen.getByTestId("image-lightbox");

    for (const isTransitioning of [true, false]) {
      rerender(viewer(isTransitioning));
      expect(screen.getByTestId("image-lightbox")).toBe(lightbox);
    }
  });

  it.each(["ArrowLeft", "ArrowRight"])("blocks %s during pending route navigation and handles it again when ready", async (key) => {
    const onClose = vi.fn();
    const viewer = (isTransitioning: boolean) => (
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={onClose} isTransitioning={isTransitioning} />
      </SambeeThemeProvider>
    );
    const { rerender } = await render(viewer(true));
    const lightbox = screen.getByTestId("image-lightbox");
    const lightboxKeyDown = vi.fn();
    lightbox.addEventListener("keydown", lightboxKeyDown);

    fireEvent.keyDown(lightbox, { key });
    expect(lightboxKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(lightbox, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    lightboxKeyDown.mockClear();
    rerender(viewer(false));
    fireEvent.keyDown(screen.getByTestId("image-lightbox"), { key });
    expect(lightboxKeyDown).not.toHaveBeenCalled();
    expect(mockUseCachedImageGallery.mock.results[0]?.value.setCurrentIndex).toHaveBeenCalled();
  });

  it("closes shortcuts help on Escape without closing the viewer", async () => {
    const onClose = vi.fn();

    await render(
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

  it("renders slide sources from the hook cache accessor instead of the raw cache ref", async () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      imageCacheRef: { current: new Map([[0, "blob:stale-ref"]]) },
      getCachedImageSrc: (index: number) => (index === 0 ? "blob:fresh-accessor" : undefined),
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} images={["/images/photo.jpg"]} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("image-lightbox")).toHaveAttribute("data-current-src", "blob:fresh-accessor");
  });

  it("marks an image ready only after its native load event", async () => {
    const markImageAsDecoded = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      currentImageLoadPhase: "decoding",
      getCachedImageSrc: () => "blob:decoded-image",
      markImageAsDecoded,
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} images={["/images/photo.jpg"]} />
      </SambeeThemeProvider>
    );

    expect(markImageAsDecoded).not.toHaveBeenCalled();
    fireEvent.load(screen.getByTestId("lightbox-image"));
    expect(markImageAsDecoded).toHaveBeenCalledWith(0, "blob:decoded-image");
  });

  it("hides the lightbox error placeholder while showing the shared image error", async () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "Failed to load image"]]),
      currentImageLoadPhase: "error",
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/invalid.psd" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.getByText("Failed to load image")).toBeInTheDocument();
    expect(screen.getByTestId("image-lightbox").parentElement).toHaveClass("image-viewer-load-error");
  });

  it("offers manual retry only for recoverable image errors", async () => {
    const retryCurrentImage = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "Server is busy. Please wait a moment and try again."]]),
      currentImageLoadPhase: "error",
      canRetryCurrentImage: true,
      retryCurrentImage,
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryCurrentImage).toHaveBeenCalledOnce();
  });

  it("does not offer retry for a local preview policy error", async () => {
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      errorStates: new Map([[0, "This image format requires server-side conversion."]]),
      currentImageLoadPhase: "error",
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="local-conn-1" path="/images/photo.psd" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows cancel feedback only after slow image loading and invokes cancellation", async () => {
    vi.useFakeTimers();
    const cancelCurrentImageLoad = vi.fn();
    mockUseCachedImageGallery.mockReturnValue({
      ...createGalleryMock(),
      currentImageLoadPhase: "fetching",
      loadingStates: new Map([[0, true]]),
      showLoadingSpinner: true,
      cancelCurrentImageLoad,
    });

    await render(
      <SambeeThemeProvider>
        <ImageViewer connectionId="conn-1" path="/images/photo.jpg" onClose={() => {}} />
      </SambeeThemeProvider>
    );

    expect(screen.getByTestId("image-loading-overlay")).toBeInTheDocument();
    expect(screen.queryByTestId("image-loading-status")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText("Preparing image: photo.jpg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelCurrentImageLoad).toHaveBeenCalledOnce();
  });
});
