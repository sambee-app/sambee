import { logger } from "../../services/logger";
import type { SettingsNavItem } from "./settingsNavigation";

export const SETTINGS_PAGE_LOADERS = {
  appearance: () => import("../../pages/PreferencesSettings").then((module) => ({ default: module.AppearanceSettings })),
  account: () => import("../../pages/AccountSettings").then((module) => ({ default: module.AccountSettings })),
  "file-browser": () => import("../../pages/FileBrowserSettings").then((module) => ({ default: module.FileBrowserSettings })),
  "text-editor": () => import("../../pages/TextEditorSettings").then((module) => ({ default: module.TextEditorSettings })),
  connections: () => import("../../pages/ConnectionsSettings").then((module) => ({ default: module.ConnectionsSettings })),
  "local-drives": () => import("../../pages/LocalDrivesSettings").then((module) => ({ default: module.LocalDrivesSettings })),
  "admin-network": () => import("../../pages/NetworkSettings").then((module) => ({ default: module.NetworkSettings })),
  "admin-authentication": () => import("../../pages/AuthenticationSettings").then((module) => ({ default: module.AuthenticationSettings })),
  "admin-users": () => import("../../pages/UserManagementSettings").then((module) => ({ default: module.UserManagementSettings })),
  "admin-smb": () => import("../../pages/SmbSettings").then((module) => ({ default: module.SmbSettings })),
  "admin-file-search": () => import("../../pages/FileSearchSettings").then((module) => ({ default: module.FileSearchSettings })),
  "admin-system": () => import("../../pages/AdvancedSettings").then((module) => ({ default: module.AdvancedSettings })),
  "admin-about": () => import("../../pages/AboutSettings").then((module) => ({ default: module.AboutSettings })),
};

const prefetchedPages = new Set<SettingsNavItem>();
const SETTINGS_PREFETCH_IDLE_TIMEOUT_MS = 2_000;

export function scheduleSettingsPagePrefetch(items: readonly SettingsNavItem[]): () => void {
  const prefetch = () => {
    void prefetchSettingsPages(items);
  };
  if (typeof window.requestIdleCallback === "function") {
    const callback = window.requestIdleCallback(prefetch, { timeout: SETTINGS_PREFETCH_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(callback);
  }
  const timeout = window.setTimeout(prefetch, 0);
  return () => window.clearTimeout(timeout);
}

export async function prefetchSettingsPages(items: readonly SettingsNavItem[]): Promise<void> {
  await Promise.all(
    items.map(async (item) => {
      if (prefetchedPages.has(item)) return;
      prefetchedPages.add(item);
      try {
        await SETTINGS_PAGE_LOADERS[item]();
      } catch (error) {
        prefetchedPages.delete(item);
        logger.warn("Failed to prefetch settings page; opening the category will retry loading it", { category: item, error }, "settings");
      }
    })
  );
}
