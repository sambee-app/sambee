import { describe, expect, test } from "vitest";
import {
  evaluateSourceResponsivenessBudgets,
  evaluateSourceTypingBudgets,
  evaluateViewerAcceptanceCoverage,
  evaluateViewerAcceptanceReport,
  evaluateViewerReadinessBudgets,
  evaluateViewerTimingBudgets,
  SOURCE_RESPONSIVENESS_TARGETS_MS,
  SOURCE_TYPING_TARGETS_MS,
  VIEWER_ACCEPTANCE_CASES,
  VIEWER_READINESS_TARGETS_MS,
  VIEWER_TIMING_TARGETS_MS,
} from "../../../e2e/viewer-performance-budgets";

describe("viewer acceptance report", () => {
  const attachment = {
    name: "source-responsiveness",
    body: Buffer.from(
      JSON.stringify({ enforced: true, budgets: evaluateSourceResponsivenessBudgets(SOURCE_RESPONSIVENESS_TARGETS_MS) })
    ).toString("base64"),
  };
  const report = () => ({
    errors: [],
    suites: [
      {
        title: "markdown-viewer.spec.ts",
        specs: VIEWER_ACCEPTANCE_CASES["dense-expansion"].map((title) => ({
          title,
          tests: ["chromium", "firefox"].flatMap((projectName) =>
            Array.from({ length: 3 }, (_, repeatEachIndex) => ({
              projectName,
              repeatEachIndex,
              status: "expected",
              results: [{ status: "passed", retry: 0, attachments: [{ ...attachment }] }],
            }))
          ),
        })),
      },
    ],
  });

  test("requires all 24 fixed expansion trials and their enforced evidence", () => {
    const result = evaluateViewerAcceptanceReport("dense-expansion", report());
    expect(result).toMatchObject({ status: "pass", expectedCount: 24, observedCount: 24 });
  });

  test("reads trial identity from attachments in the real Playwright JSON schema", () => {
    const realSchema = report();
    for (const spec of realSchema.suites[0].specs)
      for (const entry of spec.tests) {
        entry.results[0].attachments[0].body = Buffer.from(
          JSON.stringify({
            trial: entry.repeatEachIndex,
            enforced: true,
            budgets: evaluateSourceResponsivenessBudgets(SOURCE_RESPONSIVENESS_TARGETS_MS),
          })
        ).toString("base64");
        Reflect.deleteProperty(entry, "repeatEachIndex");
      }
    expect(evaluateViewerAcceptanceReport("dense-expansion", realSchema).status).toBe("pass");
  });

  test("rejects a passing subset and a missing report", () => {
    const subset = report();
    subset.suites[0].specs.pop();
    expect(evaluateViewerAcceptanceReport("dense-expansion", subset).status).toBe("fail");
    expect(evaluateViewerAcceptanceReport("dense-expansion", { suites: [] }).status).toBe("fail");
  });

  test("rejects missing, duplicate, invalid, unenforced and failing attachments", () => {
    for (const attachments of [
      [],
      [attachment, attachment],
      [{ ...attachment, body: "invalid" }],
      [{ ...attachment, body: Buffer.from(JSON.stringify({ enforced: false, budgets: { status: "pass" } })).toString("base64") }],
      [{ ...attachment, body: Buffer.from(JSON.stringify({ enforced: true, budgets: { status: "fail" } })).toString("base64") }],
    ]) {
      const invalid = report();
      invalid.suites[0].specs[0].tests[0].results[0].attachments = attachments;
      expect(evaluateViewerAcceptanceReport("dense-expansion", invalid).status).toBe("fail");
    }
  });

  test("recomputes metrics instead of trusting a pass label", () => {
    for (const metrics of [
      [],
      [{ metric: "atomicCommit", observedMs: -1 }],
      [...evaluateSourceResponsivenessBudgets(SOURCE_RESPONSIVENESS_TARGETS_MS).metrics, { metric: "atomicCommit", observedMs: 0 }],
    ]) {
      const invalid = report();
      invalid.suites[0].specs[0].tests[0].results[0].attachments = [
        { ...attachment, body: Buffer.from(JSON.stringify({ enforced: true, budgets: { status: "pass", metrics } })).toString("base64") },
      ];
      expect(evaluateViewerAcceptanceReport("dense-expansion", invalid).status).toBe("fail");
    }
  });

  test("rejects skips, retries, repeated trials and report errors", () => {
    const skipped = report();
    skipped.suites[0].specs[0].tests[0].results[0].status = "skipped";
    expect(evaluateViewerAcceptanceReport("dense-expansion", skipped).status).toBe("fail");
    const retried = report();
    retried.suites[0].specs[0].tests[0].results[0].retry = 1;
    expect(evaluateViewerAcceptanceReport("dense-expansion", retried).status).toBe("fail");
    const duplicate = report();
    duplicate.suites[0].specs[0].tests.push(duplicate.suites[0].specs[0].tests[0]);
    expect(evaluateViewerAcceptanceReport("dense-expansion", duplicate).status).toBe("fail");
    expect(evaluateViewerAcceptanceReport("dense-expansion", { ...report(), errors: ["interrupted"] }).status).toBe("fail");
  });
});

