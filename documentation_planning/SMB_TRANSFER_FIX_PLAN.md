# SMB Transfer Fix Proposal

Status: Implemented with automated regression coverage. Real-server validation and reproduction of the original sibling-directory nesting report remain pending.

## Scope and Evidence

Fix regular-file transfers between different SMB connections and the shared SMB replacement primitive. Preserve staged publication, identity-bound source deletion, existing conflict policies, and bounded-memory streaming. Do not introduce a new transfer engine or dependencies.

Confirmed findings:

- `backend/app/storage/smb.py`: move sources use `buffering=0`, returning `SMBFileIO`, but deletion accesses a nonexistent `.raw` wrapper. The permissive test mock hides this mismatch.
- The retained source permits concurrent writers and renames (`share_access="rwd"`). An in-memory reproduction updated the source after final validation, then deleted those uncopied bytes. This becomes a data-loss risk when the handle bug is fixed.
- Staged replacement and same-connection moves use `smbclient.renames`; the installed library sends `replace_if_exists=False`. Authorized replacement requires `smbclient.replace`.
- Cancellation after destination publication raises a pre-publication cancellation exception; the API incorrectly reports both locations unchanged.
- Every deletion exception becomes `outcome_unknown`. Known destination publication and replacement facts are discarded, and the result validator prevents expressing source-only uncertainty.

Unresolved: two directories selected together and moved once with F6 reportedly become nested. Isolated sibling-tree execution between distinct SMB connections preserved both roots. Do not claim a cause or rewrite traversal without a failing batch-level reproduction.

## Proposed Changes

### 1. Protect and Delete the Retained Source

- Treat the unbuffered SMB handle as the raw handle and access its `.fd` directly, using a suitably constrained type instead of a permissive wrapper assumption.
- Hold a source handle that denies other writers and renames/deletions from opening through publication and deletion. Reject an incompatible existing writer before copying. Verify that the opened object's identity and metadata match the captured source; path-only checks are insufficient.
- Keep deletion bound to that exact handle. Never fall back to deleting by path or deleting before destination publication.
- Classify failures at the provider boundary: a definite pre-dispatch failure or explicit server rejection means source retained; lost acknowledgement, timeout, or uncertain close after delete-pending means source outcome unknown. Do not classify all `OSError` instances alike.
- Close the handle and release its lease exactly once on every path. Preserve the primary transfer/deletion failure when cleanup also fails; log cleanup failures without falsely claiming successful deletion.
- Executor work can continue after timeout/cancellation. Dispose handles returned by late opens, and schedule close only after in-flight handle work settles; retain the lease until cleanup finishes without waiting indefinitely in the HTTP request.
- Deliver source protection and the handle correction together, so fixing `.raw` does not enable the concurrent-update deletion risk.

### 2. Correct Replacement

Use `smbclient.replace` for authorized regular-file replacement in both staged publication and same-connection moves; keep `rename` for exclusive, non-replacing publication. Retain final target-policy validation, directory-conflict rejection, timestamp preservation, and stage cleanup. Never remove the visible target first.

### 3. Preserve Factual Outcomes

Reuse existing status names; make only the contract changes needed to retain confirmed effects and replacement facts. This table describes individual files; directory aggregation is defined below.

| Situation | Result | Source / Destination Effects |
| --- | --- | --- |
| Cancelled before publication | `cancelled` | unchanged / unchanged |
| Cancelled after publication, before deletion | `completed_with_source_retained` | unchanged / mutated |
| Definite deletion rejection | `completed_with_source_retained` | unchanged / mutated |
| Deletion completion cannot be confirmed | `outcome_unknown` | unknown / mutated |
| Publication itself cannot be confirmed | `outcome_unknown` | unchanged or unknown / unknown |
| Copy source validation fails after confirmed publication | `failed` (`source_changed`) | unchanged / mutated |
| Confirmed publication and deletion | `completed` | mutated / mutated |

- Preserve the actual `replaced` value after confirmed publication, including late cancellation, uncertain source deletion, and post-publication copy validation failure. Carry it through `SourceChangedError` and both API mappings; permit it on `failed` results when destination mutation is confirmed. Do not infer publication or replacement from a refreshed pathname alone.
- Use the existing `source_delete_failed` detail for retained-source results, with explicit wording for late cancellation. Keep the destination and do not automatically repeat an uncertain move.
- Wire cancellation into both direct and durable moves, checking again after publication and immediately before delete dispatch. Once deletion has been dispatched, cancellation cannot promise retention: report confirmed completion or uncertainty from the deletion result instead.
- Update `backend/app/models/file.py`, the exception-to-result mappings in both direct and durable API paths, and `frontend/src/services/storageContracts.ts` together. Audit result readers, receipt serialization/replay, frontend recovery, and companion compatibility; retain support for existing conservative unknown results.
- Aggregate each directory side as `mutated` if any mutation is confirmed, otherwise `unknown` if any child is uncertain, otherwise `unchanged`. These effects record whether any mutation is known, not whether every child outcome is resolved. Preserve a stopping child's `failed`, `cancelled`, or `outcome_unknown` status independently of those effects; do not return that child's effects unchanged.
- A finished tree with retained entries reports `completed_with_source_retained`; its source may be `mutated` when other children moved, and its destination may be unchanged when all entries were skipped. Tree `replaced` means any child replacement is confirmed. Permit these aggregate combinations in the shared contract; `skipped` alone always requires unchanged effects and `replaced=false`.
- Refresh affected locations and update destination caches after known publication, even when deletion fails.
- Log actionable, credential-free context: connection IDs, source/destination paths, failure phase, and confirmed effects. UI notices must distinguish a retained source from uncertainty and must not offer a misleading retry.

