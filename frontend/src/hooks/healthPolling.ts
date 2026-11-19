const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export const HEALTH_REQUEST_TIMEOUT_MS = 8_000;
export const HEALTH_RECOVERY_MS = 20_000;
export const HEALTH_TICK_MS = 1_000;
export const HEALTH_RESUME_GAP_MS = 5_000;

export function healthRetryDelay(failures: number): number {
  return Math.min(RETRY_MIN_MS * 2 ** Math.min(failures - 1, 4), RETRY_MAX_MS);
}

export function isHealthPollingGap(previous: { elapsed: number; wall: number }, current: typeof previous): boolean {
  return Math.max(current.elapsed - previous.elapsed, current.wall - previous.wall) >= HEALTH_RESUME_GAP_MS;
}

export type PollResult = "ok" | "retry" | "collecting";

/** A polling source owns its own deadline, backoff, and one pending refresh. */
export function createHealthPoll(run: (signal: AbortSignal) => Promise<PollResult>, interval: () => number, onSettled?: () => void) {
  let due = 0;
  let failures = 0;
  let queued = false;
  let active: AbortController | null = null;
  let deadline = 0;

  const poll = {
    tick(now: number, canPoll: () => boolean) {
      if (active || now < due || !canPoll()) return;
      const request = new AbortController();
      active = request;
      deadline = window.setTimeout(
        () => request.abort(new DOMException("Health request timed out", "TimeoutError")),
        HEALTH_REQUEST_TIMEOUT_MS
      );
      void run(request.signal).then((result) => {
        if (active !== request) return;
        window.clearTimeout(deadline);
        active = null;
        failures = result === "ok" ? 0 : failures + 1;
        const delay = result === "collecting" ? Math.min(healthRetryDelay(failures), interval()) : healthRetryDelay(Math.max(1, failures));
        due = queued ? 0 : result === "ok" ? now + interval() : performance.now() + delay;
        queued = false;
        if (due === 0) poll.tick(performance.now(), canPoll);
        onSettled?.();
      });
    },
    refresh() {
      if (active) queued = true;
      else due = 0;
    },
    cancel(nextDue = 0) {
      window.clearTimeout(deadline);
      active?.abort();
      active = null;
      due = nextDue;
      queued = false;
      failures = 0;
    },
    get running() {
      return active !== null;
    },
  };
  return poll;
}

// Bound the entire call, including work such as Companion request signing that precedes HTTP.
export async function healthRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return await Promise.race([request(), canceled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
