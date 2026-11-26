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
import FilterAltOutlinedIcon from "@mui/icons-material/FilterAltOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import FolderSpecialOutlinedIcon from "@mui/icons-material/FolderSpecialOutlined";
import KeyboardCommandKeyIcon from "@mui/icons-material/KeyboardCommandKey";
import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Button,
  CircularProgress,
  ClickAwayListener,
  Divider,
  IconButton,
  InputAdornment,
  Link,
  ListItemButton,
  ListItemIcon,
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
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Trans, useTranslation } from "react-i18next";
import { usePillButtonMenu } from "../../hooks/usePillButtonMenu";
import { FILESYSTEM_SEARCH_QUERY_MAX_BYTES, validateFilesystemSearchQuery } from "../../services/filesystemSearchContract";
import { getPillButtonFocusVisibleBoxShadow, getSecondaryToolbarMenuPaperStyle } from "../../theme/commonStyles";
import { focusLiveSearchOption, type LiveSearchOptions, LiveSearchOptionsPanel } from "./LiveSearchOptions";
import { PillButtonTooltip } from "./PillButtonTooltip";
import {
  getQuickBarResultRowHeight,
  QUICK_BAR_RESULT_ITEM_HEIGHT,
  QuickBarResultGroupHeader,
  QuickBarResultRow,
  quickBarDropdownActiveRow,
  quickBarDropdownRowPadding,
} from "./QuickBarResultRow";
import { SearchStatusDialog } from "./SearchStatusDialog";
import type { SearchProvider, SearchResult, SearchSelectionAction, SearchSelectionBehavior, SearchStatusInfo } from "./search/types";
import type { NavigationItemType, NavigationScope } from "./search/useNavigationSearchProvider";

// ============================================================================
// Constants
// ============================================================================

/** Maximum visible results before the list scrolls */
const MAX_VISIBLE_RESULTS = 10;

/** Desired dropdown width in pixels (static per viewport) */
const DROPDOWN_WIDTH_PX = 700;

/** Number of items to jump with Page Up/Down */
const PAGE_JUMP_SIZE = 10;

/** Legacy key code that browsers report for keys an IME processes (Safari reports it for the Enter that ends composition) */
const IME_PROCESS_KEY_CODE = 229;

const QUICK_BAR_COMPACT_CHROME = {
  "--quick-bar-inset": "10px",
  "--quick-bar-height": "44px",
} as const;

const QUICK_BAR_DESKTOP_CHROME = {
  "--quick-bar-inset": "8px",
  "--quick-bar-height": "38px",
} as const;

const QUICK_BAR_INSET = "var(--quick-bar-inset)";
const QUICK_BAR_HEIGHT = "var(--quick-bar-height)";
const QUICK_BAR_FOCUS_RING_INSET = "5px";

const QUICK_BAR_CONTROL_SX = {
  position: "relative",
  height: QUICK_BAR_HEIGHT,
  alignSelf: "center",
  flexShrink: 0,
  "&&.Mui-focusVisible": {
    outline: "none",
    "&::before": {
      content: '""',
      position: "absolute",
      inset: QUICK_BAR_FOCUS_RING_INSET,
      borderRadius: 1,
      pointerEvents: "none",
      boxShadow: getPillButtonFocusVisibleBoxShadow,
      "@media (forced-colors: active)": {
        outline: "2px solid Highlight",
      },
    },
  },
} as const;

function getQuickBarModeIcon(modeId: string): React.ReactElement {
  switch (modeId) {
    case "navigate":
      return <FolderOutlinedIcon aria-hidden="true" sx={{ fontSize: 18 }} />;
    case "commands":
      return <KeyboardCommandKeyIcon aria-hidden="true" sx={{ fontSize: 18 }} />;
    default:
      return <SearchIcon aria-hidden="true" sx={{ fontSize: 18 }} />;
  }
}

const QUICK_BAR_MODE_BUTTON_SX = {
  ...QUICK_BAR_CONTROL_SX,
  columnGap: 0.5,
  minWidth: 0,
  paddingBlock: 0,
  paddingInline: QUICK_BAR_INSET,
  borderStartEndRadius: 0,
  borderEndEndRadius: 0,
  color: "text.secondary",
  "@media (hover: hover) and (pointer: fine)": {
    "&:hover": {
      backgroundColor: "action.selected",
    },
  },
  "@media (hover: none)": {
    "&:hover": {
      backgroundColor: "transparent",
    },
  },
  "&::after": {
    content: '""',
    position: "absolute",
    insetInlineEnd: 0,
    top: "50%",
    transform: "translateY(-50%)",
    width: "1px",
    height: 18,
    backgroundColor: "divider",
    pointerEvents: "none",
  },
} as const;

const QUICK_BAR_MODE_MENU_ITEM_SX = {
  fontSize: "0.8125rem",
  lineHeight: 1.35,
} as const;

