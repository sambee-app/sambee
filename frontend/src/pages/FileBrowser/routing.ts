import { SETTINGS_CATEGORY_ORDER, type SettingsCategory } from "../../components/Settings/settingsCategories";
import type { MobileSettingsView } from "../../components/Settings/settingsNavigation";
import { extractDriveId, isLocalDrive, LOCAL_DRIVE_PREFIX } from "../../services/backendRouter";
import type { Connection } from "../../types";
import type { ViewerId } from "../../utils/FileTypeRegistry";
import type { PaneId, VirtualRouteLocation } from "./types";
import { ACTIVE_PANE_QUERY_KEY, RIGHT_PANE_QUERY_KEY } from "./types";

export const BROWSE_TARGET_KIND_SMB = "smb";
export const BROWSE_TARGET_KIND_LOCAL = "local";

export type BrowseTargetKind = typeof BROWSE_TARGET_KIND_SMB | typeof BROWSE_TARGET_KIND_LOCAL;

export const WORKSPACE_QUERY_KEYS = ["file", "viewer", "mode", "pane", "virtual", "settings"] as const;
const VIEWER_IDS: readonly string[] = ["image", "markdown", "pdf", "text"];

export interface ViewerRoute {
  file: BrowseRouteTarget;
  paneId: PaneId;
  viewerId: ViewerId;
  mode: "view" | "edit";
}

export interface BrowseRouteTarget {
  kind: BrowseTargetKind;
  targetId: string;
  path: string;
  virtualLocation?: VirtualRouteLocation;
}

export interface ResolvedBrowseRouteTarget extends BrowseRouteTarget {
  connectionId: string;
}

export interface BrowseRouteState {
  left: BrowseRouteTarget | null;
  right: BrowseRouteTarget | null;
  activePaneId: PaneId;
  viewer?: ViewerRoute;
  settings?: MobileSettingsView;
  extraSearch?: string;
}

export interface ResolvedBrowseRouteState {
  left: ResolvedBrowseRouteTarget | null;
  right: ResolvedBrowseRouteTarget | null;
  activePaneId: PaneId;
}

interface ParseBrowseRouteInput {
  targetType?: string;
  targetId?: string;
  path?: string;
  searchParams: URLSearchParams;
}

const isBrowseTargetKind = (value?: string): value is BrowseTargetKind => {
  return value === BROWSE_TARGET_KIND_SMB || value === BROWSE_TARGET_KIND_LOCAL;
};

const encodePath = (path: string): string => {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
};

const decodePath = (path: string): string => {
  return path
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
};

