import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../../i18n";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { getQuickBarResultRowHeight, QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT, QUICK_BAR_RESULT_ITEM_HEIGHT } from "../QuickBarResultRow";
import type { SearchProvider, SearchResultsUpdate } from "../search/types";
import { UnifiedSearchBar } from "../UnifiedSearchBar";

const virtualizerSizeCache = new Map<string | number, number>();

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
  afterEach(async () => {
    cleanup();
    virtualizerSizeCache.clear();
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
