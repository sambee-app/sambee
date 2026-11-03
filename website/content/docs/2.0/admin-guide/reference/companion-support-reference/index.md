+++
title = "Companion Support Reference"
+++

## Communication and Security Model

Sambee uses two different browser-to-companion paths, depending on the workflow.

- Local-drive browsing uses the companion's localhost API on `127.0.0.1:21549`.
- Real-time local directory updates use a localhost WebSocket on the same port.
- Desktop-app opening uses the `sambee://` custom URI scheme.

The localhost API is bound to the local machine only. It is not meant for remote network access.

Localhost traffic is authenticated after pairing, but it is not transport-encrypted.

- HTTP requests use an HMAC derived from a shared secret and a current timestamp.
- WebSocket and browser resource URLs use the same HMAC model through query parameters because browsers cannot attach custom headers in those cases.
- The companion rejects requests outside the allowed clock-skew window.
- Pairing is scoped to the browser origin, not just to the machine as a whole.

The shared secret is created only after the user confirms the same pairing code in both the browser and the companion. The companion stores its copy in the OS credential store. The browser stores its copy locally for that paired browser profile at that Sambee origin.

If you need contributor-level implementation detail, continue to the developer guide page [Browser-to-Companion Trust Model](../../../../0.7/developer-guide/companion-architecture/browser-to-companion-trust-model/).

