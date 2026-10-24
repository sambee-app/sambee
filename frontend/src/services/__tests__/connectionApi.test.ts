import { createMockConnection } from "../../test/fixtures/connections";
import { requireTestValue } from "../../test/helpers/assertions";
/**
 * Contract tests for Connection Management API
 *
 * Ensures frontend types match backend API responses for admin/connection endpoints
 */

import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection, ConnectionCreate } from "../../types";

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
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

describe("Connection Management API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("Contract Tests - GET /connections", () => {
    it("should return array of connections", async () => {
      const backendResponse: Connection[] = [
        createMockConnection({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: "Test Server",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "public",
          username: "user1",
          path_prefix: "/",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();

      // Verify it's an array
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it("should include all required connection fields", async () => {
      const backendResponse: Connection[] = [
        createMockConnection({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: "Test Server",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "public",
          username: "testuser",
          path_prefix: "/data",
          created_at: "2024-01-01T12:30:00Z",
          updated_at: "2024-01-02T08:15:00Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();
      const conn = result[0];

      // Verify all required fields are present
      expect(conn).toHaveProperty("id");
      expect(conn).toHaveProperty("name");
      expect(conn).toHaveProperty("type");
      expect(conn).toHaveProperty("host");
      expect(conn).toHaveProperty("port");
      expect(conn).toHaveProperty("share_name");
      expect(conn).toHaveProperty("username");
      expect(conn).toHaveProperty("path_prefix");
      expect(conn).toHaveProperty("created_at");
      expect(conn).toHaveProperty("updated_at");
    });

    it("should have correct field types", async () => {
      const backendResponse: Connection[] = [
        createMockConnection({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: "Test Server",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "public",
          username: "user",
          path_prefix: "/",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();
      const conn = requireTestValue(result[0]);

      // Verify types
      expect(typeof conn.id).toBe("string");
      expect(typeof conn.name).toBe("string");
      expect(typeof conn.type).toBe("string");
      expect(typeof conn.host).toBe("string");
      expect(typeof conn.port).toBe("number");
      expect(typeof conn.share_name).toBe("string");
      expect(typeof conn.username).toBe("string");
      expect(typeof conn.path_prefix).toBe("string");
      expect(typeof conn.created_at).toBe("string");
      expect(typeof conn.updated_at).toBe("string");
    });

    it("should parse UUID strings correctly", async () => {
      const uuid = "123e4567-e89b-12d3-a456-426614174000";
      const backendResponse: Connection[] = [
        createMockConnection({
          id: uuid,
          name: "Test",
          type: "smb",
          host: "192.168.1.1",
          port: 445,
          share_name: "share",
          username: "user",
          path_prefix: "/",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();

      // UUID should be a valid UUID string
      expect(requireTestValue(result[0]).id).toBe(uuid);
      expect(requireTestValue(result[0]).id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("should parse ISO 8601 timestamps", async () => {
      const backendResponse: Connection[] = [
        createMockConnection({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: "Test",
          type: "smb",
          host: "192.168.1.1",
          port: 445,
          share_name: "share",
          username: "user",
          path_prefix: "/",
          created_at: "2024-01-15T10:30:45Z",
          updated_at: "2024-02-20T14:25:30.123Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();

      // Timestamps should be ISO 8601 strings
      expect(requireTestValue(result[0]).created_at).toBe("2024-01-15T10:30:45Z");
      expect(requireTestValue(result[0]).updated_at).toBe("2024-02-20T14:25:30.123Z");

      // Should be parseable as dates
      expect(new Date(requireTestValue(result[0]).created_at).toISOString()).toBeTruthy();
      expect(new Date(requireTestValue(result[0]).updated_at).toISOString()).toBeTruthy();
    });

    it("should handle empty connections array", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: [],
      } as AxiosResponse);

      const result = await apiService.getConnections();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it("should handle multiple connections", async () => {
      const backendResponse: Connection[] = [
        createMockConnection({
          id: "123e4567-e89b-12d3-a456-426614174000",
          name: "Server 1",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "share1",
          username: "user1",
          path_prefix: "/",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        }),
        createMockConnection({
          id: "223e4567-e89b-12d3-a456-426614174001",
          name: "Server 2",
          type: "smb",
          host: "192.168.1.200",
          port: 445,
          share_name: "share2",
          username: "user2",
          path_prefix: "/data",
          created_at: "2024-01-02T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        }),
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getConnections();

      expect(result).toHaveLength(2);
      expect(requireTestValue(result[0]).name).toBe("Server 1");
      expect(requireTestValue(result[1]).name).toBe("Server 2");
    });
  });

  describe("Contract Tests - POST /connections", () => {
    it("should return created connection with ID", async () => {
      const createRequest: ConnectionCreate = {
        name: "New Server",
        type: "smb",
        host: "192.168.1.50",
        port: 445,
        share_name: "newshare",
        username: "newuser",
        password: "password123",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
      };

      const backendResponse: Connection = createMockConnection({
        id: "323e4567-e89b-12d3-a456-426614174002",
        name: "New Server",
        type: "smb",
        host: "192.168.1.50",
        port: 445,
        share_name: "newshare",
        username: "newuser",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-03-01T10:00:00Z",
        updated_at: "2024-03-01T10:00:00Z",
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.createConnection(createRequest);

      // Should return Connection (not ConnectionCreate)
      expect(result).toHaveProperty("id");
      expect(result).not.toHaveProperty("password");
      expect(result.id).toBeTruthy();
      expect(typeof result.id).toBe("string");
    });

    it("should not include password in response", async () => {
      const createRequest: ConnectionCreate = {
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        password: "secret123",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
      };

      const backendResponse: Connection = createMockConnection({
        id: "423e4567-e89b-12d3-a456-426614174003",
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-03-01T10:00:00Z",
        updated_at: "2024-03-01T10:00:00Z",
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.createConnection(createRequest);

      // Password should NOT be in response
      expect(result).not.toHaveProperty("password");
      expect(result).not.toHaveProperty("password_encrypted");
    });

    it("should match Connection type structure", async () => {
      const createRequest: ConnectionCreate = {
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        password: "pass",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
      };

      const backendResponse: Connection = createMockConnection({
        id: "523e4567-e89b-12d3-a456-426614174004",
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-03-01T10:00:00Z",
        updated_at: "2024-03-01T10:00:00Z",
      });

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.createConnection(createRequest);

      // Should have all Connection fields
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("host");
      expect(result).toHaveProperty("port");
      expect(result).toHaveProperty("share_name");
      expect(result).toHaveProperty("username");
      expect(result).toHaveProperty("path_prefix");
      expect(result).toHaveProperty("created_at");
      expect(result).toHaveProperty("updated_at");
    });
  });

  describe("Contract Tests - PUT /connections/{id}", () => {
    it("should return updated connection", async () => {
      const connectionId = "623e4567-e89b-12d3-a456-426614174005";
      const updates: Partial<ConnectionCreate> = {
        name: "Updated Name",
        share_name: "updated_share",
      };

      const backendResponse: Connection = createMockConnection({
        id: connectionId,
        name: "Updated Name",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "updated_share",
        username: "user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-03-01T15:00:00Z", // Updated timestamp
      });

      mockAxiosInstance.put.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.updateConnection(connectionId, updates);

      // Should return full Connection object
      expect(result.id).toBe(connectionId);
      expect(result.name).toBe("Updated Name");
      expect(result.share_name).toBe("updated_share");
    });

    it("should update updated_at timestamp", async () => {
      const connectionId = "723e4567-e89b-12d3-a456-426614174006";
      const originalTimestamp = "2024-01-01T00:00:00Z";
      const updatedTimestamp = "2024-03-01T16:30:00Z";

      const backendResponse: Connection = createMockConnection({
        id: connectionId,
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: originalTimestamp,
        updated_at: updatedTimestamp,
      });

      mockAxiosInstance.put.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.updateConnection(connectionId, {
        name: "Test",
      });

      // created_at should stay same, updated_at should change
      expect(result.created_at).toBe(originalTimestamp);
      expect(result.updated_at).toBe(updatedTimestamp);
      expect(result.updated_at).not.toBe(result.created_at);
    });

    it("should match Connection type structure", async () => {
      const connectionId = "823e4567-e89b-12d3-a456-426614174007";

      const backendResponse: Connection = createMockConnection({
        id: connectionId,
        name: "Test",
        type: "smb",
        host: "192.168.1.1",
        port: 445,
        share_name: "share",
        username: "user",
        path_prefix: "/",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-03-01T00:00:00Z",
      });

      mockAxiosInstance.put.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.updateConnection(connectionId, {});

      // Should have all Connection fields
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("host");
      expect(result).toHaveProperty("port");
      expect(result).toHaveProperty("share_name");
      expect(result).toHaveProperty("username");
      expect(result).toHaveProperty("path_prefix");
      expect(result).toHaveProperty("created_at");
      expect(result).toHaveProperty("updated_at");
    });
  });

  describe("Contract Tests - DELETE /connections/{id}", () => {
    it("should handle successful deletion with no response body", async () => {
      const connectionId = "923e4567-e89b-12d3-a456-426614174008";

      mockAxiosInstance.delete.mockResolvedValueOnce({
        data: undefined,
      } as AxiosResponse);

      // Should not throw
      await expect(apiService.deleteConnection(connectionId)).resolves.toBeUndefined();

      // Verify correct endpoint was called
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(`/connections/${connectionId}`);
    });

    it("should handle empty object response", async () => {
      const connectionId = "a23e4567-e89b-12d3-a456-426614174009";

      mockAxiosInstance.delete.mockResolvedValueOnce({
        data: {},
      } as AxiosResponse);

      await expect(apiService.deleteConnection(connectionId)).resolves.toBeUndefined();
    });
  });

  describe("Contract Tests - POST /connections/{id}/test", () => {
    it("should return test result format with success status", async () => {
      const connectionId = "b23e4567-e89b-12d3-a456-426614174010";
      const connectionDraft = {
        host: "draft-host.invalid",
        port: 445,
        share_name: "draft-share",
        username: "draft-user",
        path_prefix: "/draft-path",
      };

      const backendResponse = {
        status: "success",
        message: "Connection test successful",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.testConnection(connectionId, connectionDraft);

      // Verify structure
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("message");

      // Verify types
      expect(typeof result.status).toBe("string");
      expect(typeof result.message).toBe("string");

      // Verify values
      expect(result.status).toBe("success");
      expect(result.message).toBeTruthy();
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(`/connections/${connectionId}/test`, connectionDraft);
    });

    it("should handle error status", async () => {
      const connectionId = "c23e4567-e89b-12d3-a456-426614174011";

      const backendResponse = {
        status: "error",
        message: "Connection failed: Host unreachable",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.testConnection(connectionId);

      expect(result.status).toBe("error");
      expect(result.message).toContain("Connection failed");
    });

    it("should handle success status", async () => {
      const connectionId = "d23e4567-e89b-12d3-a456-426614174012";

      const backendResponse = {
        status: "success",
        message: "Successfully connected to \\\\192.168.1.100\\share",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.testConnection(connectionId);

      expect(result.status).toBe("success");
      expect(result.message).toBeTruthy();
    });
  });

  describe("Error Handling", () => {
    it("should handle 404 on get connections", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Not found" },
        },
      });

      await expect(apiService.getConnections()).rejects.toMatchObject({
        response: { status: 404 },
      });
    });

    it("should handle validation errors on create", async () => {
      const invalidConnection: ConnectionCreate = {
        scope: "private",
        access_mode: "read_write",
        name: "",
        type: "smb",
        host: "",
        port: 445,
        share_name: "",
        username: "",
        password: "",
        path_prefix: "/",
      };

      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 422,
          data: {
            detail: [
              {
                loc: ["body", "name"],
                msg: "Field cannot be empty",
                type: "value_error",
              },
            ],
          },
        },
      });

      await expect(apiService.createConnection(invalidConnection)).rejects.toMatchObject({
        response: { status: 422 },
      });
    });

    it("should handle 404 on delete non-existent connection", async () => {
      const nonExistentId = "e23e4567-e89b-12d3-a456-426614174013";

      mockAxiosInstance.delete.mockRejectedValueOnce({
        response: {
          status: 404,
          data: { detail: "Connection not found" },
        },
      });

      await expect(apiService.deleteConnection(nonExistentId)).rejects.toMatchObject({
        response: { status: 404 },
      });
    });
  });
});
