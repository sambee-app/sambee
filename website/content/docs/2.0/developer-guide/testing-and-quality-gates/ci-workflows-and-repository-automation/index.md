+++
title = "CI Workflows and Repository Automation"
+++

Use this page to understand the GitHub Actions workflows contributors hit most often and to keep the workflow list grouped predictably in the GitHub UI.

## Naming Convention

GitHub lists workflows by the top-level `name` field.

Sambee groups workflow display names by operational purpose using `Area: Subject`.

Current workflow groups are:

- `CI`.
- `Release`.
- `Deploy`.
- `Security`.
- `Admin`.

Keep new names short, stable, and grouped by what the workflow does rather than by how it is triggered.

## Workflow Map

| Display name | File | Role |
|---|---|---|
| `CI: Test` | `.github/workflows/test.yml` | Runs the main backend, frontend, and companion validation suites. |
| `CI: Lint` | `.github/workflows/lint.yml` | Runs repository lint and formatting checks across backend, frontend, and companion. |
| `CI: Check Backend Lockfiles` | `.github/workflows/check-backend-lockfiles.yml` | Verifies that committed backend lockfiles still match the reviewed requirement sources. |
| `CI: Validate Docker Image` | `.github/workflows/docker-image-validate.yml` | Builds and smoke-tests the production container image on pull requests, pushes, and manual runs. |
| `Release: Publish Docker Image` | `.github/workflows/docker-image-publish.yml` | Promotes an existing preview candidate onto release tags and the `stable` or `beta` channel, then signs the digest. |
| `Release: Create Docker Image` | `.github/workflows/docker-image-preview-publish.yml` | Builds, validates, publishes, and signs a new preview image, forcing a fresh Debian package-layer rebuild for that run before moving the `test` channel tag. |
| `Maintenance: Backfill Docker Release Tags` | `.github/workflows/docker-image-backfill.yml` | Reattaches release tags and release-channel aliases to an already published candidate digest for an existing release. |
| `Maintenance: Clean Up Docker Package Versions` | `.github/workflows/docker-image-cleanup.yml` | Removes unprotected SHA-tagged preview GHCR package versions, prunes stale signature artifacts, and deletes unreferenced untagged package versions while preserving release-tagged and channel-protected versions including `test`. |
| `Maintenance: Clean Up Actions Caches` | `.github/workflows/cleanup-actions-caches.yml` | Removes closed-PR caches and superseded known cache keys without disabling warm caches for active builds. |
| `Maintenance: Signal Closed PR Cache Cleanup` | `.github/workflows/signal-closed-pr-cache-cleanup.yml` | Triggers cache cleanup after a pull request closes without granting the pull request write access. |
| `Release: Build Companion Artifact` | `.github/workflows/build-companion.yml` | Builds companion release artifacts for a new unique version or prerelease candidate in the public distribution repository. |
| `Release: Promote Companion Release` | `.github/workflows/promote-companion-release.yml` | Moves an existing companion release onto one or more update channels. |
| `Deploy: Website` | `.github/workflows/website-deploy.yml` | Builds the website and deploys `website/public/` to Cloudflare Pages. |
| `Security: Dependency Audit` | `.github/workflows/dependency-security.yml` | Runs scheduled and manual dependency vulnerability audits. |
| `Security: Docker Image Scan` | `.github/workflows/docker-image-security-scan.yml` | Builds the current main image, forces a fresh Debian package-layer rebuild for that run, and scans it for newly disclosed vulnerabilities. |
| `Admin: Sync Labels` | `.github/workflows/sync-labels.yml` | Synchronizes repository labels from `.github/labels.yml` without deleting unmanaged labels. |

GitHub also shows repository-level features such as `Dependabot updates` and `Dependency graph`.

Those are not repository workflows, so their display names are not controlled by these YAML files.

## CI: Test

`CI: Test` is the main validation workflow for pushes to `main`, pull requests against `main`, and manual dispatch.

