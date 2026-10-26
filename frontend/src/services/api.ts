import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import type { ThemeConfig } from "../theme/types";
import type {
  AboutSettings,
  AdminUser,
  AdminUserCreateInput,
  AdminUserCreateResult,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserPasswordResetInput,
  AdminUserPasswordResetResult,
  AdminUserUpdateInput,
  AdvancedSystemSettings,
  AdvancedSystemSettingsUpdate,
  ArchiveCompanionSession,
  ArchiveDirectoryListing,
  ArchiveExtractionDecisionAction,
  ArchiveOperation,
  ArchiveOperationPhase,
  ArchiveOperationPrepare,
  AuthenticationMode,
  AuthenticationModeActivationResponse,
  AuthToken,
  CompanionDownloadMetadata,
  ConflictInfo,
  Connection,
  ConnectionCreate,
  ConnectionVisibilityOption,
  CurrentAccount,
  CurrentUserSettings,
  CurrentUserSettingsUpdate,
  DirectoryListing,
  DirectorySearchResult,
  EditLockInfo,
  EditLockStatus,
  FileInfo,
  FileSearchSettingsRead,
  FileSearchSettingsUpdate,
  LocalActivationResolution,
  LocalLinkTargetListing,
  NetworkSettings,
  NetworkSettingsUpdate,
  OidcAdminConfigurationRead,
  OidcBrowserSessionList,
  OidcBrowserSessionRevokeResult,
  OidcConfigurationCandidate,
  OidcFinalizeResponse,
  OidcMappingMutationResponse,
  OidcReviewedPolicy,
  OidcTestedIdentity,
  OidcTestStartResponse,
  PublicSupportReport,
  RecentDirectory,
  RecentDirectorySearchResponse,
  RecentFile,
  RecentFileSearchResponse,
  SmbSettings,
  SmbSettingsUpdate,
  User,
} from "../types";
import { FileType } from "../types";
import { randomUuid } from "../utils/randomUuid";
import { AuthSessionError, authSession } from "./authSession";
import {
  getBackendAvailabilitySnapshot,
  isBackendConnectivityError,
  isLocalAbortError,
  markBackendAvailable,
  markBackendReconnecting,
  markBackendUnavailable,
} from "./backendAvailability";
import { getBaseUrl, getBrowseSegment, isLocalDrive } from "./backendRouter";
import { clearBrowserRecoverySnapshot } from "./browserRecoverySnapshot";
import { COMPANION_BASE_URL } from "./companion";
import { companionSession } from "./companionSession";
import { snapshotRegisteredDrafts } from "./draftRecovery";
import { logger } from "./logger";
import { sanitizeReturnPath } from "./oidcAuth";
import { setPasswordChangeRequired } from "./passwordChange";
import { type ContentTransferResult, ExpiredEditLockError, type TargetResolutionPolicy } from "./storageContracts";

export { ExpiredEditLockError } from "./storageContracts";

export interface DirectorySearchOptions {
  includeDotDirectories?: boolean;
  signal?: AbortSignal;
}

export interface StoredTheme {
  id: string;
  scope: "user" | "site";
  version: number;
  definition: Omit<ThemeConfig, "id">;
}

export interface ThemeList {
  themes: StoredTheme[];
  site_default_id: string;
}

export function getThemeRequestError(cause: unknown): string {
  if (axios.isAxiosError(cause)) {
    const detail: unknown = cause.response?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  return cause instanceof Error ? cause.message : "Could not change the theme. Check the connection and try again.";
}

export interface CrossBackendTransferOptions {
  signal?: AbortSignal;
  transferAttemptId?: string;
  onProgress?: (bytesTransferred: number, totalBytes: number | null) => void;
  onUploadSent?: () => void;
}

type ClientConfig = Pick<AxiosRequestConfig, "headers">;

const EXPIRED_EDIT_LOCK_CODE = "edit_lock_lost";

function isExpiredEditLockResponse(body: string): boolean {
  try {
    const response = JSON.parse(body) as { code?: unknown; detail?: { code?: unknown } };
    return response.code === EXPIRED_EDIT_LOCK_CODE || response.detail?.code === EXPIRED_EDIT_LOCK_CODE;
  } catch {
    return false;
  }
}

function supportsStreamUploadRequestBodies(): boolean {
  if (typeof Request === "undefined" || typeof ReadableStream === "undefined") return false;

  let duplexAccessed = false;
  try {
    const request = new Request("https://sambee.invalid", {
      method: "POST",
      body: new ReadableStream(),
      get duplex() {
        duplexAccessed = true;
        return "half";
      },
    } as RequestInit & { duplex: "half" });
    return duplexAccessed && !request.headers.has("Content-Type");
  } catch {
    return false;
  }
}

const CONNECTIONS_API_BASE = "/connections";
const API_PATH_SUFFIX = "/api";
const DIRECTORY_LIST_REQUEST_TIMEOUT_MS = 40_000;
const LOCAL_LINK_TARGET_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_ARCHIVE_EXECUTION_POLL_INTERVAL_MS = 200;
const LOCAL_ARCHIVE_CANCELLATION_MAX_REVISION_RETRIES = 3;
export interface ArchiveExecutionProgress {
  completedMembers: number;
  totalMembers?: number;
  skippedMembers: number;
  failedMembers: number;
  processedBytes?: number;
  totalBytes?: number;
}

export interface LocalArchiveExecution {
  contract_version: "v2";
  execution_id: string;
  kind: "create" | "extract";
  phase: "accepted" | "streaming" | "awaiting_user_decision" | "completed" | "cancelled" | "failed";
  revision: number;
  progress: ArchiveExecutionProgress;
  cancellation_requested: boolean;
  aggregate_counters?: LocalArchiveRelayExtractionStatus["aggregate_counters"];
  directories_created?: number;
  files_created?: number;
  source_bytes?: number;
  error?: string;
  pendingDecision?:
    | {
        kind: "collision";
        source_session_id: string;
        delivery_sequence: number;
        decision_revision: number;
        member_path: string;
        is_directory: boolean;
        allowed_actions: ("skip" | "skip_all" | "replace" | "replace_all" | "replace_older" | "rename")[];
        source: ArchiveConflictItem;
        target: ArchiveConflictItem;
      }
    | {
        kind: "member_error";
        source_session_id: string;
        delivery_sequence: number;
        decision_revision: number;
        member_path: string;
        target_path: string;
        message: string;
        partial_output: boolean;
        allowed_actions: ("retry" | "ignore")[];
      };
}

export interface LocalArchiveRelayExtractionStatus {
  source_session_id: string;
  phase: "ready" | "current" | "streaming_current" | "awaiting_result" | "awaiting_decision" | "completed" | "failed" | "cancelled";
  aggregate_counters: {
    members_processed: number;
    members_completed: number;
    members_skipped: number;
    members_failed: number;
    files_extracted: number;
    directories_created: number;
    extracted_bytes: number;
    files_replaced: number;
  };
  pending_decision:
    | {
        revision: number;
        kind: "collision";
        member_path: string;
        delivery_sequence: number;
        is_directory: boolean;
        allowed_actions: ArchiveExtractionDecisionAction[];
        source: ArchiveConflictItem;
        target: ArchiveConflictItem;
      }
    | {
        revision: number;
        kind: "member_error";
        member_path: string;
        target_path: string | null;
        message: string | null;
        delivery_sequence: number;
        is_directory: boolean;
        allowed_actions: ArchiveExtractionDecisionAction[];
      }
    | null;
}

export interface ArchiveConflictItem {
  path: string;
  size: number | null;
  modified_at: string | null;
}

export interface ArchiveRelayExtractionResponse {
  members_processed: number;
  members_completed: number;
  members_skipped: number;
  members_failed: number;
  files_extracted: number;
  directories_created: number;
  extracted_bytes: number;
  files_replaced: number;
  phase?: "awaiting_user_decision";
}

export interface ArchiveLiveExtractionStatus {
  source_session_id: string;
  phase: "ready" | "current" | "streaming_current" | "awaiting_result" | "awaiting_decision" | "completed" | "failed" | "cancelled";
  aggregate_counters: LocalArchiveRelayExtractionStatus["aggregate_counters"];
  pending_decision: LocalArchiveRelayExtractionStatus["pending_decision"];
}

function isLocalArchiveStaleRevisionError(error: unknown): boolean {
  return (error as { response?: { status?: unknown } } | null)?.response?.status === 409;
}

function isLocalArchiveExecutionTerminal(execution: LocalArchiveExecution): boolean {
  return execution.phase === "completed" || execution.phase === "cancelled" || execution.phase === "failed";
}

export const PDF_VIEWER_REQUEST_TIMEOUT_MS = 90_000;
export const OIDC_FINALIZATION_REQUEST_TIMEOUT_MS = 15_000;

function getDevicePixelDimension(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * window.devicePixelRatio);
}

let controlledReauthenticationInProgress = false;
let oidcExchangePending = window.location.pathname === "/login/oidc/callback";
export function setOidcExchangePending(pending: boolean): void {
  oidcExchangePending = pending;
}

export function isOidcExchangePending(): boolean {
  return oidcExchangePending;
}

export function isControlledReauthenticationInProgress(): boolean {
  return controlledReauthenticationInProgress;
}

function isPublicAuthRequest(url: string): boolean {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    return pathname.endsWith("/auth/token") || pathname.endsWith("/auth/oidc/exchange");
  } catch {
    return false;
  }
}

export function startControlledReauthentication(): void {
  if (oidcExchangePending) return;
  controlledReauthenticationInProgress = true;
  clearBrowserRecoverySnapshot();
  snapshotRegisteredDrafts();
  if (window.location.pathname !== "/login") {
    window.location.assign(
      `/login?return_path=${encodeURIComponent(sanitizeReturnPath(window.location.pathname + window.location.search))}`
    );
  }
}

authSession.setReauthenticationHandler(startControlledReauthentication);

function isConfirmedOidcReauthentication(error: AxiosError): boolean {
  const data = error.response?.data as { detail?: { code?: string } } | undefined;
  return data?.detail?.code === "oidc_reauthentication_required";
}

function isViewerBlobRequest(config: AxiosError["config"] | undefined): boolean {
  const method = config?.method?.toLowerCase();
  if (method && method !== "get") {
    return false;
  }

  const rawUrl = config?.url;
  if (!rawUrl) {
    return false;
  }

  try {
    const resolvedUrl = new URL(rawUrl, window.location.origin);
    return /^\/api\/viewer\/[^/]+\/file$/.test(resolvedUrl.pathname) || /^\/viewer\/[^/]+\/file$/.test(resolvedUrl.pathname);
  } catch {
    return false;
  }
}

function normalizeUser(user: User): User {
  return { ...user };
}

