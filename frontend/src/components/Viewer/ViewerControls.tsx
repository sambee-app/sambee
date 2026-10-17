import { ArrowBack, ArrowForward, Close, Download, IosShare, RotateLeft, RotateRight, Search, ZoomIn, ZoomOut } from "@mui/icons-material";
import { Box, Button, Chip, IconButton, TextField, Typography, useMediaQuery, useTheme } from "@mui/material";
import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMMON_SHORTCUTS, VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { withShortcut } from "../../hooks/useKeyboardShortcuts";
import { PAGE_INPUT, RESPONSIVE_FONT_SIZE, TOOLBAR_HEIGHT, Z_INDEX } from "../../theme/constants";
import { getViewerToolbarForegroundColors, VIEWER_DEFAULTS } from "../../theme/viewerStyles";

export const VIEWER_SEARCH_INPUT_ATTRIBUTE = "data-viewer-search-input";

/**
 * Configuration for which controls to display
 */
export interface ViewerControlsConfig {
  /** Show navigation buttons (Previous/Next) */
  navigation?: boolean;
  /** Show page navigation with input field (for PDFs) */
  pageNavigation?: boolean;
  /** Show zoom controls (desktop only, mobile uses pinch-to-zoom) */
  zoom?: boolean;
  /** Show rotation controls (for images) */
  rotation?: boolean;
  /** Show search toggle/functionality */
  search?: boolean;
  /** Show download button */
  download?: boolean;
  /** Show share button */
  share?: boolean;
}

/**
 * Navigation state for gallery/multi-item viewing
 */
export interface NavigationState {
  currentIndex: number;
  totalItems: number;
  onNext?: () => void;
  onPrevious?: () => void;
}

/**
 * Page navigation state for PDFs
 */
export interface PageNavigationState {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

/**
 * Zoom control state
 */
export interface ZoomState {
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * Rotation control state (for images)
 */
export interface RotationState {
  onRotateLeft: () => void;
  onRotateRight: () => void;
}

/**
 * Search control state
 */
export interface SearchState {
  searchText: string;
  onSearchChange: (text: string) => void;
  searchMatches?: number;
  currentMatch?: number;
  onSearchNext?: () => void;
  onSearchPrevious?: () => void;
  searchPanelOpen?: boolean;
  /** Keep the toolbar search control collapsed while another surface owns the panel. */
  hideSearchPanel?: boolean;
  onSearchPanelToggle?: (open: boolean) => void;
  onSearchClose?: (reason: "escape" | "toggle") => void;
  clearSearchOnClose?: boolean;
  isSearchable?: boolean;
  searchUnavailableTitle?: string;
}

export interface ViewerControlsProps {
  /** Filename to display in the toolbar */
  filename: string;
  /** Optional adornment rendered next to the filename */
  filenameAdornment?: React.ReactNode;
  /** Configuration for which controls to show */
  config: ViewerControlsConfig;
  /** Close handler */
  onClose: () => void;
  /** Navigation state (optional) */
  navigation?: NavigationState;
  /** Page navigation state (optional, for PDFs) */
  pageNavigation?: PageNavigationState;
  /** Zoom state (optional) */
  zoom?: ZoomState;
  /** Rotation state (optional, for images) */
  rotation?: RotationState;
  /** Search state (optional) */
  search?: SearchState;
  /** Generic viewer actions rendered as text buttons or icon buttons */
  actions?: ViewerToolbarAction[];
  /** Optional component rendered with viewer actions in the toolbar */
  toolbarAccessory?: React.ReactNode;
  /** Download handler (optional) */
  onDownload?: () => void;
  /** Share handler (optional) */
  onShare?: () => void;
  shareControl?: React.ReactNode;
  /** Warm share payload on early user intent (optional) */
  onShareIntent?: () => void;
  /** Disable share button while work is in progress */
  shareDisabled?: boolean;
  /** Disable page and viewing controls while content is unavailable */
  controlsDisabled?: boolean;
  /** Override gallery navigation disable behavior when navigation remains safe */
  navigationDisabled?: boolean;
  /** Disable download while the source is not yet available */
  downloadDisabled?: boolean;
  /** Toolbar background color from theme */
  toolbarBackground?: string;
  /** Toolbar text color from theme */
  toolbarText?: string;
  /** Whether to render the default close button */
  showCloseButton?: boolean;
}

interface ViewerFilenameBadgeProps {
  label: string;
  toolbarText?: string;
}

interface ViewerToolbarActionBase {
  id: string;
  onClick: () => void;
  label: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export interface ViewerButtonToolbarAction extends ViewerToolbarActionBase {
  kind?: "button";
  variant?: "text" | "outlined" | "contained";
}

export interface ViewerIconToolbarAction extends ViewerToolbarActionBase {
  kind: "icon";
  icon: React.ReactNode;
}

export type ViewerToolbarAction = ViewerButtonToolbarAction | ViewerIconToolbarAction;

export const ViewerFilenameBadge: React.FC<ViewerFilenameBadgeProps> = ({ label, toolbarText = VIEWER_DEFAULTS.TOOLBAR_TEXT }) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const toolbarForegrounds = getViewerToolbarForegroundColors(toolbarText);

