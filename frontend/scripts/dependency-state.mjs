import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = new URL("../", import.meta.url);
const STAMP_PATH = new URL("node_modules/.dependencies.sha256", FRONTEND_ROOT);
const DEPENDENCY_INPUTS = ["package.json", "package-lock.json"];
const RECOVERY_MESSAGE = "Run cd frontend && npm ci from the repository root to restore frontend dependencies.";
const VALID_MODES = new Set(["--clear", "--write", "--check"]);

async function dependencyHash() {
  const hash = createHash("sha256");
  for (const filename of DEPENDENCY_INPUTS) {
    hash.update(filename).update("\0");
    hash.update(await readFile(new URL(filename, FRONTEND_ROOT))).update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  const [mode, ...extraArguments] = process.argv.slice(2);
  if (!VALID_MODES.has(mode) || extraArguments.length > 0) {
    throw new Error("Usage: node scripts/dependency-state.mjs --clear|--write|--check");
  }

  if (mode === "--clear") {
    await rm(STAMP_PATH, { force: true });
    return;
  }

  const currentHash = await dependencyHash();
  if (mode === "--write") {
    await writeFile(STAMP_PATH, `${currentHash}\n`);
    return;
  }

  let recordedHash;
  try {
    recordedHash = (await readFile(STAMP_PATH, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    throw new Error(`Frontend dependency stamp is missing at ${fileURLToPath(STAMP_PATH)}.`);
  }

  if (recordedHash !== currentHash) {
    throw new Error("Frontend dependencies are stale: package.json or package-lock.json changed, or the stamp is invalid.");
  }
}

try {
  await main();
} catch (error) {
  console.error(`Frontend dependency validation failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(RECOVERY_MESSAGE);
  process.exitCode = 1;
}
