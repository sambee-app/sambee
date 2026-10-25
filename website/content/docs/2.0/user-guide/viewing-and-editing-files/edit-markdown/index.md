+++
title = "Edit Markdown"
+++

Markdown files are opened in Sambee's [Markdown viewer](../view-images-and-read-documents/). From there, you can seamlessly switch to a full-fledged Markdown editor.

## Entering Edit Mode

In the Markdown viewer's toolbar, click the edit icon or press <kbd>E</kbd> to switch to the Markdown editor. You edit Markdown source directly, with highlighted structure and fenced code. Highlighting doesn't change your source text or line layout.

## Code Colors

Code blocks use the same language highlighting as the text viewer and editor. A fence's language label selects its grammar; unknown or unlabelled blocks remain plain text. Preview highlighting loads in the background and waits while you're selecting preview text. Code text, whitespace, copying, and search remain unchanged.

See [Syntax Highlighting Languages](../../reference/syntax-highlighting-languages/) for supported languages, accepted shortcodes, and a fenced-code example.

In **Settings** > **Appearance**, edit or copy a theme and open **Syntax** to adjust the shared keyword, string, number, comment, type, function, operator, and punctuation colors. The palette applies to text viewing/editing and Markdown source/code blocks. Identifiers keep the existing code text color. Changes stay local to the theme draft until saved; Cancel doesn't apply them. Only administrators can save site themes.

Existing complete themes without a Syntax group use the built-in palette matching their light or dark mode. Saving or exporting includes the resolved colors. Updated Sambee versions can import those legacy version-1 exports, but older releases may reject exports containing the new roles. Very large code blocks can remain plain text without truncating their contents.

## Large Documents

Large Markdown previews appear progressively. You can read the text already displayed or close the viewer while loading continues. Search, editing, heading links and the toolbar's Print action become available when the complete document is ready. Printing from the browser menu before then shows a loading notice instead of an incomplete document.

Large previews can briefly pause while loading, and code colors can arrive after the text. Large Replace All operations show busy feedback before applying the complete replacement, but the editor and indicator can pause during that step. Editing very large tables can also be slow. These limitations don't shorten the document or split a replacement into separate undo steps.

## Saving Changes

A small indicator next to the file name shows whether the document has unsaved changes. Click the save icon or press <kbd>Ctrl</kbd> + <kbd>S</kbd> at any time to save the current state of the document.

Finish any input-method composition before saving. Sambee waits for table-cell edits to reach the document before capturing the saved text. If that can't finish, the editor stays open with your changes rather than saving an incomplete cell. Retry Save after the edit finishes.

You can keep editing during an ordinary Save. Save writes the revision it captured; edits made afterward remain unsaved. If preparation or writing fails, your changes remain available in the editor.

If Sambee must send you through OIDC sign-in while you are editing, it saves an eligible unsaved Markdown draft in this browser tab before leaving the page. See [Recover Unsaved In-Browser Edits](../recover-unsaved-edits/) for how recovery works.

## Leaving Edit Mode

Click the X icon or press <kbd>Esc</kbd> to leave the Markdown editor and return to the viewer. If there are unsaved changes, choose **Save** to save them and return to the viewer, **Discard** to return without saving, or **Cancel** to keep editing. If saving fails, the editor stays open with your changes.

From the viewer, click the X icon again to return to the file list. The text editor uses the same two-step close sequence.

## Print Or Save As PDF

In the Markdown viewer, click the printer icon to open your browser's print dialog. Choose a printer or **Save as PDF** if your browser offers it. You can also use **Print** from the browser menu. Paper size, margins and headers/footers are controlled by that dialog.

The output contains the rendered document, without Sambee's toolbar or file browser. Text prints black on white in both themes. Long code lines and table cells wrap to fit the page, and images are included. Printing doesn't modify the Markdown file.

Print is available in the viewer, not the editor. To print your latest changes, save them and return to the viewer first. Closing or cancelling the print dialog leaves the viewer open.