  return (
    <Chip
      component="span"
      label={label}
      size="small"
      variant="outlined"
      sx={{
        height: isMobile ? 20 : 22,
        color: toolbarText,
        borderColor: toolbarForegrounds.disabled,
        backgroundColor: toolbarForegrounds.subtleBackground,
        "& .MuiChip-label": {
          px: isMobile ? 0.75 : 1,
          fontSize: isMobile ? "0.6875rem" : "0.75rem",
          fontWeight: 600,
          lineHeight: 1,
        },
      }}
    />
  );
};

/**
 * Centralized viewer controls component
 * Shared toolbar for image and PDF viewers with configurable buttons
 */
export const ViewerControls: React.FC<ViewerControlsProps> = ({
  filename,
  config,
  onClose,
  navigation,
  pageNavigation,
  zoom,
  filenameAdornment,
  rotation,
  search,
  actions,
  toolbarAccessory,
  onDownload,
  onShare,
  shareControl,
  onShareIntent,
  shareDisabled = false,
  controlsDisabled = false,
  navigationDisabled = controlsDisabled,
  downloadDisabled = false,
  toolbarBackground = VIEWER_DEFAULTS.TOOLBAR_BG,
  toolbarText = VIEWER_DEFAULTS.TOOLBAR_TEXT,
  showCloseButton = true,
}) => {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { t } = useTranslation();
  const toolbarForegrounds = getViewerToolbarForegroundColors(toolbarText);
  const [pageInput, setPageInput] = useState(pageNavigation ? pageNavigation.currentPage.toString() : "");
  const [localShowSearch, setLocalShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Use controlled search panel state if provided, otherwise use local state
  const showSearch = !search?.hideSearchPanel && (search?.searchPanelOpen !== undefined ? search.searchPanelOpen : localShowSearch);
  const searchTextLength = search?.searchText.length ?? 0;
  const searchMatches = search?.searchMatches ?? 0;
  const currentMatch = search?.currentMatch ?? 0;
  const currentPage = pageNavigation?.currentPage;
  const canNavigateSearch = searchMatches > 0;
  const previousShowSearchRef = useRef(showSearch);
  const closeSearch = (reason: "escape" | "toggle") => {
    setShowSearch(false);

    if (search?.clearSearchOnClose !== false) {
      search?.onSearchChange("");
    }

    search?.onSearchClose?.(reason);
  };

  const setShowSearch = (open: boolean) => {
    if (search?.onSearchPanelToggle) {
      search.onSearchPanelToggle(open);
    } else {
      setLocalShowSearch(open);
    }
  };

  // Update page input when page changes externally
  React.useEffect(() => {
    if (currentPage !== undefined) {
      setPageInput(currentPage.toString());
    }
  }, [currentPage]);

  React.useEffect(() => {
    const justOpened = showSearch && !previousShowSearchRef.current;
    previousShowSearchRef.current = showSearch;

    if (!justOpened) {
      return;
    }

    if (!showSearch) {
      return;
    }

    const searchInput = searchInputRef.current;

    if (!searchInput) {
      return;
    }

    searchInput.focus();

    if (searchTextLength > 0) {
      searchInput.select();
    }
  }, [showSearch, searchTextLength]);

  const handlePageInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(event.target.value);
  };

  const commitPageInput = (rawValue: string) => {
    if (!pageNavigation) return;
    const pageNum = Number.parseInt(rawValue, 10);
    if (pageNum >= 1 && pageNum <= pageNavigation.totalPages) {
      pageNavigation.onPageChange(pageNum);
    } else {
      setPageInput(pageNavigation.currentPage.toString());
    }
  };

  const getInputValue = (eventTarget: EventTarget | null) => {
    return eventTarget instanceof HTMLInputElement ? eventTarget.value : pageInput;
  };

  const handlePageInputBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    commitPageInput(getInputValue(event.target));
  };

