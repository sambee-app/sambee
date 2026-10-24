import { authSession } from "./authSession";
import { getServerBaseUrl } from "./backendRouter";
import type { StorageRecoveryHandle } from "./storageContracts";

const FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY = "sambee:foreground-archive-operation";
const FOREGROUND_ARCHIVE_OPERATION_TTL_MS = 24 * 60 * 60_000;

let localArchiveAbortController: AbortController | null = null;

export interface ForegroundArchiveOperation {
  operationId: string;
  startedAt: number;
  recovery?: StorageRecoveryHandle;
}

function isStorageRecoveryHandle(value: unknown): value is StorageRecoveryHandle {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const handle = value as Partial<StorageRecoveryHandle>;
  return (
    handle.schemaVersion === 2 &&
    handle.contractVersion === "v2" &&
    (handle.backendKind === "smb" || handle.backendKind === "local") &&
    typeof handle.opaqueOperationId === "string" &&
    handle.opaqueOperationId.length > 0 &&
    typeof handle.expiresAt === "number"
  );
}

function isForegroundArchiveOperation(value: unknown): value is ForegroundArchiveOperation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const marker = value as Partial<ForegroundArchiveOperation>;
  return (
    typeof marker.operationId === "string" &&
    marker.operationId.length > 0 &&
    typeof marker.startedAt === "number" &&
    (marker.recovery === undefined || isStorageRecoveryHandle(marker.recovery))
  );
}

function cancellationUrl(operationId: string): string {
  return new URL(`archive/v2/operations/${encodeURIComponent(operationId)}/cancel`, `${getServerBaseUrl().replace(/\/$/, "")}/`).toString();
}

export function storeForegroundArchiveOperation(recovery: StorageRecoveryHandle | string): void {
  const operationId = typeof recovery === "string" ? recovery : recovery.opaqueOperationId;
  const marker: ForegroundArchiveOperation = {
    operationId,
    startedAt: Date.now(),
    ...(typeof recovery === "string" ? {} : { recovery }),
  };
  try {
    sessionStorage.setItem(FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    // Storage is best effort. The foreground dialog remains the primary control surface.
  }
}

export function loadForegroundArchiveOperation(): ForegroundArchiveOperation | null {
  try {
    const raw = sessionStorage.getItem(FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const marker: unknown = JSON.parse(raw);
    if (!isForegroundArchiveOperation(marker) || Date.now() - marker.startedAt > FOREGROUND_ARCHIVE_OPERATION_TTL_MS) {
      clearForegroundArchiveOperation();
      return null;
    }
    return marker;
  } catch {
    clearForegroundArchiveOperation();
    return null;
  }
}

export function clearForegroundArchiveOperation(operationId?: string): void {
  try {
    const raw = sessionStorage.getItem(FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY);
    const marker: unknown = raw ? JSON.parse(raw) : null;
    if (!operationId || (isForegroundArchiveOperation(marker) && marker.operationId === operationId)) {
      sessionStorage.removeItem(FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY);
    }
  } catch {
    sessionStorage.removeItem(FOREGROUND_ARCHIVE_OPERATION_STORAGE_KEY);
  }
}

export function requestForegroundArchiveCancellation(operationId: string): void {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  const token = authSession.getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  void fetch(cancellationUrl(operationId), {
    method: "POST",
    headers,
    credentials: "include",
    keepalive: true,
  }).catch(() => {
    // The reload recovery path retries cancellation if this best-effort request is interrupted.
  });
}

export function beginForegroundLocalArchiveRequest(): AbortSignal {
  localArchiveAbortController?.abort();
  localArchiveAbortController = new AbortController();
  return localArchiveAbortController.signal;
}

export function abortForegroundLocalArchiveRequest(): void {
  localArchiveAbortController?.abort();
}

export function clearForegroundLocalArchiveRequest(signal: AbortSignal): void {
  if (localArchiveAbortController?.signal === signal) {
    localArchiveAbortController = null;
  }
}

export function hasForegroundArchiveWork(): boolean {
  return loadForegroundArchiveOperation() !== null || localArchiveAbortController !== null;
}
