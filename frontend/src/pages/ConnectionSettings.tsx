import { SettingsActionBar } from "../components/Settings/SettingsActionBar";
//
// ConnectionSettings
//

import { Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon, MoreVert as MoreVertIcon } from "@mui/icons-material";
import { Box, Button, Divider, IconButton, ListItem, Menu, MenuItem, Tooltip, Typography, useMediaQuery, useTheme } from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ConnectionDialog from "../components/Admin/ConnectionDialog";
import DeleteDialog from "../components/Admin/DeleteDialog";
import { CompactBadge as Chip } from "../components/CompactBadge";
import { SettingsNotificationSnackbar, type SettingsNotificationState } from "../components/Settings/SettingsFeedback";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsList } from "../components/Settings/SettingsList";
import { SettingsSectionHeader } from "../components/Settings/SettingsSectionHeader";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsEmptyState, SettingsLoadingState } from "../components/Settings/SettingsState";
import {
  settingsDestructiveIconButtonSx,
  settingsMetadataChipSx,
  settingsUtilityButtonSx,
  settingsUtilityIconButtonSx,
} from "../components/Settings/settingsButtonStyles";
import { loadConnectionsSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { getSettingsPageSurfaceColor } from "../components/Settings/settingsSurface";
import { settingsListItemTitleSx } from "../components/Settings/settingsTypographyStyles";
import { useSettingsAccess } from "../components/Settings/useSettingsAccess";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import api from "../services/api";
import type { Connection } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

/**
 * ConnectionSettings
 *
 * Connection management content for admin users.
 * Used within SettingsLayout (no AppBar needed).
 * Responsive design: table on desktop, cards on mobile.
 */

interface ConnectionSettingsProps {
  isAdmin?: boolean;
  /** Callback when connections are added, updated, or deleted */
  onConnectionsChanged?: () => void;
  /**
   * Force desktop layout regardless of screen size.
   * Used when rendered inside SettingsDialog where the mobile 3-dot menu
   * would overlap with the dialog's close button.
   */
  forceDesktopLayout?: boolean;
  showHeader?: boolean;
  sectionTitle?: string;
  onFooterSecondaryActionsChange?: (actions: ReactNode) => void;
  contentPadding?: "responsive" | "none";
}

const CONNECTION_ROW_VERTICAL_PADDING = 2.5;

export function ConnectionSettings({
  isAdmin,
  onConnectionsChanged,
  forceDesktopLayout = false,
  showHeader = true,
  sectionTitle,
  onFooterSecondaryActionsChange,
  contentPadding = "responsive",
}: ConnectionSettingsProps) {
  const theme = useTheme();
  const isLargeScreen = useMediaQuery(theme.breakpoints.up("sm"));
  const { t } = useTranslation();
  const { isAdmin: detectedIsAdmin, canWrite: detectedCanWrite } = useSettingsAccess(isAdmin !== true);
  // Use desktop layout if forced or on large screens
  const isDesktop = forceDesktopLayout || isLargeScreen;
  const shouldRenderInlineGroupHeader = Boolean(sectionTitle);
  const effectiveIsAdmin = Boolean(isAdmin || detectedIsAdmin);
  const canCreateConnections = effectiveIsAdmin || detectedCanWrite;
  const [notification, setNotification] = useState<SettingsNotificationState>({
    open: false,
    message: "",
    severity: "success",
  });
  const showNotification = useCallback((message: string, severity: "success" | "error" | "info") => {
    setNotification({ open: true, message, severity });
  }, []);
  const handleConnectionsLoadError = useCallback(
    (error: unknown) => {
      const message = getApiErrorMessage(error, t("settings.connectionManagement.notifications.loadFailed"));
      showNotification(message, "error");
    },
    [showNotification, t]
  );
  const {
    data: cachedConnections,
    loading,
    refresh,
  } = useCachedAsyncData<Connection[]>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.connections,
    load: loadConnectionsSettingsData,
    onError: handleConnectionsLoadError,
  });
  const connections = cachedConnections ?? [];
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{
    element: HTMLElement;
    connection: Connection;
  } | null>(null);
  const handleAddClick = useCallback(() => {
    setSelectedConnection(null);
    setConnectionDialogOpen(true);
  }, []);

  const addConnectionAction = useMemo(
    () =>
      canCreateConnections ? (
        <Button variant="outlined" startIcon={<AddIcon />} onClick={handleAddClick} sx={settingsUtilityButtonSx}>
          {t("settings.connectionManagement.addConnectionButton")}
        </Button>
      ) : null,
    [canCreateConnections, handleAddClick, t]
  );

  useEffect(() => {
    if (!onFooterSecondaryActionsChange) {
      return;
    }

    onFooterSecondaryActionsChange(addConnectionAction);
    return () => onFooterSecondaryActionsChange(null);
  }, [addConnectionAction, onFooterSecondaryActionsChange]);

  const handleEdit = (connection: Connection) => {
    if (!connection.can_manage) return;
    setSelectedConnection(connection);
    setConnectionDialogOpen(true);
  };

  const handleDeleteClick = (connection: Connection) => {
    if (!connection.can_manage) return;
    setSelectedConnection(connection);
    setDeleteDialogOpen(true);
  };

  const handleConnectionDialogClose = () => {
    setConnectionDialogOpen(false);
    setSelectedConnection(null);
  };

  const handleConnectionSave = (savedConnection: Connection, requestedScope: "shared" | "private") => {
    void refresh();
    if (savedConnection.scope !== requestedScope) {
      showNotification(
        savedConnection.scope === "private"
          ? t("settings.connectionManagement.notifications.savedPrivateInfo")
          : selectedConnection
            ? t("settings.connectionManagement.notifications.updatedSuccess")
            : t("settings.connectionManagement.notifications.createdSuccess"),
        savedConnection.scope === "private" ? "info" : "success"
      );
    } else {
      showNotification(
        selectedConnection
          ? t("settings.connectionManagement.notifications.updatedSuccess")
          : t("settings.connectionManagement.notifications.createdSuccess"),
        "success"
      );
    }
    handleConnectionDialogClose();
    onConnectionsChanged?.();
  };

  const handleDeleteConfirm = async () => {
    if (!selectedConnection) return;

    try {
      setDeleteSubmitting(true);
      await api.deleteConnection(selectedConnection.id);
      showNotification(t("settings.connectionManagement.notifications.deletedSuccess"), "success");
      await refresh();
      setDeleteDialogOpen(false);
      setSelectedConnection(null);
      onConnectionsChanged?.();
    } catch (error: unknown) {
      const message = getApiErrorMessage(error, t("settings.connectionManagement.notifications.deleteFailed"));
      showNotification(message, "error");
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLElement>, connection: Connection) => {
    if (!connection.can_manage) return;
    setMenuAnchor({ element: event.currentTarget, connection });
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleMenuEdit = () => {
    if (menuAnchor) {
      handleEdit(menuAnchor.connection);
    }
    handleMenuClose();
  };

  const handleMenuDelete = () => {
    if (menuAnchor) {
      handleDeleteClick(menuAnchor.connection);
    }
    handleMenuClose();
  };

  const sharedConnections = connections.filter((connection) => connection.scope === "shared");
  const privateConnections = connections.filter((connection) => connection.scope === "private");

  const renderMetadataChips = (connection: Connection) => (
    <>
      <Chip label={connection.type.toUpperCase()} size="small" variant="outlined" sx={settingsMetadataChipSx} />
      {connection.access_mode === "read_only" ? (
        <Chip
          label={t("settings.connectionDialog.accessMode.readOnlyLabel")}
          size="small"
          color="warning"
          variant="outlined"
          sx={settingsMetadataChipSx}
        />
      ) : null}
    </>
  );

  const renderConnectionList = (sectionConnections: Connection[]) => {
    if (sectionConnections.length === 0) {
      return null;
    }

    if (isDesktop) {
      return (
        <SettingsList>
          {sectionConnections.map((connection, index) => (
            <Box key={connection.id}>
              <ListItem
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  pt: index === 0 ? 0 : CONNECTION_ROW_VERTICAL_PADDING,
                  pb: CONNECTION_ROW_VERTICAL_PADDING,
                  px: 0,
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                    mb: 1.5,
                    flexWrap: "wrap",
                  }}
                >
                  <Typography component="div" variant="body1" sx={settingsListItemTitleSx}>
                    {connection.name}
                  </Typography>
                  {renderMetadataChips(connection)}
                </Box>

                <Box sx={{ display: "flex", mb: -0.5 }}>
                  <Typography variant="body2" sx={{ minWidth: 48, color: "text.secondary" }}>
                    {t("settings.connectionManagement.userLabel")}
                  </Typography>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {connection.username}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <Box sx={{ display: "flex" }}>
                    <Typography variant="body2" sx={{ minWidth: 48, color: "text.secondary" }}>
                      {t("settings.connectionManagement.pathLabel")}
                    </Typography>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      \\{connection.host}\{connection.share_name}
                      {connection.path_prefix && connection.path_prefix !== "/" && connection.path_prefix.replace(/\//g, "\\")}
                    </Typography>
                  </Box>
                  {connection.can_manage ? (
                    <Box sx={{ display: "flex", gap: 1, ml: 2 }}>
                      <Tooltip title={t("settings.connectionManagement.tooltipEdit")}>
                        <IconButton
                          onClick={() => handleEdit(connection)}
                          aria-label={t("settings.connectionManagement.ariaEdit")}
                          sx={settingsUtilityIconButtonSx}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t("settings.connectionManagement.tooltipDelete")}>
                        <IconButton
                          onClick={() => handleDeleteClick(connection)}
                          aria-label={t("settings.connectionManagement.ariaDelete")}
                          sx={settingsDestructiveIconButtonSx}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ) : null}
                </Box>
              </ListItem>
              <Divider />
            </Box>
          ))}
        </SettingsList>
      );
    }

    return (
      <SettingsList>
        {sectionConnections.map((connection, index) => (
          <Box key={connection.id}>
            <ListItem
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "stretch",
                pt: index === 0 ? 0 : CONNECTION_ROW_VERTICAL_PADDING,
                pb: CONNECTION_ROW_VERTICAL_PADDING,
                px: 0,
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  mb: 1.5,
                  gap: 1,
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    flexWrap: "wrap",
                  }}
                >
                  <Typography component="div" variant="body1" sx={settingsListItemTitleSx}>
                    {connection.name}
                  </Typography>
                  {renderMetadataChips(connection)}
                </Box>
                {connection.can_manage ? (
                  <IconButton
                    size="small"
                    onClick={(e) => handleMenuOpen(e, connection)}
                    aria-label={t("settings.connectionManagement.connectionActionsAriaLabel")}
                    sx={{
                      ...settingsUtilityIconButtonSx,
                      mt: 0,
                      width: 32,
                      height: 32,
                    }}
                  >
                    <MoreVertIcon />
                  </IconButton>
                ) : null}
              </Box>

              <Box sx={{ display: "flex", mb: 1 }}>
                <Typography variant="body2" sx={{ minWidth: 48, color: "text.secondary" }}>
                  {t("settings.connectionManagement.userLabel")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {connection.username}
                </Typography>
              </Box>

              <Box sx={{ display: "flex" }}>
                <Typography variant="body2" sx={{ minWidth: 48, color: "text.secondary" }}>
                  {t("settings.connectionManagement.pathLabel")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  \\{connection.host}\{connection.share_name}
                  {connection.path_prefix && connection.path_prefix !== "/" && connection.path_prefix.replace(/\//g, "\\")}
                </Typography>
              </Box>
            </ListItem>
            <Divider />
          </Box>
        ))}
      </SettingsList>
    );
  };

  const renderSection = (title: string, sectionConnections: Connection[], emptyMessage: string, testId?: string) => (
    <Box data-testid={testId}>
      <SettingsGroup title={title}>
        {sectionConnections.length === 0 ? (
          <SettingsEmptyState description={emptyMessage} compact sx={{ py: 2, maxWidth: "none", mx: 0, textAlign: "left" }} />
        ) : (
          renderConnectionList(sectionConnections)
        )}
      </SettingsGroup>
    </Box>
  );

  return (
    <Box
      sx={{
        height: showHeader ? "100%" : "auto",
        display: "flex",
        flexDirection: "column",
        bgcolor: getSettingsPageSurfaceColor,
        overflow: showHeader ? "hidden" : "visible",
      }}
    >
      {showHeader ? (
        <SettingsSectionHeader
          title={t("settings.connectionManagement.headerTitle")}
          description={t("settings.connectionManagement.headerDescription")}
          dialogSafe={forceDesktopLayout}
          showTitle={isDesktop}
          actions={undefined}
        />
      ) : shouldRenderInlineGroupHeader ? (
        <Box data-testid="connection-settings-inline-header" sx={{ px: { xs: 2, sm: 3, md: 4 }, pt: 2, pb: 2 }}>
          <SettingsGroup title={sectionTitle} actions={null} />
        </Box>
      ) : null}

      {/* Connection List */}
      <Box
        sx={{
          flex: showHeader ? 1 : undefined,
          overflow: showHeader ? "auto" : "visible",
          ...(contentPadding === "responsive" ? { px: { xs: 2, sm: 3, md: 4 }, pb: 3 } : { p: 0 }),
        }}
      >
        {loading ? (
          <SettingsLoadingState />
        ) : connections.length === 0 ? (
          <SettingsEmptyState
            title={t("settings.connectionManagement.emptyTitle")}
            description={
              effectiveIsAdmin
                ? t("settings.connectionManagement.emptyAdminDescription")
                : canCreateConnections
                  ? t("settings.connectionManagement.emptyRegularDescription")
                  : t("settings.connectionManagement.emptyViewerDescription")
            }
          />
        ) : (
          <SettingsSectionList sx={{ mt: showHeader ? 3 : 0 }}>
            {renderSection(
              t("settings.connectionManagement.sharedSectionTitle"),
              sharedConnections,
              t("settings.connectionManagement.sharedSectionEmpty"),
              "connection-settings-shared-section"
            )}
            {renderSection(
              t("settings.connectionManagement.privateSectionTitle"),
              privateConnections,
              t("settings.connectionManagement.privateSectionEmpty"),
              "connection-settings-private-section"
            )}
          </SettingsSectionList>
        )}
      </Box>

      {!onFooterSecondaryActionsChange && addConnectionAction && <SettingsActionBar secondaryActions={addConnectionAction} />}

      {/* Actions Menu */}
      <Menu
        anchorEl={menuAnchor?.element}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        slotProps={{
          paper: {
            sx: {
              minWidth: 180,
            },
          },
        }}
      >
        <MenuItem onClick={handleMenuEdit}>
          <EditIcon fontSize="small" sx={{ mr: 1.5, color: "primary.main" }} />
          {t("settings.connectionManagement.menuEdit")}
        </MenuItem>
        <MenuItem onClick={handleMenuDelete} sx={{ color: "error.main" }}>
          <DeleteIcon fontSize="small" sx={{ mr: 1.5 }} />
          {t("settings.connectionManagement.menuDelete")}
        </MenuItem>
      </Menu>

      {/* Connection Dialog */}
      <ConnectionDialog
        open={connectionDialogOpen}
        onClose={handleConnectionDialogClose}
        onSave={handleConnectionSave}
        connection={selectedConnection}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteDialog
        open={deleteDialogOpen}
        onClose={() => {
          setDeleteDialogOpen(false);
          setSelectedConnection(null);
        }}
        onConfirm={handleDeleteConfirm}
        submitting={deleteSubmitting}
        title={t("settings.connectionManagement.deleteDialogTitle")}
        description={t("settings.connectionManagement.deleteDialogDescription")}
        descriptionItemName={selectedConnection?.name ?? null}
      />

      <SettingsNotificationSnackbar
        notification={notification}
        onClose={() => setNotification((current) => ({ ...current, open: false }))}
      />
    </Box>
  );
}
