import type { BrowserHistoryService } from "../../services/browserHistoryService";
import { logger } from "../../services/logger";
import { publishRecentFilesChanged } from "../../services/recentFilesSync";
import type { StorageArchiveOperationCoordinator } from "../../services/storageArchiveOperations";
import type { ContentTransferResult, StorageBackendRegistry, TargetResolutionPolicy } from "../../services/storageContracts";
import {
  downloadPhysicalFile,
  downloadPhysicalSelection,
  downloadVirtualFile,
  downloadZipSelection,
  publishBrowserFile,
  transferAcrossStorageBackends,
} from "../../services/storageTransferOperations";
import { type ConflictInfo, type DirectoryListing, type FileInfo, FileType, isApiError } from "../../types";
import { randomUuid } from "../../utils/randomUuid";
import { startZipArchiveExtraction } from "./archiveExtractionExecution";
import type {
  ArchiveExtractionExecution,
  ArchiveExtractionRequest,
  BrowserItem,
  ContentItemHandle,
  ContentLocation,
  ContentProviderRegistry,
  PhysicalItemHandle,
  PhysicalLocation,
  VirtualLocation,
} from "./contentProviders";
import { physicalItemHandle, physicalLocation } from "./contentProviders";

export { publishBrowserFile };

export async function downloadContentSelection(
  items: readonly BrowserItem[],
  _providers: ContentProviderRegistry,
  signal: AbortSignal
): Promise<void> {
  const item = items[0];
  if (!item || !items.every((selected) => selected.entry.is_readable)) throw new Error("Select readable items to download");
  const virtualSource = item.handle.kind === "virtual" ? item.handle.location.source.path : null;
  if (items.length > 1 || item.entry.type === FileType.DIRECTORY) {
    if (item.handle.kind === "physical" && items.every((selected) => selected.handle.kind === "physical")) {
      await downloadPhysicalSelection(
        item.handle.location.connectionId,
        items.map((selected) => selected.handle.path),
        signal
      );
    } else if (
      item.handle.kind === "virtual" &&
      item.handle.location.providerId === "zip" &&
      items.every(
        (selected) =>
          selected.handle.kind === "virtual" &&
          selected.handle.location.providerId === "zip" &&
          selected.handle.location.source.path === virtualSource
      )
    ) {
      await downloadZipSelection(
        item.handle.location.connectionId,
        item.handle.location.source.path,
        items.map((selected) => selected.handle.path),
        signal
      );
    } else throw new Error("Selected download sources are incompatible");
  } else if (item.handle.kind === "physical") {
    await downloadPhysicalFile(item.handle.location.connectionId, item.handle.path, item.entry.name, signal);
  } else {
    if (item.handle.location.providerId !== "zip") throw new Error("Unsupported virtual download source");
    await downloadVirtualFile(
      item.handle.location.connectionId,
      item.handle.location.source.path,
      item.handle.path,
      item.entry.name,
      signal
    );
  }
}

export interface ArchiveExtractionAvailability {
  available: boolean;
  reason?: "invalid-source" | "invalid-destination" | "unsupported";
}

export function getArchiveExtractionAvailability(
  providers: ContentProviderRegistry,
  source: VirtualLocation,
  destination: PhysicalLocation
): ArchiveExtractionAvailability {
  if (!providers.getCapabilities(source).extract) {
    return { available: false, reason: "unsupported" };
  }
  if (!providers.getCapabilities(destination).mutate) {
    return { available: false, reason: "invalid-destination" };
  }
  return { available: true };
}

export function startArchiveExtraction(providers: ContentProviderRegistry, request: ArchiveExtractionRequest): ArchiveExtractionExecution {
  const availability = getArchiveExtractionAvailability(providers, request.source, request.destination);
  if (!availability.available) {
    throw new Error("Archive extraction is unavailable for the selected source or destination");
  }
  if (request.source.providerId === "zip") {
    return startZipArchiveExtraction(request);
  }
  throw new Error("Archive extraction is unavailable for this content provider");
}

export type ContentOperationReason =
  | "empty-selection"
  | "mixed-source-connections"
  | "unsupported-source"
  | "unsupported-destination"
  | "read-only"
  | "companion-unavailable";

export interface ContentOperationAvailability {
  available: boolean;
  reason?: ContentOperationReason;
}

export interface ContentOperationEnvironment {
  isCompanionPaired: boolean;
  storageRegistry: StorageBackendRegistry;
  history: BrowserHistoryService;
}

