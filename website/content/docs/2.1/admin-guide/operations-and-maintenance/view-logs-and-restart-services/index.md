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

Sambee redacts cookies, authorization headers, and tokens from log output. Debug logs can still contain file paths and user names, so share them only with trusted persons.

If you only need recent startup output, use:

```bash
docker compose logs sambee --tail 100
```

### Diagnose Slow Image Previews

Set `[app].log_level` to `debug` in `config.toml`, then restart Sambee. Open an image and collect the lines with the same `request_id`. A processed preview writes two DEBUG summaries: `Image request` for the request and `Image conversion` for the converter.

| Log Fields | Meaning |
| --- | --- |
| `connect_ms`, `metadata_ms` | Backend connection and source metadata lookup. |
| `read_ms`, `first_chunk_ms` | Complete source read and time until the first chunk. The read includes opening the source. |
| `chunks`, `input_bytes`, `read_complete` | Number of chunks and bytes received, and whether the source read finished. Failed reads retain partial counts. |
| `executor_queue_ms`, `conversion_ms` | Wait for a conversion worker and elapsed time inside that worker. |
| `total_ms`, `outcome` | Request preparation time and result: `converted`, `original`, or an error type. Total time includes backend release and buffer assembly but excludes delivery to the browser. |
| `path` in `Image conversion` | `libvips`, `preprocessor`, or `original`. The original path returns the source bytes. In size mode, a candidate WebP can have been encoded and rejected because it was not smaller. |
| `source`, `output`, `format`, `output_bytes` | Source and output dimensions, output format, and byte count. Preprocessor dimensions are reported as `unknown` when unavailable. |
| `setup_ms`, `encode_ms` | Header loading and pipeline setup, then lazy evaluation and encoding. Encoding time includes deferred decoding and resizing. The preprocessor reports its conversion time as `encode_ms`. |
| `preference`, `webp_fallback` | Requested conversion preference (`speed` or `size`) and WebP dimension fallback (`none`, `original`, `jpeg`, or `png`). |

The request summary is also written after a failure. A failure before conversion has no converter summary. Stages that did not run appear as `None`. Small browser-native images can be streamed without conversion; their summary does not measure stream delivery.

At startup, one DEBUG `Image environment` line records CPU architecture, pyvips and libvips versions, CPU counts, and selected libvips environment settings. Compare the same file and viewport dimensions when testing two deployments. Stage timings overlap the totals; do not add them to the totals.

The INFO `Image converted` line remains available without DEBUG logging. Return the log level to its normal setting after the investigation to reduce log volume.

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
