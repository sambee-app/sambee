import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserOpenMode } from "../../../pages/FileBrowser/types";
import { type BrowserHistoryService, browserHistoryService, type HistorySearchOptions } from "../../../services/browserHistoryService";
import { publishRecentFilesChanged } from "../../../services/recentFilesSync";
import { type FileEntry, FileType, type RecentFile, type RecentFileSearchResponse } from "../../../types";
import {
  bestSearchRelevance,
  findSearchHighlights,
  findTextHighlight,
  getSearchErrorMessage,
  getSearchRelevance,
  rankHistorySearchResults,
  removeRecentHistoryResult,
  searchTerms,
} from "./recentHistory";
import type { SearchProvider, SearchResult, SearchSelectionAction, SearchStatusInfo } from "./types";

const RECENT_FILE_PREFIX = "recent:";
const CURRENT_FILE_PREFIX = "current:";

function toBrowserOpenMode(action: SearchSelectionAction): BrowserOpenMode {
  return action;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "/" : path.slice(0, separator) || "/";
}

function formatConnectionPath(connection: string, path: string): string {
  const rootedPath = path.startsWith("/") ? path : `/${path}`;
  return `${connection}:${rootedPath}`;
}

interface FileSearchProviderOptions {
  connectionId: string;
  currentPath: string;
  connectionName: string;
  resultLimit: number;
  getConnectionName: (connectionId: string) => string;
  onOpenRecentFile: (file: RecentFile, mode: BrowserOpenMode) => void;
  currentFolder?: {
    files: readonly FileEntry[];
    onOpenFile: (file: FileEntry, mode: BrowserOpenMode) => void;
  };
  history?: BrowserHistoryService;
  historyOptions?: HistorySearchOptions;
}

