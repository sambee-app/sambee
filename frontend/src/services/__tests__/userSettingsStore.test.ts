import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAuthToken } from "../../test/fixtures/users";

const { getCurrentUserSettingsMock, updateCurrentUserSettingsMock } = vi.hoisted(() => ({
  getCurrentUserSettingsMock: vi.fn(),
  updateCurrentUserSettingsMock: vi.fn(),
}));

const { getUserSettingsChannel, getUserSettingsMessageHandler } = vi.hoisted(() => {
  let userSettingsMessageHandler: ((event: MessageEvent<{ type?: unknown }>) => void) | null = null;
  let userSettingsChannel: MockBroadcastChannel | null = null;

  class MockBroadcastChannel {
    addEventListener = vi.fn((eventName: string, listener: (event: MessageEvent<{ type?: unknown }>) => void) => {
      if (eventName === "message") userSettingsMessageHandler = listener;
    });
    postMessage = vi.fn();

    constructor(name: string) {
      if (name === "sambee-user-settings") userSettingsChannel = this;
    }
  }

  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  return {
    getUserSettingsChannel: () => userSettingsChannel,
    getUserSettingsMessageHandler: () => userSettingsMessageHandler,
  };
});

vi.mock("../api", () => ({
  default: {
    getCurrentUserSettings: getCurrentUserSettingsMock,
    updateCurrentUserSettings: updateCurrentUserSettingsMock,
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
  },
}));

import { SambeeThemeProvider, useSambeeTheme } from "../../theme/ThemeContext";
import { authSession } from "../authSession";
import {
  CURRENT_USER_SETTING_PERSIST_TIMEOUT_MS,
  refreshCurrentUserSettings,
  SETTING_SUCCESS_DISPLAY_MS,
  useCurrentUserSetting,
  userSettingsStore,
} from "../userSettingsStore";

const settings = {
  appearance: { theme_id: "sambee-light", has_theme_override: true, custom_themes: [] },
  localization: { language: "browser" as const, regional_locale: "browser" as const },
  browser: {
    quick_nav_include_dot_directories: false,
    quick_bar_shortcut_hint_visibility: "auto" as const,
    touch_friendly_file_selection: "auto" as const,
    file_browser_view_mode: "list" as const,
    pane_mode: "single" as const,
    selected_connection_id: null,
    viewer_associations: {},
  },
  text_editor: { max_file_size_bytes: 52_428_800, word_wrap_enabled: null },
};

async function authenticateAndLoad() {
  getCurrentUserSettingsMock.mockResolvedValue(settings);
  authSession.setAuthenticated(createMockAuthToken({ access_token: "token", token_type: "bearer", user_id: "user-1" }), false);
  await refreshCurrentUserSettings();
  await refreshCurrentUserSettings();
}

function themeProviderWrapper({ children }: { children: ReactNode }) {
  return createElement(SambeeThemeProvider, null, children);
}

