/**
 * Preferences panel for the Sambee Companion app.
 *
 * Displays user-configurable settings such as paired browser management,
 * notification preferences, upload conflict resolution, and temp file
 * retention. Settings are auto-saved when changed.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { type CompanionLocalizationState, getCurrentRegionalLocale, translate } from "../i18n";
import { log } from "../lib/logger";
import { type CompanionUpdateStatus, fetchCompanionUpdateStatus, installCompanionUpdate } from "../lib/updateCheck";
import type { CompanionUpdateChannel, UploadConflictAction, UserPreferences } from "../stores/userPreferences";
import { getUserPreferences, saveUserPreferences } from "../stores/userPreferences";
import { ModalDialog } from "./ModalDialog";
import "../styles/preferences.css";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum allowed temp file retention (days). */
const MIN_RETENTION_DAYS = 1;

/** Maximum allowed temp file retention (days). */
const MAX_RETENTION_DAYS = 90;

/** Duration (ms) to show the "Saved" indicator after a change. */
const SAVED_INDICATOR_MS = 1500;

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface PreferencesProps {
  /** Called when the user closes the preferences panel. */
  onClose: () => void;
}

type UpdateActionState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; currentVersion: string; checkedChannel: CompanionUpdateChannel }
  | { kind: "available"; status: CompanionUpdateStatus; checkedChannel: CompanionUpdateChannel }
  | { kind: "installing"; status: CompanionUpdateStatus; checkedChannel: CompanionUpdateChannel }
  | { kind: "installed"; version: string | null; checkedChannel: CompanionUpdateChannel }
  | { kind: "error"; message: string; checkedChannel: CompanionUpdateChannel };

interface NativeDirectoryPolicyStatus {
  status: string;
  owner_origin: string | null;
  effective_revision: number | null;
  message: string | null;
}

