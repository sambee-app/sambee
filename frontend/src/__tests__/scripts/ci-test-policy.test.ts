import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";
import { ciWorkerCount, expectedBrowserCases, validateBrowserCases } from "../../../scripts/ci-test-policy.mjs";

describe("CI resource and browser policy", () => {
  it.each([
    [4, 16, 4],
    [2, 8, 2],
    [12, 31, 4],
    [8, 6, 2],
    [1, 1, 1],
  ])("caps %s CPUs and %s GiB at %s workers", (cpus, gib, expected) => {
    expect(ciWorkerCount(cpus, gib * 1024 ** 3)).toBe(expected);
  });

  it.each([
    [0, 8],
    [2, 0],
    [NaN, 8],
    [2, Infinity],
  ])("rejects invalid resources", (cpus, memory) => {
    expect(() => ciWorkerCount(cpus, memory)).toThrow("positive CPU and memory");
  });

  for (const mode of ["production", "development"] as const) {
    const passing = () =>
      expectedBrowserCases(mode).map((identity) => {
        const [engine, title] = identity.split(": ");
        return { engine, title, status: "passed", attempts: 1 };
      });
    it(`requires the complete ${mode} engine/width matrix`, () => {
      expect(passing()).toHaveLength(mode === "production" ? 16 : 2);
      expect(validateBrowserCases(mode, passing())).toEqual([]);
      expect(validateBrowserCases(mode, passing().slice(1))).not.toEqual([]);
      expect(validateBrowserCases(mode, [...passing(), passing()[0]!])).not.toEqual([]);
    });
    it.each(["skipped", "failed", "timedOut", "interrupted"])(`rejects ${mode} %s results`, (status) => {
      const cases = passing();
      cases[0]!.status = status;
      expect(validateBrowserCases(mode, cases)).not.toEqual([]);
    });
    it(`rejects ${mode} retry-only success`, () => {
      const cases = passing();
      cases[0]!.attempts = 2;
      expect(validateBrowserCases(mode, cases)).not.toEqual([]);
    });
  }
  it("rejects unknown modes", () => expect(() => expectedBrowserCases("diagnostic")).toThrow("Unknown"));
});

describe("required frontend type correctness", () => {
  const root = process.cwd();
  const projectNames = ["tsconfig.app.json", "tsconfig.test.json", "tsconfig.node.json"];

  it("requires the real solution check before producing normal build assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.scripts.typecheck).toBe("tsc -b --noEmit");
    expect(manifest.scripts.build).toMatch(/^npm run typecheck && /);
    const solution = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
    expect(solution.references).toEqual(projectNames.map((path) => ({ path: `./${path}` })));
  });

  it("uses the real check in the local test runner and VS Code task", () => {
    const runner = readFileSync(resolve(root, "../scripts/test"), "utf8");
    expect(runner).toContain('run_check "TypeScript type check passed" "TypeScript type check failed" npm run typecheck');
    const tasks = JSON.parse(readFileSync(resolve(root, "../.vscode/tasks.json"), "utf8"));
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Frontend: Type Check + Lint",
          command: expect.stringMatching(/^npm run typecheck 2>&1 && /),
        }),
      ])
    );
  });

  it("preserves strict options and checks every application, test, helper, and declaration file", () => {
    const compiler = new API();
    try {
      const projects = projectNames.map((name) => compiler.parseConfigFile(resolve(root, name)));
      const strictOptions = [
        "strict",
        "noUnusedLocals",
        "noUnusedParameters",
        "noUncheckedIndexedAccess",
        "noPropertyAccessFromIndexSignature",
        "noFallthroughCasesInSwitch",
      ];
      for (const project of projects) {
        for (const option of strictOptions) expect(project.options[option], option).toBe(true);
        expect(project.options["noCheck"]).not.toBe(true);
      }
      const checkedFiles = new Set(projects.flatMap((project) => project.fileNames));
      const sourceFiles = readdirSync(resolve(root, "src"), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .map((entry) => resolve(entry.parentPath, entry.name));
      expect(sourceFiles.length).toBeGreaterThan(0);
      expect(sourceFiles.filter((file) => !checkedFiles.has(file))).toEqual([]);
      expect(checkedFiles.has(resolve(root, "vite.config.ts"))).toBe(true);
      expect(checkedFiles.has(resolve(root, "vitest.config.ts"))).toBe(true);
      expect(projects.map((project) => project.options["types"])).toEqual([
        ["vite/client"],
        ["vite/client", "vitest/globals", "@testing-library/jest-dom/vitest", "node"],
        ["node"],
      ]);
    } finally {
      compiler.close();
    }
  });
});
