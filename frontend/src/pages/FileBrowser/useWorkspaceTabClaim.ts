import { createContext, useEffect, useEffectEvent, useState } from "react";
import { authSession } from "../../services/authSession";
import type { BrowseRouteState } from "./routing";
import { claimWorkspaceTabs, type WorkspaceTabClaim } from "./workspaceTabStorage";

/** Undefined means there is no app owner; null means that its claim is pending. */
export const WorkspaceTabClaimContext = createContext<WorkspaceTabClaim | null | undefined>(undefined);

export function useWorkspaceTabClaim(route: BrowseRouteState, enabled: boolean, waitForAuth = false): WorkspaceTabClaim | null {
  const [claim, setClaim] = useState<WorkspaceTabClaim | null>(null);
  const currentRoute = useEffectEvent(() => route);

  useEffect(() => {
    if (!enabled) {
      setClaim(null);
      return;
    }
    const lifetime = new AbortController();
    const scope =
      waitForAuth && !authSession.isBootstrapComplete()
        ? authSession.bootstrap().then(() => authSession.getUserId())
        : authSession.getUserId();
    void claimWorkspaceTabs(scope, currentRoute(), lifetime.signal).then((result) => {
      if (!lifetime.signal.aborted) setClaim(result);
    });
    return () => lifetime.abort();
  }, [enabled, waitForAuth]);

  return claim;
}
