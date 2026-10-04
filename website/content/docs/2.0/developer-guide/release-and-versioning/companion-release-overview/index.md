+++
title = "Companion Release Overview"
+++

Sambee Companion releases are built and published once. A successful build automatically promotes the release to `test`; later channel promotion rewrites public feed files without rebuilding binaries.

Key differences between the Companion and Docker release paths:

- Docker releases promote an already published container image.
- Companion releases promote an already published GitHub Release by rewriting feeds read by Companion's auto-updater and by the Sambee frontend.
- Docker images are available for Linux only, whereas Companion is a native app for Windows, Linux, and macOS. Each platform binary needs to be built on the respective OS.

## Summary

If you want to take a new Companion version to `stable`, follow this order:

1. Increment `VERSION` to the next `X.Y.Z` value and run `./scripts/sync-version`.
1. Run `Release: Build Companion Artifact`:
   - Select target platforms
   - If the workflow's source version field is left blank, the artifact is built from the current commit in `main`, and the Git tag `build-vX.Y.Z` is created to reserve the version for the commit the artifact is built from.
   - If a source version field is specified, the workflow verifies and repairs the artifact associated with the version via the Git tag used for reservation.
1. The workflow builds and signs Companion, publishes the verified immutable release in the [Companion GitHub repo](https://github.com/sambee-app/sambee-companion/releases), promotes it to `test`, and cleans up obsolete releases.
1. Test the published release through the `test` channel or by installing its release assets.
1. Run `Release: Promote Companion Release` when the release is approved for `beta`, `stable`, or Sambee download metadata.

One published release can move from `test` to `beta` to `stable` without rebuilding binaries.

Read the detailed pages in this order:

1. [Build Companion Release](../build-companion-release/)
1. [Promote Companion Release](../promote-companion-release/)
1. [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/)
1. [Companion Release Cleanup](../companion-release-cleanup/)

## Workflow Map

| Workflow | When to use it | Result |
|---|---|---|
| Local `npm run check:rust:windows` | You want an early local Windows-target compatibility signal while working in Linux or the devcontainer. | Runs a Windows GNU target `cargo check` only. It does not create signed release assets. |
| `Release: Build Companion Artifact` | You want to create release assets for one canonical version. | Builds the selected platform set, publishes the verified immutable GitHub Release, promotes only `test`, and cleans up obsolete releases. |
| `Release: Promote Companion Release` | A published Companion release is approved for one or more channels or for Sambee download metadata. | Rewrites the selected feed files in `docs/feeds` of the release repository. |
| `Maintenance: Clean Up Companion Releases` | You want to reconcile release retention outside a promotion run. | Validates the feed markers and deletes obsolete GitHub Releases. |

## Main Control Points

| File or system | Role |
|---|---|
| `.github/workflows/build-companion.yml` | Builds platform artifacts from a canonical source, publishes the verified release, promotes `test`, and runs cleanup. |
| `.github/workflows/promote-companion-release.yml` | Promotes one published release to selected public feeds. |
| `.github/scripts/promote_companion_release.py` | Resolves release assets and writes the feed JSON files. |
| `.github/scripts/cleanup_companion_releases.py` | Validates feed references and applies Companion release retention. |
| [sambee-app/sambee-companion](https://github.com/sambee-app/sambee-companion/) | Dedicated public release repository for Companion GitHub Releases and committed feed source files. |
| `release-repo/docs/feeds` | Source-controlled feed JSON files that promotion updates and commits ([docs](../companion-channels-feeds-and-downloads/)). |

## Published Artifact

Published Companion releases live in [sambee-app/sambee-companion](https://github.com/sambee-app/sambee-companion/) as GitHub Releases.

Each release may contain:

- Installer assets.
- Tauri updater bundles.
- `.sig` files for updater verification.
- Release notes.
