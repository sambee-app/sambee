import { Delete as DeleteIcon, Edit as EditIcon, CheckCircle as TestIcon } from "@mui/icons-material";
import {
  Box,
  IconButton,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { Connection } from "../../types";
import { CompactBadge as Chip } from "../CompactBadge";

interface ConnectionListProps {
  connections: Connection[];
  onEdit: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
  onTest: (connection: Connection) => void;
  loading?: boolean;
}

const ConnectionList: React.FC<ConnectionListProps> = ({ connections, onEdit, onDelete, onTest, loading = false }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography>{t("fileBrowser.chrome.alerts.loadingConnections")}</Typography>
      </Box>
    );
  }

  if (connections.length === 0) {
    return (
      <Box sx={{ p: 4, textAlign: "center" }}>
        <Typography variant="h6" sx={{ color: "text.secondary" }}>
          {t("settings.connectionManagement.emptyTitle")}
        </Typography>
        <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
          {t("settings.connectionManagement.emptyAdminDescription")}
        </Typography>
      </Box>
    );
  }

  return (
    <TableContainer component={Paper}>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell>{t("settings.connectionDialog.labels.name")}</TableCell>
            <TableCell>{t("settings.connectionDialog.labels.host")}</TableCell>
            <TableCell>{t("settings.connectionDialog.labels.shareName")}</TableCell>
            <TableCell>{t("settings.connectionDialog.labels.username")}</TableCell>
            <TableCell align="center">{t("settings.connectionManagement.columns.port")}</TableCell>
            <TableCell>{t("settings.connectionManagement.columns.type")}</TableCell>
            <TableCell align="right">{t("settings.connectionManagement.columns.actions")}</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {connections.map((connection) => (
            <TableRow key={connection.id} hover>
              <TableCell>
                <strong>{connection.name}</strong>
              </TableCell>
              <TableCell>{connection.host}</TableCell>
              <TableCell>{connection.share_name || "-"}</TableCell>
              <TableCell>{connection.username}</TableCell>
              <TableCell align="center">{connection.port}</TableCell>
              <TableCell>
                <Chip label={connection.type.toUpperCase()} size="small" />
              </TableCell>
              <TableCell align="right">
                <Tooltip title={t("settings.connectionManagement.tooltipTest")}>
                  <IconButton
                    size="small"
                    onClick={() => onTest(connection)}
                    color="primary"
                    aria-label={t("settings.connectionManagement.ariaTest")}
                  >
                    <TestIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t("settings.connectionManagement.tooltipEdit")}>
                  <IconButton
                    size="small"
                    onClick={() => onEdit(connection)}
                    color="primary"
                    aria-label={t("settings.connectionManagement.ariaEdit")}
                  >
                    <EditIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t("settings.connectionManagement.tooltipDelete")}>
                  <IconButton
                    size="small"
                    onClick={() => onDelete(connection)}
                    color="error"
                    aria-label={t("settings.connectionManagement.ariaDelete")}
                  >
                    <DeleteIcon />
                  </IconButton>
                </Tooltip>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

export default ConnectionList;
