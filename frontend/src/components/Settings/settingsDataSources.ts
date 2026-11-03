import { primeCachedAsyncData } from "../../hooks/useCachedAsyncData";
import api from "../../services/api";
import companionService, {
  type CompanionAuthProtocolStatus,
  getCompanionAuthProtocolStatus,
  hasStoredSecret,
  isCompanionAuthSignatureMismatch,
  type PairStatusResponse,
} from "../../services/companion";
import { canSignCompanionRequests } from "../../services/companionSession";
import { logger } from "../../services/logger";
import type {
  AboutSettings,
  AdminUser,
  AdminUserListQuery,
  AdminUserListResponse,
  AdvancedSystemSettings,
  CompanionDownloadMetadata,
  Connection,
  NetworkSettings,
  OidcAdminConfigurationRead,
  SmbSettings,
} from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { LOCAL_DRIVES_PAGE_COPY } from "./localDrivesCopy";
import type { SettingsNavItem } from "./settingsNavigation";

export const SETTINGS_DATA_CACHE_KEYS = {
  connections: "settings-data/connections",
  localDrives: "settings-data/local-drives",
  adminUsers: "settings-data/admin-users",
  adminUserContext: "settings-data/admin-user-context",
  adminSystem: "settings-data/admin-system",
  directoryIndexBackend: "settings-data/directory-index/backend",
  directoryIndexCompanion: "settings-data/directory-index/companion",
  adminSmb: "settings-data/admin-smb",
  adminNetwork: "settings-data/admin-network",
  adminAuthentication: "settings-data/admin-authentication",
  adminAbout: "settings-data/admin-about",
} as const;

export interface LocalDrivesSettingsData {
  companionAvailable: boolean;
  currentPairStatus: PairStatusResponse | null;
  authProtocolStatus: CompanionAuthProtocolStatus | null;
  pairingVerified: boolean | null;
  downloadMetadata: CompanionDownloadMetadata | null;
  downloadError: string | null;
}

export interface UserManagementSettingsData {
  users: AdminUser[];
  directory: AdminUserListResponse;
  currentUserId: string | null;
  oidcConfiguration: OidcAdminConfigurationRead;
}

export interface UserManagementDirectoryData {
  users: AdminUser[];
  directory: AdminUserListResponse;
}

export interface UserManagementContextData {
  currentUserId: string | null;
  oidcConfiguration: OidcAdminConfigurationRead;
}

function normalizeUserDirectoryResponse(response: AdminUserListResponse | AdminUser[]): AdminUserListResponse {
  if (!Array.isArray(response)) {
    return response;
  }

  return {
    items: response,
    total: response.length,
    summary: {
      total: response.length,
      active_admins: response.filter((user) => user.role === "admin" && user.is_active).length,
      disabled: response.filter((user) => !user.is_active).length,
      expiring_soon: 0,
      pending_oidc: response.filter((user) => user.pending_oidc !== null).length,
      unavailable_sign_in: response.filter((user) => !user.has_local_password && user.oidc === null).length,
    },
  };
}

export async function loadConnectionsSettingsData(): Promise<Connection[]> {
  return api.getConnections();
}

export function getUserManagementSettingsDataCacheKey(query: AdminUserListQuery): string {
  return `${SETTINGS_DATA_CACHE_KEYS.adminUsers}:${JSON.stringify(query)}`;
}

export async function loadUserManagementDirectoryData(query: AdminUserListQuery = {}): Promise<UserManagementDirectoryData> {
  const directoryResponse = await api.getUsers(query);
  const directory = normalizeUserDirectoryResponse(directoryResponse);

  return {
    users: directory.items,
    directory,
  };
}

export async function loadUserManagementContextData(): Promise<UserManagementContextData> {
  const [currentUser, oidcConfiguration] = await Promise.all([api.getCurrentUser(), api.getOidcConfiguration()]);

  return {
    currentUserId: currentUser.id ?? null,
    oidcConfiguration,
  };
}

export async function loadUserManagementSettingsData(query: AdminUserListQuery = {}): Promise<UserManagementSettingsData> {
  const [directoryData, contextData] = await Promise.all([loadUserManagementDirectoryData(query), loadUserManagementContextData()]);

  return { ...directoryData, ...contextData };
}

export async function loadAdvancedSettingsData(): Promise<AdvancedSystemSettings> {
  return api.getAdvancedSettings();
}

export async function loadSmbSettingsData(): Promise<SmbSettings> {
  return api.getSmbSettings();
}

export async function loadAboutSettingsData(): Promise<AboutSettings> {
  return api.getAboutSettings();
}

export async function loadNetworkSettingsData(): Promise<NetworkSettings> {
  return api.getNetworkSettings();
}

export async function loadAuthenticationSettingsData(): Promise<OidcAdminConfigurationRead> {
  return api.getOidcConfiguration();
}

export async function loadLocalDrivesSettingsData(): Promise<LocalDrivesSettingsData> {
  let companionAvailable = false;
  let currentPairStatus: PairStatusResponse | null = null;
  let authProtocolStatus: CompanionAuthProtocolStatus | null = null;
  let pairingVerified: boolean | null = null;
  let downloadMetadata: CompanionDownloadMetadata | null = null;
  let downloadError: string | null = null;

  if (canSignCompanionRequests()) {
    try {
      const health = await companionService.checkHealth();

      companionAvailable = health !== null;
      if (health) {
        authProtocolStatus = getCompanionAuthProtocolStatus(health);
        if (authProtocolStatus === "compatible") {
          currentPairStatus = await companionService.getPairStatus();
          if (currentPairStatus.status === "paired" && hasStoredSecret()) {
            try {
              await companionService.testPairing();
              pairingVerified = true;
            } catch (error) {
              pairingVerified = isCompanionAuthSignatureMismatch(error) ? false : null;
              logger.warn("Failed to verify local drive pairing", { error }, "companion");
            }
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to refresh local drives companion status", { error }, "companion");
    }
  }

  try {
    downloadMetadata = await api.getCompanionDownloads();
  } catch (error) {
    logger.warn("Failed to load companion download metadata", { error }, "companion");
    downloadError = getApiErrorMessage(error, LOCAL_DRIVES_PAGE_COPY.downloadLoadFailed, { includeOriginalMessage: true });
  }

  return {
    companionAvailable,
    currentPairStatus,
    authProtocolStatus,
    pairingVerified,
    downloadMetadata,
    downloadError,
  };
}

export function prefetchSettingsDataForItem(item: SettingsNavItem) {
  switch (item) {
    case "connections":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.connections, loadConnectionsSettingsData);
    case "local-drives":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.localDrives, loadLocalDrivesSettingsData);
    case "admin-users":
      return Promise.all([
        primeCachedAsyncData(getUserManagementSettingsDataCacheKey({}), loadUserManagementDirectoryData),
        primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminUserContext, loadUserManagementContextData),
      ]);
    case "admin-system":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminSystem, loadAdvancedSettingsData);
    case "admin-smb":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminSmb, loadSmbSettingsData);
    case "admin-about":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAbout, loadAboutSettingsData);
    case "admin-network":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminNetwork, loadNetworkSettingsData);
    case "admin-authentication":
      return primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication, loadAuthenticationSettingsData);
    default:
      return null;
  }
}

export function prefetchSettingsDataForItems(items: SettingsNavItem[]) {
  for (const item of items) {
    const prefetchPromise = prefetchSettingsDataForItem(item);
    if (prefetchPromise) {
      void prefetchPromise.catch(() => undefined);
    }
  }
}
