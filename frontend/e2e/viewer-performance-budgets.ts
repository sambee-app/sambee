export const VIEWER_TIMING_TARGETS_MS = {
  documentCompletion: 1_500,
  firstExactSearch: 1_000,
  changedQuery: 100,
  lastMatchNavigation: 100,
  maximumTimerGap: 50,
} as const;

export type ViewerTimingMetric = keyof typeof VIEWER_TIMING_TARGETS_MS;
export type ViewerTimingSamples = Partial<Record<ViewerTimingMetric, number | null>>;

export const VIEWER_READINESS_TARGETS_MS = {
  firstUsableText: 1_500,
  firstVisibleSyntax: 1_500,
  fullSyntaxPreparation: 3_000,
} as const;

export type ViewerReadinessMetric = keyof typeof VIEWER_READINESS_TARGETS_MS;
export type ViewerReadinessSamples = Partial<Record<ViewerReadinessMetric, number | null>>;

function evaluateTimingMetrics<Metric extends string>(targets: Record<Metric, number>, samples: Partial<Record<Metric, number | null>>, diagnostic: boolean) {
  const metrics = (Object.entries(targets) as [Metric, number][]).map(([metric, targetMs]) => {
    const observedMs = samples[metric];
    const valid = typeof observedMs === "number" && Number.isFinite(observedMs) && observedMs >= 0;
    const status = !valid ? "invalid" : observedMs > targetMs ? "fail" : "pass";
    return { metric, targetMs, observedMs: valid ? observedMs : null, status };
  });
  return {
    status: diagnostic ? "diagnostic" : metrics.every((metric) => metric.status === "pass") ? "pass" : "fail",
    metrics,
  };
}

export function evaluateViewerReadinessBudgets(samples: ViewerReadinessSamples, diagnostic = false) {
  return evaluateTimingMetrics(VIEWER_READINESS_TARGETS_MS, samples, diagnostic);
}

export function evaluateViewerTimingBudgets(samples: ViewerTimingSamples, diagnostic = false) {
  return {
    ...evaluateTimingMetrics(VIEWER_TIMING_TARGETS_MS, samples, diagnostic),
    openCriteria: [
      "Actual hardware input-to-visible-response latency",
      "Application-owned blocking work attribution and scrolling refresh-rate acceptance",
      "First usable text and visible syntax completion budgets",
      "Controlled renderer heap, six-cycle shutdown growth and aggregate worker/native memory",
      "Fresh/cached grammar isolation, large prose/tables, source typing and dense replacement",
      "Native Find, OS clipboard, assistive technology, printing and physical-device acceptance",
    ],
  };
}
