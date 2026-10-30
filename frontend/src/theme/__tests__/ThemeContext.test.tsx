import { readFileSync } from "node:fs";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAuthToken } from "../../test/fixtures/users";

const { useCurrentUserSettingMock, getThemesMock, getCurrentUserMock, refreshSettingsMock } = vi.hoisted(() => ({
  useCurrentUserSettingMock: vi.fn(),
  getThemesMock: vi.fn(),
  getCurrentUserMock: vi.fn(),
  refreshSettingsMock: vi.fn(),
}));

vi.mock("../../services/api", () => ({
  default: { getThemes: getThemesMock, getCurrentUser: getCurrentUserMock },
}));

vi.mock("../../services/userSettingsStore", () => ({
  useCurrentUserSetting: useCurrentUserSettingMock,
  refreshCurrentUserSettings: refreshSettingsMock,
}));

import { authSession } from "../../services/authSession";
import { logger } from "../../services/logger";
import { completeAuthentication } from "../../services/oidcAuth";
import { SambeeThemeProvider, useSambeeTheme } from "../ThemeContext";

function createWrapper() {
  return ({ children }: { children: ReactNode }) => <SambeeThemeProvider>{children}</SambeeThemeProvider>;
}

describe("ThemeContext", () => {
  beforeEach(() => {
    getThemesMock.mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    getCurrentUserMock.mockResolvedValue({ role: "editor" });
    refreshSettingsMock.mockResolvedValue(undefined);
    document.head.innerHTML = '<meta name="theme-color" content="#F4C430" />';
    useCurrentUserSettingMock.mockImplementation(() => ({
      confirmedValue: undefined,
      pending: false,
      error: null,
      commit: vi.fn(),
      clearError: vi.fn(),
    }));
  });

  it("uses the built-in default while appearance settings are unavailable", async () => {
    const { result } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });

    expect(result.current.currentTheme.id).toBe("sambee-light");
    expect(result.current.availableThemes.map((theme) => theme.id)).toEqual(["sambee-light", "sambee-dark"]);
    await waitFor(() => expect(refreshSettingsMock).toHaveBeenCalled());
  });

  it("uses the default theme color for PWA and document metadata", () => {
    const documentHtml = readFileSync("index.html", "utf8");
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as { theme_color: string };

    expect(documentHtml).toContain('<meta name="theme-color" content="#F4C430" />');
    expect(manifest.theme_color).toBe("#F4C430");
  });

  it("projects the confirmed selection and stored themes", async () => {
    const customTheme = {
      id: "custom",
      name: "Custom",
      mode: "dark" as const,
      primary: { main: "#123456" },
      secondary: { main: "#abcdef" },
    };
    getThemesMock.mockResolvedValue({
      themes: [{ id: "custom", scope: "user", version: 1, definition: customTheme }],
      site_default_id: "sambee-light",
    });
    useCurrentUserSettingMock.mockImplementation(() => ({
      confirmedValue: "custom",
      pending: false,
      error: null,
      commit: vi.fn(),
      clearError: vi.fn(),
    }));

    const { result } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.currentTheme).toMatchObject(customTheme));
    expect(result.current.muiTheme.palette.mode).toBe("dark");
    expect(result.current.availableThemes).toContainEqual(expect.objectContaining(customTheme));
    expect(result.current.muiTheme.palette.syntax).toEqual(result.current.currentTheme.components?.syntax);
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#123456");
  });

  it("falls back safely when a confirmed theme ID is absent from the registry", async () => {
    useCurrentUserSettingMock.mockImplementation((field: string) => ({
      confirmedValue: field === "appearance.theme_id" ? "missing" : [],
      pending: false,
      error: null,
      commit: vi.fn(),
      clearError: vi.fn(),
    }));

    const { result } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });

    expect(result.current.currentTheme.id).toBe("sambee-light");
    await waitFor(() => expect(refreshSettingsMock).toHaveBeenCalled());
  });

  it("refreshes the site default on focus and after a local write", async () => {
    const { result } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });
    await waitFor(() => expect(getThemesMock).toHaveBeenCalledTimes(1));
    getThemesMock.mockResolvedValue({ themes: [], site_default_id: "sambee-dark" });

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.currentTheme.id).toBe("sambee-dark"));

    getThemesMock.mockResolvedValue({ themes: [], site_default_id: "sambee-light" });
    await act(async () => result.current.refreshThemes());
    expect(result.current.currentTheme.id).toBe("sambee-light");
  });

  it("reloads themes and user settings once for a same-user login, not for a token refresh", async () => {
    const { unmount } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });
    await waitFor(() => expect(getThemesMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      authSession.setAuthenticated(createMockAuthToken({ access_token: "a", token_type: "bearer", user_id: "same-user" }), true);
    });
    await waitFor(() => expect(getThemesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(refreshSettingsMock).toHaveBeenCalledTimes(2));
    authSession.setAuthenticated(createMockAuthToken({ access_token: "refreshed", token_type: "bearer", user_id: "same-user" }), true);
    expect(getThemesMock).toHaveBeenCalledTimes(2);
    expect(refreshSettingsMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      authSession.setAuthenticated(createMockAuthToken({ access_token: "b", token_type: "bearer", user_id: "same-user" }), true);
      authSession.notifyNewLogin();
    });
    await waitFor(() => expect(getThemesMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(refreshSettingsMock).toHaveBeenCalledTimes(3));
    expect(getCurrentUserMock).toHaveBeenCalledTimes(3);
    unmount();
    authSession.clear();
  });

  it("keeps B's data when A's initial theme and user requests fail after same-user login", async () => {
    let rejectThemes!: (reason: Error) => void;
    let rejectUser!: (reason: Error) => void;
    getThemesMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectThemes = reject;
        })
    );
    getCurrentUserMock.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectUser = reject;
        })
    );
    authSession.setAuthenticated(createMockAuthToken({ access_token: "a", token_type: "bearer", user_id: "same-user" }), true);
    const tracing = vi.spyOn(logger, "initializeBackendTracing").mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });
    await waitFor(() => expect(getThemesMock).toHaveBeenCalledTimes(1));
    getThemesMock.mockResolvedValue({ themes: [], site_default_id: "sambee-dark" });
    getCurrentUserMock.mockResolvedValue({ role: "admin" });
    await act(async () => {
      await completeAuthentication(
        createMockAuthToken({ access_token: "b", token_type: "bearer", user_id: "same-user", return_path: "/browse" })
      );
    });
    await waitFor(() => expect(result.current.currentTheme.id).toBe("sambee-dark"));
    await act(async () => {
      rejectThemes(new Error("A was revoked"));
      rejectUser(new Error("A was revoked"));
    });
    expect(result.current.isAdmin).toBe(true);
    expect(getThemesMock).toHaveBeenCalledTimes(2);
    expect(refreshSettingsMock).toHaveBeenCalledTimes(1);
    expect(authSession.getAccessToken()).toBe("b");
    tracing.mockRestore();
    unmount();
    authSession.clear();
  });

  it("applies a saved selected theme when another tab regains focus", async () => {
    const customTheme = {
      id: "custom",
      name: "Custom",
      mode: "light" as const,
      primary: { main: "#123456" },
      secondary: { main: "#abcdef" },
    };
    useCurrentUserSettingMock.mockImplementation(() => ({ confirmedValue: "custom" }));
    getThemesMock.mockResolvedValue({
      themes: [{ id: "custom", scope: "user", version: 1, definition: customTheme }],
      site_default_id: "sambee-light",
    });
    const { result } = renderHook(() => useSambeeTheme(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.currentTheme.primary.main).toBe("#123456"));

    getThemesMock.mockResolvedValue({
      themes: [{ id: "custom", scope: "user", version: 2, definition: { ...customTheme, primary: { main: "#654321" } } }],
      site_default_id: "sambee-light",
    });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.currentTheme.primary.main).toBe("#654321"));
    expect(result.current.muiTheme.palette.primary.main).toBe("#654321");
  });
});
