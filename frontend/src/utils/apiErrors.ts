import { translate } from "../i18n";
import { isClientTimeoutError, isLocalAbortError } from "../services/backendAvailability";
import { isApiError, type OidcMappingValidationError } from "../types";

export type FileFailureKind = "missing" | "not_file" | "access_denied" | "timeout" | "unavailable" | "pairing" | "cancelled" | "unknown";

const FILE_FAILURE_CODES: Readonly<Record<string, FileFailureKind>> = {
  item_not_found: "missing",
  file_not_found: "missing",
  recent_file_target_missing: "missing",
  local_link_target_missing: "missing",
  not_a_file: "not_file",
  recent_file_target_not_file: "not_file",
  file_access_denied: "access_denied",
  recent_file_access_denied: "access_denied",
  local_link_target_access_denied: "access_denied",
  file_timeout: "timeout",
  file_unavailable: "unavailable",
  recent_file_validation_transient: "unavailable",
  recent_file_connection_removed: "unavailable",
  connection_not_found: "unavailable",
  companion_auth_signature_mismatch: "pairing",
  companion_pairing_missing: "pairing",
  pair_confirmation_pending: "pairing",
};

export function getStorageErrorCode(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const detail = error.response?.data?.detail;
  const code = typeof detail === "object" && detail !== null && "code" in detail ? detail.code : error.response?.data?.code;
  return typeof code === "string" ? code : null;
}

export function classifyFileFailure(error: unknown, path: string): { kind: FileFailureKind; message: string } {
  if (error instanceof PhysicalFileRequestError) return error.failure;
  const code = getStorageErrorCode(error);
  const status = isApiError(error) ? error.response?.status : undefined;
  const kind = isLocalAbortError(error)
    ? "cancelled"
    : (code && FILE_FAILURE_CODES[code]) ||
      (isClientTimeoutError(error) || status === 504 ? "timeout" : status === 403 ? "access_denied" : "unknown");
  const name = path.split("/").at(-1) || path;
  return { kind, message: translate(`fileBrowser.chrome.alerts.fileFailure.${kind}`, { name }) };
}

const MAX_FILE_ERROR_PAYLOAD_BYTES = 64 * 1024;

export class PhysicalFileRequestError extends Error {
  readonly failure;
  readonly response;

  constructor(error: unknown, path: string, originalError: unknown = error) {
    const failure = classifyFileFailure(error, path);
    super(failure.message, { cause: originalError });
    this.name = "PhysicalFileRequestError";
    this.failure = failure;
    this.response = isApiError(error) ? error.response : undefined;
  }
}

export async function normalizePhysicalFileFailure(error: unknown, path: string): Promise<PhysicalFileRequestError> {
  let structuredError = error;
  const response = isApiError(error) ? error.response : undefined;
  const payload: unknown = response?.data;
  const headers = response && "headers" in response ? response.headers : undefined;
  const contentType = headers && typeof headers === "object" && "content-type" in headers ? headers["content-type"] : undefined;
  const encodedPayload =
    typeof payload === "string" && payload.length <= MAX_FILE_ERROR_PAYLOAD_BYTES && typeof contentType === "string"
      ? new Blob([payload], { type: contentType })
      : payload;
  if (
    encodedPayload instanceof Blob &&
    encodedPayload.size <= MAX_FILE_ERROR_PAYLOAD_BYTES &&
    /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(encodedPayload.type)
  ) {
    try {
      const data: unknown = JSON.parse(await encodedPayload.text());
      if (typeof data === "object" && data !== null) structuredError = { response: { ...response, data } };
    } catch {
      // An unreadable error response is not proof that the file is missing.
    }
  }
  return new PhysicalFileRequestError(structuredError, path, error);
}

interface ApiErrorMessageOptions {
  includeOriginalMessage?: boolean;
}

/**
 * Extract a user-facing message from API errors while ignoring structured
 * payloads like ConflictInfo when a plain string is required by the UI.
 */
export function getApiErrorMessage(error: unknown, fallback: string, options: ApiErrorMessageOptions = {}): string {
  if (error instanceof PhysicalFileRequestError) return error.message;
  if (!isApiError(error)) {
    return fallback;
  }

  const detail = error.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  if (isMessageDetail(detail)) {
    return detail.message;
  }
  if (isOidcMappingValidationDetail(detail)) {
    return detail.errors.map((mappingError) => mappingError.message).join(" ");
  }

  if (options.includeOriginalMessage && typeof error.message === "string" && error.message.trim()) {
    return `${fallback}: ${error.message}`;
  }

  return fallback;
}

export function getOidcMappingValidationErrors(error: unknown): OidcMappingValidationError[] {
  if (!isApiError(error)) return [];
  const detail = error.response?.data?.detail;
  return isOidcMappingValidationDetail(detail) ? detail.errors : [];
}

function isMessageDetail(value: unknown): value is { message: string } {
  return (
    typeof value === "object" && value !== null && "message" in value && typeof value.message === "string" && value.message.trim() !== ""
  );
}

function isOidcMappingValidationDetail(value: unknown): value is { errors: OidcMappingValidationError[] } {
  if (typeof value !== "object" || value === null || !("errors" in value) || !Array.isArray(value.errors)) return false;
  return value.errors.every(
    (item) => typeof item === "object" && item !== null && typeof item.error_code === "string" && typeof item.message === "string"
  );
}
