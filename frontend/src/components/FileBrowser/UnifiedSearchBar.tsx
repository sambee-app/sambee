//
// UnifiedSearchBar
//

/**
 * Unified Search Bar Component
 * =============================
 *
 * A modular search bar that accepts a SearchProvider to deliver
 * pluggable search functionality. Renders inline in the header
 * (or mobile sticky area) with a dropdown results panel.
 *
 * Features:
 * - Debounced input driven by the provider's debounceMs
 * - Keyboard navigation: Up/Down/Enter/Escape
 * - Click selection on results
 * - Provider status indicator (e.g., "Indexing...")
 * - Footer hints and info from the provider
 * - Activates provider on focus, deactivates on dismiss
 * - Responsive: works in both desktop header and mobile sticky bar
 */

import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ClearIcon from "@mui/icons-material/Clear";
import {
  Box,
  Button,
  CircularProgress,
  ClickAwayListener,
  Divider,
  IconButton,
  InputAdornment,
  ListItemButton,
  Menu,
  MenuItem,
  Paper,
  Popper,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import { useVirtualizer } from "@tanstack/react-virtual";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePillButtonMenu } from "../../hooks/usePillButtonMenu";
import { getSecondaryToolbarMenuPaperStyle, pillButtonStyle } from "../../theme/commonStyles";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import { PillButtonTooltip } from "./PillButtonTooltip";
import {
  getQuickBarResultRowHeight,
  QUICK_BAR_RESULT_ITEM_HEIGHT,
  QuickBarResultGroupHeader,
  QuickBarResultRow,
} from "./QuickBarResultRow";
import type { SearchProvider, SearchResult, SearchSelectionAction, SearchSelectionBehavior } from "./search/types";

// ============================================================================
// Constants
// ============================================================================

/** Maximum visible results before the list scrolls */
const MAX_VISIBLE_RESULTS = 10;

/** Desired dropdown width in pixels (static per viewport) */
const DROPDOWN_WIDTH_PX = 700;

/** Number of items to jump with Page Up/Down */
const PAGE_JUMP_SIZE = 10;

/** Preserve touch comfort on mobile while tightening desktop density slightly. */
const QUICK_BAR_SPACING = {
  xs: { horizontal: 10, vertical: 10 },
  sm: { horizontal: 8, vertical: 8 },
} as const;

const INPUT_PADDING = {
  xs: `${QUICK_BAR_SPACING.xs.vertical}px ${QUICK_BAR_SPACING.xs.horizontal}px`,
  sm: `${QUICK_BAR_SPACING.sm.vertical}px ${QUICK_BAR_SPACING.sm.horizontal}px`,
} as const;

const HORIZONTAL_CHROME_SPACING = {
  xs: `${QUICK_BAR_SPACING.xs.horizontal}px`,
  sm: `${QUICK_BAR_SPACING.sm.horizontal}px`,
} as const;

function getQuickBarModeLabelSx(useCompactLayout: boolean) {
  return {
    fontSize: useCompactLayout ? `${COMPACT_LAYOUT_SIZE.SEARCH_MODE_LABEL_PX}px` : "0.7rem",
    fontWeight: 600,
    lineHeight: 1.2,
  } as const;
}

const QUICK_BAR_MODE_BUTTON_SX = {
  ...pillButtonStyle,
  minHeight: { xs: 32, sm: 28 },
  minWidth: "auto",
  px: { xs: 1, sm: 0.75 },
  py: { xs: 0.125, sm: 0 },
  borderRadius: 2.5,
  color: "text.secondary",
} as const;

const QUICK_BAR_CLEAR_BUTTON_SX = {
  minWidth: { xs: 44, sm: 26 },
  minHeight: { xs: 44, sm: 26 },
  width: { sm: 26 },
  height: { sm: 26 },
  p: { sm: 0.375 },
} as const;

const QUICK_BAR_MODE_MENU_ITEM_SX = {
  fontSize: "0.8125rem",
  lineHeight: 1.35,
} as const;

// ============================================================================
// Props
// ============================================================================

