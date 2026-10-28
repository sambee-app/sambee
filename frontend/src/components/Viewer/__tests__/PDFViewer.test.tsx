import { act, fireEvent, render as renderBase, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef } from "react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentProviderRegistryContext } from "../../../pages/FileBrowser/contentProviders";
import apiService from "../../../services/api";
import * as logger from "../../../services/logger";
import { createStorageBackedTestContentProviderRegistry, readBlobAsText } from "../../../test/helpers";
import { SambeeThemeProvider } from "../../../theme";
import { DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE, DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR } from "../../../utils/domTextSearch";
import PDFViewer from "../PDFViewer";
import { createViewerSearchTestDriver } from "./viewerSearchTestUtils";

const contentProviders = createStorageBackedTestContentProviderRegistry();

function ContentProviderTestWrapper({ children }: { children: ReactNode }) {
  return <ContentProviderRegistryContext.Provider value={contentProviders}>{children}</ContentProviderRegistryContext.Provider>;
}

function render(ui: ReactNode) {
  return renderBase(ui, { wrapper: ContentProviderTestWrapper });
}

// Mock react-pdf components
vi.mock("react-pdf", () => ({
  Document: ({
    children,
    onLoadSuccess,
    onLoadError,
    onPassword,
    file,
    onItemClick,
    options,
    suspense,
  }: {
    children: React.ReactNode;
    onLoadSuccess?: (pdf: {
      numPages: number;
      getPage: (pageNum: number) => Promise<{
        getViewport: (params: { scale: number; rotation?: number }) => { width: number; height: number };
        getTextContent: () => Promise<{
          items: Array<{
            str: string;
            transform: number[];
            width: number;
            height: number;
          }>;
        }>;
      }>;
    }) => void;
    onLoadError?: (error: Error) => void;
    onPassword?: (callback: (password: string | null) => void) => void;
    file: string;
    suspense?: boolean;
    onItemClick?: (args: { dest?: unknown; pageIndex?: number; pageNumber?: number }) => void;
    options?: {
      cMapPacked?: boolean;
      cMapUrl?: string;
      iccUrl?: string;
      standardFontDataUrl?: string;
      wasmUrl?: string;
    };
  }) => {
    const loadedFileRef = useRef<string | null>(null);

    capturedInitialDocumentItemClick ??= onItemClick;

    const getPageItems = useCallback((pageNum: number) => {
      if (pageNum === 1) {
        return [
          {
            str: "Page sample text",
            transform: [1, 0, 0, 1, 0, 0],
            width: 120,
            height: 12,
          },
          {
            str: "MDT Di",
            transform: [1, 0, 0, 1, 0, 16],
            width: 120,
            height: 12,
          },
          {
            str: "mmaktor",
            transform: [1, 0, 0, 1, 0, 32],
            width: 160,
            height: 12,
          },
          {
            str: "MDT_DB_Di",
            transform: [1, 0, 0, 1, 0, 48],
            width: 160,
            height: 12,
          },
          {
            str: "mmaktor_02.pdf",
            transform: [1, 0, 0, 1, 0, 64],
            width: 160,
            height: 12,
          },
        ];
      }

      return [
        {
          str: "Page sample text",
          transform: [1, 0, 0, 1, 0, 0],
          width: 120,
          height: 12,
        },
      ];
    }, []);

    useEffect(() => {
      const nextLoadError = mockDocumentLoadErrors.shift();
      if (mockPasswordRequest && onPassword) {
        mockPasswordRequest = false;
        queueMicrotask(() => {
          onPassword((password) => {
            submittedPdfPassword = password;
          });
        });
      } else if (nextLoadError) {
        queueMicrotask(() => {
          onLoadError?.(nextLoadError);
        });
      } else if (file && loadedFileRef.current !== file) {
        loadedFileRef.current = file;

        queueMicrotask(() => {
          const mockPdf = {
            numPages: 5,
            getPage: (pageNum: number) =>
              Promise.resolve({
                rotate: mockIntrinsicPageRotations.get(pageNum) ?? 0,
                getViewport: () => ({ width: 612, height: 792 }),
                getTextContent: async () => {
                  if (mockTextExtractionDelayMs > 0) {
                    await new Promise<void>((resolve) => {
                      window.setTimeout(resolve, mockTextExtractionDelayMs);
                    });
                  }
                  return { items: getPageItems(pageNum) };
                },
              }),
          };
          onLoadSuccess?.(mockPdf);
        });
      }
    }, [file, getPageItems, onLoadError, onLoadSuccess, onPassword]);

    return (
      <div
        data-cmap-packed={options?.cMapPacked}
        data-cmap-url={options?.cMapUrl}
        data-icc-url={options?.iccUrl}
        data-standard-font-url={options?.standardFontDataUrl}
        data-testid="pdf-document"
        data-wasm-url={options?.wasmUrl}
        data-file={file}
        data-suspense={suspense}
      >
        <button
          type="button"
          data-testid="pdf-internal-link"
          onClick={() => capturedInitialDocumentItemClick?.({ dest: "chapter-3", pageIndex: 2, pageNumber: 3 })}
        >
          Jump to page 3
        </button>
        {children}
      </div>
    );
  },
  Page: ({
    pageNumber,
    scale,
    width,
    rotate,
    renderTextLayer,
    onLoadSuccess,
    onRenderSuccess,
    onRenderTextLayerSuccess,
  }: {
    pageNumber: number;
    scale?: number;
    width?: number;
    rotate?: number;
    renderTextLayer?: boolean;
    onLoadSuccess?: (page: {
      rotate: number;
      getViewport: (params: { scale: number; rotation?: number }) => { width: number; height: number };
    }) => void;
    onRenderSuccess?: () => void;
    onRenderTextLayerSuccess?: () => void;
  }) => {
    const pageWidth = pageNumber === 1 ? 612 : 1224;
    const pageHeight = 792;
    const intrinsicRotation = mockIntrinsicPageRotations.get(pageNumber) ?? 0;
    const effectiveRotation = rotate ?? intrinsicRotation;
    const onRenderSuccessRef = useRef(onRenderSuccess);
    mockPageRenderCounts.set(pageNumber, (mockPageRenderCounts.get(pageNumber) ?? 0) + 1);

    useEffect(() => {
      onRenderSuccessRef.current = onRenderSuccess;
    }, [onRenderSuccess]);

    useEffect(() => {
      onLoadSuccess?.({
        rotate: intrinsicRotation,
        getViewport: ({ rotation: viewportRotation }) =>
          (viewportRotation ?? intrinsicRotation) % 180 !== 0
            ? { width: pageHeight, height: pageWidth }
            : { width: pageWidth, height: pageHeight },
      });
      if (mockPageRenderDelayMs > 0) {
        const renderTimer = window.setTimeout(() => onRenderSuccessRef.current?.(), mockPageRenderDelayMs);
        return () => window.clearTimeout(renderTimer);
      }
      onRenderSuccessRef.current?.();
      if (renderTextLayer && pageNumber !== mockMissingTextLayerPage) {
        onRenderTextLayerSuccess?.();
      }
    }, [intrinsicRotation, onLoadSuccess, onRenderTextLayerSuccess, pageNumber, pageWidth, renderTextLayer]);

    const textLayerSpans =
      pageNumber === 1
        ? ["Page sample text", "MDT Di", "mmaktor", "MDT_DB_Di", "mmaktor_02.pdf"]
        : pageNumber === 3
          ? ["Pa", "ge sample text"]
          : ["Page sample text"];

    return (
      <div data-testid="pdf-page" data-page={pageNumber} data-scale={scale} data-width={width} data-rotate={effectiveRotation}>
        <canvas />
        {renderTextLayer && pageNumber !== mockMissingTextLayerPage && (
          <div className="react-pdf__Page__textContent">
            {textLayerSpans.map((text) => (
              <span key={`${pageNumber}-${text}`}>{text}</span>
            ))}
          </div>
        )}
      </div>
    );
  },
  pdfjs: { version: "3.11.174", GlobalWorkerOptions: { workerSrc: "" } },
}));

