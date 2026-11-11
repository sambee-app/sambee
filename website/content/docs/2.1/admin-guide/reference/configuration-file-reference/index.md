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
| `[frontend_logging]` | `logging_enabled`, `log_level` | Controls browser-console logging behavior. |
| `[frontend_logging]` | `tracing_enabled`, `tracing_level`, `tracing_retention_hours` | Controls backend trace collection for frontend logging. |
| `[frontend_logging]` | `tracing_components`, `tracing_username_regex` | Restricts tracing by component or user scope. |
| `[directory_cache]` | `location` | Selects the private backend directory-index root. SQLite catalogues are reused after restart and marked unverified until background verification completes. |
| `[preprocessors.imagemagick]` | `max_file_size_bytes`, `timeout_seconds` | Sets conversion limits for ImageMagick preprocessing. |
| `[companion_downloads]` | `metadata_feed_url` | Changes where Sambee resolves Companion download metadata. |
| `[companion_downloads.pin]` | `version`, `published_at`, `notes`, asset URLs | Pins Companion download links to a specific published release instead of following the promoted feed. |

## Image Conversion Preference

Use **Settings > Administration > Image viewer > Image conversion preference** to choose how backend image previews balance CPU use and transfer size. This setting also applies to libvips conversions. Local-drive images from Companion and original downloads are unchanged.

| Option | Behavior |
| --- | --- |
| Conversion speed (default) | Use JPEG for opaque previews. A JPEG that fits the requested dimensions is sent unchanged. Encoding uses less CPU, but files can be larger. |
| Target size | Use WebP for opaque previews, including JPEGs that already fit. Keep the original fitting JPEG if WebP is not smaller. Conversion can use more CPU. |

Images with an alpha band stay WebP in both modes, except ICO images with alpha, which use PNG. EPS and AI previews stay PNG.

The saved value applies to subsequent backend preview requests without a restart. Previously loaded gallery images can remain cached; reload the page to request them again.

This setting is stored as `image_viewer.conversion_preference` in the database, with `speed` or `size` as its value. There is no TOML or environment override. If the stored value is invalid, Sambee logs an error and uses the speed default. The public support report includes the effective value and its source.

### Conversion Threshold

**Image conversion threshold** defaults to **5 MiB (5,242,880 bytes)**. Backend previews process browser-native images only when their known file size is strictly greater than this value. Zero processes every non-empty image. Formats that require conversion are always processed, regardless of this threshold. An unknown size keeps the existing format-based behavior.

This setting is stored only in the database as `image_viewer.conversion_threshold_bytes`. Changes apply to subsequent preview requests, including archive members, without a restart. Cached gallery images are not fetched again automatically. The old `[image_viewer].conv_size_thresh` configuration key is no longer supported and is not migrated.

The threshold is a transfer and conversion trade-off, not a decoded-pixel or memory limit. The 5 MiB default is a starting point, not a measured optimum. Compare 2, 5, and 10 MiB on the target device and network before tuning it. ImageMagick input-size and timeout limits are separate controls on the same page.

PDF compatibility and processing controls are under **Administration > PDF viewer**. **Administration > System** keeps archive creation limits. Personal and administration categories are each sorted by their translated labels.

## File Search and History Policy

Use **Settings > File Search** for shared retention, results per group, and file-history exclusions. These are administrator settings, not personal File Browser preferences.

**Recent files and directories to retain** defaults to 200 files and 200 directories per user, with separate limits for the lists. Existing administrator overrides remain unchanged. Lowering retention immediately removes the oldest records from both lists; zero clears both lists and prevents new records. **Results per group** defaults to 10 and applies to both search modes.

Image, temporary, backup, and extension exclusions apply only to file history before storage. Enter one literal extension per exclusion; Sambee normalizes `TMP` to `.tmp`.

Users can clear their own histories in **Settings > File Browser**. Removing history does not delete stored files or folders.

## Directory-Index Policy

Directory-index resource policies have no TOML override. Configure them in **Admin > Directory Search**; see [Manage Directory Search](../../operations-and-maintenance/manage-directory-search/) for controls, Companion approval, and recovery.

`directory_cache.location` selects only the backend storage root.

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
