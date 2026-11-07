import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../../i18n";
import { browserHistoryService } from "../../../services/browserHistoryService";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { type FileEntry, FileType } from "../../../types";
import { getQuickBarResultRowHeight, QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT, QUICK_BAR_RESULT_ITEM_HEIGHT } from "../QuickBarResultRow";
import { SEARCH_CONTRACT_VERSION } from "../search/recentHistory";
import type { SearchProvider, SearchResultsUpdate } from "../search/types";
import { useDirectorySearchProvider } from "../search/useDirectorySearchProvider";
import { useFileSearchProvider } from "../search/useFileSearchProvider";
import { UnifiedSearchBar } from "../UnifiedSearchBar";

const virtualizerSizeCache = new Map<string | number, number>();
const virtualizerScrollToOffset = vi.fn();
const INPUT_DEBOUNCE_MS = 160;
const QUIET_REFRESH_INTERVAL_MS = 500;
const MOCK_HISTORY_RESPONSE_MS = 40;
const MOCK_INDEX_RESPONSE_MS = 80;
const VISIBLE_RESULTS_TARGET_MS = 300;
const INCREMENTAL_KEY_INTERVAL_MS = 50;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getItemKey,
  }: {
    count: number;
    estimateSize: (index: number) => number;
    getItemKey?: (index: number) => string | number;
  }) => {
    const getItemSize = (index: number) => {
      const key = getItemKey?.(index) ?? index;
      const cachedSize = virtualizerSizeCache.get(key);
      if (cachedSize !== undefined) return cachedSize;

      const size = estimateSize(index);
      virtualizerSizeCache.set(key, size);
      return size;
    };

    return {
      getTotalSize: () => Array.from({ length: count }, (_, index) => getItemSize(index)).reduce((total, height) => total + height, 0),
      getVirtualItems: () => {
        let start = 0;
        return Array.from({ length: count }, (_, index) => {
          const virtualItem = { index, start };
          start += getItemSize(index);
          return virtualItem;
        });
      },
      scrollToOffset: virtualizerScrollToOffset,
      scrollToIndex: vi.fn(),
    };
  },
}));

