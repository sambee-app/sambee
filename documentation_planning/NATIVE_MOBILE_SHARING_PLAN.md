# Native Mobile Sharing: Proposed Fix

Status: Implemented. Automated and mocked-browser validation completed; native Android/iOS delivery validation remains manual.

## Implementation Validation

- All 404 tests in the 10 affected frontend suites pass, covering shared policy, lifecycle, menus, viewers, image caching, and file-browser interactions. Image and original/normalized PDF sharing assert displayed content bytes. Regression coverage includes pending/failed representation replacement, ignored late PDF responses, exact displayed-attachment recovery downloads, and saved-attachment invalidation after Text/Markdown saves.
- Frontend lint and the production build pass. Website documentation validation passed during the original implementation; published documentation is unchanged by these fixes. Existing production bundle-size warnings remain.
- Mocked-browser checks at the demo connection cover file/text selection, privacy-filtered details, copy feedback, focus restoration, and short-phone/desktop layouts. Failure evidence survives responsive action visibility changes and is cleared when the source changes.
- Review follow-up fixes suspend all viewer shortcuts while sharing Details is open, retain valid prepared attachments across availability changes, and ignore generic MIME metadata before consulting the filename registry. Integrated viewer tests cover Details Escape dismissal; a mocked-browser check confirms that the text viewer, Download recovery, focus, and report survive dismissal and responsive changes at phone, short-phone, and desktop sizes.
- The stricter app-project TypeScript check remains blocked by existing repository errors. Comparing against an isolated HEAD archive found no new diagnostics: 789 at HEAD versus 781 after correcting the image test mock's types. The normal production build passes.
- Actual Android Chromium, Android Firefox, and Safari iOS share-sheet delivery still require the manual checks below. Mocked API success does not establish receiving-app delivery.

## Goal

Improve native mobile sharing across all sharing entry points, including the file list and image, PDF, text, and Markdown viewers/editors. Make file sharing work for browser-supported types, including plain text, and consolidate error handling and feedback. Keep sharing an attachment distinct from sharing its text contents.

Only the text and Markdown viewers/editors gain a small popout dialog with two choices: "Share as file" and "Share as text", opened by the existing single sharing icon in the top bar. Do not add a second toolbar icon or introduce this chooser in other sharing entry points.

"Share as file" must behave exactly like image/PDF viewer sharing and call the same shared file-sharing implementation. The chooser changes how the action is selected, not how the attachment is prepared or shared.

Image/PDF viewer sharing uses the file representation displayed by that viewer, including browser-compatible normalized or converted content. Do not substitute a potentially incompatible original. Text/Markdown attachment sharing uses the saved file, while file-list sharing uses the selected stored files because there is no displayed viewer representation there.

## Findings

- Android Chromium permits `.txt` attachments with MIME type `text/plain`, but its current file-sharing allowlist excludes `.md` and `text/markdown`. This is a Chromium restriction, not a universal restriction of the Web Share API or Android.
- Sambee's server download endpoint returns original file bytes as `application/octet-stream`. The text and Markdown viewers construct share files without a MIME fallback, preserving that generic type, which Chromium rejects.
- The file list supplies the entry's MIME type as a fallback for generic downloads. Its reported rejection of `.txt` therefore still needs device-level investigation; the generic-download explanation alone does not establish the cause there.
- The share helper preserves MIME parameters. Android Chromium checks MIME types against an exact allowlist, so a type such as `text/plain; charset=utf-8` can also be rejected.
- Chromium's `canShare()` preflight does not enforce the Android file-type allowlist. A positive result does not guarantee that `share()` will accept the file.
- The helper falls back to title/text when a singular file fails preflight, but not when the actual share call rejects it. Viewers show a generic failure for that rejection; the file list maps a particular permission error to its file-type warning.
- All 13 existing sharing-helper tests passed during investigation. They mock browser behavior and do not demonstrate Android compatibility.
- Image and PDF presentation can involve normalization/conversion. The PDF viewer already builds its share file from the loaded PDF, which may be normalized. Image sharing currently requests image content separately, so the implementation must ensure it uses the displayed representation rather than assuming a separate request returns equivalent bytes.

### Additional Firefox on Android Testing

