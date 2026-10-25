import { createContext, useContext } from "react";
import api from "../../services/api";
import { isLocalDrive } from "../../services/backendRouter";
import type {
  ResolvedStorageDirectoryLocation,
  StorageBackendRegistry,
  StorageEditSession,
  StorageReadRequest,
} from "../../services/storageContracts";
import type { ArchiveEntryInfo, ArchiveExtractionDecisionAction, FileEntry } from "../../types";
import { FileType } from "../../types";

export type VirtualContentProviderId = "zip" | (string & {});

export interface PhysicalLocation {
  kind: "physical";
  connectionId: string;
  path: string;
}

export interface VirtualLocation {
  kind: "virtual";
  providerId: VirtualContentProviderId;
  connectionId: string;
  source: PhysicalLocation;
  path: string;
}

export type ContentLocation = PhysicalLocation | VirtualLocation;

export interface PhysicalItemHandle {
  kind: "physical";
  location: PhysicalLocation;
  path: string;
}

export interface VirtualItemHandle {
  kind: "virtual";
  location: VirtualLocation;
  path: string;
}

export type ContentItemHandle = PhysicalItemHandle | VirtualItemHandle;

export interface PdfScreenProfile {
  width: number;
  height: number;
  zoomPercent: number;
}

export type ContentReadRequest =
  | { kind: "raw" }
  | { kind: "text" }
  | { kind: "image"; viewportWidth?: number; viewportHeight?: number; noResizing?: boolean }
  | { kind: "pdf"; variant?: "normalized"; screenProfile?: PdfScreenProfile };

export interface ContentReadOptions {
  download?: boolean;
  signal?: AbortSignal;
}

export interface ContentTextWriteOptions {
  mimeType?: string;
  reacquireExpiredLock?: boolean;
}

export interface ContentEditSession {
  heartbeat(): Promise<void>;
  /** Writes the editor content, recreating the target when it was deleted during the edit session. */
  writeText(content: string, options?: ContentTextWriteOptions): Promise<void>;
  release(): Promise<void>;
}

export type ContentEditStartResult =
  | { kind: "acquired"; session: ContentEditSession }
  | { kind: "read-only" }
  | { kind: "locked" }
  | { kind: "permission-denied" }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export interface BrowserItem {
  key: string;
  entry: FileEntry;
  handle: ContentItemHandle;
}

export interface ContentCapabilities {
  browse: boolean;
  read: boolean;
  download: boolean;
  extract: boolean;
  mutate: boolean;
  openInNativeApp: boolean;
}

export interface ArchiveExtractionConflict {
  source: ArchiveExtractionConflictItem;
  target: ArchiveExtractionConflictItem;
  isDirectory: boolean;
}

export interface ArchiveExtractionConflictItem {
  path: string;
  size: number | null;
  modifiedAt: string | null;
}

export interface ArchiveExtractionMemberError {
  memberPath: string;
  targetPath: string;
  message: string;
  partialOutput: boolean;
}

export interface ArchiveExtractionSummary {
  filesExtracted: number;
  directoriesCreated: number;
  extractedBytes: number;
  membersProcessed: number;
  totalMembers?: number;
  totalBytes?: number;
  filesSkipped: number;
  filesReplaced: number;
  partialMembers: number;
}

export type ArchiveExtractionConflictAction = "skip" | "skip_all" | "replace" | "replace_all" | "replace_older" | "rename";

export interface ArchiveExtractionRequest {
  source: VirtualLocation;
  destination: PhysicalLocation;
  selectedMemberPaths?: string[];
}

export type ArchiveExtractionOutcome =
  | { status: "completed"; filesSkipped: number; summary: ArchiveExtractionSummary }
  | { status: "cancelled" }
  | { status: "interrupted" }
  | { status: "awaiting-decision"; conflicts: ArchiveExtractionConflict[]; allowedActions: ArchiveExtractionConflictAction[] }
  | { status: "awaiting-member-error"; error: ArchiveExtractionMemberError };

