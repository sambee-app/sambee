# Delete Files from Viewers

## Scope

Implement "delete from viewer" for Image, PDF, and Markdown preview mode only. Add a **Delete file** toolbar button and a `Del` shortcut. Both open the same confirmation for the file on screen. Cancel leaves the file and viewer unchanged. Do not add file deletion to Markdown edit mode.

**Link rule:** Delete removes the entry at the viewed path. If that entry is a link, remove the link itself. Never delete the target of a link, and never delete a directory.

After a successful delete:

- **PDF and Markdown:** Close the viewer.
- **Image:** Show the next image in the current gallery order. If there is no next image, show the previous image. Close the viewer only when no images remain. Do not wrap. The replacement image can load again.

Text files open directly in the Text Editor. Do not add file deletion to the Text Editor as part of this work. The cleanup of obsolete Text Viewer references is a separate change (see [TEXT_VIEWER_REFERENCES_CLEANUP_PLAN.md](TEXT_VIEWER_REFERENCES_CLEANUP_PLAN.md)).

A related Companion bug is a separate item (see section 4). Do it first, because the new Companion route reuses its path helper.

## 1. Add a File-Only Delete Operation

Reuse the storage registry, request routing, and write-access checks behind [`deleteContentItems`](../frontend/src/pages/FileBrowser/contentOperations.ts). Do not use the existing recursive delete operation for viewers. It can remove a directory and all its contents on both [SMB](../backend/app/storage/smb.py) and [Companion](../companion/src-tauri/src/server/handlers.rs).

The storage operation must apply the link rule in one step. It must not remove a directory, even if a directory replaces the file after the confirmation opens. A separate metadata check does not give this protection. Keep the existing File Browser file and folder deletion behavior unchanged (except for the Companion bug fix in section 4).

### Dedicated route on both backends

- Add a new route: `DELETE /api/browse/{connection_id}/file` in the [SMB browser API](../backend/app/api/browser.py) and `DELETE /api/browse/{drive}/file` in [Companion](../companion/src-tauri/src/server/mod.rs). Use the existing `empty-directory` routes as the pattern for the route shape and write-access check. Do not copy their error handling (see "Errors"). Do not copy the SMB `item` route's subtree monitor stop or directory-cache removal. The file route cannot remove a directory. If it rejects a directory at the target path, its monitors, subscriptions, and directory cache must stay intact. Refresh the parent listing after the removal as described in section 3.
- Do not add a mode parameter to the existing `item` route. Users install Companion separately, so it can be older than the web app. The only version check is the auth protocol version in [`companion.ts`](../frontend/src/services/companion.ts). Companion's `BrowseQuery` ignores query parameters that it does not know, so an older Companion would ignore a file-only parameter and delete a directory recursively. A new route makes an older server fail closed.
- Keep the existing drive or share boundaries, write-access check (`require_connection_write_access`), mutation-policy checks, and the share-root and drive-root refusals.
- **SMB:** Add a `remove_file` method to [`SMBBackend`](../backend/app/storage/smb.py) that calls `smbclient.remove`. It opens the target with `FILE_OPEN_REPARSE_POINT | FILE_NON_DIRECTORY_FILE`. Thus it removes a link itself, never its target, and it fails for a directory. No additional link check is necessary.
  - Run the call through `_run_blocking_smb_call(..., mutation_paths=(smb_path,))`, as `remove_empty_directory` does. Without `mutation_paths`, a timeout does not return `smb_mutation_uncertain`.
  - `smbclient.remove` does not raise `IsADirectoryError`, `FileNotFoundError`, or `PermissionError`, although its docstring says so. It raises `smbprotocol.exceptions.SMBOSError`, which is only an `OSError`. Translate the error with [`translate_smb_target_error`](../backend/app/storage/smb_errors.py) before the API maps it. Add `STATUS_FILE_IS_A_DIRECTORY → IsADirectoryError` to that translator. The translator has other callers in `smb.py`; check that this addition does not change their results, or add the mapping only in `remove_file`. Without this, a directory, a missing file, and "access denied" all become `file_unavailable` (503).
  - Treat `STATUS_DELETE_PENDING` as success, as the existing `delete_item` does.