export interface ArchiveContentOperationEnvironment extends ContentOperationEnvironment {
  archiveOperations: StorageArchiveOperationCoordinator;
}

export interface ContentOperationProgress {
  current: number;
  total: number;
}

export interface TransferRequest {
  kind: "copy" | "move";
  source: ContentItemHandle;
  destination: ContentLocation;
  targetName?: string;
  targetResolutionPolicy?: TargetResolutionPolicy;
  signal?: AbortSignal;
  onProgress?: (bytesTransferred: number, totalBytes: number | null) => void;
  onAttemptStart?: (transferAttemptId: string) => void;
  onAttemptSettled?: (transferAttemptId: string) => void;
}

export interface TransferTreeRequest extends TransferRequest {
  onConflict: (
    conflict: ConflictInfo,
    allowedActions: readonly ("skip" | "overwrite" | "overwrite-older" | "rename")[],
    progress: { completed: number; discovered: number }
  ) => Promise<{
    resolution: "skip" | "overwrite" | "overwrite-older" | "rename";
    applyToAll: boolean;
    targetName?: string;
  } | null>;
  onTreeProgress?: (completed: number, discovered: number) => void;
  onPolicyChange?: (policy: TargetResolutionPolicy) => void;
}

export interface CreateContainerRequest {
  sources: readonly ContentItemHandle[];
  destination: ContentLocation;
  name: string;
}

export interface ContentOperationExecution {
  result: Promise<void>;
  cancel(): Promise<void>;
  isCancellationRequested(): boolean;
}

export interface NativeOpenRequest {
  item: ContentItemHandle;
  forcePicker?: boolean;
  recentRecordId?: string;
  themeJson: string;
  assumeLocalTargetResolved?: boolean;
}

export interface NativeOpenResult {
  companionUri: string | null;
  resolvedDirectory: PhysicalLocation | null;
}

function normalizeDirectoryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function validateDirectoryListing(path: string, listing: DirectoryListing): boolean {
  const normalizedPath = normalizeDirectoryPath(path);
  if (typeof listing.path === "string" && normalizeDirectoryPath(listing.path) !== normalizedPath) {
    return false;
  }
  return listing.items.every((entry) => {
    if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/]/.test(entry.name)) {
      return false;
    }
    return normalizeDirectoryPath(entry.path) === `${normalizedPath}/${entry.name}`.replace(/^\//, "");
  });
}

const PERMANENT_RECENT_NATIVE_OPEN_FAILURE_CODES = new Set([
  "recent_file_target_missing",
  "recent_file_target_not_file",
  "recent_file_native_launch_failed",
]);

function isPhysicalLocation(location: ContentLocation): location is PhysicalLocation {
  return location.kind === "physical";
}

function isPhysicalItem(item: ContentItemHandle): item is PhysicalItemHandle {
  return item.kind === "physical";
}

function unavailable(reason: ContentOperationReason): ContentOperationAvailability {
  return { available: false, reason };
}

function canWriteLocation(location: ContentLocation, environment: ContentOperationEnvironment): ContentOperationAvailability {
  if (!isPhysicalLocation(location)) {
    return unavailable("unsupported-destination");
  }
  try {
    const resolved = environment.storageRegistry.resolveDirectory(location);
    return environment.storageRegistry.getCapabilities(resolved.resolvedTarget).writable ? { available: true } : unavailable("read-only");
  } catch {
    return unavailable("unsupported-destination");
  }
}

function canWriteItem(item: PhysicalItemHandle, environment: ContentOperationEnvironment): ContentOperationAvailability {
  try {
    const resolved = environment.storageRegistry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
    return environment.storageRegistry.getCapabilities(resolved.resolvedTarget).writable ? { available: true } : unavailable("read-only");
  } catch {
    return unavailable("unsupported-source");
  }
}

function recordNativeOpenAttempt(item: PhysicalItemHandle, history: BrowserHistoryService): void {
  const { connectionId } = item.location;
  const record = () =>
    Promise.resolve()
      .then(() => history.recordRecentFile(connectionId, item.path))
      .then(() => publishRecentFilesChanged());
  void record().catch((error: unknown) => logger.warn("Failed to record recent file", { connectionId, path: item.path, error }, "browser"));
}

function getOperationErrorCode(error: unknown): string | null {
  if (!isApiError(error)) {
    return null;
  }
  const code = error.response?.data?.code;
  return typeof code === "string" ? code : null;
}

