# Directory Index Identity and Recovery Plan

## Status and Scope

The implementation is present for SMB directory indexing in the backend and local-drive directory indexing in the Companion on Linux and Windows. Host tests and Windows cross-compilation are available in this development environment. Windows-native acceptance remains open until the Windows CI tests pass.

The existing Windows verification workflow runs the native test suite. It includes serial-zero and 64-bit identity checks, a volume query-remove message test, and a system-volume hot-plug query test. Cross-compilation is not evidence that these runtime checks passed.

Interrupted candidates retain their generation, rows, and pending work. If the observation epoch changes, completed directory reads are revalidated in bounded batches before the candidate can establish fresh coverage.

Treat identity as supporting evidence, not proof of storage continuity. Search should remain available when identity metadata is missing, inconsistent, or synthetic. Such metadata must not cause repeated rebuilds or permanent exclusions.

The plan also covers index reuse after a backend restart, a Companion restart, and cache recreation.

## 1. Define the Guarantee

The index represents directory observations beneath a configured logical root.

The implementation must:

- Enforce the configured traversal boundary and current access controls.
- Detect changes where platform guarantees permit reliable detection.
- Track freshness separately from root identity.
- Avoid claims of physical-storage continuity or an atomic snapshot.

### Boundary Policy

- **SMB:** The source identity is the configured Sambee connection: connection ID, host, port, share, folder, and username. The server and storage behind these settings are not part of the identity. A share migration to another server, a server restart, or a storage change is an ordinary content change. Verification handles it.
- **SMB boundary:** The boundary is logical: the configured share and folder. Sambee does not promise physical-volume containment. A server can mount other storage inside a share without a reparse point. Such content is visible to the client and is indexed like other folders. Reparse points and redirects stay excluded.
- **Local storage:** The boundary is the configured root on its mount. Traversal does not cross into other mounts.

The user documentation must state this difference.

## 2. Use Each Signal Within Its Documented Scope

| Evidence | Permitted use |
| --- | --- |
| Held handles and supported no-follow traversal | Enforce containment and validate an active observation. |
| File IDs and mount IDs | Compare objects within one session (SMB: within one connection). See the identifier rules. |
| SMB session and tree IDs | Identify connection lifetime, not storage identity. |
| Directory timestamps, synthetic volume serials, optional object IDs | Do not use these alone to decide source replacement or force rebuilding. |
| Watcher events | Schedule work. The absence of events does not prove freshness. |

Ignore documented unavailable or non-unique identifier values. Do not treat every zero or unusual value as invalid without an API requirement.

### Identifier Rules

| Field | Rule |
| --- | --- |
| SMB file ID (64-bit) | `0` and `0xFFFFFFFFFFFFFFFF` mean "unavailable" (MS-FSCC). Use available values only for handle and ancestry checks within one connection. If unavailable, skip the file-ID comparison. Never use file IDs across connections. |
| SMB server GUID | Diagnostics only. Windows servers generate a new GUID at each start. |
| SMB volume serial, volume creation time | Accept any value. Use for diagnostics only. |
| SMB session ID, tree ID | Accept any value that the library returns. Compare only within one connection. |
| Linux device and inode, Windows 128-bit file ID | Use only for handle and ancestry checks within one Companion session. Never use them to decide a replacement. Do not apply SMB sentinel rules. Reject only values that the platform API documents as invalid. |
| Windows volume serial, Linux file-system UUID | Volume evidence for the rules below. On Windows, use the 64-bit `VolumeSerialNumber` from `FILE_ID_INFO` for all stored and compared serials. A serial of `0` is valid. A file system without a UUID has no value. |
| Volume label, file-system type, capacity | Volume evidence for removable drives only. Diagnostics for other drives. Capacity is the total size of the volume, not the free space. |
| Linux device number, Windows drive letter and volume GUID | Diagnostics only. |

The documentation does not guarantee file IDs across sessions. Support is file-system specific. On FAT, a file ID can change after a rename or a defragmentation. On NTFS, the root folder ID of a volume never changes. Thus, a root file ID cannot show a replacement.

### When to Create a New Index or Generation

**SMB:** Only a change of the connection settings in section 1 creates a new index. SMB servers do not supply identity evidence that is stable across restarts.

**Local storage:** The Companion classifies the drive that contains the configured root. Extend the existing classifier in `companion/src-tauri/src/server/drives.rs` with the checks below. The drive browser and the index use this one classifier.

