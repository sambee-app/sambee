/**
 * LogTransport - Sends log batches to backend API
 *
 * Handles the HTTP transport layer for mobile logs.
 * Uses fetch API directly to avoid circular dependencies with api.ts.
 */

import { authSession } from "./authSession";
import type { LogBatch } from "./logBuffer";

//
// LogTransport
//
export class LogTransport {
  private apiBaseUrl: string;

  /**
   * Create a new log transport
   *
   * @param apiBaseUrl - Base URL for the API (default: /api)
   */
  constructor(apiBaseUrl = "/api") {
    this.apiBaseUrl = apiBaseUrl;
  }

  /**
   * Send a log batch to the backend
   *
   * @param batch - Log batch to send
   * @throws Error if the request fails
   */
  async send(batch: LogBatch): Promise<void> {
    const url = `${this.apiBaseUrl}/logs/mobile`;

    // Get authentication token if available
    const token = authSession.getAccessToken();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send logs (${response.status}): ${errorText}`);
    }
  }
}