- **Companion:** Use the parent-only path resolution from section 4: canonicalize the parent, check the drive boundary, and keep the final name unresolved. Do not use [`resolve_viewer_path`](../companion/src-tauri/src/server/handlers.rs) for the target, because it follows links. Apply `ensure_mutation_allowed` to the target. Call `std::fs::remove_file(parent/name)` through `run_observed_operation`, not the subtree variant. `remove_file` does not follow a final link and fails for a directory or a directory link. If the platform reports such a failure as a permission error, map it to `not_a_file` only if `symlink_metadata` on the unresolved path confirms a directory or a directory link.

### Errors

- Return structured error codes for the frontend. On SMB, use `file_target_http_error(error, requires_file=True)` from [`_smb_helpers.py`](../backend/app/api/_smb_helpers.py), and preserve `smb_mutation_uncertain` (409) when the outcome is unknown. Do not copy the error handling of the SMB `empty-directory` route; it returns plain strings and HTTP 500. On Companion, use the existing `map_file_io_error` in [`handlers.rs`](../companion/src-tauri/src/server/handlers.rs) and the codes in [`errors.rs`](../companion/src-tauri/src/server/errors.rs). Common codes include `item_not_found`, `not_a_file`, `file_access_denied`, `file_timeout`, and `file_unavailable`. Do not return a directory found at the path as a generic HTTP 500.
- An older Companion has no `file` route and returns 404 or 405 without an error `code`. For Companion connections only, the frontend treats a 404 or 405 without a `code` from this route as "Companion update required". Never fall back to the `item` route.
  - Do not apply this rule to SMB connections. The SMB API returns "Connection not found" as a 404 without a code.
  - Give every 404 from the new Companion handler a code. Map the errors locally in the new handler: `file_unavailable` for an unknown drive or an unavailable drive root, and `file_access_denied` for a boundary refusal. Do not change the responses of shared resolvers or existing routes. If the error cannot distinguish a missing file from an unavailable location, report the failure without claiming that the file is gone.

### Frontend operation

- Add a file-only `removeFile` operation to the storage backend contract in [`storageBackends.ts`](../frontend/src/services/storageBackends.ts) and a `deleteContentFile` function next to [`deleteContentItems`](../frontend/src/pages/FileBrowser/contentOperations.ts).
- Let `deleteContentFile` pass the original request error to the caller. Do not wrap it in a generic message such as `Content deletion failed: <status>`. The viewer needs the error code to show a specific message.

## 2. Add the Shared Viewer Action

- Let [`WorkspaceViewer`](../frontend/src/pages/FileBrowser/WorkspaceViewer.tsx) own the delete request for the resolved file. Do not use the browser selection or focused row to identify the target. Pass the action through [`DynamicViewer`](../frontend/src/components/FileBrowser/DynamicViewer.tsx) to the supported viewers. Reuse the action slot in [`ViewerControls`](../frontend/src/components/Viewer/ViewerControls.tsx).
- Reuse [`ConfirmDeleteDialog`](../frontend/src/components/FileBrowser/ConfirmDeleteDialog.tsx). When the dialog opens, capture the target: connection, path, pane, and the viewer selection key. Show the filename. Never change the target of an open confirmation.
- Use one predicate, "the captured target still matches the routed and displayed selection", for all stale-target checks:
  - Close an unconfirmed dialog when the predicate becomes false, including after browser Back or Forward.
  - Check it again immediately before sending the request, because route and selection updates are asynchronous. If it fails, send no request.
  - Apply the result (close the viewer or advance the gallery) only to the captured target.
