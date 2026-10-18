+++
title = "What's New"
+++

## ⚠️ Action Required

Sambee's GitHub repository was moved to an organization account. This makes it necessary that you update the Docker Compose image URL to `ghcr.io/sambee-app/sambee` in your Docker Compose file (see the [Docker deployment docs](../../../admin-guide/installation-and-deployment/deploy-sambee-with-docker/) for details).

## Theme Editor

UI themes are an integral part of an app's visual presentation. As so often, flexibility is key. Some like it dark, others colorful, some require high-contrast, others prefer muted colors.

Sambee now has a multi-layer theme system. It differentiates between built-in themes, site-wide themes which only admins can manage, and users' personal themes. Any user can modify existing themes for their own use; admins can also provide themes for other users on the same Sambee server and designate a default theme for new users.

With Sambee's new theme editor, users can change all theme colors via hex values or the integrated RGBA color picker (which covers transparency in addition to color). Themes can be imported and exported, too.

## File List

### Mouse Selection on Desktop

Previous versions of Sambee introduced multi-selection for mobile users and keyboard aficionados on desktop. Mouse coverage was lacking. That has been rectified now: Selecting multiple files with a mouse is now straightforward. Click a file or folder icon to select it, then Shift-click another icon to add everything in between without losing your earlier selections. The pane's status bar keeps the count in view.

### Other Changes

- Native mobile sharing is now available for single or multiple files from the file list.
- Single-file downloads are now streamed directly without buffering in memory. This speeds up downloads and effectively removes limits imposed by file size.
- Item selection keyboard shortcuts now include <kbd>Shift+Home</kbd> and <kbd>Shift+End</kbd>.

### Bugfixes

#### File Copy/Move Fixes

- Uploads and copy or move operations no longer interfere with each other's conflict decisions.
- Moving files between SMB connections no longer leaves the original in place when it should have been deleted.
- SMB moves now protect the source from concurrent edits and renames, preventing deletion of changes that weren't copied.
- Overwriting an existing SMB file now replaces it atomically instead of failing.
- Cancelling a move after copying finishes, but before source deletion starts, now correctly reports that both copies were kept.
- Transfer results now show when a file was copied or replaced, even if removing or checking the original fails.
- When transferring a folder, a problem with one file no longer hides files already copied, moved, or replaced from the summary.
- Interrupted SMB moves now release files safely, without leaving them open or interrupting work still in progress.
- Pressing Enter after a transfer finishes no longer starts the same transfer again.

#### Other Fixes

- Invalid file browser URLs no longer break the page or prevent the other pane from loading.
- Overlapping download requests were allowed.
- A failed background connection refresh no longer hides a recovered file listing.
- Renaming a file to a name that differed by case only failed on local drive connections.

## OpenID Connect (OIDC)

### Refresh Token & `offline_access` Are Now Optional

Many identity providers require the `offline_access` scope to issue refresh tokens, but some (like OneLogin) rejects that scope in the authorization code flow and can issue a refresh token without it when refresh tokens are enabled for the app.

Sambee uses a provider refresh token when one is returned, whether or not `offline_access` was requested. If no refresh token is returned, Sambee can continue issuing short-lived API tokens from the browser session for up to 8 hours by default (configurable from 1 to 24 hours). After Sambee's user session expires, the user must sign in through the identity provider again.

### Other Changes

- When an OIDC login is necessary, all Sambee browser tabs switch to the login page. After a successful login in one tab, that tab now broadcasts a login complete hint. When other tabs on the login page receive that hint, they return to their respectice previous URLs.

### Bugfixes

- OIDC login failures after password reset: OIDC login now completes reliably after an administrator resets the account’s password. Sambee ignores responses from the previous browser session while the new login finishes, reloads the user’s themes and settings, and returns to the file browser instead of the login page.

## Miscellaneous

### Native Mobile Sharing

Consolidated the native mobile sharing implementation across the file list and image, PDF, text, and Markdown viewers and editors. When sharing fails, a dialog with details can be invoked to facilitate issue reporting.

Text and Markdown viewers/editors now have an option to share the current content as text as an alternative to sharing the stored file. This helps circumvent Chrome restrictions that prevent sharing file types such as Markdown.

Image and PDF viewers alway share the displayed content, which may have been normalized for viewing in the browser.

### Full Browser History Navigation

Every navigation step is now encoded in the URL and recorded in browser history. This enables browser back/forward navigation across the entire Sambee workspace, including the file list, viewers, and editors.

### Local Drive Acess

Sambee now checks local-drive access before saying the browser is ready to use Companion. If the check fails, Local Drives settings distinguish between an outdated Companion, an outdated Sambee page, and a pairing that needs to be restored.

When Companion rejects a request while browsing a local drive, the file list points to the affected pane and offers a way to reload Sambee or open Local Drives, depending on what went wrong.

### Unencrypted HTTP Support

Sambee now deals with unencrypted HTTP explicitly:

- Companion pairing and operations are unavailable.
- File copying caused a `crypto.randomUUID` error. This has been fixed by implementing a fallback.
- File uploading would show `outcome uncertain` and not upload files on HTTP/1.1 connections (even over HTTPS). This has been fixed by sending files directly instead of using a streamed request body, so uploads work on HTTP/1.1 while still showing progress.
- Copying to the clipboard (used in Settings) is now disabled.

HTTP for development on `localhost` is treated as secure by browsers and continues to be supported by Sambee.

### Supported Browser Detection

If your browser is too old or lacks features Sambee needs, you'll now see a clear message instead of a blank page. The message identifies missing capabilities and links to the browser requirements so you can choose a supported browser.

### Text and Markdown Editors

Closing the editor by clicking the X now works in the same way as pressing <kbd>Esc</kbd>: it returns to the viewer. From there, another click returns to the file list.

### Password Login

- When an admin configures a user to require a password change, that change is now enforced upon the next password login.
- Local usernames are now evaluated case-insensitively.
- The password field got an option to reveal the password.

### Settings

- User Management: Table column content could overflow into the next row. This was fixes with a comprehensive layout revision.

## Under the Hood

### Security Review

- OIDC login now binds the callback and login grant to the browser that started the login flow, preventing a grant from being redeemed in another browser.
- Only admins can list and download uploaded mobile logs; signed-in users can still upload logs for troubleshooting.
- Companion requests now use signatures tied to the HTTP method and requested URL, so a signature can't be reused for another request.
- Mobile log uploads have a size limit, and stored logs are pruned when they exceed the storage budget.
- HTML, XHTML, and SVG files, including archive members, download instead of running as active content in the viewer.

### Other Changes

- The backend's Python environment was upgraded from 3.13 to 3.14.
- Fixed the container startup warning: `AuthlibDeprecationWarning: The httpx module is deprecated; please use httpx2 instead.`

### Dependency Security

- Updated all **dependencies** with known issues or vulnerabilities to fixed versions.
- Pinned all third-party GitHub Actions workflows to commit SHAs.
- Frontend: removed `patch-package` to get rid of vulnerable transisitve dependency `braces`.

## Internals

- Companion build for Windows: Authenticode signing was removed from PR check builds and only remains on release workflows.
- GitHub Actions: replaced `pull_request_target` as it will be removed on public repositories by default in November.
- GitHub Actions: cache retention optimization.
