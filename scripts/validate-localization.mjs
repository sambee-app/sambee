import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EN_TRANSLATIONS as companion } from "../companion/src/i18n/resources.ts";
import { LANGUAGE_NAMES, SHIPPING_LANGUAGES } from "../frontend/src/i18n/languages.ts";
import { EN_TRANSLATIONS as frontend } from "../frontend/src/i18n/resources.ts";

const PLURAL = /_(zero|one|two|few|many|other)$/;
const terminology = JSON.parse(readFileSync(new URL("../localization/glossary.json", import.meta.url), "utf8"));
const placeholders = (message) => [...new Set([
  ...Array.from(message.matchAll(/{{\s*-?\s*([^},]+?)(?:,[^}]*)?\s*}}/g), (match) => match[1].trim()),
  ...Array.from(message.matchAll(/<\/?[\w-]+\s*\/?>/g), (match) => match[0]),
])].sort();
const fingerprint = (forms) => createHash("sha256").update(JSON.stringify(forms)).digest("hex");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flatten(tree, prefix = "", messages = new Map()) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new Error(`Expected an object at ${prefix || "(root)"}`);
  for (const [part, value] of Object.entries(tree)) {
    if (!/^[\w-]+$/.test(part)) throw new Error(`Invalid key ${prefix}${part}`);
    const key = prefix + part;
    if (typeof value === "string" && value.trim()) messages.set(key, value);
    else flatten(value, `${key}.`, messages);
  }
  return messages;
}

