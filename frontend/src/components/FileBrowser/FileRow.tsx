//
// FileRow
//

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CircleOutlinedIcon from "@mui/icons-material/CircleOutlined";
import EditNoteIcon from "@mui/icons-material/EditNote";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import ShortcutIcon from "@mui/icons-material/Shortcut";
import { Box, IconButton, Tooltip, Typography } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDate, formatFileSize } from "../../pages/FileBrowser/formatters";
import type { ViewMode } from "../../pages/FileBrowser/types";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import type { FileEntry } from "../../types";
import { getArchiveMemberUnavailableMessageKey, isShortcutFile } from "../../utils/fileEntries";
import { getFileIcon } from "../../utils/fileIcons";
import { abbreviatePath } from "../../utils/pathDisplay";
import { FileRowButton } from "./FileRowButton";

const LONG_PRESS_DURATION_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const LONG_PRESS_SUPPRESSION_DURATION_MS = 1000;

interface FileRowProps {
  file: FileEntry;
  useCompactLayout?: boolean;
  useTouchSelectionControls?: boolean;
  index: number;
  isSelected: boolean;
  isMultiSelected: boolean;
  virtualStart: number;
  virtualSize: number;
  onClick: (file: FileEntry, index: number) => void;
  onDesktopBodyClick?: (file: FileEntry, index: number, event: React.MouseEvent<HTMLButtonElement>) => void;
  onIconClick?: (file: FileEntry, index: number, extend: boolean, additive: boolean) => void;
  fileRowStyles: {
    buttonSelected: Record<string, unknown>;
    buttonNotSelected: Record<string, unknown>;
    buttonMultiSelected: Record<string, unknown>;
    buttonFocusedMultiSelected: Record<string, unknown>;
    iconBox: Record<string, unknown>;
    contentBox: Record<string, unknown>;
  };
  viewMode: ViewMode;
  showCompactActions?: boolean;
  hasUnsavedLocalDraft?: boolean;
  selectionMode?: boolean;
  onOpenItemActions?: (file: FileEntry, index: number, anchorElement: HTMLElement) => void;
  onLongPressSelect?: (file: FileEntry, index: number) => void;
}

export const shortenTargetPath = abbreviatePath;

function getCompactFileMetadata(file: FileEntry): string | null {
  if (file.type === "directory" || file.link_target?.target?.type === "directory") {
    return null;
  }

  const metadata = [formatFileSize(file.size), formatDate(file.modified_at)].filter(Boolean);
  return metadata.length > 0 ? metadata.join(" \u00b7 ") : null;
}

