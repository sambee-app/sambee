+++
title = "Recover Unsaved In-Browser Edits"
+++

Sambee can preserve eligible unsaved Markdown and plain-text edits when a required OIDC sign-in takes you away from the editor.

## When Sambee Saves A Draft

Sambee saves a tab-scoped recovery draft before a controlled sign-in redirect and while you continue editing. This protects work when the browser session expires, an administrator revokes the session, or the identity provider requires you to sign in again.

Drafts stay in the current browser tab. They are not uploaded to Sambee, shared with another browser, or shown after you sign in as a different account.

The pre-sign-in snapshot is a best-effort attempt. Sign-in continues even if a draft cannot be stored; it does not wait for unfinished editor input or save the file. Save important work regularly.

## Return To Your Edit

After you finish signing in, Sambee returns you to the file you were editing.

- When Sambee offers an unsaved local draft, choose **Resume editing** to return to it, or **Discard draft** to keep the saved file.
- If the remote file changed, review the recovery choice carefully. Sambee doesn't overwrite the remote version automatically.
- Save the restored draft when you're ready. Sambee removes its recovery copy once the current draft is saved or when you deliberately discard it. Edits made while an earlier save is still in progress remain unsaved.

## Recovery Limits

### Moved or Deleted Files

If the file or its folder is moved or deleted while you edit, keep the editor open. A directory refresh can open an accessible parent folder without closing the editor or changing its unsaved text.

Save from an active edit session can recreate a deleted file at its original path. It does not follow a moved file to its new location. SMB saves require the parent folder to exist; local-drive saves can recreate parent folders on an available drive.

A failed save keeps the draft. Use the available draft recovery or download action to keep your work. If editing becomes unavailable, use the explicit editing retry action and review any conflict before saving. Sambee does not silently acquire a new lock after a failed save.

Access errors and connection failures do not mean the file was deleted. Check access or restore the connection, then retry. Do not discard the draft unless you no longer need its changes.

A normal save can overwrite changes made at the same file path. Sambee does not check for all external changes before each write. If the write succeeds but updated file information cannot be read, the save remains successful; Sambee does not repeat the write automatically.

### Notifications and Connection Recovery

Recovery notifications appear at the bottom center of the application, not inside a browser pane. Informational results, including automatic parent-folder recovery, close after 6 seconds. Browser failures, pairing notices, monitoring failures, and connection status notices close after 10 seconds. Editor errors and safety warnings, including save failures, close after 15 seconds. The timer pauses while you point to the notification or use its controls with the keyboard. Closing a notification does not save a draft, restore a connection, or remove recovery data. Use Next notification when more than one condition needs attention.

File and folder failure notifications show the problem first. A smaller line below it identifies the connection and failed file or folder. Long paths are shortened to fit on one line, keeping the connection and the end of the path where space permits. Point to a shortened value to see the complete path from the connection's root. The full value also remains available to screen readers. The path identifies the failed target, not a different folder that you opened later. After automatic parent-folder recovery, this line still identifies the original missing folder.

Notifications stay open without a timer only while they provide Cancel for an active upload, download, or share preparation, or Share and Cancel for files ready to share. Sharing after confirmation uses the normal 6-second information timeout. A notification closing does not cancel an active operation. Unsaved-change and other decision dialogs do not close on a timer.

Retry applies to the file or folder that failed, even after you select another row or pane. A failed folder navigation keeps the previous usable folder visible. If no folder can load, the list area shows the error and recovery actions instead of an empty list. A folder that loaded with no files remains a normal empty folder.

Refresh reloads the displayed folder. It does not repeat a failed file launch or open a different failed folder. The existing header warning control opens connection recovery actions after a notification closes automatically or you close it manually. No additional warning or progress controls are added when a notification closes.

If automatic updates stop, use **Automatic updates stopped** to retry monitoring. This control remains available after you close its notification. Monitoring is active again only after the subscription is confirmed. A backend connection status distinguishes reconnection from unavailability. Companion recovery remains available through Local Drives, including when no editor is open. A signature error can require **Reload Sambee**. Unsaved changes still require your decision before reload.

If a document cannot load, its viewer shows the error with Retry and Close. A missing image in the gallery shows an error for that image; use Retry, select another image, or close the viewer. Sambee does not keep the previous document open until the next document finishes loading.

### Browser Storage

Draft recovery depends on browser tab storage. Sambee keeps recovery drafts only for a limited time and displays a warning when a draft is too large or the browser cannot store it. Save important work regularly; do not rely on draft recovery as a replacement for saving.

Closing the tab, explicitly discarding the draft, or signing out can remove the recovery copy.

An unfinished edit may not be recoverable when the browser suspends or terminates the page. A successful recovery checkpoint isn't a file save or a guarantee that the draft will survive closing the tab.
