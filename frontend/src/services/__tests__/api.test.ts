import type { AxiosResponse } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAuthToken } from "../../test/fixtures/users";
import type {
  AdvancedSystemSettings,
  AuthToken,
  CompanionDownloadMetadata,
  Connection,
  ConnectionCreate,
  CurrentUserSettings,
  DirectoryListing,
  SmbSettings,
  User,
} from "../../types";
import { FileType } from "../../types";
import { randomUuid } from "../../utils/randomUuid";

// Mock axios before importing the API service - use factory function
// The factory needs to define the mock instance inside
vi.mock("axios", () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
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
      isAxiosError: vi.fn((error: unknown) => Boolean(error && typeof error === "object" && "isAxiosError" in error)),
      isCancel: vi.fn(() => false),
    },
  };
});

// Get reference to the mocked functions for assertions
import axios from "axios";
// Now import the API service (it will use the mocked axios.create)
import apiService, {
  ExpiredEditLockError,
  OIDC_FINALIZATION_REQUEST_TIMEOUT_MS,
  setOidcExchangePending,
  startControlledReauthentication,
} from "../api";
import { AuthSessionError, authSession } from "../authSession";
import { getBackendAvailabilitySnapshot, markBackendUnavailable, resetBackendAvailabilityForTests } from "../backendAvailability";
import * as backendRouter from "../backendRouter";
import { companionSession } from "../companionSession";
import * as draftRecovery from "../draftRecovery";
import { logger } from "../logger";

const mockedAxios = vi.mocked(axios);
const mockAxiosInstance = mockedAxios.create() as ReturnType<typeof mockedAxios.create> & {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
};
const requestInterceptorUse = vi.mocked(mockAxiosInstance.interceptors.request.use);
const requestInterceptorHandlers = requestInterceptorUse.mock.calls[0] as
  | [
      ((config: { url?: string; method?: string; headers: Record<string, string> }) => Promise<unknown>)?,
      ((error: unknown) => Promise<never>)?,
    ]
  | undefined;
const requestHandler = requestInterceptorHandlers?.[0];
const responseInterceptorUse = vi.mocked(mockAxiosInstance.interceptors.response.use);
const responseInterceptorHandlers = responseInterceptorUse.mock.calls[0] as
  | [((response: AxiosResponse) => AxiosResponse | Promise<AxiosResponse>)?, ((error: unknown) => Promise<never>)?]
  | undefined;
const responseSuccessHandler = responseInterceptorHandlers?.[0];
const responseErrorHandler = responseInterceptorHandlers?.[1];

