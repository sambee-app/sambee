+++
title = "Configuration File Reference"
+++

This page is a compact map of the optional `config.toml` file.

Use `config.example.toml` as the source of truth for supported keys. This page explains the sections that matter most in day-to-day administration.

## How to Use This Reference

- Copy only the keys you actually need into the local `config.toml`.
- Keep the file local to the deployment and mount it read-only in production.
- Treat commented defaults in `config.example.toml` as the baseline behavior unless you override them intentionally.
- Expect most basic deployments to use only a small subset of these keys.

## High-Value Sections and Keys

| Section | Key | Operational effect |
|---|---|---|
| `[app]` | `log_level` | Sets application diagnostic verbosity and Uvicorn lifecycle logging. |
| `[app]` | `access_log_level` | Sets Uvicorn HTTP request access-log verbosity. |
| `[app]` | `protocol_log_level` | Sets Uvicorn WebSocket connection, frame, and keepalive log verbosity. |
| `[auth]` | `disable_enforcement` | Temporarily bypasses all Sambee authentication enforcement at runtime. |
| `[security]` | `access_token_expire_minutes` | Changes the short-lived API-token lifetime. OIDC sessions refresh this token in the background; configure the OIDC interactive sign-in interval separately in Authentication settings. |
| `[admin]` | `username` | Sets the initial administrator username. |
| `[image_viewer]` | `conv_size_thresh` | Controls when large images are always converted for viewing. |
| `[frontend_logging]` | `logging_enabled`, `log_level` | Controls browser-console logging behavior. |
| `[frontend_logging]` | `tracing_enabled`, `tracing_level`, `tracing_retention_hours` | Controls backend trace collection for frontend logging. |
| `[frontend_logging]` | `tracing_components`, `tracing_username_regex` | Restricts tracing by component or user scope. |
| `[directory_cache]` | `location`, `coalesce_interval_seconds`, `max_staleness_minutes` | Controls the saved directory index Sambee keeps to make browsing and search recover faster after restarts. |
| `[preprocessors.imagemagick]` | `max_file_size_bytes`, `timeout_seconds` | Sets conversion limits for ImageMagick preprocessing. |
| `[companion_downloads]` | `metadata_feed_url` | Changes where Sambee resolves Companion download metadata. |
| `[companion_downloads.pin]` | `version`, `published_at`, `notes`, asset URLs | Pins Companion download links to a specific published release instead of following the promoted feed. |

## File Search and History Policy

Use **Settings > File Search** for shared retention, results per group, and file-history exclusions. These are administrator settings, not personal File Browser preferences. The page identifies built-in defaults or a saved system override; administrators can reset an override.

Lowering retention removes the oldest history records immediately. Zero clears history and prevents new records. Image, temporary, backup, and extension exclusions apply before file history is stored. Enter one literal extension per exclusion; Sambee normalizes `TMP` to `.tmp`.

Users can clear their own file and directory histories in **Settings > File Browser**. Removing history does not delete stored files or folders.

## Backend Logging Levels

The `[app]` logging keys accept `DEBUG`, `INFO`, `WARNING`, or `ERROR`, regardless of case.

```toml
[app]
log_level = "INFO"
access_log_level = "WARNING"
protocol_log_level = "WARNING"
```

`log_level` defaults to `INFO`. `access_log_level` and `protocol_log_level` default to `WARNING`, which keeps routine successful HTTP requests and verbose WebSocket frames or pings out of normal logs. Raise either setting only for focused diagnosis. Uvicorn startup, shutdown, and error messages continue to use `log_level`.

## Keys That Deserve Extra Care

These areas have the highest operational impact:

- `[auth].disable_enforcement`: Bypasses all Sambee authentication enforcement. Use it only with a trusted reverse proxy or network perimeter that already enforces access control. It does not change the mode selected in Authentication settings and requires a restart after removal. The retired `auth_method` key is rejected at startup.
- Backend logging keys: Can significantly increase log volume, particularly `protocol_log_level = "DEBUG"`.
- Frontend logging and tracing keys: Can change both local debugging visibility and backend trace collection volume.
- `directory_cache.location`: Changes where the saved SMB directory index lives on disk.
- Companion download keys: Change what download links Sambee presents to users.
