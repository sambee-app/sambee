//
// StatusBar
//

import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { formatDate, formatFileSize } from "../../pages/FileBrowser/formatters";
import type { FileEntry } from "../../types";
import { isShortcutFile } from "../../utils/fileEntries";
import { STATUS_BAR_STRINGS } from "./statusBarStrings";

/** Shared height constant so breadcrumb bar and status bar match exactly. */
export const STATUS_BAR_HEIGHT = 32;

interface StatusBarProps {
  files: FileEntry[];
  focusedIndex: number;
  selectedCount?: number;
  canResolveShortcutTargets: boolean;
}

/**
 * Status bar showing selected file info and total count
 * Desktop only component
 */
export function StatusBar({ files, focusedIndex, selectedCount = 0, canResolveShortcutTargets }: StatusBarProps) {
  const { t } = useTranslation();
  const selectedFile = files[focusedIndex];
  const linkTargetStatus = selectedFile?.link_target
    ? STATUS_BAR_STRINGS.linkTargetStatus(selectedFile.link_target)
    : selectedFile && isShortcutFile(selectedFile) && !canResolveShortcutTargets
      ? STATUS_BAR_STRINGS.UNRESOLVABLE_SHORTCUT
      : null;

  return (
    <Box
      sx={{
        px: 2,
        height: STATUS_BAR_HEIGHT,
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        borderTop: 1,
        borderColor: "divider",
        bgcolor: (theme) => theme.palette.statusBar?.background ?? theme.palette.background.default,
        color: (theme) => theme.palette.statusBar?.text ?? theme.palette.text.primary,
      }}
    >
      {/* Left side - Selected file info */}
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", minWidth: 0, flex: 1, overflow: "hidden" }}>
        {(() => {
          if (selectedCount > 0)
            return (
              <Typography variant="caption" noWrap>
                {t("fileBrowser.compactActions.selectedCount", { count: selectedCount })}
              </Typography>
            );
          if (!selectedFile) return null;

          const parts = [];
          parts.push(selectedFile.name);

          if (selectedFile.type === "file" && selectedFile.size !== undefined && selectedFile.size !== null) {
            parts.push(formatFileSize(selectedFile.size));
          }

          if (selectedFile.modified_at) {
            parts.push(formatDate(selectedFile.modified_at));
          }

          return (
            <Box sx={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0, overflow: "hidden" }}>
              <Typography data-testid="status-bar-focused-file-name" variant="caption" noWrap sx={{ minWidth: 0 }}>
                {selectedFile.name}
              </Typography>
              {selectedFile.type === "file" && selectedFile.size !== undefined && selectedFile.size !== null && (
                <Typography variant="caption" noWrap>
                  {formatFileSize(selectedFile.size)}
                </Typography>
              )}
              {selectedFile.modified_at && (
                <Typography variant="caption" noWrap>
                  {formatDate(selectedFile.modified_at)}
                </Typography>
              )}
              {linkTargetStatus && (
                <Typography variant="caption" noWrap sx={{ color: "error.main" }}>
                  {linkTargetStatus}
                </Typography>
              )}
            </Box>
          );
        })()}
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, flexShrink: 0 }}>
        <Typography
          variant="caption"
          sx={{
            whiteSpace: "nowrap",
            color: (theme) => theme.palette.statusBar?.textSecondary ?? theme.palette.text.secondary,
          }}
        >
          {STATUS_BAR_STRINGS.itemCount(files.length)}
        </Typography>
      </Box>
    </Box>
  );
}
