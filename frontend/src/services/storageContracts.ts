import type { ArchiveDirectoryListing, Connection, DirectoryListing, FileInfo } from "../types";

export type StorageTarget = { kind: "smb"; connectionId: string } | { kind: "local"; driveId: string };

export interface CompanionDriveDescriptor {
  driveId: string;
  name: string;
  path: string;
}

export interface CompanionSessionSnapshot {
  status: "unpaired" | "pairing" | "paired" | "unavailable";
  revision: number;
  drives: readonly CompanionDriveDescriptor[];
  error: { code: "unavailable" | "authentication-failed" | "transport"; detail: string } | null;
}

export interface StorageCapabilitySnapshot {
  capabilityRevision: number;
  connections: readonly Connection[];
  companion: CompanionSessionSnapshot;
}

export interface StorageDirectoryReference {
  connectionId: string;
  path: string;
}

export interface StorageItemReference {
  connectionId: string;
  path: string;
}

export interface ResolvedStorageTarget {
  target: StorageTarget;
  connection: Connection | null;
  capabilitySnapshot: StorageCapabilitySnapshot;
}

export interface ResolvedStorageDirectoryLocation {
  target: StorageTarget;
  path: string;
  resolvedTarget: ResolvedStorageTarget;
}

export interface ResolvedStorageItemLocation {
  target: StorageTarget;
  path: string;
  resolvedTarget: ResolvedStorageTarget;
}

export interface StorageBackendCapabilities {
  readable: boolean;
  writable: boolean;
  canEditText: boolean;
  canList: boolean;
  canReadArchive: boolean;
  preview: {
    imageConversion: boolean;
    imageResizing: boolean;
    pdfNormalization: boolean;
  };
  canWriteFile: boolean;
  canResolveActivation: boolean;
  canOpenInNativeApp: boolean;
}

export type StorageReadRequest =
  | { kind: "raw" }
  | { kind: "text" }
  | { kind: "image"; viewportWidth?: number; viewportHeight?: number; noResizing?: boolean }
  | { kind: "pdf"; variant?: "normalized"; screenProfile?: StoragePdfScreenProfile };

export interface StoragePdfScreenProfile {
  width: number;
  height: number;
  zoomPercent: number;
}

