/**
 * Hook for managing image gallery data with intelligent caching, preloading, and viewport optimization.
 *
 * Features:
 * - Fetches images on-demand with viewport-aware sizing
 * - Preloads images around the current index for smooth navigation
 * - Manages blob URL cache with automatic cleanup of distant images
 * - Handles loading states with delayed spinner to avoid flicker
 * - Supports retry logic for transient errors
 * - Abortable requests to prevent race conditions
 */

import axios from "axios";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { isLocalAbortError } from "../services/backendAvailability";
import { error as logError, logger, info as logInfo } from "../services/logger";
import { PreviewUnavailableError } from "../services/previewPolicy";
import { isApiError } from "../types";
import { PhysicalFileRequestError } from "../utils/apiErrors";
import { checkIsTransientError, getTransientErrorMessage } from "./useApiRetry";

// Delay before showing spinner to avoid flicker on fast loads
const SPINNER_DELAY_MS_DEFAULT = 300;
// Number of images to keep cached on each side of current index
const CACHE_RANGE_DEFAULT = 2;
// Number of images to preload ahead/behind current index
const PRELOAD_RANGE_DEFAULT = 1;
// Limit total in-flight viewer requests so preserved overlap and queued preloads
// share the same transport budget as the current image.
const MAX_ACTIVE_VIEWER_REQUESTS = 2;
const TRANSIENT_RETRY_DELAY_MS = 1000;
const IMAGE_PREVIEW_TOO_LARGE_ERROR_CODE = "image_preview_too_large";
export const IMAGE_LOAD_CANCELED_MESSAGE = "Image loading was canceled. You can still download the original file.";
export const IMAGE_LOAD_FAILED_MESSAGE = "Failed to load image";

export type ImageLoadPhase = "fetching" | "decoding" | "ready" | "canceled" | "error";

