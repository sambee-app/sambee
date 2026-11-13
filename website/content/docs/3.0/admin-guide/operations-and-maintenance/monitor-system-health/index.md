+++
title = "Monitor System Health"
+++

Use **Settings** > **Administration** > **Health Monitoring** to control who sees the resource-health indicator and to configure alert thresholds for memory, normalized system load, CPU temperature, and storage free space.

System health monitoring is a live resource-health view, not an external availability alert system. If the backend container stops, it cannot report its own status; keep external uptime monitoring for outage alerts.

The **System Health** dialog opens with a compact overview. Each reading expands to show its capacity, thresholds, source, and sample age without repeating the current value. **Server** includes **Container application data** and **Container temporary storage**; **Connection storage** shows drive and connection types separately from their names. **Server load** shows the status of the normalized 5-minute load, not CPU usage. **Container memory** excludes file cache and includes all processes in the container, not Sambee alone; **No limit set** means that percentage alerts cannot be evaluated.

## Visibility and Audience

Health monitoring is enabled by default and shown to **Admins** by default. Administrators can set **Show health information to** to:

- **Admins**
- **Editors**
- **Both (Admins and Editors)**

**Viewer** accounts are always excluded, and only administrators can view or edit Health Monitoring settings. Backend endpoints enforce these role and connection-visibility rules before scheduling storage checks, computing aggregate severity, or returning details. When monitoring is disabled, Sambee hides the indicator, stops metric requests, and clears in-memory metric state.

Visible browser tabs continue to check the display policy about once a minute, even when monitoring is disabled or not permitted for the current role. This lets the indicator appear after an administrator enables monitoring or changes its audience in another browser. Returning to a visible tab also checks the policy. Hidden tabs and signed-out browsers make no monitoring requests.

## Monitored Metrics and Default Thresholds

Sambee does not collect or display host or container CPU usage percentages. All numeric settings commit per field on blur or <kbd>Enter</kbd> without a page-level Save button.

| Metric | Default Warning | Default Error | Evaluation and Recovery |
| --- | --- | --- | --- |
| Host memory | `85.0%` used | `95.0%` used | Calculated from `/host/proc/meminfo` `MemAvailable`. Enters Warning or Error after 60 sustained seconds; recovers after 60 sustained seconds with a `5.0` percentage-point margin. |
| Container memory without file cache | `85.0%` of limit | `95.0%` of limit | Calculated from the container's cgroup (`memory.current - (file - shmem)`). Includes shared and kernel memory. Uses the same 60-second entry and `5.0` percentage-point recovery rules when a finite container memory limit is set. |
| Normalized system load | `0.75` | `0.90` | Displays normalized 1-, 5-, and 15-minute load divided by logical CPU count from `/host/proc/cpuinfo` (never raw load). Evaluates only the 5-minute value; enters on the first 5-second sample and recovers after two samples with a `0.10` margin. |
| CPU temperature | Same-source high limit | Same-source critical limit | Enters Error immediately and Warning after two 5-second samples. Uses valid same-source hardware or kernel hysteresis on Automatic limits, or a `2.0 °C` recovery margin across two samples when hysteresis is absent or overridden. |
| Available storage space | `10.0%` available | `5.0%` available | Enters Warning or Error on one reading (`0` available bytes enters Error immediately). Recovers after two consecutive readings with a `2.0` percentage-point margin. |

When Warning and Error thresholds are equal, Error takes precedence at the shared boundary, and Error recovery requires moving strictly past the Error recovery boundary so status does not flap.

## Container Memory vs. Host Memory

Container memory is always reported separately from physical-host memory and never substitutes host RAM as a container limit:

- Sambee reads only its own container cgroup (`/sys/fs/cgroup/memory.max`, `memory.current`, and `memory.stat`, with cgroup v1 fallback). Standard Docker private cgroup namespaces (`0::/`) are supported without walking parent cgroups.
- Usage excludes both active and inactive file cache. This cache-excluded reading is not cAdvisor's working set.
- Shared memory and tmpfs remain included, as do kernel allocations. The row details show excluded file cache separately.
- The reading includes all processes in that cgroup. In a shared development container, this can include editors and other tools.
- When `memory.max` is `"max"` (no container limit configured), Sambee displays used bytes and **No limit set** as informational without percentage alerts.
- If cgroup files or required cache counters cannot be read or parsed, container memory reports **Unknown** with the collection error rather than guessing usage or claiming unlimited memory.