export interface ArchiveExtractionExecution {
  result: Promise<ArchiveExtractionOutcome>;
  cancel(): Promise<void>;
  decide(action: ArchiveExtractionDecisionAction, memberPath?: string, targetPath?: string): Promise<ArchiveExtractionOutcome>;
  onProgress(listener: (summary: ArchiveExtractionSummary) => void): () => void;
  isCancellationRequested(): boolean;
}

export interface ProviderListResult {
  items: BrowserItem[];
  total: number;
  nextCursor: string | null;
}

export interface ContentProvider {
  readonly id: "physical" | VirtualContentProviderId;
  list(location: ContentLocation, options?: { cursor?: string; pageSize?: number; signal?: AbortSignal }): Promise<ProviderListResult>;
  getCapabilities(location: ContentLocation): ContentCapabilities;
  read(item: ContentItemHandle, request: ContentReadRequest, options?: ContentReadOptions): Promise<Blob>;
  beginEdit(item: ContentItemHandle): Promise<ContentEditStartResult>;
  invalidatePdfDerivative(item: ContentItemHandle, screenProfile?: PdfScreenProfile): Promise<void>;
}

export interface VirtualContentProvider extends ContentProvider {
  readonly sourceExtensions: readonly string[];
}

export interface ContentProviderRegistry {
  get(location: ContentLocation): ContentProvider;
  getCapabilities(location: ContentLocation): ContentCapabilities;
  getVirtualProviderIdForFilename(filename: string): VirtualContentProviderId | null;
}

export const ContentProviderRegistryContext = createContext<ContentProviderRegistry | null>(null);

const PHYSICAL_CAPABILITIES: ContentCapabilities = {
  browse: true,
  read: true,
  download: true,
  extract: false,
  mutate: true,
  openInNativeApp: true,
};

const VIRTUAL_READ_ONLY_CAPABILITIES: ContentCapabilities = {
  browse: true,
  read: true,
  download: true,
  extract: true,
  mutate: false,
  openInNativeApp: false,
};

export function physicalLocation(connectionId: string, path: string): PhysicalLocation {
  return { kind: "physical", connectionId, path };
}

export function virtualLocation(
  providerId: VirtualContentProviderId,
  connectionId: string,
  source: PhysicalLocation,
  path: string
): VirtualLocation {
  return { kind: "virtual", providerId, connectionId, source, path };
}

export function physicalItem(location: PhysicalLocation, entry: FileEntry): BrowserItem {
  const path = entry.path;
  return {
    key: `physical\u0001${location.connectionId}\u0001${path}`,
    entry,
    handle: { kind: "physical", location, path },
  };
}

export function virtualItem(location: VirtualLocation, entry: FileEntry): BrowserItem {
  return {
    key: `virtual\u0001${location.providerId}\u0001${location.connectionId}\u0001${location.source.path}\u0001${entry.path}`,
    entry,
    handle: { kind: "virtual", location, path: entry.path },
  };
}

export function virtualItemHandle(location: VirtualLocation, path: string): VirtualItemHandle {
  return { kind: "virtual", location, path };
}

export function physicalItemHandle(connectionId: string, path: string): PhysicalItemHandle {
  return { kind: "physical", location: physicalLocation(connectionId, ""), path };
}

export function isPhysicalItem(item: BrowserItem): item is BrowserItem & { handle: PhysicalItemHandle } {
  return item.handle.kind === "physical";
}

export function isVirtualItem(item: BrowserItem): item is BrowserItem & { handle: VirtualItemHandle } {
  return item.handle.kind === "virtual";
}

function toArchiveEntry(entry: ArchiveEntryInfo): FileEntry {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    size: entry.size ?? undefined,
    modified_at: entry.modified_at ?? undefined,
    is_readable: entry.state === "readable",
    is_hidden: entry.is_hidden,
    archive_entry_state: entry.state,
  };
}

function isVirtualContentProvider(provider: ContentProvider): provider is VirtualContentProvider {
  return "sourceExtensions" in provider && Array.isArray(provider.sourceExtensions);
}

function storageReadRequest(request: ContentReadRequest): StorageReadRequest {
  return request;
}

function toContentEditSession(session: StorageEditSession): ContentEditSession {
  return session;
}

