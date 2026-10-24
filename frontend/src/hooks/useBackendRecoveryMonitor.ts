import { useCallback, useEffect, useRef } from "react";
import { isOidcExchangePending } from "../services/api";
import { AuthSessionError, authSession } from "../services/authSession";
import {
  type BackendAvailabilityStatus,
  getBackendAvailabilitySnapshot,
  markBackendAvailable,
  markBackendReconnecting,
  markBackendUnavailable,
} from "../services/backendAvailability";
import { getServerBaseUrl } from "../services/backendRouter";
import { logger } from "../services/logger";

const HEALTH_CHECK_PATH = "/health";
const AUTHENTICATED_PROBE_PATH = "/auth/me";
const HEALTH_CHECK_TIMEOUT_MS = 2_500;
const PROBE_FAILURES_BEFORE_UNAVAILABLE = 3;
const RECOVERY_RETRY_DELAYS_MS = [500, 750, 1_250, 2_000] as const;
const PROACTIVE_PROBE_MIN_INTERVAL_MS = 30_000;
const TOKEN_REFRESH_SUCCESS_REASON = "token-refresh-success";
const PROACTIVE_RECOVERY_REASONS = new Set(["visibility-visible", "window-focus", "window-online", "window-pageshow"]);

interface BackendRecoveryMonitorOptions {
  enabled?: boolean;
  status: BackendAvailabilityStatus;
  onRecovered?: (reason: string, wasRecovering: boolean) => void;
  onReconnectNow?: (reason: string) => void;
  onAuthenticationFailure?: () => void;
}

function getRecoveryDelay(failures: number): number {
  const index = Math.min(failures, RECOVERY_RETRY_DELAYS_MS.length - 1);
  return RECOVERY_RETRY_DELAYS_MS[index] ?? RECOVERY_RETRY_DELAYS_MS[0];
}

interface RecoveryProbeRequest {
  url: string;
  headers: Record<string, string>;
}