describe("viewer acceptance coverage", () => {
  const expected = ["chromium/1543/dense/cold/1", "firefox/390/dense/cold/1"];
  const samples = expected.map((identity) => ({ identity, status: "pass", retry: 0 }));

  test("requires every expected identity exactly once", () => {
    expect(evaluateViewerAcceptanceCoverage(expected, samples).status).toBe("pass");
    expect(evaluateViewerAcceptanceCoverage(expected, samples.slice(1)).missing).toEqual([expected[0]]);
    expect(evaluateViewerAcceptanceCoverage(expected, [...samples, samples[0]]).duplicate).toEqual([expected[0]]);
    expect(evaluateViewerAcceptanceCoverage(expected, [...samples, { ...samples[0], identity: "unexpected" }]).unexpected).toEqual([
      "unexpected",
    ]);
  });

  test("rejects empty or duplicate expectations", () => {
    expect(evaluateViewerAcceptanceCoverage([], []).status).toBe("fail");
    expect(evaluateViewerAcceptanceCoverage([...expected, expected[0]], samples).status).toBe("fail");
  });

  for (const status of ["fail", "invalid", "skipped", "diagnostic", "unverified"]) {
    test(`rejects ${status} samples`, () => {
      expect(evaluateViewerAcceptanceCoverage(expected, [{ ...samples[0], status }, samples[1]]).status).toBe("fail");
    });
  }

  test("rejects retries even when the final result passes", () => {
    expect(evaluateViewerAcceptanceCoverage(expected, [{ ...samples[0], retry: 1 }, samples[1]]).status).toBe("fail");
  });
});

describe("source typing budget evaluation", () => {
  test("keeps keyboard p95 strictly below 50 ms", () => {
    expect(evaluateSourceTypingBudgets(SOURCE_TYPING_TARGETS_MS).status).toBe("fail");
    expect(
      evaluateSourceTypingBudgets({ ...SOURCE_TYPING_TARGETS_MS, keyboardTwoFrameP95: SOURCE_TYPING_TARGETS_MS.keyboardTwoFrameP95 - 0.1 })
        .status
    ).toBe("pass");
  });
  for (const metric of Object.keys(SOURCE_TYPING_TARGETS_MS) as (keyof typeof SOURCE_TYPING_TARGETS_MS)[]) {
    test(`rejects missing, invalid and over-budget ${metric}`, () => {
      for (const sample of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, SOURCE_TYPING_TARGETS_MS[metric] + 1]) {
        const report = evaluateSourceTypingBudgets({
          ...SOURCE_TYPING_TARGETS_MS,
          keyboardTwoFrameP95: SOURCE_TYPING_TARGETS_MS.keyboardTwoFrameP95 - 0.1,
          [metric]: sample,
        });
        expect(report.status).toBe("fail");
        expect(report.metrics.find((entry) => entry.metric === metric)?.status).not.toBe("pass");
      }
    });
  }
});

