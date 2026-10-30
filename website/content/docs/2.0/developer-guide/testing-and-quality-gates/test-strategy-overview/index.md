+++
title = "Test Strategy Overview"
+++

Sambee has multiple subsystems, so the right validation strategy depends on which contract you changed.

## Start with the Smallest Relevant Set

Do not default to either no validation or every possible check.

- backend-only change with no shared contract impact: run backend tests and type checking
- frontend-only change: run frontend tests, type check, and lint
- companion-only change: run companion checks, the Windows GNU cross-check, and Rust tests
- shared workflow change: run every affected subsystem's checks

## Recommended Checks by Change Area

| Change area | Baseline checks |
|---|---|
| Backend behavior | `cd backend && pytest -m 'not performance' -v`, `cd backend && pytest -m performance -v`, `cd backend && mypy app` |
| Frontend behavior | `cd frontend && npm test`, `cd frontend && npx tsc --noEmit`, `cd frontend && npm run lint` |
| Companion behavior | `cd companion && npx tsc --noEmit`, `cd companion && npm run lint`, `cd companion && npm run check:rust:windows`, `cd companion/src-tauri && cargo test` |

For fast local iteration, `./scripts/test` runs the main backend, frontend, and companion suites together. Its backend pass mirrors CI by running non-performance tests in parallel and `@performance` tests in a separate serial pass. The local companion pass now also includes the Windows GNU target compatibility check when the toolchain is installed. Use `COVERAGE=1 ./scripts/test` when you want the broader CI-style coverage pass.

### Frontend Browser-Test Layers

Keep frontend browser coverage explicit instead of folding it into the default Vitest command.

- `cd frontend && npm test` runs the default Vitest suite.
- `cd frontend && npm run test:e2e` runs the default Playwright Chromium suite.
- `cd frontend && npm run test:e2e:all` runs all configured Playwright browser projects.

Install Playwright browsers locally with `cd frontend && npm run test:e2e:install` when a fresh environment does not have the browser binaries yet.

### Frontend Console Diagnostics

Frontend Vitest tests fail on every unexpected `console.warn` or `console.error` message, not only known React, MUI, or MSW warnings. The shared test setup records these messages until test cleanup is complete. Clearing or restoring Vitest mocks does not clear recorded diagnostics.

Fix the cause of unexpected output. Await asynchronous React updates with `act`, complete pending operations, and unmount components before restoring their API mocks.

If an error-path test must emit an expected diagnostic, mock that specific message and assert that it occurred. Forward unrelated messages to the original console method. Do not suppress all warnings or errors to make a test pass. Informational `console.log` output is not affected by this policy.

## Cross-Boundary Changes Need Cross-Boundary Checks

Run broader coverage when you change a shared contract, for example:

- backend response shape that the frontend consumes
- companion behavior that changes browser-facing pairing or editing flows
- localization or logging behavior that spans more than one app

## Contract-Sensitive Areas

### API Contracts

Frontend and backend compatibility depends on stable response shapes and matching types. Sambee currently protects that boundary primarily with frontend service contract tests plus backend endpoint tests for the same response families.

#### Current Pattern in This Repository

The current API-contract pattern is broader than a single logging endpoint.

- frontend contract suites live under `frontend/src/services/__tests__/`
- those tests typically mock the HTTP client, call the real frontend service methods, and assert endpoint paths, request parameters, response shapes, field types, enum values, blob headers, and error handling
- representative suites include `authApi.test.ts`, `connectionApi.test.ts`, `browseApi.test.ts`, `viewerApi.test.ts`, `mobileLoggingApi.test.ts`, and `loggingConfig.test.ts`
- backend tests validate the corresponding FastAPI surface from the server side, for example `backend/tests/test_logging_config.py`

That means an API-shape change is not just a backend refactor. It is a cross-boundary behavior change that should update backend models, backend tests, frontend types, frontend service logic, and the contract tests that bind them together.

#### What the Frontend Contract Tests Actually Check

The frontend service contract tests are not only smoke tests.

- authentication and admin flows check required fields and value shapes for token, user, and connection payloads
- browse tests check nested directory listings, `FileInfo` structure, enum values, optional metadata, and path handling
- viewer tests check binary-response behavior such as `Blob` creation, `Content-Type` handling, viewport parameters, and download semantics
- logging-config tests check the exact backend response shape and then verify behavior derived from it, such as level-threshold evaluation and disabled-state behavior

The useful rule is: test the response contract first, then test the frontend behavior that depends on that contract.

#### Logging Configuration as a Concrete Example

The logging configuration tests are a good example because they show both sides of the boundary.

- backend tests assert the `/api/logs/config` response contains `logging_enabled`, `logging_level`, `tracing_enabled`, `tracing_level`, and `tracing_components`
- frontend tests in `loggingConfig.test.ts` consume that exact shape and then verify threshold and filtering behavior that would break if the backend fields drifted

