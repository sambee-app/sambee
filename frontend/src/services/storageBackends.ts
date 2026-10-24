import { type EditLockInfo, isApiError } from "../types";
import api, { ExpiredEditLockError } from "./api";
import { claimEditLockRecovery } from "./editLockRecovery";
import { assertLocalPreviewSupported } from "./previewPolicy";
import type {
  ArchiveCreationOperations,
  ArchiveSourceOperations,
  ContentTransferResult,
  ResolvedStorageDirectoryLocation,
  ResolvedStorageItemLocation,
  ResolvedStorageTarget,
  SameBackendTransferRequest,
  StorageActivationResult,
  StorageArchiveCreateRequest,
  StorageBackend,
  StorageBackendCapabilities,
  StorageCreateRequest,
  StorageEditStartResult,
  StorageEmptyDirectoryRemovalResult,
  StorageListOptions,
  StorageNativeOpenOptions,
  StorageNativeOpenResult,
  StorageOperationResult,
  StorageReadRequest,
  StorageRequestOptions,
  StorageTarget,
  WriteFileRequest,
} from "./storageContracts";

const ARCHIVE_RECOVERY_TTL_MS = 24 * 60 * 60_000;

const COMPLETED = {
  status: "completed",
  effects: { source: "unchanged", destination: "mutated" },
} as const satisfies StorageOperationResult;

function connectionId(target: StorageTarget): string {
  return target.kind === "smb" ? target.connectionId : `local-drive:${target.driveId}`;
}

