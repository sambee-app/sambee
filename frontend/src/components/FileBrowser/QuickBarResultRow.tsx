import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import FolderIcon from "@mui/icons-material/Folder";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import KeyboardCommandKeyIcon from "@mui/icons-material/KeyboardCommandKey";
import { Box, Typography } from "@mui/material";
import type React from "react";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import type { SearchResult, SearchResultIcon, SearchResultItem, SearchTextHighlight } from "./search/types";

/** Shared height for a two-line quick-bar result row. */
export const QUICK_BAR_RESULT_ITEM_HEIGHT = 56;

/** Compact height for a quiet quick-bar result group label. */
export const QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT = 32;

const QUICK_BAR_RESULT_ICON_COLUMN_WIDTH = 36;

function getResultIcon(icon: SearchResultIcon): React.ReactElement {
  switch (icon) {
    case "command":
      return <KeyboardCommandKeyIcon fontSize="small" />;
    case "directory":
      return <FolderIcon fontSize="small" />;
    case "recent-directory":
    case "recent-file":
      return <HistoryOutlinedIcon fontSize="small" />;
    case "file":
      return <DescriptionOutlinedIcon fontSize="small" />;
  }
}

function renderHighlightedText(text: string, highlight?: SearchTextHighlight | SearchTextHighlight[]): React.ReactNode {
  if (!highlight) return text;
  const ranges = Array.isArray(highlight) ? highlight : [highlight];
  const pieces: React.ReactNode[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < offset ||
      range.end <= range.start ||
      range.end > text.length
    )
      continue;
    pieces.push(text.slice(offset, range.start));
    pieces.push(
      <Box key={`${range.start}:${range.end}`} component="span" sx={{ color: "primary.main", fontWeight: 700 }}>
        {text.slice(range.start, range.end)}
      </Box>
    );
    offset = range.end;
  }
  pieces.push(text.slice(offset));
  return <>{pieces}</>;
}

/** Returns the virtualized height for a structured quick-bar result. */
export function getQuickBarResultRowHeight(result: SearchResult): number {
  return result.kind === "group-header" ? QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT : QUICK_BAR_RESULT_ITEM_HEIGHT;
}

export function QuickBarResultRow({ result, useCompactLayout = false }: { result: SearchResultItem; useCompactLayout?: boolean }) {
  const isDirectory = result.icon === "directory" || result.icon === "recent-directory";

  return (
    <Box sx={{ alignItems: "center", display: "flex", gap: 1.25, minWidth: 0, width: "100%" }}>
      <Box
        aria-hidden="true"
        sx={{
          alignItems: "center",
          color: isDirectory ? "text.secondary" : undefined,
          display: "flex",
          flex: `0 0 ${QUICK_BAR_RESULT_ICON_COLUMN_WIDTH}px`,
          justifyContent: "center",
        }}
      >
        {getResultIcon(result.icon)}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          component="div"
          variant="body2"
          sx={{
            color: isDirectory ? "text.secondary" : undefined,
            fontSize: useCompactLayout ? `${COMPACT_LAYOUT_SIZE.SEARCH_RESULT_PRIMARY_TEXT_PX}px` : undefined,
            lineHeight: useCompactLayout ? 1.25 : undefined,
          }}
          noWrap
        >
          {renderHighlightedText(result.primaryText, result.primaryHighlight)}
        </Typography>
        {result.secondaryText ? (
          <Typography component="div" variant="caption" sx={{ color: "text.secondary" }} noWrap>
            {renderHighlightedText(result.secondaryText, result.secondaryHighlight)}
          </Typography>
        ) : null}
      </Box>
      {result.shortcutLabel ? (
        <Box
          component="kbd"
          sx={{
            border: 1,
            borderColor: "divider",
            borderRadius: 0.5,
            color: "text.secondary",
            flexShrink: 0,
            fontFamily: "inherit",
            fontSize: "0.7rem",
            lineHeight: 1,
            px: 0.5,
            py: 0.25,
            whiteSpace: "nowrap",
          }}
        >
          {result.shortcutLabel}
        </Box>
      ) : null}
    </Box>
  );
}

export function QuickBarResultGroupHeader({
  label,
  showDivider,
  useCompactLayout = false,
}: {
  label: string;
  showDivider: boolean;
  useCompactLayout?: boolean;
}) {
  return (
    <Box
      role="presentation"
      sx={{
        alignItems: "center",
        borderColor: "divider",
        borderTop: showDivider ? 1 : 0,
        display: "flex",
        height: QUICK_BAR_RESULT_GROUP_HEADER_HEIGHT,
        px: 2,
      }}
    >
      <Typography
        component="div"
        role="heading"
        aria-level={2}
        variant="caption"
        sx={{
          color: "text.secondary",
          fontWeight: 600,
          fontSize: useCompactLayout ? `${COMPACT_LAYOUT_SIZE.SEARCH_RESULT_GROUP_HEADING_PX}px` : undefined,
        }}
      >
        {label}
      </Typography>
    </Box>
  );
}
