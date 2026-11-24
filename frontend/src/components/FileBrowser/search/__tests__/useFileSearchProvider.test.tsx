import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../../i18n";
import api from "../../../../services/api";
import { SambeeThemeProvider } from "../../../../theme/ThemeContext";
import { FileType } from "../../../../types";
import { rankHistorySearchResults } from "../recentHistory";
import { useFileSearchProvider } from "../useFileSearchProvider";

vi.mock("../../../../services/api");

function wrapper({ children }: { children: React.ReactNode }) {
  return <SambeeThemeProvider>{children}</SambeeThemeProvider>;
}

describe("useFileSearchProvider", () => {
  it("finds and opens a file from the current folder without a history entry", async () => {
    vi.mocked(api.searchRecentFiles).mockResolvedValueOnce({ result_limit: 10, results: [] });
    const file = { name: "image.png", path: "Pictures/image.png", type: FileType.FILE, is_readable: true, is_hidden: false };
    const onOpenFile = vi.fn();
    const onOpenRecentFile = vi.fn();
    const { result } = renderHook(() =>
      useFileSearchProvider({
        connectionId: "connection-1",
        currentPath: "Pictures",
        connectionName: "Pictures server",
        resultLimit: 10,
        getConnectionName: () => "Pictures server",
        onOpenRecentFile,
        currentFolder: { files: [file], onOpenFile },
      })
    );
    await act(async () => {
      const rows = await result.current.fetchResults("image", new AbortController().signal);
      expect(rows).toMatchObject([{ kind: "result", icon: "file", primaryText: "image.png" }]);
      const [match] = rows;
      if (!match) throw new Error("Expected an image.png match");
      result.current.onSelect(match.value, "force-viewer-picker");
      expect(await result.current.onRemoveSelected?.(match.value)).toBe(false);
    });
    expect(onOpenFile).toHaveBeenCalledWith(file, "force-viewer-picker");
    expect(onOpenRecentFile).not.toHaveBeenCalled();
  });

  it("shows a recent file only once and excludes direct files from Subfolders only", async () => {
    const file = { name: "image.png", path: "Pictures/image.png", type: FileType.FILE, is_readable: true, is_hidden: false };
    vi.mocked(api.searchRecentFiles).mockResolvedValueOnce({
      result_limit: 10,
      results: [
        { id: "image", path: file.path, file_name: file.name, connection_id: "connection-1", last_opened_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const { result, rerender } = renderHook(
      ({ descendantsOnly }) =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Pictures",
          connectionName: "Pictures server",
          resultLimit: 10,
          getConnectionName: () => "Pictures server",
          onOpenRecentFile: vi.fn(),
          currentFolder: { files: [file], onOpenFile: vi.fn() },
          historyOptions: descendantsOnly ? { scope: { path: "Pictures", mode: "descendants_only" } } : undefined,
        }),
      { initialProps: { descendantsOnly: false } }
    );
    await act(async () => {
      expect(await result.current.fetchResults("image", new AbortController().signal)).toMatchObject([
        { kind: "result", icon: "recent-file", primaryText: "image.png" },
      ]);
    });
    vi.mocked(api.searchRecentFiles).mockResolvedValue({ result_limit: 10, results: [] });
    rerender({ descendantsOnly: true });
    await act(async () => {
      expect(await result.current.fetchResults("image", new AbortController().signal)).toEqual([]);
    });
    rerender({ descendantsOnly: false });
    await act(async () => {
      expect(await result.current.fetchResults("", new AbortController().signal)).toEqual([]);
    });
  });

  it("requests scoped recent files without publishing folder matches", async () => {
    vi.mocked(api.searchRecentFiles).mockResolvedValueOnce({ result_limit: 10, results: [] });
    const scope = { path: "Reports", mode: "subtree" as const };
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenRecentFile: vi.fn(),
          historyOptions: { connectionId: "connection-1", scope },
        }),
      { wrapper }
    );
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    let rows: Awaited<ReturnType<typeof result.current.fetchResults>> = [];
    await act(async () => {
      rows = await result.current.fetchResults("report", signal, onUpdate);
    });
    expect(rows).toEqual([]);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(api.searchRecentFiles).toHaveBeenLastCalledWith("report", 10, signal, { connectionId: "connection-1", scope });
  });

  it("reports history errors without presenting stale results", async () => {
    vi.mocked(api.searchRecentFiles).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenRecentFile: vi.fn(),
        }),
      { wrapper }
    );
    await act(async () => {
      expect(await result.current.fetchResults("report", new AbortController().signal)).toEqual([]);
    });
    expect(result.current.getStatusInfo()).toMatchObject({
      label: "Reports server: Recent files are unavailable. Check the backend connection and retry.",
      showSpinner: false,
      loadDetails: expect.any(Function),
    });
  });

  it("does not let an older history completion replace a newer selection map", async () => {
    let finishOld!: (response: Awaited<ReturnType<typeof api.searchRecentFiles>>) => void;
    vi.mocked(api.searchRecentFiles).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    vi.mocked(api.searchRecentFiles).mockResolvedValueOnce({
      results: [
        {
          id: "new",
          connection_id: "connection-2",
          path: "summary-new.txt",
          file_name: "summary-new.txt",
          last_opened_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const onOpenRecentFile = vi.fn();
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenRecentFile,
        }),
      { wrapper }
    );
    let oldRequest!: ReturnType<typeof result.current.fetchResults>;
    act(() => {
      oldRequest = result.current.fetchResults("report", new AbortController().signal);
    });
    await act(async () => {
      await result.current.fetchResults("summary", new AbortController().signal);
    });
    await act(async () => {
      finishOld({ results: [] });
      await oldRequest;
    });
    expect(await oldRequest).toEqual([]);
    result.current.onSelect("recent:new");
    expect(onOpenRecentFile).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }), "associated-viewer");
  });

  it("ranks exact matches before frequency and preserves empty-query groups", () => {
    const results = [
      { kind: "group-header" as const, id: "recent", value: "" as const, label: "Recent" },
      {
        kind: "result" as const,
        id: "frequent",
        value: "recent:frequent",
        icon: "recent-file" as const,
        primaryText: "report-final",
        matchRank: 1,
        usageScore: 100,
      },
      { kind: "result" as const, id: "exact", value: "recent:exact", icon: "recent-file" as const, primaryText: "report", matchRank: 0 },
      {
        kind: "result" as const,
        id: "occasional",
        value: "recent:occasional",
        icon: "recent-file" as const,
        primaryText: "report-other",
        matchRank: 1,
        usageScore: 1,
      },
    ];
    expect(rankHistorySearchResults(results, "report").map((result) => result.id)).toEqual(["exact", "frequent", "occasional"]);
    expect(rankHistorySearchResults(results, "")).toBe(results);
  });

  it("opens and removes a recent file with the selected mode", async () => {
    const onOpenRecentFile = vi.fn();
    vi.mocked(api.searchRecentFiles).mockResolvedValueOnce({
      result_limit: 1,
      results: [
        {
          id: "recent-report",
          connection_id: "connection-1",
          path: "Reports/report.txt",
          file_name: "report.txt",
          last_opened_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenRecentFile,
        }),
      { wrapper }
    );
    const results = await result.current.fetchResults("report", new AbortController().signal);
    expect(results).toMatchObject([
      {
        kind: "result",
        value: "recent:recent-report",
        icon: "recent-file",
        primaryText: "report.txt",
        primaryHighlight: { start: 0, end: 6 },
        secondaryText: "Reports server:/Reports",
      },
    ]);
    result.current.onSelect("recent:recent-report", "associated-native-app");
    expect(onOpenRecentFile).toHaveBeenCalledWith(expect.objectContaining({ id: "recent-report" }), "associated-native-app");
    await expect(result.current.onRemoveSelected?.("recent:recent-report")).resolves.toBe(true);
    expect(api.removeRecentFile).toHaveBeenCalledWith("recent-report");
    render(
      result.current.getFooterHint?.({
        kind: "result",
        id: "recent-report",
        value: "recent:recent-report",
        icon: "recent-file",
        primaryText: "report.txt",
      })
    );
    expect(screen.getByText("Shift+Del")).toBeInTheDocument();
  });
});
