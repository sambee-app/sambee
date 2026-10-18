import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  FilterList as FilterListIcon,
  Link as LinkIcon,
  LinkOff as LinkOffIcon,
  LockReset as LockResetIcon,
  MoreVert as MoreVertIcon,
  RestartAlt as RestartAltIcon,
  ViewWeek as ViewWeekIcon,
} from "@mui/icons-material";
import {
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  FormHelperText,
  IconButton,
  InputLabel,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Pagination,
  PaginationItem,
  Popover,
  Select,
  Stack,
  Switch,
  type SxProps,
  TableSortLabel,
  TextField,
  type Theme,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { startTransition, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import DeleteDialog from "../components/Admin/DeleteDialog";
import { adminDialogActionButtonSx, adminDialogEndActionRowSx } from "../components/Admin/dialogActionStyles";
import { CompactBadge as Chip } from "../components/CompactBadge";
import { DialogNotice } from "../components/Dialog/DialogNotice";
import { DialogReadOnlyField } from "../components/Dialog/DialogReadOnlyField";
import { ResponsiveDialogShell } from "../components/Dialog/ResponsiveDialogShell";
import {
  FormFieldLabel,
  FormGroup,
  FormRow,
  FormSurface,
  formFieldControlSx,
  formOutlinedControlSx,
  formSelectControlSx,
  formSelectMenuProps,
  formSelectSx,
} from "../components/Form/FormLayout";
import { SettingsInlineAlert, SettingsNotificationSnackbar, type SettingsNotificationState } from "../components/Settings/SettingsFeedback";
import { SettingsFormSection } from "../components/Settings/SettingsFormLayout";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsPasswordVisibilityToggle } from "../components/Settings/SettingsPasswordVisibilityToggle";
import { SettingsSelectMenuItem } from "../components/Settings/SettingsSelectMenuItem";
import { SettingsEmptyState, SettingsLoadingState } from "../components/Settings/SettingsState";
import {
  settingsMetadataChipSx,
  settingsPrimaryButtonSx,
  settingsUtilityButtonSx,
  settingsUtilityIconButtonSx,
} from "../components/Settings/settingsButtonStyles";
import {
  getUserManagementSettingsDataCacheKey,
  loadUserManagementContextData,
  loadUserManagementDirectoryData,
  SETTINGS_DATA_CACHE_KEYS,
} from "../components/Settings/settingsDataSources";
import { settingsListItemTitleSx } from "../components/Settings/settingsTypographyStyles";
import { clearCachedAsyncDataByPrefix, useCachedAsyncData } from "../hooks/useCachedAsyncData";
import api, { isControlledReauthenticationInProgress } from "../services/api";
import type {
  AdminUser,
  AdminUserCreateInput,
  AdminUserCreateResult,
  AdminUserDirectoryAuthentication,
  AdminUserDirectoryOidcState,
  AdminUserDirectoryRoleSource,
  AdminUserDirectorySort,
  AdminUserDirectoryState,
  AdminUserListQuery,
  AdminUserPasswordResetResult,
  AdminUserUpdateInput,
  SortDirection,
  UserRole,
} from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";
import { dialogEnterKeyHandler } from "../utils/keyboardUtils";
import { formatLocalizedDateTime } from "../utils/localeFormatting";

interface UserFormState {
  username: string;
  name: string;
  email: string;
  role: UserRole;
  oidcRoleAssignment: UserRole | "";
  isActive: boolean;
  password: string;
  mustChangePassword: boolean;
  expiresAt: string;
}

type SingleSxProp = Exclude<SxProps<Theme>, ReadonlyArray<unknown>>;

function combineSx(...styles: SxProps<Theme>[]): SingleSxProp[] {
  return styles.flatMap((style) => (Array.isArray(style) ? style : [style])) as SingleSxProp[];
}

interface ResetPasswordFormState {
  password: string;
  mustChangePassword: boolean;
}

interface UserManagementSettingsProps {
  dialogSafeHeader?: boolean;
}

type OidcMappingEditorMode = "create" | "change" | "move";

type UserEditorField = "username";
type OidcMappingEditorField = "targetUser" | "expectedUsername";
const OIDC_INHERITED_ROLE_VALUE = "inherited";

const USER_EDITOR_IDS = {
  username: "user-editor-username",
  usernameDescription: "user-editor-username-description",
  name: "user-editor-name",
  nameDescription: "user-editor-name-description",
  email: "user-editor-email",
  emailDescription: "user-editor-email-description",
  role: "user-editor-role",
  roleLabel: "user-editor-role-label",
  roleDescription: "user-editor-role-description",
  expiresAt: "user-editor-expires-at",
  expiresAtDescription: "user-editor-expires-at-description",
  isActive: "user-editor-is-active",
  isActiveLabel: "user-editor-is-active-label",
  isActiveDescription: "user-editor-is-active-description",
  password: "user-editor-password",
  passwordDescription: "user-editor-password-description",
  mustChangePassword: "user-editor-must-change-password",
  mustChangePasswordLabel: "user-editor-must-change-password-label",
  mustChangePasswordDescription: "user-editor-must-change-password-description",
} as const;

const OIDC_DETAILS_IDS = {
  provider: "oidc-details-provider",
  issuer: "oidc-details-issuer",
  subject: "oidc-details-subject",
  lastSeenUsername: "oidc-details-last-seen-username",
  lastGroups: "oidc-details-last-groups",
  createdAt: "oidc-details-created-at",
  lastLoginAt: "oidc-details-last-login-at",
} as const;

const DEFAULT_USER_FORM: UserFormState = {
  username: "",
  name: "",
  email: "",
  role: "editor",
  oidcRoleAssignment: "",
  isActive: true,
  password: "",
  mustChangePassword: true,
  expiresAt: "",
};

function toDateTimeLocalValue(value?: string | null): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const timezoneOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
}

function toIsoDateTimeValue(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }

  return new Date(value).toISOString();
}

const DEFAULT_RESET_PASSWORD_FORM: ResetPasswordFormState = {
  password: "",
  mustChangePassword: true,
};
const LOCAL_TIMESTAMP_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

function formatLocalTimestamp(value: string): string {
  return formatLocalizedDateTime(value, LOCAL_TIMESTAMP_FORMAT_OPTIONS);
}

interface DirectoryQueryState {
  q: string;
  roles: UserRole[];
  states: AdminUserDirectoryState[];
  authentication: AdminUserDirectoryAuthentication[];
  oidcStates: AdminUserDirectoryOidcState[];
  roleSources: AdminUserDirectoryRoleSource[];
  expiration: "" | "has_expiration" | "no_expiration";
  sort: AdminUserDirectorySort;
  direction: SortDirection;
  page: number;
  pageSize: number;
}

interface DirectoryFilterOption<T extends string> {
  value: T;
  label: string;
}

type DirectoryColumn =
  | "role"
  | "status"
  | "signIn"
  | "lastSignIn"
  | "expiration"
  | "email"
  | "createdAt"
  | "updatedAt"
  | "oidcState"
  | "roleSource"
  | "oidcProvider";

const DIRECTORY_DEFAULT_PAGE_SIZE = 25;
const DIRECTORY_SEARCH_DEBOUNCE_MS = 300;
const DIRECTORY_ACTIONS_COLUMN_WIDTH = "76px";
const DIRECTORY_CONTAINER_NAME = "user-directory";
const DIRECTORY_WIDE_QUERY = `@container ${DIRECTORY_CONTAINER_NAME} (min-width: 40rem)`;
export const USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY = "sambee.user-directory.visible-columns.v1";
const DIRECTORY_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DIRECTORY_SECONDARY_CONTROL_FONT_SIZE = "0.875rem";
const DIRECTORY_ROLE_VALUES: UserRole[] = ["admin", "editor", "viewer"];
const DIRECTORY_STATE_VALUES: AdminUserDirectoryState[] = ["active", "disabled", "expired", "expiring_soon"];
const DIRECTORY_AUTHENTICATION_VALUES: AdminUserDirectoryAuthentication[] = ["password", "oidc", "password_and_oidc", "unavailable"];
const DIRECTORY_OIDC_STATE_VALUES: AdminUserDirectoryOidcState[] = ["linked", "pending", "unlinked"];
const DIRECTORY_ROLE_SOURCE_VALUES: AdminUserDirectoryRoleSource[] = [
  "local_assignment",
  "individual_override",
  "oidc_default",
  "oidc_groups",
  "awaiting_oidc_sign_in",
];
const DIRECTORY_SORT_VALUES: AdminUserDirectorySort[] = [
  "username",
  "role",
  "status",
  "sign_in",
  "last_sign_in",
  "expiration",
  "email",
  "created_at",
  "updated_at",
  "oidc_state",
  "role_source",
  "oidc_provider",
];
const DIRECTORY_DIRECTION_VALUES: SortDirection[] = ["asc", "desc"];
const DIRECTORY_COLUMN_VALUES: DirectoryColumn[] = [
  "role",
  "status",
  "signIn",
  "lastSignIn",
  "expiration",
  "email",
  "createdAt",
  "updatedAt",
  "oidcState",
  "roleSource",
  "oidcProvider",
];
const DIRECTORY_DEFAULT_COLUMN_VALUES: DirectoryColumn[] = ["role", "status", "signIn", "lastSignIn", "expiration"];
const DIRECTORY_OIDC_COLUMN_VALUES: DirectoryColumn[] = ["lastSignIn", "oidcState", "roleSource", "oidcProvider"];
const DIRECTORY_COLUMN_LABELS: Record<DirectoryColumn, string> = {
  role: "Role",
  status: "Status",
  signIn: "Sign-in",
  lastSignIn: "Last OIDC sign-in",
  expiration: "Expiration",
  email: "Email",
  createdAt: "Created",
  updatedAt: "Last updated",
  oidcState: "OIDC state",
  roleSource: "Role source",
  oidcProvider: "OIDC provider",
};
const DIRECTORY_COLUMN_GRID_WIDTHS: Record<DirectoryColumn, string> = {
  role: "minmax(0, 0.8fr)",
  status: "minmax(0, 0.9fr)",
  signIn: "minmax(0, 1fr)",
  lastSignIn: "minmax(0, 1fr)",
  expiration: "minmax(0, 1.2fr)",
  email: "minmax(0, 1.4fr)",
  createdAt: "minmax(0, 1.1fr)",
  updatedAt: "minmax(0, 1.1fr)",
  oidcState: "minmax(0, 1fr)",
  roleSource: "minmax(0, 1.2fr)",
  oidcProvider: "minmax(0, 1.1fr)",
};
const DIRECTORY_HEADER_LABEL_SX = {
  alignItems: "flex-start",
  color: "text.secondary",
  display: "flex",
  fontSize: "0.75rem",
  fontWeight: 600,
  letterSpacing: 0,
  lineHeight: 1.66,
  minWidth: 0,
  maxWidth: "100%",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  textAlign: "left",
} as const;
const DIRECTORY_SECONDARY_CONTROL_SX = {
  fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE,
  "& .MuiInputBase-input, & .MuiSelect-select": { fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE },
  "& .MuiInputLabel-root": { fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE },
} as const;
const DIRECTORY_COLUMN_MENU_ICON_SX = { justifyContent: "center", minWidth: 36 } as const;

function readVisibleDirectoryColumns(): DirectoryColumn[] | null {
  try {
    const storedColumns = window.localStorage.getItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY);
    if (!storedColumns) {
      return null;
    }
    const parsedColumns: unknown = JSON.parse(storedColumns);
    if (!Array.isArray(parsedColumns) || !parsedColumns.every((column) => DIRECTORY_COLUMN_VALUES.includes(column as DirectoryColumn))) {
      return null;
    }
    return [...new Set(parsedColumns as DirectoryColumn[])];
  } catch {
    return null;
  }
}

function writeVisibleDirectoryColumns(columns: DirectoryColumn[]): void {
  try {
    window.localStorage.setItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(columns));
  } catch {
    // Column selection remains available for the current session when storage is unavailable.
  }
}

function getDirectoryOidcState(user: AdminUser): string {
  if (user.pending_oidc) {
    return "Setup pending";
  }
  return user.oidc ? "Linked" : "Unlinked";
}

function getDirectoryRoleSource(user: AdminUser, roleAssignmentMode: "uniform" | "group_based" | undefined): string {
  if (user.pending_oidc || (user.oidc && !user.oidc.last_login_at)) {
    return "Awaiting OIDC sign-in";
  }
  if (user.oidc_role_assignment) {
    return "Individual override";
  }
  if (user.oidc) {
    return roleAssignmentMode === "group_based" ? "OIDC groups" : "OIDC default";
  }
  return "Local assignment";
}

