# Windows Companion CI optimization plan

## Goal

Reduce the runtime of `windows-x64` in [Verify Companion Build](../.github/workflows/verify-companion-build.yml). Keep the full default-feature Windows test suite, the recovery-only native test, the unsigned NSIS installer, and the packaged-process smoke test. Validate the implementation locally. Do not add a benchmark workflow or dispatch GitHub Actions runs for experiments.

## Baseline

The [Windows job](https://github.com/sambee-app/sambee/actions/runs/45496435413/job/138808287258) ran on 2026-11-24 from 21:59 to 22:17 UTC for the merge ref of [PR #517](https://github.com/sambee-app/sambee/pull/517). The job took about 18.5 minutes in total. It did not find a Rust cache (`No cache found` for the `companion-windows-verification` key).

| Work | Observed time |
| --- | ---: |
| Checkout, version-sync check, toolchain, cache restore, and `npm ci` | About 0:40 |
| Crate download | 0:26 |
| Default Rust test build with full debug information | 5:24 |
| Default Rust test execution | 2:26 |
| Empty binary test harness and doc-tests (0 tests each) | About 2 seconds |
| Recovery-feature test build | 1:16 |
| Recovery-feature test execution | 1:00 |
| Rust build for the NSIS package | 5:50 |
| NSIS bundling, packaged-process smoke, and artifact upload combined | About 15 seconds |
| Rust cache cleanup and save (1.13 GB) | 1:14 |

The default suite ran 531 library tests, of which 529 passed and two were ignored. The recovery pass ran 73 tests. It repeated 72 default-suite tests to run one additional test. One minute is the measured cost of the entire second test execution, not a promised saving. The feature-specific build can still be necessary: `recovery-verification` changes compiled code in `sambee-companion`, so Cargo must compile that crate again.

The plain `cargo test` command builds three units of the `sambee-companion` package, not one. A local `cargo test --no-run --message-format=json` shows these units:

- The library test harness. It contains all 531 tests.
- The non-test library, with `staticlib`, `cdylib`, and `rlib` outputs. Only the binary test harness and the doc-tests use it.
- The binary test harness for `src/main.rs`. It contains 0 tests.

After the build, Cargo also runs the doc-tests, which contain 0 tests. The package has no `tests/`, `benches/`, or `examples/` directory.

## Implementation

### 1. Run only the recovery-specific test in the second pass

- Keep the first `cargo test` command and its failure handling. Do not move the full suite to the recovery feature.
- In [the verification workflow](../.github/workflows/verify-companion-build.yml), change the second command to select the library and use the exact test name:

  ```powershell
  $recoveryTest = 'server::directory_manager::tests::verification_controls_reconcile_gap_and_release_resources'
  $nativeTestLog = '../recovery-report/native-tests.log'
  cargo test --lib --features recovery-verification $recoveryTest -- --exact --format pretty 2>&1 |
    Tee-Object -FilePath $nativeTestLog
  if ($LASTEXITCODE -ne 0) { throw 'Native recovery test failed. Inspect recovery-report/native-tests.log.' }
  $passedTest = '^test ' + [regex]::Escape($recoveryTest) + ' \.\.\. ok$'
  if (-not (Select-String -LiteralPath $nativeTestLog -Pattern $passedTest -Quiet)) {
    throw "Expected native recovery test did not pass: $recoveryTest. Inspect recovery-report/native-tests.log."
  }
  ```

- Keep artifact upload on failure. Cargo can exit successfully when an exact filter matches zero tests, so require the named test to pass in the log. The second pass no longer needs a test-thread limit because it selects one test.
- If a later change adds another recovery-only native test, include it in verification and update the local test-list check. Do not restore the duplicate module-wide pass.

### 2. Build only the library tests in the default pass

- Change the first command to `cargo test --lib`. Keep its failure handling.
- This removes the non-test library build (including the `cdylib` link and the `staticlib` archive), the empty binary test harness, and the empty doc-test run. It keeps all 531 tests, because all of them are in the library test harness.
- Accept one reduction in compile coverage: the job no longer compiles the default-feature, non-test library in the debug profile. The NSIS package step still compiles `src/main.rs` and the non-test library (all three crate types) in the release profile. `recovery-verification` only adds code; no source uses `cfg(not(feature = "recovery-verification"))`. The only `cfg(not(test))` code ([handlers.rs](../companion/src-tauri/src/server/handlers.rs)) is therefore still compiled by the package step. No current code is compiled only when both `not(test)` and `debug_assertions` apply. If later code adds such a combination, or adds a `cfg(not(feature = "recovery-verification"))` gate, restore a non-test debug build.
- Expect a small saving. The log shows about 2 seconds for the empty harness and doc-test runs. On a local 12-core Linux machine with `CARGO_INCREMENTAL=0`, a rebuild after a change to `src/lib.rs` took about 17–18 seconds with `--lib` and about 18.5–19 seconds without it. Cargo builds the extra units in parallel with the library test harness. The Windows saving is not measured.
- If a later change adds a `tests/` directory or tests in `src/main.rs`, add `--tests` or `--bins` to the command. If it adds doc-tests, add a separate `cargo test --doc` command, because Cargo does not accept `--doc` together with `--lib`.

### 3. Generate only line-table debug information for Windows CI tests

- Set `CARGO_PROFILE_TEST_DEBUG: 'line-tables-only'` at the Windows verification job level, before the Rust cache action runs. This lets the cache action include the setting in its existing environment key.
- This removes full type and variable debug information while retaining source locations for test backtraces. It does not disable debug assertions or overflow checks. Both test commands use the test profile. Cargo applies the selected profile to all units in the build, so dependencies also get the reduced debug information. The packaging step uses the release profile and is unchanged.
- Leave the local defaults and shipping profile in [Cargo.toml](../companion/src-tauri/Cargo.toml) unchanged. Expect a cold Rust cache on the first run with the new profile setting. The time saved by removing debug information is not yet measured.

## Keep unchanged

- **Runner and job count.** The [public Windows x64 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) provides four vCPUs. Cargo already defaults to the logical CPU count. Increasing `CARGO_BUILD_JOBS` does not add CPU capacity. Do not change the full suite's test concurrency, buy larger runners, or split the job in this change.
- **Package compiler settings.** Keep LTO off, 16 codegen units, and optimization level 1 in verification. A lower optimization level or different linker needs measurement; the log does not identify a linker bottleneck. Do not combine test and package profiles: the [test harness uses unwinding](https://doc.rust-lang.org/cargo/reference/profiles.html#panic), while the package uses `panic = "abort"`, and their Cargo targets and features also differ.
- **Cache policy.** Keep the current Rust cache configuration. A cache saved on one PR's merge ref does not warm a different PR. A default-branch cache could improve restores, but adding default-branch builds has an unmeasured cost. Do not change the trigger, cache scope, or save policy in this plan. The 1:14 save cost occurs only after a cache miss: when the restore finds an exact key, the cache action reports `Cache up-to-date.` and does not save again. The Linux `companion` job in [the test workflow](../.github/workflows/test.yml) uses a different cache key and does not run `cargo test`, so it does not warm this job.
- **Feature set of the default suite.** Do not run the default suite with `recovery-verification` to avoid the second build. The feature changes runtime behavior (for example, `verification_due` in the directory manager and extra server routes), and the shipping workflow builds without it.
- **Verification evidence.** Keep the signer and updater-artifact checks, the same build outputs and `recovery-report` paths, and the smoke test of the packaged executable. Do not change the signed release workflow.

## Local validation before merge

1. Run the existing [workflow configuration tests](../backend/tests/test_release_workflow_configuration.py). In a local Windows x64 checkout with the MSVC toolchain, compare `cargo test --lib -- --list` with `cargo test --lib --features recovery-verification -- --list`. Confirm that the exact selection covers every recovery-only test on the implementation revision.
2. On that Windows machine, run the new default command (`cargo test --lib`) and the new recovery command with `CARGO_PROFILE_TEST_DEBUG=line-tables-only`. Confirm that the default test list is the same as before (531 tests) and that the recovery command reports `1 passed` and that `native-tests.log` contains the named pass. Run the PowerShell block with an unmatched test name to confirm it fails instead of accepting zero tests.
3. Confirm from verbose local Cargo output that the native test builds use `-C debuginfo=line-tables-only`. Check that the unsigned package, smoke, and artifact steps are unchanged. If Windows validation is unavailable, report that limit; do not substitute a hosted experiment.

There is no runtime target for this change. The acceptance criteria are removal of duplicate test execution, unused test-build targets, and full test debug information without losing the existing verification checks. Treat the first routine run after merge as normal CI, not an experiment.
