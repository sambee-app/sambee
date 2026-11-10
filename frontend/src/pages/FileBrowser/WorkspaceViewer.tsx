import { type Ref, useImperativeHandle, useMemo } from "react";
import { useLocation, useParams } from "react-router-dom";
import { DynamicViewer, ViewerFallbackDialog } from "../../components/FileBrowser/DynamicViewer";
import type { ViewerLeaveGuard } from "../../hooks/useRoutedViewerEditing";
import type { BrowserContentServices } from "../../services/browserContentServices";
import type { Connection } from "../../types";
import { isConnectionReadOnly } from "./access";
import { parseBrowseRoute } from "./routing";
import type { UseFileBrowserPaneReturn } from "./types";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

export type WorkspaceViewerHandle = Pick<
  ReturnType<typeof useWorkspaceNavigation>,
  "openViewer" | "openSettings" | "closeSettings" | "backSettings"
>;

interface WorkspaceViewerProps {
  ref: Ref<WorkspaceViewerHandle>;
  connections: Connection[];
  services: BrowserContentServices;
  left: UseFileBrowserPaneReturn;
  right: UseFileBrowserPaneReturn;
  ready: boolean;
  onGuardChange: (guard: ViewerLeaveGuard | null) => void;
}

export function WorkspaceViewer({ ref, connections, services, left, right, ready, onGuardChange }: WorkspaceViewerProps) {
  const location = useLocation();
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
          connectionId={info.connectionId ?? pane.connectionId}
          isReadOnly={isConnectionReadOnly(connections.find((connection) => connection.id === (info.connectionId ?? pane.connectionId)))}
          isPending={workspace.viewerLoading || Boolean(workspace.viewerError)}
          viewInfo={info}
          navigation={{
            selectionKey: workspace.viewerSelectionKey,
            mode: route.viewer?.mode ?? "view",
            onModeChange: workspace.changeMode,
            onGuardChange,
          }}
          onClose={workspace.closeViewer}
          onIndexChange={(index) => workspace.changeImage(left.viewInfo ? "left" : "right", index)}
          hasMoreItems={info.virtualSource ? pane.archiveHasMore : false}
          isLoadingMoreItems={info.virtualSource ? pane.archiveLoadingMore : false}
          onLoadMoreItems={info.virtualSource ? pane.loadMoreArchive : undefined}
          contentProviders={services.providers}
        />
      )}
    </>
  );
}