interface UnifiedSearchBarProps {
  /** The search provider supplying results and behavior */
  provider: SearchProvider;
  /** Increments whenever the quick bar is explicitly reopened and should reset transient state. */
  activationToken?: number;
  /** Increments whenever visible results should refresh without changing dropdown visibility. */
  refreshToken?: number;
  /** Ref forwarded to the underlying <input> element */
  inputRef?: React.RefObject<HTMLInputElement>;
  /** Remove from Tab order (dual-pane mode uses Tab for pane switching) */
  disableTabFocus?: boolean;
  /** Whether to use compact (mobile) layout styling */
  useCompactLayout?: boolean;
  /** Called when Escape is pressed with an empty query and closed dropdown */
  onBlurToFileList?: () => void;
  /** Controlled query value for modes that should persist outside the search bar. */
  queryValue?: string;
  /** Controlled query change handler. */
  onQueryValueChange?: (value: string) => void;
  /** Disable dropdown search behavior and use the input as a plain filter box. */
  disableDropdown?: boolean;
  /** Called when ArrowDown should hand focus from the input to the file list. */
  onArrowDownToFileList?: () => void;
  /** Explicit quick-bar mode options shown in the mode-selector menu. */
  modeOptions?: UnifiedSearchBarModeOption[];
  /** Accessible label for the quick-bar mode selector trigger. */
  modeSelectorAriaLabel?: string;
  /** Temporarily suppress the results dropdown while a higher-priority overlay is open. */
  suppressDropdown?: boolean;
  /** Whether keyboard shortcut hints are relevant in the current input context. */
  showKeyboardHints?: boolean;
}

export interface UnifiedSearchBarModeOption {
  id: string;
  label: string;
  onSelect: () => void;
}

// ============================================================================
// Component
// ============================================================================