- User-reported: sharing Markdown from the viewer works. Preserve this working opportunity; do not disable Markdown sharing based on Chromium's restrictions or assume browser behavior remains fixed across versions.
- User-reported: sharing any file, including images, from the file list fails with "Sharing is not available on this device or browser". The same image can be shared from the image viewer. Fix this inconsistency as part of this plan.
- Code evidence: the helper treats missing, throwing, or negative file preflight as `false`. Requests using `files` (the file list) then return `unsupported` without calling `share()`. Requests using `file` (viewers) can instead drop the attachment and share only title/text. This is a local hypothesis for the discrepancy, not a confirmed Firefox runtime diagnosis.

### Safari on iOS Testing

- User-reported: no known sharing issues in Safari on iOS. This is a working baseline to preserve, not evidence that every file type or sharing flow has been exhaustively tested.
- Apply shared correctness and error-handling improvements without introducing Safari-specific restrictions or workarounds. Include Safari on iOS in manual regression checks.

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
- Wire "Share as file" directly to the shared viewer file-sharing action described below. Do not introduce a text/Markdown-specific preparation/readiness workflow, an extra confirmation, or copied file-sharing handlers. "Share as text" stays independent of attachment preparation.

### File Attachments (All Sharing Entry Points)

Share the attachment appropriate to the entry point, according to the source contract below. Text/Markdown viewers and editors expose this action as "Share as file" in their popout. The shared handler preserves the selected representation's bytes rather than imposing an original-only policy.

| Entry point | Attachment source |
| --- | --- |
| Image viewer | The image representation currently displayed, including conversion, normalization, or server-side resizing used for that presentation. Reuse the displayed resource's bytes rather than separately requesting an original or differently processed image. |
| PDF viewer | The complete PDF representation currently displayed, including a normalized PDF when normalization was needed. Share the document, not just the visible page. |
| Text/Markdown viewer or editor: Share as file | The saved file, retaining its format and bytes. Do not render Markdown to HTML or include unsaved edits in the attachment. |
| File list: single or multiple files | The selected stored files, preserving their names and bytes. Do not start a viewer or normalize files solely for file-list sharing. |

For image/PDF viewers, "displayed" means the underlying file resource used for presentation, not a screenshot, visible-page crop, or capture of browser UI. If the original is displayed without processing, sharing that resource naturally shares the original. Do not add a new conversion pipeline just for sharing.

- Use MIME metadata for the actual attachment representation. For displayed derivatives, prefer the displayed resource's format over the original file entry's MIME type. Use reliable existing metadata to replace missing or generic types; do not invent another MIME registry.
- Keep the original filename when its extension matches the shared format. If image conversion changes the format, retain the filename stem and use the correct extension for the displayed derivative, using existing format utilities. A normalized PDF remains a PDF. This is truthful naming of converted content, not renaming to bypass sharing restrictions.
- Normalize MIME types by removing parameters and surrounding whitespace before passing them to the sharing API across all attachment-sharing flows.
- Keep normal download responses unchanged. MIME parameter normalization applies only to attachment metadata; it does not perform an additional content conversion or replace displayed image/PDF bytes with original bytes.
- Never silently replace an attachment with text, rename Markdown files to `.txt`, or label content as an unrelated format to bypass browser restrictions.
- Keep multi-file sharing all-or-nothing from Sambee's perspective: do not silently omit files or retry only a subset.
- Preserve existing attachment-sharing entry points and successful image/PDF workflows. They receive the shared correctness and error-handling improvements, but no text-sharing chooser.
- Do not introduce browser-name, version, extension, or MIME allowlists that block attempts based on another browser's behavior. Keep legitimate metadata intact and support what the current browser actually accepts.

Expected result: `.txt` attachments with `text/plain` should be eligible for Android Chromium sharing, subject to device verification. The Chromium implementation inspected currently rejects Markdown attachments, but that must not become an application-wide prohibition. Permit Markdown attachment sharing wherever it works, including future browser versions, and keep the explicit text-sharing option available in text/Markdown viewers and editors.

### Consistent Attachment Sharing (All Browsers)

- Consolidate single-file attachment submission so the file list and viewers do not take different capability/fallback paths merely because one passes `files: [file]` and another passes `file`.
- Distinguish missing or throwing preflight from an explicit negative result. Absence of a usable `canShare()` must not by itself be treated as absence of `share()` or conclusive evidence that attachments cannot be shared.
- Use the decision table below for all attachment-sharing requests. This policy is implementable without real-device reproduction; manual results may inform a later revision, not an undefined browser-specific exception.
- Preserve user activation: prepare file-list payloads before the final share action and invoke native sharing from that action. Do not replace the file list's preparation/confirmation flow with an asynchronous chain that loses activation.
- Test both a single image and multi-file selections. Never convert multi-file sharing into a series of separate shares or silently omit attachments.

