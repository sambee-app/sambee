import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../i18n";
import type { UserPreferences } from "../../stores/userPreferences";
import { Preferences } from "../Preferences";

const {
  invokeMock,
  listenMock,
  isAutostartEnabledMock,
  enableAutostartMock,
  disableAutostartMock,
  getUserPreferencesMock,
  saveUserPreferencesMock,
  fetchCompanionUpdateStatusMock,
  installCompanionUpdateMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  isAutostartEnabledMock: vi.fn(),
  enableAutostartMock: vi.fn(),
  disableAutostartMock: vi.fn(),
  getUserPreferencesMock: vi.fn(),
  saveUserPreferencesMock: vi.fn(),
  fetchCompanionUpdateStatusMock: vi.fn(),
  installCompanionUpdateMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: isAutostartEnabledMock,
  enable: enableAutostartMock,
  disable: disableAutostartMock,
}));

vi.mock("../../stores/userPreferences", () => ({
  getUserPreferences: getUserPreferencesMock,
  saveUserPreferences: saveUserPreferencesMock,
}));

vi.mock("../../lib/updateCheck", () => ({
  fetchCompanionUpdateStatus: fetchCompanionUpdateStatusMock,
  installCompanionUpdate: installCompanionUpdateMock,
}));

describe("Preferences", () => {
  it("shows settings authority without a separate policy reset action", async () => {
    getUserPreferencesMock.mockResolvedValue({
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    });
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_paired_origins") return [];
      if (command === "get_synced_localization") return null;
      if (command === "get_native_directory_policy_status")
        return {
          status: "synchronized",
          authoritative_origin: "https://owner.example",
          results: { localization: "defaults_active" },
          sections: { directory_index: { marker: "3" } },
          message: null,
        };
    });
    render(<Preferences onClose={vi.fn()} />);
    expect((await screen.findAllByText("https://owner.example")).length).toBeGreaterThan(0);
    expect(await screen.findByText(translate("preferences.localizationStatus.waitingBadge"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset Policy Owner" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("reset_native_directory_policy_owner");
  });

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    isAutostartEnabledMock.mockReset();
    enableAutostartMock.mockReset();
    disableAutostartMock.mockReset();
    getUserPreferencesMock.mockReset();
    saveUserPreferencesMock.mockReset();
    fetchCompanionUpdateStatusMock.mockReset();
    installCompanionUpdateMock.mockReset();
    listenMock.mockResolvedValue(vi.fn());
  });

  afterEach(async () => {
    cleanup();
    await setLocale("en");
  });

  it("renders translated preferences sections and unpair confirmation", async () => {
    await setLocale("en-XA");

    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve(["https://example.test"]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve({
          language: "en-XA",
          regional_locale: "en-GB",
          updated_at: "2026-03-22T12:00:00.000Z",
          source_origin: "https://example.test",
        });
      }
      if (command === "get_native_directory_policy_status") {
        return Promise.resolve({
          status: "synchronized",
          authoritative_origin: "https://example.test",
          results: { localization: "synchronized" },
          sections: { localization: { result: "synchronized", origin: "https://example.test" } },
          message: null,
        });
      }

      return Promise.resolve(undefined);
    });
    isAutostartEnabledMock.mockResolvedValue(false);

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: translate("preferences.title") })).toBeInTheDocument();
    });

    expect(screen.getByText(translate("preferences.sections.pairedBrowsers"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.sections.localization"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.localizationStatus.syncedBadge"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.localizationStatus.appliedFromLabel"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.sections.editingBehavior"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.sections.startup"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.sections.updates"))).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.sections.notifications"))).toBeInTheDocument();
    expect(screen.getByText("en-XA")).toBeInTheDocument();
    expect(screen.getByText("en-GB")).toBeInTheDocument();
    expect(screen.getAllByText("https://example.test")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: translate("preferences.unpairButton") }));

    expect(await screen.findByRole("heading", { name: translate("preferences.confirmUnpair.title") })).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.confirmUnpair.body", { origin: "https://example.test" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: translate("common.actions.cancel") })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: translate("preferences.unpairButton") }).length).toBeGreaterThan(0);
  });

  it("shows translated pending text while unpairing", async () => {
    await setLocale("en-XA");

    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    let resolveUnpair: () => void = () => {};

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve(["https://example.test"]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve(null);
      }

      if (command === "unpair_origin") {
        return new Promise<void>((resolve) => {
          resolveUnpair = resolve;
        });
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: translate("preferences.title") })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: translate("preferences.unpairButton") }));

    const unpairButtons = await screen.findAllByRole("button", { name: translate("preferences.unpairButton") });
    fireEvent.click(unpairButtons[unpairButtons.length - 1]!);

    expect(await screen.findAllByText(translate("preferences.confirmUnpair.unpairing"))).toHaveLength(2);

    resolveUnpair();
  });

  it("shows an empty localization state when no browser sync has happened yet", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve([]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve(null);
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    });

    expect(screen.getByText("No browser localization has been synchronized yet.")).toBeInTheDocument();
    expect(screen.getByText(translate("preferences.localizationStatus.noneBadge"))).toBeInTheDocument();
  });

  it("shows a localization failure before any localization has been applied", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") return Promise.resolve([]);
      if (command === "get_synced_localization") return Promise.resolve(null);
      if (command === "get_native_directory_policy_status") {
        return Promise.resolve({
          status: "delivery_failed",
          authoritative_origin: "https://example.test",
          results: { localization: "delivery_failed" },
          sections: {},
          message: "Localization delivery failed.",
        });
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);

    expect(await screen.findByText(translate("preferences.localizationStatus.failedBadge"))).toBeInTheDocument();
    expect(await screen.findByText("Localization delivery failed.")).toBeInTheDocument();
  });

  it("refreshes settings authority when the native status event fires", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };
    let authority = "https://first.example";
    let statusChangedListener: ((event: { event: string; id: number; payload: null }) => void) | undefined;

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    listenMock.mockImplementation((_event, listener) => {
      statusChangedListener = listener;
      return Promise.resolve(vi.fn());
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") return Promise.resolve(["https://first.example", "https://second.example"]);
      if (command === "get_synced_localization") return Promise.resolve(null);
      if (command === "get_native_directory_policy_status") {
        return Promise.resolve({
          status: "synchronized",
          authoritative_origin: authority,
          results: { localization: "defaults_active" },
          sections: {},
          message: null,
        });
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);
    expect((await screen.findAllByText("https://first.example")).length).toBeGreaterThan(0);

    authority = "https://second.example";
    await act(async () => {
      statusChangedListener?.({ event: "settings-status-changed", id: 1, payload: null });
    });

    await waitFor(() => {
      expect(screen.getAllByText("https://second.example").length).toBeGreaterThan(0);
      expect(screen.getByText(translate("preferences.settingsSource.managesSettings"))).toBeInTheDocument();
    });
  });

  it("reloads paired origins and authority after unpairing", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };
    let unpaired = false;
    let pairedOriginReads = 0;
    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        pairedOriginReads += 1;
        return Promise.resolve(unpaired ? ["https://first.example"] : ["https://first.example", "https://second.example"]);
      }
      if (command === "get_synced_localization") return Promise.resolve(null);
      if (command === "get_native_directory_policy_status") {
        return Promise.resolve({
          status: "synchronized",
          authoritative_origin: unpaired ? "https://first.example" : "https://second.example",
          results: { localization: "defaults_active" },
          sections: {},
          message: null,
        });
      }
      if (command === "unpair_origin") {
        unpaired = true;
        return Promise.resolve(undefined);
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);
    await screen.findAllByText("https://second.example");
    fireEvent.click(screen.getAllByRole("button", { name: translate("preferences.unpairButton") })[1]!);
    await screen.findByRole("heading", { name: translate("preferences.confirmUnpair.title") });
    const unpairButtons = await screen.findAllByRole("button", { name: translate("preferences.unpairButton") });
    fireEvent.click(unpairButtons[unpairButtons.length - 1]!);

    await waitFor(() => {
      expect(screen.getAllByText("https://first.example").length).toBeGreaterThan(0);
      expect(screen.queryByText("https://second.example")).not.toBeInTheDocument();
    });
    expect(pairedOriginReads).toBeGreaterThan(1);
  });

  it("requires confirmation before switching away from stable update channel", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve([]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve(null);
      }

      return Promise.resolve(undefined);
    });

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Update channel"), {
      target: { value: "beta" },
    });

    expect(await screen.findByRole("heading", { name: "Switch update channel?" })).toBeInTheDocument();
    expect(saveUserPreferencesMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Switch channel" }));

    await waitFor(() => {
      expect(saveUserPreferencesMock).toHaveBeenCalledWith({
        ...prefs,
        companionUpdateChannel: "beta",
      });
    });
  });

  it("shows manual update status when the companion is already up to date", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "stable",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve([]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve(null);
      }

      return Promise.resolve(undefined);
    });
    fetchCompanionUpdateStatusMock.mockResolvedValue({
      available: false,
      currentVersion: "0.5.0",
      version: null,
      notes: null,
      publishedAt: null,
    });

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("You are up to date on the Stable channel.")).toBeInTheDocument();
    expect(screen.getByText(/^Last checked:/)).toBeInTheDocument();
    expect(screen.getByText("0.5.0")).toBeInTheDocument();
  });

  it("does not show release descriptions and installs available updates on demand", async () => {
    const prefs: UserPreferences = {
      allowedServers: [],
      uploadConflictAction: "ask",
      autoStartOnLogin: false,
      showNotifications: true,
      companionUpdateChannel: "beta",
      tempFileRetentionDays: 7,
    };

    getUserPreferencesMock.mockResolvedValue(prefs);
    isAutostartEnabledMock.mockResolvedValue(false);
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_paired_origins") {
        return Promise.resolve([]);
      }

      if (command === "get_synced_localization") {
        return Promise.resolve(null);
      }

      return Promise.resolve(undefined);
    });
    fetchCompanionUpdateStatusMock.mockResolvedValue({
      available: true,
      currentVersion: "0.5.0",
      version: "0.6.0",
      notes: "Bug fixes and feed-based update checks.",
      publishedAt: "2026-03-27T12:34:56Z",
    });
    installCompanionUpdateMock.mockResolvedValue(undefined);

    render(<Preferences onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(await screen.findByText("Update 0.6.0 is available on the Beta channel.")).toBeInTheDocument();
    expect(screen.queryByText("Bug fixes and feed-based update checks.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install update" }));

    await waitFor(() => {
      expect(installCompanionUpdateMock).toHaveBeenCalledWith("beta");
    });

    expect(
      await screen.findByText("Update 0.6.0 has been installed. Restart the app if it does not relaunch automatically.")
    ).toBeInTheDocument();
  });
});
