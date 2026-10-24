import { requireTestValue } from "../../test/helpers/assertions";
/**
 * Mobile Logging API Contract Tests
 *
 * Tests the contract between frontend and backend for mobile logging endpoints.
 * These tests validate response structure, types, and edge cases.
 *
 * Contract: POST /logs/mobile
 * - Request: { session_id, device_info, logs[] }
 * - Response: { status, filename, logs_received }
 *
 * Contract: GET /logs/list
 * - Response: { files[], total_size }
 */

import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    defaults: {
      baseURL: "/api",
    },
  };

  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      isCancel: vi.fn(() => false),
    },
    isAxiosError: vi.fn((error) => error?.isAxiosError === true),
  };
});

import axios from "axios";
import { apiService } from "../api";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

describe("Mobile Logging API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("Contract Tests - POST /logs/mobile", () => {
    it("should accept mobile log batch with all required fields", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_20240115_abc123de.jsonl",
        logs_received: 1,
      };

      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const logBatch = {
        session_id: "abc123de-f456-7890-abcd-ef1234567890",
        device_info: {
          userAgent: "Mozilla/5.0...",
          screenWidth: 1920,
          screenHeight: 1080,
        },
        logs: [
          {
            timestamp: Date.now(),
            level: "info",
            component: "FileViewer",
            message: "File loaded successfully",
            context: { fileSize: 1024, duration: 150 },
          },
        ],
      };

      const result = await apiService.sendMobileLogs(logBatch);

      // Verify response structure
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("filename");
      expect(result).toHaveProperty("logs_received");

      // Verify types
      expect(typeof result.status).toBe("string");
      expect(typeof result.filename).toBe("string");
      expect(typeof result.logs_received).toBe("number");

      // Verify values
      expect(result.status).toBe("success");
      expect(result.filename).toBeTruthy();
      expect(result.logs_received).toBe(1);
    });

    it("should accept batch of multiple log entries", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_20240115_xyz789ab.jsonl",
        logs_received: 3,
      };

      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const logBatch = {
        session_id: "xyz789ab-1234-5678-9abc-def012345678",
        device_info: { platform: "web" },
        logs: [
          {
            timestamp: Date.now(),
            level: "debug",
            component: "App",
            message: "App started",
            context: {},
          },
          {
            timestamp: Date.now() + 1000,
            level: "info",
            component: "Connection",
            message: "Connected to server",
            context: { serverId: "test-123" },
          },
          {
            timestamp: Date.now() + 2000,
            level: "error",
            component: "FileViewer",
            message: "Failed to load file",
            context: { error: "Network timeout" },
          },
        ],
      };

      const result = await apiService.sendMobileLogs(logBatch);

      expect(result.status).toBe("success");
      expect(result.logs_received).toBe(3);
    });

    it("should handle different log levels", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_test.jsonl",
        logs_received: 1,
      };

      const logLevels = ["debug", "info", "warn", "error"];

      for (const level of logLevels) {
        (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          data: mockResponse,
          status: 200,
          statusText: "OK",
          headers: {},
        } as AxiosResponse);

        const logBatch = {
          session_id: `test-${level}`,
          device_info: {},
          logs: [
            {
              timestamp: Date.now(),
              level,
              message: `Test ${level} message`,
              context: {},
            },
          ],
        };

        const result = await apiService.sendMobileLogs(logBatch);
        expect(result.status).toBe("success");
      }
    });

    it("should handle empty context object", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_test.jsonl",
        logs_received: 1,
      };

      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const logBatch = {
        session_id: "test-empty-context",
        device_info: {},
        logs: [
          {
            timestamp: Date.now(),
            level: "info",
            message: "Simple message",
            context: {},
          },
        ],
      };

      const result = await apiService.sendMobileLogs(logBatch);
      expect(result.status).toBe("success");
    });

    it("should handle complex context objects", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_test.jsonl",
        logs_received: 1,
      };

      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const logBatch = {
        session_id: "test-complex",
        device_info: {
          os: "Android",
          version: "12",
        },
        logs: [
          {
            timestamp: Date.now(),
            level: "error",
            component: "FileViewer",
            message: "Complex error scenario",
            context: {
              error: {
                code: "ECONNREFUSED",
                message: "Connection refused",
              },
              stack: ["at FileViewer.loadFile", "at Connection.request"],
              metadata: {
                connectionId: "abc-123",
                retryCount: 3,
              },
            },
          },
        ],
      };

      const result = await apiService.sendMobileLogs(logBatch);
      expect(result.status).toBe("success");
    });

    it("should handle optional component field", async () => {
      const mockResponse = {
        status: "success",
        filename: "mobile_logs_test.jsonl",
        logs_received: 1,
      };

      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const logBatch = {
        session_id: "test-no-component",
        device_info: {},
        logs: [
          {
            timestamp: Date.now(),
            level: "info",
            message: "Message without component",
          },
        ],
      };

      const result = await apiService.sendMobileLogs(logBatch);
      expect(result.status).toBe("success");
    });
  });

  describe("Contract Tests - Error Handling", () => {
    it("should handle 400 bad request errors", async () => {
      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        response: {
          status: 400,
          data: { detail: "Too many logs in batch (max 100)" },
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(
        apiService.sendMobileLogs({
          session_id: "test",
          device_info: {},
          logs: Array(101).fill({ timestamp: Date.now(), level: "info", message: "Test" }),
        })
      ).rejects.toMatchObject({
        response: {
          status: 400,
        },
      });
    });

    it("should handle 500 server errors", async () => {
      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: "Failed to process logs" },
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(
        apiService.sendMobileLogs({
          session_id: "test",
          device_info: {},
          logs: [{ timestamp: Date.now(), level: "info", message: "Test" }],
        })
      ).rejects.toMatchObject({
        response: {
          status: 500,
        },
      });
    });

    it("should handle network errors", async () => {
      (mockAxiosInstance.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

      await expect(
        apiService.sendMobileLogs({
          session_id: "test",
          device_info: {},
          logs: [{ timestamp: Date.now(), level: "info", message: "Test" }],
        })
      ).rejects.toThrow("Network error");
    });
  });

  describe("Contract Tests - GET /logs/list", () => {
    it("should return list of log files with metadata", async () => {
      const mockResponse = {
        files: [
          {
            filename: "mobile_logs_20240115_abc123de.jsonl",
            size: 2048,
            modified: "2024-01-15T10:30:00.000Z",
            session_id: "abc123de",
            log_count: 25,
          },
          {
            filename: "mobile_logs_20240114_xyz789ab.jsonl",
            size: 1536,
            modified: "2024-01-14T15:20:00.000Z",
            session_id: "xyz789ab",
            log_count: 18,
          },
        ],
        total_size: 3584,
      };

      (mockAxiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const result = await apiService.listMobileLogs();

      // Verify response structure
      expect(result).toHaveProperty("files");
      expect(result).toHaveProperty("total_size");

      // Verify types
      expect(Array.isArray(result.files)).toBe(true);
      expect(typeof result.total_size).toBe("number");

      // Verify file structure
      const file = requireTestValue(result.files[0]);
      expect(file).toHaveProperty("filename");
      expect(file).toHaveProperty("size");
      expect(file).toHaveProperty("modified");
      expect(file).toHaveProperty("session_id");
      expect(file).toHaveProperty("log_count");

      expect(typeof file.filename).toBe("string");
      expect(typeof file.size).toBe("number");
      expect(typeof file.modified).toBe("string");
      expect(typeof file.session_id).toBe("string");
      expect(typeof file.log_count).toBe("number");

      // Verify values
      expect(result.files.length).toBe(2);
      expect(result.total_size).toBe(3584);
    });

    it("should handle empty file list", async () => {
      const mockResponse = {
        files: [],
        total_size: 0,
      };

      (mockAxiosInstance.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockResponse,
        status: 200,
        statusText: "OK",
        headers: {},
      } as AxiosResponse);

      const result = await apiService.listMobileLogs();

      expect(result.files).toEqual([]);
      expect(result.total_size).toBe(0);
    });

    it("should handle 500 server errors", async () => {
      (mockAxiosInstance.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
        response: {
          status: 500,
          data: { detail: "Failed to list logs" },
          headers: {},
        },
        isAxiosError: true,
      });

      await expect(apiService.listMobileLogs()).rejects.toMatchObject({
        response: {
          status: 500,
        },
      });
    });
  });

  describe("Contract Tests - GET /logs/download/{filename}", () => {
    it("should generate a token-free download URL", () => {
      const url = apiService.getLogDownloadUrl("mobile_logs_20240115_abc123de.jsonl");

      expect(url).toContain("/logs/download/mobile_logs_20240115_abc123de.jsonl");
      expect(url).not.toContain("token=");
    });

    it("should encode filename parameter correctly", () => {
      const url = apiService.getLogDownloadUrl("mobile logs with spaces.jsonl");

      expect(url).toContain(encodeURIComponent("mobile logs with spaces.jsonl"));
    });
  });
});
