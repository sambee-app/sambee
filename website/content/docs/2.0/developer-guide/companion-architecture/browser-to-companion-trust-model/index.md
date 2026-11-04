+++
title = "Browser-to-Companion Trust Model"
+++

The browser-to-companion boundary is powerful because it crosses from the browser app into desktop-local capability. That makes it one of the most security-sensitive parts of Sambee.

## Two Distinct Trust Paths

Sambee uses two browser-to-companion interaction models.

### Deep-Link Editing Path

This path is used when the browser asks the companion to open an SMB-backed file in a native desktop app.

1. The browser asks the backend for a short-lived URI token.
1. The browser launches a `sambee://` deep link.
1. Companion exchanges the one-time token for a session token.
1. Companion downloads the file, acquires the edit lock, and later uploads the result.

Companion sends the URI token to the backend token endpoint in a JSON request body. Do not reintroduce query-string token exchange compatibility; deep-link tokens are sensitive and should not be exposed in URLs, logs, proxy access logs, or browser history.

The deep-link token is not a general browser-to-companion credential. It is a short-lived bootstrap value for one native-editing handoff.

### Localhost API Path

This path is used for local-drive access and related browser-to-desktop features.

1. the browser probes `http://localhost:21549/api/health`
1. browser and companion perform an explicit pairing flow for the current browser origin
1. the browser uses authenticated localhost requests for local-drive operations
1. the companion sends directory-change notifications over a paired WebSocket channel

## Why Pairing Exists

Localhost alone is not a trust boundary.

The companion therefore requires explicit pairing and per-request authentication so that:

- remote network clients cannot reach it
- arbitrary websites cannot use it just because they run in the browser
- local native processes do not gain the browser's paired privileges automatically

## Pairing Model

The pairing flow is deliberately shaped like numeric-comparison pairing, but the important trust decision is not just “do the codes match?” It is “does the user approve this exact browser origin on this computer?”

- the browser and companion exchange nonces
- both sides independently derive the same short pairing code
- the companion displays the exact requesting browser origin in a native approval window
- the user confirms the match in both places
- the companion returns a shared secret only after dual confirmation succeeds

That dual confirmation step is what turns “something can reach localhost” into “the user intentionally paired this browser origin with this desktop app.”

### Production and Development Origin Rules

In production, Companion does not rely on a preconfigured list of Sambee frontend URLs.

- any valid browser origin can request pairing
- Companion normalizes that exact origin and shows it to the user for local approval
- once approved, that exact origin becomes the paired browser origin for future authenticated localhost requests

For development, typical loopback browser origins such as `localhost`, `127.0.0.1`, and `::1` remain usable without manual per-port configuration.

This keeps development practical without weakening the production trust boundary into hostname heuristics or silent trust-on-first-use.

## Request Authentication after Pairing

After pairing, companion-bound requests use HMAC-based authentication rather than the server's bearer-token flow.

- localhost API requests carry an HMAC derived from the shared secret and a timestamp
- the companion rejects requests outside the allowed clock window
- pairing is tracked per browser origin, not as one global switch
- the shared secret is stored in OS-protected credential storage on the companion side

Browser-facing pairing state should also stay origin-scoped and typed.

Important browser-visible states include:

- unavailable
- unpaired
- pending local approval
- paired
- repair required because the browser-side secret is missing or unusable

That state model matters because local trust problems should surface as explicit recovery states rather than as a misleading generic “not paired” result.

## Pairing Management and Cancellation

Pairing management is intentionally narrower than routine local-drive access.

- the browser should only learn the status of its own current origin
- browser-visible paired-origin enumeration is not part of the browser contract
- browser-managed unpairing is limited to the current origin
- closing either pairing UI path should cancel the pending request explicitly

That last point is part of the trust model, not just a UX detail. A dismissed pairing window should not leave behind a stale approval request that can still be completed later by accident.

## Shared Settings Delivery

Successful pairing selects the authoritative server for theme, localization, and directory-index resource policy. Pairing again selects that origin again. Failed or cancelled pairing, authenticated status requests, reconnects, and background checks must not change authority. Both native and HTTP unpair paths use `PairingState`; removing the authoritative origin clears authority without selecting a replacement or resetting valid settings.

