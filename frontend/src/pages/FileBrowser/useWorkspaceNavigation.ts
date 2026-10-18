import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import type { MobileSettingsView } from "../../components/Settings/settingsNavigation";
import type { BrowserContentServices } from "../../services/browserContentServices";
import type { Connection } from "../../types";
import { FileType } from "../../types";
import { getFileTypeByExtension } from "../../utils/FileTypeRegistry";
import { type BrowserItem, physicalLocation, virtualItemHandle, virtualLocation } from "./contentProviders";
import { type BrowseRouteState, buildBrowseRouteTarget, resolveBrowseRouteTarget, serializeBrowseRoute } from "./routing";
import type { PaneId, UseFileBrowserPaneReturn, ViewInfo } from "./types";

export function useWorkspaceNavigation({
  route,
  connections,
  services,
  left,
  right,
  ready,
}: {
  route: BrowseRouteState;
  connections: Connection[];
  services: BrowserContentServices;
  left: UseFileBrowserPaneReturn;
  right: UseFileBrowserPaneReturn;
  ready: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const action = useNavigationType();
  const entries = useRef({ keys: [location.key], index: 0, current: location.key });
  if (entries.current.current !== location.key) {
    const history = entries.current;
    if (action === "PUSH") {
      history.keys = history.keys.slice(0, history.index + 1);
      history.keys.push(location.key);
      history.index += 1;
    } else if (action === "REPLACE") {
      history.keys[history.index] = location.key;
    } else {
      const index = history.keys.indexOf(location.key);
      if (index < 0) {
        history.keys = [location.key];
        history.index = 0;
      } else history.index = index;
    }
    history.current = location.key;
  }
  const state = location.state && typeof location.state === "object" ? location.state : {};
  const pendingViewer = useRef<{ identity: string; info: ViewInfo } | null>(null);
  const panes = useRef({ left, right });
  panes.current = { left, right };
  const [viewerError, setViewerError] = useState<unknown>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [resolvedViewerIdentity, setResolvedViewerIdentity] = useState("");
  const [viewerRequestRevision, setViewerRequestRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const viewer = route.viewer;
  const viewerIdentity = viewer ? JSON.stringify([viewer.file, viewer.viewerId, viewer.paneId]) : "";
  const getViewer = useEffectEvent(() => viewer);
  const applyViewer = useEffectEvent((paneId: PaneId, info: ViewInfo | null) => {
    const pane = panes.current[paneId];
    if (info) {
      pane.setViewInfo(info);
      if (info.currentIndex !== undefined) pane.handleViewIndexChange(info.currentIndex);
      const other = panes.current[paneId === "left" ? "right" : "left"];
      if (other.viewInfo) other.handleViewClose();
    } else if (pane.viewInfo) pane.handleViewClose();
  });

  const navigateRoute = useCallback(
    (next: BrowseRouteState, options?: { replace?: boolean }) => {
      const url = serializeBrowseRoute(next);
      if (url === location.pathname + location.search) return;
      void navigate(
        { pathname: url.split("?")[0], search: url.includes("?") ? url.slice(url.indexOf("?")) : "", hash: location.hash },
        { replace: options?.replace, state }
      );
    },
    [location, navigate, state]
  );

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const invalidViewer = !route.viewer && ["file", "viewer", "mode", "pane", "virtual"].some((key) => search.has(key));
    const invalidSettings = search.has("settings") && !route.settings;
    if (!invalidViewer && !invalidSettings) return;
    if (invalidViewer) for (const key of ["file", "viewer", "mode", "pane", "virtual"]) search.delete(key);
    if (invalidSettings) search.delete("settings");
    void navigate(
      { pathname: location.pathname, search: search.toString(), hash: location.hash },
      { replace: true, state: location.state }
    );
  }, [location, navigate, route.viewer, route.settings]);

  const openViewer = (paneId: PaneId, info: ViewInfo) => {
    const virtual = info.virtualSource;
    const target = buildBrowseRouteTarget(
      info.connectionId ?? panes.current[paneId].connectionId,
      info.path,
      connections,
      virtual ? { providerId: virtual.location.providerId, sourcePath: virtual.location.source.path, virtualPath: virtual.path } : null
    );
    if (!target || !info.viewerId) return;
    setViewerRequestRevision((revision) => revision + 1);
    const nextViewer = { file: target, paneId, viewerId: info.viewerId, mode: "view" as const };
    pendingViewer.current = { identity: JSON.stringify([target, info.viewerId, paneId]), info };
    navigateRoute({ ...route, viewer: nextViewer, settings: undefined });
  };

  useEffect(() => {
    const viewer = getViewer();
    setViewerError(null);
    if (!viewer) {
      pendingViewer.current = null;
      setViewerLoading(false);
      setResolvedViewerIdentity("");
      applyViewer("left", null);
      applyViewer("right", null);
      return;
    }
    if (!ready) return;
    const controller = new AbortController();
    const paneId = viewer.paneId;
    const cached = pendingViewer.current;
    pendingViewer.current = null;
    if (cached?.identity === viewerIdentity) {
      applyViewer(paneId, cached.info);
      setViewerLoading(false);
      setResolvedViewerIdentity(viewerIdentity);
      return;
    }
    const existing = panes.current[paneId].viewInfo;
    const target = resolveBrowseRouteTarget(viewer.file, connections);
    const virtual = viewer.file.virtualLocation;
    const path = virtual?.virtualPath ?? viewer.file.path;
    const existingVirtual = existing?.virtualSource;
    const sameVirtual = virtual
      ? existingVirtual?.location.providerId === virtual.providerId &&
        existingVirtual.location.source.path === virtual.sourcePath &&
        existingVirtual.path === virtual.virtualPath
      : !existingVirtual;
    if (
      sameVirtual &&
      existing?.connectionId === target?.connectionId &&
      existing.path === path &&
      existing.viewerId === viewer.viewerId &&
      !retry
    ) {
      setViewerLoading(false);
      setResolvedViewerIdentity(viewerIdentity);
      return;
    }
    setViewerLoading(true);
    void (async () => {
      if (!target) throw new Error("The file's connection is unavailable. Close the viewer and check Connections settings.");
      const parent = path.split("/").slice(0, -1).join("/");
      let virtualSource: ViewInfo["virtualSource"];
      let metadata: { type?: FileType; size?: number; modified_at?: string; mime_type?: string };
      if (virtual) {
        const location = virtualLocation(
          virtual.providerId,
          target.connectionId,
          physicalLocation(target.connectionId, virtual.sourcePath),
          parent
        );
        const provider = services.providers.get(location);
        let cursor: string | undefined;
        let item: BrowserItem | undefined;
        do {
          const listing = await provider.list(location, { cursor, signal: controller.signal });
          item = listing.items.find((candidate) => candidate.handle.path === path);
          cursor = listing.nextCursor ?? undefined;
        } while (!item && cursor && !controller.signal.aborted);
        if (!item) throw new Error("The archive member is unavailable. Close the viewer and refresh the archive.");
        metadata = item.entry;
        virtualSource = virtualItemHandle(location, path);
      } else {
        const item = services.registry.resolveItem({ connectionId: target.connectionId, path });
        metadata = await services.registry.getBackend(item.target).getInfo(item, { signal: controller.signal });
      }
      if (metadata.type && metadata.type !== FileType.FILE)
        throw new Error("This location is not a file. Close the viewer to browse its directory.");
      if (controller.signal.aborted) return;
      const pane = panes.current[paneId];
      const images =
        viewer.viewerId === "image" && !virtualSource && pane.connectionId === target.connectionId ? pane.imageFiles : undefined;
      const gallery = images?.includes(path) ? images : undefined;
      applyViewer(paneId, {
        connectionId: target.connectionId,
        path,
        viewerId: viewer.viewerId,
        mimeType: metadata.mime_type ?? getFileTypeByExtension(path)?.mimeTypes[0] ?? "application/octet-stream",
        fileSize: metadata.size,
        fileModifiedAt: metadata.modified_at,
        virtualSource,
        images: gallery,
        currentIndex: gallery?.indexOf(path),
        sessionId: crypto.randomUUID(),
      });
      setResolvedViewerIdentity(viewerIdentity);
    })()
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setViewerError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setViewerLoading(false);
      });
    return () => controller.abort();
  }, [viewerIdentity, ready, retry, connections, services]);

  return {
    navigateRoute,
    openViewer,
    closeViewer: () => navigateRoute({ ...route, viewer: undefined }),
    changeImage: (paneId: PaneId, index: number) => {
      const info = panes.current[paneId].viewInfo;
      const path = info?.images?.[index];
      if (info && path) {
        openViewer(paneId, {
          ...info,
          path,
          currentIndex: index,
          virtualSource: info.virtualSource ? { ...info.virtualSource, path } : undefined,
        });
      }
    },
    changeMode: (mode: "view" | "edit", replace = false) => {
      if (!viewer || viewer.mode === mode) return;
      const next = { ...route, viewer: { ...viewer, mode } };
      navigateRoute(next, { replace });
    },
    openSettings: (settings: MobileSettingsView) => navigateRoute({ ...route, settings }),
    closeSettings: () => navigateRoute({ ...route, settings: undefined }),
    backSettings: () => {
      if (entries.current.index > 0) void navigate(-1);
      else navigateRoute({ ...route, settings: route.settings === "main" ? undefined : "main" }, { replace: true });
    },
    viewerError,
    viewerSelectionKey: `${location.key}:${viewerRequestRevision}`,
    viewerLoading: Boolean(viewer && (viewerLoading || resolvedViewerIdentity !== viewerIdentity)),
    retryViewer: () => setRetry((value) => value + 1),
  };
}