| Class | Windows | Linux |
| --- | --- | --- |
| Fixed | `GetDriveTypeW` returns `DRIVE_FIXED`. The storage bus is not USB, SD, or MMC, and the device is not hot-pluggable. | The block device (or its parent disk) has `removable` set to `0`, and the bus is not USB, SD, or MMC. |
| Removable | `DRIVE_REMOVABLE` or `DRIVE_CDROM`. Also `DRIVE_FIXED` with a USB, SD, or MMC bus or a hot-plug device, for example an external USB disk. | `removable` is `1`, or the bus is USB, SD, or MMC. |
| Network | `DRIVE_REMOTE`. | A network file system, for example NFS or CIFS. |
| Virtual | `DRIVE_RAMDISK`. | FUSE cloud drives, as in the existing classifier. |
| Unknown | Classification fails. Apply the removable rules. | Same. |

On Windows, read the bus type with `IOCTL_STORAGE_QUERY_PROPERTY` and the hot-plug state with `IOCTL_STORAGE_GET_HOTPLUG_INFO`. On Linux, read sysfs and udev data for the block device of the mount. A query that fails gives the class "unknown".

Volume evidence is compared only when it is available in both the stored and the current values. A missing value is not a difference.

| Class | New index | New generation in the same index | Keep the index and verify |
| --- | --- | --- | --- |
| All local | The configured root path changes. | — | — |
| Fixed | The volume serial or file-system UUID changes. Only a format or a different volume at the same path does this. | — | All other changes, including the label. |
| Removable, unknown | The volume serial or file-system UUID changes. | The volume label, the file-system type, or the capacity changes. | All other changes. |
| Network, virtual | — | — | All changes. Only the configured root path counts, as for SMB. |

The volume serial or UUID is part of the index file name (see "Reuse After Restart"). Thus, each volume at the same path has its own index. A renamed removable drive gets a new generation. This is acceptable because removable drives are usually small.

The drive class is not part of the file name. A class change alone does not create a new index or generation. Apply the rules of the current class.

Read the volume evidence again at each re-bind of the root and at each change from unavailable to available. Apply the rules above, as when the index opens. A root file-ID mismatch with unchanged volume evidence causes re-binding and verification only.

On Linux, store whether the configured root is on a separate mount. If it was, and the root path is now on the parent file system, the volume is not mounted. Report the source as temporarily unavailable. Do not index the mount-point folder.

Classify each outcome as new index, new generation, keep and verify, temporarily unavailable, or unsupported capability. Only the first two mean that the storage changed.

## 3. Remove False-Positive Failure Paths

### SMB

- Remove the volume-serial and volume-creation-time comparison between a folder and its parent during traversal (`SmbDirectoryIdentity.same_volume`).
- Remove the comparison with the previous root-path binding after a reconnect (`stable_identity` and `_previous_binding` in `SmbDirectoryRoot.read`). After a reconnect, bind the new handles and schedule verification.
- A binding mismatch within one connection causes re-binding and verification, not a terminal error.

Apply the identifier rules in section 2 in `SmbDirectoryHandle.identity`.

Keep exact ancestry, handle, reparse-point, and redirect protections. Missing optional metadata must not exclude an otherwise safely readable folder.

### Linux

Retain descriptor-relative, no-follow traversal. Use unique mount IDs or `openat2` only where they improve a required check.

Feature detection must have a supported fallback. It must not create another compatibility requirement.

Fix these classifications:

- `NotFound` and `NotADirectory` during traversal mean "possibly missing", not "unsafe traversal". Use the validated absence check in section 6.
- If `STATX_MNT_ID` is unavailable, detect mount points with another documented method, for example mount IDs from `name_to_handle_at`. A device-number comparison alone is not sufficient, because it does not detect bind mounts.
- If no method can detect mount points, stop only that source. Report that the kernel cannot check mount boundaries. Do not say that the filesystem is unsupported. Do not retry until the Companion restarts.

### Windows

Retain full file IDs, held handles, and ancestry checks within one session. Do not add a mandatory volume-GUID check.

A drive-letter or metadata change alone must not trigger rebuilding.

Fix these conflicts with section 2:

- `directory_traversal_windows.rs` rejects a volume serial of `0`. Accept it.
- `directory_index.rs` compares the 32-bit `dwVolumeSerialNumber`. Use the 64-bit serial from `FILE_ID_INFO`, as traversal does.