  const handlePageInputSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    commitPageInput(pageInput);

    if (document.activeElement instanceof HTMLInputElement) {
      document.activeElement.blur();
    }
  };

  const handlePreviousPage = () => {
    if (!pageNavigation) return;
    if (pageNavigation.currentPage > 1) {
      pageNavigation.onPageChange(pageNavigation.currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (!pageNavigation) return;
    if (pageNavigation.currentPage < pageNavigation.totalPages) {
      pageNavigation.onPageChange(pageNavigation.currentPage + 1);
    }
  };

  const renderToolbarAction = (action: ViewerToolbarAction) => {
    if (action.kind === "icon") {
      return (
        <IconButton
          key={action.id}
          color="inherit"
          onClick={action.onClick}
          aria-label={action.ariaLabel ?? action.label}
          title={action.title ?? action.label}
          disabled={controlsDisabled || action.disabled}
          size={isMobile ? "small" : "medium"}
        >
          {action.icon}
        </IconButton>
      );
    }

    return (
      <Button
        key={action.id}
        color="inherit"
        onClick={action.onClick}
        aria-label={action.ariaLabel ?? action.label}
        title={action.title ?? action.label}
        disabled={controlsDisabled || action.disabled}
        size={isMobile ? "small" : "medium"}
        variant={action.variant ?? "text"}
        sx={{
          color: toolbarText,
          borderColor: toolbarForegrounds.disabled,
          whiteSpace: "nowrap",
          minWidth: 0,
          px: isMobile ? 1 : 1.5,
        }}
      >
        {action.label}
      </Button>
    );
  };

  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        bgcolor: toolbarBackground,
        color: toolbarText,
        display: "flex",
        flexDirection: isMobile && showSearch ? "column" : "row",
        alignItems: isMobile && showSearch ? "stretch" : "center",
        gap: isMobile ? theme.spacing(0.5) : theme.spacing(2),
        minHeight: isMobile ? `${TOOLBAR_HEIGHT.MOBILE_PX}px` : `${TOOLBAR_HEIGHT.DESKTOP_PX}px`,
        paddingTop: isMobile ? `calc(${theme.spacing(1)} + env(safe-area-inset-top, 0px))` : 0,
        paddingBottom: isMobile ? theme.spacing(1) : 0,
        paddingLeft: isMobile ? theme.spacing(1) : theme.spacing(2),
        paddingRight: isMobile ? theme.spacing(1) : theme.spacing(2),
        zIndex: Z_INDEX.VIEWER_TOOLBAR,
        boxSizing: "border-box",
      }}
    >
      {/* First row: Filename and main controls */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: isMobile && showSearch ? "wrap" : "nowrap",
          gap: isMobile ? theme.spacing(0.5) : theme.spacing(2),
          flex: 1,
          minWidth: 0,
        }}
      >
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: isMobile ? theme.spacing(0.75) : theme.spacing(1),
          }}
        >
          <Typography
            component="span"
            variant={isMobile ? "body2" : "h6"}
            sx={{
              flexShrink: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: RESPONSIVE_FONT_SIZE.BODY,
              minWidth: 0,
            }}
          >
            {filename}
          </Typography>

          {filenameAdornment && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
            >
              {filenameAdornment}
            </Box>
          )}

          {navigation && navigation.totalItems > 1 && (
            <Typography
              component="span"
              variant="caption"
              sx={{
                color: toolbarForegrounds.muted,
                fontSize: RESPONSIVE_FONT_SIZE.CAPTION,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {navigation.currentIndex + 1} / {navigation.totalItems}
            </Typography>
          )}
        </Box>

        {/* Gallery navigation */}
        {config.navigation && navigation && navigation.totalItems > 1 && !isMobile && (
          <>
            <IconButton
              color="inherit"
              onClick={navigation.onPrevious}
              disabled={navigationDisabled || navigation.currentIndex === 0}
              title={withShortcut(COMMON_SHORTCUTS.PREVIOUS_ARROW)}
              aria-label={t("viewer.controls.previous")}
              size={isMobile ? "small" : "medium"}
              sx={{
                "&.Mui-disabled": {
                  color: toolbarBackground,
                },
              }}
            >
              <ArrowBack fontSize={isMobile ? "small" : "medium"} />
            </IconButton>

            <IconButton
              color="inherit"
              onClick={navigation.onNext}
              disabled={navigationDisabled || navigation.currentIndex === navigation.totalItems - 1}
              title={withShortcut(COMMON_SHORTCUTS.NEXT_ARROW)}
              aria-label={t("viewer.controls.next")}
              size={isMobile ? "small" : "medium"}
              sx={{
                "&.Mui-disabled": {
                  color: toolbarBackground,
                },
              }}
            >
              <ArrowForward fontSize={isMobile ? "small" : "medium"} />
            </IconButton>
          </>
        )}

        {/* Page navigation (for PDFs) */}
        {config.pageNavigation && pageNavigation && pageNavigation.totalPages > 0 && (
          <Box
            component="form"
            onSubmit={handlePageInputSubmit}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: isMobile ? 0.5 : 1,
            }}
          >
            <IconButton
              color="inherit"
              onClick={handlePreviousPage}
              type="button"
              disabled={controlsDisabled || pageNavigation.currentPage <= 1}
              title={withShortcut(COMMON_SHORTCUTS.PAGE_UP)}
              aria-label={t("viewer.controls.previousPage")}
              size={isMobile ? "small" : "medium"}
              sx={{
                "&.Mui-disabled": {
                  color: toolbarBackground,
                },
              }}
            >
              <ArrowBack fontSize={isMobile ? "small" : "medium"} />
            </IconButton>

            <TextField
              value={pageInput}
              onChange={handlePageInputChange}
              disabled={controlsDisabled}
              size="small"
              slotProps={{
                htmlInput: {
                  inputMode: "numeric",
                  pattern: "[0-9]*",
                  onBlur: handlePageInputBlur,
                },
              }}
              sx={{
                width: isMobile ? `${PAGE_INPUT.WIDTH_MOBILE_PX}px` : `${PAGE_INPUT.WIDTH_DESKTOP_PX}px`,
                "& .MuiInputBase-root": {
                  color: toolbarText,
                  fontSize: isMobile ? "0.75rem" : "0.875rem",
                },
                "& .MuiOutlinedInput-notchedOutline": {
                  borderColor: toolbarForegrounds.border,
                },
                "&:hover .MuiOutlinedInput-notchedOutline": {
                  borderColor: toolbarForegrounds.borderHover,
                },
                "& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline": {
                  borderColor: "primary.main",
                },
                "& .MuiInputBase-input": {
                  textAlign: "center",
                  padding: isMobile ? `${PAGE_INPUT.PADDING_MOBILE_PX}px` : `${PAGE_INPUT.PADDING_DESKTOP_PX}px`,
                },
              }}
            />

            <Typography variant={isMobile ? "caption" : "body2"} sx={{ whiteSpace: "nowrap" }}>
              / {pageNavigation.totalPages}
            </Typography>

            <IconButton
              color="inherit"
              onClick={handleNextPage}
              type="button"
              disabled={controlsDisabled || pageNavigation.currentPage >= pageNavigation.totalPages}
              title={withShortcut(COMMON_SHORTCUTS.PAGE_DOWN)}
              aria-label={t("viewer.controls.nextPage")}
              size={isMobile ? "small" : "medium"}
              sx={{
                "&.Mui-disabled": {
                  color: toolbarBackground,
                },
              }}
            >
              <ArrowForward fontSize={isMobile ? "small" : "medium"} />
            </IconButton>
          </Box>
        )}

        {/* Zoom controls - desktop only, mobile uses pinch-to-zoom */}
        {config.zoom && zoom && !isMobile && (
          <Box sx={{ display: "flex", gap: 0 }}>
            <IconButton
              color="inherit"
              onClick={zoom.onZoomOut}
              disabled={controlsDisabled}
              title={withShortcut(VIEWER_SHORTCUTS.ZOOM_OUT)}
              aria-label={t("viewer.controls.zoomOut")}
              size="medium"
            >
              <ZoomOut />
            </IconButton>

            <IconButton
              color="inherit"
              onClick={zoom.onZoomIn}
              disabled={controlsDisabled}
              title={withShortcut(VIEWER_SHORTCUTS.ZOOM_IN)}
              aria-label={t("viewer.controls.zoomIn")}
              size="medium"
            >
              <ZoomIn />
            </IconButton>
          </Box>
        )}

        {/* Rotation controls */}
        {config.rotation && rotation && (
          <Box sx={{ display: "flex", gap: 0 }}>
            {!isMobile && (
              <IconButton
                color="inherit"
                onClick={rotation.onRotateLeft}
                disabled={controlsDisabled}
                title={withShortcut(VIEWER_SHORTCUTS.ROTATE_LEFT)}
                aria-label={t("viewer.controls.rotateLeft")}
                size="medium"
              >
                <RotateLeft />
              </IconButton>
            )}

            <IconButton
              color="inherit"
              onClick={rotation.onRotateRight}
              disabled={controlsDisabled}
              title={withShortcut(VIEWER_SHORTCUTS.ROTATE_RIGHT)}
              aria-label={t("viewer.controls.rotateRight")}
              size={isMobile ? "small" : "medium"}
            >
              <RotateRight fontSize={isMobile ? "small" : "medium"} />
            </IconButton>
          </Box>
        )}

        {/* Search control */}
        {config.search &&
          search &&
          (showSearch ? (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                flexShrink: 0,
                minWidth: 0,
                width: isMobile ? "min(100%, 320px)" : "320px",
                maxWidth: isMobile ? "100%" : "360px",
              }}
            >
              <TextField
                value={search.searchText}
                onChange={(e) => search.onSearchChange(e.target.value)}
                disabled={controlsDisabled}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && search.onSearchNext) {
                    e.preventDefault();
                    search.onSearchNext();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeSearch("escape");
                  }
                }}
                placeholder={t("common.search.placeholder")}
                size="small"
                inputRef={searchInputRef}
                slotProps={{
                  htmlInput: {
                    [VIEWER_SEARCH_INPUT_ATTRIBUTE]: "true",
                  },
                }}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  "& .MuiInputBase-root": {
                    color: toolbarText,
                    fontSize: "0.875rem",
                  },
                  "& .MuiOutlinedInput-notchedOutline": {
                    borderColor: toolbarForegrounds.border,
                  },
                  "&:hover .MuiOutlinedInput-notchedOutline": {
                    borderColor: toolbarForegrounds.borderHover,
                  },
                  "& .MuiInputBase-input::placeholder": {
                    color: toolbarForegrounds.muted,
                    opacity: 1,
                  },
                }}
              />

              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.25,
                  flexShrink: 0,
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    minWidth: "4ch",
                    textAlign: "left",
                    fontVariantNumeric: "tabular-nums",
                    color: canNavigateSearch ? toolbarText : toolbarForegrounds.disabled,
                  }}
                >
                  {currentMatch} / {searchMatches}
                </Typography>

                <IconButton
                  color="inherit"
                  onClick={search.onSearchPrevious}
                  disabled={controlsDisabled || !search.onSearchPrevious || !canNavigateSearch}
                  title={t("common.search.previousMatch")}
                  aria-label={t("common.search.previousMatch")}
                  size="small"
                  sx={{
                    flexShrink: 0,
                    "&.Mui-disabled": {
                      color: toolbarForegrounds.disabled,
                    },
                  }}
                >
                  <ArrowBack fontSize="small" />
                </IconButton>

                <IconButton
                  color="inherit"
                  onClick={search.onSearchNext}
                  disabled={controlsDisabled || !search.onSearchNext || !canNavigateSearch}
                  title={t("common.search.nextMatch")}
                  aria-label={t("common.search.nextMatch")}
                  size="small"
                  sx={{
                    flexShrink: 0,
                    "&.Mui-disabled": {
                      color: toolbarForegrounds.disabled,
                    },
                  }}
                >
                  <ArrowForward fontSize="small" />
                </IconButton>

                <IconButton
                  color="inherit"
                  onClick={() => {
                    closeSearch("toggle");
                  }}
                  title={t("common.search.closeSearch", { defaultValue: "Close search" })}
                  aria-label={t("common.search.closeSearch", { defaultValue: "Close search" })}
                  size="small"
                  disabled={controlsDisabled}
                  sx={{ flexShrink: 0 }}
                >
                  <Close fontSize="small" />
                </IconButton>
              </Box>
            </Box>
          ) : (
            <IconButton
              color="inherit"
              onClick={() => {
                setShowSearch(true);
              }}
              title={
                search.isSearchable === false
                  ? (search.searchUnavailableTitle ?? t("viewer.controls.searchUnavailable"))
                  : withShortcut(COMMON_SHORTCUTS.SEARCH)
              }
              aria-label={t("common.search.action")}
              size={isMobile ? "small" : "medium"}
              disabled={controlsDisabled || search.isSearchable === false}
              sx={{
                ...(search.isSearchable === false && {
                  opacity: 0.5,
                  cursor: "not-allowed",
                }),
              }}
            >
              <Search fontSize={isMobile ? "small" : "medium"} />
            </IconButton>
          ))}

        {/* Download button */}
        {config.download && onDownload && !isMobile && (
          <IconButton
            color="inherit"
            onClick={onDownload}
            title={withShortcut(COMMON_SHORTCUTS.DOWNLOAD)}
            aria-label={t("common.actions.download")}
            size="medium"
            disabled={downloadDisabled}
          >
            <Download />
          </IconButton>
        )}

        {/* Share button */}
        {config.share &&
          isMobile &&
          (shareControl ??
            (onShare && (
              <IconButton
                color="inherit"
                onClick={onShare}
                onPointerDown={onShareIntent}
                aria-label={t("common.actions.share")}
                title={t("common.actions.share")}
                size="small"
                disabled={controlsDisabled || shareDisabled}
              >
                <IosShare fontSize="small" />
              </IconButton>
            )))}

        {toolbarAccessory}

        {actions?.map(renderToolbarAction)}

        {showCloseButton && (
          <IconButton
            color="inherit"
            onClick={onClose}
            title={withShortcut(COMMON_SHORTCUTS.CLOSE)}
            aria-label={t("common.actions.close")}
            size={isMobile ? "small" : "medium"}
          >
            <Close fontSize={isMobile ? "small" : "medium"} />
          </IconButton>
        )}
      </Box>
    </Box>
  );
};

export default ViewerControls;
