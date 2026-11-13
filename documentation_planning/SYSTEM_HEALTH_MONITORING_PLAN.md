# System Health Monitoring Plan

## Status and Scope

This is a proposal for a new feature, not documentation of an implemented feature. Thresholds, intervals, and interfaces below are proposed implementation values.

The agreed scope is:

- Monitor the Sambee backend host.
- Monitor system load, memory, one CPU thermal summary, and filesystem space. Do not collect or display host or container CPU usage or CPU percentages.
- Obtain the current CPU thermal reading and its hardware-specific or kernel thermal-policy limits from the host kernel interfaces. Support Intel, AMD, and Raspberry Pi sources where the required interface is available. Do not maintain CPU-model limit tables or use fixed Celsius defaults.
- Display normalized Linux system load for 1, 5, and 15 minutes only. Use the normalized 5-minute value for warning and error evaluation.
- Show free space for local drives on this browser's paired Companion.
- Show free space only for SMB connections active in this browser. In a dual-pane layout, include both connections and remove duplicates.
- Do not check every saved SMB connection.
- Provide optional read-only Linux host mounts. Keep deployments without those mounts working, with clear coverage limits.
- Include editable thresholds for memory, system load, and free space in the first release. Default CPU temperature thresholds to detected limits; allow admins to override either threshold or supply one that cannot be detected. Detected host limits remain read-only.
- Enable monitoring by default. Show health information to admins by default. Permit admins to select Admins, Editors, or Both.
- Keep metric samples and recent evaluation state in RAM only. Persist settings, not metrics.
- On mobile, place the health indicator directly below Settings in the navigation drawer opened with the main Sambee icon. Do not add a health button to the mobile toolbar.

## Assessment

The small indicator and detail dialog fit a file browser. They keep routine health information out of the file list and let the user inspect a problem when needed.

Three changes to the initial idea are important:

1. Separate health severity from data availability. OK, Warning, and Error cannot describe a check that has not run, has failed, or has old data.
1. Identify the source of each reading. Host memory, container memory, an SMB share, and a local drive are different resources.
1. Use sustained thresholds and recovery margins. A short memory-pressure spike must not cause repeated changes between OK and Warning.

This feature is a resource-health view. It is not a full availability-monitoring system. A failed backend cannot report its own current health. The browser must show an unavailable or old-data state, and external monitoring remains necessary for outage alerts.

## Repository Findings

These findings describe the repository when this plan was prepared:

- [The health endpoint](../backend/app/main.py) exposes `/api/health`, which returns a fixed healthy response. The Docker health check uses it. Keep this liveness contract separate from resource monitoring.
- [Application lifespan](../backend/app/main.py) owns startup and shutdown. It is the integration point for a bounded host sampler.
- [The system settings service](../backend/app/services/system_settings.py) already reads cgroup memory limits. This is prior art, not a complete host-memory collector.
- [The settings model](../backend/app/models/system_settings.py) provides the persisted settings table. Use the existing settings service, validation, single-field update conventions, and redacted Public Support Report export in [the system settings service](../backend/app/services/system_settings.py).
- [Connection access rules](../backend/app/services/connection_access.py) define connection visibility. Filter results before aggregation as well as before returning details.
- [The SMB pool](../backend/app/storage/smb_pool.py) keeps connection-context-specific caches. Capacity reads must retain this credential boundary.
- [The SMB backend](../backend/app/storage/smb.py) aborts pooled transports (`abort=True`) when standard operations time out. Capacity probes must retain worker ownership on timeout without aborting a shared connection used by active file operations.
- The pinned `smbprotocol` 1.17.0 library provides `smbclient.stat_volume()`. It returns total size, caller-available size, and actual-available size. No new SMB dependency is needed.
- [Companion drive models](../companion/src-tauri/src/server/models.rs) expose drive identity, name, and type, but no free-space data.
- [Companion drive discovery](../companion/src-tauri/src/server/drives.rs) re-enumerates drives on each path lookup (its path registry is test-only) and stubs `volume_evidence` outside Linux and Windows. Add a small production drive-root map populated during `enumerate_drives()` and share one `#[cfg(unix)]` `statvfs` helper across Linux and macOS alongside Windows `GetDiskFreeSpaceExW`.
- [Desktop toolbar actions](../frontend/src/components/FileBrowser/DesktopToolbarActions.tsx) provide the insertion point immediately after Settings.
- [The mobile toolbar](../frontend/src/components/FileBrowser/MobileToolbar.tsx) uses the main Sambee icon to open the navigation drawer. Keep this toolbar unchanged.
- [The mobile navigation drawer](../frontend/src/components/Mobile/HamburgerMenu.tsx) contains Settings followed by Documentation. Insert the health indicator as a selectable System health row directly below Settings and above Documentation.
- Settings navigation, lazy page loaders, translations, and the shared responsive dialog need coordinated updates.
- The release was 2.1.4 when this plan was prepared. The applicable documentation tree for this feature is [version 3.0](../website/content/docs/3.0/), which inherits from version 2.1.

## Read-Only Mount Feasibility

### Native Linux Docker

Read-only mounts can expose the necessary interfaces without a privileged container, host PID mode, or Docker socket.

| Metric | Host source | Important limit |
| --- | --- | --- |
| Memory usage | `/proc/meminfo` | Use `MemAvailable`, not just `MemFree`. Keep container-limit metrics separate. |
| System load | `/proc/loadavg` and host logical CPU inventory from `/proc/cpuinfo` | Divide each 1-, 5-, and 15-minute load by the host logical CPU count. Display only the normalized values. CPU count is normalization metadata, not a usage metric. Load also includes some tasks waiting for I/O. |
| CPU temperature | Recognized Intel/AMD hwmon package/control channel or a verified Raspberry Pi CPU thermal zone, resolved into the mounted host sysfs tree | Read the current value and that source's limits. Keep hardware limits, kernel policy trip points, and admin overrides distinct. Do not infer limits from CPU model names or unrelated thermal zones. |
| Application filesystem space | The mounted application data and temporary paths | This describes those filesystems, not every disk on the physical host. |

Proposed deployment interface:

