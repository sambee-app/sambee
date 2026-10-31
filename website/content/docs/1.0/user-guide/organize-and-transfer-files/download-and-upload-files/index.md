+++
title = "Download and Upload Files"
+++

Use **Download** to save a file to your computer. Select a folder or several items in the same directory to download them together as `Sambee-download.zip`. The ZIP preserves the selected folders and their contents. Downloads don't create a ZIP in the source share or drive.

Download is available from the file browser toolbar and the compact item or selection menu. You can also select members or folders inside a ZIP stored on an SMB share or a paired local drive and download them as a new ZIP.

For persistent archive creation and extraction, see [Work with ZIP Archives](../work-with-zip-archives/).

## Upload Files and Folders

Open a writable folder in an SMB share or paired local drive. On desktop, choose **Upload** (or press `Ctrl` + `U`), then choose **Files** for one or more files or **Folder** for one folder. On a compact screen, use the **+** menu to choose **Upload files** or **Upload folder** directly. Folder selection depends on your browser; when it isn't supported, **Upload files** remains available. A folder picker may not return an empty folder, but dragging that folder into the browser can preserve it in supported browsers.

You can also drag files and folders from your computer onto a file list. The drop cue names the connection and current folder receiving them. In dual-pane mode, drop onto the pane you want; dropping on a file or folder row still targets that pane's current folder, not the row. If drops aren't supported by your browser or the destination isn't writable, use the upload picker instead.

Uploaded folders keep their names and internal structure. If a folder with the same name already exists, Sambee merges into it without removing files already there. If a file blocks a folder, or a folder blocks a file, you can skip or rename the incoming item; a folder isn't overwritten. Individual file conflicts can be skipped, renamed, or replaced.

Files upload one at a time. The progress notice shows the current file and path, and the final notice reports completed, skipped, failed, or uncertain results and folder counts. Cancelling or failing partway through doesn't undo files or folders already created. If a folder upload has an uncertain outcome, Sambee stops the remaining transfers; inspect the destination before trying again.

See [transfer recovery](../../troubleshooting/common-user-problems/#cannot-complete-a-transfer) before retrying a partial or uncertain upload.

## Download Limits

Selected-item ZIPs are prepared in private temporary storage and removed after the download finishes or is cancelled. The default ZIP size limit is 250 MiB; administrators can change it in Advanced Settings. Local ZIP-member downloads also require the selected members' uncompressed data to fit this limit. A download exceeding the limit fails without leaving a partial ZIP in your share or drive. Single-file downloads are separate from this ZIP limit.
