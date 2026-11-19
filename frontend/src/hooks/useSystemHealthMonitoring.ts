import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { CompanionLifecycleStatus } from "../components/FileBrowser/FileBrowserAlerts";
import api from "../services/api";
import { authSession } from "../services/authSession";
import { isLocalDrive } from "../services/backendRouter";
import companionService, {
  hasStoredSecret,
  isCompanionCapacityUnsupported,
  isCompanionPairingRejected,
  isCompanionTimestampRejected,
} from "../services/companion";
import { companionSession } from "../services/companionSession";
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
import { createHealthPoll, HEALTH_RECOVERY_MS, HEALTH_TICK_MS, healthRequest, isHealthPollingGap } from "./healthPolling";
import type { CompanionStatus } from "./useCompanion";

const SUMMARY_POLL_MS = 15_000;
const DIALOG_POLL_MS = 5_000;
const POLICY_REFRESH_MS = 60_000;
const POLICY_MAX_AGE_MS = 120_000;
const INITIAL_CHECK_MS = 15_000;
const HOST_REFRESH_LEAD_MS = 2 * HEALTH_TICK_MS;
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
  refreshing?: boolean;
  checking?: boolean;
  retryNotes?: string[];
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

type TimedMetric = {
  availability: MetricAvailability;
  is_stale: boolean;
  age_seconds: number | null;
  sampled_at: string | null;
};

function isReading(metric: TimedMetric) {
  return metric.availability === "available" && !metric.is_stale;
}

function backendMetrics(snapshot: HealthMonitoringSnapshot) {
  return [
    snapshot.host_memory,
    snapshot.system_load,
    snapshot.cpu_temperature,
    snapshot.container_memory,
    ...snapshot.application_storage,
    ...snapshot.smb_storage,
  ];
}

function mapSnapshot(
  snapshot: HealthMonitoringSnapshot,
  map: <T extends TimedMetric>(metric: T, storage: boolean, previous?: T) => T,
  previous?: HealthMonitoringSnapshot | null
): HealthMonitoringSnapshot {
  return {
    ...snapshot,
    host_memory: map(snapshot.host_memory, false, previous?.host_memory),
    system_load: map(snapshot.system_load, false, previous?.system_load),
    cpu_temperature: map(snapshot.cpu_temperature, false, previous?.cpu_temperature),
    container_memory: map(snapshot.container_memory, false, previous?.container_memory),
    application_storage: snapshot.application_storage.map((item) =>
      map(
        item,
        true,
        previous?.application_storage.find((value) => value.id === item.id)
      )
    ),
    smb_storage: snapshot.smb_storage.map((item) =>
      map(
        item,
        true,
        previous?.smb_storage.find((value) => value.id === item.id)
      )
    ),
  };
}

function isAccessDenied(error: unknown) {
  return isApiError(error) && (error.response?.status === 401 || error.response?.status === 403);
}

const subscribeCompanion = (listener: () => void) => companionSession.subscribe(listener);
const getCompanionRevision = () => companionSession.getSnapshot().revision;

