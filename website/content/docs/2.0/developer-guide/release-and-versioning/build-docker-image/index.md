+++
title = "Build Docker Image"
+++

This is step 1 of the Docker release flow ([overview](../docker-release-overview/)).

Use `Release: Create Docker Image` to build one immutable Docker candidate from `main`. It is the only workflow that builds and pushes a new Sambee image to GitHub Container Registry (GHCR).

The workflow reserves the annotated canonical Git tag `build-vX.Y.Z` for the committed, synchronized `VERSION` source. It does not publish a GitHub Release or move `stable` or `beta`.

## Inputs

The workflow accepts only an optional existing candidate selector:

| Input | What it means | Typical usage |
|---|---|---|
| `build_version` | Reuse an existing immutable `X.Y.Z` candidate. | Leave empty for a new candidate. Use an existing value only to verify or repair its immutable aliases. |

The workflow rejects arbitrary source refs, source SHAs, and temporary version overrides. The checked-in, synchronized plain numeric `VERSION` is the only publishable version source.

## Validation

Before it publishes anything, the workflow requires the following validation checks:

- Backend type checks must pass.
- Backend tests must pass.
- Frontend type checks must pass.
- Frontend tests must pass.
- Each supported platform image must build, publish by digest, and start successfully.

For source checks, the workflow reuses successful backend and frontend jobs from `CI: Test` only when they ran on a push to `main` for the exact candidate commit. It checks each job separately. If a job was skipped, is still running, or its result cannot be verified, the release workflow runs that area's checks itself. PR checks alone do not qualify because they may test a different merge commit. Platform image builds and startup checks always run for a new candidate.

The workflow forces a fresh rebuild of the Dockerfile layer that installs Debian packages for that run. That keeps preview candidates aligned with the latest package fixes available from the Debian repositories at build time while still letting the rest of the image reuse BuildKit cache.

## Published Output

After validation, the workflow:

1. Builds and pushes native `linux/amd64` and `linux/arm64` platform manifests to the internal `ghcr.io/<owner>/sambee-staging` repository.
2. Starts those same images and waits for the health endpoint to succeed.
3. Scans those same images with Trivy.
4. Assembles the platform manifests into one multi-platform staging index and verifies its image labels.
5. Extracts per-platform SBOM and provenance payloads on native runners, then assembles and publishes a metadata bundle that names the final `sambee` image identity under the digest-derived `.meta` tag in `ghcr.io/<owner>/sambee-signatures`.
6. Signs and verifies the staging digest with Cosign using GitHub Actions OIDC.
7. Copies the verified multi-platform index by digest to the immutable `sambee:build-vX.Y.Z` marker, then verifies the final image, metadata bundle, and signature again.
8. Creates immutable `X.Y.Z` and `sha-<full-commit-sha>` aliases and moves `test` to that same verified image.

The digest is the real artifact identity. The canonical `build-vX.Y.Z` tag is the candidate source of truth; `test` is only a moving alias.

Later promotion may move `stable`, `beta`, or both channel aliases to that same image, depending on the release type and the current `beta` version.

The workflow uses digest-only platform pushes and run-scoped `stage-<run>-<attempt>-*` tags in `sambee-staging`. Treat them as internal transport artifacts, not release candidates.

Cosign writes the signature artifact into a dedicated signature repository so the main `sambee` package page stays centered on deployable image versions.
That signature repository can still show both digest-derived signature tags and referenced untagged bundle manifests, which are part of Cosign's current storage model rather than extra preview image variants.

## Retry Behavior

Signing makes at most three attempts for recognized temporary failures, such as timeouts, connection failures, rate limits, and server errors. The delays between signing attempts are 15 and 30 seconds. Authentication, permission, policy, and unknown errors stop signing without a retry. Signature verification and registry inspection remain required: the workflow reuses a valid signature if a failed command published it, and refuses another signing attempt if existing signatures fail verification or registry inspection fails. Publication stays blocked until signing and verification succeed.

The signing script accepts `SIGNATURE_SIGN_ATTEMPTS` and `SIGNATURE_SIGN_RETRY_DELAY_SECONDS` environment variables to change the attempt limit and base delay. Attempts must be positive whole numbers; delays must be non-negative whole seconds. Each retry delay is the base delay multiplied by the failed signing attempt number.

If temporary signing failures continue, check [Sigstore service status](https://status.sigstore.dev/) and the runner's connectivity to Sigstore and GHCR. After recovery, use **Re-run failed jobs** only if the staging image and required artifacts still exist. Metadata artifacts expire after one day. If cleanup removed the staging image or required artifacts expired, dispatch `Release: Create Docker Image` again with the same `build_version`; before the candidate marker exists, this can rebuild the candidate.

Before the late candidate marker is written, a failed run may be retried with the same `Z` version. The run uses a unique `stage-<run>-<attempt>-<platform>` tag in `sambee-staging` and cleans up its staging versions after promotion or failure. That package can also contain untagged digest-only platform manifests. The Docker publication lock serializes candidate and maintenance cleanup, so the cleanup may delete the whole isolated package when every tagged version is a staging tag; GHCR requires that package-level operation when the last tagged version remains. Scheduled cleanup reclaims stale staging artifacts and unreferenced signature and metadata artifacts.

After a valid candidate marker exists, a matching dispatch takes the repair-only path. It verifies the signed digest and restores only missing matching immutable aliases or the `test` pointer; it does not rebuild the image. A conflicting immutable marker requires incrementing `Z` and publishing a new candidate.

GitHub Actions concurrency is mutual exclusion, not a FIFO queue: only one pending run is retained for the publication lock. Avoid stacking dispatches. A superseded pending dispatch is safe to submit again because it did not reach a publication step.

## Security Scan Behavior

The preview workflow runs Trivy before publish.

For preview publishing, Trivy findings are advisory rather than blocking. That keeps the newest candidate available for testing while still surfacing risk clearly in the workflow output.

The preview scan runs against the same pushed platform digests that are later assembled into the published candidate index, so validation and publication use the same platform manifests.

Those manifests use the same OS-package refresh policy, so the candidate that gets published is rebuilt against current Debian package metadata for that workflow run.

## Metadata

The published image includes OCI labels for the source repository, source ref name, git revision, version, creation time, and license.

The workflow also generates `GIT_COMMIT` in CI before building because GitHub-hosted runners do not run the local git hooks that usually keep that file current. That keeps frontend and backend build metadata aligned inside the container image.
