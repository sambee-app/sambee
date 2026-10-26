//
// useDirectorySearchProvider
//

/**
 * Directory Search Provider Hook
 * ===============================
 *
 * Returns a SearchProvider that searches all directory paths across the
 * current SMB connection using the backend directory cache.
 *
 * Features:
 * - Server-side search via GET /browse/{connectionId}/directories?q=...
 * - Cache state tracking (empty → building → ready → updating)
 * - Highlighted matching substrings in results
 * - Warm-up on activation to trigger cache building
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BROWSER_SHORTCUTS } from "../../../config/keyboardShortcuts";
import { type BrowserHistoryService, browserHistoryService } from "../../../services/browserHistoryService";
import { logger } from "../../../services/logger";
import { publishRecentDirectoriesChanged } from "../../../services/recentDirectoriesSync";
import type { DirectorySearchResult, RecentDirectory } from "../../../types";
import { normalizeQuerySeparators } from "./normalizeQuerySeparators";
import { historyMatchRank, rankHistorySearchResults, removeRecentHistoryResult } from "./recentHistory";
import type { SearchProvider, SearchResult, SearchResultItem, SearchStatusInfo, SearchTextHighlight } from "./types";

// ============================================================================
// Constants
// ============================================================================

/** Debounce delay in milliseconds for directory search */
const DIRECTORY_SEARCH_DEBOUNCE_MS = 200;

/** Minimum query length to trigger a directory search */
const DIRECTORY_MIN_QUERY_LENGTH = 2;

const PATH_SEPARATOR = "/";
const MAX_RECENT_DIRECTORY_RESULT_LIMIT = 50;
const RECENT_DIRECTORY_PREFIX = "recent-directory:";
const DIRECTORY_PREFIX = "directory:";

/** Ellipsis prefix used when the path is truncated */
const ELLIPSIS_PREFIX = "…/";

// ============================================================================
// splitPathSegments — splits a path into segments preserving separators
// ============================================================================

/**
 * Splits a path string into segments.
 * Leading separators are preserved in the first segment.
 *
 * Example: "/Documents/Reports/2026" → ["/", "Documents", "Reports", "2026"]
 */
//
// splitPathSegments
//
function splitPathSegments(path: string): string[] {
  /**
   * Split on path separator, filter empty strings, and preserve leading separator.
   */

  const parts = path.split(PATH_SEPARATOR).filter(Boolean);
  if (path.startsWith(PATH_SEPARATOR)) {
    parts.unshift(PATH_SEPARATOR);
  }
  return parts;
}

// ============================================================================
// findMatchSegmentRange — locates which segments contain the query match
// ============================================================================

interface SegmentRange {
  /** Index of the first segment containing part of the match */
  startSegment: number;
  /** Index of the last segment containing part of the match (inclusive) */
  endSegment: number;
}

/**
 * Given path segments and a query, find which segments span the match.
 * Returns null if the query does not match.
 */
//
// findMatchSegmentRange
//
function findMatchSegmentRange(segments: string[], query: string): SegmentRange | null {
  /**
   * Reconstruct the path, map each character back to its segment index,
   * then look up the segments that contain the match start and end.
   */

  if (!query) return null;

  // Reconstruct the full path from segments with separators
  let reconstructed = "";
  const charToSegment: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined) continue;
    // Add separator before non-root, non-first segments
    if (i > 0 && seg !== PATH_SEPARATOR) {
      reconstructed += PATH_SEPARATOR;
      charToSegment.push(i);
    }
    for (let c = 0; c < seg.length; c++) {
      reconstructed += seg[c];
      charToSegment.push(i);
    }
  }

  const matchIndex = reconstructed.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) return null;

  const matchEnd = matchIndex + query.length - 1;
  const startSeg = charToSegment[matchIndex];
  const endSeg = charToSegment[Math.min(matchEnd, charToSegment.length - 1)];
  if (startSeg === undefined || endSeg === undefined) return null;

  return {
    startSegment: startSeg,
    endSegment: endSeg,
  };
}

// ============================================================================
// SmartPathDisplay — shows path with match context and highlighted match
// ============================================================================

function findTextHighlight(text: string, query: string): SearchTextHighlight | undefined {
  if (!query) return undefined;
  const start = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return start < 0 ? undefined : { start, end: start + query.length };
}

