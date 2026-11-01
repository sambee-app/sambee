import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../../../i18n";
import api from "../../../../services/api";
import { SambeeThemeProvider } from "../../../../theme/ThemeContext";
import { getDirectoryResultPresentation, useDirectorySearchProvider } from "../useDirectorySearchProvider";

vi.mock("../../../../services/api");
vi.mock("../../../../services/recentDirectoriesSync", () => ({
  publishRecentDirectoriesChanged: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(SambeeThemeProvider, null, children);
}

describe("getDirectoryResultPresentation", () => {
  it("keeps the history representation with the best valid duplicate relevance", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [
        {
          id: "recent-reports",
          connection_id: "connection-1",
          path: "Documents/Reports",
          last_visited_at: "2026-01-01T00:00:00Z",
          matched_term_count: 99,
          match_rank: -1,
        },
      ],
    });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Documents/Reports"],
      total_matches: 1,
      cache_state: "ready",
      directory_count: 1,
      matched_term_counts: { "Documents/Reports": 2 },
      match_ranks: { "Documents/Reports": 0 },
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    let rows: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("doc report", new AbortController().signal);
    });
    expect(rows).toEqual([
      expect.objectContaining({
        value: "recent-directory:recent-reports",
        icon: "recent-directory",
        matchedTermCount: 2,
        matchRank: 0,
      }),
    ]);
  });

  it("retains results and shows an incomplete source message even when cache state is ready", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Reports"],
      total_matches: 1,
      cache_state: "ready",
      directory_count: 1,
      coverage: "partial",
      coverage_issue_count: 1,
      status_message: "Directory indexing is paused. Increase its disk budget and retry.",
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    let rows: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("Reports", new AbortController().signal);
    });
    expect(rows.some((row) => row.kind === "result" && row.value === "directory:Reports")).toBe(true);
    expect(result.current.getStatusInfo?.()).toEqual({
      label: "Directory indexing is paused. Increase its disk budget and retry.",
      showSpinner: false,
    });
  });

  it("does not let a late warm-up overwrite a newer query status", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    let finishWarmup!: (response: Awaited<ReturnType<typeof api.searchDirectories>>) => void;
    vi.mocked(api.searchDirectories).mockImplementation((_connection, query) =>
      query === ""
        ? new Promise((resolve) => {
            finishWarmup = resolve;
          })
        : Promise.resolve({ results: ["Reports"], total_matches: 1, cache_state: "ready", directory_count: 1, coverage: "complete" })
    );
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    act(() => result.current.onActivate?.());
    await act(async () => {
      await result.current.fetchResults("Reports", new AbortController().signal);
    });
    await act(async () => {
      finishWarmup({ results: [], total_matches: 0, cache_state: "building", directory_count: 0, coverage: "partial" });
    });
    expect(result.current.getStatusInfo?.()).toBeNull();
  });

  it("returns proportional-renderer data with a highlighted smart path", () => {
    expect(getDirectoryResultPresentation("Documents/Quarterly Reports/2026", "Reports")).toEqual({
      primaryText: "…/Quarterly Reports/2026",
      secondaryText: "/Documents/",
      primaryHighlight: { start: 12, end: 19 },
    });
  });

  it("uses the connection root as context when a shallow directory has no parent path", () => {
    expect(getDirectoryResultPresentation("Documents", "Doc")).toEqual({
      primaryText: "Documents",
      secondaryText: "/",
      primaryHighlight: { start: 0, end: 3 },
    });
  });

  it("preserves a root marker in a truncated rooted path's parent context", () => {
    expect(getDirectoryResultPresentation("/Documents/Quarterly Reports/2026", "Reports")).toEqual({
      primaryText: "…/Quarterly Reports/2026",
      secondaryText: "/Documents/",
      primaryHighlight: { start: 12, end: 19 },
    });
  });

  it("keeps recent directories first, avoids an empty cache query, and supports safe selection/removal", async () => {
    const onNavigate = vi.fn();
    const onNavigateDirectory = vi.fn();
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [
        {
          id: "recent-reports",
          connection_id: "connection-1",
          path: "Documents/Reports",
          last_visited_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "recent-other-connection",
          connection_id: "connection-2",
          path: "Projects/2026",
          last_visited_at: "2026-01-02T00:00:00Z",
        },
      ],
    });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Documents/Reports", "Documents/Reference"],
      total_matches: 2,
      cache_state: "ready",
      directory_count: 12,
    });

    const { result } = renderHook(
      () =>
        useDirectorySearchProvider("connection-1", onNavigate, {
          getConnectionName: (connectionId) => (connectionId === "connection-1" ? "Documents server" : "Projects server"),
          onNavigateDirectory,
        }),
      { wrapper }
    );

    const emptyResults = await result.current.fetchResults("", new AbortController().signal);
    expect(api.searchDirectories).not.toHaveBeenCalled();
    expect(emptyResults.map((entry) => ({ kind: entry.kind, value: entry.value }))).toEqual([
      { kind: "group-header", value: "" },
      { kind: "result", value: "recent-directory:recent-reports" },
      { kind: "result", value: "recent-directory:recent-other-connection" },
    ]);
    expect(emptyResults[1]).toMatchObject({
      icon: "recent-directory",
      primaryText: "…/Reports",
      secondaryText: "Documents server:/Documents/",
    });

    let results: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      results = await result.current.fetchResults("report", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledWith("connection-1", "report", expect.objectContaining({ includeDotDirectories: false }));
    expect(results.map((entry) => ({ kind: entry.kind, value: entry.value }))).toEqual([
      { kind: "result", value: "recent-directory:recent-reports" },
      { kind: "result", value: "recent-directory:recent-other-connection" },
      { kind: "result", value: "directory:Documents/Reference" },
    ]);
    expect(results[0]).toMatchObject({ icon: "recent-directory" });
    expect(results[1]).toMatchObject({ icon: "recent-directory" });
    expect(results[2]).toMatchObject({ icon: "directory" });

    result.current.onSelect("recent-directory:recent-other-connection");
    expect(onNavigateDirectory).toHaveBeenCalledWith("connection-2", "Projects/2026", "recent-other-connection");
    result.current.onSelect("directory:Documents/Reference");
    expect(onNavigate).toHaveBeenCalledWith("Documents/Reference");

    await expect(result.current.onRemoveSelected?.("recent-directory:recent-reports")).resolves.toBe(true);
    expect(api.removeRecentDirectory).toHaveBeenCalledWith("recent-reports");
    await expect(result.current.onRemoveSelected?.("directory:Documents/Reference")).resolves.toBe(false);
  });

  it("preserves server match ranks when merging Unicode cache matches with history", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [
        {
          id: "recent-prefix",
          connection_id: "connection-1",
          path: "strasse-extra",
          last_visited_at: "2026-01-01T00:00:00Z",
          match_rank: 1,
          usage_score: 20,
        },
      ],
    });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Stra\u00dfe"],
      match_ranks: { "Stra\u00dfe": 0 },
      total_matches: 1,
      cache_state: "ready",
      directory_count: 1,
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    let results: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      results = await result.current.fetchResults("strasse", new AbortController().signal);
    });

    expect(results.map((entry) => entry.value)).toEqual(["directory:Stra\u00dfe", "recent-directory:recent-prefix"]);
    expect(results[0]).toMatchObject({ matchRank: 0 });
  });

  it("queries recent directories but skips cache search for a one-character query", async () => {
    vi.mocked(api.searchDirectories).mockClear();
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    await result.current.fetchResults("r", new AbortController().signal);

    expect(api.searchRecentDirectories).toHaveBeenCalledWith("r", 50, expect.any(AbortSignal));
    expect(api.searchDirectories).not.toHaveBeenCalled();
  });

  it("returns no results for an aborted directory request", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Documents/Reports"],
      total_matches: 1,
      cache_state: "ready",
      directory_count: 1,
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    const controller = new AbortController();
    controller.abort();

    await expect(result.current.fetchResults("re", controller.signal)).resolves.toEqual([]);
  });

  it("propagates complete source failure to the shared Quick Bar error UI", async () => {
    vi.mocked(api.searchRecentDirectories).mockRejectedValue(new Error("Network error"));
    vi.mocked(api.searchDirectories).mockRejectedValue(new Error("Index error"));
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    await act(async () => {
      await expect(result.current.fetchResults("reports", new AbortController().signal)).rejects.toThrow("Network error");
    });
  });

  it("publishes selectable history before a deferred index response", async () => {
    const onNavigateDirectory = vi.fn();
    const onUpdate = vi.fn();
    let finishIndex: ((response: Awaited<ReturnType<typeof api.searchDirectories>>) => void) | undefined;
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [{ id: "recent", connection_id: "connection-1", path: "Reports", last_visited_at: "2026-01-01T00:00:00Z" }],
    });
    vi.mocked(api.searchDirectories).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishIndex = resolve;
        })
    );
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn(), { onNavigateDirectory }), { wrapper });
    let request: ReturnType<typeof result.current.fetchResults> | undefined;
    await act(async () => {
      request = result.current.fetchResults("reports", new AbortController().signal, onUpdate);
      await Promise.resolve();
    });
    expect(onUpdate).toHaveBeenCalledWith([expect.objectContaining({ value: "recent-directory:recent", icon: "recent-directory" })]);
    result.current.onSelect("recent-directory:recent");
    expect(onNavigateDirectory).toHaveBeenCalledWith("connection-1", "Reports", "recent");
    await act(async () => {
      finishIndex?.({ results: ["Reports", "Other Reports"], cache_state: "ready", total_matches: 2, directory_count: 100_001 });
      await request;
    });
    expect(onUpdate.mock.lastCall?.[0]).toHaveLength(2);
    expect(onUpdate.mock.lastCall?.[0][0]).toMatchObject({ icon: "recent-directory" });
  });

  it("keeps history when index search fails and stops the status spinner", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [{ id: "recent", connection_id: "connection-1", path: "Reports", last_visited_at: "2026-01-01T00:00:00Z" }],
    });
    vi.mocked(api.searchDirectories).mockRejectedValue(new Error("Index unavailable"));
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      const rows = await result.current.fetchResults("reports", new AbortController().signal);
      expect(rows).toEqual([expect.objectContaining({ value: "recent-directory:recent" })]);
    });
    expect(result.current.getStatusInfo()).toMatchObject({ showSpinner: false });
    expect(result.current.getStatusInfo()?.label).toContain("Directory search is unavailable");
  });

  it("keeps index results when history search fails", async () => {
    vi.mocked(api.searchRecentDirectories).mockRejectedValue(new Error("History unavailable"));
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Reports"],
      cache_state: "ready",
      total_matches: 1,
      directory_count: 1,
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      const rows = await result.current.fetchResults("reports", new AbortController().signal);
      expect(rows).toEqual([expect.objectContaining({ value: "directory:Reports" })]);
    });
    expect(result.current.getStatusInfo()?.label).toContain("Recent directories are unavailable");
  });

  it("aborts activation on deactivation and unmount", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(api.searchDirectories).mockImplementation((_connection, _query, options) => {
      signal = options?.signal;
      return new Promise<never>(() => undefined);
    });
    const { result, unmount } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    result.current.onActivate?.();
    expect(signal?.aborted).toBe(false);
    result.current.onDeactivate?.();
    expect(signal?.aborted).toBe(true);
    result.current.onActivate?.();
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
