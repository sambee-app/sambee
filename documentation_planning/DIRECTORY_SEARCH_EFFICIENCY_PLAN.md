# Directory Search Efficiency Plan

This plan removes unnecessary full verification passes of the directory index and reduces polling and log noise in the quick bar. It covers three changes:

- **A** – Keep healthy change monitoring active after the quick bar becomes idle.
- **D** – Poll a lightweight status endpoint during scans, and run the search query again only when the index changes.
- **E** – Log expected startup invalidations at DEBUG level.

All changes apply to both backends: SMB (Python backend) and local drives (Rust Companion).

## Problem Summary

| Symptom | Cause |
| --- | --- |
| Full pass over all directories on almost every Ctrl+K after a pause of 10 minutes or more | A source is released after `idle_release_seconds` (600 s). Release stops the watcher. Reopen always runs a full pass, because changes made while the source was closed were not observed. |
| Hundreds of identical `search_directories` DEBUG lines | During a scan, the frontend polls every 500 ms (`DIRECTORY_REFRESH_INTERVAL_MS`), and each poll runs the full FTS query again. |
| Two `directory_scan_invalidated` INFO lines at each start | `lifecycle` (storage open) and `watcher_start` are both logged at INFO level. They are expected steps, not problems. |

Relevant code:

- Backend: `release_idle_caches`, `can_release_idle`, `_initialize`, `_run_rescan`, `_periodic_rescan_loop`, `DirectoryScanCoordinator.invalidate` in `backend/app/services/directory_cache.py`
- Companion: `LocalDirectoryManager::tick`, `LocalSource::close_idle`, `verification_due`, `invalidate_for` in `companion/src-tauri/src/server/directory_manager.rs`
- Frontend: `getRefreshIntervalMs`, `fetchResults` in `frontend/src/components/FileBrowser/search/useDirectorySearchProvider.tsx`
- Contract: `shared/directory-index/contract.json`

## A – Keep Healthy Monitoring Active While Idle

### Target Behavior

A source has three lifecycle stages:

| Stage | Entry condition | Resources |
| --- | --- | --- |
| Active | Search access within `idle_release_seconds` | All resources |
| Dormant (new) | No search access for `idle_release_seconds`, **and** monitoring is healthy | Watcher, writer, and reconciliation stay active. SQLite memory is reduced. |
| Released | See release rules below | All resources are closed (current idle-release behavior) |

The source is released when one of these conditions is true:

1. Monitoring is not healthy (`monitoring_state != "healthy"`, `verification_required`, watcher failure, or a Companion volume with limited monitoring). Keeping such a source would only cause degraded-interval verification of an unused source.
2. The time since the last access is longer than the new policy value `monitoring_retention_seconds`.
3. A full verification comes due while the source is dormant. Do not start a full pass for an unused source. Release it instead. The next access runs the pass.
4. The number of dormant sources is more than the new limit `max_dormant_sources`. Release the least recently accessed dormant sources first.
5. All of the existing release preconditions are satisfied: no active workers, no running or pending scan, no active queries, and no pending observations.

Reopening a dormant source requires no full pass: the source never stopped observing, and `_next_full_pass_at`, `verified_at`, and the watcher state remain in memory. A process restart still requires a full pass. This is not changed.

### Contract and Policy

1. In `shared/directory-index/contract.json`:
   - Add the policy field `monitoring_retention_seconds`:
     - label: "Idle change-monitoring retention"
     - description: "How long an unused source keeps healthy change monitoring active. This avoids a full verification pass when search is used again. Each retained source uses one monitoring connection."
     - default: `86400`, minimum: `600`, maximum: `2592000`, step: `60`
   - Add the limit `max_dormant_sources`: `8`.
   - Keep `idle_release_seconds` (600). It now means "active to dormant, or release when monitoring is not healthy".
2. In `backend/app/core/directory_index_contract.py`, add the field to `POLICY_FIELDS` and the limit to `LIMIT_FIELDS`. Add a validation rule: `monitoring_retention_seconds.minimum >= idle_release_seconds`.
3. In `backend/app/models/system_settings.py` (`DirectoryIndexPolicy`), add the field with contract bounds, and add it to the ordered field list.
4. In `backend/app/core/system_setting_definitions.py`, add the backend and Companion keys. The definitions are generated from `POLICY_FIELDS`.
5. In `frontend/src/types/index.ts`, add the field to `DIRECTORY_INDEX_POLICY_FIELDS`. `DirectorySearchSettings.tsx` renders fields generically. Before you change it, read the settings form dialog pattern document.
6. In the Companion `DirectoryPolicy` (`directory_manager.rs`), add the field, its parsing, and its validation.

### Backend (SMB)

