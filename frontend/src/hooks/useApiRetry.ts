import { useCallback } from "react";
import { isBackendConnectivityError, isLocalAbortOrClientTimeout } from "../services/backendAvailability";
import { info as logInfo } from "../services/logger";
import { PreviewUnavailableError } from "../services/previewPolicy";
import { isApiError } from "../types";
import { PhysicalFileRequestError } from "../utils/apiErrors";

/**
 * Options for API retry behavior
 */
interface RetryOptions {
  /** Maximum number of retry attempts (default: 1) */
  maxRetries?: number;
  /** Delay in milliseconds before retry (default: 1000) */
  retryDelay?: number;
  /** Optional abort signal to check during retry wait */
  signal?: AbortSignal;
}

/**
 * Check if an error is transient and might succeed on retry
 * Only true network errors (no response at all from server) should trigger retry
 */
const isTransientError = (err: unknown): boolean => {
  if (err instanceof PhysicalFileRequestError) return isTransientError(err.cause);
  if (err instanceof PreviewUnavailableError) {
    return false;
  }

  if (isLocalAbortOrClientTimeout(err)) {
    return false;
  }

  if (isBackendConnectivityError(err)) {
    return true;
  }

  if (!isApiError(err)) {
    return false;
  }

  return !err.response;
};

/**
 * Get user-friendly error message for transient errors after retry
 */
export const getTransientErrorMessage = (): string => {
  return "Server is busy. Please wait a moment and try again.";
};

/**
 * Check if an error is a transient error (exposed for use in error handling)
 */
export const checkIsTransientError = isTransientError;

/**
 * Hook that provides retry logic for API calls with transient error detection
 *
 * @example
 * const fetchWithRetry = useApiRetry();
 * const result = await fetchWithRetry(
 *   () => apiService.getImageBlob(id, path, { signal }),
 *   { signal, maxRetries: 1, retryDelay: 1000 }
 * );
 */
export const useApiRetry = () => {
  return useCallback(async <T>(fetchFn: () => Promise<T>, options: RetryOptions = {}): Promise<T> => {
    const { maxRetries = 1, retryDelay = 1000, signal } = options;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fetchFn();
      } catch (err) {
        lastError = err;

        // Check if aborted
        if (signal?.aborted) {
          throw err;
        }

        // Check if this is a transient error and we have retries left
        const shouldRetry = isTransientError(err) && attempt < maxRetries;

        if (shouldRetry) {
          logInfo("Transient error detected, will retry after delay", {
            attempt,
            error: err,
          });

          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          // Check if aborted during wait
          if (signal?.aborted) {
            throw err;
          }

          // Continue to next attempt
          continue;
        }

        // No more retries or not a transient error
        throw err;
      }
    }

    // Should never reach here, but TypeScript needs this
    throw lastError;
  }, []);
};

/**
 * Check if an error should show the "server busy" message
 */
export const shouldShowBusyMessage = (err: unknown, didRetry: boolean): boolean => {
  return isTransientError(err) && didRetry;
};
