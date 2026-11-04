import { afterEach, describe, expect, it } from "vitest";
import {
  applyCompanionLocalization,
  getCurrentRegionalLocale,
  LOCALE_STORAGE_KEY,
  REGIONAL_LOCALE_STORAGE_KEY,
  setLocale,
  translate,
} from "../index";

describe("companion i18n", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("switches representative companion strings when the locale changes", async () => {
    expect(translate("pairing.title")).toBe("Confirm this browser origin");
    expect(translate("pairing.eyebrow")).toBe("Approve Browser Origin");
    expect(translate("preferences.sections.pairedBrowsers")).toBe("Trusted Browser Origins");
    expect(translate("doneEditing.buttons.doneUpload")).toBe("✓ Done Editing — Hold to Upload");
    expect(translate("doneEditing.buttons.retryUpload")).toBe("✓ Done Editing — Hold to Retry Upload");
    expect(translate("recovery.actions.retryUpload")).toBe("Retry Upload");
    expect(translate("appPicker.title", { extension: "docx" })).toBe("Choose an app to open this .docx file");
    expect(translate("preferences.title")).toBe("Preferences");

    await setLocale("en-XA");

    expect(translate("pairing.title")).toBe("[Ćóńƒíŕḿ ťħíš ƀŕóŵšéŕ óŕíğíń]");
    expect(translate("pairing.eyebrow")).toBe("[Åṕṕŕóṽé Ɓŕóŵšéŕ Óŕíğíń]");
    expect(translate("preferences.sections.pairedBrowsers")).toBe("[Ťŕúšťéď Ɓŕóŵšéŕ Óŕíğíńš]");
    expect(translate("doneEditing.buttons.doneUpload")).toBe("[✓ Ďóńé Éďíťíńğ — Ħóĺď ťó Úṕĺóåď]");
    expect(translate("doneEditing.buttons.retryUpload")).toBe("[✓ Ďóńé Éďíťíńğ — Ħóĺď ťó Ŕéťŕý Úṕĺóåď]");
    expect(translate("recovery.actions.retryUpload")).toBe("[Ŕéťŕý Úṕĺóåď]");
    expect(translate("appPicker.title", { extension: "docx" })).toBe("[Ćħóóšé åń åṕṕ ťó óṕéń ťħíš .docx ƒíĺé]");
    expect(translate("preferences.title")).toBe("[Ṕŕéƒéŕéńćéš]");
    expect(document.documentElement.lang).toBe("en-XA");
    expect(document.documentElement.dir).toBe("ltr");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-XA");
  });

  it("applies browser-synced localization and mirrors the regional locale", async () => {
    await applyCompanionLocalization({
      language: "en-XA",
      regional_locale: "en-GB",
      updated_at: "2026-03-22T12:00:00.000Z",
      source_origin: "https://sambee.example.test",
    });

    expect(translate("preferences.title")).toBe("[Ṕŕéƒéŕéńćéš]");
    expect(getCurrentRegionalLocale()).toBe("en-GB");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en-XA");
    expect(window.localStorage.getItem(REGIONAL_LOCALE_STORAGE_KEY)).toBe("en-GB");
  });

  it("resolves browser preferences using the Companion operating-system webview locale", async () => {
    await applyCompanionLocalization({
      language: "browser",
      regional_locale: "browser",
      updated_at: "2026-11-04T00:00:00Z",
      source_origin: "https://sambee.example",
    });
    expect(getCurrentRegionalLocale()).toBe(Intl.getCanonicalLocales(navigator.language)[0]);
    expect(window.localStorage.getItem(REGIONAL_LOCALE_STORAGE_KEY)).not.toBe("browser");
  });
});
