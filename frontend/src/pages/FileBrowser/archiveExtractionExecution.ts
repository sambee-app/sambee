import api, {
  type ArchiveLiveExtractionStatus,
  type LocalArchiveExecution,
  type LocalArchiveRelayExtractionStatus,
} from "../../services/api";
import { isLocalDrive } from "../../services/backendRouter";
import {
  beginForegroundLocalArchiveRequest,
  clearForegroundArchiveOperation,
  clearForegroundLocalArchiveRequest,
  storeForegroundArchiveOperation,
} from "../../services/foregroundArchiveOperation";
import type { ArchiveExtractionDecisionAction, ArchiveOperation } from "../../types";
import { isApiError } from "../../types";
import type {
  ArchiveExtractionConflictAction,
  ArchiveExtractionExecution,
  ArchiveExtractionOutcome,
  ArchiveExtractionRequest,
  ArchiveExtractionSummary,
} from "./contentProviders";

function nonNegativeCounter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function archiveExtractionSummary(checkpointJson: string | undefined): ArchiveExtractionSummary {
  try {
    const checkpoint: unknown = JSON.parse(checkpointJson ?? "{}");
    if (typeof checkpoint !== "object" || checkpoint === null) {
      throw new Error("Archive extraction checkpoint is invalid");
    }
    const aggregate = "aggregate_counters" in checkpoint ? checkpoint.aggregate_counters : checkpoint;
    if (typeof aggregate !== "object" || aggregate === null || Array.isArray(aggregate)) {
      throw new Error("Archive extraction aggregate is invalid");
    }
    return {
      filesExtracted: nonNegativeCounter(Reflect.get(aggregate, "files_extracted")),
      directoriesCreated: nonNegativeCounter(Reflect.get(aggregate, "directories_created")),
      extractedBytes: nonNegativeCounter(Reflect.get(aggregate, "extracted_bytes")),
      membersProcessed: nonNegativeCounter(Reflect.get(aggregate, "members_processed")),
      filesSkipped: nonNegativeCounter(Reflect.get(aggregate, "members_skipped")),
      filesReplaced: nonNegativeCounter(Reflect.get(aggregate, "files_replaced")),
      partialMembers: 0,
    };
  } catch {
    return {
      filesExtracted: 0,
      directoriesCreated: 0,
      extractedBytes: 0,
      membersProcessed: 0,
      filesSkipped: 0,
      filesReplaced: 0,
      partialMembers: 0,
    };
  }
}

function responseExtractionSummary(result: {
  aggregate_counters?: {
    files_extracted: number;
    directories_created: number;
    extracted_bytes: number;
    members_processed: number;
    members_skipped: number;
    files_replaced: number;
  };
}): ArchiveExtractionSummary {
  const aggregate = result.aggregate_counters;
  return {
    filesExtracted: nonNegativeCounter(aggregate?.files_extracted),
    directoriesCreated: nonNegativeCounter(aggregate?.directories_created),
    extractedBytes: nonNegativeCounter(aggregate?.extracted_bytes),
    membersProcessed: nonNegativeCounter(aggregate?.members_processed),
    filesSkipped: nonNegativeCounter(aggregate?.members_skipped),
    filesReplaced: nonNegativeCounter(aggregate?.files_replaced),
    partialMembers: 0,
  };
}

function companionExtractionOutcome(result: {
  files_extracted: number;
  directories_created: number;
  extracted_bytes: number;
  members_processed: number;
  members_skipped: number;
  files_replaced: number;
  phase?: string;
}): ArchiveExtractionOutcome {
  if (result.phase === "awaiting_user_decision") {
    throw new Error("Archive extraction decision must be read from the live source session");
  }
  const summary = responseExtractionSummary({ aggregate_counters: result });
  return { status: "completed", filesSkipped: summary.filesSkipped, summary };
}

