+++
title = "OpenID Connect Authentication Operations"
+++

Use this guide to manage OIDC sessions, account mappings, and audit records after completing [OpenID Connect Authentication Setup](../openid-connect-authentication-setup/).

## Session Lifecycle

When a provider returns a refresh token, Sambee stores it encrypted on the server. If the provider returns none, Sambee stores no provider token. In both cases, the browser holds only a short-lived API token in memory and an `HttpOnly` session cookie. Reloading the page can obtain a new API token from that cookie without exposing provider tokens to browser storage, URLs, logs, or API responses.

Sambee renews the API token in the background while the session remains valid. A session with a refresh token is limited by the configured interactive sign-in interval (default 30 days from the verified IdP authentication). A session without a refresh token has a fixed limit of 8 hours from the callback by default, configurable from 1 to 24 hours. Neither local activity nor API-token renewal extends that deadline; the earlier applicable deadline always wins. Reducing the no-refresh limit permanently shortens existing sessions, including pending sign-ins.

A new top-level authorization is required when the applicable deadline ends, the identity provider rejects or revokes a refresh token, a refresh result is uncertain, an access policy changes, or the browser session is revoked. The IdP might use its SSO cookie to return quickly, but this is not guaranteed. Sambee returns the user to the same safe route after sign-in. Registered text and Markdown drafts are snapshotted before an authentication redirect when storage is available; other unsaved work might be interrupted. See [Recover Unsaved In-Browser Edits](../../../user-guide/viewing-and-editing-files/recover-unsaved-edits/) for limitations and recovery behavior.

## Manage OIDC Sessions

Users can open **Settings** > **Account** to review their current session and other active OIDC browser sessions. The page separates **This browser** from **Other sessions**. For a local password sign-in, the current entry is not a persistent server-side browser session. For an OIDC sign-in, Sambee shows when each session was created and last active. Newly created OIDC sessions can also show a coarse browser and operating-system label without exposing a device fingerprint or token details. Existing sessions might not have a label. See [Manage Your Account](../../../user-guide/getting-started/manage-your-account/) for the user-facing controls.

- Select **Sign out** next to the current browser to revoke its session and return to the sign-in page.
- Select **Revoke** to end another browser session.

Revocation immediately invalidates API tokens issued for the affected browser sessions. It does not sign the user out of the identity provider itself.

## Manage Account Mappings

Open **Settings** > **Administration** > **Users** to review how each local account authenticates. An account can show **Local password**, **OIDC linked**, or both. Established mappings show the provider name and most recent OIDC sign-in. With automatic username linking enabled, an admitted IdP user with the same username automatically links to that local account or updates its existing OIDC link. A pending mapping shows the provider username that must complete the first admitted OIDC sign-in, who created the mapping, and when.

In **OIDC only** mode, Sambee creates a passwordless account automatically when an admitted identity signs in for the first time. User Management does not offer manual user creation or local-password resets in this mode. Existing accounts can still be reviewed and mapped when an administrator needs to resolve an identity collision or apply an individual OIDC role before the first sign-in.

### Assign Individual Roles

For a linked or pending account, set **OIDC role assignment** to **Administrator**, **Editor**, or **Viewer** to create an individual override. Select **Use configured role assignment** to apply the provider's uniform or group-based policy instead. Individual assignments take precedence over the configured policy and work without a groups claim unless selected-group admission requires one.

### Change Mappings

Administrators can map an unlinked local account to an expected provider username, cancel a pending mapping, or change a linked account to a different provider username. Changing a linked username removes the established identity and creates a pending mapping.

Use **Advanced OIDC actions** to view the stored identity properties, including issuer, subject, last-seen provider username, and verified group snapshot. You can also move an established identity to another active, unlinked local account or detach it from a local account. Changing, moving, or detaching an established identity revokes affected Sambee sessions. Detaching does not revoke access at the identity provider; remove provider admission separately when the person must no longer sign in.

Mapping updates are atomic and revision checked. If another administrator changes mappings while the page is open, Sambee rejects the stale update; reload the users page and review the current state. In **OIDC only** mode, Sambee prevents removal of the last active OIDC administrator mapping.

Deleting a local user also removes their established identity, pending mappings targeting that user, and incomplete OIDC flows in the same transaction. Pending mappings that the deleted user created for other accounts remain active and show **Deleted user** as their creator. Deletion remains subject to the last-administrator guard.

## Require A Local Password Change

When creating a local user or resetting an existing local password, enable **Require change on next password sign-in** to require a new password before the user can continue. The user directory shows **Pwd change req'd** while this requirement is pending.

After signing in with the temporary or existing local password, the user must enter that password, choose a different password, and confirm it. They can sign out instead, but can't browse files, use administration settings, or issue companion credentials until the change succeeds. Successful changes invalidate existing Sambee tokens and require another sign-in.

The requirement applies only to local-password sessions. A linked user can still sign in through OIDC; that doesn't clear the local-password requirement or change the identity provider's password. Passwordless OIDC accounts have no local password to reset. In **OIDC only** mode, local password changes are unavailable.

Existing password-change flags are enforced after upgrading. They aren't cleared automatically. If a user can't complete the change, an administrator can set another local password through User Management. Switch the requirement off during that reset only when the replacement password is intended to be permanent. Authentication-disabled mode doesn't enforce the change workflow.

## Audit Events

OIDC configuration, identity events, and successful local password changes and resets are stored in the Sambee database. They do not contain passwords, raw subjects, provider tokens, client secrets, authorization codes, nonces, verifiers, or one-time login grants. Events are retained until the database is removed or an external retention process deletes them.

Export the complete audit stream as JSON Lines:

```bash
cd backend
python -m app.oidc_admin export-audit --output sambee-audit.jsonl
```

## Authentication Request Limits

Sambee enforces authentication limits in the application. A reverse proxy can add stricter limits but does not replace these defaults:

| Request | Default limit |
|---|---|
| Start OIDC authorization | 20 requests per source IP per 5 minutes |
| Process OIDC callback | 60 requests per source IP per 5 minutes |
| Exchange OIDC login grant | 30 requests per source IP per 5 minutes |
| Password sign-in | 10 attempts per source IP per 5 minutes and 10 attempts per submitted username per 15 minutes |

Limits refill continuously. A rejected API request returns `Retry-After`; browser-based OIDC requests return to the sign-in page with a generic retry message. Password forms larger than 64 KiB are rejected before parsing. These responses do not expose account existence, the active sign-in mode, provider payloads, or submitted credentials.