1. **Dormant transition.** In `SQLiteConnectionDirectoryCache`, add a `_dormant` flag and a `_dormant_since` timestamp. In `DirectoryCacheManager.release_idle_caches`, split the current check:
   - `can_go_dormant()`: idle for `idle_release_seconds`, monitoring healthy, and no work pending. On entry, call a new `DirectoryIndex.release_memory()`. It runs `PRAGMA shrink_memory` on idle connections while maintenance is not blocked.
   - `should_release()`: the release rules 1–5 above.
2. **Touch.** `touch()` clears `_dormant`. Search requests already call `touch()` through `get_or_create_cache`. Keep the current rule that listing hints do not touch the source.
3. **Periodic loop.** In `_periodic_rescan_loop`, if the source is dormant and `_verification_due(verified_at)` is true, do not call `_run_rescan`. Mark the source for release so the manager releases it on the next tick. Reconciliation of watcher events continues while dormant.
4. **Watcher loss while dormant.** `_observation_lost` makes monitoring unhealthy. Release rule 1 then releases the source. No change is required other than evaluating rule 1 during the dormant state.
5. **Cap.** Sort dormant sources by `_last_access` and release the oldest ones beyond `max_dormant_sources`.
6. **Reopen.** `get_or_create_cache` returns the existing dormant instance, so no full pass starts. Make sure that `start_scan()` does not reinitialize an open, dormant source. The existing `_scan_task` guard covers this after initialization completes. Add a test for it.
7. **Credentials and policy changes.** Do not change the current behavior: replacement creates a new instance with a full pass, and `apply_policy` updates retained instances.

### Companion (Local Drives)

1. In `LocalDirectoryManager::tick`, change the `retain` predicate to use the same rules as the backend. "Healthy" means: `watcher` is present, `watcher_failed` is false, `verification_required` is false, and `volume.monitoring_reliable()` is true.
2. Add a dormant flag to the `LocalSource` status. On dormant entry, call `DirectoryIndex::release_memory()` (`PRAGMA shrink_memory`). **Do not** drop `reader` or `root`: `start_scan_if_cold` treats a missing reader or root as a cold source and starts a scan.
3. In `tick`, if a dormant source is due for verification, release it through `close_idle` instead of calling `start_scan`.
4. `touch()` clears the dormant flag.
5. Removable media: keep the current behavior. A removal notification releases handles and pauses the source.

### Edge Cases

| Case | Handling |
| --- | --- |
| Watcher fails while dormant | Monitoring becomes unhealthy, and the next tick releases the source. The next access runs a full pass (current behavior). |
| Event overflow while dormant | Same as watcher failure (`observation_loss`). |
| Many connections or drives | `max_dormant_sources` limits retained SMB sessions and threads. |
| Policy change lowers `monitoring_retention_seconds` | Apply on the next tick. Sources beyond the new limit are released. |
| Disk-budget pressure | Existing reclamation applies to dormant sources, because their storage stays registered. |
| Shutdown | `stop_all` and `stop_all_async` stop dormant sources like active ones. |
| Connection deleted or edited | `remove_cache` and replacement behave as before. |

## D – Lightweight Status Polling

### API

1. **Backend:** Add `GET /api/browse/{connection_id}/directories/status`. It returns the status fields of `DirectorySearchResult` without results: `cache_state`, `directory_count`, `search_contract_version`, `accepted_revision`, `coverage`, `coverage_issue_count`, `issue_details_available`, `status_message`, `monitoring_state`, `retry_after_ms`, and `scan_progress`.
   - Use `get_cache` (not `get_or_create_cache`). If no source exists, return `cache_state: "empty"` so that the client falls back to a normal search.
   - Call `touch()`, because the quick bar is open.
   - Get the values from `index.status()` and the cache properties. Run no FTS query.
   - Extract a shared helper that builds the status part, so that this endpoint and `search_directories` use the same code.
2. **Companion:** Add `GET /api/browse/{drive}/directories/status` with the same response shape, in `server/mod.rs` and `handlers`.
3. **Frontend service:** Add `getDirectorySearchStatus(connectionId, { signal })` to `api.ts` and `browserHistoryService.ts`.
4. Add a response type `DirectorySearchStatus` to `frontend/src/types/index.ts`. Make `DirectorySearchResult` extend it.

### Frontend Polling

In `useDirectorySearchProvider.tsx`:

1. Add the constant `DIRECTORY_STATUS_INTERVAL_MS = 1_000` and use it for scan progress polling. Keep `DIRECTORY_RECOVERY_INTERVAL_MS` and the retry rules.
2. The refresh path calls the status endpoint first. Run the full search again only if one of these conditions is true:
   - `accepted_revision` changed since the last search response, **and** at least `DIRECTORY_RESULT_REFRESH_MIN_MS = 2_000` has passed since the last search, or the scan phase changed to `idle`. The final results must always appear.
   - The status response is `cache_state: "empty"` (the source was released). Then run a normal search, which reopens the source.
   - The query changed. The normal debounced path handles this.