export function validateTerminology(locale, catalog, glossary) {
  const terms = glossary?.locales?.[locale]?.terms ?? [];
  if (!Array.isArray(terms)) throw new Error(`Expected terminology rules for ${locale} to be an array`);

  const messages = flatten(catalog);
  const errors = [];
  for (const [key, message] of messages) {
    for (const term of terms) {
      if (!term || typeof term.concept !== "string" || typeof term.preferred !== "string" || !Array.isArray(term.avoid)) {
        throw new Error(`Invalid terminology rule for ${locale}`);
      }
      if (term.keyIncludes !== undefined && (!Array.isArray(term.keyIncludes) || term.keyIncludes.some((part) => typeof part !== "string"))) {
        throw new Error(`Invalid key scope for ${locale}/${term.concept}`);
      }
      if (term.keyIncludes && !term.keyIncludes.some((part) => key.toLowerCase().includes(part.toLowerCase()))) {
        continue;
      }
      for (const avoided of term.avoid) {
        if (typeof avoided !== "string" || !avoided) throw new Error(`Invalid avoided term for ${locale}/${term.concept}`);
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(avoided)}(?=$|[^\\p{L}\\p{N}])`, "iu");
        if (pattern.test(message)) {
          errors.push(`${key}: use "${term.preferred}" instead of "${avoided}" for ${term.concept}`);
        }
      }
    }
  }
  return errors;
}

function buildManifest(english, locale) {
  const source = flatten(english);
  const expected = new Map();
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  for (const [key, value] of source) {
    const base = key.replace(PLURAL, "");
    if (base !== key && source.has(`${base}_one`) && source.has(`${base}_other`)) {
      if (key !== `${base}_other`) continue;
      const englishForms = ["zero", "one", "two", "few", "many", "other"]
        .flatMap((category) => source.has(`${base}_${category}`) ? [[category, source.get(`${base}_${category}`)]] : []);
      const hash = fingerprint(englishForms.map(([, message]) => message));
      for (const category of categories) {
        expected.set(`${base}_${category}`, {
          placeholders: placeholders(source.get(`${base}_${category}`) ?? value),
          source: Object.fromEntries(englishForms),
          hash,
        });
      }
    } else {
      expected.set(key, { placeholders: placeholders(value), source: value, hash: fingerprint([value]) });
    }
  }
  return expected;
}

export function getTranslationInput(english, locale, catalog, fingerprints) {
  const { missing, stale } = validateCatalog(english, locale, catalog, fingerprints);
  const pending = new Set([...missing, ...stale]);
  return Object.fromEntries(
    Array.from(buildManifest(english, locale))
      .filter(([key]) => pending.has(key))
      .map(([key, { source, hash }]) => [key, { source, fingerprint: hash }])
  );
}

export function validateCatalog(english, locale, catalog, fingerprints = {}) {
  const expected = buildManifest(english, locale);
  const messages = flatten(catalog);
  const errors = [];
  const missing = [];
  const stale = [];
  for (const [key, message] of messages) {
    const entry = expected.get(key);
    if (!entry) {
      errors.push(`${key}: unknown key or invalid plural form`);
    } else if (JSON.stringify(placeholders(message)) !== JSON.stringify(entry.placeholders)) {
      errors.push(`${key}: expected placeholders ${entry.placeholders.join(", ") || "(none)"}`);
    }
  }
  if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) throw new Error("Expected an object of source fingerprints");
  for (const [key, hash] of Object.entries(fingerprints)) {
    if (!expected.has(key) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) errors.push(`${key}: invalid source fingerprint`);
  }
  for (const [key, { hash }] of expected) {
    if (!messages.has(key)) missing.push(key);
    else if (fingerprints[key] !== hash) stale.push(key);
  }
  return { errors, missing, stale };
}

function readCatalogFiles(app, directory) {
  const root = new URL(`../${app}/src/i18n/${directory}/`, import.meta.url);
  const files = existsSync(root) ? readdirSync(root) : [];
  const catalogs = new Map();
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const locale = file.slice(0, -".json".length);
    if (locale === "en" || !Object.hasOwn(LANGUAGE_NAMES, locale)) throw new Error(`Unsupported locale: ${file}`);
    catalogs.set(locale, JSON.parse(readFileSync(new URL(file, root), "utf8")));
  }
  return catalogs;
}

function main() {
  const [, , command, app, locale] = process.argv;
  if (command === "--fingerprints" || command === "--translation-input") {
    const english = app === "frontend" ? frontend : app === "companion" ? companion : null;
    if (!english || !locale || locale === "en" || !Object.hasOwn(LANGUAGE_NAMES, locale)) {
      console.error(`Usage: node scripts/validate-localization.mjs ${command} <frontend|companion> <locale>`);
      return 1;
    }
    try {
      const output =
        command === "--fingerprints"
          ? Object.fromEntries(Array.from(buildManifest(english, locale), ([key, entry]) => [key, entry.hash]))
          : getTranslationInput(
              english,
              locale,
              readCatalogFiles(app, "catalogs").get(locale) ?? readCatalogFiles(app, "drafts").get(locale) ?? {},
              readCatalogFiles(app, "fingerprints").get(locale)
            );
      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      console.error(`${app}/${locale}: ${error.message}`);
      return 1;
    }
    return 0;
  }
  const release = process.argv.includes("--release");
  const details = release || process.argv.includes("--details");
  const locales = Object.keys(LANGUAGE_NAMES).filter((locale) => locale !== "en");
  let failed = false;
  for (const [app, english] of Object.entries({ frontend, companion })) {
    try {
      const catalogs = readCatalogFiles(app, "catalogs");
      const drafts = readCatalogFiles(app, "drafts");
      const fingerprints = readCatalogFiles(app, "fingerprints");
      for (const locale of locales) {
        const label = `${app}/${locale}`;
        if (catalogs.has(locale) && drafts.has(locale)) throw new Error(`${label}: catalog exists in both catalogs and drafts`);
        const catalog = catalogs.get(locale) ?? drafts.get(locale) ?? {};
        const { errors, missing, stale } = validateCatalog(english, locale, catalog, fingerprints.get(locale));
        const terminologyErrors = validateTerminology(locale, catalog, terminology);
        for (const error of errors) console.error(`${label}/${error}`);
        for (const error of terminologyErrors) console.error(`${label}/${error}`);
        if (missing.length || stale.length) {
          console.log(`${label}: ${missing.length} missing, ${stale.length} stale or without source fingerprints`);
          if (details) {
            for (const key of missing) console.log(`${label}/${key}: missing`);
            for (const key of stale) console.log(`${label}/${key}: stale or without a source fingerprint`);
          }
        }
        failed ||= errors.length > 0 || terminologyErrors.length > 0 || (release && (missing.length > 0 || stale.length > 0 || !catalogs.has(locale) || !SHIPPING_LANGUAGES.includes(locale)));
      }
    } catch (error) {
      console.error(`${app}: ${error.message}`);
      failed = true;
    }
  }
  if (release && failed) console.error("Release requires complete, current catalogs for all requested languages in both apps.");
  return Number(failed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