export function useFileSearchProvider({
  connectionId,
  currentPath,
  connectionName,
  resultLimit,
  getConnectionName,
  onOpenRecentFile,
  currentFolder,
  history = browserHistoryService,
  historyOptions,
}: FileSearchProviderOptions): SearchProvider {
  const { t } = useTranslation();
  const recentFilesRef = useRef(new Map<string, RecentFile>());
  const currentFolderRef = useRef(currentFolder);
  currentFolderRef.current = currentFolder;
  const requestGenerationRef = useRef(0);
  const historyConnectionId = historyOptions?.connectionId;
  const scopePath = historyOptions?.scope?.path;
  const scopeMode = historyOptions?.scope?.mode;
  const sourceBindingRef = useRef({
    connectionId,
    currentPath,
    history,
    resultLimit,
    historyConnectionId,
    scopePath,
    scopeMode,
  });
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [failureDetail, setFailureDetail] = useState<string | undefined>();

  useLayoutEffect(() => {
    sourceBindingRef.current = {
      connectionId,
      currentPath,
      history,
      resultLimit,
      historyConnectionId,
      scopePath,
      scopeMode,
    };
    return () => {
      requestGenerationRef.current += 1;
      recentFilesRef.current.clear();
    };
  }, [connectionId, currentPath, history, resultLimit, historyConnectionId, scopePath, scopeMode]);

  const fetchResults = useCallback(
    async (query: string, signal: AbortSignal): Promise<SearchResult[]> => {
      const generation = ++requestGenerationRef.current;
      const isCurrent = () =>
        !signal.aborted &&
        generation === requestGenerationRef.current &&
        sourceBindingRef.current.connectionId === connectionId &&
        sourceBindingRef.current.currentPath === currentPath &&
        sourceBindingRef.current.history === history &&
        sourceBindingRef.current.resultLimit === resultLimit &&
        sourceBindingRef.current.historyConnectionId === historyConnectionId &&
        sourceBindingRef.current.scopePath === scopePath &&
        sourceBindingRef.current.scopeMode === scopeMode;
      if (!isCurrent()) return [];
      setHistoryUnavailable(false);
      setFailureDetail(undefined);
      const terms = searchTerms(query);
      const recentResults = (recentResponse: RecentFileSearchResponse): SearchResult[] => {
        recentFilesRef.current = new Map(recentResponse.results.map((file) => [file.id, file]));

        const recentPaths = new Set(recentResponse.results.filter((file) => file.connection_id === connectionId).map((file) => file.path));
        const folderMatches: SearchResult[] = [];
        if (terms.length && scopeMode !== "descendants_only") {
          for (const file of currentFolderRef.current?.files ?? []) {
            if (file.type !== FileType.FILE || !file.is_readable) continue;
            const path = currentPath ? `${currentPath}/${file.name}` : file.name;
            if (recentPaths.has(path)) continue;
            const relevance = getSearchRelevance(file.name, terms);
            if (!relevance.matchedTermCount) continue;
            folderMatches.push({
              kind: "result",
              id: JSON.stringify([connectionId, path]),
              value: `${CURRENT_FILE_PREFIX}${file.name}`,
              icon: "file",
              ...relevance,
              sortPath: file.name,
              primaryText: file.name,
              primaryHighlight: findSearchHighlights(file.name, query),
              secondaryText: formatConnectionPath(connectionName, currentPath),
            });
          }
        }

        const ranked = rankHistorySearchResults(
          [
            ...(recentResponse.results.length > 0
              ? [
                  {
                    id: "recent-group-header",
                    kind: "group-header" as const,
                    value: "" as const,
                    label: t("fileBrowser.search.groups.recentFiles"),
                  },
                ]
              : []),
            ...recentResponse.results.map((file) => ({
              kind: "result" as const,
              id: JSON.stringify([file.connection_id, file.path]),
              value: `${RECENT_FILE_PREFIX}${file.id}`,
              icon: "recent-file" as const,
              ...bestSearchRelevance(terms.length, getSearchRelevance(file.file_name, terms), {
                matchedTermCount: file.matched_term_count,
                matchRank: file.match_rank,
              }),
              usageScore: file.usage_score,
              sortPath: file.file_name,
              lastUsedAt: file.last_opened_at,
              primaryText: file.file_name,
              primaryHighlight: findTextHighlight(file.file_name, query.trim()),
              secondaryText: formatConnectionPath(getConnectionName(file.connection_id), parentPath(file.path)),
            })),
            ...folderMatches,
          ],
          query
        );
        return terms.length ? ranked.slice(0, resultLimit) : ranked;
      };
      const availableResponse: RecentFileSearchResponse = { results: [], result_limit: resultLimit };
      try {
        const recentResponse = await history.searchRecentFiles(
          query,
          resultLimit,
          signal,
          historyConnectionId !== undefined || scopePath !== undefined
            ? {
                connectionId: historyConnectionId,
                ...(scopePath !== undefined && scopeMode !== undefined ? { scope: { path: scopePath, mode: scopeMode } } : {}),
              }
            : undefined
        );
        if (!isCurrent()) return [];
        return recentResults(recentResponse);
      } catch (error: unknown) {
        if (!isCurrent()) return [];
        setHistoryUnavailable(true);
        setFailureDetail(getSearchErrorMessage(error));
        return recentResults(availableResponse);
      }
    },
    [connectionId, connectionName, currentPath, getConnectionName, history, historyConnectionId, resultLimit, scopeMode, scopePath, t]
  );

  const onSelect = useCallback(
    (value: string, action: SearchSelectionAction = "associated-viewer") => {
      if (value.startsWith(RECENT_FILE_PREFIX)) {
        const recentFile = recentFilesRef.current.get(value.slice(RECENT_FILE_PREFIX.length));
        if (recentFile) onOpenRecentFile(recentFile, toBrowserOpenMode(action));
      } else if (value.startsWith(CURRENT_FILE_PREFIX) && scopeMode !== "descendants_only") {
        const folder = currentFolderRef.current;
        const name = value.slice(CURRENT_FILE_PREFIX.length);
        const file = folder?.files.find((entry) => entry.name === name && entry.type === FileType.FILE && entry.is_readable);
        if (file && folder) folder.onOpenFile(file, toBrowserOpenMode(action));
      }
      return { focusTarget: "file-list" as const };
    },
    [onOpenRecentFile, scopeMode]
  );

  const getStatusInfo = useCallback(
    (): SearchStatusInfo | null =>
      historyUnavailable
        ? {
            label: t("fileBrowser.search.status.connectionStatus", {
              connection: connectionName,
              message: t("fileBrowser.search.status.fileHistoryUnavailable"),
            }),
            showSpinner: false,
            ...(failureDetail && failureDetail !== t("fileBrowser.search.status.fileHistoryUnavailable")
              ? {
                  loadDetails: async () => ({ source: connectionName, message: failureDetail }),
                }
              : {}),
          }
        : null,
    [connectionName, failureDetail, historyUnavailable, t]
  );

  const onRemoveSelected = useCallback(
    async (value: string) => {
      return removeRecentHistoryResult({
        value,
        prefix: RECENT_FILE_PREFIX,
        records: recentFilesRef.current,
        remove: history.removeRecentFile,
        publish: publishRecentFilesChanged,
      });
    },
    [history]
  );

  return {
    id: "file-search",
    sourceKey: JSON.stringify([connectionId, currentPath, resultLimit, historyConnectionId, scopePath, scopeMode, Boolean(currentFolder)]),
    modeId: "file-search",
    modeLabel: t("fileBrowser.search.modes.fileSearch"),
    placeholder: t("fileBrowser.search.placeholders.fileSearch"),
    debounceMs: 100,
    minQueryLength: 0,
    fetchResults,
    onSelect,
    onRemoveSelected,
    getStatusInfo,
    getFooterHint: (selectedResult) => (
      <>
        <span>
          <kbd>Enter</kbd> {t("fileBrowser.row.openInBrowserViewer")}
        </span>
        <span>
          <kbd>Shift+Enter</kbd> {t("fileBrowser.row.chooseBrowserViewer")}
        </span>
        <span>
          <kbd>Ctrl+Enter</kbd> {t("fileBrowser.row.openInNativeApp")}
        </span>
        <span>
          <kbd>Ctrl+Alt+Enter</kbd> {t("fileBrowser.row.chooseNativeApp")}
        </span>
        {selectedResult?.value.startsWith(RECENT_FILE_PREFIX) ? (
          <span>
            <kbd>Shift+Del</kbd> {t("fileBrowser.search.footer.removeRecent")}
          </span>
        ) : null}
      </>
    ),
    footerInfo: (resultCount) => t("fileBrowser.search.results.count", { count: resultCount }),
    shortcutHint: "/",
  };
}