function localRelayExtractionOutcome(status: LocalArchiveRelayExtractionStatus, destinationPathPrefix?: string): ArchiveExtractionOutcome {
  const pending = status.pending_decision;
  if (status.phase !== "awaiting_decision" || !pending || !Number.isSafeInteger(pending.revision) || pending.revision < 1) {
    throw new Error("Local archive relay decision is unavailable");
  }
  if (pending.kind === "member_error") {
    if (!pending.target_path || !pending.message) {
      throw new Error("Local archive relay member error details are invalid");
    }
    return {
      status: "awaiting-member-error",
      error: {
        memberPath: pending.member_path,
        targetPath: pending.target_path,
        message: pending.message,
        partialOutput: true,
      },
    };
  }
  return {
    status: "awaiting-decision",
    conflicts: [
      {
        source: { path: pending.source.path, size: pending.source.size, modifiedAt: pending.source.modified_at },
        target: {
          path: destinationPathPrefix ? [destinationPathPrefix, pending.target.path].filter(Boolean).join("/") : pending.target.path,
          size: pending.target.size,
          modifiedAt: pending.target.modified_at,
        },
        isDirectory: pending.is_directory,
      },
    ],
    allowedActions: pending.allowed_actions as ArchiveExtractionConflictAction[],
  };
}

function liveExtractionOutcome(status: ArchiveLiveExtractionStatus, destinationPathPrefix?: string): ArchiveExtractionOutcome {
  return localRelayExtractionOutcome(status, destinationPathPrefix);
}

function toExtractionOutcome(operation: ArchiveOperation): ArchiveExtractionOutcome {
  if (operation.phase === "completed") {
    const summary = archiveExtractionSummary(operation.checkpoint_json);
    return { status: "completed", filesSkipped: summary.filesSkipped, summary };
  }
  if (operation.phase === "cancelled") {
    return { status: "cancelled" };
  }
  throw new Error("Archive extraction did not reach a terminal state");
}