function buildRecoveryProbeRequest(): RecoveryProbeRequest {
  const baseUrl = getServerBaseUrl();
  const accessToken = authSession.getAccessToken();

  if (accessToken) {
    return {
      url: `${baseUrl}${AUTHENTICATED_PROBE_PATH}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Cache-Control": "no-cache",
      },
    };
  }

  return {
    url: `${baseUrl}${HEALTH_CHECK_PATH}`,
    headers: {
      "Cache-Control": "no-cache",
    },
  };
}

export function useBackendRecoveryMonitor({
  enabled = true,
  status,
  onRecovered,
  onReconnectNow,
  onAuthenticationFailure,
}: BackendRecoveryMonitorOptions): void {
  const timerRef = useRef<number | null>(null);
  const probeInFlightRef = useRef(false);
  const queuedProbeReasonRef = useRef<string | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const lastProbeStartedAtRef = useRef<number>(0);
  const onRecoveredRef = useRef(onRecovered);
  const onReconnectNowRef = useRef(onReconnectNow);
  const onAuthenticationFailureRef = useRef(onAuthenticationFailure);
  const runHealthProbeRef = useRef<(reason: string) => void>(() => undefined);

  onRecoveredRef.current = onRecovered;
  onReconnectNowRef.current = onReconnectNow;
  onAuthenticationFailureRef.current = onAuthenticationFailure;

  const clearProbeTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleProbe = useCallback(
    (delayMs: number, reason: string) => {
      clearProbeTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void runHealthProbeRef.current(reason);
      }, delayMs);
    },
    [clearProbeTimer]
  );

  const runHealthProbe = useCallback(
    async (reason: string) => {
      if (!enabled) {
        return;
      }

      if (probeInFlightRef.current) {
        queuedProbeReasonRef.current = reason;
        return;
      }

      probeInFlightRef.current = true;
      lastProbeStartedAtRef.current = Date.now();
      clearProbeTimer();

      const abortController = new AbortController();
      const timeoutId = window.setTimeout(() => {
        abortController.abort();
      }, HEALTH_CHECK_TIMEOUT_MS);
      const probeRequest = buildRecoveryProbeRequest();
      const exchangePendingAtDispatch = isOidcExchangePending();
      const isSuperseded = () => {
        const currentToken = authSession.getAccessToken();
        return Boolean(
          probeRequest.headers["Authorization"] && currentToken && probeRequest.headers["Authorization"] !== `Bearer ${currentToken}`
        );
      };

      try {
        const response = await fetch(probeRequest.url, {
          method: "GET",
          cache: "no-store",
          signal: abortController.signal,
          headers: probeRequest.headers,
        });
        if (isSuperseded()) return;
        if (response.status === 401 && (exchangePendingAtDispatch || isOidcExchangePending())) return;

        if (response.status === 401 && probeRequest.headers["Authorization"]) {
          markBackendAvailable();
          await authSession.requestRefresh();
          if (isSuperseded()) return;
          logger.info("Backend recovery token refresh succeeded", { reason, url: probeRequest.url }, "backend-recovery");
          scheduleProbe(0, TOKEN_REFRESH_SUCCESS_REASON);
          return;
        }

        if (!response.ok) {
          throw new Error(`Backend recovery probe failed with status ${response.status}`);
        }

        const wasRecovering =
          getBackendAvailabilitySnapshot().status !== "available" ||
          consecutiveFailuresRef.current > 0 ||
          reason === TOKEN_REFRESH_SUCCESS_REASON;
        const shouldNotifyRecovery = wasRecovering || PROACTIVE_RECOVERY_REASONS.has(reason);
        consecutiveFailuresRef.current = 0;
        markBackendAvailable();

        if (shouldNotifyRecovery) {
          logger.info("Backend recovery probe succeeded", { reason, url: probeRequest.url }, "backend-recovery");
          onReconnectNowRef.current?.("health-probe-success");
          onRecoveredRef.current?.("health-probe-success", wasRecovering);
        }
      } catch (error) {
        if (isSuperseded() || exchangePendingAtDispatch || isOidcExchangePending()) return;
        const shouldKeepRecovering =
          error instanceof AuthSessionError &&
          (error.code === "transient" || (error.code === "refresh-uncertain" && authSession.hasUsableAccessToken()));

        if (error instanceof AuthSessionError && !shouldKeepRecovering) {
          logger.warn("Backend recovery requires authentication", { reason, url: probeRequest.url, error }, "backend-recovery");
          markBackendAvailable();
          onAuthenticationFailureRef.current?.();
          return;
        }

        consecutiveFailuresRef.current += 1;

        if (consecutiveFailuresRef.current >= PROBE_FAILURES_BEFORE_UNAVAILABLE) {
          markBackendUnavailable("Backend health checks are still failing.");
        } else {
          markBackendReconnecting("Backend recovery check in progress.");
        }

        logger.warn(
          "Backend recovery probe failed",
          {
            reason,
            url: probeRequest.url,
            failures: consecutiveFailuresRef.current,
            error,
          },
          "backend-recovery"
        );

        scheduleProbe(getRecoveryDelay(consecutiveFailuresRef.current - 1), "retry-after-failure");
      } finally {
        window.clearTimeout(timeoutId);
        probeInFlightRef.current = false;

        if (queuedProbeReasonRef.current) {
          const queuedReason = queuedProbeReasonRef.current;
          queuedProbeReasonRef.current = null;
          void runHealthProbe(queuedReason);
        }
      }
    },
    [clearProbeTimer, enabled, scheduleProbe]
  );

  runHealthProbeRef.current = (reason: string) => {
    void runHealthProbe(reason);
  };

  useEffect(() => {
    if (!enabled) {
      clearProbeTimer();
      consecutiveFailuresRef.current = 0;
      queuedProbeReasonRef.current = null;
      return;
    }

    if (status === "available") {
      clearProbeTimer();
      consecutiveFailuresRef.current = 0;
      queuedProbeReasonRef.current = null;
      return;
    }

    onReconnectNowRef.current?.("backend-status-change");
    void runHealthProbe("backend-status-change");
  }, [clearProbeTimer, enabled, runHealthProbe, status]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const shouldRunProactiveProbe = () => Date.now() - lastProbeStartedAtRef.current >= PROACTIVE_PROBE_MIN_INTERVAL_MS;

    const triggerImmediateRecovery = (reason: string) => {
      if (getBackendAvailabilitySnapshot().status === "available") {
        if (!shouldRunProactiveProbe()) {
          return;
        }

        void runHealthProbe(reason);
        return;
      }

      onReconnectNowRef.current?.(reason);
      void runHealthProbe(reason);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerImmediateRecovery("visibility-visible");
      }
    };

    const handleFocus = () => {
      triggerImmediateRecovery("window-focus");
    };

    const handleOnline = () => {
      triggerImmediateRecovery("window-online");
    };

    const handlePageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) {
        return;
      }

      triggerImmediateRecovery("window-pageshow");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [enabled, runHealthProbe]);

  useEffect(() => {
    return () => {
      clearProbeTimer();
      queuedProbeReasonRef.current = null;
      consecutiveFailuresRef.current = 0;
    };
  }, [clearProbeTimer]);
}

export default useBackendRecoveryMonitor;