### 4. Investigate Sibling Directory Nesting

- Add a regression through the actual file-browser multi-selection/F6 confirmation path, not merely two direct calls to `executeTransferTree`.
- Select two sibling directories on one SMB connection and capture create, transfer, and cleanup requests for a different SMB connection. Assert both destination roots share the originally captured parent, including when the first tree contains nested directories.
- Exercise destination refresh/rerender during the first transfer, conflicts with apply-to-all, and a retained/unknown child result. Later work must retain the original destination or stop according to the outcome; it must never inherit a previous tree's destination.
- If the reported nesting still cannot be reproduced, retain the open TODO and capture correlated operation/attempt IDs, both connection IDs, and request paths during a controlled reproduction. Fix the first demonstrated path divergence only.

## Implementation and Verification

1. Add failing regressions in existing suites, then implement protected handle deletion and replacement. Test with a strict unbuffered-handle fake or the real library interface; assert no `.raw` access and the actual replacement primitive.
2. Implement factual outcomes and caller handling together. Cover definite permission rejection, lost deletion acknowledgement, close failure, pre/post-publication and post-delete-dispatch cancellation in direct and durable paths, replacement followed by source-validation failure, and receipt replay. Verify the destination survives all post-publication failures and source deletion is never retried blindly.
3. Add source-identity/content races and cleanup assertions: existing writer, update/rename attempts during transfer, source replacement around handle acquisition, late-open completion, in-flight delete timeout, skip, conflict, and cancellation. Prove newer or replacement source data cannot be deleted. Test completed-child-then-unknown aggregation and partially moved trees with retained entries, including prior replacements.
4. Add the batch regression above. Keep the nesting issue open unless its failing reproduction passes after a grounded fix.
5. Run focused tests after each edit, then the affected backend transfer/API/SMB suites, frontend contract/recovery/tree/batch suites, backend type/lint checks, and frontend lint/build. Run companion checks only if its contract implementation changes. Resolve new errors and warnings; identify unrelated existing failures separately.
6. Check applicable versioned transfer documentation and update changed semantics using the `docs-update` workflow. No dependency, lockfile, release-version, or unrelated UI changes are planned.
7. Validate real SMB behavior using disposable files and explicit test credentials, including concurrent access and overwrite. Mocked tests alone do not establish server sharing/delete semantics. VS Code browser checks must use `http://localhost:3000/browse/smb/demo`; other cross-connection checks belong in automated fixtures or a separately authorized integration environment.

Acceptance: successful cross-SMB moves leave one destination copy and remove only the copied source object; replacement actually replaces; partial outcomes remain accurate; sibling roots remain siblings in batch coverage. If real-SMB validation or the original nesting reproduction is unavailable, document that limitation rather than declaring those checks complete.

## Implementation Record

- Protected unbuffered SMB move handles now deny concurrent writers and renames, validate identity and metadata through the retained handle, and delete through that handle's `fd`.
- Late opens and in-flight handle operations retain their connection lease until deferred cleanup finishes. Cleanup runs once, is bounded in the request, and doesn't replace the primary transfer error.
- Both replacing publication paths use `smbclient.replace`; exclusive publication still uses `rename` and never removes a visible destination first.
- Direct and durable APIs preserve destination publication and replacement facts for retained sources, uncertain deletes, and post-publication copy validation failures. Durable cancellation and receipt replay have regressions before publication, after publication, and after delete dispatch.
- Tree outcomes aggregate confirmed mutations and replacements independently of stopping status. The actual multi-selection/F6 path covers nested first roots, destination WebSocket refresh, apply-to-all conflicts, retained sources, and unknown outcomes. These cases preserve sibling roots or stop the batch; they don't reproduce the original nesting report.
- Terminal dialog confirmation also rejects Enter, preventing a hidden keyboard retry after an uncertain result.
- Version 2.0's dual-pane guide documents the changed semantics. No dependencies, lockfiles, release versions, or companion implementation changed.
- The disposable real-SMB integration regression requires explicit `TEST_SMB_HOST`, `TEST_SMB_SHARE`, `TEST_SMB_USERNAME`, and `TEST_SMB_PASSWORD`. Without those credentials it is skipped; mocked tests don't establish server sharing/delete semantics.

### Verification Results

- Affected backend transfer, browser API, SMB, and pool suites: 373 passed, two explicit-credential integration tests skipped. Two unrelated image-preview tests still warn about Starlette's deprecated `HTTP_413_REQUEST_ENTITY_TOO_LARGE` constant.
- Affected frontend API/contract, recovery, storage backend, tree, batch, and dialog suites: 351 passed across seven files.
- Backend Ruff and mypy, frontend Biome and production build, documentation validation, and `git diff --check` passed. The production build reports its non-failing large-chunk warning.
- Browser smoke check used only the demo connection, opening and dismissing F6 confirmation without moving files. Cross-connection behavior was tested in automated fixtures, not against a live SMB server.
- Tree diagnostics include a correlated operation ID, child attempt IDs, both connection IDs, original destination parent, request paths, and create/transfer/cleanup phases. The original nesting report remains open in `TODO.md`.

## Plan Review

Reviewed against the original implementation with an independent reviewer. The review identified gaps in late executor cleanup, aggregate outcomes, durable late cancellation, and replacement facts after copy validation failure; the implementation and regressions address all four. Real-server validation and the original nesting reproduction remain open.