| Runtime condition | Required behavior |
| --- | --- |
| `navigator.share` is unavailable | Do not invoke native sharing. Report sharing unavailable through the centralized failure handler, with applicable recovery actions and Details. |
| File preflight explicitly returns `false` | Do not invoke native sharing. Report that the browser cannot share this attachment payload, not that all sharing is unavailable. Offer applicable recovery actions and Details. |
| `navigator.canShare` is missing | Attempt native sharing once with the prepared attachments from the source contract and no optional title, text, or URL fields. Record preflight as unavailable. |
| File preflight throws | Attempt native sharing once with the prepared attachments from the source contract and no optional title, text, or URL fields. Record preflight as thrown with privacy-filtered error information. |
| File preflight returns `true` | Attempt native sharing once with the prepared attachments from the source contract and optional title metadata. Do not include text as an alternative to the attachment. |
| Native sharing rejects | Use centralized cancellation/failure handling. Never retry automatically, remove attachments, or substitute title/text-only sharing. |
| Native sharing resolves | Record API completion, not independently verified attachment delivery. Do not claim to know what the receiving app received. |

Run file preflight with the attachment array alone (`{ files }`), so title/text fields cannot hide lack of attachment support. When preflight is unavailable or throws, omit optional fields from the actual attempt to avoid a browser ignoring unsupported files and successfully sharing only a title or text. This is a defensive attempt, not proof of file support; no browser sniffing or hard-coded support matrix is introduced. Explicit "Share as text" submits text through the same centralized invocation/error handler without requiring file preflight.

### Shared Viewer File-Sharing Lifecycle

- Extract the common image/PDF file-sharing behavior into one shared implementation used by image, PDF, text, and Markdown viewers/editors. Reuse existing helpers; do not make one viewer depend on another viewer component or create a general workflow framework.
- Keep source-specific content loading in each viewer. Supply the displayed image/PDF resource's blob/file and representation metadata, or the saved-file loader for text/Markdown, to the shared implementation. Reuse and retain displayed image/PDF bytes where available; if presentation currently retains only a URL, integrate byte retention into the existing presentation-loading path rather than requesting a potentially different derivative or original for sharing.
- Centralize attachment preparation, valid prepared-file reuse, pending/readiness state, native invocation, and cancellation/failure forwarding. "Share as file" in the text/Markdown menu and the image/PDF share icons invoke the same action with the same lifecycle semantics.
- Preserve user activation in the shared implementation: when sharing is actionable, the native invocation must run directly from the user's action using prepared bytes, without a preceding network wait or deferred effect/timer. Any necessary preparation and pending/readiness handling must be common to all viewers, not a special menu-only workflow. Preserve working image/PDF behavior and do not add confirmation steps.
- Retain successfully prepared files while valid. Invalidate them when the connection, file path, virtual source, or relevant saved-file version changes, including a successful editor save. For image/PDF viewers, also invalidate when the displayed resource or representation changes, including normalization fallback or a replacement derivative. Do not allow a previously prepared original or different derivative to outlive that switch. Unsaved text/Markdown editor changes alone do not change the saved-file attachment.
- While a new image/PDF representation is loading or has failed, do not share stale bytes or silently fall back to the original. Apply the common pending/readiness and failure behavior. Keep the currently selected representation's bytes valid through the share attempt; resource cleanup must not revoke or discard them prematurely.
- Ignore or cancel stale preparation results when the source changes or the viewer closes. Preparation completion must never automatically invoke native sharing; preparation failure goes through the centralized failure handler. Do not depend on pointer-hover warming, fast networks, or save-data being disabled for correctness.
- Keep "Share as text" available independently of attachment preparation. It reads the current loaded/editor text at selection time and never waits for file preparation or implicitly saves edits.
- Keep the file list's existing prepare-then-confirm interaction, while using the same common attachment capability/submission policy and centralized failure handling. Its multi-file preparation UI need not become the viewer lifecycle.

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
- Treat a positive `canShare()` result as preliminary, not a guarantee of file-type acceptance. Follow the common decision table for explicit negative, missing, and thrown preflight results.
- Represent missing or thrown preflight separately from an explicit negative result. Do not display "Sharing is not available" solely because optional file preflight is missing or throws while `share()` exists.
- Handle rejection from the actual `share()` invocation as well as a negative preflight result.
- Use consistent messages across all sharing entry points, with a download-and-share-from-Files suggestion when appropriate. Preserve useful recovery actions already available in each entry point.
- If failed image/PDF sharing offers "Download" as recovery, download the same prepared displayed representation that was being shared, with its matching filename/type. Do not replace it with a potentially incompatible original. Ordinary download actions outside sharing recovery retain their existing behavior.
- Do not claim every permission error proves an unsupported file type. Permission, activation, and other browser restrictions can also prevent sharing.
- Keep cancellation silent and preserve existing cancellation behavior.
- Capture a privacy-filtered diagnostic snapshot for the failed attempt in the centralized handler, without file contents. Present it only when the user chooses "Details", not as inline debugging output or an automatically opened popup.
- Prevent avoidable activation loss through the shared preparation/invocation lifecycle and focused tests, rather than deferring this requirement to device testing. Text sharing is an explicit action, not a recovery retry for activation failures.

