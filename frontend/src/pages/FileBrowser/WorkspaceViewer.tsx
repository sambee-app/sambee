import { type Ref, useContext, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UNSAFE_DataRouterContext, useLocation, useNavigation, useParams } from "react-router-dom";
import ConfirmDeleteDialog from "../../components/FileBrowser/ConfirmDeleteDialog";
import { DynamicViewer, ViewerFallbackDialog } from "../../components/FileBrowser/DynamicViewer";
import type { ViewerLeaveGuard } from "../../hooks/useRoutedViewerEditing";
import { isLocalDrive } from "../../services/backendRouter";
import type { BrowserContentServices } from "../../services/browserContentServices";
import { logger } from "../../services/logger";
import { type Connection, FileType, isApiError } from "../../types";
import { classifyFileFailure, getStorageErrorCode } from "../../utils/apiErrors";
import { isConnectionReadOnly, isConnectionWritable } from "./access";
import { type ContentOperationEnvironment, deleteContentFile } from "./contentOperations";
import { physicalItemHandle } from "./contentProviders";
import { parseBrowseRoute, resolveBrowseRouteTarget } from "./routing";
import type { UseFileBrowserPaneReturn, ViewerDeletionTarget } from "./types";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

export type WorkspaceViewerHandle = Pick<
  ReturnType<typeof useWorkspaceNavigation>,
  "openViewer" | "openSettings" | "closeSettings" | "backSettings"
>;

interface WorkspaceViewerProps {
  ref: Ref<WorkspaceViewerHandle>;
  connections: Connection[];
  services: BrowserContentServices;
  contentOperations: ContentOperationEnvironment;
  left: UseFileBrowserPaneReturn;
  right: UseFileBrowserPaneReturn;
  ready: boolean;
  onGuardChange: (guard: ViewerLeaveGuard | null) => void;
}

interface DeleteTarget extends ViewerDeletionTarget {
  selectionKey: string;
}

function matchesDeleteTarget(target: DeleteTarget, selection: DeleteTarget | null) {
  return (
    target.connectionId === selection?.connectionId &&
    target.path === selection.path &&
    target.paneId === selection.paneId &&
    target.sessionId === selection.sessionId &&
    target.selectionKey === selection.selectionKey
  );
}

function deleteFailure(error: unknown, target: DeleteTarget) {
  const code = getStorageErrorCode(error);
  if (code === "smb_mutation_uncertain") return "uncertain";
  if (code === "smb_recovery_busy") return "recoveryBusy";
  const status = isApiError(error) ? error.response?.status : undefined;
  if (isLocalDrive(target.connectionId) && !code && (status === 404 || status === 405)) return "companionUpdate";
  switch (classifyFileFailure(error, target.path).kind) {
    case "timeout":
      return "uncertain";
    case "missing":
      return "missing";
    case "not_file":
      return "notFile";
    case "access_denied":
      return "accessDenied";
    default:
      return "failed";
  }
}

type DeleteResult = { target: DeleteTarget; failure?: ReturnType<typeof deleteFailure> };

const deleteDialogContainer = () => document.fullscreenElement ?? document.body;