function getCompactRoleSource(source: AdminUserDirectoryRoleSource): string {
  const labels: Record<AdminUserDirectoryRoleSource, string> = {
    local_assignment: "Local role",
    individual_override: "Role override",
    oidc_default: "OIDC default role",
    oidc_groups: "OIDC group role",
    awaiting_oidc_sign_in: "Awaiting OIDC",
  };
  return labels[source];
}

function DirectoryTimestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <>Never</>;
  return (
    <Tooltip title={formatLocalTimestamp(value)}>
      <Box component="time" dateTime={value} sx={{ display: "inline-block", verticalAlign: "top" }}>
        <Box component="span" sx={{ display: "block" }}>
          {formatLocalizedDateTime(value, { dateStyle: "short" })}
        </Box>
        <Box component="span" sx={{ display: "block" }}>
          {formatLocalizedDateTime(value, { timeStyle: "short" })}
        </Box>
      </Box>
    </Tooltip>
  );
}

function getDirectoryRowGridSx(visibleColumns: DirectoryColumn[]) {
  const desktopColumns = [
    "minmax(0, 1.6fr)",
    ...visibleColumns.map((column) => DIRECTORY_COLUMN_GRID_WIDTHS[column]),
    DIRECTORY_ACTIONS_COLUMN_WIDTH,
  ].join(" ");
  const mobileAreas = ['"identity actions"', ...visibleColumns.map((column) => `"${column} ${column}"`)].join(" ");

  return {
    display: "grid",
    gridTemplateColumns: `minmax(0, 1fr) ${DIRECTORY_ACTIONS_COLUMN_WIDTH}`,
    gridTemplateAreas: mobileAreas,
    gap: 1,
    alignItems: "start",
    minWidth: 0,
    width: "100%",
    [DIRECTORY_WIDE_QUERY]: {
      display: "grid",
      gridTemplateColumns: desktopColumns,
      gridTemplateAreas: "none",
      gap: 1.5,
      "& > [data-directory-cell]": { gridArea: "auto" },
    },
  } as const;
}

function DirectoryRowCell({ area, children, align = "start" }: { area: string; children: React.ReactNode; align?: "start" | "end" }) {
  return (
    <Box
      role="cell"
      data-directory-cell={area}
      sx={{
        alignItems: "flex-start",
        display: "flex",
        alignSelf: align === "end" ? { xs: "start", md: "auto" } : undefined,
        gridArea: area,
        justifyContent: align === "end" ? "flex-end" : "flex-start",
        minWidth: 0,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        whiteSpace: "normal",
      }}
    >
      {children}
    </Box>
  );
}

function getDirectoryQueryFromLocation(search: string): DirectoryQueryState {
  const params = new URLSearchParams(search);
  const parseValues = <T extends string>(key: string, allowedValues: T[]): T[] =>
    params.getAll(key).filter((value): value is T => allowedValues.includes(value as T));
  const expiration = params.get("expiration");
  const sort = params.get("sort");
  const direction = params.get("direction");
  const parsedPage = Number.parseInt(params.get("page") ?? "1", 10);
  const parsedPageSize = Number.parseInt(params.get("page_size") ?? String(DIRECTORY_DEFAULT_PAGE_SIZE), 10);

  return {
    q: params.get("q")?.trim() ?? "",
    roles: parseValues("role", DIRECTORY_ROLE_VALUES),
    states: parseValues("state", DIRECTORY_STATE_VALUES),
    authentication: parseValues("auth", DIRECTORY_AUTHENTICATION_VALUES),
    oidcStates: parseValues("oidc_state", DIRECTORY_OIDC_STATE_VALUES),
    roleSources: parseValues("role_source", DIRECTORY_ROLE_SOURCE_VALUES),
    expiration: expiration === "has_expiration" || expiration === "no_expiration" ? expiration : "",
    sort: DIRECTORY_SORT_VALUES.includes(sort as AdminUserDirectorySort) ? (sort as AdminUserDirectorySort) : "username",
    direction: DIRECTORY_DIRECTION_VALUES.includes(direction as SortDirection) ? (direction as SortDirection) : "asc",
    page: Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize: DIRECTORY_PAGE_SIZE_OPTIONS.includes(parsedPageSize as (typeof DIRECTORY_PAGE_SIZE_OPTIONS)[number])
      ? (parsedPageSize as (typeof DIRECTORY_PAGE_SIZE_OPTIONS)[number])
      : DIRECTORY_DEFAULT_PAGE_SIZE,
  };
}