It first detects which top-level product areas changed, then fans out only the relevant jobs for:

- backend
- frontend, including Chromium and Firefox browser correctness
- companion
- website documentation

Manual dispatch runs all areas. Changes to shared frontend CI infrastructure also select frontend validation.

The workflow ends with a single gate job so branch protection can depend on one stable required check instead of a changing set of per-area jobs. Require `CI: Test / test-gate` in the repository's branch protection or ruleset. A failed browser check fails the selected frontend job and therefore the gate; browser correctness doesn't wait for Docker image creation.

In the backend job, regular tests run under `pytest-xdist` for throughput, while `@performance` tests run in a separate serial pass so wall-clock assertions are not distorted by parallel worker contention.

Backend pytest runs treat unexpected warnings as errors, including resource-cleanup warnings. The shared policy in `backend/pyproject.toml` applies to both local and CI runs, and warning summaries aren't suppressed. Tests that deliberately trigger a warning must assert it with `pytest.warns(...)`, matching the warning category and message. Fix application warnings rather than ignoring them. Unavoidable dependency exceptions must be narrowly scoped and documented; the current exception covers Starlette's TestClient reference to AnyIO's deprecated `BlockingPortal` alias. Remove that exception when the dependency no longer needs it.

The `frontend` job requires a clean TypeScript check, runs Vitest, builds normal production assets, installs version-matched Playwright Chromium/Firefox binaries and their Linux dependencies, then runs `npm run test:browser:ci`. Both engines run on frontend pull requests, pushes, and manual dispatch. The same required checks run in release fallback when successful source CI cannot be reused.

The browser command requires exactly 16 production cases: four scenarios at desktop and narrow widths in each engine. They protect real normalization/syntax workers, entity decoding, native selection/focus/heading links/search, regex replacement with undo/redo and exact Save content, and cancellation/reopen cleanup with stale-result replay. Two additional development-worker cases exercise Vite's dependency-resolution path. Browser APIs and workers are real; backend responses are mocked at `http://localhost:3000/browse/smb/demo`. This isn't full-stack SMB E2E or evidence of physical printing, browser-menu Find, hardware IME, or assistive-technology behavior.

The correctness reporter rejects missing, duplicate, skipped, failed, and retried cases. Browser cases run with one worker and no retries. Reports and retained failure traces/screenshots are uploaded for seven days. Timing budgets, profiling, heap measurements, alternate renderers, and repeated cache/performance matrices remain separate opt-in diagnostics.

`npm run typecheck` runs `tsc -b --noEmit` across the application, test/helper, and Node configuration projects. Browser code uses browser types; tests add Vitest and Node types; configuration tooling uses Node types. All source and declaration files remain checked with strict null/index and unused-code diagnostics enabled. The ES2023 library declarations describe existing APIs; the emitted target remains ES2020, and declarations don't provide runtime polyfills.

Type correctness is mandatory in routine CI, release fallback, ordinary `npm run build`, `./scripts/test`, and the VS Code frontend validation task. The old root `tsc --noEmit` command checked no input files and mustn't be used as a substitute. Regression tests protect required command wiring, strict options, separate environments, and complete source coverage. Unit and browser correctness remain independent required gates.

The required gate rejects an unexpectedly skipped selected job. Only unrelated, unselected areas may be skipped. Superseded pull-request test/lint runs are cancelled; main-branch validation runs aren't cancelled by that policy. Release reuse requires the exact source commit's successful frontend job, its successful browser-correctness step, and the new required `Verify frontend type correctness` step. Missing, skipped, or failed steps and legacy advisory type-check runs don't qualify.

The current companion test job does not call `./scripts/test`.
It runs explicit steps for Node install, companion TypeScript type checking, and the archive topology conformance script, including Rust tests, formatting, and Clippy.
That means the local Windows GNU cross-check in `./scripts/test` does not currently run in `CI: Test`.

