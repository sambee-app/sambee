/**
 * LogBuffer - In-memory buffer for mobile log entries
 *
 * Stores logs in memory until they reach a threshold size or time,
 * then triggers flush to send them to the backend.
 */

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  component?: string;
}

export interface LogBatch {
  session_id: string;
  device_info: {
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
    platform: string;
    isTouchDevice: boolean;
  };
  logs: LogEntry[];
}

export type FlushCallback = (batch: LogBatch) => Promise<void>;

//
// LogBuffer
//
export class LogBuffer {
  private logs: LogEntry[] = [];
  private sessionId: string;
  private deviceInfo: LogBatch["device_info"];
  private flushCallback: FlushCallback;
  private maxLogs: number;
  private flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isEnabled = false;

  /**
   * Create a new log buffer
   *
   * @param flushCallback - Function to call when flushing logs
   * @param maxLogs - Maximum number of logs to buffer before auto-flush (default: 50)
   * @param flushIntervalMs - Time interval for auto-flush in milliseconds (default: 30000 = 30s)
   */
  constructor(flushCallback: FlushCallback, maxLogs = 50, flushIntervalMs = 30000) {
    this.flushCallback = flushCallback;
    this.maxLogs = maxLogs;
    this.flushIntervalMs = flushIntervalMs;

    // Generate session ID
    this.sessionId = this.generateSessionId();

    // Collect device info
    this.deviceInfo = {
      userAgent: navigator.userAgent,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      devicePixelRatio: window.devicePixelRatio,
      platform: navigator.platform,
      isTouchDevice: this.checkIsTouchDevice(),
    };
  }

  /**
   * Enable log buffering and start flush timer
   */
  enable(): void {
    if (this.isEnabled) {
      return;
    }

    this.isEnabled = true;
    this.startFlushTimer();
  }

  /**
   * Disable log buffering and stop flush timer
   */
  disable(): void {
    if (!this.isEnabled) {
      return;
    }

    this.isEnabled = false;
    this.stopFlushTimer();
  }

  /**
   * Add a log entry to the buffer
   */
  add(entry: LogEntry): void {
    if (!this.isEnabled) {
      return;
    }

    this.logs.push(entry);

    // Auto-flush if we hit the max log count
    if (this.logs.length >= this.maxLogs) {
      void this.flush();
    }

    // Safety check: if buffer exceeds 2x max size (flush may have failed),
    // drop oldest logs to prevent memory issues
    if (this.logs.length > this.maxLogs * 2) {
      // Use console.warn directly to avoid circular dependency (logBuffer is used by logger)
      console.warn(`LogBuffer exceeded ${this.maxLogs * 2} entries, dropping oldest logs`);
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  /**
   * Flush all buffered logs to the backend
   */
  async flush(): Promise<void> {
    if (this.logs.length === 0) {
      return;
    }

    const batch: LogBatch = {
      session_id: this.sessionId,
      device_info: this.deviceInfo,
      logs: [...this.logs],
    };

    try {
      await this.flushCallback(batch);
      // Only clear buffer after successful send
      this.logs = [];
    } catch (error) {
      // Log to console if flush fails (can't send to backend)
      // Keep logs in buffer for retry on next flush
      console.error("Failed to flush mobile logs:", error);
    }

    // Restart flush timer after flush attempt
    this.restartFlushTimer();
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.logs.length;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Check if device has touch capability
   */
  private checkIsTouchDevice(): boolean {
    return (
      "ontouchstart" in window ||
      navigator.maxTouchPoints > 0 ||
      // @ts-expect-error - legacy property
      navigator.msMaxTouchPoints > 0
    );
  }

  /**
   * Start the flush timer
   */
  private startFlushTimer(): void {
    if (this.flushTimer !== null) {
      return;
    }

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Stop the flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Restart the flush timer (called after manual flush)
   */
  private restartFlushTimer(): void {
    this.stopFlushTimer();
    if (this.isEnabled) {
      this.startFlushTimer();
    }
  }
}
