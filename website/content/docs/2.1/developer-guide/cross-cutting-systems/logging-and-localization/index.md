+++
title = "Logging and Localization"
+++

Logging and localization are both cross-boundary product systems in Sambee.

- Logging affects local debugging, operator visibility, and backend trace collection.
- Localization affects typed UI copy, locale behavior, browser formatting, and browser-to-companion sync.

Treat both as shared contracts rather than optional polish.

## Logging Model

Sambee uses more than one logging surface, but the goal is still one coherent diagnostic story.

### Backend Logging

The backend sends logs to standard output so they are available through Docker or the process supervisor. Configure the backend in the `[app]` section of `config.toml`:

```toml
[app]
log_level = "INFO"
access_log_level = "WARNING"
protocol_log_level = "WARNING"
```

| Key | Controls | Default |
|---|---|---|
| `log_level` | Application diagnostics and Uvicorn startup, shutdown, and error messages. | `INFO` |
| `access_log_level` | HTTP access records, outbound HTTP request summaries, and WebSocket handshake summaries. | `WARNING` |
| `protocol_log_level` | WebSocket lifetime summaries and protocol warnings and errors. | `WARNING` |

All three settings accept `DEBUG`, `INFO`, `WARNING`, or `ERROR`, regardless of case. Access and protocol thresholds are independent of the application threshold. The default access and protocol levels keep successful requests and normal WebSocket lifecycle events out of operational logs. Setting only `log_level` to `DEBUG` does not enable protocol dumps.

Set `access_log_level` to `INFO` for request auditing and one summary per WebSocket handshake. Set `protocol_log_level` to `DEBUG` for one lifetime summary when an accepted WebSocket closes. Routine access records retain their DEBUG label after the configured threshold is applied. Warnings and errors retain their original severity.

#### One-Line Summaries

Normal output contains one physical line per record. Embedded line breaks are escaped. Raw WebSocket headers, frame payloads, connection-state changes, and keepalive exchanges are suppressed, including at DEBUG. HTTP transport phase traces and development file-watcher idle messages are also suppressed.

Routine `spnego` authentication messages are suppressed, including when application logging is set to DEBUG. Warnings and errors remain enabled. The shared log filter also redacts SPNEGO, NTLM, GSSAPI, and SSPI step input and output tokens. These tokens can contain identity details and authentication material; base64 encoding does not protect them.

| Event | Information |
|---|---|
| `ws_handshake` | Request path without its query, HTTP status, and acceptance or rejection. Requests that reach the application also include a connection ID and handshake duration. Malformed requests rejected before the application starts include the rejection status. |
| `ws_closed` | Connection ID, close code, lifetime, and sent and received application-message and byte totals. These totals exclude WebSocket control frames and wire overhead. |
| `http_client` | OIDC request method, destination host and path without its query, status when available, duration, and a fixed error code on failure. |
| `storage_operation` | Browser API operation name, source ID, HTTP status, duration, and error type when available. It does not contain file paths or request bodies. |
| `monitor_cleanup` | Resource-cleanup duration and error count. Failed resource cleanup also retains its warning. |
| `image_conversion` | Converter path, image dimensions, output format and size, and conversion timings. |
| `connections_listed` | Number of visible connections. |

WebSocket traffic totals are collected per connection, not per message. Browser-operation summaries use the common API boundary for requests that reach the backend. Local-drive requests handled directly by Companion keep its own diagnostics. Long-running directory scans retain separate start and finish events so operators can identify an active pass.

#### Exception Diagnostics

Normal exception records contain an `error_id` and the exception type instead of a multiline traceback. Directory-recovery records retain their safe, condensed cause chain. Use the same `error_id` to find the full exception in `logs/backend-diagnostics.log` under the backend data directory.

The diagnostic file rotates at 10 MiB and retains three archives. New files and rotated files have owner-only read and write permissions. Full exceptions can contain private paths, provider details, or credentials. Restrict access to the data directory and review diagnostic files before sharing them.

If the backend cannot create the diagnostic file, it reports a permission error and sends full exception diagnostics to standard error. Standard output remains condensed. Correct the data-directory permissions and restart the backend to restore file diagnostics.

### Browser App Logging

The browser app supports both:

- Console logging for local development and debugging.
- Backend tracing for server-side log collection when production or mobile debugging needs it.

That means a logging change can affect both developer ergonomics and support visibility.

### Companion and Service-Side Logging

The companion has its own desktop-side logging path, and operational logs are still important on the backend and in local development scripts.