async function removePermanentRecentNativeOpenFailure(recordId: string, error: unknown, history: BrowserHistoryService): Promise<void> {
  const errorCode = getOperationErrorCode(error);
  if (!errorCode || !PERMANENT_RECENT_NATIVE_OPEN_FAILURE_CODES.has(errorCode)) {
    return;
  }
  try {
    await history.removeRecentFile(recordId);
    publishRecentFilesChanged();
  } catch (removeError: unknown) {
    logger.warn("Failed to remove stale recent file", { recordId, error: removeError }, "browser");
  }
}

export function getCreateContentItemAvailability(
  location: ContentLocation,
  environment: ContentOperationEnvironment
): ContentOperationAvailability {
  return canWriteLocation(location, environment);
}

export function getNativeOpenAvailability(item: ContentItemHandle, environment: ContentOperationEnvironment): ContentOperationAvailability {
  if (!isPhysicalItem(item)) {
    return unavailable("unsupported-source");
  }
  try {
    const resolved = environment.storageRegistry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
    return environment.storageRegistry.getCapabilities(resolved.resolvedTarget).canOpenInNativeApp
      ? { available: true }
      : unavailable("read-only");
  } catch {
    return unavailable("unsupported-source");
  }
}

export async function openContentInNativeApp(
  request: NativeOpenRequest,
  environment: ContentOperationEnvironment
): Promise<NativeOpenResult> {
  const availability = getNativeOpenAvailability(request.item, environment);
  if (!availability.available || !isPhysicalItem(request.item)) {
    throw new Error(`Native app opening is unavailable: ${availability.reason ?? "unsupported"}`);
  }

  try {
    let resolved = environment.storageRegistry.resolveItem({ connectionId: request.item.location.connectionId, path: request.item.path });
    let targetItem = request.item;
    const backend = environment.storageRegistry.getBackend(resolved.target);
    if (backend.resolveActivation && !request.assumeLocalTargetResolved) {
      const activation = await backend.resolveActivation(resolved);
      if (activation.type === FileType.DIRECTORY) {
        return { companionUri: null, resolvedDirectory: physicalLocation(activation.connectionId, activation.path) };
      }
      targetItem = physicalItemHandle(activation.connectionId, activation.path);
      resolved = environment.storageRegistry.resolveItem({ connectionId: activation.connectionId, path: activation.path });
    }
    recordNativeOpenAttempt(targetItem, environment.history);
    const launch = await environment.storageRegistry.getBackend(resolved.target).openInNativeApp?.(resolved, {
      forcePicker: request.forcePicker ?? false,
      themeJson: request.themeJson,
    });
    if (!launch || launch.kind === "unavailable" || launch.kind === "failed") {
      throw new Error("Native app launch failed");
    }
    return { companionUri: launch.kind === "browser-launch" ? launch.uri : null, resolvedDirectory: null };
  } catch (error) {
    if (request.recentRecordId) {
      await removePermanentRecentNativeOpenFailure(request.recentRecordId, error, environment.history);
    }
    throw error;
  }
}

export function getTransferAvailability(
  request: Pick<TransferRequest, "kind" | "source" | "destination">,
  environment: ContentOperationEnvironment
): ContentOperationAvailability {
  if (!isPhysicalItem(request.source)) {
    return unavailable("unsupported-source");
  }
  const destinationAvailability = canWriteLocation(request.destination, environment);
  if (!destinationAvailability.available) {
    return destinationAvailability;
  }
  if (request.kind === "move") {
    const sourceAvailability = canWriteItem(request.source, environment);
    if (!sourceAvailability.available) {
      return sourceAvailability;
    }
  }
  return { available: true };
}

