export const SETTINGS_CATEGORY_ORDER = [
  "appearance",
  "account",
  "file-browser",
  "text-editor",
  "connections",
  "local-drives",
  "admin-network",
  "admin-authentication",
  "admin-users",
  "admin-smb",
  "admin-file-search",
  "admin-system",
  "admin-about",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_ORDER)[number];
