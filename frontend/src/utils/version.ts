/**
 * Version and build information utilities
 */

import { translate } from "../i18n";
import { logger } from "../services/logger";
import { formatLocalizedDateTime } from "./localeFormatting";

const VERSION_FETCH_TIMEOUT_MS = 5_000;

export interface VersionInfo {
  version: string;
  build_time: string;
  git_commit: string;
}

/**
 * Fetch version information from the backend
 */
export async function fetchVersionInfo(): Promise<VersionInfo | null> {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    abortController.abort();
  }, VERSION_FETCH_TIMEOUT_MS);

  try {
    // Use absolute URL for tests (required by MSW), relative for production
    const baseURL = import.meta.env["VITE_API_URL"] || (import.meta.env.MODE === "test" ? "http://localhost:3000/api" : "/api");
    const response = await fetch(`${baseURL}/version`, { signal: abortController.signal });
    if (!response.ok) {
      logger.warn("Failed to fetch version info", { status: response.statusText }, "api");
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.warn("Error fetching version info", { error }, "api");
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Format build time for display
 */
export function formatBuildTime(buildTime: string): string {
  if (buildTime === "unknown") {
    return translate("settings.shell.unknownValue");
  }

  try {
    return formatLocalizedDateTime(buildTime, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return buildTime;
  }
}