export async function executeTransfer(request: TransferRequest, environment: ContentOperationEnvironment): Promise<ContentTransferResult> {
  if (!isPhysicalItem(request.source) || !isPhysicalLocation(request.destination)) {
    const availability = getTransferAvailability(request, environment);
    throw new Error(`Content transfer is unavailable: ${availability.reason ?? "unsupported"}`);
  }
  const availability = getTransferAvailability(request, environment);
  if (!availability.available) {
    return {
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "unsupported" },
    };
  }

  const source = environment.storageRegistry.resolveItem({
    connectionId: request.source.location.connectionId,
    path: request.source.path,
  });
  const destination = environment.storageRegistry.resolveDirectory(request.destination);
  const idempotencyKey = randomUuid();
  const targetResolutionPolicy = request.targetResolutionPolicy ?? "ask";
  const targetName = request.targetName ?? source.path.split("/").pop() ?? "";
  const requiresStreamRelay = source.target.kind !== destination.target.kind;
  if (requiresStreamRelay) {
    const targetPath = `${destination.path}/${targetName}`.replace(/^\//, "");
    if (request.signal || request.onProgress) {
      return transferAcrossStorageBackends(
        request.kind,
        request.source.location.connectionId,
        source.path,
        request.destination.connectionId,
        targetPath,
        targetResolutionPolicy,
        { signal: request.signal, onProgress: request.onProgress }
      );
    }
    return transferAcrossStorageBackends(
      request.kind,
      request.source.location.connectionId,
      source.path,
      request.destination.connectionId,
      targetPath,
      targetResolutionPolicy
    );
  }
  const backend = environment.storageRegistry.getBackend(source.target);
  const transferAttemptId = randomUuid();
  const transfer = {
    source,
    destination,
    targetName: request.targetName,
    targetResolutionPolicy,
    idempotencyKey,
    transferAttemptId,
    signal: request.signal,
  };
  request.onAttemptStart?.(transferAttemptId);
  try {
    return await (request.kind === "move" ? backend.moveWithinBackend(transfer) : backend.copyWithinBackend(transfer));
  } finally {
    request.onAttemptSettled?.(transferAttemptId);
  }
}