### Removable Media

Open handles block safe removal on Windows and unmounting on Linux.

- Release all held root and ancestor handles of a removable or unknown drive when its source has no active scan, query, or watcher. Open them again when work starts.
- On Windows, register for device notifications on the volume handle. On `DBT_DEVICEQUERYREMOVE`, stop work, release all handles, and report the source as temporarily unavailable.
- If the media is removed during a scan, invalidate the unfinished reads. Keep the index. Report the source as temporarily unavailable.

### Capability Failures

An unsupported identity query is not an unsupported traversal operation.

If safe traversal itself cannot be established, limit the affected scope and explain that specific limitation. Do not repeatedly retry a permanent capability gap.

## 4. Recover Without Rebuilding by Default

| Situation | Response |
| --- | --- |
| Optional metadata changes or is unavailable | Continue using supported checks. Do not rebuild. |
| Temporary disconnection | Pause affected work and retry with backoff. |
| Reconnect or monitoring gap | Invalidate unfinished observations and schedule bounded verification. |
| SMB server, share location, or storage changes behind unchanged connection settings | Keep observations, label them unverified, and schedule bounded verification. |
| Local differences that section 2 lists as "keep and verify" | Keep observations, label them unverified, and schedule bounded verification. |
| Local volume change that section 2 lists as a new generation | Start a new generation automatically. Retire the old generation. Verify the new root. Do not require user action. |
| Removable media is not present, or a Linux volume is not mounted | Temporarily unavailable. Keep the index and pause work. |
| Configuration change | Use a different index (see "Reuse After Restart"). |
| Confirmed index corruption | Repair derived data where possible. Rebuild only when necessary. |

A reconnect must not automatically discard the catalogue or restart a complete scan. Reuse completed observations subject to freshness and publication rules. Read interrupted work again.

Within a scan, a failed identity comparison should first cause bounded re-observation. Persistent ambiguity must not create an endless scan, discard, and restart loop.

Recovery must not reset the whole connection, interrupt unrelated file operations, or remove recent-directory history.

### Reuse After Restart

A backend restart, a Companion restart, or cache recreation must reuse the existing index. Today, the backend and the Companion put a random runtime session ID into the index file name. Thus each restart builds a new index.

- Derive the index file name only from the source kind and the boundary settings:
  - **SMB:** connection ID, host, port, share, folder, and username.
  - **Local:** root path. For fixed, removable, and unknown drives, also the volume serial or file-system UUID when available. Each volume at the same path thus has its own index, and swapping volumes reuses each index. Existing retention and pressure cleanup limit the number of index files.
  - **Local network and virtual drives:** root path only.
- The file name is a SHA-256 hash of these values. It must not contain host names, user names, paths, or serials in clear text.
- Do not include the runtime session ID or the connection edit time. A password change or a display-name change must not create a new index.
- Keep the runtime session ID for diagnostics, epochs, and jitter only.
- When the index opens, apply the existing schema and integrity checks.
- **SMB:** Reuse the index when the connection settings match. Do not store or compare server or storage identity.
- **Local:** Store the drive class and the volume evidence in the index metadata. When the index opens, compare them with the current values. Use the rules in section 2. Do not store or compare file IDs.
- Do not trust the stored verification time. Label reused observations unverified until a verification pass completes.
- The existing source lease continues to allow only one owner for each index.
- Existing index files with session-based names are not reused. Existing orphan cleanup removes them.

## 5. Bound Storage Work

Both runtimes already have a scan coordinator, request coalescing, retry gates, backoff, and jitter. Do not replace them. Compare them with the rules below. Change only what is missing.

- Combine duplicate requests and verify affected directories before expanding scope.
- Limit concurrent reads, metadata requests, work per interval, and retries.
- Cache unsupported-capability results for an appropriate lifetime.
- Preserve completed verification progress across interruptions where valid.
- Use incremental verification passes instead of repeatedly starting at the root.
- Set minimum spacing between automatic full passes. Search requests must not bypass it.
- Schedule another pass only when evidence or freshness policy requires it, not merely because the previous pass was incomplete.

Keep limits centrally defined. Measure requests, directories revisited, scan restarts, and storage time so the performance cost can be tested.

## 6. Preserve Useful Search Without Misstating Freshness

A low-confidence signal must not blank the entire index.

