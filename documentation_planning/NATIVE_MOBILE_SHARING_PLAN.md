# Native Mobile Sharing: Proposed Fix

Status: Proposal for review. No implementation changes have been made.

## Goal

Improve native mobile sharing across all sharing entry points, including the file list and image, PDF, text, and Markdown viewers/editors. Make file sharing work for browser-supported types, including plain text, and consolidate error handling and feedback. Keep sharing an attachment distinct from sharing its text contents.

Only the text and Markdown viewers/editors gain a small popout dialog with two choices: "Share as file" and "Share as text", opened by the existing single sharing icon in the top bar. Do not add a second toolbar icon or introduce this chooser in other sharing entry points.

## Findings

- Android Chromium permits `.txt` attachments with MIME type `text/plain`, but its current file-sharing allowlist excludes `.md` and `text/markdown`. This is a Chromium restriction, not a universal restriction of the Web Share API or Android.
- Sambee's server download endpoint returns original file bytes as `application/octet-stream`. The text and Markdown viewers construct share files without a MIME fallback, preserving that generic type, which Chromium rejects.
- The file list supplies the entry's MIME type as a fallback for generic downloads. Its reported rejection of `.txt` therefore still needs device-level investigation; the generic-download explanation alone does not establish the cause there.
- The share helper preserves MIME parameters. Android Chromium checks MIME types against an exact allowlist, so a type such as `text/plain; charset=utf-8` can also be rejected.
- Chromium's `canShare()` preflight does not enforce the Android file-type allowlist. A positive result does not guarantee that `share()` will accept the file.
- The helper falls back to title/text when a singular file fails preflight, but not when the actual share call rejects it. Viewers show a generic failure for that rejection; the file list maps a particular permission error to its file-type warning.
- All 13 existing sharing-helper tests passed during investigation. They mock browser behavior and do not demonstrate Android compatibility.

### Additional Firefox on Android Testing

- User-reported: sharing Markdown from the viewer works. Preserve this working opportunity; do not disable Markdown sharing based on Chromium's restrictions or assume browser behavior remains fixed across versions.
- User-reported: sharing any file, including images, from the file list fails with "Sharing is not available on this device or browser". The same image can be shared from the image viewer. Fix this inconsistency as part of this plan.
- Code evidence: the helper treats missing, throwing, or negative file preflight as `false`. Requests using `files` (the file list) then return `unsupported` without calling `share()`. Requests using `file` (viewers) can instead drop the attachment and share only title/text. This is a local hypothesis for the discrepancy, not a confirmed Firefox runtime diagnosis.

Relevant code:

- `frontend/src/utils/nativeShare.ts`
- `frontend/src/components/Viewer/TextViewer.tsx`
- `frontend/src/components/Viewer/MarkdownViewer.tsx`
- `frontend/src/components/Viewer/ImageViewer.tsx`
- `frontend/src/components/Viewer/PDFViewer.tsx`
- `frontend/src/pages/FileBrowser.tsx`
- `frontend/src/services/api.ts`
- `backend/app/api/viewer.py`

Browser evidence:

