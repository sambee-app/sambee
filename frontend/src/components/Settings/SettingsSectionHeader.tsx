import { Box, type SxProps, type Theme, Typography } from "@mui/material";
import type { ReactNode } from "react";

const DIALOG_CLOSE_BUTTON_CLEARANCE_PX = 56;

interface SettingsSectionHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  dialogSafe?: boolean;
  showTitle?: boolean;
  sx?: SxProps<Theme>;
}

export function SettingsSectionHeader({
  title,
  description,
  actions,
  dialogSafe = false,
  showTitle = true,
  sx,
}: SettingsSectionHeaderProps) {
  const baseSx: SxProps<Theme> = {
    px: { xs: 2, sm: 3, md: 4 },
    py: 2,
    display: "flex",
    flexDirection: "column",
    rowGap: 3,
    pr: dialogSafe && actions ? { sm: `${DIALOG_CLOSE_BUTTON_CLEARANCE_PX}px`, md: `${DIALOG_CLOSE_BUTTON_CLEARANCE_PX}px` } : undefined,
  };

  const resolvedSx: SxProps<Theme> = Array.isArray(sx) ? [baseSx, ...sx] : sx ? [baseSx, sx] : baseSx;

  return (
    <Box sx={resolvedSx}>
      <Box sx={{ minWidth: 0 }}>
        {showTitle && (
          <Typography variant="h5" sx={{ fontWeight: "medium" }}>
            {title}
          </Typography>
        )}
        {description && (
          <Typography variant="body2" sx={{ mt: showTitle ? 0.5 : 0, maxWidth: 680, color: "text.secondary" }}>
            {description}
          </Typography>
        )}
      </Box>

      {actions && (
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1,
            justifyContent: "flex-start",
            alignItems: "center",
          }}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
}
