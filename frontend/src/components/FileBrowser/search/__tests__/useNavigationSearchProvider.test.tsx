import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../../i18n";
import type { SearchProvider } from "../types";
import { useNavigationSearchProvider } from "../useNavigationSearchProvider";

function provider(value: string): SearchProvider {
  return {
    id: value,
    placeholder: "",
    debounceMs: 0,
    minQueryLength: 0,
    fetchResults: vi.fn().mockResolvedValue([{ kind: "result", id: value, value, primaryText: value, icon: "directory" }]),
    onSelect: vi.fn(),
    getStatusInfo: () => null,
  };
}

describe("useNavigationSearchProvider", () => {
  it.each([
    ["all", true, true],
    ["directories", true, false],
    ["files", false, true],
  ] as const)("selects providers for %s", async (itemType, useDirectories, useFiles) => {
    const directories = provider("directory");
    const files = provider("file");
    const { result } = renderHook(() => useNavigationSearchProvider(directories, files, itemType));
    let rows: Awaited<ReturnType<SearchProvider["fetchResults"]>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("query", new AbortController().signal);
    });
    expect(directories.fetchResults).toHaveBeenCalledTimes(Number(useDirectories));
    expect(files.fetchResults).toHaveBeenCalledTimes(Number(useFiles));
    expect(rows.filter((row) => row.kind === "result").map((row) => row.value)).toEqual([
      ...(useDirectories ? ["directories:directory"] : []),
      ...(useFiles ? ["files:file"] : []),
    ]);
    if (useFiles) {
      result.current.onSelect("files:file", "force-viewer-picker");
      expect(files.onSelect).toHaveBeenCalledWith("file", "force-viewer-picker");
    }
  });

  it("interleaves history by last use and gives a stronger typed match priority over recency", async () => {
    const directories = provider("directory");
    const files = provider("file");
    vi.mocked(directories.fetchResults).mockResolvedValue([
      { kind: "group-header", id: "dirs", value: "", label: "Recent directories" },
      { kind: "result", id: "dir", value: "dir", primaryText: "Notes", icon: "recent-directory", matchRank: 0, lastUsedAt: "2026-11-20" },
      {
        kind: "result",
        id: "older",
        value: "older",
        primaryText: "Old notes",
        icon: "recent-directory",
        matchRank: 2,
        lastUsedAt: "2026-11-18",
      },
    ]);
    vi.mocked(files.fetchResults).mockResolvedValue([
      { kind: "result", id: "file", value: "file", primaryText: "Notes.pdf", icon: "recent-file", matchRank: 1, lastUsedAt: "2026-11-21" },
    ]);
    const { result } = renderHook(() => useNavigationSearchProvider(directories, files, "all"));
    await act(async () => {
      const recent = await result.current.fetchResults("", new AbortController().signal);
      expect(recent[0]).toMatchObject({ kind: "group-header", label: "Recent files and folders" });
      expect(recent.map((row) => row.value)).toEqual(["", "files:file", "directories:dir", "directories:older"]);
      const matches = await result.current.fetchResults("notes", new AbortController().signal);
      expect(matches[0]).toMatchObject({ kind: "group-header", label: "Matches" });
      expect(matches.map((row) => row.value)).toEqual(["", "directories:dir", "files:file", "directories:older"]);
    });
  });

  it.each(["asynchronous", "synchronous"])("keeps the other provider's results after a %s failure", async (failure) => {
    const directories = provider("directory");
    const files = provider("file");
    if (failure === "asynchronous") vi.mocked(files.fetchResults).mockRejectedValue(new Error("offline"));
    else
      vi.mocked(files.fetchResults).mockImplementation(() => {
        throw new Error("offline");
      });
    const { result } = renderHook(() => useNavigationSearchProvider(directories, files, "all"));
    let rows: Awaited<ReturnType<SearchProvider["fetchResults"]>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("query", new AbortController().signal);
    });
    expect(rows.filter((row) => row.kind === "result").map((row) => row.value)).toEqual(["directories:directory"]);
    expect(result.current.getStatusInfo()?.label).toContain("Search could not be completed");
  });
});
