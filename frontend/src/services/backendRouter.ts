/**
 * BackendRouter — maps connection IDs to the correct backend.
 *
 * SMB connections route to the Sambee server (`/api`).
 * Local drives route to the companion app (`http://localhost:21549/api`).
 *
 * This module also handles:
 * - Merging companion drives into the connection list
 * - Creating synthetic Connection objects for local drives
 * - Determining which auth mechanism to use per request
 */

import type { Connection } from "../types";
import { COMPANION_BASE_URL, type DriveInfo } from "./companion";

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefix used for synthetic connection IDs representing local drives. */
export const LOCAL_DRIVE_PREFIX = "local-drive:";

const FORWARD_SLASH = "/";
const BACKSLASH = "\\";

/** Connection type value for local drives. */
export const CONNECTION_TYPE_LOCAL = "local";

/** Base URL for the primary Sambee backend API. */
export const SERVER_API_BASE_URL =
  import.meta.env["VITE_API_URL"] || (import.meta.env.MODE === "test" ? "http://localhost:3000/api" : "/api");

// ── Drive ↔ Connection Mapping ───────────────────────────────────────────────

/**
 * Convert a companion DriveInfo into a synthetic Connection object.
 *
 * These have IDs prefixed with `local-drive:` so we can distinguish
 * them from real server-side connections.
 */
export function driveToConnection(drive: DriveInfo): Connection {
  return {
    id: `${LOCAL_DRIVE_PREFIX}${drive.id}`,
    name: drive.name,
    slug: drive.id,
    type: CONNECTION_TYPE_LOCAL,
    host: "localhost",
    port: 21549,
    share_name: drive.id,
    username: "",
    scope: "private",
    access_mode: "read_write",
    can_manage: false,
    created_at: "",
    updated_at: "",
  };
}

/**
 * Extract the companion drive ID from a synthetic connection ID.
 *
 * @example extractDriveId("local-drive:c") → "c"
 */
export function extractDriveId(connectionId: string): string {
  return connectionId.slice(LOCAL_DRIVE_PREFIX.length);
}

// ── Route Resolution ─────────────────────────────────────────────────────────

/**
 * Determine whether a connection ID refers to a local drive.
 */
export function isLocalDrive(connectionId: string): boolean {
  return connectionId.startsWith(LOCAL_DRIVE_PREFIX);
}

/**
 * Normalize a local-drive path into the drive-relative format expected by the
 * browser state and companion API.
 *
 * Windows absolute inputs like `d:\temp` or `d:/temp` become `temp` when the
 * active connection targets drive `d`. Leading separators are also removed so
 * `/temp` and `\temp` resolve to `temp`.
 */
export function normalizeLocalDrivePath(connectionId: string, path: string): string {
  if (!isLocalDrive(connectionId)) {
    return path;
  }

  const normalizedSeparators = path.replaceAll(BACKSLASH, FORWARD_SLASH);
  const driveId = extractDriveId(connectionId);

  if (driveId.length === 1 && /^[A-Za-z]:/.test(normalizedSeparators)) {
    const requestedDrive = normalizedSeparators[0]?.toLowerCase();
    if (requestedDrive === driveId.toLowerCase()) {
      return normalizedSeparators.slice(2).replace(/^\/+/, "");
    }
  }

  return normalizedSeparators.replace(/^\/+/, "");
}

/**
 * Get the API base URL for a given connection.
 *
 * - Local drives → companion base URL
 * - Everything else → server base URL (relative `/api`)
 */
export function getBaseUrl(connectionId: string): string {
  if (isLocalDrive(connectionId)) {
    return COMPANION_BASE_URL;
  }
  return SERVER_API_BASE_URL;
}

/**
 * Get the API base URL for the primary Sambee backend.
 */
export function getServerBaseUrl(): string {
  return SERVER_API_BASE_URL;
}

/**
 * Get the browse path segment for API calls.
 *
 * For local drives, uses the drive ID (e.g., `c`, `root`, `volumes-data`).
 * For SMB connections, uses the connection UUID as-is.
 */
export function getBrowseSegment(connectionId: string): string {
  if (isLocalDrive(connectionId)) {
    return extractDriveId(connectionId);
  }
  return connectionId;
}

// ── Connection List Merging ──────────────────────────────────────────────────

/**
 * Merge server connections with companion drives into a unified list.
 *
 * Local drives are appended after server connections, maintaining
 * alphabetical order within each group.
 */
export function mergeConnections(serverConnections: Connection[], drives: DriveInfo[]): Connection[] {
  const driveConnections = drives.map(driveToConnection);
  return [...serverConnections, ...driveConnections];
}
