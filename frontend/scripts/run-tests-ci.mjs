import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { ciWorkerCount } from "./ci-test-policy.mjs";

const cpus = availableParallelism();
const memoryBytes = totalmem();
console.log(
  `CI resources: ${cpus} CPUs, ${(memoryBytes / 1024 ** 3).toFixed(1)} GiB RAM; Vitest workers=${ciWorkerCount(cpus, memoryBytes)}`
);
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run", ...process.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    env: { ...process.env, SAMBEE_TEST_CI: "1" },
  }
);
if (result.error) console.error(`Could not start CI unit tests: ${result.error.message}`);
process.exitCode = result.status ?? 1;
