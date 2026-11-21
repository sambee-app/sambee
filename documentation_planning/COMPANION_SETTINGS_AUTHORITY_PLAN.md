# Companion Settings Authority Plan

## Purpose

This plan fixes a defect: Companion stops receiving theme, localization, and directory policy from a paired Sambee server. It also makes the current settings authority visible in Companion.

## Problem

### Symptoms (production)

- Browser language changes do not reach Companion.
- Companion shows a localization from 4 November 2026 (`en`, `de-DE`, source `https://files.wb28.helgeklein.de`) and the badge "Synced from browser".
- In the browser, **Settings > Local Drives** shows "Another server manages the settings" for all three sections.
- Restarting Companion does not help. Removing the second pairing (`http://localhost:3000`) does not help.

### Root cause

Companion accepts settings from exactly one origin, the **settings authority**. `PairingState` in `companion/src-tauri/src/server/pairing.rs` stores this origin in the OS keychain (`__settings_authority__`). Three code paths change it:

| Path | Current behavior | Problem |
| --- | --- | --- |
| `confirm` (line 360) | Sets the authority to the new origin. | Correct ("last pairing wins"). |
| `unpair` (line 433) | When the removed origin is the authority, sets the authority to `None`. | Remaining paired servers lose all settings delivery. |
| `migrate_settings_authority` (line 110), called at startup by `restore_managed` | Keeps a stored `null`. It selects a fallback only when the keychain has no entry. | A restart cannot repair a `null` authority. |

Sequence in production:

1. Companion is paired with prod. Prod is the authority.
2. `localhost:3000` is paired. It becomes the authority.
3. `localhost:3000` is unpaired. The authority becomes `None`.
4. Prod's `CompanionSettingsSynchronizer` sees `authoritative_origin !== window.location.origin`. It publishes `authority_conflict` and sets `blocked = true`. No grant is requested.
5. A restart reads `null` from the keychain and keeps it.

### Secondary defects

- **Misleading localization display.** Companion Preferences shows `browser-localization.json` (the last *applied* localization) with a static "Synced from browser" badge. It does not compare that data with the current authority or the delivery state. The displayed "Source origin" can be a server that is no longer the authority.
- **Stale authority display.** `DirectoryPolicyPreferences` loads `get_native_directory_policy_status` once on mount and on manual refresh. Pairing, unpairing, and settings delivery do not notify the window.
- **No recovery in the browser.** After `authority_conflict`, the synchronizer stays blocked until a page reload or a manual **Retry**. If the authority moves back to this server, the open tab does not resume delivery.

## Requirements

1. **Last pairing wins.** A successful pairing (new or repeated) makes that origin the authority.
2. **Unpair moves the authority back.** When the authority is unpaired and other paired origins remain, the **most recently paired remaining origin** becomes the authority. The authority is `None` only when no paired origin remains.
3. **Self-healing at startup.** A stored authority that is `null` or no longer paired is replaced by the same fallback rule.
4. **Correct display.** Companion always shows the current authority and the real delivery state. The display updates without reopening Preferences.
5. **Browser recovery.** A browser tab that had `authority_conflict` resumes delivery when its origin becomes the authority again.

## Design

### Authority selection rule

Use one pure function for all paths:

```rust
/// Most recently paired origin, excluding `removed`. `None` when no origin remains.
fn fallback_authority<'a>(paired_origins: &'a [String], removed: Option<&str>) -> Option<&'a str>
```

`paired_origins` is in pairing order (oldest first). The fallback is the last entry that is not `removed`.

To keep the order correct, `record_verified_origin(..., PairingCompleted)` moves an existing origin to the end of the list. Today it returns early when the origin is already present. Other reasons (`RecoveredFromAuthenticatedRequest`, and so on) keep the current order. They must not change the authority or the order.

### Pairing state changes (`pairing.rs`)

- `confirm`: no change to the authority rule. Apply the reorder above.
- `unpair(origin)`:
  1. Remove the origin from `paired_origins`. Persist the list.
  2. If `origin` was the authority, call `set_settings_authority(fallback_authority(&origins, None))`.
  3. Delete the secret.

  Change the order of the current steps so that the fallback uses the list after the removal. Keep the current error behavior: when the keychain write for the authority fails, return the error and do not leave a half-removed pairing. Compute the new list first, persist the authority, then commit the in-memory list and the keychain list.
- `migrate_settings_authority(legacy)`:
  - Stored value is a paired origin: keep it. The generation still increments.
  - Stored value is `null` or not paired: use `fallback_authority`.
  - No keychain entry: keep the legacy preference. Otherwise use `fallback_authority` (replaces the "exactly one origin" rule).
- Remove the `removed_origin` parameter from `set_settings_authority` if it is no longer needed. `unpair` decides whether the removed origin was the authority.