- Container memory monitoring needs no extra mounts in a normal Docker installation: Docker exposes Sambee's own container cgroup at `/sys/fs/cgroup` (`memory.max`, `memory.current`, `memory.stat`) with world-readable permissions for the non-root `sambee` user.
- Provide four optional read-only host mounts for Linux host metrics: `/proc/meminfo:/host/proc/meminfo:ro`, `/proc/loadavg:/host/proc/loadavg:ro`, `/proc/cpuinfo:/host/proc/cpuinfo:ro`, and `/sys:/host/sys:ro` (or narrower validated sensor-device mounts where practical).
- Limit proc-file inputs to memory, load, and host CPU inventory. Do not read CPU-time counters or calculate CPU percentages.
- Do not mount `/var/run` (Docker socket), `/var/lib/docker` (root-only), `/:/rootfs`, `/dev/disk`, or the full host `/proc`.
- Do not replace the container's own `/proc` or `/sys` (for example, `/sys:/sys:ro` hides the container's private `/sys/fs/cgroup` view).
- Do not add host mounts to the default deployment automatically.
- Use explicit bind mounts that do not create missing host paths.
- Validate read-only behavior, including nested mounts, on supported Docker/kernel versions.
- Resolve sensor links within the mounted `/host/sys` tree. A mount of `/sys/class/hwmon` alone can leave links to `/sys/devices` unresolved.
- Raspberry Pi support uses the host CPU thermal zone and board identity below `/host/sys/class/thermal/` and `/host/sys/firmware/devicetree/base/` (exposed by `/sys:/host/sys:ro`, bypassing Docker's `tmpfs` mask on `/sys/firmware`). Narrow sysfs mounts must include these paths and their required link targets.
- Read only known metric attributes. Never write sensor limits or fan controls.

This is interface-level feasibility, not a hardware test. The proposed host mounts and sensors have not been tested on a native Linux deployment.

### Limits

- A VM can report only the sensors and resources that it receives.
- Docker Desktop runs the Linux engine in a VM. Linux proc/sys mounts do not guarantee access to the physical Windows or macOS host.
- A read-only mount prevents writes but still exposes host information. Keep the mounted data as small as practical.
- Missing temperature sensors cannot be fixed by a mount alone.
- Recognize CPU package/control channels by their documented kernel-driver interface, or verify the Raspberry Pi board and its CPU thermal-zone type. Do not call an arbitrary hwmon or thermal-zone reading "CPU temperature."
- Show unsupported sensors as Not available. If a previously working sensor disappears, show a collection problem.
- A reading without a trustworthy source must not be presented as confirmed physical-host data.

## Proposed User Experience

### Indicator

- On desktop, use the Settings gear's size and inherited foreground color. In the mobile drawer, match the adjacent Settings row's icon size, color, spacing, and touch-target treatment.
- Use different shapes for OK, Warning, Error, and Unknown. Do not rely on color.
- Place the desktop button immediately to the right of Settings.
- On mobile, show a selectable System health row directly below Settings in the navigation drawer opened with the main Sambee icon. Put the status-shaped indicator in the row's icon position and show the current status as readable text.
- Do not add a separate mobile-toolbar indicator, Sambee-icon badge, or duplicate entry in the settings drawer.
- Include an accessible label and tooltip, for example "System health: Warning. One storage volume has low free space."
- Open the same responsive detail dialog with mouse, touch, or keyboard.
- When the mobile System health row is selected, close the navigation drawer and open the health details dialog. Coordinate the drawer and dialog focus handling so they do not compete; return focus to the main Sambee icon after the dialog closes.
- Do not flash, show repeated toast messages, or announce each numeric update.
- Respect existing dual-pane keyboard and focus rules.
- Hide the indicator and stop feature requests when monitoring is disabled or the user is not permitted to read it.

### Details Dialog

Use `ResponsiveDialogShell`. Keep the initial view small and readable:

1. Show a summary with current severity, coverage, and last update.
1. Show backend-host memory, system load, and one CPU thermal summary with its selected source, detected limits, effective thresholds, and any admin overrides.
1. Show backend-runtime container memory limits and working-set usage (`max(0, memory.current - inactive_file)`), where available, clearly separate from host values.
1. Show storage for application data/temp filesystems, active SMB connections, and local drives on this device.

For each metric, show value, unit, threshold, source, age, status, and a short action when needed. For storage, show available bytes and percent, not percent alone.

Show normalized system load as three labeled values: 1 minute, 5 minutes, and 15 minutes. Do not display additional raw load values. Show the host logical CPU count as source metadata, and identify the 5-minute value as the value used for warning/error evaluation.

Example: "SMB Media: 4% available, 18 GiB. Error threshold: 5%. Free space or select another location."

Keep unsupported, permission-denied, offline, timeout, and old-data cases distinct. Keep the last reading with its timestamp after a failure, but never present it as current.

Optional unsupported metrics do not create a permanent warning. State "Available checks are OK; temperature is not available" rather than claiming that the whole host is healthy.

The aggregate uses only resources this user may see. A known Error remains visible even if another check is Unknown; show a separate incomplete-coverage notice. With no known fault but missing required current data, show Unknown rather than OK.

Provide a Close action. A retry can refresh the cached state or request one bounded check, but must not bypass rate limits.

### Settings

Add Administration > Health Monitoring with:

- Enable health monitoring, with a default of On.
- Show health information to, with options Admins, Editors, and Both, and a default of Admins.
- Warning and error thresholds for memory, normalized 5-minute load, and free space. The 1- and 15-minute load values are informational and have no separate thresholds.
- Show detected CPU temperature limits as read-only values, including their availability and source. For each recognized package/control source, let admins independently choose Automatic or an override for Warning and Error. A manual value can replace a detected limit or fill a missing one.
- Store temperature overrides against stable source identity, not a changing hwmon or thermal-zone index. Provide a return-to-Automatic action per threshold. Never write host sensor limits or trip points.
- Clear units and descriptions, including whether a high or low value triggers the condition.

Keep settings management admin-only, even if the display audience is Editors. Viewers remain excluded. Enforce display permission in the backend, not only in the UI.

Follow the existing settings pattern: immediate valid field commits, one in-flight write per field, field-specific errors, and no page-level Save button.

Store and transmit numeric thresholds as exact scaled integers to match `IntegerSystemSettingDefinition` and avoid IEEE-754 binary floating-point step errors: tenths of a percentage point (`1..1000` for memory and `0..999` for available space), hundredths (`>= 1`) for normalized load, and integer millidegrees in `100`-millidegree steps for `0.1 °C` temperature overrides. Represent per-source CPU overrides as discriminated `StrictSettingUpdate` variants (`cpu_temp_warning_override` and `cpu_temp_error_override`) carrying `{ source_id, value_millidegrees }` (`null` restores `Automatic`). Accept `source_id` only when it matches a currently discovered CPU source or an existing persisted override row so arbitrary keys cannot create unbounded database rows. Include `[ui_configuration.health_monitoring]` in `build_public_support_report_read()`, aliasing any CPU `source_id` values through `PublicSupportReportAliases`.

Validate threshold pairs transactionally. Tell the user when a change would cross the other threshold and which value to change first. Reject non-finite, out-of-range, or wrongly ordered values. Apply these validation rules:

| Setting | Valid values | Pair ordering |
| --- | --- | --- |
| Host and container memory | 0.1–100.0% in 0.1 percentage-point steps (`1..1000` tenths of a percent). | Warning ≤ Error. |
| Normalized load | Finite and at least 0.01, in 0.01 steps (`>= 1` hundredth). Do not set an arbitrary upper bound; normalized load can exceed 1.0. | Warning ≤ Error. |
| Available space | 0.0–99.9% in 0.1 percentage-point steps (`0..999` tenths of a percent). | Warning ≥ Error. |
| CPU temperature override | Finite Celsius-scale values in 0.1-degree steps, stored and transmitted as integer millidegrees divisible by `100`. Reject values outside the safe integer range. Do not impose a universal hardware limit. | When both effective values are available, Warning ≤ Error. |

Equality is valid for each pair; Error takes precedence at the shared boundary. A CPU threshold may be set while the other effective threshold is unavailable. A manual temperature value above its detected limit remains valid but shows the warning described below. Never silently round an input with excess precision.

The positive lower bounds for memory and load thresholds and the 99.9% upper bound for available-space settings keep recovery possible within each metric's value range.

## Metric Policy

These are proposed starting values, not universal hardware limits:

| Metric | Warning | Error | Evaluation |
| --- | --- | --- | --- |
| Host memory | At least 85% used | At least 95% used | Based on available memory; enter Warning or Error after the corresponding condition remains true for 60 seconds. |
| Container memory | At least 85% of container cgroup limit | At least 95% of container cgroup limit | Show separately; evaluate working-set memory (`max(0, memory.current - inactive_file)`) with the same 60-second entry period as host memory. Without a finite container cgroup limit, show working-set bytes only and do not apply percentage thresholds. |
| Normalized load | At least 0.75 | At least 0.9 | Evaluate only the normalized 5-minute value. Apply crossings on the first successful 5-second host sample; the 5-minute average already smooths short spikes. Display normalized 1-, 5-, and 15-minute values, without raw load values. Load describes runnable tasks and some I/O waits, not a utilization percentage. |
| CPU temperature | Valid same-source high limit or an admin warning override | Valid same-source critical limit or an admin error override | For hwmon, use the channel's valid `tempN_max` and `tempN_crit`; for Raspberry Pi, use the lowest valid passive/hot trip below the selected critical trip, when present, and the lowest valid critical trip. Evaluate Warning after two consecutive successful samples and Error immediately. Show one CPU summary with detected values and effective thresholds separately. Missing limits remain unavailable unless an admin supplies them; never guess a default. |
| Available space | At most 10% | At most 5% | Apply Warning and Error from one successful storage reading; available bytes of zero gives Error immediately. Recovery requires two consecutive successful readings. |

For high-trigger metrics, enter Error at or above its threshold and Warning at or above its threshold, with Error taking precedence. For available space, enter Error at or below its threshold and Warning at or below its threshold, with Error taking precedence. Threshold equality is therefore well-defined.

Keep a valid CPU reading visible when a detected limit is missing. Evaluate only the available, valid effective thresholds and show incomplete coverage. If neither a detected threshold nor an override is available, show the reading as informational with "Temperature limits are not available. An administrator can set monitoring thresholds." Do not classify it as OK. An override cannot provide a missing temperature reading.

Container memory-limit and working-set handling:

- Read only Sambee's own container cgroup (`/sys/fs/cgroup/memory.max`, `memory.current`, and `memory.stat`, with cgroup v1 `memory.limit_in_bytes`, `memory.usage_in_bytes`, and `total_inactive_file` fallback). Do not traverse parent cgroups or treat a standard Docker private cgroup namespace (`0::/`) as a collection failure.
- Calculate container memory usage as working-set bytes: `max(0, memory.current - inactive_file)` (falling back to raw usage only if `inactive_file` is absent). Excluding reclaimable file cache prevents normal file streaming, SQLite directory indexing, image conversion, and PDF caching from triggering false alerts.
- When `memory.max` is `"max"` (or above the cgroup v1 unlimited sentinel), show working-set bytes and "No memory limit configured." Do not calculate a container-memory percentage or apply the warning/error percentage thresholds.
- Treat the confirmed absence of a finite container limit as informational, not Warning, Error, or a collection failure. Exclude the unevaluated container percentage from the aggregate severity.
- Continue host-memory monitoring independently. Never substitute host RAM as the container limit.
- If the container's own cgroup files cannot be read or parsed, show Unknown with the reason. Do not label failed detection as unlimited or "No memory limit configured."

Use central constants for defaults and units. Keep sampling intervals fixed in the first release to avoid extra configuration:

- Use a host sample interval of 5 seconds.
- Refresh the browser summary every 15 seconds while visible; an open dialog can refresh every 5 seconds. These requests return the current RAM snapshot immediately without blocking on a host sample or storage probe.
- Use a storage refresh interval of 60 seconds per source, shared across eligible clients for the same source. Pass at most two active `connection_ids` (single or dual pane; reject more than two with `422`) on snapshot reads, check `can_view_connection` on every request, and schedule one non-blocking background probe only when an accessible source has no cached entry or its entry is at least 60 seconds old (and is not in flight or in backoff).
- Keep storage collection separate from the 5-second host sampler. Stagger storage probes rather than checking all volumes at once, allow at most two storage probes in flight per backend process and per Companion process, limit new SMB probe triggers per user (for example, at most 4 per 60 seconds), and cap the SMB capacity cache with a bounded LRU (for example, 32 entries). No background SMB polling loop runs when no eligible visible browser requests snapshots.
- Deduplicate simultaneous requests and apply retry backoff after errors. Opening the dialog, retrying, or switching between cached connections must not bypass the storage interval or create a probe burst.
- Mark host data as old after 15 seconds without a successful sample.
- Mark storage data as old after 180 seconds without a successful check.
- Use explicit recovery boundaries to avoid status flapping. For a high-trigger pair with Warning `W`, Error `E`, and margin `m`, use `max(0, W - m)` to clear Warning and `max(W, E - m)` to clear Error to Warning. For available space, use `min(100, W + m)` to clear Warning and `min(W, E + m)` to clear Error to Warning. A value that passes both applicable clear boundaries can move directly from Error to OK; otherwise Error can recover to Warning first. For high-trigger metrics, clear Warning at or below its boundary and Error strictly below its boundary. For available space, clear Warning at or above its boundary and Error strictly above its boundary. This strict Error comparison prevents recovery and re-entry at the same value when Warning and Error thresholds are equal.
- Use margins of 5 percentage points for host/container memory, 2 percentage points for space, and 0.1 for normalized load. For CPU temperature, use valid same-source hardware or kernel hysteresis on Automatic thresholds when present; when hardware hysteresis is absent (such as Intel `coretemp`) or an admin override is active, use a fixed `2.0 °C` (`2000` millidegree) margin with the same high-trigger formulas (`max(0, W - 2000)` and `max(W, E - 2000)`). These formulas keep boundaries ordered even when valid thresholds are close or equal; do not reject a pair because its gap is smaller than a margin.

Apply the thresholds and recovery rules with these state transitions:

- From OK, enter Error if the Error condition is met; otherwise enter Warning if the Warning condition is met.
- From Warning, enter Error if the Error condition is met. Otherwise remain Warning until its recovery condition is met, then enter OK.
- From Error, remain Error until its recovery condition is met. Then enter Warning unless the Warning recovery condition is also met, in which case enter OK directly.
- A missing or stale current reading is Unknown. Keep the last reading and severity marked as old data, and do not advance breach or recovery counters.

The per-metric entry and recovery timing above applies to these transitions. In particular, memory uses its 60-second conditions, load uses first-sample entry and two-sample recovery, storage uses first-reading entry and two-reading recovery, and temperature uses the source-specific sample rules.

- For host and container memory, require the threshold condition to remain clear for 60 seconds before recovery. For normalized load, require two consecutive successful host samples beyond the applicable recovery boundary. For storage, require two consecutive successful readings beyond the applicable recovery boundary. Show a recovery-pending state in details. Missing or stale data is never evidence of recovery.
- For automatic CPU temperature thresholds, use valid same-source recovery boundaries where provided. For manual overrides or missing valid hardware recovery boundaries, apply the `2.0 °C` (`2000` millidegree) high-trigger recovery boundaries (`max(0, W - 2000)` to clear Warning at or below the boundary, and `max(W, E - 2000)` to clear Error strictly below the boundary) after two consecutive successful samples. Missing data is not recovery. An Error can recover to Warning before Warning recovers to OK.
- Do not delay current critical-temperature crossings with a long sustained-breach delay. Do not treat latched historical alarm bits as current crossings.
- Re-evaluate current samples after threshold changes. Do not reuse elapsed breach time under an old policy.

Test the exact boundaries, initial collection state, and threshold transitions. If the host logical CPU count cannot be read or is invalid, show normalized load as Unknown; do not display raw load or invent a denominator.

Linux normally supplies a positive logical CPU count. Missing or unreadable host proc mounts and restricted proc visibility are realistic collection failures in containers, not a normal zero-CPU state. Keep the single Unknown rule above; no raw-load fallback or additional CPU discovery system is needed.

Percent-only disk thresholds are a simple first version, but imperfect for very small and very large volumes. Display bytes to give context. Per-volume byte thresholds can be later work rather than expanding the first settings page.

## Collection and Data Flow

### Backend Host

Create one process-owned host sampler integrated with application lifespan. The production container currently uses one worker. Keep the latest snapshot and only the bounded recent state needed for sustained evaluation.

Use the Linux proc/sys interfaces for the agreed Docker scope; no new Python monitoring dependency is required for this approach. Reuse or extract existing cgroup helpers where correct. Do not hide host readings behind container-limit fallbacks.

Collect host memory, the three normalized system-load values, and recognized CPU package/control readings on the host sample interval. Read the kernel's three raw load values only as calculation inputs; do not expose them as additional API metrics or display fields. Collect application filesystem space on the separate storage interval. Read cgroup memory limits and usage separately. CPU inventory is needed only to normalize load; do not add CPU-time sampling, CPU usage fields, CPU usage thresholds, or container CPU accounting.

Keep finite, confirmed unlimited (`"max"`), and unknown container memory-limit states distinct in the collector and API using Sambee's own `/sys/fs/cgroup` files (`memory.max`, `memory.current`, `memory.stat`). Do not walk parent cgroups.

Report expected source failures explicitly. One failed metric must not stop other collectors or application startup. Log state changes without metric values or repeated poll errors.

### CPU Temperature Collection

Use Linux hwmon and, for verified Raspberry Pi CPU sources, thermal-zone attributes through the optional read-only host sysfs mount. The kernel driver, not Sambee, handles processor-specific sensor registers, calibration, and offsets. Detect source limits automatically, then apply any admin monitoring override without changing the host.

#### Discovery and Source Scope

1. Enumerate the small `/host/sys/class/hwmon/hwmon*` directory at startup. Read each device's `name` and resolve its links inside the mounted host sysfs tree.
1. Recognize documented CPU sources. Initially support Intel `coretemp`, AMD `k10temp`, and the verified Raspberry Pi CPU thermal zone; these are interface rules, not CPU-model or temperature-limit tables.
1. For Intel `coretemp`, use the package channel `temp1_*`, confirmed by its `Package id ...` label. Do not collect the separate `Core ...` channels. If the driver has no package channel, report this source as unsupported rather than choosing an arbitrary core.
1. For AMD `k10temp`, use its documented main CPU control channel `temp1_*` (`Tctl` where labeled). Do not mix it with `Tdie` or individual CCD channels. Tctl can be a control-scale value rather than physical die temperature; label it "CPU control temperature (Tctl)" and keep its limits on the same scale.
1. On Raspberry Pi, confirm board identity from the host device tree's NUL-separated root `compatible` values with a `raspberrypi,` board identifier. Find the thermal zone with `type` equal to `cpu-thermal`; do not assume it is `thermal_zone0`. Read that zone's `temp` and named trip attributes as described below.
1. Ignore motherboard, GPU, storage, fan, per-core, and CCD sensors. Do not fall back to generic ACPI thermal zones, whose association with a CPU and trip-point meaning are not guaranteed. Raspberry Pi's verified CPU zone is a deliberate, bounded exception.

This deliberately limits first-release support. A different CPU driver can be added after its package/control semantics and limit units are verified, without adding processor-model limit data. Unsupported CPUs and VMs without sensors show Not available.

Use a stable identity from the driver/source type, underlying device or device-tree path, and channel label. Do not treat a changing `hwmonN` or `thermal_zoneN` directory number as identity. Discover once, cache the selected paths, and repeat discovery after a source disappears or on a 60-second discovery interval; do not scan the device tree on every sample.

#### Raspberry Pi Source and Trip Points

The CPU thermal zone exposes the SoC reading that is useful for CPU thermal monitoring. This works with the existing read-only sysfs approach and needs no `vcgencmd`, firmware mailbox access, `/dev/vcio`, extra container capabilities, or CPU-model threshold tables.

- Use the verified `cpu-thermal` zone as the single Raspberry Pi source. Do not collect it again through a generated `cpu_thermal` hwmon view. The driver named `raspberrypi-hwmon` reports voltage/undervoltage information and is not the CPU temperature source.
- Read `temp` in millidegrees Celsius. Read each `trip_point_N_type`, `trip_point_N_temp`, and optional `trip_point_N_hyst` from that same zone; enumerate trip indices rather than assigning meaning to a fixed index.
- For an automatic Warning, use the lowest valid `passive` or `hot` trip below the selected critical trip, when present. For an automatic Error, use the lowest valid `critical` trip. If no critical trip exists, a valid passive/hot trip can still provide Warning; missing conditions remain unavailable.
- Ignore `active` fan-control trips for warning/error evaluation. A fan turning on is not an overheating fault.
- Thermal-zone trip temperatures are board/kernel policy values, not necessarily firmware throttling thresholds or the processor's physical maximum. Label their origin accordingly. For example, a Raspberry Pi 5 kernel CPU zone can expose a critical shutdown trip well above its ordinary cooling trip points; do not present that value as the firmware throttling limit.
- Thermal-zone hysteresis is a delta: the clearing boundary is the selected trip temperature minus `trip_point_N_hyst`. This differs from hwmon's absolute hysteresis attributes. Validate each boundary before use.
- Validate the source on representative Raspberry Pi 3/4 and 5 native Linux hosts. Kernel and distribution support can differ; missing board identity, CPU zone, or trip points must be reported explicitly. Do not claim that every Raspberry Pi image exposes both limits.

#### Reading the Current Value and Limits

Read these attributes from the same recognized device and channel:

| Attribute | Meaning in the monitor |
| --- | --- |
| `tempN_input` | Current CPU package/control reading. |
| `tempN_max` | Hardware/driver-reported high limit used for Warning, if supported. |
| `tempN_crit` | Hardware/driver-reported critical limit used for Error, if supported. |
| `tempN_max_hyst`, `tempN_crit_hyst` | Optional absolute recovery temperatures, not margins to subtract from a limit. |
| `tempN_fault`, `tempN_enable` | Optional source-health flags; a fault or disabled channel prevents use of its reading. |

For supported hwmon drivers and the Raspberry Pi thermal zone, temperature attributes are integer millidegrees Celsius or the driver's documented temperature-control scale. Parse bounded integer text, then divide by 1,000 for display. Keep original integers for threshold comparisons. Do not add offsets, infer TjMax, inspect CPU marketing names, read MSRs, execute `sensors-detect`, or write sysfs attributes.

Read the current value and detected limits together on each 5-second host sample. This is a few small sysfs reads per package/source, not file or disk scanning. Replace the source snapshot as one unit so a value is never paired with another source's limits. Reset that source's evaluation state if its identity, detected limits, or effective overrides change.

- Accept only valid values in the supported driver's documented units. A read error, malformed value, disabled channel, or fault makes the current source Unknown; retain its last successful reading only as old data.
- Treat an absent optional limit as unavailable, not as a collector failure. Reject non-positive limits and inconsistent limit pairs; show which hardware attribute is unusable. Do not silently turn an invalid limit into a default.
- Warning must not exceed the critical limit. Equal hardware limits are permitted; Error takes precedence at their shared boundary.
- Evaluate an effective Error-threshold crossing immediately. Confirm an effective Warning-threshold crossing with two consecutive successful samples to avoid a brief warning change.
- Use optional source hysteresis only for an Automatic threshold with a valid clearing boundary below the corresponding detected limit. For manual overrides or missing valid hysteresis (such as Intel `coretemp`), apply the `2.0 °C` (`2000` millidegree) high-trigger recovery boundaries (`max(0, W - 2000)` and `max(W, E - 2000)`) across two consecutive successful samples. Missing data is not recovery.
- Do not use alarm bits as a substitute for current thresholds. For example, Intel `tempN_crit_alarm` can stay set after a past critical event; a latched historical alarm must not be mistaken for a current-temperature crossing.

#### One Summary on Single- and Multi-Package Hosts

Keep one package/control candidate per physical CPU device internally, so a second socket is not ignored. Expose one CPU thermal summary, not a per-core or sensor dashboard.

Evaluate each candidate using its own effective thresholds. Select the candidate with the highest known severity; among candidates with the same severity, prefer the smallest remaining margin to its effective Error threshold. If no candidate has an Error threshold, use the highest reading on the same driver/control scale. Use stable identity to resolve ties.

Show the selected reading, label, source, detected limits, effective thresholds, and coverage together. Identify the selected package on multi-package hosts. A known Error candidate must remain visible when another candidate is unavailable; report incomplete coverage separately. Do not compare a Tctl reading with a Tdie limit or report that all CPUs are healthy when a package or required threshold could not be assessed.

#### Hardware-Limit Availability

Intel `coretemp` normally exports both recommended and critical limits for a supported package channel. AMD `k10temp` limit availability depends on processor generation and firmware. Raspberry Pi exposes the CPU zone's configured trip points; a critical trip does not guarantee a passive/hot warning trip. A valid current reading does not guarantee both automatic thresholds.

Missing source support cannot be fixed by application tables or a read-only mount. Show whichever same-source limits are available, clearly mark missing ones, and evaluate only supported effective conditions. Admin overrides can fill absent limits, but cannot manufacture a sensor reading. No guessed warning offset, universal Celsius limit, or external hardware lookup is required.

#### Admin Temperature Overrides

- Persist a nullable Warning override and Error override for each stable recognized source, alongside the source's observed `(detected_max, detected_crit)` hardware limits. An unset override means Automatic; a set value replaces the corresponding detected threshold even when that detected threshold exists.
- Preserve detected values separately. Show each effective threshold's origin as Hardware, Kernel thermal policy, or Admin override. Returning to Automatic restores the current detected value, or marks that condition unavailable if none exists.
- Accept updates through discriminated `StrictSettingUpdate` variants (`cpu_temp_warning_override` and `cpu_temp_error_override`) carrying `{ source_id, value_millidegrees }` in `100`-millidegree (`0.1 °C`) steps. Accept `source_id` only if it matches a currently discovered CPU source or an existing persisted override row. Validate the effective Warning/Error pair transactionally; Warning must not exceed Error. Do not store a stale copy of an automatic limit as a manual value.
- An admin can set one missing limit independently. Until both conditions have valid effective thresholds, keep their coverage explicit rather than claiming full assessment.
- Bind overrides to the sensor slot (`driver + device_path + channel_label`) and its observed hardware limits rather than a changing `hwmonN` or `thermal_zoneN` index. If the same slot later boots with different non-null hardware limits (such as after a processor upgrade with different thermal limits) or if an automatic change makes a mixed automatic/manual pair invalid, report the configuration change or conflict, mark temperature assessment Unknown when invalid, and prompt the admin to reconfirm, adjust, or clear the override; do not silently clamp values. If a processor is replaced in the same socket with identical or absent hardware limits, the slot retains its override until cleared by an admin.
- Overrides affect Sambee's status evaluation only. They do not alter host fan control, throttling, shutdown policy, or hardware protection. Warn when a manual threshold exceeds the corresponding detected limit, without silently changing the admin's value.
- Override updates, clears, source changes, and automatic limit changes reset that source's breach/recovery state. A missing or stale current reading still produces Unknown.

### Storage Capacity Without File Scans

Read the operating system or server's filesystem capacity counters. Do not calculate space by adding file sizes.

| Source | Capacity query | Calculation |
| --- | --- | --- |
| Backend application data/temp filesystems | `statvfs` or an equivalent filesystem-statistics call on the configured path | Total bytes = total blocks (`f_blocks`) multiplied by fragment size (`f_frsize`); available bytes = unprivileged available blocks (`f_bavail`, excluding root-reserved space) multiplied by fragment size. |
| Companion Unix drives (Linux and macOS) | Shared `#[cfg(unix)]` `statvfs` helper using an in-memory `drive_id -> (PathBuf, DriveType)` map populated during `enumerate_drives()` | Use the same total and unprivileged available block calculation (`f_blocks * f_frsize`, `f_bavail * f_frsize`). Re-enumerate at most once on a cache miss; do not repeat full mount/udev discovery on each capacity check. |
| Companion Windows drives | `GetDiskFreeSpaceExW` using the same in-memory `drive_id -> (PathBuf, DriveType)` map | Use the returned total bytes and bytes available to the caller. |
| Active SMB connections | `smbclient.stat_volume()` through a non-aborting helper on the existing connection pool | Use the returned total size and caller-available size. This issues a filesystem-size metadata query, not a directory scan. |

For each source, calculate available percent as `100 * available_bytes / total_bytes` when the total is valid and positive. On Windows and SMB, caller-available space reflects per-user quotas where enforced; on POSIX filesystems, `statvfs.f_bavail` reflects blocks available to unprivileged users and does not guarantee per-user quota awareness. Label these semantics accurately in the UI and documentation.

- Do not enumerate directories, read file contents, run `du`, perform write tests, flush filesystems, or request disk-health scans.
- Reuse mapped drive roots and existing connection contexts. Deduplicate backend data/temp paths on the same filesystem where filesystem identity (`st_dev` / `f_fsid`) matches; container `overlayfs` (`/tmp`) and bind mounts (`/app/data`) may report distinct filesystem identities even on one host disk.
- Keep the same cache and concurrency limits for local, backend, and SMB storage. Share successful capacity results without sharing credentials or private-connection data.
- If a filesystem cannot report capacity, show Not available or the specific collection error. Do not fall back to a scan.
- Filesystem statistics are normally inexpensive metadata reads, and their cost does not grow with the number or size of files. SMB needs a small protocol exchange and may need to open a metadata handle.
- Network, virtual, or removable filesystems can still block or cause device/server I/O. The application cannot guarantee that a metadata query never wakes a disk or causes server-side I/O. Use bounded workers, conservative caching, and retry backoff; verify overhead on supported backends.

### SMB

Add an authenticated capacity read for an accessible connection, using its configured path and stored credential context. Snapshot requests accept at most two active `connection_ids` (matching single- and dual-pane views; reject more than two with `422`), verify `can_view_connection` on every request, return cached RAM state immediately, and schedule a non-blocking background probe only when an entry is missing or at least 60 seconds old.

- Use a dedicated `stat_volume()` capacity helper on `SMBBackend` with `SMBConnectionPool.get_connection()` and `wait_for_worker()` rather than `_run_blocking_smb_operation()`'s `abort=True` path.
- Prefer caller-available bytes for the main reading; show actual free bytes as separate information if useful. Never describe quota-limited availability as total physical-disk free space.
- Derive percent against the reported capacity and label its meaning. Do not invent a quota total.
- Do not scan files, calculate directory sizes, or perform a write test.
- Deduplicate by connection, path/volume context, and credential version. Do not share results just because two connections use the same server name.
- Invalidate on connection changes and re-check access on every request.
- Use bounded low-priority admission, one in-flight read per source, the two-probe process semaphore, a per-user trigger rate cap (for example, at most 4 new SMB probe triggers per user per 60 seconds), timeout handling, and retry backoff.
- On probe timeout or browser-request cancellation, call `retain_connection_until_future_complete()` and retain both the per-source in-flight flag and the probe semaphore permit until the executor worker exits. Never call `abort=True` or disconnect active file reads, writes, moves, or archive streams on the shared pooled connection.
- Bound cached SMB capacity entries with a fixed-size LRU (for example, 32 entries). Run no background SMB polling timer; SMB checks stop automatically when no eligible visible browser polls.

### Local Drives

Add an authenticated capacity endpoint to Companion, maintaining an in-memory `drive_id -> (PathBuf, DriveType)` map updated during `enumerate_drives()` (re-enumerating once on an unknown ID) and using the existing pairing rules.

- Query all local drives exposed to this paired browser, not drives on other users' devices.
- Share one `#[cfg(unix)]` `libc::statvfs` helper across Linux and macOS (leaving Linux-only udev classification in `volume_evidence` unchanged) and use `GetDiskFreeSpaceExW` on Windows. Report total and available bytes, noting POSIX unprivileged-block (`f_bavail`) versus Windows caller-quota semantics.
- Keep slow network, virtual, and removable drives from blocking the drive list or file operations. Move both the 2-probe `OwnedSemaphorePermit` and the per-drive in-flight guard into the `tokio::task::spawn_blocking` closure so a stuck kernel syscall retains its slot until the OS thread exits and never spawns duplicate threads for the same wedged mount.
- Return per-drive errors without losing successful results.
- Treat unsupported virtual-drive capacity as Not available, not zero free space.
- Support an older Companion with a clear "Update Companion to show drive space" message. Do not break normal browsing.
- Keep local readings in this browser/Companion context. Do not upload them to a global backend snapshot.

The frontend joins backend-host data, active-connection results, and local-drive results into one view. It recomputes the summary when panes, identity, permissions, pairing, or policy change.

Use the same health state for the desktop toolbar and mobile navigation-drawer row. Keep the existing visible-page polling lifecycle when the mobile drawer is closed, so its status is current when opened. Opening or closing the drawer must not start another polling loop or change which storage connections are monitored.

The backend must filter host and SMB reads. The Companion API remains protected by its own authenticated device boundary. The display-audience setting is not a substitute for OS access control over a user's own local drives.

### RAM-Only Contract

- Do not add a metrics table, time-series files, browser local storage, or metric payloads in logs.
- Return metric responses with `Cache-Control: no-store`; exclude them from persistent client caching.
- Persist thresholds and audience settings only.
- Keep bounded RAM caches and evaluation windows; clear them when disabled and release them at shutdown.
- Pause browser polling in hidden tabs and stop it at logout.
- State clearly that application-level RAM-only storage does not prevent OS swap or crash dumps. A strict no-disk guarantee also needs deployment controls.

## Work Items

| ID | Work item | Scope | Prerequisites |
| --- | --- | --- | --- |
| 1 | Confirming host-source and storage contracts | Validate read-only mounts, CPU-driver package/control semantics, same-channel limits, and sensor-link resolution on native Linux; define metric/source/availability models and Companion compatibility behavior. | None |
| 2 | Implementing policy and authorization | Add defaults, scaled-integer validated settings updates, bounded discriminated CPU temperature override updates, Public Support Report aliasing, audience checks, and policy reads for permitted users. | 1 |
| 3 | Implementing host monitoring | Add host memory, three normalized system-load values, Intel/AMD hwmon and Raspberry Pi CPU thermal-zone collection with detected limits, `2.0 °C` fallback hysteresis, and one thermal summary, and `/sys/fs/cgroup` container working-set memory collectors; apply slot-and-limit-bound admin overrides; collect filesystem space separately through cached metadata queries; add bounded sampling, threshold evaluation, cleanup, and a protected snapshot API. | 1, 2 |
| 4 | Implementing SMB capacity | Add the non-aborting storage capacity helper on `SMBBackend`, on-read 60-second background refresh with 2-connection and per-user rate bounds, bounded LRU caching, and access tests. | 1, 2 |
| 5 | Implementing local-drive capacity | Add the Companion in-memory drive-root map, shared `#[cfg(unix)]` `statvfs` (Linux and macOS) and Windows `GetDiskFreeSpaceExW` reads with owned blocking permits, authenticated endpoint, compatibility handling, and frontend transport types. | 1 |
| 6 | Implementing the user interface | Add shared health state, the desktop toolbar indicator, the mobile System health row directly below Settings in the main navigation drawer, the responsive details dialog, the lazy settings page, and translations. Keep the mobile toolbar unchanged. | 2, 3, 4, 5 |
| 7 | Validating and documenting | Run focused tests and type checks, validate the UI in a browser, update version 3.0 documentation, and review the final diff. | 2, 3, 4, 5, 6 |

## Verification

Add focused tests for new behavior:

- Test normalized 1-, 5-, and 15-minute system load, the host logical CPU denominator, missing or invalid CPU inventory, MemAvailable accounting, and finite/unlimited container cgroups.
- Test that only the normalized 5-minute value triggers load severity, with warning at 0.75 and error at 0.9, including values just below, at, and above each boundary. High 1- or 15-minute values must not independently trigger a warning or error.
- Test scaled-integer threshold validation at each permitted range and precision boundary, high-trigger versus low-trigger pair ordering, equality with Error precedence, and acceptance of normalized-load thresholds above 1.0. Confirm that invalid precision is rejected rather than rounded and that every proposed default passes validation.
- Test the recovery formulas with thresholds closer than their margins and with equal thresholds. Verify Error-to-Warning, Warning-to-OK, and direct Error-to-OK transitions at and around each directional recovery boundary.
- Verify confirmation timing: memory breach and recovery require 60 seconds; load entry uses the first successful sample and recovery uses two samples; storage entry uses one successful reading and recovery uses two; temperature Warning uses two samples and Error is immediate.
- Verify that raw load values are not API metrics or visible in the dialog, including when normalization fails.
- Test container working-set memory (`max(0, memory.current - inactive_file)`), including cache-heavy file/SQLite/PDF workloads that do not trigger false alerts, fallback when `inactive_file` is absent, and default Docker private cgroup namespaces (`0::/`).
- Test that confirmed unlimited container memory (`memory.max == "max"`) shows working-set bytes and "No memory limit configured," without a percentage, percentage alerts, host-RAM substitution, or an aggregate warning or Unknown state caused by the private cgroup namespace.
- Test that unreadable or malformed container cgroup files produce Unknown rather than unlimited, while host-memory monitoring continues independently.
- Verify that collectors, API payloads, settings, and the dialog contain no CPU usage or CPU percentage metrics.
- Test missing mounts, permission errors, invalid sensor data, changing sensor paths, missing thresholds, and failed sampling.
- Test Intel package-only selection and AMD Tctl-only selection, excluding individual cores, Tdie/CCD alternatives, and unrelated sensors. Verify same-channel values, limits, units, and labels.
- Test Raspberry Pi board/CPU-zone recognition, changing zone indices, Pi 3/4 and 5 source fixtures, missing trip points, ignored active fan trips, and deduplication against the generated hwmon view. Verify that unrelated zones and `raspberrypi-hwmon` voltage data are not used as CPU temperature.
- Test missing high/critical limits independently, no-limit informational readings, equal limits, invalid limit ordering, optional fault/enable flags, and valid/invalid hysteresis boundaries. Verify absolute hwmon hysteresis, thermal-zone hysteresis deltas, and the `2.0 °C` (`2000` millidegree) fallback recovery margin when hardware hysteresis is absent or overridden, with no hardware-model table or guessed limit.
- Test independent admin overrides for detected or missing thresholds, discriminated single-field updates, `source_id` allowlist validation (accepting only discovered or already persisted sources), Public Support Report `source_id` aliasing, return to Automatic, Celsius/control-scale labels, exact `100`-millidegree step validation without rounding, effective-pair validation, accepted overrides above detected limits with a warning, `2.0 °C` manual-threshold recovery, and review/conflict states after a detected hardware-limit change.
- Test two-sample high-limit confirmation, immediate critical crossings, recovery without stale-data clearing, and latched alarm bits that do not indicate a current crossing.
- Test multi-package severity selection, critical-limit margins, stable ties, incomplete coverage, cached discovery, hwmon renumbering, and source/limit changes without mixing readings.
- Test exact warning/error boundaries, sustained breaches, recovery margins, stale data, partial coverage, and threshold changes.
- Test admin/editor/viewer combinations, disabled monitoring, private connections, and aggregate-information leakage.
- Test active single/dual-pane connections, rejection of more than two `connection_ids` per snapshot request (`422`), per-user SMB probe trigger rate bounds, duplicate connections, navigation cancellation, credential changes, bounded concurrency, and non-aborting probe timeouts alongside an active SMB file write.
- Test SMB caller quota versus actual space, POSIX `f_bavail` unprivileged-block semantics versus caller quotas, missing server support, and zero/invalid capacity.
- Test capacity calculations from filesystem block counters and Windows/SMB returned bytes. Verify that capacity collection performs no directory traversal, file-content reads, write probes, or scan fallback.
- Test shared caching, staggered probes, the two-probe process limit, permanently blocked storage syscalls retaining their semaphore permit and per-source in-flight slot until worker exit, bounded LRU eviction, and retry backoff. Repeated UI refreshes and simultaneous clients must not multiply storage queries.
- Test Windows, Linux, and macOS local space, the Companion in-memory drive-root map (confirming capacity reads do not repeat full drive discovery), unavailable virtual/removable drives, pairing loss, and older Companion versions.
- Test settings persistence and validation, with no metric writes to database, browser storage, logs, or persistent caches.
- Test keyboard access, focus return, accessible labels, all status shapes, small screens, long connection names, and untranslated strings.
- Test that selecting the main Sambee icon on mobile opens the navigation drawer and that System health appears directly below Settings and above Documentation, with the current status shown as an icon and text.
- Test that selecting System health closes the navigation drawer, opens the details dialog, and returns focus to the main Sambee icon when the dialog closes.
- Test that the mobile toolbar and settings drawer have no duplicate health entry, that disabled or unauthorized monitoring hides the navigation-drawer row, and that drawer open/close cycles do not create extra polling loops.

Use existing pytest, mypy/Ruff, Vitest, TypeScript, and Cargo tools for the changed areas. Validate actual Windows and macOS platform behavior in their respective CI or test environments, not only with Linux mocks.

For browser validation, use only `http://localhost:3000/browse/smb/demo`.

Confirm these measurable limits:

- Run no more than one host sampling loop per backend process, and run no background SMB polling loop when no eligible browser polls.
- Run no more than one storage probe per source in flight.
- Run no more than two storage probes in flight per backend process or Companion process, keeping permits owned until blocked worker threads exit.
- Make shared results obey the 60-second storage cache interval, two-connection request limit, and per-user SMB trigger rate bound.
- Verify that a 5-second host sample does not perform a storage query, and that a dialog or summary refresh never blocks on storage I/O or bypasses the 60-second storage interval.
- Measure monitoring overhead with supported local and SMB filesystems during ordinary browsing. Check process CPU time, storage-query counts, and device I/O separately from unrelated application activity; no test may use a directory scan as a capacity read.
- Apply old-data transitions at the specified ages.
- Prevent storage probes from consuming unbounded workers, disconnecting active SMB file operations on timeout, or delaying ordinary browsing without a bound.
- Keep cache sizes bounded as users change connections.
- Make host-mount setup perform no host writes and need no added container capabilities.

## Documentation Changes for Implementation

Use the `docs-update` skill before editing website docs.

Add feature documentation in [version 3.0](../website/content/docs/3.0/). Keep earlier versions unchanged for this feature. Version 3.0 inherits from 2.1; use the docs editor to materialize inherited pages before adding version-specific content.

Update the version 3.0 admin deployment guide with the four optional read-only host mounts (`/host/proc/{meminfo,loadavg,cpuinfo}` and `/host/sys`), explain why container memory needs no extra mounts and why `/var/run`, `/var/lib/docker`, `/:/rootfs`, `/dev/disk`, and `/sys:/sys` must not be mounted, and cover source limits and native Linux versus VM/Desktop behavior. Add admin health settings and troubleshooting guidance, user instructions for the indicator/dialog, and developer documentation for the sampling, authorization, scaled-integer settings, Public Support Report aliasing, storage, and RAM-only contracts. Explain normalized 1-, 5-, and 15-minute system load, with warning/error defaults of 0.75/0.9 on the 5-minute value only. Do not introduce CPU usage metrics or raw-load displays.

Document supported Intel/AMD package/control drivers and Raspberry Pi CPU zones, Tctl versus physical die temperature, detected same-source limits, kernel trip-point semantics, the `2.0 °C` fallback recovery margin when hardware hysteresis is absent or overridden, single-summary selection, and missing-limit coverage. Explain slot-and-limit-bound admin overrides and return to Automatic, noting that same-socket processor swaps with identical or absent hardware limits retain the slot's override until cleared. Detected limits remain read-only; no CPU-model tables are needed. For missing sensors, advise checking host driver/firmware support and the read-only mount. For missing limits, explain how an admin can set monitoring thresholds without changing host thermal controls.

Document filesystem-statistics (Linux, macOS, and Windows) and SMB metadata queries, POSIX unprivileged-block (`f_bavail`) versus Windows/SMB caller-quota semantics, the separate 60-second on-read storage refresh interval, shared caching, non-aborting SMB timeout ownership, concurrency limits, and the prohibition on scans. State that remote/device I/O behavior depends on the server or filesystem driver, even for metadata queries.

Document container working-set memory (`max(0, memory.current - inactive_file)`) and `/sys/fs/cgroup` finite, absent (`"max"`), and unknown limits. Explain that percentage thresholds apply only to a finite container cgroup limit and that host-memory checks remain independent.

Describe both entry points in user documentation: the desktop indicator to the right of Settings, and the mobile System health row below Settings in the navigation drawer opened with the main Sambee icon. Do not describe a mobile-toolbar health button.

Read the resolved version 3.0 [settings/form/dialog pattern](../website/content/docs/3.0/developer-guide/frontend-architecture/settings-form-dialog-pattern/) before implementation. No dependency changes are currently proposed. If that changes, consult the resolved version 3.0 [dependency-update workflow](../website/content/docs/3.0/developer-guide/release-and-versioning/dependency-update-workflow/) before editing pins or lockfiles.

## Effort and Risk

Ratings use 1 = Low and 5 = Very high. They are relative scope ratings, not time estimates.

| Area | Effort | Risk | Main issue |
| --- | --- | --- | --- |
| Policy and settings | 3/5 | 2/5 | Correlated threshold validation and display permissions. |
| Host metrics and optional mounts | 4/5 | 3/5 | Sensor labels, symlinks, host visibility, and container limits. |
| Active SMB free space | 3/5 | 3/5 | Quotas, server variation, and shared-pool timeout behavior. |
| Local-drive free space | 3/5 | 3/5 | Windows/Unix parity, slow mounts, and Companion compatibility. |
| Indicator and details dialog | 3/5 | 2/5 | Partial data, responsive layout, drawer-to-dialog focus handling, and keyboard behavior. |
| Integration tests and documentation | 4/5 | 2/5 | Platform and deployment matrix. |
| **Overall** | **4/5: High** | **3/5: Medium** | Three runtimes, deployment changes, and state evaluation. |

The read-only files are not the largest coding task. Reliable status evaluation, storage timeouts, permissions, and Companion compatibility account for much of the work.

Removing CPU usage reduces collector, settings, and test scope, but does not change the overall effort or risk rating. System-load normalization still needs a reliable host CPU count.

Recommended implementation order: establish the read-only host proof first, then deliver host/settings/UI with explicit coverage states, then complete SMB and local-drive capacity before calling the agreed feature complete.

## Out of Scope

- Do not monitor other users' private connections or saved SMB connections not active in this browser.
- Do not collect CPU usage or CPU percentage metrics for the backend host, container, SMB servers, or Companion devices. Host CPU count for load normalization and identified CPU temperature sensors remain in scope.
- Do not monitor system load or temperature on SMB servers or Companion devices.
- Do not add a per-core/CCD temperature dashboard, unrelated thermal sensors, CPU-model limit tables, guessed hardware limits, or writes to host thermal controls.
- Do not require a host agent, privileged containers, Docker socket access, SMART/NVMe access, IPMI, or fan control.
- Do not add persistent history, charts, forecasts, email/push alerts, Prometheus integration, or fleet monitoring.
- Do not add full golden-signal application monitoring, service-level objectives, or automatic recovery.
- Do not discover arbitrary host disks.

## Sources

- [Google SRE: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/): Actionable signals, saturation, symptoms versus causes, and simple monitoring.
- [WCAG 2.2: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html): Status must not depend on color alone.
- [Linux hwmon sysfs interface](https://docs.kernel.org/hwmon/sysfs-interface.html): Optional attributes, sensor labels, device links, units, and hardware limits.
- [Linux Intel coretemp driver](https://docs.kernel.org/hwmon/coretemp.html): Package channels, recommended and critical limits, units, invalid readings, and latched critical alarms.
- [Linux AMD k10temp driver](https://docs.kernel.org/hwmon/k10temp.html): The main Tctl channel, its relationship to Tdie, and hardware-dependent limit availability.
- [Linux thermal sysfs interface](https://docs.kernel.org/driver-api/thermal/sysfs-api.html): Zone temperature, typed trip points, hysteresis deltas, and critical shutdown behavior.
- [Raspberry Pi kernel CPU thermal zones](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm/boot/dts/broadcom/bcm283x.dtsi): The named CPU zone and board/kernel critical policy, not an application temperature table.
- [Raspberry Pi 5 CPU thermal zone](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/arch/arm64/boot/dts/broadcom/bcm2712-ds.dtsi): CPU sensor association and critical trip; board fan-control trips are separate.
- [Raspberry Pi hwmon driver](https://docs.kernel.org/hwmon/raspberrypi-hwmon.html): Voltage monitoring, not the CPU temperature source.
- [Linux proc filesystem](https://docs.kernel.org/filesystems/proc.html): Host resource counters.
- [Linux cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html): Container resource accounting and limits.
- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/): Read-only behavior, host coupling, source paths, and Desktop limits.
- [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/): Container memory limits and the distinction between container limits and host resources.
- [smbprotocol 1.17.0 capacity implementation](https://github.com/jborean93/smbprotocol/blob/v1.17.0/src/smbclient/_os.py#L840): Verified `stat_volume()` return values and read-attribute query.
