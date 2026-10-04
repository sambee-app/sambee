+++
title = "Companion Release Cleanup"
+++

Companion cleanup removes obsolete GitHub Releases after a successful feed promotion. It also runs on a schedule and can be started manually as `Maintenance: Clean Up Companion Releases`.

## Retention Rules

Cleanup keeps:

- Every published, non-prerelease release referenced by a `test`, `beta`, `stable`, or Sambee feed marker.
- The latest published, non-prerelease `companion-vX.Y.Z` release in every `X.Y` series.

For example, it keeps `companion-v8.0.13` and deletes `companion-v8.0.12` unless a feed still points to the older release.

Cleanup deletes every other GitHub Release, including obsolete drafts, GitHub prereleases, and noncanonical legacy releases. It does not delete Git tags.

## Safety Checks

Before deleting anything, cleanup reads the committed feed files in `sambee-companion` and validates every referenced release asset.

For each present marker, it requires:

- A plain numeric `X.Y.Z` version.
- Asset URLs for `sambee-app/sambee-companion` release downloads.
- One canonical `companion-vX.Y.Z` release tag for every asset in the marker.
- A marker version that matches that tag.
- A published, non-prerelease release containing every referenced asset.

Missing marker files represent an unpromoted channel and do not protect a release. A malformed present marker, inconsistent asset URL, missing asset, ambiguous release, or GitHub API failure stops cleanup before deletion.

The `companion-release-publication` concurrency group prevents cleanup from overlapping an active provisional release upload.

## When It Runs

Cleanup runs after automatic `test` promotion from `Release: Build Companion Artifact` and after successful manual `Release: Promote Companion Release` runs. Use the maintenance workflow when you need an additional reconciliation pass.