- [Android Chromium sharing implementation](https://chromium.googlesource.com/chromium/src/+/main/components/browser_ui/webshare/android/java/src/org/chromium/components/browser_ui/webshare/ShareServiceImpl.java)
- [Chromium share preflight implementation](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webshare/navigator_share.cc)

## Proposed Behavior

### Sharing Popout

- Apply this interaction only to the text and Markdown viewers and editors, retaining the existing native-sharing availability rules.
- Tapping the existing top-bar sharing icon opens a compact popout dialog instead of immediately invoking native sharing.
- Present exactly two sharing choices: "Share as file" and "Share as text". Selecting a choice starts that action without an additional confirmation step.
- Allow dismissal without sharing and restore focus to the existing sharing icon. Support keyboard navigation, Escape, accessible labels, and touch-sized choices.
- Reuse the existing anchored toolbar-menu pattern rather than building a custom popout. `frontend/src/components/FileBrowser/HelpMenu.tsx`, already used by the text and Markdown viewers, combines MUI `Menu`/`MenuItem`, `usePillButtonMenu`, `ToolbarIconButton`, and `secondaryToolbarMenuPaperSx`. Use it as the local reference; verify the hook's focus and keyboard behavior suits native sharing before reusing it.
- Centralize the two-choice sharing chooser in one component consumed by both text and Markdown viewers/editors. Keep menu presentation, labels, anchoring, dismissal, and accessibility in that component; callers supply file/text actions and pending/availability state.
- Reuse existing menu hooks and styles. If a missing generic behavior would otherwise be duplicated, extend or extract the smallest shared toolbar-menu building block rather than copying it. Do not create a second overlay system or refactor unrelated menus.
- Follow existing viewer overlay conventions and the repository's settings/form/dialog architecture guidance. This is an anchored action menu, not a settings form or an ordinary modal dialog; do not force it into the form-dialog shell or add a second toolbar icon.
- Preserve the user activation needed by native sharing when invoking the chosen action. File preparation must not make the subsequent share invocation unreliable.

### File Attachments (All Sharing Entry Points)

Share the original saved file as an attachment, preserving its name and bytes. These rules apply to every native file-sharing entry point; text/Markdown viewers and editors expose this action as "Share as file" in their popout.

- Use existing file-type metadata to replace missing or generic MIME types when constructing the share attachment. Resolve viewer metadata through existing repository utilities rather than inventing another MIME registry.
- Normalize MIME types by removing parameters and surrounding whitespace before passing them to the sharing API across all attachment-sharing flows.
- Keep normal download responses unchanged. MIME normalization applies only to the constructed share attachment, not to its encoding or contents.
- Never silently replace an attachment with text, rename Markdown files to `.txt`, or label content as an unrelated format to bypass browser restrictions.
- Keep multi-file sharing all-or-nothing from Sambee's perspective: do not silently omit files or retry only a subset.
- Preserve existing attachment-sharing entry points and successful image/PDF workflows. They receive the shared correctness and error-handling improvements, but no text-sharing chooser.
- Do not introduce browser-name, version, extension, or MIME allowlists that block attempts based on another browser's behavior. Keep legitimate metadata intact and support what the current browser actually accepts.

Expected result: `.txt` attachments with `text/plain` should be eligible for Android Chromium sharing, subject to device verification. The Chromium implementation inspected currently rejects Markdown attachments, but that must not become an application-wide prohibition. Permit Markdown attachment sharing wherever it works, including future browser versions, and keep the explicit text-sharing option available in text/Markdown viewers and editors.

### Consistent Attachment Sharing (All Browsers)

- Consolidate single-file attachment submission so the file list and viewers do not take different capability/fallback paths merely because one passes `files: [file]` and another passes `file`.
- Distinguish missing or throwing preflight from an explicit negative result. Absence of a usable `canShare()` must not by itself be treated as absence of `share()` or conclusive evidence that attachments cannot be shared.
- Where file preflight is unavailable or cannot reliably assess the payload, allow a direct attempt with the original attachment payload from the user's share action. Use the actual invocation result for feedback; never retry automatically with title/text only.
- Check explicit negative preflight against the Firefox reproduction before deciding how it should gate submission. Do not add browser sniffing or blindly retry rejected operations; define and test the common policy using runtime evidence.
- Preserve user activation: prepare file-list payloads before the final share action and invoke native sharing from that action. Do not replace the file list's preparation/confirmation flow with an asynchronous chain that loses activation.
- Test both a single image and multi-file selections. Never convert multi-file sharing into a series of separate shares or silently omit attachments.

### Share as Text

The "Share as text" choice invokes native text sharing without an attachment or a file download.

- Readers share the loaded text, including Markdown source rather than rendered HTML.
- Editors share current editor contents, including unsaved changes.
- "Share as file" continues to share the saved file; it does not save edits implicitly.
- Both actions live in the same popout, reached through the existing sharing icon.
- Do not add text sharing or the popout to the file list or other viewers. Their attachment sharing still receives the generic improvements described above.

This is an explicit choice, not an automatic retry after a failed attachment share. Its inclusion and placement in the popout, including sharing unsaved editor contents, are confirmed requirements.

### Errors and Cancellation (All Sharing Entry Points)

- Consolidate error classification, user-facing messages, and diagnostic handling for every native-sharing entry point, including single/multi-file list sharing and image, PDF, text, and Markdown viewers/editors.
- One centralized sharing handler owns failure classification, the diagnostic snapshot, and the shared failure presentation, including "Details". Entry points supply operation context and applicable recovery actions; they must not implement their own diagnostic collection or error dialogs.
- Treat `canShare()` as a preliminary capability check, not a guarantee of file-type acceptance.
- Represent unavailable/inconclusive preflight separately from confirmed rejection. Do not display "Sharing is not available" solely because optional file preflight is missing or throws while `share()` exists.
- Handle rejection from the actual `share()` invocation as well as a negative preflight result.
- Use consistent messages across all sharing entry points, with a download-and-share-from-Files suggestion when appropriate. Preserve useful recovery actions already available in each entry point.
- Do not claim every permission error proves an unsupported file type. Permission, activation, and other browser restrictions can also prevent sharing.
- Keep cancellation silent and preserve existing cancellation behavior.
- Capture a privacy-filtered diagnostic snapshot for the failed attempt in the centralized handler, without file contents. Present it only when the user chooses "Details", not as inline debugging output or an automatically opened popup.
- Do not promise a text fallback will fix failures caused by missing user activation. If device testing identifies that issue, adjust payload preparation and invocation timing within the affected sharing flow.

### Failure Details (Permanent Product Feature)

- Add a "Details" action to the shared sharing-failure presentation alongside applicable existing actions such as "Close" and "Download". Make it available for failures from all native-sharing entry points, not just text/Markdown or Firefox.
- Selecting "Details" opens a reusable popup with readable, selectable diagnostic information that users can include in a problem report. This is a supported product feature, not temporary debugging UI.
- Add a copy icon button inside the details popup, using the same MUI `ContentCopyIcon`, tooltip, and accessible-label pattern as Settings > About (`frontend/src/pages/AboutSettings.tsx`). Copy the complete privacy-filtered report directly as plain text; no copy-choice menu is needed because this popup has one report.
- Use the same formatted report for display and copying so privacy filtering cannot diverge. Reuse suitable clipboard helpers, or centralize common clipboard behavior if it would otherwise be duplicated; do not duplicate the About page's report-building code or couple this dialog to that page.
- Show localized copy-success or copy-failure feedback without dismissing the popup or losing the report. Follow the About page's clipboard-availability behavior: hide the copy control when `navigator.clipboard.writeText` is unavailable, and keep the report selectable for manual copying. Handle clipboard rejection without introducing insecure fallbacks.
- Keep the ordinary error message concise and actionable. Do not show raw errors, capability dumps, or diagnostic metadata outside the explicitly requested details popup.
- Include Sambee version, available browser/platform version information, sharing entry point and selected mode, secure-context/API availability, preflight state (including unavailable or thrown), whether native sharing was invoked, available activation state at invocation, attachment count/types/sizes, which data fields were submitted, and the sanitized error name/message or locally classified failure reason. Mark unavailable information as unknown; do not infer capabilities from browser identity.
- Describe the submitted data structure without exposing its contents. Exclude file/text contents, titles, filenames, paths, shared URLs, credentials, tokens, and raw request/header or stack dumps. Sanitize browser error messages that might contain sensitive values.
- Retain the snapshot of that failed attempt while its failure UI is active, so opening details does not rerun preflight, retry sharing, or replace the evidence with current browser state. Clear it when the failure flow is dismissed or replaced.
- Do not automatically upload diagnostics or introduce telemetry. Users decide whether and where to report the information. Do not claim to know which app received a file: delivery verification remains a manual test.
- Reuse the shared ordinary-dialog infrastructure (`ResponsiveDialogShell`) and existing diagnostic presentation utilities where suitable. Keep this separate from the anchored text/Markdown sharing chooser. Closing details returns to the failure UI with its recovery actions and appropriate focus intact.

## Implementation Steps

These steps are executable by the AI in the current workspace. Native Android share-sheet behavior and delivery to receiving apps cannot be verified here; real-device checks are separate manual validation, not implementation prerequisites.

1. Trace all native-sharing callers and encode the reported failure scenarios in focused tests with mocked browser APIs. Cover missing, throwing, positive, and negative preflight results; compare file-list and viewer attachment submission. Use these tests to validate the common capability policy without claiming to reproduce Firefox Android itself.
2. Implement one reusable two-choice sharing menu for the existing sharing icon in the text/Markdown viewers/editors, following the existing `HelpMenu` pattern. Reuse `usePillButtonMenu`, toolbar controls, and shared menu styles where suitable; centralize any missing common behavior instead of duplicating it. Keep other viewers' controls unchanged.
3. Normalize share-file MIME types and use existing metadata for generic downloads through shared file construction across all native attachment-sharing flows. Preserve file names, bytes, and successful image/PDF sharing.
4. Fix the Firefox file-list discrepancy through a common attachment-submission and capability policy, distinguishing unavailable preflight from rejection and allowing actual attachment attempts where preflight cannot assess support. Make sharing modes explicit: an attachment request must never silently become text-only sharing. In the text/Markdown chooser, "Share as file" sends an attachment (with optional title); "Share as text" sends text without an attachment, download, or implicit save.
5. Consolidate rejection handling, messages, cancellation behavior, diagnostic capture, and failure presentation in one centralized sharing handler used by all native-sharing callers. Preserve entry-point-specific recovery actions, including file-list download recovery. Add the permanent "Details" action and shared privacy-filtered diagnostic popup, including the About-style copy control; do not add temporary or inline debug output.
6. Run focused helper/component regression tests, frontend type checking, and linting. Use the available VS Code browser at `http://localhost:3000/browse/smb/demo` to check chooser, failure/details dialogs, focus, and responsive layout at phone/desktop sizes. Simulate share/clipboard outcomes where needed; distinguish these checks from native mobile integration testing.
7. Update the applicable user documentation and release note to explain the implemented generic sharing improvements, browser-dependent attachment support, and failure details/copy option. Describe the chooser specifically for text/Markdown viewers and editors. Follow the docs-update workflow for published documentation changes, and report any remaining real-device verification gaps without claiming Android compatibility has been independently confirmed.

## Verification Criteria

- Generic download MIME types are replaced with reliable existing metadata for share attachments.
- Parameterized text MIME types become `text/plain` without changing file bytes.
- Unknown types are not guessed to be plain text merely to force sharing.
- Positive preflight followed by browser rejection produces useful feedback, not an automatic text substitution.
- Missing or throwing `canShare()` is tested separately from explicit `false`; when an attachment attempt is appropriate, `share()` receives the original files rather than a title/text substitute. Actual rejection and absent `share()` still receive accurate feedback.
- A single-file request has identical attachment semantics whether submitted by the file list or a viewer, verified through mocked API payload assertions. Actual Firefox Android delivery remains a manual check.
- Markdown sharing is not blocked based on Chromium-specific rules. Tests cover attachment and explicit text payloads separately; actual Firefox delivery remains a manual check.
- No hard-coded browser/type support matrix is introduced; tests cover varying runtime capabilities and rejection behavior so browser changes do not require updating application allowlists.
- All native-sharing entry points use consolidated error handling, including consistent feedback for negative preflight results and actual share rejection without overstating their causes.
- Every sharing-failure presentation offers the centrally implemented "Details" action alongside applicable recovery actions. Diagnostics appear only after explicit selection, never inline or automatically.
- Details describe the failed attempt accurately, remain stable while open, and contain no file contents, shared text, titles, filenames, paths, URLs, credentials, or unfiltered error dumps. Cover privacy filtering and unknown diagnostic fields in focused tests.
- Opening/closing details neither retries sharing nor loses download recovery. Keyboard and focus behavior, selectable report text, mobile layout, and dismissal work through the reused dialog infrastructure. No diagnostics are uploaded automatically.
- The details copy button uses the existing About copy icon pattern and copies exactly the displayed privacy-filtered report. Test success feedback, rejected clipboard writes, unavailable clipboard access, accessible naming, and continued manual text selection; copying must not dismiss the popup or alter the failure snapshot.
- Cancelling the share sheet does not display an error in any entry point.
- Each text/Markdown viewer and editor retains exactly one top-bar sharing icon, which opens the compact popout with "Share as file" and "Share as text".
- Each choice invokes only its selected sharing mode; dismissing the popout invokes neither.
- Both text and Markdown viewers/editors use the same sharing-menu component and existing shared menu infrastructure. Test the common menu behavior once in its owning component and cover caller-specific file/text wiring in viewer tests.
- Focus restoration, keyboard navigation, Escape dismissal, touch targets, and light/dark appearance work at phone and desktop widths, including a short viewport.
- Text sharing uses loaded text in viewers and current editor contents including unsaved edits in editors. It does not save or download anything.
- File-list sharing, multi-file sharing, and image/PDF sharing use the generic MIME and error-handling improvements without gaining the text/Markdown chooser. Existing successful attachment workflows remain functional.
- Multi-file rejection never silently drops files or starts partial retries; file-list download recovery remains available.
- Run focused helper and affected component tests, frontend type checking, and linting. Use only `http://localhost:3000/browse/smb/demo` for VS Code browser testing, as required by repository instructions.

## Manual Device Validation (Outside AI Execution)

Real-device testing requires a person with access to Android and receiving apps. It is not part of the AI implementation steps and must not be reported as completed by mocked or desktop-browser tests.

- Check Firefox and a Chromium-based browser using `.txt` and `.md` from the file list and text/Markdown reader/editor modes, plus image/PDF viewers and multi-file selections.
- Confirm the same image reaches the receiving app as an attachment from both the file list and image viewer wherever supported. Exercise both popout choices in text/Markdown and distinguish actual attachment delivery from text/title-only delivery.
- Record acceptance or rejection per browser/version, particularly Markdown attachment behavior, without prescribing a universal outcome. On failure, use the product's "Details" and copy option to capture the privacy-filtered report.

## Review Decisions

- Confirmed: the plan covers native mobile sharing improvements generally; consolidated error handling applies to all sharing entry points.
- Confirmed: fix the Firefox Android file-list failure, preserve supported Markdown sharing, and use flexible runtime behavior rather than assumptions about a browser or file type.
- Confirmed: only text and Markdown viewers/editors gain the popout. Keep one sharing icon in their top bar, opening a small popout dialog with "Share as file" and "Share as text".
- Confirmed: no temporary or inline debug output. Sharing failures expose a permanent, user-requested "Details" popup, owned by the centralized sharing handler and available across all sharing entry points.
- Confirmed: "Share as text" includes unsaved editor changes, while "Share as file" shares the saved file without implicitly saving edits.

## Scope Limits

- No text-sharing chooser outside the text and Markdown viewers/editors. File-list sharing, multi-file sharing, image/PDF viewers, and other native-sharing callers remain in scope for generic correctness and consolidated error handling.
- No second sharing icon in the top bar.
- No backend download contract changes or dependency changes are planned.
- No browser allowlist bypasses, extension changes, or disguised MIME types.
- No claim that all Android browsers have Chromium's restrictions.
- Distinguish user-reported Android test results from independent reproduction. Do not claim independent verification until performed on a real device.
