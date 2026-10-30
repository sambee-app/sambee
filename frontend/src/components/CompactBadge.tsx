import { Chip, type ChipProps, Tooltip } from "@mui/material";
import { truncateTextByGrapheme } from "../utils/pathDisplay";

export const MAX_BADGE_LABEL_LENGTH = 18;

export function CompactBadge({ label, title, sx, ...props }: Omit<ChipProps, "label"> & { label: string }) {
  const shortLabel = truncateTextByGrapheme(label, MAX_BADGE_LABEL_LENGTH);
  return (
    <Tooltip title={title ?? (shortLabel === label ? "" : label)}>
      <Chip
        {...props}
        label={shortLabel}
        aria-label={props["aria-label"] ?? label}
        sx={[
          ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
          {
            minWidth: 0,
            maxWidth: "100%",
            height: "auto",
            minHeight: 20,
            "& .MuiChip-label": { whiteSpace: "normal", overflowWrap: "anywhere", py: 0.125 },
          },
        ]}
      />
    </Tooltip>
  );
}
