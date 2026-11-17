+++
title = "Set up the Development Environment"
+++

The supported contributor path is the repository dev container.

## Preferred Setup Path

The project is designed to be opened in VS Code with Dev Containers.

Baseline assumptions from the maintained setup:

- The dev container and production image inherit the same pinned Python runtime base from the root `Dockerfile`.
- Node and npm are available for frontend and companion work.
- Rust tooling is available for companion development.
- Post-create setup installs reviewed dependencies, initializes local state, and prepares default config where needed.

### Runtime Package Refreshes

The shared runtime base refreshes Debian packages, including SQLite, before it installs the runtime dependencies. Production and CI image builds use a unique refresh key, so each build checks the current Debian packages instead of reusing a cached package-upgrade layer.

Local Dev Containers can reuse Docker's build cache. Use **Dev Containers: Rebuild Container Without Cache** when you need the current available Debian packages locally. The runtime's Python, SQLite module, and `libsqlite3-0` package versions are reported by Docker image validation in CI.

Independent builds made on different days can resolve different Debian security updates. This is intentional: the shared base controls the package policy and Python runtime, while regular rebuilds keep native packages current without maintaining a separate internal base-image release process.

## First-Time Setup

1. Open the repository in VS Code.
1. Reopen in the dev container when prompted.
1. Let the post-create setup complete.

The standard setup performs these tasks automatically:

- configures Git hooks used by the repository workflow
- installs backend dependencies from the hashed lockfiles
- installs Node dependencies from the committed lockfiles
- installs `pip-audit` and `cargo-audit` at the pinned versions used in CI
- initializes the local database
- creates a default `config.toml` if one is missing

Backend tools run from `backend/.venv`. VS Code selects that interpreter, and the backend workspace tasks use it explicitly. Use `backend/.venv/bin/python -m <tool>` for manual backend commands.

The Git-hook setup matters more than it first appears.

- the repo uses hooks from `.githooks/`
- those hooks keep `GIT_COMMIT` aligned after commits and checkouts
- they preserve the repository's Git LFS hook integration
- they block pushes of `wip/*` branches
- they refresh the committed docs structure report automatically when staged docs inputs affect it

If you work outside the dev container, run:

```bash
./scripts/setup-git-hooks
```

When you want to refresh docs-derived artifacts manually, use the workspace task `Website: Refresh Docs Derived Artifacts` or run:

```bash
python3 scripts/update-docs-derived-artifacts.py
```

## Local Service URLs

In the standard development setup, the main services are:

- frontend: `http://localhost:3000`
- backend: `http://localhost:8000`

The backend and frontend dev servers are usually started automatically by the workspace tasks.

### Backend Reload Scope

The backend dev launcher watches Python sources under `backend/app/`, not the complete workspace. It checks the active root `config.toml` separately so edits, atomic saves, deletion, and recreation still trigger a reload. `SAMBEE_CONFIG_PATH` can select another configuration file, including a symlink.

Website output and dependency directories are outside the backend watch scope. The configuration check reads file metadata, not the complete workspace. This keeps local reload monitoring inexpensive when the host requires polling.

Restart the backend dev task after changes to the launcher itself.

## Dependency Trust Rules

Contributors are expected to use the reviewed dependency workflow rather than ad hoc installs.

- use `npm ci` in `frontend/`, `companion/`, and `website/` for routine installs
- use the backend lockfile workflow instead of floating Python installs
- treat `requirements*.txt`, lockfiles, and version metadata as reviewed source, not disposable setup noise
- keep Tauri JavaScript packages and Rust crates aligned when companion dependencies move
- review Dependabot Python runtime image updates with the Docker target validation results
- treat high-risk frontend ecosystem upgrades as coordinated manual changes

## Configuration Expectations

Local development depends on configuration, but the repo is designed to create a sane default local configuration automatically.

- `config.example.toml` is the template
- `config.toml` is the active local configuration
- the backend startup workflow creates a default config with secure keys if one is missing

Do not assume production deployment rules and local development rules are identical. The Admin Guide covers deployment-specific setup.

## When to Leave the Happy Path

Use the default container-based workflow unless you have a specific reason not to.

- If your issue is environment-specific, fix the supported workflow first.
- If you change tooling or dependencies, expect to update the corresponding reviewed inputs and rerun the relevant validation commands.
- If you change version metadata, treat `VERSION` and the sync workflow as part of the change.

## Common Setup Failures

If startup fails immediately after opening the dev container, start with the supported workflow rather than ad hoc fixes.

Common cases:

- missing `config.toml`: the backend startup workflow should create a default config automatically
- frontend `vite: not found` or `node_modules` permission failures: remove the broken install and rerun `npm ci` in `frontend/`
- service startup confusion: backend and frontend dev servers are usually started by workspace tasks, so check task state before assuming the app itself is broken

Once the environment is ready, continue to [Common Task Commands](../common-task-commands/).
