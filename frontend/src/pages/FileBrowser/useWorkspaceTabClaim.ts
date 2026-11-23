import { createContext, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { authSession } from "../../services/authSession";
import type { BrowseRouteState } from "./routing";
import { claimWorkspaceTabs, type WorkspaceTabClaim } from "./workspaceTabStorage";

/** Undefined means there is no app owner; null means that its claim is pending. */
export const WorkspaceTabClaimContext = createContext<WorkspaceTabClaim | null | undefined>(undefined);

const subscribeToUser = (notify: () => void) => authSession.subscribeToIdentity(notify);
const getUser = () => authSession.getUserId();

export function useWorkspaceTabUserScope(): string | null {
  return useSyncExternalStore(subscribeToUser, getUser);
}

export function useWorkspaceTabClaim(route: BrowseRouteState, shouldStart: boolean, waitForAuth = false): WorkspaceTabClaim | null {
  const userScope = useWorkspaceTabUserScope();
  const [claimed, setClaimed] = useState<{ userScope: string | null; claim: WorkspaceTabClaim } | null>(null);
  const [started, setStarted] = useState(shouldStart);
  if (shouldStart && !started) setStarted(true);
  const currentRoute = useEffectEvent(() => route);

  useEffect(() => {
    if (!started) return;
    const lifetime = new AbortController();
    setClaimed(null);
    const scope =
      waitForAuth && !authSession.isBootstrapComplete()
        ? authSession.bootstrap().then(() => {
            if (userScope !== authSession.getUserId()) lifetime.abort();
            return userScope;
          })
        : userScope;
    void claimWorkspaceTabs(scope, currentRoute(), lifetime.signal).then((result) => {
      if (!lifetime.signal.aborted && userScope === authSession.getUserId()) setClaimed({ userScope, claim: result });
    });
    return () => lifetime.abort();
  }, [started, userScope, waitForAuth]);

  return claimed?.userScope === userScope ? claimed.claim : null;
}
