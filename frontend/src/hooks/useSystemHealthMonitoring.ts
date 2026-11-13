import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CompanionLifecycleStatus } from "../components/FileBrowser/FileBrowserAlerts";
import api from "../services/api";
import { authSession } from "../services/authSession";
import { isLocalDrive } from "../services/backendRouter";
import companionService, {
  hasStoredSecret,
  isCompanionAuthSignatureMismatch,
  isCompanionCapacityUnsupported,
  isCompanionPairingMissing,
} from "../services/companion";
import { subscribeHealthMonitoringSettingsChanged } from "../services/healthMonitoringEvents";
import {
  type AggregateHealthSeverity,
  type CompanionDriveCapacityItem,
  type HealthMonitoringClientPolicy,
  type HealthMonitoringSnapshot,
  type HealthMonitoringThresholds,
  type HealthSeverity,
  isApiError,
  type MetricAvailability,
  type StorageMetric,
} from "../types";
import type { CompanionStatus } from "./useCompanion";

const SUMMARY_POLL_MS = 15_000;
const DIALOG_POLL_MS = 5_000;
const POLICY_REFRESH_MS = 60_000;
const STORAGE_HYSTERESIS_TENTHS_PERCENT = 20;

const DEFAULT_THRESHOLDS: HealthMonitoringThresholds = {
  memory_warning_tenths_percent: 850,
  memory_error_tenths_percent: 950,
  load_warning_hundredths: 75,
  load_error_hundredths: 90,
  available_space_warning_tenths_percent: 100,
  available_space_error_tenths_percent: 50,
};

interface LocalDriveEvaluationTracker {
  signature: string;
  committedSeverity: HealthSeverity;
  warningClearStreak: number;
  errorClearStreak: number;
  lastReadingKey: string | null;
}

export interface SystemHealthViewState {
  visible: boolean;
  severity: AggregateHealthSeverity;
  headline: string;
  incompleteCoverage: boolean;
  coverageNotes: string[];
  lastUpdatedAt: string | null;
  backendUnavailable: boolean;
  snapshot: HealthMonitoringSnapshot | null;
  localDrives: StorageMetric[];
  companionUpdateRequired: boolean;
}

interface UseSystemHealthMonitoringOptions {
  authenticated: boolean;
  activeConnectionIds: readonly string[];
  dialogOpen: boolean;
  companionStatus: CompanionStatus;
  companionLifecycleStatus: CompanionLifecycleStatus | null;
}

