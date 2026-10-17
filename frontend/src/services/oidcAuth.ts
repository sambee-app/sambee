import type { AuthToken } from "../types";
import { authSession } from "./authSession";
import { logger } from "./logger";
import { PASSWORD_CHANGE_PATH } from "./passwordChange";

export const OIDC_ATTEMPT_MARKER = "sambee_oidc_attempted";
export const OIDC_LOGOUT_MARKER = "sambee_oidc_logout";
export const OIDC_RETURN_PATH_MARKER = "sambee_oidc_return_path";
export const OIDC_LOGIN_CHANNEL = "sambee-oidc-login";
const OIDC_CALLBACK_PATH = "/login/oidc/callback";

export function notifyOidcLogin(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(OIDC_LOGIN_CHANNEL);
    channel.postMessage({ type: "completed" });
    channel.close();
  } catch (error) {
    logger.warn("Could not notify other tabs of OIDC sign-in; they can recover when focused", { error }, "auth");
  }
}

export function sanitizeReturnPath(returnPath: string | null | undefined): string {
  if (!returnPath?.startsWith("/") || returnPath.startsWith("//") || returnPath.includes("\\")) return "/browse";
  try {
    const resolved = new URL(returnPath, window.location.origin);
    if (resolved.origin !== window.location.origin || resolved.pathname === OIDC_CALLBACK_PATH) return "/browse";
    return resolved.pathname + resolved.search;
  } catch {
    return "/browse";
  }
}

export function loginReturnPath(search: string): string {
  const requestedPath = new URLSearchParams(search).get("return_path");
  return sanitizeReturnPath(requestedPath ?? sessionStorage.getItem(OIDC_RETURN_PATH_MARKER));
}

export function loginPath(returnPath: string): string {
  return `/login?return_path=${encodeURIComponent(sanitizeReturnPath(returnPath))}`;
}

export function startOidcAuthorization(path: string, returnPath = "/browse"): void {
  const sanitizedReturnPath = sanitizeReturnPath(returnPath);
  sessionStorage.setItem(OIDC_RETURN_PATH_MARKER, sanitizedReturnPath);
  const separator = path.includes("?") ? "&" : "?";
  window.location.assign(`${path}${separator}return_path=${encodeURIComponent(sanitizedReturnPath)}`);
}

export async function completeAuthentication(response: AuthToken, fallbackReturnPath?: string, renewable = true): Promise<string> {
  const previousUserId = authSession.getUserId();
  authSession.beginNewLogin();
  authSession.setAuthenticated(response, renewable);
  authSession.completeLoginBootstrap();
  if (renewable && previousUserId === (response.user_id ?? null)) authSession.notifyNewLogin();
  sessionStorage.removeItem(OIDC_ATTEMPT_MARKER);
  sessionStorage.removeItem(OIDC_LOGOUT_MARKER);
  const returnPath = sanitizeReturnPath(response.return_path ?? fallbackReturnPath ?? sessionStorage.getItem(OIDC_RETURN_PATH_MARKER));
  sessionStorage.removeItem(OIDC_RETURN_PATH_MARKER);
  if (response.password_change_required) return `${PASSWORD_CHANGE_PATH}?return_path=${encodeURIComponent(returnPath)}`;
  await logger.initializeBackendTracing();
  return returnPath;
}
