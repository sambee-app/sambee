import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["production", "development"]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url)), "test", ...process.argv.slice(2)],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
      env: {
        ...process.env,
        SAMBEE_E2E_CI: "1",
        SAMBEE_E2E_PRODUCTION: mode === "production" ? "1" : "0",
        SAMBEE_E2E_DEVELOPMENT: mode === "development" ? "1" : "0",
      },
    }
  );
  if (result.error) console.error(`Could not start ${mode} browser contracts: ${result.error.message}`);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