function TargetPathLabel({ path, rowTextSx }: { path: string; rowTextSx?: Record<string, string> }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [displayPath, setDisplayPath] = useState(path);

  useEffect(() => {
    const label = labelRef.current;
    const measurement = measureRef.current;
    if (!label || !measurement) return;

    const updatePath = () => {
      const availableWidth = label.clientWidth;
      if (availableWidth <= 0) {
        setDisplayPath(path);
        return;
      }
      const measureText = (text: string) => {
        measurement.textContent = text;
        return measurement.getBoundingClientRect().width;
      };
      setDisplayPath(shortenTargetPath(path, availableWidth, measureText));
    };

    updatePath();
    const observer = new ResizeObserver(updatePath);
    observer.observe(label);
    return () => observer.disconnect();
  }, [path]);

  return (
    <>
      <Typography variant="body2" component="span" noWrap sx={{ ...rowTextSx, color: "text.secondary", flex: "0 0 auto", mx: 1 }}>
        {"\u2192"}
      </Typography>
      <Typography
        ref={labelRef}
        variant="body2"
        component="span"
        noWrap
        title={path}
        sx={{ ...rowTextSx, color: "text.secondary", flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {displayPath}
      </Typography>
      <Typography
        ref={measureRef}
        aria-hidden
        component="span"
        sx={{ ...rowTextSx, left: -10000, position: "fixed", visibility: "hidden", whiteSpace: "nowrap" }}
      />
    </>
  );
}

/**
 * Individual file row component for virtualized list
 * Optimized with React.memo and custom comparison
 */
export const FileRow = React.memo(
  React.forwardRef<HTMLDivElement, FileRowProps>(
    (
      {
        file,
        useCompactLayout = false,
        useTouchSelectionControls = useCompactLayout,
        index,
        isSelected,
        isMultiSelected,
        virtualStart,
        virtualSize,
        onClick,
        onDesktopBodyClick,
        onIconClick,
        fileRowStyles,
        viewMode,
        showCompactActions = false,
        hasUnsavedLocalDraft = false,
        selectionMode = false,
        onOpenItemActions,
        onLongPressSelect,
      },
      ref
    ) => {
      const { t } = useTranslation();
      const longPressTimerRef = useRef<number | null>(null);
      const suppressionTimerRef = useRef<number | null>(null);
      const longPressStartRef = useRef<{ pointerId: number; clientX: number; clientY: number } | null>(null);
      const suppressNextClickRef = useRef(false);
      const suppressContextMenuRef = useRef(false);
      const suppressGestureRef = useRef(false);
      const isListMode = viewMode === "list";
      const linkTarget = file.link_target?.target;
      const isShortcut = isShortcutFile(file);
      const isUnavailableArchiveEntry = file.archive_entry_state !== undefined && !file.is_readable;
      const unavailableMessageKey = getArchiveMemberUnavailableMessageKey(file);
      const unavailableMessage = unavailableMessageKey ? t(unavailableMessageKey) : undefined;
      const rowTextSx = useCompactLayout ? { fontSize: `${COMPACT_LAYOUT_SIZE.FILE_ROW_TEXT_PX}px` } : undefined;
      const fileIconSize = useCompactLayout ? COMPACT_LAYOUT_SIZE.FILE_ROW_ICON_PX : 24;
      const compactMetadata = useCompactLayout ? getCompactFileMetadata(file) : null;
      const canOpenItemActions = showCompactActions && !isUnavailableArchiveEntry && onOpenItemActions !== undefined;
      const desktopSelection = !useTouchSelectionControls && onIconClick !== undefined;
      const itemTypeLabel = t(file.type === "directory" ? "fileBrowser.row.itemTypes.folder" : "fileBrowser.row.itemTypes.file");
      const linkTargetName = linkTarget?.name;
      const linkTargetPath = linkTarget?.path ?? linkTargetName;
      const ariaLabel = `${itemTypeLabel}: ${file.name}${
        linkTargetPath
          ? t("fileBrowser.row.shortcutTargetSuffix", { target: linkTargetPath })
          : isShortcut
            ? t("fileBrowser.row.shortcutSuffix")
            : ""
      }${hasUnsavedLocalDraft ? t("fileBrowser.row.unsavedLocalDraftSuffix") : ""}${isMultiSelected ? t("fileBrowser.row.selectedSuffix") : ""}`;

      // Compute the correct row style based on focused + multi-selected state
      const rowStyle =
        isSelected && isMultiSelected
          ? fileRowStyles.buttonFocusedMultiSelected
          : isMultiSelected
            ? fileRowStyles.buttonMultiSelected
            : isSelected
              ? fileRowStyles.buttonSelected
              : fileRowStyles.buttonNotSelected;

      const fileName = (
        <Box sx={{ display: "flex", minWidth: 0, width: "100%" }}>
          <Typography
            variant="body2"
            component="span"
            noWrap
            title={unavailableMessage ?? file.name}
            sx={{ ...rowTextSx, color: "text.primary", flex: linkTargetPath ? "0 1 auto" : 1, minWidth: 0 }}
          >
            {file.name}
          </Typography>
          {hasUnsavedLocalDraft ? (
            <Tooltip title={t("fileBrowser.row.unsavedLocalDraft")}>
              <Box
                component="span"
                role="img"
                aria-label={t("fileBrowser.row.unsavedLocalDraft")}
                sx={{ display: "inline-flex", flex: "0 0 20px", ml: 0.5 }}
              >
                <EditNoteIcon sx={{ fontSize: 18 }} />
              </Box>
            </Tooltip>
          ) : null}
          {linkTargetPath ? <TargetPathLabel path={linkTargetPath} rowTextSx={rowTextSx} /> : null}
        </Box>
      );

      const clearLongPressTimer = React.useCallback(() => {
        if (longPressTimerRef.current !== null) {
          window.clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }, []);

      const clearSuppressionTimer = React.useCallback(() => {
        if (suppressionTimerRef.current !== null) {
          window.clearTimeout(suppressionTimerRef.current);
          suppressionTimerRef.current = null;
        }
      }, []);

      useEffect(
        () => () => {
          clearLongPressTimer();
          clearSuppressionTimer();
        },
        [clearLongPressTimer, clearSuppressionTimer]
      );

      const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
        if (!useTouchSelectionControls || selectionMode || event.pointerType !== "touch" || !onLongPressSelect) return;

        const pointerId = event.pointerId;
        longPressStartRef.current = { pointerId, clientX: event.clientX, clientY: event.clientY };
        suppressContextMenuRef.current = true;
        clearLongPressTimer();
        longPressTimerRef.current = window.setTimeout(() => {
          if (longPressStartRef.current?.pointerId !== pointerId) return;

          longPressTimerRef.current = null;
          suppressNextClickRef.current = true;
          clearSuppressionTimer();
          suppressionTimerRef.current = window.setTimeout(() => {
            suppressNextClickRef.current = false;
            suppressContextMenuRef.current = false;
            suppressionTimerRef.current = null;
          }, LONG_PRESS_SUPPRESSION_DURATION_MS);
          onLongPressSelect(file, index);
        }, LONG_PRESS_DURATION_MS);
      };

      const cancelLongPress = (pointerId: number) => {
        if (longPressStartRef.current?.pointerId !== pointerId) return;

        longPressStartRef.current = null;
        clearLongPressTimer();
        if (!suppressNextClickRef.current) {
          suppressContextMenuRef.current = false;
        }
      };

      const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
        const start = longPressStartRef.current;
        if (!start || start.pointerId !== event.pointerId) return;

        if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > LONG_PRESS_MOVE_TOLERANCE_PX) {
          cancelLongPress(event.pointerId);
        }
      };

      return (
        <div
          ref={ref}
          data-index={index}
          title={unavailableMessage}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: `${virtualSize}px`,
            transform: `translateY(${virtualStart}px)`,
            willChange: "transform", // GPU acceleration hint
          }}
        >
          <FileRowButton
            tabIndex={-1}
            onClick={(event) => {
              if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                suppressContextMenuRef.current = false;
                clearSuppressionTimer();
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              if (desktopSelection && (event.button !== 0 || (suppressGestureRef.current && event.detail > 1))) return;
              if (desktopSelection && selectionMode) {
                if (event.detail === 0) return;
                suppressGestureRef.current = true;
                onDesktopBodyClick?.(file, index, event);
                return;
              }
              suppressGestureRef.current = false;
              onClick(file, index);
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => cancelLongPress(event.pointerId)}
            onPointerCancel={(event) => cancelLongPress(event.pointerId)}
            onContextMenu={(event) => {
              if (!suppressContextMenuRef.current) return;
              suppressContextMenuRef.current = false;
              event.preventDefault();
              event.stopPropagation();
            }}
            disabled={isUnavailableArchiveEntry}
            sx={[rowStyle, canOpenItemActions ? { pr: 7 } : {}, isUnavailableArchiveEntry ? { cursor: "not-allowed", opacity: 0.5 } : {}]}
            dataSelected={isSelected ? "true" : undefined}
            ariaLabel={unavailableMessage ? `${ariaLabel}. ${unavailableMessage}` : ariaLabel}
            ariaPressed={useTouchSelectionControls && selectionMode ? isMultiSelected : undefined}
          >
            {/* Selection mode uses an explicit selected/unselected icon pair. */}
            {(() => {
              const icon = (() => {
                if (isMultiSelected) {
                  return <CheckCircleIcon sx={{ fontSize: fileIconSize, color: "primary.main" }} />;
                }

                if (selectionMode) {
                  return <CircleOutlinedIcon sx={{ fontSize: fileIconSize, color: "text.secondary" }} />;
                }

                if (isShortcut) {
                  return <ShortcutIcon sx={{ fontSize: fileIconSize, color: "text.secondary" }} />;
                }

                return getFileIcon({
                  filename: file.name,
                  isDirectory: file.type === "directory",
                  size: fileIconSize,
                });
              })();

              return useCompactLayout ? (
                <>
                  <Box sx={{ ...fileRowStyles.iconBox, visibility: desktopSelection ? "hidden" : undefined }}>{icon}</Box>
                  <Box sx={{ ...fileRowStyles.contentBox, display: "flex", flexDirection: "column", minWidth: 0 }}>
                    {fileName}
                    {compactMetadata ? (
                      <Typography
                        variant="body2"
                        noWrap
                        sx={{
                          color: "text.secondary",
                          fontSize: `${COMPACT_LAYOUT_SIZE.FILE_ROW_METADATA_PX}px`,
                          fontVariantNumeric: "tabular-nums",
                          lineHeight: 1.35,
                          mt: "1px",
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          width: "100%",
                        }}
                      >
                        {compactMetadata}
                      </Typography>
                    ) : null}
                  </Box>
                </>
              ) : isListMode ? (
                // List mode: icon + name only
                <>
                  <Box sx={{ ...fileRowStyles.iconBox, visibility: desktopSelection ? "hidden" : undefined }}>{icon}</Box>
                  <Box sx={{ ...fileRowStyles.contentBox, minWidth: 0 }}>{fileName}</Box>
                </>
              ) : (
                // Details mode: icon + name + size + date in grid layout
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: `${fileIconSize}px 1fr auto auto`,
                    columnGap: 1,
                    alignItems: "center",
                    width: "100%",
                  }}
                >
                  <Box sx={{ ...fileRowStyles.iconBox, visibility: desktopSelection ? "hidden" : undefined }}>{icon}</Box>
                  <Box sx={{ ...fileRowStyles.contentBox, minWidth: 0 }}>{fileName}</Box>
                  <Typography
                    variant="body2"
                    sx={{ textAlign: "right", minWidth: "80px", ml: 1, mr: 3, ...rowTextSx, color: "text.secondary" }}
                    noWrap
                  >
                    {file.type === "directory" ? "" : formatFileSize(file.size)}
                  </Typography>
                  <Typography variant="body2" sx={{ ...rowTextSx, color: "text.secondary" }} noWrap>
                    {formatDate(file.modified_at)}
                  </Typography>
                </Box>
              );
            })()}
          </FileRowButton>
          {desktopSelection && (
            <IconButton
              role="checkbox"
              data-file-selection-icon="true"
              tabIndex={-1}
              disabled={isUnavailableArchiveEntry}
              aria-label={`${t(isMultiSelected ? "fileBrowser.compactActions.deselect" : "fileBrowser.compactActions.select")}: ${file.name}`}
              aria-checked={isMultiSelected}
              onClick={(event) => {
                event.stopPropagation();
                if (event.button !== 0 || (suppressGestureRef.current && event.detail > 1)) return;
                suppressGestureRef.current = true;
                onIconClick(file, index, event.shiftKey, event.ctrlKey || event.metaKey);
              }}
              onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") event.stopPropagation();
              }}
              sx={{
                position: "absolute",
                left: 8,
                top: "50%",
                transform: "translateY(-50%)",
                width: 40,
                height: 40,
                "& .selection-affordance": { display: "none" },
                "&:hover .selection-affordance, &:focus-visible .selection-affordance": { display: "block" },
                "&:hover .file-icon, &:focus-visible .file-icon": { display: "none" },
              }}
            >
              {selectionMode ? (
                isMultiSelected ? (
                  <CheckCircleIcon sx={{ fontSize: fileIconSize, color: "primary.main" }} />
                ) : (
                  <CircleOutlinedIcon sx={{ fontSize: fileIconSize }} />
                )
              ) : (
                <>
                  <Box className="file-icon" sx={{ display: "flex" }}>
                    {isShortcut ? (
                      <ShortcutIcon sx={{ fontSize: fileIconSize }} />
                    ) : (
                      getFileIcon({ filename: file.name, isDirectory: file.type === "directory", size: fileIconSize })
                    )}
                  </Box>
                  <CircleOutlinedIcon className="selection-affordance" sx={{ fontSize: fileIconSize }} />
                </>
              )}
            </IconButton>
          )}
          {canOpenItemActions ? (
            <IconButton
              aria-label={t("fileBrowser.compactActions.moreActionsFor", { name: file.name })}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation();
                onOpenItemActions(file, index, event.currentTarget);
              }}
              sx={{ position: "absolute", top: "50%", right: 8, width: 44, height: 44, transform: "translateY(-50%)" }}
            >
              <MoreVertIcon />
            </IconButton>
          ) : null}
        </div>
      );
    }
  ),
  // Custom comparison for optimal re-renders
  (prev, next) =>
    prev.index === next.index &&
    prev.useCompactLayout === next.useCompactLayout &&
    prev.useTouchSelectionControls === next.useTouchSelectionControls &&
    prev.fileRowStyles === next.fileRowStyles &&
    prev.isSelected === next.isSelected &&
    prev.isMultiSelected === next.isMultiSelected &&
    prev.file.name === next.file.name &&
    prev.file.modified_at === next.file.modified_at &&
    prev.file.size === next.file.size &&
    prev.file.is_readable === next.file.is_readable &&
    prev.file.archive_entry_state === next.file.archive_entry_state &&
    prev.file.link_kind === next.file.link_kind &&
    prev.file.link_target === next.file.link_target &&
    prev.virtualStart === next.virtualStart &&
    prev.virtualSize === next.virtualSize &&
    prev.viewMode === next.viewMode &&
    prev.showCompactActions === next.showCompactActions &&
    prev.hasUnsavedLocalDraft === next.hasUnsavedLocalDraft &&
    prev.selectionMode === next.selectionMode &&
    prev.onIconClick === next.onIconClick &&
    prev.onDesktopBodyClick === next.onDesktopBodyClick &&
    prev.onLongPressSelect === next.onLongPressSelect &&
    prev.onOpenItemActions === next.onOpenItemActions
);

FileRow.displayName = "FileRow";
