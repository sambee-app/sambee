import axios, { type AxiosError } from "axios";
import type { AuthToken } from "../types";
import { setPasswordChangeRequired } from "./passwordChange";

export type AuthSessionState =
  | "idle"
  | "active"
  | "refreshing"
  | "transiently-unavailable"
  | "reauthentication-required"
  | "refresh-uncertain";

export interface AuthIdentity {
  epoch: number;
  userId: string | null;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.MODE === "test" ? "http://localhost:3000/api" : "/api");
const REFRESH_SAFETY_MARGIN_MS = 5 * 60_000;
const REFRESH_JITTER_RATIO = 0.05;
const REFRESH_RETRY_DELAY_MS = 30_000;
const MAX_REFRESH_DELAY_MS = 2_147_483_647;

export class AuthSessionError extends Error {
  constructor(
    readonly code: "unauthenticated" | "reauthentication-required" | "refresh-uncertain" | "transient",
    message: string
  ) {
    super(message);
  }
}

export class AuthSessionManager {
  private accessToken: string | null = null;
  private expiresAt: number | null = null;
  private renewable = false;
  private sessionDeadline: number | null = null;
  private sessionCapability: AuthToken["oidc_session_capability"] = undefined;
  private reauthenticationHandler: (() => void) | null = null;
  private userId: string | null = null;
  private refreshPromise: Promise<AuthToken> | null = null;
  private refreshTimer: number | null = null;
  private state: AuthSessionState = "idle";
  private bootstrapPromise: Promise<AuthSessionState> | null = null;
  private bootstrapComplete = false;
  private refreshAt: number | null = null;
  private refreshGeneration: number | null = null;
  private readonly refreshChannel: BroadcastChannel | null;
  private readonly refreshClient = axios.create({ baseURL: API_BASE_URL, withCredentials: true });
  private readonly clearListeners = new Set<() => void>();
  private readonly identityListeners = new Set<(identity: AuthIdentity) => void>();
  private readonly bootstrapListeners = new Set<() => void>();
  private identityEpoch = 0;
  private loginGeneration = 0;