describe("userSettingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSession.clear();
    userSettingsStore.resetForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits a canonical field response and broadcasts an invalidation", async () => {
    await authenticateAndLoad();
    const result = { field: "appearance.theme_id", value: "sambee-dark" } as const;
    updateCurrentUserSettingsMock.mockResolvedValue(result);

    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");

    expect(updateCurrentUserSettingsMock).toHaveBeenCalledWith(result, { signal: expect.any(AbortSignal) });
    expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-dark");
    expect(getUserSettingsChannel()?.postMessage).toHaveBeenCalledWith({ type: "invalidate" });
  });

  it("keeps a canonical field response when the initial settings snapshot is unavailable", async () => {
    authSession.setAuthenticated(createMockAuthToken({ access_token: "token", token_type: "bearer", user_id: "user-1" }), false);
    const result = { field: "appearance.theme_id", value: "sambee-dark" } as const;
    updateCurrentUserSettingsMock.mockResolvedValue(result);

    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");

    expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-dark");
  });

  it("does not save a confirmed scalar or nested record again", async () => {
    await authenticateAndLoad();
    await vi.waitFor(() => {
      expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-light");
      expect(userSettingsStore.getValue("browser.viewer_associations").confirmedValue).toEqual({});
    });

    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-light");
    await userSettingsStore.getValue("browser.viewer_associations").commit({});

    expect(updateCurrentUserSettingsMock).not.toHaveBeenCalled();
  });

  it("persists an explicit selection of the inherited theme only once", async () => {
    getCurrentUserSettingsMock.mockResolvedValue({
      ...settings,
      appearance: { ...settings.appearance, has_theme_override: false },
    });
    authSession.setAuthenticated(createMockAuthToken({ access_token: "token", token_type: "bearer", user_id: "user-1" }), false);
    await refreshCurrentUserSettings();
    await refreshCurrentUserSettings();
    updateCurrentUserSettingsMock.mockResolvedValue({ field: "appearance.theme_id", value: "sambee-light" });

    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-light");
    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-light");

    expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(1);
  });

  it("writes a structurally changed compound setting", async () => {
    await authenticateAndLoad();
    const update = { field: "browser.viewer_associations", value: { ".pdf": "browser" } } as const;
    updateCurrentUserSettingsMock.mockResolvedValue(update);

    await userSettingsStore.getValue("browser.viewer_associations").commit(update.value);

    expect(updateCurrentUserSettingsMock).toHaveBeenCalledWith(update, { signal: expect.any(AbortSignal) });
  });

  it("updates the touch-friendly file-selection field in the shared snapshot", async () => {
    await authenticateAndLoad();
    const update = { field: "browser.touch_friendly_file_selection", value: "always" } as const;
    updateCurrentUserSettingsMock.mockResolvedValue(update);

    await userSettingsStore.getValue("browser.touch_friendly_file_selection").commit("always");

    expect(updateCurrentUserSettingsMock).toHaveBeenCalledWith(update, { signal: expect.any(AbortSignal) });
    expect(userSettingsStore.getValue("browser.touch_friendly_file_selection").confirmedValue).toBe("always");
  });

  it("shows saved feedback briefly after a successful write", async () => {
    vi.useFakeTimers();
    await authenticateAndLoad();
    updateCurrentUserSettingsMock.mockResolvedValue({ field: "appearance.theme_id", value: "sambee-dark" });
    const { result } = renderHook(() => useCurrentUserSetting("appearance.theme_id"));

    await act(async () => {
      await result.current.commit("sambee-dark");
    });

    expect(result.current.saved).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTING_SUCCESS_DISPLAY_MS);
    });
    expect(result.current.saved).toBe(false);
  });

  it("reports a timeout and clears pending when an update aborts", async () => {
    vi.useFakeTimers();
    await authenticateAndLoad();
    updateCurrentUserSettingsMock.mockImplementationOnce(
      (_update, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("canceled")));
        })
    );

    const commit = userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    const expectedTimeout = expect(commit).rejects.toThrow("Saving this setting timed out. Check the connection and try again.");
    await vi.advanceTimersByTimeAsync(CURRENT_USER_SETTING_PERSIST_TIMEOUT_MS);

    await expectedTimeout;
    expect(userSettingsStore.getValue("appearance.theme_id")).toMatchObject({ pending: false, saved: false });
    expect(userSettingsStore.getValue("appearance.theme_id").error).toBe(
      "Saving this setting timed out. Check the connection and try again."
    );
  });

  it("reactively exposes a successful committed value", async () => {
    await authenticateAndLoad();
    getCurrentUserSettingsMock.mockClear();
    let resolveRefresh: ((value: typeof settings) => void) | undefined;
    getCurrentUserSettingsMock.mockImplementationOnce(
      () =>
        new Promise<typeof settings>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    getCurrentUserSettingsMock.mockResolvedValue({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });
    updateCurrentUserSettingsMock.mockResolvedValue({ field: "appearance.theme_id", value: "sambee-dark" });
    const { result } = renderHook(() => useCurrentUserSetting("appearance.theme_id"));
    await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.commit("sambee-dark");
    });

    expect(result.current.confirmedValue).toBe("sambee-dark");
    await act(async () => {
      resolveRefresh?.({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });
    });
    await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(2));
  });

  it("updates the theme provider immediately after a successful theme commit", async () => {
    await authenticateAndLoad();
    getCurrentUserSettingsMock.mockClear();
    let resolveRefresh: ((value: typeof settings) => void) | undefined;
    getCurrentUserSettingsMock.mockImplementationOnce(
      () =>
        new Promise<typeof settings>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    getCurrentUserSettingsMock.mockResolvedValue({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });
    updateCurrentUserSettingsMock.mockResolvedValue({ field: "appearance.theme_id", value: "sambee-dark" });
    const { result } = renderHook(() => useSambeeTheme(), { wrapper: themeProviderWrapper });
    await act(async () => {
      await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    });

    await act(async () => {
      await userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    });

    expect(result.current.currentTheme.id).toBe("sambee-dark");
    await act(async () => {
      resolveRefresh?.({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });
    });
    await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(2));
  });

  it("does not let a stale refresh overwrite a successful field update", async () => {
    await authenticateAndLoad();
    getCurrentUserSettingsMock.mockClear();
    let resolveStaleRefresh: ((value: typeof settings) => void) | undefined;
    getCurrentUserSettingsMock.mockImplementationOnce(
      () =>
        new Promise<typeof settings>((resolve) => {
          resolveStaleRefresh = resolve;
        })
    );
    getCurrentUserSettingsMock.mockResolvedValueOnce({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });
    updateCurrentUserSettingsMock.mockResolvedValue({ field: "appearance.theme_id", value: "sambee-dark" });

    const staleRefresh = refreshCurrentUserSettings();
    await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    await userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    resolveStaleRefresh?.(settings);
    await staleRefresh;

    await vi.waitFor(() => expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-dark"));
  });

  it("applies a successful field update after a refresh completes during its write", async () => {
    await authenticateAndLoad();
    let resolveUpdate: ((value: { field: "appearance.theme_id"; value: string }) => void) | undefined;
    updateCurrentUserSettingsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    getCurrentUserSettingsMock.mockResolvedValueOnce(settings);

    const commit = userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    await vi.waitFor(() => expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    await refreshCurrentUserSettings();

    expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-light");
    resolveUpdate?.({ field: "appearance.theme_id", value: "sambee-dark" });
    await commit;

    expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-dark");
  });

  it("rejects a second write to the same field while the first is in flight", async () => {
    await authenticateAndLoad();
    let resolveUpdate: ((value: { field: "appearance.theme_id"; value: string }) => void) | undefined;
    updateCurrentUserSettingsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );

    const firstCommit = userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    await vi.waitFor(() => expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    await expect(userSettingsStore.getValue("appearance.theme_id").commit("sambee-light")).rejects.toThrow(
      "A write for this setting is already in progress."
    );
    resolveUpdate?.({ field: "appearance.theme_id", value: "sambee-dark" });
    await firstCommit;
  });

  it("allows writes to distinct fields while another field is pending", async () => {
    await authenticateAndLoad();
    let resolveThemeUpdate: ((value: { field: "appearance.theme_id"; value: string }) => void) | undefined;
    updateCurrentUserSettingsMock.mockImplementation((update) => {
      if (update.field === "appearance.theme_id") {
        return new Promise((resolve) => {
          resolveThemeUpdate = resolve;
        });
      }
      return Promise.resolve(update);
    });

    const themeCommit = userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    await vi.waitFor(() => expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    await userSettingsStore.getValue("localization.language").commit("en-XA");

    expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(2);
    expect(userSettingsStore.getValue("appearance.theme_id").pending).toBe(true);
    resolveThemeUpdate?.({ field: "appearance.theme_id", value: "sambee-dark" });
    await themeCommit;
  });

  it("discards an outstanding write after the authenticated identity changes", async () => {
    await authenticateAndLoad();
    let resolveUpdate: ((value: { field: "appearance.theme_id"; value: string }) => void) | undefined;
    updateCurrentUserSettingsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );

    const commit = userSettingsStore.getValue("appearance.theme_id").commit("sambee-dark");
    await vi.waitFor(() => expect(updateCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    authSession.clear();
    resolveUpdate?.({ field: "appearance.theme_id", value: "sambee-dark" });
    await commit;

    expect(userSettingsStore.getValue("appearance.theme_id")).toMatchObject({ confirmedValue: undefined, pending: false, error: null });
  });

  it("refreshes in response to an invalidation broadcast", async () => {
    await authenticateAndLoad();
    getCurrentUserSettingsMock.mockClear();
    getCurrentUserSettingsMock.mockResolvedValue({ ...settings, appearance: { ...settings.appearance, theme_id: "sambee-dark" } });

    getUserSettingsMessageHandler()?.(new MessageEvent("message", { data: { type: "invalidate" } }));

    await vi.waitFor(() => expect(getCurrentUserSettingsMock).toHaveBeenCalledTimes(1));
    expect(userSettingsStore.getValue("appearance.theme_id").confirmedValue).toBe("sambee-dark");
  });
});
