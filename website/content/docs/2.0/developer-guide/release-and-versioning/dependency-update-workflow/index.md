+++
title = "Dependency Update Workflow"
+++

Use this page for routine dependency updates and dependency-related release preparation. Use [Product Versioning](../product-versioning/) when changing the Sambee version, and [Release Checklist](../release-checklist/) when preparing a complete product release.

## Dependency Update Rules

Routine install behavior and actual dependency changes are different workflows.

- use `npm ci` for routine installs in `frontend/` and `companion/`
- use the hashed backend lockfiles for routine Python installs
- do not hand-edit generated lockfile details when the repository already provides a regeneration workflow
- accept Dependabot updates to backend requirements and pip-compile lockfiles when CI validation passes

### Frontend Install Freshness

`./scripts/test` checks frontend dependency freshness before generating test
fixtures or running backend tests. It stops if the install stamp is missing or
doesn't match the current `frontend/package.json` and
`frontend/package-lock.json`. It doesn't install dependencies automatically or
require network access for the check.

To restore the frontend environment, run this from the repository root:

```bash
cd frontend && npm ci
```

The install lifecycle clears any previous stamp before setup and writes a SHA-256
hash to `frontend/node_modules/.dependencies.sha256` only after the existing
postinstall setup succeeds. The stamp is local to the installed environment and
isn't committed. Existing installations need one successful `npm ci` to create
it. Installations using `--ignore-scripts` won't create the stamp.

To check the environment separately, run:

```bash
cd frontend && npm run check:dependencies
```

The hash covers both files in full, so metadata-only changes also require a fresh
install. This check detects changed dependency inputs, not arbitrary damage to
installed packages. If individual packages are missing despite a matching stamp,
run `npm ci` again.

### Biome Version Alignment

`npm run lint` in `frontend/` and `companion/` checks the Biome version before
linting source files. Each check requires an exact `@biomejs/biome` pin that
matches the lockfile, installed package, and configuration schemas. The companion
check also validates the shared frontend and repository-root schemas.

To run the checks separately from the repository root:

```bash
npm --prefix frontend run check:biome
npm --prefix companion run check:biome
```

Keep both projects on the same Biome version because they share configuration.
Update both package pins, regenerate their lockfiles with npm, and migrate the
configuration schemas together. If only the installed version is stale, run
`npm ci` in the affected project. These checks do not install dependencies.

### Backend Dependency Updates

For routine Dependabot backend dependency-update pull requests:

- review the direct requirement and generated lockfile changes
- do not rerun the backend lockfile refresh script only to satisfy CI
- validate with backend tests and type checking

CI verifies that direct source pins match both generated lockfiles. The backend
test image and production Docker image validate hash-enforced installations.

For manual backend dependency changes or an intentional full transitive refresh:

- update `requirements.txt` and `requirements-dev.txt` first
- regenerate `requirements.lock.txt` and `requirements-dev.lock.txt` through `scripts/refresh-backend-lockfiles`
- treat resolver conflicts as real compatibility constraints instead of forcing transitive pins by hand
- avoid hand-editing lockfile hashes except as a last resort

Use `scripts/refresh-backend-lockfiles --check` when you deliberately want to
compare the committed locks with a new clean dependency resolution. It is an
optional maintenance check, not a required step for routine Dependabot pull
requests.

### Container Build Pip

`backend/build-tools/requirements.txt` pins the build-time pip version and its
wheel SHA-256 hash. Keep this file separate from the application lockfiles.
Dependabot checks this directory each week and can update the version and hashes
in one pull request. Don't copy the pin or download checksum into the Dockerfile.

Before Python dependency downloads, `scripts/bootstrap-build-pip.py` fetches the
pinned wheel through Python's standard-library HTTPS client and the system CA
store. It checks the wheel against the committed hashes, then runs that wheel
directly to install pip offline. The old pip isn't used for the download or
upgrade. The shared runtime, native `pyvips` wheel builder, and backend-test
virtual environment all use this bootstrap step.

The production target installs the application dependencies, runs `pip check`,
then uninstalls pip and removes Python's separate `ensurepip` bootstrap copy.
The test, beta, and stable channels use this same production image. They can't
install packages with pip at runtime; change the dependency inputs and rebuild
the image instead. Development and backend-test targets keep pip.

The upgrade and cleanup steps are cached before application source is copied.
Uncached builds need a pip download, but application-only builds can reuse the
dependency layer. Files from the base image can remain in older image layers,
even after they're removed from the final filesystem.

For build-pip updates:

- Run `backend/.venv/bin/python -m pytest backend/tests/test_bootstrap_build_pip_script.py`.
- Validate startup and the absence of pip, its launchers and metadata, and `ensurepip` in both production image architectures.
- Run the container vulnerability scan. A pip release can still include vulnerable bundled libraries; a version update alone doesn't prove that all findings are fixed.

### High-Risk Dependency Areas

Some ecosystems are intentionally treated as coordinated manual changes rather than casual bumps.

- high-risk frontend packages such as React, Vite, TypeScript, and MUI
- companion Tauri package and crate alignment
- backend packages with higher behavioral risk such as `smbprotocol` and `pyvips`

Additional contributor rules in those areas:

- keep companion Tauri JavaScript packages and Rust crates on matching major.minor versions
- validate companion Tauri alignment with `scripts/check_tauri_version_alignment.py` when those dependencies move
- review Dependabot proposals for the shared Python runtime base as container-runtime changes
- confirm Docker target validation reports the expected Python and SQLite versions before merging a Python runtime update
- expect Debian packages to refresh during cache-busted image builds; do not hand-pin individual APT packages unless reproducibility requirements change
- prefer committed scripts and lockfiles over one-off installers or floating `npx` downloads

## Dependency Security Audits

The audit workflow and Dependabot configuration now live in the Developer Guide security section.

Use [Dependency Security and Dependabot](../../security/dependency-security-and-dependabot/) for:

- Dependabot grouping and ignore rules
- scheduled dependency audit coverage

Use [Container Image Security and Artifact Integrity](../../security/container-image-security-and-artifact-integrity/) for:

- container-image vulnerability scanning
- Trivy suppression policy
- image signing, SBOM, and provenance controls

Keep this page focused on dependency inputs, generated lockfiles, and dependency-specific validation.

## Validation Expectations

At minimum, run the checks for the subsystem whose release-sensitive files changed.

Common examples:

```bash
cd backend && pytest -v
cd backend && mypy app
cd frontend && npm run typecheck && npm run lint
cd companion && npx tsc --noEmit && npm run lint
```

Choose the relevant subset based on the dependencies that changed.
