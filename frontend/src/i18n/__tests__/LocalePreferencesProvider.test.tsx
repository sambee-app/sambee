import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n, { setLanguagePreference } from "../index";
import { LocalePreferencesProvider, useLocalePreferences } from "../LocalePreferencesProvider";

const settings = vi.hoisted(() => ({ language: "en", region: "browser" }));

vi.mock("../../services/userSettingsStore", () => ({
  useCurrentUserSetting: (field: string) => ({
    confirmedValue: field === "localization.language" ? settings.language : settings.region,
    commit: vi.fn(),
  }),
}));

function PreferenceDisplay() {
  const { languagePreference } = useLocalePreferences();
  return <div>{languagePreference}</div>;
}

describe("LocalePreferencesProvider", () => {
  afterEach(async () => {
    cleanup();
    await setLanguagePreference("en");
    vi.restoreAllMocks();
  });

  it("updates the selected preference in both directions when the resolved language stays the same", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US", "de-DE"]);
    await setLanguagePreference("en");
    settings.language = "en";
    const languageChanged = vi.fn();
    i18n.on("languageChanged", languageChanged);

    try {
      const { rerender } = render(
        <LocalePreferencesProvider>
          <PreferenceDisplay />
        </LocalePreferencesProvider>
      );
      expect(screen.getByText("en")).toBeInTheDocument();

      settings.language = "browser";
      rerender(
        <LocalePreferencesProvider>
          <PreferenceDisplay />
        </LocalePreferencesProvider>
      );
      await waitFor(() => expect(screen.getByText("browser")).toBeInTheDocument());

      settings.language = "en";
      rerender(
        <LocalePreferencesProvider>
          <PreferenceDisplay />
        </LocalePreferencesProvider>
      );
      await waitFor(() => expect(screen.getByText("en")).toBeInTheDocument());
      expect(languageChanged).not.toHaveBeenCalled();

      await act(() => setLanguagePreference("browser"));
      expect(screen.getByText("browser")).toBeInTheDocument();
    } finally {
      i18n.off("languageChanged", languageChanged);
    }
  });
});
