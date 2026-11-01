import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../../i18n";
import api from "../../../../services/api";
import { SambeeThemeProvider } from "../../../../theme/ThemeContext";
import { type FileEntry, FileType } from "../../../../types";
import { rankHistorySearchResults } from "../recentHistory";
import { useFileSearchProvider } from "../useFileSearchProvider";

vi.mock("../../../../services/api");

const files = [
  { name: "annual-report.txt", type: FileType.FILE },
  { name: "report.txt", type: FileType.FILE },
  { name: "summary.txt", type: FileType.FILE },
] as FileEntry[];

function wrapper({ children }: { children: React.ReactNode }) {
  return <SambeeThemeProvider>{children}</SambeeThemeProvider>;
}

describe("useFileSearchProvider", () => {
  it("publishes selectable loaded files before history and keeps them if history fails", async () => {
    let rejectHistory!: (error: Error) => void;
    vi.mocked(api.searchRecentFiles).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHistory = reject;
        })
    );
    const onOpenCurrentFile = vi.fn();
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          files,
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenCurrentFile,
          onOpenRecentFile: vi.fn(),
        }),
      { wrapper }
    );
    const onUpdate = vi.fn();
    let pending!: ReturnType<typeof result.current.fetchResults>;
    act(() => {
      pending = result.current.fetchResults("report", new AbortController().signal, onUpdate);
    });
    expect(onUpdate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ value: "current:report.txt" })]));
    result.current.onSelect("current:report.txt");
    expect(onOpenCurrentFile).toHaveBeenCalledWith(expect.objectContaining({ name: "report.txt" }), "associated-viewer");
    await act(async () => {
      rejectHistory(new Error("offline"));
      await pending;
    });
    expect(await pending).toEqual(onUpdate.mock.calls[0]?.[0]);
    expect(result.current.getStatusInfo()).toEqual({
      label: "Recent files are unavailable. Check the backend connection and retry.",
      showSpinner: false,
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
          files,
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenCurrentFile: vi.fn(),
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

  it("uses normalized Unicode code-point ties before limiting loaded files", async () => {
    vi.mocked(api.searchRecentFiles).mockResolvedValue({ result_limit: 1, results: [] });
    const candidates = [
      { name: "report-\u{10000}.txt", type: FileType.FILE },
      { name: "report-\uE000.txt", type: FileType.FILE },
    ] as FileEntry[];
    const { result } = renderHook(
      () =>
        useFileSearchProvider({
          connectionId: "connection-1",
          currentPath: "Reports",
          files: candidates,
          connectionName: "Reports server",
          resultLimit: 1,
          getConnectionName: () => "Reports server",
          onOpenCurrentFile: vi.fn(),
          onOpenRecentFile: vi.fn(),
        }),
      { wrapper }
    );
    const rows = await result.current.fetchResults("report", new AbortController().signal);
    expect(rows.map((row) => row.value)).toEqual(["current:report-\uE000.txt"]);
  });

  it("ranks exact matches across sources before frequency and preserves empty-query groups", () => {
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
      { kind: "result" as const, id: "exact", value: "current:report", icon: "file" as const, primaryText: "report", matchRank: 0 },
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
  it("keeps recent files first, omits duplicate current items, and preserves selection mode", async () => {
    const onOpenCurrentFile = vi.fn();
    const onOpenRecentFile = vi.fn();
    vi.mocked(api.searchRecentFiles).mockResolvedValue({
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
          files,
          connectionName: "Reports server",
          resultLimit: 10,
          getConnectionName: () => "Reports server",
          onOpenCurrentFile,
          onOpenRecentFile,
        }),
      { wrapper }
    );

    const results = await result.current.fetchResults("report", new AbortController().signal);

    expect(results.map((entry) => ({ kind: entry.kind, value: entry.value }))).toEqual([
      { kind: "result", value: "recent:recent-report" },
      { kind: "result", value: "current:annual-report.txt" },
    ]);

    expect(results).toMatchObject([
      {
        kind: "result",
        icon: "recent-file",
        primaryText: "report.txt",
        primaryHighlight: { start: 0, end: 6 },
        secondaryText: "Reports server:/Reports",
      },
      {
        kind: "result",
        icon: "file",
        primaryText: "annual-report.txt",
        primaryHighlight: { start: 7, end: 13 },
        secondaryText: "Reports server:/Reports",
      },
    ]);

    result.current.onSelect("recent:recent-report", "associated-native-app");
    expect(onOpenRecentFile).toHaveBeenCalledWith(expect.objectContaining({ id: "recent-report" }), "associated-native-app");

    result.current.onSelect("current:annual-report.txt", "force-native-picker");
    expect(onOpenCurrentFile).toHaveBeenCalledWith(expect.objectContaining({ name: "annual-report.txt" }), "force-native-picker");

    await expect(result.current.onRemoveSelected?.("recent:recent-report")).resolves.toBe(true);
    expect(api.removeRecentFile).toHaveBeenCalledWith("recent-report");
    await expect(result.current.onRemoveSelected?.("current:annual-report.txt")).resolves.toBe(false);

    render(
      result.current.getFooterHint?.({
        kind: "result",
        id: "recent-report",
        value: "recent:recent-report",
        icon: "recent-file",
        primaryText: "report.txt",
      })
    );

    expect(screen.getByText("Enter")).toBeInTheDocument();
    expect(screen.getByText("Shift+Enter")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Enter")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+Enter")).toBeInTheDocument();
    expect(screen.getByText("Shift+Del")).toBeInTheDocument();
    expect(screen.queryByText("Shift+Delete")).not.toBeInTheDocument();
  });
});
