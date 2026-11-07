+++
title = "Manage Directory Search"
+++

Use **Admin > Directory Search** to set resource limits for backend and Companion directory indexes. Backend changes take effect on live sources. Paired browsers deliver saved Companion policy automatically while an authenticated session is active.

## Resource Controls

The settings include storage, retention, cache, and verification controls, with help and allowed ranges beside each field. Start with the defaults and adjust them for the server or device capacity.

The disk budget and cache target are not hard disk or process-memory limits. Leave extra free space for background work. Lowering the budget can pause index growth; it does not trim active indexes.

## Companion Policy Delivery

Pairing authorizes settings delivery. The most recently paired server manages Companion settings. Pairing that server again also selects it as authority. Other paired servers keep their file-access pairing but cannot replace managed settings.

All active, authenticated users can deliver the saved canonical policy. Only administrators can edit it. There is no separate policy approval or Apply action.

**Settings > Local Drives** shows the settings authority and separate synchronization states for directory policy, theme, and localization. Checks run after pairing, login, reconnect, persisted changes, and periodically while a tab is visible. A theme or localization change does not revise or reapply unchanged directory policy.

The device must reach the Sambee backend directly over HTTPS with a valid certificate. Redirects are not supported. HTTP is allowed only for loopback development origins.

## Troubleshooting

If delivery fails, Companion keeps the last valid value for each section, or built-in defaults before the first delivery. Directory search remains available. Follow the displayed recovery action and use **Retry**. Update both applications when status reports an incompatible settings protocol.

To change authority, pair the intended server again. Unpairing the authoritative origin clears authority and keeps the last valid settings; Companion does not select another paired server automatically. For older installations with several pairings and no usable policy binding, pair the intended server again to establish authority.

If index growth pauses, restore free disk space or increase the relevant disk budget.

Indexes are reused after a restart. Retained results remain unverified until background verification completes. A temporary disconnection keeps the index; restore source access to resume work.

### SMB Verification and Recovery

The backend waits up to 10 seconds for directory notifications before its first source check and scan. If notification setup fails or times out, verification starts without monitoring and watcher retries continue. If monitoring becomes ready later, verification safely retries reads made before that transition. No cache reset is needed.

Retained results become searchable after a valid source-root check, even while full verification continues. An unavailable root temporarily blocks search without deleting the index. Restore the source connection or permissions and let background recovery continue.

Directory changes normally retry only affected parents. Completed quiet branches remain available, and background work gives both existing results and full verification time to progress. A parent that changes during its read is deferred for at least one second. A full pass may remain incomplete while directories keep changing. To confirm complete coverage, allow a quiet period and check the verification time.

A denied folder, failed directory safety check, or unsupported name does not stop verification of readable folders. A completed pass can have partial coverage and a verification time. It does not mean that every eligible folder was read. Failed folders are checked at the next regular verification. Restore their permissions or correct unsupported names to improve coverage. A failed incremental read keeps stored descendants until a later check can confirm a change.

Status messages show active conditions. A local retry alone does not mean that the source is unavailable. Follow a displayed storage, access, or monitoring recovery action. Retry delays account for both scan gates and watcher retries; a longer failure backoff can delay scan work beyond the one-second change retry. Repeated searches and status checks do not shorten that delay.

### Source Boundaries

SMB indexing stays within the configured share and folder. Storage mounted inside that share is included unless it is exposed through a redirect or reparse point. Local indexing does not cross mount boundaries.

Junctions, symbolic links, and other redirected descendants are not followed. They are intentional exclusions, not indexing failures: they do not reduce coverage or appear in status details. Source-root and opened-parent safety checks remain strict. A directory that changes into a redirect during a read cannot publish children.

Local fixed drives use a separate index when the volume serial or file-system UUID changes. Removable and unknown drives also start a new generation when the volume label, file-system type, or total capacity changes. Each volume at the same path can reuse its own retained index. Missing media pauses search without deleting the index. On Linux, mount the volume again; the empty mount-point folder is not a replacement source.

For supported platforms and database precautions, see [Directory-Search Databases](../../reference/companion-support-reference/#directory-search-databases). For backend storage configuration, see [Configuration File Reference](../../reference/configuration-file-reference/#directory-index-policy).