const testProvider: SearchProvider = {
  id: "test-provider",
  placeholder: "Search",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

const noResultsProvider: SearchProvider = {
  id: "no-results-provider",
  modeId: "navigate",
  modeLabel: "Navigate",
  shortcutHint: "Ctrl+K",
  placeholder: "Search",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

const footerProvider: SearchProvider = {
  id: "footer-provider",
  placeholder: "Search",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [
    {
      kind: "result",
      id: "result-1",
      value: "result-1",
      icon: "directory",
      primaryText: "Documents",
    },
  ],
  onSelect: () => undefined,
  getStatusInfo: () => null,
  footerHint: "Keyboard shortcuts",
  footerInfo: (resultCount) => `${resultCount} result`,
};

const fileSearchProvider: SearchProvider = {
  id: "file-search-provider",
  modeId: "file-search",
  modeLabel: "File Search",
  placeholder: "Search recent and current-directory files",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

const resultsProvider: SearchProvider = {
  id: "results-provider",
  modeId: "navigate",
  modeLabel: "Navigate",
  placeholder: "Search",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [
    {
      kind: "result",
      id: "folder-1",
      value: "/docs",
      icon: "directory",
      primaryText: "Docs",
    },
  ],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

const commandsProvider: SearchProvider = {
  id: "commands-provider",
  modeId: "commands",
  modeLabel: "Commands",
  placeholder: "Search commands",
  debounceMs: 0,
  minQueryLength: 0,
  fetchResults: async () => [
    {
      kind: "result",
      id: "command-1",
      value: "command-1",
      icon: "command",
      primaryText: "Open settings",
    },
  ],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

function createSelectableProvider(onSelect: SearchProvider["onSelect"]): SearchProvider {
  return {
    id: "selectable-provider",
    modeId: "file-search",
    modeLabel: "File Search",
    placeholder: "Search recent and current-directory files",
    debounceMs: 0,
    minQueryLength: 0,
    fetchResults: async () => [
      {
        kind: "result",
        id: "file-1",
        value: "file-1",
        icon: "file",
        primaryText: "Quarterly report",
      },
    ],
    onSelect,
    getStatusInfo: () => null,
  };
}

function createGroupedProvider(onSelect: SearchProvider["onSelect"]): SearchProvider {
  return {
    id: "grouped-provider",
    modeId: "file-search",
    modeLabel: "File Search",
    placeholder: "Search recent and current-directory files",
    debounceMs: 0,
    minQueryLength: 0,
    fetchResults: async () => [
      { kind: "group-header", id: "recent", value: "", label: "Recent files" },
      {
        kind: "result",
        id: "recent-file",
        value: "recent-file",
        icon: "recent-file",
        primaryText: "Quarterly report",
        secondaryText: "Demo:/Reports",
      },
      { kind: "group-header", id: "current", value: "", label: "Current directory" },
      {
        kind: "result",
        id: "current-file",
        value: "current-file",
        icon: "file",
        primaryText: "Annual report",
        secondaryText: "Demo:/Reports",
      },
    ],
    onSelect,
    getStatusInfo: () => null,
    footerInfo: (resultCount) => `${resultCount} results`,
  };
}

function createRemovableGroupedProvider(): SearchProvider {
  let hasRemovedRecent = false;

  const getResults = (): Awaited<ReturnType<SearchProvider["fetchResults"]>> => [
    { kind: "group-header" as const, id: "recent", value: "", label: "Recent files" },
    ...(!hasRemovedRecent
      ? [
          {
            kind: "result" as const,
            id: "recent-first",
            value: "recent-first",
            icon: "recent-file" as const,
            primaryText: "First recent file",
          },
        ]
      : []),
    {
      kind: "result" as const,
      id: "recent-second",
      value: "recent-second",
      icon: "recent-file" as const,
      primaryText: "Second recent file",
    },
    { kind: "group-header" as const, id: "current", value: "" as const, label: "Current directory" },
    {
      kind: "result" as const,
      id: "current-file",
      value: "current-file",
      icon: "file" as const,
      primaryText: "Current file",
    },
  ];

  return {
    id: "removable-grouped-provider",
    modeId: "file-search",
    modeLabel: "File Search",
    placeholder: "Search recent and current-directory files",
    debounceMs: 0,
    minQueryLength: 0,
    fetchResults: async () => getResults(),
    onSelect: () => undefined,
    onRemoveSelected: async () => {
      hasRemovedRecent = true;
      return true;
    },
    getStatusInfo: () => null,
  };
}

const modeOptions = [
  {
    id: "navigate",
    label: "Navigate",
    onSelect: vi.fn(),
  },
  {
    id: "file-search",
    label: "File Search",
    onSelect: vi.fn(),
  },
  {
    id: "commands",
    label: "Commands",
    onSelect: vi.fn(),
  },
];

function renderWithProvider(component: React.ReactElement) {
  return render(<SambeeThemeProvider>{component}</SambeeThemeProvider>);
}

describe("UnifiedSearchBar", () => {
  it.each(["connection-1", "local-C"])("completes activation, recovery, source switching, and dismissal for %s", async (connectionId) => {
    vi.useFakeTimers();
    const retryMs = 2000;
    let phase: "paused" | "failed" | "healthy" = "paused";
    const history = {
      ...browserHistoryService,
      searchRecentDirectories: vi.fn().mockResolvedValue({ result_limit: 10, results: [] }),
      searchDirectories: vi.fn(async () => {
        if (phase === "failed") throw { response: { status: 503, data: { detail: { recoverable: true, retry_after_ms: retryMs } } } };
        return {
          results: phase === "healthy" ? ["Recovered Reports"] : [],
          total_matches: phase === "healthy" ? 1 : 0,
          directory_count: 1,
          cache_state: "ready" as const,
          monitoring_state: phase === "healthy" ? ("healthy" as const) : ("unavailable" as const),
          retry_after_ms: phase === "healthy" ? null : retryMs,
          search_contract_version: SEARCH_CONTRACT_VERSION,
        };
      }),
    };
    function RecoveryHarness({ source }: { source: string }) {
      const provider = useDirectorySearchProvider(source, vi.fn(), { history });
      return <UnifiedSearchBar provider={provider} />;
    }
    try {
      const { rerender } = renderWithProvider(<RecoveryHarness source={connectionId} />);
      const input = screen.getByRole("textbox");
      await act(async () => input.focus());
      fireEvent.change(input, { target: { value: "reports" } });
      await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS));
      expect(history.searchDirectories).toHaveBeenCalledWith(connectionId, "", expect.anything());
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      phase = "failed";
      await act(() => vi.advanceTimersByTimeAsync(retryMs));
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      phase = "healthy";
      await act(() => vi.advanceTimersByTimeAsync(retryMs));
      expect(screen.getByRole("option", { name: /Recovered Reports/ })).toBeInTheDocument();
      phase = "paused";
      const replacement = connectionId === "connection-1" ? "local-C" : "connection-1";
      rerender(
        <SambeeThemeProvider>
          <RecoveryHarness source={replacement} />
        </SambeeThemeProvider>
      );
      await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS));
      expect(history.searchDirectories).toHaveBeenCalledWith(replacement, expect.any(String), expect.anything());
      expect(screen.queryByRole("option", { name: /Recovered Reports/ })).not.toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Escape" });
      const calls = history.searchDirectories.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(retryMs * 3));
      expect(history.searchDirectories).toHaveBeenCalledTimes(calls);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it.each(["pasted", "incremental"])("publishes selectable merged rows within the mocked %s-query timing budget", async (inputMode) => {
    vi.useFakeTimers();
    try {
      const onNavigateDirectory = vi.fn();
      const history = {
        ...browserHistoryService,
        searchRecentDirectories: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, MOCK_HISTORY_RESPONSE_MS));
          return {
            result_limit: 10,
            results: [{ id: "recent", connection_id: "connection-1", path: "Reports", last_visited_at: "2026-01-01T00:00:00Z" }],
          };
        }),
        searchDirectories: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, MOCK_INDEX_RESPONSE_MS));
          return {
            results: ["Reports", "Quarterly Reports"],
            total_matches: 2,
            directory_count: 100_000,
            cache_state: "ready" as const,
            search_contract_version: SEARCH_CONTRACT_VERSION,
          };
        }),
      };
      function DirectoryTimingHarness() {
        const provider = useDirectorySearchProvider("connection-1", vi.fn(), { history, onNavigateDirectory });
        return <UnifiedSearchBar provider={provider} />;
      }
      renderWithProvider(<DirectoryTimingHarness />);
      const input = screen.getByRole("textbox");
      if (inputMode === "incremental") {
        for (const prefix of ["r", "re", "rep"]) {
          fireEvent.change(input, { target: { value: prefix } });
          await act(() => vi.advanceTimersByTimeAsync(INCREMENTAL_KEY_INTERVAL_MS));
        }
      }
      const started = Date.now();
      fireEvent.change(input, { target: { value: "reports" } });
      await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS - 1));
      expect(history.searchDirectories).not.toHaveBeenCalled();
      expect(history.searchRecentDirectories).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1 + MOCK_HISTORY_RESPONSE_MS));
      expect(screen.getAllByRole("option")).toHaveLength(1);
      expect(Date.now() - started).toBe(INPUT_DEBOUNCE_MS + MOCK_HISTORY_RESPONSE_MS);
      await act(() => vi.advanceTimersByTimeAsync(MOCK_INDEX_RESPONSE_MS - MOCK_HISTORY_RESPONSE_MS));
      expect(screen.getAllByRole("option")).toHaveLength(2);
      expect(screen.getByRole("option", { name: /Quarterly Reports/ })).toBeInTheDocument();
      expect(Date.now() - started).toBeLessThanOrEqual(VISIBLE_RESULTS_TARGET_MS);
      expect(history.searchDirectories).toHaveBeenCalledTimes(1);
      expect(history.searchRecentDirectories).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onNavigateDirectory).toHaveBeenCalledWith("connection-1", "Reports", "recent");
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("does not overlap quiet refreshes and gives new input priority over a blocked refresh", async () => {
    vi.useFakeTimers();
    try {
      const stableRows = [{ kind: "result" as const, id: "stable", value: "stable", icon: "directory" as const, primaryText: "Stable" }];
      const freshRows = stableRows.map((row) => ({ ...row, id: "fresh", value: "fresh", primaryText: "Fresh" }));
      let finishRefresh: ((rows: typeof stableRows) => void) | undefined;
      const fetchResults = vi
        .fn<SearchProvider["fetchResults"]>()
        .mockResolvedValueOnce(stableRows)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRefresh = resolve;
            })
        )
        .mockResolvedValue(freshRows);
      renderWithProvider(
        <UnifiedSearchBar
          provider={{
            ...testProvider,
            minQueryLength: 1,
            debounceMs: INPUT_DEBOUNCE_MS,
            fetchResults,
            getRefreshIntervalMs: () => QUIET_REFRESH_INTERVAL_MS,
          }}
        />
      );
      const input = screen.getByPlaceholderText("Search");
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "stable" } });
      await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS));
      expect(fetchResults).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS - 1));
      expect(fetchResults).toHaveBeenCalledTimes(1);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(fetchResults).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS * 3));
      expect(fetchResults).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      expect(screen.getByText("Stable")).toBeInTheDocument();
      const refreshSignal = fetchResults.mock.calls[1]?.[1];
      fireEvent.change(input, { target: { value: "fresh" } });
      expect(refreshSignal?.aborted).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS - 1));
      expect(fetchResults).toHaveBeenCalledTimes(2);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(fetchResults).toHaveBeenCalledTimes(3);
      expect(fetchResults.mock.lastCall?.[0]).toBe("fresh");
      expect(screen.getByText("Fresh")).toBeInTheDocument();
      await act(async () => finishRefresh?.(stableRows));
      expect(screen.queryByText("Stable")).not.toBeInTheDocument();
      expect(screen.getByText("Fresh")).toBeInTheDocument();
      expect(document.activeElement).toBe(input);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("refreshes without a foreground spinner and stops after dismissal", async () => {
    const fetchResults = vi.fn(async () => [
      { kind: "result" as const, id: "stable", value: "stable", icon: "directory" as const, primaryText: "Stable" },
    ]);
    render(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={{ ...testProvider, fetchResults, getRefreshIntervalMs: () => 500 }} />
      </SambeeThemeProvider>
    );
    const input = screen.getByPlaceholderText("Search");
    fireEvent.change(input, { target: { value: "stable" } });
    await waitFor(() => expect(fetchResults).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchResults).toHaveBeenCalledTimes(2), { timeout: 1200 });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Stable")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(fetchResults).toHaveBeenCalledTimes(2);
  });

  it.each(["", "reports"])("restarts recovery when a dismissed query '%s' is focused again", async (query) => {
    vi.useFakeTimers();
    try {
      const fetchResults = vi
        .fn<SearchProvider["fetchResults"]>()
        .mockResolvedValue([{ kind: "result", id: "stable", value: "stable", icon: "directory", primaryText: "Stable" }]);
      const onActivate = vi.fn();
      renderWithProvider(
        <UnifiedSearchBar
          provider={{
            ...testProvider,
            minQueryLength: query ? 1 : 0,
            fetchResults,
            onActivate,
            getRefreshIntervalMs: () => QUIET_REFRESH_INTERVAL_MS,
          }}
        />
      );
      const input = screen.getByPlaceholderText("Search");
      await act(async () => input.focus());
      if (query) {
        fireEvent.change(input, { target: { value: query } });
        await act(() => vi.advanceTimersByTimeAsync(INPUT_DEBOUNCE_MS));
      }
      expect(fetchResults).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(input, { key: "Escape" });
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS * 2));
      expect(fetchResults).toHaveBeenCalledTimes(1);
      act(() => input.blur());
      await act(async () => input.focus());
      expect(onActivate).toHaveBeenCalledTimes(2);
      expect(fetchResults).toHaveBeenCalledTimes(2);
      expect(fetchResults.mock.lastCall?.[0]).toBe(query);
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS));
      expect(fetchResults).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("pauses hidden-tab work, resumes once, and cancels refresh on unmount", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      const rows = [{ kind: "result" as const, id: "stable", value: "stable", icon: "directory" as const, primaryText: "Stable" }];
      let finishHiddenRequest: ((results: typeof rows) => void) | undefined;
      const fetchResults = vi
        .fn<SearchProvider["fetchResults"]>()
        .mockResolvedValueOnce(rows)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishHiddenRequest = resolve;
            })
        )
        .mockResolvedValue(rows);
      const { unmount } = renderWithProvider(
        <UnifiedSearchBar provider={{ ...testProvider, fetchResults, getRefreshIntervalMs: () => QUIET_REFRESH_INTERVAL_MS }} />
      );
      const input = screen.getByPlaceholderText("Search");
      fireEvent.change(input, { target: { value: "stable" } });
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS));
      expect(fetchResults).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(fetchResults.mock.calls[1]?.[1].aborted).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS * 3));
      expect(fetchResults).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
      visibility.mockReturnValue("visible");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(fetchResults).toHaveBeenCalledTimes(3);
      await act(async () => finishHiddenRequest?.(rows.map((row) => ({ ...row, primaryText: "Obsolete" }))));
      expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
      expect(screen.getByText("Stable")).toBeInTheDocument();
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS * 3));
      expect(fetchResults).toHaveBeenCalledTimes(3);
    } finally {
      cleanup();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rejects old-source publications and cancels in-flight work on source replacement", async () => {
    vi.useFakeTimers();
    try {
      const oldRows = [{ kind: "result" as const, id: "old", value: "old", icon: "directory" as const, primaryText: "Old source" }];
      const newRows = oldRows.map((row) => ({ ...row, id: "new", value: "new", primaryText: "New source" }));
      let finishOld: ((rows: typeof oldRows) => void) | undefined;
      let publishOld: SearchResultsUpdate | undefined;
      const onDeactivate = vi.fn();
      const oldFetch = vi.fn<SearchProvider["fetchResults"]>().mockImplementation(
        (_query, _signal, onUpdate) =>
          new Promise((resolve) => {
            publishOld = onUpdate;
            finishOld = resolve;
          })
      );
      const oldProvider = { ...testProvider, sourceKey: "old-source", minQueryLength: 1, fetchResults: oldFetch, onDeactivate };
      const newFetch = vi.fn<SearchProvider["fetchResults"]>().mockResolvedValue(newRows);
      const newProvider = { ...oldProvider, sourceKey: "new-source", fetchResults: newFetch };
      const { rerender } = renderWithProvider(<UnifiedSearchBar provider={oldProvider} />);
      const input = screen.getByPlaceholderText("Search");
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "old" } });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(oldFetch).toHaveBeenCalledTimes(1);
      rerender(
        <SambeeThemeProvider>
          <UnifiedSearchBar provider={newProvider} />
        </SambeeThemeProvider>
      );
      expect(oldFetch.mock.calls[0]?.[1].aborted).toBe(true);
      expect(onDeactivate).toHaveBeenCalledTimes(1);
      expect(input).toHaveValue("");
      fireEvent.change(input, { target: { value: "new" } });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("New source")).toBeInTheDocument();
      await act(async () => {
        publishOld?.(oldRows);
        finishOld?.(oldRows);
      });
      expect(screen.queryByText("Old source")).not.toBeInTheDocument();
      expect(screen.getByText("New source")).toBeInTheDocument();
      expect(document.activeElement).toBe(input);
      await act(() => vi.advanceTimersByTimeAsync(QUIET_REFRESH_INTERVAL_MS * 3));
      expect(oldFetch).toHaveBeenCalledTimes(1);
      expect(newFetch).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("keeps accepted rows and stops refresh after a quiet request fails", async () => {
    const fetchResults = vi
      .fn()
      .mockResolvedValueOnce([{ kind: "result", id: "stable", value: "stable", icon: "directory", primaryText: "Stable" }])
      .mockRejectedValue(new Error("offline"));
    render(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={{ ...testProvider, fetchResults, getRefreshIntervalMs: () => 500 }} />
      </SambeeThemeProvider>
    );
    fireEvent.change(screen.getByPlaceholderText("Search"), { target: { value: "stable" } });
    await waitFor(() => expect(fetchResults).toHaveBeenCalledTimes(2), { timeout: 1200 });
    expect(screen.getByText("Stable")).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(fetchResults).toHaveBeenCalledTimes(2);
  });

  afterEach(async () => {
    cleanup();
    virtualizerSizeCache.clear();
    virtualizerScrollToOffset.mockClear();
    await setLocale("en");
  });

  it("uses the compact mode label size", () => {
    renderWithProvider(<UnifiedSearchBar provider={noResultsProvider} modeOptions={modeOptions} useCompactLayout />);

    expect(screen.getByText("Navigate")).toHaveStyle({ fontSize: "14px" });
  });

  it("uses translated clear-search aria label", async () => {
    const user = userEvent.setup();
    const onQueryValueChange = vi.fn();
    await setLocale("en-XA");

    renderWithProvider(
      <UnifiedSearchBar provider={testProvider} queryValue="abc" onQueryValueChange={onQueryValueChange} disableDropdown={true} />
    );

    const clearButton = screen.getByRole("button", { name: "[Ćĺéåŕ šéåŕćħ]" });
    expect(clearButton).toBeInTheDocument();

    await user.click(clearButton);

    expect(onQueryValueChange).toHaveBeenCalledWith("");
  });

  it("uses translated no-results copy", async () => {
    const user = userEvent.setup();
    await setLocale("en-XA");

    renderWithProvider(<UnifiedSearchBar provider={noResultsProvider} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await user.type(searchInput, "abc");

    expect(screen.getByText(translate("fileBrowser.search.results.none", { query: "abc" }))).toBeInTheDocument();
  });

  it("does not open a loading popup for an empty initial search", async () => {
    const user = userEvent.setup();
    const fetchResults = vi.fn(() => new Promise<never>(() => undefined));
    const loadingProvider: SearchProvider = {
      ...noResultsProvider,
      id: "loading-provider",
      fetchResults,
      getStatusInfo: () => ({ label: "Loading history", showSpinner: true }),
    };

    renderWithProvider(<UnifiedSearchBar provider={loadingProvider} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);

    await waitFor(() => {
      expect(fetchResults).toHaveBeenCalledWith("", expect.any(AbortSignal), expect.any(Function));
    });
    expect(screen.queryByText("Loading history")).not.toBeInTheDocument();
  });

  it("opens status details by pointer without changing the query or list selection", async () => {
    const user = userEvent.setup();
    const loadDetails = vi.fn(async () => ({
      source: "FS1",
      issues: [{ path: "private", code: "access_denied" as const }],
      incomplete: true,
    }));
    const status = { label: "FS1: not all directories could be indexed.", showSpinner: false, loadDetails };
    renderWithProvider(<UnifiedSearchBar provider={{ ...footerProvider, getStatusInfo: () => status }} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "reports");
    const link = await screen.findByRole("link", { name: "details" });
    expect(link.parentElement).toHaveTextContent("FS1: not all directories could be indexed (details).");
    expect(link).toHaveAttribute("tabindex", "-1");
    expect(link.querySelector("svg")).toBeNull();
    expect(loadDetails).not.toHaveBeenCalled();
    const selection = input.getAttribute("aria-activedescendant");
    await user.click(link);
    expect(await screen.findByRole("dialog", { name: "Directory Search Status" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(await screen.findByText("private")).toBeInTheDocument();
    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Affected locations" })).toBeInTheDocument();
    expect(screen.getByText("Containing directory")).toBeInTheDocument();
    expect(screen.getByText("Only a sample of affected locations is shown. More directories may be affected.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("reports");
    expect(input.getAttribute("aria-activedescendant")).toBe(selection);
    expect(screen.getByRole("option", { name: "Documents" })).toBeInTheDocument();
  });

  it.each(["stale", "failed"])("shows %s details without losing the quick-bar query", async (outcome) => {
    const user = userEvent.setup();
    const status = {
      label: "FS1: not all directories could be indexed.",
      showSpinner: false,
      loadDetails:
        outcome === "stale"
          ? async () => ({ source: "FS1", issues: [] })
          : async () => {
              throw new Error("Disconnected");
            },
    };
    renderWithProvider(<UnifiedSearchBar provider={{ ...footerProvider, getStatusInfo: () => status }} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "reports");
    await user.click(await screen.findByRole("link", { name: "details" }));
    const message =
      outcome === "stale"
        ? "These details are no longer available. Refresh the status."
        : "Could not load status details. Check the source connection and reopen this dialog.";
    expect(await screen.findByText(message)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("reports");
  });

  it("leaves statuses without additional information as plain text", async () => {
    const user = userEvent.setup();
    const status = { label: "FS1: not all directories could be indexed.", showSpinner: false };
    renderWithProvider(<UnifiedSearchBar provider={{ ...footerProvider, getStatusInfo: () => status }} />);
    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "reports");
    expect(await screen.findByText(status.label)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    await user.click(screen.getByText(status.label));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("publishes selectable rows before the final response and rejects old-query updates", async () => {
    const user = userEvent.setup();
    const updates = new Map<string, SearchResultsUpdate>();
    const provider: SearchProvider = {
      ...testProvider,
      fetchResults: async (query, _signal, onUpdate) => {
        if (onUpdate) updates.set(query, onUpdate);
        return new Promise<never>(() => undefined);
      },
    };
    renderWithProvider(<UnifiedSearchBar provider={provider} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "a");
    await waitFor(() => expect(updates.has("a")).toBe(true));
    act(() =>
      updates.get("a")?.([{ kind: "result", id: "history", value: "history", icon: "recent-directory", primaryText: "Available history" }])
    );
    expect(await screen.findByRole("option", { name: "Available history" })).toBeInTheDocument();
    await user.type(input, "b");
    act(() => updates.get("a")?.([{ kind: "result", id: "stale", value: "stale", icon: "directory", primaryText: "Stale result" }]));
    expect(screen.queryByRole("option", { name: "Stale result" })).not.toBeInTheDocument();
  });

  it("preserves the selected value when a complete-array update inserts a row", async () => {
    const user = userEvent.setup();
    let update: SearchResultsUpdate | undefined;
    const onSelect = vi.fn();
    const provider: SearchProvider = {
      ...testProvider,
      onSelect,
      fetchResults: async (_query, _signal, onUpdate) => {
        update = onUpdate;
        return new Promise<never>(() => undefined);
      },
    };
    const selected = {
      kind: "result" as const,
      id: "history",
      value: "history",
      icon: "recent-directory" as const,
      primaryText: "History",
    };
    renderWithProvider(<UnifiedSearchBar provider={provider} />);
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.type(input, "a");
    await waitFor(() => expect(update).toBeTypeOf("function"));
    act(() => update?.([selected]));
    await screen.findByRole("option", { name: "History" });
    act(() => update?.([{ kind: "result", id: "new", value: "new", icon: "directory", primaryText: "New directory" }, selected]));
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("history", "associated-viewer");
  });

  it("hides shortcut hints without hiding footer information", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={footerProvider} showKeyboardHints={false} />);

    await user.click(screen.getByRole("textbox"));

    expect(await screen.findByText("1 result")).toBeInTheDocument();
    expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
  });

  it("hides shortcut hints while retaining footer information in compact layout", async () => {
    const user = userEvent.setup();
    const provider = { ...createGroupedProvider(vi.fn()), footerHint: "Keyboard shortcuts" };

    renderWithProvider(<UnifiedSearchBar provider={provider} useCompactLayout />);

    await user.click(screen.getByRole("textbox"));

    expect(await screen.findByText("2 results")).toBeInTheDocument();
    expect(screen.queryByText("Keyboard shortcuts")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent files" })).toHaveStyle({ fontSize: "14px" });
    expect(screen.getByText("Quarterly report")).toHaveStyle({ fontSize: "16px", lineHeight: "1.25" });
  });

  it("shows a retryable error instead of no-results when a search request fails", async () => {
    const user = userEvent.setup();
    const failingProvider: SearchProvider = {
      ...noResultsProvider,
      fetchResults: async () => Promise.reject(new Error("backend unavailable")),
    };

    renderWithProvider(<UnifiedSearchBar provider={failingProvider} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await user.type(searchInput, "report");

    expect(await screen.findByRole("alert")).toHaveTextContent("Search could not be completed. Try again.");
    expect(screen.queryByText('No results found for "report"')).not.toBeInTheDocument();
  });

  it("shows a shared error when removing a recent item fails", async () => {
    const user = userEvent.setup();
    const failingRemovalProvider: SearchProvider = {
      ...resultsProvider,
      id: "failing-removal-provider",
      onRemoveSelected: async () => Promise.reject(new Error("history unavailable")),
    };

    renderWithProvider(<UnifiedSearchBar provider={failingRemovalProvider} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await screen.findByRole("option", { name: "Docs" });
    await user.keyboard("{Shift>}{Delete}{/Shift}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove this recent item. Try again.");
    expect(searchInput).toHaveFocus();
  });

  it.each([
    ["{Enter}", "associated-viewer"],
    ["{Shift>}{Enter}{/Shift}", "force-viewer-picker"],
    ["{Control>}{Enter}{/Control}", "associated-native-app"],
    ["{Control>}{Alt>}{Enter}{/Alt}{/Control}", "force-native-picker"],
  ] as const)("dispatches %s with the %s File Search action", async (keySequence, expectedAction) => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProvider(<UnifiedSearchBar provider={createSelectableProvider(onSelect)} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await user.type(searchInput, "q");
    await screen.findByRole("option", { name: "Quarterly report" });
    await user.keyboard(keySequence);

    expect(onSelect).toHaveBeenCalledWith("file-1", expectedAction);
  });

  it("gives Ctrl+Alt click precedence over the native-app action", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProvider(<UnifiedSearchBar provider={createSelectableProvider(onSelect)} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await user.type(searchInput, "q");
    const result = await screen.findByRole("option", { name: "Quarterly report" });
    fireEvent.click(result, { ctrlKey: true, altKey: true });

    expect(onSelect).toHaveBeenCalledWith("file-1", "force-native-picker");
  });

  it("uses compact, non-selectable group labels and shared result presentation", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    renderWithProvider(<UnifiedSearchBar provider={createGroupedProvider(onSelect)} />);

    await user.click(screen.getByRole("textbox"));

    expect(await screen.findByRole("heading", { name: "Recent files" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current directory" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("2 results")).toBeInTheDocument();
    expect(screen.queryByText("4 results")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Quarterly report Demo:/Reports" })).toHaveTextContent("Quarterly report");
    expect(screen.getByTestId("HistoryOutlinedIcon")).toBeInTheDocument();
    expect(screen.queryByText(/^Recent -/)).not.toBeInTheDocument();
    expect(getQuickBarResultRowHeight({ kind: "group-header", id: "header", value: "", label: "Group" })).toBe(
      QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT
    );
    expect(getQuickBarResultRowHeight({ kind: "result", id: "item", value: "item", icon: "file", primaryText: "Item" })).toBe(
      QUICK_BAR_RESULT_ITEM_HEIGHT
    );

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onSelect).toHaveBeenCalledWith("current-file", "associated-viewer");
  });

  it("keeps group header spacing correct when removing a recent item", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={createRemovableGroupedProvider()} />);

    await user.click(screen.getByRole("textbox"));
    await screen.findByRole("option", { name: "First recent file" });
    await user.keyboard("{Shift>}{Delete}{/Shift}");

    const currentDirectoryHeader = await screen.findByRole("heading", { name: "Current directory" });
    expect(currentDirectoryHeader.parentElement?.parentElement).toHaveStyle({ transform: "translateY(88px)" });
  });

  it("closes the dropdown when tab moves focus away", async () => {
    const user = userEvent.setup();

    renderWithProvider(
      <>
        <UnifiedSearchBar provider={resultsProvider} />
        <button type="button">Next focus target</button>
      </>
    );

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);

    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.tab();

    expect(screen.getByRole("button", { name: "Next focus target" })).toHaveFocus();
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  it("returns focus to the quick-bar input when Escape is pressed on the mode button", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={noResultsProvider} modeOptions={modeOptions} />);

    const searchInput = screen.getByRole("textbox");
    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });

    modeButton.focus();
    expect(modeButton).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(searchInput).toHaveFocus();
    });
  });

  it("describes the quick-bar mode selector", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={noResultsProvider} modeOptions={modeOptions} />);

    await user.hover(screen.getByRole("button", { name: "Switch quick bar mode" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Switch quick bar mode");
  });

  it("supports arrow navigation in the mode menu after clicking from File Search with typed input", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={fileSearchProvider} modeOptions={modeOptions} disableDropdown={true} />);

    const searchInput = screen.getByRole("textbox");
    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });

    await user.click(searchInput);
    await user.type(searchInput, "s");
    await user.click(modeButton);

    await screen.findByRole("menuitem", { name: "File Search" });

    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Commands" })).toHaveFocus();
    });

    await user.keyboard("{ArrowUp}");

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "File Search" })).toHaveFocus();
    });
  });

  it("closes the quick-bar dropdown when clicking the mode button to open the mode menu", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={resultsProvider} modeOptions={modeOptions} />);

    const searchInput = screen.getByRole("textbox");
    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });

    await user.click(searchInput);

    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.click(modeButton);

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  it("keeps the dropdown open when activation switches the focused quick bar into commands mode", async () => {
    const user = userEvent.setup();

    const { rerender } = renderWithProvider(<UnifiedSearchBar provider={resultsProvider} activationToken={0} modeOptions={modeOptions} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);

    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={commandsProvider} activationToken={1} modeOptions={modeOptions} />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  it("fetches file history when the source updates during first activation", async () => {
    const searchRecentFiles = vi.spyOn(browserHistoryService, "searchRecentFiles").mockResolvedValue({ results: [], result_limit: 50 });
    const initialFiles: FileEntry[] = [];
    const loadedFiles = [{ name: "report.txt", type: FileType.FILE }] as FileEntry[];
    function SearchHarness({ active }: { active: boolean }) {
      const fileProvider = useFileSearchProvider({
        connectionId: "connection-1",
        currentPath: "",
        files: active ? loadedFiles : initialFiles,
        connectionName: "Demo",
        resultLimit: 50,
        getConnectionName: () => "Demo",
        onOpenCurrentFile: vi.fn(),
        onOpenRecentFile: vi.fn(),
      });
      return <UnifiedSearchBar provider={active ? fileProvider : resultsProvider} activationToken={active ? 1 : 0} />;
    }
    const { rerender } = renderWithProvider(<SearchHarness active={false} />);

    rerender(
      <SambeeThemeProvider>
        <SearchHarness active />
      </SambeeThemeProvider>
    );
    await act(async () => screen.getByRole("textbox").focus());

    expect(await screen.findByRole("option", { name: /report.txt/ })).toBeInTheDocument();
    expect(searchRecentFiles).toHaveBeenCalledTimes(1);
  });

  it("waits for file history before opening the initial file-search menu", async () => {
    const user = userEvent.setup();
    let releaseHistory = () => {};
    vi.spyOn(browserHistoryService, "searchRecentFiles").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHistory = () => resolve({ results: [], result_limit: 50 });
        })
    );
    const files = [{ name: "report.txt", type: FileType.FILE }] as FileEntry[];
    function SearchHarness() {
      const provider = useFileSearchProvider({
        connectionId: "connection-1",
        currentPath: "",
        files,
        connectionName: "Demo",
        resultLimit: 50,
        getConnectionName: () => "Demo",
        onOpenCurrentFile: vi.fn(),
        onOpenRecentFile: vi.fn(),
      });
      return <UnifiedSearchBar provider={provider} />;
    }
    renderWithProvider(<SearchHarness />);

    await user.click(screen.getByRole("textbox"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await act(async () => releaseHistory());
    expect(await screen.findByRole("option", { name: /report.txt/ })).toBeInTheDocument();
  });

  it("starts one search when shortcut activation is followed by input focus", async () => {
    const fetchResults = vi.fn<SearchProvider["fetchResults"]>(() => new Promise<[]>(() => {}));
    const onActivate = vi.fn();
    const provider = { ...resultsProvider, fetchResults, onActivate };
    const { rerender } = renderWithProvider(<UnifiedSearchBar provider={provider} activationToken={0} />);

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={provider} activationToken={1} />
      </SambeeThemeProvider>
    );
    await act(async () => screen.getByRole("textbox").focus());

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(fetchResults).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.invocationCallOrder[0]).toBeLessThan(fetchResults.mock.invocationCallOrder[0] ?? 0);
    expect(fetchResults.mock.calls[0]?.[1]?.aborted).toBe(false);
  });

  it.each(["suppressDropdown", "disableDropdown"] as const)("preserves the query when %s is cleared", async (prop) => {
    const user = userEvent.setup();
    const fetchResults = vi.fn<SearchProvider["fetchResults"]>(async (query) => [
      {
        kind: "result",
        id: query || "all-commands",
        value: query || "all-commands",
        icon: "command",
        primaryText: query || "All commands",
      },
    ]);
    const provider = { ...commandsProvider, fetchResults };
    const { rerender } = renderWithProvider(<UnifiedSearchBar provider={provider} />);

    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "rename");
    expect(await screen.findByRole("option", { name: "rename" })).toBeInTheDocument();

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={provider} {...{ [prop]: true }} />
      </SambeeThemeProvider>
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fetchResults.mockClear();

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={provider} {...{ [prop]: false }} />
      </SambeeThemeProvider>
    );

    expect(await screen.findByRole("option", { name: "rename" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("rename");
    expect(fetchResults).toHaveBeenCalledTimes(1);
    expect(fetchResults.mock.calls[0]?.[0]).toBe("rename");
  });

  it.each([
    { grouped: false, shortcut: true, close: true },
    { grouped: true, shortcut: true, close: true },
    { grouped: false, shortcut: false, close: true },
    { grouped: true, shortcut: false, close: true },
    { grouped: false, shortcut: true, close: false },
    { grouped: true, shortcut: true, close: false },
  ])("resets results on activation (grouped: $grouped, shortcut: $shortcut, close: $close)", async ({ grouped, shortcut, close }) => {
    const user = userEvent.setup();
    const groupedProvider = createGroupedProvider(vi.fn());
    const provider = {
      ...groupedProvider,
      fetchResults: async (query: string, signal: AbortSignal) =>
        (await groupedProvider.fetchResults(query, signal)).filter((result) => grouped || result.kind === "result"),
    };
    const { rerender } = renderWithProvider(<UnifiedSearchBar provider={provider} activationToken={0} />);
    const searchInput = screen.getByRole("textbox");

    await user.click(searchInput);
    expect(await screen.findByRole("option", { name: /Quarterly report/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: /Annual report/ })).toHaveAttribute("aria-selected", "true");
    if (close) {
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    }
    virtualizerScrollToOffset.mockClear();

    if (shortcut) {
      rerender(
        <SambeeThemeProvider>
          <UnifiedSearchBar provider={provider} activationToken={1} />
        </SambeeThemeProvider>
      );
    } else {
      fireEvent.blur(searchInput);
      fireEvent.focus(searchInput);
    }

    expect(await screen.findByRole("option", { name: /Quarterly report/ })).toHaveAttribute("aria-selected", "true");
    expect(virtualizerScrollToOffset).toHaveBeenCalledWith(0);
  });

  it("reopens the commands dropdown when the same mode is reactivated from outside the quick bar", async () => {
    const user = userEvent.setup();

    const { rerender } = renderWithProvider(
      <>
        <UnifiedSearchBar provider={commandsProvider} activationToken={0} modeOptions={modeOptions} />
        <button type="button">File list focus target</button>
      </>
    );

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    const outsideTarget = screen.getByRole("button", { name: "File list focus target" });
    await user.click(outsideTarget);
    expect(outsideTarget).toHaveFocus();

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={commandsProvider} activationToken={1} modeOptions={modeOptions} />
        <button type="button">File list focus target</button>
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  it("refreshes results without reopening a dismissed dropdown", async () => {
    const user = userEvent.setup();
    const fetchResults = vi.fn(resultsProvider.fetchResults);
    const provider = { ...resultsProvider, fetchResults };
    const { rerender } = renderWithProvider(<UnifiedSearchBar provider={provider} refreshToken={0} />);

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    const callsBeforeRefresh = fetchResults.mock.calls.length;

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={provider} refreshToken={1} />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(fetchResults).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
    });
    expect(searchInput).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("preserves the navigate query when the same mode is reactivated from outside the quick bar", async () => {
    const user = userEvent.setup();

    const { rerender } = renderWithProvider(
      <>
        <UnifiedSearchBar provider={resultsProvider} activationToken={0} modeOptions={modeOptions} />
        <button type="button">Outside focus target</button>
      </>
    );

    const searchInput = screen.getByRole("textbox");
    await user.click(searchInput);
    await user.type(searchInput, "ab");

    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(searchInput).toHaveValue("ab");

    const outsideTarget = screen.getByRole("button", { name: "Outside focus target" });
    await user.click(outsideTarget);
    expect(outsideTarget).toHaveFocus();

    rerender(
      <SambeeThemeProvider>
        <UnifiedSearchBar provider={resultsProvider} activationToken={1} modeOptions={modeOptions} />
        <button type="button">Outside focus target</button>
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveValue("ab");
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
  });

  it("supports arrow navigation in the mode menu after opening with Space from the focused mode button", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={fileSearchProvider} modeOptions={modeOptions} disableDropdown={true} />);

    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });
    modeButton.focus();

    await user.keyboard("{Space}");

    await screen.findByRole("menuitem", { name: "File Search" });

    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Commands" })).toHaveFocus();
    });

    await user.keyboard("{ArrowUp}");

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "File Search" })).toHaveFocus();
    });
  });

  it("opens the mode menu with ArrowDown from the focused mode button", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={fileSearchProvider} modeOptions={modeOptions} disableDropdown={true} />);

    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });
    modeButton.focus();

    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "File Search" })).toHaveFocus();
    });

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("does not open the mode menu with Ctrl+ArrowDown from the focused mode button", async () => {
    const user = userEvent.setup();

    renderWithProvider(<UnifiedSearchBar provider={fileSearchProvider} modeOptions={modeOptions} disableDropdown={true} />);

    const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });
    modeButton.focus();

    await user.keyboard("{Control>}{ArrowDown}{/Control}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "File Search" })).not.toBeInTheDocument();
  });
});
