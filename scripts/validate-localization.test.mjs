import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getTranslationInput, validateCatalog, validateTerminology } from "./validate-localization.mjs";

const english = { item_one: "{{count}} item", item_other: "{{count}} items", open: "Open {{name}}" };
const hash = (forms) => createHash("sha256").update(JSON.stringify(forms)).digest("hex");

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
