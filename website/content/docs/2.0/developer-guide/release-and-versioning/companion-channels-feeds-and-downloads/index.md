+++
title = "Companion Channels, Feeds & Downloads"
+++

Use this page when you need the system model behind Companion release promotion.

It explains which public files exist, who reads them, and why channel promotion does not require rebuilding binaries.

{{< companion-promotion-overview >}}

## Core Model

Companion release distribution is intentionally split between build control in the main repository, release assets in a dedicated release repository, and public feed serving from a separate feed host.

That split keeps Companion binaries out of normal Sambee deployments while still letting:

- Sambee render Companion download links.
- Installed Companion builds fetch updates.

The current model uses four moving parts:

1. The main `sambee` repository builds Companion releases.
2. The dedicated `sambee-companion` repository hosts immutable GitHub Release assets and stores the committed feed files under `docs/feeds`.
3. The separate host `https://release-feeds.sambee.net` serves those committed feed files publicly.
4. Channel manifests under `stable`, `beta`, and `test` decide which published release installed Companion builds see.
5. A separate Sambee download-metadata file decides which installer links Sambee renders in the product UI.

The important consequence is simple: channels are feed pointers, not separate binaries.

Every successful Companion build moves only the `test` updater feed. It does not change `beta`, `stable`, or the Sambee download-metadata feed.

## Public Distribution Surface

Published Companion releases live in `sambee-app/sambee-companion` as GitHub Releases.

The public feed host is:

- `https://release-feeds.sambee.net`

That host is separate from the main `sambee.net` website deployment in this repository.
The website workflow here deploys `website/public` to Cloudflare Pages for `sambee.net`, while the live feed host currently responds separately.

The current public layout is:

```text
feeds/companion/tauri/stable/latest.json
feeds/companion/tauri/beta/latest.json
feeds/companion/tauri/test/latest.json
feeds/sambee/companion/latest.json
```

Inside the release repository, those files are committed under `docs/feeds/`.
That repository path is the source of the published feed JSON, not the same thing as the main website source tree in this repository.

## Who Reads What

| Consumer | Public file | Format | Purpose |
|---|---|---|---|
| Installed Companion builds | `feeds/companion/tauri/<channel>/latest.json` | Tauri updater JSON | Exposes the published release visible to the selected update channel. |
| Sambee backend | `feeds/sambee/companion/latest.json` | Sambee-specific download metadata | Exposes version, notes, and installer URLs for the product UI. |

Sambee and Companion do not read the same feed.

- Promoting a Companion channel changes auto-update visibility for installed desktop apps.
- Promoting the Sambee metadata feed changes which direct downloads the product surfaces.
- The same published release can move across `test`, `beta`, and `stable` over time.
- The build workflow promotes `test` automatically; later promotion targets remain manual.

## Feed Rules

Installed Companion builds consume standard Tauri updater JSON.

Important behavior:

- Each channel manifest points to immutable release assets in `sambee-companion`.
- Feed files can move between releases over time, but published asset URLs should not be patched in place.
- Each publishable release uses a new plain numeric `X.Y.Z` version. Tauri offers an update only when the later version is greater; publishing replacement bytes under an equal version is unsupported.
- The promotion script includes every platform for which it finds a complete bundle-and-signature pair.
- A release does not need every platform to be promotable.

Sambee uses a different JSON document.

Important behavior:

- It contains only what Sambee needs to render download UI.
- The asset map can contain any supported subset of discovered installers.
- Sambee does not read the Tauri channel manifests directly.

## Runtime Behavior

Companion uses `tauri-plugin-updater` for self-update checks.

The runtime updater is channel-aware:

- The Rust update commands build the updater URL from the selected channel at runtime.
- The frontend stores the local preference as `companionUpdateChannel`.
- Allowed channel values are `stable`, `beta`, and `test`.
- The default channel is `stable`.

In practice, that means the same installed app can see different releases over time based on the local channel setting and the currently promoted feed file.

## Sambee Integration

Sambee does not bundle Companion binaries.

By default, the backend resolves Companion download metadata from `https://release-feeds.sambee.net/feeds/sambee/companion/latest.json`.

The backend then:

- Fetches the hosted Companion download metadata.
- Normalizes and validates installer URLs.
- Exposes the result through the backend API to the frontend.

Sambee also supports a deterministic pin override in configuration.

When a pin is configured, the backend stops using the hosted feed for Companion download links and serves the pinned version, notes, and installer URLs instead.

## App Identity And Signing

Companion uses one app identity across all update channels.

Channel separation comes from feed selection, not from separate binaries or per-channel app identifiers.

Companion also uses one Tauri updater signing key across all channels.

- Updater artifacts are signed during release builds.
- Installed Companion builds verify updates using the embedded updater public key.
- Platform-specific installer signing is separate from the Tauri updater signature.
