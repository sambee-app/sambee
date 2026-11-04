export const COMPANION_SETTINGS_CHANGED_EVENT = "sambee:companion-settings-changed";

export function notifyCompanionSettingsChanged(switchUser = false): void {
  window.dispatchEvent(new CustomEvent(COMPANION_SETTINGS_CHANGED_EVENT, { detail: { switchUser } }));
}