This matters because an older or copied example that still expects fields like `enabled` or `log_level` would describe the wrong contract for the current codebase.

#### When to Add or Update Contract Tests

Add or expand API contract coverage when:

- you add a new frontend-consumed endpoint
- you rename, remove, or add a response field
- you change enum values or allowed string values
- you change binary-response behavior such as MIME handling, blob creation, or download headers
- you add frontend logic that derives behavior from backend configuration values rather than just displaying them

For those changes, update both ends together:

1. backend response model or endpoint behavior
2. backend tests for the server response
3. frontend types and service methods
4. frontend contract tests for the consumed shape
5. frontend behavior tests for the logic built on top of that shape

#### Practical Contract-Testing Checklist

For a new or changed endpoint, usually verify:

- required fields exist
- field types match the frontend types
- optional fields behave correctly when present or absent
- known enum or string-literal values are accepted intentionally
- request parameters and path construction still match the backend route contract
- error responses degrade in a controlled way
- derived frontend behavior still works once the typed response is consumed

#### OpenAPI as a Future Option

Sambee exposes and tests the backend OpenAPI schema, including `/openapi.json`, but TypeScript type generation from that schema is not part of the checked-in frontend workflow today.

If API surface area grows enough to justify generation, OpenAPI-driven types are a reasonable future option because the backend is already able to publish the schema. Treat that as an explicit workflow addition, not as something the repository already guarantees.

Possible future additions include:

- generating TypeScript types from the FastAPI schema in a reviewed frontend workflow
- adding CI checks that detect generated-type drift
- widening contract-style coverage for endpoints that still rely mostly on broader unit tests or integration tests

### Localization

Localization is treated as typed product behavior, not just string replacement. If you touch translation wiring or browser-to-companion localization sync, validate the relevant frontend and companion checks.

### Companion Cross-Target Safety

Companion contributors now have a local Linux-hosted Windows-target safety check.

- `npm run check:rust:windows` runs `cargo check` for `x86_64-pc-windows-gnu`.
- In the devcontainer, the required Rust target and MinGW toolchain are preinstalled.
- This check is for compatibility validation, not for producing release-ready Windows binaries.

Keep the distinction clear:

- local cross-check: prove the Windows target still compiles far enough for contract and dependency safety
- release build: create the signed Windows installer and updater artifacts in CI on Windows runners

### Logging and Diagnostics

Logging changes can affect both local debugging and backend trace collection. Validate the app surfaces that consume those logging contracts.

## Practical Selection Rule

Use this decision order:

1. Identify which subsystem changed directly.
2. Identify which other subsystem consumes the changed contract.
3. Run baseline checks for the changed subsystem.
4. Add checks for every subsystem whose contract might now be wrong.

## When to Go beyond the Baseline

Run deeper or wider validation when:

- the change affects a high-risk workflow such as file editing, locking, upload, or pairing
- you changed dependencies or version metadata
- you changed typed API contracts
- you changed browser-sensitive editor behavior such as focus handoff, contenteditable selection, keyboard navigation, or decorator-backed editing flows
- you changed companion native dependencies, Windows-specific crates, or Tauri integration
- the change fixes a regression that previously escaped narrower coverage

The goal is not maximum command count. The goal is to prove the changed behavior still matches Sambee's cross-app contracts.

## Backend Test Structure and Fixtures

Backend tests live under `backend/tests/`.

Common files include:

- `conftest.py`: shared fixtures and test wiring
- `test_auth.py`: authentication and authorization behavior
- `test_connections.py`: SMB connection management
- `test_browser.py`: file-browsing behavior with mocked SMB backends

Common fixtures include:

- `client`
- `session`
- `admin_user`, `regular_user`
- `admin_token`, `user_token`
- `auth_headers_admin`, `auth_headers_user`
- `test_connection`
- `multiple_connections`
- `mock_smb_backend`

Use the shared fixtures instead of rebuilding the same setup in each test file.

## Performance Notes

- backend tests use `pytest-xdist` for parallel execution in the normal workflow, but `@performance` tests run separately without xdist so timing assertions stay stable
- coverage is intentionally optional during routine local work because it is slower
- use deeper coverage when the change touches risky backend behavior or when CI-equivalent evidence matters

## Go Deeper

- [Image Conversion Test Assets](../image-conversion-test-assets/): generated fixtures, real colorspace assertions, and the backend integration suite for image-conversion regressions
- [Logging and Localization](../../cross-cutting-systems/logging-and-localization/): shared cross-boundary rules that often expand the validation surface
- [How to Plan and Review a Change](../../contribution-workflows/how-to-plan-and-review-a-change/): decide scope before choosing checks
- [Dependency Update Workflow](../../release-and-versioning/dependency-update-workflow/): use this when version metadata or reviewed dependency inputs are part of the change
