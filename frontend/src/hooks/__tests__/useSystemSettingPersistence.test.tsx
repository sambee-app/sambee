import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSystemSettingPersistence } from "../useSystemSettingPersistence";

describe("useSystemSettingPersistence", () => {
  it("does not save an update that matches its confirmed value", async () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useSystemSettingPersistence(commit, () => "Save failed"));

    const outcome = await result.current.persist({ field: "limit", value: 100 }, 100);

    expect(outcome).toEqual({ status: "unchanged" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("does not save equal array values from a separately allocated draft", async () => {
    const commit = vi.fn();
    const { result } = renderHook(() => useSystemSettingPersistence(commit, () => "Save failed"));

    const outcome = await result.current.persist({ field: "trusted_proxy_cidrs", value: ["10.0.0.0/24"] }, ["10.0.0.0/24"]);

    expect(outcome).toEqual({ status: "unchanged" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("continues saving after StrictMode reinitializes effects", async () => {
    const commit = vi.fn(async (update: { field: string; value: unknown }) => update);
    const { result } = renderHook(() => useSystemSettingPersistence(commit, () => "Save failed"), { wrapper: StrictMode });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.persist({ field: "limit", value: 101 }, 100);
    });

    expect(outcome).toEqual({ status: "completed", update: { field: "limit", value: 101 } });
    expect(result.current.isPending("limit")).toBe(false);
    expect(result.current.isSaved("limit")).toBe(true);
  });

  it("aborts a save that exceeds its deadline and clears its pending state", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const commit = vi.fn(
        (_update: { field: string; value: unknown }, options: { signal: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            requestSignal = options.signal;
            options.signal.addEventListener("abort", () => reject(new Error("Request cancelled")), { once: true });
          })
      );
      const { result } = renderHook(() => useSystemSettingPersistence(commit, () => "Save failed", 100));

      let outcome: Promise<unknown>;
      act(() => {
        outcome = result.current.persist({ field: "limit", value: 101 }, 100);
      });

      expect(result.current.isPending("limit")).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      await expect(outcome!).resolves.toMatchObject({ status: "failed" });
      expect(requestSignal?.aborted).toBe(true);
      expect(result.current.isPending("limit")).toBe(false);
      expect(result.current.fieldErrors["limit"]).toBe("Saving this setting timed out. Check the connection and try again.");
    } finally {
      vi.useRealTimers();
    }
  });
});
