/**
 * CompanionService — HTTP client for the local companion app API.
 *
 * Handles:
 * - Health checks and companion detection
 * - HMAC-SHA256 authentication for companion requests
 * - Pairing protocol (initiate / confirm)
 * - Drive enumeration
 * - Browse operations (list, info)
 *
 * The companion runs on localhost:21549 and uses HMAC-authenticated
 * requests rather than JWT tokens.
 */

import axios, { type AxiosInstance } from "axios";
import { type CompanionDirectoryPolicyStatus, isApiError } from "../types";
import { companionSession } from "./companionSession";
import { logger } from "./logger";

// ── Constants ────────────────────────────────────────────────────────────────

/** The base URL for the companion's local API server. */
export const COMPANION_BASE_URL = "http://localhost:21549/api";
export const COMPANION_AUTH_PROTOCOL_VERSION = 2;
const COMPANION_AUTH_SIGNATURE_MISMATCH_CODE = "companion_auth_signature_mismatch";
const COMPANION_BROWSER_UPDATE_REQUIRED_CODE = "companion_browser_update_required";
const COMPANION_PAIRING_NOT_FOUND_CODE = "companion_pairing_not_found";
export type CompanionAuthProtocolStatus = "compatible" | "companion_update_required" | "browser_update_required";
export type CompanionPairingErrorKind = "signature" | "pairing_required";

export function isCompanionAuthSignatureMismatch(error: unknown): boolean {
  if (!isApiError(error) || error.response?.status !== 403) return false;
  return (
    error.response.data?.code === COMPANION_AUTH_SIGNATURE_MISMATCH_CODE ||
    error.response.data?.code === COMPANION_BROWSER_UPDATE_REQUIRED_CODE ||
    error.response.data?.detail === "Invalid authentication"
  );
}

export function isCompanionPairingMissing(error: unknown): boolean {
  if (!isApiError(error) || error.response?.status !== 403) return false;
  return error.response.data?.code === COMPANION_PAIRING_NOT_FOUND_CODE || error.response.data?.detail === "Not paired with this origin";
}

export function getCompanionAuthProtocolStatus(health: CompanionHealthResponse): CompanionAuthProtocolStatus {
  const version = health.auth_protocol_version ?? 0;
  if (version < COMPANION_AUTH_PROTOCOL_VERSION) return "companion_update_required";
  if (version > COMPANION_AUTH_PROTOCOL_VERSION) return "browser_update_required";
  return "compatible";
}

/** Timeout in milliseconds for the health-check probe. */
const HEALTH_CHECK_TIMEOUT_MS = 1500;

/**
 * How long to wait for the companion-side approval before failing pairing.
 *
 * This should be close to, but below, the companion's own pairing expiry.
 */
const PAIR_CONFIRM_MAX_WAIT_MS = 110_000;

/** Delay between pairing confirmation retries while waiting on companion approval. */
const PAIR_CONFIRM_RETRY_DELAY_MS = 250;

/** Companion API detail used while local pairing approval is still pending. */
export const COMPANION_PAIR_CONFIRMATION_PENDING_DETAIL = "Waiting for companion confirmation";
/** Stable companion API code used while local pairing approval is still pending. */
export const COMPANION_PAIR_CONFIRMATION_PENDING_CODE = "pair_confirmation_pending";

// ── Types ────────────────────────────────────────────────────────────────────

/** Companion health-check response. */
export interface CompanionHealthResponse {
  status: string;
  paired: boolean;
  auth_protocol_version?: number;
}

/** Public pairing status for the current browser origin. */
export interface PairStatusResponse {
  current_origin: string | null;
  current_origin_paired: boolean;
  status: "unpaired" | "pending_local_approval" | "paired";
}

/** Authenticated pairing test response. */
export interface PairTestResponse {
  status: string;
  message: string;
  origin: string;
}

export interface CompanionLocalizationPayload {
  language: string;
  regional_locale: string;
  updated_at: string;
}

export interface CompanionLocalizationSyncResponse extends CompanionLocalizationPayload {
  applied: boolean;
  source_origin: string;
}

/** Drive/volume information returned by the companion. */
export interface DriveInfo {
  id: string;
  name: string;
  drive_type: "fixed" | "removable" | "network" | "virtual" | "unknown";
}

export interface CompanionArchiveCreationResult {
  files_created: number;
  directories_created: number;
  source_bytes: number;
}

/** Pairing initiation response from the companion. */
interface PairInitiateResponse {
  pairing_id: string;
  nonce_companion: string;
}

interface PairInitiateRequest {
  nonce_browser: string;
  origin?: string;
}

/** Pairing confirmation response from the companion. */
interface PairConfirmResponse {
  secret: string;
}

interface CompanionApiErrorResponse {
  detail?: string;
  code?: string;
}

/**
 * Compute SHA-256 of a hex string, returning hex.
 *
 * Used for pairing code derivation.
 */
