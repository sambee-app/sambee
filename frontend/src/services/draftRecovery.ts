import { authSession } from "./authSession";

const DRAFT_PREFIX = "sambee_oidc_draft";
const MAX_DRAFT_BYTES = 2 * 1024 * 1024;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DRAFT_RECOVERY_CHANGED_EVENT = "sambee:draft-recovery-changed";

export type DraftEditorType = "markdown" | "text";

export interface DraftSnapshot {
  baseline: string;
  baselineHash: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface UnsavedDraftMetadata {
  connectionId: string;
  path: string;
  editorType: DraftEditorType;
  createdAt: number;
  updatedAt: number;
}

export type DraftSaveResult =
  | { saved: true }
  | { saved: false; reason: "no-user" | "too-large" | "storage-unavailable" | "stale-checkpoint" };

export interface DraftCheckpoint {
  readonly revision: number;
}

export interface DraftCheckpointSession {
  capture(revision: number): DraftCheckpoint;
  commit(checkpoint: DraftCheckpoint, baseline: string, content: string): DraftSaveResult;
  dispose(): void;
}

interface RegisteredDraft {
  snapshot: () => void;
}

const registeredDrafts = new Set<RegisteredDraft>();
const checkpointSessions = new Map<string, object>();

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function hashBaseline(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function keyForUser(userId: string | null, connectionId: string, path: string, editorType: DraftEditorType): string | null {
  return userId ? `${DRAFT_PREFIX}:${userId}:${connectionId}:${editorType}:${encodeURIComponent(normalizePath(path))}` : null;
}

function key(connectionId: string, path: string, editorType: DraftEditorType): string | null {
  return keyForUser(authSession.getUserId(), connectionId, path, editorType);
}

function parseDraftSnapshot(value: string): DraftSnapshot | null {
  try {
    const parsed = JSON.parse(value) as Partial<DraftSnapshot>;
    if (
      typeof parsed.baseline !== "string" ||
      typeof parsed.content !== "string" ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null;
    }

    return {
      baseline: parsed.baseline,
      baselineHash: typeof parsed.baselineHash === "string" ? parsed.baselineHash : hashBaseline(parsed.baseline),
      content: parsed.content,
      createdAt: typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : parsed.updatedAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function isExpired(snapshot: DraftSnapshot): boolean {
  return Date.now() - snapshot.updatedAt > DRAFT_MAX_AGE_MS;
}

function notifyDraftRecoveryChanged(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new Event(DRAFT_RECOVERY_CHANGED_EVENT));
}

function parseDraftKey(storageKey: string, userId: string): Omit<UnsavedDraftMetadata, "createdAt" | "updatedAt"> | null {
  const prefix = `${DRAFT_PREFIX}:${userId}:`;
  if (!storageKey.startsWith(prefix)) {
    return null;
  }

  const parts = storageKey.slice(prefix.length).split(":");
  if (parts.length !== 3) {
    return null;
  }

  const [connectionId, editorType, encodedPath] = parts;
  if (!connectionId || (editorType !== "markdown" && editorType !== "text") || !encodedPath) {
    return null;
  }

  try {
    return { connectionId, editorType, path: normalizePath(decodeURIComponent(encodedPath)) };
  } catch {
    return null;
  }
}

export function saveDraft(
  connectionId: string,
  path: string,
  editorType: DraftEditorType,
  baseline: string,
  content: string
): DraftSaveResult {
  const storageKey = key(connectionId, path, editorType);
  if (storageKey) checkpointSessions.delete(storageKey);
  return writeDraft(storageKey, baseline, content);
}

function writeDraft(
  storageKey: string | null,
  baseline: string,
  content: string,
  authority?: { isCurrent(): boolean; acknowledge(): void }
): DraftSaveResult {
  if (authority && !authority.isCurrent()) return { saved: false, reason: "stale-checkpoint" };
  if (new Blob([content]).size > MAX_DRAFT_BYTES) {
    return { saved: false, reason: "too-large" };
  }
  if (!storageKey) {
    return { saved: false, reason: "no-user" };
  }
  const current = loadDraftAtKey(storageKey);
  const hadUnsavedDraft = current !== null && current.content !== current.baseline;
  const snapshot: DraftSnapshot = {
    baseline,
    baselineHash: hashBaseline(baseline),
    content,
    createdAt: current?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  try {
    const serialized = JSON.stringify(snapshot);
    if (authority && !authority.isCurrent()) return { saved: false, reason: "stale-checkpoint" };
    sessionStorage.setItem(storageKey, serialized);
    authority?.acknowledge();
    if (!hadUnsavedDraft) {
      notifyDraftRecoveryChanged();
    }
    return { saved: true };
  } catch {
    return { saved: false, reason: "storage-unavailable" };
  }
}

export function createDraftCheckpointSession(connectionId: string, path: string, editorType: DraftEditorType): DraftCheckpointSession {
  const identity = authSession.getIdentity();
  const storageKey = keyForUser(identity.userId, connectionId, path, editorType);
  const session = {};
  const checkpoints = new WeakSet<DraftCheckpoint>();
  let acknowledgedRevision = -1;
  let latestRevision = -1;
  let disposed = false;
  if (storageKey) checkpointSessions.set(storageKey, session);
  const isCurrent = (checkpoint: DraftCheckpoint) => {
    const currentIdentity = authSession.getIdentity();
    return (
      !disposed &&
      storageKey !== null &&
      checkpointSessions.get(storageKey) === session &&
      checkpoints.has(checkpoint) &&
      checkpoint.revision > acknowledgedRevision &&
      currentIdentity.userId === identity.userId &&
      currentIdentity.epoch === identity.epoch
    );
  };

  return {
    capture(revision) {
      if (!Number.isSafeInteger(revision) || revision < 0 || revision < latestRevision) {
        throw new RangeError("Draft checkpoint revisions must be nonnegative, safe integers in increasing order");
      }
      latestRevision = revision;
      const checkpoint = Object.freeze({ revision });
      checkpoints.add(checkpoint);
      return checkpoint;
    },
    commit(checkpoint, baseline, content) {
      if (!identity.userId) return { saved: false, reason: "no-user" };
      return writeDraft(storageKey, baseline, content, {
        isCurrent: () => isCurrent(checkpoint),
        acknowledge: () => {
          acknowledgedRevision = checkpoint.revision;
        },
      });
    },
    dispose() {
      disposed = true;
      if (storageKey && checkpointSessions.get(storageKey) === session) checkpointSessions.delete(storageKey);
    },
  };
}

export function loadDraft(connectionId: string, path: string, editorType: DraftEditorType): DraftSnapshot | null {
  const storageKey = key(connectionId, path, editorType);
  return storageKey ? loadDraftAtKey(storageKey) : null;
}

function loadDraftAtKey(storageKey: string): DraftSnapshot | null {
  try {
    const value = sessionStorage.getItem(storageKey);
    if (!value) {
      return null;
    }
    const parsed = parseDraftSnapshot(value);
    if (!parsed) {
      sessionStorage.removeItem(storageKey);
      notifyDraftRecoveryChanged();
      return null;
    }
    if (isExpired(parsed)) {
      sessionStorage.removeItem(storageKey);
      notifyDraftRecoveryChanged();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(connectionId: string, path: string, editorType: DraftEditorType): void {
  const storageKey = key(connectionId, path, editorType);
  if (storageKey) {
    checkpointSessions.delete(storageKey);
    try {
      const hadDraft = sessionStorage.getItem(storageKey) !== null;
      sessionStorage.removeItem(storageKey);
      if (hadDraft) {
        notifyDraftRecoveryChanged();
      }
    } catch {
      // Storage can be unavailable in privacy-restricted browser sessions.
    }
  }
}

export function getUnsavedDraftsForConnection(connectionId: string): UnsavedDraftMetadata[] {
  const userId = authSession.getUserId();
  if (!userId) {
    return [];
  }

  const drafts: UnsavedDraftMetadata[] = [];
  let changed = false;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey) {
        continue;
      }
      const metadata = parseDraftKey(storageKey, userId);
      if (!metadata || metadata.connectionId !== connectionId) {
        continue;
      }
      const value = sessionStorage.getItem(storageKey);
      const snapshot = value ? parseDraftSnapshot(value) : null;
      if (!snapshot || isExpired(snapshot)) {
        sessionStorage.removeItem(storageKey);
        changed = true;
        continue;
      }
      if (snapshot.content !== snapshot.baseline) {
        drafts.push({ ...metadata, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt });
      }
    }
  } catch {
    return drafts;
  }

  if (changed) {
    notifyDraftRecoveryChanged();
  }

  return drafts;
}

export function purgeExpiredDraftsForCurrentUser(): void {
  const userId = authSession.getUserId();
  if (!userId) {
    return;
  }

  let changed = false;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = sessionStorage.key(index);
      if (!storageKey || !parseDraftKey(storageKey, userId)) {
        continue;
      }
      const value = sessionStorage.getItem(storageKey);
      const snapshot = value ? parseDraftSnapshot(value) : null;
      if (!snapshot || isExpired(snapshot)) {
        sessionStorage.removeItem(storageKey);
        changed = true;
      }
    }
  } catch {
    return;
  }

  if (changed) {
    notifyDraftRecoveryChanged();
  }
}

export function registerDraftSnapshot(snapshot: () => void): () => void {
  const registered = { snapshot };
  registeredDrafts.add(registered);
  return () => registeredDrafts.delete(registered);
}

export function snapshotRegisteredDrafts(): void {
  for (const registered of registeredDrafts) {
    registered.snapshot();
  }
}

export function clearCurrentUserDrafts(): void {
  const userId = authSession.getUserId();
  if (!userId) {
    return;
  }
  const prefix = `${DRAFT_PREFIX}:${userId}:`;
  for (const storageKey of checkpointSessions.keys()) {
    if (storageKey.startsWith(prefix)) checkpointSessions.delete(storageKey);
  }
  let changed = false;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = sessionStorage.key(index);
      if (storageKey?.startsWith(prefix)) {
        sessionStorage.removeItem(storageKey);
        changed = true;
      }
    }
  } catch {
    return;
  }
  if (changed) {
    notifyDraftRecoveryChanged();
  }
}
