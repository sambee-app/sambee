+++
title = "Promote Companion Release"
+++

This is the manual promotion step of the Companion release flow.

Use this workflow to point one or more public feeds at an already published Companion release. GitHub Actions displays this workflow as `Release: Promote Companion Release`.

This workflow does not rebuild binaries. It rewrites feed files in the public release repository and commits those pointer changes. See [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) for the public feed layout and serving model.

## Use It When

Run the promotion workflow when:

- A published Companion release should become visible on `beta` or `stable`.
- Sambee should start offering direct downloads for that same published release.
- You want to move an already published release from one visibility level to another without rebuilding it.

New builds already promote their verified published release to `test` automatically. You can still select `test` manually when you need to repair or deliberately move that feed.

Do not use this workflow for draft or GitHub prerelease releases.
Promotion should target a published, non-prerelease release only.

## Inputs

The manual workflow accepts these inputs:

| Input | What it means | Typical usage |
|---|---|---|
| `release_ref` | The release to promote. | Use the Companion tag for the clearest intent, for example `companion-v0.6.0`. |
| `companion_channel_test` | Update the Companion `test` updater feed. | Use when installed test-channel builds should see this release. |
| `companion_channel_beta` | Update the Companion `beta` updater feed. | Use when installed beta-channel builds should see this release. |
| `companion_channel_stable` | Update the Companion `stable` updater feed. | Use when the release is approved for normal users. |
| `sambee` | Update the Sambee Companion download-metadata feed. | Use when Sambee should offer this release for direct download. |

`release_ref` can be:

- A Companion tag such as `companion-v0.6.0`.
- A GitHub release URL for `sambee-app/sambee-companion`, such as `https://github.com/sambee-app/sambee-companion/releases/tag/companion-v0.6.0`.
- A numeric GitHub release ID.

Before updating feeds, the workflow verifies that the selected release's immutable provenance refers to a canonical build tag at the recorded source commit. A matching public Sambee release or Docker image is not required.

At least one target must be selected.

## What It Updates

The workflow checks out both repositories, resolves the release, and rewrites only the selected feed files in `sambee-app/sambee-companion`.

Selected Companion channel targets update the appropriate updater manifest. The Sambee target updates the direct-download metadata document. [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) defines those files and their consumers.

After rewriting the files, the workflow commits and pushes the feed updates to the release repository, where they become available to their consumers. A successful promotion then runs the same release cleanup used by new builds.

## Validation Rules

Promotion is intentionally strict.

It fails when:

- No promotion target was selected.
- The referenced release is still a draft.
- The referenced release is a GitHub prerelease.
- The release has no assets.
- The external release provenance or completion marker does not exactly match its assets and checksums.
- The Companion provenance build tag does not resolve to the recorded source commit.
- A selected Tauri feed target lacks a required bundle-and-signature pair for an included platform.
- The Sambee metadata target would have no usable downloadable installer assets.

A release does not need every supported platform to be promotable.
It only needs complete assets for the platforms that are actually included in the selected feed output.

## Promotion Targets Mean Different Things

Companion updater feeds and Sambee download metadata are separate surfaces.

- Promote a Companion channel when installed desktop apps should see the release through self-update.
- Promote Sambee metadata when the product UI should offer the release as a direct download.
- Select both when you want both outcomes from the same published release.

Use [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) when you need the underlying model.

## Run the Workflow

Use this order when you are promoting a Companion release:

1. Start `Release: Promote Companion Release`.
1. Set `release_ref` to the exact published release you want to expose.
1. Select only the feed targets you intend to change.
1. Let the workflow verify the Companion provenance, then update and push the selected feed files.
1. Validate the affected updater channel or Sambee download surface.
1. Rerun the same workflow later if that same release should move from `test` to `beta` or `stable`.
