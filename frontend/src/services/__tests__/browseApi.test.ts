/**
 * Contract tests for Browse API
 *
 * Ensures frontend types match backend API responses for browse endpoints
 */

import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEARCH_CONTRACT_VERSION } from "../../components/FileBrowser/search/recentHistory";
import { type DirectoryListing, type DirectorySearchResult, type FileInfo, FileType } from "../../types";

// Mock axios before importing services
vi.mock("axios", () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: {
        use: vi.fn(),
        eject: vi.fn(),
      },
      response: {
        use: vi.fn(),
        eject: vi.fn(),
      },
    },
  };

  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      isCancel: vi.fn(() => false),
    },
  };
});

import axios from "axios";
import { apiService } from "../api";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  get: ReturnType<typeof vi.fn>;
};

function getRequiredItem<T>(items: T[], index: number): T {
  const item = items[index];
  expect(item).toBeDefined();

  if (item === undefined) {
    throw new Error(`Expected item at index ${index} to be defined`);
  }

  return item;
}

describe("Browse API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const testConnectionId = "123e4567-e89b-12d3-a456-426614174000";

  describe("Contract Tests - GET /browse/{connection_id}/list", () => {
    it("should return directory listing format", async () => {
      const backendResponse: DirectoryListing = {
        path: "/documents",
        items: [
          {
            name: "file.txt",
            path: "/documents/file.txt",
            type: FileType.FILE,
            size: 1024,
            mime_type: "text/plain",
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-02T00:00:00Z",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/documents");

      // Verify required fields
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("items");
      expect(result).toHaveProperty("total");

      // Verify types
      expect(typeof result.path).toBe("string");
      expect(Array.isArray(result.items)).toBe(true);
      expect(typeof result.total).toBe("number");

      // Verify values
      expect(result.path).toBe("/documents");
      expect(result.total).toBe(1);
    });

    it("should have correct FileInfo structure", async () => {
      const fileInfo: FileInfo = {
        name: "document.pdf",
        path: "/files/document.pdf",
        type: FileType.FILE,
        size: 2048,
        mime_type: "application/pdf",
        created_at: "2024-01-01T10:00:00Z",
        modified_at: "2024-01-05T15:30:00Z",
        is_readable: true,
        is_hidden: false,
      };

      const backendResponse: DirectoryListing = {
        path: "/files",
        items: [fileInfo],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/files");
      const item = getRequiredItem(result.items, 0);

      // Verify all FileInfo fields
      expect(item).toHaveProperty("name");
      expect(item).toHaveProperty("path");
      expect(item).toHaveProperty("type");
      expect(item).toHaveProperty("size");
      expect(item).toHaveProperty("mime_type");
      expect(item).toHaveProperty("created_at");
      expect(item).toHaveProperty("modified_at");
      expect(item).toHaveProperty("is_readable");
      expect(item).toHaveProperty("is_hidden");

      // Verify types
      expect(typeof item.name).toBe("string");
      expect(typeof item.path).toBe("string");
      expect(typeof item.type).toBe("string");
      expect(typeof item.size).toBe("number");
      expect(typeof item.mime_type).toBe("string");
      expect(typeof item.created_at).toBe("string");
      expect(typeof item.modified_at).toBe("string");
      expect(typeof item.is_readable).toBe("boolean");
      expect(typeof item.is_hidden).toBe("boolean");
    });

    it("should handle file type enum values", async () => {
      const backendResponse: DirectoryListing = {
        path: "/",
        items: [
          {
            name: "folder",
            path: "/folder",
            type: FileType.DIRECTORY,
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "file.txt",
            path: "/file.txt",
            type: FileType.FILE,
            size: 100,
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 2,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/");

      // Verify enum values
      const firstItem = getRequiredItem(result.items, 0);
      const secondItem = getRequiredItem(result.items, 1);

      expect(firstItem.type).toBe(FileType.DIRECTORY);
      expect(firstItem.type).toBe("directory");
      expect(secondItem.type).toBe(FileType.FILE);
      expect(secondItem.type).toBe("file");
    });

    it("should handle optional fields when available", async () => {
      const backendResponse: DirectoryListing = {
        path: "/",
        items: [
          {
            name: "file.txt",
            path: "/file.txt",
            type: FileType.FILE,
            size: 1024,
            mime_type: "text/plain",
            created_at: "2024-01-01T00:00:00Z",
            modified_at: "2024-01-02T00:00:00Z",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/");
      const item = getRequiredItem(result.items, 0);

      // Optional fields should be present when available
      expect(item.size).toBe(1024);
      expect(item.mime_type).toBe("text/plain");
      expect(item.created_at).toBe("2024-01-01T00:00:00Z");
      expect(item.modified_at).toBe("2024-01-02T00:00:00Z");
    });

    it("should handle optional fields when missing", async () => {
      const backendResponse: DirectoryListing = {
        path: "/",
        items: [
          {
            name: "folder",
            path: "/folder",
            type: FileType.DIRECTORY,
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/");
      const item = getRequiredItem(result.items, 0);

      // Directories may not have size or mime_type
      // These fields are optional in the FileInfo interface
      expect(item.name).toBe("folder");
      expect(item.type).toBe(FileType.DIRECTORY);
    });

    it("should handle empty directories", async () => {
      const backendResponse: DirectoryListing = {
        path: "/empty",
        items: [],
        total: 0,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/empty");

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(Array.isArray(result.items)).toBe(true);
    });

    it("should handle hidden files flag", async () => {
      const backendResponse: DirectoryListing = {
        path: "/",
        items: [
          {
            name: ".hidden",
            path: "/.hidden",
            type: FileType.FILE,
            is_readable: true,
            is_hidden: true,
          },
          {
            name: "visible.txt",
            path: "/visible.txt",
            type: FileType.FILE,
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 2,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/");

      const hiddenItem = getRequiredItem(result.items, 0);
      const visibleItem = getRequiredItem(result.items, 1);

      expect(hiddenItem.is_hidden).toBe(true);
      expect(visibleItem.is_hidden).toBe(false);
    });

    it("should handle is_readable flag", async () => {
      const backendResponse: DirectoryListing = {
        path: "/",
        items: [
          {
            name: "readable.txt",
            path: "/readable.txt",
            type: FileType.FILE,
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "unreadable.txt",
            path: "/unreadable.txt",
            type: FileType.FILE,
            is_readable: false,
            is_hidden: false,
          },
        ],
        total: 2,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/");

      const readableItem = getRequiredItem(result.items, 0);
      const unreadableItem = getRequiredItem(result.items, 1);

      expect(readableItem.is_readable).toBe(true);
      expect(unreadableItem.is_readable).toBe(false);
    });

    it("should handle multiple items with mixed types", async () => {
      const backendResponse: DirectoryListing = {
        path: "/mixed",
        items: [
          {
            name: "folder1",
            path: "/mixed/folder1",
            type: FileType.DIRECTORY,
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "document.pdf",
            path: "/mixed/document.pdf",
            type: FileType.FILE,
            size: 5120,
            mime_type: "application/pdf",
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "image.jpg",
            path: "/mixed/image.jpg",
            type: FileType.FILE,
            size: 204800,
            mime_type: "image/jpeg",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 3,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "/mixed");

      expect(result.items).toHaveLength(3);
      expect(result.total).toBe(3);
      const firstItem = getRequiredItem(result.items, 0);
      const secondItem = getRequiredItem(result.items, 1);
      const thirdItem = getRequiredItem(result.items, 2);

      expect(firstItem.type).toBe(FileType.DIRECTORY);
      expect(secondItem.type).toBe(FileType.FILE);
      expect(thirdItem.type).toBe(FileType.FILE);
    });

    it("should handle root path", async () => {
      const backendResponse: DirectoryListing = {
        path: "",
        items: [
          {
            name: "folder",
            path: "/folder",
            type: FileType.DIRECTORY,
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, "");

      expect(result.path).toBe("");
      expect(result.items).toHaveLength(1);
    });

    it("should handle nested paths", async () => {
      const nestedPath = "/documents/2024/january";
      const backendResponse: DirectoryListing = {
        path: nestedPath,
        items: [
          {
            name: "report.pdf",
            path: `${nestedPath}/report.pdf`,
            type: FileType.FILE,
            size: 1024,
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.listDirectory(testConnectionId, nestedPath);

      expect(result.path).toBe(nestedPath);
      expect(getRequiredItem(result.items, 0).path).toBe(`${nestedPath}/report.pdf`);
    });
  });

  describe("Contract Tests - GET /browse/{connection_id}/info", () => {
    it("should return single FileInfo object", async () => {
      const backendResponse: FileInfo = {
        name: "document.pdf",
        path: "/files/document.pdf",
        type: FileType.FILE,
        size: 2048,
        mime_type: "application/pdf",
        created_at: "2024-01-01T10:00:00Z",
        modified_at: "2024-01-05T15:30:00Z",
        is_readable: true,
        is_hidden: false,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getFileInfo(testConnectionId, "/files/document.pdf");

      // Verify it's a single FileInfo object, not an array
      expect(Array.isArray(result)).toBe(false);
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("type");

      expect(result.name).toBe("document.pdf");
      expect(result.path).toBe("/files/document.pdf");
    });

    it("should match FileInfo type from listing", async () => {
      const fileInfo: FileInfo = {
        name: "test.txt",
        path: "/test.txt",
        type: FileType.FILE,
        size: 100,
        mime_type: "text/plain",
        created_at: "2024-01-01T00:00:00Z",
        modified_at: "2024-01-02T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: fileInfo,
      } as AxiosResponse);

      const result = await apiService.getFileInfo(testConnectionId, "/test.txt");

      // Should have same structure as items in DirectoryListing
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("size");
      expect(result).toHaveProperty("mime_type");
      expect(result).toHaveProperty("created_at");
      expect(result).toHaveProperty("modified_at");
      expect(result).toHaveProperty("is_readable");
      expect(result).toHaveProperty("is_hidden");
    });

    it("should handle directory info", async () => {
      const backendResponse: FileInfo = {
        name: "documents",
        path: "/documents",
        type: FileType.DIRECTORY,
        is_readable: true,
        is_hidden: false,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getFileInfo(testConnectionId, "/documents");

      expect(result.type).toBe(FileType.DIRECTORY);
      expect(result.name).toBe("documents");
    });

    it("should handle file info with all optional fields", async () => {
      const backendResponse: FileInfo = {
        name: "photo.jpg",
        path: "/images/photo.jpg",
        type: FileType.FILE,
        size: 524288,
        mime_type: "image/jpeg",
        created_at: "2024-01-10T08:30:00Z",
        modified_at: "2024-01-15T14:45:00Z",
        is_readable: true,
        is_hidden: false,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getFileInfo(testConnectionId, "/images/photo.jpg");

      expect(result.size).toBe(524288);
      expect(result.mime_type).toBe("image/jpeg");
      expect(result.created_at).toBe("2024-01-10T08:30:00Z");
      expect(result.modified_at).toBe("2024-01-15T14:45:00Z");
    });
  });

  describe("Error Handling", () => {
    it("should handle 404 on non-existent path", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Path not found" },
        },
      });

      await expect(apiService.listDirectory(testConnectionId, "/nonexistent")).rejects.toMatchObject({
        response: { status: 404 },
      });
    });

    it("should handle 403 on access denied", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 403,
          data: { detail: "Access denied" },
        },
      });

      await expect(apiService.listDirectory(testConnectionId, "/restricted")).rejects.toMatchObject({
        response: { status: 403 },
      });
    });

    it("should handle invalid connection ID", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Connection not found" },
        },
      });

      await expect(apiService.listDirectory("invalid-uuid", "/")).rejects.toMatchObject({
        response: { status: 404 },
      });
    });

    it("should handle server errors", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: "Internal server error" },
        },
      });

      await expect(apiService.listDirectory(testConnectionId, "/")).rejects.toMatchObject({
        response: { status: 500 },
      });
    });
  });

  // ==========================================================================
  // Contract Tests — GET /browse/{connection_id}/directories
  // ==========================================================================

  describe("Contract Tests - GET /browse/{connection_id}/directories", () => {
    it.each([undefined, null, SEARCH_CONTRACT_VERSION])("preserves directory search contract version %s", async (searchContractVersion) => {
      const backendResponse: DirectorySearchResult = {
        results: ["documents", "documents/work", "documents/personal"],
        total_matches: 3,
        cache_state: "ready",
        directory_count: 150,
        search_contract_version: searchContractVersion,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.searchDirectories(testConnectionId, "doc");

      // Verify required fields
      expect(result).toHaveProperty("results");
      expect(result).toHaveProperty("total_matches");
      expect(result).toHaveProperty("cache_state");
      expect(result).toHaveProperty("directory_count");
      expect(result.search_contract_version).toBe(searchContractVersion);

      // Verify types
      expect(Array.isArray(result.results)).toBe(true);
      expect(typeof result.total_matches).toBe("number");
      expect(typeof result.cache_state).toBe("string");
      expect(typeof result.directory_count).toBe("number");

      // Verify API call
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        `/browse/${testConnectionId}/directories`,
        expect.objectContaining({
          params: { q: "doc", include_dot_directories: false },
        })
      );
    });

    it("should pass include_dot_directories when requested", async () => {
      const backendResponse: DirectorySearchResult = {
        results: [".git"],
        total_matches: 1,
        cache_state: "ready",
        directory_count: 5,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      await apiService.searchDirectories(testConnectionId, "git", { includeDotDirectories: true });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        `/browse/${testConnectionId}/directories`,
        expect.objectContaining({
          params: { q: "git", include_dot_directories: true },
        })
      );
    });

    it("should handle empty search query", async () => {
      const backendResponse: DirectorySearchResult = {
        results: [],
        total_matches: 0,
        cache_state: "ready",
        directory_count: 100,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.searchDirectories(testConnectionId, "");

      expect(result.results).toEqual([]);
      expect(result.total_matches).toBe(0);
      expect(result.cache_state).toBe("ready");
    });

    it("should accept all valid cache states", async () => {
      const cacheStates = ["empty", "opening", "building", "ready", "updating"] as const;

      for (const state of cacheStates) {
        const backendResponse: DirectorySearchResult = {
          results: [],
          total_matches: 0,
          cache_state: state,
          directory_count: 0,
        };

        mockAxiosInstance.get.mockResolvedValueOnce({
          data: backendResponse,
        } as AxiosResponse);

        const result = await apiService.searchDirectories(testConnectionId, "test");
        expect(result.cache_state).toBe(state);
      }
    });

    it("should pass abort signal to request", async () => {
      const backendResponse: DirectorySearchResult = {
        results: [],
        total_matches: 0,
        cache_state: "ready",
        directory_count: 0,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const controller = new AbortController();
      await apiService.searchDirectories(testConnectionId, "test", { signal: controller.signal });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        `/browse/${testConnectionId}/directories`,
        expect.objectContaining({
          signal: controller.signal,
        })
      );
    });

    it("should handle 404 for non-existent connection", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Connection not found" },
        },
      });

      await expect(apiService.searchDirectories("non-existent-id", "test")).rejects.toMatchObject({
        response: { status: 404 },
      });
    });

    it("should handle server errors", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: "Internal server error" },
        },
      });

      await expect(apiService.searchDirectories(testConnectionId, "test")).rejects.toMatchObject({
        response: { status: 500 },
      });
    });
  });

  describe("Contract Tests - POST /browse/{connection_id}/rename", () => {
    it("should return renamed file info on success", async () => {
      const renamedFileInfo: FileInfo = {
        name: "renamed.txt",
        path: "/renamed.txt",
        type: FileType.FILE,
        size: 1024,
        is_readable: true,
        is_hidden: false,
      };

      (mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post.mockResolvedValueOnce({
        data: renamedFileInfo,
        status: 200,
      } as AxiosResponse);

      const result = await apiService.renameItem(testConnectionId, "/document.txt", "renamed.txt");

      expect(result).toEqual(renamedFileInfo);
      expect(result.name).toBe("renamed.txt");
      expect(result.type).toBe(FileType.FILE);

      expect((mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
        `/browse/${testConnectionId}/rename`,
        { path: "/document.txt", new_name: "renamed.txt" },
        {}
      );
    });

    it("should handle 404 for non-existent item", async () => {
      (mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Item not found: /ghost.txt" },
        },
      });

      await expect(apiService.renameItem(testConnectionId, "/ghost.txt", "renamed.txt")).rejects.toMatchObject({
        response: { status: 404 },
      });
    });

    it("should handle 409 for name collision", async () => {
      (mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { detail: "An item named 'existing.txt' already exists" },
        },
      });

      await expect(apiService.renameItem(testConnectionId, "/document.txt", "existing.txt")).rejects.toMatchObject({
        response: { status: 409 },
      });
    });

    it("should handle 400 for invalid name", async () => {
      (mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { detail: "New name contains invalid characters" },
        },
      });

      await expect(apiService.renameItem(testConnectionId, "/document.txt", "file/name.txt")).rejects.toMatchObject({
        response: { status: 400 },
      });
    });

    it("should handle server errors", async () => {
      (mockAxiosInstance as unknown as { post: ReturnType<typeof vi.fn> }).post.mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: "Internal server error" },
        },
      });

      await expect(apiService.renameItem(testConnectionId, "/document.txt", "renamed.txt")).rejects.toMatchObject({
        response: { status: 500 },
      });
    });
  });
});
