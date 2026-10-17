import type { ThemeConfig } from "../theme/types";

export type UserRole = "admin" | "editor" | "viewer";
export type AccountIdentitySource = "local" | "oidc";
export type AccountSessionKind = "password" | "oidc";
export type ConnectionScope = "shared" | "private";
export type ConnectionAccessMode = "read_write" | "read_only";
export type SystemSettingSource = "database" | "config_file" | "default";
export type LanguagePreference = "browser" | "en" | "en-XA";
export type RegionalLocalePreference = string;
export type CompanionDownloadPlatform = "windows-x64" | "windows-arm64" | "macos-arm64" | "linux-x64";

export interface User {
  id?: string;
  username: string;
  name?: string | null;
  email?: string | null;
  role?: UserRole;
  is_active?: boolean;
  must_change_password?: boolean;
  password_change_required?: boolean;
  expires_at?: string | null;
  access_token_expires_at?: string;
  created_at?: string;
}

export interface CurrentAccount extends User {
  id: string;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  expires_at: string | null;
  created_at: string;
  has_local_password: boolean;
  identity_source: AccountIdentitySource;
  password_change_available: boolean;
  password_change_required: boolean;
  browser_session_management_available: boolean;
  oidc_provider_name: string | null;
  current_session: CurrentAccountSession | null;
}

export interface CurrentAccountSession {
  kind: AccountSessionKind;
  id: string | null;
  started_at: string | null;
  last_active_at: string | null;
  browser_name: string | null;
  operating_system: string | null;
}

export interface AuthToken extends User {
  access_token: string;
  token_type: string;
  oidc_refresh_generation?: number;
  oidc_session_capability?: "renewable" | "reauthorization_only";
  oidc_session_expires_at?: string;
  return_path?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  name?: string | null;
  email?: string | null;
  role: UserRole;
  is_active: boolean;
  must_change_password: boolean;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
  has_local_password: boolean;
  oidc_role_assignment: UserRole | null;
  oidc: {
    identity_id: string;
    user_id: string;
    provider_display_name: string;
    issuer: string;
    subject: string;
    last_seen_username: string | null;
    last_groups: string[];
    created_at: string;
    last_login_at: string | null;
    inherited_role?: UserRole | null;
  } | null;
  pending_oidc: {
    expected_username: string;
    created_by_username: string;
    created_at: string;
  } | null;
}

export type AdminUserDirectoryState = "active" | "disabled" | "expired" | "expiring_soon";
export type AdminUserDirectoryAuthentication = "password" | "oidc" | "password_and_oidc" | "unavailable";
export type AdminUserDirectoryOidcState = "linked" | "pending" | "unlinked";
export type AdminUserDirectoryRoleSource =
  | "local_assignment"
  | "individual_override"
  | "oidc_default"
  | "oidc_groups"
  | "awaiting_oidc_sign_in";
export type AdminUserDirectorySort =
  | "username"
  | "role"
  | "status"
  | "sign_in"
  | "last_sign_in"
  | "expiration"
  | "email"
  | "created_at"
  | "updated_at"
  | "oidc_state"
  | "role_source"
  | "oidc_provider";
export type SortDirection = "asc" | "desc";

