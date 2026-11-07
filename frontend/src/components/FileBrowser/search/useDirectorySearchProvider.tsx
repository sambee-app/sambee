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

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BROWSER_SHORTCUTS } from "../../../config/keyboardShortcuts";
import { type BrowserHistoryService, browserHistoryService } from "../../../services/browserHistoryService";
import { logger } from "../../../services/logger";
import { publishRecentDirectoriesChanged } from "../../../services/recentDirectoriesSync";
import type { DirectorySearchResult, RecentDirectory, RecentDirectorySearchResponse } from "../../../types";
import { normalizeQuerySeparators } from "./normalizeQuerySeparators";
import {
  bestSearchRelevance,
  findSearchHighlights,
  findTextHighlight,
  getSearchErrorMessage,
  getSearchRelevance,
  rankHistorySearchResults,
  removeRecentHistoryResult,
  SEARCH_CONTRACT_VERSION,
  searchTerms,
} from "./recentHistory";
import type { SearchProvider, SearchResult, SearchResultItem, SearchResultsUpdate, SearchStatusInfo } from "./types";

// ============================================================================
// Constants
// ============================================================================

/** Debounce delay in milliseconds for directory search */
const DIRECTORY_SEARCH_DEBOUNCE_MS = 160;
const DIRECTORY_REFRESH_INTERVAL_MS = 500;
const DIRECTORY_RECOVERY_INTERVAL_MS = 5_000;
const DIRECTORY_MIN_RETRY_MS = 1_000;
const DIRECTORY_MAX_RETRY_MS = 60_000;

function directoryRetryDelay(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(DIRECTORY_MAX_RETRY_MS, Math.max(DIRECTORY_MIN_RETRY_MS, value))
    : DIRECTORY_RECOVERY_INTERVAL_MS;
}