function archiveTargetPath(request: StorageArchiveCreateRequest): string {
  return `${request.destination.path}/${request.name}`.replace(/^\//, "");
}

function localDriveId(target: StorageTarget): string {
  if (target.kind !== "local") throw new Error("Local storage backend requires a local target");
  return target.driveId;
}

async function createLocalArchiveExecution(
  driveId: string,
  sourcePaths: string[],
  targetPath: string,
  signal?: AbortSignal
): Promise<StorageOperationResult> {
  let execution = await api.startLocalArchiveCreation(`local-drive:${driveId}`, sourcePaths, targetPath);
  let cancellation: Promise<void> | null = null;
  const requestCancellation = (): Promise<void> => {
    cancellation ??= (async () => {
      execution = await api.cancelLocalArchiveExecutionWithRevisionRetry(
        `local-drive:${driveId}`,
        execution.execution_id,
        execution.revision
      );
    })();
    return cancellation;
  };
  const handleAbort = () => {
    void requestCancellation().catch(() => undefined);
  };
  signal?.addEventListener("abort", handleAbort, { once: true });
  try {
    if (signal?.aborted) {
      await requestCancellation();
    }
    execution = await api.waitForLocalArchiveExecution(`local-drive:${driveId}`, execution.execution_id);
    if (execution.phase === "cancelled") {
      return { status: "cancelled", effects: { source: "unknown", destination: "unknown" }, error: { code: "cancelled", detail: null } };
    }
    if (execution.phase === "failed") {
      throw new Error(execution.error ?? "Local archive creation failed");
    }
    return COMPLETED;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
  }
}

function assertOwned(kind: StorageTarget["kind"], ...targets: ResolvedStorageTarget[]): void {
  if (targets.some((target) => target.target.kind !== kind)) throw new Error("Storage backend does not own every requested target");
}

function requireEditLockContext(lockInfo: EditLockInfo): Required<Pick<EditLockInfo, "lock_id" | "lock_capability" | "operation_id">> {
  if (!lockInfo.lock_capability || !lockInfo.operation_id) throw new Error("Edit lock context is incomplete");
  return { lock_id: lockInfo.lock_id, lock_capability: lockInfo.lock_capability, operation_id: lockInfo.operation_id };
}

abstract class ApiStorageBackend implements StorageBackend {
  abstract readonly kind: StorageTarget["kind"];

  getCapabilities(target: ResolvedStorageTarget): StorageBackendCapabilities {
    const local = target.target.kind === "local";
    const paired = target.capabilitySnapshot.companion.status === "paired";
    const writable = local ? paired : target.connection?.access_mode === "read_write";
    return {
      readable: local ? paired : Boolean(target.connection),
      writable,
      canEditText: writable,
      canList: local ? paired : Boolean(target.connection),
      canReadArchive: !local || paired,
      preview: { imageConversion: !local, imageResizing: !local, pdfNormalization: !local },
      canWriteFile: writable,
      canResolveActivation: local && paired,
      canOpenInNativeApp: writable,
    };
  }

  async list(location: ResolvedStorageDirectoryLocation, options?: StorageListOptions) {
    assertOwned(this.kind, location.resolvedTarget);
    return api.listDirectory(connectionId(location.target), location.path, options);
  }

  async getInfo(location: ResolvedStorageItemLocation, options?: StorageRequestOptions) {
    assertOwned(this.kind, location.resolvedTarget);
    return api.getFileInfo(connectionId(location.target), location.path, options);
  }

  async read(location: ResolvedStorageItemLocation, request: StorageReadRequest, options?: StorageRequestOptions): Promise<Blob> {
    assertOwned(this.kind, location.resolvedTarget);
    const id = connectionId(location.target);
    if (location.target.kind === "local") assertLocalPreviewSupported(location.path, request, options);
    if (options?.download || request.kind === "raw") return api.getOriginalFileBlob(id, location.path, options);
    if (request.kind === "text") return new Blob([await api.getFileContent(id, location.path)], { type: "text/plain" });
    if (request.kind === "image")
      return api.getImageBlob(id, location.path, {
        ...options,
        viewportWidth: request.viewportWidth,
        viewportHeight: request.viewportHeight,
        no_resizing: request.noResizing,
      });
    return api.getPdfBlob(id, location.path, { ...options, pdfVariant: request.variant, screenProfile: request.screenProfile });
  }

  async writeFile(destination: ResolvedStorageDirectoryLocation, request: WriteFileRequest): Promise<StorageOperationResult> {
    assertOwned(this.kind, destination.resolvedTarget);
    const path = `${destination.path}/${request.name}`.replace(/^\//, "");
    await api.writeFile(connectionId(destination.target), path, request.content, request.name);
    return COMPLETED;
  }

  async invalidatePdfDerivative(
    item: ResolvedStorageItemLocation,
    profile?: { width: number; height: number; zoomPercent: number }
  ): Promise<void> {
    assertOwned(this.kind, item.resolvedTarget);
    await api.invalidatePdfDerivative(connectionId(item.target), item.path, profile);
  }

  async create(destination: ResolvedStorageDirectoryLocation, request: StorageCreateRequest): Promise<StorageOperationResult> {
    assertOwned(this.kind, destination.resolvedTarget);
    await api.createItem(connectionId(destination.target), destination.path, request.name, request.kind);
    return COMPLETED;
  }

  async rename(item: ResolvedStorageItemLocation, name: string): Promise<StorageOperationResult> {
    assertOwned(this.kind, item.resolvedTarget);
    await api.renameItem(connectionId(item.target), item.path, name);
    return COMPLETED;
  }
  async remove(item: ResolvedStorageItemLocation): Promise<StorageOperationResult> {
    assertOwned(this.kind, item.resolvedTarget);
    await api.deleteItem(connectionId(item.target), item.path);
    return COMPLETED;
  }
  async removeEmptyDirectory(item: ResolvedStorageItemLocation): Promise<StorageEmptyDirectoryRemovalResult> {
    assertOwned(this.kind, item.resolvedTarget);
    try {
      await api.removeEmptyDirectory(connectionId(item.target), item.path);
      return { status: "removed" };
    } catch (error) {
      const detail = isApiError(error) ? error.response?.data?.detail : null;
      if (
        isApiError(error) &&
        error.response?.status === 409 &&
        typeof detail === "string" &&
        detail.startsWith("Directory is not empty:")
      ) {
        return { status: "not_empty" };
      }
      throw error;
    }
  }
  async copyWithinBackend(request: SameBackendTransferRequest): Promise<ContentTransferResult> {
    return this.transfer(request, false);
  }
  async moveWithinBackend(request: SameBackendTransferRequest): Promise<ContentTransferResult> {
    return this.transfer(request, true);
  }
  private async transfer(request: SameBackendTransferRequest, move: boolean): Promise<ContentTransferResult> {
    assertOwned(this.kind, request.source.resolvedTarget, request.destination.resolvedTarget);
    const name = request.targetName ?? request.source.path.split("/").pop() ?? "";
    const destination = `${request.destination.path}/${name}`.replace(/^\//, "");
    const sourceConnectionId = connectionId(request.source.target);
    const destinationConnectionId = connectionId(request.destination.target);
    if (move) {
      return api.moveItem(
        sourceConnectionId,
        request.source.path,
        destination,
        request.idempotencyKey,
        destinationConnectionId,
        request.targetResolutionPolicy,
        { signal: request.signal, transferAttemptId: request.transferAttemptId }
      );
    } else {
      return api.copyItem(
        sourceConnectionId,
        request.source.path,
        destination,
        request.idempotencyKey,
        destinationConnectionId,
        request.targetResolutionPolicy,
        { signal: request.signal, transferAttemptId: request.transferAttemptId }
      );
    }
  }
  readonly archive: ArchiveSourceOperations = {
    listDirectory: (source, path, options) => api.listArchiveDirectory(connectionId(source.target), source.path, path, options),
    readMember: (source, path, request, options) => {
      if (source.target.kind === "local") assertLocalPreviewSupported(path, request, options);
      return api.getArchiveMember(connectionId(source.target), source.path, path, {
        download: options?.download,
        request,
        signal: options?.signal,
      });
    },
    invalidateMemberPdfDerivative: (source, path, profile) =>
      api.invalidateArchiveMemberPdfDerivative(connectionId(source.target), source.path, path, profile),
  };
  readonly editing = {
    begin: async (item: ResolvedStorageItemLocation): Promise<StorageEditStartResult> => {
      assertOwned(this.kind, item.resolvedTarget);
      if (!this.getCapabilities(item.resolvedTarget).canEditText) return { kind: "read-only" };
      const id = connectionId(item.target);
      const recovery = await claimEditLockRecovery(id, item.path);
      let lockInfo: EditLockInfo;
      try {
        const saved = recovery.load();
        if (saved) {
          try {
            await api.heartbeatEditLock(id, item.path, saved);
            lockInfo = saved;
          } catch (error) {
            if (!(error instanceof ExpiredEditLockError)) throw error;
            recovery.clear();
            lockInfo = await api.acquireEditLock(id, item.path);
          }
        } else {
          lockInfo = await api.acquireEditLock(id, item.path);
        }
        requireEditLockContext(lockInfo);
        recovery.save(lockInfo);
      } catch (error) {
        await recovery.release();
        throw error;
      }
      let lockContext = requireEditLockContext(lockInfo);
      let released = false;
      return {
        kind: "acquired",
        session: {
          heartbeat: () => api.heartbeatEditLock(id, item.path, lockInfo),
          writeText: async (content, options) => {
            try {
              await api.writeTextWithEditLock(id, item.path, content, lockContext, { mimeType: options?.mimeType });
            } catch (error) {
              if (!(error instanceof ExpiredEditLockError)) throw error;

              lockInfo = await api.acquireEditLock(id, item.path);
              lockContext = requireEditLockContext(lockInfo);
              recovery.save(lockInfo);
              await api.writeTextWithEditLock(id, item.path, content, lockContext, { mimeType: options?.mimeType });
            }
          },
          release: async () => {
            if (released) return;
            try {
              await api.releaseEditLock(id, item.path, lockInfo);
              recovery.clear();
              released = true;
            } finally {
              await recovery.release();
            }
          },
        },
      };
    },
  };
}

export class SambeeSmbBackend extends ApiStorageBackend {
  readonly kind = "smb" as const;
  readonly archiveCreation: ArchiveCreationOperations = {
    prepareCreate: async (request) => {
      if (
        request.selectedMemberPaths &&
        (request.sources.length !== 1 ||
          request.sources[0]!.target.kind !== "smb" ||
          request.destination.target.kind !== "smb" ||
          connectionId(request.sources[0]!.target) !== connectionId(request.destination.target))
      ) {
        throw new Error("ZIP member creation requires a same-connection SMB destination");
      }
      const operation = await api.prepareArchiveOperation({
        contract_version: "v2",
        kind: "create",
        source_connection_id: connectionId(request.sources[0]!.target),
        source_path: request.selectedMemberPaths ? request.sources[0]!.path : "",
        destination_connection_id: connectionId(request.destination.target),
        destination_path: archiveTargetPath(request),
        plan_json: JSON.stringify({ source_paths: request.sources.map((source) => source.path) }),
        ...(request.selectedMemberPaths ? { selected_member_paths: [...request.selectedMemberPaths] } : {}),
      });
      return {
        recovery: {
          schemaVersion: 2,
          contractVersion: "v2",
          backendKind: "smb",
          opaqueOperationId: operation.id,
          expiresAt: Date.now() + ARCHIVE_RECOVERY_TTL_MS,
        },
      };
    },
    execute: async (_request, context) => {
      if (context.mode !== "durable") throw new Error("SMB archive creation requires a durable operation");
      await api.executeArchiveCreation(context.preparation.recovery.opaqueOperationId);
      return COMPLETED;
    },
    cancel: async (recovery) => {
      await api.cancelArchiveOperation(recovery.opaqueOperationId);
      return { status: "cancelled", effects: { source: "unknown", destination: "unknown" }, error: { code: "cancelled", detail: null } };
    },
  };
  async openInNativeApp(item: ResolvedStorageItemLocation, options: StorageNativeOpenOptions): Promise<StorageNativeOpenResult> {
    return {
      kind: "browser-launch",
      uri: await api.getCompanionUri(connectionId(item.target), item.path, options.themeJson, { forcePicker: options.forcePicker }),
    };
  }
}
export class CompanionLocalBackend extends ApiStorageBackend {
  readonly kind = "local" as const;
  readonly archiveCreation: ArchiveCreationOperations = {
    execute: async (request, context, signal) => {
      if (context.mode === "direct-local") {
        assertOwned(this.kind, ...request.sources.map((source) => source.resolvedTarget), request.destination.resolvedTarget);
        return createLocalArchiveExecution(
          localDriveId(request.sources[0]!.target),
          request.sources.map((source) => source.path),
          archiveTargetPath(request),
          signal
        );
      }
      const session = await api.getArchiveCompanionSession(context.preparation.recovery.opaqueOperationId);
      if (request.sources[0]!.target.kind === "local") {
        assertOwned(this.kind, ...request.sources.map((source) => source.resolvedTarget));
        await api.createLocalArchiveToSmb(
          connectionId(request.sources[0]!.target),
          request.sources.map((source) => source.path),
          archiveTargetPath(request),
          context.preparation.recovery.opaqueOperationId,
          session.token
        );
      } else {
        assertOwned(this.kind, request.destination.resolvedTarget);
        await api.createSmbArchiveToLocal(
          connectionId(request.destination.target),
          archiveTargetPath(request),
          context.preparation.recovery.opaqueOperationId,
          session.token
        );
      }
      return COMPLETED;
    },
  };
  async resolveActivation(item: ResolvedStorageItemLocation): Promise<StorageActivationResult> {
    const resolution = await api.resolveLocalActivation(connectionId(item.target), item.path);
    return { connectionId: `local-drive:${resolution.drive_id}`, path: resolution.path, type: resolution.item.type, item: resolution.item };
  }
  async openInNativeApp(item: ResolvedStorageItemLocation, options: StorageNativeOpenOptions): Promise<StorageNativeOpenResult> {
    await api.openLocalFile(connectionId(item.target), item.path, { forcePicker: options.forcePicker });
    return { kind: "opened-locally" };
  }
}
