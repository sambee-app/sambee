# Windows Companion CI optimization plan

## Goal

Reduce the runtime of `windows-x64` in [Verify Companion Build](../.github/workflows/verify-companion-build.yml). Keep the full Windows library test suite without the recovery feature, the recovery-only native test, the unsigned NSIS installer, and the packaged-process smoke test. Validate the implementation locally. Do not add a benchmark workflow or dispatch GitHub Actions runs for experiments.

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

### 1. Share the release profile between the package and the tests

- Build the verification package first. The Tauri build hook produces the frontend assets required by `tauri/custom-protocol`.
- Run both library test passes with `--release --lib --target x86_64-pc-windows-msvc` and enable `tauri/custom-protocol` to match the package. Set `CARGO_PROFILE_RELEASE_PANIC=unwind` at job scope to match the Rust test harness. Keep the shipping `panic = "abort"` setting in [Cargo.toml](../companion/src-tauri/Cargo.toml).
- The test harnesses and application still compile separately. The local Windows MSVC Cargo unit graphs show that 606 of 607 registry dependency units in each test pass also occur in the package build. The exception is a test dependency, `filetime`. This is not a Windows timing measurement.
- Verification now tests release behavior: it no longer runs with debug assertions or overflow checks. `--lib` omits the empty binary harness and doc-test run. If the package gains tests outside its library, add them to verification.

### 2. Run only the recovery-specific test in the second pass

- Keep the full library suite without `recovery-verification`. Enable that feature only for the second test pass and the unsigned package.
- Select `verification_controls_reconcile_gap_and_release_resources` by its exact test name. Cargo can report success when no test matches. Require the named pass in `native-tests.log`, and keep artifact upload on failure.
- If a later change adds another recovery-only native test, include it in verification. Do not restore the duplicate module-wide pass.

## Keep unchanged

- **Runner and job count.** The [public Windows x64 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories) provides four vCPUs. Cargo already defaults to the logical CPU count. Increasing `CARGO_BUILD_JOBS` does not add CPU capacity. Do not change the full suite's test concurrency, buy larger runners, or split the job in this change.
- **Package optimization settings.** Keep LTO off, 16 codegen units, and optimization level 1 in verification. A lower optimization level or different linker needs measurement; the log does not identify a linker bottleneck.
- **Cache policy.** Keep the current Rust cache configuration. A cache saved on one PR's merge ref does not warm a different PR. A default-branch cache could improve restores, but adding default-branch builds has an unmeasured cost. Do not change the trigger, cache scope, or save policy in this plan. The 1:14 save cost occurs only after a cache miss: when the restore finds an exact key, the cache action reports `Cache up-to-date.` and does not save again. The Linux `companion` job in [the test workflow](../.github/workflows/test.yml) uses a different cache key and does not run `cargo test`, so it does not warm this job.
- **Feature set of the default suite.** Do not run the default suite with `recovery-verification` to avoid the second build. The feature changes runtime behavior (for example, `verification_due` in the directory manager and extra server routes), and the shipping workflow builds without it.
- **Verification evidence.** Keep the signer and updater-artifact checks, the same build outputs and `recovery-report` paths, and the smoke test of the packaged executable. Do not change the signed release workflow.

## Local validation before merge

1. Run the [workflow configuration tests](../backend/tests/test_release_workflow_configuration.py). Compare the Windows MSVC Cargo unit graphs for the package and the two test builds with the verification profile overrides.
2. On a local Windows x64 machine with the MSVC toolchain, run the package build and both test passes in workflow order. Confirm that the full suite has the same test list and that `native-tests.log` records one pass. Check that a mistyped exact filter fails the PowerShell step. Confirm that the packaged-process smoke test passes.
3. If Windows validation is unavailable, report that limit. Do not substitute a hosted experiment.

There is no runtime target for this change. Remove duplicate test execution and share compiled dependencies without losing the package and recovery checks. Treat the first routine run after merge as normal CI, not an experiment.
