import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FRONTEND_ROOT = process.cwd();
const HELPER_PATH = join(FRONTEND_ROOT, "scripts/dependency-state.mjs");
const RECOVERY_COMMAND = "cd frontend && npm ci";

describe("frontend dependency freshness", () => {
  let workspace: string;
  let root: string;
  let script: string;
  let stamp: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "sambee-dependencies-"));
    root = join(workspace, "frontend");
    mkdirSync(root);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "node_modules"));
    script = join(root, "scripts/dependency-state.mjs");
    stamp = join(root, "node_modules/.dependencies.sha256");
    copyFileSync(HELPER_PATH, script);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function run(mode: string) {
    return spawnSync(process.execPath, [script, mode], { cwd: tmpdir(), encoding: "utf8" });
  }

  it("accepts a current installation regardless of the working directory", () => {
    expect(run("--write").status).toBe(0);
    expect(readFileSync(stamp, "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    expect(run("--check").status).toBe(0);
  });

  it.each(["package.json", "package-lock.json"])("rejects a changed %s", (filename) => {
    expect(run("--write").status).toBe(0);
    writeFileSync(join(root, filename), JSON.stringify({ changed: true }));
    const result = run("--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependencies are stale");
    expect(result.stderr).toContain(RECOVERY_COMMAND);
  });

  it.each([false, true])("rejects a missing stamp with node_modules removed=%s", (removeModules) => {
    if (removeModules) {
      rmSync(join(root, "node_modules"), { recursive: true });
    }
    const result = run("--check");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stamp is missing");
    expect(result.stderr).toContain(RECOVERY_COMMAND);
  });

  it("rejects an invalid stamp", () => {
    writeFileSync(stamp, "invalid\n");
    expect(run("--check").status).toBe(1);
  });

  it("invalidates the stamp before installation and tolerates an absent stamp", () => {
    expect(run("--write").status).toBe(0);
    expect(run("--clear").status).toBe(0);
    expect(run("--check").status).toBe(1);
    expect(run("--clear").status).toBe(0);
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(run("--clear").status).toBe(0);
  });

  it("reports unreadable inputs and failed writes without stamping success", () => {
    rmSync(join(root, "package-lock.json"));
    expect(run("--write").status).toBe(1);
    expect(run("--check").stderr).toContain(RECOVERY_COMMAND);
    writeFileSync(join(root, "package-lock.json"), "{}");
    rmSync(join(root, "node_modules"), { recursive: true });
    expect(run("--write").status).toBe(1);
  });

  it("rejects unknown modes", () => {
    const result = run("--unknown");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  describe.each(["frontend", "companion"])("%s Biome version alignment", (project) => {
    const version = "2.6.2";
    const schema = `https://biomejs.dev/schemas/${version}/schema.json`;
    const installedPackage = "node_modules/@biomejs/biome/package.json";
    const configs = project === "companion" ? ["../biome.json", "../frontend/biome.json", "biome.json"] : ["../biome.json", "biome.json"];

    function run(mode: string) {
      const arguments_ = mode === "--check-biome" ? [project] : [];
      return spawnSync(process.execPath, [script, mode, ...arguments_], { cwd: tmpdir(), encoding: "utf8" });
    }

    beforeEach(() => {
      root = join(workspace, project);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": version } }));
      writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@biomejs/biome": { version } } }));
      mkdirSync(join(root, "node_modules/@biomejs/biome"), { recursive: true });
      writeFileSync(join(root, installedPackage), JSON.stringify({ version }));
      for (const filename of configs) {
        writeFileSync(join(root, filename), JSON.stringify({ $schema: schema }));
      }
    });

    it("accepts matching versions without an installation stamp", () => {
      expect(run("--check-biome").status).toBe(0);
    });

    it.each(configs)("rejects a schema mismatch in %s", (filename) => {
      writeFileSync(join(root, filename), JSON.stringify({ $schema: "https://biomejs.dev/schemas/2.3.4/schema.json" }));
      const result = run("--check-biome");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${filename} must use schema ${schema}`);
      expect(result.stderr).toContain("biome migrate --write");
    });

    it("rejects an installed version mismatch even with a current stamp", () => {
      expect(run("--write").status).toBe(0);
      writeFileSync(join(root, installedPackage), JSON.stringify({ version: "2.5.15" }));
      expect(run("--check").status).toBe(0);
      const result = run("--check-biome");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Installed Biome version 2.5.15 does not match locked version");
      expect(result.stderr).toContain(`cd ${project} && npm ci`);
    });

    it("rejects a package pin that differs from the locked version", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": "2.5.15" } }));
      expect(run("--check-biome").stderr).toContain("Pin @biomejs/biome in package.json");
    });

    it("rejects a missing locked Biome version", () => {
      writeFileSync(join(root, "package-lock.json"), "{}");
      const result = run("--check-biome");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("has no locked @biomejs/biome version");
    });

    it.each(["biome.json", installedPackage])("rejects missing or invalid JSON in %s", (filename) => {
      rmSync(join(root, filename));
      expect(run("--check-biome").status).toBe(1);
      writeFileSync(join(root, filename), "invalid");
      const result = run("--check-biome");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Cannot read ${filename}`);
    });
  });

  it.each([
    ["--check-biome", "unknown"],
    ["--write", "companion"],
    ["--check-biome", "companion", "extra"],
  ])("rejects invalid arguments %s %s", (...arguments_) => {
    const result = spawnSync(process.execPath, [script, ...arguments_], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("wires stamping after setup and validation before the expensive test stages", () => {
    const { scripts } = JSON.parse(readFileSync(join(FRONTEND_ROOT, "package.json"), "utf8"));
    expect(scripts.preinstall).toBe("node scripts/dependency-state.mjs --clear");
    expect(scripts.postinstall).toMatch(/&& node scripts\/dependency-state.mjs --write$/);
    expect(scripts["check:dependencies"]).toBe("node scripts/dependency-state.mjs --check");
    expect(scripts["check:biome"]).toBe("node scripts/dependency-state.mjs --check-biome");
    expect(scripts.prelint).toBe("npm run check:dependencies && npm run check:biome");
    const { scripts: companionScripts } = JSON.parse(readFileSync(join(FRONTEND_ROOT, "../companion/package.json"), "utf8"));
    expect(companionScripts["check:biome"]).toBe("node ../frontend/scripts/dependency-state.mjs --check-biome companion");
    expect(companionScripts.prelint).toBe("npm run check:biome");
    const runner = readFileSync(join(FRONTEND_ROOT, "../scripts/test"), "utf8");
    const checkPosition = runner.indexOf('node "$REPO_ROOT/frontend/scripts/dependency-state.mjs" --check');
    expect(checkPosition).toBeGreaterThan(0);
    expect(checkPosition).toBeLessThan(runner.indexOf("SETUP: Generate Test Images"));
  });
});