### Failure Details (Permanent Product Feature)

- Add a "Details" action to the shared sharing-failure presentation alongside applicable existing actions such as "Close" and "Download". Make it available for failures from all native-sharing entry points, not just text/Markdown or Firefox.
- Selecting "Details" opens a reusable popup with readable, selectable diagnostic information that users can include in a problem report. This is a supported product feature, not temporary debugging UI.
- Add a copy icon button inside the details popup, using the same MUI `ContentCopyIcon`, tooltip, and accessible-label pattern as Settings > About (`frontend/src/pages/AboutSettings.tsx`). Copy the complete privacy-filtered report directly as plain text; no copy-choice menu is needed because this popup has one report.
- Use the same formatted report for display and copying so privacy filtering cannot diverge. Reuse suitable clipboard helpers, or centralize common clipboard behavior if it would otherwise be duplicated; do not duplicate the About page's report-building code or couple this dialog to that page.
- Show localized copy-success or copy-failure feedback without dismissing the popup or losing the report. Follow the About page's clipboard-availability behavior: hide the copy control when `navigator.clipboard.writeText` is unavailable, and keep the report selectable for manual copying. Handle clipboard rejection without introducing insecure fallbacks.
- Keep the ordinary error message concise and actionable. Do not show raw errors, capability dumps, or diagnostic metadata outside the explicitly requested details popup.
- Include Sambee version, available browser/platform version information, sharing entry point and selected mode, secure-context/API availability, preflight state (including unavailable or thrown), whether native sharing was invoked, available activation state at invocation, attachment count/types/sizes, attachment source category (displayed original, displayed derivative, or saved file) when known, which data fields were submitted, and the sanitized error name/message or locally classified failure reason. Mark unavailable information as unknown; do not infer capabilities from browser identity.
- Describe the submitted data structure without exposing its contents. Exclude file/text contents, titles, filenames, paths, shared URLs, credentials, tokens, and raw request/header or stack dumps. Sanitize browser error messages that might contain sensitive values.
- Retain the snapshot of that failed attempt while its failure UI is active, so opening details does not rerun preflight, retry sharing, or replace the evidence with current browser state. Clear it when the failure flow is dismissed or replaced.
- Do not automatically upload diagnostics or introduce telemetry. Users decide whether and where to report the information. Do not claim to know which app received a file: delivery verification remains a manual test.
- Reuse the shared ordinary-dialog infrastructure (`ResponsiveDialogShell`) and existing diagnostic presentation utilities where suitable. Keep this separate from the anchored text/Markdown sharing chooser. Closing details returns to the failure UI with its recovery actions and appropriate focus intact.

## Implementation Steps

These steps are executable by the AI in the current workspace. Native Android share-sheet behavior and delivery to receiving apps cannot be verified here; real-device checks are separate manual validation, not implementation prerequisites.