export function useSystemHealthMonitoring({
  authenticated,
  activeConnectionIds,
  dialogOpen,
  companionStatus,
  companionLifecycleStatus,
}: UseSystemHealthMonitoringOptions): SystemHealthViewState {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<HealthMonitoringClientPolicy | null>(null);
  const [backendSample, setBackendSample] = useState<{ key: string; snapshot: HealthMonitoringSnapshot } | null>(null);
  const [backendRetry, setBackendRetry] = useState(false);
  const [companionRetry, setCompanionRetry] = useState(false);
  const [policyRetry, setPolicyRetry] = useState(false);
  const [rawLocalDrives, setRawLocalDrives] = useState<CompanionDriveCapacityItem[]>([]);
  const [companionUpdateRequired, setCompanionUpdateRequired] = useState(false);
  const [companionRejected, setCompanionRejected] = useState(false);
  const [companionReady, setCompanionReady] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const [checkingUntil, setCheckingUntil] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<{ startedAt: number; until: number; severity: AggregateHealthSeverity } | null>(null);
  const [pendingRefresh, setPendingRefresh] = useState({ backend: false, companion: false });
  const timings = useRef(new WeakMap<TimedMetric, { expiresAt: number; receivedAt: number }>()).current;
  const driveTrackersRef = useRef<Map<string, LocalDriveEvaluationTracker>>(new Map());
  const companionRevision = useSyncExternalStore(subscribeCompanion, getCompanionRevision);
  const lastSeverity = useRef<AggregateHealthSeverity>("unknown");
  const pollControl = useRef<((policy: boolean) => void) | null>(null);
  const readDialogOpen = useEffectEvent(() => dialogOpen);

  const smbConnectionIds = useMemo(() => extractActiveSmbConnectionIds(activeConnectionIds), [activeConnectionIds]);
  const smbIdsKey = smbConnectionIds.join(",");
  const policyRef = useRef<HealthMonitoringClientPolicy | null>(null);
  const policyValidUntil = useRef(0);
  const lastTick = useRef({ elapsed: performance.now(), wall: Date.now() });
  const recoveryUntil = useRef(0);
  const noLocalAccess =
    companionStatus === "needs_repair" || companionLifecycleStatus === "renewal_required" || companionLifecycleStatus === "auth_failed";
  const requiresCompanion = companionStatus === "paired";

  const nextExpiry = useEffectEvent((at: number) => {
    const metrics = [...(backendSample ? backendMetrics(backendSample.snapshot) : []), ...rawLocalDrives];
    if (
      [checkingUntil, recovery?.until, ...metrics.map((metric) => timings.get(metric)?.expiresAt)].some(
        (time) => time != null && time > now && time <= at
      )
    ) {
      setNow(at);
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Pairing and access changes invalidate cached readings even if the UI status is unchanged.
  useEffect(() => {
    setRawLocalDrives([]);
    setCompanionRejected(false);
    setCompanionReady(false);
    setCompanionRetry(false);
    setCompanionUpdateRequired(companionStatus === "update_required");
    driveTrackersRef.current.clear();
  }, [companionRevision, companionStatus, noLocalAccess]);

  useEffect(() => {
    const clearMetrics = (preserveRecovery = false) => {
      setBackendSample(null);
      setRawLocalDrives([]);
      setCompanionReady(false);
      setCompanionRejected(false);
      setBackendRetry(false);
      setCompanionRetry(false);
      setPolicyRetry(false);
      setCheckingUntil(null);
      driveTrackersRef.current.clear();
      if (!preserveRecovery) {
        setRecovery(null);
        setPendingRefresh({ backend: false, companion: false });
        lastSeverity.current = "unknown";
        recoveryUntil.current = 0;
      }
    };
    const updatePolicy = (next: HealthMonitoringClientPolicy | null) => {
      policyRef.current = next;
      setPolicy(next);
    };
    if (!authenticated) {
      updatePolicy(null);
      policyValidUntil.current = 0;
      clearMetrics();
      return;
    }

    let disposed = false;
    let sessionCleared = false;
    let companionUnsupported = false;
    let hostRefreshIn = Infinity;
    const visible = () => !disposed && !sessionCleared && document.visibilityState !== "hidden";
    const permitted = () =>
      Boolean(policyRef.current?.enabled && policyRef.current.permitted && performance.now() < policyValidUntil.current);
    const canRead = () => visible() && !policyPoll.running && permitted();
    const interval = () => {
      const currentPolicy = policyRef.current;
      return readDialogOpen()
        ? (currentPolicy?.dialog_poll_seconds ?? DIALOG_POLL_MS / 1000) * 1000
        : (currentPolicy?.summary_poll_seconds ?? SUMMARY_POLL_MS / 1000) * 1000;
    };
    const limit = (storage: boolean) =>
      storage ? (policyRef.current?.storage_stale_seconds ?? 180) * 1000 : (policyRef.current?.host_stale_seconds ?? 15) * 1000;
    const retain = <T extends TimedMetric>(metric: T, storage: boolean, previous: T | undefined, at: number): T => {
      if (isReading(metric)) {
        const deadline = at + Math.max(0, limit(storage) - (metric.age_seconds ?? 0) * 1000);
        const priorDeadline = previous && metric.sampled_at === previous.sampled_at ? timings.get(previous)?.expiresAt : undefined;
        timings.set(metric, { expiresAt: Math.min(deadline, priorDeadline ?? deadline), receivedAt: at });
      } else if (
        metric.availability !== "unsupported" &&
        metric.availability !== "permission_denied" &&
        previous &&
        (timings.get(previous)?.expiresAt ?? 0) > at
      ) {
        return previous;
      }
      return metric;
    };
    const deny = (preserveRecovery = false) => {
      backendPoll.cancel();
      localPoll.cancel();
      clearMetrics(preserveRecovery);
      policyValidUntil.current = 0;
      updatePolicy(null);
    };
    const tickSources = () => {
      const elapsed = performance.now();
      backendPoll.tick(elapsed, canRead);
      localPoll.tick(elapsed, canReadLocal);
    };
    const policyPoll = createHealthPoll(
      async (signal) => {
        try {
          const next = await healthRequest(signal, () => api.getHealthMonitoringClientPolicy({ signal }));
          signal.throwIfAborted();
          const wasPermitted = Boolean(policyRef.current?.enabled && policyRef.current.permitted);
          if (!next.enabled || !next.permitted) deny();
          updatePolicy(next);
          policyValidUntil.current = performance.now() + POLICY_MAX_AGE_MS;
          setPolicyRetry(false);
          if (!wasPermitted && next.enabled && next.permitted) {
            setCheckingUntil(performance.now() + INITIAL_CHECK_MS);
            backendPoll.refresh();
            localPoll.refresh();
          }
          return "ok";
        } catch (error) {
          if (disposed || sessionCleared || (signal.aborted && signal.reason?.name !== "TimeoutError")) return "ok";
          if (isAccessDenied(error)) {
            deny();
            return "ok";
          }
          setPolicyRetry(true);
          return "retry";
        }
      },
      () => POLICY_REFRESH_MS,
      tickSources
    );
    const backendPoll = createHealthPoll(
      async (signal) => {
        try {
          const next = await healthRequest(signal, () =>
            api.getHealthMonitoringSnapshot(smbIdsKey ? smbIdsKey.split(",") : [], { signal })
          );
          signal.throwIfAborted();
          const at = observeClock().elapsed;
          if (!permitted()) return "ok";
          setBackendSample((previous) => ({
            key: smbIdsKey,
            snapshot: mapSnapshot(next, (metric, storage, prior) => retain(metric, storage, prior, at), previous?.snapshot),
          }));
          const reported = backendMetrics(next);
          // A host sample may already be several seconds old when it reaches the browser.
          // Refresh before the oldest host reading expires, even in summary mode.
          const hostRemaining = [next.host_memory, next.system_load, next.cpu_temperature, next.container_memory]
            .filter((metric) => isReading(metric) && metric.severity !== "informational")
            .map((metric) => limit(false) - (metric.age_seconds ?? 0) * 1000);
          hostRefreshIn = Math.max(HEALTH_TICK_MS, Math.min(...hostRemaining) - HOST_REFRESH_LEAD_MS);
          const failed = reported.filter((metric) => !isReading(metric) && metric.severity === "unknown");
          setBackendRetry(failed.length > 0);
          if (!failed.length) setPendingRefresh((pending) => ({ ...pending, backend: false }));
          setNow(at);
          if (failed.some((metric) => metric.availability === "collecting" || metric.availability === "stale")) return "collecting";
          return failed.some((metric) => metric.availability !== "permission_denied") ? "retry" : "ok";
        } catch (error) {
          if (disposed || sessionCleared || (signal.aborted && signal.reason?.name !== "TimeoutError")) return "ok";
          if (isAccessDenied(error)) {
            deny();
            policyPoll.cancel(performance.now() + POLICY_REFRESH_MS);
            return "ok";
          }
          setBackendRetry(true);
          setNow(observeClock().elapsed);
          return "retry";
        }
      },
      () => Math.min(interval(), hostRefreshIn)
    );
    const samePairing = () => companionRevision === getCompanionRevision() && hasStoredSecret();
    const canReadLocal = () => canRead() && requiresCompanion && !noLocalAccess && !companionUnsupported && samePairing();
    const localPoll = createHealthPoll(async (signal) => {
      try {
        const getCapacity = () => healthRequest(signal, () => companionService.getDrivesCapacity({ signal }));
        const listing = await getCapacity().catch((error: unknown) => {
          if (!isCompanionPairingRejected(error)) throw error;
          return getCapacity();
        });
        signal.throwIfAborted();
        if (!samePairing()) return "ok";
        const at = observeClock().elapsed;
        if (!permitted()) return "ok";
        setRawLocalDrives((previous) =>
          listing.items.map((metric) =>
            retain(
              metric,
              true,
              previous.find((item) => item.id === metric.id),
              at
            )
          )
        );
        setCompanionRejected(false);
        setCompanionUpdateRequired(false);
        setCompanionReady(true);
        const failed = listing.items.filter((metric) => !isReading(metric) && metric.availability !== "unsupported");
        setCompanionRetry(failed.length > 0);
        if (!failed.length) setPendingRefresh((pending) => ({ ...pending, companion: false }));
        setNow(at);
        if (failed.some((metric) => metric.availability === "collecting" || metric.availability === "stale")) return "collecting";
        return failed.some((metric) => metric.availability !== "permission_denied") ? "retry" : "ok";
      } catch (error) {
        if (disposed || sessionCleared || (signal.aborted && signal.reason?.name !== "TimeoutError")) return "ok";
        if (
          isCompanionCapacityUnsupported(error) ||
          isCompanionPairingRejected(error) ||
          (isAccessDenied(error) && !isCompanionTimestampRejected(error))
        ) {
          companionUnsupported = isCompanionCapacityUnsupported(error);
          setCompanionRejected(!companionUnsupported);
          setCompanionUpdateRequired(companionUnsupported);
          setRawLocalDrives([]);
          setCompanionReady(false);
          driveTrackersRef.current.clear();
          setCompanionRetry(false);
          setPendingRefresh((pending) => ({ ...pending, companion: false }));
          return "ok";
        }
        setCompanionRetry(true);
        setNow(observeClock().elapsed);
        return "retry";
      }
    }, interval);

    const observeClock = () => {
      const current = { elapsed: performance.now(), wall: Date.now() };
      if (visible() && isHealthPollingGap(lastTick.current, current)) {
        if (current.elapsed >= recoveryUntil.current && lastSeverity.current !== "unknown") {
          recoveryUntil.current = current.elapsed + HEALTH_RECOVERY_MS;
          setRecovery({ startedAt: current.elapsed, until: recoveryUntil.current, severity: lastSeverity.current });
          setPendingRefresh({ backend: true, companion: requiresCompanion && !noLocalAccess && !companionUnsupported });
          setNow(current.elapsed);
        }
        requestRefresh(true);
      }
      if (visible()) lastTick.current = current;
      return current;
    };
    const tick = () => {
      if (!visible()) return;
      const current = observeClock();
      if (policyRef.current?.permitted && current.elapsed >= policyValidUntil.current) deny(current.elapsed < recoveryUntil.current);
      nextExpiry(current.elapsed);
      policyPoll.tick(current.elapsed, visible);
      tickSources();
    };
    const requestRefresh = (recheckPolicy: boolean) => {
      if (!visible()) return;
      if (recheckPolicy) policyPoll.refresh();
      backendPoll.refresh();
      localPoll.refresh();
    };
    const refresh = (recheckPolicy: boolean) => {
      requestRefresh(recheckPolicy);
      tick();
    };
    const onReturn = () => refresh(false);
    const onVisibility = () => {
      if (visible()) refresh(true);
    };
    const resetSession = () => {
      sessionCleared = true;
      policyPoll.cancel();
      deny();
    };
    const bootstrap = () => {
      sessionCleared = false;
      refresh(true);
    };
    const unsubClear = authSession.subscribeToClear(resetSession);
    const unsubIdentity = authSession.subscribeToIdentity((identity) => {
      resetSession();
      if (identity.userId !== null) bootstrap();
    });
    const unsubBootstrap = authSession.subscribeToBootstrap(bootstrap);
    const unsubSettings = subscribeHealthMonitoringSettingsChanged(() => refresh(true));
    pollControl.current = refresh;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onReturn);
    window.addEventListener("online", onReturn);
    window.addEventListener("pageshow", onReturn);
    tick();
    const timer = window.setInterval(tick, HEALTH_TICK_MS);
    return () => {
      disposed = true;
      pollControl.current = null;
      window.clearInterval(timer);
      policyPoll.cancel();
      backendPoll.cancel();
      localPoll.cancel();
      unsubClear();
      unsubIdentity();
      unsubBootstrap();
      unsubSettings();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("online", onReturn);
      window.removeEventListener("pageshow", onReturn);
    };
  }, [authenticated, companionRevision, noLocalAccess, requiresCompanion, smbIdsKey, timings]);

  const previousDialog = useRef(dialogOpen);
  useEffect(() => {
    if (previousDialog.current !== dialogOpen) pollControl.current?.(dialogOpen);
    previousDialog.current = dialogOpen;
  }, [dialogOpen]);

  const refreshing = recovery !== null && now < recovery.until && (pendingRefresh.backend || pendingRefresh.companion);
  const checking = checkingUntil !== null && now < checkingUntil;
  const expired = useCallback(
    <T extends TimedMetric>(metric: T): T => {
      const timing = timings.get(metric);
      return isReading(metric) && timing && (timing.expiresAt <= now || timing.receivedAt < (recovery?.startedAt ?? 0))
        ? { ...metric, availability: "stale", is_stale: true, severity: "unknown", recovery_pending: false }
        : metric;
    },
    [now, recovery?.startedAt, timings]
  );
  const backendCurrent = backendSample?.key === smbIdsKey ? backendSample.snapshot : null;
  const snapshot = useMemo(() => (backendCurrent ? mapSnapshot(backendCurrent, expired) : null), [backendCurrent, expired]);
  const backendUnavailable = backendRetry && !snapshot;

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
      companionRejected ||
      companionStatus === "reconnecting" ||
      (requiresCompanion && !companionReady)
    ) {
      placeholder = {
        id: "companion-unavailable",
        severity: "unknown",
        availability: companionRejected || noLocalAccess || !checking ? "unavailable" : "collecting",
        message: companionRejected || noLocalAccess ? t("systemHealth.metrics.pairingLost") : t("systemHealth.summary.companionRetrying"),
        action: companionRejected || noLocalAccess ? t("systemHealth.metrics.pairingLost") : null,
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

    return rawLocalDrives.map((sample): StorageMetric => {
      const drive = expired(sample);
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
          is_stale: drive.is_stale,
          message: drive.message ?? null,
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
    expired,
    checking,
    companionRejected,
    companionReady,
    companionLifecycleStatus,
    companionStatus,
    companionUpdateRequired,
    rawLocalDrives,
    noLocalAccess,
    requiresCompanion,
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

    const observed = snapshot ? backendMetrics(snapshot) : [];
    const backendSeverity: AggregateHealthSeverity = !snapshot
      ? "unknown"
      : observed.some((metric) => metric.severity === "error")
        ? "error"
        : observed.some((metric) => metric.severity === "warning")
          ? "warning"
          : observed.some((metric) => metric.severity === "unknown")
            ? "unknown"
            : "ok";

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
    if (refreshing && recovery && !companionRejected && !noLocalAccess && !companionUpdateRequired) {
      if (
        severity === "unknown" ||
        (severity !== "error" && recovery.severity === "error") ||
        (severity === "ok" && recovery.severity === "warning")
      )
        severity = recovery.severity;
    }

    let headline = snapshot?.summary.headline ?? t("systemHealth.summary.neverUpdated");
    if (snapshot && backendSeverity !== snapshot.summary.severity) {
      headline = t(`systemHealth.overview.${backendSeverity}`);
    }
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
      if (companionRejected || noLocalAccess) headline = t("systemHealth.metrics.pairingLost");
    }
    if (refreshing && !companionRejected && !noLocalAccess) headline = t("systemHealth.summary.refreshing");
    else if (severity === "unknown" && checking && !companionRejected && !noLocalAccess && !companionUpdateRequired)
      headline = t("systemHealth.overview.checking");

    const timestamps = [...observed.map((metric) => metric.sampled_at), ...evaluatedLocalDrives.map((d) => d.sampled_at)].filter(
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
  }, [
    authenticated,
    backendUnavailable,
    checking,
    companionRejected,
    companionUpdateRequired,
    evaluatedLocalDrives,
    noLocalAccess,
    policy,
    recovery,
    refreshing,
    snapshot,
    t,
  ]);

  useEffect(() => {
    lastSeverity.current = joined.severity;
  }, [joined.severity]);

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
    refreshing,
    checking: checking && joined.severity === "unknown" && !companionRejected && !noLocalAccess && !companionUpdateRequired,
    retryNotes: [
      ...(policyRetry ? [t("systemHealth.summary.policyRetrying")] : []),
      ...(backendRetry ? [t("systemHealth.summary.backendRetrying")] : []),
      ...(companionRetry || companionStatus === "reconnecting" ? [t("systemHealth.summary.companionRetrying")] : []),
    ],
  };
}
