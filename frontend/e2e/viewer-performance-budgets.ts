export const VIEWER_TIMING_TARGETS_MS = {
  documentCompletion: 1_500,
  firstExactSearch: 1_000,
  changedQuery: 100,
  lastMatchNavigation: 100,
  maximumTimerGap: 50,
} as const;

export type ViewerTimingMetric = keyof typeof VIEWER_TIMING_TARGETS_MS;
export type ViewerTimingSamples = Partial<Record<ViewerTimingMetric, number | null>>;

export interface ViewerAcceptanceSample {
  identity: string;
  status: string;
  retry: number;
}

export function evaluateViewerAcceptanceCoverage(expected: readonly string[], samples: readonly ViewerAcceptanceSample[]) {
  const expectedIdentities = new Set(expected);
  const observed = new Map<string, ViewerAcceptanceSample[]>();
  for (const sample of samples) {
    const entries = observed.get(sample.identity) ?? [];
    entries.push(sample);
    observed.set(sample.identity, entries);
  }
  const missing = expected.filter(identity => !observed.has(identity));
  const unexpected = [...observed.keys()].filter(identity => !expectedIdentities.has(identity));
  const duplicate = [...observed].filter(([, entries]) => entries.length !== 1).map(([identity]) => identity);
  const invalid = samples.filter(sample => sample.status !== "pass" || sample.retry !== 0).map(sample => sample.identity);
  const validExpectation = expected.length > 0 && expectedIdentities.size === expected.length;
  return {
    status: validExpectation && !missing.length && !unexpected.length && !duplicate.length && !invalid.length ? "pass" : "fail",
    expectedCount: expected.length,
    observedCount: samples.length,
    validExpectation,
    missing,
    unexpected,
    duplicate,
    invalid,
  };
}

const ACCEPTANCE_WIDTHS = [1543, 390] as const;
const ACCEPTANCE_ENGINES = ["chromium", "firefox"] as const;
const PUBLICATION_FIXTURES = ["dense", "near-safeguard", "host-envelope", "many-blocks", "long-line"] as const;
const sourceCases = (operation: string) => ACCEPTANCE_WIDTHS.flatMap(width => ["dense", "long-line"].map(fixture => `production source ${operation} ${fixture} at ${width}px`));

export const VIEWER_ACCEPTANCE_CASES = {
  "source-responsiveness": sourceCases("responsiveness"),
  "dense-expansion": sourceCases("dense expansion"),
  "source-typing": sourceCases("typing"),
  "prose-table": ACCEPTANCE_WIDTHS.flatMap(width => ["prose", "table"].map(fixture => `production prose table responsiveness ${fixture} at ${width}px`)),
  "table-editing": ACCEPTANCE_WIDTHS.flatMap(width => ["first", "middle", "last", "line-break", "composition", "close-flush", "composition-close"].map(fixture => `production large table editing ${fixture} at ${width}px`)),
  publication: ACCEPTANCE_WIDTHS.flatMap(width => PUBLICATION_FIXTURES.map(fixture => `production syntax publication / ${fixture} at ${width}px preserves active search and selection`)),
  readiness: ACCEPTANCE_WIDTHS.flatMap(width => PUBLICATION_FIXTURES.map(fixture => `production syntax readiness / unheld ${fixture} readiness at ${width}px`)),
  "readiness-http-cache": ACCEPTANCE_WIDTHS.flatMap(width => PUBLICATION_FIXTURES.map(fixture => `production syntax readiness / unheld ${fixture} readiness at ${width}px`)),
} as const;

interface ViewerReportSuite {
  title: string;
  suites?: ViewerReportSuite[];
  specs?: {
    title: string;
    tests: {
      projectName: string;
      repeatEachIndex?: number;
      status: string;
      results: { status: string; retry: number; attachments?: { name: string; body?: string }[] }[];
    }[];
  }[];
}