export function getDirectoryResultPresentation(
  path: string,
  query: string
): Pick<SearchResultItem, "primaryText" | "secondaryText" | "primaryHighlight"> {
  const segments = splitPathSegments(path);
  const matchRange = findMatchSegmentRange(segments, query);

  // Determine which segments to show in the primary line.
  // Always show from the match start segment (or the last segment if no match)
  // through the end.
  let visibleStart: number;
  if (matchRange) {
    // Show from match start through end of path
    visibleStart = matchRange.startSegment;
  } else {
    // No match — show the last segment only
    visibleStart = Math.max(0, segments.length - 1);
  }

  // Skip leading "/" segment for the visible portion (it's just a separator)
  if (visibleStart === 0 && segments[0] === PATH_SEPARATOR && segments.length > 1) {
    visibleStart = 1;
  }

  const visibleSegments = segments.slice(visibleStart);
  const isTruncated = visibleStart > 0 && !(visibleStart === 1 && segments[0] === PATH_SEPARATOR);
  const primaryPath = (isTruncated ? ELLIPSIS_PREFIX : "") + visibleSegments.join(PATH_SEPARATOR);

  // Build the parent path for the secondary line (everything before the visible segments)
  const parentSegments = segments.slice(0, visibleStart);
  const parentPathWithoutRoot = parentSegments.filter((segment) => segment !== PATH_SEPARATOR).join(PATH_SEPARATOR);
  const parentPath = parentSegments.length > 0 ? `${PATH_SEPARATOR}${parentPathWithoutRoot}${PATH_SEPARATOR}` : "";

  return {
    primaryText: primaryPath,
    secondaryText: isTruncated && parentPath ? parentPath : PATH_SEPARATOR,
    primaryHighlight: findTextHighlight(primaryPath, query),
  };
}

