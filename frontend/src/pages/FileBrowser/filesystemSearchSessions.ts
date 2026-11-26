import {
  COMPANION_SEARCH_UPDATE_REQUIRED,
  type FilesystemSearchClientError,
  type FilesystemSearchItem,
  type FilesystemSearchRecord,
  type FilesystemSearchRequest,
  validateFilesystemSearchQuery,
} from "../../services/filesystemSearchContract";
import { FilesystemSearchStartError, startFilesystemSearch } from "../../services/filesystemSearchService";
import { SearchStreamError } from "../../services/filesystemSearchStream";
import { randomUuid } from "../../utils/randomUuid";
import {
  type BrowserItem,
  type ContentItemHandle,
  physicalItem,
  physicalLocation,
  type VirtualItemHandle,
  virtualItem,
  virtualLocation,
} from "./contentProviders";

type Terminal = Extract<FilesystemSearchRecord, { type: "terminal" }>;

export interface FilesystemSearchSession {
  id: string;
  request: FilesystemSearchRequest;
  requestId: string | null;
  rows: FilesystemSearchRow[];
  status: "running" | "finished" | "interrupted";
  terminal: Terminal | null;
  /** Server-supplied failure text, shown as is. */
  error: string | null;
  /** A known failure that has its own translated message. */
  errorCode?: typeof COMPANION_SEARCH_UPDATE_REQUIRED | FilesystemSearchClientError;
}

export interface FilesystemSearchRow {
  item: BrowserItem;
}

type SearchRunner = typeof startFilesystemSearch;

function parentPath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** Result keys identify the source and real target, not a display path or file name. */
export function searchResultItem(connectionId: string, result: FilesystemSearchItem): BrowserItem {
  if (result.target.kind === "physical") {
    const parent = parentPath(result.target.path);
    return physicalItem(physicalLocation(connectionId, parent), { ...result.entry, path: result.target.path });
  }
  const parent = parentPath(result.target.member_path);
  const source = physicalLocation(connectionId, result.target.archive_path);
  return virtualItem(virtualLocation("zip", connectionId, source, parent), {
    ...result.entry,
    path: result.target.member_path,
    archive_entry_state: result.archive_state,
  });
}

/** The parent location relative to the search root, for display only. */
export function searchResultLocation(request: FilesystemSearchRequest, result: FilesystemSearchItem): string {
  const relative = (path: string, root: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  if (result.target.kind === "physical") {
    return parentPath(relative(result.target.path, request.root.path));
  }
  if (request.root.kind === "archive" && result.target.archive_path === request.root.path) {
    return parentPath(relative(result.target.member_path, request.root.member_path));
  }
  const archive = relative(result.target.archive_path, request.root.path);
  const memberParent = parentPath(result.target.member_path);
  return memberParent ? `${archive}/${memberParent}` : archive;
}

/** A gallery has one connection and, for ZIP members, one archive. */
export function isSearchResultFromSource(handle: ContentItemHandle, connectionId: string, virtualSource?: VirtualItemHandle): boolean {
  if (handle.location.connectionId !== connectionId) return false;
  if (handle.kind === "physical") return virtualSource === undefined;
  return (
    virtualSource !== undefined &&
    handle.location.providerId === virtualSource.location.providerId &&
    handle.location.source.path === virtualSource.location.source.path
  );
}

/**
 * Owns independent requests for one browser lifetime. Closing a session or
 * disposing the owner rejects late records even when a transport ignores abort.
 */
export class FilesystemSearchSessions {
  private readonly sessions = new Map<string, FilesystemSearchSession>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly run: SearchRunner = startFilesystemSearch) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(id: string): FilesystemSearchSession | undefined {
    return this.sessions.get(id);
  }

  start(request: FilesystemSearchRequest): string {
    if (this.disposed) throw new Error("The search session is closed. Open the browser and try again.");
    const queryError = validateFilesystemSearchQuery(request.query);
    if (queryError === "empty") throw new Error("Enter a name or pattern to search.");
    if (queryError === "too-long") throw new Error("Search term is too long. Use a shorter term and retry.");
    const id = randomUuid();
    const snapshot: FilesystemSearchRequest = { ...request, source: { ...request.source }, root: { ...request.root } };
    const controller = new AbortController();
    this.sessions.set(id, { id, request: snapshot, requestId: null, rows: [], status: "running", terminal: null, error: null });
    this.controllers.set(id, controller);
    this.notify();

    const current = () => !controller.signal.aborted && this.controllers.get(id) === controller && this.sessions.has(id);
    const publish = (record: FilesystemSearchRecord) => {
      if (!current()) return;
      const session = this.sessions.get(id)!;
      if (session.status !== "running") return;
      if (record.type === "start") {
        this.sessions.set(id, { ...session, requestId: record.request_id });
      } else if (record.type === "batch") {
        const rows = [...session.rows];
        const seen = new Set(rows.map(({ item }) => item.key));
        for (const result of record.results) {
          const item = searchResultItem(snapshot.source.id, result);
          if (!seen.has(item.key)) {
            seen.add(item.key);
            const location = searchResultLocation(snapshot, result);
            rows.push({
              item: { ...item, entry: { ...item.entry, browser_identity: item.key, search_location: location } },
            });
          }
        }
        this.sessions.set(id, { ...session, rows });
      } else {
        this.sessions.set(id, { ...session, terminal: record, status: "finished" });
      }
      this.notify();
    };

    void Promise.resolve()
      .then(() => (current() ? this.run(snapshot, controller.signal, publish) : undefined))
      .then(() => {
        if (!current()) return;
        const session = this.sessions.get(id)!;
        if (!session.terminal) {
          this.sessions.set(id, { ...session, status: "interrupted", error: null });
          this.notify();
        }
      })
      .catch((error: unknown) => {
        if (!current()) return;
        const session = this.sessions.get(id)!;
        const startError = error instanceof FilesystemSearchStartError ? error : undefined;
        this.sessions.set(id, {
          ...session,
          status: "interrupted",
          error: startError?.detail ?? null,
          errorCode:
            snapshot.source.kind === "local" && startError?.code === COMPANION_SEARCH_UPDATE_REQUIRED
              ? COMPANION_SEARCH_UPDATE_REQUIRED
              : error instanceof SearchStreamError
                ? error.code
                : startError && startError.detail === undefined
                  ? "start_failed"
                  : undefined,
        });
        this.notify();
      })
      .finally(() => {
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
      });
    return id;
  }

  close(id: string): void {
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    if (this.sessions.delete(id)) this.notify();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.sessions.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
