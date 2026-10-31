+++
title = "Promote Companion Release"
+++

This is step 2 of the Companion release flow.

Use this workflow to point one or more public feeds at an already published Companion release. GitHub Actions displays this workflow as `Release: Promote Companion Release`.

This workflow does not rebuild binaries. It rewrites feed files in the public release repository and commits those pointer changes. See [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) for the public feed layout and serving model.

## Use It When

Run the promotion workflow when:

- A published Companion release should become visible on `test`, `beta`, or `stable`.
- Sambee should start offering direct downloads for that same published release.
- You want to move an already published release from one visibility level to another without rebuilding it.

Do not use this workflow for draft releases.
Promotion should target a published release only.

## Inputs

The manual workflow accepts these inputs:

| Input | What it means | Typical usage |
|---|---|---|
| `release_ref` | The release to promote. | Use the Companion tag for the clearest intent, for example `companion-v0.6.0`. |
| `companion_channel_test` | Update the Companion `test` updater feed. | Use when installed test-channel builds should see this release. |
| `companion_channel_beta` | Update the Companion `beta` updater feed. | Use when prerelease users should see this release. |
| `companion_channel_stable` | Update the Companion `stable` updater feed. | Use when the release is approved for normal users. |
| `sambee` | Update the Sambee Companion download-metadata feed. | Use when Sambee should offer this release for direct download. |

`release_ref` can be:

- A Companion tag such as `companion-v0.6.0`.
- A GitHub release URL.
- A numeric GitHub release ID.

The workflow reads the selected release's immutable provenance and derives the required public Sambee authorization tag as `vX.Y.Z`. That public release must contain `sambee-release.json` with a matching version, build tag, source SHA, and Companion-compatible scope.

At least one target must be selected.

## What It Updates

The workflow checks out both repositories, resolves the release, and rewrites only the selected feed files in `helgeklein/sambee-companion`.

Selected Companion channel targets update the appropriate updater manifest. The Sambee target updates the direct-download metadata document. [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) defines those files and their consumers.

After rewriting the files, the workflow commits and pushes the feed updates to the release repository, where they become available to their consumers.

## Validation Rules

Promotion is intentionally strict.

It fails when:

- No promotion target was selected.
- The referenced release is still a draft.
- The release has no assets.
- The external release provenance or completion marker does not exactly match its assets and checksums.
- The public `sambee-release.json` does not authorize `companion` or `both`, or its version, build tag, or source SHA differs from the Companion provenance.
- A selected Tauri feed target lacks a required bundle-and-signature pair for an included platform.
- The Sambee metadata target would have no usable downloadable installer assets.

A release does not need every supported platform to be promotable.
It only needs complete assets for the platforms that are actually included in the selected feed output.

## Promotion Targets Mean Different Things

Companion updater feeds and Sambee download metadata are separate surfaces.

- Promote a Companion channel when installed desktop apps should see the release through self-update.
- Promote Sambee metadata when the product UI should offer the release as a direct download.
- Select both to make the same release available through self-update and direct download.

Use [Companion Channels, Feeds, And Downloads](../companion-channels-feeds-and-downloads/) when you need the underlying model.

## Run the Workflow

Use this order when you are promoting a Companion release:

1. Publish the reviewed draft release in `helgeklein/sambee-companion`.
2. Start `Release: Promote Companion Release`.
3. Set `release_ref` to the exact published release you want to expose.
4. Select only the feed targets you intend to change.
5. Let the workflow derive the matching public Sambee release, then update and push the selected feed files.
6. Validate the affected updater channel or Sambee download surface.
7. Rerun the same workflow later if that same release should move from `test` to `beta` or `stable`.