function DirectoryPolicyPreferences() {
  const [status, setStatus] = useState<NativeDirectoryPolicyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus((await invoke<NativeDirectoryPolicyStatus>("get_native_directory_policy_status")) ?? null);
      setError(null);
    } catch {
      setError(translate("preferences.directoryPolicy.unavailable"));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const reset = async () => {
    setResetting(true);
    setError(null);
    try {
      await invoke("reset_native_directory_policy_owner");
      await load();
      setConfirmReset(false);
    } catch {
      setError(translate("preferences.directoryPolicy.resetFailed"));
    } finally {
      setResetting(false);
    }
  };
  return (
    <div class="preferences__section">
      <span class="preferences__section-title">{translate("preferences.directoryPolicy.title")}</span>
      <div class="preferences__field">
        <span class="preferences__hint" role="status">
          {error ??
            status?.message ??
            (!status
              ? translate("preferences.directoryPolicy.loading")
              : status.owner_origin
                ? translate("preferences.directoryPolicy.active")
                : translate("preferences.directoryPolicy.defaults"))}
        </span>
        {status?.owner_origin && (
          <dl class="preferences__status-grid">
            <div class="preferences__status-row">
              <dt class="preferences__status-label">{translate("preferences.directoryPolicy.owner")}</dt>
              <dd class="preferences__status-value preferences__status-value--code">{status.owner_origin}</dd>
            </div>
            <div class="preferences__status-row">
              <dt class="preferences__status-label">{translate("preferences.directoryPolicy.revision")}</dt>
              <dd class="preferences__status-value">{status.effective_revision}</dd>
            </div>
          </dl>
        )}
        <div class="preferences__confirm-actions">
          <button
            type="button"
            class="preferences__confirm-btn preferences__confirm-btn--ghost"
            onClick={() => void load()}
            disabled={resetting}
          >
            {translate("preferences.directoryPolicy.refresh")}
          </button>
          <button
            type="button"
            class="preferences__confirm-btn preferences__confirm-btn--danger"
            onClick={() => setConfirmReset(true)}
            disabled={!status || resetting || status.status === "unowned"}
          >
            {translate("preferences.directoryPolicy.reset")}
          </button>
        </div>
      </div>
      {confirmReset && (
        <ModalDialog
          role="alertdialog"
          titleId="directory-policy-reset-title"
          initialFocusRef={cancelRef}
          onRequestClose={() => {
            if (!resetting) setConfirmReset(false);
          }}
          panelClassName="preferences__confirm-panel"
        >
          <h3 id="directory-policy-reset-title" class="preferences__confirm-title">
            {translate("preferences.directoryPolicy.resetTitle")}
          </h3>
          <p class="preferences__confirm-body">{translate("preferences.directoryPolicy.resetBody")}</p>
          {error && (
            <p class="preferences__confirm-body" role="alert">
              {error}
            </p>
          )}
          <div class="preferences__confirm-actions">
            <button
              type="button"
              ref={cancelRef}
              class="preferences__confirm-btn preferences__confirm-btn--ghost"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
            >
              {translate("common.actions.cancel")}
            </button>
            <button
              type="button"
              class="preferences__confirm-btn preferences__confirm-btn--danger"
              onClick={() => void reset()}
              disabled={resetting}
            >
              {translate(resetting ? "preferences.directoryPolicy.resetting" : "preferences.directoryPolicy.confirmReset")}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return translate("preferences.updateStatus.unknownError");
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

//
// Preferences
//
/**
 * Full-panel preferences editor.
 *
 * Settings are loaded once on mount and auto-saved on every change.
 * A brief "Saved" indicator flashes after each successful save.
 */
export function Preferences({ onClose }: PreferencesProps) {
  const conflictActionLabels: Record<UploadConflictAction, string> = {
    ask: translate("preferences.conflictActions.ask"),
    overwrite: translate("preferences.conflictActions.overwrite"),
    "save-copy": translate("preferences.conflictActions.saveCopy"),
  };
  const updateChannelLabels: Record<CompanionUpdateChannel, string> = {
    stable: translate("preferences.updateChannels.stable"),
    beta: translate("preferences.updateChannels.beta"),
    test: translate("preferences.updateChannels.test"),
  };
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [pairedOrigins, setPairedOrigins] = useState<string[]>([]);
  const [syncedLocalization, setSyncedLocalization] = useState<CompanionLocalizationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSaved, setShowSaved] = useState(false);
  const [changingAutostart, setChangingAutostart] = useState(false);
  const [pendingUnpairOrigin, setPendingUnpairOrigin] = useState<string | null>(null);
  const [unpairingOrigin, setUnpairingOrigin] = useState<string | null>(null);
  const [pendingUpdateChannel, setPendingUpdateChannel] = useState<CompanionUpdateChannel | null>(null);
  const [updateActionState, setUpdateActionState] = useState<UpdateActionState>({ kind: "idle" });
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelUnpairButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelUpdateChannelButtonRef = useRef<HTMLButtonElement | null>(null);

  // ── Load preferences on mount ───────────────────────────────────────

  useEffect(() => {
    Promise.all([
      getUserPreferences(),
      invoke<string[]>("get_paired_origins"),
      invoke<CompanionLocalizationState | null>("get_synced_localization"),
    ])
      .then(async ([storedPrefs, origins, localization]) => {
        let autoStartOnLogin = storedPrefs.autoStartOnLogin;

        try {
          autoStartOnLogin = await isAutostartEnabled();
        } catch (err) {
          log.error("Failed to read autostart state:", err);
        }

        const resolvedPrefs = storedPrefs.autoStartOnLogin === autoStartOnLogin ? storedPrefs : { ...storedPrefs, autoStartOnLogin };

        setPrefs(resolvedPrefs);
        setPairedOrigins(origins);
        setSyncedLocalization(localization);
        setLoading(false);

        if (resolvedPrefs !== storedPrefs) {
          try {
            await saveUserPreferences(resolvedPrefs);
          } catch (err) {
            log.error("Failed to reconcile autostart preference:", err);
          }
        }
      })
      .catch((err) => {
        log.error("Failed to load preferences:", err);
        setLoading(false);
      });

    const unlistenLocalization = listen<CompanionLocalizationState>("localization-updated", (event) => {
      setSyncedLocalization(event.payload);
    }).catch((err) => {
      log.warn("Failed to subscribe to localization updates:", err);
      return null;
    });

    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      void unlistenLocalization.then((fn) => fn?.());
    };
  }, []);

  useEffect(() => {
    if (!pendingUnpairOrigin) {
      return;
    }

    cancelUnpairButtonRef.current?.focus();
  }, [pendingUnpairOrigin]);

  useEffect(() => {
    if (!pendingUpdateChannel) {
      return;
    }

    cancelUpdateChannelButtonRef.current?.focus();
  }, [pendingUpdateChannel]);

  useEffect(() => {
    if (!prefs) {
      return;
    }

    setUpdateActionState({ kind: "idle" });
    setLastCheckedAt(null);
  }, [prefs?.companionUpdateChannel]);

  // ── Auto-save helper ────────────────────────────────────────────────

  //
  // persistPrefs
  //
  /**
   * Save the given preferences and flash the "Saved" indicator.
   */
  const persistPrefs = useCallback(async (updated: UserPreferences) => {
    setPrefs(updated);
    try {
      await saveUserPreferences(updated);
      setShowSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setShowSaved(false), SAVED_INDICATOR_MS);
    } catch (err) {
      log.error("Failed to save preferences:", err);
    }
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────

  //
  // handleNotificationsChange
  //
  const handleNotificationsChange = useCallback(() => {
    if (!prefs) return;
    persistPrefs({ ...prefs, showNotifications: !prefs.showNotifications });
  }, [prefs, persistPrefs]);

  const handleAutostartChange = useCallback(async () => {
    if (!prefs || changingAutostart) {
      return;
    }

    const previousPrefs = prefs;
    const updatedPrefs = {
      ...prefs,
      autoStartOnLogin: !prefs.autoStartOnLogin,
    };

    setChangingAutostart(true);
    setPrefs(updatedPrefs);

    try {
      if (updatedPrefs.autoStartOnLogin) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }

      await persistPrefs(updatedPrefs);
    } catch (err) {
      setPrefs(previousPrefs);
      log.error("Failed to update autostart preference:", err);
    } finally {
      setChangingAutostart(false);
    }
  }, [changingAutostart, persistPrefs, prefs]);

  const handleUpdateChannelChange = useCallback(
    (e: Event) => {
      if (!prefs) {
        return;
      }

      const nextChannel = (e.target as HTMLSelectElement).value as CompanionUpdateChannel;
      if (nextChannel === prefs.companionUpdateChannel) {
        return;
      }

      if (prefs.companionUpdateChannel === "stable" && nextChannel !== "stable") {
        setPendingUpdateChannel(nextChannel);
        return;
      }

      setUpdateActionState({ kind: "idle" });
      void persistPrefs({ ...prefs, companionUpdateChannel: nextChannel });
    },
    [persistPrefs, prefs]
  );

  const handleCheckForUpdates = useCallback(async () => {
    if (!prefs || updateActionState.kind === "checking" || updateActionState.kind === "installing") {
      return;
    }

    const checkedChannel = prefs.companionUpdateChannel;
    setUpdateActionState({ kind: "checking" });

    try {
      const status = await fetchCompanionUpdateStatus(checkedChannel);
      setLastCheckedAt(new Date().toISOString());

      if (status.available) {
        log.info(`Manual companion update check found ${status.version ?? "an update"} on ${checkedChannel}.`);
        setUpdateActionState({ kind: "available", status, checkedChannel });
      } else {
        setUpdateActionState({
          kind: "up-to-date",
          currentVersion: status.currentVersion,
          checkedChannel,
        });
      }
    } catch (err) {
      log.error("Failed to check for companion updates:", err);
      setLastCheckedAt(new Date().toISOString());
      setUpdateActionState({
        kind: "error",
        message: getErrorMessage(err),
        checkedChannel,
      });
    }
  }, [prefs, updateActionState.kind]);

  const handleInstallUpdate = useCallback(async () => {
    if (updateActionState.kind !== "available") {
      return;
    }

    const { checkedChannel, status } = updateActionState;
    setUpdateActionState({ kind: "installing", status, checkedChannel });

    try {
      await installCompanionUpdate(checkedChannel);
      setUpdateActionState({
        kind: "installed",
        version: status.version,
        checkedChannel,
      });
    } catch (err) {
      log.error("Failed to install companion update:", err);
      setUpdateActionState({
        kind: "error",
        message: getErrorMessage(err),
        checkedChannel,
      });
    }
  }, [updateActionState]);

  //
  // handleConflictActionChange
  //
  const handleConflictActionChange = useCallback(
    (e: Event) => {
      if (!prefs) return;
      const value = (e.target as HTMLSelectElement).value as UploadConflictAction;
      persistPrefs({ ...prefs, uploadConflictAction: value });
    },
    [prefs, persistPrefs]
  );

  //
  // handleRetentionChange
  //
  const handleRetentionChange = useCallback(
    (e: Event) => {
      if (!prefs) return;
      const raw = Number.parseInt((e.target as HTMLInputElement).value, 10);
      if (Number.isNaN(raw)) return;
      const clamped = Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, raw));
      persistPrefs({ ...prefs, tempFileRetentionDays: clamped });
    },
    [prefs, persistPrefs]
  );

  //
  const handleConfirmUnpair = useCallback(async () => {
    if (!pendingUnpairOrigin) {
      return;
    }

    const origin = pendingUnpairOrigin;
    setUnpairingOrigin(origin);
    try {
      await invoke("unpair_origin", { origin });
      setPairedOrigins((current) => current.filter((entry) => entry !== origin));
    } catch (err) {
      log.error("Failed to unpair origin:", err);
    } finally {
      setPendingUnpairOrigin(null);
      setUnpairingOrigin(null);
    }
  }, [pendingUnpairOrigin]);

  const handleCancelUnpair = useCallback(() => {
    if (unpairingOrigin) {
      return;
    }

    setPendingUnpairOrigin(null);
  }, [unpairingOrigin]);

  const handleConfirmUpdateChannel = useCallback(async () => {
    if (!prefs || !pendingUpdateChannel) {
      return;
    }

    await persistPrefs({
      ...prefs,
      companionUpdateChannel: pendingUpdateChannel,
    });
    setPendingUpdateChannel(null);
  }, [pendingUpdateChannel, persistPrefs, prefs]);

  const handleCancelUpdateChannel = useCallback(() => {
    setPendingUpdateChannel(null);
  }, []);

  const updateStatusPublishedAt =
    updateActionState.kind === "available" || updateActionState.kind === "installing" ? updateActionState.status.publishedAt : null;

  const localizedUpdatePublishedAt = updateStatusPublishedAt
    ? new Date(updateStatusPublishedAt).toLocaleString(getCurrentRegionalLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  const localizedLastCheckedAt = lastCheckedAt
    ? new Date(lastCheckedAt).toLocaleString(getCurrentRegionalLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  const showInstallButton = updateActionState.kind === "available" || updateActionState.kind === "installing";
  const isUpdateBusy = updateActionState.kind === "checking" || updateActionState.kind === "installing";

  const localizedUpdatedAt = syncedLocalization
    ? new Date(syncedLocalization.updated_at).toLocaleString(getCurrentRegionalLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  // ── Render ──────────────────────────────────────────────────────────

  if (loading || !prefs) {
    return (
      <div class="preferences">
        <p>{translate("preferences.loading")}</p>
      </div>
    );
  }

  return (
    <div class="preferences">
      {/* ── Header ── */}
      <div class="preferences__header">
        <h2 class="preferences__title">{translate("preferences.title")}</h2>
        <button type="button" class="preferences__close-btn" onClick={onClose} title={translate("preferences.closeTitle")}>
          ✕
        </button>
      </div>

      {/* ── Paired Browsers ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.pairedBrowsers")}</span>
        <div class="preferences__field">
          <span class="preferences__hint">{translate("preferences.pairedBrowsersHint")}</span>
          {pairedOrigins.length > 0 ? (
            <div class="preferences__server-list">
              {pairedOrigins.map((origin) => (
                <div key={origin} class="preferences__server-item">
                  <span class="preferences__server-url">{origin}</span>
                  <button
                    type="button"
                    class="preferences__server-remove-btn"
                    onClick={() => setPendingUnpairOrigin(origin)}
                    title={translate("preferences.unpairTitle")}
                    disabled={unpairingOrigin === origin}
                  >
                    {unpairingOrigin === origin ? translate("preferences.confirmUnpair.unpairing") : translate("preferences.unpairButton")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span class="preferences__server-empty">{translate("preferences.pairedBrowsersEmpty")}</span>
          )}
        </div>
      </div>

      <hr class="preferences__divider" />

      <DirectoryPolicyPreferences />
      <hr class="preferences__divider" />

      {/* ── Localization Sync ── */}
      <div class="preferences__section">
        <div class="preferences__section-heading">
          <span class="preferences__section-title">{translate("preferences.sections.localization")}</span>
          <span class="preferences__status-badge">{translate("preferences.localizationStatus.syncedBadge")}</span>
        </div>
        <div class="preferences__field">
          <span class="preferences__hint">{translate("preferences.localizationStatusHint")}</span>
          {syncedLocalization ? (
            <dl class="preferences__status-grid">
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.localizationStatus.languageLabel")}</dt>
                <dd class="preferences__status-value">{syncedLocalization.language}</dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.localizationStatus.regionalLocaleLabel")}</dt>
                <dd class="preferences__status-value">{syncedLocalization.regional_locale}</dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.localizationStatus.updatedAtLabel")}</dt>
                <dd class="preferences__status-value">{localizedUpdatedAt ?? syncedLocalization.updated_at}</dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.localizationStatus.sourceOriginLabel")}</dt>
                <dd class="preferences__status-value preferences__status-value--code">{syncedLocalization.source_origin}</dd>
              </div>
            </dl>
          ) : (
            <span class="preferences__server-empty">{translate("preferences.localizationStatus.empty")}</span>
          )}
        </div>
      </div>

      <hr class="preferences__divider" />

      {/* ── Editing Behavior ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.editingBehavior")}</span>

        {/* Upload conflict action */}
        <div class="preferences__field">
          <label class="preferences__label" htmlFor="conflict-action">
            {translate("preferences.conflictResolutionLabel")}
          </label>
          <select id="conflict-action" class="preferences__select" value={prefs.uploadConflictAction} onChange={handleConflictActionChange}>
            {(Object.entries(conflictActionLabels) as [UploadConflictAction, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span class="preferences__hint">{translate("preferences.conflictResolutionHint")}</span>
        </div>
      </div>

      <hr class="preferences__divider" />

      {/* ── Startup ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.startup")}</span>
        <label class="preferences__checkbox-row">
          <input type="checkbox" checked={prefs.autoStartOnLogin} onChange={handleAutostartChange} disabled={changingAutostart} />
          <span class="preferences__label">{translate("preferences.startupLabel")}</span>
        </label>
        <span class="preferences__hint">{translate("preferences.startupHint")}</span>
      </div>

      <hr class="preferences__divider" />

      {/* ── Notifications ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.updates")}</span>
        <div class="preferences__field">
          <label class="preferences__label" htmlFor="update-channel">
            {translate("preferences.updateChannelLabel")}
          </label>
          <select id="update-channel" class="preferences__select" value={prefs.companionUpdateChannel} onChange={handleUpdateChannelChange}>
            {(Object.entries(updateChannelLabels) as [CompanionUpdateChannel, string][]).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span class="preferences__hint">{translate("preferences.updateChannelHint")}</span>
          {prefs.companionUpdateChannel !== "stable" && (
            <span class="preferences__hint">
              {translate("preferences.preReleaseWarning", { channel: updateChannelLabels[prefs.companionUpdateChannel] })}
            </span>
          )}
          <div class="preferences__update-actions">
            <button
              type="button"
              class="preferences__action-btn preferences__action-btn--secondary"
              onClick={() => {
                void handleCheckForUpdates();
              }}
              disabled={isUpdateBusy}
            >
              {translate(
                updateActionState.kind === "checking" ? "preferences.updateActions.checking" : "preferences.updateActions.checkNow"
              )}
            </button>
            {showInstallButton && (
              <button
                type="button"
                class="preferences__action-btn preferences__action-btn--primary"
                onClick={() => {
                  void handleInstallUpdate();
                }}
                disabled={updateActionState.kind !== "available"}
              >
                {translate(
                  updateActionState.kind === "installing" ? "preferences.updateActions.installing" : "preferences.updateActions.install"
                )}
              </button>
            )}
          </div>
          {localizedLastCheckedAt && (
            <span class="preferences__hint">{translate("preferences.updateStatus.lastChecked", { time: localizedLastCheckedAt })}</span>
          )}
          {updateActionState.kind === "up-to-date" && (
            <dl class="preferences__status-grid preferences__status-grid--updates" aria-live="polite">
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.statusLabel")}</dt>
                <dd class="preferences__status-value">
                  {translate("preferences.updateStatus.upToDate", {
                    channel: updateChannelLabels[updateActionState.checkedChannel],
                  })}
                </dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.currentVersionLabel")}</dt>
                <dd class="preferences__status-value">{updateActionState.currentVersion}</dd>
              </div>
            </dl>
          )}
          {(updateActionState.kind === "available" || updateActionState.kind === "installing") && (
            <dl class="preferences__status-grid preferences__status-grid--updates" aria-live="polite">
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.statusLabel")}</dt>
                <dd class="preferences__status-value">
                  {translate(
                    updateActionState.kind === "installing"
                      ? "preferences.updateStatus.installing"
                      : "preferences.updateStatus.updateAvailable",
                    {
                      channel: updateChannelLabels[updateActionState.checkedChannel],
                      version: updateActionState.status.version ?? translate("preferences.updateStatus.unknownVersion"),
                    }
                  )}
                </dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.currentVersionLabel")}</dt>
                <dd class="preferences__status-value">{updateActionState.status.currentVersion}</dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.latestVersionLabel")}</dt>
                <dd class="preferences__status-value">
                  {updateActionState.status.version ?? translate("preferences.updateStatus.unknownVersion")}
                </dd>
              </div>
              {updateActionState.status.publishedAt && (
                <div class="preferences__status-row">
                  <dt class="preferences__status-label">{translate("preferences.updateStatus.publishedAtLabel")}</dt>
                  <dd class="preferences__status-value">{localizedUpdatePublishedAt ?? updateActionState.status.publishedAt}</dd>
                </div>
              )}
            </dl>
          )}
          {updateActionState.kind === "installed" && (
            <dl class="preferences__status-grid preferences__status-grid--updates" aria-live="polite">
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.statusLabel")}</dt>
                <dd class="preferences__status-value">
                  {translate("preferences.updateStatus.installed", {
                    version: updateActionState.version ?? translate("preferences.updateStatus.unknownVersion"),
                  })}
                </dd>
              </div>
            </dl>
          )}
          {updateActionState.kind === "error" && (
            <dl class="preferences__status-grid preferences__status-grid--updates" aria-live="polite">
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.statusLabel")}</dt>
                <dd class="preferences__status-value">
                  {translate("preferences.updateStatus.checkFailed", {
                    channel: updateChannelLabels[updateActionState.checkedChannel],
                  })}
                </dd>
              </div>
              <div class="preferences__status-row">
                <dt class="preferences__status-label">{translate("preferences.updateStatus.errorLabel")}</dt>
                <dd class="preferences__status-value preferences__status-value--multiline">{updateActionState.message}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>

      <hr class="preferences__divider" />

      {/* ── Notifications ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.notifications")}</span>
        <label class="preferences__checkbox-row">
          <input type="checkbox" checked={prefs.showNotifications} onChange={handleNotificationsChange} />
          <span class="preferences__label">{translate("preferences.notificationsLabel")}</span>
        </label>
        <span class="preferences__hint">{translate("preferences.notificationsHint")}</span>
      </div>

      <hr class="preferences__divider" />

      {/* ── Cleanup ── */}
      <div class="preferences__section">
        <span class="preferences__section-title">{translate("preferences.sections.tempFileCleanup")}</span>
        <div class="preferences__field">
          <label class="preferences__label" htmlFor="retention-days">
            {translate("preferences.retentionLabel")}
          </label>
          <input
            id="retention-days"
            type="number"
            class="preferences__number-input"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            value={prefs.tempFileRetentionDays}
            onChange={handleRetentionChange}
          />
          <span class="preferences__hint">{translate("preferences.retentionHint")}</span>
        </div>
      </div>

      {/* ── Save indicator ── */}
      <div class="preferences__footer">
        {showSaved && <span class="preferences__saved-indicator">{translate("preferences.savedIndicator")}</span>}
      </div>

      {pendingUnpairOrigin && (
        <ModalDialog
          role="alertdialog"
          titleId="unpair-dialog-title"
          onRequestClose={handleCancelUnpair}
          initialFocusRef={cancelUnpairButtonRef}
          panelClassName="preferences__confirm-panel"
        >
          <h3 id="unpair-dialog-title" class="preferences__confirm-title">
            {translate("preferences.confirmUnpair.title")}
          </h3>
          <p class="preferences__confirm-body">
            <strong>{translate("preferences.confirmUnpair.body", { origin: pendingUnpairOrigin })}</strong>
          </p>
          <div class="preferences__confirm-actions">
            <button
              type="button"
              class="preferences__confirm-btn preferences__confirm-btn--ghost"
              ref={cancelUnpairButtonRef}
              onClick={handleCancelUnpair}
              disabled={Boolean(unpairingOrigin)}
            >
              {translate("common.actions.cancel")}
            </button>
            <button
              type="button"
              class="preferences__confirm-btn preferences__confirm-btn--danger"
              onClick={handleConfirmUnpair}
              disabled={Boolean(unpairingOrigin)}
            >
              {unpairingOrigin ? translate("preferences.confirmUnpair.unpairing") : translate("preferences.unpairButton")}
            </button>
          </div>
        </ModalDialog>
      )}

      {pendingUpdateChannel && (
        <ModalDialog
          role="alertdialog"
          titleId="update-channel-dialog-title"
          onRequestClose={handleCancelUpdateChannel}
          initialFocusRef={cancelUpdateChannelButtonRef}
          panelClassName="preferences__confirm-panel"
        >
          <h3 id="update-channel-dialog-title" class="preferences__confirm-title">
            {translate("preferences.confirmUpdateChannel.title")}
          </h3>
          <p class="preferences__confirm-body">
            <strong>
              {translate("preferences.confirmUpdateChannel.body", {
                channel: updateChannelLabels[pendingUpdateChannel],
              })}
            </strong>
          </p>
          <div class="preferences__confirm-actions">
            <button
              type="button"
              class="preferences__confirm-btn preferences__confirm-btn--ghost"
              ref={cancelUpdateChannelButtonRef}
              onClick={handleCancelUpdateChannel}
            >
              {translate("common.actions.cancel")}
            </button>
            <button
              type="button"
              class="preferences__confirm-btn"
              onClick={() => {
                void handleConfirmUpdateChannel();
              }}
            >
              {translate("preferences.confirmUpdateChannel.confirm")}
            </button>
          </div>
        </ModalDialog>
      )}
    </div>
  );
}
