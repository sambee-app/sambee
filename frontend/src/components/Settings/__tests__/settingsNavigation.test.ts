import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../../../i18n";
import {
  getSettingsCategoryByPath,
  getSettingsCategoryLabel,
  getSettingsNavItemByPath,
  getSettingsNavItemLabel,
  getSettingsViewTitle,
  getVisibleSettingsNavItems,
  getVisibleSettingsSections,
} from "../settingsNavigation";

describe("settingsNavigation", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("returns the consolidated settings sections for regular users", () => {
    expect(getVisibleSettingsSections(false)).toEqual([
      {
        section: "personal",
        label: "Personal",
        categories: ["appearance", "account", "file-browser", "text-editor", "connections", "local-drives"],
      },
    ]);
  });

  it("returns the consolidated settings sections for admins", () => {
    expect(getVisibleSettingsSections(true)).toEqual([
      {
        section: "personal",
        label: "Personal",
        categories: ["appearance", "account", "file-browser", "text-editor", "connections", "local-drives"],
      },
      {
        section: "administration",
        label: "Administration",
        categories: [
          "admin-network",
          "admin-authentication",
          "admin-users",
          "admin-smb",
          "admin-file-search",
          "admin-directory-search",
          "admin-system",
          "admin-about",
        ],
      },
    ]);
  });

  it("maps current settings routes to their categories", () => {
    expect(getSettingsCategoryByPath("/settings/appearance")).toBe("appearance");
    expect(getSettingsCategoryByPath("/settings/account")).toBe("account");
    expect(getSettingsCategoryByPath("/settings/file-browser")).toBe("file-browser");
    expect(getSettingsCategoryByPath("/settings/text-editor")).toBe("text-editor");
    expect(getSettingsCategoryByPath("/settings/connections")).toBe("connections");
    expect(getSettingsCategoryByPath("/settings/connections/smb")).toBe("connections");
    expect(getSettingsCategoryByPath("/settings/connections/local-drives")).toBe("local-drives");
    expect(getSettingsCategoryByPath("/settings/admin/network")).toBe("admin-network");
    expect(getSettingsCategoryByPath("/settings/admin/users")).toBe("admin-users");
    expect(getSettingsCategoryByPath("/settings/admin/smb")).toBe("admin-smb");
    expect(getSettingsCategoryByPath("/settings/admin/file-search")).toBe("admin-file-search");
    expect(getSettingsCategoryByPath("/settings/admin/directory-search")).toBe("admin-directory-search");
    expect(getSettingsCategoryByPath("/settings/admin/system")).toBe("admin-system");
  });

  it("maps nested settings routes to the correct nav items", () => {
    expect(getSettingsNavItemByPath("/settings/appearance")).toBe("appearance");
    expect(getSettingsNavItemByPath("/settings/account")).toBe("account");
    expect(getSettingsNavItemByPath("/settings/file-browser")).toBe("file-browser");
    expect(getSettingsNavItemByPath("/settings/text-editor")).toBe("text-editor");
    expect(getSettingsNavItemByPath("/settings/connections")).toBe("connections");
    expect(getSettingsNavItemByPath("/settings/connections/local-drives")).toBe("local-drives");
  });

  it("returns visible settings nav items as a flat list", () => {
    expect(getVisibleSettingsNavItems(false)).toEqual([
      "appearance",
      "account",
      "file-browser",
      "text-editor",
      "connections",
      "local-drives",
    ]);
  });

  it("does not resolve retired legacy settings routes", () => {
    expect(getSettingsCategoryByPath("/settings/preferences")).toBeNull();
    expect(getSettingsCategoryByPath("/settings/browser")).toBeNull();
    expect(getSettingsCategoryByPath("/settings/smb-connections")).toBeNull();
    expect(getSettingsCategoryByPath("/settings/local-drives")).toBeNull();
    expect(getSettingsCategoryByPath("/settings/admin/advanced")).toBeNull();
  });

  it("returns translated labels when the locale changes", async () => {
    expect(getSettingsCategoryLabel("appearance")).toBe("Appearance");
    expect(getSettingsCategoryLabel("account")).toBe("Account");
    expect(getSettingsCategoryLabel("file-browser")).toBe("File Browser");
    expect(getSettingsCategoryLabel("text-editor")).toBe("Text Editor");
    expect(getSettingsCategoryLabel("admin-file-search")).toBe("File Search");
    expect(getSettingsCategoryLabel("admin-directory-search")).toBe("Directory Search");
    expect(getSettingsNavItemLabel("local-drives")).toBe("Local Drives");
    expect(getSettingsViewTitle("main")).toBe("Settings");

    await setLocale("en-XA");

    expect(getSettingsCategoryLabel("appearance")).not.toBe("Appearance");
    expect(getSettingsCategoryLabel("appearance")).toMatch(/^\[.*\]$/);
    expect(getSettingsCategoryLabel("file-browser")).not.toBe("File Browser");
    expect(getSettingsCategoryLabel("file-browser")).toMatch(/^\[.*\]$/);
    expect(getSettingsCategoryLabel("text-editor")).not.toBe("Text Editor");
    expect(getSettingsCategoryLabel("text-editor")).toMatch(/^\[.*\]$/);
    expect(getSettingsCategoryLabel("admin-file-search")).not.toBe("File Search");
    expect(getSettingsCategoryLabel("admin-file-search")).toMatch(/^\[.*\]$/);
    expect(getSettingsCategoryLabel("admin-directory-search")).toMatch(/^\[.*\]$/);
    expect(getSettingsNavItemLabel("local-drives")).not.toBe("Local Drives");
    expect(getSettingsNavItemLabel("local-drives")).toMatch(/^\[.*\]$/);
    expect(getSettingsViewTitle("main")).toBe("[Šéťťíńğš]");
  });
});