### Caching Model

The test workflow uses layered caching to reduce repeated setup work while keeping dependency inputs explicit.

Current cache layers include:

- GitHub Actions BuildKit caching for the `backend-test` Docker target, with dependency layers before source copies.
- `actions/setup-node` npm download caching for frontend and companion jobs.
- Rust build caching for `companion/src-tauri`.

Frontend jobs use clean `npm ci --prefer-offline` installs; they don't cache `node_modules` or Playwright browser downloads. The mypy cache inside the disposable backend test container isn't persisted separately.

Vitest file parallelism is capped at four workers and further limited by the runner's available CPUs and RAM, reserving 2 GiB plus 2 GiB per worker. The CI command logs the actual resources and selected cap. Standard public Ubuntu runners currently provide 4 vCPUs/16 GB RAM; private runners provide 2 vCPUs/8 GB RAM. Local measurements on a larger machine aren't Actions performance guarantees.

Treat those cache keys as reviewed dependency inputs, not as disposable generated noise.

When dependency manifests or lockfiles change, commit the corresponding lockfile updates in the same pull request so cache invalidation and dependency review stay aligned.

### Cache Retention

`Maintenance: Clean Up Actions Caches` runs after cache-producing workflows finish and daily as a fallback. When a pull request closes, an unprivileged signal workflow runs first; its completion triggers the same cleanup. A manual run defaults to a dry run; select **Delete eligible caches** to apply the policy. Its run summary lists selected entries and the amount of storage reclaimed. The cleanup reads only trusted code from `main`, and does not run pull-request code with cache-deletion permissions.

The policy keeps the newest known cache family on `main` and each open pull request. It removes superseded Rust and website cache keys, and deletes all caches for a closed pull request after its builds finish. It skips refs with active builds and leaves unrecognized keys, including individual BuildKit blobs on active refs, alone. GitHub's normal expiration still applies to those unclassified entries. The job deletes caches by ID so a pull request's copy cannot inadvertently delete an identically keyed cache on `main`.

Review the dry-run report before changing cache-family rules. If active caches alone approach the repository storage limit, raise the limit or accept more cache misses: deleting their newest copies would make CI slower. Cleanup happens after cache uploads, so it cannot prevent a full repository from evicting caches during an upload.

### Local Parity

For fast local iteration, use `./scripts/test`.

When you want a closer CI-style pass, run the per-subsystem checks from [Test Strategy Overview](../test-strategy-overview/) and keep lockfile-driven installs intact.

For frontend work, that usually means:

- `cd frontend && npm run test` for the default Vitest suite
- `cd frontend && npm run test:ci` for runner-aware Vitest concurrency
- `cd frontend && npm run typecheck` for the complete strict compiler check
- `cd frontend && npm run build` followed by `npm run test:browser:ci` for the exact production/development browser contract
- `cd frontend && npm run test:e2e:install -- --with-deps` to install the matching browsers and Linux dependencies

`./scripts/test` now includes a local companion Windows GNU target compatibility check.
That check is intentionally a local validation aid, not part of the current `CI: Test` workflow contract.

## CI: Lint

`CI: Lint` applies the same change-detection pattern, then runs the repository's static checks for only the affected areas.

Current coverage includes:

- backend Ruff checks and formatting validation.
- frontend Biome validation.
- companion Clippy, Rustfmt, and Biome validation.

Ruff's executable-script rules (`EXE`) also check Python files throughout the repository, including `.github/`. Any Python-file change selects backend lint, as do changes to the lint workflow or `scripts/test`. These checks fail CI and `./scripts/test` on errors; they aren't advisory. A script with a shebang must be executable. Files invoked explicitly through Python, and imported modules, don't need a shebang.

The lint workflow does not run the local companion Windows GNU cross-check either.
That cross-target validation is currently a local developer workflow check, while actual Windows artifact creation remains in the release workflow.