3. Update `updateIndexStatus` from the status response so that the progress label continues to update.
4. Keep the abort and generation guards for both request types.

Result: during a pass, about one status request per second, and a search request only when committed results change, at most once every 2 seconds.

### Log Noise

The `OperationSummaryMiddleware` DEBUG line stays for each request. The operation name of the new endpoint (`directory_search_status`) is different, so polls are easy to filter. The number of requests decreases by approximately 50 % or more.

## E – Log Levels for Expected Invalidations

1. **Backend:** In `DirectoryScanCoordinator.invalidate`, log at DEBUG level when `reason` is `LIFECYCLE` or `WATCHER_START`. Keep INFO for `OBSERVATION_LOSS`, `SOURCE_REBIND`, `READ_CAPACITY`, and `STALLED_READ`. Use a module-level frozenset `EXPECTED_INVALIDATION_REASONS`, not inline checks.
2. **Companion:** In `invalidate_for`, apply the same rule with `log::debug!` and `log::info!`. Put the reason classification in a method `InvalidationReason::is_expected()`, next to `loses_observations()`.
3. Do not change `Directory watcher started` (INFO) and `Directory watcher connected` (DEBUG). They are two steps of one start.

## Tests

### Backend (`backend/tests/test_directory_index_contract.py`)

- A healthy source idle for more than `idle_release_seconds` becomes dormant and is not released.
- Reopening a dormant source starts no full pass (`_scan_disk_queue` is not called).
- An unhealthy source is released after `idle_release_seconds`.
- A dormant source with verification due is released, not scanned.
- A source idle for more than `monitoring_retention_seconds` is released.
- The `max_dormant_sources` cap releases the oldest dormant sources first.
- Watcher events while dormant are reconciled.
- Update the existing idle-release tests that set `_last_access` back by `idle_release_seconds` so that they make monitoring unhealthy or exceed retention.
- Status endpoint: returns status without results, returns `empty` for a missing source, does not create a source, and calls `touch()`.
- `invalidate` logs `lifecycle` and `watcher_start` at DEBUG and `observation_loss` at INFO.
- `test_system_settings.py`: the new policy field and its bounds.

### Companion (`directory_manager.rs` tests)

- The same lifecycle cases as the backend, including `listing_weak_targets_do_not_prevent_idle_cleanup` and `idle_query_preserves_reads_without_bypassing_retry_or_root_revalidation`.
- A dormant source keeps `reader` and `root`. `start_scan_if_cold` starts no scan.
- Status route response shape.

### Frontend

- `useDirectorySearchProvider` tests: during a scan, the hook polls the status endpoint; it runs the search again only after a revision change and the minimum interval; it always runs a final search when the phase becomes `idle`; and it falls back to a search on `empty`.
- `DirectorySearchSettings.test.tsx`: the new field renders.

### Commands

- `cd backend && pytest tests/test_directory_index_contract.py tests/test_system_settings.py`
- `cd companion/src-tauri && cargo test directory_manager`
- `cd frontend && npx vitest run src/components/FileBrowser/search src/pages/__tests__/DirectorySearchSettings.test.tsx`

## Documentation

Follow the `docs-update` skill. Update:

- `developer-guide/backend-architecture/smb-change-notification-and-directory-freshness`: lifecycle stages, release rules, removal of the statement that "reopening after idle release still requires a full pass", the status endpoint, and the log levels.
- `developer-guide/companion-architecture/local-drive-and-save-back-pipeline`: the same lifecycle rules for local drives.
- `admin-guide/operations-and-maintenance/manage-directory-search`: the new setting "Idle change-monitoring retention" and its resource cost (one monitoring connection per retained source).
- `user-guide/find-and-browse-files/smart-navigation-and-the-quick-bar`: only if it describes when updates run.
- `release-info/news-and-changes/whats-new`: a short entry.

## Implementation Order

1. E: small and independent.
2. Contract and policy plumbing for A (all layers), with settings tests.
3. A in the backend, with tests.
4. A in the Companion, with tests.
5. D: endpoints in both backends, then frontend polling, with tests.
6. Documentation.

## Risks

- **Resource use:** Each dormant SMB source holds one watcher session and one thread. `max_dormant_sources` and the retention policy limit this.
- **Missed changes:** A dormant source relies on the watcher only. This is the same guarantee as an active source with healthy monitoring, and the healthy verification interval still applies, because a due verification releases the source.
- **Status and result skew:** The status can show a newer revision than the displayed results for up to 2 seconds. This is acceptable for progress display. The final search at phase `idle` makes sure that the final results appear.
