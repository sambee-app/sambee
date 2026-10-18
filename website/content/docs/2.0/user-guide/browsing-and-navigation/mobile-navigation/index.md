+++
title = "Mobile Navigation"
+++

Sambee is designed and optimized for phones and tablets as well as for desktops. Because each platform has different strengths, the mobile experience differs from the desktop experience in some cases.

## Where Mobile Excels

Mobile is a good fit when you want to:

- Explore network shares made available through Sambee.
- View images, read PDFs, and edit Markdown files.
- Share content from file servers on mobile platforms.

## What Changes on Mobile

Compared with desktop, mobile navigation is more compact:

- The interface focuses on single-pane navigation.
- Toolbar space is tighter.
- Some desktop-oriented browser controls are simplified or moved behind menus.
- Opening files in natively installed apps is not available.
- Local drive access is not available.

## Back, Forward, and Bookmarks

Opening a file, entering its editor, moving between gallery images, and navigating settings update the browser address. You can bookmark or share that address on desktop or mobile. The recipient still needs access to the connection and file; local-drive links also need a paired companion with that drive available.

Use browser Back to retrace your steps: editing to viewing, viewing to the file list, or one settings category to the previous one. Forward reopens those locations. Reopening an editor checks access and obtains a new edit lock.

If you have unsaved edits, Back or another navigation asks you to **Save**, **Discard**, or **Cancel**. Cancel keeps your draft and current location. A failed save keeps you in the editor. Your browser can also warn before reloading or closing a tab with unsaved edits.

Settings **Close** returns to the underlying file browser even after several category changes. The mobile settings back arrow follows your settings history. When you opened a bookmark directly, these controls use an in-app parent instead of sending you to an unrelated page. Resizing between phone and desktop layouts keeps the selected settings category.

Refreshing a bookmark restores its requested location, not a different workspace saved earlier in the tab. A missing file or unavailable connection offers recovery actions rather than silently opening another file.

## Share Files and Text

On a phone, use **Share** in a file's action menu, or select several files and choose **Share** from the selection menu. Sambee prepares the stored files first. When they're ready, tap **Share** to open your device's share sheet. Multiple files are submitted together; Sambee doesn't silently drop files or retry a smaller selection.

Image and PDF viewers have a sharing icon in the top bar. They share the resource you're viewing, including a compatible converted image or normalized PDF when needed. An image's extension matches the shared format. PDF sharing includes the whole displayed document, not just the visible page. Sharing from the file list instead uses the stored files without viewer conversions.

In text and Markdown viewers and editors, the same sharing icon opens two choices:

- **Share as file** shares the saved file without saving your edits first.
- **Share as text** shares the loaded text or your current editor contents, including unsaved changes. Markdown is shared as source text, not rendered HTML.

The file choice shows a preparation indicator while its attachment loads. You can still share text independently of that preparation.

Sharing availability and accepted attachment types depend on your browser and device. A browser can reject an attachment even after its capability check succeeds. Sambee won't silently replace a rejected attachment with text; choose **Share as text** explicitly where available.

### If Sharing Fails

When a prepared attachment can't be shared, use **Download** and try sharing it from your device's Files app. For failed image/PDF viewer sharing, this recovery download uses the same displayed resource. Ordinary download controls keep their existing behavior. For several files, download each prepared file in turn. If attachment preparation fails, text and Markdown viewers offer **Retry** without automatically opening the share sheet.

Choose **Details** in sharing-failure feedback to open a diagnostic report. The copy icon copies the report; if clipboard access isn't available, select the report to copy it manually. The report excludes file names, paths, shared text, file contents, and credentials. Sambee doesn't upload it automatically. Closing Details keeps the failure feedback and its recovery actions available.

Cancelling the native share sheet doesn't show an error. Completion of the browser's share request doesn't confirm what a receiving app received.
