/**
 * useCompanion — React hook for companion detection and drive management.
 *
 * Probes the companion on mount, manages pairing state, and provides
 * the list of local drives to merge into the connection selector.
 *
 * Usage in FileBrowser:
 * ```tsx
 * const companion = useCompanion();
 * const allConnections = mergeConnections(serverConnections, companion.drives);
 * ```
 */

import { useCallback, useEffect, useRef, useState } from "react";
import companionService, { type DriveInfo, getCompanionAuthProtocolStatus, hasStoredSecret } from "../services/companion";
import { companionSession } from "../services/companionSession";
import { logger } from "../services/logger";

/** Companion availability and pairing status. */
export type CompanionStatus =
  /** Not running or unreachable. */
  | "unavailable"
  /** Reachable but not yet paired. */
  | "unpaired"
  /** A pairing is in progress and waiting for local approval in the companion. */
  | "pending_local_approval"
  /** The companion still recognizes this origin, but the browser secret is missing or invalid. */
  | "needs_repair"
  /** Companion uses an incompatible authentication protocol. */
  | "update_required"
  /** Paired and ready for authenticated requests. */
  | "paired"
  /** Currently performing initial detection. */
  | "detecting";

export interface UseCompanionResult {
  /** Current companion availability/pairing status. */
  status: CompanionStatus;
  /** Drives from the companion (empty unless status is "paired"). */
  drives: DriveInfo[];
  /** Start the pairing flow; returns the 6-char code for user confirmation. */
  initiatePairing: () => Promise<{ pairingId: string; pairingCode: string }>;
  /** Confirm pairing after user verifies the code matches on both sides. */
  confirmPairing: (pairingId: string) => Promise<void>;
  /** Re-probe the companion (e.g., after pairing completes). */
  refresh: () => Promise<void>;
  /** Whether a detection/refresh is in progress. */
  loading: boolean;
}

function haveSameDrives(left: readonly DriveInfo[], right: readonly DriveInfo[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (drive, index) => drive.id === right[index]?.id && drive.name === right[index]?.name && drive.drive_type === right[index]?.drive_type
    )
  );
}

/**
 * Hook that manages the companion lifecycle:
 * 1. On mount, probes `GET /api/health` with a short timeout.
 * 2. If paired, fetches drives immediately.
 * 3. Provides pairing initiators for the UI dialog.
 */
export function useCompanion(): UseCompanionResult {
  const [status, setStatus] = useState<CompanionStatus>("detecting");
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const initialDetectionStartedRef = useRef(false);
  const setDrivesIfChanged = useCallback((nextDrives: DriveInfo[]) => {
    setDrives((currentDrives) => (haveSameDrives(currentDrives, nextDrives) ? currentDrives : nextDrives));
  }, []);

  /**
   * Probe the companion and, if paired, load drives.
   */
  const detect = useCallback(async () => {
    setLoading(true);
    try {
      const health = await companionService.checkHealth();

      if (!mountedRef.current) return;

      if (!health) {
        setStatus("unavailable");
        setDrivesIfChanged([]);
        return;
      }

      if (getCompanionAuthProtocolStatus(health) !== "compatible") {
        setStatus("update_required");
        setDrivesIfChanged([]);
        return;
      }

      const storedSecret = hasStoredSecret();
      const pairStatus = await companionService.getPairStatus();
      const currentOriginPaired = pairStatus.status === "paired";

      if (pairStatus.status === "pending_local_approval") {
        setStatus("pending_local_approval");
        setDrivesIfChanged([]);
        return;
      }

      // Companion is reachable and the browser already has a shared secret.
      // Even if the companion's health flag is stale, a successful authenticated
      // drive fetch proves the pairing is still valid.
      if (storedSecret && currentOriginPaired) {
        try {
          const driveList = await companionService.getDrives();
          if (mountedRef.current) {
            setStatus("paired");
            setDrivesIfChanged(driveList);
          }
          return;
        } catch (err) {
          logger.warn("Stored companion secret was not accepted during startup", { error: err }, "companion");
          if (mountedRef.current) {
            setStatus("needs_repair");
            setDrivesIfChanged([]);
          }
          return;
        }
      }

      if (currentOriginPaired) {
        logger.warn("Companion reported this origin as paired but no usable browser secret was available", {}, "companion");
        setStatus("needs_repair");
        setDrivesIfChanged([]);
        return;
      }

      setStatus("unpaired");
      setDrivesIfChanged([]);
    } catch {
      if (mountedRef.current) {
        setStatus("unavailable");
        setDrivesIfChanged([]);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [setDrivesIfChanged]);

  // Detect on mount
  useEffect(() => {
    mountedRef.current = true;
    if (!initialDetectionStartedRef.current) {
      initialDetectionStartedRef.current = true;
      void detect();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [detect]);

  useEffect(() => {
    const sessionStatus =
      status === "paired"
        ? "paired"
        : status === "detecting" || status === "pending_local_approval"
          ? "pairing"
          : status === "unavailable"
            ? "unavailable"
            : "unpaired";
    companionSession.setState(
      sessionStatus,
      drives.map((drive) => ({ driveId: drive.id, name: drive.name, path: "" }))
    );
  }, [drives, status]);

  /**
   * Start pairing — returns the code for the UI to display.
   */
  const initiatePairing = useCallback(async () => {
    const result = await companionService.initiatePairing();
    return { pairingId: result.pairingId, pairingCode: result.pairingCode };
  }, []);

  /**
   * Complete pairing — stores the shared secret and refreshes drives.
   */
  const confirmPairing = useCallback(
    async (pairingId: string) => {
      await companionService.confirmPairing(pairingId);
      // After pairing, re-detect to load drives
      await detect();
    },
    [detect]
  );

  return {
    status,
    drives,
    initiatePairing,
    confirmPairing,
    refresh: detect,
    loading,
  };
}
