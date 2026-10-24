import { validateBrowserCases } from "./ci-test-policy.mjs";

export default class CiBrowserReporter {
  constructor(options) {
    this.mode = options.mode;
  }

  onBegin(_config, suite) {
    this.suite = suite;
  }

  onEnd(result) {
    const cases = this.suite.allTests().map((test) => ({
      engine: test.parent.project()?.name,
      title: test.title,
      status: test.results.at(-1)?.status,
      attempts: test.results.length,
    }));
    const errors = validateBrowserCases(this.mode, cases);
    for (const error of errors) console.error(error);
    console.log(`Browser correctness ${this.mode}: ${cases.length} cases, ${errors.length} contract violations`);
    if (errors.length || result.status !== "passed") return { status: "failed" };
  }
}