[cAdvisor](https://github.com/google/cadvisor/blob/master/lib/container/libcontainer/handler.go#L820) reports separate memory values on cgroup v2: total charged memory from `memory.current`, working set from `max(0, memory.current - inactive_file)`, and RSS from `memory.stat` `anon`. The Linux [Docker stats](https://docs.docker.com/reference/cli/docker/container/stats/) display also subtracts inactive file cache, not all file cache. These values measure different parts of memory usage.

Windows Task Manager reports the WSL VM, not an individual Linux cgroup. To check a difference, compare Docker stats for the same container with its cgroup counters at the same time. Do not change the calculation only to match the VM reading.

## CPU Temperature Sources and Overrides

CPU thermal collection requires the optional `/sys:/host/sys:ro` mount on native Linux hosts (see [Deploy Sambee with Docker](../../installation-and-deployment/deploy-sambee-with-docker/#optional-enable-linux-host-health-mounts)). Sambee never uses CPU-model lookup tables, guessed Celsius defaults, or writes to sysfs thermal or fan controls.

Supported kernel interfaces:

- Intel `coretemp`: Package channel `temp1_*` verified by a `Package id ...` label. Individual core channels and latched historical `temp1_crit_alarm` bits are ignored.
- AMD `k10temp`: Main CPU control channel `temp1_*` (`Tctl`), labeled **CPU control temperature (Tctl)**. `Tctl` uses AMD's control scale rather than physical die temperature; `Tdie` and per-CCD channels are not mixed with it.
- Raspberry Pi `cpu-thermal`: Verified through a `raspberrypi,` root device-tree `compatible` entry under `/host/sys/firmware/devicetree/base/compatible` and the thermal zone whose `type` is `cpu-thermal`. Automatic Warning uses the lowest valid `passive` or `hot` trip below the critical trip, and automatic Error uses the lowest valid `critical` trip. Active fan-control trips, generated `cpu_thermal` hwmon views, and `raspberrypi-hwmon` voltage sensors are ignored.

On multi-socket hosts, Sambee evaluates each CPU package with its own limits and exposes one summary showing the candidate with the highest severity (or smallest margin to its effective Error threshold on ties), while reporting incomplete coverage if another package cannot be assessed. A failed package check produces **Unknown** unless another package has a known **Warning** or **Error**. Unsupported sensors and missing optional limits remain separate coverage limits.

### Admin Temperature Overrides

Detected limits remain read-only. For each discovered CPU source, administrators can leave Warning and Error on **Automatic** or enter an override in `0.1 °C` steps:

- If a sensor reports a valid temperature without one or both hardware limits, **Automatic** leaves the missing threshold unavailable (informational when neither threshold exists) until an administrator supplies an override.
- Overrides bind to the stable sensor slot (`driver + device_path + channel_label`) and observed non-null hardware limits rather than changing `hwmonN` or `thermal_zoneN` numbers.
- If non-null hardware limits change later (such as after a processor upgrade with different thermal limits), Sambee flags the override for review—or marks temperature **Unknown** if the mixed pair becomes invalid—so you can **Reconfirm override**, adjust it, or select **Return to Automatic**. Replacing a processor in the same socket with identical or absent hardware limits retains the slot's override until cleared.
- Manual overrides above a detected limit remain allowed for Sambee's status evaluation and show a warning reminder; they never alter host fan speed, throttling, or hardware shutdown protection.

## Storage Capacity Queries

Sambee reads filesystem metadata counters only (`statvfs` on Linux and macOS, `GetDiskFreeSpaceExW` on Windows Companion, and `smbclient.stat_volume()` on active SMB connections). It never scans directories, sums file sizes, or writes test files.

- POSIX `statvfs` (`f_bavail * f_frsize`) reports blocks available to unprivileged users and does not guarantee per-user quota awareness. Windows and SMB queries report caller-available space including enforced per-user quotas.
- Storage checks run on read at most once every 60 seconds per volume, staggered with at most two storage probes in flight per backend or Companion process, bounded SMB LRU caching, and retry backoff. Even metadata reads can wake disks or trigger server I/O depending on the remote server or filesystem driver.
- Timed-out SMB capacity probes retain worker ownership until thread exit without aborting shared pooled SMB connections used by active file transfers.
- If all SMB cache entries have checks in progress, new volumes wait for capacity and show **Unknown**. Normal browser refreshes retry admission without creating duplicate probes. Connection changes hide readings from the old connection context while its check finishes.

The browser refreshes health details every 5 seconds while the dialog is open, or every 15 seconds for the indicator alone. Initial storage results appear on a normal refresh; a check in progress does not cause faster polling.

## RAM-Only Storage Contract

Sambee stores only settings and overrides in SQLite. Metric samples, recent evaluation windows, and storage capacity caches live in process RAM only, are cleared when monitoring is disabled or the service stops, and are served with `Cache-Control: no-store`. Browser tabs pause polling while hidden and clear state on sign-out.

Application-level RAM storage does not prevent operating-system swap or crash dumps from writing process memory to disk; apply host swap and core-dump controls if your environment requires strict no-disk guarantees.

## Troubleshooting

- **Host memory, load, or CPU temperature shows Not available**: Check that the container runs on a native Linux host with the optional read-only `/host/proc/*` and `/host/sys` bind mounts configured, and verify that host kernel drivers (`coretemp`, `k10temp`, or Raspberry Pi `cpu-thermal`) are loaded on the host. Virtual machines and Docker Desktop VMs normally do not expose physical CPU thermal sensors.
- **Temperature limits are not available**: Some processors and board device trees expose current temperature without `temp1_max`, `temp1_crit`, or passive cooling trips. Set manual Warning and Error overrides in **Settings** > **Administration** > **Health Monitoring** to evaluate alerts in Sambee without changing host thermal policy.
- **Old data (`> 15s` for host, `> 180s` for storage)**: Check whether the backend host or remote storage mount is stalled or unreachable, then select **Retry** in the System Health dialog.
- **Update Companion to show drive space**: Install the latest Companion version on the paired desktop device.

