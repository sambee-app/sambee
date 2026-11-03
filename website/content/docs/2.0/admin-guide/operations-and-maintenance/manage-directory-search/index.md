+++
title = "Manage Directory Search"
+++

Use **Admin > Directory Search** to set resource limits for backend and Companion directory indexes. Backend changes take effect on live sources. Companion changes must be applied separately to each device.

## Resource Controls

The settings include storage, retention, cache, and verification controls, with help and allowed ranges beside each field. Start with the defaults and adjust them for the server or device capacity.

The disk budget and cache target are not hard disk or process-memory limits. Leave extra free space for background work. Lowering the budget can pause index growth; it does not trim active indexes.

## Apply the Policy to a Companion Device

Pairing alone does not approve resource settings. An administrator must apply the saved policy and approve it locally in Companion.

1. Sign in as an administrator on the device and verify pairing in **Settings > Local Drives**.
1. Select **Apply To This Companion** and approve the request in Companion.
1. Check that the policy is active in **Settings > Local Drives**.

Repeat this process for each device after a policy change. Other paired users can view status but cannot apply the policy.

The device must be able to reach the Sambee backend directly over HTTPS with a valid certificate. Redirects are not supported. HTTP is allowed only for a literal loopback address in development.

## Troubleshooting

If delivery fails, Companion keeps its last approved policy. Follow the displayed recovery action, then apply again. To change the backend owner, confirm an owner reset in native Companion Preferences first.

If index growth pauses, restore free disk space or increase the relevant disk budget.

Indexes are reused after a restart. Retained results remain unverified until background verification completes. A temporary disconnection keeps the index; restore source access to resume work.

SMB indexing stays within the configured share and folder. Storage mounted inside that share is included unless it is exposed through a redirect or reparse point. Local indexing does not cross mount boundaries.

Local fixed drives use a separate index when the volume serial or file-system UUID changes. Removable and unknown drives also start a new generation when the volume label, file-system type, or total capacity changes. Each volume at the same path can reuse its own retained index. Missing media pauses search without deleting the index. On Linux, mount the volume again; the empty mount-point folder is not a replacement source.

For supported platforms and database precautions, see [Directory-Search Databases](../../reference/companion-support-reference/#directory-search-databases). For backend storage configuration, see [Configuration File Reference](../../reference/configuration-file-reference/#directory-index-policy).
