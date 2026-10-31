+++
title = "Manage Your Account"
+++

Open **Settings** > **Account** to review the identity Sambee uses for your current sign-in, including your username, optional name and email, and assigned role.

## Sign In With A Local Password

Usernames aren't case-sensitive: `Testuser` and `testuser` sign in to the same account. Leading and trailing username whitespace is ignored. Passwords remain case-sensitive and aren't trimmed.

If an older installation already contains accounts whose usernames differ only by case, those accounts temporarily require their exact username spelling. Ask an administrator to resolve the conflicting names. Once the conflict is resolved, capitalization no longer matters.

## Sign Out

Select **Sign out** next to **This browser** in **Sessions** to return to the sign-in page. For OIDC, this also revokes the current OIDC browser session. For a password sign-in, Sambee clears the current browser's local access token; password sessions are not stored as server-side browser sessions.

## Change a Local Password

The **Password** section appears when local password sign-in is configured and your account has a local password. Sambee signs out this browser after a successful password change; sign in again with the new password.

When your organization uses **OIDC only**, the Password section is unavailable because local passwords cannot be used to sign in.

## Manage Sessions

**Sessions** separates **This browser** from **Other sessions**. Password sign-in has no server-side browser-session list; other sessions are OIDC browser sessions.

OIDC sessions show their creation and last-active times. Browser labels such as **Firefox on Linux** help you distinguish sessions, but do not uniquely identify a device. Older sessions may have no label.

Use **Revoke** to end another OIDC browser session.

Revoking a browser session immediately invalidates its Sambee API tokens. It does not sign the user out of the identity provider itself. See [OpenID Connect Authentication Operations](../../../admin-guide/authentication/openid-connect-authentication-operations/) for session lifecycle details.

When authentication is not enforced, Sambee cannot identify or end a browser session. The **Sessions** section shows this status without a session entry or sign-out action.