export function evaluateViewerAcceptanceReport(slice: keyof typeof VIEWER_ACCEPTANCE_CASES, report: { suites: ViewerReportSuite[]; errors?: unknown[] }) {
  const trials = 3;
  const titles = VIEWER_ACCEPTANCE_CASES[slice];
  const identity = (title: string, engine: string, trial: number) => JSON.stringify([title, engine, trial]);
  const expected = titles.flatMap(title => ACCEPTANCE_ENGINES.flatMap(engine => Array.from({ length: trials }, (_, trial) => identity(title, engine, trial))));
  const samples: ViewerAcceptanceSample[] = [];
  const visit = (suite: ViewerReportSuite, parents: string[]) => {
    for (const spec of suite.specs ?? []) {
      const title = [...parents, spec.title].join(" / ");
      for (const test of spec.tests) {
        for (const result of test.results) {
          const attachments = result.attachments ?? [];
          const readiness = slice === "readiness" || slice === "readiness-http-cache";
          const name = slice === "publication" ? "viewer-timing-budgets.json" : readiness ? "syntax-readiness.json" : slice === "source-typing" ? "source-typing" : slice === "prose-table" ? "prose-table-responsiveness" : slice === "table-editing" ? "large-table-editing" : "source-responsiveness";
          const evidence = attachments.filter(attachment => attachment.name === name);
          let validEvidence = evidence.length === (slice === "readiness-http-cache" ? 2 : 1);
          const cacheStates: string[] = [];
          let trial = test.repeatEachIndex;
          for (const attachment of evidence) {
            try {
              const measurement = JSON.parse(Buffer.from(attachment.body ?? "", "base64").toString("utf8"));
              trial ??= measurement.trial;
              validEvidence &&= Number.isInteger(trial) && (measurement.trial === undefined || measurement.trial === trial);
              const budget = measurement.budgets ?? measurement.budget ?? measurement;
              let computed: { status: string };
              if (readiness) {
                computed = evaluateViewerReadinessBudgets(measurement.metrics ?? {});
                cacheStates.push(measurement.cacheState);
              } else if (slice === "prose-table") {
                computed = evaluateTimingMetrics({ documentCompletion: VIEWER_TIMING_TARGETS_MS.documentCompletion, maximumTimerGap: VIEWER_TIMING_TARGETS_MS.maximumTimerGap }, measurement.load ?? {}, false);
              } else {
                const values: Record<string, number | null> = {};
                const metrics = budget.metrics ?? [];
                for (const metric of metrics) values[metric.metric] = metric.observedMs;
                computed = slice === "publication" ? evaluateViewerTimingBudgets(values) : slice === "source-typing" || slice === "table-editing" ? evaluateSourceTypingBudgets(values) : evaluateSourceResponsivenessBudgets(values);
                validEvidence &&= metrics.length === Object.keys(values).length;
              }
              validEvidence &&= measurement.enforced === true && budget.status === "pass" && computed.status === "pass";
            } catch { validEvidence = false; }
          }
          if (readiness) validEvidence &&= JSON.stringify(cacheStates.sort()) === JSON.stringify(slice === "readiness-http-cache" ? ["cold", "warm-http-fresh-workers"] : ["routed-no-cache"]);
          samples.push({ identity: identity(title, test.projectName, trial ?? -1), retry: result.retry, status: result.status === "passed" && test.status === "expected" && validEvidence ? "pass" : "invalid" });
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...parents, child.title]);
  };
  for (const suite of report.suites) visit(suite, []);
  const coverage = evaluateViewerAcceptanceCoverage(expected, samples);
  return { ...coverage, status: !report.errors?.length ? coverage.status : "fail", slice };
}

export const VIEWER_READINESS_TARGETS_MS = {
  firstUsableText: 1_500,
  firstVisibleSyntax: 1_500,
  fullSyntaxPreparation: 3_000,
} as const;

export type ViewerReadinessMetric = keyof typeof VIEWER_READINESS_TARGETS_MS;
export type ViewerReadinessSamples = Partial<Record<ViewerReadinessMetric, number | null>>;

export const SOURCE_RESPONSIVENESS_TARGETS_MS = {
  atomicCommit: 50,
  serialization: 50,
  synchronousPublication: 50,
  maximumTimerGap: 50,
} as const;

export type SourceResponsivenessSamples = Partial<Record<keyof typeof SOURCE_RESPONSIVENESS_TARGETS_MS, number | null>>;

export function evaluateSourceResponsivenessBudgets(samples: SourceResponsivenessSamples, diagnostic = false) {
  return evaluateTimingMetrics(SOURCE_RESPONSIVENESS_TARGETS_MS, samples, diagnostic);
}

export const SOURCE_TYPING_TARGETS_MS = {
  keyboardTwoFrameP95: 50,
  maximumTimerGap: 50,
  serialization: 50,
  synchronousPublication: 50,
} as const;

export type SourceTypingSamples = Partial<Record<keyof typeof SOURCE_TYPING_TARGETS_MS, number | null>>;

export function evaluateSourceTypingBudgets(samples: SourceTypingSamples) {
  return evaluateTimingMetrics(SOURCE_TYPING_TARGETS_MS, samples, false, ["keyboardTwoFrameP95"]);
}

function evaluateTimingMetrics<Metric extends string>(targets: Record<Metric, number>, samples: Partial<Record<Metric, number | null>>, diagnostic: boolean, exclusive: readonly Metric[] = []) {
  const metrics = (Object.entries(targets) as [Metric, number][]).map(([metric, targetMs]) => {
    const observedMs = samples[metric];
    const valid = typeof observedMs === "number" && Number.isFinite(observedMs) && observedMs >= 0;
    const status = !valid ? "invalid" : observedMs > targetMs || (observedMs === targetMs && exclusive.includes(metric)) ? "fail" : "pass";
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