async function sha256Hex(hexInput: string): Promise<string> {
  const bytes = new Uint8Array(hexInput.match(/.{1,2}/g)!.map((b) => Number.parseInt(b, 16)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random 32-byte nonce as a hex string.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Sleep for a short delay while waiting for companion-side confirmation. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** Return true when the companion is still waiting for local approval. */
function isWaitingForCompanionConfirmation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const response = (error as { response?: { data?: CompanionApiErrorResponse } }).response;
  return (
    response?.data?.code === COMPANION_PAIR_CONFIRMATION_PENDING_CODE ||
    response?.data?.detail === COMPANION_PAIR_CONFIRMATION_PENDING_DETAIL
  );
}

// ── Secret Persistence ──────────────────────────────────────────────────────

/** Store the pairing secret. */
function storeSecret(secret: string): void {
  companionSession.storeSecret(secret);
}

/** Remove the stored pairing secret. */
export function clearStoredSecret(): void {
  companionSession.clearPairing();
}

/** Check if we have a stored pairing secret. */
export function hasStoredSecret(): boolean {
  return companionSession.hasSecret();
}

// ── CompanionService ─────────────────────────────────────────────────────────

class CompanionService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: COMPANION_BASE_URL,
      timeout: 10_000,
    });

    this.checkHealth = this.checkHealth.bind(this);
    this.initiatePairing = this.initiatePairing.bind(this);
    this.confirmPairing = this.confirmPairing.bind(this);
    this.cancelPairing = this.cancelPairing.bind(this);
    this.getPairStatus = this.getPairStatus.bind(this);
    this.unpairCurrentOrigin = this.unpairCurrentOrigin.bind(this);
    this.testPairing = this.testPairing.bind(this);
    this.syncLocalization = this.syncLocalization.bind(this);
    this.getDrives = this.getDrives.bind(this);
    this.listDirectory = this.listDirectory.bind(this);
    this.getFileInfo = this.getFileInfo.bind(this);
    this.createArchive = this.createArchive.bind(this);
  }

  // ── Auth Header Construction ─────────────────────────────────────────────

  /**
   * Build the HMAC auth headers required by non-public companion endpoints.
   *
   * Returns an object with `X-Companion-Secret` (HMAC digest) and
   * `X-Companion-Timestamp` headers.
   */
  private async buildAuthHeaders(method: string, path: string): Promise<Record<string, string>> {
    return companionSession.getSigningHeaders(method, `${COMPANION_BASE_URL}${path}`);
  }

  // ── Health ───────────────────────────────────────────────────────────────

  /**
   * Probe the companion with a short timeout.
   *
   * Returns the health response if reachable, or `null` if the companion
   * is not running or unreachable.
   */
  async checkHealth(): Promise<CompanionHealthResponse | null> {
    try {
      const response = await this.client.get<CompanionHealthResponse>("/health", {
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      });
      return response.data;
    } catch {
      return null;
    }
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  /**
   * Initiate pairing with the companion.
   *
   * Generates a browser-side nonce, sends it to the companion, receives
   * the companion's nonce, and computes the 6-character pairing code.
   *
   * @returns Object with `pairingId`, `pairingCode`, and the internal
   *          `nonceBrowser` (needed for logging/debugging only).
   */
  async initiatePairing(): Promise<{
    pairingId: string;
    pairingCode: string;
    nonceBrowser: string;
  }> {
    const nonceBrowser = generateNonce();
    const requestBody: PairInitiateRequest = {
      nonce_browser: nonceBrowser,
      origin: window.location.origin || undefined,
    };

    const response = await this.client.post<PairInitiateResponse>("/pair/initiate", requestBody);

    const { pairing_id, nonce_companion } = response.data;

    // Compute code = SHA-256(nonce_browser ‖ nonce_companion), first 6 hex chars uppercased
    const combined = nonceBrowser + nonce_companion;
    const hash = await sha256Hex(combined);
    const pairingCode = hash.slice(0, 6).toUpperCase();

    logger.info("Pairing initiated", { pairingId: pairing_id, pairingCode }, "companion");

    return { pairingId: pairing_id, pairingCode, nonceBrowser };
  }

  /**
   * Confirm a pairing after both sides have verified the code.
   *
   * Receives and stores the shared secret.
   */
  async confirmPairing(pairingId: string): Promise<void> {
    const deadline = Date.now() + PAIR_CONFIRM_MAX_WAIT_MS;

    while (true) {
      try {
        const response = await this.client.post<PairConfirmResponse>("/pair/confirm", {
          pairing_id: pairingId,
          origin: window.location.origin || undefined,
        });

        storeSecret(response.data.secret);
        logger.info("Pairing confirmed — secret stored", {}, "companion");
        return;
      } catch (error) {
        if (!isWaitingForCompanionConfirmation(error) || Date.now() >= deadline) {
          throw error;
        }

        await delay(PAIR_CONFIRM_RETRY_DELAY_MS);
      }
    }
  }

  /** Cancel a pending pairing for the current browser origin. */
  async cancelPairing(pairingId: string): Promise<void> {
    await this.client.post("/pair/cancel", {
      pairing_id: pairingId,
      origin: window.location.origin || undefined,
    });
  }

  /** Query the companion for the current browser origin's pairing status. */
  async getPairStatus(): Promise<PairStatusResponse> {
    const response = await this.client.get<PairStatusResponse>("/pair/status", {
      params: { origin: window.location.origin || undefined },
    });
    return response.data;
  }

  /** Remove the current browser origin from the companion. */
  async unpairCurrentOrigin(): Promise<void> {
    const headers = await this.buildAuthHeaders("DELETE", "/pair/current");
    await this.client.delete("/pair/current", { headers });
  }

  /** Validate the current browser's authenticated pairing with the companion. */
  async testPairing(): Promise<PairTestResponse> {
    const headers = await this.buildAuthHeaders("POST", "/pair/test");
    const response = await this.client.post<PairTestResponse>("/pair/test", undefined, { headers });
    return response.data;
  }

  async getDirectoryPolicyStatus(options?: { signal?: AbortSignal }): Promise<CompanionDirectoryPolicyStatus> {
    const headers = await this.buildAuthHeaders("GET", "/directory-index/policy");
    const response = await this.client.get<CompanionDirectoryPolicyStatus>("/directory-index/policy", { headers, ...options });
    return response.data;
  }

  async requestDirectoryPolicyChallenge(options?: { signal?: AbortSignal }): Promise<CompanionDirectoryPolicyStatus> {
    const headers = await this.buildAuthHeaders("POST", "/directory-index/policy/challenge");
    const response = await this.client.post<CompanionDirectoryPolicyStatus>("/directory-index/policy/challenge", undefined, {
      headers,
      ...options,
    });
    return response.data;
  }

  async redeemDirectoryPolicyGrant(grant: string, options?: { signal?: AbortSignal }): Promise<CompanionDirectoryPolicyStatus> {
    const headers = await this.buildAuthHeaders("POST", "/directory-index/policy/redeem");
    const response = await this.client.post<CompanionDirectoryPolicyStatus>(
      "/directory-index/policy/redeem",
      { grant },
      { headers, ...options }
    );
    return response.data;
  }

  /** Synchronize the current browser localization to the companion. */
  async syncLocalization(payload: CompanionLocalizationPayload): Promise<CompanionLocalizationSyncResponse> {
    const headers = await this.buildAuthHeaders("POST", "/localization");
    const response = await this.client.post<CompanionLocalizationSyncResponse>("/localization", payload, { headers });
    return response.data;
  }

  // ── Drives ───────────────────────────────────────────────────────────────

  /**
   * Enumerate all accessible drives/volumes.
   *
   * Requires an active pairing (HMAC auth).
   */
  async getDrives(): Promise<DriveInfo[]> {
    const headers = await this.buildAuthHeaders("GET", "/drives");
    const response = await this.client.get<DriveInfo[]>("/drives", { headers });
    return response.data;
  }

  // ── Browse ───────────────────────────────────────────────────────────────

  /**
   * List directory contents on a local drive.
   */
  async listDirectory(driveId: string, path = ""): Promise<{ path: string; items: unknown[]; total: number }> {
    const headers = await this.buildAuthHeaders("GET", `/browse/${driveId}/list?${new URLSearchParams({ path })}`);
    const response = await this.client.get(`/browse/${driveId}/list`, {
      headers,
      params: { path },
    });
    return response.data;
  }

  /**
   * Get file/directory metadata on a local drive.
   */
  async getFileInfo(driveId: string, path = ""): Promise<unknown> {
    const headers = await this.buildAuthHeaders("GET", `/browse/${driveId}/info?${new URLSearchParams({ path })}`);
    const response = await this.client.get(`/browse/${driveId}/info`, {
      headers,
      params: { path },
    });
    return response.data;
  }

  /** Create a ZIP directly from selected local paths. */
  async createArchive(
    driveId: string,
    sourcePaths: string[],
    targetPath: string,
    signal?: AbortSignal
  ): Promise<CompanionArchiveCreationResult> {
    const headers = await this.buildAuthHeaders("POST", `/browse/${driveId}/archive`);
    const response = await this.client.post<CompanionArchiveCreationResult>(
      `/browse/${driveId}/archive`,
      { source_paths: sourcePaths, target_path: targetPath },
      { headers, signal }
    );
    return response.data;
  }
}

export const companionService = new CompanionService();
export default companionService;

// ── WebSocket helpers ────────────────────────────────────────────────────────

/**
 * Build an authenticated WebSocket URL for the companion.
 *
 * The browser WebSocket API does not support custom headers, so HMAC
 * credentials are passed as query parameters on the upgrade request.
 * Returns `null` if no pairing secret is stored.
 */
export async function buildCompanionWsUrl(): Promise<string | null> {
  if (!companionSession.hasSecret()) return null;

  // Derive ws:// URL from the HTTP base URL
  const wsBase = COMPANION_BASE_URL.replace(/^http/, "ws");
  return `${wsBase}/ws?${await companionSession.getSignedQuery("GET", `${COMPANION_BASE_URL}/ws`)}`;
}
