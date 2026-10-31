+++
title = "Recover Unsaved In-Browser Edits"
+++

Sambee can preserve eligible unsaved Markdown and plain-text edits when a required OIDC sign-in takes you away from the editor.

## When Sambee Saves A Draft

Sambee saves a tab-scoped recovery draft before a controlled sign-in redirect and while you continue editing. This protects work when the browser session expires, an administrator revokes the session, or the identity provider requires you to sign in again.

Drafts stay in the current browser tab. They are not uploaded to Sambee, shared with another browser, or shown after you sign in as a different account.

## Return To Your Edit

After you finish signing in, Sambee returns you to the file you were editing.

- If the remote file has not changed, Sambee restores your unsaved draft in the editor.
- If the remote file changed, Sambee shows a recovery choice and does not overwrite the remote version automatically.
- Save the restored draft when you are ready. Sambee removes its recovery copy after a successful save or when you deliberately discard it.

## Recovery Limits

Draft recovery depends on browser tab storage. Sambee keeps recovery drafts only for a limited time and displays a warning when a draft is too large or the browser cannot store it. Save important work regularly; do not rely on draft recovery as a replacement for saving.

Closing the tab, explicitly discarding the draft, or signing out can remove the recovery copy.

