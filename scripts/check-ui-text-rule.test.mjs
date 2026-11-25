import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Biome flags UI literals but accepts translations and non-display values", () => {
  const root = mkdtempSync(join(tmpdir(), "sambee-ui-lint-"));
  const biome = fileURLToPath(new URL("../frontend/node_modules/.bin/biome", import.meta.url));
  const plugin = fileURLToPath(new URL("../frontend/no-hardcoded-ui-text.grit", import.meta.url));
  const file = join(root, "example.tsx");
  const config = join(root, "biome.json");
  try {
    writeFileSync(config, JSON.stringify({ plugins: [plugin] }));
    const lint = (source) => {
      writeFileSync(file, source);
      return spawnSync(biome, ["lint", "--only=plugin", "--config-path", config, "--reporter=json", file], { encoding: "utf8" });
    };
    const bad = lint('<button title="Save" aria-label={"Save"} placeholder="Name">Save{"Now"}</button>');
    assert.equal(bad.status, 1, bad.stderr);
    assert.ok(bad.stdout, bad.stderr);
    assert.equal(JSON.parse(bad.stdout).diagnostics.length, 5);
    const fieldCopy = lint('<TextField label="Search users" helperText={"Type a username"} />');
    assert.equal(fieldCopy.status, 1, fieldCopy.stderr);
    assert.equal(JSON.parse(fieldCopy.stdout).diagnostics.length, 2);
    const localizedField = lint('<TextField label={t("searchUsers")} helperText={t("searchHelp")} />');
    assert.equal(localizedField.status, 0, localizedField.stderr);
    const nonEnglish = lint("<button>保存</button>");
    assert.equal(nonEnglish.status, 1, nonEnglish.stderr);
    assert.equal(JSON.parse(nonEnglish.stdout).diagnostics.length, 1);
    const good = lint('<><button title={t("save")} aria-label={t("save")} className="button" data-testid="save">&ensp;↵{t("save")}</button><kbd>Shift+Del</kbd><img alt="Sambee" />Sambee</>');
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout).diagnostics, []);
    const keyboardCopy = lint("<kbd>Press Enter</kbd>");
    assert.equal(keyboardCopy.status, 1, keyboardCopy.stderr);
    const emptyAlt = lint('<><img alt="" src="logo.svg" />{"\\u2192"}</>');
    assert.equal(emptyAlt.status, 0, emptyAlt.stderr);
    const escapedText = lint('<button>{"\\u0041"}</button>');
    assert.equal(escapedText.status, 1, escapedText.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared Biome configuration enforces UI text in both apps but excludes fixtures", () => {
  const root = mkdtempSync(join(tmpdir(), "sambee-ui-config-"));
  const workspace = fileURLToPath(new URL("../", import.meta.url));
  const biome = join(workspace, "frontend/node_modules/.bin/biome");
  try {
    for (const app of ["frontend", "companion"]) {
      mkdirSync(join(root, app, "src/components/__tests__"), { recursive: true });
      mkdirSync(join(root, app, "src/components/__fixtures__"), { recursive: true });
      copyFileSync(join(workspace, app, "biome.json"), join(root, app, "biome.json"));
    }
    copyFileSync(join(workspace, "biome.json"), join(root, "biome.json"));
    copyFileSync(join(workspace, "frontend/biome-base.json"), join(root, "frontend/biome-base.json"));
    copyFileSync(join(workspace, "frontend/no-hardcoded-ui-text.grit"), join(root, "frontend/no-hardcoded-ui-text.grit"));
    for (const app of ["frontend", "companion"]) {
      const cwd = join(root, app);
      const file = join(cwd, "src/components/Example.tsx");
      const lint = (path) =>
        spawnSync(biome, ["lint", "--only=plugin", "--reporter=json", path], { cwd, encoding: "utf8" });
      writeFileSync(file, "<button>Save</button>");
      const literal = lint(file);
      assert.equal(literal.status, 1, `${app}: ${literal.stderr}`);
      assert.equal(JSON.parse(literal.stdout).diagnostics.length, 1);
      const workspaceLiteral = spawnSync(biome, ["lint", "--only=plugin", file], { cwd: root, encoding: "utf8" });
      assert.equal(workspaceLiteral.status, 1, `${app}: workspace lint must reject literals: ${workspaceLiteral.stderr}`);
      writeFileSync(file, '<button>{t("save")}</button>');
      const translated = lint(file);
      assert.equal(translated.status, 0, `${app}: ${translated.stderr}`);
      assert.deepEqual(JSON.parse(translated.stdout).diagnostics, []);
      const jsx = join(cwd, "src/components/Example.jsx");
      writeFileSync(jsx, "<button>Save</button>");
      assert.equal(lint(jsx).status, 1, `${app}: JSX literals must be rejected`);
      const fixture = join(cwd, "src/components/__tests__/Example.test.tsx");
      writeFileSync(fixture, "<button>Fixture</button>");
      assert.equal(lint(fixture).status, 0, `${app}: fixture must be excluded`);
      const fixtureComponent = join(cwd, "src/components/__fixtures__/Example.tsx");
      writeFileSync(fixtureComponent, "<button>Fixture</button>");
      assert.equal(lint(fixtureComponent).status, 0, `${app}: fixture component must be excluded`);
    }
    const preview = join(root, "companion/src/components/PreviewHome.tsx");
    writeFileSync(preview, "<button>Preview</button>");
    assert.equal(
      spawnSync(biome, ["lint", "--only=plugin", preview], { cwd: join(root, "companion"), encoding: "utf8" }).status,
      0,
      "browser-only preview must be excluded"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
