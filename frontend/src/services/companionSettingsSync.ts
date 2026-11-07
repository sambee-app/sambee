import { useSyncExternalStore } from "react";
import { isApiError } from "../types";
import {
  COMPANION_SETTINGS_SECTIONS,
  COMPANION_SETTINGS_VERSION,
  type CompanionSettingsMetadata,
  type CompanionSettingsSection,
  type CompanionSettingsStatus,
} from "../types/companionSettings";
import { getApiErrorMessage } from "../utils/apiErrors";
import api from "./api";
import { isAuthRequired } from "./authConfig";
import { authSession } from "./authSession";
import { subscribeBackendRecoveryConfirmed } from "./backendRecoveryEvents";
import companionService, { isCompanionAuthSignatureMismatch, isCompanionPairingMissing } from "./companion";
import { companionSession } from "./companionSession";
import { COMPANION_SETTINGS_CHANGED_EVENT } from "./companionSettingsEvents";

const CHECK_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000];
const SETTINGS_LOCK = "sambee-companion-settings";
export type SettingsSyncPhase =
  | "defaults_active"
  | "synchronized"
  | "synchronizing"
  | "update_required"
  | "authority_conflict"
  | "pairing_required"
  | "delivery_failed";
export interface SettingsSyncSnapshot {
  phase: SettingsSyncPhase;
  status: CompanionSettingsStatus | null;
  message: string | null;
  sections: Partial<Record<CompanionSettingsSection, SettingsSyncPhase>>;
}

export function changedSettingsSections(
  metadata: CompanionSettingsMetadata,
  status: CompanionSettingsStatus,
  switchUser: boolean
): CompanionSettingsSection[] {
  return COMPANION_SETTINGS_SECTIONS.filter((name) => {
    const desired = metadata[name];
    const current = status.sections[name];
    if (name !== "directory_index" && !switchUser) {
      const applied = [status.sections.theme, status.sections.localization].find(
        (section) => section?.origin === window.location.origin && section.backend_identity === metadata.backend_identity
      );
      if (applied?.user_scope && applied.user_scope !== desired.user_scope) return false;
    }
    return (
      current?.result !== "synchronized" ||
      current.backend_identity !== metadata.backend_identity ||
      current.origin !== window.location.origin ||
      current.version !== desired.version ||
      current.marker !== desired.marker ||
      current.user_scope !== desired.user_scope
    );
  });
}