The workflow also ends with one gate job so branch protection can depend on a stable result.

## Runner Distro Policy

All Ubuntu x64 host jobs use `ubuntu-latest`, following GitHub's managed OS migrations and runner-image updates. Native ARM64 image matrices use `ubuntu-26.04-arm`; GitHub doesn't currently document an `ubuntu-latest-arm` label. Windows and macOS coverage remains on its own platform runners.

Host runner choice doesn't replace production-runtime validation. Debian-family checks still include the backend test container and the release `validate-tests` container.

The backend job builds the `backend-test` Docker target, which inherits the same runtime base as production. It runs mypy and the backend test suites inside that target, including when a Python image or other runtime input changes. The release validation job uses the pinned Debian-based Python container because `scripts/install-system-deps` requires distro-provided ImageMagick 7, while the default Ubuntu GitHub-hosted runner image still resolves `imagemagick` to ImageMagick 6.

The release `validate-tests` job runs as root and sets `HOME=/root` at job scope. GitHub Actions can otherwise supply a mounted home directory owned by another user, which Firefox refuses to use. The override keeps dependency installation, Playwright browser installation, and browser execution on the same owned home. Hosted frontend PR checks keep the runner's normal home; don't apply `/root` globally or change ownership of GitHub's mounted directories.

## Shared Runtime Targets

The root `Dockerfile` defines a shared `runtime-base` target. Production and the VS Code dev container both inherit that target, so they use the same pinned Python image and shared runtime package-installation policy.

Before building targets, Docker validation confirms that every Python image reference in the Dockerfile uses the same tag and digest. This keeps the native wheel-builder aligned with the shared runtime when Dependabot updates the Python image.

`CI: Validate Docker Image` builds and reports the following values for the production target on each supported image platform and for the devcontainer target on Linux AMD64:

- Python version.
- `sqlite3` module version.
- Debian `libsqlite3-0` package version.

The workflow passes a unique APT refresh key to each build, which intentionally refreshes Debian packages instead of reusing an older cached upgrade layer. The reported versions are evidence of the resolved native runtime; they are not required to match across images built at different times.

Current jobs that intentionally remain on `ubuntu-latest` include:

- change-detection, label-sync, and website deployment workflows
- pure Python lint, lockfile freshness, and dependency-audit workflows
- frontend-only and companion-only validation workflows
- Docker build, smoke-test, and vulnerability-scan workflows, where the distro-sensitive logic runs inside the built image rather than on the host runner

When adding or changing a workflow, treat runner distro as part of the test contract whenever a job installs OS packages or validates native behavior.

## CI: Check Backend Lockfiles

`CI: Check Backend Lockfiles` protects the reviewed Python dependency workflow.

It runs `scripts/refresh-backend-lockfiles --check` on pushes, pull requests, and manual runs that touch backend requirement inputs, generated lockfiles, or the refresh script itself.

Use this as the fast failure signal when requirement files and generated lockfiles drift apart.

For the broader dependency-update workflow, use [Dependency Update Workflow](../../release-and-versioning/dependency-update-workflow/).

## Admin: Sync Labels

`Admin: Sync Labels` keeps repository labels aligned with `.github/labels.yml`.

It is intentionally conservative.

- Dependabot-related labels should stay declared in `.github/labels.yml`.
- The workflow uses `skip-delete: true`, so labels not declared there are left alone.

That keeps automation-owned labels deterministic without forcing the repository to delete every manually created label.

## Related Workflow Docs

Use the more specific pages for the workflows that have dedicated operational guidance:

- [Dependency Security and Dependabot](../../security/dependency-security-and-dependabot/)
- [Docker Release Overview](../../release-and-versioning/docker-release-overview/)
- [Companion Release Overview](../../release-and-versioning/companion-release-overview/)
- [Set Up Cloudflare Pages Publishing](../../../website-dev-guide/setup-and-operations/set-up-cloudflare-pages-publishing/)
