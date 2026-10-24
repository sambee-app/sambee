/**
 * Centralized logging service for the frontend.
 *
 * Provides two separate logging mechanisms:
 * 1. Console logging: Controlled by backend config (logging_enabled/logging_level)
 *    - Development builds: Defaults to DEBUG level, can be overridden by backend config
 *    - Production builds: Defaults to WARN level, can be overridden by backend config
 *    - Backend config takes precedence once loaded via initializeBackendTracing()
 *
 * 2. Backend tracing: Optional server-side logging controlled by backend config
 *    - Can be enabled/disabled per user via backend configuration
 *    - Sends logs to backend for production monitoring and debugging
 *    - Configured via [frontend_logging] section in config.toml
 */

import { LogBuffer, type LogEntry as MobileLogEntry } from "./logBuffer";
import { LogTransport } from "./logTransport";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogContext {
  [key: string]: unknown;
}

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: LogContext;
  requestId?: string;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

class Logger {
  private minLevel: LogLevel;
  private isDevelopment: boolean;
  private isTest: boolean;
  private backendTraceBuffer: LogBuffer | null = null;
  private backendTracingEnabled = false;

  constructor() {
    this.isDevelopment = import.meta.env.DEV;
    // Detect test environment - vitest sets this or we can check if vitest globals exist
    this.isTest =
      import.meta.env["VITEST"] === true ||
      import.meta.env.MODE === "test" ||
      // Alternative: check if vitest globals are available
      (typeof globalThis !== "undefined" && ("describe" in globalThis || "it" in globalThis || "test" in globalThis));
    // In production, only show warnings and errors; in development, show all logs
    this.minLevel = this.isDevelopment ? LogLevel.DEBUG : LogLevel.WARN;
  }

  /**
   * Initialize backend tracing based on server configuration
   *
   * Backend tracing (optional server-side logging) can be enabled/disabled
   * per user via the backend config [frontend_logging] section.
   * Should be called after user authentication to fetch user-specific tracing config.
   *
   * Also applies console logging settings from the backend config.
   */
  async initializeBackendTracing(): Promise<void> {
    // Don't enable in test environment
    if (this.isTest) {
      return;
    }

    try {
      const { loggingConfig } = await import("./loggingConfig");
      const config = await loggingConfig.getConfig();

      // Apply console logging settings from backend config
      if (config.logging_enabled) {
        const levelMap: Record<string, LogLevel> = {
          DEBUG: LogLevel.DEBUG,
          INFO: LogLevel.INFO,
          WARNING: LogLevel.WARN,
          ERROR: LogLevel.ERROR,
        };
        const level = levelMap[config.logging_level.toUpperCase()];
        if (level !== undefined) {
          this.setLevel(level);
          this.info("Console logging level set from server config", {
            logging_level: config.logging_level,
          });
        }
      } else if (!this.isDevelopment) {
        // In production, if logging is disabled, suppress all console output
        this.setLevel(LogLevel.ERROR + 1); // Higher than ERROR to disable all
      }

      // Enable backend tracing if configured
      if (config.tracing_enabled) {
        this.enableBackendTracing();
        this.info("Backend tracing initialized from server config", {
          tracing_level: config.tracing_level,
          tracing_components: config.tracing_components,
        });
      }
    } catch (error) {
      // Use console.warn directly during initialization to avoid circular dependency
      // Silently fail - backend config is optional
      console.warn("Failed to initialize logging/tracing config:", error);
    }
  }

  /**
   * Enable backend tracing (server-side logging)
   *
   * @param maxLogs - Maximum number of logs to buffer before auto-flush (default: 50)
   * @param flushIntervalMs - Time interval for auto-flush in milliseconds (default: 30000 = 30s)
   */
  enableBackendTracing(maxLogs = 50, flushIntervalMs = 30000): void {
    // Don't enable in test environment
    if (this.isTest) {
      return;
    }

    if (this.backendTracingEnabled) {
      return;
    }

    const transport = new LogTransport();
    this.backendTraceBuffer = new LogBuffer(
      async (batch) => {
        await transport.send(batch);
      },
      maxLogs,
      flushIntervalMs
    );

    this.backendTraceBuffer.enable();
    this.backendTracingEnabled = true;

    this.info("Backend tracing enabled", {
      sessionId: this.backendTraceBuffer.getSessionId(),
      maxLogs,
      flushIntervalMs,
    });
  }

  /**
   * Disable backend tracing
   */
  disableBackendTracing(): void {
    if (!this.backendTracingEnabled || !this.backendTraceBuffer) {
      return;
    }

    this.info("Backend tracing disabled");

    // Flush any remaining logs before disabling
    void this.backendTraceBuffer.flush();
    this.backendTraceBuffer.disable();
    this.backendTracingEnabled = false;
  }

