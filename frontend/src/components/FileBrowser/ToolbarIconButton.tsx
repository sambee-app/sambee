import { IconButton, type SxProps, type Theme, Tooltip } from "@mui/material";
import type React from "react";
import { toolbarIconButtonSx } from "../../theme/commonStyles";

interface ToolbarIconButtonProps {
  label: string;
  tooltip: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onKeyUp?: React.KeyboardEventHandler<HTMLButtonElement>;
  tabIndex?: number;
  ariaControls?: string;
  ariaExpanded?: boolean;
  ariaHaspopup?: React.AriaAttributes["aria-haspopup"];
  sx?: Exclude<SxProps<Theme>, readonly unknown[]>;
  children: React.ReactNode;
}

export function ToolbarIconButton({
  label,
  tooltip,
  onClick,
  onKeyDown,
  onKeyUp,
  tabIndex,
  ariaControls,
  ariaExpanded,
  ariaHaspopup,
  sx,
  children,
}: ToolbarIconButtonProps) {
  return (
    <Tooltip title={tooltip}>
      <IconButton
        color="inherit"
        aria-label={label}
        onClick={onClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        tabIndex={tabIndex}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-haspopup={ariaHaspopup}
        sx={[toolbarIconButtonSx, sx ?? {}]}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}