- Prevent duplicate requests. Only a confirmed delete closes the viewer or advances the gallery. On failure, keep the same file open and show an actionable error in the confirmation.
- Do not offer deletion for read-only connections or archive members. Apply this rule to each displayed image, not only the image that opened the gallery. Physical files opened from search results can be deleted. The backend checks write access again at the storage boundary.
- Register `Del` in the [viewer shortcut system](../frontend/src/hooks/useKeyboardShortcuts.ts) and show it in shortcut help when applicable. Do not treat `Del` in CodeMirror, a search field, or a nested dialog as a file-delete request. The File Browser `Del` shortcut is already inactive while a viewer is open (`isBrowserBrowsing` in [`FileBrowser.tsx`](../frontend/src/pages/FileBrowser.tsx)). Keep it that way.

### Error display in the confirmation

- `ConfirmDeleteDialog` has no error area today. The File Browser shows delete errors at pane level. Add an optional `error` prop and show it inside the dialog (for example, an `Alert` above the actions). Clear the error when the user confirms again. Do not use toasts for this error, because toasts are not visible in browser fullscreen.
- Read error codes with the existing `getStorageErrorCode` and classify with `classifyFileFailure` in [`apiErrors.ts`](../frontend/src/utils/apiErrors.ts). Do not add separate response parsing. Add localized messages for viewer delete:

| Condition | Message | Behavior |
|---|---|---|
| `missing` | "Sambee could not find this file. Close the viewer and refresh the folder." | User can confirm again. |
| `not_file` | "This path is a folder, not a file. Sambee did not delete it. Refresh the folder." | User can confirm again. |
| `access_denied` | "You do not have permission to delete this file. Ask the share owner for write access." | User can confirm again. |
| `timeout` or `smb_mutation_uncertain` | "Sambee could not confirm the deletion. The file may already be deleted. Close the viewer and refresh the folder." | Detect `smb_mutation_uncertain` before the generic `unknown` mapping. Invalidate the parent listing. Block further delete attempts for this target in the current viewer session, because the first operation can still be running on the server. |
| `smb_recovery_busy` | "The SMB connection is recovering. Wait a moment, then try again." | The file was not deleted. User can confirm again. |
| Companion update required | "Update Sambee Companion to delete files from the viewer." | See section 1. |
| All other errors | "Sambee could not delete the file. Check the connection, then try again." | User can confirm again. |

Do not retry automatically and do not add a separate storage check.

### Confirmation in browser fullscreen

The browser shows only the fullscreen element and its descendants. MUI dialogs portal to `document.body` by default, so a confirmation opened in fullscreen is not visible. Do not exit fullscreen to show the confirmation.

- Add an optional `container` prop to [`ResponsiveDialogShell`](../frontend/src/components/Dialog/ResponsiveDialogShell.tsx). Pass it to both the MUI `Dialog` (desktop) and the `Drawer` (mobile). The default stays `document.body`, so other dialogs do not change.
- The viewer delete flow passes `() => document.fullscreenElement ?? document.body`. Resolve the container when the dialog opens.
  - PDF and Markdown make their own MUI Dialog root fullscreen. The confirmation then mounts inside that root.
  - The Image Viewer uses the yarl Fullscreen plugin, which makes the lightbox container fullscreen. The viewer toolbar is outside that container, so in image fullscreen only `Del` can start a delete. The confirmation then mounts inside the yarl container.
- If the user exits fullscreen while the confirmation is open, the portal target stays in the document and the confirmation stays visible.
- Scroll lock: MUI applies scroll lock to the container. Use `disableScrollLock` when the container is not `document.body`.
- Event isolation: React events bubble through the React tree, not the DOM tree. The confirmation belongs to `WorkspaceViewer`, so its key and pointer events do not reach yarl or the Image Viewer handlers. `ResponsiveDialogShell` also has its own shortcut scope. In fullscreen, the browser itself handles `Escape` and exits fullscreen; the confirmation stays open and the viewer does not close.
- Out of scope: the Markdown unsaved-changes dialog and `RecoveredDraftDialog` probably have the same fullscreen problem. They can use the new prop in a later change.

### Viewer-specific rules