// Mock API service
vi.mock("../../../services/api");

// Mock logger
vi.mock("../../../services/logger", () => ({
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Mock URL.createObjectURL and revokeObjectURL
const mockCreateObjectURL = vi.fn(() => "blob:mock-url");
const mockRevokeObjectURL = vi.fn();
globalThis.URL.createObjectURL = mockCreateObjectURL;
globalThis.URL.revokeObjectURL = mockRevokeObjectURL;

let capturedInitialDocumentItemClick: ((args: { dest?: unknown; pageIndex?: number; pageNumber?: number }) => void) | undefined;
let mockBlobUrlCounter = 0;
let mockMissingTextLayerPage: number | null = null;
let mockPageRenderCounts = new Map<number, number>();
let mockIntrinsicPageRotations = new Map<number, number>();
let mockDocumentLoadErrors: Error[] = [];
let mockPasswordRequest = false;
let submittedPdfPassword: string | null = null;
let mockTextExtractionDelayMs = 0;
let mockPageRenderDelayMs = 0;

function mockMatchMedia(matches: boolean, reducedMotion = false) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" ? reducedMotion : matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock ResizeObserver
globalThis.ResizeObserver = class MockResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe() {
    // Immediately trigger with mock dimensions
    this.callback(
      [
        {
          target: document.createElement("div"),
          contentRect: {
            width: 800,
            height: 600,
            top: 0,
            left: 0,
            bottom: 600,
            right: 800,
            x: 0,
            y: 0,
          } as DOMRectReadOnly,
          borderBoxSize: [] as unknown as ReadonlyArray<ResizeObserverSize>,
          contentBoxSize: [] as unknown as ReadonlyArray<ResizeObserverSize>,
          devicePixelContentBoxSize: [] as unknown as ReadonlyArray<ResizeObserverSize>,
        } as ResizeObserverEntry,
      ],
      this
    );
  }

  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("PDFViewer", () => {
  const SWIPE_SETTLE_WAIT_MS = 500;
  const viewerSearch = createViewerSearchTestDriver();

  const findPageCounterText = (expectedText: string) =>
    screen.queryByText((_content, node) => {
      if (node?.textContent?.trim() !== expectedText) {
        return false;
      }

      return !Array.from(node.children).some((child) => child.textContent?.trim() === expectedText);
    });

  const getActivePdfPage = () => {
    const activePage = document.querySelector('[data-page-number] [data-testid="pdf-page"]');
    if (!(activePage instanceof HTMLElement)) {
      throw new Error("Active PDF page is not rendered");
    }

    return activePage;
  };

  const dragCarousel = (element: HTMLElement, startX: number, startY: number, endX: number, endY: number) => {
    fireEvent.pointerDown(element, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: startX,
      clientY: startY,
      buttons: 1,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: endX,
      clientY: endY,
      buttons: 1,
    });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: endX, clientY: endY });
  };

  const mockOnClose = vi.fn();
  const defaultProps = {
    connectionId: "test-conn-id",
    path: "/test/document.pdf",
    onClose: mockOnClose,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capturedInitialDocumentItemClick = undefined;
    mockBlobUrlCounter = 0;
    mockMissingTextLayerPage = null;
    mockPageRenderCounts = new Map();
    mockIntrinsicPageRotations = new Map();
    mockDocumentLoadErrors = [];
    mockPasswordRequest = false;
    submittedPdfPassword = null;
    mockTextExtractionDelayMs = 0;
    mockPageRenderDelayMs = 0;
    mockCreateObjectURL.mockImplementation(() => `blob:mock-url-${++mockBlobUrlCounter}`);
    mockMatchMedia(false);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        ...globalThis.navigator,
      },
    });

    // Mock successful API response by default
    (apiService.getPdfBlob as Mock).mockResolvedValue(new Blob(["mock pdf content"], { type: "application/pdf" }));
    vi.mocked(apiService.getFileInfo).mockResolvedValue({ type: "file" } as never);

    // Reset AbortController to default
    globalThis.AbortController = class MockAbortController {
      signal = { aborted: false } as AbortSignal;
      abort = vi.fn();
    } as unknown as typeof AbortController;
  });

  const renderPDFViewer = (props: ComponentProps<typeof PDFViewer> = defaultProps) => {
    return render(
      <SambeeThemeProvider>
        <PDFViewer {...props} />
      </SambeeThemeProvider>
    );
  };

  const getSearchHighlights = () => Array.from(document.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR));

  const waitForPageNavigationReady = async () => {
    await waitFor(() => {
      expect(screen.getByLabelText("Next page")).toBeEnabled();
    });
  };

  const waitForZoomControlsReady = async () => {
    await waitFor(() => {
      expect(screen.getByLabelText("Zoom in")).toBeEnabled();
    });
  };

  it("shows a read-only badge in the toolbar when opened in read-only mode", async () => {
    renderPDFViewer({
      ...defaultProps,
      isReadOnly: true,
    });

    await waitFor(() => {
      expect(screen.getByText("Read only")).toBeInTheDocument();
    });
  });

  it("loads a virtual PDF through its provider instead of the physical PDF endpoint", async () => {
    const virtualSource = {
      kind: "virtual" as const,
      path: "docs/inside.pdf",
      location: {
        kind: "virtual" as const,
        providerId: "zip",
        connectionId: "test-conn-id",
        source: { kind: "physical" as const, connectionId: "test-conn-id", path: "archives/backup.zip" },
        path: "docs",
      },
    };
    (apiService.getArchiveMember as Mock).mockResolvedValue(new Blob(["virtual pdf"], { type: "application/pdf" }));

    renderPDFViewer({ ...defaultProps, path: "docs/inside.pdf", virtualSource });

    await waitFor(() => {
      expect(apiService.getArchiveMember).toHaveBeenCalledWith("test-conn-id", "archives/backup.zip", "docs/inside.pdf", {
        download: undefined,
        request: { kind: "pdf" },
        signal: expect.anything(),
      });
    });
    expect(apiService.getPdfBlob).not.toHaveBeenCalled();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  describe("Rendering States", () => {
    it("renders loading state initially", async () => {
      renderPDFViewer();
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
      await waitForPageNavigationReady();
    });

    it("renders PDF document when loaded successfully", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
      });
    });

    it("configures local PDF.js optional resource assets", async () => {
      renderPDFViewer();

      const documentElement = await screen.findByTestId("pdf-document");

      expect(documentElement).toHaveAttribute("data-cmap-packed", "true");
      expect(documentElement).toHaveAttribute("data-cmap-url", "/pdfjs/cmaps/");
      expect(documentElement).toHaveAttribute("data-icc-url", "/pdfjs/iccs/");
      expect(documentElement).toHaveAttribute("data-standard-font-url", "/pdfjs/standard_fonts/");
      expect(documentElement).toHaveAttribute("data-wasm-url", "/pdfjs/wasm/");
    });

    it("renders error state when fetch fails", async () => {
      (apiService.getPdfBlob as Mock).mockRejectedValue(new Error("Network error"));

      renderPDFViewer();

      // Wait longer because network errors trigger retry with 1s delay
      await waitFor(
        () => {
          expect(screen.getByText(/Server is busy/i)).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it("shows CircularProgress while loading", async () => {
      renderPDFViewer();
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
      await waitForPageNavigationReady();
    });

    it("does not show loading text for a promptly rendered PDF", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();
      });

      expect(screen.queryByTestId("pdf-loading-status")).not.toBeInTheDocument();
    });

    it.each([false, true])("reveals only the rendered page with reduced motion %s", async (reducedMotion) => {
      vi.useFakeTimers();
      mockMatchMedia(false, reducedMotion);
      mockPageRenderDelayMs = 1000;

      try {
        renderPDFViewer();
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        const presentation = screen.getByTestId("pdf-document-presentation");
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
        expect(presentation).toHaveStyle({ opacity: "0", visibility: "hidden", transition: "none" });
        expect(presentation).toHaveAttribute("aria-hidden", "true");
        expect(presentation).toHaveAttribute("inert");

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        expect(presentation).toHaveStyle({
          opacity: "1",
          visibility: "visible",
          transition: `opacity ${reducedMotion ? 0 : 160}ms ease-in-out`,
        });
        expect(presentation).toHaveAttribute("aria-hidden", "false");
        expect(presentation).not.toHaveAttribute("inert");
        expect(screen.getByLabelText("Next page")).toBeEnabled();

        if (!reducedMotion) {
          const overlay = screen.getByTestId("pdf-loading-overlay");
          expect(overlay).toHaveStyle({ opacity: "0", pointerEvents: "none" });
          expect(overlay).toHaveAttribute("aria-hidden", "true");
          expect(overlay).toHaveAttribute("inert");
          await act(async () => {
            await vi.advanceTimersByTimeAsync(159);
          });
          expect(overlay).toBeInTheDocument();
        }

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();

        fireEvent.click(screen.getByLabelText("Next page"));
        expect(getActivePdfPage()).toHaveAttribute("data-page", "2");
        expect(presentation).toHaveStyle({ opacity: "1", visibility: "visible" });
        expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("conceals a replacement document until its first page renders", async () => {
      const { rerender } = renderPDFViewer();
      await waitForPageNavigationReady();
      mockPageRenderDelayMs = 1000;

      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/replacement.pdf" />
        </SambeeThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId("pdf-document")).toHaveAttribute("data-file", "blob:mock-url-2");
      });
      expect(screen.getByTestId("pdf-document-presentation")).toHaveStyle({ opacity: "0", visibility: "hidden", transition: "none" });
      expect(screen.getByTestId("pdf-loading-overlay")).toHaveAttribute("aria-hidden", "false");
      expect(screen.getByLabelText("Zoom in")).toBeDisabled();
    });

    it("keeps users informed until the first page has rendered", async () => {
      vi.useFakeTimers();
      mockPageRenderDelayMs = 6000;
      const downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("document.pdf");
        expect(this.href).toBe("blob:mock-url-1");
      });

      try {
        renderPDFViewer();
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(screen.getByTestId("pdf-loading-overlay")).toBeInTheDocument();
        expect(screen.queryByTestId("pdf-loading-status")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Zoom in")).toBeDisabled();
        expect(screen.getByLabelText("Rotate right")).toBeDisabled();
        expect(screen.getByLabelText("Search")).toBeDisabled();
        expect(screen.getByLabelText("Download")).toBeDisabled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(screen.getByText("Loading PDF")).toBeInTheDocument();
        expect(screen.getByTestId("pdf-loading-status")).toHaveStyle({ position: "absolute", top: "calc(50% + 20px)" });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
        expect(screen.getByText("Rendering page 1")).toBeInTheDocument();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(screen.getByText("This PDF is taking longer than usual.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByText("PDF loading was canceled. You can still download the original file.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Try compatibility mode" })).not.toBeInTheDocument();
        expect(screen.getByLabelText("Zoom in")).toBeDisabled();
        expect(screen.getByLabelText("Download")).toBeEnabled();

        await act(async () => {
          fireEvent.click(screen.getByLabelText("Download"));
          await Promise.resolve();
        });
        expect(apiService.getOriginalFileBlob).toHaveBeenCalledWith("test-conn-id", "/test/document.pdf", { download: true });
        expect(downloadClick).toHaveBeenCalledOnce();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(6000);
        });
        expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();
      } finally {
        downloadClick.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("automatically retries Invalid PDF structure with the normalized variant", async () => {
      mockDocumentLoadErrors = [new Error("InvalidPDFException: Invalid PDF structure")];

      renderPDFViewer();

      await waitFor(() => {
        expect(apiService.getPdfBlob).toHaveBeenCalledTimes(2);
      });

      expect(apiService.getPdfBlob).toHaveBeenLastCalledWith(
        "test-conn-id",
        "/test/document.pdf",
        expect.objectContaining({ pdfVariant: "normalized" })
      );
    });

    it("offers manual compatibility mode for a non-structural document error", async () => {
      mockDocumentLoadErrors = [new Error("Unsupported PDF feature")];

      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Try compatibility mode" })).toBeInTheDocument();
      });

      expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();
      mockPageRenderDelayMs = 1000;
      await userEvent.click(screen.getByRole("button", { name: "Try compatibility mode" }));

      await waitFor(() => {
        expect(apiService.getPdfBlob).toHaveBeenLastCalledWith(
          "test-conn-id",
          "/test/document.pdf",
          expect.objectContaining({ pdfVariant: "normalized" })
        );
      });
      expect(screen.getByTestId("pdf-document-presentation")).toHaveStyle({ opacity: "0", visibility: "hidden" });
      expect(screen.getByTestId("pdf-loading-overlay")).toHaveAttribute("aria-hidden", "false");
    });

    it("keeps the PDF password decision accessible", async () => {
      mockPasswordRequest = true;
      const user = userEvent.setup();
      renderPDFViewer();
      const password = await screen.findByLabelText("PDF password");
      expect(screen.getByRole("dialog", { name: "Unlock PDF" })).toBeVisible();
      await user.type(password, "secret");
      await user.click(screen.getByRole("button", { name: "Open PDF" }));
      expect(submittedPdfPassword).toBe("secret");
      expect(apiService.getPdfBlob).toHaveBeenCalledTimes(1);
    });

    it("submits an encrypted PDF password without requesting compatibility mode", async () => {
      mockPasswordRequest = true;
      const user = userEvent.setup();

      renderPDFViewer();

      await user.type(await screen.findByLabelText("PDF password"), "secret");
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("pdf-loading-overlay")).not.toBeInTheDocument();
      expect(screen.getByTestId("pdf-document-presentation")).toHaveAttribute("inert");
      await user.click(screen.getByRole("button", { name: "Open PDF" }));

      expect(submittedPdfPassword).toBe("secret");
      expect(apiService.getPdfBlob).toHaveBeenCalledTimes(1);
    });
  });

  describe("API Integration", () => {
    it("calls getPdfBlob with correct connectionId and path", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(apiService.getPdfBlob).toHaveBeenCalledWith(
          "test-conn-id",
          "/test/document.pdf",
          expect.objectContaining({ signal: expect.anything() })
        );
      });
    });

    it("creates blob URL from received blob", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });
    });

    it("passes blob URL to react-pdf Document component", async () => {
      renderPDFViewer();

      await waitFor(() => {
        const doc = screen.getByTestId("pdf-document");
        expect(doc).toHaveAttribute("data-file", "blob:mock-url-1");
      });
    });

    it("handles API errors gracefully", async () => {
      const error = {
        response: { data: { detail: "Access denied" }, status: 403 },
        message: "Request failed",
      };
      (apiService.getPdfBlob as Mock).mockRejectedValue(error);

      renderPDFViewer();

      await waitFor(
        () => {
          expect(screen.getByText("Access to this file was denied. Check your permissions and retry.")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it("retries a failed PDF load when requested", async () => {
      const error = {
        response: { data: { detail: "PDF request timed out" }, status: 504 },
        message: "Request failed",
      };
      (apiService.getPdfBlob as Mock).mockRejectedValueOnce(error).mockResolvedValueOnce(new Blob(["mock pdf content"]));

      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByText("The file request timed out. Check the connection and retry.")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
      });

      expect(apiService.getPdfBlob).toHaveBeenCalledTimes(2);
    });

    it.each(["original", "normalized"] as const)("reuses the loaded %s PDF bytes for mobile share", async (variant) => {
      mockMatchMedia(true);
      const share = vi.fn().mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
      const canShare = vi.fn().mockReturnValue(true);
      const originalContent = "complete original PDF";
      const normalizedContent = "complete normalized PDF with compatible structure";
      (apiService.getPdfBlob as Mock).mockImplementation((_connectionId, _path, options) =>
        Promise.resolve(new Blob([options?.pdfVariant === "normalized" ? normalizedContent : originalContent], { type: "application/pdf" }))
      );
      if (variant === "normalized") mockDocumentLoadErrors = [new Error("InvalidPDFException: Invalid PDF structure")];

      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          ...globalThis.navigator,
          share,
          canShare,
        },
      });

      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      await act(async () => fireEvent.click(screen.getByLabelText("Share")));

      await waitFor(() => {
        expect(share).toHaveBeenCalledWith({
          files: [expect.any(File)],
          title: "document.pdf",
        });
      });

      const attachment = share.mock.calls[0]?.[0]?.files[0];
      expect(await readBlobAsText(attachment)).toBe(variant === "normalized" ? normalizedContent : originalContent);
      expect(apiService.getPdfBlob).toHaveBeenCalledTimes(variant === "normalized" ? 2 : 1);
      await userEvent.click(await screen.findByRole("button", { name: "Details" }));
      await screen.findByText(/"reason": "NotAllowedError"/);
      await userEvent.keyboard("{Escape}");
      const details = await screen.findByRole("button", { name: "Details" });
      await waitFor(() => expect(details).toHaveFocus());
      expect(mockOnClose).not.toHaveBeenCalled();
      mockCreateObjectURL.mockClear();
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      try {
        await userEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(mockCreateObjectURL).toHaveBeenCalledExactlyOnceWith(attachment);
        expect(click).toHaveBeenCalledTimes(1);
        expect(apiService.getOriginalFileBlob).not.toHaveBeenCalled();
        expect(share).toHaveBeenCalledTimes(1);
      } finally {
        click.mockRestore();
      }
    });

    it("invalidates a loaded PDF immediately and ignores a late replaced document", async () => {
      mockMatchMedia(true);
      const share = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "share", { configurable: true, value: share });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      let resolveStale: (blob: Blob) => void = () => {};
      (apiService.getPdfBlob as Mock)
        .mockResolvedValueOnce(new Blob(["first document"], { type: "application/pdf" }))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveStale = resolve;
            })
        )
        .mockResolvedValueOnce(new Blob(["active replacement document"], { type: "application/pdf" }));
      const { rerender } = renderPDFViewer();
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
      const firstAttachment = share.mock.calls[0]?.[0]?.files[0];
      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/stale.pdf" />
        </SambeeThemeProvider>
      );
      expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(share).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(apiService.getPdfBlob).toHaveBeenCalledTimes(2));
      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/active.pdf" />
        </SambeeThemeProvider>
      );
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
      await act(async () => resolveStale(new Blob(["late stale document"], { type: "application/pdf" })));
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(await readBlobAsText(share.mock.calls[1]?.[0]?.files[0])).toBe("active replacement document");
      expect(await readBlobAsText(firstAttachment)).toBe("first document");
      expect(apiService.getPdfBlob).toHaveBeenCalledTimes(3);
      await waitFor(() => expect(screen.getByRole("button", { name: "Share" })).toBeEnabled());
    });

    it("never shares the failed original while PDF normalization is pending or failed", async () => {
      mockMatchMedia(true);
      const share = vi.fn();
      Object.defineProperty(navigator, "share", { configurable: true, value: share });
      let rejectNormalization: (error: Error) => void = () => {};
      (apiService.getPdfBlob as Mock)
        .mockResolvedValueOnce(new Blob(["incompatible original"], { type: "application/pdf" }))
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectNormalization = reject;
            })
        );
      mockDocumentLoadErrors = [new Error("InvalidPDFException: Invalid PDF structure")];
      renderPDFViewer();
      await waitFor(() => expect(apiService.getPdfBlob).toHaveBeenCalledTimes(2));
      const button = screen.getByRole("button", { name: "Share" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      await act(async () => rejectNormalization(Object.assign(new Error("normalization failed"), { response: { status: 403 } })));
      expect(await screen.findByText(/PDF compatibility processing could not make this file viewable/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      expect(share).not.toHaveBeenCalled();
      expect(apiService.getOriginalFileBlob).not.toHaveBeenCalled();
    });
  });

  describe("Blob URL Lifecycle Management", () => {
    it("creates blob URL after successful fetch", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      });
    });

    it("revokes the blob URL after the viewer unmounts", async () => {
      const { unmount } = renderPDFViewer();

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });

      unmount();

      await waitFor(() => {
        expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
      });
    });

    it("revokes the blob URL when the viewer is closed", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByLabelText("Close"));

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("revokes old blob URL when path changes", async () => {
      const { rerender } = renderPDFViewer();

      await waitFor(() => {
        expect(mockCreateObjectURL).toHaveBeenCalled();
      });

      mockCreateObjectURL.mockReturnValue("blob:new-mock-url");

      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/new-document.pdf" />
        </SambeeThemeProvider>
      );

      await waitFor(() => {
        expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
      });
    });

    it("handles AbortController cancellation on unmount", async () => {
      const abortSpy = vi.fn();

      class TestAbortController {
        signal = { aborted: false } as AbortSignal;
        abort = abortSpy;
      }

      globalThis.AbortController = TestAbortController as unknown as typeof AbortController;

      const { unmount } = renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      unmount();

      await waitFor(() => {
        expect(abortSpy).toHaveBeenCalled();
      });
    });
  });

  describe("Document Loading", () => {
    it("uses callback-driven loading instead of React-PDF Suspense", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-document")).toHaveAttribute("data-suspense", "false");
      });
    });

    it("updates numPages state on load success", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByText("/ 5")).toBeInTheDocument();
      });
    });

    it("resets to page 1 on new document", async () => {
      const { rerender } = renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await waitForPageNavigationReady();
      // Navigate to page 3
      const nextButton = screen.getByLabelText("Next page");
      fireEvent.click(nextButton);
      fireEvent.click(nextButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });

      // Load new document
      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/another.pdf" />
        </SambeeThemeProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("handles onLoadError callback", async () => {
      mockDocumentLoadErrors = [new Error("Failed to load PDF")];

      renderPDFViewer();

      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith("PDF load error", expect.objectContaining({ error: expect.any(String) }));
      });
    });
  });

  describe("Page Navigation", () => {
    it("navigates to an internal PDF link target", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      fireEvent.click(screen.getByTestId("pdf-internal-link"));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });
    });

    it("increments page on next button", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await waitForPageNavigationReady();
      const nextButton = screen.getByLabelText("Next page");
      fireEvent.click(nextButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });
    });

    it("decrements page on previous button", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      // Go to page 2 first
      const nextButton = screen.getByLabelText("Next page");
      fireEvent.click(nextButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });

      // Go back to page 1
      const prevButton = screen.getByLabelText("Previous page");
      fireEvent.click(prevButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("navigates between pages with horizontal mobile swipes", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      const content = screen.getByTestId("pdf-viewer-content");
      dragCarousel(content, 300, 200, 50, 200);

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "2");
      });

      dragCarousel(content, 50, 200, 300, 200);

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });
    });

    it("moves the page track during a mobile drag and prevents text selection", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-swipe-track")).toBeInTheDocument();
      });

      const content = screen.getByTestId("pdf-viewer-content");
      const track = screen.getByTestId("pdf-swipe-track");
      expect(content).toHaveStyle({ touchAction: "pan-y", userSelect: "none" });
      const initialTransform = track.style.transform;

      fireEvent.pointerDown(content, {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: 300,
        clientY: 200,
        buttons: 1,
      });
      fireEvent.pointerMove(window, {
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: 200,
        clientY: 200,
        buttons: 1,
      });

      await waitFor(() => {
        expect(track.style.transform).not.toBe(initialTransform);
        expect(track.style.transform).toMatch(/\+ -[1-9]\d*px/);
      });

      fireEvent.pointerUp(window, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 200, clientY: 200 });
    });

    it("does not let an in-flight swipe override direct page navigation", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      dragCarousel(screen.getByTestId("pdf-viewer-content"), 300, 200, 50, 200);

      const pageInput = screen.getByRole("textbox");
      fireEvent.change(pageInput, { target: { value: "4" } });
      fireEvent.blur(pageInput);

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "4");
      });

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, SWIPE_SETTLE_WAIT_MS));
      });
      expect(getActivePdfPage()).toHaveAttribute("data-page", "4");
    });

    it("cancels an in-flight swipe when loading a new document", async () => {
      mockMatchMedia(true);
      const { rerender } = renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      dragCarousel(screen.getByTestId("pdf-viewer-content"), 300, 200, 50, 200);

      rerender(
        <SambeeThemeProvider>
          <PDFViewer {...defaultProps} path="/test/replacement.pdf" />
        </SambeeThemeProvider>
      );

      await waitFor(() => {
        expect(apiService.getPdfBlob).toHaveBeenCalledWith(
          "test-conn-id",
          "/test/replacement.pdf",
          expect.objectContaining({ signal: expect.anything() })
        );
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, SWIPE_SETTLE_WAIT_MS));
      });
      expect(getActivePdfPage()).toHaveAttribute("data-page", "1");

      dragCarousel(screen.getByTestId("pdf-viewer-content"), 300, 200, 50, 200);

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "2");
      });
    });

    it("ignores short and vertical drag gestures", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      const content = screen.getByTestId("pdf-viewer-content");
      dragCarousel(content, 300, 200, 260, 200);
      dragCarousel(content, 300, 200, 250, 320);

      expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
    });

    it("does not navigate beyond page boundaries with mobile swipes", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      const content = screen.getByTestId("pdf-viewer-content");
      dragCarousel(content, 200, 200, 500, 200);

      expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
    });

    it("does not navigate pages with swipes after zooming", async () => {
      mockMatchMedia(true);
      renderPDFViewer();

      await waitFor(() => {
        expect(getActivePdfPage()).toHaveAttribute("data-page", "1");
      });

      const initialScale = getActivePdfPage().getAttribute("data-scale");
      fireEvent.keyDown(document, { key: "+" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).not.toHaveAttribute("data-scale", initialScale);
      });

      const content = screen.getByTestId("pdf-viewer-content");
      expect(content).toHaveStyle({ touchAction: "auto", userSelect: "auto" });
      fireEvent.pointerDown(content, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 300, clientY: 200 });
      fireEvent.pointerUp(content, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 200, clientY: 200 });

      expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
    });

    it("respects page boundaries (1 to numPages)", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      // Verify previous button is disabled on first page
      const prevButton = screen.getByLabelText("Previous page");
      expect(prevButton).toBeDisabled();

      // Try to go below page 1 - should stay at page 1
      fireEvent.click(prevButton);
      expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");

      // Navigate to page 2
      const nextButton = screen.getByLabelText("Next page");
      fireEvent.click(nextButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });

      // Navigate back to page 1
      fireEvent.click(screen.getByLabelText("Previous page"));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("handles direct page number input", async () => {
      const user = userEvent.setup();
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();

      const pageInput = screen.getByRole("textbox");
      await user.clear(pageInput);
      await user.type(pageInput, "3");
      fireEvent.blur(pageInput);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });
    });

    it("navigates when Enter is pressed in the page number input", async () => {
      const user = userEvent.setup();
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await waitForPageNavigationReady();

      const pageInput = screen.getByRole("textbox");
      await user.clear(pageInput);
      await user.type(pageInput, "4");
      expect(pageInput).toHaveValue("4");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "4");
      });
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("highlights split text-layer matches on the current page", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const searchInput = await viewerSearch.openSearch("dimm");

      await waitFor(() => {
        expect(screen.getByText("1 / 2")).toBeInTheDocument();
        expect(searchInput).toHaveValue("dimm");
        expect(getSearchHighlights()).toHaveLength(4);
      });

      expect(
        document.querySelectorAll(`${DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR}[${DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE}="true"]`)
      ).toHaveLength(2);
    });

    it("navigates to the next split-item match on the current page", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      const searchInput = await viewerSearch.openSearch("dimm");

      await waitFor(() => {
        expect(findPageCounterText("1 / 2")).toBeInTheDocument();
      });

      fireEvent.keyDown(searchInput, { key: "F3" });

      await waitFor(() => {
        expect(findPageCounterText("2 / 2")).toBeInTheDocument();
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("runs a search entered before PDF text extraction completes", async () => {
      mockTextExtractionDelayMs = 100;
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await viewerSearch.openSearch("dimm");

      await waitFor(
        () => {
          expect(findPageCounterText("1 / 2")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it("rebuilds highlights when navigating to later pages with split text-layer spans", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const searchInput = await viewerSearch.openSearch("page");

      await waitFor(() => {
        expect(findPageCounterText("1 / 5")).toBeInTheDocument();
        expect(searchInput).toHaveValue("page");
      });

      fireEvent.keyDown(searchInput, { key: "F3" });
      fireEvent.keyDown(searchInput, { key: "F3" });

      await waitFor(() => {
        expect(findPageCounterText("3 / 5")).toBeInTheDocument();
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
        expect(getSearchHighlights()).toHaveLength(2);
      });
    });

    it("navigates to next page on ArrowRight", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      const viewerContent = screen.getByTestId("pdf-viewer-content");
      viewerContent.focus();
      expect(viewerContent).toHaveFocus();

      fireEvent.keyDown(viewerContent, { key: "ArrowRight" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });
    });

    it("navigates to previous page on ArrowLeft", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      const viewerContent = screen.getByTestId("pdf-viewer-content");
      viewerContent.focus();
      expect(viewerContent).toHaveFocus();

      // Go to page 2 first
      fireEvent.keyDown(viewerContent, { key: "ArrowRight" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });

      fireEvent.keyDown(viewerContent, { key: "ArrowLeft" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("goes to first page on Home", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      const viewerContent = screen.getByTestId("pdf-viewer-content");
      viewerContent.focus();
      expect(viewerContent).toHaveFocus();

      fireEvent.keyDown(viewerContent, { key: "ArrowRight" });
      fireEvent.keyDown(viewerContent, { key: "ArrowRight" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });

      fireEvent.keyDown(viewerContent, { key: "Home" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("goes to last page on End", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForPageNavigationReady();
      const viewerContent = screen.getByTestId("pdf-viewer-content");
      viewerContent.focus();
      expect(viewerContent).toHaveFocus();

      fireEvent.keyDown(viewerContent, { key: "End" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "5");
      });
    });

    it.each(["document", "viewer"])("closes viewer exactly once on Escape from %s", async (target) => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const eventTarget = target === "document" ? document : screen.getByTestId("pdf-viewer-content");
      fireEvent.keyDown(eventTarget, { key: "Escape" });

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("closes search instead of the viewer when Escape is pressed in the search input", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await viewerSearch.expectEscapeClosesSearch({
        searchTerm: "page",
        assertViewerStillOpen: () => {
          expect(mockOnClose).not.toHaveBeenCalled();
        },
      });
    });

    it("focuses the search input when Ctrl+F opens the search panel", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: "f", ctrlKey: true });

      const searchInput = await screen.findByPlaceholderText("Search");

      await waitFor(() => {
        expect(searchInput).toHaveFocus();
      });
    });

    it("supports PageDown and PageUp while the search input is focused", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const searchInput = await viewerSearch.openSearch();

      await waitFor(() => {
        expect(searchInput).toHaveFocus();
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      fireEvent.keyDown(searchInput, { key: "PageDown" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });

      fireEvent.keyDown(searchInput, { key: "PageUp" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("supports Home and End while the search input is focused", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const searchInput = await viewerSearch.openSearch("page");

      await waitFor(() => {
        expect(searchInput).toHaveFocus();
      });

      fireEvent.keyDown(searchInput, { key: "End" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "5");
      });

      fireEvent.keyDown(searchInput, { key: "Home" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });
    });

    it("keeps F3 search result navigation working while the search input is focused", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const searchInput = await viewerSearch.openSearch("page");

      await waitFor(() => {
        expect(searchInput).toHaveFocus();
        expect(findPageCounterText("1 / 5")).toBeInTheDocument();
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      fireEvent.keyDown(searchInput, { key: "F3" });

      await waitFor(() => {
        expect(findPageCounterText("2 / 5")).toBeInTheDocument();
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
      });
    });

    it("zooms in on Plus/Equals", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const initialScale = screen.getByTestId("pdf-page").getAttribute("data-scale");

      fireEvent.keyDown(document, { key: "+" });

      await waitFor(() => {
        const newScale = screen.getByTestId("pdf-page").getAttribute("data-scale");
        expect(newScale).not.toBe(initialScale);
      });
    });

    it("zooms out on Minus/Underscore", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Zoom in first
      fireEvent.keyDown(document, { key: "+" });

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      const scaleAfterZoomIn = screen.getByTestId("pdf-page").getAttribute("data-scale");

      // Zoom out
      fireEvent.keyDown(document, { key: "-" });

      await waitFor(() => {
        const newScale = screen.getByTestId("pdf-page").getAttribute("data-scale");
        expect(newScale).not.toBe(scaleAfterZoomIn);
      });
    });
  });

  describe("Zoom Functionality", () => {
    it("defaults to fit-page mode", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Component doesn't display mode text, just verify page renders with scale
      const page = screen.getByTestId("pdf-page");
      expect(page).toHaveAttribute("data-scale");
    });

    it("fits landscape pages using their own viewport and settles after navigation", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await waitForPageNavigationReady();
      fireEvent.click(screen.getByLabelText("Next page"));

      await waitFor(() => {
        const landscapeScale = Number(screen.getByTestId("pdf-page").getAttribute("data-scale"));
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "2");
        expect(landscapeScale).toBeCloseTo(800 / 1224, 4);
      });

      fireEvent.click(screen.getByLabelText("Next page"));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });

      const settledRenderCount = mockPageRenderCounts.get(3);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      expect(mockPageRenderCounts.get(3)).toBe(settledRenderCount);
    });

    it("does not poll when an active page has no text layer", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "1");
      });

      await viewerSearch.openSearch("dimm");
      await waitFor(() => {
        expect(getSearchHighlights()).toHaveLength(4);
      });

      mockMissingTextLayerPage = 3;
      fireEvent.click(screen.getByLabelText("Next page"));
      fireEvent.click(screen.getByLabelText("Next page"));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-page", "3");
      });

      const settledRenderCount = mockPageRenderCounts.get(3);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      expect(mockPageRenderCounts.get(3)).toBe(settledRenderCount);
    });

    it("handles fit-width mode", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Component doesn't have fit-width button, zoom is handled through zoom in/out
      const zoomInButton = screen.getByLabelText("Zoom in");
      expect(zoomInButton).toBeInTheDocument();
    });

    it("handles numeric zoom values", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForZoomControlsReady();
      const zoomInButton = screen.getByLabelText("Zoom in");
      const initialScale = screen.getByTestId("pdf-page").getAttribute("data-scale");
      fireEvent.click(zoomInButton);

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).not.toHaveAttribute("data-scale", initialScale);
      });
    });

    it("updates scale when zoom buttons clicked", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitForZoomControlsReady();
      const zoomInButton = screen.getByLabelText("Zoom in");
      const initialScale = screen.getByTestId("pdf-page").getAttribute("data-scale");

      fireEvent.click(zoomInButton);

      await waitFor(() => {
        const newScale = screen.getByTestId("pdf-page").getAttribute("data-scale");
        expect(newScale).not.toBe(initialScale);
      });
    });
  });

  describe("Error Handling", () => {
    it("displays error message from API", async () => {
      const error = {
        response: { data: { detail: "Custom error message" } },
      };
      (apiService.getPdfBlob as Mock).mockRejectedValue(error);

      renderPDFViewer();

      await waitFor(
        () => {
          expect(screen.getByText("The file could not be opened. Check the connection and retry.")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it("does not expose raw API detail or infer absence from an unclassified 404", async () => {
      const error = {
        response: { data: { detail: "File not found" }, status: 404 },
        message: "Request failed with status code 404",
      };
      (apiService.getPdfBlob as Mock).mockRejectedValue(error);

      renderPDFViewer();

      await waitFor(
        () => {
          expect(screen.getByText("The file could not be opened. Check the connection and retry.")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );
    });

    it("shows generic error for unknown errors", async () => {
      (apiService.getPdfBlob as Mock).mockRejectedValue(new Error("Unknown error"));

      renderPDFViewer();

      // Plain Error objects without response are treated as transient/network errors
      await waitFor(
        () => {
          expect(screen.getByText(/Server is busy/i)).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });

    it("logs errors appropriately", async () => {
      const error = new Error("Test error");
      (apiService.getPdfBlob as Mock).mockRejectedValue(error);

      renderPDFViewer();

      await waitFor(
        () => {
          expect(logger.error).toHaveBeenCalledWith(
            "Failed to fetch PDF",
            expect.objectContaining({
              path: "/test/document.pdf",
              error: expect.objectContaining({ cause: error }),
            })
          );
        },
        { timeout: 3000 }
      );
    });
  });

  describe("Auto-focus Behavior", () => {
    it("focuses container after successful load", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(document.activeElement).not.toBe(document.body);
      });
    });

    it("does not focus on error state", async () => {
      (apiService.getPdfBlob as Mock).mockRejectedValue(new Error("Load failed"));

      renderPDFViewer();

      // Plain Error objects without response are treated as transient/network errors
      await waitFor(
        () => {
          expect(screen.getByText(/Server is busy/i)).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      const container = screen.getByText(/Server is busy/i).parentElement;
      expect(document.activeElement).not.toBe(container);
    });
  });

  describe("Rotation", () => {
    it("preserves a page's intrinsic rotation", async () => {
      mockIntrinsicPageRotations.set(1, 90);
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-rotate", "90");
      });
    });

    it("applies manual rotation on top of a page's intrinsic rotation", async () => {
      mockIntrinsicPageRotations.set(1, 90);
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-rotate", "90");
      });

      await waitForPageNavigationReady();
      fireEvent.click(screen.getByLabelText(/rotate right/i));

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-rotate", "180");
      });
    });

    it("uses each page's intrinsic rotation when navigating between pages", async () => {
      mockIntrinsicPageRotations.set(1, 90);
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-rotate", "90");
      });

      await waitForPageNavigationReady();
      fireEvent.click(screen.getByLabelText("Next page"));

      await waitFor(() => {
        const page = screen.getByTestId("pdf-page");
        expect(page).toHaveAttribute("data-page", "2");
        expect(page).toHaveAttribute("data-rotate", "0");
      });
    });

    it("fits a page using its effective rotation", async () => {
      mockIntrinsicPageRotations.set(1, 90);
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toHaveAttribute("data-scale", (600 / 612).toString());
      });
    });

    it("rotates page right using keyboard shortcut (R)", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Press R key to rotate right
      fireEvent.keyDown(document, { key: "r" });

      // Rotation is applied to the Page component
      // Since we're mocking Page, we can't directly verify the rotate prop
      // But we can verify the handler doesn't crash
      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });
    });

    it("rotates page left using keyboard shortcut (Shift+R)", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Press Shift+R to rotate left
      fireEvent.keyDown(document, { key: "R", shiftKey: true });

      // Verify handler doesn't crash
      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });
    });

    it("rotates using rotation buttons", async () => {
      renderPDFViewer();

      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });

      // Find and click rotate right button
      const rotateRightButton = screen.getByLabelText(/rotate right/i);
      fireEvent.click(rotateRightButton);

      // Find and click rotate left button
      const rotateLeftButton = screen.getByLabelText(/rotate left/i);
      fireEvent.click(rotateLeftButton);

      // Verify buttons work without crashing
      await waitFor(() => {
        expect(screen.getByTestId("pdf-page")).toBeInTheDocument();
      });
    });
  });
});