const parseRouteTarget = (kind: string | undefined, targetId: string | undefined, path: string | undefined): BrowseRouteTarget | null => {
  if (!isBrowseTargetKind(kind) || !targetId) {
    return null;
  }

  try {
    return {
      kind,
      targetId: decodeURIComponent(targetId),
      path: decodePath(path ?? ""),
    };
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
};

const buildRoutePath = (path: string, virtualLocation?: VirtualRouteLocation | null): string => {
  if (!virtualLocation) {
    return path;
  }

  return [virtualLocation.sourcePath, virtualLocation.virtualPath].filter(Boolean).join("/");
};

export const buildBrowseRouteTarget = (
  connectionId: string,
  path: string,
  connections: Pick<Connection, "id" | "slug">[],
  virtualLocation?: VirtualRouteLocation | null
): BrowseRouteTarget | null => {
  if (!connectionId) {
    return null;
  }

  if (isLocalDrive(connectionId)) {
    const driveId = extractDriveId(connectionId);
    return {
      kind: BROWSE_TARGET_KIND_LOCAL,
      targetId: driveId,
      path: buildRoutePath(path, virtualLocation),
      ...(virtualLocation ? { virtualLocation } : {}),
    };
  }

  const connection = connections.find((candidate) => candidate.id === connectionId);
  if (!connection?.slug) {
    return null;
  }

  return {
    kind: BROWSE_TARGET_KIND_SMB,
    targetId: connection.slug,
    path: buildRoutePath(path, virtualLocation),
    ...(virtualLocation ? { virtualLocation } : {}),
  };
};

export const resolveBrowseRouteTarget = (
  target: BrowseRouteTarget | null,
  connections: Pick<Connection, "id" | "slug">[]
): ResolvedBrowseRouteTarget | null => {
  if (!target) {
    return null;
  }

  if (target.kind === BROWSE_TARGET_KIND_LOCAL) {
    return {
      ...target,
      connectionId: `${LOCAL_DRIVE_PREFIX}${target.targetId}`,
    };
  }

  const connection = connections.find((candidate) => candidate.slug === target.targetId);
  if (!connection) {
    return null;
  }

  return {
    ...target,
    connectionId: connection.id,
  };
};

export const resolveBrowseRouteState = (
  state: BrowseRouteState,
  connections: Pick<Connection, "id" | "slug">[]
): ResolvedBrowseRouteState => {
  return {
    left: resolveBrowseRouteTarget(state.left, connections),
    right: resolveBrowseRouteTarget(state.right, connections),
    activePaneId: state.activePaneId,
  };
};

export const parseBrowseRoute = ({ targetType, targetId, path, searchParams }: ParseBrowseRouteInput): BrowseRouteState => {
  const left = parseRouteTarget(targetType, targetId, path);

  const p2 = searchParams.get(RIGHT_PANE_QUERY_KEY);
  let right: BrowseRouteTarget | null = null;
  if (p2) {
    const [rawKind, rawTargetId, ...encodedPathSegments] = p2.split("/");
    right = parseRouteTarget(rawKind, rawTargetId, encodedPathSegments.join("/"));
  }

  const activePaneId: PaneId = right && searchParams.get(ACTIVE_PANE_QUERY_KEY) === "2" ? "right" : "left";
  const viewer = parseViewerRoute(searchParams, Boolean(right));
  const settings = searchParams.get("settings");
  const extra = new URLSearchParams(searchParams);
  for (const key of [...WORKSPACE_QUERY_KEYS, RIGHT_PANE_QUERY_KEY, ACTIVE_PANE_QUERY_KEY]) extra.delete(key);

  return {
    left,
    right,
    activePaneId,
    ...(viewer ? { viewer } : {}),
    ...(settings === "main" || SETTINGS_CATEGORY_ORDER.includes(settings as SettingsCategory)
      ? { settings: settings as MobileSettingsView }
      : {}),
    ...(extra.size ? { extraSearch: extra.toString() } : {}),
  };
};

export function parseViewerRoute(searchParams: URLSearchParams, hasRightPane: boolean): ViewerRoute | undefined {
  const file = searchParams.get("file");
  const viewerId = searchParams.get("viewer");
  const mode = searchParams.get("mode") ?? "view";
  const pane = searchParams.get("pane") ?? "1";
  if (!file || !viewerId || !VIEWER_IDS.includes(viewerId) || !["view", "edit"].includes(mode)) return;
  if (!["1", "2"].includes(pane) || (pane === "2" && !hasRightPane)) return;
  if (mode === "edit" && viewerId !== "text" && viewerId !== "markdown") return;
  const [kind, targetId, ...segments] = file.split("/");
  const target = parseRouteTarget(kind, targetId, segments.join("/"));
  if (!target?.path) return;
  const virtual = searchParams.get("virtual");
  if (virtual) {
    try {
      const descriptor: unknown = JSON.parse(virtual);
      if (!Array.isArray(descriptor) || descriptor.length !== 3 || descriptor.some((value) => typeof value !== "string")) return;
      const [providerId, sourcePath, virtualPath] = descriptor as string[];
      if (providerId !== "zip" || !sourcePath || !virtualPath) return;
      target.virtualLocation = { providerId, sourcePath, virtualPath };
    } catch {
      return;
    }
  }
  return { file: target, viewerId: viewerId as ViewerId, paneId: pane === "2" ? "right" : "left", mode: mode as ViewerRoute["mode"] };
}

export const serializeBrowseRoute = ({ left, right, activePaneId, viewer, settings, extraSearch }: BrowseRouteState): string => {
  const encodedLeftPath = left ? encodePath(buildRoutePath(left.path, left.virtualLocation)) : "";
  let nextUrl = left
    ? `/browse/${left.kind}/${encodeURIComponent(left.targetId)}${encodedLeftPath ? `/${encodedLeftPath}` : ""}`
    : "/browse";

  const queryParams = new URLSearchParams(extraSearch);
  for (const key of [...WORKSPACE_QUERY_KEYS, RIGHT_PANE_QUERY_KEY, ACTIVE_PANE_QUERY_KEY]) queryParams.delete(key);
  if (right) {
    const encodedRightTargetId = encodeURIComponent(right.targetId);
    const encodedRightPath = encodePath(buildRoutePath(right.path, right.virtualLocation));
    const p2Value = `${right.kind}/${encodedRightTargetId}${encodedRightPath ? `/${encodedRightPath}` : ""}`;
    queryParams.set(RIGHT_PANE_QUERY_KEY, p2Value);
    if (activePaneId === "right") {
      queryParams.set(ACTIVE_PANE_QUERY_KEY, "2");
    }
  }

  if (viewer) {
    queryParams.set("file", `${viewer.file.kind}/${encodeURIComponent(viewer.file.targetId)}/${encodePath(viewer.file.path)}`);
    queryParams.set("viewer", viewer.viewerId);
    if (viewer.mode === "edit") queryParams.set("mode", "edit");
    if (viewer.paneId === "right") queryParams.set("pane", "2");
    const virtual = viewer.file.virtualLocation;
    if (virtual) queryParams.set("virtual", JSON.stringify([virtual.providerId, virtual.sourcePath, virtual.virtualPath]));
  }
  if (settings) queryParams.set("settings", settings);

  if (queryParams.size > 0) {
    nextUrl += `?${queryParams.toString()}`;
  }

  return nextUrl;
};
