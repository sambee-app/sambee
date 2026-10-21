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

Draft recovery depends on browser tab storage. Sambee keeps recovery drafts only for a limited time and displays a warning when a draft is too large or the browser cannot store it. Save important work regularly; do not rely on draft recovery as a replacement for saving.

Closing the tab, explicitly discarding the draft, or signing out can remove the recovery copy.

An unfinished edit may not be recoverable when the browser suspends or terminates the page. A successful recovery checkpoint isn't a file save or a guarantee that the draft will survive closing the tab.

