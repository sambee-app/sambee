import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredTheme } from "../../services/api";
import api from "../../services/api";
import { render } from "../../test/utils/test-utils";
import { builtInThemes } from "../../theme/themes";
import { AppearanceSettings } from "../PreferencesSettings";

const { setLanguagePreferenceMock, setRegionalLocalePreferenceMock, themeCommitMock, themeContextState, settingStates } = vi.hoisted(
  () => ({
    setLanguagePreferenceMock: vi.fn(),
    setRegionalLocalePreferenceMock: vi.fn(),
    themeCommitMock: vi.fn(),
    themeContextState: { isAdmin: false, currentThemeId: "sambee-light", storedThemes: [] as StoredTheme[], refreshThemes: vi.fn() },
    settingStates: {
      language: { error: null as string | null, pending: false, saved: false },
      regionalLocale: { error: null as string | null, pending: false, saved: false },
      theme: { error: null as string | null, pending: false, saved: false },
    },
  })
);

vi.mock("../../theme", () => ({
  useSambeeTheme: () => ({
    isAdmin: themeContextState.isAdmin,
    siteDefaultId: "sambee-light",
    refreshThemes: themeContextState.refreshThemes,
    storedThemes: themeContextState.storedThemes,
    currentTheme: {
      id: themeContextState.currentThemeId,
      name: "Sambee light",
      primary: { main: "#1976d2" },
      background: { default: "#ffffff" },
      text: { primary: "#111111" },
    },
    availableThemes: [
      builtInThemes[0]!,
      builtInThemes[1]!,
      ...themeContextState.storedThemes.map((entry) => ({ ...entry.definition, id: entry.id })),
    ],
  }),
}));

vi.mock("../../i18n/LocalePreferencesProvider", () => ({
  LocalePreferencesProvider: ({ children }: { children: React.ReactNode }) => children,
  useLocalePreferences: () => ({
    languagePreference: "browser",
    regionalLocale: "en-US",
    regionalLocalePreference: "browser",
    setLanguagePreference: setLanguagePreferenceMock,
    setRegionalLocalePreference: setRegionalLocalePreferenceMock,
  }),
}));

vi.mock("../../services/userSettingsStore", () => ({
  useCurrentUserSetting: (field: string) => {
    const state =
      field === "localization.language"
        ? settingStates.language
        : field === "localization.regional_locale"
          ? settingStates.regionalLocale
          : settingStates.theme;
    return {
      confirmedValue: "sambee-light",
      ...state,
      commit: themeCommitMock,
      clearError: vi.fn(),
    };
  },
}));

