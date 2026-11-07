import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import "../../../../i18n";
import api from "../../../../services/api";
import { createBrowserContentServices } from "../../../../services/browserContentServices";
import { type BrowserHistoryService, browserHistoryService } from "../../../../services/browserHistoryService";
import { CompanionSession } from "../../../../services/companionSession";
import { SambeeThemeProvider } from "../../../../theme/ThemeContext";
import { SEARCH_CONTRACT_VERSION } from "../recentHistory";
import { getDirectoryResultPresentation, useDirectorySearchProvider } from "../useDirectorySearchProvider";

vi.mock("../../../../services/api");
vi.mock("../../../../services/recentDirectoriesSync", () => ({
  publishRecentDirectoriesChanged: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(SambeeThemeProvider, null, children);
}

describe("getDirectoryResultPresentation", () => {
  it.each([false, true])("links named partial coverage only when details exist (%s)", async (available) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const response = {
      results: ["readable"],
      total_matches: 1,
      directory_count: 2,
      cache_state: "ready" as const,
      coverage: "partial" as const,
      coverage_issue_count: 1,
      issue_details_available: available,
      search_contract_version: SEARCH_CONTRACT_VERSION,
    };
    vi.mocked(api.searchDirectories).mockResolvedValue(response);
    const { result } = renderHook(() => useDirectorySearchProvider("local-C", vi.fn(), { getConnectionName: () => "FS1" }), { wrapper });
    await act(async () => {
      await result.current.fetchResults("readable", new AbortController().signal);
    });
    const status = result.current.getStatusInfo();
    expect(status).toMatchObject({ label: "FS1: not all directories could be indexed.", showSpinner: false });
    expect(!!status?.loadDetails).toBe(available);
    if (available) {
      vi.mocked(api.searchDirectories).mockResolvedValue({
        ...response,
        issue_details: [{ path: "private", code: "access_denied" }],
        issue_details_incomplete: true,
      });
      const signal = new AbortController().signal;
      await expect(status?.loadDetails?.(signal)).resolves.toEqual({
        source: "FS1",
        issues: [{ path: "private", code: "access_denied" }],
        incomplete: true,
      });
      expect(api.searchDirectories).toHaveBeenLastCalledWith("local-C", "", {
        includeDotDirectories: false,
        includeIssueDetails: true,
        signal,
      });
    }
  });

  it("does not attach history error details to an index failure", async () => {
    vi.mocked(api.searchRecentDirectories).mockRejectedValue(new Error("History storage is offline."));
    vi.mocked(api.searchDirectories).mockRejectedValue({
      response: { status: 403, data: { detail: { message: "This source is not permitted." } } },
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn(), { getConnectionName: () => "FS1" }), {
      wrapper,
    });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    await expect(result.current.getStatusInfo()?.loadDetails?.(new AbortController().signal)).resolves.toEqual({
      source: "FS1",
      message: "This source is not permitted.",
    });
  });

  it.each([
    { phase: "building", found: 0, label: "Indexing..." },
    { phase: "building", found: 123, label: "Indexing... (123 directories found)" },
    { phase: "updating", found: 123, label: "Updating index... (12 of ~42 directories checked)" },
  ] as const)("shows $phase progress before uncertain coverage", async ({ phase, found, label }) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: [],
      total_matches: 0,
      cache_state: "ready",
      directory_count: 7,
      coverage: "uncertain",
      search_contract_version: SEARCH_CONTRACT_VERSION,
      scan_progress: { phase, parents_done: 12, parents_queued: 30, directories_found: found, started_at_ms: 1 },
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getStatusInfo()).toEqual({ label: `connection-1: ${label}`, showSpinner: true });
    expect(result.current.getRefreshIntervalMs?.()).toBe(500);
  });

  it.each([
    { cache_state: "building", directory_count: 0, label: "Indexing...", spinner: true },
    { cache_state: "building", directory_count: 3, label: "Indexing... (3 directories found)", spinner: true },
    { cache_state: "updating", directory_count: 3, label: "Updating index... (3 directories)", spinner: true },
    { cache_state: "ready", directory_count: 3, label: null, spinner: false },
  ] as const)(
    "keeps opening silent before $cache_state with $directory_count directories",
    async ({ cache_state, directory_count, label, spinner }) => {
      vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
      vi.mocked(api.searchDirectories).mockResolvedValue({
        results: [],
        total_matches: 0,
        cache_state: "opening",
        directory_count: 0,
        coverage: "partial",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
      const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
      expect(result.current.getStatusInfo()).toBeNull();
      await act(async () => {
        await result.current.fetchResults("reports", new AbortController().signal);
      });
      expect(result.current.getStatusInfo()).toBeNull();
      expect(result.current.getRefreshIntervalMs?.()).toBe(500);
      vi.mocked(api.searchDirectories).mockResolvedValue({
        results: [],
        total_matches: 0,
        cache_state,
        directory_count,
        coverage: "complete",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
      await act(async () => {
        await result.current.fetchResults("reports", new AbortController().signal);
      });
      expect(result.current.getStatusInfo()).toEqual(label ? { label: `connection-1: ${label}`, showSpinner: spinner } : null);
    }
  );

  it("shows a recovery message even while opening", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const message = "Directory index storage is in use. Wait for active workers to finish, then retry.";
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: [],
      total_matches: 0,
      cache_state: "opening",
      directory_count: 0,
      status_message: message,
      retry_after_ms: 2000,
      search_contract_version: SEARCH_CONTRACT_VERSION,
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getStatusInfo()).toEqual({ label: `connection-1: ${message}`, showSpinner: false });
    expect(result.current.getRefreshIntervalMs?.()).toBe(2000);
    vi.mocked(api.searchDirectories).mockRejectedValue(new Error("Source is offline."));
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getStatusInfo()?.label).toContain("Directory search is unavailable");
  });

  it.each(["connection-1", "local-C"])("fences old generation responses and retry errors for %s", async (connectionId) => {
    type Response = Awaited<ReturnType<typeof api.searchDirectories>>;
    const services = createBrowserContentServices([], new CompanionSession());
    const healthy: Response = {
      results: ["Current Reports"],
      total_matches: 1,
      directory_count: 1,
      cache_state: "ready",
      monitoring_state: "healthy",
      search_contract_version: SEARCH_CONTRACT_VERSION,
    };
    let finishOld!: (response: Response) => void;
    let failOld!: (error: unknown) => void;
    let finishActivation!: (response: Response) => void;
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories)
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishActivation = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            failOld = reject;
          })
      )
      .mockResolvedValue(healthy);
    const { result, rerender, unmount } = renderHook(
      ({ revision }) => useDirectorySearchProvider(connectionId, vi.fn(), { history: services.history, sourceRevision: revision }),
      { wrapper, initialProps: { revision: services.getSnapshot().capabilityRevision } }
    );
    const staleUpdate = vi.fn();
    let oldSearch!: ReturnType<typeof result.current.fetchResults>;
    let oldFailure!: ReturnType<typeof result.current.fetchResults>;
    await act(async () => {
      result.current.onActivate?.();
      oldSearch = result.current.fetchResults("reports", new AbortController().signal, staleUpdate);
      oldFailure = result.current.fetchResults("reports", new AbortController().signal, staleUpdate);
      await Promise.resolve();
    });
    staleUpdate.mockClear();
    const oldKey = result.current.sourceKey;
    services.updateCompanionSnapshot({ ...services.getSnapshot().companion, revision: 1 });
    rerender({ revision: services.getSnapshot().capabilityRevision });
    expect(result.current.sourceKey).not.toBe(oldKey);
    await act(async () => {
      expect(await result.current.fetchResults("reports", new AbortController().signal)).toEqual([
        expect.objectContaining({ value: "directory:Current Reports" }),
      ]);
    });
    await act(async () => {
      const stale: Response = { ...healthy, results: ["Stale Reports"], cache_state: "building", retry_after_ms: 60_000 };
      finishActivation(stale);
      finishOld(stale);
      failOld({ response: { status: 501, data: { detail: { recoverable: false } } } });
      expect(await oldSearch).toEqual([]);
      expect(await oldFailure).toEqual([]);
    });
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(result.current.getStatusInfo()).toBeNull();
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
    vi.mocked(api.searchDirectories).mockResolvedValue({ ...healthy, monitoring_state: "recovering", retry_after_ms: 2000 });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(2000);
    unmount();
    services.dispose();
  });

  it("publishes new rows without recommitting unchanged status and still publishes changed coverage", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const response: Awaited<ReturnType<typeof api.searchDirectories>> = {
      results: ["Reports"],
      total_matches: 1,
      directory_count: 100_000,
      cache_state: "ready",
      coverage: "complete",
      coverage_issue_count: 0,
      last_verified_at_ms: 1,
      search_contract_version: SEARCH_CONTRACT_VERSION,
    };
    vi.mocked(api.searchDirectories).mockResolvedValue(response);
    let commits = 0;
    const onNavigate = vi.fn();
    const { result } = renderHook(
      () => {
        const provider = useDirectorySearchProvider("connection-1", onNavigate);
        useEffect(() => {
          commits += 1;
        });
        return provider;
      },
      { wrapper }
    );
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    const settledCommits = commits;
    vi.mocked(api.searchDirectories).mockResolvedValue({ ...response, results: ["Quarterly Reports"] });
    let rows: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("quarterly", new AbortController().signal);
    });
    expect(rows.some((row) => row.kind === "result" && row.value === "directory:Quarterly Reports")).toBe(true);
    expect(commits).toBe(settledCommits);
    const statusMessage = "Directory indexing is paused. Increase its disk budget and retry.";
    vi.mocked(api.searchDirectories).mockResolvedValue({
      ...response,
      coverage: "partial",
      coverage_issue_count: 1,
      last_verified_at_ms: 2,
      status_message: statusMessage,
    });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(commits).toBeGreaterThan(settledCommits);
    expect(result.current.getStatusInfo?.()).toEqual({ label: `connection-1: ${statusMessage}`, showSpinner: false });
  });

  it.each([
    { cache_state: "opening", search_contract_version: SEARCH_CONTRACT_VERSION, expected: 500 },
    { cache_state: "building", search_contract_version: SEARCH_CONTRACT_VERSION, expected: 500 },
    { cache_state: "updating", search_contract_version: SEARCH_CONTRACT_VERSION, expected: 500 },
    { cache_state: "ready", search_contract_version: SEARCH_CONTRACT_VERSION, expected: null },
    { cache_state: "empty", search_contract_version: SEARCH_CONTRACT_VERSION, expected: 5000 },
    {
      cache_state: "ready",
      coverage: "partial",
      status_message: "Directory indexing is paused. Increase its disk budget and retry.",
      search_contract_version: SEARCH_CONTRACT_VERSION,
      expected: 5000,
    },
    { cache_state: "building", search_contract_version: undefined, expected: null },
    { cache_state: "building", search_contract_version: null, expected: null },
    { cache_state: "building", search_contract_version: SEARCH_CONTRACT_VERSION + 1, expected: null },
  ] as const)("gates quiet refresh for $cache_state contract $search_contract_version", async ({ expected, ...status }) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockResolvedValue({ results: [], total_matches: 0, directory_count: 0, ...status });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(expected);
  });

  it.each(["building", "updating"] as const)("keeps status refresh when a %s query becomes too short", async (cacheState) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockClear();
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: [],
      total_matches: 0,
      directory_count: 0,
      cache_state: cacheState,
      search_contract_version: SEARCH_CONTRACT_VERSION,
    });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(500);

    await act(async () => {
      await result.current.fetchResults("r", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledTimes(2);
    expect(api.searchDirectories).toHaveBeenLastCalledWith("connection-1", "", expect.anything());
    expect(result.current.getRefreshIntervalMs?.()).toBe(500);

    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledTimes(3);
    expect(result.current.getRefreshIntervalMs?.()).toBe(500);
  });

  it.each(["connection-1", "local-C"])("keeps one full-query request and source-specific legacy status for %s", async (connectionId) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const response = {
      results: ["alpha/beta"],
      total_matches: 100_001,
      directory_count: 100_001,
      cache_state: "ready" as const,
    };
    vi.mocked(api.searchDirectories).mockResolvedValue(response);
    vi.mocked(api.searchDirectories).mockClear();
    const { result } = renderHook(() => useDirectorySearchProvider(connectionId, vi.fn()), { wrapper });
    let rows: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("alpha beta", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledTimes(1);
    expect(api.searchDirectories).toHaveBeenCalledWith(connectionId, "alpha beta", expect.objectContaining({ signal: expect.anything() }));
    expect(rows.some((row) => row.kind === "result" && row.value === "directory:alpha/beta")).toBe(true);
    expect(result.current.getStatusInfo?.()).toEqual({
      label: `${connectionId}: Multi-term directory search is not confirmed for this source. Search one directory term or check backend and companion support.`,
      showSpinner: false,
    });
    vi.mocked(api.searchDirectories).mockResolvedValue({ ...response, search_contract_version: SEARCH_CONTRACT_VERSION });
    await act(async () => {
      await result.current.fetchResults("alpha beta", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledTimes(2);
    expect(result.current.getStatusInfo?.()).toBeNull();
  });

  it("reuses same-query history, retains bounded recovery, and reloads invalidated history", async () => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories)
      .mockResolvedValueOnce({
        results: [],
        total_matches: 0,
        directory_count: 0,
        cache_state: "building",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      })
      .mockRejectedValueOnce(new Error("Index unavailable"))
      .mockResolvedValue({
        results: [],
        total_matches: 0,
        directory_count: 0,
        cache_state: "ready",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(500);
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(5000);
    expect(api.searchRecentDirectories).toHaveBeenCalledTimes(1);
    result.current.invalidateResults?.();
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(api.searchRecentDirectories).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.fetchResults("other", new AbortController().signal);
    });
    expect(api.searchRecentDirectories).toHaveBeenCalledTimes(3);
    expect(api.searchDirectories).toHaveBeenCalledTimes(4);
  });

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
      label: "connection-1: Directory indexing is paused. Increase its disk budget and retry.",
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

    let emptyResults: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      emptyResults = await result.current.fetchResults("", new AbortController().signal);
    });
    expect(api.searchDirectories).toHaveBeenCalledWith("connection-1", "", expect.anything());
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

  it("queries recent directories and index status for a one-character query", async () => {
    vi.mocked(api.searchDirectories).mockClear();
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    await act(async () => {
      await result.current.fetchResults("r", new AbortController().signal);
    });

    expect(api.searchRecentDirectories).toHaveBeenCalledWith("r", 50, expect.any(AbortSignal));
    expect(api.searchDirectories).toHaveBeenCalledWith("connection-1", "", expect.anything());
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

  it("shows complete source failure and keeps bounded recovery active", async () => {
    vi.mocked(api.searchRecentDirectories).mockRejectedValue(new Error("Network error"));
    vi.mocked(api.searchDirectories).mockRejectedValue(new Error("Index error"));
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });

    await act(async () => {
      await expect(result.current.fetchResults("reports", new AbortController().signal)).resolves.toEqual([]);
    });
    expect(result.current.getStatusInfo()).toMatchObject({ showSpinner: false });
    expect(result.current.getRefreshIntervalMs?.()).toBe(5000);
  });

  it.each(["connection-1", "local-C"])("retains results and stops terminal retries for %s", async (connectionId) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories)
      .mockResolvedValueOnce({
        results: ["Reports"],
        total_matches: 1,
        directory_count: 1,
        cache_state: "ready",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      })
      .mockRejectedValue({ response: { status: 503, data: { detail: { recoverable: true, retry_after_ms: 900_000 } } } });
    const { result } = renderHook(() => useDirectorySearchProvider(connectionId, vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    await act(async () => {
      const rows = await result.current.fetchResults("reports", new AbortController().signal);
      expect(rows).toEqual([expect.objectContaining({ value: "directory:Reports" })]);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(60_000);
    vi.mocked(api.searchDirectories).mockRejectedValue({ response: { status: 501, data: { detail: { recoverable: false } } } });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
  });

  it.each(["connection-1", "local-C"])(
    "keeps terminal index failures visible across query and history changes for %s",
    async (connectionId) => {
      vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
      vi.mocked(api.searchDirectories).mockRejectedValue({ response: { status: 400 } });
      const { result } = renderHook(() => useDirectorySearchProvider(connectionId, vi.fn()), { wrapper });
      await act(async () => {
        await result.current.fetchResults("reports", new AbortController().signal);
      });
      const failure = result.current.getStatusInfo();
      expect(failure?.label).toContain("Directory search is unavailable");
      expect(result.current.getRefreshIntervalMs?.()).toBeNull();
      const requests = vi.mocked(api.searchDirectories).mock.calls.length;
      await act(async () => {
        await result.current.fetchResults("archive", new AbortController().signal);
      });
      expect(result.current.getStatusInfo()).toEqual(failure);
      vi.mocked(api.searchRecentDirectories).mockRejectedValueOnce(new Error("History unavailable"));
      await act(async () => {
        await result.current.fetchResults("other", new AbortController().signal);
      });
      expect(result.current.getStatusInfo()).toEqual(failure);
      expect(api.searchDirectories).toHaveBeenCalledTimes(requests);
      vi.mocked(api.searchDirectories).mockResolvedValue({
        results: [],
        total_matches: 0,
        directory_count: 0,
        cache_state: "ready",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
      await act(async () => result.current.onActivate?.());
      expect(result.current.getStatusInfo()).toBeNull();
      expect(api.searchDirectories).toHaveBeenCalledTimes(requests + 1);
    }
  );

  it.each(["connection-1", "local-C"])("retries temporary query saturation for %s", async (connectionId) => {
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories)
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue({
        results: [],
        total_matches: 0,
        directory_count: 0,
        cache_state: "ready",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
    const { result } = renderHook(() => useDirectorySearchProvider(connectionId, vi.fn()), { wrapper });
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(5000);
    expect(result.current.getStatusInfo()?.label).toContain("Directory search is unavailable");
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getStatusInfo()).toBeNull();
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
  });

  it("shows activation failure and stops recovery on deactivation", async () => {
    vi.mocked(api.searchDirectories).mockRejectedValue(new Error("unavailable"));
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    await act(async () => {
      result.current.onActivate?.();
    });
    expect(result.current.getStatusInfo()).toMatchObject({ showSpinner: false });
    expect(result.current.getRefreshIntervalMs?.()).toBe(5000);
    act(() => result.current.onDeactivate?.());
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
  });

  it.each(["connection-1", "local-C"])("recovers from paused activation and request failure for %s", async (connectionId) => {
    const healthy = {
      results: ["Reports"],
      total_matches: 1,
      directory_count: 1,
      cache_state: "ready" as const,
      monitoring_state: "healthy" as const,
      search_contract_version: SEARCH_CONTRACT_VERSION,
    };
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({
      result_limit: 10,
      results: [{ id: "recent", connection_id: connectionId, path: "Other Reports", last_visited_at: "2026-01-01T00:00:00Z" }],
    });
    vi.mocked(api.searchDirectories)
      .mockResolvedValueOnce({ ...healthy, results: [], cache_state: "building", monitoring_state: "unavailable", retry_after_ms: 30_000 })
      .mockResolvedValueOnce({ ...healthy, monitoring_state: "recovering" })
      .mockRejectedValueOnce({ response: { status: 503, data: { detail: { recoverable: true, retry_after_ms: 2000 } } } })
      .mockResolvedValue(healthy);
    const { result } = renderHook(() => useDirectorySearchProvider(connectionId, vi.fn()), { wrapper });
    await act(async () => result.current.onActivate?.());
    expect(api.searchDirectories).toHaveBeenLastCalledWith(connectionId, "", expect.anything());
    expect(result.current.getStatusInfo()).toMatchObject({ showSpinner: false });
    expect(result.current.getRefreshIntervalMs?.()).toBe(30_000);
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getRefreshIntervalMs?.()).toBe(5000);
    await act(async () => {
      const retained = await result.current.fetchResults("reports", new AbortController().signal);
      expect(retained).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "directory:Reports" }),
          expect.objectContaining({ value: "recent-directory:recent" }),
        ])
      );
    });
    expect(result.current.getStatusInfo()).toMatchObject({ showSpinner: false });
    expect(result.current.getRefreshIntervalMs?.()).toBe(2000);
    await act(async () => {
      await result.current.fetchResults("reports", new AbortController().signal);
    });
    expect(result.current.getStatusInfo()).toBeNull();
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
    expect(api.searchRecentDirectories).toHaveBeenCalledTimes(1);
    expect(api.searchDirectories).toHaveBeenCalledTimes(4);
    act(() => result.current.onDeactivate?.());
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
  });

  it("rejects a response that arrives after deactivation", async () => {
    type Response = Awaited<ReturnType<typeof api.searchDirectories>>;
    let finish: ((response: Response) => void) | undefined;
    vi.mocked(api.searchRecentDirectories).mockResolvedValue({ result_limit: 10, results: [] });
    vi.mocked(api.searchDirectories).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    const { result } = renderHook(() => useDirectorySearchProvider("connection-1", vi.fn()), { wrapper });
    let pending: ReturnType<typeof result.current.fetchResults> | undefined;
    const onUpdate = vi.fn();
    await act(async () => {
      pending = result.current.fetchResults("reports", new AbortController().signal, onUpdate);
      await Promise.resolve();
    });
    onUpdate.mockClear();
    act(() => result.current.onDeactivate?.());
    await act(async () => {
      finish?.({
        results: ["Stale Reports"],
        total_matches: 1,
        directory_count: 1,
        cache_state: "building",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
      expect(await pending).toEqual([]);
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
  });

  it.each(["connection-1", "local-C"])("rejects old-client results after same-source replacement for %s", async (connectionId) => {
    type Response = Awaited<ReturnType<typeof api.searchDirectories>>;
    let finishOld: ((response: Response) => void) | undefined;
    const oldHistory: BrowserHistoryService = {
      ...browserHistoryService,
      searchRecentDirectories: vi.fn().mockResolvedValue({ result_limit: 10, results: [] }),
      searchDirectories: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          })
      ),
    };
    const newHistory: BrowserHistoryService = {
      ...oldHistory,
      searchDirectories: vi.fn().mockResolvedValue({
        results: ["Current Reports"],
        total_matches: 1,
        directory_count: 1,
        cache_state: "ready",
        monitoring_state: "healthy",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      }),
    };
    const { result, rerender } = renderHook(({ history }) => useDirectorySearchProvider(connectionId, vi.fn(), { history }), {
      wrapper,
      initialProps: { history: oldHistory },
    });
    const staleUpdate = vi.fn();
    let pending: ReturnType<typeof result.current.fetchResults> | undefined;
    await act(async () => {
      pending = result.current.fetchResults("reports", new AbortController().signal, staleUpdate);
      await Promise.resolve();
    });
    staleUpdate.mockClear();
    const oldSourceKey = result.current.sourceKey;
    rerender({ history: newHistory });
    expect(result.current.sourceKey).not.toBe(oldSourceKey);
    await act(async () => {
      const current = await result.current.fetchResults("reports", new AbortController().signal);
      expect(current).toEqual([expect.objectContaining({ value: "directory:Current Reports" })]);
    });
    await act(async () => {
      finishOld?.({
        results: ["Stale Reports"],
        total_matches: 1,
        directory_count: 1,
        cache_state: "building",
        search_contract_version: SEARCH_CONTRACT_VERSION,
      });
      expect(await pending).toEqual([]);
    });
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(result.current.getRefreshIntervalMs?.()).toBeNull();
    expect(result.current.getStatusInfo()).toBeNull();
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