interface DirectorySearchProviderOptions {
  includeDotDirectories?: boolean;
  getConnectionName?: (connectionId: string) => string;
  onNavigateDirectory?: (connectionId: string, path: string) => void;
  resultLimit?: number;
  history?: BrowserHistoryService;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Creates a SearchProvider for directory navigation.
 *
 * @param connectionId - The active SMB connection ID
 * @param onNavigate - Callback when a directory is selected
 * @returns A SearchProvider instance for use with UnifiedSearchBar
 */
//
// useDirectorySearchProvider
//
export function useDirectorySearchProvider(
  connectionId: string,
  onNavigate: (path: string) => void,
  options: DirectorySearchProviderOptions = {}
): SearchProvider {
  const { t } = useTranslation();
  const [cacheState, setCacheState] = useState<string>("empty");
  const [directoryCount, setDirectoryCount] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const includeDotDirectories = options.includeDotDirectories ?? false;
  const recentDirectoryResultLimit = options.resultLimit ?? MAX_RECENT_DIRECTORY_RESULT_LIMIT;
  const history = options.history ?? browserHistoryService;
  const recentDirectoriesRef = useRef(new Map<string, RecentDirectory>());

  const getRecentDirectoryPresentation = useCallback(
    (directory: RecentDirectory, query: string): Pick<SearchResultItem, "primaryText" | "secondaryText" | "primaryHighlight"> => {
      const presentation = getDirectoryResultPresentation(directory.path, query);
      const connectionName = options.getConnectionName?.(directory.connection_id) ?? directory.connection_id;
      return {
        ...presentation,
        secondaryText: `${connectionName}:${presentation.secondaryText}`,
      };
    },
    [options.getConnectionName]
  );

  //
  // fetchResults
  //
  const fetchResults = useCallback(
    async (query: string, signal: AbortSignal): Promise<SearchResult[]> => {
      // Normalise backslashes to forward slashes for cross-directory search
      const normalizedQuery = normalizeQuerySeparators(query).trim();

      try {
        const recentDirectoriesRequest = history.searchRecentDirectories(normalizedQuery, recentDirectoryResultLimit, signal);
        const directorySearchRequest =
          normalizedQuery.length >= DIRECTORY_MIN_QUERY_LENGTH
            ? history.searchDirectories(connectionId, normalizedQuery, {
                includeDotDirectories,
                signal,
              })
            : Promise.resolve<DirectorySearchResult | null>(null);
        const [recentResponse, directorySearchResult] = await Promise.all([recentDirectoriesRequest, directorySearchRequest]);

        if (signal.aborted) {
          return [];
        }

        recentDirectoriesRef.current = new Map(recentResponse.results.map((directory) => [directory.id, directory]));

        if (directorySearchResult) {
          setCacheState(directorySearchResult.cache_state);
          setDirectoryCount(directorySearchResult.directory_count);
          setTotalMatches(directorySearchResult.total_matches);
        }

        const recentPaths = new Set(recentResponse.results.map((directory) => `${directory.connection_id}\u0000${directory.path}`));
        const directoryResults = (directorySearchResult?.results ?? [])
          .filter((path) => !recentPaths.has(`${connectionId}\u0000${path}`))
          .slice(0, recentResponse.result_limit)
          .map((path) => ({
            kind: "result" as const,
            id: `${DIRECTORY_PREFIX}${path}`,
            value: `${DIRECTORY_PREFIX}${path}`,
            icon: "directory" as const,
            matchRank:
              directorySearchResult?.match_ranks?.[path] ?? historyMatchRank(path.split(PATH_SEPARATOR).at(-1) ?? path, normalizedQuery),
            ...getDirectoryResultPresentation(path, normalizedQuery),
          }));

        return rankHistorySearchResults(
          [
            ...(recentResponse.results.length > 0
              ? [
                  {
                    kind: "group-header" as const,
                    id: "recent-directories-group-header",
                    value: "" as const,
                    label: t("fileBrowser.search.groups.recentDirectories"),
                  },
                ]
              : []),
            ...recentResponse.results.map((directory) => ({
              kind: "result" as const,
              id: `${RECENT_DIRECTORY_PREFIX}${directory.id}`,
              value: `${RECENT_DIRECTORY_PREFIX}${directory.id}`,
              icon: "directory" as const,
              matchRank:
                directory.match_rank ?? historyMatchRank(directory.path.split(PATH_SEPARATOR).at(-1) ?? directory.path, normalizedQuery),
              usageScore: directory.usage_score,
              ...getRecentDirectoryPresentation(directory, normalizedQuery),
            })),
            ...(directoryResults.length > 0
              ? [
                  {
                    kind: "group-header" as const,
                    id: "directories-group-header",
                    value: "" as const,
                    label: t("fileBrowser.search.groups.directories"),
                  },
                ]
              : []),
            ...directoryResults,
          ],
          normalizedQuery
        );
      } catch (error: unknown) {
        if (
          signal.aborted ||
          (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ERR_CANCELED")
        ) {
          return [];
        }
        throw error;
      }
    },
    [connectionId, getRecentDirectoryPresentation, history, includeDotDirectories, recentDirectoryResultLimit, t]
  );

  //
  // onSelect
  //
  const onSelect = useCallback(
    (value: string): undefined => {
      if (value.startsWith(RECENT_DIRECTORY_PREFIX)) {
        const directory = recentDirectoriesRef.current.get(value.slice(RECENT_DIRECTORY_PREFIX.length));
        if (directory) {
          options.onNavigateDirectory?.(directory.connection_id, directory.path);
        }
        return;
      }

      if (value.startsWith(DIRECTORY_PREFIX)) {
        onNavigate(value.slice(DIRECTORY_PREFIX.length));
      }
    },
    [onNavigate, options.onNavigateDirectory]
  );

  const onRemoveSelected = useCallback(
    async (value: string) => {
      return removeRecentHistoryResult({
        value,
        prefix: RECENT_DIRECTORY_PREFIX,
        records: recentDirectoriesRef.current,
        remove: history.removeRecentDirectory,
        publish: publishRecentDirectoriesChanged,
      });
    },
    [history]
  );

  //
  // getStatusInfo
  //
  const getStatusInfo = useCallback((): SearchStatusInfo | null => {
    switch (cacheState) {
      case "building":
        return {
          label: t("fileBrowser.search.status.indexing", { count: directoryCount }),
          showSpinner: true,
        };
      case "updating":
        return {
          label: t("fileBrowser.search.status.updating", { count: directoryCount }),
          showSpinner: true,
        };
      case "empty":
        return { label: t("fileBrowser.search.status.startingIndex"), showSpinner: true };
      case "ready":
        return null;
      default:
        return null;
    }
  }, [cacheState, directoryCount, t]);

  //
  // onActivate
  //
  const onActivate = useCallback(() => {
    // Trigger an empty search to warm up the directory cache
    const controller = new AbortController();
    history
      .searchDirectories(connectionId, "", {
        includeDotDirectories,
        signal: controller.signal,
      })
      .then((result: DirectorySearchResult) => {
        if (!controller.signal.aborted) {
          setCacheState(result.cache_state);
          setDirectoryCount(result.directory_count);
        }
      })
      .catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code !== "ERR_CANCELED") {
          logger.error("Failed to warm up directory cache", { error }, "directory-search-provider");
        }
      });
  }, [connectionId, history, includeDotDirectories]);

  //
  // footerInfo
  //
  const footerInfo = useCallback(
    (resultCount: number): string | undefined => {
      if (resultCount > 0) {
        const isTruncated = totalMatches > resultCount;
        if (isTruncated) {
          return t("fileBrowser.search.results.countTruncated", { count: resultCount });
        }

        return t("fileBrowser.search.results.count", { count: resultCount });
      }
      return cacheState === "ready" && directoryCount > 0
        ? t("fileBrowser.search.results.directoriesIndexed", { count: directoryCount })
        : undefined;
    },
    [cacheState, directoryCount, t, totalMatches]
  );

  return {
    id: "directory-search",
    modeId: "navigate",
    modeLabel: t("fileBrowser.search.modes.navigate"),
    placeholder: t("fileBrowser.search.placeholders.directory"),
    debounceMs: DIRECTORY_SEARCH_DEBOUNCE_MS,
    minQueryLength: 0,
    fetchResults,
    onSelect,
    onRemoveSelected,
    getStatusInfo,
    onActivate,
    getFooterHint: (selectedResult) => (
      <>
        ↑↓ {t("fileBrowser.search.footer.navigate")}&ensp;↵ {t("fileBrowser.search.footer.open")}&ensp;<kbd>esc</kbd>{" "}
        {t("fileBrowser.search.footer.close")}
        {selectedResult?.kind === "result" && selectedResult.value.startsWith(RECENT_DIRECTORY_PREFIX) ? (
          <>
            &ensp;<kbd>Shift+Del</kbd> {t("fileBrowser.search.footer.removeRecentDirectory")}
          </>
        ) : null}
      </>
    ),
    footerInfo,
    shortcutHint: BROWSER_SHORTCUTS.QUICK_NAVIGATE.label,
  };
}