class CompanionSettingsSynchronizer {
  private snapshot: SettingsSyncSnapshot = { phase: "defaults_active", status: null, message: null, sections: {} };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private running = false;
  private pending = false;
  private switchUser = false;
  private retries = 0;
  private blocked = false;
  private generation = 0;
  private cleanup: (() => void)[] = [];

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): SettingsSyncSnapshot => this.snapshot;

  start(): () => void {
    if (this.running) return () => undefined;
    this.running = true;
    this.blocked = false;
    this.retries = 0;
    const preferences = (event: Event) => this.request((event as CustomEvent<{ switchUser?: boolean }>).detail?.switchUser === true, true);
    const visible = () => {
      if (document.visibilityState === "visible") this.request();
      else this.cancel({ preserveUserSwitch: true });
    };
    const reconnect = () => this.request();
    window.addEventListener(COMPANION_SETTINGS_CHANGED_EVENT, preferences);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", reconnect);
    this.cleanup = [
      () => window.removeEventListener(COMPANION_SETTINGS_CHANGED_EVENT, preferences),
      () => document.removeEventListener("visibilitychange", visible),
      () => window.removeEventListener("online", reconnect),
      companionSession.subscribe(() => {
        if (companionSession.hasSecret()) this.request();
        else {
          this.cancel();
          this.publish({ phase: "defaults_active", status: null, message: null, sections: {} });
        }
      }),
      authSession.subscribeToIdentity(() => {
        this.cancel();
        this.blocked = false;
        if (authSession.hasUsableAccessToken()) this.request();
      }),
      authSession.subscribeToClear(() => this.cancel()),
      authSession.subscribeToBootstrap(() => this.request()),
      subscribeBackendRecoveryConfirmed(() => this.request()),
    ];
    this.request();
    return () => this.stop();
  }

  stop(): void {
    this.running = false;
    this.cancel();
    for (const dispose of this.cleanup) dispose();
    this.cleanup = [];
  }

  request = (switchUser = false, explicit = false): void => {
    if (!this.running) return;
    if (explicit) {
      this.blocked = false;
      this.retries = 0;
    }
    if (switchUser) {
      this.generation += 1;
      this.controller?.abort();
    }
    this.switchUser ||= switchUser;
    this.pending = true;
    if (!this.controller) void this.run();
  };

  private cancel({ preserveUserSwitch = false }: { preserveUserSwitch?: boolean } = {}): void {
    this.generation += 1;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    if (!preserveUserSwitch) this.switchUser = false;
    this.retries = 0;
  }

  private publishStatus(status: CompanionSettingsStatus): void {
    const sections = Object.fromEntries(
      COMPANION_SETTINGS_SECTIONS.map((name) => [name, status.results?.[name] ?? status.sections[name]?.result ?? "defaults_active"])
    ) as SettingsSyncSnapshot["sections"];
    const results = Object.values(sections);
    this.publish({
      phase:
        status.status === "delivery_failed" || results.includes("delivery_failed")
          ? "delivery_failed"
          : results.every((result) => result === "defaults_active")
            ? "defaults_active"
            : "synchronized",
      status,
      message: status.message,
      sections,
    });
  }

  private publish(snapshot: SettingsSyncSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.running && !this.blocked && document.visibilityState === "visible") {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.request();
      }, delay);
    }
  }

  private async run(): Promise<void> {
    if (!this.running || this.blocked || this.controller || !companionSession.hasSecret() || document.visibilityState !== "visible") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    const generation = this.generation;
    const switchUser = this.switchUser;
    this.pending = false;
    let delay = CHECK_INTERVAL_MS;
    try {
      if (!authSession.hasUsableAccessToken() && (await isAuthRequired())) {
        controller.abort();
        return;
      }
      const check = () => !controller.signal.aborted && generation === this.generation && this.running;
      if (!check()) return;
      const synchronize = async () => {
        if (!check()) return;
        const options = { signal: controller.signal };
        const [metadata, status] = await Promise.all([
          api.getCompanionSettingsMetadata(options),
          companionService.getSettingsStatus(options),
        ]);
        if (!check()) return;
        if (
          metadata.version !== COMPANION_SETTINGS_VERSION ||
          status.version !== COMPANION_SETTINGS_VERSION ||
          COMPANION_SETTINGS_SECTIONS.some((name) => metadata[name].version !== COMPANION_SETTINGS_VERSION)
        ) {
          this.blocked = true;
          this.publish({ phase: "update_required", status, message: null, sections: {} });
          return;
        }
        if (status.authoritative_origin !== window.location.origin || status.status === "authority_conflict") {
          this.blocked = true;
          this.publish({ phase: "authority_conflict", status, message: null, sections: {} });
          return;
        }
        const sections = changedSettingsSections(metadata, status, switchUser);
        if (!sections.length) {
          this.retries = 0;
          this.switchUser = false;
          this.publishStatus(status);
          return;
        }
        this.publish({
          phase: "synchronizing",
          status,
          message: null,
          sections: Object.fromEntries(sections.map((name) => [name, "synchronizing"])),
        });
        const challenge = await companionService.requestSettingsChallenge(options);
        if (!check()) return;
        if (!challenge.challenge || challenge.authoritative_origin !== window.location.origin)
          throw new Error("Settings authority changed. Refresh settings status.");
        const grant = await api.issueCompanionSettingsGrant(
          {
            version: COMPANION_SETTINGS_VERSION,
            companion_id: challenge.companion_id,
            challenge: challenge.challenge,
            origin: window.location.origin,
            sections,
            switch_user: switchUser,
          },
          options
        );
        if (!check()) return;
        const applied = await companionService.redeemSettingsGrant(grant.grant, options);
        if (!check()) return;
        if (
          applied.authoritative_origin !== window.location.origin ||
          applied.authority_generation !== challenge.authority_generation ||
          sections.some((name) => {
            const result = applied.sections[name];
            return (
              result?.result !== "synchronized" ||
              result.marker !== grant[name].marker ||
              result.user_scope !== grant[name].user_scope ||
              result.backend_identity !== grant.backend_identity
            );
          })
        )
          throw new Error("Settings delivery was not confirmed. Refresh settings status and retry.");
        this.retries = 0;
        this.switchUser = false;
        this.publishStatus(applied);
      };
      if (navigator.locks) {
        await navigator.locks.request(SETTINGS_LOCK, { signal: controller.signal }, synchronize);
      } else {
        await synchronize();
      }
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation || !this.running) return;
      const status = isApiError(error) ? error.response?.status : undefined;
      const code = isApiError(error) ? error.response?.data?.code : undefined;
      const phase =
        status === 404 || status === 426 || code === "settings_update_required" || code === "companion_browser_update_required"
          ? "update_required"
          : code === "settings_authority_conflict"
            ? "authority_conflict"
            : isCompanionAuthSignatureMismatch(error) || isCompanionPairingMissing(error)
              ? "pairing_required"
              : "delivery_failed";
      this.blocked = phase === "authority_conflict" || phase === "update_required" || phase === "pairing_required";
      this.publish({
        ...this.snapshot,
        phase,
        message:
          phase === "pairing_required"
            ? null
            : getApiErrorMessage(error, "Settings delivery failed. Check the connection and retry. The last valid settings remain active."),
        sections: Object.fromEntries(Object.keys(this.snapshot.sections).map((name) => [name, phase])),
      });
      delay = RETRY_DELAYS_MS[this.retries++] ?? CHECK_INTERVAL_MS;
    } finally {
      if (this.controller === controller) this.controller = null;
      if (this.pending && this.running) void this.run();
      else if (!controller.signal.aborted) this.schedule(delay);
    }
  }
}

export const companionSettingsSync = new CompanionSettingsSynchronizer();
export function useCompanionSettingsSync(): SettingsSyncSnapshot {
  return useSyncExternalStore(companionSettingsSync.subscribe, companionSettingsSync.getSnapshot);
}
