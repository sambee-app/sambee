import type {
  DirectorySearchResult,
  DirectorySearchStatus,
  FileEntry,
  RecentDirectorySearchResponse,
  RecentFileSearchResponse,
} from "../types";
import api, { type HistorySearchOptions, type QuickNavigationScope } from "./api";

export type { HistorySearchOptions, QuickNavigationScope } from "./api";

export interface BrowserHistoryService {
  searchRecentFiles(
    query: string,
    resultLimit: number,
    signal: AbortSignal,
    options?: HistorySearchOptions
  ): Promise<RecentFileSearchResponse>;
  hasItemType(connectionId: string, path: string, expectedType: FileEntry["type"]): Promise<boolean>;
  recordRecentFile(connectionId: string, path: string): Promise<void>;
  removeRecentFile(recordId: string): Promise<void>;
  validateRecentFileTarget(recordId: string): Promise<FileEntry>;
  searchRecentDirectories(
    query: string,
    resultLimit: number,
    signal: AbortSignal,
    options?: HistorySearchOptions
  ): Promise<RecentDirectorySearchResponse>;
  recordRecentDirectory(connectionId: string, path: string): Promise<void>;
  removeRecentDirectory(recordId: string): Promise<void>;
  searchDirectories(
    connectionId: string,
    query: string,
    options: { includeDotDirectories: boolean; includeIssueDetails?: boolean; scope?: QuickNavigationScope; signal: AbortSignal }
  ): Promise<DirectorySearchResult>;
  getDirectorySearchStatus(connectionId: string, options: { signal: AbortSignal }): Promise<DirectorySearchStatus>;
}

export const browserHistoryService: BrowserHistoryService = {
  searchRecentFiles: (query, resultLimit, signal, options) =>
    options ? api.searchRecentFiles(query, resultLimit, signal, options) : api.searchRecentFiles(query, resultLimit, signal),
  hasItemType: async (connectionId, path, expectedType) => (await api.getFileInfo(connectionId, path)).type === expectedType,
  recordRecentFile: async (connectionId, path) => {
    await api.recordRecentFile(connectionId, path);
  },
  removeRecentFile: (recordId) => api.removeRecentFile(recordId),
  validateRecentFileTarget: (recordId) => api.validateRecentFileTarget(recordId),
  searchRecentDirectories: (query, resultLimit, signal, options) =>
    options ? api.searchRecentDirectories(query, resultLimit, signal, options) : api.searchRecentDirectories(query, resultLimit, signal),
  recordRecentDirectory: async (connectionId, path) => {
    await api.recordRecentDirectory(connectionId, path);
  },
  removeRecentDirectory: (recordId) => api.removeRecentDirectory(recordId),
  searchDirectories: (connectionId, query, options) => api.searchDirectories(connectionId, query, options),
  getDirectorySearchStatus: (connectionId, options) => api.getDirectorySearchStatus(connectionId, options),
};