export interface StorageListOptions {
  cursor?: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface StorageRequestOptions {
  download?: boolean;
  signal?: AbortSignal;
}

export interface WriteFileRequest {
  name: string;
  content: Blob;
  overwrite: boolean;
  signal?: AbortSignal;
}

export type TargetResolutionPolicy = "ask" | "skip" | "replace" | "replace_older";

export class ExpiredEditLockError extends Error {
  constructor() {
    super("Lock not found or expired");
    this.name = "ExpiredEditLockError";
  }
}

export interface StorageTextWriteOptions {
  mimeType?: string;
  reacquireExpiredLock?: boolean;
}

export interface StorageEditSession {
  heartbeat(): Promise<void>;
  /** Writes the editor content, recreating the target when it was deleted during the edit session. */
  writeText(content: string, options?: StorageTextWriteOptions): Promise<void>;
  release(): Promise<void>;
}

export type StorageEditStartResult =
  | { kind: "acquired"; session: StorageEditSession }
  | { kind: "read-only" }
  | { kind: "locked" }
  | { kind: "permission-denied" }
  | { kind: "unsupported" }
  | { kind: "unavailable" };

export interface StorageEditingOperations {
  begin(item: ResolvedStorageItemLocation): Promise<StorageEditStartResult>;
}

export interface StorageCreateRequest {
  name: string;
  kind: "file" | "directory";
  signal?: AbortSignal;
}

export type StorageEmptyDirectoryRemovalResult = { status: "removed" } | { status: "not_empty" };

export interface SameBackendTransferRequest {
  source: ResolvedStorageItemLocation;
  destination: ResolvedStorageDirectoryLocation;
  targetName?: string;
  targetResolutionPolicy: TargetResolutionPolicy;
  idempotencyKey: string;
  transferAttemptId?: string;
  signal?: AbortSignal;
}

export interface StorageMutationEffects {
  source: "unchanged" | "mutated" | "unknown";
  destination: "unchanged" | "mutated" | "unknown";
}

export type ContentTransferResult =
  | { status: "completed"; replaced: boolean; effects: StorageMutationEffects }
  | { status: "skipped"; replaced: false; effects: { source: "unchanged"; destination: "unchanged" } }
  | {
      status: "completed_with_source_retained";
      replaced: boolean;
      effects: { source: "unchanged" | "mutated"; destination: "unchanged" | "mutated" };
      error: { code: "source_delete_failed"; detail: string };
    }
  | { status: "outcome_unknown"; replaced: boolean; effects: StorageMutationEffects }
  | { status: "failed"; replaced: boolean; effects: StorageMutationEffects; error: StorageOperationError }
  | { status: "cancelled"; replaced: boolean; effects: StorageMutationEffects };

export type StorageOperationError =
  | { code: "unavailable"; reason: "read-only" | "unpaired" | "unsupported" | "missing-target" | "source_size_unknown" }
  | { code: "validation"; reason: "heterogeneous-source-target" | "invalid-directory-listing" | "invalid-name" | "target-inside-source" }
  | { code: "stale-capability"; expectedRevision: number; actualRevision: number }
  | { code: "conflict"; detail: string }
  | { code: "source_changed"; detail: string }
  | { code: "transport"; detail: string };

export type StorageOperationResult =
  | { status: "completed"; effects: StorageMutationEffects }
  | { status: "failed" | "partial-output"; effects: StorageMutationEffects; error: StorageOperationError }
  | { status: "cancelled"; effects: StorageMutationEffects; error: { code: "cancelled"; detail: string | null } };

export interface StorageRecoveryHandle {
  schemaVersion: 2;
  contractVersion: "v2";
  backendKind: StorageTarget["kind"];
  opaqueOperationId: string;
  expiresAt: number;
}

export interface StorageOperationExecution {
  result: Promise<StorageOperationResult>;
  recoveryReady: Promise<StorageRecoveryHandle | null>;
  cancel(): Promise<StorageOperationResult>;
  isCancellationRequested(): boolean;
}

export interface StorageArchiveCreateRequest {
  sources: readonly ResolvedStorageItemLocation[];
  destination: ResolvedStorageDirectoryLocation;
  name: string;
  selectedMemberPaths?: readonly string[];
}

export interface StorageArchivePreparation {
  recovery: StorageRecoveryHandle;
}

export type StorageArchiveExecutionContext =
  | { mode: "direct-local"; preparation: null }
  | { mode: "durable"; preparation: StorageArchivePreparation };

export interface ArchiveCreationOperations {
  prepareCreate?(request: StorageArchiveCreateRequest): Promise<StorageArchivePreparation>;
  execute(
    request: StorageArchiveCreateRequest,
    context: StorageArchiveExecutionContext,
    signal?: AbortSignal
  ): Promise<StorageOperationResult>;
  cancel?(recovery: StorageRecoveryHandle): Promise<StorageOperationResult>;
}

export interface StorageNativeOpenOptions {
  forcePicker: boolean;
  themeJson: string;
}

export interface StorageActivationResult {
  connectionId: string;
  path: string;
  type: FileInfo["type"];
  item: FileInfo;
}

export type StorageNativeOpenResult =
  | { kind: "opened-locally" }
  | { kind: "browser-launch"; uri: string }
  | { kind: "unavailable"; error: StorageOperationError }
  | { kind: "failed"; error: StorageOperationError; permanentMissingTarget?: boolean };

export interface ArchiveSourceOperations {
  listDirectory(source: ResolvedStorageItemLocation, virtualPath: string, options?: StorageListOptions): Promise<ArchiveDirectoryListing>;
  readMember(
    source: ResolvedStorageItemLocation,
    memberPath: string,
    request: StorageReadRequest,
    options?: StorageRequestOptions
  ): Promise<Blob>;
  invalidateMemberPdfDerivative(source: ResolvedStorageItemLocation, memberPath: string, profile?: StoragePdfScreenProfile): Promise<void>;
}

export interface StorageBackend {
  readonly kind: StorageTarget["kind"];
  getCapabilities(target: ResolvedStorageTarget): StorageBackendCapabilities;
  list(location: ResolvedStorageDirectoryLocation, options?: StorageListOptions): Promise<DirectoryListing>;
  getInfo(location: ResolvedStorageItemLocation, options?: StorageRequestOptions): Promise<FileInfo>;
  read(location: ResolvedStorageItemLocation, request: StorageReadRequest, options?: StorageRequestOptions): Promise<Blob>;
  writeFile(destination: ResolvedStorageDirectoryLocation, request: WriteFileRequest): Promise<StorageOperationResult>;
  invalidatePdfDerivative(item: ResolvedStorageItemLocation, profile?: StoragePdfScreenProfile): Promise<void>;
  create(destination: ResolvedStorageDirectoryLocation, request: StorageCreateRequest): Promise<StorageOperationResult>;
  rename(item: ResolvedStorageItemLocation, name: string): Promise<StorageOperationResult>;
  remove(item: ResolvedStorageItemLocation): Promise<StorageOperationResult>;
  removeEmptyDirectory(item: ResolvedStorageItemLocation): Promise<StorageEmptyDirectoryRemovalResult>;
  copyWithinBackend(request: SameBackendTransferRequest): Promise<ContentTransferResult>;
  moveWithinBackend(request: SameBackendTransferRequest): Promise<ContentTransferResult>;
  resolveActivation?(item: ResolvedStorageItemLocation): Promise<StorageActivationResult>;
  openInNativeApp?(item: ResolvedStorageItemLocation, options: StorageNativeOpenOptions): Promise<StorageNativeOpenResult>;
  editing?: StorageEditingOperations;
  archive?: ArchiveSourceOperations;
  archiveCreation?: ArchiveCreationOperations;
}

export interface StorageBackendRegistry {
  resolveDirectory(reference: StorageDirectoryReference): ResolvedStorageDirectoryLocation;
  resolveItem(reference: StorageItemReference): ResolvedStorageItemLocation;
  getBackend(target: StorageTarget): StorageBackend;
  getCapabilities(target: ResolvedStorageTarget): StorageBackendCapabilities;
}
