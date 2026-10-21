import { createDraftCheckpointSession, type DraftCheckpoint, type DraftEditorType, type DraftSaveResult } from "./draftRecovery";

export const DRAFT_CHECKPOINT_START_MS = 250;
export const DRAFT_CHECKPOINT_LAG_MS = 1_000;
export const DRAFT_TRANSITION_FLUSH_MS = 2_000;
export const DRAFT_CHECKPOINT_TASK_MS = 50;

export interface DraftCheckpointContent {
  baseline: string;
  content: string;
}

export type DraftCheckpointOutcome =
  | { saved: true; revision: number | null }
  | {
      saved: false;
      revision: number;
      reason: Extract<DraftSaveResult, { saved: false }>["reason"] | "snapshot-failed" | "timeout" | "disposed";
    };

interface PendingCheckpoint {
  checkpoint: DraftCheckpoint;
  requestedAt: number;
  serialize: (signal: AbortSignal) => Promise<DraftCheckpointContent>;
}

export function createDraftCheckpointController(connectionId: string, path: string, editorType: DraftEditorType) {
  const session = createDraftCheckpointSession(connectionId, path, editorType);
  let pending: PendingCheckpoint | null = null;
  let active: Promise<DraftCheckpointOutcome> | null = null;
  let cancelActive: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latestRevision = -1;
  let disposed = false;
  let lastOutcome: DraftCheckpointOutcome = { saved: true, revision: null };

  function schedule(): void {
    if (disposed || active || !pending || timer !== undefined) return;
    const delay = Math.max(0, pending.requestedAt + DRAFT_CHECKPOINT_START_MS - DRAFT_CHECKPOINT_TASK_MS - performance.now());
    timer = setTimeout(() => {
      timer = undefined;
      void runNext();
    }, delay);
  }

  function runNext(): Promise<DraftCheckpointOutcome> {
    if (active) return active;
    if (!pending) return Promise.resolve(lastOutcome);
    const job = pending;
    pending = null;
    clearTimeout(timer);
    timer = undefined;
    const revision = job.checkpoint.revision;
    const controller = new AbortController();
    const operation = new Promise<DraftCheckpointOutcome>((resolve) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: DraftCheckpointOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        lastOutcome = outcome;
        resolve(outcome);
      };
      const fail = (reason: "disposed" | "timeout") => {
        finish({ saved: false, revision, reason });
        controller.abort();
      };
      cancelActive = () => fail("disposed");
      const remaining = job.requestedAt + DRAFT_CHECKPOINT_LAG_MS - performance.now();
      if (remaining <= 0) {
        fail("timeout");
        return;
      }
      deadline = setTimeout(() => fail("timeout"), remaining);
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return null;
          return job.serialize(controller.signal);
        })
        .then((snapshot) => {
          if (settled || snapshot === null) return;
          if (performance.now() >= job.requestedAt + DRAFT_CHECKPOINT_LAG_MS) {
            fail("timeout");
            return;
          }
          if (typeof snapshot.baseline !== "string" || typeof snapshot.content !== "string") {
            finish({ saved: false, revision, reason: "snapshot-failed" });
            return;
          }
          const result = session.commit(job.checkpoint, snapshot.baseline, snapshot.content);
          finish({ ...result, revision });
        })
        .catch(() => finish({ saved: false, revision, reason: "snapshot-failed" }));
    });
    active = operation.finally(() => {
      active = null;
      cancelActive = null;
      schedule();
    });
    return active;
  }

  return {
    request(revision: number, serialize: PendingCheckpoint["serialize"]): void {
      if (disposed) throw new Error("Cannot request a checkpoint for a disposed editor session");
      const checkpoint = session.capture(revision);
      latestRevision = revision;
      pending = { checkpoint, requestedAt: pending?.requestedAt ?? performance.now(), serialize };
      schedule();
    },
    getOutcome(): DraftCheckpointOutcome {
      return lastOutcome;
    },
    async flush(): Promise<DraftCheckpointOutcome> {
      if (disposed) return { saved: false, revision: latestRevision, reason: "disposed" };
      const targetRevision = latestRevision;
      if (targetRevision < 0) return lastOutcome;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const completion = async () => {
        let outcome = await runNext();
        while (!disposed && (outcome.revision ?? -1) < targetRevision && pending) outcome = await runNext();
        return outcome;
      };
      try {
        return await Promise.race([
          completion(),
          new Promise<DraftCheckpointOutcome>((resolve) => {
            deadline = setTimeout(() => resolve({ saved: false, revision: targetRevision, reason: "timeout" }), DRAFT_TRANSITION_FLUSH_MS);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      pending = null;
      session.dispose();
      cancelActive?.();
    },
  };
}