- Use the shared logging utilities where the app already has them.
- Keep log messages specific enough to be actionable.
- Avoid replacing structured or filtered logging with scattered ad hoc output.

For local environment diagnosis, the repo also provides supported log and service-status scripts instead of relying entirely on manual process inspection.

### Directory-Search Diagnostics

Use fixed event names and route templates with status, duration, and counts. Do not log search terms, request payloads, pairing codes, or credentials. Omit paths except for the bounded directory-scan item diagnostics below. Log committed changes only after commit; use numeric error codes instead of exception text that can expose private data.

Directory scans emit `directory_scan_started`, `directory_scan_finished`, and `directory_scan_invalidated` at INFO. Finish events report committed progress, group commits, duration, and a fixed abort reason. Invalidation events include the reason and a counter, even when the reason repeats. Use these events to distinguish a resumed pass from repeated observation loss. A lifecycle change alone does not require completed parents to be read again.

Item diagnostics use the fixed codes `access_denied`, `unsafe_traversal`, `unsupported_encoding`, and `scan_failed`. The shared `max_logged_scan_issues_per_pass` limit permits at most 20 individual INFO messages in total per pass, with a quoted source path and no private exception text. Restrict access to logs because these messages contain directory names. Pass totals retain all issue counts, including suppressed messages. Backend finish events carry numeric totals; Companion emits `directory_scan_issue_totals` before its finish event. Partial coverage is not a scan abort.

Backend pass logs include `smb_round_trips`, the number of directory-index request groups attempted during the pass. One compound counts once, not once for each message. Root and metadata probes, loop queries, cleanup requests, and credit-growth echoes count separately. Credit admission that rejects a compound without sending it counts zero. Failed send attempts count, so this is not a measurement of completed network exchanges or latency. Ordinary file browsing is not included.

Companion pass logs include `native_opens`, the number of directory-open attempts made by the source traversal during the pass. The count includes root verification, Linux mount-policy directory checks, fallback traversal, and failed opens. It excludes metadata queries, closes, and index-file I/O. Both counters use per-pass differences from a source-owned total, which survives root rebinding. Start events include the prepared generation, phase, queue counts, and I/O performed during setup. Use the counters to identify repeated opens and probes, and the duration to measure elapsed scan time.

See [Directory-Index Consistency](../../backend-architecture/smb-change-notification-and-directory-freshness/#directory-index-consistency) for lifecycle and storage rules. See [Companion Support Reference](../../../admin-guide/reference/companion-support-reference/#logging-controls) for operational logging controls.

## Localization Model

Localization is a typed system, not just a string file.

### Sources of Truth

| Area | Source |
|---|---|
| Browser app translations | `frontend/src/i18n/resources.ts` |
| Companion translations | `companion/src/i18n/resources.ts` |
| Typed wrappers | each app's `i18n/index.ts` layer |

English is the source locale, and the pseudo-locale is generated automatically from the English tree.

### Contributor Rules

- Add new UI strings through the translation resources instead of hard-coding copy.
- Keep translation keys type-safe instead of casting around the type system.
- Preserve the distinction between UI language and regional formatting behavior.
- Companion localization uses the shared settings protocol. Deliver stored preferences, including `browser`; Companion resolves them from its own operating-system locale.

## What Contributors Must Preserve

### Logging

- Browser app logging and backend tracing are related but separately configurable.
- Logging changes should not silently remove trace visibility that support workflows depend on.
- Diagnostics should stay specific and action-oriented.

### Localization

- Typed keys should remain enforced.
- Browser UI formatting uses effective locale values. Shared Companion delivery carries stored preferences, and Companion resolves its own effective locale.
- App-owned UI text should stay translatable.

For the concrete contributor workflow, continue to [Localization and Locale Behavior](../localization-and-locale-behavior/).

## Common Failure Modes

- Adding UI text without a translation key.
- Bypassing typed translation keys with casts.
- Changing localization behavior in the browser app without checking companion sync effects.
- Switching logging behavior in a way that helps local debugging but breaks backend tracing or support visibility.
- Flooding logs with noisy messages that hide the actionable ones.

## Validation Expectations

When this area changes, usually run:

```bash
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd companion && npx tsc --noEmit
cd companion && npm run lint
```

For higher-confidence changes, add the relevant frontend or companion tests, especially when localization sync or logging configuration behavior changes.

Use [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/) to decide when those cross-boundary checks need to extend further.