  constructor() {
    this.refreshChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("sambee-oidc-refresh");
    this.refreshChannel?.addEventListener("message", this.handleRefreshMessage);
    window.addEventListener("visibilitychange", this.refreshAfterReturn);
    window.addEventListener("focus", this.refreshAfterReturn);
    window.addEventListener("online", this.refreshAfterReturn);
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getState(): AuthSessionState {
    return this.state;
  }

  getUserId(): string | null {
    return this.userId;
  }

  getIdentity(): AuthIdentity {
    return { epoch: this.identityEpoch, userId: this.userId };
  }

  isBootstrapComplete(): boolean {
    return this.bootstrapComplete;
  }

  hasUsableAccessToken(): boolean {
    return (
      this.accessToken !== null &&
      (this.expiresAt === null || this.expiresAt > Date.now()) &&
      (this.sessionDeadline === null || this.sessionDeadline > Date.now())
    );
  }

  setReauthenticationHandler(handler: () => void): void {
    this.reauthenticationHandler = handler;
  }

  setAuthenticated(response: AuthToken, renewable: boolean): void {
    setPasswordChangeRequired(response.password_change_required ?? false);
    const nextUserId = response.user_id ?? null;
    const identityChanged = this.userId !== nextUserId;
    this.userId = nextUserId;
    this.accessToken = response.access_token;
    this.renewable = renewable;
    this.expiresAt = response.access_token_expires_at ? Date.parse(response.access_token_expires_at) : null;
    this.sessionDeadline = response.oidc_session_expires_at ? Date.parse(response.oidc_session_expires_at) : null;
    this.sessionCapability = response.oidc_session_capability;
    this.refreshGeneration = response.oidc_refresh_generation ?? this.refreshGeneration;
    this.refreshAt = this.expiresAt === null ? null : Date.now() + Math.max(0, (this.expiresAt - Date.now()) / 2);
    this.state = "active";
    this.scheduleRefresh();
    if (identityChanged) this.publishIdentityChange();
  }

  beginNewLogin(): void {
    this.loginGeneration += 1;
    this.refreshPromise = null;
  }

  completeLoginBootstrap(): void {
    this.bootstrapComplete = true;
    for (const listener of this.bootstrapListeners) listener();
  }

  subscribeToBootstrap(listener: () => void): () => void {
    this.bootstrapListeners.add(listener);
    return () => this.bootstrapListeners.delete(listener);
  }

  notifyNewLogin(): void {
    this.publishIdentityChange();
  }

  subscribeToClear(listener: () => void): () => void {
    this.clearListeners.add(listener);
    return () => {
      this.clearListeners.delete(listener);
    };
  }

  subscribeToIdentity(listener: (identity: AuthIdentity) => void): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  clear(): void {
    setPasswordChangeRequired(false);
    this.accessToken = null;
    this.expiresAt = null;
    this.sessionDeadline = null;
    this.sessionCapability = undefined;
    this.renewable = false;
    this.userId = null;
    this.publishIdentityChange();
    this.refreshAt = null;
    this.refreshGeneration = null;
    this.state = "idle";
    this.clearRefreshTimer();
    for (const listener of this.clearListeners) {
      listener();
    }
  }

  private publishIdentityChange(): void {
    this.identityEpoch += 1;
    const identity = this.getIdentity();
    for (const listener of this.identityListeners) {
      listener(identity);
    }
  }

  async bootstrap(): Promise<AuthSessionState> {
    if (this.bootstrapPromise) {
      return this.bootstrapPromise;
    }
    this.bootstrapPromise = (async () => {
      if (!this.accessToken) {
        try {
          await this.requestRefresh();
        } catch {
          // A bootstrap attempt must settle before protected routes make decisions.
        }
      }
      this.completeLoginBootstrap();
      return this.state;
    })();
    return this.bootstrapPromise;
  }

  async requestRefresh(options?: { newLogin?: boolean }): Promise<AuthToken> {
    if (options?.newLogin) {
      this.beginNewLogin();
      this.clear();
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    const generation = this.loginGeneration;
    const refresh = this.performRefresh(generation).finally(() => {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    });
    this.refreshPromise = refresh;
    return refresh;
  }

  async refreshIfNeeded(): Promise<void> {
    if (this.sessionDeadline !== null && this.sessionDeadline <= Date.now()) {
      this.requireReauthentication();
    }
    if (!this.renewable || this.expiresAt === null || this.state === "refresh-uncertain") {
      return;
    }
    if (this.expiresAt - Date.now() <= REFRESH_SAFETY_MARGIN_MS) {
      await this.requestRefresh();
    }
  }

  async logout(): Promise<void> {
    try {
      await this.refreshClient.post("/auth/oidc/logout");
    } catch {
      // The local state must still be cleared if the server session already expired.
    } finally {
      this.clear();
    }
  }

  private async performRefresh(generation: number): Promise<AuthToken> {
    if (typeof navigator !== "undefined" && "locks" in navigator) {
      return navigator.locks.request("sambee-oidc-refresh", { mode: "exclusive" }, () => this.performRefreshRequest(generation));
    }
    return this.performRefreshRequest(generation);
  }

  private async performRefreshRequest(generation: number): Promise<AuthToken> {
    if (generation !== this.loginGeneration)
      throw new AuthSessionError("unauthenticated", "An earlier refresh was superseded by a new sign-in.");
    if (this.sessionDeadline !== null && this.sessionDeadline <= Date.now()) this.requireReauthentication();
    const tokenBeforeRefresh = this.accessToken;
    this.state = "refreshing";
    try {
      const response = await this.refreshClient.post<AuthToken>("/auth/oidc/refresh", undefined, {
        headers: this.refreshGeneration === null ? undefined : { "X-Sambee-OIDC-Refresh-Generation": this.refreshGeneration.toString() },
      });
      if (generation !== this.loginGeneration)
        throw new AuthSessionError("unauthenticated", "An earlier refresh was superseded by a new sign-in.");
      if (this.accessToken === tokenBeforeRefresh) this.setAuthenticated(response.data, true);
      this.refreshChannel?.postMessage({ type: "completed", generation: this.refreshGeneration });
      return response.data;
    } catch (error) {
      if (generation !== this.loginGeneration || this.accessToken !== tokenBeforeRefresh) throw error;
      const response = (error as AxiosError<{ detail?: { code?: string } }>).response;
      const code = response?.data?.detail?.code;
      if (response?.status === 401 && code === "oidc_refresh_uncertain") {
        this.state = "refresh-uncertain";
        throw new AuthSessionError("refresh-uncertain", "The OIDC refresh result is uncertain.");
      }
      if (response?.status === 401) {
        const wasAuthenticated = this.userId !== null;
        this.clear();
        this.state = "reauthentication-required";
        if (wasAuthenticated) this.reauthenticationHandler?.();
        throw new AuthSessionError("reauthentication-required", "OIDC sign-in is required.");
      }
      if (!response || response.status === 429 || response.status >= 500) {
        this.state = "transiently-unavailable";
        this.scheduleRefresh(REFRESH_RETRY_DELAY_MS);
        throw new AuthSessionError("transient", "The authentication service is unavailable.");
      }
      this.state = "idle";
      throw new AuthSessionError("unauthenticated", "No renewable OIDC session is available.");
    }
  }

  private scheduleRefresh(delayOverride?: number): void {
    this.clearRefreshTimer();
    if (!this.renewable || this.expiresAt === null || this.state === "refresh-uncertain" || document.visibilityState !== "visible") {
      return;
    }
    if (this.sessionDeadline !== null && this.sessionDeadline <= Date.now()) {
      this.requireReauthentication();
    }
    if (
      this.sessionCapability === "reauthorization_only" &&
      this.sessionDeadline !== null &&
      this.sessionDeadline - Date.now() <= REFRESH_SAFETY_MARGIN_MS
    ) {
      this.refreshTimer = window.setTimeout(
        () => {
          void this.requestRefresh().catch(() => undefined);
        },
        Math.min(MAX_REFRESH_DELAY_MS, Math.max(0, this.sessionDeadline - Date.now()))
      );
      return;
    }
    const remaining = this.expiresAt - Date.now();
    const jitter = Math.floor(remaining * REFRESH_JITTER_RATIO * (Math.random() - 0.5) * 2);
    const nextRefreshAt = this.refreshAt ?? Date.now() + remaining / 2;
    const delay = delayOverride ?? Math.max(0, Math.min(MAX_REFRESH_DELAY_MS, Math.floor(nextRefreshAt - Date.now() + jitter)));
    this.refreshTimer = window.setTimeout(() => {
      void this.requestRefresh().catch(() => undefined);
    }, delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private requireReauthentication(): never {
    const wasAuthenticated = this.userId !== null;
    this.clear();
    this.state = "reauthentication-required";
    if (wasAuthenticated) this.reauthenticationHandler?.();
    throw new AuthSessionError("reauthentication-required", "OIDC sign-in is required.");
  }

  private refreshAfterReturn = (): void => {
    if (document.visibilityState !== "visible") {
      this.clearRefreshTimer();
      return;
    }
    if (this.renewable && this.refreshAt !== null && this.refreshAt <= Date.now()) {
      void this.requestRefresh().catch(() => undefined);
      return;
    }
    this.scheduleRefresh();
  };

  private handleRefreshMessage = (event: MessageEvent<{ type?: string; generation?: number }>): void => {
    if (event.data?.type !== "completed" || !this.renewable || this.expiresAt === null) {
      return;
    }
    if (typeof event.data.generation === "number") {
      this.refreshGeneration = Math.max(this.refreshGeneration ?? 0, event.data.generation);
    }
    this.refreshAt = Math.max(this.refreshAt ?? 0, Date.now() + REFRESH_SAFETY_MARGIN_MS);
    this.scheduleRefresh();
  };
}

export const authSession = new AuthSessionManager();
