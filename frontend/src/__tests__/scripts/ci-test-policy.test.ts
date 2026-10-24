import { describe, expect, it } from "vitest";
import { ciWorkerCount, expectedBrowserCases, validateBrowserCases } from "../../../scripts/ci-test-policy.mjs";

describe("CI resource and browser policy", () => {
  it.each([
    [4, 16, 4],
    [2, 8, 2],
    [12, 31, 4],
    [8, 6, 2],
    [1, 1, 1],
  ])("caps %s CPUs and %s GiB at %s workers", (cpus, gib, expected) => {
    expect(ciWorkerCount(cpus, gib * 1024 ** 3)).toBe(expected);
  });

  it.each([
    [0, 8],
    [2, 0],
    [NaN, 8],
    [2, Infinity],
  ])("rejects invalid resources", (cpus, memory) => {
    expect(() => ciWorkerCount(cpus, memory)).toThrow("positive CPU and memory");
  });

  for (const mode of ["production", "development"] as const) {
    const passing = () =>
      expectedBrowserCases(mode).map((identity) => {
        const [engine, title] = identity.split(": ");
        return { engine, title, status: "passed", attempts: 1 };
      });
    it(`requires the complete ${mode} engine/width matrix`, () => {
      expect(passing()).toHaveLength(mode === "production" ? 16 : 2);
      expect(validateBrowserCases(mode, passing())).toEqual([]);
      expect(validateBrowserCases(mode, passing().slice(1))).not.toEqual([]);
      expect(validateBrowserCases(mode, [...passing(), passing()[0]!])).not.toEqual([]);
    });
    it.each(["skipped", "failed", "timedOut", "interrupted"])(`rejects ${mode} %s results`, (status) => {
      const cases = passing();
      cases[0]!.status = status;
      expect(validateBrowserCases(mode, cases)).not.toEqual([]);
    });
    it(`rejects ${mode} retry-only success`, () => {
      const cases = passing();
      cases[0]!.attempts = 2;
      expect(validateBrowserCases(mode, cases)).not.toEqual([]);
    });
  }
  it("rejects unknown modes", () => expect(() => expectedBrowserCases("diagnostic")).toThrow("Unknown"));
});
