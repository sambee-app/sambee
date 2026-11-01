import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserOpenMode } from "../../../pages/FileBrowser/types";
import { type BrowserHistoryService, browserHistoryService } from "../../../services/browserHistoryService";
import { publishRecentFilesChanged } from "../../../services/recentFilesSync";
import type { FileEntry, RecentFile } from "../../../types";
import { findTextHighlight, getSearchRelevance, rankHistorySearchResults, removeRecentHistoryResult, searchTerms } from "./recentHistory";
import type { SearchProvider, SearchResult, SearchSelectionAction, SearchStatusInfo } from "./types";

const CURRENT_DIRECTORY_PREFIX = "current:";
const RECENT_FILE_PREFIX = "recent:";

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
  files: FileEntry[];
  connectionName: string;
  resultLimit: number;
  getConnectionName: (connectionId: string) => string;
  onOpenCurrentFile: (file: FileEntry, mode: BrowserOpenMode) => void;
  onOpenRecentFile: (file: RecentFile, mode: BrowserOpenMode) => void;
  history?: BrowserHistoryService;
}

export function useFileSearchProvider({
  connectionId,
  currentPath,
  files,
  connectionName,
  resultLimit,
  getConnectionName,
  onOpenCurrentFile,
  onOpenRecentFile,
  history = browserHistoryService,
}: FileSearchProviderOptions): SearchProvider {
  const { t } = useTranslation();
  const recentFilesRef = useRef(new Map<string, RecentFile>());
  const currentFilesRef = useRef(new Map<string, FileEntry>());

  const fetchResults = useCallback(
    async (query: string, signal: AbortSignal): Promise<SearchResult[]> => {
      const terms = searchTerms(query);
      const currentCandidates = files
        .filter((file) => file.type === "file" && (!terms.length || getSearchRelevance(file.name, terms).matchedTermCount > 0))
        .sort((left, right) => {
          const leftRank = getSearchRelevance(left.name, terms);
          const rightRank = getSearchRelevance(right.name, terms);
          return (
            rightRank.matchedTermCount - leftRank.matchedTermCount ||
            leftRank.matchRank - rightRank.matchRank ||
            (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
          );
        });
      const recentResponse = await history.searchRecentFiles(query, resultLimit, signal);
      const effectiveResultLimit = recentResponse.result_limit ?? resultLimit;
      const recentPaths = new Set(recentResponse.results.map((file) => `${file.connection_id}\u0000${file.path}`));
      const uniqueCurrentMatches = currentCandidates
        .filter((file) => !recentPaths.has(`${connectionId}\u0000${currentPath ? `${currentPath}/` : ""}${file.name}`))
        .slice(0, effectiveResultLimit);

      recentFilesRef.current = new Map(recentResponse.results.map((file) => [file.id, file]));
      currentFilesRef.current = new Map(uniqueCurrentMatches.map((file) => [file.name, file]));

      return rankHistorySearchResults(
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
            id: `${RECENT_FILE_PREFIX}${file.id}`,
            value: `${RECENT_FILE_PREFIX}${file.id}`,
            icon: "recent-file" as const,
            ...getSearchRelevance(file.file_name, terms),
            usageScore: file.usage_score,
            sortPath: file.file_name,
            lastUsedAt: file.last_opened_at,
            primaryText: file.file_name,
            primaryHighlight: findTextHighlight(file.file_name, query.trim()),
            secondaryText: formatConnectionPath(getConnectionName(file.connection_id), parentPath(file.path)),
          })),
          ...(uniqueCurrentMatches.length > 0
            ? [
                {
                  id: "current-directory-group-header",
                  kind: "group-header" as const,
                  value: "" as const,
                  label: t("fileBrowser.search.groups.currentDirectory"),
                },
              ]
            : []),
          ...uniqueCurrentMatches.map((file) => ({
            kind: "result" as const,
            id: `${CURRENT_DIRECTORY_PREFIX}${file.name}`,
            value: `${CURRENT_DIRECTORY_PREFIX}${file.name}`,
            icon: "file" as const,
            ...getSearchRelevance(file.name, terms),
            sortPath: file.name,
            primaryText: file.name,
            primaryHighlight: findTextHighlight(file.name, query.trim()),
            secondaryText: formatConnectionPath(connectionName, currentPath || "/"),
          })),
        ],
        query
      );
    },
    [connectionId, connectionName, currentPath, files, getConnectionName, history, resultLimit, t]
  );

  const onSelect = useCallback(
    (value: string, action: SearchSelectionAction = "associated-viewer") => {
      if (value.startsWith(RECENT_FILE_PREFIX)) {
        const recentFile = recentFilesRef.current.get(value.slice(RECENT_FILE_PREFIX.length));
        if (recentFile) onOpenRecentFile(recentFile, toBrowserOpenMode(action));
      } else if (value.startsWith(CURRENT_DIRECTORY_PREFIX)) {
        const currentFile = currentFilesRef.current.get(value.slice(CURRENT_DIRECTORY_PREFIX.length));
        if (currentFile) onOpenCurrentFile(currentFile, toBrowserOpenMode(action));
      }
      return { focusTarget: "file-list" as const };
    },
    [onOpenCurrentFile, onOpenRecentFile]
  );

  const getStatusInfo = useCallback((): SearchStatusInfo | null => null, []);

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
    sourceKey: `${connectionId}:${currentPath}:${resultLimit}`,
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