const QUICK_BAR_ICON_BUTTON_SX = {
  ...QUICK_BAR_CONTROL_SX,
  width: QUICK_BAR_HEIGHT,
  borderRadius: 1,
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
  inputRef?: React.RefObject<HTMLInputElement | null>;
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
  navigationControls?: UnifiedSearchBarNavigationControls;
  liveSearchControls?: {
    options: LiveSearchOptions;
    onOptionsChange: (options: LiveSearchOptions) => void;
    onSubmit: (query: string, options: LiveSearchOptions) => void;
  };
}

export interface UnifiedSearchBarNavigationControls {
  scope: NavigationScope;
  itemType: NavigationItemType;
  onScopeChange: (scope: NavigationScope) => void;
  onItemTypeChange: (itemType: NavigationItemType) => void;
}

export interface UnifiedSearchBarModeOption {
  id: string;
  label: string;
  onSelect: () => void;
}

const MIN_BACKGROUND_REFRESH_MS = 500;

/** Delay before replacing visible prior-query results with a partial interim update when a slower source stalls. */
export const INTERIM_RESULTS_FALLBACK_MS = 150;

interface SettledEmptyFeedback {
  kind: "below-minimum" | "no-results";
  query: string;
}

function hasSelectableSearchResults(items: readonly SearchResult[]): boolean {
  return items.some((item) => item.kind === "result");
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
  disableDropdown: disableDropdownProp = false,
  onArrowDownToFileList,
  disableTabFocus,
  modeOptions,
  modeSelectorAriaLabel,
  suppressDropdown = false,
  showKeyboardHints = true,
  navigationControls,
  liveSearchControls,
}: UnifiedSearchBarProps) {
  // ── State ──────────────────────────────────────────────────────────────
  const [internalQuery, setInternalQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [settledEmptyFeedback, setSettledEmptyFeedback] = useState<SettledEmptyFeedback | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isSearchPending, setIsSearchPending] = useState(false);
  const [statusDialog, setStatusDialog] = useState<SearchStatusInfo | null>(null);
  const [navigationMenu, setNavigationMenu] = useState<"scope" | "itemType" | null>(null);
  const [navigationMenuAnchor, setNavigationMenuAnchor] = useState<HTMLElement | null>(null);
  const [navigationControlFocused, setNavigationControlFocused] = useState(false);
  const [liveQueryError, setLiveQueryError] = useState<ReturnType<typeof validateFilesystemSearchQuery>>(null);
  const [liveOptionsOpen, setLiveOptionsOpen] = useState(false);
  const disableDropdown = disableDropdownProp || liveSearchControls !== undefined;

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
  const interimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietRequestRef = useRef(false);
  const acceptedQueryRef = useRef<string | null>(null);
  const executeSearchRef = useRef<(value: string, openDropdown: boolean, quiet: boolean) => Promise<void>>(async () => {});
  const dropdownOpenRef = useRef(false);
  dropdownOpenRef.current = isDropdownOpen && !disableDropdown && !suppressDropdown;
  const pendingQueryRef = useRef<string>("");
  const providerRef = useRef(provider);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const scopeButtonRef = useRef<HTMLButtonElement>(null);
  const itemTypeButtonRef = useRef<HTMLButtonElement>(null);
  const liveOptionsListRef = useRef<HTMLUListElement>(null);
  const liveOptionsFocusRequest = useRef<"first" | "last" | null>(null);
  const suppressLiveOptionsOnFocusRef = useRef(false);
  const activatedRef = useRef(false);
  const lastResetProviderRef = useRef(provider);
  const lastActivationTokenRef = useRef(activationToken);
  const lastRefreshTokenRef = useRef(refreshToken);
  const wasDropdownSuppressedRef = useRef(suppressDropdown);
  const queryGenerationRef = useRef(0);
  const resultsRef = useRef<SearchResult[]>([]);
  resultsRef.current = results;
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = results[selectedIndex]?.id;

  const clearInterimTimer = useCallback(() => {
    if (interimTimerRef.current) {
      clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
  }, []);

  // Always keep providerRef current so stable callbacks use the latest provider
  providerRef.current = provider;

  const isControlledQuery = queryValue !== undefined;
  const query = isControlledQuery ? queryValue : internalQuery;

  const setQuery = useCallback(
    (value: string) => {
      queryGenerationRef.current += 1;
      acceptedQueryRef.current = null;
      clearInterimTimer();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      abortControllerRef.current?.abort();
      setIsLoading(false);
      providerRef.current.onQueryChange?.(value);
      onQueryValueChange?.(value);

      if (isControlledQuery) {
        return;
      }

      setInternalQuery(value);
    },
    [clearInterimTimer, isControlledQuery, onQueryValueChange]
  );

  // Use external inputRef if provided, otherwise internal
  const effectiveInputRef = inputRef ?? internalInputRef;
  const showNavigationControls = provider.modeId === "navigate" && navigationControls !== undefined;

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
        <PillButtonTooltip label={`${modeSelectorLabel}: ${provider.modeLabel}`}>
          <Button
            onClick={handleModeMenuClick}
            onKeyDown={handleModeTriggerKeyDown}
            onKeyUp={handleModeMenuKeyUp}
            size="small"
            tabIndex={disableTabFocus ? -1 : undefined}
            aria-label={modeSelectorLabel}
            aria-description={provider.modeLabel}
            aria-controls={isModeMenuOpen ? "quick-bar-mode-menu" : undefined}
            aria-haspopup="true"
            aria-expanded={isModeMenuOpen ? "true" : undefined}
            data-mode-id={provider.modeId}
            sx={QUICK_BAR_MODE_BUTTON_SX}
          >
            {getQuickBarModeIcon(provider.modeId)}
            {/* Trim the arrow's side bearings without changing the triangle's size. */}
            <ArrowDropDownIcon aria-hidden="true" viewBox="3 0 18 24" sx={{ fontSize: 12, width: "0.75em" }} />
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
                <ListItemIcon sx={{ minWidth: "28px !important", color: "text.secondary" }}>
                  {getQuickBarModeIcon(modeOption.id)}
                </ListItemIcon>
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
  ]);

  const endAdornment = useMemo(() => {
    const showShortcutBadge = !showNavigationControls && !query && !isFocused && !!kbdBadge;

    if (!query && !isLoading && !showShortcutBadge) {
      return undefined;
    }

    return (
      <InputAdornment
        position="end"
        sx={{
          marginInlineStart: 0,
          paddingInlineEnd: query ? 0 : QUICK_BAR_INSET,
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
                setSettledEmptyFeedback(null);
                setIsDropdownOpen(false);
                setHasSearched(false);
                setSearchError(false);
                effectiveInputRef.current?.focus();
              }}
              sx={QUICK_BAR_ICON_BUTTON_SX}
              aria-label={t("common.search.clear")}
            >
              <ClearIcon sx={{ fontSize: useCompactLayout ? 24 : 18 }} />
            </IconButton>
          ) : showShortcutBadge ? (
            kbdBadge
          ) : null}
        </Box>
      </InputAdornment>
    );
  }, [effectiveInputRef, isFocused, isLoading, kbdBadge, query, setQuery, showNavigationControls, t, useCompactLayout]);

  // ── Search execution ───────────────────────────────────────────────────

  //
  // executeSearch
  //
  const executeSearch = useCallback(
    async (searchQuery: string, openDropdown = true, quiet = false) => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      if (
        quiet &&
        (document.visibilityState === "hidden" ||
          !dropdownOpenRef.current ||
          acceptedQueryRef.current !== searchQuery ||
          providerRef.current.getRefreshIntervalMs?.() == null)
      )
        return;
      // Cancel any in-flight request and pending interim fallback
      clearInterimTimer();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      quietRequestRef.current = quiet;
      const generation = queryGenerationRef.current;
      const activeProvider = providerRef.current;
      const hadVisibleResults = hasSelectableSearchResults(resultsRef.current);
      let publishedInCurrentSearch = false;
      let latestInterimResults: SearchResult[] | null = null;
      const isCurrent = () =>
        !controller.signal.aborted &&
        generation === queryGenerationRef.current &&
        activeProvider.id === providerRef.current.id &&
        activeProvider.sourceKey === providerRef.current.sourceKey;
      const commitResults = (updatedResults: SearchResult[], isFinal: boolean) => {
        if (!isCurrent()) return;
        const previousId = selectedIdRef.current;
        const previousIndex = updatedResults.findIndex((result) => result.kind === "result" && result.id === previousId);
        const firstIndex = updatedResults.findIndex((result) => result.kind === "result");
        const hasSelectable = firstIndex >= 0;

        setResults(updatedResults);
        setSelectedIndex(Math.max(previousIndex >= 0 ? previousIndex : firstIndex, 0));
        setHasSearched(true);

        if (hasSelectable) {
          setSettledEmptyFeedback(null);
        } else if (isFinal) {
          if (searchQuery.length === 0) {
            setSettledEmptyFeedback(null);
          } else {
            const belowMinimumMessage =
              providerRef.current.getBelowMinimumMessage?.(searchQuery) ?? providerRef.current.belowMinimumMessage;
            setSettledEmptyFeedback({
              kind: belowMinimumMessage ? "below-minimum" : "no-results",
              query: searchQuery,
            });
          }
        }

        if (openDropdown) setIsDropdownOpen(true);
      };

      const publishInterimResults = (updatedResults: SearchResult[]) => {
        if (!isCurrent() || quiet || !hasSelectableSearchResults(updatedResults)) {
          return;
        }
        if (!hadVisibleResults || publishedInCurrentSearch) {
          clearInterimTimer();
          latestInterimResults = null;
          publishedInCurrentSearch = true;
          commitResults(updatedResults, false);
          return;
        }
        latestInterimResults = updatedResults;
        if (!interimTimerRef.current) {
          interimTimerRef.current = setTimeout(() => {
            interimTimerRef.current = null;
            if (!isCurrent() || !latestInterimResults) return;
            const deferredResults = latestInterimResults;
            latestInterimResults = null;
            publishedInCurrentSearch = true;
            commitResults(deferredResults, false);
          }, INTERIM_RESULTS_FALLBACK_MS);
        }
      };

      const publishFinalResults = (fetchedResults: SearchResult[]) => {
        clearInterimTimer();
        latestInterimResults = null;
        publishedInCurrentSearch = true;
        commitResults(fetchedResults, true);
      };

      try {
        if (!quiet) {
          acceptedQueryRef.current = null;
          setIsSearchPending(false);
          setIsLoading(true);
          setSearchError(false);
          setRemoveError(false);
        }
        const fetchedResults = quiet
          ? await activeProvider.fetchResults(searchQuery, controller.signal, publishInterimResults, true)
          : await activeProvider.fetchResults(searchQuery, controller.signal, publishInterimResults);
        publishFinalResults(fetchedResults);
        if (isCurrent()) {
          acceptedQueryRef.current = searchQuery;
          const interval = providerRef.current.getRefreshIntervalMs?.();
          if (
            interval != null &&
            Number.isFinite(interval) &&
            interval >= MIN_BACKGROUND_REFRESH_MS &&
            document.visibilityState !== "hidden"
          ) {
            refreshTimerRef.current = setTimeout(() => {
              refreshTimerRef.current = null;
              if (isCurrent()) void executeSearchRef.current(searchQuery, false, true);
            }, interval);
          }
        }
      } catch {
        clearInterimTimer();
        latestInterimResults = null;
        if (isCurrent()) {
          acceptedQueryRef.current = null;
          if (!quiet) {
            setResults([]);
            setSettledEmptyFeedback(null);
          }
          setHasSearched(true);
          setSearchError(true);
          if (openDropdown) {
            setIsDropdownOpen(true);
          }
        }
      } finally {
        if (isCurrent()) {
          setIsLoading(false);
        }
      }
    },
    // providerRef is stable — no dependency on provider object identity
    [clearInterimTimer]
  );
  executeSearchRef.current = executeSearch;

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
      setLiveQueryError(null);
      setRemoveError(false);

      if (disableDropdown) {
        setResults([]);
        setSettledEmptyFeedback(null);
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
        if (newQuery.length === 0) {
          setSettledEmptyFeedback(null);
        }
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
          setSettledEmptyFeedback(null);
          setIsDropdownOpen(false);
        } else if (effectiveBelowMinimumMessage) {
          // Show hint when query is non-empty but below minimum length
          setSettledEmptyFeedback({ kind: "below-minimum", query: newQuery });
          setIsDropdownOpen(true);
        } else {
          setSettledEmptyFeedback(null);
          setIsDropdownOpen(false);
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

  const getSelectionAction = useCallback((event: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): SearchSelectionAction => {
    if (event.ctrlKey && event.altKey) return "force-native-picker";
    if (event.ctrlKey) return "associated-native-app";
    if (event.shiftKey) return "force-viewer-picker";
    return "associated-viewer";
  }, []);

  const dismissSearch = useCallback(() => {
    queryGenerationRef.current += 1;
    acceptedQueryRef.current = null;
    clearInterimTimer();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;
    abortControllerRef.current?.abort();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setIsLoading(false);
    setIsSearchPending(false);
    setIsDropdownOpen(false);
    setLiveOptionsOpen(false);
    liveOptionsFocusRequest.current = null;
    setIsFocused(false);
    setNavigationControlFocused(false);
    activatedRef.current = false;
    providerRef.current.onDeactivate?.();
  }, [clearInterimTimer]);

  const resetQuickBar = useCallback(() => {
    setQuery("");
    setResults([]);
    setSettledEmptyFeedback(null);
    setHasSearched(false);
    setSearchError(false);
    setRemoveError(false);
    setLiveQueryError(null);
    dismissSearch();
  }, [dismissSearch, setQuery]);

  const exitQuickBar = useCallback(() => {
    resetQuickBar();
    onBlurToFileList?.();
  }, [onBlurToFileList, resetQuickBar]);

  const handleSelect = useCallback(
    (value: string, action: SearchSelectionAction = "associated-viewer") => {
      const activeProvider = providerRef.current;
      // End the search before selection can change the provider or open another overlay.
      flushSync(resetQuickBar);

      const selectionBehavior: SearchSelectionBehavior | undefined = activeProvider.onSelect(value, action);
      const focusTarget = selectionBehavior?.focusTarget ?? "file-list";

      if (focusTarget === "quick-bar") {
        setTimeout(() => {
          effectiveInputRef.current?.focus();
          effectiveInputRef.current?.select();
        }, 0);
      } else if (focusTarget === "file-list") {
        onBlurToFileList?.();
      }
    },
    [effectiveInputRef, onBlurToFileList, resetQuickBar]
  );

  const returnFromLiveOptions = useCallback(() => {
    suppressLiveOptionsOnFocusRef.current = true;
    effectiveInputRef.current?.focus();
    suppressLiveOptionsOnFocusRef.current = false;
    setLiveOptionsOpen(false);
  }, [effectiveInputRef]);

  useLayoutEffect(() => {
    const edge = liveOptionsFocusRequest.current;
    if (liveOptionsOpen && edge) {
      liveOptionsFocusRequest.current = null;
      focusLiveSearchOption(liveOptionsListRef.current, edge);
    }
  }, [liveOptionsOpen]);

  // ── Keyboard navigation ────────────────────────────────────────────────

  //
  // handleKeyDown
  //
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Keys that confirm or edit IME text belong to the IME, not to quick navigation, live search, or parent shortcuts.
      if (e.nativeEvent.isComposing || e.keyCode === IME_PROCESS_KEY_CODE) {
        e.stopPropagation();
        return;
      }
      if (liveSearchControls && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        e.stopPropagation();
        const edge = e.key === "ArrowDown" ? "first" : "last";
        if (liveOptionsListRef.current) focusLiveSearchOption(liveOptionsListRef.current, edge);
        else {
          liveOptionsFocusRequest.current = edge;
          setLiveOptionsOpen(true);
        }
        return;
      }
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
          if (liveSearchControls) {
            e.preventDefault();
            const queryError = validateFilesystemSearchQuery(query);
            if (queryError) {
              setLiveQueryError(queryError);
            } else {
              setLiveQueryError(null);
              setLiveOptionsOpen(false);
              liveSearchControls.onSubmit(query, { ...liveSearchControls.options });
            }
            break;
          }
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
          if (liveSearchControls || showNavigationControls) {
            e.stopPropagation();
            if (liveSearchControls && liveOptionsOpen) {
              setLiveOptionsOpen(false);
            } else {
              exitQuickBar();
            }
            break;
          }
          if (disableDropdown) {
            if (query) {
              setQuery("");
              setResults([]);
              setSettledEmptyFeedback(null);
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
            dismissSearch();
          } else if (query) {
            // Second Escape: clear the query
            setQuery("");
            setResults([]);
            setSettledEmptyFeedback(null);
            setHasSearched(false);
            setSearchError(false);
          } else if (onBlurToFileList) {
            // Third Escape: blur back to the file list
            onBlurToFileList();
          }
          break;

        case "Tab":
          if (liveSearchControls) {
            break;
          }
          if (showNavigationControls) {
            e.preventDefault();
            (e.shiftKey ? itemTypeButtonRef : scopeButtonRef).current?.focus();
            break;
          }
          if (isDropdownOpen) {
            dismissSearch();
          }
          break;
      }
    },
    [
      disableDropdown,
      dismissSearch,
      exitQuickBar,
      findSelectableResultIndex,
      getSelectionAction,
      handleSelect,
      handleRemoveSelected,
      isDropdownOpen,
      liveSearchControls,
      liveOptionsOpen,
      onArrowDownToFileList,
      onBlurToFileList,
      query,
      results,
      selectedIndex,
      setQuery,
      showNavigationControls,
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

  const resetOpenResults = useEffectEvent(() => {
    const firstIndex = Math.max(
      results.findIndex((result) => result.kind === "result"),
      0
    );
    selectedIdRef.current = results[firstIndex]?.id;
    setSelectedIndex(firstIndex);
    rowVirtualizer.scrollToOffset(0);
  });

  useLayoutEffect(() => {
    if (listContainer) {
      resetOpenResults();
    }
  }, [listContainer]);

  // ── Scroll selected item into view ─────────────────────────────────────
  useEffect(() => {
    if (listContainer && results.length > 0) {
      rowVirtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [listContainer, selectedIndex, results.length, rowVirtualizer]);

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
    if (statusDialog || navigationMenu) return;
    setLiveOptionsOpen(false);
    setNavigationControlFocused(false);
    dismissSearch();
  }, [dismissSearch, navigationMenu, statusDialog]);

  // ── Re-open on typing after click-away ─────────────────────────────────
  //
  // handleInputFocus
  //
  const handleInputFocus = useCallback(() => {
    const newlyActivated = !activatedRef.current;
    setIsFocused(true);
    if (liveSearchControls && !suppressLiveOptionsOnFocusRef.current) setLiveOptionsOpen(true);
    suppressLiveOptionsOnFocusRef.current = false;
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

    if (
      newlyActivated &&
      ((!hasSearched && query.length === 0 && effectiveMinQueryLength === 0) || (hasSearched && query.length >= effectiveMinQueryLength))
    ) {
      void executeSearch(query);
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
    liveSearchControls,
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
      clearInterimTimer();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      providerRef.current.onDeactivate?.();
    };
  }, [clearInterimTimer]);

  // ── Reset when provider changes or the quick bar is explicitly reopened ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset only on explicit provider identity / activation changes
  useEffect(() => {
    const previousProvider = lastResetProviderRef.current;
    const providerChanged = previousProvider.id !== provider.id || previousProvider.sourceKey !== provider.sourceKey;
    const activationChanged = lastActivationTokenRef.current !== activationToken;

    if (!providerChanged && !activationChanged) {
      return;
    }

    previousProvider.onDeactivate?.();
    queryGenerationRef.current += 1;
    acceptedQueryRef.current = null;
    clearInterimTimer();
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    const isInputFocused = document.activeElement === effectiveInputRef.current;
    const preserveNavigationQuery = providerChanged && previousProvider.id === "navigation-search" && provider.id === "navigation-search";
    const nextQuery = providerChanged && !preserveNavigationQuery ? "" : query;
    const effectiveMinQueryLength = getEffectiveMinQueryLength(nextQuery);
    const effectiveBelowMinimumMessage = getEffectiveBelowMinimumMessage(nextQuery);
    const shouldSearchOnActivation =
      (activationChanged || (preserveNavigationQuery && activatedRef.current)) &&
      !disableDropdown &&
      nextQuery.length >= effectiveMinQueryLength;
    const shouldShowBelowMinimumOnActivation =
      activationChanged &&
      !disableDropdown &&
      nextQuery.length > 0 &&
      nextQuery.length < effectiveMinQueryLength &&
      !!effectiveBelowMinimumMessage;
    const shouldOpenOnActivation = shouldSearchOnActivation || shouldShowBelowMinimumOnActivation;
    const shouldPreserveSearchStateOnActivation = shouldSearchOnActivation && !providerChanged;

    setStatusDialog(null);
    if (shouldPreserveSearchStateOnActivation) {
      resetOpenResults();
    } else {
      setResults([]);
      setSettledEmptyFeedback(shouldShowBelowMinimumOnActivation ? { kind: "below-minimum", query: nextQuery } : null);
      setSelectedIndex(0);
      setHasSearched(false);
      setSearchError(false);
      setRemoveError(false);
    }

    setIsLoading(shouldSearchOnActivation);
    setIsSearchPending(false);
    setIsDropdownOpen(shouldOpenOnActivation);

    if (!isControlledQuery && providerChanged && !preserveNavigationQuery) {
      setInternalQuery("");
    }

    lastResetProviderRef.current = provider;
    lastActivationTokenRef.current = activationToken;

    activatedRef.current = isInputFocused || shouldSearchOnActivation;

    if (activatedRef.current) {
      providerRef.current.onActivate?.();
    }

    if (shouldSearchOnActivation) {
      void executeSearch(nextQuery);
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
    provider.sourceKey,
    query,
  ]);

  useEffect(() => {
    const stopQuietRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      if (quietRequestRef.current) abortControllerRef.current?.abort();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        stopQuietRefresh();
        clearInterimTimer();
        abortControllerRef.current?.abort();
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        setIsLoading(false);
        setIsSearchPending(false);
      } else if (dropdownOpenRef.current && acceptedQueryRef.current === query && providerRef.current.getRefreshIntervalMs?.() != null) {
        void executeSearchRef.current(query, false, true);
      }
    };
    if (!isDropdownOpen || disableDropdown || suppressDropdown) stopQuietRefresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [clearInterimTimer, disableDropdown, isDropdownOpen, query, suppressDropdown]);

  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) {
      return;
    }

    lastRefreshTokenRef.current = refreshToken;
    if (!disableDropdown && !suppressDropdown && query.length >= getEffectiveMinQueryLength(query)) {
      providerRef.current.invalidateResults?.();
      void executeSearch(query, false);
    }
  }, [disableDropdown, executeSearch, getEffectiveMinQueryLength, query, refreshToken, suppressDropdown]);

  const resumeFocusedSearch = useEffectEvent(() => {
    if (document.activeElement === effectiveInputRef.current && query.length >= getEffectiveMinQueryLength(query)) {
      void executeSearch(query);
    }
  });

  useEffect(() => {
    if (!disableDropdown && !suppressDropdown && provider.minQueryLength === 0) {
      resumeFocusedSearch();
    }
  }, [disableDropdown, provider.minQueryLength, suppressDropdown]);

  useEffect(() => {
    if (isModeMenuOpen && isDropdownOpen) {
      setIsDropdownOpen(false);
    }
  }, [isDropdownOpen, isModeMenuOpen]);

  useEffect(() => {
    if (!liveSearchControls) setLiveOptionsOpen(false);
  }, [liveSearchControls]);

  // ── Derived state ──────────────────────────────────────────────────────
  const statusInfo = provider.getStatusInfo();
  const selectableResultCount = results.filter((result) => result.kind === "result").length;
  const footerHint = provider.getFooterHint?.(results[selectedIndex]) ?? provider.footerHint;
  const effectiveMinQueryLength = getEffectiveMinQueryLength(query);
  const showSearchError = searchError && query.length >= effectiveMinQueryLength && !isLoading && !isSearchPending;
  const showRemoveError = removeError && !isLoading && !isSearchPending;
  const belowMinimumFeedbackMessage =
    settledEmptyFeedback?.kind === "below-minimum" ? getEffectiveBelowMinimumMessage(settledEmptyFeedback.query) : undefined;
  const showBelowMinimum = results.length === 0 && !showSearchError && !showRemoveError && !!belowMinimumFeedbackMessage;
  const noResultsQuery = settledEmptyFeedback?.kind === "no-results" ? settledEmptyFeedback.query : undefined;
  const showNoResults =
    results.length === 0 && !showSearchError && !showRemoveError && !statusInfo?.suppressEmpty && noResultsQuery !== undefined;
  const showSearchProgress = statusInfo !== null && (query.length > 0 || !!statusInfo.suppressEmpty);
  const handleNavigationControlKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, control: "scope" | "itemType") => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitQuickBar();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const target =
        control === "scope"
          ? event.shiftKey
            ? effectiveInputRef
            : itemTypeButtonRef
          : event.shiftKey
            ? scopeButtonRef
            : effectiveInputRef;
      target.current?.focus();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <ClickAwayListener onClickAway={handleClickAway}>
      <Box
        ref={anchorRef}
        onFocusCapture={showNavigationControls ? () => setNavigationControlFocused(true) : undefined}
        onBlur={(event) => {
          // A window blur has no in-page focus destination.
          const next = event.relatedTarget;
          if (!next || event.currentTarget.contains(next) || navigationMenu || isModeMenuOpen) return;
          setNavigationControlFocused(false);
          setLiveOptionsOpen(false);
        }}
        sx={{
          position: "relative",
          boxSizing: "border-box",
          width: "100%",
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
              ...(useCompactLayout ? QUICK_BAR_COMPACT_CHROME : QUICK_BAR_DESKTOP_CHROME),
              display: "flex",
              alignItems: "stretch",
              minHeight: QUICK_BAR_HEIGHT,
              "&:focus-within": {
                outline: (shellTheme) => `3px solid ${shellTheme.palette.appBar?.focus}`,
                outlineOffset: "0",
              },
            }}
          >
            {modeSelector}
            <TextField
              fullWidth
              size="small"
              placeholder={provider.placeholder}
              value={query}
              error={liveQueryError !== null}
              helperText={
                liveQueryError === "empty"
                  ? t("fileBrowser.search.live.emptyQuery")
                  : liveQueryError === "too-long"
                    ? t("fileBrowser.search.live.queryTooLong", { max: FILESYSTEM_SEARCH_QUERY_MAX_BYTES })
                    : undefined
              }
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={handleInputFocus}
              onClick={liveSearchControls ? () => setLiveOptionsOpen(true) : undefined}
              onBlur={(event) => {
                if (event.relatedTarget) setIsFocused(false);
              }}
              inputRef={effectiveInputRef}
              slotProps={{
                htmlInput: {
                  ...(disableTabFocus ? { tabIndex: -1 } : {}),
                  "data-quick-bar-input": "true",
                  "aria-label": provider.placeholder,
                },
                input: {
                  sx: {
                    flex: 1,
                    paddingInline: 0,
                    fontSize: useCompactLayout ? "16px" : "14px",
                  },
                  endAdornment,
                },
              }}
              sx={{
                flex: 1,
                minWidth: 0,
                "& .MuiInputBase-root.Mui-focused": {
                  outline: "none",
                },
                "& .MuiInputBase-input": {
                  paddingBlock: 1,
                  paddingInline: QUICK_BAR_INSET,
                  textOverflow: "ellipsis",
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
            {showNavigationControls && navigationControls && (
              <Box
                sx={{
                  width: `calc(2 * ${QUICK_BAR_HEIGHT})`,
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onPointerDownCapture={() => setNavigationControlFocused(true)}
              >
                {!(isFocused || navigationControlFocused || navigationMenu) && showKeyboardHints && !query && kbdBadge}
                <PillButtonTooltip
                  label={`${t("fileBrowser.search.navigation.scopeLabel")}: ${t(`fileBrowser.search.navigation.scope.${navigationControls.scope}`)}`}
                >
                  <span>
                    <IconButton
                      ref={scopeButtonRef}
                      aria-label={t("fileBrowser.search.navigation.scopeLabel")}
                      aria-description={t(`fileBrowser.search.navigation.scope.${navigationControls.scope}`)}
                      aria-haspopup="menu"
                      aria-expanded={navigationMenu === "scope"}
                      onKeyDown={(event) => handleNavigationControlKeyDown(event, "scope")}
                      onClick={(event) => {
                        setNavigationMenuAnchor(event.currentTarget);
                        setNavigationMenu("scope");
                      }}
                      size="small"
                      sx={{
                        ...QUICK_BAR_ICON_BUTTON_SX,
                        display: isFocused || navigationControlFocused || navigationMenu ? "inline-flex" : "none",
                      }}
                    >
                      <FolderSpecialOutlinedIcon aria-hidden="true" fontSize="small" />
                    </IconButton>
                  </span>
                </PillButtonTooltip>
                <PillButtonTooltip
                  label={`${t("fileBrowser.search.navigation.itemTypeLabel")}: ${t(`fileBrowser.search.navigation.itemType.${navigationControls.itemType}`)}`}
                >
                  <span>
                    <IconButton
                      ref={itemTypeButtonRef}
                      aria-label={t("fileBrowser.search.navigation.itemTypeLabel")}
                      aria-description={t(`fileBrowser.search.navigation.itemType.${navigationControls.itemType}`)}
                      aria-haspopup="menu"
                      aria-expanded={navigationMenu === "itemType"}
                      onKeyDown={(event) => handleNavigationControlKeyDown(event, "itemType")}
                      onClick={(event) => {
                        setNavigationMenuAnchor(event.currentTarget);
                        setNavigationMenu("itemType");
                      }}
                      size="small"
                      sx={{
                        ...QUICK_BAR_ICON_BUTTON_SX,
                        display: isFocused || navigationControlFocused || navigationMenu ? "inline-flex" : "none",
                      }}
                    >
                      <FilterAltOutlinedIcon aria-hidden="true" fontSize="small" />
                    </IconButton>
                  </span>
                </PillButtonTooltip>
                <Menu anchorEl={navigationMenuAnchor} open={navigationMenu !== null} onClose={() => setNavigationMenu(null)}>
                  {navigationMenu === "scope"
                    ? (["connection", "subtree", "descendants_only"] as const).map((value) => (
                        <MenuItem
                          key={value}
                          selected={navigationControls.scope === value}
                          onClick={() => {
                            navigationControls.onScopeChange(value);
                            setNavigationMenu(null);
                          }}
                        >
                          {t(`fileBrowser.search.navigation.scope.${value}`)}
                        </MenuItem>
                      ))
                    : (["all", "directories", "files"] as const).map((value) => (
                        <MenuItem
                          key={value}
                          selected={navigationControls.itemType === value}
                          onClick={() => {
                            navigationControls.onItemTypeChange(value);
                            setNavigationMenu(null);
                          }}
                        >
                          {t(`fileBrowser.search.navigation.itemType.${value}`)}
                        </MenuItem>
                      ))}
                </Menu>
              </Box>
            )}
          </Box>
        </Paper>

        {/* Quick-bar dropdown */}
        <Popper
          open={
            !statusDialog &&
            !navigationMenu &&
            !isModeMenuOpen &&
            !suppressDropdown &&
            (liveSearchControls
              ? liveOptionsOpen
              : !disableDropdown &&
                isDropdownOpen &&
                (results.length > 0 || showNoResults || showSearchError || showRemoveError || showBelowMinimum || showSearchProgress))
          }
          disablePortal={Boolean(liveSearchControls)}
          role={liveSearchControls ? "presentation" : undefined}
          anchorEl={anchorRef.current}
          placement="bottom"
          style={{
            width: liveSearchControls ? "100%" : Math.min(DROPDOWN_WIDTH_PX, window.innerWidth - 16),
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
            {liveSearchControls ? (
              <LiveSearchOptionsPanel
                options={liveSearchControls.options}
                onChange={liveSearchControls.onOptionsChange}
                listRef={liveOptionsListRef}
                onEscape={returnFromLiveOptions}
                onTab={returnFromLiveOptions}
                useCompactLayout={useCompactLayout}
                showKeyboardHints={!useCompactLayout && showKeyboardHints}
              />
            ) : (
              <>
                {/* Status indicator */}
                {statusInfo && (
                  <Box
                    sx={{
                      px: 2,
                      py: 0.5,
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      borderBottom: results.length > 0 || showBelowMinimum || showNoResults || showSearchError || showRemoveError ? 1 : 0,
                      borderColor: "divider",
                    }}
                  >
                    {statusInfo.showSpinner && <CircularProgress size={14} />}
                    <Typography variant="caption" sx={{ color: "text.secondary", overflowWrap: "anywhere" }}>
                      {statusInfo.loadDetails ? statusInfo.label.replace(/\.$/u, "") : statusInfo.label}
                      {statusInfo.loadDetails && (
                        <Trans
                          i18nKey="fileBrowser.search.statusDetails.linkSuffix"
                          components={{
                            details: (
                              <Link
                                component="button"
                                type="button"
                                role="link"
                                tabIndex={-1}
                                underline="always"
                                onPointerDown={(event) => event.preventDefault()}
                                onClick={() => setStatusDialog(statusInfo)}
                                sx={{ font: "inherit", verticalAlign: "baseline" }}
                              />
                            ),
                          }}
                        />
                      )}
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
                              ...quickBarDropdownRowPadding,
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              transform: `translateY(${virtualRow.start}px)`,
                              "&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible": quickBarDropdownActiveRow,
                            }}
                            role="option"
                            aria-selected={virtualRow.index === selectedIndex}
                          >
                            <QuickBarResultRow
                              result={result}
                              useCompactLayout={useCompactLayout}
                              showRecentBadge={Boolean(query.trim())}
                            />
                          </ListItemButton>
                        );
                      })}
                    </Box>
                  </Box>
                )}

                {/* Below minimum query length hint */}
                {showBelowMinimum && (
                  <Box sx={{ px: 2, py: 2, textAlign: "center" }}>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {belowMinimumFeedbackMessage}
                    </Typography>
                  </Box>
                )}

                {/* No results */}
                {showNoResults && (
                  <Box sx={{ px: 2, py: 2, textAlign: "center" }}>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {t("fileBrowser.search.results.none", { query: noResultsQuery })}
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
              </>
            )}
          </Paper>
        </Popper>
        {statusDialog && <SearchStatusDialog status={statusDialog} onClose={() => setStatusDialog(null)} />}
      </Box>
    </ClickAwayListener>
  );
}
