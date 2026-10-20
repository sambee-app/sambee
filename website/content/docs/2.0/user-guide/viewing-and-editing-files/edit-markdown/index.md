+++
title = "Edit Markdown"
+++

Markdown files are opened in Sambee's [Markdown viewer](../view-images-and-read-documents/). From there, you can seamlessly switch to a full-fledged Markdown editor.

## Entering Edit Mode

In the Markdown viewer's toolbar, click the edit icon or press <kbd>E</kbd> to switch to the Markdown editor. You edit Markdown source directly, with highlighted structure and fenced code. Highlighting doesn't change your source text or line layout.

## Code Colors

Code blocks use the same language highlighting as the text viewer and editor. A fence's language label selects its grammar; unknown or unlabelled blocks remain plain text. Preview highlighting loads in the background and waits while you're selecting preview text. Code text, whitespace, copying, and search remain unchanged.

In **Settings** > **Appearance**, edit or copy a theme and open **Syntax** to adjust the shared keyword, string, number, comment, type, function, operator, and punctuation colors. The palette applies to text viewing/editing and Markdown source/code blocks. Identifiers keep the existing code text color. Changes stay local to the theme draft until saved; Cancel doesn't apply them. Only administrators can save site themes.

Existing complete themes without a Syntax group use the built-in palette matching their light or dark mode. Saving or exporting includes the resolved colors. Updated Sambee versions can import those legacy version-1 exports, but older releases may reject exports containing the new roles. Very large code blocks can remain plain text without truncating their contents.

## Saving Changes

A small indicator next to the file name shows whether the document has unsaved changes. Click the save icon or press <kbd>Ctrl</kbd> + <kbd>S</kbd> at any time to save the current state of the document.

If Sambee must send you through OIDC sign-in while you are editing, it saves an eligible unsaved Markdown draft in this browser tab before leaving the page. See [Recover Unsaved In-Browser Edits](../recover-unsaved-edits/) for how recovery works.

## Leaving Edit Mode

Click the X icon or press <kbd>Esc</kbd> to leave the Markdown editor and return to the viewer. If there are unsaved changes, choose **Save** to save them and return to the viewer, **Discard** to return without saving, or **Cancel** to keep editing. If saving fails, the editor stays open with your changes.

From the viewer, click the X icon again to return to the file list. The text editor uses the same two-step close sequence.