describe("API Service", () => {
  const fetchMock = vi.fn();
  const uploadRequests: MockUploadRequest[] = [];

  class MockUploadRequest {
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null, onload: null as (() => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 200;
    statusText = "OK";
    responseText = JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } });
    url = "";
    headers: Record<string, string> = {};
    body: File | null = null;
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(file: File) {
      this.body = file;
      uploadRequests.push(this);
    }
    abort() {
      this.onabort?.();
    }
  }

  beforeEach(() => {
    setOidcExchangePending(false);
    // Clear localStorage
    localStorage.clear();
    authSession.clear();
    resetBackendAvailabilityForTests();

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("XMLHttpRequest", MockUploadRequest);
    uploadRequests.length = 0;

    // Reset all mock function calls
    vi.clearAllMocks();
  });

  afterEach(() => {
    setOidcExchangePending(false);
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("OIDC request classification", () => {
    it.each(["oidc_reauthentication_required", undefined])("ignores obsolete token 401s (%s)", async (code) => {
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer", user_id: "same-user" }), true);
      const request = (await requestHandler?.({ url: "/themes", method: "get", headers: {} })) as { headers: Record<string, string> };
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer", user_id: "same-user" }), true);
      markBackendUnavailable("Recovery in progress");
      const availabilityBeforeFailure = getBackendAvailabilitySnapshot();
      const refresh = vi.spyOn(authSession, "requestRefresh");
      const snapshot = vi.spyOn(draftRecovery, "snapshotRegisteredDrafts");
      const error = {
        response: { status: 401, data: code ? { detail: { code } } : {}, headers: {} },
        message: "Unauthorized",
        config: { url: "/themes", method: "get", headers: request.headers },
      };

      await expect(responseErrorHandler?.(error as never)).rejects.toBe(error);
      expect(refresh).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(window.location.assign).not.toHaveBeenCalled();
      expect(getBackendAvailabilitySnapshot()).toBe(availabilityBeforeFailure);
      const currentRequest = (await requestHandler?.({ url: "/themes", method: "get", headers: {} })) as {
        headers: Record<string, string>;
      };
      expect(currentRequest.headers["Authorization"]).toBe("Bearer session-b");
      responseSuccessHandler?.({ config: { method: "get", url: "/themes" }, status: 200, statusText: "OK" } as never);
      expect(window.location.assign).not.toHaveBeenCalled();
    });

    it("keeps current-token 401 handling and never replays a write", async () => {
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), true);
      const refresh = vi
        .spyOn(authSession, "requestRefresh")
        .mockResolvedValue(createMockAuthToken({ access_token: "renewed", token_type: "bearer" }));
      const error = {
        response: { status: 401, headers: {} },
        message: "Unauthorized",
        config: { url: "/themes", method: "get", headers: { Authorization: "Bearer session-b" } },
      };
      mockAxiosInstance.request.mockResolvedValue({ data: {} });
      await expect(responseErrorHandler?.(error as never)).resolves.toEqual({ data: {} });
      expect(refresh).toHaveBeenCalledOnce();

      const writeError = { ...error, config: { url: "/settings", method: "post", headers: { Authorization: "Bearer session-b" } } };
      await expect(responseErrorHandler?.(writeError as never)).rejects.toBe(writeError);
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    });

    it.each(["success", "failure"])("does not act on A's 401 when its refresh settles after B (%s)", async (outcome) => {
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), true);
      let finishRefresh!: (response: AuthToken) => void;
      let failRefresh!: (reason: Error) => void;
      const refresh = new Promise<AuthToken>((resolve, reject) => {
        finishRefresh = resolve;
        failRefresh = reject;
      });
      vi.spyOn(authSession, "requestRefresh").mockReturnValue(refresh);
      const snapshot = vi.spyOn(draftRecovery, "snapshotRegisteredDrafts");
      const error = {
        response: { status: 401, headers: {} },
        message: "Unauthorized",
        config: { url: "/themes", method: "get", headers: { Authorization: "Bearer session-a" } },
      };
      const pending = responseErrorHandler?.(error as never);
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), true);
      if (outcome === "success") finishRefresh(createMockAuthToken({ access_token: "old-refresh", token_type: "bearer" }));
      else failRefresh(new Error("Refresh failed"));

      await expect(pending).rejects.toBe(error);
      expect(authSession.getAccessToken()).toBe("session-b");
      expect(mockAxiosInstance.request).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(window.location.assign).not.toHaveBeenCalled();
    });

    it("does not redirect for a request-time refresh failure after B arrives", async () => {
      let failRefresh!: (reason: Error) => void;
      const refreshIfNeeded = vi.spyOn(authSession, "refreshIfNeeded").mockReturnValue(
        new Promise((_, reject) => {
          failRefresh = reject;
        })
      );
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-a", token_type: "bearer" }), true);
      const request = requestHandler?.({ url: "/themes", method: "get", headers: {} });
      authSession.setAuthenticated(createMockAuthToken({ access_token: "session-b", token_type: "bearer" }), true);
      failRefresh(new AuthSessionError("reauthentication-required", "Session expired"));
      await expect(request).rejects.toMatchObject({ code: "reauthentication-required" });
      expect(window.location.assign).not.toHaveBeenCalled();
      refreshIfNeeded.mockRestore();
    });

    it("suppresses exchange-time 401s even when they arrive after a failed exchange", async () => {
      setOidcExchangePending(true);
      const refresh = vi.spyOn(authSession, "requestRefresh");
      const config = await requestHandler?.({ url: "/themes", method: "get", headers: {} });
      expect(refresh).not.toHaveBeenCalled();
      const error = {
        response: { status: 401, data: { detail: { code: "oidc_reauthentication_required" } }, headers: {} },
        message: "Unauthorized",
        config,
      };
      await expect(responseErrorHandler?.(error as never)).rejects.toBe(error);
      expect(window.location.assign).not.toHaveBeenCalled();
      setOidcExchangePending(false);
      await expect(responseErrorHandler?.(error as never)).rejects.toBe(error);
      expect(window.location.assign).not.toHaveBeenCalled();
      const currentRequest = await requestHandler?.({ url: "/themes", method: "get", headers: {} });
      await expect(responseErrorHandler?.({ ...error, config: currentRequest } as never)).rejects.toMatchObject({
        response: error.response,
      });
      expect(window.location.assign).toHaveBeenCalledOnce();
    });

    it("refreshes before authenticated OIDC session-control requests", async () => {
      const refreshIfNeeded = vi.spyOn(authSession, "refreshIfNeeded").mockResolvedValue();

      await requestHandler?.({ url: "/auth/oidc/sessions", headers: {} });

      expect(refreshIfNeeded).toHaveBeenCalledOnce();
    });

    it("does not refresh before the public OIDC grant exchange", async () => {
      const refreshIfNeeded = vi.spyOn(authSession, "refreshIfNeeded").mockResolvedValue();

      await requestHandler?.({ url: "/auth/oidc/exchange", headers: {} });

      expect(refreshIfNeeded).not.toHaveBeenCalled();
    });

    it("retries a session-control 401 after refreshing the OIDC token", async () => {
      const requestRefresh = vi
        .spyOn(authSession, "requestRefresh")
        .mockResolvedValue({ access_token: "renewed-token", token_type: "bearer", username: "testuser" });
      mockAxiosInstance.request.mockResolvedValue({ data: { sessions: [] } });
      const error = {
        response: { status: 401, headers: {} },
        message: "Unauthorized",
        config: { url: "/auth/oidc/sessions", method: "get", headers: {} },
      };

      await expect(responseErrorHandler?.(error as never)).resolves.toEqual({ data: { sessions: [] } });

      expect(requestRefresh).toHaveBeenCalledOnce();
      expect(mockAxiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({ _oidcRetried: true }));
    });

    it("preserves drafts and redirects after a confirmed reauthentication response to a write", async () => {
      const snapshotDrafts = vi.spyOn(draftRecovery, "snapshotRegisteredDrafts");
      const error = {
        response: { status: 401, data: { detail: { code: "oidc_reauthentication_required" } }, headers: {} },
        message: "Unauthorized",
        config: { url: "/auth/change-password", method: "post", headers: {} },
      };

      await expect(responseErrorHandler?.(error as never)).rejects.toEqual(error);

      expect(snapshotDrafts).toHaveBeenCalledOnce();
      expect(window.location.assign).toHaveBeenCalledWith("/login?return_path=%2F");
      expect(authSession.requestRefresh).not.toHaveBeenCalled();
    });

    it("attempts a synchronous snapshot before sign-in without requiring a storage acknowledgement", () => {
      const snapshot = vi.fn(() => {
        expect(window.location.assign).not.toHaveBeenCalled();
        return { saved: false as const, reason: "storage-unavailable" as const };
      });
      const unregister = draftRecovery.registerDraftSnapshot(snapshot);
      try {
        startControlledReauthentication();
        expect(snapshot).toHaveBeenCalledOnce();
        expect(window.location.assign).toHaveBeenCalledOnce();
      } finally {
        unregister();
      }
    });

    it("preserves drafts and the browse return path at a no-refresh deadline", async () => {
      vi.spyOn(authSession, "refreshIfNeeded").mockRestore();
      const originalPathname = window.location.pathname;
      const originalSearch = window.location.search;
      const deadline = Date.now() + 30_000;
      authSession.setAuthenticated(
        createMockAuthToken({
          access_token: "expiring-token",
          token_type: "bearer",
          user_id: "user-1",
          oidc_session_capability: "reauthorization_only",
          oidc_session_expires_at: new Date(deadline).toISOString(),
          access_token_expires_at: new Date(deadline).toISOString(),
        }),
        true
      );
      const snapshotDrafts = vi.spyOn(draftRecovery, "snapshotRegisteredDrafts");
      window.location.pathname = "/browse/smb/demo";
      window.location.search = "?path=notes";
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
      try {
        await expect(requestHandler?.({ url: "/settings", method: "post", headers: {} })).rejects.toMatchObject({
          code: "reauthentication-required",
        });
        expect(snapshotDrafts).toHaveBeenCalled();
        expect(window.location.assign).toHaveBeenCalledWith("/login?return_path=%2Fbrowse%2Fsmb%2Fdemo%3Fpath%3Dnotes");
        expect(mockAxiosInstance.request).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
        window.location.pathname = originalPathname;
        window.location.search = originalSearch;
      }
    });
  });

  it("uses a bounded timeout for OIDC finalization", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: { configuration_revision: 3, identity_mapping_revision: 2, reauthentication_required: true },
    });

    await apiService.finalizeOidcConfiguration(
      "flow-id",
      {
        no_refresh_session_limit_hours: 8,
        sign_in_mode: "oidc_only",
        interactive_reauthentication_max_age_days: 30,
        admission_mode: "selected_groups",
        admission_groups: ["users"],
        role_assignment_mode: "uniform",
        uniform_role: "editor",
        role_mappings: { admin: ["admins"], editor: [], viewer: [] },
        auto_link_by_username: true,
      },
      [],
      1,
      []
    );

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/admin/auth/oidc/finalize",
      {
        flow_id: "flow-id",
        reviewed_policy: {
          sign_in_mode: "oidc_only",
          interactive_reauthentication_max_age_days: 30,
          no_refresh_session_limit_hours: 8,
          admission_mode: "selected_groups",
          admission_groups: ["users"],
          role_assignment_mode: "uniform",
          uniform_role: "editor",
          role_mappings: { admin: ["admins"], editor: [], viewer: [] },
          auto_link_by_username: true,
        },
        replacement_mappings: [],
        expected_identity_mapping_revision: 1,
        omitted_account_acknowledgements: [],
      },
      { timeout: OIDC_FINALIZATION_REQUEST_TIMEOUT_MS }
    );
  });

  it("phase_10_stabilization_api_requires_a_supplied_idempotency_key", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);

    await apiService.copyItem("connection", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000003");

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/browse/connection/copy",
      expect.objectContaining({ idempotency_key: "00000000-0000-4000-8000-000000000003" }),
      expect.anything()
    );
  });

  it("routes a same-provider move with its idempotency key", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "mutated", destination: "mutated" } },
    } as AxiosResponse);

    await apiService.moveItem("connection", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000004");

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/browse/connection/move",
      expect.objectContaining({ idempotency_key: "00000000-0000-4000-8000-000000000004" }),
      expect.anything()
    );
  });

  it("generates secure v4 IDs for copy and move without randomUUID", async () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xff));
    vi.stubGlobal("crypto", { getRandomValues });
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);

    expect(randomUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    await apiService.copyItem("connection", "source.txt", "destination.txt", "copy-key");
    await apiService.moveItem("connection", "source.txt", "destination.txt", "move-key");

    expect(getRandomValues).toHaveBeenCalledTimes(3);
    for (const [, body] of mockAxiosInstance.post.mock.calls) {
      expect(body.transfer_attempt_id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    }
  });

  it("forwards cancellation to a same-provider transfer request", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);
    const abortController = new AbortController();

    await apiService.copyItem("connection", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000006", undefined, "ask", {
      signal: abortController.signal,
    });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/browse/connection/copy",
      expect.anything(),
      expect.objectContaining({ signal: abortController.signal })
    );
  });

  it("cancels an active same-provider transfer attempt when aborted", async () => {
    let resolveCopyResponse: (response: AxiosResponse) => void;
    const copyResponse = new Promise<AxiosResponse>((resolve) => {
      resolveCopyResponse = resolve;
    });
    mockAxiosInstance.post.mockReturnValueOnce(copyResponse).mockResolvedValueOnce({
      data: { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } },
    } as AxiosResponse);
    const abortController = new AbortController();

    const transfer = apiService.copyItem(
      "connection",
      "source.txt",
      "destination.txt",
      "00000000-0000-4000-8000-000000000008",
      undefined,
      "ask",
      { signal: abortController.signal, transferAttemptId: "attempt-123" }
    );

    await vi.waitFor(() => expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1));
    abortController.abort();

    await vi.waitFor(() =>
      expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
        2,
        "/browse/connection/transfer-attempts/attempt-123/cancel",
        {},
        expect.not.objectContaining({ signal: abortController.signal })
      )
    );

    resolveCopyResponse!({
      data: { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } },
    } as AxiosResponse);
    await expect(transfer).resolves.toMatchObject({ status: "cancelled" });
  });

  it("routes a cross-connection SMB copy through the active backend transfer path", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);

    await expect(
      apiService.copyItem("source", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000005", "destination")
    ).resolves.toMatchObject({ status: "completed" });

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/browse/source/copy",
      expect.objectContaining({
        source_path: "source.txt",
        dest_connection_id: "destination",
        dest_path: "destination.txt",
        idempotency_key: "00000000-0000-4000-8000-000000000005",
      }),
      expect.anything()
    );
  });

  it.each(["copy", "move"] as const)("routes a cross-connection SMB directory %s through the staged backend path", async (operation) => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source", path: "source", type: FileType.DIRECTORY, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);

    await apiService[operation === "copy" ? "copyItem" : "moveItem"](
      "source",
      "source",
      "destination/source",
      "00000000-0000-4000-8000-000000000007",
      "destination"
    );

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      `/browse/source/${operation}`,
      expect.objectContaining({ dest_connection_id: "destination" }),
      expect.anything()
    );
  });

  it.each(["copy", "move"] as const)("routes a cross-drive local %s through the Companion endpoint", async (operation) => {
    localStorage.setItem("companion_secret", "test-companion-secret");
    mockAxiosInstance.post.mockResolvedValue({
      data: { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } },
    } as AxiosResponse);

    await apiService[operation === "copy" ? "copyItem" : "moveItem"](
      "local-drive:c",
      "source.txt",
      "output/source.txt",
      "00000000-0000-4000-8000-000000000006",
      "local-drive:d"
    );

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      `/browse/c/${operation}`,
      expect.objectContaining({ dest_connection_id: "local-drive:d" }),
      expect.anything()
    );
    expect(mockAxiosInstance.post).not.toHaveBeenCalledWith(
      expect.stringContaining("transfer-operations"),
      expect.anything(),
      expect.anything()
    );
  });

  it("relays a cross-provider regular file", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: {
        name: "source.txt",
        path: "source.txt",
        type: FileType.FILE,
        size: 0,
        modified_at: "2026-09-07T12:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    } as AxiosResponse);
    const sourceResponse = new Response(new ReadableStream({ start: (controller) => controller.close() }));
    fetchMock.mockResolvedValueOnce(sourceResponse).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }), {
        status: 200,
      })
    );

    await expect(apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt")).resolves.toMatchObject({
      status: "completed",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost:3000/api/viewer/source/download?path=source.txt", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3000/api/browse/destination/transfer-stream?path=target.txt&target_resolution_policy=ask&expected_size=0&source_modified_at=2026-09-07T12%3A00%3A00Z",
      expect.objectContaining({ body: expect.anything(), duplex: "half" })
    );
  });

  it("publishes a browser file through the staged destination endpoint", async () => {
    const file = new File(["hello"], "report.txt", { lastModified: Date.UTC(2026, 8, 7, 12) });
    file.stream = vi.fn(() => {
      throw new Error("File stream must not be read");
    });

    const result = apiService.publishBrowserFile(file, "destination", "folder/report.txt", "ask");
    await vi.waitFor(() => expect(uploadRequests).toHaveLength(1));
    const request = uploadRequests[0]!;
    request.onload?.();
    await expect(result).resolves.toMatchObject({
      status: "completed",
    });

    expect(request.url).toBe(
      "http://localhost:3000/api/browse/destination/transfer-stream?path=folder%2Freport.txt&target_resolution_policy=ask&expected_size=5&source_modified_at=2026-09-07T12%3A00%3A00.000Z"
    );
    expect(request.body).toBe(file);
    expect(file.stream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the same File with XHR for HTTP and HTTPS destinations", async () => {
    const file = new File(["hello"], "report.txt");
    file.stream = vi.fn(() => {
      throw new Error("File stream must not be read");
    });
    const baseUrl = vi.spyOn(backendRouter, "getBaseUrl");
    try {
      for (const scheme of ["http", "https"]) {
        baseUrl.mockReturnValue(`${scheme}://example.test/api`);
        const result = apiService.publishBrowserFile(file, "destination", "report.txt");
        await vi.waitFor(() => expect(uploadRequests).toHaveLength(scheme === "http" ? 1 : 2));
        const request = uploadRequests[uploadRequests.length - 1]!;
        expect(request.url).toMatch(new RegExp(`^${scheme}://example\\.test/api/`));
        expect(request.body).toBe(file);
        request.onload?.();
        await expect(result).resolves.toMatchObject({ status: "completed" });
      }
      expect(file.stream).not.toHaveBeenCalled();
    } finally {
      baseUrl.mockRestore();
    }
  });

  it("reports bytes sent and waits for publication confirmation", async () => {
    const file = new File(["hello"], "report.txt");
    const onProgress = vi.fn();
    const onUploadSent = vi.fn();
    const result = apiService.publishBrowserFile(file, "destination", "report.txt", "ask", { onProgress, onUploadSent });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(uploadRequests).toHaveLength(1));
    const request = uploadRequests[0]!;
    expect(request.headers["Content-Type"]).toBe("application/octet-stream");
    request.upload.onprogress?.({ lengthComputable: false, loaded: 2 } as ProgressEvent);
    request.upload.onprogress?.({ lengthComputable: true, loaded: 2 } as ProgressEvent);
    request.upload.onprogress?.({ lengthComputable: true, loaded: 5 } as ProgressEvent);
    expect(onProgress.mock.calls).toEqual([
      [2, 5],
      [5, 5],
    ]);
    request.upload.onload?.();
    expect(onUploadSent).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    request.onload?.();
    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(request.upload.onprogress).toBeNull();
    expect(request.onload).toBeNull();
  });

  it("cancels before sending and treats a network error after sending as uncertain", async () => {
    const file = new File(["hello"], "report.txt");
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiService.publishBrowserFile(file, "destination", "report.txt", "ask", { signal: controller.signal })
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(uploadRequests).toHaveLength(0);

    const result = apiService.publishBrowserFile(file, "destination", "report.txt");
    await vi.waitFor(() => expect(uploadRequests).toHaveLength(1));
    uploadRequests[0]!.onerror?.();
    await expect(result).resolves.toMatchObject({ status: "outcome_unknown", effects: { destination: "unknown" } });
  });

  it("treats a timed-out or zero-status upload as uncertain", async () => {
    for (const fail of ["timeout", "zero-status"]) {
      const result = apiService.publishBrowserFile(new File(["hello"], "report.txt"), "destination", "report.txt");
      await vi.waitFor(() => expect(uploadRequests).toHaveLength(fail === "timeout" ? 1 : 2));
      const request = uploadRequests[uploadRequests.length - 1]!;
      if (fail === "timeout") request.ontimeout?.();
      else {
        request.status = 0;
        request.onload?.();
      }
      await expect(result).resolves.toMatchObject({ status: "outcome_unknown", effects: { destination: "unknown" } });
    }
  });

  it("returns conflict metadata for a browser file without implicit replacement", async () => {
    const file = new File([], "report.txt");
    const existing = { name: "report.txt", path: "folder/report.txt", type: FileType.FILE, size: 4, is_readable: true, is_hidden: false };
    mockAxiosInstance.get.mockResolvedValueOnce({ data: existing } as AxiosResponse);
    const result = apiService.publishBrowserFile(file, "destination", "folder/report.txt");
    await vi.waitFor(() => expect(uploadRequests).toHaveLength(1));
    const request = uploadRequests[0]!;
    request.status = 409;
    request.responseText = "Destination already exists";
    request.onload?.();

    await expect(result).rejects.toMatchObject({
      response: { status: 409, data: { detail: { existing_file: existing, incoming_file: { name: "report.txt", size: 0 } } } },
    });
    expect(request.url).toContain("target_resolution_policy=ask");
  });

  it("reports an interrupted browser-file destination request as outcome unknown", async () => {
    const file = new File([], "report.txt");
    const controller = new AbortController();
    const result = apiService.publishBrowserFile(file, "destination", "report.txt", "ask", { signal: controller.signal });
    await vi.waitFor(() => expect(uploadRequests).toHaveLength(1));
    controller.abort();
    await expect(result).resolves.toMatchObject({
      status: "outcome_unknown",
      effects: { destination: "unknown" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a selected-root ZIP without putting authentication in the URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["zip"]), { status: 200 }));
    const save = vi.spyOn(apiService, "saveDownloadBlob").mockImplementation(() => {});
    await apiService.downloadSelectionArchive("destination", ["folder", "file.txt"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/browse/destination/download-selection",
      expect.objectContaining({ method: "POST", body: '["folder","file.txt"]' })
    );
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "Sambee-download.zip");
  });

  it("aborts preparation before handing a physical file to the browser", async () => {
    const controller = new AbortController();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: "/api/viewer/download-intents/scoped-token" }), { status: 200 }));

    const download = apiService.downloadFile("destination", "report.txt", "report.txt", controller.signal);
    controller.abort();
    await download;

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/viewer/download-intents",
      expect.objectContaining({ method: "POST", signal: controller.signal })
    );
    expect(click).not.toHaveBeenCalled();
  });

  it("hands a single file to the browser without fetching its bytes", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href).toBe("http://localhost:3000/api/viewer/download-intents/scoped-token");
      expect(this.download).toBe("report.txt");
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: "/api/viewer/download-intents/scoped-token" }), { status: 200 }));

    await apiService.downloadFile("destination", "report.txt", "report.txt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledOnce();
  });

  it("hands a ZIP member to the browser through a server download intent", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: "/api/viewer/download-intents/member-token" }), { status: 200 }));

    await apiService.downloadArchiveMember("destination", "files.zip", "inner/report.txt", "report.txt");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3000/api/viewer/download-intents",
      expect.objectContaining({
        body: JSON.stringify({ connection_id: "destination", path: "files.zip", member_path: "inner/report.txt" }),
      })
    );
    expect(click).toHaveBeenCalledOnce();
  });

  it("issues a signed companion intent for a local ZIP member without fetching bytes", async () => {
    const sign = vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValueOnce({ "X-Companion-Secret": "signed" });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href).toBe("http://localhost:21549/api/download-intents/local-token");
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ url: "/api/download-intents/local-token" }), { status: 200 }));

    await apiService.downloadArchiveMember("local-drive:test", "files.zip", "inner/report.txt", "report.txt");

    expect(sign).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:21549/api/download-intents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ drive: "test", path: "files.zip", member_path: "inner/report.txt" }),
      })
    );
    expect(click).toHaveBeenCalledOnce();
  });

  it("authenticates local selection ZIPs with both Companion and backend sessions", async () => {
    vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValueOnce({
      "X-Companion-Secret": "signed",
      "X-Companion-Timestamp": "123",
    });
    vi.spyOn(authSession, "getAccessToken").mockReturnValueOnce("backend-token");
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["zip"]), { status: 200 }));
    const save = vi.spyOn(apiService, "saveDownloadBlob").mockImplementation(() => {});

    await apiService.downloadSelectionArchive("local-drive:test", ["folder"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:21549/api/browse/test/download-selection",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer backend-token", "X-Companion-Secret": "signed" }),
      })
    );
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "Sambee-download.zip");
  });

  it("authenticates local ZIP-member selection with both sessions", async () => {
    vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValueOnce({ "X-Companion-Secret": "signed" });
    vi.spyOn(authSession, "getAccessToken").mockReturnValueOnce("backend-token");
    fetchMock.mockResolvedValueOnce(new Response(new Blob(["zip"]), { status: 200 }));
    const save = vi.spyOn(apiService, "saveDownloadBlob").mockImplementation(() => {});

    await apiService.downloadZipSelectionArchive("local-drive:test", "source.zip", ["folder"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:21549/api/browse/test/archive/download-selection",
      expect.objectContaining({
        method: "POST",
        body: '{"archive_path":"source.zip","paths":["folder"]}',
        headers: expect.objectContaining({ Authorization: "Bearer backend-token", "X-Companion-Secret": "signed" }),
      })
    );
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "Sambee-download.zip");
  });

  it("does not begin a cross-provider relay when the source size is unknown", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
    } as AxiosResponse);

    await expect(apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt")).resolves.toMatchObject({
      status: "failed",
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "source_size_unknown" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("buffers a cross-provider source when stream upload is unavailable", async () => {
    class UnsupportedStreamUploadRequest {
      headers = new Headers({ "Content-Type": "text/plain" });
    }

    vi.stubGlobal("Request", UnsupportedStreamUploadRequest);
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }), {
          status: 200,
        })
      );

    await expect(apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt")).resolves.toMatchObject({
      status: "completed",
    });

    const destinationRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(destinationRequest.body).toBeInstanceOf(Blob);
    expect(await new Response(destinationRequest.body).arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it("returns a failed result when buffering a cross-provider source fails", async () => {
    class UnsupportedStreamUploadRequest {
      headers = new Headers({ "Content-Type": "text/plain" });
    }

    vi.stubGlobal("Request", UnsupportedStreamUploadRequest);
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start: (controller) => controller.error(new Error("source connection lost")),
        })
      )
    );

    await expect(apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt")).resolves.toMatchObject({
      status: "failed",
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "transport", detail: "Transfer source stream failed: source connection lost" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels without publishing when buffering a cross-provider source is aborted", async () => {
    class UnsupportedStreamUploadRequest {
      headers = new Headers({ "Content-Type": "text/plain" });
    }

    vi.stubGlobal("Request", UnsupportedStreamUploadRequest);
    const abortController = new AbortController();
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    fetchMock.mockImplementationOnce(async () => {
      abortController.abort();
      return new Response(
        new ReadableStream({
          start: (controller) => controller.error(new DOMException("The operation was aborted", "AbortError")),
        })
      );
    });

    await expect(
      apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt", "ask", {
        signal: abortController.signal,
      })
    ).resolves.toMatchObject({ status: "cancelled", effects: { source: "unchanged", destination: "unchanged" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels without publishing when buffering completes after an abort", async () => {
    class UnsupportedStreamUploadRequest {
      headers = new Headers({ "Content-Type": "text/plain" });
    }

    vi.stubGlobal("Request", UnsupportedStreamUploadRequest);
    const abortController = new AbortController();
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
            abortController.abort();
          },
        })
      )
    );

    await expect(
      apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt", "ask", {
        signal: abortController.signal,
      })
    ).resolves.toMatchObject({ status: "cancelled", effects: { source: "unchanged", destination: "unchanged" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports byte progress while relaying a cross-provider stream", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    const progress: Array<[number, number | null]> = [];
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          })
        )
      )
      .mockImplementationOnce(async (_url: string, request: RequestInit) => {
        await new Response(request.body).arrayBuffer();
        return new Response(
          JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }),
          {
            status: 200,
          }
        );
      });

    await apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt", "ask", {
      onProgress: (bytesTransferred, totalBytes) => progress.push([bytesTransferred, totalBytes]),
    });

    expect(progress).toEqual([[3, 3]]);
  });

  it("cancels before publication without deleting the source", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 0, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    const abortController = new AbortController();
    abortController.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    await expect(
      apiService.transferAcrossBackends("move", "source", "source.txt", "destination", "target.txt", "ask", {
        signal: abortController.signal,
      })
    ).resolves.toMatchObject({ status: "cancelled", effects: { source: "unchanged", destination: "unchanged" } });

    expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
  });

  it("reports an aborted destination acknowledgement as an unknown outcome", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 0, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    const abortController = new AbortController();
    fetchMock
      .mockResolvedValueOnce(new Response(new ReadableStream({ start: (controller) => controller.close() })))
      .mockImplementationOnce(async () => {
        abortController.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      });

    await expect(
      apiService.transferAcrossBackends("move", "source", "source.txt", "destination", "target.txt", "ask", {
        signal: abortController.signal,
      })
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      effects: { source: "unchanged", destination: "unknown" },
    });
    expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
  });

  it("converts a relay target conflict into existing conflict-dialog metadata", async () => {
    const source = { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 3, is_readable: true, is_hidden: false };
    const existing = { name: "target.txt", path: "target.txt", type: FileType.FILE, size: 4, is_readable: true, is_hidden: false };
    mockAxiosInstance.get
      .mockResolvedValueOnce({ data: source } as AxiosResponse)
      .mockResolvedValueOnce({ data: existing } as AxiosResponse);
    fetchMock.mockResolvedValueOnce(new Response("abc")).mockResolvedValueOnce(new Response("Destination already exists", { status: 409 }));

    await expect(apiService.transferAcrossBackends("copy", "source", "source.txt", "destination", "target.txt")).rejects.toMatchObject({
      response: { status: 409, data: { detail: { existing_file: existing, incoming_file: source } } },
    });
  });

  it.each(["copy", "move"] as const)("routes a mixed-provider %s facade call through the staged relay", async (operation) => {
    localStorage.setItem("companion_secret", "test-companion-secret");
    mockAxiosInstance.delete.mockResolvedValue({});
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 0, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start: (controller) => controller.close() }))).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }), {
        status: 200,
      })
    );

    await expect(
      apiService[operation === "copy" ? "copyItem" : "moveItem"](
        "local-drive:c",
        "source.txt",
        "target.txt",
        "00000000-0000-4000-8000-000000000008",
        "destination"
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/browse/destination/transfer-stream?path=target.txt"),
      expect.objectContaining({ duplex: "half" })
    );
    if (operation === "move") {
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/browse/c/item", expect.objectContaining({ params: { path: "source.txt" } }));
    }
  });

  it("retains a mixed-provider source when deletion fails after destination publication", async () => {
    localStorage.setItem("companion_secret", "test-companion-secret");
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source.txt", path: "source.txt", type: FileType.FILE, size: 0, is_readable: true, is_hidden: false },
    } as AxiosResponse);
    mockAxiosInstance.delete.mockRejectedValue(new Error("Source is read-only"));
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start: (controller) => controller.close() }))).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } }), {
        status: 200,
      })
    );

    await expect(
      apiService.transferAcrossBackends("move", "local-drive:c", "source.txt", "destination", "target.txt")
    ).resolves.toMatchObject({
      status: "completed_with_source_retained",
      effects: { source: "unchanged", destination: "mutated" },
    });
  });

  it("rejects directory sources at the regular-file relay boundary", async () => {
    mockAxiosInstance.get.mockResolvedValue({
      data: { name: "source", path: "source", type: FileType.DIRECTORY, is_readable: true, is_hidden: false },
    } as AxiosResponse);

    await expect(apiService.transferAcrossBackends("copy", "source", "source", "destination", "output/source")).resolves.toEqual({
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "unsupported" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAxiosInstance.post).not.toHaveBeenCalled();
  });

  it("phase_10_stabilization_no_response_returns_unknown_without_retry", async () => {
    mockAxiosInstance.post.mockRejectedValue({ isAxiosError: true, message: "Network Error" });

    await expect(
      apiService.copyItem("connection", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000001")
    ).resolves.toEqual({
      status: "outcome_unknown",
      replaced: false,
      effects: { source: "unknown", destination: "unknown" },
    });
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: "outcome_unknown", replaced: true, effects: { source: "unknown", destination: "mutated" } },
    { status: "outcome_unknown", replaced: true, effects: { source: "mutated", destination: "mutated" } },
    {
      status: "failed",
      replaced: true,
      effects: { source: "unchanged", destination: "mutated" },
      error: { code: "source_changed", detail: "Source changed after publication" },
    },
  ] as const)("preserves factual transfer response without retry: %j", async (result) => {
    mockAxiosInstance.post.mockResolvedValueOnce({ data: result } as AxiosResponse);
    await expect(
      apiService.moveItem("source", "report.txt", "incoming/report.txt", "00000000-0000-4000-8000-000000000009", "destination", "replace")
    ).resolves.toEqual(result);
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
  });

  it("phase_10_stabilization_normalizes_unavailable_response", async () => {
    mockAxiosInstance.post.mockResolvedValue({
      data: {
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "unchanged" },
        error: { code: "unavailable", detail: "Transfers are unavailable in this release" },
      },
    } as AxiosResponse);

    await expect(
      apiService.copyItem("connection", "source.txt", "destination.txt", "00000000-0000-4000-8000-000000000002")
    ).resolves.toEqual({
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "unsupported" },
    });
  });

  describe("Authentication", () => {
    it("login() sets access token and returns auth data", async () => {
      const mockAuthToken: AuthToken = {
        access_token: "test-token",
        token_type: "bearer",
        username: "testuser",
        role: "editor",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: mockAuthToken,
      } as AxiosResponse);

      const result = await apiService.login("testuser", "password123");

      expect(result).toEqual(mockAuthToken);
      expect(authSession.getAccessToken()).toBe("test-token");
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/auth/token", expect.any(FormData));
    });

    it("login() throws on invalid credentials", async () => {
      mockAxiosInstance.post.mockRejectedValueOnce({
        response: { status: 401, data: { detail: "Invalid credentials" } },
      });

      await expect(apiService.login("wrong", "wrong")).rejects.toMatchObject({
        response: { status: 401 },
      });

      expect(localStorage.getItem("access_token")).toBeNull();
    });

    it("getCurrentUser() returns user data", async () => {
      const mockUser: User = {
        username: "testuser",
        role: "editor",
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockUser,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      expect(result).toEqual(mockUser);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/auth/me");
    });

    it("getCurrentUser() preserves role-based admin data without synthesizing legacy flags", async () => {
      const mockUser = {
        username: "adminuser",
        role: "admin" as const,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockUser,
      } as AxiosResponse);

      const result = await apiService.getCurrentUser();

      expect(result).toEqual({
        username: "adminuser",
        role: "admin",
      });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/auth/me");
    });

    it("changePassword() sends correct request", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: {} });

      await apiService.changePassword("oldpass", "newpass");

      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/auth/change-password", {
        current_password: "oldpass",
        new_password: "newpass",
      });
    });

    it("getCurrentUserSettings() returns persisted user settings", async () => {
      const mockSettings: CurrentUserSettings = {
        appearance: {
          theme_id: "sambee-dark",
          custom_themes: [
            {
              id: "custom-theme",
              name: "Custom Theme",
              mode: "light",
              primary: { main: "#123456" },
            },
          ],
        },
        localization: {
          language: "en",
          regional_locale: "en-GB",
        },
        browser: {
          quick_nav_include_dot_directories: true,
          quick_bar_shortcut_hint_visibility: "auto",
          touch_friendly_file_selection: "auto",
          file_browser_view_mode: "details",
          pane_mode: "dual",
          selected_connection_id: "conn-123",
          viewer_associations: {},
        },
        text_editor: {
          max_file_size_bytes: 1048576,
          word_wrap_enabled: null,
        },
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockSettings,
      } as AxiosResponse);

      const result = await apiService.getCurrentUserSettings();

      expect(result).toEqual(mockSettings);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/auth/me/settings");
    });

    it("updateCurrentUserSettings() sends the update payload", async () => {
      const update = { field: "appearance.theme_id", value: "sambee-dark" } as const;

      mockAxiosInstance.put.mockResolvedValueOnce({
        data: update,
      } as AxiosResponse);

      const result = await apiService.updateCurrentUserSettings(update);

      expect(result).toEqual(update);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/auth/me/settings", update);
    });

    it("updateCurrentUserSettings() forwards an optional cancellation signal", async () => {
      const update = { field: "appearance.theme_id", value: "sambee-dark" } as const;
      const controller = new AbortController();
      mockAxiosInstance.put.mockResolvedValueOnce({ data: update } as AxiosResponse);

      await apiService.updateCurrentUserSettings(update, { signal: controller.signal });

      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/auth/me/settings", update, { signal: controller.signal });
    });
  });

  describe("Connections Management", () => {
    it("getConnections() returns list of connections", async () => {
      const mockConnections: Connection[] = [
        {
          id: "1",
          name: "Test Server",
          slug: "test-server",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "public",
          username: "user",
          path_prefix: "",
          scope: "shared",
          access_mode: "read_write",
          can_manage: true,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "2",
          name: "Backup Server",
          slug: "backup-server",
          type: "smb",
          host: "192.168.1.200",
          port: 445,
          share_name: "backup",
          username: "admin",
          path_prefix: "",
          scope: "shared",
          access_mode: "read_write",
          can_manage: true,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockConnections,
      } as AxiosResponse);

      const result = await apiService.getConnections();

      expect(result).toEqual(mockConnections);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/connections");
    });

    it("createConnection() posts data and returns new connection", async () => {
      const newConnection: ConnectionCreate = {
        name: "New Server",
        type: "smb",
        host: "192.168.1.50",
        port: 445,
        share_name: "data",
        username: "user",
        password: "pass",
        path_prefix: "",
        scope: "private",
        access_mode: "read_write",
      };

      const createdConnection: Connection = {
        id: "3",
        name: "New Server",
        slug: "new-server",
        type: "smb",
        host: "192.168.1.50",
        port: 445,
        share_name: "data",
        username: "user",
        path_prefix: "",
        scope: "private",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: createdConnection,
      } as AxiosResponse);

      const result = await apiService.createConnection(newConnection);

      expect(result).toEqual(createdConnection);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/connections", newConnection);
    });

    it("getConnectionVisibilityOptions() returns server-driven visibility metadata", async () => {
      const options = [
        {
          value: "private",
          label: "Private to me",
          description: "Visible only to your account. You can fully manage it.",
          available: true,
          unavailable_reason: null,
        },
        {
          value: "shared",
          label: "Shared with everyone",
          description: "Visible to all users. Only admins can manage it.",
          available: false,
          unavailable_reason: "Shared connections can only be created or updated by admins.",
        },
      ];

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: options,
      } as AxiosResponse);

      const result = await apiService.getConnectionVisibilityOptions();

      expect(result).toEqual(options);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/connections/visibility-options");
    });

    it("updateConnection() updates data and returns updated connection", async () => {
      const updates: Partial<ConnectionCreate> = {
        name: "Updated Server",
        share_name: "newshare",
      };

      const updatedConnection: Connection = {
        id: "1",
        name: "Updated Server",
        slug: "test-server",
        type: "smb",
        host: "192.168.1.100",
        port: 445,
        share_name: "newshare",
        username: "user",
        path_prefix: "",
        scope: "shared",
        access_mode: "read_write",
        can_manage: true,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      };

      mockAxiosInstance.put.mockResolvedValueOnce({
        data: updatedConnection,
      } as AxiosResponse);

      const result = await apiService.updateConnection("1", updates);

      expect(result).toEqual(updatedConnection);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/connections/1", updates);
    });

    it("getAdvancedSettings() returns admin advanced settings", async () => {
      const advancedSettings: AdvancedSystemSettings = {
        preprocessors: {
          imagemagick: {
            max_file_size_bytes: {
              key: "preprocessors.imagemagick.max_file_size_bytes",
              label: "Maximum file size",
              description: "Largest input file ImageMagick is allowed to preprocess.",
              value: 104857600,
              source: "default",
              default_value: 104857600,
              min_value: 1048576,
              max_value: 1073741824,
              step: 1048576,
            },
            timeout_seconds: {
              key: "preprocessors.imagemagick.timeout_seconds",
              label: "Conversion timeout",
              description: "Maximum time allowed for an ImageMagick preprocessing run.",
              value: 30,
              source: "default",
              default_value: 30,
              min_value: 5,
              max_value: 600,
              step: 1,
            },
          },
        },
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: advancedSettings,
      } as AxiosResponse);

      const result = await apiService.getAdvancedSettings();

      expect(result).toEqual(advancedSettings);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/admin/settings/advanced");
    });

    it("getAboutSettings() returns safe admin runtime information", async () => {
      const aboutSettings = {
        version: "0.9.24",
        build_time: "2026-08-02T10:00:00Z",
        git_commit: "5966e38",
        started_at: "2026-08-02T09:00:00Z",
        architecture: "x86_64",
        logical_cpu_count: 4,
        memory_bytes: 8589934592,
        python_runtime: "CPython 3.13.12",
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: aboutSettings } as AxiosResponse);

      const result = await apiService.getAboutSettings();

      expect(result).toEqual(aboutSettings);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/admin/settings/about");
    });

    it("getPublicSupportReport() returns public-safe support text", async () => {
      const supportReport = { content: "# Sambee public support report" };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: supportReport } as AxiosResponse);

      const result = await apiService.getPublicSupportReport();

      expect(result).toEqual(supportReport);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/admin/settings/support-report");
    });

    it("updateAdvancedSettings() forwards one field update", async () => {
      const update = { field: "preprocessors.imagemagick.timeout_seconds", value: 45 };
      mockAxiosInstance.put.mockResolvedValueOnce({ data: update } as AxiosResponse);

      await expect(apiService.updateAdvancedSettings(update)).resolves.toEqual(update);
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/admin/settings/advanced", update);
    });

    it("gets and updates dedicated SMB settings", async () => {
      const smbSettings: SmbSettings = {
        read_chunk_size_bytes: {
          key: "smb.read_chunk_size_bytes",
          label: "SMB read chunk size",
          description: "Chunk size used when streaming files from SMB shares.",
          value: 4194304,
          source: "default",
          default_value: 4194304,
          min_value: 65536,
          max_value: 16777216,
          step: 65536,
        },
        policy: {
          authentication_mode: "negotiate",
          encryption_mode: "signing_only",
          connection_timeout_seconds: 30,
        },
        require_signing: true,
        require_encryption: false,
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: smbSettings } as AxiosResponse);
      const update = { field: "encryption_mode", value: "encryption_required" } as const;
      mockAxiosInstance.put.mockResolvedValueOnce({ data: update } as AxiosResponse);

      await expect(apiService.getSmbSettings()).resolves.toEqual(smbSettings);
      await expect(apiService.updateSmbSettings(update)).resolves.toEqual(update);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/admin/settings/smb");
      expect(mockAxiosInstance.put).toHaveBeenCalledWith("/admin/settings/smb", update);
    });

    it("deleteConnection() removes connection", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({ data: {} });

      await apiService.deleteConnection("1");

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/connections/1");
    });

    it("testConnection() returns status", async () => {
      const mockStatus = {
        status: "success",
        message: "Connection successful",
      };

      mockAxiosInstance.post.mockResolvedValueOnce({
        data: mockStatus,
      } as AxiosResponse);

      const result = await apiService.testConnection("1");

      expect(result).toEqual(mockStatus);
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/connections/1/test");
    });

    it("getCompanionDownloads() returns backend-managed installer metadata", async () => {
      const metadata: CompanionDownloadMetadata = {
        source: "feed",
        version: "0.5.0",
        published_at: "2026-03-27T12:00:00Z",
        notes: "Release notes",
        assets: {
          "windows-x64": "https://downloads.example.test/Sambee-Companion.exe",
        },
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: metadata,
      } as AxiosResponse);

      const result = await apiService.getCompanionDownloads();

      expect(result).toEqual(metadata);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/companion/downloads");
    });
  });

  describe("Browse Operations", () => {
    it("listDirectory() returns file listing for root path", async () => {
      const mockListing: DirectoryListing = {
        path: "/",
        items: [
          {
            name: "Documents",
            path: "/Documents",
            type: FileType.DIRECTORY,
            size: 0,
            modified_at: "2024-01-01T10:00:00",
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "file.txt",
            path: "/file.txt",
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T11:00:00",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 2,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockListing,
      } as AxiosResponse);

      const result = await apiService.listDirectory("conn1", "");

      expect(result).toEqual(mockListing);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/list", {
        params: { path: "" },
        timeout: 40000,
      });
    });

    it("listDirectory() handles nested paths correctly", async () => {
      const mockListing: DirectoryListing = {
        path: "/Documents/Work",
        items: [
          {
            name: "report.pdf",
            path: "/Documents/Work/report.pdf",
            type: FileType.FILE,
            size: 2048,
            modified_at: "2024-01-02T10:00:00",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockListing,
      } as AxiosResponse);

      const result = await apiService.listDirectory("conn1", "/Documents/Work");

      expect(result).toEqual(mockListing);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/list", {
        params: { path: "/Documents/Work" },
        timeout: 40000,
      });
    });

    it("listDirectory() accepts a custom timeout", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { path: "/", items: [], total: 0 },
      } as AxiosResponse);

      await apiService.listDirectory("conn1", "/", { timeoutMs: 1500 });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/list", {
        params: { path: "/" },
        timeout: 1500,
      });
    });

    it("getFileInfo() returns file metadata", async () => {
      const mockFileInfo = {
        name: "document.pdf",
        path: "/document.pdf",
        type: FileType.FILE,
        size: 5120,
        modified_at: "2024-01-03T10:00:00",
        is_readable: true,
        is_hidden: false,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: mockFileInfo,
      } as AxiosResponse);

      const result = await apiService.getFileInfo("conn1", "/document.pdf");

      expect(result).toEqual(mockFileInfo);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/info", {
        params: { path: "/document.pdf" },
      });
    });

    it("resolveLocalActivation() resolves through the Companion API", async () => {
      const resolution = {
        drive_id: "d",
        path: "Documents/report.pdf",
        item: {
          name: "report.pdf",
          path: "Documents/report.pdf",
          type: FileType.FILE,
          is_readable: true,
          is_hidden: false,
        },
      };
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.get.mockResolvedValueOnce({ data: resolution } as AxiosResponse);

      const result = await apiService.resolveLocalActivation("local-drive:c", "Links/report.lnk");

      expect(result).toEqual(resolution);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/c/resolve-activation", {
        params: { path: "Links/report.lnk" },
      });
    });

    it("listLocalLinkTargets() requests deferred Companion link metadata", async () => {
      const listing = {
        items: [
          {
            source_path: "Links/report.lnk",
            state: "resolved",
            target: { name: "report.pdf", path: "C:\\Users\\sambee\\Documents\\report.pdf", type: "file" },
          },
        ],
      };
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.get.mockResolvedValueOnce({ data: listing } as AxiosResponse);

      const result = await apiService.listLocalLinkTargets("local-drive:c", "Links");

      expect(result).toEqual(listing);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/c/link-targets", {
        params: { path: "Links" },
        timeout: 15_000,
      });
    });

    it("starts a direct-local archive creation lifecycle execution", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: { execution_id: "create-1", kind: "create", phase: "accepted", revision: 1, cancellation_requested: false },
      } as AxiosResponse);

      await expect(
        apiService.startLocalArchiveCreation("local-drive:c", ["Documents/report.txt"], "Archives/backup.zip")
      ).resolves.toMatchObject({
        execution_id: "create-1",
        kind: "create",
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/browse/c/archive/v2/executions",
        { contract_version: "v2", kind: "create", source_paths: ["Documents/report.txt"], target_path: "Archives/backup.zip" },
        {}
      );
    });

    it("authenticates SMB-to-local archive extraction with the browser token", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      authSession.setAuthenticated({ access_token: "browser-token", token_type: "bearer", username: "testuser" }, false);
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { members_completed: 1 } } as AxiosResponse);

      await apiService.extractSmbArchiveToLocal("local-drive:c", "output", "operation-id");

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/browse/c/archive/v2/relay/extraction",
        { contract_version: "v2", destination_path: "output", operation_id: "operation-id" },
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer browser-token" }) })
      );
    });

    it("retries local archive cancellation after a stale progress revision", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.post.mockRejectedValueOnce({ response: { status: 409 } }).mockResolvedValueOnce({
        data: { execution_id: "create-1", kind: "create", phase: "streaming", revision: 3, cancellation_requested: true },
      } as AxiosResponse);
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: { execution_id: "create-1", kind: "create", phase: "streaming", revision: 2, cancellation_requested: false },
      } as AxiosResponse);

      await expect(apiService.cancelLocalArchiveExecutionWithRevisionRetry("local-drive:c", "create-1", 1)).resolves.toMatchObject({
        revision: 3,
        cancellation_requested: true,
      });

      expect(mockAxiosInstance.post.mock.calls.slice(-2)).toEqual([
        ["/browse/c/archive/v2/executions/create-1/cancellation", { contract_version: "v2", expected_revision: 1 }, {}],
        ["/browse/c/archive/v2/executions/create-1/cancellation", { contract_version: "v2", expected_revision: 2 }, {}],
      ]);
    });
  });

  describe("Viewer Operations", () => {
    it("getViewUrl() constructs a token-free server URL", async () => {
      const url = await apiService.getViewUrl("conn1", "/test.pdf");

      expect(url).toContain("/viewer/conn1/file");
      expect(url).toContain("path=%2Ftest.pdf");
      expect(url).not.toContain("token=");
    });

    it("getDownloadUrl() constructs a token-free server URL", async () => {
      const url = await apiService.getDownloadUrl("conn1", "/data.zip");

      expect(url).toContain("/viewer/conn1/download");
      expect(url).toContain("path=%2Fdata.zip");
      expect(url).not.toContain("token=");
    });

    it("getOriginalFileBlob() fetches untransformed bytes from the download endpoint", async () => {
      authSession.setAuthenticated({ access_token: "download-token", token_type: "bearer", username: "testuser" }, false);
      const controller = new AbortController();
      const blob = new Blob(["original"]);
      fetchMock.mockResolvedValueOnce({ ok: true, blob: vi.fn().mockResolvedValueOnce(blob) });

      await expect(apiService.getOriginalFileBlob("conn1", "/photos/image.jxl", { signal: controller.signal })).resolves.toBe(blob);

      expect(fetchMock).toHaveBeenCalledWith("http://localhost:3000/api/viewer/conn1/download?path=%2Fphotos%2Fimage.jxl", {
        headers: { Authorization: "Bearer download-token" },
        signal: controller.signal,
      });
    });

    it("uses device-pixel viewport dimensions for physical and archive images", async () => {
      vi.stubGlobal("devicePixelRatio", 2);
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: new Blob(["archive"]), headers: {} } as AxiosResponse)
        .mockResolvedValueOnce({ data: new ArrayBuffer(0), headers: {} } as AxiosResponse);

      await apiService.getArchiveMember("conn1", "photos.zip", "photos/image.jxl", {
        request: { kind: "image", viewportWidth: 640, viewportHeight: 360 },
      });
      await apiService.getImageBlob("conn1", "photos/image.jxl", { viewportWidth: 640, viewportHeight: 360 });

      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(
        1,
        "/archive/v2/inspection/member",
        expect.objectContaining({
          params: expect.objectContaining({ contract_version: "v2", connection_id: "conn1", viewport_width: 1280, viewport_height: 720 }),
          responseType: "blob",
        })
      );
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(
        2,
        "/viewer/conn1/file",
        expect.objectContaining({
          params: expect.objectContaining({ path: "photos/image.jxl", viewport_width: 1280, viewport_height: 720 }),
          responseType: "arraybuffer",
        })
      );
    });

    it("uses the Companion raw archive-member contract for local drives", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.get.mockResolvedValueOnce({ data: new Blob(["archive"]), headers: {} } as AxiosResponse);

      await apiService.getArchiveMember("local-drive:c", "photos.zip", "photos/image.png", {
        request: { kind: "image", viewportWidth: 640, viewportHeight: 360 },
      });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/viewer/c/archive/v2/member",
        expect.objectContaining({
          params: {
            contract_version: "v2",
            archive_path: "photos.zip",
            member_path: "photos/image.png",
            download: false,
          },
          responseType: "blob",
        })
      );
    });

    it("getFileContent() fetches file content as text", async () => {
      localStorage.setItem("access_token", "content-token");

      mockAxiosInstance.get.mockResolvedValueOnce({
        data: "File content here",
      } as AxiosResponse);

      const result = await apiService.getFileContent("conn1", "/readme.txt");

      expect(result).toBe("File content here");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/viewer/conn1/file", {
        params: { path: "/readme.txt" },
        responseType: "text",
      });
    });

    it("supportsEditLocks() reports server and Companion-local support", () => {
      expect(apiService.supportsEditLocks("conn1")).toBe(true);
      expect(apiService.supportsEditLocks("local-drive:c")).toBe(true);
    });

    it("saveTextFile() uploads text content to the same path", async () => {
      authSession.setAuthenticated({ access_token: "save-token", token_type: "bearer", username: "testuser" }, false);
      fetchMock.mockResolvedValueOnce({
        ok: true,
      });

      await apiService.saveTextFile("conn1", "/notes/readme.md", "# Updated\n");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: FormData }];
      expect(url).toBe("http://localhost:3000/api/browse/conn1/upload?path=%2Fnotes%2Freadme.md");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ Authorization: "Bearer save-token" });
      expect(options.body).toBeInstanceOf(FormData);

      const uploadedFile = options.body.get("file");
      expect(uploadedFile).toBeInstanceOf(File);
      expect((uploadedFile as File).name).toBe("readme.md");
      expect((uploadedFile as File).type).toBe("text/plain;charset=utf-8");
      expect((uploadedFile as File).size).toBeGreaterThan(0);
    });

    it("classifies an expired edit lock upload response with a nested error code", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: { code: "edit_lock_lost", message: "Lock not found or expired" } }), { status: 404 })
      );

      await expect(
        apiService.writeTextWithEditLock("conn1", "/notes/readme.md", "# Updated\n", {
          lock_id: "lock-1",
          lock_capability: "capability-1",
          operation_id: "operation-1",
        })
      ).rejects.toBeInstanceOf(ExpiredEditLockError);
    });

    it("classifies an expired edit lock upload response with a top-level error code", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: "edit_lock_lost" }), { status: 404 }));

      await expect(
        apiService.writeTextWithEditLock("conn1", "/notes/readme.md", "# Updated\n", {
          lock_id: "lock-1",
          lock_capability: "capability-1",
          operation_id: "operation-1",
        })
      ).rejects.toBeInstanceOf(ExpiredEditLockError);
    });

    it("does not classify a string-only expired edit lock response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Lock not found or expired" }), { status: 404 }));

      await expect(
        apiService.writeTextWithEditLock("conn1", "/notes/readme.md", "# Updated\n", {
          lock_id: "lock-1",
          lock_capability: "capability-1",
          operation_id: "operation-1",
        })
      ).rejects.not.toBeInstanceOf(ExpiredEditLockError);
    });

    it("acquireEditLock() calls the companion lock endpoint for server connections", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({
        data: {
          lock_id: "lock-1",
          lock_capability: "cap-1",
          operation_id: "op-1",
          file_path: "/docs/readme.md",
          locked_by: "alice",
          locked_at: "2026-03-23T12:00:00Z",
        },
      } as AxiosResponse);

      const result = await apiService.acquireEditLock("conn1", "/docs/readme.md", "session-1");

      expect(result).toEqual({
        lock_id: "lock-1",
        lock_capability: "cap-1",
        operation_id: "op-1",
        file_path: "/docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      });
      expect(mockAxiosInstance.post).toHaveBeenCalledWith("/browse/conn1/lock", undefined, {
        params: { path: "/docs/readme.md", check_write_access: true },
      });
    });

    it("heartbeatEditLock() refreshes the server-side lock heartbeat", async () => {
      mockAxiosInstance.post.mockResolvedValueOnce({ data: { status: "ok" } } as AxiosResponse);

      await apiService.heartbeatEditLock("conn1", "/docs/readme.md", {
        lock_id: "lock-1",
        lock_capability: "cap-1",
        operation_id: "op-1",
        file_path: "/docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      });

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/browse/conn1/lock/heartbeat",
        {
          operation_id: "op-1",
          lock_id: "lock-1",
          lock_capability: "cap-1",
        },
        {
          params: { path: "/docs/readme.md" },
        }
      );
    });

    it.each(["nested", "top-level"])("classifies a lost heartbeat lock with a %s code", async (shape) => {
      const detail = { code: "edit_lock_lost" };
      mockAxiosInstance.post.mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 404, data: shape === "nested" ? { detail } : detail },
      });
      await expect(
        apiService.heartbeatEditLock("conn1", "/docs/readme.md", {
          lock_id: "lock-1",
          lock_capability: "cap-1",
          operation_id: "op-1",
          file_path: "/docs/readme.md",
          locked_by: "alice",
          locked_at: "2026-10-19T12:00:00Z",
        })
      ).rejects.toBeInstanceOf(ExpiredEditLockError);
    });

    it.each([
      { isAxiosError: true, response: { status: 404, data: { detail: "Not found" } } },
      { isAxiosError: true, response: { status: 403, data: { detail: "Context mismatch" } } },
      new Error("Network unavailable"),
    ])("preserves non-expiry heartbeat failures: %j", async (error) => {
      mockAxiosInstance.post.mockRejectedValueOnce(error);
      await expect(
        apiService.heartbeatEditLock("conn1", "/docs/readme.md", {
          lock_id: "lock-1",
          lock_capability: "cap-1",
          operation_id: "op-1",
          file_path: "/docs/readme.md",
          locked_by: "alice",
          locked_at: "2026-10-19T12:00:00Z",
        })
      ).rejects.toEqual(error);
    });

    it("releaseEditLock() releases the server-side lock", async () => {
      mockAxiosInstance.delete.mockResolvedValueOnce({ data: { status: "ok" } } as AxiosResponse);

      await apiService.releaseEditLock("conn1", "/docs/readme.md", {
        lock_id: "lock-1",
        lock_capability: "cap-1",
        operation_id: "op-1",
        file_path: "/docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      });

      expect(mockAxiosInstance.delete).toHaveBeenCalledWith("/browse/conn1/lock", {
        params: { path: "/docs/readme.md" },
        data: {
          operation_id: "op-1",
          lock_id: "lock-1",
          lock_capability: "cap-1",
        },
      });
    });

    it("getEditLockStatus() reads server-side lock state", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          locked: true,
          locked_by: "alice",
          locked_at: "2026-03-23T12:00:00Z",
        },
      } as AxiosResponse);

      const result = await apiService.getEditLockStatus("conn1", "/docs/readme.md");

      expect(result).toEqual({
        locked: true,
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/lock-status", {
        params: { path: "/docs/readme.md" },
      });
    });

    it("getEditLockStatus() reads Companion-local lock state", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { locked: true, locked_by: "alice" } } as AxiosResponse);

      const result = await apiService.getEditLockStatus("local-drive:c", "/docs/readme.md");

      expect(result).toEqual({ locked: true, locked_by: "alice" });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        "/browse/c/lock-status",
        expect.objectContaining({ params: { path: "/docs/readme.md" } })
      );
    });

    it("edit lock mutations use Companion-local routes", async () => {
      localStorage.setItem("companion_secret", "test-companion-secret");
      const lockInfo = {
        lock_id: "lock-1",
        lock_capability: "cap-1",
        operation_id: "op-1",
        file_path: "/docs/readme.md",
        locked_by: "alice",
        locked_at: "2026-03-23T12:00:00Z",
      };
      mockAxiosInstance.post.mockResolvedValue({ data: lockInfo } as AxiosResponse);
      mockAxiosInstance.delete.mockResolvedValue({ data: { status: "ok" } } as AxiosResponse);

      await expect(apiService.acquireEditLock("local-drive:c", "/docs/readme.md", "session-1")).resolves.toEqual(lockInfo);
      await apiService.heartbeatEditLock("local-drive:c", "/docs/readme.md", lockInfo);
      await apiService.releaseEditLock("local-drive:c", "/docs/readme.md", lockInfo);

      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/browse/c/lock",
        undefined,
        expect.objectContaining({ params: { path: "/docs/readme.md", check_write_access: true } })
      );
      expect(mockAxiosInstance.post).toHaveBeenCalledWith(
        "/browse/c/lock/heartbeat",
        {
          operation_id: "op-1",
          lock_id: "lock-1",
          lock_capability: "cap-1",
        },
        expect.objectContaining({ params: { path: "/docs/readme.md" } })
      );
      expect(mockAxiosInstance.delete).toHaveBeenCalledWith(
        "/browse/c/lock",
        expect.objectContaining({
          params: { path: "/docs/readme.md" },
          data: {
            operation_id: "op-1",
            lock_id: "lock-1",
            lock_capability: "cap-1",
          },
        })
      );
    });
  });

  describe("Error Handling", () => {
    it("network errors are propagated", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("Network error"));

      await expect(apiService.getConnections()).rejects.toThrow("Network error");
    });

    it("500 errors are propagated", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce({
        response: { status: 500, data: { detail: "Server error" } },
      });

      await expect(apiService.listDirectory("conn1", "/")).rejects.toMatchObject({
        response: { status: 500 },
      });
    });

    it("marks the backend reconnecting on the first connectivity failure", async () => {
      const networkError = { code: "ERR_NETWORK", message: "Network error" };

      expect(responseErrorHandler).toBeDefined();
      await expect(responseErrorHandler?.(networkError)).rejects.toEqual(networkError);
      expect(getBackendAvailabilitySnapshot()).toMatchObject({
        status: "reconnecting",
        lastErrorMessage: "Network error",
      });
    });

    it("does not mark the backend reconnecting for viewer blob network failures", async () => {
      const networkError = {
        code: "ERR_NETWORK",
        message: "Network error",
        config: {
          method: "get",
          url: "/viewer/5532865d-cb5b-4fb1-9232-6716970f97db/file",
        },
      };

      expect(responseErrorHandler).toBeDefined();
      await expect(responseErrorHandler?.(networkError as never)).rejects.toEqual(networkError);
      expect(getBackendAvailabilitySnapshot()).toMatchObject({
        status: "available",
        lastErrorMessage: null,
      });
    });

    it("does not log an API error for a signal-aborted viewer blob request surfaced as a network error", async () => {
      const errorSpy = vi.spyOn(logger, "error");
      const networkError = {
        code: "ERR_NETWORK",
        message: "Network Error",
        config: {
          method: "get",
          url: "/viewer/5532865d-cb5b-4fb1-9232-6716970f97db/file",
          signal: { aborted: true },
        },
      };

      expect(responseErrorHandler).toBeDefined();
      await expect(responseErrorHandler?.(networkError as never)).rejects.toEqual(networkError);
      expect(errorSpy).not.toHaveBeenCalledWith("API request failed", expect.anything(), "api");
    });

    it("does not log an API error for a transient viewer blob network failure", async () => {
      const errorSpy = vi.spyOn(logger, "error");
      const networkError = {
        code: "ERR_NETWORK",
        message: "Network Error",
        config: {
          method: "get",
          url: "/viewer/5532865d-cb5b-4fb1-9232-6716970f97db/file",
        },
      };

      expect(responseErrorHandler).toBeDefined();
      await expect(responseErrorHandler?.(networkError as never)).rejects.toEqual(networkError);
      expect(errorSpy).not.toHaveBeenCalledWith("API request failed", expect.anything(), "api");
    });

    it("keeps the backend unavailable after another connectivity failure while already unavailable", async () => {
      const networkError = { code: "ERR_NETWORK", message: "Still offline" };

      markBackendUnavailable("Initial outage");

      expect(responseErrorHandler).toBeDefined();
      await expect(responseErrorHandler?.(networkError)).rejects.toEqual(networkError);
      expect(getBackendAvailabilitySnapshot()).toMatchObject({
        status: "unavailable",
        lastErrorMessage: "Still offline",
      });
    });

    it("marks the backend available again after a successful response", async () => {
      const response = {
        data: {},
        status: 200,
        statusText: "OK",
        headers: {},
        config: {
          method: "get",
          url: "/connections",
          headers: {},
        } as AxiosResponse["config"],
      } as AxiosResponse;

      markBackendUnavailable("Initial outage");

      expect(responseSuccessHandler).toBeDefined();
      expect(responseSuccessHandler?.(response)).toBe(response);
      expect(getBackendAvailabilitySnapshot()).toMatchObject({
        status: "available",
        lastErrorMessage: null,
      });
    });

    it("does not clear the token or redirect on 401 while backend recovery is active", async () => {
      const networkErrorHandler = responseErrorHandler;
      const authError = {
        response: { status: 401, data: { detail: "Unauthorized" }, headers: {} },
        message: "Unauthorized",
        config: { url: "/auth/me", method: "get" },
      };

      localStorage.setItem("access_token", "token-123");
      markBackendUnavailable("Recovery in progress");

      await expect(networkErrorHandler?.(authError as never)).rejects.toEqual(authError);
      expect(localStorage.getItem("access_token")).toBe("token-123");
      expect(getBackendAvailabilitySnapshot()).toMatchObject({
        status: "reconnecting",
        recoveryLock: true,
      });
      expect(window.location.href).not.toBe("/login");
    });
  });

  describe("Convenience Functions", () => {
    it("login() convenience function works", async () => {
      const authResponse: AxiosResponse<AuthToken> = {
        data: {
          access_token: "token123",
          token_type: "bearer",
          username: "testuser",
          role: "editor",
        },
        status: 200,
        statusText: "OK",
        headers: {},
        config: {
          headers: {},
        } as unknown as AxiosResponse["config"],
      };
      mockAxiosInstance.post.mockResolvedValueOnce(authResponse);

      const { login } = await import("../api");
      const result = await login("user", "pass");

      expect(result).toEqual(authResponse.data);
      expect(authSession.getAccessToken()).toBe("token123");
    });

    it("browseFiles() convenience function returns items from first connection", async () => {
      const connections: Connection[] = [
        {
          id: "conn1",
          name: "Test",
          slug: "test",
          type: "smb",
          host: "192.168.1.100",
          port: 445,
          share_name: "share",
          username: "user",
          path_prefix: "/",
          scope: "shared",
          access_mode: "read_write",
          can_manage: true,
          created_at: "2024-01-01T00:00:00",
          updated_at: "2024-01-01T00:00:00",
        },
      ];

      const listing: DirectoryListing = {
        path: "/test",
        items: [
          {
            name: "file.txt",
            path: "/test/file.txt",
            type: FileType.FILE,
            size: 1024,
            is_readable: true,
            is_hidden: false,
            modified_at: "2024-01-01T00:00:00",
          },
        ],
        total: 1,
      };

      mockAxiosInstance.get.mockResolvedValueOnce({ data: connections } as unknown as AxiosResponse<Connection[]>).mockResolvedValueOnce({
        data: listing,
      } as AxiosResponse<DirectoryListing>);

      const { browseFiles } = await import("../api");
      const result = await browseFiles("/test", "token");

      expect(result).toEqual(listing.items);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/connections");
      expect(mockAxiosInstance.get).toHaveBeenCalledWith("/browse/conn1/list", {
        params: { path: "/test" },
        timeout: 40000,
      });
    });

    it("browseFiles() returns empty array when no connections exist", async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] } as unknown as AxiosResponse<Connection[]>);

      const { browseFiles } = await import("../api");
      const result = await browseFiles("/test", "token");

      expect(result).toEqual([]);
    });

    it("browseFiles() returns empty array on error", async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error("Network error"));

      const { browseFiles } = await import("../api");

      const result = await browseFiles("/test", "token");

      expect(result).toEqual([]);
      // Note: Error logging is suppressed during tests, so we don't check for it
    });
  });
});