describe("AppearanceSettings", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    themeContextState.isAdmin = false;
    themeContextState.currentThemeId = "sambee-light";
    themeContextState.storedThemes = [];
    themeContextState.refreshThemes.mockResolvedValue(undefined);
    themeCommitMock.mockResolvedValue(undefined);
    setLanguagePreferenceMock.mockResolvedValue(undefined);
    setRegionalLocalePreferenceMock.mockResolvedValue(undefined);
    for (const state of Object.values(settingStates)) {
      state.error = null;
      state.pending = false;
      state.saved = false;
    }
  });

  it("renders independent localization controls and no routine Save action", () => {
    render(<AppearanceSettings />);

    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Regional settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("persists a selected language immediately", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("combobox", { name: "Language" }));
    await user.click(await screen.findByRole("option", { name: "Pseudo-English (for localization testing)" }));

    await waitFor(() => expect(setLanguagePreferenceMock).toHaveBeenCalledWith("en-XA"));
  });

  it("persists a selected regional locale immediately", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("combobox", { name: "Regional settings" }));
    await user.click(await screen.findByRole("option", { name: "German (Germany)" }));

    await waitFor(() => expect(setRegionalLocalePreferenceMock).toHaveBeenCalledWith("de-DE"));
  });

  it("persists a selected theme as its own field update", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    expect(screen.getByText("Default", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Site default" })).not.toBeInTheDocument();
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Sambee dark" }));

    await waitFor(() => expect(themeCommitMock).toHaveBeenCalledWith("sambee-dark"));
    expect(screen.getByText("Default", { exact: true })).toBeInTheDocument();
  });

  it("lets users explicitly select the currently inherited theme", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("radio", { name: "Sambee light" }));

    await waitFor(() => expect(themeCommitMock).toHaveBeenCalledWith("sambee-light"));
  });

  it("copies a built-in theme into Your themes without changing the applied selection", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createTheme")
      .mockResolvedValue({ id: "new-id", scope: "user", version: 1, definition: builtInThemes[0]! });
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Sambee light (copy)" }), "user"));
    expect(themeCommitMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Sambee light" })).toBeChecked();
  });

  it("numbers a built-in copy when its personal copy names already exist", async () => {
    const user = userEvent.setup();
    themeContextState.storedThemes = [
      { id: "copy-1", scope: "user", version: 1, definition: { ...builtInThemes[0]!, name: "Sambee light (copy)" } },
      { id: "copy-2", scope: "user", version: 1, definition: { ...builtInThemes[0]!, name: "Sambee light (copy 2)" } },
    ];
    const create = vi
      .spyOn(api, "createTheme")
      .mockResolvedValue({ id: "copy-3", scope: "user", version: 1, definition: builtInThemes[0]! });
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Sambee light (copy 3)" }), "user"));
  });

  it("numbers a site copy only against names in Site themes", async () => {
    const user = userEvent.setup();
    themeContextState.isAdmin = true;
    themeContextState.currentThemeId = "site-original";
    themeContextState.storedThemes = [
      { id: "site-original", scope: "site", version: 1, definition: { ...builtInThemes[0]!, name: "Shared" } },
      { id: "site-copy", scope: "site", version: 1, definition: { ...builtInThemes[0]!, name: "Shared (copy)" } },
      { id: "user-copy", scope: "user", version: 1, definition: { ...builtInThemes[0]!, name: "Shared (copy 2)" } },
    ];
    const create = vi
      .spyOn(api, "createTheme")
      .mockResolvedValue({ id: "site-copy-2", scope: "site", version: 1, definition: builtInThemes[0]! });
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Shared (copy 2)" }), "site"));
  });

  it("does not apply a copy saved from the theme editor", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createTheme")
      .mockResolvedValue({ id: "new-id", scope: "user", version: 1, definition: builtInThemes[0]! });
    render(<AppearanceSettings />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save copy" }));
    await user.click(screen.getByRole("menuitem", { name: "Your themes" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    await waitFor(() => expect(themeContextState.refreshThemes).toHaveBeenCalledOnce());
    expect(themeCommitMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Sambee light" })).toBeChecked();
  });

  it("selects a theme when its card is clicked", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    await user.click(screen.getByText("Sambee dark"));

    await waitFor(() => expect(themeCommitMock).toHaveBeenCalledWith("sambee-dark"));
  });

  it("allows an administrator to set a built-in theme as the site default", async () => {
    const user = userEvent.setup();
    themeContextState.isAdmin = true;
    themeContextState.currentThemeId = "sambee-dark";
    const setDefault = vi.spyOn(api, "setSiteDefaultTheme").mockResolvedValue({ themes: [], site_default_id: "sambee-dark" });
    render(<AppearanceSettings />);

    act(() => screen.getByRole("radio", { name: "Sambee light" }).focus());
    expect(screen.getByRole("radio", { name: "Sambee dark" })).toBeChecked();
    expect(themeCommitMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Set as default" }));

    await waitFor(() => expect(setDefault).toHaveBeenCalledWith("sambee-dark"));
  });

  it("keeps actions on the selected theme when focus moves to another radio", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createTheme")
      .mockResolvedValue({ id: "new-id", scope: "user", version: 1, definition: builtInThemes[0]! });
    render(<AppearanceSettings />);

    act(() => screen.getByRole("radio", { name: "Sambee dark" }).focus());

    expect(screen.queryByRole("button", { name: "Target Sambee dark for actions" })).not.toBeInTheDocument();
    expect(themeCommitMock).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Sambee light" })).toBeChecked();
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Sambee light (copy)" }), "user"));
  });

  it("refreshes a stale theme after a delete conflict without retrying the old version", async () => {
    const user = userEvent.setup();
    const stored = { id: "custom", scope: "user" as const, version: 1, definition: { ...builtInThemes[0]!, name: "Custom" } };
    themeContextState.storedThemes = [stored];
    themeContextState.currentThemeId = "custom";
    const remove = vi.spyOn(api, "deleteTheme").mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { detail: "Theme changed in another tab. Refresh and try again" } },
    });
    render(<AppearanceSettings />);

    act(() => screen.getByRole("radio", { name: "Sambee dark" }).focus());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete theme?" })).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(themeContextState.refreshThemes).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(stored);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete theme?" })).not.toBeInTheDocument());
    expect(screen.getByText("Theme changed in another tab. Refresh and try again")).toBeInTheDocument();
  });

  it.each([
    ["Space", " "],
    ["Enter", "{Enter}"],
  ])("persists a focused theme when activated with %s", async (_keyName, key) => {
    const user = userEvent.setup();
    render(<AppearanceSettings />);

    screen.getByRole("radio", { name: "Sambee dark" }).focus();
    await user.keyboard(key);

    await waitFor(() => expect(themeCommitMock).toHaveBeenCalledWith("sambee-dark"));
  });

  it("keeps the requested theme selected while its update is pending", async () => {
    const user = userEvent.setup();
    themeCommitMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
    render(<AppearanceSettings />);

    screen.getByRole("radio", { name: "Sambee dark" }).focus();
    await user.keyboard(" ");

    await waitFor(() => expect(themeCommitMock).toHaveBeenCalledWith("sambee-dark"));
    expect(screen.getByRole("radio", { name: "Sambee dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Sambee dark" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Sambee light" })).not.toBeChecked();
    expect(screen.getByRole("status", { name: "Saving setting" })).toBeInTheDocument();
    await user.click(screen.getByText("Sambee light"));
    expect(themeCommitMock).toHaveBeenCalledTimes(1);
  });

  it("restores theme radio focus after its save completes", async () => {
    const user = userEvent.setup();
    let resolveThemeUpdate: (() => void) | undefined;
    themeCommitMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveThemeUpdate = resolve;
        })
    );
    render(<AppearanceSettings />);

    const darkTheme = screen.getByRole("radio", { name: "Sambee dark" });
    darkTheme.focus();
    await user.keyboard(" ");

    await waitFor(() => expect(darkTheme).toBeDisabled());
    darkTheme.blur();
    resolveThemeUpdate?.();

    await waitFor(() => expect(darkTheme).toHaveFocus());
  });

  it("renders saved and failed theme feedback", () => {
    settingStates.theme.saved = true;
    const { rerender } = render(<AppearanceSettings />);

    expect(screen.getByRole("status", { name: "Setting saved" })).toBeInTheDocument();

    settingStates.theme.saved = false;
    settingStates.theme.error = "Unable to save theme.";
    rerender(<AppearanceSettings />);
    expect(screen.getByText("Unable to save theme.")).toBeInTheDocument();
  });

  it("renders localized select saving, saved, and error feedback", () => {
    settingStates.language.pending = true;
    const { rerender } = render(<AppearanceSettings />);

    expect(screen.getByRole("combobox", { name: "Language" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status", { name: "Saving setting" })).toBeInTheDocument();

    settingStates.language.pending = false;
    settingStates.language.saved = true;
    rerender(<AppearanceSettings />);
    expect(screen.getByRole("status", { name: "Setting saved" })).toBeInTheDocument();

    settingStates.language.saved = false;
    settingStates.regionalLocale.error = "Could not save regional settings.";
    rerender(<AppearanceSettings />);
    expect(screen.getByText("Could not save regional settings.")).toBeInTheDocument();
  });
});
