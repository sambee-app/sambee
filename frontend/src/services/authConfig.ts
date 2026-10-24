import axios from "axios";
import { logger } from "./logger";

export type SignInMode = "none" | "password_only" | "oidc_or_password" | "oidc_only";

export interface OidcPublicConfig {
  display_name: string;
  authorization_path: string;
}

export interface AuthConfig {
  sign_in_mode: SignInMode;
  oidc: OidcPublicConfig | null;
}

interface CanonicalAuthConfigResponse {
  sign_in_mode: SignInMode;
  oidc?: OidcPublicConfig | null;
}

let authConfigCache: AuthConfig | null = null;

/**
 * Get authentication configuration from backend
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  if (authConfigCache) {
    return authConfigCache;
  }

  try {
    const baseURL = import.meta.env["VITE_API_URL"] || "/api";
    const response = await axios.get<unknown>(`${baseURL}/auth/config`);
    authConfigCache = parseAuthConfig(response.data);
    logger.info(`Auth configuration loaded: ${authConfigCache.sign_in_mode}`, {}, "auth");
    return authConfigCache;
  } catch (error) {
    logger.error("Failed to load auth configuration", { error }, "auth");
    throw error;
  }
}

function isOidcPublicConfig(value: unknown): value is OidcPublicConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate["display_name"] === "string" && typeof candidate["authorization_path"] === "string";
}

export function parseAuthConfig(value: unknown): AuthConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid authentication configuration");
  }

  const candidate = value as Partial<CanonicalAuthConfigResponse>;
  if (
    candidate.sign_in_mode === "none" ||
    candidate.sign_in_mode === "password_only" ||
    candidate.sign_in_mode === "oidc_or_password" ||
    candidate.sign_in_mode === "oidc_only"
  ) {
    const oidc = candidate.oidc ?? null;
    if (candidate.sign_in_mode !== "none" && candidate.sign_in_mode !== "password_only" && !isOidcPublicConfig(oidc)) {
      throw new Error("OIDC authentication configuration is incomplete");
    }
    if (oidc !== null && !isOidcPublicConfig(oidc)) {
      throw new Error("Invalid OIDC authentication configuration");
    }
    return { sign_in_mode: candidate.sign_in_mode, oidc };
  }

  throw new Error("Invalid authentication configuration");
}

/**
 * Check if authentication is required
 */
export async function isAuthRequired(): Promise<boolean> {
  const config = await getAuthConfig();
  return config.sign_in_mode !== "none";
}

/**
 * Clear cached auth configuration (useful for testing or when config changes)
 */
export function clearAuthConfigCache(): void {
  authConfigCache = null;
}
