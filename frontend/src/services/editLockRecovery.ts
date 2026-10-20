import type { EditLockInfo } from "../types";
import { authSession } from "./authSession";
import { warn } from "./logger";

const RECOVERY_PREFIX = "sambee:edit-lock:";
const activeGuards = new Set<() => void>();

export function clearEditLockRecovery(): void {
  for (const release of activeGuards) release();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(RECOVERY_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    warn("Unable to clear saved edit-lock recovery credentials");
  }
}

authSession.subscribeToClear(clearEditLockRecovery);

export async function claimEditLockRecovery(connectionId: string, path: string) {
  const userId = authSession.getUserId();
  const identityEpoch = authSession.getIdentity().epoch;
  const key = `${RECOVERY_PREFIX}${JSON.stringify([userId, connectionId, path])}`;
  let release = () => {};
  let lockCompletion = Promise.resolve();
  let protectedTab = false;
  if (navigator.locks) {
    await new Promise<void>((resolve, reject) => {
      lockCompletion = navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error("File is already being edited in another tab");
        protectedTab = true;
        await new Promise<void>((unlock) => {
          release = () => {
            activeGuards.delete(release);
            unlock();
          };
          activeGuards.add(release);
          resolve();
        });
      });
      void lockCompletion.catch(reject);
    });
  }

  const clear = () => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      warn("Unable to remove saved edit-lock recovery credentials");
    }
  };
  return {
    async release(): Promise<void> {
      release();
      await lockCompletion;
    },
    clear,
    load(): EditLockInfo | null {
      const navigation = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
      if (!protectedTab || navigation?.type !== "reload") return null;
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
        if (
          saved &&
          typeof saved === "object" &&
          "lock_id" in saved &&
          "operation_id" in saved &&
          "lock_capability" in saved &&
          typeof saved.lock_id === "string" &&
          saved.lock_id &&
          typeof saved.operation_id === "string" &&
          saved.operation_id &&
          typeof saved.lock_capability === "string" &&
          saved.lock_capability
        ) {
          return {
            lock_id: saved.lock_id,
            operation_id: saved.operation_id,
            lock_capability: saved.lock_capability,
            file_path: path,
            locked_by: "",
            locked_at: "",
          };
        }
        clear();
      } catch {
        clear();
      }
      return null;
    },
    save(lock: EditLockInfo): void {
      if (!protectedTab || authSession.getUserId() !== userId || authSession.getIdentity().epoch !== identityEpoch) return;
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            lock_id: lock.lock_id,
            operation_id: lock.operation_id,
            lock_capability: lock.lock_capability,
          })
        );
      } catch {
        warn("Edit-lock recovery is unavailable; reloading may require waiting for the lock to expire");
      }
    },
  };
}
