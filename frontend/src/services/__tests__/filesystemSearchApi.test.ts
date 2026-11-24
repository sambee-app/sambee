import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../../../shared/filesystem-search/stream-fixtures.json";
import api, { FilesystemSearchStartError } from "../api";
import { authSession } from "../authSession";
import { companionSession } from "../companionSession";
import { COMPANION_SEARCH_UPDATE_REQUIRED, type FilesystemSearchRequest } from "../filesystemSearchContract";

const request: FilesystemSearchRequest = {
  version: 1,
  source: { kind: "smb", id: "connection-1" },
  root: { kind: "directory", path: "" },
  query: "report",
  case_sensitive: false,
  folder_depth: "recursive",
  item_type: "all",
  search_archives: false,
};

function response(records: unknown[]) {
  return new Response(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("file-system search API", () => {
  it("uses the backend bearer token and delivers streamed records without a retry", async () => {
    vi.spyOn(authSession, "getAccessToken").mockReturnValue("session-token");
    const fetch = vi.fn().mockResolvedValue(response(fixtures.stream));
    vi.stubGlobal("fetch", fetch);
    const received = vi.fn();
    const signal = new AbortController().signal;
    await expect(api.startFilesystemSearch(request, signal, received)).resolves.toMatchObject({ reason: "partial_coverage" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/browse/connection-1/filesystem-search"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer session-token", Accept: "application/x-ndjson" }),
        body: JSON.stringify(request),
        signal,
      })
    );
    expect(received).toHaveBeenCalledTimes(3);
  });

  it("signs a Companion request for the paired site and drive", async () => {
    const signing = vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValue({ "X-Companion-Secret": "signed" });
    const fetch = vi.fn().mockResolvedValue(response(fixtures.stream));
    vi.stubGlobal("fetch", fetch);
    const local: FilesystemSearchRequest = { ...request, source: { kind: "local", id: "local-drive:c" } };
    await api.startFilesystemSearch(local, new AbortController().signal, vi.fn());
    expect(signing).toHaveBeenCalledWith("POST", expect.stringContaining("/browse/c/filesystem-search"));
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ "X-Companion-Secret": "signed" }) })
    );
  });

  it("keeps actionable server errors and does not retry them", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: "stopping", message: "The previous search is still stopping. Try again shortly." } }), {
        status: 409,
      })
    );
    vi.stubGlobal("fetch", fetch);
    const failure = await api.startFilesystemSearch(request, new AbortController().signal, vi.fn()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesystemSearchStartError);
    expect(failure).toMatchObject({ status: 409, code: "stopping", detail: expect.stringContaining("still stopping") });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports an older Companion and stops before fetching if already cancelled", async () => {
    vi.spyOn(companionSession, "getSigningHeaders").mockResolvedValue({ "X-Companion-Secret": "signed" });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const local: FilesystemSearchRequest = { ...request, source: { kind: "local", id: "local-drive:c" } };
    await expect(api.startFilesystemSearch(local, new AbortController().signal, vi.fn())).rejects.toMatchObject({
      status: 404,
      code: COMPANION_SEARCH_UPDATE_REQUIRED,
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(api.startFilesystemSearch(local, cancelled.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
