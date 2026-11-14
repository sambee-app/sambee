export const HEALTH_MONITORING_SETTINGS_CHANGED_EVENT = "sambee:health-monitoring-settings-changed";

export function publishHealthMonitoringSettingsChanged(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(HEALTH_MONITORING_SETTINGS_CHANGED_EVENT));
}

export function subscribeHealthMonitoringSettingsChanged(listener: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(HEALTH_MONITORING_SETTINGS_CHANGED_EVENT, listener);
  return () => window.removeEventListener(HEALTH_MONITORING_SETTINGS_CHANGED_EVENT, listener);
}