Keep usable observations under the stale-result policy without labelling them freshly verified. Never bypass current access checks or mix observations across generations.

Local failures should affect the smallest justified scope. Failed reads are not proof that a directory was deleted. Remove entries only after a successful, validated absence check. A root on a different volume than the index records is never evidence of absence.

Show users only meaningful states, such as updating, temporarily unavailable, or limited results. Keep identity details and recovery reasons in diagnostic logs.

Replace user messages that conflict with this plan. Examples:

- "Reconnect the source to rebuild its directory index" (backend).
- "Use a supported local filesystem" for a missing mount-ID capability (Companion).

## 7. Implement and Verify in Stages

1. Fix the known SMB incompatibility. Add regression tests. Apply all SMB changes in section 3 and the SMB identifier rules in section 2.
2. Separate failure reasons and recovery decisions. Add the local drive classification and the volume-evidence rules in section 2. Remove file-ID based replacement decisions. Apply the Linux and Windows fixes and the removable-media rules in section 3. Prevent uncertain metadata from causing source replacement, terminal failures, or rebuild loops.
3. Reuse the index after a restart, as specified in section 4.
4. Close the gaps in the existing verification scheduling (section 5). Test request counts, retained progress, retry limits, and event coalescing.
5. Review native hardening. Add platform mechanisms only where they improve a stated guarantee without reducing compatibility.
6. Update user messages and documentation. Describe boundaries, freshness, recovery, restart reuse, drive classes, separate indexes for each volume, missing-media behavior, and performance limits.

Tests must cover:

- Safe folders with inconsistent metadata.
- Unavailable identifiers and unsupported optional identity queries.
- Repeated reconnects and monitoring gaps.
- Root path and other configuration changes.
- SMB server change, share migration, and changed root file IDs with unchanged connection settings.
- Drive classification: fixed, removable, external USB disk reported as fixed, network, virtual, and failed queries (unknown). A class change alone keeps the index.
- Fixed drive: a label, capacity, or file-system type change keeps the generation. A volume serial or UUID change uses a different index.
- Removable drive: a label, capacity, or file-system type change starts a new generation. Swapping volumes at the same path reuses the index of each volume, also while the Companion runs. Missing media pauses work and keeps the index.
- Removable media: handles are released when idle, a removal request releases all handles, and a removal during a scan keeps the index.
- Linux: an unmounted volume at the configured root is temporarily unavailable. The mount-point folder is not indexed, and no rows are pruned.
- Windows: a volume serial of `0`, and the 64-bit serial in all comparisons.
- Missing volume evidence in the stored or current values.
- Restart with a changed root file ID, a changed device number, and a changed drive letter or volume GUID. All keep the index.
- Password-only and display-name-only connection changes.
- Interrupted scans and retained verification progress.
- Access failures and validated absence checks.
- Old workers that finish after a source change.
- Request counts, retry bounds, and minimum spacing between full passes.
- Supported traversal fallbacks and unsupported safety capabilities.

Run relevant backend, Companion, and frontend tests.

Windows-native tests must run on a Windows host or a Windows CI runner. This development environment cannot run them. Until they pass, the Windows acceptance criteria stay open. Cross-compilation alone is not sufficient.

## Acceptance Criteria

Each criterion must have an automated test. Limits refer to the central constants from section 5.

- A folder with a different volume serial or volume creation time than its parent is indexed without an issue.
- After a reconnect where only optional metadata changes, the index keeps its generation and rows. No new full pass starts before the minimum full-pass spacing.
- A restart reuses the index when section 2 does not require a new index or generation. Results are labelled unverified until verification completes.
- For SMB, only a change of the connection settings in section 1 creates a new index. A server change or share migration keeps the index and runs verification.
- A fixed drive uses a different index only after a volume serial or UUID change. A file-ID, label, metadata, or drive-class change keeps the index and generation.
- A removable drive starts a new generation after a label, file-system type, or capacity change. A different removable volume at the same path uses its own index.
- An idle removable source holds no handles. A removal request succeeds while the Companion runs.
- An unmounted Linux volume does not cause pruning or indexing of the mount-point folder.
- A new generation starts exactly once for each volume change. Search never returns rows from the old generation after that.
- A missing safety capability stops only the affected source. The message names the capability.
- Request counts, retries, and full passes in the test stay within the central limits.
- Search status does not claim freshness that has not been established.

A difference that section 2 does not list as a new index or generation is not a reason to create one.