1. Trace all native-sharing callers and encode the capability decision table and reported failure scenarios in focused tests with mocked browser APIs. Cover absent `share`, missing/throwing/positive/negative preflight, invocation rejection/cancellation, and API completion. Compare file-list and viewer attachment submission without claiming to reproduce Firefox Android itself.
2. Extract and integrate one shared viewer file-sharing implementation for image, PDF, text, and Markdown, keeping source-specific loading in each viewer. Wire image/PDF sharing to the resource actually displayed, retaining its bytes and representation metadata from the presentation loader; keep text/Markdown file sharing tied to saved-file bytes. Centralize preparation, prepared-file reuse/invalidation (including representation switches), pending/readiness behavior, direct user-gesture invocation, and cancellation/failure forwarding. Connect the text/Markdown reusable two-choice menu to this same file action and an independent text action. Follow the existing `HelpMenu` pattern for the menu, reuse suitable hooks/controls/styles, and preserve image/PDF toolbar interactions without adding a chooser or confirmation there.
3. Normalize share-file MIME types through shared file construction, using metadata and filename extensions that match the chosen representation. Preserve the prepared representation's bytes; retain saved-file names where their format is unchanged and adjust converted-image extensions truthfully. Keep file-list attachments as stored files and normal download responses unchanged.
4. Apply the common decision table to all attachment callers, eliminating the divergent file-list/viewer capability paths implicated by the Firefox report. Block explicit negative preflight, attempt once for missing/throwing preflight without optional fields, and handle actual invocation results centrally. Make modes explicit: no attachment request becomes text-only sharing; the text/Markdown chooser's file choice uses the shared image/PDF file action, while its text choice submits current text without an attachment, download, or implicit save. Preserve file-list preparation/confirmation and multi-file semantics.
5. Consolidate rejection handling, messages, cancellation behavior, diagnostic capture, and failure presentation in one centralized sharing handler used by all native-sharing callers. Preserve entry-point-specific recovery actions, including file-list download recovery. For image/PDF share-failure recovery, supply the same displayed attachment for download rather than the original. Add the permanent "Details" action and shared privacy-filtered diagnostic popup, including the About-style copy control; do not add temporary or inline debug output.
6. Run focused helper/component regression tests, including the complete capability table and shared viewer lifecycle cases, frontend type checking, and linting. Use the available VS Code browser at `http://localhost:3000/browse/smb/demo` to check chooser, failure/details dialogs, focus, and responsive layout at phone/desktop sizes. Simulate share/clipboard outcomes where needed; distinguish these checks from native mobile integration testing.
7. Update the applicable user documentation and release note to explain the implemented generic sharing improvements, browser-dependent attachment support, and failure details/copy option. Explain that image/PDF viewers share their displayed representation, including normalized content, while the file list shares stored files. Describe the chooser and saved-file versus unsaved-text distinction specifically for text/Markdown viewers and editors. Follow the docs-update workflow for published documentation changes, and report any remaining real-device verification gaps without claiming Android compatibility has been independently confirmed.

## Verification Criteria

- Generic download MIME types are replaced with reliable existing metadata for share attachments.
- Image/PDF tests use distinct original and displayed-derivative bytes and assert that the displayed bytes are shared, including converted/resized images and normalized PDFs. Unprocessed presentations share their displayed original resource. No original-file fetch is used as a fallback for a displayed derivative.
- Shared filenames/extensions and MIME types match the actual displayed format, including an image conversion that changes format. Metadata normalization does not modify prepared content bytes.
- PDF sharing contains the whole displayed PDF document, not a page screenshot. Image sharing uses the displayed image resource, not a browser screenshot or viewport crop.
- Parameterized text MIME types become `text/plain` without changing file bytes.
- Unknown types are not guessed to be plain text merely to force sharing.
- Positive preflight followed by browser rejection produces useful feedback, not an automatic text substitution.
- Each capability-table branch has an explicit test: absent `share` and explicit negative preflight cause no invocation; missing/throwing preflight causes exactly one attachments-only invocation; positive preflight causes exactly one attachment invocation. Rejection never triggers automatic retries or title/text substitution. Feedback distinguishes unavailable API from unsupported payload.
- File preflight receives only `{ files }`. Missing/throwing preflight attempts contain no optional title/text/URL fields, and API completion is not described as confirmed receiving-app delivery.
- Single-file requests use the same capability/submission semantics across entry points, while payload assertions honor their different sources: displayed representations for image/PDF viewers, saved files for text/Markdown and the file list. Actual Firefox Android delivery remains a manual check.
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
- "Share as file" and image/PDF share controls invoke the same shared viewer file-sharing code, not parallel implementations. Preparation, pending/readiness state, invocation, and error behavior are consistent; only the text/Markdown action chooser differs.
- Shared lifecycle tests cover cold, pending, failed, and ready preparation; reuse of valid loaded/prepared bytes; constrained-network/save-data conditions; invalidation after source changes or successful saves; and ignored late results after close/source replacement. Completion of preparation never invokes sharing automatically, and actionable sharing invokes the native API directly without a network wait or effect/timer.
- Representation-switch tests verify that normalization fallback and image/PDF resource replacement invalidate old attachments; late results cannot replace the active representation. While replacement is pending or failed, sharing never submits stale or incompatible original bytes. Cleanup does not invalidate a share already in progress.
- Image/PDF share-failure download recovery uses the exact prepared displayed attachment and matching filename/type. File-list recovery continues downloading the selected stored files. Normal download behavior outside share recovery is unchanged.
- File preparation does not block "Share as text". In text/Markdown editors, text selection uses current contents, including unsaved edits, while file sharing uses the saved-file version and does not implicitly save.
- Focus restoration, keyboard navigation, Escape dismissal, touch targets, and light/dark appearance work at phone and desktop widths, including a short viewport.
- Text sharing uses loaded text in viewers and current editor contents including unsaved edits in editors. It does not save or download anything.
- File-list sharing, multi-file sharing, and image/PDF sharing use the generic MIME and error-handling improvements without gaining the text/Markdown chooser. Existing successful attachment workflows remain functional.
- Multi-file rejection never silently drops files or starts partial retries; file-list download recovery remains available.
- Run focused helper and affected component tests, frontend type checking, and linting. Use only `http://localhost:3000/browse/smb/demo` for VS Code browser testing, as required by repository instructions.

