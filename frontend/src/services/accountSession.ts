import { authSession } from "./authSession";
import { clearBrowserRecoverySnapshot } from "./browserRecoverySnapshot";
import { clearCurrentUserDrafts } from "./draftRecovery";
import { OIDC_ATTEMPT_MARKER, OIDC_LOGOUT_MARKER, OIDC_RETURN_PATH_MARKER } from "./oidcAuth";

export function clearCurrentBrowserSession(): void {
  clearBrowserRecoverySnapshot();
  clearCurrentUserDrafts();
  authSession.clear();
  sessionStorage.removeItem(OIDC_ATTEMPT_MARKER);
  sessionStorage.removeItem(OIDC_RETURN_PATH_MARKER);
  sessionStorage.setItem(OIDC_LOGOUT_MARKER, "1");
}

export async function signOutCurrentBrowser(): Promise<void> {
  clearCurrentBrowserSession();
  await authSession.logout();
}