function storageCapabilities(location: PhysicalLocation, registry: StorageBackendRegistry): ContentCapabilities {
  try {
    const target = registry.resolveDirectory(location);
    const capabilities = registry.getCapabilities(target.resolvedTarget);
    return {
      browse: capabilities.canList,
      read: capabilities.readable,
      download: capabilities.readable,
      extract: false,
      mutate: capabilities.writable,
      openInNativeApp: capabilities.canOpenInNativeApp,
    };
  } catch {
    return { browse: false, read: false, download: false, extract: false, mutate: false, openInNativeApp: false };
  }
}

export function createStorageBackedContentProviderRegistry(registry: StorageBackendRegistry): ContentProviderRegistry {
  const physical: ContentProvider = {
    id: "physical",
    async list(location, options) {
      if (location.kind !== "physical") throw new Error("Physical provider requires a physical location");
      let resolved: ResolvedStorageDirectoryLocation;
      try {
        resolved = registry.resolveDirectory(location);
      } catch (error) {
        if (!isLocalDrive(location.connectionId)) {
          throw error;
        }
        // Direct local routes can load before Companion detection has refreshed its drive catalog.
        const listing = await api.listDirectory(location.connectionId, location.path, { signal: options?.signal });
        return { items: listing.items.map((entry) => physicalItem(location, entry)), total: listing.total, nextCursor: null };
      }
      const listing = await registry.getBackend(resolved.target).list(resolved, options);
      return { items: listing.items.map((entry) => physicalItem(location, entry)), total: listing.total, nextCursor: null };
    },
    getCapabilities: (location) => (location.kind === "physical" ? storageCapabilities(location, registry) : PHYSICAL_CAPABILITIES),
    async read(item, request, options) {
      if (item.kind !== "physical") throw new Error("Physical provider requires a physical item");
      const resolved = registry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
      return registry.getBackend(resolved.target).read(resolved, storageReadRequest(request), options);
    },
    async beginEdit(item) {
      if (item.kind !== "physical") throw new Error("Physical provider requires a physical item");
      const resolved = registry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
      const editing = registry.getBackend(resolved.target).editing;
      if (!editing) return { kind: "unsupported" };
      const result = await editing.begin(resolved);
      return result.kind === "acquired" ? { kind: "acquired", session: toContentEditSession(result.session) } : result;
    },
    async invalidatePdfDerivative(item, screenProfile) {
      if (item.kind !== "physical") throw new Error("Physical provider requires a physical item");
      const resolved = registry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
      await registry.getBackend(resolved.target).invalidatePdfDerivative(resolved, screenProfile);
    },
  };
  const zip: VirtualContentProvider = {
    id: "zip",
    sourceExtensions: [".zip"],
    async list(location, options) {
      if (location.kind !== "virtual" || location.providerId !== "zip") throw new Error("ZIP provider requires a ZIP virtual location");
      const source = registry.resolveItem({ connectionId: location.source.connectionId, path: location.source.path });
      const archive = registry.getBackend(source.target).archive;
      if (!archive) throw new Error("Archive browsing is unavailable for this location");
      const listing = await archive.listDirectory(source, location.path, options);
      return {
        items: listing.items.map((entry) => virtualItem(location, toArchiveEntry(entry))),
        total: listing.items.length,
        nextCursor: listing.next_cursor ?? null,
      };
    },
    getCapabilities: (location) => {
      if (location.kind !== "virtual" || location.providerId !== "zip") {
        return VIRTUAL_READ_ONLY_CAPABILITIES;
      }
      try {
        const source = registry.resolveItem({ connectionId: location.source.connectionId, path: location.source.path });
        const capabilities = registry.getCapabilities(source.resolvedTarget);
        return { ...VIRTUAL_READ_ONLY_CAPABILITIES, extract: capabilities.canReadArchive && capabilities.writable };
      } catch {
        return { ...VIRTUAL_READ_ONLY_CAPABILITIES, extract: false };
      }
    },
    async read(item, request, options) {
      if (item.kind !== "virtual" || item.location.providerId !== "zip")
        throw new Error("ZIP provider cannot read a different virtual content type");
      const source = registry.resolveItem({ connectionId: item.location.source.connectionId, path: item.location.source.path });
      const archive = registry.getBackend(source.target).archive;
      if (!archive) throw new Error("Archive reading is unavailable for this location");
      return archive.readMember(source, item.path, storageReadRequest(request), options);
    },
    async beginEdit() {
      return { kind: "unsupported" };
    },
    async invalidatePdfDerivative(item, screenProfile) {
      if (item.kind !== "virtual" || item.location.providerId !== "zip")
        throw new Error("ZIP provider cannot invalidate a different virtual content type");
      const source = registry.resolveItem({ connectionId: item.location.source.connectionId, path: item.location.source.path });
      await registry.getBackend(source.target).archive?.invalidateMemberPdfDerivative(source, item.path, screenProfile);
    },
  };
  return createRegistry([physical, zip]);
}

