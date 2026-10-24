import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConflictDecision, ConflictResolution } from "../../components/FileBrowser/OverwriteConflictDialog";
import { isLocalDrive } from "../../services/backendRouter";
import { logger } from "../../services/logger";
import type { StorageBackendRegistry, TargetResolutionPolicy } from "../../services/storageContracts";
import type { ConflictInfo, Connection } from "../../types";
import { FileType, isApiError } from "../../types";
import { getConnectionById, isConnectionWritable } from "./access";
import type { BrowserUploadEntry } from "./browserUploadManifest";
import { type ContentOperationEnvironment, createContentItem, publishBrowserFile } from "./contentOperations";
import { type PhysicalLocation, physicalLocation } from "./contentProviders";
import type { PaneId, UseFileBrowserPaneReturn } from "./types";

const MAX_UPLOAD_DIRECTORY_CREATE_RETRIES = 3;

interface UploadConflict {
  info: ConflictInfo;
  kind: "file" | "directory";
  actions: readonly ConflictResolution[];
  path: string;
  connectionId: string;
}

interface UploadProgress {
  current: number;
  total: number;
  name: string;
  connectionId: string;
  bytes: number | null;
  size: number;
  phase: "sending" | "publishing";
  completed: number;
  skipped: number;
  failed: number;
  unknown: number;
}

interface UploadDirectoryChanges {
  connectionId: string;
  writingPaths: Set<string>;
  deferredPaths: Set<string>;
}