//
// UnifiedSearchBar
//
export function UnifiedSearchBar({
  provider,
  activationToken = 0,
  refreshToken = 0,
  inputRef,
  useCompactLayout = false,
  onBlurToFileList,
  queryValue,
  onQueryValueChange,
  disableDropdown = false,
  onArrowDownToFileList,
  disableTabFocus,
  modeOptions,
  modeSelectorAriaLabel,
  suppressDropdown = false,
  showKeyboardHints = true,
}: UnifiedSearchBarProps) {
  // ── State ──────────────────────────────────────────────────────────────
  const [internalQuery, setInternalQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isSearchPending, setIsSearchPending] = useState(false);

  const theme = useTheme();
  const { t } = useTranslation();
  const {
    anchorEl: modeMenuAnchorEl,
    open: isModeMenuOpen,
    handleClick: handleModeMenuClick,
    handleKeyDown: handleModeMenuKeyDown,
    handleKeyUp: handleModeMenuKeyUp,
    handleClose: handleModeMenuClose,
  } = usePillButtonMenu();

  // ── Refs ───────────────────────────────────────────────────────────────
  const anchorRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQueryRef = useRef<string>("");
  const providerRef = useRef(provider);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const activatedRef = useRef(false);
  const lastResetProviderRef = useRef(provider);
  const lastActivationTokenRef = useRef(activationToken);
  const lastRefreshTokenRef = useRef(refreshToken);
  const wasDropdownSuppressedRef = useRef(suppressDropdown);

  // Always keep providerRef current so stable callbacks use the latest provider
  providerRef.current = provider;

  const isControlledQuery = queryValue !== undefined;
  const query = isControlledQuery ? queryValue : internalQuery;

  const setQuery = useCallback(
    (value: string) => {
      providerRef.current.onQueryChange?.(value);
      onQueryValueChange?.(value);

      if (isControlledQuery) {
        return;
      }

      setInternalQuery(value);
    },
    [isControlledQuery, onQueryValueChange]
  );

  // Use external inputRef if provided, otherwise internal
  const effectiveInputRef = inputRef ?? internalInputRef;

  const getEffectiveMinQueryLength = useCallback(
    (value: string) => provider.getMinQueryLength?.(value) ?? provider.minQueryLength,
    [provider]
  );

  const getEffectiveBelowMinimumMessage = useCallback(
    (value: string) => provider.getBelowMinimumMessage?.(value) ?? provider.belowMinimumMessage,
    [provider]
  );

  // ── Keyboard shortcut badge (memoized) ─────────────────────────────────
  const kbdBadge = useMemo(() => {
    if (!provider.shortcutHint || useCompactLayout) return null;
    return (
      <Box
        component="kbd"
        aria-hidden="true"
        sx={{
          display: "inline-block",
          fontFamily: "inherit",
          fontSize: "0.7rem",
          lineHeight: 1,
          px: 0.75,
          py: 0.3,
          borderRadius: 0.5,
          border: 1,
          borderColor: "divider",
          color: "text.disabled",
          backgroundColor: theme.palette.action.selected,
          whiteSpace: "nowrap",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {provider.shortcutHint}
      </Box>
    );
  }, [provider.shortcutHint, theme.palette.action.selected, useCompactLayout]);

  const handleModeSelect = useCallback(
    (modeOption: UnifiedSearchBarModeOption) => {
      modeOption.onSelect();
      handleModeMenuClose();
    },
    [handleModeMenuClose]
  );

  const focusQuickBarInput = useCallback(() => {
    setTimeout(() => {
      effectiveInputRef.current?.focus();
      effectiveInputRef.current?.select();
    }, 0);
  }, [effectiveInputRef]);

  const handleModeTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        focusQuickBarInput();
        return;
      }

      handleModeMenuKeyDown(event);
    },
    [focusQuickBarInput, handleModeMenuKeyDown]
  );

  const modeSelector = useMemo(() => {
    if (!provider.modeLabel || !provider.modeId || !modeOptions || modeOptions.length === 0) {
      return null;
    }

    const modeSelectorLabel = modeSelectorAriaLabel ?? t("fileBrowser.search.modeSelectorAriaLabel");

    return (
      <>
        <PillButtonTooltip label={modeSelectorLabel}>
          <Button
            onClick={handleModeMenuClick}
            onKeyDown={handleModeTriggerKeyDown}
            onKeyUp={handleModeMenuKeyUp}
            size="small"
            tabIndex={disableTabFocus ? -1 : undefined}
            aria-label={modeSelectorLabel}
            aria-controls={isModeMenuOpen ? "quick-bar-mode-menu" : undefined}
            aria-haspopup="true"
            aria-expanded={isModeMenuOpen ? "true" : undefined}
            sx={QUICK_BAR_MODE_BUTTON_SX}
          >
            <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.125, whiteSpace: "nowrap" }}>
              <Typography variant="body2" sx={getQuickBarModeLabelSx(useCompactLayout)}>
                {provider.modeLabel}
              </Typography>
              <ArrowDropDownIcon sx={{ fontSize: "1rem" }} />
            </Box>
          </Button>
        </PillButtonTooltip>
        <Menu
          id="quick-bar-mode-menu"
          anchorEl={modeMenuAnchorEl}
          open={isModeMenuOpen}
          onClose={(_event, reason) => {
            handleModeMenuClose();

            if (reason === "escapeKeyDown") {
              focusQuickBarInput();
            }
          }}
          anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          transformOrigin={{ vertical: "top", horizontal: "left" }}
          slotProps={{
            paper: {
              sx: (menuTheme) => ({
                ...getSecondaryToolbarMenuPaperStyle(menuTheme),
                minWidth: 180,
              }),
            },
          }}
        >
          {modeOptions.flatMap((modeOption, index) => {
            const items = [];

            if (index > 0) {
              items.push(<Divider key={`${modeOption.id}-divider`} />);
            }

            items.push(
              <MenuItem
                key={modeOption.id}
                onClick={() => handleModeSelect(modeOption)}
                selected={modeOption.id === provider.modeId}
                sx={QUICK_BAR_MODE_MENU_ITEM_SX}
              >
                {modeOption.label}
              </MenuItem>
            );

            return items;
          })}
        </Menu>
      </>
    );
  }, [
    disableTabFocus,
    focusQuickBarInput,
    handleModeMenuClick,
    handleModeMenuClose,
    handleModeMenuKeyUp,
    handleModeTriggerKeyDown,
    handleModeSelect,
    isModeMenuOpen,
    modeMenuAnchorEl,
    modeOptions,
    modeSelectorAriaLabel,
    provider.modeId,
    provider.modeLabel,
    t,
    useCompactLayout,
  ]);

  const endAdornment = useMemo(() => {
    const showShortcutBadge = !query && !isFocused && !!kbdBadge;

    if (!query && !isLoading && !showShortcutBadge) {
      return undefined;
    }

    return (
      <InputAdornment
        position="end"
        sx={{
          ml: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          {isLoading ? <CircularProgress size={18} /> : null}
          {query ? (
            <IconButton
              size="small"
              onClick={() => {
                setQuery("");
                setResults([]);
                setIsDropdownOpen(false);
                setHasSearched(false);
                setSearchError(false);
                effectiveInputRef.current?.focus();
              }}
              edge="end"
              sx={QUICK_BAR_CLEAR_BUTTON_SX}
              aria-label={t("common.search.clear")}
            >
              <ClearIcon fontSize={useCompactLayout ? "medium" : "small"} />
            </IconButton>
          ) : showShortcutBadge ? (
            kbdBadge
          ) : null}
        </Box>
      </InputAdornment>
    );
  }, [effectiveInputRef, isFocused, isLoading, kbdBadge, query, setQuery, t, useCompactLayout]);

  // ── Search execution ───────────────────────────────────────────────────

  //
  // executeSearch
  //
  const executeSearch = useCallback(
    async (searchQuery: string, openDropdown = true) => {
      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        setIsSearchPending(false);
        setIsLoading(true);
        setSearchError(false);
        setRemoveError(false);
        const fetchedResults = await providerRef.current.fetchResults(searchQuery, controller.signal);

        if (!controller.signal.aborted) {
          setResults(fetchedResults);
          setSelectedIndex(
            Math.max(
              fetchedResults.findIndex((result) => result.kind !== "group-header"),
              0
            )
          );
          setHasSearched(true);
          if (openDropdown) {
            setIsDropdownOpen(true);
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          setResults([]);
          setHasSearched(true);
          setSearchError(true);
          if (openDropdown) {
            setIsDropdownOpen(true);
          }
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    // providerRef is stable — no dependency on provider object identity
    []
  );

  // ── Input handling ─────────────────────────────────────────────────────

  //
  // handleInputChange
  //
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newQuery = e.target.value;
      const effectiveMinQueryLength = getEffectiveMinQueryLength(newQuery);
      const effectiveBelowMinimumMessage = getEffectiveBelowMinimumMessage(newQuery);

      setQuery(newQuery);
      setRemoveError(false);

      if (disableDropdown) {
        setResults([]);
        setSelectedIndex(0);
        setHasSearched(false);
        setSearchError(false);
        setIsDropdownOpen(false);
        setIsSearchPending(false);
        return;
      }

      // Clear previous debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      if (newQuery.length >= effectiveMinQueryLength) {
        setSearchError(false);
        setIsSearchPending(true);
        pendingQueryRef.current = newQuery;
        debounceTimerRef.current = setTimeout(() => {
          executeSearch(pendingQueryRef.current);
        }, provider.debounceMs);
      } else {
        setIsSearchPending(false);
        setResults([]);
        setSelectedIndex(0);
        setHasSearched(false);
        setSearchError(false);
        if (newQuery.length === 0) {
          setIsDropdownOpen(false);
        } else if (effectiveBelowMinimumMessage) {
          // Show hint when query is non-empty but below minimum length
          setIsDropdownOpen(true);
        }
      }
    },
    [disableDropdown, provider.debounceMs, executeSearch, getEffectiveBelowMinimumMessage, getEffectiveMinQueryLength, setQuery]
  );

  // ── Selection handling ─────────────────────────────────────────────────

  const findSelectableResultIndex = useCallback(
    (startIndex: number, direction: 1 | -1) => {
      for (let index = startIndex; index >= 0 && index < results.length; index += direction) {
        if (results[index]?.kind !== "group-header") {
          return index;
        }
      }
      return selectedIndex;
    },
    [results, selectedIndex]
  );

  const handleRemoveSelected = useCallback(async () => {
    const selectedResult = results[selectedIndex];
    if (!selectedResult || selectedResult.kind === "group-header" || !providerRef.current.onRemoveSelected) {
      return;
    }

    try {
      setRemoveError(false);
      if (await providerRef.current.onRemoveSelected(selectedResult.value)) {
        await executeSearch(query);
        effectiveInputRef.current?.focus();
      }
    } catch {
      setRemoveError(true);
      setIsDropdownOpen(true);
      effectiveInputRef.current?.focus();
    }
  }, [effectiveInputRef, executeSearch, query, results, selectedIndex]);

  //
  // handleSelect
  //
  const handleSelect = useCallback(
    (value: string, action: SearchSelectionAction = "associated-viewer") => {
      // Apply quick-bar teardown before command side effects open other overlays.
      flushSync(() => {
        setQuery("");
        setResults([]);
        setIsDropdownOpen(false);
        setHasSearched(false);
      });

      const selectionBehavior: SearchSelectionBehavior | undefined = providerRef.current.onSelect(value, action);

      const focusTarget = selectionBehavior?.focusTarget ?? "file-list";

      if (focusTarget === "quick-bar") {
        setTimeout(() => {
          effectiveInputRef.current?.focus();
          effectiveInputRef.current?.select();
        }, 0);
        return;
      }

      if (focusTarget === "file-list" && onBlurToFileList) {
        onBlurToFileList();
      }
    },
    [effectiveInputRef, onBlurToFileList, setQuery]
  );

  const getSelectionAction = useCallback((event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): SearchSelectionAction => {
    if (event.ctrlKey && event.altKey) return "force-native-picker";
    if (event.ctrlKey) return "associated-native-app";
    if (event.shiftKey) return "force-viewer-picker";
    return "associated-viewer";
  }, []);

  // ── Keyboard navigation ────────────────────────────────────────────────

  //
  // handleKeyDown
  //
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          if (disableDropdown) {
            if (onArrowDownToFileList) {
              e.preventDefault();
              onArrowDownToFileList();
            }
            break;
          }
          if (isDropdownOpen && results.length > 0) {
            e.preventDefault();
            setSelectedIndex((prev) => findSelectableResultIndex(Math.min(prev + 1, results.length - 1), 1));
          }
          break;

        case "ArrowUp":
          if (disableDropdown) {
            break;
          }
          if (isDropdownOpen && results.length > 0) {
            e.preventDefault();
            setSelectedIndex((prev) => findSelectableResultIndex(Math.max(prev - 1, 0), -1));
          }
          break;

        case "PageDown":
          if (disableDropdown) {
            break;
          }
          if (isDropdownOpen && results.length > 0) {
            e.preventDefault();
            setSelectedIndex((prev) => findSelectableResultIndex(Math.min(prev + PAGE_JUMP_SIZE, results.length - 1), 1));
          }
          break;

        case "PageUp":
          if (disableDropdown) {
            break;
          }
          if (isDropdownOpen && results.length > 0) {
            e.preventDefault();
            setSelectedIndex((prev) => findSelectableResultIndex(Math.max(prev - PAGE_JUMP_SIZE, 0), -1));
          }
          break;

        case "Enter":
          if (disableDropdown) {
            break;
          }
          if (isDropdownOpen && results[selectedIndex]?.kind !== "group-header" && results[selectedIndex]) {
            e.preventDefault();
            handleSelect(results[selectedIndex].value, getSelectionAction(e));
          }
          break;

        case "Delete":
          if (e.shiftKey && isDropdownOpen && !disableDropdown) {
            e.preventDefault();
            void handleRemoveSelected();
          }
          break;

        case "Escape":
          e.preventDefault();
          if (disableDropdown) {
            if (query) {
              setQuery("");
              setResults([]);
              setHasSearched(false);
              setSearchError(false);
              setIsDropdownOpen(false);
            } else if (onBlurToFileList) {
              onBlurToFileList();
            }
            break;
          }
          if (isDropdownOpen) {
            // First Escape: close the dropdown
            setIsDropdownOpen(false);
          } else if (query) {
            // Second Escape: clear the query
            setQuery("");
            setResults([]);
            setHasSearched(false);
            setSearchError(false);
          } else if (onBlurToFileList) {
            // Third Escape: blur back to the file list
            onBlurToFileList();
          }
          break;

        case "Tab":
          if (isDropdownOpen) {
            setIsDropdownOpen(false);
          }
          break;
      }
    },
    [
      disableDropdown,
      findSelectableResultIndex,
      getSelectionAction,
      handleSelect,
      handleRemoveSelected,
      isDropdownOpen,
      onArrowDownToFileList,
      onBlurToFileList,
      query,
      results,
      selectedIndex,
      setQuery,
    ]
  );

  // ── Virtual list for results ───────────────────────────────────────────
  // Use state (not ref) for the scroll element so the virtualizer
  // re-initialises when the container mounts/unmounts.
  const [listContainer, setListContainer] = useState<HTMLDivElement | null>(null);
  const getVirtualizerItemKey = useCallback((index: number) => results[index]?.id ?? `missing-result-${index}`, [results]);
  const rowVirtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => listContainer,
    estimateSize: (index) => {
      const result = results[index];
      return result ? getQuickBarResultRowHeight(result) : QUICK_BAR_RESULT_ITEM_HEIGHT;
    },
    getItemKey: getVirtualizerItemKey,
    overscan: 5,
  });

  const resultsMaxHeight = useMemo(() => {
    let itemCount = 0;
    let height = 0;

    for (const result of results) {
      if (result.kind === "group-header") {
        if (itemCount === MAX_VISIBLE_RESULTS) break;
        height += getQuickBarResultRowHeight(result);
        continue;
      }

      height += QUICK_BAR_RESULT_ITEM_HEIGHT;
      itemCount += 1;
      if (itemCount === MAX_VISIBLE_RESULTS) break;
    }

    return height;
  }, [results]);

  // ── Scroll selected item into view ─────────────────────────────────────
  useEffect(() => {
    if (results.length > 0) {
      rowVirtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, results.length, rowVirtualizer]);

  // ── Focus activation ───────────────────────────────────────────────────

  //
  // handleFocus
  //
  const handleFocus = useCallback(() => {
    if (!activatedRef.current) {
      activatedRef.current = true;
      providerRef.current.onActivate?.();
    }
  }, []);

  // ── Click-away dismissal ───────────────────────────────────────────────

  //
  // handleClickAway
  //
  const handleClickAway = useCallback(() => {
    setIsDropdownOpen(false);
  }, []);

  // ── Re-open on typing after click-away ─────────────────────────────────
  //
  // handleInputFocus
  //
  const handleInputFocus = useCallback(() => {
    setIsFocused(true);
    handleFocus();

    if (suppressDropdown) {
      setIsDropdownOpen(false);
      return;
    }

    const effectiveMinQueryLength = getEffectiveMinQueryLength(query);
    const effectiveBelowMinimumMessage = getEffectiveBelowMinimumMessage(query);

    if (disableDropdown) {
      setIsDropdownOpen(false);
      return;
    }

    if (!hasSearched && query.length === 0 && effectiveMinQueryLength === 0) {
      void executeSearch("");
    }

    // Re-open dropdown if there are results to show
    if (results.length > 0 || hasSearched) {
      setIsDropdownOpen(true);
    }

    // Show below-minimum hint if query is non-empty but too short
    if (query.length > 0 && query.length < effectiveMinQueryLength && effectiveBelowMinimumMessage) {
      setIsDropdownOpen(true);
    }
  }, [
    disableDropdown,
    executeSearch,
    getEffectiveBelowMinimumMessage,
    getEffectiveMinQueryLength,
    handleFocus,
    results.length,
    hasSearched,
    query,
    suppressDropdown,
  ]);

  useLayoutEffect(() => {
    const wasDropdownSuppressed = wasDropdownSuppressedRef.current;
    wasDropdownSuppressedRef.current = suppressDropdown;

    if (suppressDropdown || wasDropdownSuppressed) {
      setIsDropdownOpen(false);
    }
  }, [suppressDropdown]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      providerRef.current.onDeactivate?.();
    };
  }, []);

  // ── Reset when provider changes or the quick bar is explicitly reopened ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset only on explicit provider identity / activation changes
  useEffect(() => {
    const previousProvider = lastResetProviderRef.current;
    const providerChanged = previousProvider.id !== provider.id;
    const activationChanged = lastActivationTokenRef.current !== activationToken;

    if (!providerChanged && !activationChanged) {
      return;
    }

    previousProvider.onDeactivate?.();

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const isInputFocused = document.activeElement === effectiveInputRef.current;
    const nextQuery = providerChanged ? "" : query;
    const effectiveMinQueryLength = getEffectiveMinQueryLength(nextQuery);
    const effectiveBelowMinimumMessage = getEffectiveBelowMinimumMessage(nextQuery);
    const shouldSearchOnActivation = activationChanged && !disableDropdown && nextQuery.length >= effectiveMinQueryLength;
    const shouldShowBelowMinimumOnActivation =
      activationChanged &&
      !disableDropdown &&
      nextQuery.length > 0 &&
      nextQuery.length < effectiveMinQueryLength &&
      !!effectiveBelowMinimumMessage;
    const shouldOpenOnActivation = shouldSearchOnActivation || shouldShowBelowMinimumOnActivation;
    const shouldPreserveSearchStateOnActivation = shouldSearchOnActivation && !providerChanged;

    if (!shouldPreserveSearchStateOnActivation) {
      setResults([]);
      setSelectedIndex(0);
      setHasSearched(false);
      setSearchError(false);
      setRemoveError(false);
    }

    setIsLoading(shouldSearchOnActivation);
    setIsSearchPending(false);
    setIsDropdownOpen(shouldOpenOnActivation);

    if (!isControlledQuery && providerChanged) {
      setInternalQuery("");
    }

    lastResetProviderRef.current = provider;
    lastActivationTokenRef.current = activationToken;

    activatedRef.current = isInputFocused;

    if (shouldSearchOnActivation) {
      void executeSearch(nextQuery);
    }

    if (isInputFocused) {
      providerRef.current.onActivate?.();
    }
  }, [
    activationToken,
    disableDropdown,
    effectiveInputRef,
    executeSearch,
    getEffectiveBelowMinimumMessage,
    getEffectiveMinQueryLength,
    isControlledQuery,
    provider.id,
    query,
  ]);

  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) {
      return;
    }

    lastRefreshTokenRef.current = refreshToken;
    if (!disableDropdown && !suppressDropdown && query.length >= getEffectiveMinQueryLength(query)) {
      void executeSearch(query, false);
    }
  }, [disableDropdown, executeSearch, getEffectiveMinQueryLength, query, refreshToken, suppressDropdown]);

  useEffect(() => {
    if (disableDropdown || suppressDropdown) {
      return;
    }
    if (document.activeElement === effectiveInputRef.current && provider.minQueryLength === 0) {
      void executeSearch("");
    }
  }, [disableDropdown, effectiveInputRef, executeSearch, provider.minQueryLength, suppressDropdown]);

  useEffect(() => {
    if (isModeMenuOpen && isDropdownOpen) {
      setIsDropdownOpen(false);
    }
  }, [isDropdownOpen, isModeMenuOpen]);

  // ── Derived state ──────────────────────────────────────────────────────
  const statusInfo = provider.getStatusInfo();
  const selectableResultCount = results.filter((result) => result.kind === "result").length;
  const footerHint = provider.getFooterHint?.(results[selectedIndex]) ?? provider.footerHint;
  const effectiveMinQueryLength = getEffectiveMinQueryLength(query);
  const effectiveBelowMinimumMessage = getEffectiveBelowMinimumMessage(query);
  const showSearchError = searchError && query.length >= effectiveMinQueryLength && !isLoading && !isSearchPending;
  const showRemoveError = removeError && !isLoading && !isSearchPending;
  const showNoResults =
    hasSearched &&
    query.length > 0 &&
    query.length >= effectiveMinQueryLength &&
    !isLoading &&
    !isSearchPending &&
    !showSearchError &&
    results.length === 0;
  const showBelowMinimum = query.length > 0 && query.length < effectiveMinQueryLength && !!effectiveBelowMinimumMessage;
  const showSearchProgress = query.length > 0 && (isSearchPending || isLoading || statusInfo !== null);

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <ClickAwayListener onClickAway={handleClickAway}>
      <Box
        ref={anchorRef}
        sx={{
          position: "relative",
          boxSizing: "border-box",
          mb: useCompactLayout ? 2 : 0,
          mt: useCompactLayout ? { xs: 1, sm: 0 } : 0,
          mx: useCompactLayout ? { xs: 2, sm: 3, md: 4 } : 0,
        }}
      >
        {/* Search input */}
        <Paper
          elevation={2}
          sx={{
            position: useCompactLayout ? "sticky" : "relative",
            top: 0,
            zIndex: 10,
            backgroundColor: "background.default",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              px: HORIZONTAL_CHROME_SPACING,
              "&:focus-within": {
                outline: (shellTheme) => `3px solid ${shellTheme.palette.appBar?.focus}`,
                outlineOffset: "0",
              },
            }}
          >
            {modeSelector ? (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  flexShrink: 0,
                }}
              >
                {modeSelector}
              </Box>
            ) : null}
            <TextField
              fullWidth
              size="small"
              placeholder={provider.placeholder}
              value={query}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={handleInputFocus}
              onBlur={() => setIsFocused(false)}
              inputRef={effectiveInputRef}
              slotProps={{
                htmlInput: {
                  ...(disableTabFocus ? { tabIndex: -1 } : {}),
                  "data-quick-bar-input": "true",
                },
                input: {
                  sx: {
                    px: 0,
                  },
                  endAdornment,
                },
              }}
              sx={{
                flex: 1,
                "& .MuiInputBase-root": {
                  fontSize: { xs: "16px", sm: "14px" },
                  pl: 0,
                },
                "& .MuiInputBase-root.Mui-focused": {
                  outline: "none",
                },
                "& .MuiInputBase-input": {
                  padding: INPUT_PADDING,
                },
                "& .MuiOutlinedInput-notchedOutline": {
                  border: "none",
                },
                "&:hover .MuiOutlinedInput-notchedOutline": {
                  border: "none",
                },
                "& .Mui-focused .MuiOutlinedInput-notchedOutline": {
                  border: "none",
                },
              }}
            />
          </Box>
        </Paper>

        {/* Dropdown results panel */}
        <Popper
          open={
            !suppressDropdown &&
            !disableDropdown &&
            isDropdownOpen &&
            (results.length > 0 || showNoResults || showSearchError || showRemoveError || showBelowMinimum || showSearchProgress)
          }
          anchorEl={anchorRef.current}
          placement="bottom"
          style={{
            width: Math.min(DROPDOWN_WIDTH_PX, window.innerWidth - 16),
            zIndex: 1300,
          }}
          modifiers={[
            {
              name: "offset",
              options: { offset: [0, 4] },
            },
            {
              name: "preventOverflow",
              options: { boundary: "viewport", padding: 8 },
            },
          ]}
        >
          <Paper
            elevation={8}
            sx={{
              borderRadius: 1,
              overflow: "hidden",
              maxWidth: "100%",
            }}
          >
            {/* Status indicator */}
            {statusInfo && (
              <Box
                sx={{
                  px: 2,
                  py: 0.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  borderBottom: results.length > 0 || showNoResults || showSearchError || showRemoveError ? 1 : 0,
                  borderColor: "divider",
                }}
              >
                {statusInfo.showSpinner && <CircularProgress size={14} />}
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {statusInfo.label}
                </Typography>
              </Box>
            )}

            {/* Results list (virtualized) */}
            {results.length > 0 && (
              <Box
                ref={setListContainer}
                role="listbox"
                sx={{
                  maxHeight: resultsMaxHeight,
                  overflowY: "auto",
                  position: "relative",
                }}
              >
                <Box
                  sx={{
                    height: rowVirtualizer.getTotalSize(),
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const result = results[virtualRow.index];
                    if (!result) return null;
                    if (result.kind === "group-header") {
                      return (
                        <Box
                          key={result.id}
                          sx={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <QuickBarResultGroupHeader
                            label={result.label}
                            showDivider={virtualRow.index > 0}
                            useCompactLayout={useCompactLayout}
                          />
                        </Box>
                      );
                    }
                    return (
                      <ListItemButton
                        key={result.id}
                        selected={virtualRow.index === selectedIndex}
                        onClick={(event) => handleSelect(result.value, getSelectionAction(event))}
                        onMouseEnter={() => setSelectedIndex(virtualRow.index)}
                        sx={{
                          py: 0.75,
                          px: 2,
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualRow.start}px)`,
                          "&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible": {
                            backgroundColor: "action.selected",
                          },
                        }}
                        role="option"
                        aria-selected={virtualRow.index === selectedIndex}
                      >
                        <QuickBarResultRow result={result} useCompactLayout={useCompactLayout} />
                      </ListItemButton>
                    );
                  })}
                </Box>
              </Box>
            )}

            {/* Below minimum query length hint */}
            {showBelowMinimum && (
              <Box sx={{ px: 2, py: 1.5, textAlign: "center" }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {effectiveBelowMinimumMessage}
                </Typography>
              </Box>
            )}

            {/* No results */}
            {showNoResults && (
              <Box sx={{ px: 2, py: 2, textAlign: "center" }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {t("fileBrowser.search.results.none", { query })}
                </Typography>
              </Box>
            )}

            {showSearchError && (
              <Box sx={{ px: 2, py: 2, textAlign: "center" }} role="alert">
                <Typography variant="body2" sx={{ color: "error.main" }}>
                  {t("fileBrowser.search.results.failed")}
                </Typography>
              </Box>
            )}

            {showRemoveError && (
              <Box sx={{ px: 2, py: 2, textAlign: "center" }} role="alert">
                <Typography variant="body2" sx={{ color: "error.main" }}>
                  {t("fileBrowser.search.results.removeFailed")}
                </Typography>
              </Box>
            )}

            {/* Footer */}
            {(footerHint || provider.footerInfo) && (
              <Box
                sx={{
                  px: 2,
                  py: 0.75,
                  borderTop: 1,
                  borderColor: "divider",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 1,
                  justifyContent: "space-between",
                  backgroundColor: "action.selected",
                }}
              >
                {!useCompactLayout && showKeyboardHints && footerHint && (
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      columnGap: 1.25,
                      color: "text.secondary",
                      flex: 1,
                      fontSize: "0.75rem",
                      minWidth: 0,
                      rowGap: 0.5,
                      flexWrap: "wrap",
                      "& > span": {
                        whiteSpace: "nowrap",
                      },
                      "& kbd": {
                        fontFamily: "inherit",
                        fontSize: "0.7rem",
                        lineHeight: 1,
                        px: 0.5,
                        py: 0.25,
                        borderRadius: 0.5,
                        border: 1,
                        borderColor: "divider",
                        backgroundColor: "background.default",
                      },
                    }}
                  >
                    {footerHint}
                  </Box>
                )}
                {provider.footerInfo && (
                  <Typography variant="caption" sx={{ color: "text.secondary", flexShrink: 0, pt: 0.25 }}>
                    {provider.footerInfo(selectableResultCount)}
                  </Typography>
                )}
              </Box>
            )}
          </Paper>
        </Popper>
      </Box>
    </ClickAwayListener>
  );
}
