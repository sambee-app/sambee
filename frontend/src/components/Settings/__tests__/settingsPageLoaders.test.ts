import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../services/logger";
import { prefetchSettingsPages, SETTINGS_PAGE_LOADERS, scheduleSettingsPagePrefetch } from "../settingsPageLoaders";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("settings page prefetch", () => {
  it("defers module loading to idle time and exposes cancellation", async () => {
    const idle = vi.fn<typeof window.requestIdleCallback>().mockReturnValue(1);
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", idle);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const load = vi.spyOn(SETTINGS_PAGE_LOADERS, "text-editor").mockResolvedValue({ default: () => createElement("div") });

    const cancel = scheduleSettingsPagePrefetch(["text-editor"]);
    expect(load).not.toHaveBeenCalled();
    const callback = idle.mock.calls[0]![0];
    callback({ didTimeout: false, timeRemaining: () => 50 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    cancel();
    expect(cancelIdle).toHaveBeenCalledWith(1);
  });

  it("cancels the timer fallback before loading modules", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const load = vi.spyOn(SETTINGS_PAGE_LOADERS, "local-drives").mockResolvedValue({ default: () => createElement("div") });

    const cancel = scheduleSettingsPagePrefetch(["local-drives"]);
    cancel();
    await vi.runAllTimersAsync();
    expect(load).not.toHaveBeenCalled();

    scheduleSettingsPagePrefetch(["local-drives"]);
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledOnce();
  });

  it("loads only requested pages and deduplicates completed prefetches", async () => {
    const account = vi.spyOn(SETTINGS_PAGE_LOADERS, "account").mockResolvedValue({ default: () => createElement("div") });
    const admin = vi.spyOn(SETTINGS_PAGE_LOADERS, "admin-users");

    await prefetchSettingsPages(["account", "account"]);
    await prefetchSettingsPages(["account"]);

    expect(account).toHaveBeenCalledOnce();
    expect(admin).not.toHaveBeenCalled();
  });

  it("deduplicates in-flight prefetches", async () => {
    let complete!: () => void;
    const load = vi.spyOn(SETTINGS_PAGE_LOADERS, "connections").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ default: () => createElement("div") });
        })
    );

    const first = prefetchSettingsPages(["connections"]);
    const second = prefetchSettingsPages(["connections"]);
    expect(load).toHaveBeenCalledOnce();
    complete();
    await Promise.all([first, second]);
  });

  it("logs background failures and allows a later retry", async () => {
    const error = new Error("Chunk download failed");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const load = vi
      .spyOn(SETTINGS_PAGE_LOADERS, "file-browser")
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ default: () => createElement("div") });

    await expect(prefetchSettingsPages(["file-browser"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Failed to prefetch settings page; opening the category will retry loading it",
      { category: "file-browser", error },
      "settings"
    );
    await prefetchSettingsPages(["file-browser"]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
