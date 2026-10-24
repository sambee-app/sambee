import type { CompanionDriveDescriptor, CompanionSessionSnapshot } from "./storageContracts";

const COMPANION_SECRET_KEY = "companion_secret";

type Listener = () => void;

export function canSignCompanionRequests(): boolean {
  return window.isSecureContext === true && typeof crypto.subtle !== "undefined";
}

function haveSameDrives(left: readonly CompanionDriveDescriptor[], right: readonly CompanionDriveDescriptor[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (drive, index) => drive.driveId === right[index]?.driveId && drive.name === right[index]?.name && drive.path === right[index]?.path
    )
  );
}

async function sign(secret: string, value: string): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", bytes.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, bytes.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (const [index, leftPoint] of leftPoints.entries()) {
    const rightPoint = rightPoints[index];
    if (rightPoint === undefined) break;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}

export class CompanionSession {
  private revision = 0;
  private snapshot: CompanionSessionSnapshot = { status: "unpaired", revision: 0, drives: [], error: null };
  private readonly listeners = new Set<Listener>();

  getSnapshot(): CompanionSessionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setState(
    status: CompanionSessionSnapshot["status"],
    drives: readonly CompanionDriveDescriptor[] = [],
    error: CompanionSessionSnapshot["error"] = null
  ): void {
    if (this.snapshot.status === status && this.snapshot.error === error && haveSameDrives(this.snapshot.drives, drives)) {
      return;
    }

    this.revision += 1;
    this.snapshot = { status, drives, error, revision: this.revision };
    for (const listener of this.listeners) listener();
  }

  hasSecret(): boolean {
    return localStorage.getItem(COMPANION_SECRET_KEY) !== null;
  }

  storeSecret(secret: string): void {
    localStorage.setItem(COMPANION_SECRET_KEY, secret);
    this.setState("paired", this.snapshot.drives);
  }

  clearPairing(): void {
    localStorage.removeItem(COMPANION_SECRET_KEY);
    this.setState("unpaired");
  }

  async getSigningHeaders(method: string, url: string): Promise<Record<string, string>> {
    const secret = localStorage.getItem(COMPANION_SECRET_KEY);
    if (!secret) throw new Error("Not paired with companion");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const target = new URL(url, `${window.location.origin}/`);
    const parameters = [...target.searchParams.entries()]
      .filter(([key]) => !["hmac", "ts", "origin"].includes(key))
      .sort(
        ([leftKey, leftValue], [rightKey, rightValue]) => compareCodePoints(leftKey, rightKey) || compareCodePoints(leftValue, rightValue)
      );
    const query = new URLSearchParams(parameters).toString();
    const path = target.pathname + (query ? `?${query}` : "");
    const payload = `${window.location.origin}\n${timestamp}\n${method.toUpperCase()}\n${path}`;
    return { "X-Companion-Secret": await sign(secret, payload), "X-Companion-Timestamp": timestamp };
  }

  async getSignedQuery(method: string, url: string): Promise<string> {
    const headers = await this.getSigningHeaders(method, url);
    return `hmac=${headers["X-Companion-Secret"]}&ts=${headers["X-Companion-Timestamp"]}&origin=${encodeURIComponent(window.location.origin)}`;
  }
}

export const companionSession = new CompanionSession();