function toAdminUserListQuery(query: DirectoryQueryState): AdminUserListQuery {
  return {
    q: query.q || undefined,
    roles: query.roles,
    states: query.states,
    authentication: query.authentication,
    oidcStates: query.oidcStates,
    roleSources: query.roleSources,
    expiration: query.expiration || undefined,
    sort: query.sort,
    direction: query.direction,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function toDirectorySearch(query: DirectoryQueryState): string {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const role of query.roles) params.append("role", role);
  for (const state of query.states) params.append("state", state);
  for (const authentication of query.authentication) params.append("auth", authentication);
  for (const oidcState of query.oidcStates) params.append("oidc_state", oidcState);
  for (const roleSource of query.roleSources) params.append("role_source", roleSource);
  if (query.expiration) params.set("expiration", query.expiration);
  if (query.sort !== "username") params.set("sort", query.sort);
  if (query.direction !== "asc") params.set("direction", query.direction);
  if (query.page !== 1) params.set("page", String(query.page));
  if (query.pageSize !== DIRECTORY_DEFAULT_PAGE_SIZE) params.set("page_size", String(query.pageSize));
  return params.toString();
}

const DIRECTORY_QUERY_KEYS = [
  "q",
  "role",
  "state",
  "auth",
  "oidc_state",
  "role_source",
  "expiration",
  "sort",
  "direction",
  "page",
  "page_size",
];

function DirectoryFilterSelect<T extends string>({
  label,
  options,
  values,
  onChange,
}: {
  label: string;
  options: DirectoryFilterOption<T>[];
  values: T[];
  onChange: (values: T[]) => void;
}) {
  const labelId = useId();

  return (
    <FormControl size="small" sx={[DIRECTORY_SECONDARY_CONTROL_SX, { minWidth: 150 }]}>
      <InputLabel id={labelId}>{label}</InputLabel>
      <Select
        labelId={labelId}
        multiple
        value={values}
        label={label}
        onChange={(event) => {
          const nextValues = event.target.value;
          onChange((typeof nextValues === "string" ? nextValues.split(",") : nextValues) as T[]);
        }}
        renderValue={(selected) => (selected.length > 0 ? `${label} (${selected.length})` : label)}
      >
        {options.map((option) => (
          <MenuItem
            key={option.value}
            value={option.value}
            sx={{
              fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE,
              "& .MuiListItemText-primary": { fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE },
            }}
          >
            <Checkbox checked={values.includes(option.value)} />
            <ListItemText primary={option.label} />
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
}

function DirectoryColumnHeader({
  label,
  sort,
  activeSort,
  direction,
  onSort,
}: {
  label: string;
  sort?: AdminUserDirectorySort;
  activeSort: AdminUserDirectorySort;
  direction: SortDirection;
  onSort: (sort: AdminUserDirectorySort) => void;
}) {
  const isActive = sort === activeSort;
  const ariaSort = isActive ? (direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <Box role="columnheader" aria-sort={sort ? ariaSort : undefined} sx={{ alignItems: "center", display: "flex", minWidth: 0 }}>
      {sort ? (
        <TableSortLabel
          active={isActive}
          direction={isActive ? direction : "asc"}
          hideSortIcon={false}
          onClick={() => onSort(sort)}
          tabIndex={-1}
          aria-label={`Sort by ${label}${isActive ? `, ${ariaSort}` : ""}`}
          sx={{
            ...DIRECTORY_HEADER_LABEL_SX,
            "&.Mui-active, &:hover": { color: "text.secondary" },
            "& .MuiTableSortLabel-icon": { color: "inherit", flexShrink: 0 },
          }}
        >
          <Box component="span" sx={{ minWidth: 0 }}>
            {label}
          </Box>
        </TableSortLabel>
      ) : (
        <Box component="span" sx={DIRECTORY_HEADER_LABEL_SX}>
          {label}
        </Box>
      )}
    </Box>
  );
}

export function UserManagementSettings({ dialogSafeHeader = false }: UserManagementSettingsProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const theme = useTheme();
  const usesDesktopFormLayout = useMediaQuery(theme.breakpoints.up("md"));
  const directoryQuery = useMemo(() => getDirectoryQueryFromLocation(location.search), [location.search]);
  const [searchInput, setSearchInput] = useState(directoryQuery.q);
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuId = useId();
  const directoryContainerRef = useRef<HTMLDivElement>(null);
  const toolbarColumnsRef = useRef<HTMLButtonElement>(null);
  const headerColumnsRef = useRef<HTMLButtonElement>(null);
  const columnsMenuActionsRef = useRef<{ updatePosition: () => void }>(null);
  const getColumnsAnchor = useCallback(() => {
    const headerButton = headerColumnsRef.current;
    return headerButton && headerButton.getBoundingClientRect().width > 0 ? headerButton : toolbarColumnsRef.current;
  }, []);
  useEffect(() => {
    if (!columnsMenuOpen || !directoryContainerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => columnsMenuActionsRef.current?.updatePosition());
    observer.observe(directoryContainerRef.current);
    return () => observer.disconnect();
  }, [columnsMenuOpen]);
  const [selectedDirectoryColumns, setSelectedDirectoryColumns] = useState<DirectoryColumn[] | null>(readVisibleDirectoryColumns);
  const [notification, setNotification] = useState<SettingsNotificationState>({
    open: false,
    message: "",
    severity: "success",
  });
  const showNotification = useCallback((message: string, severity: "success" | "error" | "info") => {
    setNotification({ open: true, message, severity });
  }, []);
  const updateDirectoryQuery = useCallback(
    (update: Partial<DirectoryQueryState>, resetPage = true, replace = false) => {
      const nextQuery = { ...directoryQuery, ...update, page: resetPage ? 1 : (update.page ?? directoryQuery.page) };
      const search = new URLSearchParams(location.search);
      for (const key of DIRECTORY_QUERY_KEYS) search.delete(key);
      for (const [key, value] of new URLSearchParams(toDirectorySearch(nextQuery))) search.append(key, value);
      if (search.toString() === new URLSearchParams(location.search).toString()) return;
      void navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash }, { replace, state: location.state });
    },
    [directoryQuery, location, navigate]
  );
  const replaceDirectoryQuery = useCallback(
    (update: Partial<DirectoryQueryState>) => {
      updateDirectoryQuery({ ...update, page: 1 }, false, true);
    },
    [updateDirectoryQuery]
  );
  const directoryRequest = useMemo(() => toAdminUserListQuery(directoryQuery), [directoryQuery]);
  const loadDirectoryData = useCallback(() => loadUserManagementDirectoryData(directoryRequest), [directoryRequest]);
  const directoryCacheKey = useMemo(() => getUserManagementSettingsDataCacheKey(directoryRequest), [directoryRequest]);
  useEffect(() => {
    setSearchInput(directoryQuery.q);
  }, [directoryQuery.q]);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (searchInput.trim() !== directoryQuery.q) {
        updateDirectoryQuery({ q: searchInput.trim() });
      }
    }, DIRECTORY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [directoryQuery.q, searchInput, updateDirectoryQuery]);
  const handleUsersLoadError = useCallback(
    (error: unknown) => {
      if (isControlledReauthenticationInProgress()) {
        return;
      }
      const message = getApiErrorMessage(error, t("settings.userManagement.notifications.loadFailed"));
      showNotification(message, "error");
    },
    [showNotification, t]
  );
  const {
    data: cachedDirectoryData,
    loading: directoryLoading,
    refreshing: directoryRefreshing,
    refresh: refreshDirectoryData,
  } = useCachedAsyncData({
    cacheKey: directoryCacheKey,
    load: loadDirectoryData,
    onError: handleUsersLoadError,
    refreshCachedDataOnMount: false,
    retainDataOnCacheKeyChange: true,
  });
  const { data: userManagementContext, loading: contextLoading } = useCachedAsyncData({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.adminUserContext,
    load: loadUserManagementContextData,
    onError: handleUsersLoadError,
    refreshCachedDataOnMount: false,
  });
  const loading = directoryLoading || contextLoading;
  const users = cachedDirectoryData?.users ?? [];
  const usernameConflicts = cachedDirectoryData?.directory.username_conflicts ?? [];
  const directorySummary = cachedDirectoryData?.directory.summary ?? {
    total: 0,
    active_admins: 0,
    disabled: 0,
    expiring_soon: 0,
    pending_oidc: 0,
    unavailable_sign_in: 0,
  };
  const currentUserId = userManagementContext?.currentUserId ?? null;
  const authenticationMode = userManagementContext?.oidcConfiguration.auth_mode;
  const oidcAuthenticationEnabled = authenticationMode === "oidc_only" || authenticationMode === "oidc_or_password";
  const oidcConfiguration = oidcAuthenticationEnabled ? (userManagementContext?.oidcConfiguration.configuration ?? null) : null;
  const localPasswordManagementAvailable = authenticationMode === "password_only" || authenticationMode === "oidc_or_password";
  const pendingOidcMappingsAllowed = oidcConfiguration !== null;
  const availableDirectoryColumns = useMemo(
    () => DIRECTORY_COLUMN_VALUES.filter((column) => !DIRECTORY_OIDC_COLUMN_VALUES.includes(column) || oidcAuthenticationEnabled),
    [oidcAuthenticationEnabled]
  );
  const visibleDirectoryColumns = useMemo(
    () => availableDirectoryColumns.filter((column) => (selectedDirectoryColumns ?? DIRECTORY_DEFAULT_COLUMN_VALUES).includes(column)),
    [availableDirectoryColumns, selectedDirectoryColumns]
  );
  const directoryRowGridSx = useMemo(() => getDirectoryRowGridSx(visibleDirectoryColumns), [visibleDirectoryColumns]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [resetPasswordEditorOpen, setResetPasswordEditorOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [resetPasswordSubmitting, setResetPasswordSubmitting] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [mappingEditor, setMappingEditor] = useState<{
    open: boolean;
    mode: OidcMappingEditorMode;
    user: AdminUser | null;
    expectedUsername: string;
  }>({ open: false, mode: "create", user: null, expectedUsername: "" });
  const [mappingSubmitting, setMappingSubmitting] = useState(false);
  const [mappingContextualError, setMappingContextualError] = useState<string | null>(null);
  const [mappingFieldErrors, setMappingFieldErrors] = useState<Partial<Record<OidcMappingEditorField, string>>>({});
  const [mappingActionError, setMappingActionError] = useState<string | null>(null);
  const [mappingTargetSearch, setMappingTargetSearch] = useState("");
  const [mappingTargetQuery, setMappingTargetQuery] = useState("");
  const [mappingTargetUsers, setMappingTargetUsers] = useState<AdminUser[]>([]);
  const [mappingTargetUser, setMappingTargetUser] = useState<AdminUser | null>(null);
  const [mappingTargetsLoading, setMappingTargetsLoading] = useState(false);
  const [oidcDetailsUser, setOidcDetailsUser] = useState<AdminUser | null>(null);
  const [oidcConfirmation, setOidcConfirmation] = useState<{ user: AdminUser; action: "cancel" | "detach" } | null>(null);
  const [oidcConfirmationSubmitting, setOidcConfirmationSubmitting] = useState(false);
  const oidcConfirmationCancelRef = useRef<HTMLButtonElement>(null);
  const [userActionsMenu, setUserActionsMenu] = useState<{
    anchor: HTMLElement | null;
    user: AdminUser | null;
  }>({ anchor: null, user: null });
  const [formState, setFormState] = useState<UserFormState>(DEFAULT_USER_FORM);
  const [showInitialPassword, setShowInitialPassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<UserEditorField, string>>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [resetPasswordForm, setResetPasswordForm] = useState<ResetPasswordFormState>(DEFAULT_RESET_PASSWORD_FORM);
  const [resetPasswordError, setResetPasswordError] = useState<string | null>(null);
  const resetPasswordInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [credentialsDialog, setCredentialsDialog] = useState<{
    open: boolean;
    title: string;
    username: string;
    temporaryPassword: string;
    description: string;
  }>({
    open: false,
    title: "",
    username: "",
    temporaryPassword: "",
    description: "",
  });

  const isEditing = Boolean(selectedUser);
  const isEditingSelf = Boolean(selectedUser && currentUserId && selectedUser.id === currentUserId);
  const hasOidcManagedIdentity = oidcAuthenticationEnabled && Boolean(selectedUser?.oidc);
  const hasOidcRoleAssignment = oidcAuthenticationEnabled && Boolean(selectedUser?.oidc || selectedUser?.pending_oidc);
  const inheritedOidcRole = selectedUser?.oidc?.inherited_role ?? null;
  const canUseInheritedOidcRole = inheritedOidcRole !== null;
  const activeAdminCount = directorySummary.active_admins;
  const activeDirectoryFilterCount =
    directoryQuery.roles.length +
    directoryQuery.states.length +
    directoryQuery.authentication.length +
    (oidcAuthenticationEnabled ? directoryQuery.oidcStates.length + directoryQuery.roleSources.length : 0) +
    (directoryQuery.expiration ? 1 : 0);
  const clearDirectoryFilters = useCallback(() => {
    setSearchInput("");
    updateDirectoryQuery({
      q: "",
      roles: [],
      states: [],
      authentication: [],
      oidcStates: [],
      roleSources: [],
      expiration: "",
    });
  }, [updateDirectoryQuery]);
  const toggleDirectoryColumn = useCallback((column: DirectoryColumn) => {
    setSelectedDirectoryColumns((current) => {
      const selectedColumns = new Set(current ?? DIRECTORY_DEFAULT_COLUMN_VALUES);
      if (selectedColumns.has(column)) {
        selectedColumns.delete(column);
      } else {
        selectedColumns.add(column);
      }
      const nextColumns = DIRECTORY_COLUMN_VALUES.filter((value) => selectedColumns.has(value));
      writeVisibleDirectoryColumns(nextColumns);
      return nextColumns;
    });
  }, []);
  const resetDirectoryColumns = useCallback(() => {
    try {
      window.localStorage.removeItem(USER_DIRECTORY_VISIBLE_COLUMNS_STORAGE_KEY);
    } catch {
      // The default selection is still restored for the current session.
    }
    setSelectedDirectoryColumns(null);
  }, []);
  const handleDirectorySort = useCallback(
    (sort: AdminUserDirectorySort) => {
      startTransition(() => {
        updateDirectoryQuery({
          sort,
          direction: directoryQuery.sort === sort && directoryQuery.direction === "asc" ? "desc" : "asc",
        });
      });
    },
    [directoryQuery.direction, directoryQuery.sort, updateDirectoryQuery]
  );
  const refreshDirectory = useCallback(async () => {
    clearCachedAsyncDataByPrefix(`${SETTINGS_DATA_CACHE_KEYS.adminUsers}:`);
    return refreshDirectoryData();
  }, [refreshDirectoryData]);

  useEffect(() => {
    if (!userManagementContext || oidcAuthenticationEnabled) {
      return;
    }

    const authentication = directoryQuery.authentication.filter((value) => value === "password" || value === "unavailable");
    if (
      authentication.length !== directoryQuery.authentication.length ||
      directoryQuery.oidcStates.length > 0 ||
      directoryQuery.roleSources.length > 0
    ) {
      replaceDirectoryQuery({ authentication, oidcStates: [], roleSources: [] });
    }
  }, [
    directoryQuery.authentication,
    directoryQuery.oidcStates.length,
    directoryQuery.roleSources.length,
    oidcAuthenticationEnabled,
    replaceDirectoryQuery,
    userManagementContext,
  ]);

  useEffect(() => {
    if (!mappingEditor.open || mappingEditor.mode !== "move") {
      setMappingTargetUsers([]);
      return;
    }

    let disposed = false;
    setMappingContextualError(null);
    setMappingTargetsLoading(true);
    void api
      .getUsers({
        q: mappingTargetQuery.trim() || undefined,
        states: ["active"],
        oidcStates: ["unlinked"],
        page: 1,
        pageSize: 100,
      })
      .then((response) => {
        if (!disposed) {
          setMappingContextualError(null);
          setMappingTargetUsers(
            response.items.filter((user) => user.is_active && !user.oidc && !user.pending_oidc && user.id !== mappingEditor.user?.id)
          );
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setMappingContextualError(getApiErrorMessage(error, "Available local accounts could not be loaded."));
          setMappingTargetUsers([]);
        }
      })
      .finally(() => {
        if (!disposed) {
          setMappingTargetsLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [mappingEditor.mode, mappingEditor.open, mappingEditor.user?.id, mappingTargetQuery]);

  const roleLabel = (role: UserRole) => {
    if (role === "admin") return t("settings.userManagement.adminRole");
    if (role === "viewer") return t("settings.userManagement.viewerRole");
    return t("settings.userManagement.editorRole");
  };

  const openMappingEditor = (user: AdminUser, mode: OidcMappingEditorMode) => {
    setMappingContextualError(null);
    setMappingFieldErrors({});
    setMappingActionError(null);
    setMappingTargetUser(null);
    setMappingEditor({
      open: true,
      mode,
      user,
      expectedUsername: user.pending_oidc?.expected_username ?? "",
    });
    setMappingTargetSearch("");
    setMappingTargetQuery("");
  };

  const closeMappingEditor = () => {
    setMappingEditor({ open: false, mode: "create", user: null, expectedUsername: "" });
    setMappingTargetSearch("");
    setMappingTargetQuery("");
    setMappingTargetUser(null);
    setMappingContextualError(null);
    setMappingFieldErrors({});
    setMappingActionError(null);
  };

  const handleMappingSubmit = async () => {
    const user = mappingEditor.user;
    if (!user || !oidcConfiguration) return;
    try {
      setMappingSubmitting(true);
      setMappingFieldErrors({});
      setMappingActionError(null);
      if (mappingEditor.mode === "move") {
        const targetUser = mappingTargetUser;
        if (!user.oidc || !targetUser) {
          setMappingFieldErrors({ targetUser: "Select an available local account." });
          return;
        }
        if (!targetUser.is_active || targetUser.oidc || targetUser.pending_oidc || targetUser.id === user.id) {
          setMappingFieldErrors({ targetUser: "Select an available local account." });
          return;
        }
        await api.moveOidcIdentity(user.oidc.identity_id, oidcConfiguration.identity_mapping_revision, targetUser.id);
      } else {
        if (!pendingOidcMappingsAllowed) {
          setMappingActionError("Confirm that the provider username claim is stable and unique before creating pending mappings.");
          return;
        }
        const expectedUsername = mappingEditor.expectedUsername.trim();
        if (!expectedUsername) {
          setMappingFieldErrors({ expectedUsername: "Provider username is required." });
          return;
        }
        if (mappingEditor.mode === "change") {
          await api.changeOidcIdentity(user.id, oidcConfiguration.identity_mapping_revision, expectedUsername);
        } else {
          await api.putPendingOidcMappings(oidcConfiguration.identity_mapping_revision, [
            { target_user_id: user.id, expected_username: expectedUsername },
          ]);
        }
      }
      setMappingEditor({ open: false, mode: "create", user: null, expectedUsername: "" });
      setMappingFieldErrors({});
      setMappingActionError(null);
      showNotification("OIDC mapping updated.", "success");
      await refreshDirectory();
    } catch (error: unknown) {
      setMappingActionError(getApiErrorMessage(error, "The OIDC mapping could not be updated."));
    } finally {
      setMappingSubmitting(false);
    }
  };

  const handleOidcConfirmation = async () => {
    if (!oidcConfiguration || !oidcConfirmation || oidcConfirmationSubmitting) return;
    const { user, action } = oidcConfirmation;
    setOidcConfirmationSubmitting(true);
    try {
      if (action === "cancel") {
        await api.cancelPendingOidcMapping(user.id, oidcConfiguration.identity_mapping_revision);
        showNotification("Pending OIDC mapping canceled.", "success");
      } else {
        await api.detachOidcIdentity(user.id, oidcConfiguration.identity_mapping_revision);
        showNotification("OIDC identity detached.", "success");
      }
      setOidcConfirmation(null);
      await refreshDirectory();
    } catch (error: unknown) {
      showNotification(
        getApiErrorMessage(
          error,
          action === "cancel" ? "The pending OIDC mapping could not be canceled." : "The OIDC identity could not be detached."
        ),
        "error"
      );
    } finally {
      setOidcConfirmationSubmitting(false);
    }
  };

  const openCreateDialog = () => {
    setSelectedUser(null);
    setFormState(DEFAULT_USER_FORM);
    setFieldErrors({});
    setSubmissionError(null);
    setShowInitialPassword(false);
    setEditorOpen(true);
  };

  const openEditDialog = (user: AdminUser) => {
    setSelectedUser(user);
    setFormState({
      username: user.username,
      name: user.name ?? "",
      email: user.email ?? "",
      role: user.role,
      oidcRoleAssignment: user.oidc_role_assignment ?? "",
      isActive: user.is_active,
      password: "",
      mustChangePassword: user.must_change_password,
      expiresAt: toDateTimeLocalValue(user.expires_at),
    });
    setFieldErrors({});
    setSubmissionError(null);
    setShowInitialPassword(false);
    setEditorOpen(true);
  };

  const closeUserActionsMenu = () => {
    setUserActionsMenu({ anchor: null, user: null });
  };

  const closeEditor = useCallback(() => {
    setEditorOpen(false);
    setSelectedUser(null);
    setFormState(DEFAULT_USER_FORM);
    setFieldErrors({});
    setSubmissionError(null);
    setShowInitialPassword(false);
  }, []);

  const handleSave = useCallback(async () => {
    const username = formState.username.trim();
    const name = formState.name.trim();
    const email = formState.email.trim().toLowerCase();
    if (!username) {
      setFieldErrors({ username: t("settings.userManagement.notifications.usernameRequired") });
      setSubmissionError(null);
      requestAnimationFrame(() => {
        document.getElementById(USER_EDITOR_IDS.username)?.focus();
      });
      return;
    }
    if (users.some((user) => user.id !== selectedUser?.id && user.username === username)) {
      setFieldErrors({ username: t("settings.userManagement.editor.usernameTaken") });
      setSubmissionError(null);
      requestAnimationFrame(() => {
        document.getElementById(USER_EDITOR_IDS.username)?.focus();
      });
      return;
    }

    const expiresAt = toIsoDateTimeValue(formState.expiresAt);

    try {
      setSubmitting(true);
      setFieldErrors({});
      setSubmissionError(null);

      if (selectedUser) {
        const updatePayload: AdminUserUpdateInput = {
          username,
          ...(!hasOidcManagedIdentity ? { name: name || undefined, email: email || undefined } : {}),
          role: formState.role,
          ...(hasOidcRoleAssignment ? { oidc_role_assignment: formState.oidcRoleAssignment || null } : {}),
          is_active: formState.isActive,
          expires_at: expiresAt ?? null,
        };
        await api.updateUser(selectedUser.id, updatePayload);
        showNotification(t("settings.userManagement.notifications.userUpdated"), "success");
      } else {
        const createPayload: AdminUserCreateInput = {
          username,
          name: name || undefined,
          email: email || undefined,
          role: formState.role,
          must_change_password: formState.mustChangePassword,
          password: formState.password.trim() ? formState.password : undefined,
          expires_at: expiresAt,
        };
        const result: AdminUserCreateResult = await api.createUser(createPayload);
        showNotification(t("settings.userManagement.notifications.userCreated"), "success");
        if (result.temporary_password) {
          setCredentialsDialog({
            open: true,
            title: t("settings.userManagement.credentialsDialog.createTitle"),
            username: result.username,
            temporaryPassword: result.temporary_password,
            description: t("settings.userManagement.credentialsDialog.createDescription"),
          });
        }
      }

      closeEditor();
      await refreshDirectory();
    } catch (error: unknown) {
      const message = getApiErrorMessage(
        error,
        isEditing ? t("settings.userManagement.notifications.updateFailed") : t("settings.userManagement.notifications.createFailed")
      );
      setSubmissionError(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    closeEditor,
    formState,
    hasOidcManagedIdentity,
    hasOidcRoleAssignment,
    isEditing,
    refreshDirectory,
    selectedUser,
    showNotification,
    t,
    users,
  ]);

  const handleEditorKeyDown = useMemo(
    () =>
      dialogEnterKeyHandler(() => {
        void handleSave();
      }),
    [handleSave]
  );

  const handleEditorClose = useCallback(() => {
    closeEditor();
  }, [closeEditor]);

  const openResetPasswordDialog = (user: AdminUser) => {
    setSelectedUser(user);
    setResetPasswordForm(DEFAULT_RESET_PASSWORD_FORM);
    setResetPasswordError(null);
    setShowResetPassword(false);
    setResetPasswordEditorOpen(true);
  };

  const closeResetPasswordEditor = useCallback(() => {
    setResetPasswordEditorOpen(false);
    setResetPasswordForm(DEFAULT_RESET_PASSWORD_FORM);
    setResetPasswordError(null);
    setShowResetPassword(false);
    setSelectedUser(null);
  }, []);

  const handleResetPasswordEditorClose = useCallback(() => {
    closeResetPasswordEditor();
  }, [closeResetPasswordEditor]);

  const handleResetPassword = async () => {
    if (!selectedUser) {
      return;
    }

    if (!resetPasswordForm.password.trim()) {
      setResetPasswordError(t("settings.userManagement.resetPasswordEditor.passwordRequired"));
      return;
    }

    try {
      setResetPasswordSubmitting(true);
      setResetPasswordError(null);
      const result: AdminUserPasswordResetResult = await api.resetUserPassword(selectedUser.id, {
        new_password: resetPasswordForm.password,
        must_change_password: resetPasswordForm.mustChangePassword,
      });
      closeResetPasswordEditor();
      showNotification(result.message, "success");
      await refreshDirectory();
    } catch (error: unknown) {
      const message = getApiErrorMessage(error, t("settings.userManagement.notifications.resetFailed"));
      setResetPasswordError(message);
    } finally {
      setResetPasswordSubmitting(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) {
      return;
    }

    try {
      setDeleteSubmitting(true);
      await api.deleteUser(selectedUser.id);
      showNotification(t("settings.userManagement.notifications.userDeleted"), "success");
      setDeleteDialogOpen(false);
      setSelectedUser(null);
      await refreshDirectory();
    } catch (error: unknown) {
      const message = getApiErrorMessage(error, t("settings.userManagement.notifications.deleteFailed"));
      showNotification(message, "error");
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const editorActions = (
    <Box sx={adminDialogEndActionRowSx}>
      <Button
        onClick={closeEditor}
        disabled={submitting}
        variant="outlined"
        sx={combineSx(settingsUtilityButtonSx, adminDialogActionButtonSx)}
      >
        {t("common.actions.cancel")}
      </Button>
      <Button
        onClick={handleSave}
        variant="contained"
        disabled={submitting}
        startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : undefined}
        sx={combineSx(settingsPrimaryButtonSx, adminDialogActionButtonSx)}
      >
        {isEditing ? t("settings.userManagement.actions.saveChanges") : t("settings.userManagement.actions.createUser")}
      </Button>
    </Box>
  );

  const mappingEditorActions = (
    <Box sx={adminDialogEndActionRowSx}>
      <Button
        onClick={closeMappingEditor}
        disabled={mappingSubmitting}
        variant="outlined"
        sx={combineSx(settingsUtilityButtonSx, adminDialogActionButtonSx)}
      >
        Cancel
      </Button>
      <Button
        onClick={() => void handleMappingSubmit()}
        disabled={mappingSubmitting}
        variant="contained"
        startIcon={mappingSubmitting ? <CircularProgress size={18} color="inherit" /> : undefined}
        sx={combineSx(settingsPrimaryButtonSx, adminDialogActionButtonSx)}
      >
        Confirm
      </Button>
    </Box>
  );

  const renderDesktopLabel = (
    label: string,
    description: string,
    descriptionId: string,
    htmlFor?: string,
    required = false,
    id?: string,
    hasError = false
  ) =>
    usesDesktopFormLayout ? (
      <FormFieldLabel
        label={label}
        description={description}
        descriptionId={descriptionId}
        htmlFor={htmlFor}
        required={required}
        id={id}
        feedback={hasError ? { message: description, severity: "error" } : null}
      />
    ) : null;

  const renderOidcDetailsRow = (id: string, label: string, description: string, value: string, multiline = false) => (
    <FormRow>
      {renderDesktopLabel(label, description, `${id}-description`, id)}
      <Box sx={formFieldControlSx}>
        <DialogReadOnlyField
          id={id}
          label={usesDesktopFormLayout ? undefined : label}
          ariaLabel={usesDesktopFormLayout ? label : undefined}
          ariaDescribedBy={usesDesktopFormLayout ? `${id}-description` : undefined}
          value={value}
          multiline={multiline}
          minRows={multiline ? 2 : undefined}
          size={usesDesktopFormLayout ? "small" : "medium"}
        />
      </Box>
    </FormRow>
  );

  const editorContent = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {submissionError && <SettingsInlineAlert sx={{ mb: 0 }}>{submissionError}</SettingsInlineAlert>}
      <FormSurface testId="user-editor-form-surface">
        <FormGroup edge="start" testId="user-editor-identity-fields">
          <FormRow>
            {renderDesktopLabel(
              t("settings.userManagement.editor.usernameLabel"),
              fieldErrors.username || t("settings.userManagement.editor.usernameHelp"),
              USER_EDITOR_IDS.usernameDescription,
              USER_EDITOR_IDS.username,
              true,
              undefined,
              Boolean(fieldErrors.username)
            )}
            <Box sx={formFieldControlSx}>
              <TextField
                id={USER_EDITOR_IDS.username}
                label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.usernameLabel")}
                hiddenLabel={usesDesktopFormLayout}
                value={formState.username}
                onChange={(event) => {
                  const nextUsername = event.target.value;
                  setFormState((current) => ({ ...current, username: nextUsername }));
                  setFieldErrors(
                    users.some((user) => user.id !== selectedUser?.id && user.username === nextUsername.trim())
                      ? { username: t("settings.userManagement.editor.usernameTaken") }
                      : {}
                  );
                }}
                autoFocus
                error={Boolean(fieldErrors.username)}
                helperText={usesDesktopFormLayout ? undefined : fieldErrors.username || t("settings.userManagement.editor.usernameHelp")}
                fullWidth
                required
                variant="outlined"
                size={usesDesktopFormLayout ? "small" : "medium"}
                sx={formOutlinedControlSx}
                slotProps={{
                  htmlInput: { "aria-describedby": usesDesktopFormLayout ? USER_EDITOR_IDS.usernameDescription : undefined },
                }}
              />
            </Box>
          </FormRow>
          <FormRow>
            {renderDesktopLabel(
              t("settings.userManagement.editor.nameLabel"),
              hasOidcManagedIdentity ? t("settings.userManagement.editor.oidcNameHelp") : t("settings.userManagement.editor.nameHelp"),
              USER_EDITOR_IDS.nameDescription,
              USER_EDITOR_IDS.name
            )}
            <Box sx={formFieldControlSx}>
              {hasOidcManagedIdentity ? (
                <>
                  <DialogReadOnlyField
                    id={USER_EDITOR_IDS.name}
                    label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.nameLabel")}
                    ariaLabel={usesDesktopFormLayout ? t("settings.userManagement.editor.nameLabel") : undefined}
                    ariaDescribedBy={usesDesktopFormLayout ? USER_EDITOR_IDS.nameDescription : undefined}
                    value={formState.name}
                    size={usesDesktopFormLayout ? "small" : "medium"}
                  />
                  {!usesDesktopFormLayout && <FormHelperText>{t("settings.userManagement.editor.oidcNameHelp")}</FormHelperText>}
                </>
              ) : (
                <TextField
                  id={USER_EDITOR_IDS.name}
                  label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.nameLabel")}
                  hiddenLabel={usesDesktopFormLayout}
                  value={formState.name}
                  onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
                  helperText={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.nameHelp")}
                  fullWidth
                  variant="outlined"
                  size={usesDesktopFormLayout ? "small" : "medium"}
                  sx={formOutlinedControlSx}
                  slotProps={{ htmlInput: { "aria-describedby": usesDesktopFormLayout ? USER_EDITOR_IDS.nameDescription : undefined } }}
                />
              )}
            </Box>
          </FormRow>
          <FormRow>
            {renderDesktopLabel(
              t("settings.userManagement.editor.emailLabel"),
              hasOidcManagedIdentity ? t("settings.userManagement.editor.oidcEmailHelp") : t("settings.userManagement.editor.emailHelp"),
              USER_EDITOR_IDS.emailDescription,
              USER_EDITOR_IDS.email
            )}
            <Box sx={formFieldControlSx}>
              {hasOidcManagedIdentity ? (
                <>
                  <DialogReadOnlyField
                    id={USER_EDITOR_IDS.email}
                    label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.emailLabel")}
                    ariaLabel={usesDesktopFormLayout ? t("settings.userManagement.editor.emailLabel") : undefined}
                    ariaDescribedBy={usesDesktopFormLayout ? USER_EDITOR_IDS.emailDescription : undefined}
                    value={formState.email}
                    size={usesDesktopFormLayout ? "small" : "medium"}
                  />
                  {!usesDesktopFormLayout && <FormHelperText>{t("settings.userManagement.editor.oidcEmailHelp")}</FormHelperText>}
                </>
              ) : (
                <TextField
                  id={USER_EDITOR_IDS.email}
                  label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.emailLabel")}
                  hiddenLabel={usesDesktopFormLayout}
                  type="email"
                  value={formState.email}
                  onChange={(event) => setFormState((current) => ({ ...current, email: event.target.value }))}
                  helperText={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.emailHelp")}
                  fullWidth
                  variant="outlined"
                  size={usesDesktopFormLayout ? "small" : "medium"}
                  sx={formOutlinedControlSx}
                  slotProps={{ htmlInput: { "aria-describedby": usesDesktopFormLayout ? USER_EDITOR_IDS.emailDescription : undefined } }}
                />
              )}
            </Box>
          </FormRow>
        </FormGroup>
        <SettingsFormSection title={t("settings.userManagement.editor.sections.access")} />
        <FormGroup edge={isEditing ? "end" : "none"}>
          <FormRow>
            {renderDesktopLabel(
              t("settings.userManagement.editor.roleLabel"),
              hasOidcRoleAssignment
                ? t(
                    canUseInheritedOidcRole
                      ? "settings.userManagement.editor.oidcRoleHelp"
                      : "settings.userManagement.editor.oidcRoleUnavailableHelp"
                  )
                : t("settings.userManagement.editor.roleHelp"),
              USER_EDITOR_IDS.roleDescription,
              undefined,
              false,
              USER_EDITOR_IDS.roleLabel
            )}
            <FormControl
              fullWidth={!usesDesktopFormLayout}
              variant="outlined"
              size={usesDesktopFormLayout ? "small" : "medium"}
              sx={usesDesktopFormLayout ? [formOutlinedControlSx, formSelectControlSx] : formOutlinedControlSx}
            >
              {!usesDesktopFormLayout && (
                <InputLabel id={USER_EDITOR_IDS.roleLabel}>{t("settings.userManagement.editor.roleLabel")}</InputLabel>
              )}
              <Select
                id={USER_EDITOR_IDS.role}
                labelId={USER_EDITOR_IDS.roleLabel}
                aria-describedby={usesDesktopFormLayout ? USER_EDITOR_IDS.roleDescription : undefined}
                label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.roleLabel")}
                value={
                  hasOidcRoleAssignment && canUseInheritedOidcRole
                    ? formState.oidcRoleAssignment || OIDC_INHERITED_ROLE_VALUE
                    : formState.role
                }
                size={usesDesktopFormLayout ? "small" : "medium"}
                sx={formSelectSx}
                MenuProps={formSelectMenuProps}
                disabled={isEditingSelf}
                onChange={(event) => {
                  const selectedRole = event.target.value as UserRole | typeof OIDC_INHERITED_ROLE_VALUE;
                  setFormState((current) => ({
                    ...current,
                    role: selectedRole === OIDC_INHERITED_ROLE_VALUE ? (inheritedOidcRole ?? current.role) : selectedRole,
                    oidcRoleAssignment: hasOidcRoleAssignment
                      ? selectedRole === OIDC_INHERITED_ROLE_VALUE
                        ? ""
                        : selectedRole
                      : current.oidcRoleAssignment,
                  }));
                }}
                renderValue={(selected) => {
                  if (selected === OIDC_INHERITED_ROLE_VALUE) {
                    return t("settings.userManagement.editor.inheritedRole", { role: roleLabel(inheritedOidcRole as UserRole) });
                  }
                  return roleLabel(selected as UserRole);
                }}
              >
                {hasOidcRoleAssignment && canUseInheritedOidcRole && (
                  <SettingsSelectMenuItem
                    value={OIDC_INHERITED_ROLE_VALUE}
                    label={t("settings.userManagement.editor.inheritedRole", { role: roleLabel(inheritedOidcRole) })}
                    description={t("settings.userManagement.editor.inheritedRoleDescription")}
                  />
                )}
                <SettingsSelectMenuItem
                  value="editor"
                  label={t("settings.userManagement.editorRole")}
                  description={t("settings.userManagement.editor.roleOptions.editor")}
                />
                <SettingsSelectMenuItem
                  value="viewer"
                  label={t("settings.userManagement.viewerRole")}
                  description={t("settings.userManagement.editor.roleOptions.viewer")}
                />
                <SettingsSelectMenuItem
                  value="admin"
                  label={t("settings.userManagement.adminRole")}
                  description={t("settings.userManagement.editor.roleOptions.admin")}
                />
              </Select>
              {!usesDesktopFormLayout && (
                <FormHelperText>
                  {hasOidcRoleAssignment
                    ? t(
                        canUseInheritedOidcRole
                          ? "settings.userManagement.editor.oidcRoleHelp"
                          : "settings.userManagement.editor.oidcRoleUnavailableHelp"
                      )
                    : t("settings.userManagement.editor.roleHelp")}
                </FormHelperText>
              )}
            </FormControl>
          </FormRow>
          <FormRow>
            {renderDesktopLabel(
              t("settings.userManagement.editor.expiresAtLabel"),
              t("settings.userManagement.editor.expiresAtHelp"),
              USER_EDITOR_IDS.expiresAtDescription,
              USER_EDITOR_IDS.expiresAt
            )}
            <Box sx={[formFieldControlSx, { maxWidth: { md: 260 } }]}>
              <TextField
                id={USER_EDITOR_IDS.expiresAt}
                label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.expiresAtLabel")}
                hiddenLabel={usesDesktopFormLayout}
                type="datetime-local"
                value={formState.expiresAt}
                onChange={(event) => setFormState((current) => ({ ...current, expiresAt: event.target.value }))}
                fullWidth
                variant="outlined"
                size={usesDesktopFormLayout ? "small" : "medium"}
                helperText={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.expiresAtHelp")}
                sx={formOutlinedControlSx}
                slotProps={{
                  inputLabel: { shrink: true },
                  htmlInput: { "aria-describedby": usesDesktopFormLayout ? USER_EDITOR_IDS.expiresAtDescription : undefined },
                }}
              />
            </Box>
          </FormRow>
          {isEditing && (
            <FormRow>
              {renderDesktopLabel(
                t("settings.userManagement.editor.accountActiveLabel"),
                t("settings.userManagement.editor.accountActiveHelp"),
                USER_EDITOR_IDS.isActiveDescription,
                USER_EDITOR_IDS.isActive,
                false,
                USER_EDITOR_IDS.isActiveLabel
              )}
              <Box sx={formFieldControlSx}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1 }}>
                  {!usesDesktopFormLayout && (
                    <Typography id={USER_EDITOR_IDS.isActiveLabel} variant="body2" sx={{ mr: "auto" }}>
                      {t("settings.userManagement.editor.accountActiveLabel")}
                    </Typography>
                  )}
                  <Typography component="span" variant="body2" aria-live="polite">
                    {formState.isActive ? t("settings.userManagement.editor.switchOn") : t("settings.userManagement.editor.switchOff")}
                  </Typography>
                  <Switch
                    checked={formState.isActive}
                    disabled={isEditingSelf}
                    onChange={(event) => setFormState((current) => ({ ...current, isActive: event.target.checked }))}
                    slotProps={{
                      input: {
                        id: USER_EDITOR_IDS.isActive,
                        "aria-label": `${t("settings.userManagement.editor.accountActiveLabel")}: ${
                          formState.isActive ? t("settings.userManagement.editor.switchOn") : t("settings.userManagement.editor.switchOff")
                        }`,
                        "aria-describedby": USER_EDITOR_IDS.isActiveDescription,
                      },
                    }}
                  />
                </Box>
                {!usesDesktopFormLayout && <FormHelperText>{t("settings.userManagement.editor.accountActiveHelp")}</FormHelperText>}
              </Box>
            </FormRow>
          )}
        </FormGroup>
        {!isEditing && (
          <>
            <SettingsFormSection title={t("settings.userManagement.editor.sections.credentials")} />
            <FormGroup edge="end">
              <FormRow>
                {renderDesktopLabel(
                  t("settings.userManagement.editor.initialPasswordLabel"),
                  t("settings.userManagement.editor.initialPasswordHelp"),
                  USER_EDITOR_IDS.passwordDescription,
                  USER_EDITOR_IDS.password
                )}
                <Box sx={formFieldControlSx}>
                  <TextField
                    id={USER_EDITOR_IDS.password}
                    label={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.initialPasswordLabel")}
                    hiddenLabel={usesDesktopFormLayout}
                    type={showInitialPassword ? "text" : "password"}
                    value={formState.password}
                    onChange={(event) => setFormState((current) => ({ ...current, password: event.target.value }))}
                    helperText={usesDesktopFormLayout ? undefined : t("settings.userManagement.editor.initialPasswordHelp")}
                    fullWidth
                    variant="outlined"
                    size={usesDesktopFormLayout ? "small" : "medium"}
                    sx={formOutlinedControlSx}
                    slotProps={{
                      htmlInput: { "aria-describedby": usesDesktopFormLayout ? USER_EDITOR_IDS.passwordDescription : undefined },
                      input: {
                        endAdornment: (
                          <SettingsPasswordVisibilityToggle
                            visible={showInitialPassword}
                            onToggle={() => setShowInitialPassword((current) => !current)}
                            showLabel={t("settings.userManagement.editor.showInitialPassword")}
                            hideLabel={t("settings.userManagement.editor.hideInitialPassword")}
                          />
                        ),
                      },
                    }}
                  />
                </Box>
              </FormRow>
              <FormRow>
                {renderDesktopLabel(
                  t("settings.userManagement.editor.requirePasswordChangeLabel"),
                  t("settings.userManagement.editor.requirePasswordChangeHelp"),
                  USER_EDITOR_IDS.mustChangePasswordDescription,
                  USER_EDITOR_IDS.mustChangePassword,
                  false,
                  USER_EDITOR_IDS.mustChangePasswordLabel
                )}
                <Box sx={formFieldControlSx}>
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1 }}>
                    {!usesDesktopFormLayout && (
                      <Typography id={USER_EDITOR_IDS.mustChangePasswordLabel} variant="body2" sx={{ mr: "auto" }}>
                        {t("settings.userManagement.editor.requirePasswordChangeLabel")}
                      </Typography>
                    )}
                    <Typography component="span" variant="body2" aria-live="polite">
                      {formState.mustChangePassword
                        ? t("settings.userManagement.editor.switchOn")
                        : t("settings.userManagement.editor.switchOff")}
                    </Typography>
                    <Switch
                      checked={formState.mustChangePassword}
                      onChange={(event) => setFormState((current) => ({ ...current, mustChangePassword: event.target.checked }))}
                      slotProps={{
                        input: {
                          id: USER_EDITOR_IDS.mustChangePassword,
                          "aria-label": `${t("settings.userManagement.editor.requirePasswordChangeLabel")}: ${
                            formState.mustChangePassword
                              ? t("settings.userManagement.editor.switchOn")
                              : t("settings.userManagement.editor.switchOff")
                          }`,
                          "aria-describedby": USER_EDITOR_IDS.mustChangePasswordDescription,
                        },
                      }}
                    />
                  </Box>
                  {!usesDesktopFormLayout && (
                    <FormHelperText>{t("settings.userManagement.editor.requirePasswordChangeHelp")}</FormHelperText>
                  )}
                </Box>
              </FormRow>
            </FormGroup>
          </>
        )}
      </FormSurface>
    </Box>
  );

  const credentialsDialogActions = (
    <Box sx={adminDialogEndActionRowSx}>
      <Button
        onClick={() => setCredentialsDialog((current) => ({ ...current, open: false }))}
        variant="contained"
        sx={combineSx(settingsPrimaryButtonSx, adminDialogActionButtonSx)}
      >
        {t("settings.userManagement.actions.close")}
      </Button>
    </Box>
  );

  const credentialsDialogContent = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <TextField
        label={t("settings.userManagement.credentialsDialog.usernameLabel")}
        value={credentialsDialog.username}
        slotProps={{ input: { readOnly: true } }}
        fullWidth
        variant="outlined"
      />
      <TextField
        label={t("settings.userManagement.credentialsDialog.temporaryPasswordLabel")}
        value={credentialsDialog.temporaryPassword}
        slotProps={{ input: { readOnly: true } }}
        fullWidth
        variant="outlined"
      />
    </Box>
  );

  const resetPasswordEditorActions = (
    <Box sx={adminDialogEndActionRowSx}>
      <Button
        onClick={handleResetPasswordEditorClose}
        disabled={resetPasswordSubmitting}
        variant="outlined"
        sx={combineSx(settingsUtilityButtonSx, adminDialogActionButtonSx)}
      >
        {t("common.actions.cancel")}
      </Button>
      <Button
        onClick={() => {
          void handleResetPassword();
        }}
        variant="contained"
        disabled={resetPasswordSubmitting}
        startIcon={resetPasswordSubmitting ? <CircularProgress size={18} color="inherit" /> : undefined}
        sx={combineSx(settingsPrimaryButtonSx, adminDialogActionButtonSx)}
      >
        {t("settings.userManagement.resetPasswordEditor.submit")}
      </Button>
    </Box>
  );

  const resetPasswordEditorContent = (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {resetPasswordError && <SettingsInlineAlert sx={{ mb: 0 }}>{resetPasswordError}</SettingsInlineAlert>}
      <FormSurface testId="reset-password-editor-form-surface">
        <FormGroup edge="both">
          <FormRow sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
            <TextField
              label={t("settings.userManagement.resetPasswordEditor.passwordLabel")}
              type={showResetPassword ? "text" : "password"}
              value={resetPasswordForm.password}
              onChange={(event) => setResetPasswordForm((current) => ({ ...current, password: event.target.value }))}
              helperText={t("settings.userManagement.resetPasswordEditor.passwordHelp")}
              autoFocus
              inputRef={resetPasswordInputRef}
              fullWidth
              variant="outlined"
              sx={formOutlinedControlSx}
              slotProps={{
                input: {
                  endAdornment: (
                    <SettingsPasswordVisibilityToggle
                      visible={showResetPassword}
                      onToggle={() => setShowResetPassword((current) => !current)}
                      showLabel={t("settings.userManagement.resetPasswordEditor.showPassword")}
                      hideLabel={t("settings.userManagement.resetPasswordEditor.hidePassword")}
                    />
                  ),
                },
              }}
            />
          </FormRow>
          <FormRow sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1 }}>
              <Typography variant="body2" sx={{ mr: "auto" }}>
                {t("settings.userManagement.resetPasswordEditor.requirePasswordChangeLabel")}
              </Typography>
              <Typography component="span" variant="body2" aria-live="polite">
                {resetPasswordForm.mustChangePassword
                  ? t("settings.userManagement.editor.switchOn")
                  : t("settings.userManagement.editor.switchOff")}
              </Typography>
              <Switch
                checked={resetPasswordForm.mustChangePassword}
                onChange={(event) => setResetPasswordForm((current) => ({ ...current, mustChangePassword: event.target.checked }))}
                slotProps={{
                  input: {
                    "aria-label": `${t("settings.userManagement.resetPasswordEditor.requirePasswordChangeLabel")}: ${
                      resetPasswordForm.mustChangePassword
                        ? t("settings.userManagement.editor.switchOn")
                        : t("settings.userManagement.editor.switchOff")
                    }`,
                  },
                }}
              />
            </Box>
          </FormRow>
        </FormGroup>
      </FormSurface>
    </Box>
  );

  return (
    <SettingsPage
      category="admin-users"
      dialogSafeHeader={dialogSafeHeader}
      footerSecondaryActions={
        localPasswordManagementAvailable ? (
          <Button variant="outlined" startIcon={<AddIcon />} onClick={openCreateDialog} sx={settingsUtilityButtonSx}>
            {t("settings.userManagement.addUserButton")}
          </Button>
        ) : undefined
      }
    >
      <Stack
        ref={directoryContainerRef}
        spacing={2}
        sx={{ minWidth: 0, containerType: "inline-size", containerName: DIRECTORY_CONTAINER_NAME }}
      >
        {usernameConflicts.length > 0 && (
          <SettingsInlineAlert severity="warning" role="status" sx={{ mb: 0, overflowWrap: "anywhere" }}>
            <Typography variant="body2">
              {t("settings.userManagement.usernameConflicts", {
                defaultValue:
                  "These accounts have conflicting usernames. Password sign-in requires their exact spelling until an administrator renames or removes the duplicates.",
              })}
            </Typography>
            <Box component="ul" sx={{ my: 1, pl: 2 }}>
              {usernameConflicts.map((group) => (
                <li key={JSON.stringify(group)}>
                  {group.map((username, index) => (
                    <span key={username}>
                      {index > 0 && ", "}
                      <bdi>{username}</bdi>
                    </span>
                  ))}
                </li>
              ))}
            </Box>
          </SettingsInlineAlert>
        )}
        <Stack aria-label="Directory overview" direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Chip
            label={t("settings.userManagement.totalUsers", { count: directorySummary.total })}
            size="small"
            variant="outlined"
            sx={settingsMetadataChipSx}
          />
          <Chip
            label={t("settings.userManagement.activeAdmins", { count: activeAdminCount })}
            size="small"
            variant="outlined"
            sx={settingsMetadataChipSx}
          />
          <Chip label={`Disabled: ${directorySummary.disabled}`} size="small" variant="outlined" sx={settingsMetadataChipSx} />
          <Chip label={`Expiring: ${directorySummary.expiring_soon}`} size="small" variant="outlined" sx={settingsMetadataChipSx} />
          {oidcAuthenticationEnabled && (
            <Chip label={`OIDC pending: ${directorySummary.pending_oidc}`} size="small" variant="outlined" sx={settingsMetadataChipSx} />
          )}
        </Stack>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: 1,
            alignItems: "center",
            [DIRECTORY_WIDE_QUERY]: { gridTemplateColumns: "minmax(12rem, 20rem) minmax(0, 1fr)" },
          }}
        >
          <TextField
            label="Search users"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            size="small"
            sx={[DIRECTORY_SECONDARY_CONTROL_SX, { minWidth: 0, width: "100%" }]}
          />
          <Stack
            direction="row"
            spacing={1}
            sx={{
              justifyContent: "space-between",
              minWidth: 0,
              width: "100%",
            }}
          >
            <Stack direction="row" spacing={1}>
              <Button
                aria-haspopup="dialog"
                aria-expanded={Boolean(filterAnchor)}
                startIcon={<FilterListIcon />}
                variant="outlined"
                onClick={(event) => setFilterAnchor(event.currentTarget)}
                sx={combineSx(settingsUtilityButtonSx, { fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE, width: "fit-content" })}
              >
                {activeDirectoryFilterCount ? `Filters (${activeDirectoryFilterCount})` : "Filters"}
              </Button>
              <Button
                aria-hidden={activeDirectoryFilterCount === 0}
                onClick={clearDirectoryFilters}
                tabIndex={activeDirectoryFilterCount === 0 ? -1 : undefined}
                variant="text"
                sx={{
                  fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE,
                  minWidth: 104,
                  visibility: activeDirectoryFilterCount > 0 ? "visible" : "hidden",
                }}
              >
                Clear filters
              </Button>
            </Stack>
            <Button
              ref={toolbarColumnsRef}
              aria-expanded={columnsMenuOpen}
              aria-haspopup="menu"
              aria-controls={columnsMenuOpen ? columnsMenuId : undefined}
              aria-label="Columns"
              variant="text"
              startIcon={<ViewWeekIcon />}
              onClick={() => setColumnsMenuOpen(true)}
              sx={{
                color: "text.secondary",
                fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE,
                minWidth: 0,
                flexShrink: 0,
                whiteSpace: "nowrap",
                [DIRECTORY_WIDE_QUERY]: { display: !loading && users.length > 0 ? "none" : "inline-flex" },
              }}
            >
              Columns
            </Button>
          </Stack>
        </Box>
        <Menu
          action={columnsMenuActionsRef}
          anchorEl={getColumnsAnchor}
          aria-label="Directory columns"
          disableRestoreFocus
          onClose={() => setColumnsMenuOpen(false)}
          open={columnsMenuOpen}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
          slotProps={{
            list: { id: columnsMenuId },
            transition: { onExited: () => getColumnsAnchor()?.focus() },
          }}
        >
          {availableDirectoryColumns.map((column) => {
            const isVisible = visibleDirectoryColumns.includes(column);
            return (
              <MenuItem key={column} aria-checked={isVisible} onClick={() => toggleDirectoryColumn(column)} role="menuitemcheckbox">
                <ListItemIcon sx={DIRECTORY_COLUMN_MENU_ICON_SX}>
                  <Checkbox checked={isVisible} sx={{ p: 0 }} tabIndex={-1} />
                </ListItemIcon>
                <ListItemText primary={DIRECTORY_COLUMN_LABELS[column]} />
              </MenuItem>
            );
          })}
          <MenuItem onClick={resetDirectoryColumns}>
            <ListItemIcon sx={DIRECTORY_COLUMN_MENU_ICON_SX}>
              <RestartAltIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Reset columns" />
          </MenuItem>
        </Menu>
        <Box aria-live="polite" sx={{ height: 3 }}>
          {directoryRefreshing && <LinearProgress aria-label="Updating user directory" sx={{ height: 3 }} />}
        </Box>
        <Popover
          open={Boolean(filterAnchor)}
          anchorEl={filterAnchor}
          onClose={() => setFilterAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          transformOrigin={{ vertical: "top", horizontal: "left" }}
          slotProps={{ paper: { sx: { width: "min(480px, calc(100vw - 32px))", p: 2 } } }}
        >
          <Stack spacing={2}>
            <Typography variant="subtitle2">Filters</Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", sm: "repeat(2, minmax(0, 1fr))" }, gap: 2 }}>
              <Stack spacing={1}>
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
                  Account
                </Typography>
                <DirectoryFilterSelect
                  label="Role"
                  options={[
                    { value: "admin", label: t("settings.userManagement.adminRole") },
                    { value: "editor", label: t("settings.userManagement.editorRole") },
                    { value: "viewer", label: t("settings.userManagement.viewerRole") },
                  ]}
                  values={directoryQuery.roles}
                  onChange={(roles) => updateDirectoryQuery({ roles })}
                />
                <DirectoryFilterSelect
                  label="Status"
                  options={[
                    { value: "active", label: t("settings.userManagement.activeStatus") },
                    { value: "disabled", label: t("settings.userManagement.disabledStatus") },
                    { value: "expired", label: "Expired" },
                    { value: "expiring_soon", label: "Expiring soon" },
                  ]}
                  values={directoryQuery.states}
                  onChange={(states) => updateDirectoryQuery({ states })}
                />
                <FormControl size="small" fullWidth sx={DIRECTORY_SECONDARY_CONTROL_SX}>
                  <InputLabel>Expiration</InputLabel>
                  <Select
                    value={directoryQuery.expiration}
                    label="Expiration"
                    onChange={(event) => updateDirectoryQuery({ expiration: event.target.value as DirectoryQueryState["expiration"] })}
                  >
                    <MenuItem value="" sx={{ fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE }}>
                      Any expiration
                    </MenuItem>
                    <MenuItem value="has_expiration" sx={{ fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE }}>
                      Has expiration
                    </MenuItem>
                    <MenuItem value="no_expiration" sx={{ fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE }}>
                      No expiration
                    </MenuItem>
                  </Select>
                </FormControl>
              </Stack>
              <Stack spacing={1}>
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
                  Sign-in
                </Typography>
                <DirectoryFilterSelect
                  label="Sign-in method"
                  options={
                    oidcAuthenticationEnabled
                      ? [
                          { value: "password", label: "Password" },
                          { value: "oidc", label: "OIDC" },
                          { value: "password_and_oidc", label: "Password + OIDC" },
                          { value: "unavailable", label: "Unavailable" },
                        ]
                      : [
                          { value: "password", label: "Password" },
                          { value: "unavailable", label: "Unavailable" },
                        ]
                  }
                  values={directoryQuery.authentication}
                  onChange={(authentication) => updateDirectoryQuery({ authentication })}
                />
                {oidcAuthenticationEnabled && (
                  <>
                    <DirectoryFilterSelect
                      label="OIDC state"
                      options={[
                        { value: "linked", label: "Linked" },
                        { value: "pending", label: "Setup pending" },
                        { value: "unlinked", label: "Unlinked" },
                      ]}
                      values={directoryQuery.oidcStates}
                      onChange={(oidcStates) => updateDirectoryQuery({ oidcStates })}
                    />
                    <DirectoryFilterSelect
                      label="Role source"
                      options={[
                        { value: "local_assignment", label: "Local assignment" },
                        { value: "individual_override", label: "Individual override" },
                        { value: "oidc_default", label: "OIDC default" },
                        { value: "oidc_groups", label: "OIDC groups" },
                        { value: "awaiting_oidc_sign_in", label: "Awaiting OIDC sign-in" },
                      ]}
                      values={directoryQuery.roleSources}
                      onChange={(roleSources) => updateDirectoryQuery({ roleSources })}
                    />
                  </>
                )}
              </Stack>
            </Box>
          </Stack>
        </Popover>
        {activeDirectoryFilterCount > 0 && (
          <Stack aria-label="Active filters" direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            {directoryQuery.roles.map((role) => (
              <Chip
                key={role}
                label={`Role: ${roleLabel(role)}`}
                onDelete={() => updateDirectoryQuery({ roles: directoryQuery.roles.filter((value) => value !== role) })}
                size="small"
                tabIndex={-1}
                variant="outlined"
              />
            ))}
            {directoryQuery.states.map((state) => (
              <Chip
                key={state}
                label={state === "expiring_soon" ? "Expiring soon" : `Status: ${state.slice(0, 1).toUpperCase() + state.slice(1)}`}
                onDelete={() => updateDirectoryQuery({ states: directoryQuery.states.filter((value) => value !== state) })}
                size="small"
                tabIndex={-1}
                variant="outlined"
              />
            ))}
            {directoryQuery.authentication.map((authentication) => (
              <Chip
                key={authentication}
                label={
                  authentication === "password_and_oidc"
                    ? "Password + OIDC"
                    : `Sign-in: ${authentication.slice(0, 1).toUpperCase() + authentication.slice(1)}`
                }
                onDelete={() =>
                  updateDirectoryQuery({ authentication: directoryQuery.authentication.filter((value) => value !== authentication) })
                }
                size="small"
                tabIndex={-1}
                variant="outlined"
              />
            ))}
            {oidcAuthenticationEnabled &&
              directoryQuery.oidcStates.map((oidcState) => (
                <Chip
                  key={oidcState}
                  label={`OIDC: ${oidcState === "pending" ? "Pending" : oidcState.slice(0, 1).toUpperCase() + oidcState.slice(1)}`}
                  onDelete={() => updateDirectoryQuery({ oidcStates: directoryQuery.oidcStates.filter((value) => value !== oidcState) })}
                  size="small"
                  tabIndex={-1}
                  variant="outlined"
                />
              ))}
            {oidcAuthenticationEnabled &&
              directoryQuery.roleSources.map((roleSource) => (
                <Chip
                  key={roleSource}
                  label={getCompactRoleSource(roleSource)}
                  onDelete={() => updateDirectoryQuery({ roleSources: directoryQuery.roleSources.filter((value) => value !== roleSource) })}
                  size="small"
                  tabIndex={-1}
                  variant="outlined"
                />
              ))}
            {directoryQuery.expiration && (
              <Chip
                label={directoryQuery.expiration === "has_expiration" ? "Has expiration" : "No expiration"}
                onDelete={() => updateDirectoryQuery({ expiration: "" })}
                size="small"
                tabIndex={-1}
                variant="outlined"
              />
            )}
          </Stack>
        )}
        {loading ? (
          <SettingsLoadingState />
        ) : users.length === 0 ? (
          <SettingsEmptyState
            title={directorySummary.total === 0 ? t("settings.userManagement.emptyTitle") : "No matching users"}
            description={
              directorySummary.total === 0
                ? t("settings.userManagement.emptyDescription")
                : "Adjust or clear the current search and filters."
            }
          />
        ) : (
          <Box
            role="table"
            aria-label="Users"
            sx={{
              minWidth: 0,
              px: 0.75,
              py: 0.5,
              "& [data-directory-cell] .MuiTypography-root": {
                minWidth: 0,
                maxWidth: "100%",
                whiteSpace: "normal",
                overflowWrap: "anywhere",
              },
              "& [data-directory-cell] > .MuiStack-root": { alignItems: "flex-start" },
              "& [data-directory-cell] > .MuiTypography-body2 > span, & [data-directory-cell] .MuiTypography-caption": {
                display: "inline",
              },
              [DIRECTORY_WIDE_QUERY]: {
                "& [data-directory-cell] > .MuiTypography-body2 > span, & [data-directory-cell] .MuiTypography-caption": {
                  display: "none",
                },
              },
            }}
          >
            <Box
              role="row"
              data-testid="user-directory-header"
              sx={{
                ...directoryRowGridSx,
                display: { xs: "none" },
                px: 0,
                py: 0.75,
                borderBottom: 1,
                borderColor: "divider",
              }}
            >
              <DirectoryColumnHeader
                label="User"
                sort="username"
                activeSort={directoryQuery.sort}
                direction={directoryQuery.direction}
                onSort={handleDirectorySort}
              />
              {visibleDirectoryColumns.includes("role") && (
                <DirectoryColumnHeader
                  label="Role"
                  sort="role"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("status") && (
                <DirectoryColumnHeader
                  label="Status"
                  sort="status"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("signIn") && (
                <DirectoryColumnHeader
                  label="Sign-in"
                  sort="sign_in"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("lastSignIn") && (
                <DirectoryColumnHeader
                  label="Last OIDC sign-in"
                  sort="last_sign_in"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("expiration") && (
                <DirectoryColumnHeader
                  label="Expiration"
                  sort="expiration"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("email") && (
                <DirectoryColumnHeader
                  label="Email"
                  sort="email"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("createdAt") && (
                <DirectoryColumnHeader
                  label="Created"
                  sort="created_at"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("updatedAt") && (
                <DirectoryColumnHeader
                  label="Last updated"
                  sort="updated_at"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("oidcState") && (
                <DirectoryColumnHeader
                  label="OIDC state"
                  sort="oidc_state"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("roleSource") && (
                <DirectoryColumnHeader
                  label="Role source"
                  sort="role_source"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              {visibleDirectoryColumns.includes("oidcProvider") && (
                <DirectoryColumnHeader
                  label="OIDC provider"
                  sort="oidc_provider"
                  activeSort={directoryQuery.sort}
                  direction={directoryQuery.direction}
                  onSort={handleDirectorySort}
                />
              )}
              <Box role="columnheader" sx={{ display: "flex", justifyContent: "flex-end" }}>
                <Tooltip title="Manage visible columns">
                  <IconButton
                    ref={headerColumnsRef}
                    aria-expanded={columnsMenuOpen}
                    aria-haspopup="menu"
                    aria-controls={columnsMenuOpen ? columnsMenuId : undefined}
                    aria-label="Manage visible columns"
                    onClick={() => setColumnsMenuOpen(true)}
                    sx={{ color: "text.secondary", width: 28, height: 28, p: 0 }}
                  >
                    <ViewWeekIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>
            <List role="rowgroup" sx={{ py: 0 }}>
              {users.map((user) => {
                const isSelf = Boolean(currentUserId && user.id === currentUserId);
                const expiresAt = user.expires_at ? new Date(user.expires_at).getTime() : null;
                const isExpired = expiresAt !== null && expiresAt <= Date.now();
                const isExpiringSoon = expiresAt !== null && !isExpired && expiresAt <= Date.now() + 30 * 24 * 60 * 60 * 1000;
                const statuses = [
                  !user.is_active ? t("settings.userManagement.disabledStatus") : null,
                  isExpired ? "Expired" : null,
                  isExpiringSoon ? "Expiring soon" : null,
                  localPasswordManagementAvailable && user.must_change_password ? t("settings.userManagement.passwordResetPending") : null,
                  oidcAuthenticationEnabled && user.pending_oidc ? "OIDC pending" : null,
                  !user.has_local_password && !(oidcAuthenticationEnabled && user.oidc) ? "No sign-in method" : null,
                ].filter(Boolean);
                const authentication =
                  oidcAuthenticationEnabled && user.has_local_password && user.oidc
                    ? "Password + OIDC"
                    : oidcAuthenticationEnabled && user.oidc
                      ? "OIDC"
                      : user.has_local_password
                        ? "Password"
                        : "Unavailable";
                return (
                  <ListItem key={user.id} role="row" sx={{ px: 0, py: 1.25, borderBottom: 1, borderColor: "divider" }}>
                    <Box data-testid="user-row" sx={directoryRowGridSx}>
                      <DirectoryRowCell area="identity">
                        <Box data-testid="user-row-identity" sx={{ minWidth: 0 }}>
                          <Typography component="div" variant="body1" sx={settingsListItemTitleSx}>
                            {user.name?.trim() ? user.name : user.username}
                            {isSelf && ` ${t("settings.userManagement.currentUserSuffix")}`}
                          </Typography>
                          <Typography variant="body2" sx={{ color: "text.secondary" }}>
                            {[user.username, visibleDirectoryColumns.includes("email") ? null : user.email].filter(Boolean).join(" • ")}
                          </Typography>
                        </Box>
                      </DirectoryRowCell>
                      {visibleDirectoryColumns.includes("role") && (
                        <DirectoryRowCell area="role">
                          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: "center", minWidth: 0 }}>
                            <Typography
                              component="span"
                              variant="caption"
                              sx={{ display: { xs: "inline", md: "none" }, color: "text.secondary" }}
                            >
                              Role
                            </Typography>
                            <Typography data-testid="user-row-role" variant="body2" sx={{ color: "text.secondary" }}>
                              {roleLabel(user.role)}
                            </Typography>
                          </Stack>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("status") && (
                        <DirectoryRowCell area="status">
                          <Stack
                            direction="row"
                            spacing={1}
                            useFlexGap
                            sx={{ alignItems: "center", flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}
                          >
                            <Typography
                              component="span"
                              variant="caption"
                              sx={{ display: { xs: "inline", md: "none" }, color: "text.secondary" }}
                            >
                              Status
                            </Typography>
                            <Stack
                              data-testid="user-metadata"
                              direction="column"
                              spacing={0.5}
                              useFlexGap
                              sx={{ flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}
                            >
                              {(statuses.length ? statuses : [t("settings.userManagement.activeStatus")]).map((status) => (
                                <Typography
                                  key={status}
                                  variant="body2"
                                  sx={{ color: status === t("settings.userManagement.activeStatus") ? "text.secondary" : "warning.dark" }}
                                >
                                  {status}
                                </Typography>
                              ))}
                            </Stack>
                          </Stack>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("signIn") && (
                        <DirectoryRowCell area="signIn">
                          <Typography data-testid="user-row-sign-in" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Sign-in:
                            </Box>{" "}
                            {authentication}
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("lastSignIn") && (
                        <Tooltip title={user.oidc?.last_login_at ? formatLocalTimestamp(user.oidc.last_login_at) : "No OIDC sign-in"}>
                          <DirectoryRowCell area="lastSignIn">
                            <Typography
                              data-testid="user-row-last-oidc-sign-in"
                              variant="body2"
                              sx={{ color: "text.secondary", minWidth: 0 }}
                            >
                              <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                                Last OIDC sign-in:
                              </Box>{" "}
                              <DirectoryTimestamp value={user.oidc?.last_login_at} />
                            </Typography>
                          </DirectoryRowCell>
                        </Tooltip>
                      )}
                      {visibleDirectoryColumns.includes("expiration") && (
                        <DirectoryRowCell area="expiration">
                          <Typography data-testid="user-row-expiration" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Expiration:
                            </Box>{" "}
                            <DirectoryTimestamp value={user.expires_at} />
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("email") && (
                        <DirectoryRowCell area="email">
                          <Typography data-testid="user-row-email" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Email:
                            </Box>{" "}
                            {user.email ?? "Not set"}
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("createdAt") && (
                        <DirectoryRowCell area="createdAt">
                          <Typography data-testid="user-row-created" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Created:
                            </Box>{" "}
                            <DirectoryTimestamp value={user.created_at} />
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("updatedAt") && (
                        <DirectoryRowCell area="updatedAt">
                          <Typography data-testid="user-row-updated" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Last updated:
                            </Box>{" "}
                            <DirectoryTimestamp value={user.updated_at} />
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("oidcState") && (
                        <DirectoryRowCell area="oidcState">
                          <Typography data-testid="user-row-oidc-state" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              OIDC state:
                            </Box>{" "}
                            {getDirectoryOidcState(user)}
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("roleSource") && (
                        <DirectoryRowCell area="roleSource">
                          <Typography data-testid="user-row-role-source" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              Role source:
                            </Box>{" "}
                            {getDirectoryRoleSource(user, oidcConfiguration?.role_assignment_mode)}
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      {visibleDirectoryColumns.includes("oidcProvider") && (
                        <DirectoryRowCell area="oidcProvider">
                          <Typography data-testid="user-row-oidc-provider" variant="body2" sx={{ color: "text.secondary", minWidth: 0 }}>
                            <Box component="span" sx={{ display: { xs: "inline", md: "none" } }}>
                              OIDC provider:
                            </Box>{" "}
                            {user.oidc?.provider_display_name ?? "Not linked"}
                          </Typography>
                        </DirectoryRowCell>
                      )}
                      <DirectoryRowCell area="actions" align="end">
                        <Stack data-testid="user-row-actions" direction="row" spacing={0.5}>
                          <Tooltip title={t("settings.userManagement.actions.editUser")}>
                            <IconButton
                              aria-label={t("settings.userManagement.aria.editUser", { username: user.username })}
                              onClick={() => openEditDialog(user)}
                              sx={settingsUtilityIconButtonSx}
                            >
                              <EditIcon />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="User actions">
                            <IconButton
                              aria-label={`User actions for ${user.username}`}
                              onClick={(event) => setUserActionsMenu({ anchor: event.currentTarget, user })}
                              sx={settingsUtilityIconButtonSx}
                            >
                              <MoreVertIcon />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </DirectoryRowCell>
                    </Box>
                  </ListItem>
                );
              })}
            </List>
          </Box>
        )}
        {directorySummary.total > 0 && (
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <Typography
              variant="body2"
              color="text.secondary"
            >{`${(directoryQuery.page - 1) * directoryQuery.pageSize + 1}-${Math.min(directoryQuery.page * directoryQuery.pageSize, directorySummary.total)} of ${directorySummary.total}`}</Typography>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <FormControl size="small" sx={DIRECTORY_SECONDARY_CONTROL_SX}>
                <Select
                  value={String(directoryQuery.pageSize)}
                  onChange={(event) => updateDirectoryQuery({ pageSize: Number(event.target.value) }, true)}
                >
                  {DIRECTORY_PAGE_SIZE_OPTIONS.map((pageSize) => (
                    <MenuItem key={pageSize} value={String(pageSize)} sx={{ fontSize: DIRECTORY_SECONDARY_CONTROL_FONT_SIZE }}>
                      {pageSize} per page
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Pagination
                page={directoryQuery.page}
                count={Math.max(1, Math.ceil(directorySummary.total / directoryQuery.pageSize))}
                onChange={(_, page) => updateDirectoryQuery({ page }, false)}
                renderItem={(item) => <PaginationItem {...item} tabIndex={item.type === "page" ? -1 : undefined} />}
                size="small"
              />
            </Stack>
          </Stack>
        )}
      </Stack>

      <Menu anchorEl={userActionsMenu.anchor} open={Boolean(userActionsMenu.anchor)} onClose={closeUserActionsMenu}>
        {userActionsMenu.user && (
          <>
            {oidcAuthenticationEnabled && oidcConfiguration && !userActionsMenu.user.oidc && !userActionsMenu.user.pending_oidc && (
              <MenuItem
                disabled={!pendingOidcMappingsAllowed}
                onClick={() => {
                  const user = userActionsMenu.user;
                  closeUserActionsMenu();
                  if (user) openMappingEditor(user, "create");
                }}
              >
                <LinkIcon fontSize="small" sx={{ mr: 1.5 }} />
                Map OIDC account
              </MenuItem>
            )}
            {oidcAuthenticationEnabled && oidcConfiguration && userActionsMenu.user.pending_oidc && (
              <MenuItem
                onClick={() => {
                  const user = userActionsMenu.user;
                  closeUserActionsMenu();
                  if (user) setOidcConfirmation({ user, action: "cancel" });
                }}
              >
                <LinkOffIcon fontSize="small" sx={{ mr: 1.5 }} />
                Cancel pending OIDC mapping
              </MenuItem>
            )}
            {oidcAuthenticationEnabled && oidcConfiguration && userActionsMenu.user.oidc && (
              <>
                <MenuItem
                  onClick={() => {
                    const user = userActionsMenu.user;
                    closeUserActionsMenu();
                    if (user) setOidcDetailsUser(user);
                  }}
                >
                  <LinkIcon fontSize="small" sx={{ mr: 1.5 }} />
                  View OIDC identity details
                </MenuItem>
                <MenuItem
                  disabled={!pendingOidcMappingsAllowed}
                  onClick={() => {
                    const user = userActionsMenu.user;
                    closeUserActionsMenu();
                    if (user) openMappingEditor(user, "change");
                  }}
                >
                  <LinkIcon fontSize="small" sx={{ mr: 1.5 }} />
                  Change OIDC account
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    const user = userActionsMenu.user;
                    closeUserActionsMenu();
                    if (user) openMappingEditor(user, "move");
                  }}
                >
                  <MoreVertIcon fontSize="small" sx={{ mr: 1.5 }} />
                  Move identity to another local user
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    const user = userActionsMenu.user;
                    closeUserActionsMenu();
                    if (user) setOidcConfirmation({ user, action: "detach" });
                  }}
                >
                  <LinkOffIcon fontSize="small" sx={{ mr: 1.5 }} />
                  Detach OIDC identity
                </MenuItem>
              </>
            )}
            {localPasswordManagementAvailable && userActionsMenu.user.has_local_password && (
              <MenuItem
                onClick={() => {
                  const user = userActionsMenu.user;
                  closeUserActionsMenu();
                  if (user) openResetPasswordDialog(user);
                }}
              >
                <LockResetIcon fontSize="small" sx={{ mr: 1.5 }} />
                {t("settings.userManagement.actions.resetPassword")}
              </MenuItem>
            )}
            <MenuItem
              disabled={Boolean(currentUserId && userActionsMenu.user.id === currentUserId)}
              onClick={() => {
                const user = userActionsMenu.user;
                closeUserActionsMenu();
                if (user) {
                  setSelectedUser(user);
                  setDeleteDialogOpen(true);
                }
              }}
              sx={{ color: "error.main" }}
            >
              <DeleteIcon fontSize="small" sx={{ mr: 1.5 }} />
              {t("settings.userManagement.actions.deleteUser")}
            </MenuItem>
          </>
        )}
      </Menu>

      <ResponsiveDialogShell
        open={oidcConfirmation !== null}
        onClose={() => setOidcConfirmation(null)}
        disableClose={oidcConfirmationSubmitting}
        disableAutoFocus
        onTransitionEntered={() => oidcConfirmationCancelRef.current?.focus()}
        onKeyDown={dialogEnterKeyHandler()}
        title={oidcConfirmation?.action === "detach" ? "Detach OIDC identity?" : "Cancel pending OIDC mapping?"}
        description={
          oidcConfirmation?.action === "detach"
            ? `Detach the OIDC identity from ${oidcConfirmation.user.username}? This does not revoke IdP access.`
            : `Cancel the pending OIDC mapping for ${oidcConfirmation?.user.username ?? ""}?`
        }
        actions={
          <>
            <Button
              ref={oidcConfirmationCancelRef}
              variant="outlined"
              sx={settingsUtilityButtonSx}
              disabled={oidcConfirmationSubmitting}
              onClick={() => setOidcConfirmation(null)}
              onKeyDownCapture={dialogEnterKeyHandler()}
            >
              Cancel
            </Button>
            <Button variant="contained" color="error" disabled={oidcConfirmationSubmitting} onClick={() => void handleOidcConfirmation()}>
              {oidcConfirmation?.action === "detach" ? "Detach OIDC identity" : "Cancel pending OIDC mapping"}
            </Button>
          </>
        }
        maxWidth="xs"
      >
        {null}
      </ResponsiveDialogShell>

      <ResponsiveDialogShell
        open={oidcAuthenticationEnabled && oidcDetailsUser !== null}
        onClose={() => setOidcDetailsUser(null)}
        title={oidcDetailsUser ? `OIDC identity details for ${oidcDetailsUser.username}` : "OIDC identity details"}
        actions={
          <Box sx={adminDialogEndActionRowSx}>
            <Button
              onClick={() => setOidcDetailsUser(null)}
              variant="contained"
              sx={combineSx(settingsPrimaryButtonSx, adminDialogActionButtonSx)}
            >
              Close
            </Button>
          </Box>
        }
      >
        {oidcDetailsUser?.oidc && (
          <FormSurface testId="oidc-details-form-surface">
            <FormGroup edge="both">
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.provider,
                "Identity provider",
                "The configured sign-in provider for this identity",
                oidcDetailsUser.oidc.provider_display_name
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.issuer,
                "Issuer URL",
                "The unique URL that identifies this identity provider",
                oidcDetailsUser.oidc.issuer
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.subject,
                "IdP subject",
                "The IdP's stable unique identifier for this person",
                oidcDetailsUser.oidc.subject
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.lastSeenUsername,
                "IdP username",
                "The username most recently verified with the identity provider",
                oidcDetailsUser.oidc.last_seen_username ?? "None"
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.lastGroups,
                "IdP groups",
                "The groups most recently verified with the identity provider",
                oidcDetailsUser.oidc.last_groups.join("\n") || "None",
                true
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.createdAt,
                "Linked in Sambee",
                "When Sambee first linked this IdP identity to the account",
                formatLocalTimestamp(oidcDetailsUser.oidc.created_at)
              )}
              {renderOidcDetailsRow(
                OIDC_DETAILS_IDS.lastLoginAt,
                "Last successful OIDC sign-in",
                "The most recent sign-in verified with this identity",
                oidcDetailsUser.oidc.last_login_at ? formatLocalTimestamp(oidcDetailsUser.oidc.last_login_at) : "Never"
              )}
            </FormGroup>
          </FormSurface>
        )}
      </ResponsiveDialogShell>

      <ResponsiveDialogShell
        open={mappingEditor.open}
        onClose={closeMappingEditor}
        disableClose={mappingSubmitting}
        title={
          mappingEditor.mode === "move"
            ? "Move OIDC identity"
            : mappingEditor.mode === "change"
              ? "Change OIDC account"
              : "Map OIDC account"
        }
        description="Mapping does not override provider admission or role policy."
        contextualNotice={<DialogNotice message={mappingContextualError} testId="oidc-mapping-contextual-error" />}
        actionNotice={<DialogNotice message={mappingActionError} testId="oidc-mapping-action-error" />}
        actions={mappingEditorActions}
        onKeyDown={dialogEnterKeyHandler(() => {
          void handleMappingSubmit();
        })}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <FormSurface testId="oidc-mapping-editor-form-surface">
            <FormGroup edge="both">
              <FormRow sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
                {mappingEditor.mode === "move" ? (
                  <Autocomplete
                    autoHighlight
                    fullWidth
                    loading={mappingTargetsLoading}
                    options={mappingTargetUsers}
                    value={mappingTargetUser}
                    inputValue={mappingTargetSearch}
                    getOptionLabel={(user) => (user.name ? `${user.name} (${user.username})` : user.username)}
                    isOptionEqualToValue={(option, value) => option.id === value.id}
                    noOptionsText="No eligible local accounts match this search"
                    loadingText="Searching eligible local accounts..."
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (!mappingSubmitting) {
                          closeMappingEditor();
                        }
                      }
                    }}
                    onChange={(_, user) => {
                      setMappingTargetUser(user);
                      setMappingTargetSearch(user ? (user.name ? `${user.name} (${user.username})` : user.username) : "");
                      setMappingFieldErrors((current) => ({ ...current, targetUser: undefined }));
                    }}
                    onInputChange={(_, value, reason) => {
                      if (reason === "input" || reason === "clear") {
                        setMappingTargetSearch(value);
                        setMappingTargetQuery(value);
                        setMappingTargetUser(null);
                        setMappingFieldErrors((current) => ({ ...current, targetUser: undefined }));
                      }
                    }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        autoFocus
                        label="Move identity to"
                        error={Boolean(mappingFieldErrors.targetUser)}
                        helperText={
                          mappingFieldErrors.targetUser ?? "Search eligible active, unlinked local accounts by username, name, or email"
                        }
                        sx={formOutlinedControlSx}
                      />
                    )}
                  />
                ) : (
                  <TextField
                    autoFocus
                    fullWidth
                    label="Expected provider username"
                    value={mappingEditor.expectedUsername}
                    onChange={(event) => {
                      setMappingEditor((current) => ({ ...current, expectedUsername: event.target.value }));
                      setMappingFieldErrors((current) => ({ ...current, expectedUsername: undefined }));
                    }}
                    error={Boolean(mappingFieldErrors.expectedUsername)}
                    helperText={
                      mappingFieldErrors.expectedUsername ??
                      "The first admitted, unmapped OIDC identity with this exact username will claim the account."
                    }
                    sx={formOutlinedControlSx}
                  />
                )}
              </FormRow>
            </FormGroup>
          </FormSurface>
        </Box>
      </ResponsiveDialogShell>

      <ResponsiveDialogShell
        open={editorOpen}
        onClose={handleEditorClose}
        disableClose={submitting}
        title={isEditing ? t("settings.userManagement.editor.titleEdit") : t("settings.userManagement.editor.titleCreate")}
        actions={editorActions}
        onKeyDown={handleEditorKeyDown}
      >
        {editorContent}
      </ResponsiveDialogShell>

      <ResponsiveDialogShell
        open={resetPasswordEditorOpen}
        onClose={handleResetPasswordEditorClose}
        disableClose={resetPasswordSubmitting}
        title={t("settings.userManagement.resetPasswordEditor.title")}
        description={
          selectedUser
            ? t("settings.userManagement.resetPasswordEditor.descriptionWithName", { username: selectedUser.username })
            : t("settings.userManagement.resetPasswordEditor.descriptionFallback")
        }
        actions={resetPasswordEditorActions}
        onKeyDown={dialogEnterKeyHandler(() => {
          void handleResetPassword();
        })}
        onTransitionEntered={() => resetPasswordInputRef.current?.focus()}
      >
        {resetPasswordEditorContent}
      </ResponsiveDialogShell>

      <DeleteDialog
        open={deleteDialogOpen}
        onClose={() => {
          setDeleteDialogOpen(false);
          setSelectedUser(null);
        }}
        onConfirm={handleDeleteUser}
        submitting={deleteSubmitting}
        title={t("settings.userManagement.deleteDialog.title")}
        description={t("settings.userManagement.deleteDialog.descriptionFallback")}
        descriptionItemName={selectedUser?.username ?? null}
      />

      <ResponsiveDialogShell
        open={credentialsDialog.open}
        onClose={() => setCredentialsDialog((current) => ({ ...current, open: false }))}
        title={credentialsDialog.title}
        description={credentialsDialog.description}
        actions={credentialsDialogActions}
        maxWidth="xs"
      >
        {credentialsDialogContent}
      </ResponsiveDialogShell>

      <SettingsNotificationSnackbar
        notification={notification}
        onClose={() => setNotification((current) => ({ ...current, open: false }))}
      />
    </SettingsPage>
  );
}