export function startZipArchiveExtraction(request: ArchiveExtractionRequest): ArchiveExtractionExecution {
  const { source: location, destination, selectedMemberPaths } = request;
  const destinationPath = destination.path;
  if (location.providerId !== "zip") {
    return {
      result: Promise.reject(new Error("Archive extraction is unavailable for this content provider")),
      cancel: async () => undefined,
      decide: async () => {
        throw new Error("Archive extraction is unavailable for this content provider");
      },
      onProgress: () => () => undefined,
      isCancellationRequested: () => false,
    };
  }

  let operationId: string | null = null;
  let localSignal: AbortSignal | null = null;
  let localExecution: { executionId: string; revision: number; pendingDecision?: LocalArchiveExecution["pendingDecision"] } | null = null;
  let localCancellation: Promise<void> | null = null;
  let awaitingDecision = false;
  let cancellationRequested = false;
  let localRelayDecision: { sourceSessionId: string; deliverySequence: number; decisionRevision: number; memberPath: string } | null = null;
  let serverRelayDecision: { sourceSessionId: string; deliverySequence: number; decisionRevision: number; memberPath: string } | null =
    null;
  let latestProgress: ArchiveExtractionSummary | null = null;
  const progressListeners = new Set<(summary: ArchiveExtractionSummary) => void>();

  const publishLocalProgress = (execution: Parameters<typeof responseExtractionSummary>[0]) => {
    latestProgress = responseExtractionSummary(execution);
    for (const listener of progressListeners) {
      listener(latestProgress);
    }
  };

  const cancelLocalExecution = async (): Promise<void> => {
    if (!localExecution) {
      return;
    }
    if (!localCancellation) {
      const execution = localExecution;
      localCancellation = (async () => {
        const cancelled = await api.cancelLocalArchiveExecutionWithRevisionRetry(
          location.connectionId,
          execution.executionId,
          execution.revision
        );
        execution.revision = cancelled.revision;
      })();
    }
    await localCancellation;
  };

  const finishServerOutcome = (outcome: ArchiveExtractionOutcome): ArchiveExtractionOutcome => {
    awaitingDecision = outcome.status === "awaiting-decision" || outcome.status === "awaiting-member-error";
    if (!awaitingDecision && operationId) {
      clearForegroundArchiveOperation(operationId);
    }
    return outcome;
  };

  const isLiveStatusUnavailable = (error: unknown): boolean =>
    isApiError(error) && (error.response?.status === 404 || error.response?.status === 409);

  const waitForLocalOutcome = async (): Promise<ArchiveExtractionOutcome> => {
    if (!localExecution) {
      throw new Error("Local archive extraction is unavailable");
    }
    const status = await api.waitForLocalArchiveExecution(location.connectionId, localExecution.executionId, publishLocalProgress);
    localExecution.revision = status.revision;
    localExecution.pendingDecision = status.pendingDecision;
    if (status.phase === "completed") {
      const summary = latestProgress ?? responseExtractionSummary(status);
      return { status: "completed", filesSkipped: summary.filesSkipped, summary };
    }
    if (status.phase === "cancelled") {
      return { status: "cancelled" };
    }
    if (status.phase === "awaiting_user_decision") {
      const pendingDecision = status.pendingDecision;
      awaitingDecision = true;
      if (!pendingDecision) {
        throw new Error("Local archive extraction is missing its pending decision");
      }
      if (pendingDecision.kind === "member_error") {
        return {
          status: "awaiting-member-error",
          error: {
            memberPath: pendingDecision.member_path,
            targetPath: pendingDecision.target_path,
            message: pendingDecision.message,
            partialOutput: pendingDecision.partial_output,
          },
        };
      }
      return {
        status: "awaiting-decision",
        conflicts: [
          {
            source: {
              path: pendingDecision.source.path,
              size: pendingDecision.source.size,
              modifiedAt: pendingDecision.source.modified_at,
            },
            target: {
              path: [destinationPath, pendingDecision.target.path].filter(Boolean).join("/"),
              size: pendingDecision.target.size,
              modifiedAt: pendingDecision.target.modified_at,
            },
            isDirectory: pendingDecision.is_directory,
          },
        ],
        allowedActions: pendingDecision.allowed_actions,
      };
    }
    throw new Error(status.error ?? "Local archive extraction failed");
  };

  const executeServerOperation = async (): Promise<ArchiveExtractionOutcome> => {
    if (!operationId) {
      throw new Error("Archive extraction operation is unavailable");
    }
    const operation = await api.executeArchiveExtraction(operationId);
    if (operation.phase !== "awaiting_user_decision") {
      return finishServerOutcome(toExtractionOutcome(operation));
    }
    let liveStatus: ArchiveLiveExtractionStatus;
    try {
      liveStatus = await api.getArchiveLiveExtractionStatus(operationId);
    } catch (error) {
      if (isLiveStatusUnavailable(error)) {
        return finishServerOutcome({ status: "interrupted" });
      }
      throw error;
    }
    const pending = liveStatus.pending_decision;
    if (!pending) {
      throw new Error("Live archive extraction decision is unavailable");
    }
    serverRelayDecision = {
      sourceSessionId: liveStatus.source_session_id,
      deliverySequence: pending.delivery_sequence,
      decisionRevision: pending.revision,
      memberPath: pending.member_path,
    };
    return finishServerOutcome(liveExtractionOutcome(liveStatus));
  };

  const executeCompanionOperation = async (): Promise<ArchiveExtractionOutcome> => {
    if (!operationId) throw new Error("Archive extraction operation is unavailable");
    const companionResult = isLocalDrive(location.connectionId)
      ? await api.extractLocalArchiveToSmb(location.connectionId, location.source.path, operationId)
      : await api.extractSmbArchiveToLocal(destination.connectionId, destinationPath, operationId);
    if (companionResult.phase === "awaiting_user_decision" && isLocalDrive(location.connectionId)) {
      const liveStatus = await api.getLocalArchiveRelayExtractionStatus(location.connectionId, operationId);
      const pending = liveStatus.pending_decision;
      if (
        !pending ||
        typeof liveStatus.source_session_id !== "string" ||
        !Number.isSafeInteger(pending.delivery_sequence) ||
        pending.delivery_sequence < 1
      ) {
        throw new Error("Local archive relay decision fence is invalid");
      }
      localRelayDecision = {
        sourceSessionId: liveStatus.source_session_id,
        deliverySequence: pending.delivery_sequence,
        decisionRevision: pending.revision,
        memberPath: pending.member_path,
      };
      return finishServerOutcome(localRelayExtractionOutcome(liveStatus));
    }
    if (companionResult.phase === "awaiting_user_decision") {
      let liveStatus: ArchiveLiveExtractionStatus;
      try {
        liveStatus = await api.getArchiveLiveExtractionStatus(operationId);
      } catch (error) {
        if (isLiveStatusUnavailable(error)) {
          return finishServerOutcome({ status: "interrupted" });
        }
        throw error;
      }
      const pending = liveStatus.pending_decision;
      if (!pending) {
        throw new Error("Live archive extraction decision is unavailable");
      }
      serverRelayDecision = {
        sourceSessionId: liveStatus.source_session_id,
        deliverySequence: pending.delivery_sequence,
        decisionRevision: pending.revision,
        memberPath: pending.member_path,
      };
      return finishServerOutcome(liveExtractionOutcome(liveStatus, destinationPath));
    }
    return finishServerOutcome(companionExtractionOutcome(companionResult));
  };

  const result = (async (): Promise<ArchiveExtractionOutcome> => {
    const sourceIsLocal = isLocalDrive(location.connectionId);
    const destinationIsLocal = isLocalDrive(destination.connectionId);
    if (sourceIsLocal && destinationIsLocal) {
      localSignal = beginForegroundLocalArchiveRequest();
      const onLocalAbort = () => {
        cancellationRequested = true;
        void cancelLocalExecution();
      };
      localSignal.addEventListener("abort", onLocalAbort, { once: true });
      try {
        const execution =
          selectedMemberPaths || location.connectionId !== destination.connectionId
            ? await api.startLocalArchiveExtraction(
                location.connectionId,
                location.source.path,
                destinationPath,
                selectedMemberPaths,
                destination.connectionId
              )
            : await api.startLocalArchiveExtraction(location.connectionId, location.source.path, destinationPath);
        localExecution = { executionId: execution.execution_id, revision: execution.revision };
        if (cancellationRequested) {
          await cancelLocalExecution();
        }
        return await waitForLocalOutcome();
      } finally {
        localSignal.removeEventListener("abort", onLocalAbort);
        clearForegroundLocalArchiveRequest(localSignal);
      }
    }
    try {
      const operation = await api.prepareArchiveOperation({
        contract_version: "v2",
        kind: "extract",
        source_connection_id: location.connectionId,
        source_path: location.source.path,
        destination_connection_id: destination.connectionId,
        destination_path: destinationPath,
        selected_member_paths: selectedMemberPaths,
      });
      operationId = operation.id;
      storeForegroundArchiveOperation(operationId);
      if (cancellationRequested) {
        await api.cancelArchiveOperation(operationId);
        clearForegroundArchiveOperation(operationId);
        return { status: "cancelled" };
      }
      if (!sourceIsLocal && !destinationIsLocal) {
        return await executeServerOperation();
      }

      return await executeCompanionOperation();
    } catch (error) {
      if (operationId && !cancellationRequested) {
        try {
          await api.cancelArchiveOperation(operationId);
          clearForegroundArchiveOperation(operationId);
        } catch {
          // Retain the marker so the page-reload recovery path can retry cancellation.
        }
      }
      throw error;
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      if (localExecution) {
        await cancelLocalExecution();
        return;
      }
      if (localSignal) {
        await cancelLocalExecution();
        return;
      }
      if (!operationId) {
        return;
      }
      if (awaitingDecision) {
        try {
          await api.decideArchiveExtraction(operationId, "cancel");
          clearForegroundArchiveOperation(operationId);
          return;
        } catch (error) {
          if (!isApiError(error) || error.response?.status !== 409) {
            throw error;
          }
          // The operation may have advanced after a failed decision attempt.
          // Its local paused-state snapshot is stale, so use the general
          // cancellation endpoint that can cancel any non-terminal phase.
          awaitingDecision = false;
        }
      }
      await api.cancelArchiveOperation(operationId);
    },
    onProgress(listener) {
      progressListeners.add(listener);
      if (latestProgress) {
        listener(latestProgress);
      }
      return () => progressListeners.delete(listener);
    },
    async decide(action: ArchiveExtractionDecisionAction, memberPath?: string, targetPath?: string) {
      if (localExecution && awaitingDecision) {
        if (
          !memberPath ||
          (action !== "skip" &&
            action !== "skip_all" &&
            action !== "replace" &&
            action !== "replace_all" &&
            action !== "replace_older" &&
            action !== "rename" &&
            action !== "retry" &&
            action !== "ignore")
        ) {
          throw new Error("Local archive extraction requires a valid decision for the pending member");
        }
        const pendingDecision = localExecution.pendingDecision;
        if (!pendingDecision) {
          throw new Error("Local archive extraction is missing its pending live decision");
        }
        const execution =
          targetPath === undefined
            ? await api.decideLocalArchiveExecution(
                location.connectionId,
                localExecution.executionId,
                localExecution.revision,
                pendingDecision.source_session_id,
                pendingDecision.delivery_sequence,
                pendingDecision.decision_revision,
                memberPath,
                action
              )
            : await api.decideLocalArchiveExecution(
                location.connectionId,
                localExecution.executionId,
                localExecution.revision,
                pendingDecision.source_session_id,
                pendingDecision.delivery_sequence,
                pendingDecision.decision_revision,
                memberPath,
                action,
                targetPath
              );
        localExecution.revision = execution.revision;
        if (execution.phase === "cancelled") {
          return { status: "cancelled" };
        }
        if (execution.phase !== "streaming") {
          throw new Error("Local archive extraction did not resume after the collision decision");
        }
        awaitingDecision = false;
        return await waitForLocalOutcome();
      }
      if (!operationId || !awaitingDecision) {
        throw new Error("Archive extraction is not awaiting a collision decision");
      }
      if (isLocalDrive(location.connectionId) && localRelayDecision) {
        const companionResult = await api.decideLocalArchiveRelayExtraction(
          location.connectionId,
          operationId,
          localRelayDecision.sourceSessionId,
          localRelayDecision.deliverySequence,
          localRelayDecision.decisionRevision,
          action,
          localRelayDecision.memberPath,
          targetPath
        );
        localRelayDecision = null;
        awaitingDecision = false;
        return finishServerOutcome(companionExtractionOutcome(companionResult));
      }
      if (serverRelayDecision) {
        const decision = serverRelayDecision;
        serverRelayDecision = null;
        const liveDecision = {
          sourceSessionId: decision.sourceSessionId,
          deliverySequence: decision.deliverySequence,
          decisionRevision: decision.decisionRevision,
        };
        const operation = await api.decideArchiveExtraction(
          operationId,
          action,
          decision.memberPath,
          action === "rename" ? targetPath : undefined,
          liveDecision
        );
        awaitingDecision = false;
        if (operation.phase === "cancelled") {
          return finishServerOutcome({ status: "cancelled" });
        }
        return isLocalDrive(location.connectionId) || isLocalDrive(destination.connectionId)
          ? executeCompanionOperation()
          : executeServerOperation();
      }
      const isMemberDecision =
        action === "skip" || action === "replace" || action === "rename" || action === "retry" || action === "ignore";
      const operation = await api.decideArchiveExtraction(
        operationId,
        action,
        isMemberDecision ? memberPath : undefined,
        action === "rename" ? targetPath : undefined
      );
      if (operation.phase === "cancelled") {
        return finishServerOutcome({ status: "cancelled" });
      }
      if (operation.phase !== "streaming") {
        throw new Error("Archive extraction did not resume after the collision decision");
      }
      awaitingDecision = false;
      return isLocalDrive(location.connectionId) || isLocalDrive(destination.connectionId)
        ? executeCompanionOperation()
        : executeServerOperation();
    },
    isCancellationRequested: () => cancellationRequested,
  };
}
