# Native Mobile Sharing: Proposed Fix

Status: Proposal for review. No implementation changes have been made.

## Goal

Make file sharing work for browser-supported types, including plain text, and give consistent feedback when the browser rejects an attachment. Keep sharing an attachment distinct from sharing its text contents.

## Findings

- Android Chromium permits `.txt` attachments with MIME type `text/plain`, but its current file-sharing allowlist excludes `.md` and `text/markdown`. This is a Chromium restriction, not a universal restriction of the Web Share API or Android.
- Sambee's server download endpoint returns original file bytes as `application/octet-stream`. The text and Markdown viewers construct share files without a MIME fallback, preserving that generic type, which Chromium rejects.
- The file list supplies the entry's MIME type as a fallback for generic downloads. Its reported rejection of `.txt` therefore still needs device-level investigation; the generic-download explanation alone does not establish the cause there.
- The share helper preserves MIME parameters. Android Chromium checks MIME types against an exact allowlist, so a type such as `text/plain; charset=utf-8` can also be rejected.
- Chromium's `canShare()` preflight does not enforce the Android file-type allowlist. A positive result does not guarantee that `share()` will accept the file.
- The helper falls back to title/text when a singular file fails preflight, but not when the actual share call rejects it. Viewers show a generic failure for that rejection; the file list maps a particular permission error to its file-type warning.
- All 13 existing sharing-helper tests passed during investigation. They mock browser behavior and do not demonstrate Android compatibility.

Relevant code:

- `frontend/src/utils/nativeShare.ts`
- `frontend/src/components/Viewer/TextViewer.tsx`
- `frontend/src/components/Viewer/MarkdownViewer.tsx`
- `frontend/src/pages/FileBrowser.tsx`
- `frontend/src/services/api.ts`
- `backend/app/api/viewer.py`

Browser evidence:

- [Android Chromium sharing implementation](https://chromium.googlesource.com/chromium/src/+/main/components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java)
- [Chromium share preflight implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webshare/navigator_share.cc)

## Proposed Behavior

### Share File

Share the original saved file as an attachment, preserving its name and bytes.

- Use existing file-type metadata to replace missing or generic MIME types when constructing the share attachment. Resolve viewer metadata through existing repository utilities rather than inventing another MIME registry.
- Normalize MIME types by removing parameters and surrounding whitespace before passing them to the sharing API.
- Keep normal download responses unchanged. MIME normalization applies only to the constructed share attachment, not to its encoding or contents.
- Never silently replace an attachment with text, rename Markdown files to `.txt`, or label content as an unrelated format to bypass browser restrictions.
- Keep multi-file sharing all-or-nothing from Sambee's perspective: do not silently omit files or retry only a subset.

Expected result: `.txt` attachments with `text/plain` should be eligible for Android Chromium sharing. This requires verification on the affected device. `.md` attachments remain subject to the browser's restriction.

### Share Text

Propose an explicit "Share text" action in the text and Markdown readers/editors. It would invoke native text sharing without an attachment or a file download.

- Readers share the loaded text, including Markdown source rather than rendered HTML.
- Editors share current editor contents, including unsaved changes.
- "Share file" continues to share the saved file; it does not save edits implicitly.
- Labels and action placement must make these different meanings clear.
- Do not add a text-sharing fallback to file-list multi-file sharing.

This is a separate user-facing action, not an automatic retry after a failed attachment share. Its inclusion and placement need approval during review. Before implementing editor UI changes, consult the repository's settings/form/dialog architecture guidance where applicable.

### Errors and Cancellation

- Treat `canShare()` as a preliminary capability check, not a guarantee of file-type acceptance.
- Handle rejection from the actual `share()` invocation as well as a negative preflight result.
- Use consistent messages across viewers and the file list, with a download-and-share-from-Files suggestion when appropriate.
- Do not claim every permission error proves an unsupported file type. Permission, activation, and other browser restrictions can also prevent sharing.
- Keep cancellation silent and preserve existing cancellation behavior.
- Preserve useful diagnostic details without logging file contents. Record the error name/message and relevant attachment metadata needed to investigate the affected `.txt` case.
- Do not promise a text fallback will fix failures caused by missing user activation. If device testing identifies that issue, adjust payload preparation and invocation timing within the affected sharing flow.

## Implementation Steps

1. Verify the affected `.txt` payload's filename, MIME type, preflight result, and actual browser error. Record the browser/version used for reproduction.
2. Update shared share-file construction to normalize MIME types and use existing metadata for generic downloads. Supply that metadata from text and Markdown viewers.
3. Make attachment-only sharing semantics explicit in the shared helper and affected callers. Remove silent attachment-to-text substitution without breaking intentional text-only sharing.
4. Align rejection handling and messages across the viewers and file list. Preserve explicit download recovery and cancellation behavior.
5. If approved, add the separate "Share text" action to readers/editors using current contents without downloading or saving the file.
6. Add focused regression tests and run the relevant frontend checks.
7. Verify on Android, then update the applicable user documentation and release note to explain browser-dependent attachment support and any approved text-sharing action. Follow the docs-update workflow for published documentation changes.

## Verification Criteria

- Generic download MIME types are replaced with reliable existing metadata for share attachments.
- Parameterized text MIME types become `text/plain` without changing file bytes.
- Unknown types are not guessed to be plain text merely to force sharing.
- Positive preflight followed by browser rejection produces useful feedback, not an automatic text substitution.
- Cancelling the share sheet does not display an error.
- Multi-file rejection never silently drops files or starts partial retries.
- If approved, text sharing uses loaded/current editor contents, including unsaved edits, and does not save or download anything.
- Existing image and PDF attachment sharing continues to work.
- Android device checks cover `.txt` and `.md` from the file list and both reader/editor modes, plus image and PDF viewers. Record expected Markdown attachment rejection separately from successful text-only sharing.
- Run focused helper and affected component tests, frontend type checking, and linting. Use only `http://localhost:3000/browse/smb/demo` for VS Code browser testing, as required by repository instructions.

## Review Decisions

- Approve the additional "Share text" action, or limit this change to attachment correctness and error handling?
- Where should the two actions appear in the mobile viewer/editor controls?
- Confirm that sharing unsaved editor text is desired, while attachment sharing remains tied to the saved file.

## Scope Limits

- No backend download contract changes or dependency changes are planned.
- No browser allowlist bypasses, extension changes, or disguised MIME types.
- No claim that all Android browsers have Chromium's restrictions.
- No claim of successful Android reproduction until verified on a real device.