function directoryFailure(error: unknown): { terminal: boolean; delay: number } {
  const response = (error as { response?: { status?: number; data?: { detail?: { recoverable?: boolean; retry_after_ms?: number } } } })
    ?.response;
  const detail = response?.data?.detail;
  return {
    terminal: detail?.recoverable === false || [400, 401, 403, 404, 422, 501].includes(response?.status ?? 0),
    delay: directoryRetryDelay(detail?.retry_after_ms),
  };
}

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

  const highlights = findSearchHighlights(reconstructed, query);
  const first = highlights[0];
  const last = highlights.at(-1);
  if (!first || !last) return null;
  const matchIndex = first.start;
  const matchEnd = last.end - 1;
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
  sourceRevision?: number;
  includeDotDirectories?: boolean;
  getConnectionName?: (connectionId: string) => string;
  onNavigateDirectory?: (connectionId: string, path: string, recordId?: string) => void;
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
  const [cacheState, setCacheState] = useState<string>("opening");
  const [directoryCount, setDirectoryCount] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const [coverageStatus, setCoverageStatus] = useState<Pick<
    DirectorySearchResult,
    | "coverage"
    | "coverage_issue_count"
    | "last_verified_at_ms"
    | "status_message"
    | "monitoring_state"
    | "retry_after_ms"
    | "scan_progress"
    | "issue_details_available"
  > | null>(null);
  const [sourceFailure, setSourceFailure] = useState<"history" | "index" | null>(null);
  const [failureDetail, setFailureDetail] = useState<string | undefined>();
  const [legacyIndex, setLegacyIndex] = useState(false);
  const indexFailureRef = useRef(false);
  const indexResponseRef = useRef<DirectorySearchResult | null>(null);
  const activeIndexQueryRef = useRef(false);
  const terminalIndexRef = useRef(false);
  const retryDelayRef = useRef(DIRECTORY_RECOVERY_INTERVAL_MS);
  const indexResultsRef = useRef<{ query: string; response: DirectorySearchResult } | null>(null);
  const recentResponseRef = useRef<{ query: string; limit: number; response: RecentDirectorySearchResponse } | null>(null);
  const includeDotDirectories = options.includeDotDirectories ?? false;
  const recentDirectoryResultLimit = options.resultLimit ?? MAX_RECENT_DIRECTORY_RESULT_LIMIT;
  const history = options.history ?? browserHistoryService;
  const sourceRevision = options.sourceRevision ?? 0;
  const recentDirectoriesRef = useRef(new Map<string, RecentDirectory>());
  const requestGenerationRef = useRef(0);
  const [clientGeneration, setClientGeneration] = useState(0);
  const activationControllerRef = useRef<AbortController | null>(null);
  const sourceBindingRef = useRef({ connectionId, history, includeDotDirectories, sourceRevision });

  const updateIndexStatus = useCallback((response: DirectorySearchResult) => {
    setCacheState(response.cache_state);
    setDirectoryCount(response.directory_count);
    setCoverageStatus((previous) =>
      previous?.coverage === response.coverage &&
      previous?.coverage_issue_count === response.coverage_issue_count &&
      previous?.issue_details_available === response.issue_details_available &&
      previous?.last_verified_at_ms === response.last_verified_at_ms &&
      previous?.status_message === response.status_message &&
      previous?.monitoring_state === response.monitoring_state &&
      previous?.retry_after_ms === response.retry_after_ms &&
      previous?.scan_progress?.phase === response.scan_progress?.phase &&
      previous?.scan_progress?.parents_done === response.scan_progress?.parents_done &&
      previous?.scan_progress?.parents_queued === response.scan_progress?.parents_queued &&
      previous?.scan_progress?.directories_found === response.scan_progress?.directories_found &&
      previous?.scan_progress?.started_at_ms === response.scan_progress?.started_at_ms
        ? previous
        : {
            coverage: response.coverage,
            coverage_issue_count: response.coverage_issue_count,
            issue_details_available: response.issue_details_available,
            last_verified_at_ms: response.last_verified_at_ms,
            status_message: response.status_message,
            monitoring_state: response.monitoring_state,
            retry_after_ms: response.retry_after_ms,
            scan_progress: response.scan_progress,
          }
    );
  }, []);

  useEffect(() => {
    if (sourceBindingRef.current.history !== history) {
      setClientGeneration((generation) => generation + 1);
    }
    sourceBindingRef.current = { connectionId, history, includeDotDirectories, sourceRevision };
    recentResponseRef.current = null;
    indexResponseRef.current = null;
    indexResultsRef.current = null;
    terminalIndexRef.current = false;
    indexFailureRef.current = false;
    setSourceFailure(null);
    setFailureDetail(undefined);
    setCacheState("opening");
    setCoverageStatus(null);
    return () => {
      requestGenerationRef.current += 1;
      recentResponseRef.current = null;
      indexResponseRef.current = null;
      activationControllerRef.current?.abort();
    };
  }, [connectionId, history, includeDotDirectories, sourceRevision]);

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
    async (query: string, signal: AbortSignal, onUpdate?: SearchResultsUpdate): Promise<SearchResult[]> => {
      // Normalise backslashes to forward slashes for cross-directory search
      const normalizedQuery = normalizeQuerySeparators(query).trim();
      const terms = searchTerms(normalizedQuery);
      const queryIndex = normalizedQuery.length >= DIRECTORY_MIN_QUERY_LENGTH;
      activeIndexQueryRef.current = true;
      const generation = ++requestGenerationRef.current;
      const isCurrent = () =>
        !signal.aborted &&
        generation === requestGenerationRef.current &&
        sourceBindingRef.current.connectionId === connectionId &&
        sourceBindingRef.current.history === history &&
        sourceBindingRef.current.sourceRevision === sourceRevision &&
        sourceBindingRef.current.includeDotDirectories === includeDotDirectories;
      if (!isCurrent()) return [];
      setSourceFailure(indexFailureRef.current ? "index" : null);
      let recentResponse: RecentDirectorySearchResponse = { results: [], result_limit: recentDirectoryResultLimit };
      let directorySearchResult = indexResultsRef.current?.query === normalizedQuery ? indexResultsRef.current.response : null;

      const mergeResults = (): SearchResult[] => {
        const recentPaths = new Set(recentResponse.results.map((directory) => `${directory.connection_id}\u0000${directory.path}`));
        const directoryResults = (directorySearchResult?.results ?? [])
          .filter((path) => !recentPaths.has(`${connectionId}\u0000${path}`))
          .map((path) => ({
            kind: "result" as const,
            id: `${DIRECTORY_PREFIX}${path}`,
            value: `${DIRECTORY_PREFIX}${path}`,
            icon: "directory" as const,
            ...bestSearchRelevance(terms.length, getSearchRelevance(path, terms, path.split(PATH_SEPARATOR).at(-1) ?? path), {
              matchedTermCount: directorySearchResult?.matched_term_counts?.[path],
              matchRank: directorySearchResult?.match_ranks?.[path],
            }),
            sortPath: path,
            depth: path.split(PATH_SEPARATOR).length - 1,
            ...getDirectoryResultPresentation(path, normalizedQuery),
          }));

        const ranked = rankHistorySearchResults(
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
              icon: "recent-directory" as const,
              ...bestSearchRelevance(
                terms.length,
                getSearchRelevance(directory.path, terms, directory.path.split(PATH_SEPARATOR).at(-1) ?? directory.path),
                { matchedTermCount: directory.matched_term_count, matchRank: directory.match_rank },
                directory.connection_id === connectionId
                  ? {
                      matchedTermCount: directorySearchResult?.matched_term_counts?.[directory.path],
                      matchRank: directorySearchResult?.match_ranks?.[directory.path],
                    }
                  : {}
              ),
              sortPath: directory.path,
              lastUsedAt: directory.last_visited_at,
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
        let selectedCount = 0;
        return ranked.filter((row) => row.kind === "group-header" || selectedCount++ < recentResponse.result_limit);
      };

      const cachedHistory = recentResponseRef.current;
      const recentPromise =
        cachedHistory?.query === normalizedQuery && cachedHistory.limit === recentDirectoryResultLimit
          ? Promise.resolve(cachedHistory.response)
          : history.searchRecentDirectories(normalizedQuery, recentDirectoryResultLimit, signal);
      const recentRequest = recentPromise.then((response) => {
        if (!isCurrent()) return;
        recentResponse = response;
        recentResponseRef.current = { query: normalizedQuery, limit: recentDirectoryResultLimit, response };
        recentDirectoriesRef.current = new Map(response.results.map((directory) => [directory.id, directory]));
        onUpdate?.(mergeResults());
      });
      const indexRequest = !terminalIndexRef.current
        ? history.searchDirectories(connectionId, queryIndex ? normalizedQuery : "", { includeDotDirectories, signal }).then((response) => {
            if (!isCurrent()) return;
            directorySearchResult = queryIndex ? response : null;
            indexResultsRef.current = queryIndex ? { query: normalizedQuery, response } : null;
            indexResponseRef.current = response;
            indexFailureRef.current = false;
            terminalIndexRef.current =
              response.search_contract_version != null && response.search_contract_version !== SEARCH_CONTRACT_VERSION;
            setLegacyIndex(terms.length > 1 && response.search_contract_version !== SEARCH_CONTRACT_VERSION);
            updateIndexStatus(response);
            setTotalMatches(response.total_matches);
            onUpdate?.(mergeResults());
          })
        : Promise.resolve();
      const [recentOutcome, indexOutcome] = await Promise.allSettled([recentRequest, indexRequest]);
      if (!isCurrent()) return [];
      if (indexOutcome.status === "rejected") {
        indexFailureRef.current = true;
        const failure = directoryFailure(indexOutcome.reason);
        terminalIndexRef.current = failure.terminal;
        retryDelayRef.current = failure.delay;
      }
      setSourceFailure(indexFailureRef.current ? "index" : recentOutcome.status === "rejected" ? "history" : null);
      setFailureDetail((previous) =>
        indexOutcome.status === "rejected"
          ? getSearchErrorMessage(indexOutcome.reason)
          : indexFailureRef.current
            ? previous
            : recentOutcome.status === "rejected"
              ? getSearchErrorMessage(recentOutcome.reason)
              : undefined
      );
      return mergeResults();
    },
    [
      connectionId,
      getRecentDirectoryPresentation,
      history,
      includeDotDirectories,
      recentDirectoryResultLimit,
      sourceRevision,
      t,
      updateIndexStatus,
    ]
  );

  //
  // onSelect
  //
  const onSelect = useCallback(
    (value: string): undefined => {
      if (value.startsWith(RECENT_DIRECTORY_PREFIX)) {
        const directory = recentDirectoriesRef.current.get(value.slice(RECENT_DIRECTORY_PREFIX.length));
        if (directory) {
          options.onNavigateDirectory?.(directory.connection_id, directory.path, directory.id);
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
      recentResponseRef.current = null;
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
    const working =
      (cacheState === "building" || cacheState === "updating") && !(coverageStatus?.retry_after_ms && coverageStatus.retry_after_ms > 0);
    if (sourceFailure) {
      return {
        label: t(`fileBrowser.search.status.${sourceFailure}Unavailable`),
        showSpinner: false,
      };
    }
    if (coverageStatus?.status_message) return { label: coverageStatus.status_message, showSpinner: !!working };
    if (cacheState === "opening") return null;
    const progress = coverageStatus?.scan_progress;
    if (progress && progress.phase !== "idle") {
      return {
        label:
          progress.phase === "building"
            ? progress.directories_found > 0
              ? t("fileBrowser.search.status.indexing", { count: progress.directories_found })
              : t("fileBrowser.search.status.indexingPending")
            : t("fileBrowser.search.status.updatingProgress", {
                done: progress.parents_done,
                total: progress.parents_done + progress.parents_queued,
              }),
        showSpinner: true,
      };
    }
    if (coverageStatus?.coverage === "uncertain")
      return {
        label: t("fileBrowser.search.status.indexCoverageUncertain"),
        showSpinner: !!working,
      };
    if (coverageStatus?.coverage === "partial" && cacheState === "ready")
      return { label: t("fileBrowser.search.status.indexCoveragePartial"), showSpinner: false };
    if (legacyIndex) return { label: t("fileBrowser.search.status.legacyDirectorySearch"), showSpinner: false };
    switch (cacheState) {
      case "building":
        return {
          label:
            directoryCount > 0
              ? t("fileBrowser.search.status.indexing", { count: directoryCount })
              : t("fileBrowser.search.status.indexingPending"),
          showSpinner: !!working,
        };
      case "updating":
        return {
          label: t("fileBrowser.search.status.updating", { count: directoryCount }),
          showSpinner: !!working,
        };
      case "empty":
        return { label: t("fileBrowser.search.status.startingIndex"), showSpinner: false };
      case "ready":
        return null;
      default:
        return null;
    }
  }, [cacheState, coverageStatus, directoryCount, legacyIndex, sourceFailure, t]);

  const getRefreshIntervalMs = useCallback((): number | null => {
    const response = indexResponseRef.current;
    if (!activeIndexQueryRef.current || terminalIndexRef.current) return null;
    if (indexFailureRef.current) return retryDelayRef.current;
    if (!response || response.search_contract_version !== SEARCH_CONTRACT_VERSION) return null;
    if (response.retry_after_ms != null && response.retry_after_ms > 0) return directoryRetryDelay(response.retry_after_ms);
    if (response.scan_progress && response.scan_progress.phase !== "idle") return DIRECTORY_REFRESH_INTERVAL_MS;
    if (response.cache_state === "opening" || response.cache_state === "building" || response.cache_state === "updating")
      return DIRECTORY_REFRESH_INTERVAL_MS;
    return response.cache_state === "empty" ||
      response.status_message ||
      response.coverage === "uncertain" ||
      (response.monitoring_state != null && response.monitoring_state !== "healthy")
      ? DIRECTORY_RECOVERY_INTERVAL_MS
      : null;
  }, []);

  //
  // onActivate
  //
  const onActivate = useCallback(() => {
    // Trigger an empty search to warm up the directory cache
    activationControllerRef.current?.abort();
    const controller = new AbortController();
    activeIndexQueryRef.current = true;
    terminalIndexRef.current = false;
    const generation = requestGenerationRef.current;
    activationControllerRef.current = controller;
    history
      .searchDirectories(connectionId, "", {
        includeDotDirectories,
        signal: controller.signal,
      })
      .then((result: DirectorySearchResult) => {
        if (!controller.signal.aborted && generation === requestGenerationRef.current) {
          indexResponseRef.current = result;
          indexFailureRef.current = false;
          setSourceFailure(null);
          setFailureDetail(undefined);
          terminalIndexRef.current = result.search_contract_version != null && result.search_contract_version !== SEARCH_CONTRACT_VERSION;
          updateIndexStatus(result);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && generation === requestGenerationRef.current) {
          const failure = directoryFailure(error);
          terminalIndexRef.current = failure.terminal;
          retryDelayRef.current = failure.delay;
          indexFailureRef.current = true;
          setSourceFailure("index");
          setFailureDetail(getSearchErrorMessage(error));
          logger.warn("Directory cache activation is unavailable", {}, "directory-search-provider");
        }
      });
  }, [connectionId, history, includeDotDirectories, updateIndexStatus]);

  const onDeactivate = useCallback(() => {
    activeIndexQueryRef.current = false;
    requestGenerationRef.current += 1;
    recentResponseRef.current = null;
    activationControllerRef.current?.abort();
    activationControllerRef.current = null;
  }, []);

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
    sourceKey: `${connectionId}:${includeDotDirectories}:${recentDirectoryResultLimit}:${clientGeneration}:${sourceRevision}`,
    modeId: "navigate",
    modeLabel: t("fileBrowser.search.modes.navigate"),
    placeholder: t("fileBrowser.search.placeholders.directory"),
    debounceMs: DIRECTORY_SEARCH_DEBOUNCE_MS,
    minQueryLength: 0,
    fetchResults,
    onSelect,
    onRemoveSelected,
    getStatusInfo: () => {
      const status = getStatusInfo();
      if (!status) return null;
      const source = options.getConnectionName?.(connectionId) ?? connectionId;
      const partial = coverageStatus?.coverage === "partial" && cacheState === "ready" && !sourceFailure && !coverageStatus.status_message;
      return {
        ...status,
        label: t("fileBrowser.search.status.connectionStatus", {
          connection: source,
          message: partial ? t("fileBrowser.search.status.indexCoveragePartial") : status.label,
        }),
        ...(partial && coverageStatus.issue_details_available
          ? {
              loadDetails: async (signal: AbortSignal) => {
                const response = await history.searchDirectories(connectionId, "", {
                  includeDotDirectories,
                  includeIssueDetails: true,
                  signal,
                });
                return { source, issues: response.issue_details ?? [], incomplete: response.issue_details_incomplete };
              },
            }
          : {}),
        ...(sourceFailure && failureDetail && failureDetail !== status.label
          ? {
              loadDetails: async () => ({ source, message: failureDetail }),
            }
          : {}),
      };
    },
    getRefreshIntervalMs,
    invalidateResults: () => {
      recentResponseRef.current = null;
    },
    onActivate,
    onDeactivate,
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