function evaluateLocalDriveThresholds(
  tracker: LocalDriveEvaluationTracker,
  availableBytes: number,
  totalBytes: number,
  warningTenths: number,
  errorTenths: number,
  readingKey: string
): { severity: HealthSeverity; recoveryPending: boolean } {
  const signature = `${warningTenths}:${errorTenths}`;
  if (tracker.signature !== signature) {
    tracker.signature = signature;
    tracker.committedSeverity = "ok";
    tracker.warningClearStreak = 0;
    tracker.errorClearStreak = 0;
    tracker.lastReadingKey = null;
  }

  const isNewReading = tracker.lastReadingKey !== readingKey;
  tracker.lastReadingKey = readingKey;

  const lhs = 1000 * availableBytes;
  const isError = availableBytes === 0 || lhs <= errorTenths * totalBytes;
  const isWarning = !isError && lhs <= warningTenths * totalBytes;
  const clearWarning = Math.min(1000, warningTenths + STORAGE_HYSTERESIS_TENTHS_PERCENT);
  const clearError = Math.min(warningTenths, errorTenths + STORAGE_HYSTERESIS_TENTHS_PERCENT);
  const clearWarningMet = availableBytes > 0 && lhs >= clearWarning * totalBytes;
  const clearErrorMet = availableBytes > 0 && lhs > clearError * totalBytes;

  if (tracker.committedSeverity === "ok" || tracker.committedSeverity === "unknown" || tracker.committedSeverity === "informational") {
    tracker.warningClearStreak = 0;
    tracker.errorClearStreak = 0;
    if (isError) {
      tracker.committedSeverity = "error";
    } else if (isWarning) {
      tracker.committedSeverity = "warning";
    } else {
      tracker.committedSeverity = "ok";
    }
  } else if (tracker.committedSeverity === "warning") {
    tracker.errorClearStreak = 0;
    if (isError) {
      tracker.committedSeverity = "error";
      tracker.warningClearStreak = 0;
    } else if (clearWarningMet) {
      if (isNewReading) {
        tracker.warningClearStreak += 1;
      }
      if (tracker.warningClearStreak >= 2) {
        tracker.committedSeverity = "ok";
        tracker.warningClearStreak = 0;
      }
    } else {
      tracker.warningClearStreak = 0;
    }
  } else if (tracker.committedSeverity === "error") {
    if (isError) {
      tracker.errorClearStreak = 0;
      tracker.warningClearStreak = 0;
    } else {
      if (isNewReading) {
        tracker.errorClearStreak = clearErrorMet ? tracker.errorClearStreak + 1 : 0;
        tracker.warningClearStreak = clearWarningMet ? tracker.warningClearStreak + 1 : 0;
      } else {
        if (!clearErrorMet) tracker.errorClearStreak = 0;
        if (!clearWarningMet) tracker.warningClearStreak = 0;
      }
      if (tracker.errorClearStreak >= 2 && tracker.warningClearStreak >= 2) {
        tracker.committedSeverity = "ok";
        tracker.errorClearStreak = 0;
        tracker.warningClearStreak = 0;
      } else if (tracker.errorClearStreak >= 2) {
        tracker.committedSeverity = "warning";
        tracker.errorClearStreak = 0;
      }
    }
  }

  const recoveryPending =
    (tracker.committedSeverity === "warning" && tracker.warningClearStreak > 0) ||
    (tracker.committedSeverity === "error" && tracker.errorClearStreak > 0);
  return { severity: tracker.committedSeverity, recoveryPending };
}

