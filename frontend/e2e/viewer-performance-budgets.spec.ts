import { expect, test } from "@playwright/test";
import { evaluateViewerReadinessBudgets, evaluateViewerTimingBudgets, VIEWER_READINESS_TARGETS_MS, VIEWER_TIMING_TARGETS_MS } from "./viewer-performance-budgets";

test.describe("viewer timing budget evaluation", () => {
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

test.describe("viewer readiness budget evaluation", () => {
  for (const metric of Object.keys(VIEWER_READINESS_TARGETS_MS) as (keyof typeof VIEWER_READINESS_TARGETS_MS)[]) {
    test(`accepts the exact target and rejects an over-budget ${metric}`, () => {
      expect(evaluateViewerReadinessBudgets(VIEWER_READINESS_TARGETS_MS).status).toBe("pass");
      const report = evaluateViewerReadinessBudgets({ ...VIEWER_READINESS_TARGETS_MS, [metric]: VIEWER_READINESS_TARGETS_MS[metric] + 1 });
      expect(report.status).toBe("fail");
      expect(report.metrics.find(entry => entry.metric === metric)?.status).toBe("fail");
    });
    for (const sample of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      test(`rejects invalid ${metric}: ${String(sample)}`, () => {
        const report = evaluateViewerReadinessBudgets({ ...VIEWER_READINESS_TARGETS_MS, [metric]: sample });
        expect(report.status).toBe("fail");
        expect(report.metrics.find(entry => entry.metric === metric)).toMatchObject({ status: "invalid", observedMs: null });
      });
    }
  }
  test("does not turn diagnostic readiness measurements into acceptance", () => {
    expect(evaluateViewerReadinessBudgets(VIEWER_READINESS_TARGETS_MS, true).status).toBe("diagnostic");
  });
});