function getResponseContentType(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function getCompanionServerUrl(apiBaseUrl: string | undefined): string {
  if (!apiBaseUrl || apiBaseUrl === API_PATH_SUFFIX) {
    return window.location.origin;
  }

  const resolvedUrl = new URL(apiBaseUrl, window.location.origin);
  const normalizedPath = resolvedUrl.pathname.replace(/\/+$/, "");

  if (normalizedPath === API_PATH_SUFFIX) {
    resolvedUrl.pathname = "";
  } else if (normalizedPath.endsWith(API_PATH_SUFFIX)) {
    resolvedUrl.pathname = normalizedPath.slice(0, -API_PATH_SUFFIX.length) || "/";
  }

  resolvedUrl.search = "";
  resolvedUrl.hash = "";

  return resolvedUrl.toString().replace(/\/$/, "");
}

class ApiService {
  private api: AxiosInstance;
  /** Separate axios instance for companion requests (no Bearer interceptor). */
  private companionApi: AxiosInstance;

  constructor() {
    // Use absolute URL for tests (required by MSW), relative for production
    const baseURL = import.meta.env["VITE_API_URL"] || (import.meta.env.MODE === "test" ? "http://localhost:3000/api" : "/api");
    this.api = axios.create({
      baseURL,
    });

    // Add auth token to requests
    this.api.interceptors.request.use(
      async (config) => {
        const url = config.url ?? "";
        const publicAuthRequest = isPublicAuthRequest(url);
        if (!publicAuthRequest && !oidcExchangePending) {
          const tokenBeforeRefresh = authSession.getAccessToken();
          try {
            await authSession.refreshIfNeeded();
          } catch (error) {
            if (error instanceof AuthSessionError && error.code === "reauthentication-required") {
              if (!oidcExchangePending && (!authSession.getAccessToken() || authSession.getAccessToken() === tokenBeforeRefresh)) {
                startControlledReauthentication();
              }
              return Promise.reject(error);
            }
            if (!(error instanceof AuthSessionError)) {
              return Promise.reject(error);
            }
          }
        }
        const token = authSession.getAccessToken();
        (config as typeof config & { _oidcExchangePending?: boolean })._oidcExchangePending = oidcExchangePending;
        if (token) {
          config.headers["Authorization"] = `Bearer ${token}`;
        }

        // Log API request
        logger.debug(
          `API Request: ${config.method?.toUpperCase()} ${config.url}`,
          {
            method: config.method,
            url: config.url,
          },
          "api"
        );
        return config;
      },
      (error) => {
        logger.error("API request setup failed", { error: error.message }, "api");
        return Promise.reject(error);
      }
    );

    // Handle auth errors and log responses
    this.api.interceptors.response.use(
      (response) => {
        markBackendAvailable();
        logger.debug(
          `API Response: ${response.config.method?.toUpperCase()} ${response.config.url}`,
          {
            status: response.status,
            statusText: response.statusText,
          },
          "api"
        );
        return response;
      },
      (error: AxiosError) => {
        const config = error.config as (AxiosRequestConfig & { _oidcRetried?: boolean; _oidcExchangePending?: boolean }) | undefined;
        const sentAuthorization = error.config?.headers?.get?.("Authorization") ?? error.config?.headers?.Authorization;
        const obsoleteSession = () => {
          const currentToken = authSession.getAccessToken();
          return (
            currentToken &&
            typeof sentAuthorization === "string" &&
            sentAuthorization.startsWith("Bearer ") &&
            sentAuthorization !== `Bearer ${currentToken}`
          );
        };
        if (error.response?.status === 403 && !obsoleteSession()) {
          const body = error.response.data as { detail?: { code?: string } } | undefined;
          if (body?.detail?.code === "password_change_required") {
            setPasswordChangeRequired(true);
            return Promise.reject(error);
          }
        }
        if (error.response?.status === 401 && (oidcExchangePending || config?._oidcExchangePending || obsoleteSession())) {
          return Promise.reject(error);
        }
        const backendSnapshot = getBackendAvailabilitySnapshot();
        const viewerBlobRequest = isViewerBlobRequest(error.config);
        const suppressViewerBlobErrorLog = viewerBlobRequest && isBackendConnectivityError(error);

        if (axios.isCancel(error) || error.code === "ERR_CANCELED" || isLocalAbortError(error)) {
          return Promise.reject(error);
        }

        if (!viewerBlobRequest && isBackendConnectivityError(error)) {
          if (backendSnapshot.status === "unavailable") {
            markBackendUnavailable(error.message);
          } else {
            markBackendReconnecting(error.message);
          }
        } else if (!viewerBlobRequest && error.response?.status) {
          if (error.response.status === 401 && backendSnapshot.recoveryLock) {
            markBackendReconnecting("Authenticated backend session is not ready yet.");
          } else {
            markBackendAvailable();
          }
        }

        const requestId = logger.extractRequestId(error.response?.headers as Record<string, string>);

        // Log the error with context
        if (!suppressViewerBlobErrorLog) {
          logger.error(
            "API request failed",
            {
              method: error.config?.method,
              url: error.config?.url,
              status: error.response?.status,
              statusText: error.response?.statusText,
              message: error.message,
            },
            "api"
          );
        }
        if (error.response?.status === 401) {
          const confirmedOidcReauthentication = isConfirmedOidcReauthentication(error);
          if (backendSnapshot.recoveryLock && !confirmedOidcReauthentication) {
            logger.warn(
              "Suppressing logout redirect during backend recovery",
              {
                url: error.config?.url,
                requestId,
              },
              "api"
            );
            return Promise.reject(error);
          }

          const method = config?.method?.toLowerCase();
          const safeMethod = method === "get" || method === "head" || method === "options";
          const url = config?.url ?? "";
          const publicAuthRequest = isPublicAuthRequest(url);
          if (!publicAuthRequest && confirmedOidcReauthentication) {
            startControlledReauthentication();
            return Promise.reject(error);
          }
          if (safeMethod && !publicAuthRequest && config !== undefined && !config._oidcRetried) {
            const retryConfig = config;
            return authSession.requestRefresh().then(
              () => {
                if (obsoleteSession() || oidcExchangePending) return Promise.reject(error);
                retryConfig._oidcRetried = true;
                return this.api.request(retryConfig);
              },
              (refreshError: unknown) => {
                if (obsoleteSession() || oidcExchangePending) return Promise.reject(error);
                if (
                  refreshError instanceof AuthSessionError &&
                  (refreshError.code === "transient" || (refreshError.code === "refresh-uncertain" && authSession.hasUsableAccessToken()))
                ) {
                  return Promise.reject(error);
                }
                startControlledReauthentication();
                return Promise.reject(error);
              }
            );
          }
        }
        return Promise.reject(error);
      }
    );

    // Companion requests are signed after axios has assembled their URL and query.
    this.companionApi = axios.create({
      baseURL: COMPANION_BASE_URL,
      timeout: 10_000,
    });
    this.companionApi.interceptors.request.use(async (config) => {
      Object.assign(config.headers, await companionSession.getSigningHeaders(config.method ?? "GET", this.companionApi.getUri(config)));
      return config;
    });
  }

  // ── Routing helpers ─────────────────────────────────────────────────────

  /**
   * Build HMAC auth headers for companion requests.
   */
  private async buildCompanionHeaders(method: string, url: string): Promise<Record<string, string>> {
    return companionSession.getSigningHeaders(method, url);
  }

  /**
   * Build HMAC auth as URL query parameters for companion viewer URLs.
   *
   * Used for `<img src>` / `<iframe>` contexts where headers can't be set.
   * Returns a query string fragment: `hmac=...&ts=...&origin=...`
   */
  private async buildCompanionQueryAuth(url: string): Promise<string> {
    return companionSession.getSignedQuery("GET", url);
  }

  /**
   * Get the correct axios instance and extra config for a connection.
   *
   * For local drives: returns the companion instance + HMAC headers.
   * For server connections: returns the main instance (Bearer via interceptor).
   */
  private async getClientConfig(connectionId: string): Promise<{ client: AxiosInstance; extraConfig: ClientConfig }> {
    if (isLocalDrive(connectionId)) {
      return { client: this.companionApi, extraConfig: {} };
    }
    return { client: this.api, extraConfig: {} };
  }

  private authenticatedArchiveRelayConfig(extraConfig: ClientConfig): ClientConfig {
    const accessToken = authSession.getAccessToken();
    if (!accessToken) {
      throw new Error("Authentication is required to start archive extraction");
    }
    return {
      ...extraConfig,
      headers: {
        ...extraConfig.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    };
  }

  supportsEditLocks(connectionId: string): boolean {
    return Boolean(connectionId);
  }

  // Auth endpoints
  async login(username: string, password: string): Promise<AuthToken> {
    logger.info("Login attempt", { username }, "api");

    const formData = new FormData();
    formData.append("username", username);
    formData.append("password", password);

    const response = await this.api.post<AuthToken>("/auth/token", formData);
    authSession.setAuthenticated(response.data, false);

    logger.info(
      "Login successful",
      {
        username: response.data.username,
        hasToken: !!response.data.access_token,
        isAdmin: response.data.role === "admin",
      },
      "api"
    );
    return response.data;
  }

  async exchangeOidcGrant(grant: string): Promise<AuthToken> {
    const response = await this.api.post<AuthToken>("/auth/oidc/exchange", { grant });
    return response.data;
  }

  async getCurrentUser(): Promise<User> {
    logger.debug("Fetching current user info", {}, "api");
    const response = await this.api.get<User>("/auth/me");
    return normalizeUser(response.data);
  }

  async getCurrentAccount(): Promise<CurrentAccount> {
    const response = await this.api.get<CurrentAccount>("/auth/account");
    return normalizeUser(response.data) as CurrentAccount;
  }

  async getOidcBrowserSessions(): Promise<OidcBrowserSessionList> {
    const response = await this.api.get<OidcBrowserSessionList>("/auth/oidc/sessions");
    return response.data;
  }

  async revokeOidcBrowserSession(sessionId: string): Promise<OidcBrowserSessionRevokeResult> {
    const response = await this.api.post<OidcBrowserSessionRevokeResult>(`/auth/oidc/sessions/${sessionId}/revoke`);
    return response.data;
  }

  async getCurrentUserSettings(): Promise<CurrentUserSettings> {
    const response = await this.api.get<CurrentUserSettings>("/auth/me/settings");
    return response.data;
  }

  async getThemes(): Promise<ThemeList> {
    const response = await this.api.get<ThemeList>("/themes");
    return response.data;
  }

  async createTheme(definition: Omit<ThemeConfig, "id">, scope: StoredTheme["scope"]): Promise<StoredTheme> {
    const response = await this.api.post<StoredTheme>("/themes", { definition, scope });
    return response.data;
  }

  async updateTheme(theme: StoredTheme, definition: Omit<ThemeConfig, "id">): Promise<StoredTheme> {
    const response = await this.api.put<StoredTheme>(`/themes/${theme.id}`, { definition, scope: theme.scope, version: theme.version });
    return response.data;
  }

  async deleteTheme(theme: StoredTheme): Promise<void> {
    await this.api.delete(`/themes/${theme.id}`, { params: { version: theme.version } });
  }

  async setSiteDefaultTheme(themeId: string): Promise<ThemeList> {
    const response = await this.api.put<ThemeList>(`/themes/default/${themeId}`);
    return response.data;
  }

  async updateCurrentUserSettings(
    payload: CurrentUserSettingsUpdate,
    options?: { signal?: AbortSignal }
  ): Promise<CurrentUserSettingsUpdate> {
    const response = options
      ? await this.api.put<CurrentUserSettingsUpdate>("/auth/me/settings", payload, options)
      : await this.api.put<CurrentUserSettingsUpdate>("/auth/me/settings", payload);
    return response.data;
  }

  async validateToken(): Promise<boolean> {
    try {
      await this.getCurrentUser();
      return true;
    } catch {
      return false;
    }
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.api.post("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  }

  // Connection endpoints
  async getConnections(): Promise<Connection[]> {
    const response = await this.api.get<Connection[]>(CONNECTIONS_API_BASE);
    return response.data;
  }

  async createConnection(connection: ConnectionCreate): Promise<Connection> {
    const response = await this.api.post<Connection>(CONNECTIONS_API_BASE, connection);
    return response.data;
  }

  async getConnectionVisibilityOptions(): Promise<ConnectionVisibilityOption[]> {
    const response = await this.api.get<ConnectionVisibilityOption[]>(`${CONNECTIONS_API_BASE}/visibility-options`);
    return response.data;
  }

  async updateConnection(connectionId: string, connection: Partial<ConnectionCreate>): Promise<Connection> {
    const response = await this.api.put<Connection>(`${CONNECTIONS_API_BASE}/${connectionId}`, connection);
    return response.data;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.api.delete(`${CONNECTIONS_API_BASE}/${connectionId}`);
  }

  async testConnection(connectionId: string, connection?: Partial<ConnectionCreate>): Promise<{ status: string; message: string }> {
    const response = connection
      ? await this.api.post(`${CONNECTIONS_API_BASE}/${connectionId}/test`, connection)
      : await this.api.post(`${CONNECTIONS_API_BASE}/${connectionId}/test`);
    return response.data;
  }

  async testConnectionConfig(connection: ConnectionCreate): Promise<{ status: string; message: string }> {
    const response = await this.api.post(`${CONNECTIONS_API_BASE}/test-config`, connection);
    return response.data;
  }

  async getUsers(query: AdminUserListQuery = {}): Promise<AdminUserListResponse> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    for (const role of query.roles ?? []) params.append("role", role);
    for (const state of query.states ?? []) params.append("state", state);
    for (const authentication of query.authentication ?? []) params.append("auth", authentication);
    for (const oidcState of query.oidcStates ?? []) params.append("oidc_state", oidcState);
    for (const roleSource of query.roleSources ?? []) params.append("role_source", roleSource);
    if (query.expiration) params.set("expiration", query.expiration);
    if (query.sort) params.set("sort", query.sort);
    if (query.direction) params.set("direction", query.direction);
    if (query.page) params.set("page", String(query.page));
    if (query.pageSize) params.set("page_size", String(query.pageSize));

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.api.get<AdminUserListResponse>(`/admin/users${suffix}`);
    return response.data;
  }

  async getOidcConfiguration(): Promise<OidcAdminConfigurationRead> {
    const response = await this.api.get<OidcAdminConfigurationRead>("/admin/auth/oidc");
    return response.data;
  }

  async startOidcTest(candidate: OidcConfigurationCandidate): Promise<OidcTestStartResponse> {
    const response = await this.api.post<OidcTestStartResponse>("/admin/auth/oidc/test", candidate);
    return response.data;
  }

  async getOidcTestResult(flowId: string, reviewedPolicy?: OidcReviewedPolicy): Promise<OidcTestedIdentity> {
    const response = await this.api.post<OidcTestedIdentity>(`/admin/auth/oidc/test-flows/${flowId}/preview`, {
      reviewed_policy: reviewedPolicy,
    });
    return response.data;
  }

  async cancelOidcTestFlow(flowId: string): Promise<void> {
    await this.api.delete(`/admin/auth/oidc/test-flows/${flowId}`);
  }

  async finalizeOidcConfiguration(
    flowId: string,
    reviewedPolicy: OidcReviewedPolicy,
    replacementMappings: Array<{ target_user_id: string; expected_username: string }>,
    expectedIdentityMappingRevision: number | null,
    omittedAccountAcknowledgements: string[]
  ): Promise<OidcFinalizeResponse> {
    const response = await this.api.post<OidcFinalizeResponse>(
      "/admin/auth/oidc/finalize",
      {
        flow_id: flowId,
        reviewed_policy: reviewedPolicy,
        replacement_mappings: replacementMappings,
        expected_identity_mapping_revision: expectedIdentityMappingRevision,
        omitted_account_acknowledgements: omittedAccountAcknowledgements,
      },
      {
        timeout: OIDC_FINALIZATION_REQUEST_TIMEOUT_MS,
      }
    );
    return response.data;
  }

  async setPasswordOnlyAuthentication(
    expectedConfigurationRevision: number,
    expectedActivePasswordlessUserCount: number,
    acknowledgePasswordlessAccountLoss: boolean
  ): Promise<OidcFinalizeResponse> {
    const response = await this.api.post<OidcFinalizeResponse>("/admin/auth/password-only", {
      expected_configuration_revision: expectedConfigurationRevision,
      expected_active_passwordless_user_count: expectedActivePasswordlessUserCount,
      acknowledge_passwordless_account_loss: acknowledgePasswordlessAccountLoss,
    });
    return response.data;
  }

  async activateAuthenticationMode(
    mode: Exclude<AuthenticationMode, "oidc_or_password" | "oidc_only">,
    acknowledgeNoAuthentication = false
  ): Promise<AuthenticationModeActivationResponse> {
    const response = await this.api.post<AuthenticationModeActivationResponse>("/admin/auth/mode", {
      mode,
      acknowledge_no_authentication: acknowledgeNoAuthentication,
    });
    return response.data;
  }

  async putPendingOidcMappings(
    expectedIdentityMappingRevision: number,
    mappings: Array<{ target_user_id: string; expected_username: string }>
  ): Promise<OidcMappingMutationResponse> {
    const response = await this.api.put<OidcMappingMutationResponse>("/admin/auth/oidc/mappings/pending", {
      expected_identity_mapping_revision: expectedIdentityMappingRevision,
      mappings,
    });
    return response.data;
  }

  async cancelPendingOidcMapping(userId: string, expectedIdentityMappingRevision: number): Promise<OidcMappingMutationResponse> {
    const response = await this.api.delete<OidcMappingMutationResponse>(`/admin/auth/oidc/mappings/${userId}/pending`, {
      params: { expected_identity_mapping_revision: expectedIdentityMappingRevision },
    });
    return response.data;
  }

  async changeOidcIdentity(
    userId: string,
    expectedIdentityMappingRevision: number,
    expectedUsername: string
  ): Promise<OidcMappingMutationResponse> {
    const response = await this.api.post<OidcMappingMutationResponse>(`/admin/auth/oidc/mappings/${userId}/change`, {
      expected_identity_mapping_revision: expectedIdentityMappingRevision,
      expected_username: expectedUsername,
    });
    return response.data;
  }

  async moveOidcIdentity(
    identityId: string,
    expectedIdentityMappingRevision: number,
    targetUserId: string
  ): Promise<OidcMappingMutationResponse> {
    const response = await this.api.post<OidcMappingMutationResponse>(`/admin/auth/oidc/mappings/${identityId}/move`, {
      expected_identity_mapping_revision: expectedIdentityMappingRevision,
      target_user_id: targetUserId,
    });
    return response.data;
  }

  async detachOidcIdentity(userId: string, expectedIdentityMappingRevision: number): Promise<OidcMappingMutationResponse> {
    const response = await this.api.delete<OidcMappingMutationResponse>(`/admin/auth/oidc/mappings/${userId}`, {
      params: { expected_identity_mapping_revision: expectedIdentityMappingRevision },
    });
    return response.data;
  }

  async createUser(user: AdminUserCreateInput): Promise<AdminUserCreateResult> {
    const response = await this.api.post<AdminUserCreateResult>("/admin/users", user);
    return response.data;
  }

  async updateUser(userId: string, user: AdminUserUpdateInput): Promise<AdminUser> {
    const response = await this.api.patch<AdminUser>(`/admin/users/${userId}`, user);
    return response.data;
  }

  async resetUserPassword(userId: string, payload: AdminUserPasswordResetInput): Promise<AdminUserPasswordResetResult> {
    const response = await this.api.post<AdminUserPasswordResetResult>(`/admin/users/${userId}/reset-password`, payload);
    return response.data;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.api.delete(`/admin/users/${userId}`);
  }

  async getAdvancedSettings(): Promise<AdvancedSystemSettings> {
    const response = await this.api.get<AdvancedSystemSettings>("/admin/settings/advanced");
    return response.data;
  }

  async getAboutSettings(): Promise<AboutSettings> {
    const response = await this.api.get<AboutSettings>("/admin/settings/about");
    return response.data;
  }

  async getPublicSupportReport(): Promise<PublicSupportReport> {
    const response = await this.api.get<PublicSupportReport>("/admin/settings/support-report");
    return response.data;
  }

  async getCompanionDownloads(): Promise<CompanionDownloadMetadata> {
    const response = await this.api.get<CompanionDownloadMetadata>("/companion/downloads");
    return response.data;
  }

  async updateAdvancedSettings(
    payload: AdvancedSystemSettingsUpdate,
    options?: { signal?: AbortSignal }
  ): Promise<AdvancedSystemSettingsUpdate> {
    const response = options
      ? await this.api.put<AdvancedSystemSettingsUpdate>("/admin/settings/advanced", payload, options)
      : await this.api.put<AdvancedSystemSettingsUpdate>("/admin/settings/advanced", payload);
    return response.data;
  }

  async getFileSearchSettings(): Promise<FileSearchSettingsRead> {
    const response = await this.api.get<FileSearchSettingsRead>("/admin/settings/file-search");
    return response.data;
  }

  async updateFileSearchSettings(payload: FileSearchSettingsUpdate, options?: { signal?: AbortSignal }): Promise<FileSearchSettingsUpdate> {
    const response = options
      ? await this.api.put<FileSearchSettingsUpdate>("/admin/settings/file-search", payload, options)
      : await this.api.put<FileSearchSettingsUpdate>("/admin/settings/file-search", payload);
    return response.data;
  }

  // Recent-file history is server-owned metadata, including for local-drive files.
  async recordRecentFile(connectionId: string, path: string): Promise<RecentFile | null> {
    const response = await this.api.post<RecentFile | null>("/browse/recent-files", {
      connection_id: connectionId,
      path,
      is_regular_file: true,
    });
    return response.data;
  }

  async searchRecentFiles(query: string, limit: number, signal?: AbortSignal): Promise<RecentFileSearchResponse> {
    const response = await this.api.get<RecentFileSearchResponse>("/browse/recent-files", {
      params: { q: query, limit },
      signal,
    });
    return response.data;
  }

  async validateRecentFileTarget(recordId: string): Promise<FileInfo> {
    const response = await this.api.get<FileInfo>(`/browse/recent-files/${recordId}/target`);
    return response.data;
  }

  async removeRecentFile(recordId: string): Promise<void> {
    await this.api.delete(`/browse/recent-files/${recordId}`);
  }

  async clearRecentFiles(): Promise<number> {
    const response = await this.api.delete<{ deleted_count: number }>("/browse/recent-files");
    return response.data.deleted_count;
  }

  async recordRecentDirectory(connectionId: string, path: string): Promise<RecentDirectory | null> {
    const response = await this.api.post<RecentDirectory | null>("/browse/recent-directories", {
      connection_id: connectionId,
      path,
      is_directory: true,
    });
    return response.data;
  }

  async searchRecentDirectories(query: string, limit: number, signal?: AbortSignal): Promise<RecentDirectorySearchResponse> {
    const response = await this.api.get<RecentDirectorySearchResponse>("/browse/recent-directories", {
      params: { q: query, limit },
      signal,
    });
    return response.data;
  }

  async removeRecentDirectory(recordId: string): Promise<void> {
    await this.api.delete(`/browse/recent-directories/${recordId}`);
  }

  async clearRecentDirectories(): Promise<number> {
    const response = await this.api.delete<{ deleted_count: number }>("/browse/recent-directories");
    return response.data.deleted_count;
  }

  async getSmbSettings(): Promise<SmbSettings> {
    const response = await this.api.get<SmbSettings>("/admin/settings/smb");
    return response.data;
  }

  async updateSmbSettings(payload: SmbSettingsUpdate, options?: { signal?: AbortSignal }): Promise<SmbSettingsUpdate> {
    const response = options
      ? await this.api.put<SmbSettingsUpdate>("/admin/settings/smb", payload, options)
      : await this.api.put<SmbSettingsUpdate>("/admin/settings/smb", payload);
    return response.data;
  }

  async getNetworkSettings(): Promise<NetworkSettings> {
    const response = await this.api.get<NetworkSettings>("/admin/settings/network");
    return response.data;
  }

  async updateNetworkSettings(payload: NetworkSettingsUpdate, options?: { signal?: AbortSignal }): Promise<NetworkSettingsUpdate> {
    const response = options
      ? await this.api.put<NetworkSettingsUpdate>("/admin/settings/network", payload, options)
      : await this.api.put<NetworkSettingsUpdate>("/admin/settings/network", payload);
    return response.data;
  }

  // Browse endpoints
  async listDirectory(
    connectionId: string,
    path: string = "",
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<DirectoryListing> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<DirectoryListing>(`/browse/${segment}/list`, {
      ...extraConfig,
      params: { path },
      timeout: options?.timeoutMs ?? DIRECTORY_LIST_REQUEST_TIMEOUT_MS,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }

  async listArchiveDirectory(
    connectionId: string,
    archivePath: string,
    virtualPath = "",
    options?: { cursor?: string; pageSize?: number; signal?: AbortSignal }
  ): Promise<ArchiveDirectoryListing> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const path = isLocalDrive(connectionId) ? `/browse/${segment}/archive/v2/list` : "/archive/v2/inspection/directory";
    const response = await client.get<ArchiveDirectoryListing>(path, {
      ...extraConfig,
      params: {
        ...(isLocalDrive(connectionId) ? {} : { connection_id: connectionId }),
        contract_version: "v2",
        archive_path: archivePath,
        virtual_path: virtualPath,
        cursor: options?.cursor,
        page_size: options?.pageSize,
      },
      signal: options?.signal,
    });
    return response.data;
  }

  async getArchiveMember(
    connectionId: string,
    archivePath: string,
    memberPath: string,
    options: {
      download?: boolean;
      request?:
        | { kind: "raw" }
        | { kind: "text" }
        | { kind: "image"; viewportWidth?: number; viewportHeight?: number; noResizing?: boolean }
        | { kind: "pdf"; variant?: "normalized"; screenProfile?: { width: number; height: number; zoomPercent: number } };
      signal?: AbortSignal;
    } = {}
  ): Promise<Blob> {
    try {
      const segment = getBrowseSegment(connectionId);
      const { client, extraConfig } = await this.getClientConfig(connectionId);
      const localDrive = isLocalDrive(connectionId);
      const path = localDrive ? `/viewer/${segment}/archive/v2/member` : "/archive/v2/inspection/member";
      const response = await client.get<Blob>(path, {
        ...extraConfig,
        params: {
          ...(localDrive ? {} : { connection_id: connectionId }),
          contract_version: "v2",
          archive_path: archivePath,
          member_path: memberPath,
          download: options.download ?? false,
          ...(!localDrive ? { view_kind: options.request?.kind ?? "raw" } : {}),
          ...(!localDrive && options.request?.kind === "image"
            ? {
                viewport_width: getDevicePixelDimension(options.request.viewportWidth),
                viewport_height: getDevicePixelDimension(options.request.viewportHeight),
                no_resizing: options.request.noResizing ? 1 : undefined,
              }
            : {}),
          ...(!localDrive && options.request?.kind === "pdf"
            ? {
                pdf_variant: options.request.variant,
                screen_width: options.request.screenProfile?.width,
                screen_height: options.request.screenProfile?.height,
                screen_zoom_percent: options.request.screenProfile?.zoomPercent,
              }
            : {}),
        },
        responseType: "blob",
        signal: options.signal,
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
        try {
          const data = JSON.parse(await error.response.data.text());
          throw { ...error, response: { ...error.response, data } };
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) {
            throw parseError;
          }
        }
      }
      throw error;
    }
  }

  async startLocalArchiveExtraction(
    connectionId: string,
    archivePath: string,
    destinationPath: string,
    selectedMemberPaths?: string[],
    destinationConnectionId?: string
  ): Promise<LocalArchiveExecution> {
    return this.startLocalArchiveExecution(connectionId, {
      kind: "extract",
      contract_version: "v2",
      archive_path: archivePath,
      destination_path: destinationPath,
      ...(selectedMemberPaths ? { selected_member_paths: selectedMemberPaths } : {}),
      ...(destinationConnectionId && destinationConnectionId !== connectionId
        ? { destination_drive: getBrowseSegment(destinationConnectionId) }
        : {}),
    });
  }

  async startLocalArchiveCreation(connectionId: string, sourcePaths: string[], targetPath: string): Promise<LocalArchiveExecution> {
    return this.startLocalArchiveExecution(connectionId, {
      kind: "create",
      contract_version: "v2",
      source_paths: sourcePaths,
      target_path: targetPath,
    });
  }

  private async startLocalArchiveExecution(
    connectionId: string,
    body:
      | {
          kind: "extract";
          contract_version: "v2";
          archive_path: string;
          destination_path: string;
          selected_member_paths?: string[];
          destination_drive?: string;
        }
      | { kind: "create"; contract_version: "v2"; source_paths: string[]; target_path: string }
  ): Promise<LocalArchiveExecution> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<LocalArchiveExecution>(`/browse/${segment}/archive/v2/executions`, body, extraConfig);
    return response.data;
  }

  async getLocalArchiveExtraction(connectionId: string, executionId: string): Promise<LocalArchiveExecution> {
    return this.getLocalArchiveExecution(connectionId, executionId);
  }

  async getLocalArchiveExecution(connectionId: string, executionId: string): Promise<LocalArchiveExecution> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<LocalArchiveExecution>(
      `/browse/${segment}/archive/v2/executions/${encodeURIComponent(executionId)}`,
      extraConfig
    );
    return response.data;
  }

  async cancelLocalArchiveExtraction(connectionId: string, executionId: string, expectedRevision: number): Promise<LocalArchiveExecution> {
    return this.cancelLocalArchiveExecution(connectionId, executionId, expectedRevision);
  }

  async cancelLocalArchiveExecution(connectionId: string, executionId: string, expectedRevision: number): Promise<LocalArchiveExecution> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<LocalArchiveExecution>(
      `/browse/${segment}/archive/v2/executions/${encodeURIComponent(executionId)}/cancellation`,
      { contract_version: "v2", expected_revision: expectedRevision },
      extraConfig
    );
    return response.data;
  }

  async decideLocalArchiveExecution(
    connectionId: string,
    executionId: string,
    expectedRevision: number,
    sourceSessionId: string,
    deliverySequence: number,
    decisionRevision: number,
    memberPath: string,
    action: "skip" | "skip_all" | "replace" | "replace_all" | "replace_older" | "rename" | "retry" | "ignore",
    targetPath?: string
  ): Promise<LocalArchiveExecution> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<LocalArchiveExecution>(
      `/browse/${segment}/archive/v2/executions/${encodeURIComponent(executionId)}/decision`,
      {
        contract_version: "v2",
        expected_revision: expectedRevision,
        source_session_id: sourceSessionId,
        delivery_sequence: deliverySequence,
        decision_revision: decisionRevision,
        member_path: memberPath,
        action,
        target_path: targetPath,
      },
      extraConfig
    );
    return response.data;
  }

  async cancelLocalArchiveExecutionWithRevisionRetry(
    connectionId: string,
    executionId: string,
    expectedRevision: number
  ): Promise<LocalArchiveExecution> {
    let execution = { execution_id: executionId, revision: expectedRevision };
    for (let attempt = 0; attempt < LOCAL_ARCHIVE_CANCELLATION_MAX_REVISION_RETRIES; attempt += 1) {
      try {
        return await this.cancelLocalArchiveExecution(connectionId, execution.execution_id, execution.revision);
      } catch (error) {
        if (!isLocalArchiveStaleRevisionError(error) || attempt + 1 === LOCAL_ARCHIVE_CANCELLATION_MAX_REVISION_RETRIES) {
          throw error;
        }
        const latest = await this.getLocalArchiveExecution(connectionId, execution.execution_id);
        if (isLocalArchiveExecutionTerminal(latest)) {
          return latest;
        }
        execution = latest;
      }
    }
    throw new Error("Local archive execution changed too frequently to cancel");
  }

  async waitForLocalArchiveExecution(
    connectionId: string,
    executionId: string,
    onUpdate?: (execution: LocalArchiveExecution) => void
  ): Promise<LocalArchiveExecution> {
    let execution = await this.getLocalArchiveExecution(connectionId, executionId);
    onUpdate?.(execution);
    while (!isLocalArchiveExecutionTerminal(execution) && execution.phase !== "awaiting_user_decision") {
      await new Promise<void>((resolve) => window.setTimeout(resolve, LOCAL_ARCHIVE_EXECUTION_POLL_INTERVAL_MS));
      execution = await this.getLocalArchiveExecution(connectionId, executionId);
      onUpdate?.(execution);
    }
    return execution;
  }

  async extractLocalArchiveToSmb(connectionId: string, archivePath: string, operationId: string): Promise<ArchiveRelayExtractionResponse> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post(
      `/browse/${segment}/archive/v2/relay/extraction`,
      {
        contract_version: "v2",
        archive_path: archivePath,
        operation_id: operationId,
      },
      this.authenticatedArchiveRelayConfig(extraConfig)
    );
    return response.data;
  }

  async decideLocalArchiveRelayExtraction(
    connectionId: string,
    operationId: string,
    sourceSessionId: string,
    deliverySequence: number,
    decisionRevision: number,
    action: ArchiveExtractionDecisionAction,
    memberPath: string,
    targetPath?: string
  ): Promise<ArchiveRelayExtractionResponse> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post(
      `/browse/${segment}/archive/v2/relay/extraction/${operationId}/decision`,
      {
        source_session_id: sourceSessionId,
        delivery_sequence: deliverySequence,
        decision_revision: decisionRevision,
        action,
        member_path: memberPath,
        target_path: targetPath,
      },
      extraConfig
    );
    return response.data;
  }

  async getLocalArchiveRelayExtractionStatus(connectionId: string, operationId: string): Promise<LocalArchiveRelayExtractionStatus> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get(`/browse/${segment}/archive/v2/relay/extraction/${operationId}/status`, extraConfig);
    return response.data;
  }

  async extractSmbArchiveToLocal(
    destinationConnectionId: string,
    destinationPath: string,
    operationId: string
  ): Promise<ArchiveRelayExtractionResponse> {
    const segment = getBrowseSegment(destinationConnectionId);
    const { client, extraConfig } = await this.getClientConfig(destinationConnectionId);
    const response = await client.post(
      `/browse/${segment}/archive/v2/relay/extraction`,
      {
        contract_version: "v2",
        destination_path: destinationPath,
        operation_id: operationId,
      },
      this.authenticatedArchiveRelayConfig(extraConfig)
    );
    return response.data;
  }

  async createSmbArchiveToLocal(
    destinationConnectionId: string,
    targetPath: string,
    operationId: string,
    operationToken: string
  ): Promise<{ files_created: number; directories_created: number; source_bytes: number }> {
    const segment = getBrowseSegment(destinationConnectionId);
    const { client, extraConfig } = await this.getClientConfig(destinationConnectionId);
    const response = await client.post(
      `/browse/${segment}/archive/v2/relay/creation`,
      {
        contract_version: "v2",
        target_path: targetPath,
        server_url: getCompanionServerUrl(this.api.defaults.baseURL),
        operation_id: operationId,
        operation_token: operationToken,
      },
      extraConfig
    );
    return response.data;
  }

  async createLocalArchiveToSmb(
    sourceConnectionId: string,
    sourcePaths: string[],
    targetPath: string,
    operationId: string,
    operationToken: string
  ): Promise<{ files_created: number; directories_created: number; source_bytes: number }> {
    const segment = getBrowseSegment(sourceConnectionId);
    const { client, extraConfig } = await this.getClientConfig(sourceConnectionId);
    const response = await client.post(
      `/browse/${segment}/archive/v2/relay/creation`,
      {
        contract_version: "v2",
        source_paths: sourcePaths,
        target_path: targetPath,
        server_url: getCompanionServerUrl(this.api.defaults.baseURL),
        operation_id: operationId,
        operation_token: operationToken,
      },
      extraConfig
    );
    return response.data;
  }

  async prepareArchiveOperation(payload: ArchiveOperationPrepare): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>("/archive/v2/operations", payload);
    return response.data;
  }

  async getArchiveOperation(operationId: string): Promise<ArchiveOperation> {
    const response = await this.api.get<ArchiveOperation>(`/archive/v2/operations/${operationId}`);
    return response.data;
  }

  async listArchiveOperations(activeOnly = false): Promise<ArchiveOperation[]> {
    const response = await this.api.get<ArchiveOperation[]>("/archive/v2/operations", { params: { active_only: activeOnly } });
    return response.data;
  }

  async getArchiveCompanionSession(operationId: string): Promise<ArchiveCompanionSession> {
    const response = await this.api.post<ArchiveCompanionSession>(`/archive/v2/operations/${operationId}/companion-session`);
    return response.data;
  }

  async transitionArchiveOperation(
    operationId: string,
    expectedPhase: ArchiveOperationPhase,
    nextPhase: ArchiveOperationPhase
  ): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>(`/archive/v2/operations/${operationId}/phase`, {
      expected_phase: expectedPhase,
      next_phase: nextPhase,
    });
    return response.data;
  }

  async executeArchiveCreation(operationId: string): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>(`/archive/v2/operations/${operationId}/creation/begin`);
    return response.data;
  }

  async executeArchiveExtraction(operationId: string): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>(`/archive/v2/operations/${operationId}/extraction/begin`);
    return response.data;
  }

  async getArchiveLiveExtractionStatus(operationId: string): Promise<ArchiveLiveExtractionStatus> {
    const response = await this.api.get<ArchiveLiveExtractionStatus>(`/archive/v2/operations/${operationId}/extraction/live-status`);
    return response.data;
  }

  async decideArchiveExtraction(
    operationId: string,
    action: ArchiveExtractionDecisionAction,
    memberPath?: string,
    targetPath?: string,
    liveDecision?: { sourceSessionId: string; deliverySequence: number; decisionRevision: number }
  ): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>(`/archive/v2/operations/${operationId}/extraction/decision`, {
      action,
      member_path: memberPath,
      target_path: targetPath,
      source_session_id: liveDecision?.sourceSessionId,
      delivery_sequence: liveDecision?.deliverySequence,
      decision_revision: liveDecision?.decisionRevision,
    });
    return response.data;
  }

  async cancelArchiveOperation(operationId: string): Promise<ArchiveOperation> {
    const response = await this.api.post<ArchiveOperation>(`/archive/v2/operations/${operationId}/cancel`);
    return response.data;
  }

  async getFileInfo(connectionId: string, path: string, options: { signal?: AbortSignal } = {}): Promise<FileInfo> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<FileInfo>(`/browse/${segment}/info`, {
      ...extraConfig,
      params: { path },
      signal: options.signal,
    });
    return response.data;
  }

  /** Resolve a local entry to its canonical drive-relative activation target. */
  async resolveLocalActivation(connectionId: string, path: string): Promise<LocalActivationResolution> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<LocalActivationResolution>(`/browse/${segment}/resolve-activation`, {
      ...extraConfig,
      params: { path },
    });
    return response.data;
  }

  /** Resolve display-safe target metadata for link sources in a local directory. */
  async listLocalLinkTargets(connectionId: string, path: string, options?: { signal?: AbortSignal }): Promise<LocalLinkTargetListing> {
    if (!isLocalDrive(connectionId)) {
      throw new Error("Link target metadata is only available for local drives");
    }

    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<LocalLinkTargetListing>(`/browse/${segment}/link-targets`, {
      ...extraConfig,
      params: { path },
      timeout: LOCAL_LINK_TARGET_REQUEST_TIMEOUT_MS,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    return response.data;
  }

  /**
   * Search for directories across an entire connection.
   * Returns matching directory paths from the server-side cache.
   */
  async searchDirectories(connectionId: string, query: string, options?: DirectorySearchOptions): Promise<DirectorySearchResult> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<DirectorySearchResult>(`/browse/${segment}/directories`, {
      ...extraConfig,
      params: {
        q: query,
        include_dot_directories: options?.includeDotDirectories ?? false,
      },
      signal: options?.signal,
    });
    return response.data;
  }

  /**
   * Delete a file or directory.
   */
  async deleteItem(connectionId: string, path: string): Promise<void> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.delete(`/browse/${segment}/item`, {
      ...extraConfig,
      params: { path },
    });
  }

  /** Remove a directory only when it contains no entries. */
  async removeEmptyDirectory(connectionId: string, path: string): Promise<void> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.delete(`/browse/${segment}/empty-directory`, {
      ...extraConfig,
      params: { path },
    });
  }

  /**
   * Rename a file or directory.
   *
   * Returns the updated FileInfo for the renamed item.
   */
  async renameItem(connectionId: string, path: string, newName: string): Promise<FileInfo> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<FileInfo>(
      `/browse/${segment}/rename`,
      {
        path,
        new_name: newName,
      },
      extraConfig
    );
    return response.data;
  }

  /**
   * Create a new file or directory.
   *
   * Returns the FileInfo for the newly created item.
   */
  async createItem(connectionId: string, parentPath: string, name: string, type: "file" | "directory"): Promise<FileInfo> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<FileInfo>(
      `/browse/${segment}/create`,
      {
        parent_path: parentPath,
        name,
        type,
      },
      extraConfig
    );
    return response.data;
  }

  /**
   * Copy a file or directory to a new location.
   *
   * When ``destConnectionId`` is provided and differs from ``connectionId``,
   * a same-owner cross-connection copy is performed. Different provider kinds
   * are streamed through the active browser relay.
   */
  async copyItem(
    connectionId: string,
    sourcePath: string,
    destPath: string,
    idempotencyKey: string,
    destConnectionId?: string,
    targetResolutionPolicy: TargetResolutionPolicy = "ask",
    options: Pick<CrossBackendTransferOptions, "signal" | "transferAttemptId"> = {}
  ): Promise<ContentTransferResult> {
    if (destConnectionId && this.isCrossBackendTransfer(connectionId, destConnectionId)) {
      return this.transferAcrossBackends("copy", connectionId, sourcePath, destConnectionId, destPath, targetResolutionPolicy, options);
    }
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const transferAttemptId = options.transferAttemptId ?? randomUuid();
    return this.postTransfer(
      client,
      `/browse/${segment}/copy`,
      {
        source_path: sourcePath,
        dest_path: destPath,
        dest_connection_id: destConnectionId,
        target_resolution_policy: targetResolutionPolicy,
        idempotency_key: idempotencyKey,
        transfer_attempt_id: transferAttemptId,
      },
      { ...extraConfig, signal: options.signal },
      () => this.cancelTransferAttempt(client, segment, transferAttemptId, extraConfig)
    );
  }

  /** Move a file or directory through its owning provider. */
  async moveItem(
    connectionId: string,
    sourcePath: string,
    destPath: string,
    idempotencyKey: string,
    destConnectionId?: string,
    targetResolutionPolicy: TargetResolutionPolicy = "ask",
    options: Pick<CrossBackendTransferOptions, "signal" | "transferAttemptId"> = {}
  ): Promise<ContentTransferResult> {
    if (destConnectionId && this.isCrossBackendTransfer(connectionId, destConnectionId)) {
      return this.transferAcrossBackends("move", connectionId, sourcePath, destConnectionId, destPath, targetResolutionPolicy, options);
    }
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const transferAttemptId = options.transferAttemptId ?? randomUuid();
    return this.postTransfer(
      client,
      `/browse/${segment}/move`,
      {
        source_path: sourcePath,
        dest_path: destPath,
        dest_connection_id: destConnectionId,
        target_resolution_policy: targetResolutionPolicy,
        idempotency_key: idempotencyKey,
        transfer_attempt_id: transferAttemptId,
      },
      { ...extraConfig, signal: options.signal },
      () => this.cancelTransferAttempt(client, segment, transferAttemptId, extraConfig)
    );
  }

  /**
   * Relay one regular file between different provider origins without reading
   * its bytes into browser memory. The destination endpoint owns staging and
   * exclusive publication; this coordinator owns no filesystem capability.
   */
  async transferAcrossBackends(
    kind: "copy" | "move",
    sourceConnectionId: string,
    sourcePath: string,
    destinationConnectionId: string,
    destinationPath: string,
    targetResolutionPolicy: TargetResolutionPolicy = "ask",
    options: CrossBackendTransferOptions = {}
  ): Promise<ContentTransferResult> {
    const sourceInfo = await this.getFileInfo(sourceConnectionId, sourcePath);
    if (sourceInfo.type === "directory") {
      return {
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "unchanged" },
        error: { code: "unavailable", reason: "unsupported" },
      };
    }
    if (sourceInfo.type !== "file") {
      return {
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "unchanged" },
        error: { code: "unavailable", reason: "unsupported" },
      };
    }
    const sourceSize = sourceInfo.size;
    if (typeof sourceSize !== "number" || !Number.isSafeInteger(sourceSize) || sourceSize < 0) {
      return {
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "unchanged" },
        error: { code: "unavailable", reason: "source_size_unknown" },
      };
    }

    let sourceResponse: Response;
    try {
      sourceResponse = await this.fetchRawFileStream(sourceConnectionId, sourcePath, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        return { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
      }
      throw error;
    }
    if (!sourceResponse.body) {
      return {
        status: "outcome_unknown",
        replaced: false,
        effects: { source: "unknown", destination: "unknown" },
      };
    }
    const result = await this.publishTransferStream(
      sourceResponse.body,
      sourceSize,
      sourceInfo.modified_at,
      sourceInfo,
      destinationConnectionId,
      destinationPath,
      targetResolutionPolicy,
      options
    );
    if (kind !== "move" || result.status !== "completed") {
      return result;
    }
    try {
      await this.deleteItem(sourceConnectionId, sourcePath);
      return { ...result, effects: { source: "mutated", destination: "mutated" } };
    } catch (error) {
      return {
        status: "completed_with_source_retained",
        replaced: result.replaced,
        effects: { source: "unchanged", destination: "mutated" },
        error: {
          code: "source_delete_failed",
          detail: `Destination was created but the original could not be removed: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      };
    }
  }

  async publishBrowserFile(
    file: File,
    destinationConnectionId: string,
    destinationPath: string,
    targetResolutionPolicy: TargetResolutionPolicy = "ask",
    options: CrossBackendTransferOptions = {}
  ): Promise<ContentTransferResult> {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid upload file size");
    if (!file.name || file.name === "." || file.name === ".." || /[/\\\0]/.test(file.name)) {
      throw new Error("Invalid upload filename");
    }
    const sourceInfo = {
      name: file.name,
      path: file.name,
      type: FileType.FILE,
      size: file.size,
      modified_at: new Date(file.lastModified).toISOString(),
      is_readable: true,
      is_hidden: file.name.startsWith("."),
    };
    const startedAt = performance.now();
    let sourceConsumedAt: number | null = null;
    try {
      const destinationUrl = `${getBaseUrl(destinationConnectionId)}/browse/${getBrowseSegment(destinationConnectionId)}/transfer-stream?path=${encodeURIComponent(destinationPath)}&target_resolution_policy=${encodeURIComponent(targetResolutionPolicy)}&expected_size=${file.size}&source_modified_at=${encodeURIComponent(sourceInfo.modified_at)}`;
      const headers = await this.getTransferFetchHeaders(destinationConnectionId, "POST", destinationUrl);
      if (options.signal?.aborted) {
        return { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
      }
      let sent = false;
      const response = await new Promise<Response | null>((resolve) => {
        const xhr = new XMLHttpRequest();
        const cleanup = () => {
          options.signal?.removeEventListener("abort", abort);
          xhr.upload.onprogress = null;
          xhr.upload.onload = null;
          xhr.onload = null;
          xhr.onerror = null;
          xhr.ontimeout = null;
          xhr.onabort = null;
        };
        const settle = (result: Response | null) => {
          cleanup();
          resolve(result);
        };
        const abort = () => xhr.abort();
        xhr.open("POST", destinationUrl);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, String(value));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) options.onProgress?.(event.loaded, file.size);
        };
        xhr.upload.onload = () => {
          sourceConsumedAt = performance.now();
          options.onUploadSent?.();
        };
        xhr.onload = () => settle(xhr.status ? new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText }) : null);
        xhr.onerror = () => settle(null);
        xhr.ontimeout = () => settle(null);
        xhr.onabort = () => settle(null);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) {
          cleanup();
          resolve(null);
          return;
        }
        sent = true;
        try {
          xhr.send(file);
        } catch {
          settle(null);
        }
      });
      if (!response) {
        return sent
          ? { status: "outcome_unknown", replaced: false, effects: { source: "unchanged", destination: "unknown" } }
          : { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
      }
      return await this.resolveTransferResponse(response, destinationConnectionId, destinationPath, sourceInfo);
    } finally {
      const finishedAt = performance.now();
      logger.debug(
        "Browser file upload timing",
        {
          bytes: file.size,
          totalMs: Math.round(finishedAt - startedAt),
          sourceConsumedMs: sourceConsumedAt === null ? null : Math.round(sourceConsumedAt - startedAt),
          responseAfterSourceConsumedMs: sourceConsumedAt === null ? null : Math.round(finishedAt - sourceConsumedAt),
        },
        "file-browser"
      );
    }
  }

  private async publishTransferStream(
    sourceStream: ReadableStream<Uint8Array>,
    expectedSize: number,
    modifiedAt: string | undefined,
    sourceInfo: FileInfo,
    destinationConnectionId: string,
    destinationPath: string,
    targetResolutionPolicy: TargetResolutionPolicy,
    options: CrossBackendTransferOptions
  ): Promise<ContentTransferResult> {
    const sourceModifiedAt = modifiedAt ? `&source_modified_at=${encodeURIComponent(modifiedAt)}` : "";
    const destinationUrl = `${getBaseUrl(destinationConnectionId)}/browse/${getBrowseSegment(destinationConnectionId)}/transfer-stream?path=${encodeURIComponent(destinationPath)}&target_resolution_policy=${encodeURIComponent(targetResolutionPolicy)}&expected_size=${expectedSize}${sourceModifiedAt}`;
    const destinationHeaders = await this.getTransferFetchHeaders(destinationConnectionId, "POST", destinationUrl);
    let bytesTransferred = 0;
    const relayStream = options.onProgress
      ? sourceStream.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, controller) => {
              bytesTransferred += chunk.byteLength;
              options.onProgress?.(bytesTransferred, expectedSize);
              controller.enqueue(chunk);
            },
          })
        )
      : sourceStream;
    let destinationBody: ReadableStream<Uint8Array> | Blob = relayStream;
    if (!supportsStreamUploadRequestBodies()) {
      let bufferedBody: Blob;
      try {
        bufferedBody = await new Response(relayStream).blob();
      } catch (error) {
        if (options.signal?.aborted) {
          return { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
        }
        return {
          status: "failed",
          replaced: false,
          effects: { source: "unchanged", destination: "unchanged" },
          error: {
            code: "transport",
            detail: `Transfer source stream failed: ${error instanceof Error ? error.message : "unknown error"}`,
          },
        };
      }
      if (bufferedBody.size !== expectedSize) {
        return {
          status: "failed",
          replaced: false,
          effects: { source: "unchanged", destination: "unchanged" },
          error: {
            code: "transport",
            detail: `Transfer source size mismatch: expected ${expectedSize} bytes but received ${bufferedBody.size} bytes`,
          },
        };
      }
      if (options.signal?.aborted) {
        return { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
      }
      destinationBody = bufferedBody;
    }
    let destinationResponse: Response;
    try {
      destinationResponse = await fetch(destinationUrl, {
        method: "POST",
        headers: { ...destinationHeaders, "Content-Type": "application/octet-stream" },
        body: destinationBody,
        duplex: "half",
        signal: options.signal,
      } as RequestInit & { duplex: "half" });
    } catch {
      if (options.signal?.aborted) {
        return { status: "outcome_unknown", replaced: false, effects: { source: "unchanged", destination: "unknown" } };
      }
      return { status: "outcome_unknown", replaced: false, effects: { source: "unknown", destination: "unknown" } };
    }
    return this.resolveTransferResponse(destinationResponse, destinationConnectionId, destinationPath, sourceInfo);
  }

  private async resolveTransferResponse(
    destinationResponse: Response,
    destinationConnectionId: string,
    destinationPath: string,
    sourceInfo: FileInfo
  ): Promise<ContentTransferResult> {
    if (!destinationResponse.ok) {
      if (destinationResponse.status === 409) {
        const existingFile = await this.getFileInfo(destinationConnectionId, destinationPath).catch(() => null);
        if (existingFile) {
          throw this.createTransferConflictError(existingFile, sourceInfo);
        }
      }
      const detail = await destinationResponse.text().catch(() => destinationResponse.statusText);
      return {
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "unchanged" },
        error:
          destinationResponse.status === 409
            ? { code: "conflict", detail }
            : { code: "transport", detail: `Transfer destination failed (${destinationResponse.status}): ${detail}` },
      };
    }
    return this.normalizeTransferResult((await destinationResponse.json()) as ContentTransferResult);
  }

  // ── Transfer routing helpers ────────────────────────────────────────────

  private async postTransfer(
    client: AxiosInstance,
    path: string,
    payload: Record<string, unknown>,
    config: AxiosRequestConfig,
    onCancel?: () => Promise<void>
  ): Promise<ContentTransferResult> {
    const abortHandler = () => {
      void onCancel?.();
    };
    const signal = config.signal;
    signal?.addEventListener?.("abort", abortHandler, { once: true });
    if (signal?.aborted) {
      abortHandler();
    }
    try {
      return this.normalizeTransferResult((await client.post<ContentTransferResult>(path, payload, config)).data);
    } catch (firstError) {
      if (!axios.isAxiosError(firstError) || firstError.response) {
        throw firstError;
      }
      return { status: "outcome_unknown", replaced: false, effects: { source: "unknown", destination: "unknown" } };
    } finally {
      signal?.removeEventListener?.("abort", abortHandler);
    }
  }

  private async cancelTransferAttempt(
    client: AxiosInstance,
    segment: string,
    transferAttemptId: string,
    extraConfig: ClientConfig
  ): Promise<void> {
    try {
      await client.post(`/browse/${segment}/transfer-attempts/${encodeURIComponent(transferAttemptId)}/cancel`, {}, extraConfig);
    } catch {
      // The active request may already have completed or the provider may be unreachable.
    }
  }

  private normalizeTransferResult(result: ContentTransferResult): ContentTransferResult {
    if (result.status === "failed" && result.error.code === "unavailable" && "detail" in result.error) {
      return { ...result, error: { code: "unavailable", reason: "unsupported" } };
    }
    return result;
  }

  private createTransferConflictError(
    existingFile: FileInfo,
    incomingFile: FileInfo
  ): Error & { response: { status: number; data: { detail: ConflictInfo } } } {
    const error = new Error("Destination already exists") as Error & { response: { status: number; data: { detail: ConflictInfo } } };
    error.response = { status: 409, data: { detail: { existing_file: existingFile, incoming_file: incomingFile } } };
    return error;
  }

  /** Check whether source and destination are on different backend types. */
  private isCrossBackendTransfer(sourceConnectionId: string, destConnectionId: string): boolean {
    return isLocalDrive(sourceConnectionId) !== isLocalDrive(destConnectionId);
  }

  private async getTransferFetchHeaders(connectionId: string, method: string, url: string): Promise<Record<string, string>> {
    if (isLocalDrive(connectionId)) {
      return this.buildCompanionHeaders(method, url);
    }
    const token = authSession.getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private async fetchRawFileStream(connectionId: string, path: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
    const url = `${getBaseUrl(connectionId)}/viewer/${getBrowseSegment(connectionId)}/download?path=${encodeURIComponent(path)}`;
    const response = await fetch(url, { headers: await this.getTransferFetchHeaders(connectionId, "GET", url), signal: options.signal });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status}): ${response.statusText}`);
    }
    return response;
  }

  /**
   * Download a file's raw bytes from any backend (companion or server).
   * Returns the data as a `Blob`.
   */
  async getOriginalFileBlob(connectionId: string, path: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
    const response = await this.fetchRawFileStream(connectionId, path, options);
    return response.blob();
  }

  /**
   * Upload a `Blob` to a destination path on any backend.
   *
   * Uses multipart form data with a single `file` field, matching both
   * the Python backend and the companion upload endpoints.
   */
  private async uploadFileBlob(
    connectionId: string,
    destPath: string,
    blob: Blob,
    filename: string,
    params?: Record<string, string>
  ): Promise<void> {
    const baseUrl = getBaseUrl(connectionId);
    const segment = getBrowseSegment(connectionId);
    const url = `${baseUrl}/browse/${segment}/upload?path=${encodeURIComponent(destPath)}`;

    const formData = new FormData();
    formData.append("file", blob, filename);

    const headers: Record<string, string> = {};
    const requestUrl = params ? `${url}&${new URLSearchParams(params).toString()}` : url;
    if (isLocalDrive(connectionId)) {
      Object.assign(headers, await this.buildCompanionHeaders("POST", requestUrl));
    } else {
      const token = authSession.getAccessToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(requestUrl, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      if (response.status === 404 && isExpiredEditLockResponse(text)) {
        throw new ExpiredEditLockError();
      }
      throw new Error(`Upload failed (${response.status}): ${text}`);
    }
  }

  async writeFile(connectionId: string, destinationPath: string, content: Blob, filename: string): Promise<void> {
    await this.uploadFileBlob(connectionId, destinationPath, content, filename);
  }

  // Viewer endpoints

  /**
   * Build a direct URL for viewing a file.
   *
   * For companion connections, embeds HMAC auth in query params since
   * these URLs may be used in `<img src>` / `<iframe>` where headers can't be set.
   * Async because companion HMAC computation uses the Web Crypto API.
   */
  async getViewUrl(connectionId: string, path: string): Promise<string> {
    const baseUrl = getBaseUrl(connectionId);
    const segment = getBrowseSegment(connectionId);
    if (isLocalDrive(connectionId)) {
      const authParams = await this.buildCompanionQueryAuth(`${baseUrl}/viewer/${segment}/file?path=${encodeURIComponent(path)}`);
      return `${baseUrl}/viewer/${segment}/file?path=${encodeURIComponent(path)}&${authParams}`;
    }
    return `${baseUrl}/viewer/${segment}/file?path=${encodeURIComponent(path)}`;
  }

  async getDownloadUrl(connectionId: string, path: string): Promise<string> {
    const baseUrl = getBaseUrl(connectionId);
    const segment = getBrowseSegment(connectionId);
    if (isLocalDrive(connectionId)) {
      const authParams = await this.buildCompanionQueryAuth(`${baseUrl}/viewer/${segment}/download?path=${encodeURIComponent(path)}`);
      return `${baseUrl}/viewer/${segment}/download?path=${encodeURIComponent(path)}&${authParams}`;
    }
    return `${baseUrl}/viewer/${segment}/download?path=${encodeURIComponent(path)}`;
  }

  async getFileBlob(connectionId: string, path: string, options: { signal?: AbortSignal } = {}): Promise<Blob> {
    try {
      const segment = getBrowseSegment(connectionId);
      const { client, extraConfig } = await this.getClientConfig(connectionId);
      const response = await client.get<ArrayBuffer>(`/viewer/${segment}/file`, {
        ...extraConfig,
        params: { path },
        responseType: "arraybuffer",
        signal: options.signal,
      });

      const contentType = getResponseContentType(response.headers["content-type"], "application/octet-stream");
      const data = response.data instanceof ArrayBuffer ? response.data : new ArrayBuffer(0);
      return new Blob([data], { type: contentType });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (typeof error.response?.data === "string") {
          try {
            const json = JSON.parse(error.response.data);
            throw {
              ...error,
              response: {
                ...error.response,
                data: json,
              },
            };
          } catch {
            // Ignore parsing failures and continue to the ArrayBuffer branch.
          }
        }
      }

      if (axios.isAxiosError(error) && error.response?.data instanceof ArrayBuffer) {
        const decoder = new TextDecoder();
        const text = decoder.decode(error.response.data);
        try {
          const json = JSON.parse(text);
          const newError = {
            ...error,
            response: {
              ...error.response,
              data: json,
            },
          };
          throw newError;
        } catch (parseError) {
          if (parseError instanceof SyntaxError) {
            throw error;
          }
          throw parseError;
        }
      }

      throw error;
    }
  }

  async downloadFile(connectionId: string, path: string, filename: string, signal?: AbortSignal): Promise<void> {
    const url = await this.issueBrowserDownloadUrl(connectionId, path, undefined, signal);
    if (!signal?.aborted) this.startNativeDownload(url, filename);
  }

  async downloadArchiveMember(
    connectionId: string,
    archivePath: string,
    memberPath: string,
    filename: string,
    signal?: AbortSignal
  ): Promise<void> {
    const url = await this.issueBrowserDownloadUrl(connectionId, archivePath, memberPath, signal);
    if (!signal?.aborted) this.startNativeDownload(url, filename);
  }

  private async issueBrowserDownloadUrl(connectionId: string, path: string, memberPath?: string, signal?: AbortSignal): Promise<string> {
    const baseUrl = getBaseUrl(connectionId);
    const localDrive = isLocalDrive(connectionId);
    const issueUrl = `${baseUrl}/${localDrive ? "download-intents" : "viewer/download-intents"}`;
    const response = await fetch(issueUrl, {
      method: "POST",
      headers: {
        ...(await this.getTransferFetchHeaders(connectionId, "POST", issueUrl)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        [localDrive ? "drive" : "connection_id"]: getBrowseSegment(connectionId),
        path,
        ...(memberPath === undefined ? {} : { member_path: memberPath }),
      }),
      signal,
    });
    if (!response.ok) throw new Error(`Download preparation failed (${response.status})`);
    const { url } = (await response.json()) as { url: string };
    return new URL(url, new URL(baseUrl, location.href)).href;
  }

  private startNativeDownload(url: string, filename: string): void {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noreferrer";
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  }

  private async getSelectionDownloadHeaders(connectionId: string, url: string): Promise<Record<string, string>> {
    const headers = await this.getTransferFetchHeaders(connectionId, "POST", url);
    if (isLocalDrive(connectionId)) {
      const token = authSession.getAccessToken();
      if (!token) throw new Error("Authentication is required to download a local selection");
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async downloadSelectionArchive(connectionId: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const url = `${getBaseUrl(connectionId)}/browse/${getBrowseSegment(connectionId)}/download-selection`;
    const headers = await this.getSelectionDownloadHeaders(connectionId, url);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(paths),
      signal,
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(failure?.detail ?? `Archive download failed (${response.status})`);
    }
    const blob = await response.blob();
    if (!signal?.aborted) this.saveDownloadBlob(blob, "Sambee-download.zip");
  }

  async downloadZipSelectionArchive(connectionId: string, archivePath: string, paths: string[], signal?: AbortSignal): Promise<void> {
    const url = `${getBaseUrl(connectionId)}/browse/${getBrowseSegment(connectionId)}/archive/download-selection`;
    const headers = await this.getSelectionDownloadHeaders(connectionId, url);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ archive_path: archivePath, paths }),
      signal,
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(failure?.detail ?? `Archive download failed (${response.status})`);
    }
    const blob = await response.blob();
    if (!signal?.aborted) this.saveDownloadBlob(blob, "Sambee-download.zip");
  }

  saveDownloadBlob(blob: Blob, filename: string): void {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  }

  async getFileContent(connectionId: string, path: string): Promise<string> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get(`/viewer/${segment}/file`, {
      ...extraConfig,
      params: { path },
      responseType: "text",
    });
    return response.data;
  }

  async saveTextFile(
    connectionId: string,
    path: string,
    content: string,
    options: { filename?: string; mimeType?: string } = {}
  ): Promise<void> {
    const filename = options.filename ?? path.split("/").pop() ?? path;
    const mimeType = options.mimeType ?? "text/plain;charset=utf-8";
    const blob = new Blob([content], { type: mimeType });
    await this.uploadFileBlob(connectionId, path, blob, filename);
  }

  async writeTextWithEditLock(
    connectionId: string,
    path: string,
    content: string,
    lockInfo: Required<Pick<EditLockInfo, "lock_id" | "lock_capability" | "operation_id">>,
    options: { filename?: string; mimeType?: string } = {}
  ): Promise<void> {
    const filename = options.filename ?? path.split("/").pop() ?? path;
    const mimeType = options.mimeType ?? "text/plain;charset=utf-8";
    await this.uploadFileBlob(connectionId, path, new Blob([content], { type: mimeType }), filename, {
      editor_lock_id: lockInfo.lock_id,
      editor_lock_capability: lockInfo.lock_capability,
      editor_operation_id: lockInfo.operation_id,
    });
  }

  async acquireEditLock(connectionId: string, path: string, _sessionId?: string): Promise<EditLockInfo> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.post<EditLockInfo>(`/browse/${segment}/lock`, undefined, {
      ...extraConfig,
      params: { path, check_write_access: true },
    });

    return response.data;
  }

  async heartbeatEditLock(connectionId: string, path: string, lockInfo: EditLockInfo): Promise<void> {
    if (!lockInfo.operation_id || !lockInfo.lock_capability) {
      throw new Error("Edit lock context is incomplete");
    }

    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    try {
      await client.post(
        `/browse/${segment}/lock/heartbeat`,
        {
          operation_id: lockInfo.operation_id,
          lock_id: lockInfo.lock_id,
          lock_capability: lockInfo.lock_capability,
        },
        {
          ...extraConfig,
          params: { path },
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404 && isExpiredEditLockResponse(JSON.stringify(error.response.data))) {
        throw new ExpiredEditLockError();
      }
      throw error;
    }
  }

  async releaseEditLock(connectionId: string, path: string, lockInfo: EditLockInfo): Promise<void> {
    if (!lockInfo.operation_id || !lockInfo.lock_capability) {
      throw new Error("Edit lock context is incomplete");
    }

    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.delete(`/browse/${segment}/lock`, {
      ...extraConfig,
      params: { path },
      data: {
        operation_id: lockInfo.operation_id,
        lock_id: lockInfo.lock_id,
        lock_capability: lockInfo.lock_capability,
      },
    });
  }

  async getEditLockStatus(connectionId: string, path: string): Promise<EditLockStatus> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    const response = await client.get<EditLockStatus>(`/browse/${segment}/lock-status`, {
      ...extraConfig,
      params: { path },
    });

    return response.data;
  }

  /**
   * Fetch image as blob with authentication headers.
   * Returns blob data that can be used to create object URLs.
   * Optionally resizes images to fit viewport dimensions.
   */
  async getImageBlob(
    connectionId: string,
    path: string,
    options: { signal?: AbortSignal; viewportWidth?: number; viewportHeight?: number; no_resizing?: boolean } = {}
  ): Promise<Blob> {
    try {
      const params: Record<string, string | number> = { path };

      // Add viewport dimensions if provided (for server-side resizing)
      const viewportWidth = getDevicePixelDimension(options.viewportWidth);
      if (viewportWidth !== undefined) {
        params["viewport_width"] = viewportWidth;
      }
      const viewportHeight = getDevicePixelDimension(options.viewportHeight);
      if (viewportHeight !== undefined) {
        params["viewport_height"] = viewportHeight;
      }
      if (options.no_resizing) {
        params["no_resizing"] = 1;
      }

      const segment = getBrowseSegment(connectionId);
      const { client, extraConfig } = await this.getClientConfig(connectionId);

      // Companion serves raw files without resizing (no pyvips)
      if (isLocalDrive(connectionId)) {
        delete params["viewport_width"];
        delete params["viewport_height"];
        delete params["no_resizing"];
      }

      const response = await client.get<ArrayBuffer>(`/viewer/${segment}/file`, {
        ...extraConfig,
        params,
        responseType: "arraybuffer",
        signal: options.signal,
      });

      const contentType = getResponseContentType(response.headers["content-type"], "application/octet-stream");
      const data = response.data instanceof ArrayBuffer ? response.data : new ArrayBuffer(0);
      return new Blob([data], { type: contentType });
    } catch (error) {
      // When responseType is 'arraybuffer', error responses come as ArrayBuffer
      // We need to convert them to JSON to access the detail field
      if (axios.isAxiosError(error)) {
        // Check if data is a string (common when responseType is arraybuffer but error is JSON)
        if (typeof error.response?.data === "string") {
          try {
            const json = JSON.parse(error.response.data);
            // Re-throw with parsed data
            throw {
              ...error,
              response: {
                ...error.response,
                data: json,
              },
            };
          } catch {
            // If parsing fails, continue to next check
          }
        }
      }

      if (axios.isAxiosError(error) && error.response?.data instanceof ArrayBuffer) {
        const decoder = new TextDecoder();
        const text = decoder.decode(error.response.data);
        try {
          const json = JSON.parse(text);
          // Create error with parsed JSON data
          const newError = {
            ...error,
            response: {
              ...error.response,
              data: json,
            },
          };
          throw newError;
        } catch (parseError) {
          // If JSON.parse fails, throw original error
          if (parseError instanceof SyntaxError) {
            throw error;
          }
          // If it's not a SyntaxError, it's our thrown newError - re-throw it
          throw parseError;
        }
      }
      throw error;
    }
  }

  /**
   * Fetch PDF as blob with authentication headers.
   * Returns blob data that can be used to create object URLs for react-pdf.
   */
  async getPdfBlob(
    connectionId: string,
    path: string,
    options: {
      signal?: AbortSignal;
      pdfVariant?: "normalized";
      screenProfile?: { width: number; height: number; zoomPercent: number };
    } = {}
  ): Promise<Blob> {
    try {
      const segment = getBrowseSegment(connectionId);
      const { client, extraConfig } = await this.getClientConfig(connectionId);
      const response = await client.get<ArrayBuffer>(`/viewer/${segment}/file`, {
        ...extraConfig,
        params: {
          path,
          ...(options.pdfVariant ? { pdf_variant: options.pdfVariant } : {}),
          ...(options.screenProfile
            ? {
                screen_width: options.screenProfile.width,
                screen_height: options.screenProfile.height,
                screen_zoom_percent: options.screenProfile.zoomPercent,
              }
            : {}),
        },
        responseType: "arraybuffer",
        signal: options.signal,
        timeout: PDF_VIEWER_REQUEST_TIMEOUT_MS,
      });

      const contentType = getResponseContentType(response.headers["content-type"], "application/pdf");
      return new Blob([response.data], { type: contentType });
    } catch (error) {
      if (axios.isAxiosError(error) && typeof error.response?.data === "string") {
        try {
          throw {
            ...error,
            response: {
              ...error.response,
              data: JSON.parse(error.response.data),
            },
          };
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) {
            throw parseError;
          }
        }
      }
      if (axios.isAxiosError(error) && error.response?.data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(error.response.data);
        try {
          throw {
            ...error,
            response: {
              ...error.response,
              data: JSON.parse(text),
            },
          };
        } catch (parseError) {
          if (!(parseError instanceof SyntaxError)) {
            throw parseError;
          }
        }
      }
      throw error;
    }
  }

  async invalidatePdfDerivative(
    connectionId: string,
    path: string,
    screenProfile?: { width: number; height: number; zoomPercent: number }
  ): Promise<void> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.delete(`/viewer/${segment}/pdf-derivative`, {
      ...extraConfig,
      params: {
        path,
        ...(screenProfile
          ? {
              screen_width: screenProfile.width,
              screen_height: screenProfile.height,
              screen_zoom_percent: screenProfile.zoomPercent,
            }
          : {}),
      },
    });
  }

  async invalidateArchiveMemberPdfDerivative(
    connectionId: string,
    archivePath: string,
    memberPath: string,
    screenProfile?: { width: number; height: number; zoomPercent: number }
  ): Promise<void> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.delete(`/viewer/${segment}/archive/member/pdf-derivative`, {
      ...extraConfig,
      params: {
        archive_path: archivePath,
        member_path: memberPath,
        ...(screenProfile
          ? {
              screen_width: screenProfile.width,
              screen_height: screenProfile.height,
              screen_zoom_percent: screenProfile.zoomPercent,
            }
          : {}),
      },
    });
  }

  /**
   * Get frontend logging configuration
   */
  async getLoggingConfig() {
    const response = await this.api.get<{
      logging_enabled: boolean;
      logging_level: string;
      tracing_enabled: boolean;
      tracing_level: string;
      tracing_components: string[];
    }>("/logs/config");
    return response.data;
  }

  /**
   * Send mobile log entries to server
   */
  async sendMobileLogs(batch: {
    session_id: string;
    device_info: Record<string, unknown>;
    logs: Array<{
      timestamp: number;
      level: string;
      message: string;
      context?: Record<string, unknown>;
      component?: string;
    }>;
  }) {
    const response = await this.api.post<{
      status: string;
      filename: string;
      logs_received: number;
    }>("/logs/mobile", batch);
    return response.data;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Companion App
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Request a short-lived URI token and build a sambee:// URI for the companion app.
   *
   * The returned URI encodes the server origin, token, connection, path,
   * and (optionally) the current UI theme so the companion can match it.
   */
  async getCompanionUri(connectionId: string, path: string, themeJson?: string, options?: { forcePicker?: boolean }): Promise<string> {
    const response = await this.api.post<{ uri_token: string; expires_in: number }>("/companion/uri-token", {
      connection_id: connectionId,
      path,
    });

    const { uri_token } = response.data;
    const serverUrl = encodeURIComponent(getCompanionServerUrl(this.api.defaults.baseURL));
    const encodedPath = encodeURIComponent(path);

    let uri = `sambee://open?server=${serverUrl}&token=${uri_token}&connId=${connectionId}&path=${encodedPath}`;

    if (themeJson) {
      uri += `&theme=${btoa(themeJson)}`;
    }

    if (options?.forcePicker) {
      uri += "&forcePicker=1";
    }

    return uri;
  }

  /**
   * Open a local-drive file directly with the system default application.
   *
   * This is a companion-only operation (Phase 3a "direct local open"):
   * no download, no edit lock, no upload — the file is already on disk.
   */
  async openLocalFile(connectionId: string, path: string, options?: { forcePicker?: boolean }): Promise<void> {
    const segment = getBrowseSegment(connectionId);
    const { client, extraConfig } = await this.getClientConfig(connectionId);
    await client.post(`/browse/${segment}/open`, { path, force_picker: options?.forcePicker ?? false }, extraConfig);
  }

  /**
   * List available mobile log files
   */
  async listMobileLogs() {
    const response = await this.api.get<{
      files: Array<{
        filename: string;
        size: number;
        modified: string;
        session_id: string;
        log_count: number;
      }>;
      total_size: number;
    }>("/logs/list");
    return response.data;
  }

  /**
   * Get download URL for a mobile log file
   */
  getLogDownloadUrl(filename: string): string {
    const baseURL = this.api.defaults.baseURL || "/api";
    return `${baseURL}/logs/download/${encodeURIComponent(filename)}`;
  }
}

export const apiService = new ApiService();
export default apiService;

// Export convenience functions
export const login = (username: string, password: string) => apiService.login(username, password);
export const exchangeOidcGrant = (grant: string) => apiService.exchangeOidcGrant(grant);

export const browseFiles = async (path: string, _token: string) => {
  // For simple browsing, we'll use a default connection
  // This should be updated when connections are properly configured
  try {
    const connections = await apiService.getConnections();
    if (connections.length === 0) {
      return [];
    }
    const listing = await apiService.listDirectory(connections[0]!.id, path);
    return listing.items;
  } catch (err) {
    logger.error("Error browsing files", { error: err }, "api");
    return [];
  }
};