interface BrowserUploadConfig {
  blocked: boolean;
  connections: Connection[];
  environment: ContentOperationEnvironment;
  getPaneForId: (paneId: PaneId) => UseFileBrowserPaneReturn;
  registry: StorageBackendRegistry;
  resolvePolicy: (resolution: ConflictResolution) => TargetResolutionPolicy;
  showNotice: (message: string) => void;
  t: TFunction;
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function useBrowserUpload({
  blocked,
  connections,
  environment,
  getPaneForId,
  registry,
  resolvePolicy,
  showNotice,
  t,
}: BrowserUploadConfig) {
  const abortRef = useRef<AbortController | null>(null);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const directoryChangesRef = useRef<UploadDirectoryChanges | null>(null);
  const conflictResolveRef = useRef<((value: ConflictDecision | null) => void) | null>(null);
  const [uploadSessionActive, setUploadSessionActive] = useState(false);
  const [uploadPreparing, setUploadPreparing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadConflict, setUploadConflict] = useState<UploadConflict | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      conflictResolveRef.current?.(null);
      conflictResolveRef.current = null;
    },
    []
  );

  const resolveUploadConflict = useCallback((decision: ConflictDecision | null) => {
    conflictResolveRef.current?.(decision);
    conflictResolveRef.current = null;
  }, []);

  const cancelUpload = useCallback(() => {
    abortRef.current?.abort();
    resolveUploadConflict(null);
  }, [resolveUploadConflict]);

  const deferDirectoryChange = useCallback((connectionId: string, path: string): boolean => {
    const changes = directoryChangesRef.current;
    if (changes?.connectionId !== connectionId || !changes.writingPaths.has(path)) return false;
    changes.deferredPaths.add(path);
    return true;
  }, []);

  const startBrowserUpload = useCallback(
    (paneId: PaneId, destination: PhysicalLocation, prepare: (signal: AbortSignal) => Promise<BrowserUploadEntry[]>) => {
      if (abortRef.current || blockedRef.current) return;
      const controller = new AbortController();
      const directoryChanges: UploadDirectoryChanges = {
        connectionId: destination.connectionId,
        writingPaths: new Set<string>(),
        deferredPaths: new Set<string>(),
      };
      abortRef.current = controller;
      directoryChangesRef.current = directoryChanges;
      setUploadSessionActive(true);
      setUploadPreparing(true);
      showNotice("");
      void (async () => {
        const counts = { completed: 0, skipped: 0, failed: 0, unknown: 0, created: 0, merged: 0, skippedFolders: 0, failedFolders: 0 };
        const changedPaths = new Set<string>();
        let totalFiles = 0;
        let halted = false;
        const requestConflict = async (
          info: ConflictInfo,
          kind: "file" | "directory",
          actions: readonly ConflictResolution[],
          path: string
        ) => {
          setUploadConflict({ info, kind, actions, path, connectionId: destination.connectionId });
          const decision = await new Promise<ConflictDecision | null>((resolve) => {
            conflictResolveRef.current = resolve;
          });
          setUploadConflict(null);
          if (!decision) controller.abort();
          return decision;
        };
        try {
          const manifest = await prepare(controller.signal);
          const hasDirectories = manifest.some((entry) => entry.kind === "directory");
          totalFiles = manifest.filter((entry) => entry.kind === "file").length;
          const current = getPaneForId(paneId);
          const location = current.currentLocation;
          if (
            controller.signal.aborted ||
            location.kind !== "physical" ||
            location.connectionId !== destination.connectionId ||
            location.path !== destination.path ||
            !current.contentCapabilities.mutate ||
            !isConnectionWritable(getConnectionById(connections, destination.connectionId)) ||
            (isLocalDrive(destination.connectionId) && !environment.isCompanionPaired)
          ) {
            if (!controller.signal.aborted) showNotice(t("fileBrowser.transfers.uploadDestinationChanged"));
            return;
          }
          const mappedDirectories = new Map<string, string>();
          const skippedDirectories = new Set<string>();
          const failedDirectories = new Set<string>();
          let fileIndex = 0;
          for (const entry of manifest) {
            if (controller.signal.aborted) break;
            if (entry.kind === "file") fileIndex++;
            if (halted && (entry.kind === "directory" || entry.segments.length > 1)) continue;
            const relativeParent = entry.segments.slice(0, -1).join("/");
            if (skippedDirectories.has(relativeParent) || failedDirectories.has(relativeParent)) {
              const failed = failedDirectories.has(relativeParent);
              if (entry.kind === "file") {
                if (failed) counts.failed++;
                else counts.skipped++;
              } else (failed ? failedDirectories : skippedDirectories).add(entry.segments.join("/"));
              continue;
            }
            const parent = mappedDirectories.get(relativeParent) ?? destination.path;
            const originalName = entry.segments[entry.segments.length - 1];
            if (!originalName) throw new Error("Upload path is missing a name.");
            if (entry.kind === "directory") {
              let name = originalName;
              let resolved = false;
              let creationConflicts = 0;
              while (!controller.signal.aborted && !resolved) {
                const path = joinPath(parent, name);
                const target = registry.resolveItem({ connectionId: destination.connectionId, path });
                let existing = null;
                try {
                  existing = await registry.getBackend(target.target).getInfo(target);
                } catch (error) {
                  if (!isApiError(error) || error.response?.status !== 404) throw error;
                }
                if (existing?.type === FileType.DIRECTORY) {
                  counts.merged++;
                  mappedDirectories.set(entry.segments.join("/"), path);
                  resolved = true;
                } else if (existing) {
                  const incoming = {
                    name: originalName,
                    path: entry.segments.join("/"),
                    type: FileType.DIRECTORY,
                    is_readable: true,
                    is_hidden: false,
                  };
                  const decision = await requestConflict(
                    { incoming_file: incoming, existing_file: existing },
                    "directory",
                    ["skip", "rename"],
                    incoming.path
                  );
                  if (!decision || decision.resolution === "skip") {
                    skippedDirectories.add(entry.segments.join("/"));
                    counts.skippedFolders++;
                    resolved = true;
                  } else if (decision.targetName) name = decision.targetName;
                } else {
                  try {
                    if (controller.signal.aborted) break;
                    directoryChanges.writingPaths.add(parent);
                    await createContentItem(physicalLocation(destination.connectionId, parent), name, "directory", environment);
                    changedPaths.add(parent);
                    counts.created++;
                    mappedDirectories.set(entry.segments.join("/"), path);
                    resolved = true;
                  } catch (error) {
                    if (isApiError(error) && error.response?.status === 409 && ++creationConflicts < MAX_UPLOAD_DIRECTORY_CREATE_RETRIES) {
                      continue;
                    }
                    logger.error("Upload folder creation failed", { path, error }, "file-browser");
                    counts.failedFolders++;
                    failedDirectories.add(entry.segments.join("/"));
                    resolved = true;
                  }
                }
              }
              continue;
            }
            const file = entry.file;
            let lastProgressUpdate = 0;
            let lastReportedBytes: number | null = null;
            const updateProgress = (bytes: number | null, phase: UploadProgress["phase"] = "sending") => {
              const now = performance.now();
              if (bytes !== null && lastReportedBytes !== null && bytes > 0 && bytes < file.size && now - lastProgressUpdate < 100) return;
              lastProgressUpdate = now;
              lastReportedBytes = bytes;
              setUploadProgress({
                current: fileIndex,
                total: totalFiles,
                name: entry.segments.join("/"),
                connectionId: destination.connectionId,
                bytes,
                size: file.size,
                phase,
                ...counts,
              });
            };
            setUploadPreparing(false);
            let name = originalName;
            let policy: TargetResolutionPolicy = "ask";
            while (!controller.signal.aborted) {
              try {
                updateProgress(null);
                directoryChanges.writingPaths.add(parent);
                const result = await publishBrowserFile(file, destination.connectionId, joinPath(parent, name), policy, {
                  signal: controller.signal,
                  onProgress: (bytes) => updateProgress(bytes),
                  onUploadSent: () => updateProgress(file.size, "publishing"),
                });
                if (result.status === "completed") {
                  counts.completed++;
                  changedPaths.add(parent);
                } else if (result.status === "skipped") counts.skipped++;
                else if (result.status === "outcome_unknown") {
                  counts.unknown++;
                  changedPaths.add(parent);
                  halted = entry.segments.length > 1;
                } else if (result.status === "failed") {
                  counts.failed++;
                  logger.error("File upload failed", { name: entry.segments.join("/"), error: result.error }, "file-browser");
                }
                break;
              } catch (error) {
                const detail = isApiError(error) ? error.response?.data?.detail : null;
                if (isApiError(error) && error.response?.status === 409 && typeof detail === "object" && detail !== null) {
                  const conflict = detail as ConflictInfo;
                  const actions: readonly ConflictResolution[] =
                    conflict.existing_file.type === FileType.DIRECTORY ? ["skip", "rename"] : ["skip", "overwrite", "rename"];
                  const decision = await requestConflict(conflict, "file", actions, entry.segments.join("/"));
                  if (!decision) break;
                  if (decision.resolution === "skip") {
                    counts.skipped++;
                    break;
                  }
                  if (decision.resolution === "rename" && decision.targetName) name = decision.targetName;
                  policy = resolvePolicy(decision.resolution);
                  continue;
                }
                if (!controller.signal.aborted) {
                  counts.failed++;
                  logger.error("File upload failed", { name: entry.segments.join("/"), error }, "file-browser");
                }
                break;
              }
            }
          }
          const cancelled = controller.signal.aborted ? totalFiles - counts.completed - counts.skipped - counts.failed - counts.unknown : 0;
          const problems = [
            counts.skipped && t("fileBrowser.transfers.uploadSkipped", { count: counts.skipped }),
            counts.failed && t("fileBrowser.transfers.uploadFailed", { count: counts.failed }),
            counts.failedFolders && t("fileBrowser.transfers.uploadFolderFailed", { count: counts.failedFolders }),
            counts.unknown && t("fileBrowser.transfers.uploadUnknown", { count: counts.unknown }),
            cancelled && t("fileBrowser.transfers.uploadCancelled", { count: cancelled }),
            halted && t("fileBrowser.transfers.uploadInspectDestination"),
            halted &&
              t("fileBrowser.transfers.uploadRemaining", {
                count: totalFiles - counts.completed - counts.skipped - counts.failed - counts.unknown,
              }),
            (controller.signal.aborted || counts.failedFolders > 0) && changedPaths.size > 0 && t("fileBrowser.transfers.uploadPartial"),
          ]
            .filter(Boolean)
            .join(", ");
          const summary = t("fileBrowser.transfers.uploadComplete", { count: counts.completed });
          const folders = hasDirectories
            ? t("fileBrowser.transfers.uploadFolders", { created: counts.created, merged: counts.merged, skipped: counts.skippedFolders })
            : "";
          showNotice(
            [problems ? t("fileBrowser.transfers.uploadSummaryWithIssues", { summary, issues: problems }) : summary, folders]
              .filter(Boolean)
              .join(" · ")
          );
        } catch (error) {
          if (!controller.signal.aborted) {
            logger.error("Browser upload failed", { error, destination }, "file-browser");
            const message = error instanceof Error ? error.message : t("fileBrowser.transfers.uploadFailed", { count: 1 });
            showNotice(changedPaths.size ? `${message} ${t("fileBrowser.transfers.uploadPartial")}` : message);
          } else
            showNotice(
              changedPaths.size
                ? t("fileBrowser.transfers.uploadPartial")
                : t("fileBrowser.transfers.uploadCancelled", { count: totalFiles })
            );
        } finally {
          resolveUploadConflict(null);
          setUploadConflict(null);
          setUploadProgress(null);
          setUploadPreparing(false);
          setUploadSessionActive(false);
          abortRef.current = null;
          directoryChangesRef.current = null;
          if (changedPaths.size) {
            getPaneForId("left").invalidateConnectionCache(destination.connectionId);
            getPaneForId("right").invalidateConnectionCache(destination.connectionId);
          }
          if (changedPaths.size || directoryChanges.deferredPaths.size) {
            const affectedPaths = new Set([...changedPaths, ...directoryChanges.deferredPaths]);
            for (const paneId of ["left", "right"] as const) {
              const visiblePane = getPaneForId(paneId);
              const location = visiblePane.currentLocation;
              if (location.kind === "physical" && location.connectionId === destination.connectionId && affectedPaths.has(location.path)) {
                void visiblePane.reloadCurrentLocation({ forceRefresh: true, preserveVisibleContent: true });
              }
            }
          }
        }
      })();
    },
    [connections, environment, getPaneForId, registry, resolvePolicy, resolveUploadConflict, showNotice, t]
  );

  return {
    startBrowserUpload,
    cancelUpload,
    deferDirectoryChange,
    resolveUploadConflict,
    uploadConflict,
    uploadProgress,
    uploadPreparing,
    uploadSessionActive,
  };
}
