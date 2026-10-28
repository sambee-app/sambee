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

  it("propagates a recent-directory search failure to the shared Quick Bar error UI", async () => {
    vi.mocked(api.searchRecentDirectories).mockRejectedValue(new Error("Network error"));
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    await expect(result.current.fetchResults("reports", new AbortController().signal)).rejects.toThrow("Network error");
  });
});
