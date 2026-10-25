# Unified Text Editor

## Goal and compatibility

Remove the separate text-viewer workflow. Every text destination opens one Text Editor and attempts to become writable without an Edit action. Read-only is an editor state, not a separate destination. Markdown retains its preview/edit workflow; choosing its text destination opens source in the unified editor.

Keep the public `viewer=text` identifier, saved viewer preferences, settings keys, and text draft identifiers. Accept legacy absent/view/edit text modes as the same destination and serialize text URLs without mode, preserving history state and fragments. Do not add navigation entries for acquisition results.

## User contract

- Writable files acquire a session and a fresh baseline before typing is enabled.
- Acquisition pending, another tab/user holding the lock, denied write access, archive members, and temporary failures keep content readable in the same editor.
- Explain read-only reasons. Offer Retry editing for recoverable failures, not permanent read-only sources. Do not steal locks or poll for acquisition.
- Preserve the existing oversized-file read-only fallback and configured limit.
- Opening reserves an edit lock before typing. Saving is always explicit.
- Close goes directly to the file list. Dirty Close, Escape, Back, and navigation offer Save/Discard/Cancel and then complete the original action. Search consumes Escape first.
- Read-only retains Find, copy/selection, syntax highlighting, wrapping, download, and sharing. Save/Replace require a usable session.

## Implementation

1. Consolidate the existing TextViewer/TextCodeEditor host as TextEditor; retain the existing CodeMirror implementation. Separate document/dirty state from session/access state. Prevent duplicate and obsolete acquisitions, including Strict Mode and retained transition presentations; release late locks.
2. Make activation automatic, independent of text URL mode. Adapt shared route guarding narrowly without changing Markdown. Keep synchronous close/navigation and protect in-flight Save/acquisition.
3. Preserve expected access failures as typed outcomes across storage/content boundaries. Distinguish contention, permissions, unsupported editing, and unavailability without parsing prose errors. Check SMB and Companion for non-mutating write-access probes; metadata and application locks alone are not permission proof. Keep authoritative write errors defensive and retain drafts.
4. Read/revalidate the baseline after acquisition. Resolve recovery before enabling ordinary edits. Resume must work with automatic activation; acquisition failure must not hide or erase recoverable work.
5. Handle heartbeat failures: distinguish transient connectivity from confirmed ownership loss, freeze mutations on confirmed loss, retain dirty content/recovery, and allow explicit retry. Do not silently reacquire and overwrite: compare a fresh baseline on reacquisition and require a conflict decision when it changed. Preserve shared Markdown behavior except necessary storage safety fixes, with regression coverage.
6. Remove normal Edit, separate viewer help, and return-to-preview error actions. Use a single toolbar and permission-aware commands. Preserve concurrent-edit Save acknowledgements, recovery, focus/selection, sharing, and download semantics.
7. Update registry/warmup, translations, existing tests and browser fixtures. Update 2.0 release notes, text support references, viewer architecture, shortcuts, and Markdown's text-close description using the docs workflow.

## Verification

- Focused regressions after each code slice, then affected frontend suites, typecheck, lint and build.
- Cover normal activation, picker/bookmarks/reload, legacy routes and history, one-step Close, Save/Discard/Cancel, newer edits during Save, and unchanged Markdown.
- Cover read-only connections/files, archives/size limit, tabs/users, transient failure/retry, lock loss, recovery with unavailable locks, and changed baselines on reacquisition.
- Cover delayed acquisition/release, unmount/rapid file changes/Strict Mode, and no leaked locks or heartbeat timers.
- Run backend and Companion tests for changed contracts. Verify actual browser workflows in Chromium/Firefox at desktop/mobile widths only at `http://localhost:3000/browse/smb/demo`.
- Follow the docs-update skill and refresh/check required derived artifacts.

## Progress

- [x] Save implementation plan.
- [x] Implement unified lifecycle and navigation.
- [x] Implement access/session safety and recovery.
- [x] Migrate focused tests and verify browser workflows.
- [x] Update documentation and run final checks.

## Evidence and decisions

- Source inspection: both previous modes already render TextCodeEditor. No new editor dependency is needed.
- Source inspection: SMB lock acquisition checks connection access only; per-file write capability must not be inferred from it.
- Source inspection: the shared storage session silently reacquires an expired lock during Save. This needs explicit baseline-safe handling rather than blindly retrying a stale draft.
- Implemented `TextEditor` using the existing CodeMirror surface; removed the separate `TextViewer` host and migrated its tests. Registry and runtime warmup now load the unified host. Public text IDs and recovery/settings keys remain unchanged.
- Expected access failures are typed. SMB and Companion check write capability without truncating or creating files. Text saves disable automatic expired-lock reacquisition; explicit retry reads a fresh baseline and requires a decision for conflicting retained drafts. Transient heartbeat failure warns; confirmed loss freezes editing without erasing the draft.
- Browser verification caught a second navigation prompt after toolbar Discard. Discard now commits a clean draft before navigation. The real routed unit regression and production desktop/mobile checks pass. Mobile confirmation tests locate the drawer by its heading and wait for Cancel dismissal before another Back.
- Final complete frontend suite: 2,761 tests across 169 files passed. The focused host suite includes 51 tests covering access, navigation, recovery, conflict, acquisition cancellation, Strict Mode, and heartbeat behavior. TypeScript, lint, editor diagnostics, whitespace checks, and the normal production build passed.
- Production browser matrix: 72 cases passed in Chromium and Firefox at 1543px and 390px. Includes automatic editing, dirty Save/Discard/Cancel, Back and legacy bookmarks, contention/retry, read-only connections, shared syntax correctness, and live text/Markdown theme identity. All 16 unified-editor cases passed again against the final rebuilt bundle.
- Backend: both affected test files (`test_browser.py` and `test_smb_backend.py`) passed; two environment-dependent live SMB tests were skipped. Mypy passed for all 108 application source files. New regressions verify non-mutating probes and no database lock after denied access.
- Companion: all 290 Rust library tests passed, including three new access-probe tests. Clippy with warnings denied, Rust formatting, and the Windows cross-compilation check passed. This is a compile check, not Windows runtime verification.
- Updated the applicable 2.0 user references, Markdown close guidance, developer architecture, and release notes while preserving concurrent release-note edits. Docs content validation passed and the derived docs report was refreshed.
- Manual development-browser check at the approved demo connection: an existing SMB text file opened with `contenteditable=true`, no Edit button, and closed directly back to the file list. No edits or saves were made during this check.
- No dependency or lockfile changes, commits, or branches were created. Full live SMB permission and Windows runtime matrices were not run; automated boundary/permission tests and the live demo opening check are the available evidence.
