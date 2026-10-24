import { defineConfig, devices } from "@playwright/test";

const frontendE2ePort = 4173;
const productionProof = process.env.SAMBEE_E2E_PRODUCTION === "1";
const correctnessCI = process.env.SAMBEE_E2E_CI === "1";
const ciMode = productionProof ? "production" : "development";
const existingAppProof = productionProof || process.env.SAMBEE_E2E_DEVELOPMENT === "1";
const baseURL = existingAppProof ? "http://localhost:3000" : `http://127.0.0.1:${frontendE2ePort}`;

if (
  correctnessCI &&
  ["SAMBEE_E2E_BUDGETS", "SAMBEE_E2E_MEMORY", "SAMBEE_E2E_TRACE", "SAMBEE_E2E_RETAINED", "SAMBEE_E2E_HTTP_CACHE"].some(
    (name) => process.env[name] === "1"
  )
) {
  throw new Error("Run browser correctness separately from diagnostic and alternate-renderer modes");
}

export default defineConfig({
  testDir: "./e2e",
  timeout: correctnessCI ? 30_000 : 15_000,
  fullyParallel: false,
  workers: correctnessCI ? 1 : undefined,
  retries: correctnessCI ? 0 : process.env.CI ? 1 : 0,
  forbidOnly: correctnessCI || !!process.env.CI,
  grep: correctnessCI ? (productionProof ? /production CI correctness/ : /development Markdown worker/) : undefined,
  outputDir: correctnessCI ? `test-results/ci/${ciMode}-artifacts` : "test-results",
  reporter: correctnessCI
    ? [["list"], ["json", { outputFile: `test-results/ci/${ciMode}.json` }], ["./scripts/ci-browser-reporter.mjs", { mode: ciMode }]]
    : undefined,
  use: {
    baseURL,
    trace: correctnessCI ? "retain-on-failure" : "on-first-retry",
    screenshot: correctnessCI ? "only-on-failure" : "off",
  },
  webServer:
    correctnessCI && !productionProof
      ? {
          command: "npm run dev -- --host localhost --port 3000 --strictPort",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        }
      : existingAppProof
        ? undefined
        : {
            command: `npm run dev -- --host 127.0.0.1 --port ${frontendE2ePort}`,
            url: baseURL,
            reuseExistingServer: true,
            timeout: 120_000,
          },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
