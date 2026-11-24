import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../i18n";
import type { FilesystemSearchSession } from "../../../pages/FileBrowser/filesystemSearchSessions";
import { COMPANION_SEARCH_UPDATE_REQUIRED } from "../../../services/filesystemSearchContract";
import { LiveSearchStatus } from "../LiveSearchStatus";

const session: FilesystemSearchSession = {
  id: "run",
  request: {
    version: 1,
    source: { kind: "smb", id: "demo" },
    root: { kind: "directory", path: "" },
    query: "report",
    case_sensitive: false,
    folder_depth: "recursive",
    item_type: "all",
    search_archives: false,
  },
  requestId: null,
  rows: [],
  status: "running",
  terminal: null,
  error: null,
};

describe("live search status", () => {
  it("reports scan state without implying an incomplete scan had no matches", () => {
    const { rerender } = render(<LiveSearchStatus session={session} />);
    expect(screen.getByRole("status")).toHaveTextContent("Searching");
    const counts = { matches: 0, scanned_directories: 1, skipped: 0 };
    rerender(
      <LiveSearchStatus
        session={{ ...session, status: "finished", terminal: { type: "terminal", reason: "time_limit", counts, skips: [] } }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Time limit reached");
    expect(screen.getByRole("status")).not.toHaveTextContent("No matches");
    rerender(
      <LiveSearchStatus
        session={{ ...session, status: "finished", terminal: { type: "terminal", reason: "complete", counts, skips: [] } }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("Search complete.");
  });

  it("keeps details about skipped ZIPs out of the activity summary", () => {
    const { rerender } = render(
      <LiveSearchStatus
        session={{
          ...session,
          status: "finished",
          terminal: {
            type: "terminal",
            reason: "partial_coverage",
            counts: { matches: 0, scanned_directories: 1, skipped: 2 },
            skips: [{ reason: "archive_too_large", count: 2 }],
          },
        }}
      />
    );
    expect(screen.queryByText("2 ZIPs were too large to search.")).not.toBeInTheDocument();
    rerender(<LiveSearchStatus session={{ ...session, status: "interrupted" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Search was interrupted");
    expect(screen.getByRole("status")).not.toHaveTextContent("No matches");
  });

  it.each([
    ["archive_too_large", "Open a smaller ZIP"],
    ["archive_unreadable", "Check access to the ZIP"],
  ] as const)("explains %s for an archive root", (reason, action) => {
    render(
      <LiveSearchStatus
        session={{
          ...session,
          request: { ...session.request, root: { kind: "archive", path: "data.zip", member_path: "" } },
          status: "finished",
          terminal: {
            type: "terminal",
            reason: "source_failure",
            counts: { matches: 0, scanned_directories: 0, skipped: 1 },
            skips: [{ reason, count: 1 }],
          },
        }}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(action);
  });

  it.each([
    [
      { errorCode: "incomplete" as const },
      "Search was interrupted before it finished. Check the source connection and start a new search.",
    ],
    [{ error: "Search capacity is busy. Try again shortly." }, "Search could not start. Search capacity is busy. Try again shortly."],
  ])("shows one recovery message for an interrupted search", (failure, message) => {
    render(<LiveSearchStatus session={{ ...session, status: "interrupted", ...failure }} />);
    expect(screen.getByRole("status").textContent).toBe(message);
  });

  it("offers the local drives update control for an old Companion", () => {
    const openSettings = vi.fn();
    render(
      <LiveSearchStatus
        session={{ ...session, status: "interrupted", error: "Update Companion", errorCode: COMPANION_SEARCH_UPDATE_REQUIRED }}
        onOpenLocalDrivesSettings={openSettings}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("This Companion version does not support live search");
    screen.getByRole("button", { name: "Update Companion" }).click();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