  /**
   * Manually flush backend traces
   */
  async flushBackendTraces(): Promise<void> {
    if (this.backendTraceBuffer) {
      await this.backendTraceBuffer.flush();
    }
  }

  /**
   * Send a log entry to the backend trace buffer
   */
  private async sendToBackendTrace(level: LogLevel, message: string, context?: LogContext, component?: string): Promise<void> {
    if (!this.backendTracingEnabled || !this.backendTraceBuffer) {
      return;
    }

    // Check if this log should be sent based on configuration
    try {
      const { loggingConfig } = await import("./loggingConfig");

      const levelName = LogLevel[level].toLowerCase();
      const levelEnabled = await loggingConfig.isLevelEnabled(levelName);
      if (!levelEnabled) {
        return;
      }

      if (component) {
        const componentEnabled = await loggingConfig.isComponentEnabled(component);
        if (!componentEnabled) {
          return;
        }
      }
    } catch {
      // If config check fails, don't send to avoid blocking
      return;
    }

    const entry: MobileLogEntry = {
      timestamp: Date.now(),
      level: LogLevel[level],
      message,
      context,
      component,
    };

    this.backendTraceBuffer.add(entry);
  }

  /**
   * Set the minimum log level
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /**
   * Log a debug message (automatically forwards to backend tracing if enabled)
   * @param message - Log message
   * @param context - Additional context data
   * @param component - Optional component name for backend tracing filtering
   */
  debug(message: string, context?: LogContext, component?: string): void {
    this.log(LogLevel.DEBUG, message, context);
    void this.sendToBackendTrace(LogLevel.DEBUG, message, context, component);
  }

  /**
   * Log an info message (automatically forwards to backend tracing if enabled)
   * @param message - Log message
   * @param context - Additional context data
   * @param component - Optional component name for backend tracing filtering
   */
  info(message: string, context?: LogContext, component?: string): void {
    this.log(LogLevel.INFO, message, context);
    void this.sendToBackendTrace(LogLevel.INFO, message, context, component);
  }

  /**
   * Log a warning message (automatically forwards to backend tracing if enabled)
   * @param message - Log message
   * @param context - Additional context data
   * @param component - Optional component name for backend tracing filtering
   */
  warn(message: string, context?: LogContext, component?: string): void {
    this.log(LogLevel.WARN, message, context);
    void this.sendToBackendTrace(LogLevel.WARN, message, context, component);
  }

  /**
   * Log an error message (automatically forwards to backend tracing if enabled)
   * @param message - Log message
   * @param context - Additional context data
   * @param component - Optional component name for backend tracing filtering
   * @param error - Optional Error object
   */
  error(message: string, context?: LogContext, component?: string, error?: Error): void {
    const errorContext = error
      ? {
          ...context,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
          },
        }
      : context;
    this.log(LogLevel.ERROR, message, errorContext);
    void this.sendToBackendTrace(LogLevel.ERROR, message, errorContext, component);
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (level < this.minLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
      context,
    };

    // Extract request ID from context if present
    if (context?.["requestId"]) {
      entry.requestId = String(context["requestId"]);
    }

    // Console output (skipped in test environment)
    if (!this.isTest) {
      this.consoleLog(level, entry);
    }
  }

  /**
   * Output to console with appropriate styling
   */
  private consoleLog(level: LogLevel, entry: LogEntry): void {
    const prefix = entry.requestId ? `[${entry.requestId}] ` : "";
    const fullMessage = `${prefix}${entry.message}`;

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(`%c${entry.timestamp} DEBUG`, "color: gray", fullMessage, entry.context || "");
        break;
      case LogLevel.INFO:
        console.info(`%c${entry.timestamp} INFO`, "color: blue", fullMessage, entry.context || "");
        break;
      case LogLevel.WARN:
        console.warn(`%c${entry.timestamp} WARN`, "color: orange", fullMessage, entry.context || "");
        break;
      case LogLevel.ERROR:
        console.error(`%c${entry.timestamp} ERROR`, "color: red", fullMessage, entry.context || "");
        break;
    }
  }

  /**
   * Get request ID from backend response header
   */
  extractRequestId(headers?: Record<string, string>): string | undefined {
    if (!headers) return undefined;
    return headers["x-request-id"] || headers["X-Request-ID"];
  }
}

// Export singleton instance
export const logger = new Logger();

// Export convenience functions
export const debug = (message: string, context?: LogContext, component?: string) => logger.debug(message, context, component);
export const info = (message: string, context?: LogContext, component?: string) => logger.info(message, context, component);
export const warn = (message: string, context?: LogContext, component?: string) => logger.warn(message, context, component);
export const error = (message: string, context?: LogContext, component?: string, err?: Error) =>
  logger.error(message, context, component, err);

export default logger;
