import { Logout as LogoutIcon, Settings as SettingsIcon } from "@mui/icons-material";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import HomeIcon from "@mui/icons-material/Home";
import {
  Box,
  Divider,
  Drawer,
  FormControl,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Typography,
} from "@mui/material";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import { mobileNavigationDrawerTypographySx, SAFE_AREA_INSET } from "../../theme/mobileShell";
import type { AggregateHealthSeverity, Connection } from "../../types";
import { HealthStatusIcon } from "../HealthMonitoring/HealthStatusIcon";

export interface MobileMenuSystemHealthItem {
  visible: boolean;
  severity: AggregateHealthSeverity;
  headline: string;
  onOpen: () => void;
}

interface HamburgerMenuProps {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  selectedConnectionId: string;
  onConnectionChange: (connectionId: string) => void;
  onNavigateToRoot: () => void;
  onOpenDocumentation: () => void;
  onOpenSettings: () => void;
  systemHealth?: MobileMenuSystemHealthItem;
  onLogout: () => void;
}

const HamburgerMenu: React.FC<HamburgerMenuProps> = ({
  open,
  onClose,
  connections,
  selectedConnectionId,
  onConnectionChange,
  onNavigateToRoot,
  onOpenDocumentation,
  onOpenSettings,
  systemHealth,
  onLogout,
}) => {
  const { t } = useTranslation();
  const [suppressRestoreFocus, setSuppressRestoreFocus] = useState(false);

  useEffect(() => {
    if (open) {
      setSuppressRestoreFocus(false);
    }
  }, [open]);

  const handleConnectionChange = (connectionId: string) => {
    onConnectionChange(connectionId);
    onClose();
  };

  const selectedConnection = connections.find((c) => c.id === selectedConnectionId);
  const statusText = systemHealth ? t(`systemHealth.statuses.${systemHealth.severity}`) : "";

  return (
    <Drawer
      anchor="left"
      open={open}
      onClose={onClose}
      disableRestoreFocus={suppressRestoreFocus}
      slotProps={{
        paper: {
          sx: [
            {
              width: 280,
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              bgcolor: "background.default",
              pt: SAFE_AREA_INSET.TOP,
              pl: SAFE_AREA_INSET.LEFT,
              pb: SAFE_AREA_INSET.BOTTOM,
            },
            mobileNavigationDrawerTypographySx,
          ],
        },
      }}
    >
      <Box sx={{ p: 2 }}>
        {/* App Logo/Title */}
        <Box sx={{ display: "flex", alignItems: "center", mb: 3 }}>
          <Typography variant="h6" component="h1" sx={{ fontWeight: 600 }}>
            Sambee
          </Typography>
        </Box>

        {/* Connection Selector */}
        {connections.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Typography
              variant="caption"
              sx={{ mb: 1, display: "block", color: "text.secondary", fontSize: `${COMPACT_LAYOUT_SIZE.DRAWER_SECTION_LABEL_PX}px` }}
            >
              {t("common.labels.connection")}
            </Typography>
            <FormControl fullWidth size="small">
              <Select
                value={selectedConnectionId}
                onChange={(e) => handleConnectionChange(e.target.value)}
                displayEmpty
                aria-label={t("fileBrowser.chrome.mobileMenu.selectConnectionAriaLabel")}
              >
                {connections.map((conn) => (
                  <MenuItem key={conn.id} value={conn.id}>
                    {conn.name}
                    {selectedConnection && (
                      <Typography variant="caption" sx={{ ml: 1, color: "text.secondary" }}>
                        ({conn.host}/{conn.share_name})
                      </Typography>
                    )}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>
        )}
      </Box>

      <Divider />

      {/* Menu Items */}
      <List>
        <ListItem disablePadding>
          <ListItemButton
            onClick={() => {
              onNavigateToRoot();
              onClose();
            }}
            aria-label={t("fileBrowser.chrome.mobileMenu.navigateRootAriaLabel")}
          >
            <ListItemIcon>
              <HomeIcon />
            </ListItemIcon>
            <ListItemText primary={t("common.labels.root")} />
          </ListItemButton>
        </ListItem>
        <ListItem disablePadding>
          <ListItemButton
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            aria-label={t("fileBrowser.chrome.mobileMenu.openSettingsAriaLabel")}
          >
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary={t("common.labels.settings")} />
          </ListItemButton>
        </ListItem>

        {systemHealth?.visible && (
          <ListItem disablePadding>
            <ListItemButton
              onClick={() => {
                setSuppressRestoreFocus(true);
                onClose();
                systemHealth.onOpen();
              }}
              aria-label={t("fileBrowser.chrome.mobileMenu.openSystemHealthAriaLabel", {
                status: statusText,
                headline: systemHealth.headline,
              })}
            >
              <ListItemIcon>
                <HealthStatusIcon status={systemHealth.severity} />
              </ListItemIcon>
              <ListItemText primary={t("fileBrowser.chrome.mobileMenu.systemHealth")} secondary={statusText} />
            </ListItemButton>
          </ListItem>
        )}

        <ListItem disablePadding>
          <ListItemButton
            onClick={() => {
              onOpenDocumentation();
              onClose();
            }}
            aria-label={t("fileBrowser.chrome.mobileMenu.openDocumentationAriaLabel")}
          >
            <ListItemIcon>
              <DescriptionOutlinedIcon />
            </ListItemIcon>
            <ListItemText primary={t("fileBrowser.chrome.helpMenu.documentation")} />
          </ListItemButton>
        </ListItem>

        <ListItem disablePadding>
          <ListItemButton onClick={onLogout} aria-label={t("fileBrowser.chrome.mobileMenu.logoutAriaLabel")}>
            <ListItemIcon>
              <LogoutIcon />
            </ListItemIcon>
            <ListItemText primary={t("common.actions.logout")} />
          </ListItemButton>
        </ListItem>
      </List>
    </Drawer>
  );
};

export default HamburgerMenu;
