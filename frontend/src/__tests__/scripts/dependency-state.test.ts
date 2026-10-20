import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FRONTEND_ROOT = process.cwd();
const HELPER_PATH = join(FRONTEND_ROOT, "scripts/dependency-state.mjs");
const RECOVERY_COMMAND = "cd frontend && npm ci";

describe("frontend dependency freshness", () => {
  let root: string;
  let script: string;
  let stamp: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sambee-dependencies-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "node_modules"));
    script = join(root, "scripts/dependency-state.mjs");
    stamp = join(root, "node_modules/.dependencies.sha256");
    copyFileSync(HELPER_PATH, script);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
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

  it("wires stamping after setup and validation before the expensive test stages", () => {
    const { scripts } = JSON.parse(readFileSync(join(FRONTEND_ROOT, "package.json"), "utf8"));
    expect(scripts.preinstall).toBe("node scripts/dependency-state.mjs --clear");
    expect(scripts.postinstall).toMatch(/&& node scripts\/dependency-state.mjs --write$/);
    expect(scripts["check:dependencies"]).toBe("node scripts/dependency-state.mjs --check");
    const runner = readFileSync(join(FRONTEND_ROOT, "../scripts/test"), "utf8");
    const checkPosition = runner.indexOf('node "$REPO_ROOT/frontend/scripts/dependency-state.mjs" --check');
    expect(checkPosition).toBeGreaterThan(0);
    expect(checkPosition).toBeLessThan(runner.indexOf("SETUP: Generate Test Images"));
  });
});
