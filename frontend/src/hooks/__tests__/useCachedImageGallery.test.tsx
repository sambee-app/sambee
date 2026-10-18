import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import apiService from "../../services/api";
import { logger } from "../../services/logger";
import { PreviewUnavailableError } from "../../services/previewPolicy";
import { IMAGE_LOAD_CANCELED_MESSAGE, IMAGE_LOAD_FAILED_MESSAGE, useCachedImageGallery } from "../useCachedImageGallery";

vi.mock("../../services/api", () => ({
  default: {
    getImageBlob: vi.fn(),
  },
}));

interface DeferredRequest {
  resolve: (blob: Blob) => void;
}

function registerAbortableDeferredRequest(deferredByPath: Map<string, DeferredRequest>, path: string, options?: { signal?: AbortSignal }) {
  return new Promise<Blob>((resolve, reject) => {
    options?.signal?.addEventListener(
      "abort",
      () => {
        reject({
          code: "ERR_CANCELED",
          message: "canceled",
          config: { signal: options.signal },
        });
      },
      { once: true }
    );

    deferredByPath.set(path, {
      resolve: (blob) => resolve(blob),
    });
  });
}

const loadMockImageBlob = (path: string, options: { signal: AbortSignal; viewportWidth: number; viewportHeight: number }) =>
  apiService.getImageBlob("conn-1", path, options);

