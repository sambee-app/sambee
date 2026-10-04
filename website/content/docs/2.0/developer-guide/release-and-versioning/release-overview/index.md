+++
title = "Release Overview"
+++

## Principles

- The version number source of truth is the `VERSION` file in the repository.
- Every built artifact gets a unique version number.
- Each version is built only once.
- Releases happen without rebuilds but by applying tags to existing builds (Docker image) or updating channel pointers (Companion app).

## Process Overview for Test and Preview Candidates

1. Update `VERSION` to the next plain numeric `X.Y.Z` build sequence ([details](../product-versioning/)).
   - Run `./scripts/sync-version`.
   - Commit the synchronized metadata on `main`.
1. Build the affected component (see below for details).
   - Build workflows reserve the current `VERSION` by adding a Git tag when building from the latest commit.
   - Alternatively, select an existing `build-vX.Y.Z` Git tag to build from.
1. Test the resulting build.
   - Docker: Through the `test` tag.
   - Companion: Through the Companion draft release assets. Promote them to the Companion `test` feed as needed.
1. Repeat the loop with a new `Z` value when a new candidate is required. Never rebuild or replace a published artifact under the same version.

Notes:

- Docker and Companion candidates may be built independently.

## Release Process & Checklist

### Update Website

1. Review the homepage content and update it where necessary.

### Update Documentation

1. Verify [Supported File Formats](../../../user-guide/reference/supported-file-formats/) and update as necessary.
1. Finalize the target release's [What's New](/release-info/news-and-changes/whats-new/) page.
1. Mark the target version as current in `website/data/docs-versions.toml`:
   - Update the top-level `current` key, e.g.: `current = "1.0"`
   - Update the `[[versions]]` sections of the previous and the new current version
1. Run the VS Code task `Website: Refresh Docs Derived Artifacts`.
1. Review the Docs Structure Report this creates in `/workspace/website-meta/docs-reports/docs-structure-report.html`.

Git merge all changes.

### Build Docker Image

See this [Overview](../docker-release-overview/). In short:

1. Run [Release: Create Docker Image](../build-docker-image/)
   - The workflow:
      - Builds the [Docker image](https://github.com/sambee-app/sambee/pkgs/container/sambee/versions).
      - Moves the `test` tag to it.
      - Adds the `X.Y.Z` version tag.
1. To also move the `beta` tag to the newly built image, run [Release: Publish Docker Image](../promote-docker-image/) manually.

### Build Companion

See this [Overview](../companion-release-overview/). In short:

1. Run [Release: Build Companion Artifact](../build-companion-release/).
   - The workflow:
      - Creates and publishes a [Companion release](https://github.com/sambee-app/sambee-companion/releases)
      - Moves the `test` tag to it.
      - Adds the `X.Y.Z` version tag.

### Publish a Build

To publish a candidate build after testing and validation, complete the following steps.

1. Run `Release: Create Public Sambee Release`. Specify:
   - the validated canonical build version.
   - the intended scope: `docker`, `companion`, or `both`.
1. The workflow creates or verifies a draft release in the Sambee GitHub repo.
1. Review and edit the draft release's changelog, then publish it manually.

If you selected `docker` or `both`:

- Publishing the reviewed draft triggers [Release: Publish Docker Image](../promote-docker-image/) through the GitHub Release event.
   - The workflow tags the image built earlier as `beta` (if not ahead) and `stable`, and adds a `X.Y` version tag.

If you selected `companion` or `both`:

1. Run [Release: Promote Companion Release](../promote-companion-release/).
   - The workflow promotes the release to the `beta`, and/or `stable` update channels and updates the Sambee download-metadata feed.
