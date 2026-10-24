import { useEffect, useSyncExternalStore } from "react";
import type { CurrentUserSettings, CurrentUserSettingsUpdate } from "../types";
import api from "./api";
import { isAuthRequired } from "./authConfig";
import { authSession } from "./authSession";
import { SETTING_SUCCESS_DISPLAY_MS } from "./settingSaveFeedback";

export { SETTING_SUCCESS_DISPLAY_MS } from "./settingSaveFeedback";

export type CurrentUserSettingsField = CurrentUserSettingsUpdate["field"];

type CurrentUserSettingValues = {
  [Field in CurrentUserSettingsField]: Extract<CurrentUserSettingsUpdate, { field: Field }>["value"];
};
type ValueForField<Field extends CurrentUserSettingsField> = CurrentUserSettingValues[Field];
type CurrentUserSettingValue = CurrentUserSettingsUpdate["value"];

export interface CurrentUserSetting<Field extends CurrentUserSettingsField> {
  confirmedValue: ValueForField<Field> | undefined;
  pending: boolean;
  saved: boolean;
  error: string | null;
  commit: (value: ValueForField<Field>) => Promise<void>;
  clearError: () => void;
}

const CHANNEL_NAME = "sambee-user-settings";
const INVALIDATE_MESSAGE = "invalidate";
export const CURRENT_USER_SETTING_PERSIST_TIMEOUT_MS = 15_000;
const CURRENT_USER_SETTING_PERSIST_TIMEOUT_MESSAGE = "Saving this setting timed out. Check the connection and try again.";

class CurrentUserSettingPersistTimeoutError extends Error {
  constructor() {
    super(CURRENT_USER_SETTING_PERSIST_TIMEOUT_MESSAGE);
    this.name = "CurrentUserSettingPersistTimeoutError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function areCurrentUserSettingValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => areCurrentUserSettingValuesEqual(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && areCurrentUserSettingValuesEqual(left[key], right[key]))
  );
}

function getFieldValue<Field extends CurrentUserSettingsField>(
  settings: CurrentUserSettings | null,
  field: Field
): ValueForField<Field> | undefined {
  if (!settings) {
    return undefined;
  }
  switch (field) {
    case "appearance.theme_id":
      return settings.appearance.theme_id as ValueForField<Field>;
    case "localization.language":
      return settings.localization.language as ValueForField<Field>;
    case "localization.regional_locale":
      return settings.localization.regional_locale as ValueForField<Field>;
    case "browser.quick_nav_include_dot_directories":
      return settings.browser.quick_nav_include_dot_directories as ValueForField<Field>;
    case "browser.quick_bar_shortcut_hint_visibility":
      return settings.browser.quick_bar_shortcut_hint_visibility as ValueForField<Field>;
    case "browser.touch_friendly_file_selection":
      return settings.browser.touch_friendly_file_selection as ValueForField<Field>;
    case "browser.file_browser_view_mode":
      return settings.browser.file_browser_view_mode as ValueForField<Field>;
    case "browser.pane_mode":
      return settings.browser.pane_mode as ValueForField<Field>;
    case "browser.selected_connection_id":
      return settings.browser.selected_connection_id as ValueForField<Field>;
    case "browser.viewer_associations":
      return settings.browser.viewer_associations as ValueForField<Field>;
    case "text_editor.max_file_size_bytes":
      return settings.text_editor.max_file_size_bytes as ValueForField<Field>;
    case "text_editor.word_wrap_enabled":
      return settings.text_editor.word_wrap_enabled as ValueForField<Field>;
  }
}

function setFieldValue(settings: CurrentUserSettings, update: CurrentUserSettingsUpdate): CurrentUserSettings {
  switch (update.field) {
    case "appearance.theme_id":
      return { ...settings, appearance: { ...settings.appearance, theme_id: update.value, has_theme_override: true } };
    case "localization.language":
      return { ...settings, localization: { ...settings.localization, language: update.value } };
    case "localization.regional_locale":
      return { ...settings, localization: { ...settings.localization, regional_locale: update.value } };
    case "browser.quick_nav_include_dot_directories":
      return { ...settings, browser: { ...settings.browser, quick_nav_include_dot_directories: update.value } };
    case "browser.quick_bar_shortcut_hint_visibility":
      return { ...settings, browser: { ...settings.browser, quick_bar_shortcut_hint_visibility: update.value } };
    case "browser.touch_friendly_file_selection":
      return { ...settings, browser: { ...settings.browser, touch_friendly_file_selection: update.value } };
    case "browser.file_browser_view_mode":
      return { ...settings, browser: { ...settings.browser, file_browser_view_mode: update.value } };
    case "browser.pane_mode":
      return { ...settings, browser: { ...settings.browser, pane_mode: update.value } };
    case "browser.selected_connection_id":
      return { ...settings, browser: { ...settings.browser, selected_connection_id: update.value } };
    case "browser.viewer_associations":
      return { ...settings, browser: { ...settings.browser, viewer_associations: update.value } };
    case "text_editor.max_file_size_bytes":
      return { ...settings, text_editor: { ...settings.text_editor, max_file_size_bytes: update.value } };
    case "text_editor.word_wrap_enabled":
      return { ...settings, text_editor: { ...settings.text_editor, word_wrap_enabled: update.value } };
  }
}

