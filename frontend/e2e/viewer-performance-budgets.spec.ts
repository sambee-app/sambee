import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { evaluateViewerAcceptanceReport, VIEWER_ACCEPTANCE_CASES } from "./viewer-performance-budgets";

if (process.env.SAMBEE_E2E_REPORT) {
  test("recorded viewer acceptance report is complete and passing", async () => {
    const slice = process.env.SAMBEE_E2E_SLICE as keyof typeof VIEWER_ACCEPTANCE_CASES;
    expect(Object.keys(VIEWER_ACCEPTANCE_CASES)).toContain(slice);
    const report = JSON.parse(await readFile(process.env.SAMBEE_E2E_REPORT!, "utf8"));
    const coverage = evaluateViewerAcceptanceReport(slice, report);
    expect(coverage.status, JSON.stringify(coverage)).toBe("pass");
  });
}