- In the [Image Viewer](../frontend/src/components/Viewer/ImageViewer.tsx), disable deletion when the image on screen and the route refer to different files. The viewer can keep the previous image on screen while the next image loads.
- For Markdown, offer the Delete button and shortcut only in preview mode. Keep them unavailable during transitions between preview and edit mode. If an edit-mode transition starts before confirmation, close the confirmation.
- After confirmation, edit mode must not start for the target file until the result is handled. This includes browser Back or Forward to an edit URL for that file. Otherwise the editor can open the deleted file and a save can create it again.
  - Mechanism: [`useRoutedViewerEditing`](../frontend/src/hooks/useRoutedViewerEditing.tsx) already has a `loading` input. Its mode effect returns before it calls `enterEdit` or sets `attemptedMode` while `loading` is true. In [`MarkdownViewer`](../frontend/src/components/Viewer/MarkdownViewer.tsx), pass `loading || deletePending`. Do not add a new hook input. While the delete is pending, if the route requests edit mode, replace the route with view mode (`onModeChange("view", true)`). After a failed delete, the user can request Edit again. The Text Editor behavior does not change.

## 3. Update the Gallery, Route, and File List

### Gallery and route update

1. **Prune the gallery.** Add one function in [`useFileBrowserPane`](../frontend/src/pages/FileBrowser/useFileBrowserPane.ts) that removes the deleted path from `viewInfo.images` and `currentViewImagesRef` together. Select the next image, or the previous image if there is no next image. Update `path`, `currentIndex`, and the index used to restore focus. Keep `viewInfo.sessionId`. An image opened without a gallery has no replacement. Tab snapshots and close-focus logic use the pruned list.
2. **Replace the route.** Add one action in [`useWorkspaceNavigation`](../frontend/src/pages/FileBrowser/useWorkspaceNavigation.ts) that replaces the current route with the replacement image path. Apply the pane and route updates together so the viewer does not resolve an intermediate selection. Keep normal viewer Close and gallery navigation history unchanged.
   - Every close after a successful delete uses replace: the PDF and Markdown viewers, and the Image Viewer when no image remains. Today `closeViewer` always pushes a new entry. Add a `replace` option to it, and use the option only in the delete flow. Otherwise, Back opens the deleted file and shows the missing-file error.
   - The delete transition must not push a history entry or call `getInfo` for the deleted path. `gallerySelection` uses the fast path only if the routed path is in the gallery list.
3. **Reuse the existing gallery cache reset.** [`useCachedImageGallery`](../frontend/src/hooks/useCachedImageGallery.ts) starts a new cache session when the physical image list changes. Keep the position-based cache and let the replacement image load normally. Do not carry cache entries across sessions or change archive gallery behavior.
   - In [`ImageViewer`](../frontend/src/components/Viewer/ImageViewer.tsx), apply the new slides and selected index in the same render. A stale index can select the wrong image and push a history entry. Reset rotation and zoom even when the replacement has the same index as the deleted image. Release the deleted image's pin and never show it as a placeholder.
   - Preserve routed selection on Back and Forward. Do not treat the post-delete selection as user navigation. The counter, arrow keys, `Home`, `End`, and swipe use the pruned list.

### History after a delete

Replace only the current history entry. Older entries can still point to the deleted file. Example: open B, select **Next Image** to show C, then select **Previous Image** to show B. Delete B. The viewer shows C and replaces the latest B entry. Press browser Back twice to reach the original B entry. The app shows the existing missing-file message (`publishMissingPhysicalFile`). This is expected. Do not rewrite older history entries.

### File list

- Invalidate the affected parent directory in both panes with the existing [listing invalidation](../frontend/src/pages/FileBrowser/useFileBrowserPane.ts). If the user navigates away while the request is pending, still invalidate the directory, but do not change the new view. On close, restore focus to a surviving row or the file list.
- The physical gallery list is a snapshot and does not follow listing refreshes. The pane function in step 1 removes the deleted path from it.

## 4. Separate Item: Fix Companion Symlink Deletion in the File Browser

