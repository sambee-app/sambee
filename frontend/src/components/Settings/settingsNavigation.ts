import { translate } from "../../i18n";
import { SETTINGS_CATEGORY_ORDER, type SettingsCategory } from "./settingsCategories";

export { SETTINGS_CATEGORY_ORDER, type SettingsCategory } from "./settingsCategories";
export type SettingsNavItem = SettingsCategory;
export type SettingsContentItem = SettingsNavItem;

export type SettingsSection = "personal" | "administration";

export type MobileSettingsView = "main" | SettingsNavItem;

export interface VisibleSettingsSection {
  section: SettingsSection;
  label: string;
  categories: SettingsCategory[];
}

interface SettingsCategoryMeta {
  label: string;
  descriptionKey: string;
  route: string;
  section: SettingsSection;
  adminOnly?: boolean;
}

export const SETTINGS_ROUTE_BY_CATEGORY: Record<SettingsCategory, string> = {
  appearance: "/settings/appearance",
  account: "/settings/account",
  "file-browser": "/settings/file-browser",
  "text-editor": "/settings/text-editor",
  connections: "/settings/connections",
  "local-drives": "/settings/connections/local-drives",
  "admin-network": "/settings/admin/network",
  "admin-authentication": "/settings/admin/authentication",
  "admin-users": "/settings/admin/users",
  "admin-smb": "/settings/admin/smb",
  "admin-file-search": "/settings/admin/file-search",
  "admin-system": "/settings/admin/system",
  "admin-about": "/settings/admin/about",
};

export const SETTINGS_ROUTE_BY_NAV_ITEM: Record<SettingsNavItem, string> = SETTINGS_ROUTE_BY_CATEGORY;

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  get personal() {
    return translate("settings.sections.personal");
  },
  get administration() {
    return translate("settings.sections.administration");
  },
};

export const SETTINGS_CATEGORY_META: Record<SettingsCategory, SettingsCategoryMeta> = {
  appearance: {
    get label() {
      return translate("settings.categories.appearance.label");
    },
    descriptionKey: "settings.categories.appearance.description",
    route: SETTINGS_ROUTE_BY_CATEGORY.appearance,
    section: "personal",
  },
  account: {
    get label() {
      return translate("settings.categories.account.label");
    },
    descriptionKey: "settings.categories.account.description",
    route: SETTINGS_ROUTE_BY_CATEGORY.account,
    section: "personal",
  },
  "file-browser": {
    get label() {
      return translate("settings.categories.fileBrowser.label");
    },
    descriptionKey: "settings.categories.fileBrowser.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["file-browser"],
    section: "personal",
  },
  "text-editor": {
    get label() {
      return translate("settings.categories.textEditor.label");
    },
    descriptionKey: "settings.categories.textEditor.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["text-editor"],
    section: "personal",
  },
  connections: {
    get label() {
      return translate("settings.categories.connections.label");
    },
    descriptionKey: "settings.categories.connections.description",
    route: SETTINGS_ROUTE_BY_CATEGORY.connections,
    section: "personal",
  },
  "local-drives": {
    get label() {
      return translate("settings.connectionsSubgroups.localDrives.label");
    },
    descriptionKey: "settings.connectionsSubgroups.localDrives.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["local-drives"],
    section: "personal",
  },
  "admin-network": {
    get label() {
      return translate("settings.categories.adminNetwork.label");
    },
    descriptionKey: "settings.categories.adminNetwork.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-network"],
    section: "administration",
    adminOnly: true,
  },
  "admin-users": {
    get label() {
      return translate("settings.categories.adminUsers.label");
    },
    descriptionKey: "settings.categories.adminUsers.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-users"],
    section: "administration",
    adminOnly: true,
  },
  "admin-authentication": {
    get label() {
      return translate("settings.categories.adminAuthentication.label");
    },
    descriptionKey: "settings.categories.adminAuthentication.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-authentication"],
    section: "administration",
    adminOnly: true,
  },
  "admin-smb": {
    get label() {
      return translate("settings.categories.adminSmb.label");
    },
    descriptionKey: "settings.categories.adminSmb.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-smb"],
    section: "administration",
    adminOnly: true,
  },
  "admin-file-search": {
    get label() {
      return translate("settings.categories.adminFileSearch.label");
    },
    descriptionKey: "settings.categories.adminFileSearch.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-file-search"],
    section: "administration",
    adminOnly: true,
  },
  "admin-system": {
    get label() {
      return translate("settings.categories.adminSystem.label");
    },
    descriptionKey: "settings.categories.adminSystem.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-system"],
    section: "administration",
    adminOnly: true,
  },
  "admin-about": {
    get label() {
      return translate("settings.categories.adminAbout.label");
    },
    descriptionKey: "settings.categories.adminAbout.description",
    route: SETTINGS_ROUTE_BY_CATEGORY["admin-about"],
    section: "administration",
    adminOnly: true,
  },
};

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = SETTINGS_CATEGORY_ORDER[0]!;

export function getSettingsCategoryLabel(category: SettingsCategory): string {
  return SETTINGS_CATEGORY_META[category].label;
}

export function getSettingsNavItemLabel(item: SettingsNavItem): string {
  return SETTINGS_CATEGORY_META[item].label;
}

export function getSettingsViewTitle(view: MobileSettingsView): string {
  return view === "main" ? translate("settings.shell.title") : getSettingsNavItemLabel(view);
}

export function getSettingsCategoryDescriptionKey(category: SettingsCategory): string {
  return SETTINGS_CATEGORY_META[category].descriptionKey;
}

export function getSettingsContentItem(item: SettingsNavItem): SettingsContentItem {
  return item;
}

export function getSettingsParentCategory(item: SettingsNavItem): SettingsCategory | null {
  return item;
}

export function getVisibleSettingsCategories(isAdmin: boolean): SettingsCategory[] {
  return SETTINGS_CATEGORY_ORDER.filter((category) => {
    const meta = SETTINGS_CATEGORY_META[category];
    return !meta.adminOnly || isAdmin;
  });
}

export function getVisibleSettingsSections(isAdmin: boolean): VisibleSettingsSection[] {
  return (["personal", "administration"] as SettingsSection[])
    .map((section) => ({
      section,
      label: SETTINGS_SECTION_LABELS[section],
      categories: getVisibleSettingsCategories(isAdmin).filter((category) => SETTINGS_CATEGORY_META[category].section === section),
    }))
    .filter((entry) => entry.categories.length > 0);
}

export function getVisibleSettingsNavItems(isAdmin: boolean): SettingsNavItem[] {
  return getVisibleSettingsSections(isAdmin).flatMap((section) => section.categories);
}

export function getSettingsNavItemByPath(pathname: string): SettingsNavItem | null {
  const categoryEntry = [...(Object.entries(SETTINGS_CATEGORY_META) as Array<[SettingsCategory, SettingsCategoryMeta]>)]
    .sort(([, leftMeta], [, rightMeta]) => rightMeta.route.length - leftMeta.route.length)
    .find(([, meta]) => pathname === meta.route || pathname.startsWith(`${meta.route}/`));

  return categoryEntry?.[0] ?? null;
}

export function getSettingsMobileBackTarget(pathname: string): string | null {
  const item = getSettingsNavItemByPath(pathname);

  if (!item) {
    return null;
  }

  if (item === "local-drives") {
    return SETTINGS_ROUTE_BY_CATEGORY.connections;
  }

  return null;
}

export function getSettingsCategoryByPath(pathname: string): SettingsCategory | null {
  const item = getSettingsNavItemByPath(pathname);

  if (!item) {
    return null;
  }

  return item;
}
