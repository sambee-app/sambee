export const CI_MAX_WORKERS = 4;
export const CI_WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
export const CI_RESERVED_MEMORY_BYTES = 2 * 1024 ** 3;
export const CI_BROWSER_ENGINES = ["chromium", "firefox"];
export const CI_BROWSER_WIDTHS = [1543, 390];
export const CI_PRODUCTION_SCENARIOS = ["real workers", "native contracts", "edit and save", "cancel and reopen"];
export const CI_DEVELOPMENT_SCENARIO = "normalizes and renders entity text without DOM globals in the worker";
const CI_DEVELOPMENT_SCENARIOS = ["renders small notes without starting a normalization worker", CI_DEVELOPMENT_SCENARIO];

export function ciWorkerCount(cpuCount, memoryBytes) {
  if (!Number.isFinite(cpuCount) || cpuCount < 1 || !Number.isFinite(memoryBytes) || memoryBytes < 1) {
    throw new Error("CI worker selection requires positive CPU and memory measurements");
  }
  const memoryWorkers = Math.max(1, Math.floor((memoryBytes - CI_RESERVED_MEMORY_BYTES) / CI_WORKER_MEMORY_BYTES));
  return Math.min(CI_MAX_WORKERS, Math.floor(cpuCount), memoryWorkers);
}

export function expectedBrowserCases(mode) {
  if (mode !== "production" && mode !== "development") throw new Error(`Unknown browser CI mode: ${mode}`);
  const titles =
    mode === "production"
      ? CI_PRODUCTION_SCENARIOS.flatMap((scenario) => CI_BROWSER_WIDTHS.map((width) => `CI ${scenario} at ${width}px`))
      : CI_DEVELOPMENT_SCENARIOS;
  return CI_BROWSER_ENGINES.flatMap((engine) => titles.map((title) => `${engine}: ${title}`));
}

export function validateBrowserCases(mode, cases) {
  const missing = new Set(expectedBrowserCases(mode));
  const errors = [];
  for (const result of cases) {
    const identity = `${result.engine}: ${result.title}`;
    if (!missing.delete(identity)) errors.push(`Unexpected or duplicate browser case: ${identity}`);
    if (result.status !== "passed" || result.attempts !== 1) {
      errors.push(`Browser case must pass once without skips/retries: ${identity} (${result.status}, ${result.attempts} attempts)`);
    }
  }
  for (const identity of missing) errors.push(`Missing browser case: ${identity}`);
  return errors;
}
