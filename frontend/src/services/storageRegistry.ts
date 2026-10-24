import { extractDriveId, isLocalDrive } from "./backendRouter";
import type {
  ResolvedStorageDirectoryLocation,
  ResolvedStorageItemLocation,
  ResolvedStorageTarget,
  StorageBackend,
  StorageBackendCapabilities,
  StorageBackendRegistry,
  StorageCapabilitySnapshot,
  StorageDirectoryReference,
  StorageItemReference,
  StorageTarget,
} from "./storageContracts";

const UNAVAILABLE_CAPABILITIES: StorageBackendCapabilities = {
  readable: false,
  writable: false,
  canList: false,
  canReadArchive: false,
  preview: { imageConversion: false, imageResizing: false, pdfNormalization: false },
  canWriteFile: false,
  canEditText: false,
  canResolveActivation: false,
  canOpenInNativeApp: false,
};

function resolveTarget(
  reference: StorageDirectoryReference | StorageItemReference,
  snapshot: StorageCapabilitySnapshot
): ResolvedStorageTarget {
  const target: StorageTarget = isLocalDrive(reference.connectionId)
    ? { kind: "local", driveId: extractDriveId(reference.connectionId) }
    : { kind: "smb", connectionId: reference.connectionId };
  const connection = snapshot.connections.find((candidate) => candidate.id === reference.connectionId) ?? null;
  if (!connection && target.kind === "smb") {
    throw new Error(`Storage connection ${reference.connectionId} is unavailable`);
  }
  if (target.kind === "local" && !snapshot.companion.drives.some((drive) => drive.driveId === target.driveId)) {
    throw new Error(`Local drive ${target.driveId} is unavailable`);
  }
  return { target, connection, capabilitySnapshot: snapshot };
}

export class BrowserStorageBackendRegistry implements StorageBackendRegistry {
  constructor(
    private snapshot: StorageCapabilitySnapshot,
    private readonly backends: Readonly<Record<StorageTarget["kind"], StorageBackend>>
  ) {}

  updateSnapshot(snapshot: StorageCapabilitySnapshot): void {
    this.snapshot = snapshot;
  }

  resolveDirectory(reference: StorageDirectoryReference): ResolvedStorageDirectoryLocation {
    const resolvedTarget = resolveTarget(reference, this.snapshot);
    return { target: resolvedTarget.target, path: reference.path, resolvedTarget };
  }

  resolveItem(reference: StorageItemReference): ResolvedStorageItemLocation {
    const resolvedTarget = resolveTarget(reference, this.snapshot);
    return { target: resolvedTarget.target, path: reference.path, resolvedTarget };
  }

  getBackend(target: StorageTarget): StorageBackend {
    return this.backends[target.kind];
  }

  getCapabilities(target: ResolvedStorageTarget): StorageBackendCapabilities {
    if (target.capabilitySnapshot.capabilityRevision !== this.snapshot.capabilityRevision) {
      return UNAVAILABLE_CAPABILITIES;
    }
    return this.getBackend(target.target).getCapabilities(target);
  }
}