export function WorkspaceViewer({
  ref,
  connections,
  services,
  contentOperations,
  left,
  right,
  ready,
  onGuardChange,
}: WorkspaceViewerProps) {
  const { t } = useTranslation();
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const location = useLocation();
  const pendingLocationKey = useNavigation().location?.key;
  const params = useParams<{ targetType: string; targetId: string; "*": string }>();
  const route = useMemo(
    () =>
      parseBrowseRoute({
        targetType: params.targetType,
        targetId: params.targetId,
        path: params["*"],
        searchParams: new URLSearchParams(location.search),
      }),
    [params.targetType, params.targetId, params["*"], location.search]
  );
  const workspace = useWorkspaceNavigation({ route, connections, services, left, right, ready });
  useImperativeHandle(ref, () => workspace, [workspace]);
  const pane = left.viewInfo ? left : right;
  const info = workspace.viewerSelection ?? pane.viewInfo;
  const isArchiveListing = Boolean(info?.virtualSource && !info.searchSessionId);
  const viewerInfo =
    info && isArchiveListing && info.viewerId === "image"
      ? { ...info, images: pane.imageFiles, currentIndex: Math.max(pane.imageFiles.indexOf(info.path), 0) }
      : info;
  const connectionId = info?.connectionId ?? pane.connectionId;
  const connection = connections.find((candidate) => candidate.id === connectionId);
  const [confirmation, setConfirmation] = useState<{ target: DeleteTarget; error?: ReturnType<typeof deleteFailure> } | null>(null);
  const [pendingTarget, setPendingTarget] = useState<DeleteTarget | null>(null);
  const [deleteResult, setDeleteResult] = useState<DeleteResult | null>(null);
  const inFlight = useRef(false);
  const uncertain = useRef(new Set<string>());
  const targetKey = (target: DeleteTarget) => JSON.stringify([target.sessionId, target.connectionId, target.path]);
  const deletePending = pendingTarget !== null && pendingTarget.connectionId === connectionId && pendingTarget.path === info?.path;
  const routed = route.viewer;
  const routedFile = routed && resolveBrowseRouteTarget(routed.file, connections);
  const selection: DeleteTarget | null =
    ready &&
    !route.settings &&
    !workspace.viewerLoading &&
    !workspace.viewerError &&
    info &&
    routed &&
    routed.viewerId === info.viewerId &&
    info.viewerId !== "text" &&
    !info.virtualSource &&
    !routedFile?.virtualLocation &&
    isConnectionWritable(connection) &&
    routedFile?.connectionId === connectionId &&
    routedFile.path === info.path &&
    (routed.paneId === "left" ? Boolean(left.viewInfo) : !left.viewInfo && Boolean(right.viewInfo)) &&
    (routed.mode === "view" || (deletePending && info.viewerId === "markdown"))
      ? { connectionId, path: info.path, paneId: routed.paneId, sessionId: info.sessionId, selectionKey: workspace.viewerSelectionKey }
      : null;
  const current = useRef({ selection, locationKey: location.key, applyDeletion: workspace.applyViewerDeletion });
  useLayoutEffect(() => {
    current.current = { selection, locationKey: location.key, applyDeletion: workspace.applyViewerDeletion };
  });
  const hasLiveRoute = () => {
    const liveLocation = router?.state.navigation.location ?? router?.state.location;
    // The router can accept Back or Forward before React commits the new viewer.
    return !liveLocation || liveLocation.key === current.current.locationKey;
  };
  const liveSelection = () => (hasLiveRoute() ? current.current.selection : null);
  const shownConfirmation = confirmation && matchesDeleteTarget(confirmation.target, selection) ? confirmation : null;
  useEffect(() => {
    if (confirmation && !shownConfirmation) setConfirmation(null);
  }, [confirmation, shownConfirmation]);
  const sessionId = info?.sessionId;
  useEffect(() => {
    if (!sessionId) uncertain.current.clear();
  }, [sessionId]);

  const applyDeleteResult = useEffectEvent(({ target, failure }: DeleteResult) => {
    if (!hasLiveRoute()) return;
    const matchesSelection = matchesDeleteTarget(target, liveSelection());
    if (failure) {
      if (matchesSelection) {
        setConfirmation((previous) => (previous?.target === target ? { target, error: failure } : previous));
      }
    } else {
      if (matchesSelection) setConfirmation(null);
      current.current.applyDeletion(target, matchesSelection);
    }
    inFlight.current = false;
    setPendingTarget(null);
    setDeleteResult(null);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recheck a result when a pending route commits or is cancelled.
  useEffect(() => {
    if (!deleteResult) return;
    let active = true;
    // Keep edit mode blocked until the route commits and the result can be applied.
    // Run after effects so the pane and route can update together with flushSync.
    queueMicrotask(() => {
      if (active) applyDeleteResult(deleteResult);
    });
    return () => {
      active = false;
    };
  }, [deleteResult, location.key, pendingLocationKey]);

  const confirmDelete = async () => {
    if (!shownConfirmation || inFlight.current) return;
    const { target } = shownConfirmation;
    if (!matchesDeleteTarget(target, liveSelection()) || uncertain.current.has(targetKey(target))) return;
    inFlight.current = true;
    setPendingTarget(target);
    setConfirmation({ target });
    const parent = { connectionId: target.connectionId, path: target.path.split("/").slice(0, -1).join("/") };
    const invalidate = () => {
      left.handleDirectoryChanged(parent, { confirmedAbsence: true });
      right.handleDirectoryChanged(parent, { confirmedAbsence: true });
    };
    try {
      await deleteContentFile(physicalItemHandle(target.connectionId, target.path), contentOperations);
    } catch (error) {
      const failure = deleteFailure(error, target);
      logger.warn("Viewer file deletion failed", { connectionId: target.connectionId, failure }, "viewer");
      if (failure === "uncertain") {
        uncertain.current.add(targetKey(target));
        invalidate();
      }
      setDeleteResult({ target, failure });
      return;
    }
    invalidate();
    setDeleteResult({ target });
  };

  return (
    <>
      {workspace.viewerError && route.viewer ? (
        <ViewerFallbackDialog
          mode="failed"
          path={route.viewer.file.path}
          error={workspace.viewerError}
          onClose={workspace.closeViewer}
          onRetry={workspace.retryViewer}
        />
      ) : null}
      {info && (
        <DynamicViewer
          connectionId={connectionId}
          isReadOnly={isConnectionReadOnly(connection)}
          deletePending={deletePending}
          onDeleteRequest={
            selection && !pendingTarget && !uncertain.current.has(targetKey(selection))
              ? () => {
                  if (!inFlight.current && matchesDeleteTarget(selection, liveSelection())) {
                    setConfirmation((previous) => previous ?? { target: selection });
                  }
                }
              : undefined
          }
          isPending={workspace.viewerLoading || Boolean(workspace.viewerError)}
          viewInfo={viewerInfo ?? info}
          navigation={{
            selectionKey: workspace.viewerSelectionKey,
            mode: route.viewer?.mode ?? "view",
            onModeChange: workspace.changeMode,
            onGuardChange,
          }}
          onClose={workspace.closeViewer}
          onIndexChange={(index) => workspace.changeImage(left.viewInfo ? "left" : "right", index)}
          hasMoreItems={isArchiveListing ? pane.archiveHasMore : false}
          isLoadingMoreItems={isArchiveListing ? pane.archiveLoadingMore : false}
          loadMoreError={isArchiveListing ? pane.error : null}
          onLoadMoreItems={isArchiveListing ? pane.loadMoreArchive : undefined}
          contentProviders={services.providers}
        />
      )}
      {shownConfirmation && (
        <ConfirmDeleteDialog
          open
          items={[
            {
              name: shownConfirmation.target.path.split("/").at(-1) ?? shownConfirmation.target.path,
              path: shownConfirmation.target.path,
              type: FileType.FILE,
            },
          ]}
          isDeleting={pendingTarget !== null}
          disableConfirm={shownConfirmation.error === "uncertain"}
          error={shownConfirmation.error ? t(`viewer.delete.${shownConfirmation.error}`) : null}
          container={deleteDialogContainer}
          onClose={() => setConfirmation(null)}
          onEscape={() => {
            if (document.fullscreenElement) {
              void document.exitFullscreen().catch((error: unknown) => {
                if (document.fullscreenElement) logger.warn("Could not exit fullscreen from the delete confirmation", { error }, "viewer");
              });
            } else if (!inFlight.current) {
              setConfirmation(null);
            }
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}
