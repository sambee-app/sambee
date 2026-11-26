import { describe, expect, it, vi } from "vitest";
import { FilesystemSearchStartError } from "../../../services/api";
import {
  COMPANION_SEARCH_UPDATE_REQUIRED,
  FILESYSTEM_SEARCH_QUERY_MAX_BYTES,
  type FilesystemSearchItem,
  type FilesystemSearchRecord,
  type FilesystemSearchRequest,
} from "../../../services/filesystemSearchContract";
import { SearchStreamError } from "../../../services/filesystemSearchStream";
import { FileType } from "../../../types";
import { FilesystemSearchSessions, searchResultItem, searchResultLocation } from "../filesystemSearchSessions";

const request: FilesystemSearchRequest = {
  version: 1,
  source: { kind: "smb", id: "demo" },
  root: { kind: "directory", path: "docs" },
  query: " report ",
  case_sensitive: false,
  folder_depth: "recursive",
  item_type: "all",
  search_archives: false,
};

const member = (archive: string): FilesystemSearchItem => ({
  entry: { name: "same.txt", path: "dir/same.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
  target: { kind: "archive", archive_path: archive, member_path: "dir/same.txt" },
  archive_state: "readable",
});

const terminal: Extract<FilesystemSearchRecord, { type: "terminal" }> = {
  type: "terminal",
  reason: "complete",
  counts: { matches: 0, scanned_directories: 1, skipped: 0 },
  skips: [],
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("file-system search sessions", () => {
  it("uses the real archive identity and shows only the parent location", () => {
    const first = member("docs/a.zip");
    const second = member("docs/b.zip");
    expect(searchResultItem("demo", first).key).not.toBe(searchResultItem("demo", second).key);
    expect(searchResultItem("demo", first).handle).toMatchObject({
      kind: "virtual",
      path: "dir/same.txt",
      location: { source: { connectionId: "demo", path: "docs/a.zip" }, path: "dir" },
    });
    expect(searchResultLocation(request, first)).toBe("a.zip/dir");
    expect(searchResultLocation({ ...request, root: { kind: "archive", path: "docs/a.zip", member_path: "" } }, first)).toBe("dir");
    expect(searchResultLocation({ ...request, root: { kind: "archive", path: "docs/a.zip", member_path: "dir" } }, first)).toBe("");
  });

  it.each([
    ["docs/same.txt", ""],
    ["docs/sub/deeper/same.txt", "sub/deeper"],
  ])("shows the physical parent of %s relative to the search root", (path, expected) => {
    const item: FilesystemSearchItem = {
      entry: { name: "same.txt", path, type: FileType.FILE, is_readable: true, is_hidden: false },
      target: { kind: "physical", path },
    };
    expect(searchResultLocation(request, item)).toBe(expected);
  });

  it("keeps independent runs, snapshots their requests, and ignores records after close", async () => {
    const callbacks: ((record: FilesystemSearchRecord) => void | Promise<void>)[] = [];
    const signals: AbortSignal[] = [];
    const run = vi.fn((_request, signal, callback) => {
      signals.push(signal);
      callbacks.push(callback);
      return new Promise<typeof terminal>(() => {});
    });
    const sessions = new FilesystemSearchSessions(run);
    const first = sessions.start(request);
    const secondRequest = { ...request, root: { kind: "directory" as const, path: "other" } };
    const second = sessions.start(secondRequest);
    secondRequest.root.path = "changed";
    await flush();
    expect(sessions.get(second)?.request.root.path).toBe("other");
    callbacks[0]!({ type: "batch", results: [member("docs/a.zip"), member("docs/b.zip")] });
    expect(sessions.get(first)?.rows).toHaveLength(2);
    sessions.close(first);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    callbacks[0]!(terminal);
    expect(sessions.get(first)).toBeUndefined();
    expect(sessions.get(second)?.status).toBe("running");
    sessions.dispose();
    expect(signals[1]?.aborted).toBe(true);
    expect(sessions.get(second)).toBeUndefined();
  });

  it("preserves results when a stream fails and does not report a false completion", async () => {
    const sessions = new FilesystemSearchSessions(async (_request, _signal, publish) => {
      await publish({ type: "batch", results: [member("docs/a.zip")] });
      throw new SearchStreamError("incomplete", "Connection interrupted.");
    });

    const id = sessions.start(request);
    await flush();
    expect(sessions.get(id)).toMatchObject({ status: "interrupted", error: null, errorCode: "incomplete", terminal: null });
    expect(sessions.get(id)?.rows).toHaveLength(1);
    sessions.dispose();
  });

  it("preserves the old Companion error code for the result status", async () => {
    const sessions = new FilesystemSearchSessions(async () => {
      throw new FilesystemSearchStartError("Update Companion", 404, COMPANION_SEARCH_UPDATE_REQUIRED);
    });
    const id = sessions.start({ ...request, source: { kind: "local", id: "local-drive:c" } });
    await flush();
    expect(sessions.get(id)).toMatchObject({ status: "interrupted", errorCode: COMPANION_SEARCH_UPDATE_REQUIRED });
    sessions.dispose();
  });

  it.each([
    ["server text", new FilesystemSearchStartError("Busy.", 503, "search_capacity", "Busy."), "Busy.", undefined],
    ["no server text", new FilesystemSearchStartError("Search could not start (500).", 500), null, "start_failed"],
    ["a network failure", new TypeError("Failed to fetch"), null, undefined],
  ])("keeps only translatable or server-supplied failure details for %s", async (_case, failure, error, errorCode) => {
    const sessions = new FilesystemSearchSessions(async () => {
      throw failure;
    });
    const id = sessions.start(request);
    await flush();
    expect(sessions.get(id)).toMatchObject({ status: "interrupted", error });
    expect(sessions.get(id)?.errorCode).toBe(errorCode);
    sessions.dispose();
  });

  it("does not start a request after its tab closes", async () => {
    const run = vi.fn(async () => terminal);
    const sessions = new FilesystemSearchSessions(run);
    const id = sessions.start(request);
    sessions.close(id);
    await flush();
    expect(run).not.toHaveBeenCalled();
    sessions.dispose();
  });

  it("requires a nonblank query and preserves significant spaces", async () => {
    const run = vi.fn(async (_request, _signal, publish) => {
      await publish(terminal);
      return terminal;
    });
    const sessions = new FilesystemSearchSessions(run);
    expect(() => sessions.start({ ...request, query: "  " })).toThrow();
    expect(() => sessions.start({ ...request, query: "\u001c" })).toThrow();
    expect(() => sessions.start({ ...request, query: "é".repeat(FILESYSTEM_SEARCH_QUERY_MAX_BYTES / 2 + 1) })).toThrow(/too long/i);
    const valid = sessions.start({ ...request, query: "\ufeff" });
    const id = sessions.start(request);
    await flush();
    expect(run.mock.calls[0]?.[0].query).toBe("\ufeff");
    expect(run.mock.calls[1]?.[0].query).toBe(" report ");
    expect(sessions.get(valid)).toMatchObject({ status: "finished" });
    expect(sessions.get(id)).toMatchObject({ status: "finished", terminal: { reason: "complete" } });
    sessions.dispose();
  });
});