export async function executeTransferTree(
  request: TransferTreeRequest,
  environment: ContentOperationEnvironment
): Promise<ContentTransferResult> {
  if (!isPhysicalItem(request.source) || !isPhysicalLocation(request.destination)) {
    return {
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "unsupported" },
    };
  }

  const sourceRoot = request.source.path;
  const operationId = randomUuid();
  const operationContext = {
    operationId,
    kind: request.kind,
    sourceConnectionId: request.source.location.connectionId,
    destinationConnectionId: request.destination.connectionId,
    sourceRoot,
    destinationParent: request.destination.path,
  };
  logger.debug("Directory transfer started", operationContext, "browser");
  const rootName = request.targetName ?? sourceRoot.split("/").pop() ?? "";
  let policy = request.targetResolutionPolicy ?? "ask";
  let completed = 0;
  let discovered = 0;
  let sourceRetained = false;
  let destinationMutated = false;
  let sourceMutated = false;
  let sourceUnknown = false;
  let destinationUnknown = false;
  let replaced = false;

  const reportProgress = () => request.onTreeProgress?.(completed, discovered);
  const isMissing = (error: unknown) => isApiError(error) && error.response?.status === 404;
  const isConflict = (error: unknown) => isApiError(error) && error.response?.status === 409;
  const getInfo = async (connectionId: string, path: string): Promise<FileInfo | null> => {
    const resolved = environment.storageRegistry.resolveItem({ connectionId, path });
    try {
      return await environment.storageRegistry.getBackend(resolved.target).getInfo(resolved);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const listDirectoryEntries = async (connectionId: string, parentPath: string): Promise<Map<string, FileInfo>> => {
    const parent = environment.storageRegistry.resolveDirectory({ connectionId, path: parentPath });
    const listing = await environment.storageRegistry.getBackend(parent.target).list(parent, { signal: request.signal });
    return new Map(listing.items.map((item) => [item.name, item]));
  };
  const createDirectory = async (connectionId: string, parentPath: string, name: string) => {
    logger.debug("Directory transfer request", { ...operationContext, phase: "create", connectionId, parentPath, name }, "browser");
    const resolved = environment.storageRegistry.resolveDirectory({ connectionId, path: parentPath });
    const result = await environment.storageRegistry
      .getBackend(resolved.target)
      .create(resolved, { name, kind: "directory", signal: request.signal });
    if (result.status !== "completed") throw new Error(`Directory creation failed: ${result.status}`);
    destinationMutated = true;
  };
  const partialEffects = () => ({
    source: sourceMutated ? ("mutated" as const) : sourceUnknown ? ("unknown" as const) : ("unchanged" as const),
    destination: destinationMutated ? ("mutated" as const) : destinationUnknown ? ("unknown" as const) : ("unchanged" as const),
  });
  const cancelledTreeResult = (): ContentTransferResult => ({ status: "cancelled", replaced, effects: partialEffects() });
  const recordChildEffects = (result: ContentTransferResult) => {
    sourceMutated ||= result.effects.source === "mutated";
    destinationMutated ||= result.effects.destination === "mutated";
    sourceUnknown ||= result.effects.source === "unknown";
    destinationUnknown ||= result.effects.destination === "unknown";
    replaced ||= result.replaced;
  };
  const preservePartialEffects = (result: ContentTransferResult): ContentTransferResult => {
    if (result.status === "skipped") return result;
    if (result.status === "completed_with_source_retained") {
      const effects = partialEffects();
      if (effects.source === "unknown" || effects.destination === "unknown") {
        return { status: "outcome_unknown", replaced, effects };
      }
      return { ...result, replaced, effects: { source: effects.source, destination: effects.destination } };
    }
    return { ...result, replaced, effects: partialEffects() };
  };
  const decide = async (
    incoming: FileInfo,
    existing: FileInfo,
    actions: readonly ("skip" | "overwrite" | "overwrite-older" | "rename")[]
  ) => {
    const decision = await request.onConflict({ incoming_file: incoming, existing_file: existing }, actions, { completed, discovered });
    if (decision?.applyToAll && decision.resolution !== "rename") {
      policy = targetResolutionPolicyForTreeDecision(decision.resolution);
      request.onPolicyChange?.(policy);
    }
    return decision;
  };
  const decideTypeMismatch = async (incoming: FileInfo, existing: FileInfo) => {
    if (policy === "skip") return { resolution: "skip" as const };
    return decide(incoming, existing, ["skip", "rename"]);
  };
  const prepareDirectoryTarget = async (
    incoming: FileInfo,
    parentPath: string,
    initialName: string,
    destinationEntries: Map<string, FileInfo>
  ) => {
    let targetName = initialName;
    while (true) {
      const targetPath = `${parentPath}/${targetName}`.replace(/^\//, "");
      const existing = destinationEntries.get(targetName) ?? null;
      if (existing?.type === FileType.DIRECTORY) return { status: "ready" as const, path: targetPath };
      if (existing?.type === FileType.FILE) {
        const decision = await decideTypeMismatch(incoming, existing);
        if (!decision) return { status: "cancelled" as const };
        if (decision.resolution === "skip") return { status: "skipped" as const };
        targetName = decision.targetName ?? targetName;
        continue;
      }
      try {
        await createDirectory(request.destination.connectionId, parentPath, targetName);
        destinationEntries.set(targetName, { ...incoming, name: targetName, path: targetPath });
        return { status: "ready" as const, path: targetPath };
      } catch (error) {
        if (!isConflict(error)) throw error;
        destinationEntries = await listDirectoryEntries(request.destination.connectionId, parentPath);
        const racedTarget = destinationEntries.get(targetName) ?? null;
        if (racedTarget?.type === FileType.DIRECTORY) return { status: "ready" as const, path: targetPath };
        if (racedTarget?.type === FileType.FILE) {
          const decision = await decideTypeMismatch(incoming, racedTarget);
          if (!decision) return { status: "cancelled" as const };
          if (decision.resolution === "skip") return { status: "skipped" as const };
          targetName = decision.targetName ?? targetName;
        }
      }
    }
  };
  const transferFile = async (sourcePath: string, destinationParent: string, targetName: string): Promise<ContentTransferResult> => {
    const source = physicalItemHandle(request.source.location.connectionId, sourcePath);
    let currentTargetName = targetName;
    let currentPolicy = policy;
    while (true) {
      try {
        return await executeTransfer(
          {
            ...request,
            source,
            destination: physicalLocation(request.destination.connectionId, destinationParent),
            targetName: currentTargetName,
            targetResolutionPolicy: currentPolicy,
            onAttemptStart: (transferAttemptId) => {
              logger.debug(
                "Directory transfer request",
                {
                  ...operationContext,
                  phase: "transfer",
                  transferAttemptId,
                  sourcePath,
                  destinationPath: `${destinationParent}/${currentTargetName}`.replace(/^\//, ""),
                },
                "browser"
              );
              request.onAttemptStart?.(transferAttemptId);
            },
          },
          environment
        );
      } catch (error) {
        if (!isApiError(error) || error.response?.status !== 409) throw error;
        const conflict = error.response.data?.detail as ConflictInfo | undefined;
        if (!conflict) throw error;
        const allowedActions =
          conflict.existing_file.type === FileType.DIRECTORY
            ? (["skip", "rename"] as const)
            : (["skip", "overwrite", "overwrite-older", "rename"] as const);
        const decision = await decide(conflict.incoming_file, conflict.existing_file, allowedActions);
        if (!decision) return { status: "cancelled", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
        if (decision.resolution === "skip")
          return { status: "skipped", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
        currentTargetName = decision.resolution === "rename" ? (decision.targetName ?? currentTargetName) : currentTargetName;
        currentPolicy = targetResolutionPolicyForTreeDecision(decision.resolution);
      }
    }
  };
  const walk = async (sourcePath: string, destinationPath: string): Promise<ContentTransferResult | null> => {
    const sourceDirectory = environment.storageRegistry.resolveDirectory({
      connectionId: request.source.location.connectionId,
      path: sourcePath,
    });
    const listing = await environment.storageRegistry.getBackend(sourceDirectory.target).list(sourceDirectory, { signal: request.signal });
    if (!validateDirectoryListing(sourcePath, listing)) {
      logger.warn("Directory transfer received an invalid source listing", { sourcePath }, "browser");
      return {
        status: "failed",
        replaced,
        effects: partialEffects(),
        error: { code: "validation", reason: "invalid-directory-listing" },
      };
    }
    const destinationEntries = await listDirectoryEntries(request.destination.connectionId, destinationPath);
    for (const entry of listing.items) {
      if (request.signal?.aborted) return cancelledTreeResult();
      discovered += 1;
      reportProgress();
      const childSourcePath = `${sourcePath}/${entry.name}`.replace(/^\//, "");
      const existing = destinationEntries.get(entry.name) ?? null;
      if (entry.type === FileType.DIRECTORY) {
        const target = await prepareDirectoryTarget(entry, destinationPath, entry.name, destinationEntries);
        if (target.status === "cancelled") return cancelledTreeResult();
        if (target.status === "skipped") {
          completed += 1;
          reportProgress();
          continue;
        }
        const nested = await walk(childSourcePath, target.path);
        if (nested) return nested;
      } else {
        let targetName = entry.name;
        if (existing?.type === FileType.DIRECTORY) {
          const decision = await decideTypeMismatch(entry, existing);
          if (!decision) return cancelledTreeResult();
          if (decision.resolution === "skip") {
            completed += 1;
            reportProgress();
            continue;
          }
          targetName = decision.targetName ?? targetName;
        }
        const result = await transferFile(childSourcePath, destinationPath, targetName);
        recordChildEffects(result);
        if (result.status === "outcome_unknown") return preservePartialEffects(result);
        if (result.status === "completed_with_source_retained") {
          sourceRetained = true;
        } else if (result.status !== "completed" && result.status !== "skipped") {
          return preservePartialEffects(result);
        }
      }
      completed += 1;
      reportProgress();
    }
    if (request.kind === "move") {
      logger.debug("Directory transfer request", { ...operationContext, phase: "remove_empty_directory", sourcePath }, "browser");
      const sourceDirectory = environment.storageRegistry.resolveItem({
        connectionId: request.source.location.connectionId,
        path: sourcePath,
      });
      const removal = await environment.storageRegistry.getBackend(sourceDirectory.target).removeEmptyDirectory(sourceDirectory);
      if (removal.status === "not_empty") sourceRetained = true;
      else sourceMutated = true;
    }
    return null;
  };

  const sourceInfo = await getInfo(request.source.location.connectionId, sourceRoot);
  if (!sourceInfo)
    return {
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "unavailable", reason: "missing-target" },
    };
  if (sourceInfo.type !== FileType.DIRECTORY) {
    return {
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "source_changed", detail: "Directory source changed before transfer began" },
    };
  }
  const rootDestinationPath = `${request.destination.path}/${rootName}`.replace(/^\//, "");
  const normalizedSourceRoot = normalizeDirectoryPath(sourceRoot);
  const normalizedRootDestination = normalizeDirectoryPath(rootDestinationPath);
  if (
    request.source.location.connectionId === request.destination.connectionId &&
    (normalizedRootDestination === normalizedSourceRoot || normalizedRootDestination.startsWith(`${normalizedSourceRoot}/`))
  ) {
    return {
      status: "failed",
      replaced: false,
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "validation", reason: "target-inside-source" },
    };
  }
  const rootExisting = await getInfo(request.destination.connectionId, rootDestinationPath);
  const rootDestinationEntries = new Map(rootExisting ? [[rootName, rootExisting]] : []);
  const rootTarget = await prepareDirectoryTarget(sourceInfo, request.destination.path, rootName, rootDestinationEntries);
  if (rootTarget.status === "cancelled") return cancelledTreeResult();
  if (rootTarget.status === "skipped")
    return { status: "skipped", replaced: false, effects: { source: "unchanged", destination: "unchanged" } };
  const result = await walk(sourceRoot, rootTarget.path);
  return result ?? completedTreeResult(request.kind, sourceRetained, destinationMutated, sourceMutated, replaced);
}

function completedTreeResult(
  kind: "copy" | "move",
  sourceRetained: boolean,
  destinationMutated: boolean,
  sourceMutated: boolean,
  replaced: boolean
): ContentTransferResult {
  if (kind === "move" && sourceRetained) {
    return {
      status: "completed_with_source_retained",
      replaced,
      effects: { source: sourceMutated ? "mutated" : "unchanged", destination: destinationMutated ? "mutated" : "unchanged" },
      error: { code: "source_delete_failed", detail: "Some source directories still contain skipped or concurrently created entries." },
    };
  }
  return {
    status: "completed",
    replaced,
    effects: {
      source: kind === "move" && sourceMutated ? "mutated" : "unchanged",
      destination: destinationMutated ? "mutated" : "unchanged",
    },
  };
}

function targetResolutionPolicyForTreeDecision(resolution: "skip" | "overwrite" | "overwrite-older" | "rename"): TargetResolutionPolicy {
  if (resolution === "skip") return "skip";
  if (resolution === "overwrite") return "replace";
  if (resolution === "overwrite-older") return "replace_older";
  return "ask";
}

export function areSameContentLocations(left: ContentLocation, right: ContentLocation): boolean {
  if (left.kind !== right.kind || left.connectionId !== right.connectionId) {
    return false;
  }
  if (left.kind === "physical" && right.kind === "physical") {
    return left.path === right.path;
  }
  return (
    left.kind === "virtual" &&
    right.kind === "virtual" &&
    left.providerId === right.providerId &&
    left.source.path === right.source.path &&
    left.path === right.path
  );
}

export function getCreateContainerAvailability(
  request: Pick<CreateContainerRequest, "sources" | "destination">,
  environment: ContentOperationEnvironment
): ContentOperationAvailability {
  if (request.sources.length === 0) {
    return unavailable("empty-selection");
  }
  const virtualSource = request.sources[0]!.kind === "virtual" ? request.sources[0] : null;
  if (
    virtualSource
      ? virtualSource.location.providerId !== "zip" ||
        !request.sources.every(
          (source) =>
            source.kind === "virtual" &&
            source.location.providerId === "zip" &&
            source.location.connectionId === virtualSource.location.connectionId &&
            source.location.source.path === virtualSource.location.source.path &&
            source.location.path === virtualSource.location.path
        )
      : !request.sources.every(isPhysicalItem)
  ) {
    return unavailable("unsupported-source");
  }
  const sourceConnectionId = request.sources[0]!.location.connectionId;
  if (!request.sources.every((source) => source.location.connectionId === sourceConnectionId)) {
    return unavailable("mixed-source-connections");
  }
  const destinationAvailability = canWriteLocation(request.destination, environment);
  if (!destinationAvailability.available) {
    return destinationAvailability;
  }
  try {
    const sourceLocations = virtualSource
      ? [environment.storageRegistry.resolveItem(virtualSource.location.source)]
      : request.sources.map((source) =>
          environment.storageRegistry.resolveItem({ connectionId: source.location.connectionId, path: source.path })
        );
    const destination = environment.storageRegistry.resolveDirectory(request.destination);
    if (
      virtualSource &&
      (sourceLocations[0]!.target.kind !== "smb" ||
        destination.target.kind !== "smb" ||
        virtualSource.location.connectionId !== request.destination.connectionId)
    ) {
      return unavailable("unsupported-source");
    }
    const includesLocal = sourceLocations.some((source) => source.target.kind === "local") || destination.target.kind === "local";
    if (includesLocal && !environment.isCompanionPaired) {
      return unavailable("companion-unavailable");
    }
    if (sourceLocations.some((source) => !environment.storageRegistry.getCapabilities(source.resolvedTarget).readable)) {
      return unavailable("unsupported-source");
    }
    return { available: true };
  } catch {
    return unavailable("unsupported-source");
  }
}

export function startCreateContainer(
  request: CreateContainerRequest,
  environment: ArchiveContentOperationEnvironment
): ContentOperationExecution {
  const availability = getCreateContainerAvailability(request, environment);
  if (!availability.available || !isPhysicalLocation(request.destination)) {
    return {
      result: Promise.reject(new Error(`Container creation is unavailable: ${availability.reason ?? "unsupported"}`)),
      cancel: async () => undefined,
      isCancellationRequested: () => false,
    };
  }

  const virtualSource = request.sources[0]!.kind === "virtual" ? request.sources[0] : null;
  const execution = environment.archiveOperations.start({
    sources: virtualSource
      ? [environment.storageRegistry.resolveItem(virtualSource.location.source)]
      : request.sources.map((source) =>
          environment.storageRegistry.resolveItem({ connectionId: source.location.connectionId, path: source.path })
        ),
    destination: environment.storageRegistry.resolveDirectory(request.destination),
    name: request.name,
    ...(virtualSource ? { selectedMemberPaths: request.sources.map((source) => source.path) } : {}),
  });
  return {
    result: execution.result.then((result) => {
      if (result.status === "completed") return;
      throw new Error(result.status === "cancelled" ? "Container creation was cancelled" : "Container creation failed");
    }),
    async cancel() {
      await execution.cancel();
    },
    isCancellationRequested: execution.isCancellationRequested,
  };
}

export function isPartialContainerOutputError(error: unknown): boolean {
  return isApiError(error) && error.response?.data?.code === "local_archive_creation_partial";
}

export async function recoverInterruptedArchiveOperation(archiveOperations: StorageArchiveOperationCoordinator): Promise<boolean> {
  return archiveOperations.recoverInterrupted();
}

export function cancelForegroundArchiveOperationOnPageHide(archiveOperations: StorageArchiveOperationCoordinator): void {
  archiveOperations.cancelOnPageHide();
}

export function hasForegroundArchiveOperationWork(archiveOperations: StorageArchiveOperationCoordinator): boolean {
  return archiveOperations.hasForegroundWork();
}

export async function recoverInterruptedPhysicalTransfer(): Promise<boolean> {
  return false;
}

export async function deleteContentItems(items: readonly ContentItemHandle[], environment: ContentOperationEnvironment): Promise<void> {
  if (items.length === 0 || !items.every(isPhysicalItem)) {
    throw new Error("Content deletion is unavailable for virtual items");
  }
  for (const item of items) {
    if (!canWriteItem(item, environment).available) {
      throw new Error("Content deletion is unavailable for read-only locations");
    }
    const resolved = environment.storageRegistry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
    const result = await environment.storageRegistry.getBackend(resolved.target).remove(resolved);
    if (result.status !== "completed") throw new Error(`Content deletion failed: ${result.status}`);
  }
}

export async function renameContentItem(item: ContentItemHandle, name: string, environment: ContentOperationEnvironment): Promise<void> {
  if (!isPhysicalItem(item) || !canWriteItem(item, environment).available) {
    throw new Error("Content renaming is unavailable for this item");
  }
  const resolved = environment.storageRegistry.resolveItem({ connectionId: item.location.connectionId, path: item.path });
  const result = await environment.storageRegistry.getBackend(resolved.target).rename(resolved, name);
  if (result.status !== "completed") throw new Error(`Content renaming failed: ${result.status}`);
}

export async function createContentItem(
  location: ContentLocation,
  name: string,
  type: "file" | "directory",
  environment: ContentOperationEnvironment
): Promise<void> {
  const availability = getCreateContentItemAvailability(location, environment);
  if (!availability.available || !isPhysicalLocation(location)) {
    throw new Error(`Content creation is unavailable: ${availability.reason ?? "unsupported"}`);
  }
  const resolved = environment.storageRegistry.resolveDirectory(location);
  const result = await environment.storageRegistry.getBackend(resolved.target).create(resolved, { name, kind: type });
  if (result.status !== "completed") throw new Error(`Content creation failed: ${result.status}`);
}

export function getLocationDisplayName(location: ContentLocation, getConnectionName: (connectionId: string) => string): string {
  const path = location.kind === "physical" ? location.path : [location.source.path, location.path].filter(Boolean).join("/");
  return `${getConnectionName(location.connectionId)}:/${path}`;
}
