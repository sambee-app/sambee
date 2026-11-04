import type { AxiosResponse } from "axios";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

// Mock axios before importing the API service
vi.mock("axios", () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: "/api" },
    getUri: vi.fn(() => "http://localhost:21549/api/browse/private-drive/directories"),
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
    },
  };
});

import axios from "axios";
import apiService from "../api";
import { authSession } from "../authSession";
import { companionSession } from "../companionSession";
import { COMPANION_SETTINGS_CHANGED_EVENT } from "../companionSettingsEvents";
import { logger } from "../logger";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  post: ReturnType<typeof vi.fn>;
};
const companionRequestInterceptor = vi.mocked(mockAxiosInstance.interceptors.request.use).mock.calls.at(-1)?.[0];
const companionResponseInterceptors = vi.mocked(mockAxiosInstance.interceptors.response.use).mock.calls.at(-1);

describe("Companion API", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    // Mock window.location.origin
    Object.defineProperty(window, "location", {
      value: { origin: "https://sambee.example.com", href: "" },
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    {
      status: 200,
      code: undefined,
      cancelled: false,
      url: "/browse/private-drive/directories",
      route: "/browse/{drive}/directories",
      revision: 7,
    },
    {
      status: 503,
      code: "ERR_BAD_RESPONSE",
      cancelled: false,
      url: "/browse/private-drive/directories",
      route: "/browse/{drive}/directories",
      revision: undefined,
    },
    {
      status: null,
      code: "ERR_CANCELED",
      cancelled: true,
      url: "/browse/private-drive/directories",
      route: "/browse/{drive}/directories",
      revision: undefined,
    },
    {
      status: 200,
      code: undefined,
      cancelled: false,
      url: "/browse/private-drive/private-filename?token=private-token",
      route: "/{route}",
      revision: "private-revision",
    },
  ])(
    "logs private-safe companion timing for status $status cancellation $cancelled",
    async ({ status, code, cancelled, url, route, revision }) => {
      const { AxiosError, AxiosHeaders } = await vi.importActual<typeof import("axios")>("axios");
      assert(companionRequestInterceptor);
      assert(companionResponseInterceptors?.[0]);
      assert(companionResponseInterceptors?.[1]);
      const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
      vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValue({ "X-Companion-Secret": "private-signature" });
      vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValue(125);
      const config = await companionRequestInterceptor({
        method: "get",
        url,
        headers: new AxiosHeaders({ Authorization: "private-authorization" }),
        params: { q: "private-terms", path: "private-path", hmac: "private-signed-value" },
        data: { grant: "private-grant" },
      });
      const response = {
        config,
        status: status ?? 0,
        statusText: "private-status-text",
        headers: new AxiosHeaders(),
        data: { accepted_revision: revision },
      };
      if (code) {
        const error = new AxiosError("private-error-message", code, config, undefined, status === null ? undefined : response);
        await expect(companionResponseInterceptors[1](error)).rejects.toBe(error);
      } else {
        expect(companionResponseInterceptors[0](response)).toBe(response);
      }
      expect(debug).toHaveBeenCalledWith(
        "Companion API request finished",
        {
          method: "GET",
          route,
          status,
          duration_ms: 25,
          cancelled,
          ...(typeof revision === "number" ? { accepted_revision: revision } : {}),
        },
        "companion"
      );
      expect(debug).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(debug.mock.calls)).not.toContain("private-");
    }
  );

  describe("getCompanionUri()", () => {
    it("does not send URI themes after pairing", async () => {
      localStorage.setItem("companion_secret", "shared-secret");
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { uri_token: "paired-token", expires_in: 60 } } as AxiosResponse);
      const uri = await apiService.getCompanionUri(
        "conn-1",
        "file.txt",
        JSON.stringify({ id: "sambee-dark", mode: "dark", primary: { main: "#D4A020" } })
      );
      expect(uri).not.toContain("theme=");
    });

    it("builds a sambee:// URI with server, token, connection, and path", async () => {
      mockAxiosInstance.defaults.baseURL = "/api";
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { uri_token: "test-uri-token-123", expires_in: 60 },
      } as AxiosResponse);

      const uri = await apiService.getCompanionUri("conn-1", "Documents/report.docx");

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/companion/uri-token", {
        connection_id: "conn-1",
        path: "Documents/report.docx",
      });

      expect(uri).toContain("sambee://open?");
      expect(uri).toContain("server=https%3A%2F%2Fsambee.example.com");
      expect(uri).toContain("token=test-uri-token-123");
      expect(uri).toContain("connId=conn-1");
      expect(uri).toContain("path=Documents%2Freport.docx");
    });

    it("includes base64-encoded theme when provided", async () => {
      mockAxiosInstance.defaults.baseURL = "/api";
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { uri_token: "tok-456", expires_in: 60 },
      } as AxiosResponse);

      const themeJson = JSON.stringify({ id: "dark", mode: "dark", primary: { main: "#90caf9" } });
      const uri = await apiService.getCompanionUri("conn-2", "Photos/img.jpg", themeJson);

      const expectedThemeB64 = btoa(themeJson);
      expect(uri).toContain(`theme=${expectedThemeB64}`);
    });

    it("omits theme parameter when not provided", async () => {
      mockAxiosInstance.defaults.baseURL = "/api";
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { uri_token: "tok-789", expires_in: 60 },
      } as AxiosResponse);

      const uri = await apiService.getCompanionUri("conn-3", "file.txt");

      expect(uri).not.toContain("theme=");
    });

    it("encodes special characters in path", async () => {
      mockAxiosInstance.defaults.baseURL = "/api";
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { uri_token: "tok-special", expires_in: 60 },
      } as AxiosResponse);

      const uri = await apiService.getCompanionUri("conn-1", "My Files/report (1).docx");

      expect(uri).toContain("path=My%20Files%2Freport%20(1).docx");
    });

    it("propagates API errors", async () => {
      mockAxiosInstance.defaults.baseURL = "/api";
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: { status: 401, data: { detail: "Not authenticated" } },
      });

      await expect(apiService.getCompanionUri("conn-1", "file.txt")).rejects.toEqual(
        expect.objectContaining({
          response: expect.objectContaining({ status: 401 }),
        })
      );
    });

    it("uses the backend server root when the API base URL is absolute", async () => {
      mockAxiosInstance.defaults.baseURL = "https://api.sambee.example.com/api";
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { uri_token: "tok-absolute", expires_in: 60 },
      } as AxiosResponse);

      const uri = await apiService.getCompanionUri("conn-4", "Documents/report.docx");

      expect(uri).toContain("server=https%3A%2F%2Fapi.sambee.example.com");
      expect(uri).not.toContain("server=https%3A%2F%2Fsambee.example.com");
    });
  });

  it.each([false, true])("guards theme delivery notifications when identity changed=%s", async (changed) => {
    const identity = vi.spyOn(authSession, "getIdentity").mockReturnValue({ epoch: 1, userId: "first-user" });
    let complete!: (value: AxiosResponse) => void;
    const write = vi.spyOn(mockAxiosInstance, "put").mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      })
    );
    const notification = vi.fn();
    window.addEventListener(COMPANION_SETTINGS_CHANGED_EVENT, notification);
    try {
      const pending = apiService.setSiteDefaultTheme("sambee-dark");
      if (changed) identity.mockReturnValue({ epoch: 2, userId: "second-user" });
      complete({ data: {} } as AxiosResponse);
      await pending;
      expect(notification).toHaveBeenCalledTimes(changed ? 0 : 1);
    } finally {
      window.removeEventListener(COMPANION_SETTINGS_CHANGED_EVENT, notification);
      identity.mockRestore();
      write.mockRestore();
    }
  });
});
