+++
title = "View Logs and Restart Services"
+++

Once Sambee is in service, logs and controlled restarts are the core day-to-day admin tools.

## View Logs

To follow logs for all services:

```bash
docker compose logs -f
```

To focus on the Sambee service only:

```bash
docker compose logs -f sambee
```

Use the service-specific view first when the issue is clearly about the application itself.

If you only need recent startup output, use:

```bash
docker compose logs sambee --tail 100
```

### Diagnose Slow Image Previews

Set `[app].log_level` to `debug` in `config.toml`, then restart Sambee. Open an image and collect the log lines with the same `request_id`. Converted image previews report these stages:

| Log Fields | Meaning |
| --- | --- |
| `connect_ms`, `metadata_ms` | Backend connection and source metadata lookup. |
| `read_ms`, `first_chunk_ms` | Complete source read and time until the first chunk. The read includes opening the source. |
| `cleanup_ms`, `assembly_ms` | Backend release and assembly of source chunks into one buffer. |
| `executor_queue_ms`, `worker_ms` | Wait for a conversion worker and elapsed time inside that worker. |
| `metadata_ms`, `pipeline_setup_ms` in converter logs | Image header loading and setup of image operations. |
| `evaluate_encode_ms` | Execution of the lazy image pipeline and output encoding. This includes deferred decoding and resizing, not just encoding. |
| `dispatch_total_ms`, `preparation_total_ms` | Conversion dispatch total and source-read-through-response-preparation total. These overlap other stages; do not add them together. They exclude delivery of the response to the browser. |

The conversion start log includes the input SHA-256, byte count, requested viewport, CPU architecture, pyvips and libvips versions, CPU counts, CPU quota, and selected libvips environment settings. Compare identical source hashes and viewport dimensions when testing two deployments. Pipeline logs also show source and output dimensions.

`process_cpu_ms` measures CPU use by the entire backend process, including native worker threads. It can include other requests and can exceed elapsed time when multiple cores are active. It is not a per-request CPU measurement.

On systems with cgroup v2 CPU files, `cgroup_delta` reports changes in `usage_usec`, `nr_throttled`, and `throttled_usec`. These counters apply to the current cgroup, not just the image request. Increasing throttling counters show CPU throttling during the measured interval. The `*_usec` values use microseconds. `cpu_max` reports quota and period in microseconds; `max` means no quota at that cgroup level. A parent cgroup can impose additional limits. Missing quota data appears as `None`; unavailable counters appear as an empty dictionary.

These diagnostics do not force additional image evaluation. Return the log level to its normal setting after the investigation to reduce log volume.

## Stop the Deployment

To stop the services:

```bash
docker compose down
```

Use a full stop when you need to perform controlled maintenance, rebuild the image, or restore deployment files.

## Restart as Part of Operations

Routine restarts are not a substitute for troubleshooting, but they are a legitimate step when:

- You just changed deployment files.
- You rebuilt the image.
- You completed a controlled maintenance step.

To restart only the Sambee service:

```bash
docker compose restart sambee
```

If you restart repeatedly without understanding the failure, stop restarting and inspect the logs, deployment files, proxy path, and persistent data assumptions directly.