describe("source responsiveness budget evaluation", () => {
  for (const metric of Object.keys(SOURCE_RESPONSIVENESS_TARGETS_MS) as (keyof typeof SOURCE_RESPONSIVENESS_TARGETS_MS)[]) {
    test(`enforces ${metric}, including missing and invalid samples`, () => {
      expect(evaluateSourceResponsivenessBudgets(SOURCE_RESPONSIVENESS_TARGETS_MS).status).toBe("pass");
      for (const sample of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1, SOURCE_RESPONSIVENESS_TARGETS_MS[metric] + 1]) {
        const report = evaluateSourceResponsivenessBudgets({ ...SOURCE_RESPONSIVENESS_TARGETS_MS, [metric]: sample });
        expect(report.status).toBe("fail");
        expect(report.metrics.find((entry) => entry.metric === metric)?.status).not.toBe("pass");
      }
    });
  }
  test("does not count diagnostic evidence as acceptance", () => {
    expect(evaluateSourceResponsivenessBudgets(SOURCE_RESPONSIVENESS_TARGETS_MS, true).status).toBe("diagnostic");
  });
});

describe("viewer timing budget evaluation", () => {
  test("accepts the exact targets and rejects an over-budget sample", () => {
    expect(evaluateViewerTimingBudgets(VIEWER_TIMING_TARGETS_MS).status).toBe("pass");
    const report = evaluateViewerTimingBudgets({ ...VIEWER_TIMING_TARGETS_MS, changedQuery: VIEWER_TIMING_TARGETS_MS.changedQuery + 1 });
    expect(report.status).toBe("fail");
    expect(report.metrics.find((metric) => metric.metric === "changedQuery")?.status).toBe("fail");
    expect(report.openCriteria.length).toBeGreaterThan(0);
  });

  for (const sample of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    test(`rejects a missing or invalid measurement: ${String(sample)}`, () => {
      const report = evaluateViewerTimingBudgets({ ...VIEWER_TIMING_TARGETS_MS, documentCompletion: sample });
      expect(report.status).toBe("fail");
      expect(report.metrics.find((metric) => metric.metric === "documentCompletion")).toMatchObject({
        status: "invalid",
        observedMs: null,
      });
    });
  }

  test("does not turn diagnostic measurements into an acceptance pass", () => {
    const report = evaluateViewerTimingBudgets(VIEWER_TIMING_TARGETS_MS, true);
    expect(report.status).toBe("diagnostic");
  });
});

describe("viewer readiness budget evaluation", () => {
  for (const metric of Object.keys(VIEWER_READINESS_TARGETS_MS) as (keyof typeof VIEWER_READINESS_TARGETS_MS)[]) {
    test(`accepts the exact target and rejects an over-budget ${metric}`, () => {
      expect(evaluateViewerReadinessBudgets(VIEWER_READINESS_TARGETS_MS).status).toBe("pass");
      const report = evaluateViewerReadinessBudgets({ ...VIEWER_READINESS_TARGETS_MS, [metric]: VIEWER_READINESS_TARGETS_MS[metric] + 1 });
      expect(report.status).toBe("fail");
      expect(report.metrics.find((entry) => entry.metric === metric)?.status).toBe("fail");
    });
    for (const sample of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      test(`rejects invalid ${metric}: ${String(sample)}`, () => {
        const report = evaluateViewerReadinessBudgets({ ...VIEWER_READINESS_TARGETS_MS, [metric]: sample });
        expect(report.status).toBe("fail");
        expect(report.metrics.find((entry) => entry.metric === metric)).toMatchObject({ status: "invalid", observedMs: null });
      });
    }
  }
  test("does not turn diagnostic readiness measurements into acceptance", () => {
    expect(evaluateViewerReadinessBudgets(VIEWER_READINESS_TARGETS_MS, true).status).toBe("diagnostic");
  });
});