## Manual Device Validation (Outside AI Execution)

Real-device testing requires a person with access to Android/iOS devices and receiving apps. It is not part of the AI implementation steps and must not be reported as completed by mocked or desktop-browser tests.

- Check Firefox and a Chromium-based browser using `.txt` and `.md` from the file list and text/Markdown reader/editor modes, plus image/PDF viewers and multi-file selections.
- Regression-check Safari on iOS, where the user reports no known issues, across the affected sharing entry points and new chooser/details/copy controls. Preserve currently working sharing behavior without assuming untested combinations are supported.
- Check converted/normalized image and PDF presentations whose originals may not be displayable. Confirm the receiving app gets the displayed representation, with a matching filename/type, and share-failure download recovery saves that same representation.
- Compare sharing the same source image from the file list and viewer wherever supported, allowing the documented source difference: stored original from the list, displayed representation from the viewer. Do not require byte equality when presentation conversion occurred. Exercise both popout choices in text/Markdown and distinguish actual attachment delivery from text/title-only delivery.
- Record acceptance or rejection per browser/version, particularly Markdown attachment behavior, without prescribing a universal outcome. On failure, use the product's "Details" and copy option to capture the privacy-filtered report.

## Review Decisions

- Confirmed: the plan covers native mobile sharing improvements generally; consolidated error handling applies to all sharing entry points.
- Confirmed: fix the Firefox Android file-list failure, preserve supported Markdown sharing, and use flexible runtime behavior rather than assumptions about a browser or file type.
- Confirmed: only text and Markdown viewers/editors gain the popout. Keep one sharing icon in their top bar, opening a small popout dialog with "Share as file" and "Share as text".
- Confirmed: no temporary or inline debug output. Sharing failures expose a permanent, user-requested "Details" popup, owned by the centralized sharing handler and available across all sharing entry points.
- Confirmed: "Share as text" includes unsaved editor changes, while "Share as file" shares the saved file without implicitly saving edits.
- Confirmed: "Share as file" behaves like image/PDF viewer sharing and uses the same shared preparation/invocation code. No separate text/Markdown readiness workflow or extra confirmation is introduced.
- Confirmed: image and PDF viewers share what is displayed, including normalized/converted resources, rather than a potentially incompatible original. Text/Markdown attachments and file-list sharing retain their saved/stored-file source semantics. The same shared handler accepts these different source representations.
- Capability policy: explicit negative file preflight blocks that payload; missing/throwing preflight permits one attachments-only attempt; positive preflight permits one attachment attempt. No automatic retry, attachment removal, or text substitution. Device testing is not a prerequisite for implementing this policy.

## Scope Limits

- No text-sharing chooser outside the text and Markdown viewers/editors. File-list sharing, multi-file sharing, image/PDF viewers, and other native-sharing callers remain in scope for generic correctness and consolidated error handling.
- No second sharing icon in the top bar.
- No duplicated viewer file-sharing lifecycle or text/Markdown-specific preparation workflow. Shared fixes may update image/PDF internals while preserving their existing attachment-sharing interaction.
- No backend download contract changes or dependency changes are planned.
- No original-only policy for image/PDF viewer sharing, new conversion pipeline, screenshot sharing, or viewer normalization added to file-list sharing. Reuse the existing displayed resources and presentation transformations; keep ordinary download behavior unchanged.
- No browser allowlist bypasses, extension changes, or disguised MIME types.
- No claim that all Android browsers have Chromium's restrictions.
- Distinguish user-reported Android test results from independent reproduction. Do not claim independent verification until performed on a real device.
