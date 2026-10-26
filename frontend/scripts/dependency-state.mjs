import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FRONTEND_ROOT = new URL("../", import.meta.url);
const STAMP_PATH = new URL("node_modules/.dependencies.sha256", FRONTEND_ROOT);
const DEPENDENCY_INPUTS = ["package.json", "package-lock.json"];
const RECOVERY_MESSAGE = "Run cd frontend && npm ci from the repository root to restore frontend dependencies.";
const BIOME_PACKAGE = "@biomejs/biome";
const BIOME_PACKAGE_PATH = `node_modules/${BIOME_PACKAGE}`;
const BIOME_CONFIGS = ["../biome.json", "biome.json"];
const VALID_MODES = new Set(["--clear", "--write", "--check", "--check-biome"]);

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(new URL(filename, FRONTEND_ROOT), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filename}. Restore a valid JSON file before running lint.`, { cause: error });
  }
}

async function checkBiome() {
  const lockfile = await readJson("package-lock.json");
  const version = lockfile?.packages?.[BIOME_PACKAGE_PATH]?.version;
  if (typeof version !== "string" || !version) {
    throw new Error(`package-lock.json has no locked ${BIOME_PACKAGE} version. Restore the frontend lockfile.`);
  }
  const manifest = await readJson("package.json");
  if (manifest?.devDependencies?.[BIOME_PACKAGE] !== version) {
    throw new Error(
      `Pin ${BIOME_PACKAGE} in package.json to the locked version ${version}, or update the dependency and lockfile together.`
    );
  }
  const installed = await readJson(`${BIOME_PACKAGE_PATH}/package.json`);
  if (installed?.version !== version) {
    throw new Error(`Installed Biome version ${installed?.version} does not match locked version ${version}.`);
  }
  const expectedSchema = `https://biomejs.dev/schemas/${version}/schema.json`;
  for (const filename of BIOME_CONFIGS) {
    const config = await readJson(filename);
    if (config?.$schema !== expectedSchema) {
      throw new Error(
        `${filename} must use schema ${expectedSchema}; found ${JSON.stringify(config?.$schema)}. ` +
          "Run biome migrate --write with the locked Biome version for this configuration and commit the configuration changes."
      );
    }
  }
}

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
    throw new Error("Usage: node scripts/dependency-state.mjs --clear|--write|--check|--check-biome");
  }

  if (mode === "--check-biome") {
    await checkBiome();
    return;
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