describe("useCachedImageGallery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:gallery-image"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("notifies local index changes without echoing callback replacement or routed index updates", async () => {
    vi.mocked(apiService.getImageBlob).mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
    const onIndexChange = vi.fn();
    const replacement = vi.fn();
    const images = ["/0.jpg", "/1.jpg", "/2.jpg"];
    const { result, rerender } = renderHook(
      ({ initialIndex, callback }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          images,
          initialIndex,
          onIndexChange: callback,
          loadImageBlob: loadMockImageBlob,
          preloadRange: 0,
        }),
      { initialProps: { initialIndex: 0, callback: onIndexChange } }
    );
    await waitFor(() => expect(result.current.currentImageLoadPhase).toBe("decoding"));
    expect(onIndexChange).not.toHaveBeenCalled();

    rerender({ initialIndex: 0, callback: replacement });
    expect(replacement).not.toHaveBeenCalled();
    act(() => result.current.setCurrentIndex(1));
    expect(replacement).toHaveBeenCalledExactlyOnceWith(1);

    rerender({ initialIndex: 1, callback: onIndexChange });
    rerender({ initialIndex: 2, callback: replacement });
    expect(result.current.currentIndex).toBe(2);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onIndexChange).not.toHaveBeenCalled();

    act(() => result.current.setCurrentIndex(0));
    expect(replacement).toHaveBeenLastCalledWith(0);
    expect(replacement).toHaveBeenCalledTimes(2);
  });

  it("reapplies an unchanged routed index after an optimistic move without dropping cached images", async () => {
    vi.mocked(apiService.getImageBlob).mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));
    const onIndexChange = vi.fn();
    const images = ["/0.jpg", "/1.jpg"];
    const { result, rerender } = renderHook(
      ({ selectionKey }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          images,
          initialIndex: 0,
          selectionKey,
          onIndexChange,
          loadImageBlob: loadMockImageBlob,
          preloadRange: 0,
        }),
      { initialProps: { selectionKey: "opening" } }
    );
    await waitFor(() => expect(result.current.getCachedImageSrc(0)).toBeDefined());
    act(() => result.current.setCurrentIndex(1));
    await waitFor(() => expect(result.current.getCachedImageSrc(1)).toBeDefined());
    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith(1);
    const originalImage = result.current.getCachedImageSrc(0);
    const fetches = vi.mocked(apiService.getImageBlob).mock.calls.length;

    rerender({ selectionKey: "back" });

    expect(result.current.currentIndex).toBe(0);
    expect(result.current.getCachedImageSrc(0)).toBe(originalImage);
    expect(apiService.getImageBlob).toHaveBeenCalledTimes(fetches);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(onIndexChange).toHaveBeenCalledTimes(1);
  });

  it("waits for native image decoding before marking the current image ready", async () => {
    vi.mocked(apiService.getImageBlob).mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/0.jpg"],
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(result.current.currentImageLoadPhase).toBe("decoding");
    });

    act(() => {
      result.current.markImageAsDecoded(0, "blob:gallery-image");
    });

    expect(result.current.currentImageLoadPhase).toBe("ready");
    expect(result.current.loadingStates.get(0)).toBe(false);
  });

  it("shows the safe image size-limit failure while retaining the generic decode failure", async () => {
    vi.mocked(apiService.getImageBlob).mockRejectedValue({
      response: {
        status: 413,
        data: {
          detail: {
            code: "image_preview_too_large",
            message: "This image is too large to preview (351 MB; maximum 100 MB).",
          },
        },
      },
    });

    const { result: fetchResult } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/invalid.psd"],
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(fetchResult.current.errorStates.get(0)).toBe("This image is too large to preview (351 MB; maximum 100 MB).");
    });

    vi.mocked(apiService.getImageBlob).mockResolvedValue(new Blob(["invalid PSD"], { type: "image/vnd.adobe.photoshop" }));
    const { result: decodeResult } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/invalid.psd"],
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(decodeResult.current.currentImageLoadPhase).toBe("decoding");
    });

    act(() => {
      decodeResult.current.markImageDecodeFailed(0, "blob:gallery-image");
    });

    expect(decodeResult.current.errorStates.get(0)).toBe(IMAGE_LOAD_FAILED_MESSAGE);
  });

  it("keeps unrecognized API errors generic", async () => {
    vi.mocked(apiService.getImageBlob).mockRejectedValue({
      response: { status: 500, data: { detail: "Failed to read file: smb://internal-server/private-share" } },
    });

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/private.psd"],
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(result.current.errorStates.get(0)).toBe(IMAGE_LOAD_FAILED_MESSAGE);
    });
  });

  it("uses an explicit image loader for non-filesystem image sources", async () => {
    const loadImageBlob = vi.fn().mockResolvedValue(new Blob(["archive image"], { type: "image/png" }));

    renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        images: ["photos/inside.png"],
        gallerySourceKey: "archive:backup.zip",
        loadImageBlob,
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(loadImageBlob).toHaveBeenCalledWith(
        "photos/inside.png",
        expect.objectContaining({ signal: expect.any(AbortSignal), viewportWidth: expect.any(Number), viewportHeight: expect.any(Number) })
      );
    });
    expect(apiService.getImageBlob).not.toHaveBeenCalled();
  });

  it("cancels the active image without treating cancellation as a fetch error", async () => {
    const capturedSignals: AbortSignal[] = [];
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, _path: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
      }

      return new Promise<Blob>(() => {
        // The request remains pending until the viewer cancels it.
      });
    });

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/0.jpg"],
        preloadRange: 0,
      })
    );

    await waitFor(() => {
      expect(capturedSignals).toHaveLength(1);
    });

    act(() => {
      result.current.cancelCurrentImageLoad();
    });

    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(result.current.currentImageLoadPhase).toBe("canceled");
    expect(result.current.errorStates.get(0)).toBe(IMAGE_LOAD_CANCELED_MESSAGE);
  });

  it("aborts stale in-flight preload requests when the desired preload window moves", async () => {
    const capturedSignals: AbortSignal[] = [];

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, _path: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        capturedSignals.push(options.signal);
      }

      return new Promise<Blob>(() => {
        // Intentionally unresolved to simulate a long-running preload.
      });
    });

    const { rerender } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg"],
          initialIndex,
          preloadRange: 1,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(capturedSignals.length).toBeGreaterThan(0);
    });

    const firstSignal = capturedSignals[0];
    expect(firstSignal?.aborted).toBe(false);

    rerender({ initialIndex: 3 });

    await waitFor(() => {
      expect(firstSignal?.aborted).toBe(true);
    });
  });

  it("does not surface a stale preload abort as a failed image fetch when the transport reports a generic network error", async () => {
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, _path: string, options?: { signal?: AbortSignal }) => {
      return new Promise<Blob>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject({
              code: "ERR_NETWORK",
              message: "Network Error",
              config: { signal: options.signal },
            });
          },
          { once: true }
        );
      });
    });

    const { result, rerender } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg"],
          initialIndex,
          preloadRange: 1,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    rerender({ initialIndex: 3 });

    await waitFor(() => {
      expect(result.current.abortControllersRef.current.size).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(result.current.errorStates.get(0) ?? null).toBeNull();
    });
  });

  it("keeps the previous current-image request alive when it remains inside the one-step overlap window", async () => {
    const capturedSignals = new Map<string, AbortSignal>();

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string, options?: { signal?: AbortSignal }) => {
      if (options?.signal) {
        capturedSignals.set(path, options.signal);
      }

      return new Promise<Blob>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject({
              code: "ERR_CANCELED",
              message: "canceled",
              config: { signal: options.signal },
            });
          },
          { once: true }
        );
      });
    });

    const { rerender } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg"],
          initialIndex,
          preloadRange: 1,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(capturedSignals.has("/0.jpg")).toBe(true);
    });

    const firstSignal = capturedSignals.get("/0.jpg");
    expect(firstSignal?.aborted).toBe(false);

    rerender({ initialIndex: 1 });

    await waitFor(() => {
      expect(capturedSignals.has("/1.jpg")).toBe(true);
    });

    expect(firstSignal?.aborted).toBe(false);
  });

  it("retries an in-flight preload once after it is promoted to the current image", async () => {
    const requestedPaths: string[] = [];
    let rejectFirstPreloadAttempt: ((error: unknown) => void) | null = null;
    let preloadAttempts = 0;

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string, options?: { signal?: AbortSignal }) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      if (path === "/1.jpg") {
        preloadAttempts += 1;

        if (preloadAttempts === 1) {
          return new Promise<Blob>((_resolve, reject) => {
            rejectFirstPreloadAttempt = reject;
          });
        }

        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      return new Promise<Blob>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            reject({
              code: "ERR_CANCELED",
              message: "canceled",
              config: { signal: options.signal },
            });
          },
          { once: true }
        );

        // Keep later preload slots idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg"],
          initialIndex,
          preloadRange: 1,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths).toEqual(["/0.jpg", "/1.jpg"]);
    });

    rerender({ initialIndex: 1 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    await act(async () => {});

    rejectFirstPreloadAttempt?.({
      code: "ERR_NETWORK",
      message: "Network Error",
    });

    await waitFor(
      () => {
        expect(requestedPaths.filter((path) => path === "/1.jpg")).toHaveLength(2);
      },
      { timeout: 2500 }
    );
  });

  it("does not start another queued preload while the current image and preserved overlap already occupy the total request budget", async () => {
    const requestedPaths: string[] = [];
    const budgetDeferredByPath = new Map<string, DeferredRequest>();

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string, options?: { signal?: AbortSignal }) => {
      requestedPaths.push(path);

      if (path === "/3.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      const request = registerAbortableDeferredRequest(budgetDeferredByPath, path, options);
      expect(budgetDeferredByPath.has(path)).toBe(true);
      return request;
    });

    const { rerender } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg", "/5.jpg", "/6.jpg"],
          initialIndex,
          preloadRange: 2,
        }),
      {
        initialProps: { initialIndex: 3 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths[0]).toBe("/3.jpg");
      expect(requestedPaths[1]).toBe("/2.jpg");
    });

    rerender({ initialIndex: 4 });

    await waitFor(() => {
      expect(requestedPaths).toContain("/4.jpg");
    });

    budgetDeferredByPath.get("/2.jpg")?.resolve(new Blob(["/2.jpg"], { type: "image/jpeg" }));

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/5.jpg")).toHaveLength(1);
    });
  });

  it("does not retry a request after it is demoted from current to overlap", async () => {
    const requestedPaths: string[] = [];
    let rejectCurrentAttempt: ((error: unknown) => void) | null = null;
    let firstPathAttempts = 0;

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string, _options?: { signal?: AbortSignal }) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        firstPathAttempts += 1;

        if (firstPathAttempts === 1) {
          return new Promise<Blob>((_resolve, reject) => {
            rejectCurrentAttempt = reject;
          });
        }

        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      if (path === "/1.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      return new Promise<Blob>(() => {
        // Keep later preload slots idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg"],
          initialIndex,
          preloadRange: 1,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths[0]).toBe("/0.jpg");
    });

    rerender({ initialIndex: 1 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    await act(async () => {});

    rejectCurrentAttempt?.({
      code: "ERR_NETWORK",
      message: "Network Error",
    });

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(1);
    });
  });

  it("preserves the overlap and appends only the newly exposed edge image during one-step navigation", async () => {
    const requestedPaths: string[] = [];
    const overlapDeferredByPath = new Map<string, DeferredRequest>();

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string, options?: { signal?: AbortSignal }) => {
      requestedPaths.push(path);

      if (path === "/3.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      const request = registerAbortableDeferredRequest(overlapDeferredByPath, path, options);
      expect(overlapDeferredByPath.has(path)).toBe(true);
      return request;
    });

    const { rerender, result } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg", "/5.jpg", "/6.jpg"],
          initialIndex,
          preloadRange: 2,
        }),
      {
        initialProps: { initialIndex: 3 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths[0]).toBe("/3.jpg");
      expect(requestedPaths[1]).toBe("/2.jpg");
    });

    rerender({ initialIndex: 4 });

    await waitFor(() => {
      expect(requestedPaths).toContain("/4.jpg");
    });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(4);
    });

    overlapDeferredByPath.get("/2.jpg")?.resolve(new Blob(["/2.jpg"], { type: "image/jpeg" }));
    overlapDeferredByPath.get("/4.jpg")?.resolve(new Blob(["/4.jpg"], { type: "image/jpeg" }));

    await waitFor(() => {
      expect(requestedPaths).toContain("/5.jpg");
    });
  });

  it("does not retry or error-log a transiently failing background preload while it stays in the preload window", async () => {
    const requestedPaths: string[] = [];
    const errorSpy = vi.spyOn(logger, "error");

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/3.jpg" || path === "/4.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      if (path === "/2.jpg") {
        return Promise.reject({
          code: "ERR_NETWORK",
          message: "Network Error",
        });
      }

      return new Promise<Blob>(() => {
        // Keep later preload slots idle for this assertion.
      });
    });

    const { rerender } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg", "/4.jpg", "/5.jpg", "/6.jpg"],
          initialIndex,
          preloadRange: 2,
        }),
      {
        initialProps: { initialIndex: 3 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths[0]).toBe("/3.jpg");
      expect(requestedPaths[1]).toBe("/2.jpg");
    });

    rerender({ initialIndex: 4 });

    await waitFor(() => {
      expect(requestedPaths).toContain("/4.jpg");
    });

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/2.jpg")).toHaveLength(1);
    });

    expect(errorSpy).not.toHaveBeenCalledWith(
      "Failed to fetch image for carousel",
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("does not relaunch a request that fails after being demoted from current to overlap", async () => {
    const requestedPaths: string[] = [];
    let rejectDemotedAttempt: ((error: unknown) => void) | null = null;

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        return new Promise<Blob>((_resolve, reject) => {
          rejectDemotedAttempt = reject;
        });
      }

      if (path === "/1.jpg" || path === "/2.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      return new Promise<Blob>(() => {
        // Keep later preload slots idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg", "/3.jpg"],
          initialIndex,
          preloadRange: 2,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(requestedPaths[0]).toBe("/0.jpg");
    });

    rerender({ initialIndex: 1 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    rejectDemotedAttempt?.({
      code: "ERR_NETWORK",
      message: "Network Error",
    });

    rerender({ initialIndex: 2 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(2);
    });

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(1);
    });
  });

  it("does not leak failed background preload suppression across gallery changes with reused paths", async () => {
    const requestedPaths: string[] = [];

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/a0.jpg" || path === "/b0.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      if (path === "/shared.jpg") {
        return Promise.reject({
          code: "ERR_NETWORK",
          message: "Network Error",
        });
      }

      return new Promise<Blob>(() => {
        // Keep later preload slots idle for this assertion.
      });
    });

    const { rerender } = renderHook(
      ({ connectionId, images }) =>
        useCachedImageGallery({
          connectionId,
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex: 0,
          preloadRange: 1,
        }),
      {
        initialProps: {
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/a0.jpg", "/shared.jpg", "/a2.jpg"],
        },
      }
    );

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/shared.jpg")).toHaveLength(1);
    });

    rerender({
      connectionId: "conn-1",
      loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
      images: ["/b0.jpg", "/shared.jpg", "/b2.jpg"],
    });

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/shared.jpg")).toHaveLength(2);
    });
  });

  it("does not expose the previous gallery cache at the same index on the first render after a gallery switch", async () => {
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, _path: string) => {
      return new Promise<Blob>(() => {
        // Keep requests idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ images, initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex,
          preloadRange: 0,
        }),
      {
        initialProps: {
          images: ["/a0.jpg", "/a1.jpg", "/a2.jpg"],
          initialIndex: 1,
        },
      }
    );

    act(() => {
      result.current.imageCacheRef.current.set(1, "blob:old-gallery");
    });

    rerender({
      images: ["/b0.jpg", "/b1.jpg", "/b2.jpg"],
      initialIndex: 1,
    });

    expect(result.current.currentIndex).toBe(1);
    expect(result.current.getCachedImageSrc(1)).toBeUndefined();
    expect(result.current.imageCacheRef.current.has(1)).toBe(false);
  });

  it("does not expose the previous gallery loading state at the same index on the first render after a gallery switch", async () => {
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, _path: string) => {
      return new Promise<Blob>(() => {
        // Keep the current image loading in the original gallery.
      });
    });

    const { rerender, result } = renderHook(
      ({ images, initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex,
          preloadRange: 0,
        }),
      {
        initialProps: {
          images: ["/a0.jpg", "/a1.jpg", "/a2.jpg"],
          initialIndex: 1,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.loadingStates.get(1)).toBe(true);
    });

    rerender({
      images: ["/b0.jpg", "/b1.jpg", "/b2.jpg"],
      initialIndex: 1,
    });

    expect(result.current.currentIndex).toBe(1);
    expect(result.current.loadingStates.get(1)).toBeUndefined();
  });

  it("does not expose the previous gallery error state at the same index on the first render after a gallery switch", async () => {
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      if (path === "/a1.jpg") {
        return Promise.reject({
          message: "Server exploded",
          response: {
            status: 500,
            data: { detail: "Server exploded" },
          },
        });
      }

      return new Promise<Blob>(() => {
        // Keep remaining requests idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ images, initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex,
          preloadRange: 0,
        }),
      {
        initialProps: {
          images: ["/a0.jpg", "/a1.jpg", "/a2.jpg"],
          initialIndex: 1,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.errorStates.get(1)).toBeDefined();
    });

    rerender({
      images: ["/b0.jpg", "/b1.jpg", "/b2.jpg"],
      initialIndex: 1,
    });

    expect(result.current.currentIndex).toBe(1);
    expect(result.current.errorStates.get(1)).toBeUndefined();
  });

  it("does not immediately relaunch a non-transient current-image failure before the retry gate opens", async () => {
    const requestedPaths: string[] = [];

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        return Promise.reject({
          message: "Server exploded",
          response: {
            status: 500,
            data: { detail: "Server exploded" },
          },
        });
      }

      return new Promise<Blob>(() => {
        // Keep the rest of the gallery idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
          images: ["/0.jpg", "/1.jpg", "/2.jpg"],
          initialIndex,
          preloadRange: 0,
        }),
      {
        initialProps: { initialIndex: 0 },
      }
    );

    await waitFor(() => {
      expect(result.current.errorStates.get(0)).toBeDefined();
    });

    expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(1);

    rerender({ initialIndex: 1 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    rerender({ initialIndex: 0 });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(0);
    });

    await waitFor(() => {
      expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(2);
    });
  });

  it("retries a transient current-image failure once before succeeding", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 0;
    });

    const requestedPaths: string[] = [];
    let currentAttempts = 0;

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        currentAttempts += 1;

        if (currentAttempts === 1) {
          return Promise.reject({
            code: "ERR_NETWORK",
            message: "Network Error",
          });
        }

        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      return new Promise<Blob>(() => {
        // Keep the rest of the gallery idle for this assertion.
      });
    });

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/0.jpg", "/1.jpg", "/2.jpg"],
        initialIndex: 0,
        preloadRange: 0,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(2);
    expect(result.current.getCachedImageSrc(0)).toBeDefined();
  });

  it("does not requeue an exhausted transient current-image failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 0;
    });

    const requestedPaths: string[] = [];
    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);
      return Promise.reject({ code: "ERR_NETWORK", message: "Network Error" });
    });

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/0.jpg"],
        preloadRange: 0,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(requestedPaths).toHaveLength(2);
    expect(result.current.errorStates.get(0)).toBe("Server is busy. Please wait a moment and try again.");
    expect(result.current.canRetryCurrentImage).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(requestedPaths).toHaveLength(2);
  });

  it("keeps a local preview policy error stable without retrying", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 0;
    });

    const policyError = new PreviewUnavailableError("This image requires server-side conversion.");
    const loadImageBlob = vi.fn().mockRejectedValue(policyError);

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "local-conn-1",
        loadImageBlob,
        images: ["/0.psd"],
        preloadRange: 0,
      })
    );

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.errorStates.get(0)).toBe(policyError.message);
    expect(result.current.currentImageLoadPhase).toBe("error");
    expect(result.current.canRetryCurrentImage).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(loadImageBlob).toHaveBeenCalledTimes(1);
  });

  it("does not auto-retry a non-retryable current-image failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 0;
    });

    const requestedPaths: string[] = [];

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/0.jpg") {
        return Promise.reject({
          message: "Not found",
          response: {
            status: 404,
            data: { detail: "Not found" },
          },
        });
      }

      return new Promise<Blob>(() => {
        // Keep the rest of the gallery idle for this assertion.
      });
    });

    const { result } = renderHook(() =>
      useCachedImageGallery({
        connectionId: "conn-1",
        loadImageBlob: (path, options) => apiService.getImageBlob("conn-1", path, options),
        images: ["/0.jpg", "/1.jpg", "/2.jpg"],
        initialIndex: 0,
        preloadRange: 0,
      })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.errorStates.get(0)).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });

    expect(requestedPaths.filter((path) => path === "/0.jpg")).toHaveLength(1);
  });

  it("does not let a previous gallery request populate the new gallery cache when it resolves late", async () => {
    let resolveOldGalleryCurrent: ((blob: Blob) => void) | null = null;
    const requestedPaths: string[] = [];

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      requestedPaths.push(path);

      if (path === "/a0.jpg") {
        return new Promise<Blob>((resolve) => {
          resolveOldGalleryCurrent = resolve;
        });
      }

      if (path === "/b1.jpg") {
        return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
      }

      return new Promise<Blob>(() => {
        // Keep remaining preload slots idle for this assertion.
      });
    });

    const { rerender, result } = renderHook(
      ({ images, initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex,
          preloadRange: 0,
        }),
      {
        initialProps: {
          images: ["/a0.jpg", "/a1.jpg"],
          initialIndex: 0,
        },
      }
    );

    await waitFor(() => {
      expect(resolveOldGalleryCurrent).not.toBeNull();
    });

    const requestsBeforeSwitch = requestedPaths.length;

    rerender({
      images: ["/b0.jpg", "/b1.jpg"],
      initialIndex: 1,
    });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    await waitFor(() => {
      expect(requestedPaths.slice(requestsBeforeSwitch)[0]).toBe("/b1.jpg");
    });

    resolveOldGalleryCurrent?.(new Blob(["/a0.jpg"], { type: "image/jpeg" }));

    await waitFor(() => {
      expect(result.current.imageCacheRef.current.get(1)).toBeDefined();
    });

    expect(result.current.imageCacheRef.current.has(0)).toBe(false);
  });

  it("does not echo an external gallery switch or its stale carried index", async () => {
    const onIndexChange = vi.fn();

    vi.mocked(apiService.getImageBlob).mockImplementation((_connectionId: string, path: string) => {
      return Promise.resolve(new Blob([path], { type: "image/jpeg" }));
    });

    const { rerender, result } = renderHook(
      ({ images, initialIndex }) =>
        useCachedImageGallery({
          connectionId: "conn-1",
          loadImageBlob: loadMockImageBlob,
          images,
          initialIndex,
          onIndexChange,
          preloadRange: 0,
        }),
      {
        initialProps: {
          images: ["/a0.jpg", "/a1.jpg", "/a2.jpg"],
          initialIndex: 0,
        },
      }
    );

    act(() => {
      result.current.setCurrentIndex(2);
    });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(2);
    });

    expect(onIndexChange).toHaveBeenCalledExactlyOnceWith(2);

    rerender({
      images: ["/b0.jpg", "/b1.jpg", "/b2.jpg"],
      initialIndex: 1,
    });

    await waitFor(() => {
      expect(result.current.currentIndex).toBe(1);
    });

    expect(onIndexChange).toHaveBeenCalledTimes(1);
  });
});