### Change notifications (Companion)

Add one Tauri event, `settings-status-changed`, with no payload. Emit it after:

- authority changes (pair confirm HTTP handler, `unpair_origin` command, HTTP `DELETE /api/pair/current`, startup migration),
- `redeem_settings` success or failure (`companion_settings_redeem` handler),
- `restore_managed` completion.

`PairingState` has no `AppHandle`. Emit the event at the call sites (handlers and commands), not inside `PairingState`. Put the event name in one shared constant (Rust) and one shared constant (TypeScript).

### Companion Preferences UI (`companion/src/components/Preferences.tsx`)

- Add a **Settings source** row at the top of the settings area. It shows `authoritative_origin` from `get_native_directory_policy_status`, or "No server" when it is `null`. Mark the matching entry in the **Paired browsers** list (for example, a "Manages settings" label).
- `DirectoryPolicyPreferences` and the localization section use one shared status hook (`useNativeSettingsStatus`). The hook loads on mount, on `settings-status-changed`, and on window focus.
- Replace the static "Synced from browser" badge with a badge that comes from the native status:
  - `synchronized`: localization result is `synchronized` and the applied origin equals the authority.
  - `waiting`: there is an authority, but the localization section is not synchronized from it.
  - `failed`: localization result is `delivery_failed`. Show the status message.
  - `none`: no authority.
- Rename the localization "Source origin" row to "Applied from". Do not show it as the authority.
- After unpair, reload the paired origins and the status from Companion. Do not only filter the local list.
- Add new strings to the English catalog. Run the existing catalog and fingerprint workflow for the other languages.

### Browser synchronizer (`frontend/src/services/companionSettingsSync.ts`)

- On `authority_conflict`, do not set `blocked = true`. Schedule the next check with `CHECK_INTERVAL_MS`. A status check is cheap and signed. It does not request a grant while the conflict remains.
- Keep `blocked` for `update_required` and `pairing_required`.
- Apply the same rule to the `settings_authority_conflict` error code in the `catch` block.
- No change to the message text. "Pair the intended server again" stays correct for the "last pairing wins" rule.

## Implementation steps

1. **Pairing logic (Companion, Rust)**
   - Add `fallback_authority` and unit tests: empty list, removed authority with one or more remaining origins, removed non-authority, order after a repeated pairing.
   - Update `record_verified_origin` (reorder for `PairingCompleted` only).
   - Update `unpair` and `migrate_settings_authority` as described.
   - Tests for `unpair` and migration: use `keyring::mock` (`keyring::set_default_credential_builder(keyring::mock::default_credential_builder())`) where a test must write the authority. Mock credentials do not persist across `Entry` instances. Test the read path of the migration through the pure function and `set_test_authority`.
2. **Notifications (Companion, Rust)**
   - Add the `settings-status-changed` constant and emit it at the call sites listed above.
3. **Companion UI**
   - Add `useNativeSettingsStatus`. Update `DirectoryPolicyPreferences`, the localization section, and the paired browsers list.
   - Update `Preferences.test.tsx`: authority display, live update on event, badge states, "Applied from" label, unpair reload.
4. **Browser synchronizer**
   - Change `authority_conflict` handling. Add tests to `companionSettingsSync.test.ts`: a conflict followed by a status that shows this origin as the authority leads to delivery without a reload.
5. **Documentation** (follow the `docs-update` skill)
   - `website/content/docs/2.0/developer-guide/companion-architecture/browser-to-companion-trust-model/index.md`, section "Shared Settings Delivery", is inherited by 3.0. It now says that unpairing "clears authority without selecting a replacement". Add a 3.0 version of the page that describes the fallback rule, the startup repair, and the browser recovery. Do not change the 2.0 behavior description.
   - Check the 3.0 localization page (`localization-and-locale-behavior`, line 119) and the admin directory-search page for statements about authority.
   - Add an entry to the 3.0 "What's new" page.
6. **Validation**
   - `cargo test` for `pairing` and `directory_policy` in `companion/src-tauri`.
   - Companion and frontend unit tests for the changed files. Lint and type-check.
   - Manual test on the host Companion: pair prod, pair `localhost:3000` (authority moves), unpair `localhost:3000` (authority moves back to prod, prod tab resumes in ≤30 s, language reaches Companion), restart Companion (authority stays).

## Upgrade of affected installations

Installations with a stored `null` authority repair themselves at the first start of the fixed Companion (step 1, migration). Until users update, the workaround is: unpair the intended server in Companion, then pair it again from the browser.

## Out of scope

- Selecting the authority manually in Companion (for example, a "Use this server for settings" action). Requirement 2 makes this unnecessary for now.
- Changes to the backend grant protocol.
