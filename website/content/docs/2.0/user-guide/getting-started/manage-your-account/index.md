+++
title = "Manage Your Account"
+++

Open **Settings** > **Account** to review the identity Sambee uses for your current sign-in, including your username, optional name and email, and assigned role.

## Sign In With A Local Password

Usernames aren't case-sensitive: `Testuser` and `testuser` sign in to the same account. Leading and trailing username whitespace is ignored. Passwords remain case-sensitive and aren't trimmed. Use **Show password** beside the password field to reveal what you've entered, and **Hide password** to conceal it again.

If an older installation already contains accounts whose usernames differ only by case, those accounts temporarily require their exact username spelling. Ask an administrator to resolve the conflicting names. Once the conflict is resolved, capitalization no longer matters.

## Sign Out

Select **Sign out** next to **This browser** in **Sessions** to return to the sign-in page. For OIDC, this also revokes the current OIDC browser session. For a password sign-in, Sambee clears the current browser's local access token; password sessions are not stored as server-side browser sessions.

## Change a Local Password

The **Password** section appears when local password sign-in is configured and your account has a local password. It remains available when runtime authentication enforcement is temporarily bypassed. Enter your current password, then enter and confirm a new password. Sambee signs out the current browser after a successful change; sign in again with the new password.

When your organization uses **OIDC only**, the Password section is unavailable because local passwords cannot be used to sign in.

## Manage Sessions

The **Sessions** section separates **This browser** from **Other sessions**. It always shows the current browser when authentication is enforced. A password sign-in can show its sign-in type, but it has no server-side session ID, browser label, sign-in time, or activity history.

Other sessions are active OIDC browser sessions. They show when each session was created and last active. For newly created sessions, Sambee can also show a coarse browser and operating-system label, such as **Firefox on Linux**. These labels do not identify a device or host, and older sessions might not have one.

- Select **Sign out** next to the current browser to revoke its OIDC browser session and return to the sign-in page.
- Select **Revoke** to end another browser session.

Revoking a browser session immediately invalidates its Sambee API tokens. It does not sign the user out of the identity provider itself. See [OpenID Connect Authentication Operations](../../../admin-guide/authentication/openid-connect-authentication-operations/) for session lifecycle details.

When authentication is not enforced, Sambee cannot identify or end a browser session. The **Sessions** section shows this status without a session entry or sign-out action.
