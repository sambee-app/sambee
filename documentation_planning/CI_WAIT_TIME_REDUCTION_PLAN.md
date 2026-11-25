# CI wait-time reduction

## Goal and scope

Implement both changes in one PR. The PR does all required validation itself. Separate PRs and a measurement before the implementation are not necessary.

Make developers wait less for CI. Runner minutes are free for this public repository and queue time is almost zero. Only the run time of jobs on the critical path is important.

This plan contains two changes with measured benefits:

1. Make the required frontend check shorter.
2. Remove a duplicate compile from the Windows Companion verification.

Changes to the Docker preview release workflow are not in this plan. Change 1 updates only the release reuse reader, because that reader looks for the current `frontend` job.

Keep the required check names (`CI: Test / test-gate`, `CI: Lint / lint-gate`), the path rules, and the existing test coverage. Do not change signed Companion release workflows.

One coverage trade-off is accepted: after change 2, the Windows tests run only with the `recovery-verification` feature enabled. Windows tests no longer run without the feature. For the reasons, see [Coverage trade-off](#coverage-trade-off).

## Baseline measurements

Data source: GitHub Actions run and job records, collected on 2026-11-25.

| Check | Sample | Wall time (median) | Critical part |
|---|---|---|---|
| `CI: Test` (required) | 40 PR runs | 7.8 min, p90 10.7 min | `frontend` job, 8.2 min |
| Verify Companion Build | Newest run of the current workflow | 12.7 min | native tests, 5.1 min |

Queue time for each job was at most 0.1 min (p90). Failures and reruns were not significant: 0 reruns in 40 PR runs.

The ruleset requires branches to be up to date before merge. After each merge (about 100 each month), other open PRs must update and wait for `CI: Test` again. Thus, each minute on the required path is paid many times.

### Limits of this baseline

- The two `CI: Test` values come from different samples. The 7.8 min workflow median includes PR runs without frontend changes. The 8.2 min `frontend` median includes only runs in which the frontend job ran. Thus, the workflow median is less than the job median.
- The run IDs of these samples were not recorded.
- The values measure job time, not the time a developer waits before a merge is possible.

### Optional measurement after the merge

A baseline before the implementation is not necessary. The GitHub API keeps run and job timing data after the logs expire. Thus, a before-and-after comparison is possible at any time after the merge. If you need a precise result, use this method:

- Sample: `CI: Test` runs with the `pull_request` event, the frontend component selected, and a successful conclusion. Record the date range and the run IDs.
- Metric: median and p90 time from the push of the PR head commit to the completion of the last required check. Both `CI: Test / test-gate` and `CI: Lint / lint-gate` are required.
- Compare the same metric with the same filter for comparable PRs before and after the merge.

## 1. Make the required frontend check shorter

### Evidence

In the `frontend` job (median 8.2 min):

| Step | Median |
|---|---|
| Run tests (Vitest) | 6.1 min |
| Run browser correctness contracts | 1.4 min |
| Install browser dependencies | 0.4 min |
| Build production frontend | 0.25 min |
| Verify frontend type correctness | 0.2 min |
| Install dependencies | 0.2 min |

Vitest details from one representative run:

- 197 files, 3,478 tests, 4 workers on a 4-CPU runner.
- Wall time 314 s. Vitest reports: tests 53%, import 30%, environment 12%.
- Total per-file test time is 653 s. With import and environment time, the work is approximately 1,200 s. Thus, the 4 workers are fully used. More workers on the same runner cannot help. Only more parallel jobs can make the wall time shorter.
- [FileBrowser-interactions.test.tsx](../frontend/src/pages/__tests__/FileBrowser-interactions.test.tsx) takes 141 s alone. The 10 slowest files take 62% of the test time.

### Changes

1. **Split the largest test file.** Divide `FileBrowser-interactions.test.tsx` (173 tests) into files of related behavior. Each new file must take less than approximately 50 s on CI. Keep the shared setup in one helper module. Do not copy it.
2. **Run Vitest in parallel shards.** Add the matrix job `frontend-tests`. Its step "Run Vitest shard" runs `npm run test:ci -- --shard=<index>/<total>`. [run-tests-ci.mjs](../frontend/scripts/run-tests-ci.mjs) already passes extra arguments to Vitest. Start with 3 shards.
   - **One shard definition.** Keep the shard list in one committed JSON file under `frontend/`, for example `frontend/ci-shards.json`. The matrix, the job names (for example `frontend-tests (shard 1/3)`), the `--shard` argument, and the reuse reader all get the shard indices and the total from this file. Do not write the total in a second location.
   - **File location.** The file must be under `frontend/`. [ci_change_detector.py](../scripts/ci_change_detector.py) selects the frontend only for paths under `frontend/` or in `FRONTEND_EXTRAS`. A file in another location, for example under `.github/`, would let a PR that changes only the shard list skip all frontend jobs and still pass the gate.
   - **How the matrix gets the list.** GitHub Actions cannot read a repository file when it expands a matrix. Thus, the existing `changes` job reads the file, validates it, and gives the unchanged list as a job output. The matrix uses `fromJSON(needs.changes.outputs.<name>)`. The matrix comes only from the committed file. Do not calculate or change the list at run time. The frontend jobs already wait for `changes`, so this adds no job to the critical path.
   - **Validation of the list.** The `changes` job fails if any of these conditions is not true:
     - the file is valid JSON with the expected structure;
     - the total is a positive whole number;
     - each index is a positive whole number;
     - the indices are exactly `1` to the total, each one time, with no gap, duplicate, or extra value.

     Without the last condition, a list such as `1/3, 2/3` passes and one third of the tests never runs. Add unit tests for the validator: valid list, empty list, total of 0, non-integer value, a gap, a duplicate, and an index larger than the total. A failed `changes` job already fails `test-gate`, so the gate needs no new test for this case.
   - **No fail-fast.** Set `strategy.fail-fast: false`. Otherwise GitHub cancels the other shards when one shard fails. With this setting, developers see all failures in one run, and one failed shard can be run again alone. Five other matrix workflows in this repository already use this setting.
   - **No hidden success.** Do not use `continue-on-error` on the shard job or its steps. The step "Run Vitest shard" has no `if` condition, so it always runs when setup succeeds.
   - **Test report.** Each shard writes a Vitest JSON report and uploads it as an artifact. Include the shard index and `github.run_attempt` in the artifact name to prevent name conflicts on reruns. Keep the job name unchanged across attempts so the release reuse reader can find it. The validation of test identity uses these reports.
3. **Move the remaining frontend checks to a separate parallel job.** The job `frontend-checks` runs version sync, Tauri version alignment, type check, production build, browser installation, and browser correctness contracts. It does not wait for the Vitest shards.
4. **Update the gate.** The `needs` context gives one result for each job ID, not one result for each matrix leg. For a matrix job, GitHub gives a combined result: `failure` if a leg fails, `cancelled` if a leg is cancelled, and `skipped` only if the complete job is skipped. With the shard list rules of step 2, this combined result is sufficient. The matrix list comes from the committed file and is validated by `changes`, so no shard can be missing from the matrix.
   - Add `frontend-tests` and `frontend-checks` to the `needs` of `test-gate`.
   - In [check_ci_test_gate.py](../scripts/check_ci_test_gate.py), map the `frontend` component to both job IDs instead of one.
   - If the frontend is selected, or the event is `workflow_dispatch`, the result of each of the two jobs must be `success`.
   - If the frontend is not selected, the result of each of the two jobs must be `success` or `skipped`.
   - Add test cases: one job failed, one job cancelled, one job skipped while the frontend is selected, both jobs skipped while the frontend is not selected, and `workflow_dispatch` with a skipped job.
5. **Update the release reuse reader.** [reuse_release_ci_tests.py](../.github/scripts/reuse_release_ci_tests.py) accepts the `frontend` job only. Keep the existing check of the source run: the exact commit, the `main` branch, the `push` event, and a completed, successful run. Then require all of these:
   - The shard job names are exactly the expected set from the shared shard definition. There is no missing name, no extra name, and no duplicate name.
   - Each shard job succeeded, and its step "Run Vitest shard" succeeded.
   - The job `frontend-checks` succeeded, and its steps "Verify frontend type correctness" and "Run browser correctness contracts" succeeded.

   If any condition is not true, the release runs its own frontend tests. This also applies to an older job layout, for example a source run that still has the single `frontend` job. Add rejection test cases for:
   - a missing shard;
   - an extra shard;
   - a duplicate shard name;
   - a complete-looking set with the wrong total, for example `1/2` and `2/2` when 3 shards are expected;
   - a skipped or failed "Run Vitest shard" step;
   - a missing or failed `frontend-checks` job or required step;
   - the old single `frontend` job layout.
6. **Keep balance visible.** Each shard logs its file count and Vitest duration. If the slowest shard takes more than 1.5 times as long as the fastest, rebalance by splitting more large files. Do not add a custom sequencer as the first solution.

### Expected result

- Each shard: approximately 1,200 s ÷ 3 shards = 400 s of work on 4 workers, thus approximately 100 s of Vitest wall time. Add approximately 1 min for job setup.
- Browser check job: approximately 2.5–3 min.
- `CI: Test` critical path: approximately 8 → 4–5 min.

These values are targets, not measured results. The file imbalance and the repeated setup in each job can increase them. The `CI: Test` run of the implementation PR shows the new critical path. For a precise comparison, see [Optional measurement after the merge](#optional-measurement-after-the-merge).

### Risks

- Repeated setup in each shard (checkout, `npm ci`). The npm cache keeps this at approximately 0.2 min.
- Module import time is 30% of Vitest time and is repeated in each shard. Do not enable `isolate: false` as part of this change. Vitest estimates a saving of 72 s, but tests must first be shown to be independent.
- Partial reruns. GitHub keeps the results of jobs that were not run again. The documentation of the jobs API with `filter=latest` does not clearly state the result after only one shard was run again. The reader must never accept a smaller shard set in this case. If the data is not complete, the release runs its own tests. This fallback is safe: it is the current behavior of every release.

## 2. Remove a duplicate compile from the Windows Companion verification

### Evidence

Newest run of [verify-companion-build.yml](../.github/workflows/verify-companion-build.yml) (12.7 min), step "Run native Windows tests" (5.1 min):

| Part | Time |
|---|---|
| Compile the library tests without `recovery-verification` | 68 s |
| Run 528 tests | 170 s |
| Compile the library tests again with `recovery-verification` | 65 s |
| Run 1 recovery test | 0.5 s |

The second `cargo test` call compiles the complete `sambee-companion` crate again only to run one test.

### Feasibility

The `recovery-verification` feature has no effect on the other tests:

- It adds a field and a flag that is `false` until a verification route sets it ([directory_manager.rs](../companion/src-tauri/src/server/directory_manager.rs)).
- It adds a cache path override that is used only if `SAMBEE_RECOVERY_ROOT` is set, and the `/__verification/{action}` route ([mod.rs](../companion/src-tauri/src/server/mod.rs), [recovery_verification.rs](../companion/src-tauri/src/server/recovery_verification.rs)).
- It adds a subscription counter ([watcher.rs](../companion/src-tauri/src/server/watcher.rs)).
- No test calls `build_router` or sets the verification environment variables.
- The feature-gated code is not Windows-specific.

The build without the feature is still checked. The Linux `companion` job in `CI: Test` runs `cargo test --lib`, `cargo fmt --check`, and `cargo clippy --lib --tests -D warnings` without the feature ([test-archive-topology-conformance](../scripts/test-archive-topology-conformance)). Signed release builds also compile without the feature.

### Coverage trade-off

This change reduces coverage. Today, the full Windows library suite runs without the `recovery-verification` feature. After the change, it runs only with the feature enabled. Windows tests no longer run without the feature.

Remaining risks:

- A Windows-only compile error that occurs only without the feature.
- A test that has a different result on Windows when the feature is enabled.

Reasons to accept these risks:

- The feature adds only hooks that are not active during the tests (see [Feasibility](#feasibility)).
- The feature-gated code is not in Windows-specific modules.
- The Linux `companion` job runs the tests without the feature.
- Signed release builds compile without the feature on Windows.

### Changes

1. In the step "Run native Windows tests", replace the two `cargo test` calls with one call: `--release --lib --target x86_64-pc-windows-msvc --features 'tauri/custom-protocol,recovery-verification'`. Write its output to `recovery-report/native-tests.log` as before.
2. Keep the check that the recovery test `server::directory_manager::tests::verification_controls_reconcile_gap_and_release_resources` passed: search the log for `test <name> ... ok`. If the line is missing, fail with the current message.
3. Make sure that the step fails if any test fails, also when the output goes through `Tee-Object`.
4. Do not add a fixed test count to the workflow. Such a check would fail each time a test is added or removed. Checks 2 and 3 are the permanent checks. The count check is for this PR only (see [Checks before the merge](#checks-before-the-merge)).

### Expected result

Approximately 1.1 min less (65 s compile). Windows verification: approximately 12.7 → 11.6 min. This check is not required for merge, but it is the longest PR check for Companion changes.

### Not in this plan

The test run itself takes 170 s for 528 tests. Examining the slowest Windows tests can give a larger saving. This needs separate measurement.

## Documentation

Update the [CI workflow guide](../website/content/docs/3.0/developer-guide/testing-and-quality-gates/ci-workflows-and-repository-automation/index.md). Follow the `docs-update` skill.

- Frontend job description: Vitest shards, the shard file under `frontend/` and how the `changes` job validates it and passes it to the matrix, `fail-fast: false`, the separate `frontend-checks` job, and how `test-gate` evaluates the combined matrix result.
- Release reuse requirements: the exact set of shard jobs with a successful "Run Vitest shard" step, and the `frontend-checks` job with the type check step and the browser correctness step.
- Windows verification: replace "The full library suite runs without the recovery feature. A second pass runs only the recovery-specific test." with the single-pass description. State the coverage trade-off: Windows tests run only with the feature, and the Linux `companion` job runs the tests without the feature.

## Validation

All checks before the merge use the implementation PR. The change to `test.yml` makes `CI: Test` run all components. The change to `verify-companion-build.yml` starts the Windows verification.

### Checks before the merge

Unit tests with mocked payloads do not prove that GitHub supplies the necessary data. Thus, checks 3 and 4 use real Actions runs of the implementation PR.

1. **Unit tests.** The gate and reuse reader test cases of change 1 pass.
2. **Test identity across the file split.** The file split changes the file path in each test ID. Compare the test names (describe path and test name, without the file path) before and after the split. The lists must be the same, including the number of occurrences. Do this locally.
3. **Failed shard.** Push a temporary commit that adds a test that fails only when the `GITHUB_RUN_ATTEMPT` environment variable is `1`. In this run, only the shard that contains the test fails, and `test-gate` fails.
4. **Rerun of one shard.** Because of `fail-fast: false`, the other shards finish with success. In the same run, use "Re-run failed jobs". Only the failed shard and `test-gate` run again. The test passes in attempt 2, and `test-gate` must pass. Then use the jobs API with `filter=latest` on this run: it must return each of the expected shard names (3 with the initial list) exactly once, all with success. Record the result in the PR, because the reuse reader depends on it. Remove the temporary test before the merge.
5. **Test identity after sharding.** On the final commit, compare the combined JSON reports of all shards with one unsharded Vitest run (locally or in a temporary CI step). For each test ID, compare the number of occurrences and the status. Do not compare only a set union or the total count: a missing test and a duplicate test can cancel each other, and a skipped test is still present in the list.
6. **Windows change (change 2).** For this PR only, compare the Windows log with the log of the previous two-pass run. It shows one compile, 529 passed (528 + the recovery test), 2 ignored, 0 filtered out, and the recovery test line. The step time is approximately 1 min less.

### Checks after the merge

These checks need no extra PR. They use normal activity after the merge.

- **No frontend change.** The first PR that changes only the backend shows skipped frontend jobs and a passed `test-gate`. The gate unit tests already cover this case.
- **Release reuse.** The reader reads only push runs on `main`, so the implementation PR cannot test it with real data. The rejection unit tests cover the unsafe case. In the first release after the merge, the log shows the reuse decision. If the reader rejects valid data, the release runs its own tests, as all releases do today.
- **Wait time (optional).** See [Optional measurement after the merge](#optional-measurement-after-the-merge).

## Commits in the implementation PR

Use separate commits so that each part can be reviewed alone:

1. Change 2: the Windows `cargo test` merge.
2. Split of `FileBrowser-interactions.test.tsx` only, with no other changes.
3. Shard file `frontend/ci-shards.json` and its validator in the `changes` job, `frontend-tests` and `frontend-checks` jobs, gate, reuse reader, and their unit tests.
4. Documentation updates.