export interface AdminUserListQuery {
  q?: string;
  roles?: UserRole[];
  states?: AdminUserDirectoryState[];
  authentication?: AdminUserDirectoryAuthentication[];
  oidcStates?: AdminUserDirectoryOidcState[];
  roleSources?: AdminUserDirectoryRoleSource[];
  expiration?: "has_expiration" | "no_expiration";
  sort?: AdminUserDirectorySort;
  direction?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface AdminUserListSummary {
  total: number;
  active_admins: number;
  disabled: number;
  expiring_soon: number;
  pending_oidc: number;
  unavailable_sign_in: number;
}

export interface AdminUserListResponse {
  items: AdminUser[];
  total: number;
  summary: AdminUserListSummary;
  username_conflicts?: string[][];
}

export interface AdminUserCreateInput {
  username: string;
  name?: string;
  email?: string;
  role: UserRole;
  password?: string;
  must_change_password: boolean;
  expires_at?: string;
}

export interface AdminUserUpdateInput {
  username?: string;
  name?: string;
  email?: string;
  role?: UserRole;
  oidc_role_assignment?: UserRole | null;
  is_active?: boolean;
  expires_at?: string | null;
}

export interface AdminUserPasswordResetInput {
  new_password: string;
  must_change_password: boolean;
}

export interface AdminUserCreateResult extends AdminUser {
  temporary_password?: string | null;
}

export interface AdminUserPasswordResetResult {
  message: string;
}

export interface Connection {
  id: string;
  name: string;
  slug: string;
  type: string;
  host: string;
  port: number;
  share_name: string;
  username: string;
  path_prefix?: string;
  scope: ConnectionScope;
  access_mode: ConnectionAccessMode;
  can_manage: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConnectionCreate {
  name: string;
  type: string;
  host: string;
  port: number;
  share_name: string;
  username: string;
  password: string;
  path_prefix?: string;
  scope: ConnectionScope;
  access_mode: ConnectionAccessMode;
}

export interface ConnectionVisibilityOption {
  value: ConnectionScope;
  label: string;
  description: string;
  available: boolean;
  unavailable_reason?: string | null;
}

export interface IntegerSystemSetting {
  key: string;
  label: string;
  description: string;
  value: number;
  source: SystemSettingSource;
  default_value: number;
  min_value: number;
  max_value: number;
  step: number;
}

export interface PreprocessorAdvancedSettings {
  max_file_size_bytes: IntegerSystemSetting;
  timeout_seconds: IntegerSystemSetting;
}

export interface PdfAdvancedSettings {
  cache_quota_bytes: IntegerSystemSetting;
  cache_inactivity_ttl_seconds: IntegerSystemSetting;
  max_source_size_bytes: IntegerSystemSetting;
  max_output_size_bytes: IntegerSystemSetting;
  address_space_bytes: IntegerSystemSetting;
  temporary_disk_bytes: IntegerSystemSetting;
  timeout_seconds: IntegerSystemSetting;
  cpu_time_seconds: IntegerSystemSetting;
  max_concurrent: IntegerSystemSetting;
  queue_wait_seconds: IntegerSystemSetting;
  screen_derivative_enabled: IntegerSystemSetting;
  screen_max_decoded_pixels: IntegerSystemSetting;
}

export interface AdvancedSystemSettings {
  preprocessors: Record<string, PreprocessorAdvancedSettings>;
  pdf?: PdfAdvancedSettings;
  temporary_archive_download_size_bytes?: IntegerSystemSetting;
}

export type AdvancedSystemSettingsUpdate = { field: string; value: number };

export type FileSearchExclusionCategory = "images" | "temporary_backup";

export interface FileSearchSettings {
  retention_limit: number;
  result_limit: number;
  excluded_categories: FileSearchExclusionCategory[];
  excluded_extensions: string[];
}

export interface FileSearchSettingsRead {
  settings: FileSearchSettings;
  source: Exclude<SystemSettingSource, "config_file">;
}

export type FileSearchSettingsUpdate =
  | { field: "retention_limit"; value: number }
  | { field: "result_limit"; value: number }
  | { field: "excluded_categories"; value: FileSearchExclusionCategory[] }
  | { field: "excluded_extensions"; value: string[] };

export interface RecentFile {
  id: string;
  connection_id: string;
  path: string;
  file_name: string;
  last_opened_at: string;
}

export interface RecentFileSearchResponse {
  results: RecentFile[];
  result_limit?: number;
}

export interface RecentDirectory {
  id: string;
  connection_id: string;
  path: string;
  last_visited_at: string;
}

export interface RecentDirectorySearchResponse {
  results: RecentDirectory[];
  result_limit: number;
}

export interface RecentFileValidationError {
  code:
    | "recent_file_target_missing"
    | "recent_file_target_not_file"
    | "recent_file_native_launch_failed"
    | "recent_file_invalid_path"
    | "recent_file_connection_removed"
    | "recent_file_access_denied"
    | "recent_file_validation_transient";
  message: string;
}

export type SmbAuthenticationMode = "negotiate" | "kerberos_required";
export type SmbEncryptionMode = "signing_only" | "encryption_required";

export interface SmbPolicySettings {
  authentication_mode: SmbAuthenticationMode;
  encryption_mode: SmbEncryptionMode;
  connection_timeout_seconds: number;
}

export interface SmbSettings {
  read_chunk_size_bytes: IntegerSystemSetting;
  policy: SmbPolicySettings;
  require_signing: boolean;
  require_encryption: boolean;
}

export type SmbSettingsUpdate =
  | { field: "read_chunk_size_bytes"; value: number }
  | { field: "authentication_mode"; value: SmbAuthenticationMode }
  | { field: "encryption_mode"; value: SmbEncryptionMode }
  | { field: "connection_timeout_seconds"; value: number };

export interface AboutSettings {
  version: string;
  build_time: string;
  git_commit: string;
  started_at: string;
  architecture: string;
  logical_cpu_count: number | null;
  memory_bytes: number | null;
  python_runtime: string;
}

export interface PublicSupportReport {
  content: string;
}

export interface NetworkSettings {
  public_url: string;
  trusted_proxy_cidrs: string[];
}

export type NetworkSettingsUpdate = { field: "public_url"; value: string } | { field: "trusted_proxy_cidrs"; value: string[] };

export interface CurrentUserSettings {
  appearance: {
    theme_id: string;
    has_theme_override?: boolean;
    custom_themes: ThemeConfig[];
  };
  localization: {
    language: LanguagePreference;
    regional_locale: RegionalLocalePreference;
  };
  browser: {
    quick_nav_include_dot_directories: boolean;
    quick_bar_shortcut_hint_visibility: "auto" | "always" | "never";
    touch_friendly_file_selection: "auto" | "always" | "never";
    file_browser_view_mode: "list" | "details";
    pane_mode: "single" | "dual";
    selected_connection_id: string | null;
    viewer_associations: Record<string, string>;
  };
  text_editor: {
    max_file_size_bytes: number;
    word_wrap_enabled: boolean | null;
  };
}

export type CurrentUserSettingsUpdate =
  | { field: "appearance.theme_id"; value: string }
  | { field: "localization.language"; value: LanguagePreference }
  | { field: "localization.regional_locale"; value: RegionalLocalePreference }
  | { field: "browser.quick_nav_include_dot_directories"; value: boolean }
  | { field: "browser.quick_bar_shortcut_hint_visibility"; value: "auto" | "always" | "never" }
  | { field: "browser.touch_friendly_file_selection"; value: "auto" | "always" | "never" }
  | { field: "browser.file_browser_view_mode"; value: "list" | "details" }
  | { field: "browser.pane_mode"; value: "single" | "dual" }
  | { field: "browser.selected_connection_id"; value: string | null }
  | { field: "browser.viewer_associations"; value: Record<string, string> }
  | { field: "text_editor.max_file_size_bytes"; value: number }
  | { field: "text_editor.word_wrap_enabled"; value: boolean | null };

export enum FileType {
  FILE = "file",
  DIRECTORY = "directory",
}

export interface FileInfo {
  name: string;
  path: string;
  type: FileType;
  size?: number;
  mime_type?: string;
  created_at?: string;
  modified_at?: string;
  is_readable: boolean;
  is_hidden: boolean;
  /** Availability reported by a virtual content provider. Absent for physical entries. */
  archive_entry_state?: ArchiveEntryState;
  /** Companion-only source link classification. Absent for normal and remote entries. */
  link_kind?: LocalLinkKind;
  /** Client-side enrichment returned by Companion's deferred local link metadata request. */
  link_target?: LocalLinkTargetResolution;
}

export interface DirectoryListing {
  path: string;
  items: FileInfo[];
  total: number;
}

/** Whether an archive entry can be activated; directories are always readable for navigation. */
export type ArchiveEntryState = "readable" | "blocked" | "unavailable";

export interface ArchiveIdentity {
  path: string;
  size: number;
  modified_at?: string | null;
}

export interface ArchiveEntryInfo {
  name: string;
  path: string;
  type: FileType;
  size?: number | null;
  compressed_size?: number | null;
  compression_method?: number | null;
  crc32?: number | null;
  modified_at?: string | null;
  state: ArchiveEntryState;
  is_hidden: boolean;
}

export interface ArchiveDirectoryListing {
  archive: ArchiveIdentity;
  path: string;
  items: ArchiveEntryInfo[];
  next_cursor?: string | null;
  page_size: number;
}

export type ArchiveOperationKind = "create" | "extract";
export type ArchiveContractVersion = "v2";
export type ArchiveOperationPhase =
  | "prepared"
  | "accepted"
  | "streaming"
  | "awaiting_user_decision"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export interface ArchiveOperationPrepare {
  contract_version: ArchiveContractVersion;
  kind: ArchiveOperationKind;
  source_connection_id: string;
  source_path: string;
  destination_connection_id: string;
  destination_path: string;
  manifest_hash?: string;
  plan_json?: string;
  selected_member_paths?: string[];
}

export interface ArchiveOperation {
  id: string;
  contract_version: ArchiveContractVersion;
  kind: ArchiveOperationKind;
  phase: ArchiveOperationPhase;
  source_connection_id: string;
  source_path: string;
  destination_connection_id: string;
  destination_path: string;
  manifest_hash: string;
  checkpoint_json: string;
  pending_decision_json?: string | null;
  collision_policy?: string | null;
  cancellation_requested: boolean;
  last_error_json?: string | null;
  last_error: ArchiveOperationError | null;
  created_at: string;
  updated_at: string;
  heartbeat_at: string;
}

export interface ArchiveOperationError {
  code: string;
  message: string;
}

export interface ArchiveCompanionSession {
  token: string;
  expires_in: number;
  operation: ArchiveOperation;
  selected_member_paths: string[] | null;
}

export type ArchiveExtractionDecisionAction =
  | "skip"
  | "skip_all"
  | "replace"
  | "replace_all"
  | "replace_older"
  | "rename"
  | "retry"
  | "ignore"
  | "cancel";

/** Canonical local-drive target returned before activating a local entry. */
export interface LocalActivationResolution {
  drive_id: string;
  path: string;
  item: FileInfo;
}

export type LocalLinkKind = "filesystem_link" | "windows_shortcut";
export type LocalLinkTargetType = "file" | "directory" | "other";
export type LocalLinkTargetState = "resolved" | "missing" | "access_denied" | "unresolvable" | "unmapped_drive";

export interface LocalLinkTargetInfo {
  name: string;
  /** Full canonical path for an exposed local target; omitted for unavailable targets. */
  path?: string;
  type: LocalLinkTargetType;
}

export interface LocalLinkTargetResolution {
  source_path: string;
  state: LocalLinkTargetState;
  target?: LocalLinkTargetInfo;
}

export interface LocalLinkTargetListing {
  items: LocalLinkTargetResolution[];
}

export interface DirectorySearchResult {
  results: string[];
  total_matches: number;
  cache_state: "empty" | "building" | "ready" | "updating";
  directory_count: number;
}

export interface EditLockInfo {
  lock_id: string;
  lock_capability?: string;
  operation_id?: string;
  file_path: string;
  locked_by: string;
  locked_at: string;
}

export interface EditLockStatus {
  locked: boolean;
  locked_by?: string | null;
  locked_at?: string | null;
}

export interface AuthToken {
  access_token: string;
  token_type: string;
  user_id?: string;
  username: string;
  name?: string | null;
  email?: string | null;
  role?: UserRole;
  expires_at?: string | null;
  must_change_password?: boolean;
  return_path?: string;
  access_token_expires_at?: string;
  oidc_refresh_generation?: number;
}

export interface OidcBrowserSession {
  id: string;
  status: "active" | "refresh_uncertain";
  browser_name: string | null;
  operating_system: string | null;
  created_at: string;
  authenticated_at: string;
  last_seen_at: string | null;
  last_refreshed_at: string | null;
  current: boolean;
}

export interface OidcBrowserSessionList {
  sessions: OidcBrowserSession[];
}

export interface OidcBrowserSessionRevokeResult {
  revoked_count: number;
}

export type AuthenticationMode = "none" | "password_only" | "oidc_or_password" | "oidc_only";
export type SignInMode = "password_only" | "oidc_or_password" | "oidc_only";
export type OidcAdmissionMode = "all_idp_users" | "selected_groups";
export type OidcRoleAssignmentMode = "uniform" | "group_based";

export interface OidcRoleMappings {
  admin: string[];
  editor: string[];
  viewer: string[];
}

export interface OidcReviewedPolicy {
  sign_in_mode: SignInMode;
  interactive_reauthentication_max_age_days: number;
  no_refresh_session_limit_hours: number;
  admission_mode: OidcAdmissionMode;
  admission_groups: string[];
  role_assignment_mode: OidcRoleAssignmentMode;
  uniform_role: UserRole;
  role_mappings: OidcRoleMappings;
  auto_link_by_username: boolean;
}

export interface OidcConfigurationCandidate {
  display_name: string;
  issuer_url: string;
  client_id: string;
  client_secret?: string;
  scopes: string[];
  username_claim: string;
  name_claim: string | null;
  email_claim: string | null;
  groups_claim: string | null;
  sign_in_mode: SignInMode;
  interactive_reauthentication_max_age_days: number;
  no_refresh_session_limit_hours: number;
  admission_mode: OidcAdmissionMode;
  admission_groups: string[];
  role_assignment_mode: OidcRoleAssignmentMode;
  uniform_role: UserRole;
  role_mappings: OidcRoleMappings;
  auto_link_by_username: boolean;
}

export interface RedactedOidcConfiguration extends Omit<OidcConfigurationCandidate, "client_secret"> {
  client_secret_configured: boolean;
  configuration_revision: number;
  identity_mapping_revision: number;
}

export interface AuthenticationHealth {
  public_url_configured: boolean;
  public_url: string | null;
  redirect_uri: string | null;
  status: "healthy" | "unhealthy";
  reasons: string[];
}

export interface OidcAdminConfigurationRead {
  configuration: RedactedOidcConfiguration | null;
  health: AuthenticationHealth;
  active_passwordless_user_count: number;
  auth_mode: AuthenticationMode;
  auth_enforcement_disabled: boolean;
}

export interface AuthenticationModeActivationResponse {
  auth_mode: AuthenticationMode;
  reauthentication_required: boolean;
}

export interface OidcTestStartResponse {
  flow_id: string;
  authorization_url: string;
}

export interface OidcReplacementMapping {
  target_user_id: string;
  local_username: string;
  local_role: UserRole;
  has_local_password: boolean;
  target_state: "active" | "inactive" | "expired";
  mapping_state: "unmapped" | "pending" | "established";
  suggested_username: string;
  prefill_source: "pending" | "last_seen" | "local";
  selected_by_default: boolean;
  selectable: boolean;
  omission_acknowledgement_required: boolean;
}

export interface OidcTestedIdentity {
  flow_id: string;
  refresh_token_returned: boolean;
  candidate: RedactedOidcConfiguration;
  replacement_mappings: OidcReplacementMapping[];
  expected_identity_mapping_revision: number | null;
  admitted: boolean;
  matching_admission_group: string | null;
  affected_account_count: number;
  acting_administrator_affected: boolean;
  username: string;
  name: string | null;
  email: string | null;
  groups: string[];
  expires_at: string;
}

export interface OidcFinalizeResponse {
  configuration_revision: number;
  identity_mapping_revision: number;
  reauthentication_required: boolean;
}

export interface OidcMappingMutationResponse {
  identity_mapping_revision: number;
  pending_mappings: Array<{
    target_user_id: string;
    expected_username: string;
    created_at: string;
  }>;
}

export interface CompanionDownloadMetadata {
  source: "feed" | "pin";
  version: string;
  published_at?: string | null;
  notes: string;
  assets: Partial<Record<CompanionDownloadPlatform, string>>;
}

// Alias for compatibility
export type FileEntry = FileInfo;

/**
 * Metadata returned in 409 responses when a copy/move destination
 * already exists.  Contains info about both the existing and incoming
 * items so the UI can show a meaningful overwrite-confirmation dialog.
 */
export interface ConflictInfo {
  existing_file: FileInfo;
  incoming_file: FileInfo;
}

export interface OidcMappingValidationError {
  target_user_id: string | null;
  field: string | null;
  error_code: string;
  message: string;
}

export interface OidcMappingValidationDetail {
  errors: OidcMappingValidationError[];
}

// API Error type for axios errors
export interface ApiError {
  response?: {
    data?: {
      detail?: string | ConflictInfo | OidcMappingValidationDetail | RecentFileValidationError;
      code?: string;
    };
    status?: number;
  };
  message?: string;
}

// Type guard for API errors
export function isApiError(error: unknown): error is ApiError {
  return typeof error === "object" && error !== null && ("response" in error || "message" in error);
}
