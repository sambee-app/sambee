/* Purpose: Runs Pagefind with a bounded worker pool for local development. */

const { spawnSync } = require("child_process");

const DEVELOPMENT_ARGUMENT = "--development";
const DEVELOPMENT_THREADS = "4";
const cliArguments = process.argv.slice(2);
const development = cliArguments.includes(DEVELOPMENT_ARGUMENT);
const environment = { ...process.env };

if (development) {
   environment.RAYON_NUM_THREADS ||= DEVELOPMENT_THREADS;
}

const result = spawnSync("npx", [
   "--no-install", "pagefind",
   ...cliArguments.filter((argument) => argument !== DEVELOPMENT_ARGUMENT),
], {
   env: environment,
   stdio: "inherit",
});

if (result.error || result.signal) {
   console.error(`[pagefind] Search indexing could not finish: ${result.error?.message || result.signal}`);
}
process.exit(result.status ?? 1);