function createRegistry(providerEntries: Iterable<ContentProvider>): ContentProviderRegistry {
  const registry = new Map(Array.from(providerEntries, (provider) => [provider.id, provider]));
  const get = (location: ContentLocation): ContentProvider => {
    const providerId = location.kind === "physical" ? "physical" : location.providerId;
    const provider = registry.get(providerId);
    if (!provider) {
      throw new Error(`No content provider registered for ${providerId}`);
    }
    return provider;
  };
  return {
    get,
    getCapabilities: (location) => get(location).getCapabilities(location),
    getVirtualProviderIdForFilename: (filename) => {
      const normalizedFilename = filename.toLowerCase();
      for (const provider of registry.values()) {
        if (isVirtualContentProvider(provider) && provider.sourceExtensions.some((extension) => normalizedFilename.endsWith(extension))) {
          return provider.id;
        }
      }
      return null;
    },
  };
}

export function useContentProviderRegistry(): ContentProviderRegistry {
  const registry = useContext(ContentProviderRegistryContext);
  if (!registry) {
    throw new Error("useContentProviderRegistry must be used within a ContentProviderRegistryContext.Provider");
  }
  return registry;
}

export function readVirtualContent(
  source: VirtualItemHandle,
  path = source.path,
  options: { download?: boolean; signal?: AbortSignal } | undefined,
  registry: ContentProviderRegistry
): Promise<Blob> {
  return readContent(virtualItemHandle(source.location, path), { kind: "raw" }, options, registry);
}

export function readContent(
  item: ContentItemHandle,
  request: ContentReadRequest,
  options: ContentReadOptions | undefined,
  registry: ContentProviderRegistry
): Promise<Blob> {
  return registry.get(item.location).read(item, request, options);
}

export function readViewerContent(
  connectionId: string,
  path: string,
  request: ContentReadRequest,
  options: (ContentReadOptions & { virtualSource?: VirtualItemHandle }) | undefined,
  registry: ContentProviderRegistry
): Promise<Blob> {
  const item = options?.virtualSource ? virtualItemHandle(options.virtualSource.location, path) : physicalItemHandle(connectionId, path);
  return readContent(item, request, options, registry);
}

export async function beginViewerTextEdit(
  connectionId: string,
  path: string,
  registry: ContentProviderRegistry
): Promise<ContentEditStartResult> {
  const item = physicalItemHandle(connectionId, path);
  return registry.get(item.location).beginEdit(item);
}

export function invalidateViewerPdfDerivative(
  connectionId: string,
  path: string,
  screenProfile: PdfScreenProfile | undefined,
  virtualSource: VirtualItemHandle | undefined,
  registry: ContentProviderRegistry
): Promise<void> {
  const item = virtualSource ? virtualItemHandle(virtualSource.location, path) : physicalItemHandle(connectionId, path);
  return registry.get(item.location).invalidatePdfDerivative(item, screenProfile);
}

export function getEntryPath(location: PhysicalLocation, entry: FileEntry): string {
  return entry.path || (location.path ? `${location.path}/${entry.name}` : entry.name);
}

export function isDirectory(item: BrowserItem): boolean {
  return item.entry.type === FileType.DIRECTORY;
}