## Preference Files

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\app.sambee.companion\` |
| macOS | `~/Library/Application Support/app.sambee.companion/` |
| Linux | `~/.local/share/app.sambee.companion/` |

Deleting `user-preferences.json` and `app-preferences.json` resets companion settings.

## Directory-Search Databases

Companion stores its SQLite directory indexes in the current OS user's cache directory.

| Platform | Location |
|---|---|
| Linux | `$XDG_CACHE_HOME/app.sambee.companion/directory-index/sqlite/`, or `~/.cache/app.sambee.companion/directory-index/sqlite/` when `XDG_CACHE_HOME` is not set to an absolute path |
| Windows | `%LOCALAPPDATA%\app.sambee.companion\directory-index\sqlite\` |

These databases contain local directory paths. Keep access restricted to the device's OS user, and exit Companion before copying or removing index files. Do not edit the databases or remove individual SQLite sidecar files. macOS directory indexing is not available.

See [Manage Directory Search](../../operations-and-maintenance/manage-directory-search/) to configure resource limits and apply them to devices.

## Log Files

| Platform | Location |
|---|---|
| Windows | `%LOCALAPPDATA%\Sambee\Companion\logs\sambee-companion.log` |
| macOS | `~/Library/Application Support/app.sambee.companion/logs/sambee-companion.log` |
| Linux | `~/.local/share/sambee-companion/logs/sambee-companion.log` |

The companion writes both Rust-backend messages and TypeScript-frontend messages into the same rotating log file.

## Log Levels

| Level | When captured | Typical use |
|---|---|---|
| `error` | Always | failures that stop an operation from completing |
| `warn` | Always | degraded but non-fatal behavior |
| `info` | Verbose mode only | lifecycle steps and state transitions |
| `debug` | Verbose mode only for Sambee app and frontend logs | detailed diagnostic context |

Errors and warnings are always written, even when verbose logging is off. That keeps production incidents diagnosable without requiring the user to reproduce them in a special logging mode.

Normal verbose logging keeps dependency transport logs quiet. HTTP transport diagnostics for `reqwest`, `hyper`, `hyper_util`, `h2`, `rustls`, and `tokio_rustls` are enabled separately because they can be very noisy.

## Logging Controls

Logging settings are read once at startup, so restart the companion after changing logging registry values or logging environment variables.

Two logging toggles are available:

| Setting | Purpose |
|---|---|
| `VerboseLogging` | Enables verbose Sambee app and frontend logs. |
| `TransportLogging` | Enables HTTP transport diagnostics for `reqwest`, `hyper`, `hyper_util`, `h2`, `rustls`, and `tokio_rustls`. |

### Windows Registry Values

On Windows, configure logging through registry values under:

```text
HKEY_CURRENT_USER\Software\Sambee\Companion
```

Use type `REG_DWORD`. A non-zero value enables the setting. A missing value or `0` leaves the setting disabled.

To enable verbose Sambee app and frontend logs:

```cmd
reg add "HKCU\Software\Sambee\Companion" /v VerboseLogging /t REG_DWORD /d 1 /f
```

To enable HTTP transport diagnostics:

```cmd
reg add "HKCU\Software\Sambee\Companion" /v TransportLogging /t REG_DWORD /d 1 /f
```

To disable them again:

```cmd
reg add "HKCU\Software\Sambee\Companion" /v VerboseLogging /t REG_DWORD /d 0 /f
reg add "HKCU\Software\Sambee\Companion" /v TransportLogging /t REG_DWORD /d 0 /f
```

Restart Companion after changing either registry value.

### Linux and macOS Environment Variables

On Linux and macOS, launch the companion with environment variables for the logging modes you need.

Verbose Sambee app and frontend logs:

```bash
SAMBEE_LOG_VERBOSE=1 ./sambee-companion
```

HTTP transport diagnostics:

```bash
SAMBEE_LOG_TRANSPORT=1 ./sambee-companion
```

You can combine both logging modes:

```bash
SAMBEE_LOG_VERBOSE=1 SAMBEE_LOG_TRANSPORT=1 ./sambee-companion
```

The environment variables are also available on Windows for one-off terminal-launched debugging and take precedence over the registry values. Use `0` or `false` to force a setting off for that launch.

Use verbose logging when the normal log file does not explain why startup, local-drive access, or file-return workflows are failing. Add transport diagnostics when you need HTTP, TLS, proxy, or HTTP/2 details.

## Support Log Checklist

When collecting Companion logs for a native-editing issue, include:

- Whether the `Sambee Authentication` window appeared.
- Whether the failure happened during token exchange, file-info lookup, lock acquisition, download, upload, lock release, or heartbeat.
- Whether Companion reported a lifecycle state such as renewal required, authentication failed, lock lost, or recovery required.
- The reverse proxy or SSO product in front of Sambee, if one is used.
- The Companion log file from the affected desktop.

When verbose logging is enabled, include any operation or lock identifiers shown near the failing step. Those identifiers help correlate token exchange, lock acquisition, renewal, upload, and release events without exposing the secret material itself.

Companion sanitizes URLs before writing request diagnostics. Sensitive query values such as tokens, secrets, passwords, cookies, authorization data, sessions, keys, and theme payloads should not appear in support logs.

## Log Rotation

The companion rotates logs automatically to avoid unbounded disk growth.

- Maximum file size: 5 MB per log file.
- Maximum files: 3 total, including the active file.
- Worst-case disk usage: About 15 MB.

Rotation uses the usual numbered-copy scheme: the active `.log` becomes `.log.1`, the previous `.log.1` becomes `.log.2`, and the oldest rotated file is removed.

## Log Format

Each line follows this structure:

```text
YYYY-MM-DDThh:mm:ss.mmmZ LEVEL [module] message
```

Example:

```text
2026-02-17T14:30:45.123Z INFO  [sambee_companion_lib] Step 1: Exchanging URI token...
2026-02-17T14:30:45.456Z ERROR [frontend] Upload failed: network timeout
2026-02-17T14:30:46.789Z WARN  [sambee_companion_lib::commands::upload] Upload attempt 1/3 failed: connection refused
```

Frontend messages use the module target `frontend` so you can distinguish browser-side UI logging from Rust-side command and backend behavior.

## How Logging Reaches the File

The companion uses one unified file-log pipeline.

### Rust Side

The Rust logging module in `companion/src-tauri/src/logging.rs` implements the `log::Log` trait. Existing Rust-side `info!()`, `warn!()`, `error!()`, and `debug!()` calls therefore write into the same rotating companion log file.

If file logging initialization fails, the app falls back to stderr logging so startup can still proceed and terminal-launched sessions still have diagnostic output.

### Frontend Side

The frontend logger in `companion/src/lib/logger.ts` writes to both:

- The browser console for local developer-tools visibility.
- The Rust backend through the `log_from_frontend` Tauri command so the same message lands in the file log.

That means support logs can contain both frontend and backend events in one timeline.

The frontend logger is fire-and-forget. Logging should never block the UI or surface a user-facing error because the log write itself failed.

## Windows Webview2 Runtime Data

On Windows, the embedded WebView2 runtime stores its data at:

- `%LOCALAPPDATA%\app.sambee.companion\EBWebView\`

This directory is runtime-managed and is recreated automatically if removed.