class UserSettingsStore {
  private snapshot: CurrentUserSettings | null = null;
  private snapshotVersion = 0;
  // This tracks all observable state changes; snapshotVersion only guards stale refreshes.
  private stateVersion = 0;
  private refreshPromise: Promise<void> | null = null;
  private queuedRefresh = false;
  private pendingFields = new Set<CurrentUserSettingsField>();
  private savedFields = new Set<CurrentUserSettingsField>();
  private committedUpdates = new Map<CurrentUserSettingsField, CurrentUserSettingsUpdate>();
  private errors = new Map<CurrentUserSettingsField, string>();
  private requestTokens = new Map<CurrentUserSettingsField, symbol>();
  private abortControllers = new Map<CurrentUserSettingsField, AbortController>();
  private successTimers = new Map<CurrentUserSettingsField, ReturnType<typeof setTimeout>>();
  private savedTokens = new Map<CurrentUserSettingsField, symbol>();
  private listeners = new Set<() => void>();
  private readonly channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);

  constructor() {
    this.channel?.addEventListener("message", (event: MessageEvent<{ type?: unknown }>) => {
      if (event.data?.type === INVALIDATE_MESSAGE) {
        void this.refresh().catch(() => undefined);
      }
    });
    authSession.subscribeToIdentity(() => this.clearForIdentityChange());
    window.addEventListener("focus", () => void this.refresh().catch(() => undefined));
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.refresh().catch(() => undefined);
      }
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.stateVersion;

  getValue<Field extends CurrentUserSettingsField>(field: Field): CurrentUserSetting<Field> {
    const committedUpdate = this.committedUpdates.get(field);
    return {
      confirmedValue: this.snapshot ? getFieldValue(this.snapshot, field) : (committedUpdate?.value as ValueForField<Field> | undefined),
      pending: this.pendingFields.has(field),
      saved: this.savedFields.has(field),
      error: this.errors.get(field) ?? null,
      commit: async (value) => this.commit({ field, value } as Extract<CurrentUserSettingsUpdate, { field: Field }>),
      clearError: () => this.clearError(field),
    };
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshPromise) {
      if (force) this.queuedRefresh = true;
      return this.refreshPromise;
    }
    const identity = authSession.getIdentity();
    const requestVersion = this.snapshotVersion;
    this.refreshPromise = this.canAccessCurrentUserSettings()
      .then((canAccess) => (canAccess ? api.getCurrentUserSettings() : null))
      .then((settings) => {
        if (!settings) {
          if (identity.epoch !== authSession.getIdentity().epoch) this.queuedRefresh = true;
          return;
        }
        if (identity.epoch !== authSession.getIdentity().epoch || requestVersion !== this.snapshotVersion) {
          this.queuedRefresh = true;
          return;
        }
        this.snapshot = settings;
        this.committedUpdates.clear();
        this.snapshotVersion += 1;
        this.notify();
      })
      .finally(() => {
        this.refreshPromise = null;
        if (this.queuedRefresh) {
          this.queuedRefresh = false;
          void this.refresh().catch(() => undefined);
        }
      });
    return this.refreshPromise;
  }

  async commit(update: CurrentUserSettingsUpdate): Promise<void> {
    if (this.pendingFields.has(update.field)) {
      throw new Error("A write for this setting is already in progress.");
    }
    if (!(await this.canAccessCurrentUserSettings())) {
      throw new Error("Current-user settings require an authenticated user.");
    }
    if (this.pendingFields.has(update.field)) {
      throw new Error("A write for this setting is already in progress.");
    }
    const selectingInheritedTheme = update.field === "appearance.theme_id" && this.snapshot?.appearance.has_theme_override === false;
    if (
      this.hasConfirmedValue(update.field) &&
      areCurrentUserSettingValuesEqual(update.value, this.getConfirmedValue(update.field)) &&
      !selectingInheritedTheme
    ) {
      return;
    }
    const identity = authSession.getIdentity();
    const requestVersion = ++this.snapshotVersion;
    const token = Symbol(update.field);
    const controller = new AbortController();
    this.requestTokens.set(update.field, token);
    this.abortControllers.set(update.field, controller);
    this.pendingFields.add(update.field);
    this.clearSaved(update.field);
    this.errors.delete(update.field);
    this.notify();

    let rejectTimeout: (reason: CurrentUserSettingPersistTimeoutError) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      rejectTimeout(new CurrentUserSettingPersistTimeoutError());
      controller.abort();
    }, CURRENT_USER_SETTING_PERSIST_TIMEOUT_MS);

    try {
      const result = await Promise.race([api.updateCurrentUserSettings(update, { signal: controller.signal }), timeoutPromise]);
      if (!this.ownsRequest(update.field, token, identity.epoch)) {
        return;
      }
      if (result.field !== update.field) {
        throw new Error("The server returned a different setting field.");
      }
      if (this.snapshot) {
        this.snapshot = setFieldValue(this.snapshot, result);
      } else {
        this.committedUpdates.set(result.field, result);
      }
      this.snapshotVersion += 1;
      this.errors.delete(update.field);
      this.setSaved(update.field);
      this.notify();
      this.channel?.postMessage({ type: INVALIDATE_MESSAGE });
    } catch (error) {
      if (!this.ownsRequest(update.field, token, identity.epoch)) {
        return;
      }
      this.errors.set(
        update.field,
        error instanceof CurrentUserSettingPersistTimeoutError
          ? CURRENT_USER_SETTING_PERSIST_TIMEOUT_MESSAGE
          : error instanceof Error
            ? error.message
            : "Unable to save this setting."
      );
      this.notify();
      if (requestVersion === this.snapshotVersion) {
        void this.refresh(true).catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.ownsRequest(update.field, token, identity.epoch)) {
        this.pendingFields.delete(update.field);
        this.abortControllers.delete(update.field);
        this.requestTokens.delete(update.field);
        this.notify();
      }
    }
  }

  clearError(field: CurrentUserSettingsField): void {
    const hadError = this.errors.delete(field);
    const wasSaved = this.savedFields.has(field);
    this.clearSaved(field);
    if (hadError || wasSaved) this.notify();
  }

  resetForTests(): void {
    this.snapshot = null;
    this.snapshotVersion += 1;
    this.refreshPromise = null;
    this.queuedRefresh = false;
    this.clearActiveFieldState();
    this.committedUpdates.clear();
    this.errors.clear();
    this.notify();
  }

  private clearForIdentityChange(): void {
    this.snapshot = null;
    this.clearActiveFieldState();
    this.committedUpdates.clear();
    this.errors.clear();
    this.snapshotVersion += 1;
    this.queuedRefresh = false;
    this.notify();
    void this.refresh(authSession.getAccessToken() !== null).catch(() => undefined);
  }

  private async canAccessCurrentUserSettings(): Promise<boolean> {
    if (authSession.hasUsableAccessToken()) return true;
    try {
      return !(await isAuthRequired());
    } catch {
      return false;
    }
  }

  private notify(): void {
    this.stateVersion += 1;
    for (const listener of this.listeners) listener();
  }

  private hasConfirmedValue(field: CurrentUserSettingsField): boolean {
    return this.snapshot !== null || this.committedUpdates.has(field);
  }

  private getConfirmedValue(field: CurrentUserSettingsField): CurrentUserSettingValue | undefined {
    return this.snapshot ? getFieldValue(this.snapshot, field) : this.committedUpdates.get(field)?.value;
  }

  private ownsRequest(field: CurrentUserSettingsField, token: symbol, identityEpoch: number): boolean {
    return identityEpoch === authSession.getIdentity().epoch && this.requestTokens.get(field) === token;
  }

  private setSaved(field: CurrentUserSettingsField): void {
    this.clearSaved(field);
    const token = Symbol(field);
    this.savedTokens.set(field, token);
    this.savedFields.add(field);
    this.successTimers.set(
      field,
      setTimeout(() => {
        if (this.savedTokens.get(field) !== token) return;
        this.savedTokens.delete(field);
        this.successTimers.delete(field);
        this.savedFields.delete(field);
        this.notify();
      }, SETTING_SUCCESS_DISPLAY_MS)
    );
  }

  private clearSaved(field: CurrentUserSettingsField): void {
    const timer = this.successTimers.get(field);
    if (timer) clearTimeout(timer);
    this.successTimers.delete(field);
    this.savedTokens.delete(field);
    this.savedFields.delete(field);
  }

  private clearActiveFieldState(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    for (const timer of this.successTimers.values()) clearTimeout(timer);
    this.pendingFields.clear();
    this.savedFields.clear();
    this.requestTokens.clear();
    this.abortControllers.clear();
    this.successTimers.clear();
    this.savedTokens.clear();
  }
}

export const userSettingsStore = new UserSettingsStore();

export function getConfirmedCurrentUserSetting<Field extends CurrentUserSettingsField>(field: Field): ValueForField<Field> | undefined {
  return userSettingsStore.getValue(field).confirmedValue;
}

export function commitCurrentUserSetting(update: CurrentUserSettingsUpdate): Promise<void> {
  return userSettingsStore.commit(update);
}

export function resetCurrentUserSettingsStoreForTests(): void {
  userSettingsStore.resetForTests();
}

export function useCurrentUserSetting<Field extends CurrentUserSettingsField>(field: Field): CurrentUserSetting<Field> {
  useSyncExternalStore(userSettingsStore.subscribe, userSettingsStore.getSnapshot, userSettingsStore.getSnapshot);
  useEffect(() => {
    void userSettingsStore.refresh().catch(() => undefined);
  }, []);
  return userSettingsStore.getValue(field);
}

export function refreshCurrentUserSettings(): Promise<void> {
  return userSettingsStore.refresh();
}
