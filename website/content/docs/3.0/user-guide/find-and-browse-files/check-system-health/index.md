+++
title = "Check System Health"
+++

When your administrator enables health monitoring for your role, Sambee shows a compact status indicator for backend resources and the storage locations open in your browser.

## Open System Health

- On desktop: Select the **System health** icon immediately to the right of **Settings** in the top toolbar.
- On phones and narrow screens: Select the main **Sambee** icon to open the navigation drawer, then select **System health** directly below **Settings**. The mobile toolbar does not show a separate health button.

Closing the dialog returns keyboard focus to the file list on desktop or to the main **Sambee** menu button on mobile.

## Health at a Glance

The dialog groups readings under **Server**, **Container**, and **Connection storage**. Connection storage warnings and errors appear first. Missing or old readings are marked separately; they do not mean that a resource is healthy.

Readings update automatically every 5 seconds while the dialog is open and the browser tab is visible.

Each reading has its own expandable row for capacity, check limits, and its data source. The current value appears only once.

**Load average (normalized)** shows the 5-minute load average divided by the logical CPU count, not CPU usage. Container **Memory** shows used bytes and a percentage of its memory limit. With no limit, the percentage uses total host memory when available; the details identify the basis. This host-based percentage does not trigger container memory alerts.

The desktop toolbar icon combines a monitor-and-pulse symbol with a status badge. The dialog and mobile menu use simple status icons. Their shapes show the state without color alone:

- Checkmark in a circle (**OK**): Monitored checks are within their configured limits. The summary states if some checks are unavailable.
- Exclamation mark in a triangle (**Warning**): At least one monitored resource reached its warning threshold.
- Exclamation mark in an octagon (**Error**): At least one monitored resource reached its error threshold or ran out of free space.
- Question mark in a circle (**Unknown**): No warning or error is active, and at least one required check is still collecting, unreachable, or showing old data.
- Letter **i** in a circle (**Informational**): The check is not required or has no applicable alert limits, for example CPU temperature without a supported sensor or container memory without a limit. It does not prevent an **OK** result.

## What Storage Is Checked

Sambee checks free space only for locations active in your current browser:

- Backend application data and temporary storage.
- The SMB connection open in the current pane (or both panes in dual-pane mode, without duplicates). Saved SMB connections that are not open are not queried.
- Local drives exposed by your paired Companion app on desktop.

**Storage: application data** and **Storage: temporary data** appear under **Container**. A shared filesystem uses one combined row. Drives and connections appear under **Connection storage**, with **Local drive** or **SMB connection** shown separately from the name. If Companion cannot provide drive information, a single **Local drives** row shows its status. When Companion is not connected or paired, this row is informational and does not prevent an **OK** result. Pairing errors and failed capacity checks still show **Unknown**.

Storage entries show free space and its percentage. On SMB shares and Windows local drives, this value includes enforced user quotas.

## Common Recovery Actions

- Low storage space: Delete unneeded files or choose another destination before starting uploads, copies, or archive extractions.
- **Update Companion to show drive space**: Install the current Companion release from **Settings** > **Local Drives**; file browsing continues to work while Companion is older.
- Old or unavailable backend data: Sambee retries automatically. If the backend remains unreachable, check your network connection or contact your administrator.
