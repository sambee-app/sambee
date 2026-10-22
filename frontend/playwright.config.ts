import { defineConfig, devices } from "@playwright/test";

const frontendE2ePort = 4173;
const productionProof = process.env.SAMBEE_E2E_PRODUCTION === "1";
const existingAppProof = productionProof || process.env.SAMBEE_E2E_DEVELOPMENT === "1";
const baseURL = existingAppProof ? "http://localhost:3000" : `http://127.0.0.1:${frontendE2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 15_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: existingAppProof ? undefined : {
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
