+++
title = "Work with ZIP Archives"
+++

## Look Inside a ZIP

Open a ZIP as a virtual folder on an SMB share or paired local drive. Browse its directories and preview supported files inside it without extracting the whole archive. Read-only access is enough for inspection. Local archives require [Companion](../../use-local-drives-and-desktop-apps/access-local-drives/); SMB archives do not.

Sambee cannot preview or extract encrypted members or members with unsupported compression. These members appear in lighter text; hover over a row to see its reason. Use another archive tool, with the password for encrypted members, to access them.

## Download Selected Contents

Select archive members or folders and choose **Download** to get a new ZIP containing those items. A selected folder includes its contents. This does not create an archive in storage. See [download limits](../download-and-upload-files/#download-limits).

## Extract Selected Members

On desktop, open the ZIP in the active pane and a writable physical folder in the other pane. Select members and press **F5** to extract them there. Selected directories include all their contents and empty directories. Archive members cannot be moved; **F6** is unavailable and does not modify the ZIP.

Extraction continues for readable members inside a selected folder. The completion notice reports skipped members and gives separate counts for encryption and unsupported compression.

Extraction can leave partial results after failure or cancellation. Inspect the destination before retrying; see [transfer recovery](../../troubleshooting/common-user-problems/#cannot-complete-a-transfer).

## Create an Archive in Storage

Unlike a generated download, **Create archive** writes a persistent ZIP into the destination folder. For files selected inside a ZIP, open a writable physical folder on the **same SMB connection** in the other pane, then choose **Create archive**. Creating an archive from ZIP members is not available for local-drive or mixed-connection destinations.

For ordinary stored files or folders, select the source items and choose **Create archive** with a writable physical destination. Source items must belong to one connection. The action is unavailable for unsupported source or destination combinations; a ZIP virtual folder cannot be the destination.

Cancellation or failure can leave partial results. Inspect the destination and the final operation status before retrying.