**Problem:** [`browse_delete`](../companion/src-tauri/src/server/handlers.rs) resolves the path with `resolve_safe_path`, which canonicalizes the full path and follows a final link. `symlink_metadata` then sees the link target, not the link. Thus deleting a file link removes the target file. Deleting a directory link calls `remove_dir_all` on the target directory and removes all of its contents. The SMB backend does not have this problem, because `smbclient` opens the path with `FILE_OPEN_REPARSE_POINT`.

**Fix:**

- Add one path helper for mutations of the final entry: canonicalize only the parent, check that the parent is inside the drive boundary, and return `parent/name` with the final name unresolved. Reject `.`, `..`, and empty final names. The new viewer `file` route (section 1) uses the same helper.
- In `browse_delete`, use this helper. If `symlink_metadata` reports a link (or a Windows reparse point, as `source_link_kind` already detects), remove only the link: `remove_file` for a file link, and the platform call for a directory link or junction (`remove_dir` on Windows). Never call `remove_dir_all` on a link. Keep the existing behavior for regular files and directories.
- Keep the drive-root refusal and `ensure_mutation_allowed`. Apply the observed-operation and subtree-monitor handling to the link path, not the target.
- Check other mutation routes that use `resolve_safe_path` on the final entry (for example, rename and move). Track any similar problem as a separate issue. Do not fix it in this change.

**Verification:** On Linux and Windows, delete a file link, a directory link, a broken link, and (on Windows) a junction through the File Browser. Verify that only the link is removed and that the target and its contents stay intact. Verify that regular file and directory deletion still work, and that a link that points outside the drive is removed without access to its target.

## Verification

Use the existing [URL routing tests](../frontend/src/pages/__tests__/FileBrowser-url-routing.test.tsx), [image viewer tests](../frontend/src/pages/__tests__/FileBrowser-image-viewer.test.tsx), viewer component tests, and backend and Companion route tests. Check each risk once:

| Risk | Check |
|---|---|
| Wrong item removed | On SMB and Companion, the `file` route deletes a regular file. It removes a link but not its target. It rejects a directory without touching its contents, monitors, or directory cache. It honors the boundary and write restrictions. File Browser folder deletion through the `item` route still works. |
| Uncertain SMB result | A timeout returns `smb_mutation_uncertain`. The viewer stays open, refreshes the parent listing, and blocks another delete for that target. `STATUS_DELETE_PENDING` counts as success. |
| Version skew | For Companion, a 404 or 405 without a code shows the update message and never calls the `item` route. An SMB 404 without a code does not show it. All 404s from the new Companion handler have a code. |
| Stale target | A confirmation closes when Back or Forward changes the selection, and a stale confirm sends no request. Duplicate submissions send one request. |
| Markdown edit race | With a confirmed request pending, Back or Forward to an edit URL starts no edit session and no save. After a failed delete, Edit works again. Edit mode has no Delete action, and `Del` there does not open a confirmation. |
| History | After a PDF or Markdown delete, Back does not open the deleted file. The B → C → B case in section 3 shows the expected missing-file message. |
| Gallery | Deleting a middle, last, or only image selects next, previous, or closes (with replace). The deleted image never shows during loading. Rotation and zoom reset. The counter, arrows, `Home`, `End`, and swipe skip the deleted image. There is no `getInfo` for the deleted path and no new history entry. `Del` is disabled during a pending image transition. Archive galleries keep their paging and cache. |
| Fullscreen | In PDF, Markdown, and Image fullscreen, `Del` opens a visible, usable confirmation. Keys and pointer drag in it do not change the image. The layout does not shift. The confirmation stays open when the browser exits fullscreen. |
| Errors | Each row of the error table shows its message and allows or blocks a new confirmation as specified. |

**Release checks:** Run the targeted tests, the backend and Companion tests for the new route, and the frontend type check. Use disposable fixtures to verify mobile confirmation, browser fullscreen, and focus restoration. Update the [keyboard shortcut guide](../website/content/docs/3.0/user-guide/find-and-browse-files/keyboard-navigation-and-shortcuts/index.md) and [viewer architecture guide](../website/content/docs/3.0/developer-guide/frontend-architecture/viewer-architecture-and-preview-contracts/index.md) when implementing the feature.
