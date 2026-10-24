import type { DirectorySearchResult, FileEntry, RecentDirectorySearchResponse, RecentFileSearchResponse } from "../types";
import api from "./api";

export interface BrowserHistoryService {
  searchRecentFiles(query: string, resultLimit: number, signal: AbortSignal): Promise<RecentFileSearchResponse>;
  hasItemType(connectionId: string, path: string, expectedType: FileEntry["type"]): Promise<boolean>;
  recordRecentFile(connectionId: string, path: string): Promise<void>;
  removeRecentFile(recordId: string): Promise<void>;
  validateRecentFileTarget(recordId: string): Promise<FileEntry>;
  searchRecentDirectories(query: string, resultLimit: number, signal: AbortSignal): Promise<RecentDirectorySearchResponse>;
  recordRecentDirectory(connectionId: string, path: string): Promise<void>;
  removeRecentDirectory(recordId: string): Promise<void>;
  searchDirectories(
    connectionId: string,
    query: string,
    options: { includeDotDirectories: boolean; signal: AbortSignal }
  ): Promise<DirectorySearchResult>;
}

export const browserHistoryService: BrowserHistoryService = {
  searchRecentFiles: (query, resultLimit, signal) => api.searchRecentFiles(query, resultLimit, signal),
  hasItemType: async (connectionId, path, expectedType) => (await api.getFileInfo(connectionId, path)).type === expectedType,
  recordRecentFile: async (connectionId, path) => {
    await api.recordRecentFile(connectionId, path);
  },
  removeRecentFile: (recordId) => api.removeRecentFile(recordId),
  validateRecentFileTarget: (recordId) => api.validateRecentFileTarget(recordId),
  searchRecentDirectories: (query, resultLimit, signal) => api.searchRecentDirectories(query, resultLimit, signal),
  recordRecentDirectory: async (connectionId, path) => {
    await api.recordRecentDirectory(connectionId, path);
  },
  removeRecentDirectory: (recordId) => api.removeRecentDirectory(recordId),
  searchDirectories: (connectionId, query, options) => api.searchDirectories(connectionId, query, options),
};
