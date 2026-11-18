//
// BreadcrumbsNavigation
//

import { Breadcrumbs, Link, Typography } from "@mui/material";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { truncateTextByGrapheme } from "../../utils/pathDisplay";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Average character width in pixels for the breadcrumb font (body2 variant) */
const CHAR_WIDTH_PX = 6;

/** Pixel width of the " / " separator rendered between breadcrumb items */
const SEPARATOR_WIDTH_PX = 24;

/** Pixel width of the "…" collapse indicator rendered as a breadcrumb item */
const ELLIPSIS_ITEM_WIDTH_PX = 20;

/** Minimum characters to keep when truncating an individual segment name */
const MIN_SEGMENT_CHARS = 5;

/** Extra pixel margin subtracted from available width to keep breathing room on the right */
const SAFETY_MARGIN_PX = 80;

// ─── Types ───────────────────────────────────────────────────────────────────

interface BreadcrumbsNavigationProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  connectionName: string;
  /** Restores keyboard focus to the owning file list if pointer/assistive activation focused a breadcrumb button. */
  onRestoreListFocus?: () => void;
  /** When true, show status-bar background behind the breadcrumb text (active pane in dual mode) */
  showActiveIndicator?: boolean;
}

/** A single item in the rendered breadcrumb trail */
interface DisplaySegment {
  /** Whether this is a real path segment or a collapse indicator */
  type: "segment" | "ellipsis";
  /** Text to display (may be truncated) */
  label: string;
  /** Original full segment name (for tooltips and aria labels) */
  fullLabel: string;
  /** Index in the original pathParts array (-1 for ellipsis) */
  pathIndex: number;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

//
// estimateSegmentsWidth
//
/**
 * Estimate the total pixel width of an array of display segments,
 * including the separators rendered between them.
 */
function estimateSegmentsWidth(segments: DisplaySegment[]): number {
  let width = 0;
  for (const seg of segments) {
    width += seg.type === "ellipsis" ? ELLIPSIS_ITEM_WIDTH_PX : seg.label.length * CHAR_WIDTH_PX;
  }
  if (segments.length > 1) {
    width += (segments.length - 1) * SEPARATOR_WIDTH_PX;
  }
  return width;
}

//
// buildCandidateSegments
//
/**
 * Build a candidate DisplaySegment array from pathParts, keeping
 * the first `firstCount` segments and the last `lastCount` segments
 * with a single "…" collapse indicator between them.
 *
 * When firstCount + lastCount >= total, all segments are returned
 * without any collapse indicator.
 */
function buildCandidateSegments(pathParts: string[], firstCount: number, lastCount: number): DisplaySegment[] {
  const total = pathParts.length;
  const segments: DisplaySegment[] = [];

  if (firstCount + lastCount >= total) {
    // No collapse needed — return all segments
    for (let i = 0; i < total; i++) {
      const part = pathParts[i] ?? "";
      segments.push({ type: "segment", label: part, fullLabel: part, pathIndex: i });
    }
    return segments;
  }

  // First segments
  for (let i = 0; i < firstCount; i++) {
    const part = pathParts[i] ?? "";
    segments.push({ type: "segment", label: part, fullLabel: part, pathIndex: i });
  }

  // Collapse indicator
  segments.push({ type: "ellipsis", label: "…", fullLabel: "", pathIndex: -1 });

  // Last segments
  for (let i = total - lastCount; i < total; i++) {
    const part = pathParts[i] ?? "";
    segments.push({ type: "segment", label: part, fullLabel: part, pathIndex: i });
  }

  return segments;
}

//
// tryFitWithTruncation
//
/**
 * Attempt to fit a set of display segments within the given pixel width
 * by intelligently truncating individual segment names.
 *
 * Character budget is allocated from right to left so that segments
 * closer to the current directory (rightmost) receive the most space.
 * Any surplus budget from short segments is redistributed to longer ones.
 *
 * Returns the fitted segments, or null if they cannot fit even with
 * maximum truncation.
 */
function tryFitWithTruncation(segments: DisplaySegment[], maxWidth: number): DisplaySegment[] | null {
  // Already fits without truncation
  if (estimateSegmentsWidth(segments) <= maxWidth) {
    return segments;
  }

  const textSegments = segments.filter((s) => s.type === "segment");
  if (textSegments.length === 0) return null;

  // Calculate width budget available for text content
  const ellipsisCount = segments.filter((s) => s.type === "ellipsis").length;
  const overheadWidth = ellipsisCount * ELLIPSIS_ITEM_WIDTH_PX + (segments.length > 1 ? (segments.length - 1) * SEPARATOR_WIDTH_PX : 0);
  const availableForText = maxWidth - overheadWidth;

  // Check if even minimum truncation is too wide
  const minTotalWidth = textSegments.length * MIN_SEGMENT_CHARS * CHAR_WIDTH_PX;
  if (availableForText < minTotalWidth) return null;

  // Distribute character budget: start with minimum, then allocate right-to-left
  const totalChars = Math.floor(availableForText / CHAR_WIDTH_PX);
  const budgets: number[] = textSegments.map(() => MIN_SEGMENT_CHARS);
  let remaining = totalChars - textSegments.length * MIN_SEGMENT_CHARS;

  // Right-to-left: current directory and its ancestors get priority
  for (let i = textSegments.length - 1; i >= 0 && remaining > 0; i--) {
    const seg = textSegments[i];
    const budget = budgets[i];
    if (!seg || budget === undefined) continue;
    const needed = seg.fullLabel.length - MIN_SEGMENT_CHARS;
    if (needed > 0) {
      const give = Math.min(needed, remaining);
      budgets[i] = budget + give;
      remaining -= give;
    }
  }

  // Cap budgets at actual segment length and reclaim wasted space from short segments
  for (let i = 0; i < textSegments.length; i++) {
    const seg = textSegments[i];
    const budget = budgets[i];
    if (!seg || budget === undefined) continue;
    const fullLen = seg.fullLabel.length;
    if (budget > fullLen) {
      remaining += budget - fullLen;
      budgets[i] = fullLen;
    }
  }

  // Redistribute reclaimed space left-to-right to any still-truncated segments
  for (let i = 0; i < textSegments.length && remaining > 0; i++) {
    const seg = textSegments[i];
    const budget = budgets[i];
    if (!seg || budget === undefined) continue;
    const fullLen = seg.fullLabel.length;
    if (budget < fullLen) {
      const give = Math.min(fullLen - budget, remaining);
      budgets[i] = budget + give;
      remaining -= give;
    }
  }

  // Apply truncation budgets to build result
  const result = segments.map((seg) => ({ ...seg }));
  let budgetIdx = 0;
  for (const seg of result) {
    if (seg.type === "segment") {
      seg.label = truncateTextByGrapheme(seg.fullLabel, budgets[budgetIdx] ?? MIN_SEGMENT_CHARS);
      budgetIdx++;
    }
  }

  if (estimateSegmentsWidth(result) <= maxWidth) return result;
  return null;
}

//
// calculateBreadcrumbSegments
//
/**
 * Determine which path segments to display and how to label them,
 * given the available pixel width after the connection name.
 *
 * The algorithm proceeds through four phases of increasing aggressiveness:
 *   1. Show ALL segments (truncating long names if needed)
 *   2. Keep the first segment + "…" + last N segments (decrease N)
 *   3. Show "…" + last N segments without the first segment (decrease N)
 *   4. Fallback: just the last segment, possibly truncated
 *
 * Within each phase, tryFitWithTruncation allocates character budget
 * right-to-left so the current directory always gets the most space.
 */
function calculateBreadcrumbSegments(pathParts: string[], containerWidth: number, connectionNameLength: number): DisplaySegment[] {
  if (pathParts.length === 0) return [];

  // Reserve space for connection name + separator + safety margin
  const connectionWidth = connectionNameLength * CHAR_WIDTH_PX + SEPARATOR_WIDTH_PX + SAFETY_MARGIN_PX;
  const maxWidth = containerWidth - connectionWidth;

  if (maxWidth <= 0) {
    // Container is extremely narrow — just show last segment minimally
    const last = pathParts[pathParts.length - 1] ?? "";
    return [
      {
        type: "segment",
        label: truncateTextByGrapheme(last, MIN_SEGMENT_CHARS),
        fullLabel: last,
        pathIndex: pathParts.length - 1,
      },
    ];
  }

  const n = pathParts.length;

  // Phase 1: Try showing all segments (with truncation if needed)
  const allSegments = buildCandidateSegments(pathParts, n, 0);
  const phase1 = tryFitWithTruncation(allSegments, maxWidth);
  if (phase1) return phase1;

  // Phase 2: Keep first 1 + "…" + last K (decrease K until it fits)
  for (let lastCount = n - 2; lastCount >= 1; lastCount--) {
    const segments = buildCandidateSegments(pathParts, 1, lastCount);
    const fitted = tryFitWithTruncation(segments, maxWidth);
    if (fitted) return fitted;
  }

  // Phase 3: "…" + last K without the first segment (decrease K)
  for (let lastCount = n - 1; lastCount >= 1; lastCount--) {
    const segments = buildCandidateSegments(pathParts, 0, lastCount);
    const fitted = tryFitWithTruncation(segments, maxWidth);
    if (fitted) return fitted;
  }

  // Phase 4: Just the last segment, truncated to fit
  const last = pathParts[n - 1] ?? "";
  const maxChars = Math.max(MIN_SEGMENT_CHARS, Math.floor(maxWidth / CHAR_WIDTH_PX));
  return [{ type: "segment", label: truncateTextByGrapheme(last, maxChars), fullLabel: last, pathIndex: n - 1 }];
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Breadcrumbs navigation component for file browser.
 * Shows the current path with clickable segments to navigate back.
 *
 * Intelligently collapses middle segments and truncates long names
 * when space is limited, prioritizing segments closest to the current
 * directory for maximum navigational context.
 */
export function BreadcrumbsNavigation({
  currentPath,
  onNavigate,
  connectionName,
  onRestoreListFocus,
  showActiveIndicator,
}: BreadcrumbsNavigationProps) {
  const { t } = useTranslation();
  const pathParts = currentPath ? currentPath.split("/").filter(Boolean) : [];
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(800);

  const preventPointerFocus = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  const handleBreadcrumbFocus = () => {
    onRestoreListFocus?.();
  };

  // Measure container width using ResizeObserver for responsive breadcrumbs.
  // Guard against zero-width measurements (e.g. JSDOM in tests) to preserve
  // the sensible default.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const initialWidth = element.offsetWidth;
    if (initialWidth > 0) {
      setContainerWidth(initialWidth);
    }

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
        if (width > 0) {
          setContainerWidth(width);
        }
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Calculate which segments to display
  const displaySegments = calculateBreadcrumbSegments(pathParts, containerWidth, connectionName.length);

  //
  // handleBreadcrumbClick
  //
  const handleBreadcrumbClick = (pathIndex: number) => {
    const newPath = pathParts.slice(0, pathIndex + 1).join("/");
    onNavigate(newPath);
    onRestoreListFocus?.();
  };

  //
  // handleRootClick
  //
  const handleRootClick = () => {
    onNavigate("");
    onRestoreListFocus?.();
  };

  const activeIndicatorSx = showActiveIndicator
    ? {
        bgcolor: (theme: import("@mui/material").Theme) => theme.palette.statusBar?.background ?? theme.palette.background.default,
        color: (theme: import("@mui/material").Theme) => theme.palette.statusBar?.text ?? theme.palette.text.primary,
      }
    : {};

  return (
    <Breadcrumbs
      ref={containerRef}
      maxItems={999}
      separator="/"
      sx={{
        flex: 1,
        minWidth: 0,
        "& .MuiBreadcrumbs-separator": {
          color: (theme: import("@mui/material").Theme) => theme.palette.statusBar?.textSecondary ?? theme.palette.text.secondary,
          display: "flex",
          alignItems: "center",
          mx: 0.5,
        },
        "& .MuiBreadcrumbs-ol": {
          flexWrap: "nowrap",
          overflow: "hidden",
          alignItems: "center",
          /* Padding expands the background; negative margin cancels the shift so text stays aligned */
          px: 1,
          py: 0.25,
          mx: -1,
          borderRadius: 1,
          width: "fit-content",
          maxWidth: "calc(100% + 16px)",
          ...activeIndicatorSx,
        },
        "& .MuiBreadcrumbs-li": {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
        },
        /* Remove button inner padding so link-buttons match plain text height */
        "& .MuiBreadcrumbs-li button": {
          p: 0,
          minWidth: 0,
        },
      }}
    >
      {/* Connection name: bold when at root, clickable link otherwise */}
      {pathParts.length === 0 ? (
        <Typography variant="caption" color="inherit" sx={{ fontWeight: "bold" }}>
          {connectionName}
        </Typography>
      ) : (
        <Link
          component="button"
          variant="caption"
          onMouseDown={preventPointerFocus}
          onFocus={handleBreadcrumbFocus}
          onClick={handleRootClick}
          tabIndex={-1}
          sx={{
            fontWeight: "regular",
            color: (theme) => theme.palette.statusBar?.textSecondary ?? theme.palette.text.secondary,
          }}
          aria-label={t("fileBrowser.chrome.breadcrumb.navigateRoot")}
        >
          {connectionName}
        </Link>
      )}

      {/* Path segments with intelligent collapse and truncation */}
      {displaySegments.map((segment) => {
        if (segment.type === "ellipsis") {
          return (
            <Typography
              key="breadcrumb-ellipsis"
              variant="caption"
              sx={{
                userSelect: "none",
                color: (theme) => theme.palette.statusBar?.textSecondary ?? theme.palette.text.secondary,
              }}
            >
              …
            </Typography>
          );
        }

        const isCurrentDir = segment.pathIndex === pathParts.length - 1;
        const fullPath = pathParts.slice(0, segment.pathIndex + 1).join("/");

        if (isCurrentDir) {
          return (
            <Typography
              key={fullPath}
              variant="caption"
              color="inherit"
              title={segment.fullLabel}
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: "bold",
              }}
            >
              {segment.label}
            </Typography>
          );
        }

        return (
          <Link
            key={fullPath}
            component="button"
            variant="caption"
            onMouseDown={preventPointerFocus}
            onFocus={handleBreadcrumbFocus}
            onClick={() => handleBreadcrumbClick(segment.pathIndex)}
            tabIndex={-1}
            aria-label={t("fileBrowser.chrome.breadcrumb.navigateTo", { path: segment.fullLabel })}
            title={segment.fullLabel}
            sx={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: "regular",
              color: (theme) => theme.palette.statusBar?.textSecondary ?? theme.palette.text.secondary,
            }}
          >
            {segment.label}
          </Link>
        );
      })}
    </Breadcrumbs>
  );
}
