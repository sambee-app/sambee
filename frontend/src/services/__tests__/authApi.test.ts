import { requireTestValue } from "../../test/helpers/assertions";
/**
 * Contract tests for Authentication API
 *
 * Ensures frontend types match backend API responses for authentication endpoints
 */

import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthToken, User } from "../../types";

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
      get: vi.fn(), // Standalone get for authConfig
    },
  };
});

import axios from "axios";
import { apiService } from "../api";
import { clearAuthConfigCache, getAuthConfig, parseAuthConfig } from "../authConfig";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

// Also need to mock the standalone axios.get for authConfig
const mockAxiosGet = axios.get as ReturnType<typeof vi.fn>;

describe("Authentication API Contract Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    clearAuthConfigCache();
  });

  describe("Contract Tests - GET /auth/config", () => {
    it("should return correct auth config format", async () => {
      clearAuthConfigCache();
      const backendResponse = {
        sign_in_mode: "password_only" as const,
        oidc: null,
      };

      mockAxiosGet.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const config = await getAuthConfig();

      expect(config).toEqual({ sign_in_mode: "password_only", oidc: null });
    });

    it("should handle canonical no-auth configuration", async () => {
      clearAuthConfigCache();
      const backendResponse = {
        sign_in_mode: "none" as const,
        oidc: null,
      };

      mockAxiosGet.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const config = await getAuthConfig();
      expect(config.sign_in_mode).toBe("none");
    });

    it("should accept canonical OIDC configuration", async () => {
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          sign_in_mode: "oidc_or_password",
          oidc: { display_name: "Company SSO", authorization_path: "/api/auth/oidc/authorize" },
        },
      } as AxiosResponse);

      await expect(getAuthConfig()).resolves.toEqual({
        sign_in_mode: "oidc_or_password",
        oidc: { display_name: "Company SSO", authorization_path: "/api/auth/oidc/authorize" },
      });
    });

    it("should reject malformed canonical configuration", () => {
      expect(() => parseAuthConfig({ sign_in_mode: "oidc_only" })).toThrow("OIDC authentication configuration is incomplete");
    });

    it("should reject retired auth-method payloads", () => {
      expect(() => parseAuthConfig({ auth_method: "password" })).toThrow("Invalid authentication configuration");
    });
  });
  describe("Contract Tests - POST /auth/token", () => {
    it("should return correct token response format", async () => {
      const backendResponse: AuthToken = {
        access_token: "test-token-123",
        token_type: "bearer",
        username: "testuser",
        role: "editor",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.login("testuser", "password");

      // Verify all required fields are present
      expect(result).toHaveProperty("access_token");
      expect(result).toHaveProperty("token_type");
      expect(result).toHaveProperty("username");
      expect(result).toHaveProperty("role");

      // Verify types
      expect(typeof result.access_token).toBe("string");
      expect(typeof result.token_type).toBe("string");
      expect(typeof result.username).toBe("string");
      expect(typeof result.role).toBe("string");

      // Verify values
      expect(result.access_token).toBe("test-token-123");
      expect(result.token_type).toBe("bearer");
      expect(result.username).toBe("testuser");
      expect(result.role).toBe("editor");
    });

    it("should handle admin user token response", async () => {
      const backendResponse: AuthToken = {
        access_token: "admin-token-456",
        token_type: "bearer",
        username: "admin",
        role: "admin",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.login("admin", "adminpass");

      expect(result.role).toBe("admin");
      expect(result.username).toBe("admin");
    });

    it("should handle non-admin user token response", async () => {
      const backendResponse: AuthToken = {
        access_token: "user-token-789",
        token_type: "bearer",
        username: "regularuser",
        role: "editor",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.login("regularuser", "userpass");

      expect(result.role).toBe("editor");
      expect(result.username).toBe("regularuser");
    });
  });

  describe("Contract Tests - GET /auth/me", () => {
    it("should return correct user format", async () => {
      const backendResponse: User = {
        username: "testuser",
        role: "editor",
        created_at: "2024-01-01T00:00:00Z",
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      // Verify all required fields are present
      expect(result).toHaveProperty("username");
      expect(result).toHaveProperty("role");

      // Verify types
      expect(typeof result.username).toBe("string");
      expect(typeof result.role).toBe("string");

      // Verify values
      expect(result.username).toBe("testuser");
      expect(result.role).toBe("editor");
    });

    it("should include created_at timestamp when provided", async () => {
      const backendResponse: User = {
        username: "testuser",
        role: "editor",
        created_at: "2024-01-01T12:30:45Z",
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      // Verify optional field
      expect(result).toHaveProperty("created_at");
      expect(typeof result.created_at).toBe("string");
      expect(result.created_at).toBe("2024-01-01T12:30:45Z");
    });

    it("should handle admin user info", async () => {
      const backendResponse: User = {
        username: "admin",
        role: "admin",
        created_at: "2023-12-01T00:00:00Z",
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      expect(result.username).toBe("admin");
      expect(result.role).toBe("admin");
    });

    it("should handle user without created_at timestamp", async () => {
      const backendResponse: User = {
        username: "testuser",
        role: "editor",
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: backendResponse,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      expect(result.username).toBe("testuser");
      expect(result.role).toBe("editor");
      // created_at is optional, may or may not be present
    });
  });

  describe("Contract Tests - POST /auth/change-password", () => {
    it("should handle successful password change", async () => {
      // Backend returns empty response for successful password change
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {},
      } as AxiosResponse);

      // Should not throw
      await expect(apiService.changePassword("oldpass", "newpass")).resolves.toBeUndefined();

      // Verify correct request was made
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/auth/change-password", {
        current_password: "oldpass",
        new_password: "newpass",
      });
    });

    it("should send correct request format", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {},
      } as AxiosResponse);

      await apiService.changePassword("current123", "new456");

      // Verify request structure
      const callArgs = requireTestValue(mockAxiosInstance.post.mock.calls[0]);
      expect(callArgs[0]).toBe("/auth/change-password");
      expect(callArgs[1]).toEqual({
        current_password: "current123",
        new_password: "new456",
      });
    });
  });

  describe("Error Handling", () => {
    it("should handle 401 unauthorized on login", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { detail: "Incorrect username or password" },
        },
      });

      await expect(apiService.login("wrong", "credentials")).rejects.toMatchObject({
        response: { status: 401 },
      });
    });

    it("should handle network error on auth config fetch", async () => {
      clearAuthConfigCache();
      mockAxiosGet.mockRejectedValueOnce(new Error("Network error"));

      await expect(getAuthConfig()).rejects.toThrow("Network error");
    });
    it("should handle 401 on getCurrentUser", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: {
          status: 401,
          data: { detail: "Not authenticated" },
        },
      });

      await expect(apiService.getCurrentUser()).rejects.toMatchObject({
        response: { status: 401 },
      });
    });
  });
});