// Clamp value to ensure index stays within valid range
const clamp = (value: number, min: number, max: number) => {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

export interface UseImageGalleryDataParams {
  connectionId: string;
  images: string[];
  gallerySourceKey?: string;
  loadImageBlob: (path: string, options: { signal: AbortSignal; viewportWidth: number; viewportHeight: number }) => Promise<Blob>;
  initialIndex?: number;
  selectionKey?: string;
  onIndexChange?: (index: number) => void;
  spinnerDelayMs?: number;
  cacheRange?: number;
  preloadRange?: number;
  isTouchDevice?: boolean;
  shouldSuspendPreload?: () => boolean;
}

export interface UseImageGalleryDataResult {
  currentIndex: number;
  setCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  currentPath: string;
  filename: string;
  imageCacheRef: React.MutableRefObject<Map<number, string>>;
  getCachedImageSrc: (index: number) => string | undefined;
  getCachedImageBlob: (index: number) => Blob | undefined;
  loadingStates: Map<number, boolean>;
  errorStates: Map<number, string | null>;
  currentImageLoadPhase: ImageLoadPhase;
  imageSourceRevision: number;
  showLoadingSpinner: boolean;
  canRetryCurrentImage: boolean;
  markImageAsDecoded: (index: number, source: string) => void;
  markImageDecodeFailed: (index: number, source: string, message?: string) => void;
  cancelCurrentImageLoad: () => void;
  retryCurrentImage: () => void;
  abortControllersRef: React.MutableRefObject<Map<number, AbortController>>;
}

interface FetchImageOptions {
  priority?: RequestPriority;
}

type RequestPriority = "current" | "overlap" | "preload" | "stale";

interface InFlightImageRequest {
  promise: Promise<void>;
  controller: AbortController;
  priority: RequestPriority;
}

interface GallerySessionView {
  galleryIdentity: string;
  generation: number;
  index: number;
  loadingStates: Map<number, boolean>;
  errorStates: Map<number, string | null>;
  retryableErrors: Map<number, boolean>;
  loadPhases: Map<number, ImageLoadPhase>;
}

interface GallerySessionResources {
  galleryIdentity: string;
  generation: number;
  imageCache: Map<number, string>;
  imageBlobs: Map<number, Blob>;
  abortControllers: Map<number, AbortController>;
  inFlightRequests: Map<number, InFlightImageRequest>;
  failedBackgroundRequestKeys: Set<string>;
  currentRetryGate: CurrentRetryGate | null;
}

interface CurrentRetryGate {
  index: number;
}

function applyImageLoadFailure(
  session: GallerySessionView,
  index: number,
  message: string,
  options?: { canRetry?: boolean; showError?: boolean }
): GallerySessionView {
  const nextLoadingStates = new Map(session.loadingStates).set(index, false);
  const showError = options?.showError !== false;
  const nextErrorStates = showError ? new Map(session.errorStates).set(index, message) : session.errorStates;
  const nextRetryableErrors = showError ? new Map(session.retryableErrors).set(index, options?.canRetry === true) : session.retryableErrors;

  return {
    ...session,
    loadingStates: nextLoadingStates,
    errorStates: nextErrorStates,
    retryableErrors: nextRetryableErrors,
    loadPhases: new Map(session.loadPhases).set(index, "error"),
  };
}

function buildGalleryFailureKey(galleryIdentity: string, imagePath: string): string {
  return `${galleryIdentity}\u0000${imagePath}`;
}

function getRetryBudgetForPriority(priority: RequestPriority): number {
  return priority === "current" ? 1 : 0;
}

function createGallerySessionResources(galleryIdentity: string, generation: number): GallerySessionResources {
  return {
    galleryIdentity,
    generation,
    imageCache: new Map(),
    imageBlobs: new Map(),
    abortControllers: new Map(),
    inFlightRequests: new Map(),
    failedBackgroundRequestKeys: new Set(),
    currentRetryGate: null,
  };
}

function createGallerySessionView(galleryIdentity: string, generation: number, index: number): GallerySessionView {
  return {
    galleryIdentity,
    generation,
    index,
    loadingStates: new Map(),
    errorStates: new Map(),
    retryableErrors: new Map(),
    loadPhases: new Map(),
  };
}

function isManuallyRetryableImageFailure(err: unknown): boolean {
  if (checkIsTransientError(err)) {
    return true;
  }

  if (isApiError(err)) {
    return (err.response?.status ?? 0) >= 500;
  }

  if (typeof err === "object" && err !== null && "response" in err) {
    const response = (err as { response?: { status?: unknown } }).response;
    return typeof response?.status === "number" && response.status >= 500;
  }

  return false;
}

function getImageLoadErrorMessage(err: unknown): string {
  if (err instanceof PhysicalFileRequestError) return err.message;
  if (!isApiError(err)) {
    return IMAGE_LOAD_FAILED_MESSAGE;
  }

  const detail = err.response?.data?.detail;
  if (
    typeof detail === "object" &&
    detail !== null &&
    "code" in detail &&
    "message" in detail &&
    detail.code === IMAGE_PREVIEW_TOO_LARGE_ERROR_CODE &&
    typeof detail.message === "string" &&
    detail.message.trim()
  ) {
    return detail.message;
  }

  return IMAGE_LOAD_FAILED_MESSAGE;
}

function disposeGallerySessionResources(session: GallerySessionResources): void {
  session.abortControllers.forEach((controller) => {
    controller.abort();
  });
  session.abortControllers.clear();
  session.inFlightRequests.clear();
  session.failedBackgroundRequestKeys.clear();
  session.currentRetryGate = null;
  session.imageCache.forEach((url) => {
    URL.revokeObjectURL(url);
  });
  session.imageCache.clear();
  session.imageBlobs.clear();
}

function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);

    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener("abort", handleAbort);
      reject(new DOMException("Request aborted", "AbortError"));
    };

    if (signal.aborted) {
      handleAbort();
      return;
    }

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function buildPreloadOrder(centerIndex: number, imageCount: number, preloadRange: number): number[] {
  const order: number[] = [];

  if (centerIndex >= 0 && centerIndex < imageCount) {
    order.push(centerIndex);
  }

  for (let offset = 1; offset <= preloadRange; offset += 1) {
    const prevIndex = centerIndex - offset;
    const nextIndex = centerIndex + offset;

    if (prevIndex >= 0) {
      order.push(prevIndex);
    }
    if (nextIndex < imageCount) {
      order.push(nextIndex);
    }
  }

  return order;
}

function getLowestPriorityVictimIndex(
  requests: Map<number, InFlightImageRequest>,
  currentIndex: number,
  desiredOrder: number[]
): number | null {
  const desiredRank = new Map<number, number>();
  desiredOrder.forEach((index, rank) => {
    desiredRank.set(index, rank);
  });

  let victimIndex: number | null = null;
  let victimRank = -1;

  for (const [index, request] of requests) {
    if (request.priority === "stale" || index === currentIndex) {
      continue;
    }

    const rank = desiredRank.get(index) ?? Number.MAX_SAFE_INTEGER;
    if (rank > victimRank) {
      victimRank = rank;
      victimIndex = index;
    }
  }

  return victimIndex;
}

function retireRequest(requests: Map<number, InFlightImageRequest>, controllers: Map<number, AbortController>, index: number): void {
  const request = requests.get(index);
  if (!request) {
    return;
  }

  request.priority = "stale";
  controllers.delete(index);
  requests.delete(index);
  request.controller.abort();
}

