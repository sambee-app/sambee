export const SETTINGS_CATEGORY_ORDER = [
  "appearance",
  "account",
  "file-browser",
  "text-editor",
  "image-viewer",
  "connections",
  "local-drives",
  "admin-network",
  "admin-authentication",
  "admin-users",
  "admin-smb",
  "admin-file-search",
  "admin-directory-search",
  "admin-system",
  "admin-image-viewer",
  "admin-pdf-viewer",
  "admin-about",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORY_ORDER)[number];
