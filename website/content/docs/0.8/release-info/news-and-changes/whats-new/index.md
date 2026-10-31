+++
title = "What's New"
+++

## Quick Bar: UX

The [quick bar](../../../user-guide/find-and-browse-files/smart-navigation-and-the-quick-bar/) is Sambee's main navigation element. It sits in the top bar above the file list and is designed to be the single point of control for directory navigation, file list filtering, and command lookup and execution.

Previously, those three functions were not clearly distinguished. The three modes are now separated more distinctly, and the current mode is shown directly in the quick bar through a dedicated button. This makes the feature easier to discover and also allows users to switch modes with the mouse or by touch (in addition to the existing keyboard shortcuts).

In addition, several bugs were fixed to improve the overall experience.

## Companion: More Secure Pairing & Communication Flows

This release makes Sambee Companion connections more secure, from the first pairing step through ongoing communication during local-drive access and desktop editing.

**Pairing** is now tracked per Sambee site instead of through one global paired state. Pending approvals can be cancelled cleanly, and the browser now shows clearer states when Companion is unavailable, waiting for local approval, needs repair, or has lost its editing session.

Sambee also now trusts only the specific Sambee site you approved, limits what the local Companion service exposes, and uses narrower one-task-at-a-time edit credentials behind the scenes.

**Native editing** is also more resilient. Sambee now uses tighter, task-specific edit permissions, renews long-running edit sessions when needed, and returns you to the browser with a clearer next step if sign-in, lock ownership, or recovery fails, instead of leaving you stuck with a vague error.

## File Opening: Speed & Flexibility

When opening files for previewing or editing, you want quick previews, but you also want the ability to choose which app a file is opened in. Both paths are now efficiently available:

Open files in Sambee's browser-based viewers:

- Click a file or press <kbd>Enter</kbd> to open it in Sambee's associated viewer.
- If no associated viewer exists, or if you press <kbd>Shift + Enter</kbd>, a viewer picker dialog appears.
   - The picker lets you choose a Sambee browser viewer or a native app.

Open files in natively installed apps:

- Press <kbd>Ctrl + Enter</kbd> to open a file in its associated native app, or right-click it and select **Open in Native App**.
- If no associated native app has been chosen, or if you press <kbd>Ctrl + Alt + Enter</kbd>, an app picker dialog appears.

## Markdown Editor: Strategy Change

The WYSIWYG Markdown editor is gone for a simple reason: UX. There is no open-source rich-text (WYSIWYG) Markdown editor that provides a great user experience. The previous editor was not up to the task.

The better option is CodeMirror, one of the best available editors, configured for Markdown. It provides a first-rate editing experience and battle-tested add-ons for many of the quality-of-life features people have come to expect from modern editors.

### Interactive Markdown Table Editing

Editing Markdown in a text editor works well for headings and lists, but tables are different. Markdown table syntax is unwieldy, especially when inserting a column in the middle, and the source is difficult to scan. Tables need an interactive WYSIWYG interface that looks and feels like a spreadsheet application. Sambee provides exactly that.

## Text File Viewer and Editor

Since we already have an excellent text editor (see the Markdown Editor note), we might as well put it to good use as a generic text file editor. Sambee can now open, display, and edit any kind of text-based file, with all the bells and whistles of a first-rate editor, for example syntax highlighting.

## Miscellaneous

### Home Screen

- Added a help button next to the settings (gear) icon.

### File List

- Increased the font size on mobile.

### PDF Viewer

- Intra-document links now work correctly, e.g. from a table of contents.

### Under the Hood

- Major dependency upgrades across the board, including React 19 and MUI 9.
- Improved suspend, resume, and reload resilience.

## Internals

### Documentation System

Sambee has a best-in-class documentation system that deduplicates content, inheriting unchanged text copy through versions. This enables us to provide complete and accurate docs for each product version while minimizing maintenance effort.

This release adds a docs reporting and visualization tool that creates an HTML report of every docs book, section, and page, including its properties, such as whether it is inherited or branched. The report also has a diff view that highlights changes between any two document versions.

Docs editor tool improvements include:

- UI improvements, including better help output.
- New commands to convert pages between inherited and independent: `page materialize` and `page inherit`.
- A test and validation suite that also runs in CI.
