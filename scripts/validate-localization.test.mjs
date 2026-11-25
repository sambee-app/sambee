import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { getTranslationInput, validateCatalog, validateTerminology } from "./validate-localization.mjs";

const english = { item_one: "{{count}} item", item_other: "{{count}} items", open: "Open {{name}}" };
const hash = (forms) => createHash("sha256").update(JSON.stringify(forms)).digest("hex");

test("strict CLI reports missing and stale frontend, companion and native keys", () => {
  const root = mkdtempSync(join(tmpdir(), "sambee-localization-test-"));
  const write = (path, value) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const json = (path, value) => write(path, JSON.stringify(value));
  try {
    mkdirSync(join(root, "scripts"));
    cpSync(new URL("./validate-localization.mjs", import.meta.url), join(root, "scripts/validate-localization.mjs"));
    write("frontend/src/i18n/languages.ts", 'export const LANGUAGE_NAMES = { en: "English", fr: "French" }; export const SHIPPING_LANGUAGES = ["en", "fr"];');
    write("frontend/src/i18n/resources.ts", 'export const EN_TRANSLATIONS = { button: "Open" };');
    write("companion/src/i18n/resources.ts", 'export const EN_TRANSLATIONS = { button: "Open", native: { trayQuit: "Quit" } };');
    json("localization/glossary.json", { locales: {} });
    json("frontend/src/i18n/catalogs/fr.json", { button: "Ouvrir" });
    json("frontend/src/i18n/fingerprints/fr.json", { button: hash(["Open"]) });
    json("companion/src/i18n/catalogs/fr.json", { button: "Ouvrir", native: { trayQuit: "Quitter" } });
    json("companion/src/i18n/fingerprints/fr.json", { button: hash(["Open"]), "native.trayQuit": hash(["Quit"]) });
    const run = () => spawnSync(process.execPath, [join(root, "scripts/validate-localization.mjs"), "--release"], { encoding: "utf8" });
    const complete = run();
    assert.equal(complete.status, 0, complete.stderr);

    json("frontend/src/i18n/fingerprints/fr.json", { button: hash(["Changed"]) });
    const stale = run();
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stdout, /frontend\/fr\/button: stale or without a source fingerprint/);

    json("frontend/src/i18n/catalogs/fr.json", {});
    json("companion/src/i18n/catalogs/fr.json", { native: {} });
    const incomplete = run();
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.match(incomplete.stdout, /frontend\/fr\/button: missing/);
    assert.match(incomplete.stdout, /companion\/fr\/button: missing/);
    assert.match(incomplete.stdout, /companion\/fr\/native\.trayQuit: missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates Japanese plurals and exact interpolation names", () => {
  const { errors, missing } = validateCatalog(english, "ja", {
    item_one: "{{count}} 件",
    item_other: "{{count}} 件",
    open: "{{path}} を開く",
    extra: "余分",
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, [
    "item_one: unknown key or invalid plural form",
    "open: expected placeholders name",
    "extra: unknown key or invalid plural form",
  ]);
});

test("reports missing Polish forms and invalidates every translation when the English singular changes", () => {
  const catalog = { item_one: "{{count}} plik", item_few: "{{count}} pliki", item_many: "{{count}} plików", open: "Otwórz {{name}}" };
  const fingerprints = Object.fromEntries(
    Object.keys(catalog).map((key) => [key, hash(key === "open" ? [english.open] : [english.item_one, english.item_other])])
  );
  assert.deepEqual(validateCatalog(english, "pl", catalog, fingerprints), { errors: [], missing: ["item_other"], stale: [] });
  assert.deepEqual(validateCatalog({ ...english, item_one: "{{count}} file" }, "pl", catalog, fingerprints).stale, [
    "item_one", "item_few", "item_many",
  ]);
});

test("requires source fingerprints, not manual approval", () => {
  const catalog = { open: "Ouvrir {{name}}" };
  assert.deepEqual(validateCatalog(english, "fr", catalog).stale, ["open"]);
  const fingerprints = { open: hash([english.open]) };
  assert.deepEqual(validateCatalog(english, "fr", catalog, fingerprints).stale, []);
});

test("exports only missing and stale messages and includes all English plural forms", () => {
  const catalog = { open: "Ouvrir {{name}}", item_other: "{{count}} 件" };
  const fingerprints = { open: hash([english.open]) };
  assert.deepEqual(getTranslationInput(english, "ja", catalog, fingerprints), {
    item_other: {
      source: { one: english.item_one, other: english.item_other },
      fingerprint: hash([english.item_one, english.item_other]),
    },
  });
});

test("enforces shared Portuguese terms without matching word fragments or unrelated transfer keys", () => {
  const glossary = {
    locales: {
      pt: {
        terms: [
          { concept: "file", preferred: "arquivo", avoid: ["ficheiro", "ficheiros"] },
          { concept: "share", preferred: "compartilhar", avoid: ["partilhar"] },
          { concept: "manage", preferred: "gerenciar", avoid: ["gerir", "gere"] },
          { concept: "ongoing editing", preferred: "sendo editado", avoid: ["a ser editado"] },
          { concept: "download", preferred: "baixar", keyIncludes: ["download"], avoid: ["transferir"] },
        ],
      },
    },
  };

  assert.deepEqual(validateTerminology("pt", {
    file: "Arquivo pronto",
    share: "Compartilhar o arquivo",
    management: "Gerenciar as conexões",
    editing: "O arquivo está sendo editado.",
    transfers: "Transferir arquivos",
  }, glossary), []);
  assert.deepEqual(validateTerminology("pt", {
    file: "Ficheiro pronto",
    management: "O servidor gere as conexões",
    editing: "O arquivo está a ser editado.",
    downloadAction: "Transferir arquivo",
  }, glossary), [
    "file: use \"arquivo\" instead of \"ficheiro\" for file",
    "management: use \"gerenciar\" instead of \"gere\" for manage",
    "editing: use \"sendo editado\" instead of \"a ser editado\" for ongoing editing",
    "downloadAction: use \"baixar\" instead of \"transferir\" for download",
  ]);
});