The version-1 protocol uses typed `theme`, `localization`, and `directory_index` sections. Theme contains only `id`, `mode`, and `primary.main`. Localization contains stored language and regional-locale preferences, including `browser`. The Companion resolves `browser` from its operating-system webview locale. Directory policy retains its server revision; user sections use SHA-256 digests of canonical payloads and include a user scope.

| Endpoint | Responsibility |
|---|---|
| `GET /api/admin/settings/companion` | Authenticated metadata and section markers; not restricted to administrators |
| `POST /api/admin/settings/companion/grants` | Issue a short-lived, single-use grant for selected sections |
| `POST /api/admin/settings/companion/grants/redeem` | Direct Companion retrieval of canonical server sections |
| Companion `GET /api/settings` | Authority and per-section status |
| Companion `POST /api/settings/challenge` | Authenticated challenge; no extra approval prompt |
| Companion `POST /api/settings/redeem` | Serialized retrieval and application through the paired authority |

The browser sends an opaque grant to Companion, not settings payloads. Grants bind origin, Companion ID, challenge, backend identity, user credentials, selected markers, and user-switch permission. Redemption rechecks active user status, credential version, and any issuing OIDC session, then rebuilds selected sections. Changed settings require a fresh grant. Capacity is limited globally and per user. Editing directory policy remains administrator-only.

`CompanionSettingsSync` owns browser synchronization independently of Settings visibility or role. It checks metadata every 30 seconds while visible, compares native markers, and requests a grant only for changed sections. Web Locks serialize work across tabs. Native serialization and marker comparisons make repeated delivery a no-op. Logout and disposal stop work; identity changes cancel stale responses. Pairing, login, and explicit preference changes can change user scope. Background checks and reconnects cannot switch the applied user.

Companion rechecks authority under its authority lock before committing settings. Directory revisions are ordered only within an origin and backend identity; a new authority or backend identity can start at a lower revision. Supplied sections are validated before application. Per-section failures preserve last valid values and must not report synchronization success. Settings failure is distinct from directory search or index health.

Existing pairings, indexes, and valid policy are retained. Migration selects a still-paired legacy policy binding, or a single legacy pairing. Several unordered legacy pairings require pairing the intended server again. Authority is persisted in the keychain. Old delivery endpoints return an update-required response, not manual policy approval. URI theme delivery is bootstrap-only and cannot override managed settings, including after unpairing.

## Trust Boundaries Contributors Must Preserve

- keep the companion bound to `127.0.0.1`
- do not relax CORS rules casually
- do not replace exact-origin approval with hostname heuristics or silent trust-on-first-use behavior
- keep browser-to-companion auth distinct from backend bearer-token auth
- preserve the server-side edit-lock lifecycle for SMB-backed editing instead of letting the companion bypass it
- keep reverse-proxy cookies distinct from Sambee bearer tokens and companion localhost pairing secrets
- redact deep-link tokens, sessions, cookies, authorization data, and other sensitive query values before logging

Reverse-proxy authentication is a separate trust path from localhost pairing. The companion may use cookies captured in its own backend-origin authentication webview for Rust-side backend requests, but it must not import cookies from the user's normal browser session.

## What Changes Are High Risk

- anything that alters token exchange or deep-link parsing
- anything that changes pairing confirmation rules
- anything that weakens HMAC validation, timestamp checking, or origin scoping
- anything that blurs the distinction between local-drive workflows and SMB-backed edit workflows

## Where the Main Logic Lives

| Path | Responsibility |
|---|---|
| `companion/src-tauri/src/server/auth.rs` | localhost API authentication |
| `companion/src-tauri/src/server/pairing.rs` | pairing flow and secret lifecycle |
| `companion/src-tauri/src/uri/` and `token/` | deep-link parsing and token exchange support |
| `frontend/src/services/companion.ts` | browser-side pairing and companion communication |
| `frontend/src/services/backendRouter.ts` | routes browser requests to backend or companion appropriately |

## Validation Expectations

When this trust model changes, do not validate only the companion.

Run at least:

```bash
cd companion && npx tsc --noEmit
cd companion && npm run lint
cd companion/src-tauri && cargo test
cd frontend && npm test
cd frontend && npx tsc --noEmit
```

If the change alters SMB edit flows, add the relevant backend checks too.