//
// useCachedImageGallery
//
export const useCachedImageGallery = ({
  connectionId,
  images,
  gallerySourceKey,
  loadImageBlob,
  initialIndex = 0,
  selectionKey,
  onIndexChange,
  spinnerDelayMs = SPINNER_DELAY_MS_DEFAULT,
  cacheRange = CACHE_RANGE_DEFAULT,
  preloadRange = PRELOAD_RANGE_DEFAULT,
  isTouchDevice = false,
  shouldSuspendPreload,
}: UseImageGalleryDataParams): UseImageGalleryDataResult => {
  const safeInitialIndex = clamp(initialIndex, 0, Math.max(images.length - 1, 0));
  const galleryIdentity = useMemo(
    () => (gallerySourceKey ? `${connectionId}\u0001${gallerySourceKey}` : `${connectionId}\u0001${images.join("\u0001")}`),
    [connectionId, gallerySourceKey, images]
  );

  const sessionResourcesRef = useRef<GallerySessionResources>(createGallerySessionResources(galleryIdentity, 0));
  const [sessionView, setSessionView] = useState<GallerySessionView>(() =>
    createGallerySessionView(galleryIdentity, sessionResourcesRef.current.generation, safeInitialIndex)
  );

  const committedSessionResources = sessionResourcesRef.current;
  const hasCommittedSession = committedSessionResources.galleryIdentity === galleryIdentity;
  const pendingSessionGeneration = hasCommittedSession ? committedSessionResources.generation : committedSessionResources.generation + 1;
  const pendingSessionResources = useMemo(
    () => createGallerySessionResources(galleryIdentity, pendingSessionGeneration),
    [galleryIdentity, pendingSessionGeneration]
  );
  const activeSessionResources = hasCommittedSession ? committedSessionResources : pendingSessionResources;
  const activeSessionView =
    sessionView.galleryIdentity === galleryIdentity && sessionView.generation === pendingSessionGeneration
      ? sessionView
      : createGallerySessionView(galleryIdentity, pendingSessionGeneration, safeInitialIndex);

  const currentIndex = activeSessionView.index;
  const loadingStates = activeSessionView.loadingStates;
  const errorStates = activeSessionView.errorStates;
  const loadPhases = activeSessionView.loadPhases;
  // Controls spinner visibility after delay to avoid flicker
  const [showLoadingSpinner, setShowLoadingSpinner] = useState(false);
  const [imageSourceRevision, setImageSourceRevision] = useState(0);

  // AbortControllers for in-flight requests, keyed by index
  const abortControllersRef = useRef<Map<number, AbortController>>(committedSessionResources.abortControllers);
  // Cache of blob URLs for loaded images, keyed by index
  const imageCacheRef = useRef<Map<number, string>>(committedSessionResources.imageCache);
  // Timer for delayed spinner display
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const failedBackgroundRequestKeysRef = useRef<Set<string>>(committedSessionResources.failedBackgroundRequestKeys);
  // Track in-flight requests by image index so a preload can be promoted to the
  // current image without starting a second network request.
  const inFlightRequestsRef = useRef<Map<number, InFlightImageRequest>>(committedSessionResources.inFlightRequests);
  const desiredPreloadIndexesRef = useRef<Set<number>>(new Set());
  const currentIndexRef = useRef(currentIndex);
  currentIndexRef.current = currentIndex;
  const preloadRangeRef = useRef(preloadRange);
  preloadRangeRef.current = preloadRange;
  const galleryIdentityRef = useRef(galleryIdentity);
  const galleryGenerationRef = useRef(pendingSessionGeneration);

  const updateSessionView = useCallback(
    (targetGalleryIdentity: string, targetGeneration: number, updater: (prev: GallerySessionView) => GallerySessionView) => {
      setSessionView((prev) => {
        if (prev.galleryIdentity !== targetGalleryIdentity || prev.generation !== targetGeneration) {
          return prev;
        }

        return updater(prev);
      });
    },
    []
  );

  const setCurrentIndex = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (value) => {
      setSessionView((prev) => {
        const baseSession =
          prev.galleryIdentity === galleryIdentity && prev.generation === pendingSessionGeneration
            ? prev
            : createGallerySessionView(galleryIdentity, pendingSessionGeneration, safeInitialIndex);
        const nextIndexValue = typeof value === "function" ? value(baseSession.index) : value;
        const clampedIndex = clamp(nextIndexValue, 0, Math.max(images.length - 1, 0));

        if (baseSession.index === clampedIndex) {
          return prev === baseSession ? prev : baseSession;
        }

        return {
          ...baseSession,
          index: clampedIndex,
        };
      });
    },
    [galleryIdentity, images.length, pendingSessionGeneration, safeInitialIndex]
  );

  // Derive current path and filename from index
  const currentPath = images[currentIndex] ?? images[images.length - 1] ?? "";
  const filename = useMemo(() => {
    if (!currentPath) {
      return "";
    }
    const parts = currentPath.split("/");
    return parts[parts.length - 1] ?? currentPath;
  }, [currentPath]);

  const currentImageLoadPhase =
    loadPhases.get(currentIndex) ?? (errorStates.get(currentIndex) ? "error" : loadingStates.get(currentIndex) ? "fetching" : "ready");

  // Memoize the preload suspension callback to avoid effect loops during zoom.
  const shouldSuspendRef = useRef(shouldSuspendPreload ?? (() => false));
  shouldSuspendRef.current = shouldSuspendPreload ?? (() => false);
  const suspendPreload = useCallback(() => shouldSuspendRef.current(), []);

  // Commit gallery switches after render so abandoned renders cannot retire the active session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new route entry must reapply even an unchanged index after an optimistic move.
  useEffect(() => {
    const committedResources = sessionResourcesRef.current;

    if (committedResources.galleryIdentity !== galleryIdentity) {
      const nextResources = pendingSessionResources;
      sessionResourcesRef.current = nextResources;
      abortControllersRef.current = nextResources.abortControllers;
      imageCacheRef.current = nextResources.imageCache;
      failedBackgroundRequestKeysRef.current = nextResources.failedBackgroundRequestKeys;
      inFlightRequestsRef.current = nextResources.inFlightRequests;
      galleryIdentityRef.current = nextResources.galleryIdentity;
      galleryGenerationRef.current = nextResources.generation;

      disposeGallerySessionResources(committedResources);
      setImageSourceRevision((revision) => revision + 1);
    } else {
      abortControllersRef.current = committedResources.abortControllers;
      imageCacheRef.current = committedResources.imageCache;
      failedBackgroundRequestKeysRef.current = committedResources.failedBackgroundRequestKeys;
      inFlightRequestsRef.current = committedResources.inFlightRequests;
      galleryIdentityRef.current = committedResources.galleryIdentity;
      galleryGenerationRef.current = committedResources.generation;
    }

    setSessionView((prev) => {
      if (prev.galleryIdentity !== galleryIdentity || prev.generation !== pendingSessionGeneration) {
        return createGallerySessionView(galleryIdentity, pendingSessionGeneration, safeInitialIndex);
      }

      if (prev.index === safeInitialIndex) {
        return prev;
      }

      return {
        ...prev,
        index: safeInitialIndex,
      };
    });
  }, [galleryIdentity, pendingSessionGeneration, pendingSessionResources, safeInitialIndex, selectionKey]);

  const notifyIndexChange = useEffectEvent((index: number) => {
    if (index !== safeInitialIndex) onIndexChange?.(index);
  });

  useEffect(() => {
    notifyIndexChange(currentIndex);
  }, [currentIndex]);

  // Show spinner only after delay to avoid flicker on fast image loads
  useEffect(() => {
    const isLoading = loadingStates.get(currentIndex) || false;

    if (isLoading) {
      loadingTimerRef.current = setTimeout(() => {
        setShowLoadingSpinner(true);
      }, spinnerDelayMs);
    } else {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      setShowLoadingSpinner(false);
    }

    return () => {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
    };
  }, [loadingStates, currentIndex, spinnerDelayMs]);

  //
  // fetchAndCacheImage
  //
  /**
   * Fetches image at given index with viewport-optimized sizing and caches as blob URL.
   * Aborts any existing request for same index. Handles errors and loading states.
   * Returns a promise that resolves when the fetch completes (or reuses existing in-flight promise).
   */
  const fetchAndCacheImage = useCallback(
    async (index: number, options: FetchImageOptions = {}): Promise<void> => {
      const { priority = "preload" } = options;

      // Guard: skip invalid indices
      if (index < 0 || index >= images.length) {
        return;
      }

      const imagePath = images[index];
      if (!imagePath) {
        throw new Error("Invalid image path");
      }
      const requestGalleryIdentity = galleryIdentityRef.current;
      const requestGeneration = galleryGenerationRef.current;
      const requestSessionResources = sessionResourcesRef.current;
      const failureKey = buildGalleryFailureKey(requestGalleryIdentity, imagePath);

      // If already cached, return immediately
      if (requestSessionResources.imageCache.has(index)) {
        return;
      }

      // If already loading, return the existing promise to wait for it
      const existingRequest = requestSessionResources.inFlightRequests.get(index);
      if (existingRequest) {
        if (priority === "current") {
          existingRequest.priority = "current";
        } else if (priority === "overlap" && existingRequest.priority === "preload") {
          existingRequest.priority = "overlap";
        }
        return existingRequest.promise;
      }

      // Store promise ref FIRST to prevent race condition from duplicate calls
      let resolvePromise!: () => void;
      const fetchPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

      const abortController = new AbortController();
      const inFlightRequest: InFlightImageRequest = {
        promise: fetchPromise,
        controller: abortController,
        priority,
      };

      if (priority === "current") {
        requestSessionResources.currentRetryGate = null;
        failedBackgroundRequestKeysRef.current.delete(failureKey);
      }
      requestSessionResources.inFlightRequests.set(index, inFlightRequest);
      requestSessionResources.abortControllers.set(index, abortController);

      // Now start the actual fetch work
      try {
        // Mark as loading and clear any previous error
        updateSessionView(requestGalleryIdentity, requestGeneration, (prev) => {
          const nextLoadingStates =
            prev.loadingStates.get(index) === true ? prev.loadingStates : new Map(prev.loadingStates).set(index, true);
          const currentError = prev.errorStates.get(index) ?? null;
          const nextErrorStates = currentError === null ? prev.errorStates : new Map(prev.errorStates).set(index, null);
          const nextRetryableErrors =
            prev.retryableErrors.get(index) === false ? prev.retryableErrors : new Map(prev.retryableErrors).set(index, false);
          const nextLoadPhases =
            prev.loadPhases.get(index) === "fetching" ? prev.loadPhases : new Map(prev.loadPhases).set(index, "fetching");

          if (
            nextLoadingStates === prev.loadingStates &&
            nextErrorStates === prev.errorStates &&
            nextRetryableErrors === prev.retryableErrors &&
            nextLoadPhases === prev.loadPhases
          ) {
            return prev;
          }

          return {
            ...prev,
            loadingStates: nextLoadingStates,
            errorStates: nextErrorStates,
            retryableErrors: nextRetryableErrors,
            loadPhases: nextLoadPhases,
          };
        });

        const fetchStartTime = Date.now();

        logInfo("Fetching image for carousel", {
          index,
          path: imagePath,
          connectionId,
        });

        if (isTouchDevice) {
          logger.debug(
            "Image fetch started",
            {
              index,
              timestamp: fetchStartTime,
            },
            "image-cache"
          );
        }

        // Pass viewport dimensions for server-side image optimization
        // Use actual viewport size for efficiency - library will upscale if needed for fullscreen
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let attempt = 0;
        let blob: Blob | null = null;

        while (blob === null) {
          try {
            blob = await loadImageBlob(imagePath, {
              signal: abortController.signal,
              viewportWidth,
              viewportHeight,
            });
          } catch (err) {
            if (axios.isCancel(err) || isLocalAbortError(err)) {
              logInfo("Image fetch aborted", { index });
              resolvePromise();
              return;
            }

            if (galleryGenerationRef.current !== requestGeneration || galleryIdentityRef.current !== requestGalleryIdentity) {
              resolvePromise();
              return;
            }

            const latestRequest = requestSessionResources.inFlightRequests.get(index);
            const liveDesiredIndexes = new Set(buildPreloadOrder(currentIndexRef.current, images.length, preloadRangeRef.current));
            const effectivePriority =
              index === currentIndexRef.current
                ? "current"
                : liveDesiredIndexes.has(index)
                  ? "overlap"
                  : (latestRequest?.priority ?? priority);
            const effectiveMaxRetries = getRetryBudgetForPriority(effectivePriority);
            const shouldRetry = checkIsTransientError(err) && attempt < effectiveMaxRetries;

            if (shouldRetry) {
              logInfo("Transient error detected, will retry after delay", {
                attempt,
                error: err,
              });
              attempt += 1;
              await waitForRetryDelay(TRANSIENT_RETRY_DELAY_MS, abortController.signal);
              continue;
            }

            throw err;
          }
        }

        if (!blob || blob.size === 0) {
          throw new Error("Received empty image blob");
        }

        if (galleryGenerationRef.current !== requestGeneration || galleryIdentityRef.current !== requestGalleryIdentity) {
          resolvePromise();
          return;
        }

        // Create blob URL and cache it (must be revoked later to prevent memory leaks)
        const blobUrl = URL.createObjectURL(blob);

        if (galleryGenerationRef.current !== requestGeneration || galleryIdentityRef.current !== requestGalleryIdentity) {
          URL.revokeObjectURL(blobUrl);
          resolvePromise();
          return;
        }

        requestSessionResources.imageCache.set(index, blobUrl);
        requestSessionResources.imageBlobs.set(index, blob);
        setImageSourceRevision((revision) => revision + 1);
        requestSessionResources.failedBackgroundRequestKeys.delete(failureKey);
        if (requestSessionResources.currentRetryGate?.index === index) {
          requestSessionResources.currentRetryGate = null;
        }

        const fetchDuration = Date.now() - fetchStartTime;

        logInfo("Cached image for carousel", {
          index,
          blobUrl,
          size: blob.size,
        });

        logger.debug(
          "Image cache updated (add)",
          {
            cachedCount: requestSessionResources.imageCache.size,
            cachedIndexes: Array.from(requestSessionResources.imageCache.keys()).sort((a, b) => a - b),
          },
          "image-cache"
        );
        if (isTouchDevice) {
          logger.debug(
            "Image fetch completed",
            {
              index,
              duration: fetchDuration,
              size: blob.size,
              timestamp: Date.now(),
            },
            "image-cache"
          );
        }

        // The browser still needs to decode the blob URL before the image is ready.
        updateSessionView(requestGalleryIdentity, requestGeneration, (prev) => ({
          ...prev,
          loadPhases: new Map(prev.loadPhases).set(index, "decoding"),
        }));

        resolvePromise();
      } catch (err) {
        // Aborted/cancelled requests are expected behavior, not errors - resolve normally
        if (axios.isCancel(err) || isLocalAbortError(err)) {
          logInfo("Image fetch aborted", { index });
          resolvePromise();
          return;
        }

        if (galleryGenerationRef.current !== requestGeneration || galleryIdentityRef.current !== requestGalleryIdentity) {
          resolvePromise();
          return;
        }

        const latestRequest = requestSessionResources.inFlightRequests.get(index);
        const liveDesiredIndexes = new Set(buildPreloadOrder(currentIndexRef.current, images.length, preloadRangeRef.current));
        const effectivePriority =
          index === currentIndexRef.current ? "current" : liveDesiredIndexes.has(index) ? "overlap" : (latestRequest?.priority ?? priority);
        const isTransientFailure = checkIsTransientError(err);
        const isCurrentFailure = effectivePriority === "current";

        if (!isCurrentFailure) {
          requestSessionResources.failedBackgroundRequestKeys.add(failureKey);
        } else {
          requestSessionResources.currentRetryGate = { index };
        }

        if (isCurrentFailure || !isTransientFailure) {
          logError("Failed to fetch image for carousel", {
            index,
            path: imagePath,
            error: err,
            detail: isApiError(err) ? err.response?.data?.detail : undefined,
            status: isApiError(err) ? err.response?.status : undefined,
          });
        } else {
          logger.debug(
            "Transient background image preload failed",
            {
              index,
              path: imagePath,
              message: err instanceof Error ? err.message : undefined,
            },
            "image-cache"
          );
        }

        const errorMessage =
          err instanceof PreviewUnavailableError
            ? err.message
            : isTransientFailure
              ? getTransientErrorMessage()
              : getImageLoadErrorMessage(err);

        // Use RAF to batch state updates and avoid layout thrashing
        requestAnimationFrame(() => {
          updateSessionView(requestGalleryIdentity, requestGeneration, (prev) =>
            applyImageLoadFailure(prev, index, errorMessage, {
              canRetry: isCurrentFailure && isManuallyRetryableImageFailure(err),
              showError: isCurrentFailure || !isTransientFailure,
            })
          );
        });

        // Resolve instead of reject - we've handled the error, don't break preload chain
        resolvePromise();
      } finally {
        if (requestSessionResources.abortControllers.get(index) === abortController) {
          requestSessionResources.abortControllers.delete(index);
        }
        if (requestSessionResources.inFlightRequests.get(index)?.controller === abortController) {
          requestSessionResources.inFlightRequests.delete(index);
        }
      }
    },
    [connectionId, images, isTouchDevice, loadImageBlob, updateSessionView]
  );

  // Store fetchAndCacheImage in a ref to avoid recreating the effect
  const fetchAndCacheImageRef = useRef(fetchAndCacheImage);
  fetchAndCacheImageRef.current = fetchAndCacheImage;

  const reconcileRequestsRef = useRef<() => void>(() => {});
  reconcileRequestsRef.current = () => {
    if (!isMountedRef.current) {
      return;
    }

    if (!images.length) {
      desiredPreloadIndexesRef.current = new Set();
      return;
    }

    const currentRetryGate = activeSessionResources.currentRetryGate;
    if (currentRetryGate && currentRetryGate.index !== currentIndex) {
      activeSessionResources.currentRetryGate = null;
    }

    const desiredOrder = buildPreloadOrder(currentIndex, images.length, preloadRange);
    const desiredIndexes = new Set(desiredOrder);
    desiredPreloadIndexesRef.current = desiredIndexes;

    for (const [index, request] of activeSessionResources.inFlightRequests) {
      if (index === currentIndex) {
        request.priority = "current";
      } else if (desiredIndexes.has(index)) {
        request.priority = "overlap";
      } else {
        retireRequest(activeSessionResources.inFlightRequests, activeSessionResources.abortControllers, index);
      }
    }

    const coveredIndexes = new Set<number>();
    for (const index of activeSessionResources.imageCache.keys()) {
      if (desiredIndexes.has(index)) {
        coveredIndexes.add(index);
      }
    }

    for (const index of desiredOrder) {
      const desiredPath = images[index];
      if (
        index !== currentIndex &&
        desiredPath &&
        activeSessionResources.failedBackgroundRequestKeys.has(buildGalleryFailureKey(activeSessionResources.galleryIdentity, desiredPath))
      ) {
        coveredIndexes.add(index);
      }
    }

    const blockingCurrentRetryGate = activeSessionResources.currentRetryGate;
    if (blockingCurrentRetryGate?.index === currentIndex) {
      coveredIndexes.add(currentIndex);
    }

    for (const [index, request] of activeSessionResources.inFlightRequests) {
      if (request.priority !== "stale" && desiredIndexes.has(index)) {
        coveredIndexes.add(index);
      }
    }

    const countActiveManagedRequests = () =>
      Array.from(activeSessionResources.inFlightRequests.values()).filter((request) => request.priority !== "stale").length;

    while (!coveredIndexes.has(currentIndex) && countActiveManagedRequests() >= MAX_ACTIVE_VIEWER_REQUESTS) {
      const victimIndex = getLowestPriorityVictimIndex(activeSessionResources.inFlightRequests, currentIndex, desiredOrder);
      if (victimIndex === null) {
        break;
      }

      const victimRequest = activeSessionResources.inFlightRequests.get(victimIndex);
      if (!victimRequest) {
        break;
      }

      retireRequest(activeSessionResources.inFlightRequests, activeSessionResources.abortControllers, victimIndex);
      coveredIndexes.delete(victimIndex);
    }

    if (!coveredIndexes.has(currentIndex)) {
      void fetchAndCacheImageRef.current(currentIndex, { priority: "current" }).finally(() => {
        if (isMountedRef.current) {
          reconcileRequestsRef.current();
        }
      });
      return;
    }

    if (suspendPreload()) {
      return;
    }

    for (const index of desiredOrder) {
      if (index === currentIndex || coveredIndexes.has(index)) {
        continue;
      }

      if (countActiveManagedRequests() >= MAX_ACTIVE_VIEWER_REQUESTS) {
        break;
      }

      coveredIndexes.add(index);
      void fetchAndCacheImageRef.current(index, { priority: "preload" }).finally(() => {
        if (isMountedRef.current) {
          reconcileRequestsRef.current();
        }
      });

      break;
    }
  };

  // Maintain a rolling preload window. Initial open seeds the full +-range,
  // while subsequent one-step navigation keeps the overlap and only appends the
  // single newly exposed edge image.
  // biome-ignore lint/correctness/useExhaustiveDependencies: this effect intentionally reacts to navigation state changes and dispatches the latest reconcile callback through a ref
  useEffect(() => {
    isMountedRef.current = true;

    if (!images.length) {
      desiredPreloadIndexesRef.current = new Set();
      return;
    }

    let cancelled = false;

    queueMicrotask(() => {
      if (!cancelled) {
        reconcileRequestsRef.current();
      }
    });

    return () => {
      cancelled = true;
      // Don't abort any controllers on cleanup
      // The next effect run will reuse in-flight fetches for overlapping ranges
      // Only the cache cleanup effect will determine which images to keep
    };
  }, [currentIndex, galleryIdentity, images.length, preloadRange, suspendPreload]);

  // Clean up blob URLs for images outside cache range to prevent memory leaks
  useEffect(() => {
    const imageCache = sessionResourcesRef.current.imageCache;
    // Determine which indices should remain cached
    const indicesToKeep = new Set<number>();
    for (let offset = -cacheRange; offset <= cacheRange; offset += 1) {
      const candidate = currentIndex + offset;
      if (candidate >= 0 && candidate < images.length) {
        indicesToKeep.add(candidate);
      }
    }

    // Revoke blob URLs for images that have moved outside cache range
    const removedIndexes: number[] = [];
    imageCache.forEach((url, index) => {
      if (!indicesToKeep.has(index)) {
        logInfo("Revoking blob URL for distant image", { index, url });
        URL.revokeObjectURL(url);
        imageCache.delete(index);
        sessionResourcesRef.current.imageBlobs.delete(index);
        removedIndexes.push(index);
      }
    });

    if (removedIndexes.length > 0) {
      logger.debug(
        "Image cache updated (remove)",
        {
          cachedCount: imageCache.size,
          cachedIndexes: Array.from(imageCache.keys()).sort((a, b) => a - b),
          removedIndexes: removedIndexes.sort((a, b) => a - b),
        },
        "image-cache"
      );
    }
  }, [currentIndex, images.length, cacheRange]);

  // Cleanup: abort all pending requests and revoke all blob URLs on unmount.
  // The scheduler keeps request state in refs, so closed viewers must actively
  // release outstanding work instead of letting unresolved requests linger.
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      disposeGallerySessionResources(sessionResourcesRef.current);
    };
  }, []);

  const markImageAsDecoded = useCallback(
    (index: number, source: string) => {
      updateSessionView(galleryIdentity, pendingSessionGeneration, (prev) => {
        if (sessionResourcesRef.current.imageCache.get(index) !== source || prev.loadPhases.get(index) !== "decoding") {
          return prev;
        }

        return {
          ...prev,
          loadingStates: new Map(prev.loadingStates).set(index, false),
          loadPhases: new Map(prev.loadPhases).set(index, "ready"),
        };
      });
    },
    [galleryIdentity, pendingSessionGeneration, updateSessionView]
  );

  const markImageDecodeFailed = useCallback(
    (index: number, source: string, message = IMAGE_LOAD_FAILED_MESSAGE) => {
      updateSessionView(galleryIdentity, pendingSessionGeneration, (prev) => {
        if (sessionResourcesRef.current.imageCache.get(index) !== source) {
          return prev;
        }

        return applyImageLoadFailure(prev, index, message, { canRetry: true });
      });
    },
    [galleryIdentity, pendingSessionGeneration, updateSessionView]
  );

  const cancelCurrentImageLoad = useCallback(() => {
    const resources = sessionResourcesRef.current;
    const index = currentIndexRef.current;
    const cachedSource = resources.imageCache.get(index);
    retireRequest(resources.inFlightRequests, resources.abortControllers, index);

    if (cachedSource) {
      URL.revokeObjectURL(cachedSource);
      resources.imageCache.delete(index);
      resources.imageBlobs.delete(index);
      setImageSourceRevision((revision) => revision + 1);
    }

    resources.currentRetryGate = { index };
    updateSessionView(galleryIdentity, pendingSessionGeneration, (prev) => ({
      ...prev,
      loadingStates: new Map(prev.loadingStates).set(index, false),
      errorStates: new Map(prev.errorStates).set(index, IMAGE_LOAD_CANCELED_MESSAGE),
      retryableErrors: new Map(prev.retryableErrors).set(index, false),
      loadPhases: new Map(prev.loadPhases).set(index, "canceled"),
    }));
  }, [galleryIdentity, pendingSessionGeneration, updateSessionView]);

  const retryCurrentImage = useCallback(() => {
    const resources = sessionResourcesRef.current;
    const index = currentIndexRef.current;
    const source = resources.imageCache.get(index);
    if (source) {
      URL.revokeObjectURL(source);
      resources.imageCache.delete(index);
      resources.imageBlobs.delete(index);
      setImageSourceRevision((revision) => revision + 1);
    }

    resources.currentRetryGate = null;
    void fetchAndCacheImageRef.current(index, { priority: "current" }).finally(() => {
      if (isMountedRef.current) {
        reconcileRequestsRef.current();
      }
    });
  }, []);

  const getCachedImageSrc = useCallback(
    (index: number) => activeSessionResources.imageCache.get(index),
    [activeSessionResources.imageCache]
  );

  return {
    currentIndex,
    setCurrentIndex,
    currentPath,
    filename,
    imageCacheRef,
    getCachedImageSrc,
    getCachedImageBlob: (index: number) => activeSessionResources.imageBlobs.get(index),
    loadingStates,
    errorStates,
    currentImageLoadPhase,
    imageSourceRevision,
    showLoadingSpinner,
    canRetryCurrentImage: activeSessionView.retryableErrors.get(currentIndex) === true,
    markImageAsDecoded,
    markImageDecodeFailed,
    cancelCurrentImageLoad,
    retryCurrentImage,
    abortControllersRef,
  };
};