export function extractActiveSmbConnectionIds(connectionIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of connectionIds) {
    if (!id || isLocalDrive(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
    if (result.length >= 2) {
      break;
    }
  }
  return result;
}

export function useSystemHealthMonitoring({
  authenticated,
  activeConnectionIds,
  dialogOpen,
  companionStatus,
  companionLifecycleStatus,
}: UseSystemHealthMonitoringOptions): SystemHealthViewState {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<HealthMonitoringClientPolicy | null>(null);
  const [snapshot, setSnapshot] = useState<HealthMonitoringSnapshot | null>(null);
  const [backendUnavailable, setBackendUnavailable] = useState(false);
  const [rawLocalDrives, setRawLocalDrives] = useState<CompanionDriveCapacityItem[]>([]);
  const [companionUpdateRequired, setCompanionUpdateRequired] = useState(false);
  const [companionFetchError, setCompanionFetchError] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));

  const inFlightRef = useRef(false);
  const lastPolicyCheckRef = useRef<number | null>(null);
  const companionUnsupportedCachedRef = useRef(false);
  const driveTrackersRef = useRef<Map<string, LocalDriveEvaluationTracker>>(new Map());

  const smbConnectionIds = useMemo(() => extractActiveSmbConnectionIds(activeConnectionIds), [activeConnectionIds]);
  const smbIdsKey = smbConnectionIds.join(",");

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        lastPolicyCheckRef.current = null;
      }
      setPageVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Reset cached older-Companion detection if Companion reconnects or protocol changes
  useEffect(() => {
    if (companionStatus !== "paired") {
      companionUnsupportedCachedRef.current = false;
      if (companionStatus === "unavailable" || companionStatus === "unpaired" || companionStatus === "detecting") {
        setRawLocalDrives([]);
        setCompanionUpdateRequired(false);
        setCompanionFetchError(null);
      } else if (companionStatus === "update_required") {
        setRawLocalDrives([]);
        setCompanionUpdateRequired(true);
        setCompanionFetchError(null);
      }
    }
  }, [companionStatus]);

  const clearAllRamState = useCallback(() => {
    setSnapshot(null);
    setBackendUnavailable(false);
    setRawLocalDrives([]);
    setCompanionUpdateRequired(false);
    setCompanionFetchError(null);
    driveTrackersRef.current.clear();
  }, []);

  const policyRef = useRef<HealthMonitoringClientPolicy | null>(null);

  const updatePolicy = useCallback((next: HealthMonitoringClientPolicy | null) => {
    if (next === null) {
      lastPolicyCheckRef.current = null;
    }
    policyRef.current = next;
    setPolicy(next);
  }, []);

  useEffect(() => {
    const unsubClear = authSession.subscribeToClear(() => {
      updatePolicy(null);
      clearAllRamState();
    });
    const unsubIdentity = authSession.subscribeToIdentity(() => {
      updatePolicy(null);
      clearAllRamState();
    });
    return () => {
      unsubClear();
      unsubIdentity();
    };
  }, [clearAllRamState, updatePolicy]);

  useEffect(() => {
    if (!authenticated) {
      updatePolicy(null);
      clearAllRamState();
    }
  }, [authenticated, clearAllRamState, updatePolicy]);

  const loadPolicy = useCallback(async (): Promise<HealthMonitoringClientPolicy | null> => {
    if (!authenticated) {
      return null;
    }
    lastPolicyCheckRef.current = performance.now();
    try {
      const nextPolicy = await api.getHealthMonitoringClientPolicy();
      updatePolicy(nextPolicy);
      if (!nextPolicy.enabled || !nextPolicy.permitted) {
        clearAllRamState();
      }
      return nextPolicy;
    } catch (error) {
      if (isApiError(error) && error.response?.status === 403) {
        updatePolicy({
          enabled: false,
          permitted: false,
          thresholds: null,
          summary_poll_seconds: 15,
          dialog_poll_seconds: 5,
          host_stale_seconds: 15,
          storage_stale_seconds: 180,
        });
        clearAllRamState();
      } else if (isApiError(error) && error.response?.status === 401) {
        updatePolicy(null);
        clearAllRamState();
      } else {
        setBackendUnavailable(true);
      }
      return null;
    }
  }, [authenticated, clearAllRamState, updatePolicy]);

  const pollOnce = useCallback(
    async (options?: { recheckPolicy?: boolean }) => {
      if (!authenticated || !pageVisible || inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;
      try {
        let activePolicy = policyRef.current;
        if (
          !activePolicy ||
          options?.recheckPolicy ||
          lastPolicyCheckRef.current === null ||
          performance.now() - lastPolicyCheckRef.current >= POLICY_REFRESH_MS
        ) {
          activePolicy = await loadPolicy();
        }
        if (!activePolicy?.enabled || !activePolicy.permitted) {
          return;
        }

        const currentSmbIds = smbIdsKey ? smbIdsKey.split(",") : [];
        const snapshotPromise = api
          .getHealthMonitoringSnapshot(currentSmbIds)
          .then((nextSnapshot) => {
            setSnapshot(nextSnapshot);
            setBackendUnavailable(false);
            return nextSnapshot;
          })
          .catch((error: unknown) => {
            if (isApiError(error) && error.response?.status === 403) {
              const prev = policyRef.current;
              updatePolicy(
                prev
                  ? { ...prev, permitted: false, thresholds: null }
                  : {
                      enabled: false,
                      permitted: false,
                      thresholds: null,
                      summary_poll_seconds: 15,
                      dialog_poll_seconds: 5,
                      host_stale_seconds: 15,
                      storage_stale_seconds: 180,
                    }
              );
              clearAllRamState();
              return null;
            }
            setBackendUnavailable(true);
            return null;
          });

        const shouldQueryCompanion = companionStatus === "paired" && hasStoredSecret();
        const companionPromise = (async () => {
          if (!shouldQueryCompanion) {
            if (companionStatus === "update_required") {
              setCompanionUpdateRequired(true);
              setRawLocalDrives([]);
            }
            return null;
          }
          if (companionUnsupportedCachedRef.current) {
            setCompanionUpdateRequired(true);
            setCompanionFetchError(null);
            return null;
          }
          try {
            const listing = await companionService.getDrivesCapacity();
            setRawLocalDrives(listing.items);
            setCompanionUpdateRequired(false);
            setCompanionFetchError(null);
            return listing;
          } catch (error) {
            if (isCompanionCapacityUnsupported(error)) {
              companionUnsupportedCachedRef.current = true;
              setCompanionUpdateRequired(true);
              setRawLocalDrives([]);
              setCompanionFetchError(null);
            } else if (isCompanionAuthSignatureMismatch(error) || isCompanionPairingMissing(error)) {
              setCompanionFetchError(t("systemHealth.metrics.pairingLost"));
            } else {
              setCompanionFetchError(t("systemHealth.summary.localDriveUnknownHeadline"));
            }
            return null;
          }
        })();

        await Promise.all([snapshotPromise, companionPromise]);
      } finally {
        inFlightRef.current = false;
      }
    },
    [authenticated, clearAllRamState, companionStatus, loadPolicy, pageVisible, smbIdsKey, t, updatePolicy]
  );

  // Initial load & updates when panes, pairing, visibility, or dialog state change
  useEffect(() => {
    if (!authenticated || !pageVisible) {
      return undefined;
    }
    void pollOnce({ recheckPolicy: dialogOpen || policyRef.current === null });
    const unsubBootstrap = authSession.subscribeToBootstrap(() => {
      void pollOnce({ recheckPolicy: true });
    });
    const intervalMs = dialogOpen ? DIALOG_POLL_MS : SUMMARY_POLL_MS;
    const timer = window.setInterval(() => {
      void pollOnce();
    }, intervalMs);
    return () => {
      unsubBootstrap();
      window.clearInterval(timer);
    };
  }, [authenticated, dialogOpen, pageVisible, pollOnce]);

  // Re-check immediately when admin updates Health Monitoring settings
  useEffect(() => {
    return subscribeHealthMonitoringSettingsChanged(() => {
      void pollOnce({ recheckPolicy: true });
    });
  }, [pollOnce]);

  const thresholds = snapshot?.thresholds ?? policy?.thresholds ?? DEFAULT_THRESHOLDS;

  const evaluatedLocalDrives: StorageMetric[] = useMemo(() => {
    let placeholder: Pick<StorageMetric, "id" | "severity" | "availability" | "message" | "action"> | null = null;
    if (companionUpdateRequired) {
      placeholder = {
        id: "companion-update-required",
        severity: "unknown",
        availability: "unsupported",
        message: t("systemHealth.metrics.updateCompanion"),
        action: t("systemHealth.metrics.updateCompanion"),
      };
    } else if (
      companionStatus === "needs_repair" ||
      companionLifecycleStatus === "renewal_required" ||
      companionLifecycleStatus === "auth_failed" ||
      (companionFetchError && rawLocalDrives.length === 0)
    ) {
      placeholder = {
        id: "companion-unavailable",
        severity: "unknown",
        availability: "unavailable",
        message: companionFetchError ?? t("systemHealth.metrics.pairingLost"),
        action: t("systemHealth.metrics.pairingLost"),
      };
    } else if (companionStatus !== "paired") {
      placeholder = {
        id: "companion-not-connected",
        severity: "informational",
        availability: "unsupported",
        message: t("systemHealth.overview.localDriveHelp"),
        action: t("systemHealth.overview.localDriveHelp"),
      };
    }

    if (placeholder) {
      return [
        {
          ...placeholder,
          kind: "local_drive",
          label: t("systemHealth.overview.localDrives"),
          is_placeholder: true,
          source: "Companion localhost:21549",
          semantics: "posix_unprivileged_blocks",
          available_bytes: null,
          total_bytes: null,
          available_tenths_percent: null,
          available_percent: null,
          warning_tenths_percent: thresholds.available_space_warning_tenths_percent,
          error_tenths_percent: thresholds.available_space_error_tenths_percent,
          recovery_pending: false,
          sampled_at: null,
          age_seconds: null,
          is_stale: false,
        },
      ];
    }

    return rawLocalDrives.map((drive): StorageMetric => {
      const warnTenths = thresholds.available_space_warning_tenths_percent;
      const errTenths = thresholds.available_space_error_tenths_percent;
      const sourceLabel = `Companion (${drive.drive_type})`;

      if (
        drive.availability !== "available" ||
        drive.is_stale ||
        drive.total_bytes === null ||
        drive.total_bytes <= 0 ||
        drive.available_bytes === null
      ) {
        const availPercent =
          drive.total_bytes && drive.total_bytes > 0 && drive.available_bytes !== null
            ? Math.round((1000 * drive.available_bytes) / drive.total_bytes) / 10
            : null;
        const availTenths =
          drive.total_bytes && drive.total_bytes > 0 && drive.available_bytes !== null
            ? Math.floor((1000 * drive.available_bytes) / drive.total_bytes)
            : null;
        return {
          id: `local-drive-${drive.id}`,
          kind: "local_drive",
          label: drive.name,
          source: sourceLabel,
          semantics: drive.semantics,
          severity: drive.availability === "unsupported" ? "informational" : "unknown",
          availability: drive.availability as MetricAvailability,
          available_bytes: drive.available_bytes,
          total_bytes: drive.total_bytes,
          actual_free_bytes: drive.actual_free_bytes ?? null,
          available_tenths_percent: availTenths,
          available_percent: availPercent,
          warning_tenths_percent: warnTenths,
          error_tenths_percent: errTenths,
          recovery_pending: false,
          sampled_at: drive.sampled_at,
          age_seconds: drive.age_seconds,
          is_stale: Boolean(drive.is_stale || companionFetchError),
          message: companionFetchError ?? drive.message ?? null,
          action: null,
        };
      }

      let tracker = driveTrackersRef.current.get(drive.id);
      if (!tracker) {
        tracker = {
          signature: "",
          committedSeverity: "ok",
          warningClearStreak: 0,
          errorClearStreak: 0,
          lastReadingKey: null,
        };
        driveTrackersRef.current.set(drive.id, tracker);
      }

      const readingKey = `${drive.sampled_at ?? ""}:${drive.available_bytes}:${drive.total_bytes}`;
      const { severity, recoveryPending } = evaluateLocalDriveThresholds(
        tracker,
        drive.available_bytes,
        drive.total_bytes,
        warnTenths,
        errTenths,
        readingKey
      );
      const availTenths = Math.floor((1000 * drive.available_bytes) / drive.total_bytes);
      const availPercent = Math.round((1000 * drive.available_bytes) / drive.total_bytes) / 10;

      if (companionFetchError) {
        return {
          id: `local-drive-${drive.id}`,
          kind: "local_drive",
          label: drive.name,
          source: sourceLabel,
          semantics: drive.semantics,
          severity: "unknown",
          availability: "stale",
          available_bytes: drive.available_bytes,
          total_bytes: drive.total_bytes,
          actual_free_bytes: drive.actual_free_bytes ?? null,
          available_tenths_percent: availTenths,
          available_percent: availPercent,
          warning_tenths_percent: warnTenths,
          error_tenths_percent: errTenths,
          recovery_pending: false,
          sampled_at: drive.sampled_at,
          age_seconds: drive.age_seconds,
          is_stale: true,
          message: companionFetchError,
          action: null,
        };
      }

      return {
        id: `local-drive-${drive.id}`,
        kind: "local_drive",
        label: drive.name,
        source: sourceLabel,
        semantics: drive.semantics,
        severity,
        availability: "available",
        available_bytes: drive.available_bytes,
        total_bytes: drive.total_bytes,
        actual_free_bytes: drive.actual_free_bytes ?? null,
        available_tenths_percent: availTenths,
        available_percent: availPercent,
        warning_tenths_percent: warnTenths,
        error_tenths_percent: errTenths,
        recovery_pending: recoveryPending,
        sampled_at: drive.sampled_at,
        age_seconds: drive.age_seconds,
        is_stale: false,
        message: null,
        action: severity === "warning" || severity === "error" ? t("systemHealth.metrics.localDriveAction") : null,
      };
    });
  }, [
    companionFetchError,
    companionLifecycleStatus,
    companionStatus,
    companionUpdateRequired,
    rawLocalDrives,
    t,
    thresholds.available_space_error_tenths_percent,
    thresholds.available_space_warning_tenths_percent,
  ]);

  const joined = useMemo(() => {
    const visible = Boolean(authenticated && policy?.enabled && policy?.permitted);
    if (!visible) {
      return {
        visible: false,
        severity: "unknown" as AggregateHealthSeverity,
        headline: "",
        incompleteCoverage: false,
        coverageNotes: [] as string[],
        lastUpdatedAt: null as string | null,
      };
    }

    const notes = [...(snapshot?.summary.coverage_notes ?? [])];
    const localErrors = evaluatedLocalDrives.filter((d) => d.severity === "error");
    const localWarnings = evaluatedLocalDrives.filter((d) => d.severity === "warning");
    const localUnknowns = evaluatedLocalDrives.filter((d) => d.severity === "unknown");
    const localOptional = evaluatedLocalDrives.filter((d) => d.severity === "informational");

    if (companionUpdateRequired) {
      notes.push(t("systemHealth.metrics.updateCompanion"));
    } else if (localUnknowns.length > 0) {
      notes.push(t("systemHealth.summary.localDriveUnknownHeadline"));
    }
    if (localOptional.length > 0) {
      notes.push(`${localOptional.map((d) => d.label).join(", ")}: ${t("systemHealth.statuses.notAvailable")}`);
    }
    if (backendUnavailable) {
      notes.unshift(t("systemHealth.summary.backendUnavailableHeadline"));
    }

    const backendSeverity: AggregateHealthSeverity = backendUnavailable || !snapshot ? "unknown" : snapshot.summary.severity;

    let severity: AggregateHealthSeverity;
    if (backendSeverity === "error" || localErrors.length > 0) {
      severity = "error";
    } else if (backendSeverity === "warning" || localWarnings.length > 0) {
      severity = "warning";
    } else if (backendSeverity === "unknown" || localUnknowns.length > 0) {
      severity = "unknown";
    } else {
      severity = "ok";
    }

    let headline = snapshot?.summary.headline ?? t("systemHealth.summary.neverUpdated");
    if (backendUnavailable && severity === "unknown") {
      headline = t("systemHealth.summary.backendUnavailableHeadline");
    } else if (severity === "error" && backendSeverity !== "error" && localErrors.length > 0) {
      headline =
        localErrors.length === 1
          ? t("systemHealth.summary.localDriveErrorHeadline")
          : t("systemHealth.summary.localDriveErrorsHeadline", { count: localErrors.length });
    } else if (severity === "warning" && backendSeverity !== "warning" && localWarnings.length > 0) {
      headline =
        localWarnings.length === 1
          ? t("systemHealth.summary.localDriveWarningHeadline")
          : t("systemHealth.summary.localDriveWarningsHeadline", { count: localWarnings.length });
    } else if (severity === "unknown" && backendSeverity === "ok" && localUnknowns.length > 0) {
      headline = companionUpdateRequired ? t("systemHealth.metrics.updateCompanion") : t("systemHealth.summary.localDriveUnknownHeadline");
    }

    const timestamps = [snapshot?.summary.last_updated_at ?? null, ...evaluatedLocalDrives.map((d) => d.sampled_at)].filter(
      (value): value is string => Boolean(value)
    );
    const lastUpdatedAt = timestamps.length > 0 ? (timestamps.sort().at(-1) ?? null) : null;

    return {
      visible: true,
      severity,
      headline,
      incompleteCoverage: Boolean(notes.length > 0 || snapshot?.summary.incomplete_coverage),
      coverageNotes: notes,
      lastUpdatedAt,
    };
  }, [authenticated, backendUnavailable, companionUpdateRequired, evaluatedLocalDrives, policy, snapshot, t]);

  return {
    visible: joined.visible,
    severity: joined.severity,
    headline: joined.headline,
    incompleteCoverage: joined.incompleteCoverage,
    coverageNotes: joined.coverageNotes,
    lastUpdatedAt: joined.lastUpdatedAt,
    backendUnavailable,
    snapshot,
    localDrives: evaluatedLocalDrives,
    companionUpdateRequired,
  };
}
