import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { alpha, Box, darken, lighten, Popover, Tooltip, useTheme } from "@mui/material";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PANE_SHORTCUTS } from "../../config/keyboardShortcuts";
import {
  formatShortcut,
  KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE,
  useKeyboardShortcutScope,
  withShortcut,
} from "../../hooks/useKeyboardShortcuts";
import { getConnectionById } from "../../pages/FileBrowser/access";
import { getPaneTabFullLocation, getPaneTabLabel, type PaneTabSummary } from "../../pages/FileBrowser/tabSessions";
import type { PaneId, PaneMode } from "../../pages/FileBrowser/types";
import { secondaryToolbarMenuPaperSx } from "../../theme/commonStyles";
import { PANE_TAB_BAR } from "../../theme/constants";
import type { Connection } from "../../types";
import { truncateTextByGrapheme } from "../../utils/pathDisplay";

const FINE_POINTER_HOVER_MEDIA = "@media (hover: hover) and (pointer: fine)";
const CLOSE_MENU_TAB_KEY = "Delete";

export interface PaneTabBarProps {
  paneId: PaneId;
  paneMode: PaneMode;
  isActivePane: boolean;
  tabs: readonly PaneTabSummary[];
  selectedTabId: string;
  tabRevealToken?: number;
  connections: readonly Connection[];
  useTouchControls: boolean;
  disabled?: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
  onRestoreFocus?: () => void;
}

export interface TabBarLayoutInput {
  tabCount: number;
  selectedIndex: number;
  previousWindowStart: number;
  barWidth: number;
  leadingControlsWidthPx: number;
  trailingControlsWidthPx: number;
  minTabWidthPx: number;
}

export interface TabBarLayout {
  visibleCount: number;
  hiddenCount: number;
  windowStart: number;
  availableStripWidthPx: number;
  fixedChromeWidthPx: number;
  effectiveMinTabWidthPx: number;
  effectiveMaxTabWidthPx: number;
}

/**
 * Resolves the visible tab slice and width budget without horizontal scrolling.
 *
 * - Leading (`⌄` All Tabs) and trailing (`+` New Tab) controls occupy fixed outer slots.
 * - When all tabs fit at or above `minTabWidthPx`, every tab renders in the strip (`hiddenCount === 0`)
 *   and wide labels shrink proportionally before truncating.
 * - When tabs exceed capacity, only whole unclipped tabs render inside `[windowStart, windowStart + visibleCount)`
 *   with the selected tab guaranteed inside the visible window.
 */
export function resolveTabBarLayout({
  tabCount,
  selectedIndex,
  previousWindowStart,
  barWidth,
  leadingControlsWidthPx,
  trailingControlsWidthPx,
  minTabWidthPx,
}: TabBarLayoutInput): TabBarLayout {
  const fixedChromeWidthPx = leadingControlsWidthPx + trailingControlsWidthPx;

  if (tabCount <= 1) {
    const availableStripWidthPx = barWidth > 0 ? Math.max(0, barWidth - fixedChromeWidthPx) : 0;
    const effectiveMinTabWidthPx = availableStripWidthPx > 0 ? Math.min(minTabWidthPx, availableStripWidthPx) : minTabWidthPx;
    const effectiveMaxTabWidthPx =
      availableStripWidthPx > 0 ? Math.max(effectiveMinTabWidthPx, availableStripWidthPx) : PANE_TAB_BAR.OVERFLOW_MAX_TAB_WIDTH_PX;

    return {
      visibleCount: tabCount,
      hiddenCount: 0,
      windowStart: 0,
      availableStripWidthPx,
      fixedChromeWidthPx,
      effectiveMinTabWidthPx,
      effectiveMaxTabWidthPx,
    };
  }

  if (barWidth <= 0) {
    return {
      visibleCount: tabCount,
      hiddenCount: 0,
      windowStart: 0,
      availableStripWidthPx: 0,
      fixedChromeWidthPx,
      effectiveMinTabWidthPx: minTabWidthPx,
      effectiveMaxTabWidthPx: PANE_TAB_BAR.OVERFLOW_MAX_TAB_WIDTH_PX,
    };
  }

  const availableStripWidthPx = Math.max(0, barWidth - fixedChromeWidthPx);
  const capacity = Math.max(1, Math.floor(availableStripWidthPx / minTabWidthPx));

  if (tabCount <= capacity) {
    const effectiveMinTabWidthPx = availableStripWidthPx > 0 ? Math.min(minTabWidthPx, availableStripWidthPx) : minTabWidthPx;
    const effectiveMaxTabWidthPx = Math.max(
      effectiveMinTabWidthPx,
      Math.min(
        availableStripWidthPx,
        Math.max(PANE_TAB_BAR.OVERFLOW_MAX_TAB_WIDTH_PX, Math.floor(availableStripWidthPx / Math.max(tabCount, 1)))
      )
    );

    return {
      visibleCount: tabCount,
      hiddenCount: 0,
      windowStart: 0,
      availableStripWidthPx,
      fixedChromeWidthPx,
      effectiveMinTabWidthPx,
      effectiveMaxTabWidthPx,
    };
  }

  const visibleCount = Math.min(tabCount - 1, capacity);
  const hiddenCount = tabCount - visibleCount;
  const maxWindowStart = tabCount - visibleCount;
  const clampedStart = Math.max(0, Math.min(previousWindowStart, maxWindowStart));
  const safeSelectedIndex = Math.max(0, Math.min(selectedIndex, tabCount - 1));

  let windowStart = clampedStart;
  if (safeSelectedIndex < clampedStart) {
    windowStart = safeSelectedIndex;
  } else if (safeSelectedIndex >= clampedStart + visibleCount) {
    windowStart = safeSelectedIndex - visibleCount + 1;
  }

  const effectiveMinTabWidthPx = availableStripWidthPx > 0 ? Math.min(minTabWidthPx, availableStripWidthPx) : minTabWidthPx;
  const effectiveMaxTabWidthPx = Math.max(effectiveMinTabWidthPx, availableStripWidthPx);

  return {
    visibleCount,
    hiddenCount,
    windowStart,
    availableStripWidthPx,
    fixedChromeWidthPx,
    effectiveMinTabWidthPx,
    effectiveMaxTabWidthPx,
  };
}

/**
 * Per-pane folder tab bar.
 *
 * Design invariants:
 * - Chrome-style control placement: an arrow-down (`⌄`) All Tabs menu button sits to the left of the tabs,
 *   and a plus (`+`) New Tab button sits to the right of the tabs.
 * - Zero horizontal scrolling: tabs shrink proportionally down to a readable floor, and any additional
 *   tabs beyond bar capacity are accessed via the leading All Tabs vertical popover while keeping only
 *   whole, unclipped tabs (including the active tab) in the bar.
 * - Middle-clicking (`auxclick` button 1) closes any closable tab directly in both the bar and the menu.
 * - Close button overlays the trailing title end without participating in tab width.
 * - Bar controls stay out of sequential keyboard navigation (`tabIndex={-1}`) and never retain DOM focus.
 */
export const PaneTabBar: React.FC<PaneTabBarProps> = React.memo(
  ({
    paneId,
    paneMode,
    isActivePane,
    tabs,
    selectedTabId,
    connections,
    useTouchControls,
    disabled = false,
    onSelectTab,
    onCloseTab,
    onCreateTab,
    onRestoreFocus,
  }) => {
    const theme = useTheme();
    const { t } = useTranslation();
    const isRtl = theme.direction === "rtl";
    const menuPopoverId = useId();

    const barRef = useRef<HTMLDivElement | null>(null);
    const windowStartRef = useRef<number>(0);
    const menuListRef = useRef<HTMLDivElement | null>(null);
    const menuSelectRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const selectedTabIdRef = useRef<string>(selectedTabId);
    selectedTabIdRef.current = selectedTabId;
    const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
    const [barWidth, setBarWidth] = useState<number>(0);
    const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLButtonElement | null>(null);
    const [focusedMenuIndex, setFocusedMenuIndex] = useState<number>(0);

    const isClosable = tabs.length > 1;
    const showMenuButton = tabs.length > 0;
    const isMenuOpen = Boolean(menuAnchorEl) && showMenuButton && !disabled;
    const previousTabCountRef = useRef<number>(tabs.length);
    const menuShortcutScope = useKeyboardShortcutScope(isMenuOpen);

    const barHeightPx = useTouchControls ? PANE_TAB_BAR.HEIGHT_TOUCH_PX : PANE_TAB_BAR.HEIGHT_MOUSE_PX;
    const fallbackStartPaddingPx = useTouchControls
      ? PANE_TAB_BAR.BAR_INLINE_START_PADDING_TOUCH_PX
      : PANE_TAB_BAR.BAR_INLINE_START_PADDING_MOUSE_PX;
    const titleInlinePaddingPx = useTouchControls ? PANE_TAB_BAR.TITLE_INLINE_PADDING_TOUCH_PX : PANE_TAB_BAR.TITLE_INLINE_PADDING_MOUSE_PX;
    const closeTargetPx = useTouchControls ? PANE_TAB_BAR.CONTROL_TARGET_TOUCH_PX : PANE_TAB_BAR.CONTROL_TARGET_MOUSE_PX;
    const closePillSizePx = useTouchControls ? PANE_TAB_BAR.CLOSE_PILL_TOUCH_PX : PANE_TAB_BAR.CLOSE_PILL_MOUSE_PX;

    const menuButtonSizePx = useTouchControls ? PANE_TAB_BAR.MENU_BUTTON_SIZE_TOUCH_PX : PANE_TAB_BAR.MENU_BUTTON_SIZE_MOUSE_PX;
    const menuMarginStartPx = useTouchControls
      ? PANE_TAB_BAR.MENU_BUTTON_MARGIN_START_TOUCH_PX
      : PANE_TAB_BAR.MENU_BUTTON_MARGIN_START_MOUSE_PX;
    const menuMarginEndPx = useTouchControls ? PANE_TAB_BAR.MENU_BUTTON_MARGIN_END_TOUCH_PX : PANE_TAB_BAR.MENU_BUTTON_MARGIN_END_MOUSE_PX;
    const menuSlotWidthPx = showMenuButton ? menuMarginStartPx + menuButtonSizePx + menuMarginEndPx : fallbackStartPaddingPx;

    const addButtonSizePx = useTouchControls ? PANE_TAB_BAR.ADD_BUTTON_SIZE_TOUCH_PX : PANE_TAB_BAR.ADD_BUTTON_SIZE_MOUSE_PX;
    const addMarginEndPx = useTouchControls ? PANE_TAB_BAR.ADD_BUTTON_MARGIN_END_TOUCH_PX : PANE_TAB_BAR.ADD_BUTTON_MARGIN_END_MOUSE_PX;
    const addSlotWidthPx = PANE_TAB_BAR.ADD_BUTTON_MARGIN_START_PX + addButtonSizePx + addMarginEndPx;

    const minTabWidthPx = isClosable
      ? useTouchControls
        ? PANE_TAB_BAR.MIN_CLOSABLE_TAB_WIDTH_TOUCH_PX
        : PANE_TAB_BAR.MIN_CLOSABLE_TAB_WIDTH_MOUSE_PX
      : useTouchControls
        ? PANE_TAB_BAR.MIN_SINGLE_TAB_WIDTH_TOUCH_PX
        : PANE_TAB_BAR.MIN_SINGLE_TAB_WIDTH_MOUSE_PX;

    const selectedIndex = useMemo(() => {
      const idx = tabs.findIndex((tab) => tab.id === selectedTabId);
      return Math.max(idx, 0);
    }, [selectedTabId, tabs]);

    const layout = resolveTabBarLayout({
      tabCount: tabs.length,
      selectedIndex,
      previousWindowStart: windowStartRef.current,
      barWidth,
      leadingControlsWidthPx: menuSlotWidthPx,
      trailingControlsWidthPx: addSlotWidthPx,
      minTabWidthPx,
    });
    windowStartRef.current = layout.windowStart;

    const visibleTabs = useMemo(
      () => (layout.hiddenCount === 0 ? tabs : tabs.slice(layout.windowStart, layout.windowStart + layout.visibleCount)),
      [layout.hiddenCount, layout.visibleCount, layout.windowStart, tabs]
    );

    const resolvedTabMeta = useMemo(
      () =>
        tabs.map((tab) => {
          const connectionName = getConnectionById(connections, tab.connectionId)?.name ?? tab.connectionId;
          const rawLabel = getPaneTabLabel(tab, connectionName);
          const displayLabel = truncateTextByGrapheme(rawLabel, PANE_TAB_BAR.MAX_LABEL_GRAPHEMES);
          const fullLocation = getPaneTabFullLocation(tab, connectionName);
          const selectAriaLabel = t("fileBrowser.tabs.selectTabAriaLabel", {
            name: rawLabel,
            location: fullLocation,
          });
          const closeAriaLabel = t("fileBrowser.tabs.closeTabAriaLabel", {
            name: rawLabel,
            location: fullLocation,
          });
          return {
            tab,
            rawLabel,
            displayLabel,
            fullLocation,
            selectAriaLabel,
            closeAriaLabel,
          };
        }),
      [connections, t, tabs]
    );

    const colors = useMemo(() => {
      const baseBg = theme.palette.background.default;
      const isDark = theme.palette.mode === "dark";
      const trackBg = isDark ? darken(baseBg, 0.12) : darken(baseBg, 0.03);
      const unselectedHoverBg = isDark ? lighten(baseBg, 0.04) : darken(baseBg, 0.014);
      const selectedBg = baseBg;
      const showActiveTopAccent = paneMode === "dual" && isActivePane;
      const closePillHoverBg = alpha(theme.palette.text.primary, isDark ? 0.14 : 0.08);
      const addHoverBg = alpha(theme.palette.text.primary, isDark ? 0.1 : 0.06);

      return {
        trackBg,
        unselectedBg: trackBg,
        unselectedHoverBg,
        selectedBg,
        showActiveTopAccent,
        closePillHoverBg,
        addHoverBg,
      };
    }, [isActivePane, paneMode, theme.palette.background.default, theme.palette.mode, theme.palette.text.primary]);

    const measureBar = useCallback(() => {
      const nextWidth = barRef.current?.clientWidth ?? 0;
      setBarWidth((previous) => (previous === nextWidth ? previous : nextWidth));
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure synchronously when pane layout mode or input mode changes
    useLayoutEffect(() => {
      measureBar();
    }, [paneMode, useTouchControls, measureBar]);

    useEffect(() => {
      const bar = barRef.current;
      if (!bar) {
        return;
      }

      measureBar();
      const observer = new ResizeObserver(() => {
        measureBar();
      });
      observer.observe(bar);
      if (bar.parentElement) {
        observer.observe(bar.parentElement);
      }
      window.addEventListener("resize", measureBar);
      return () => {
        window.removeEventListener("resize", measureBar);
        observer.disconnect();
      };
    }, [measureBar]);

    const closeMenu = useCallback(
      (restoreFocus: boolean) => {
        setMenuAnchorEl(null);
        if (restoreFocus) {
          onRestoreFocus?.();
        }
      },
      [onRestoreFocus]
    );

    // Dismiss the popover cleanly if controls become disabled or the user closes down from multiple tabs to a single remaining tab.
    useEffect(() => {
      const previousTabCount = previousTabCountRef.current;
      previousTabCountRef.current = tabs.length;
      const closedDownToSingleTab = previousTabCount > 1 && tabs.length <= 1;
      if (menuAnchorEl && (!showMenuButton || disabled || closedDownToSingleTab)) {
        closeMenu(true);
      }
    }, [closeMenu, disabled, menuAnchorEl, showMenuButton, tabs.length]);

    const revealMenuButton = useCallback((button: HTMLButtonElement) => {
      const listEl = menuListRef.current;
      const rowEl = button.parentElement;
      if (listEl && rowEl && listEl.clientHeight > 0) {
        const rowTop = rowEl.offsetTop;
        const rowBottom = rowTop + rowEl.offsetHeight;
        if (rowBottom > listEl.scrollTop + listEl.clientHeight) {
          listEl.scrollTop = rowBottom - listEl.clientHeight;
        } else if (rowTop < listEl.scrollTop) {
          listEl.scrollTop = rowTop;
        }
      } else {
        button.scrollIntoView?.({ block: "nearest" });
      }
    }, []);

    const safeFocusedMenuIndex = tabs.length > 0 ? Math.max(0, Math.min(focusedMenuIndex, tabs.length - 1)) : 0;

    const handleMenuListRef = useCallback(
      (node: HTMLDivElement | null) => {
        menuListRef.current = node;
        if (!node) {
          return;
        }
        const targetBtn = menuSelectRefs.current.get(selectedTabIdRef.current) ?? menuSelectRefs.current.values().next().value;
        if (targetBtn) {
          revealMenuButton(targetBtn);
          targetBtn.focus({ preventScroll: true });
        }
      },
      [revealMenuButton]
    );

    // Retain focus inside the popover if the currently focused row is removed by closing a tab.
    useLayoutEffect(() => {
      const listEl = menuListRef.current;
      if (!isMenuOpen || !listEl) {
        return;
      }

      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement && listEl.contains(activeEl) && activeEl.tagName === "BUTTON") {
        return;
      }
      const fallbackTabId = tabs[safeFocusedMenuIndex]?.id ?? selectedTabId;
      const targetBtn = menuSelectRefs.current.get(fallbackTabId) ?? menuSelectRefs.current.values().next().value;
      if (targetBtn) {
        revealMenuButton(targetBtn);
        targetBtn.focus({ preventScroll: true });
      }
    }, [isMenuOpen, revealMenuButton, safeFocusedMenuIndex, selectedTabId, tabs]);

    const preventMouseFocus = useCallback((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
    }, []);

    const handleBarFocusCapture = useCallback(
      (event: React.FocusEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.target)) {
          onRestoreFocus?.();
        }
      },
      [onRestoreFocus]
    );

    const handleMiddleClickClose = useCallback(
      (event: React.MouseEvent<HTMLElement>, tabId: string) => {
        if (event.button === 1 && isClosable && !disabled) {
          event.preventDefault();
          event.stopPropagation();
          onCloseTab(tabId);
        }
      },
      [disabled, isClosable, onCloseTab]
    );

    const handleMenuKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
          return;
        }

        const orderedButtons = tabs
          .map((tab) => menuSelectRefs.current.get(tab.id))
          .filter((btn): btn is HTMLButtonElement => Boolean(btn));
        if (orderedButtons.length === 0) {
          return;
        }

        const activeIdx = orderedButtons.indexOf(document.activeElement as HTMLButtonElement);
        const currentIdx = activeIdx >= 0 ? activeIdx : safeFocusedMenuIndex;

        if (event.key === "ArrowDown") {
          event.preventDefault();
          const nextIdx = (currentIdx + 1) % orderedButtons.length;
          setFocusedMenuIndex(nextIdx);
          const nextBtn = orderedButtons[nextIdx];
          if (nextBtn) {
            revealMenuButton(nextBtn);
            nextBtn.focus({ preventScroll: true });
          }
          return;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          const prevIdx = (currentIdx - 1 + orderedButtons.length) % orderedButtons.length;
          setFocusedMenuIndex(prevIdx);
          const prevBtn = orderedButtons[prevIdx];
          if (prevBtn) {
            revealMenuButton(prevBtn);
            prevBtn.focus({ preventScroll: true });
          }
          return;
        }

        if (event.key === "Home") {
          event.preventDefault();
          setFocusedMenuIndex(0);
          const firstBtn = orderedButtons[0];
          if (firstBtn) {
            revealMenuButton(firstBtn);
            firstBtn.focus({ preventScroll: true });
          }
          return;
        }

        if (event.key === "End") {
          event.preventDefault();
          const lastIdx = orderedButtons.length - 1;
          setFocusedMenuIndex(lastIdx);
          const lastBtn = orderedButtons[lastIdx];
          if (lastBtn) {
            revealMenuButton(lastBtn);
            lastBtn.focus({ preventScroll: true });
          }
          return;
        }

        if (event.key === CLOSE_MENU_TAB_KEY && isClosable && !disabled && currentIdx >= 0) {
          const targetTab = tabs[currentIdx];
          if (targetTab) {
            event.preventDefault();
            onCloseTab(targetTab.id);
          }
        }
      },
      [closeMenu, disabled, isClosable, onCloseTab, revealMenuButton, safeFocusedMenuIndex, tabs]
    );

    const groupAriaLabel =
      paneMode === "dual"
        ? t(paneId === "left" ? "fileBrowser.tabs.leftPaneGroupAriaLabel" : "fileBrowser.tabs.rightPaneGroupAriaLabel")
        : t("fileBrowser.tabs.groupAriaLabel");

    const newTabTooltip = withShortcut({
      ...PANE_SHORTCUTS.NEW_TAB,
      description: t("fileBrowser.tabs.newTab"),
    });
    const closeTabLabel = t("fileBrowser.tabs.closeTab");
    const closeTabTooltip = withShortcut({ ...PANE_SHORTCUTS.CLOSE_TAB, description: closeTabLabel });
    const closeBackgroundTabTooltip = t("fileBrowser.tabs.closeBackgroundTabTooltip", {
      shortcut: formatShortcut(PANE_SHORTCUTS.CLOSE_TAB),
    });
    const closeMenuTabTooltip = t("fileBrowser.tabs.closeMenuTabTooltip", { shortcut: formatShortcut({ keys: CLOSE_MENU_TAB_KEY }) });

    const allTabsLabel =
      layout.hiddenCount > 0
        ? t("fileBrowser.tabs.allTabsOverflowAriaLabel", { total: tabs.length, hidden: layout.hiddenCount })
        : t("fileBrowser.tabs.allTabsAriaLabel", { total: tabs.length });

    const controlHeightPx = useTouchControls ? barHeightPx - PANE_TAB_BAR.BAR_TOP_INSET_PX : addButtonSizePx;
    const menuRowMinHeightPx = useTouchControls ? PANE_TAB_BAR.MENU_ITEM_MIN_HEIGHT_TOUCH_PX : PANE_TAB_BAR.MENU_ITEM_MIN_HEIGHT_MOUSE_PX;

    return (
      <>
        <Box
          ref={barRef}
          role="group"
          aria-label={groupAriaLabel}
          data-testid={`pane-tab-bar-${paneId}`}
          data-touch-controls={useTouchControls ? "true" : "false"}
          onFocusCapture={handleBarFocusCapture}
          sx={{
            display: "flex",
            alignItems: "stretch",
            width: "100%",
            minWidth: 0,
            height: `${barHeightPx}px`,
            minHeight: `${barHeightPx}px`,
            maxHeight: `${barHeightPx}px`,
            paddingTop: `${PANE_TAB_BAR.BAR_TOP_INSET_PX}px`,
            paddingInlineStart: showMenuButton ? 0 : `${fallbackStartPaddingPx}px`,
            boxSizing: "border-box",
            bgcolor: colors.trackBg,
            position: "relative",
            userSelect: "none",
            "&::after": {
              content: '""',
              position: "absolute",
              insetInline: 0,
              bottom: 0,
              height: "1px",
              bgcolor: "divider",
              pointerEvents: "none",
              zIndex: 0,
            },
          }}
        >
          {/* Leading All Tabs menu button (`⌄`) to the left of the tabs, matching modern Chrome */}
          {showMenuButton && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: `0 0 ${menuSlotWidthPx}px`,
                width: `${menuSlotWidthPx}px`,
                height: "100%",
                paddingInlineStart: `${menuMarginStartPx}px`,
                paddingInlineEnd: `${menuMarginEndPx}px`,
                boxSizing: "border-box",
                zIndex: 1,
              }}
            >
              <Tooltip title={disabled || isMenuOpen ? "" : allTabsLabel} disableFocusListener disableTouchListener enterDelay={400}>
                <Box
                  component="button"
                  type="button"
                  data-testid={`pane-tab-all-tabs-${paneId}`}
                  data-hidden-count={layout.hiddenCount}
                  tabIndex={-1}
                  aria-label={allTabsLabel}
                  aria-haspopup="dialog"
                  aria-expanded={isMenuOpen ? "true" : "false"}
                  aria-controls={isMenuOpen ? menuPopoverId : undefined}
                  disabled={disabled}
                  onMouseDown={preventMouseFocus}
                  onClick={(event) => {
                    const target = event.currentTarget;
                    setFocusedMenuIndex(selectedIndex);
                    setMenuAnchorEl((current) => (current ? null : target));
                  }}
                  sx={{
                    appearance: "none",
                    border: 0,
                    borderRadius: 1.5,
                    margin: 0,
                    padding: 0,
                    width: `${menuButtonSizePx}px`,
                    minWidth: `${menuButtonSizePx}px`,
                    height: `${controlHeightPx}px`,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    bgcolor: isMenuOpen ? colors.addHoverBg : "transparent",
                    color: isMenuOpen ? "text.primary" : "text.secondary",
                    cursor: disabled ? "default" : "pointer",
                    ...(!useTouchControls && !disabled
                      ? {
                          [FINE_POINTER_HOVER_MEDIA]: {
                            "&:hover": {
                              bgcolor: colors.addHoverBg,
                              color: "text.primary",
                            },
                          },
                        }
                      : {}),
                    ...(!disabled
                      ? {
                          "&:active": {
                            bgcolor: colors.addHoverBg,
                            color: "text.primary",
                          },
                        }
                      : {}),
                    "&:focus": {
                      outline: "none",
                    },
                  }}
                >
                  <KeyboardArrowDownIcon
                    aria-hidden="true"
                    sx={{
                      fontSize: `${PANE_TAB_BAR.MENU_ICON_FONT_SIZE_PX}px`,
                      transform: isMenuOpen ? "rotate(180deg)" : "none",
                      transition: "transform 120ms ease",
                    }}
                  />
                </Box>
              </Tooltip>
            </Box>
          )}

          {/* Clamped, non-scrolling tab strip — shrinks tabs proportionally and renders only whole tabs */}
          <Box
            data-testid={`pane-tab-strip-${paneId}`}
            tabIndex={-1}
            sx={{
              display: "flex",
              alignItems: "stretch",
              flex: layout.hiddenCount > 0 ? "1 1 auto" : "0 1 auto",
              minWidth: 0,
              maxWidth:
                layout.availableStripWidthPx > 0 ? `${layout.availableStripWidthPx}px` : `calc(100% - ${layout.fixedChromeWidthPx}px)`,
              height: "100%",
              gap: `${PANE_TAB_BAR.TAB_GAP_PX}px`,
              overflow: "hidden",
              zIndex: 1,
              "&:focus": {
                outline: "none",
              },
            }}
          >
            {visibleTabs.map((tab, visibleIndex) => {
              const tabIndex = layout.windowStart + visibleIndex;
              const meta = resolvedTabMeta[tabIndex];
              if (!meta) {
                return null;
              }

              const { displayLabel, fullLocation, selectAriaLabel, closeAriaLabel } = meta;
              const isSelected = tab.id === selectedTabId;
              const isHovered = !useTouchControls && hoveredTabId === tab.id;
              const nextTab = visibleTabs[visibleIndex + 1];
              const isNextSelected = nextTab?.id === selectedTabId;
              const isNextHovered = !useTouchControls && nextTab !== undefined && hoveredTabId === nextTab.id;
              const showTrailingSeparator =
                !isSelected && !isNextSelected && !isHovered && !isNextHovered && visibleIndex < visibleTabs.length - 1;
              const tabCurrentBg = isSelected ? colors.selectedBg : isHovered ? colors.unselectedHoverBg : colors.unselectedBg;
              const showCloseOverlay = isClosable && !disabled && (useTouchControls || isHovered);

              return (
                <Box
                  key={tab.id}
                  data-testid={`pane-tab-item-${paneId}-${tabIndex}`}
                  data-tab-id={tab.id}
                  data-selected={isSelected ? "true" : "false"}
                  onMouseDown={preventMouseFocus}
                  onAuxClick={(event) => handleMiddleClickClose(event, tab.id)}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse" && !useTouchControls) {
                      setHoveredTabId(tab.id);
                    }
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType === "mouse") {
                      setHoveredTabId((current) => (current === tab.id ? null : current));
                    }
                  }}
                  sx={{
                    position: "relative",
                    display: "inline-flex",
                    alignItems: "stretch",
                    flex: layout.hiddenCount > 0 ? "1 1 0" : "0 1 auto",
                    minWidth: `${layout.effectiveMinTabWidthPx}px`,
                    maxWidth: `${layout.effectiveMaxTabWidthPx}px`,
                    height: "100%",
                    boxSizing: "border-box",
                    overflow: "hidden",
                    borderTopLeftRadius: `${PANE_TAB_BAR.TAB_TOP_RADIUS_PX}px`,
                    borderTopRightRadius: `${PANE_TAB_BAR.TAB_TOP_RADIUS_PX}px`,
                    bgcolor: tabCurrentBg,
                    zIndex: isSelected ? 2 : 1,
                    "&::before": {
                      content: '""',
                      position: "absolute",
                      inset: 0,
                      boxSizing: "border-box",
                      borderTopLeftRadius: `${PANE_TAB_BAR.TAB_TOP_RADIUS_PX}px`,
                      borderTopRightRadius: `${PANE_TAB_BAR.TAB_TOP_RADIUS_PX}px`,
                      borderInline: isSelected ? `1px solid ${theme.palette.divider}` : "none",
                      borderTop: isSelected
                        ? colors.showActiveTopAccent
                          ? `2px solid ${theme.palette.primary.main}`
                          : `1px solid ${theme.palette.divider}`
                        : "none",
                      borderBottom: isSelected ? `1px solid ${colors.selectedBg}` : `1px solid ${theme.palette.divider}`,
                      pointerEvents: "none",
                      zIndex: 2,
                    },
                    ...(showTrailingSeparator
                      ? {
                          "&::after": {
                            content: '""',
                            position: "absolute",
                            insetInlineEnd: 0,
                            top: "50%",
                            transform: "translateY(-50%)",
                            width: "1px",
                            height: `${PANE_TAB_BAR.UNSELECTED_DIVIDER_HEIGHT_PX}px`,
                            bgcolor: "divider",
                            pointerEvents: "none",
                            zIndex: 2,
                          },
                        }
                      : {}),
                  }}
                >
                  <Tooltip title={disabled ? "" : fullLocation} disableFocusListener disableTouchListener enterDelay={400}>
                    <Box
                      component="button"
                      type="button"
                      tabIndex={-1}
                      aria-pressed={isSelected}
                      aria-label={selectAriaLabel}
                      disabled={disabled}
                      onMouseDown={preventMouseFocus}
                      onClick={() => {
                        onSelectTab(tab.id);
                      }}
                      sx={{
                        position: "relative",
                        zIndex: 0,
                        appearance: "none",
                        border: 0,
                        margin: 0,
                        paddingBlock: 0,
                        paddingInline: `${titleInlinePaddingPx}px`,
                        width: "100%",
                        minWidth: 0,
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-start",
                        bgcolor: "transparent",
                        color: isSelected || isHovered ? "text.primary" : "text.secondary",
                        fontFamily: theme.typography.fontFamily,
                        fontSize: PANE_TAB_BAR.TAB_FONT_SIZE_REM,
                        fontWeight: isSelected ? 600 : 400,
                        lineHeight: 1.25,
                        cursor: disabled ? "default" : "pointer",
                        textAlign: "start",
                        "&:focus": {
                          outline: "none",
                        },
                      }}
                    >
                      <bdi
                        dir="auto"
                        style={{
                          display: "block",
                          minWidth: 0,
                          maxWidth: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {displayLabel}
                      </bdi>
                    </Box>
                  </Tooltip>

                  {isClosable && (
                    <Box
                      data-testid={`pane-tab-close-overlay-${paneId}-${tabIndex}`}
                      data-visible={showCloseOverlay ? "true" : "false"}
                      sx={{
                        position: "absolute",
                        insetInlineEnd: 0,
                        top: 0,
                        bottom: 0,
                        zIndex: 1,
                        display: "flex",
                        alignItems: "stretch",
                        pointerEvents: "none",
                        opacity: showCloseOverlay ? 1 : 0,
                      }}
                    >
                      <Box
                        aria-hidden="true"
                        sx={{
                          width: `${PANE_TAB_BAR.CLOSE_OVERLAY_FADE_WIDTH_PX}px`,
                          height: "100%",
                          background: `linear-gradient(${isRtl ? "to left" : "to right"}, transparent, ${tabCurrentBg})`,
                          pointerEvents: "none",
                        }}
                      />
                      <Tooltip
                        title={showCloseOverlay ? (isSelected ? closeTabTooltip : closeBackgroundTabTooltip) : ""}
                        describeChild
                        disableFocusListener
                        disableTouchListener
                        disableInteractive
                        enterDelay={400}
                      >
                        <Box
                          component="button"
                          type="button"
                          tabIndex={-1}
                          aria-label={closeAriaLabel}
                          disabled={disabled}
                          onMouseDown={preventMouseFocus}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (event.detail > 0 && !showCloseOverlay) {
                              return;
                            }
                            onCloseTab(tab.id);
                          }}
                          sx={{
                            appearance: "none",
                            border: 0,
                            margin: 0,
                            padding: 0,
                            width: `${closeTargetPx}px`,
                            minWidth: `${closeTargetPx}px`,
                            height: "100%",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            bgcolor: tabCurrentBg,
                            color: isSelected ? "text.primary" : "text.secondary",
                            cursor: disabled ? "default" : "pointer",
                            pointerEvents: showCloseOverlay ? "auto" : "none",
                            ...(!useTouchControls && !disabled
                              ? {
                                  [FINE_POINTER_HOVER_MEDIA]: {
                                    "&:hover": {
                                      color: "text.primary",
                                    },
                                    "&:hover .pane-tab-close-pill": {
                                      bgcolor: colors.closePillHoverBg,
                                    },
                                  },
                                }
                              : {}),
                            ...(!disabled
                              ? {
                                  "&:active": {
                                    color: "text.primary",
                                  },
                                  "&:active .pane-tab-close-pill": {
                                    bgcolor: colors.closePillHoverBg,
                                  },
                                }
                              : {}),
                            "&:focus": {
                              outline: "none",
                            },
                          }}
                        >
                          <Box
                            component="span"
                            className="pane-tab-close-pill"
                            sx={{
                              width: `${closePillSizePx}px`,
                              height: `${closePillSizePx}px`,
                              borderRadius: "4px",
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            <CloseIcon aria-hidden="true" sx={{ fontSize: `${PANE_TAB_BAR.CLOSE_ICON_FONT_SIZE_PX}px` }} />
                          </Box>
                        </Box>
                      </Tooltip>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>

          {/* Persistent Add button immediately after the visible tabs */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: `0 0 ${addSlotWidthPx}px`,
              width: `${addSlotWidthPx}px`,
              height: "100%",
              paddingInlineStart: `${PANE_TAB_BAR.ADD_BUTTON_MARGIN_START_PX}px`,
              paddingInlineEnd: `${addMarginEndPx}px`,
              boxSizing: "border-box",
              zIndex: 1,
            }}
          >
            <Tooltip title={disabled ? "" : newTabTooltip} disableFocusListener disableTouchListener enterDelay={400}>
              <Box
                component="button"
                type="button"
                data-testid={`pane-tab-add-${paneId}`}
                tabIndex={-1}
                aria-label={t("fileBrowser.tabs.newTab")}
                disabled={disabled}
                onMouseDown={preventMouseFocus}
                onClick={() => {
                  onCreateTab();
                }}
                sx={{
                  appearance: "none",
                  border: 0,
                  borderRadius: 1.5,
                  margin: 0,
                  padding: 0,
                  width: `${addButtonSizePx}px`,
                  minWidth: `${addButtonSizePx}px`,
                  height: `${controlHeightPx}px`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "transparent",
                  color: "text.secondary",
                  cursor: disabled ? "default" : "pointer",
                  ...(!useTouchControls && !disabled
                    ? {
                        [FINE_POINTER_HOVER_MEDIA]: {
                          "&:hover": {
                            bgcolor: colors.addHoverBg,
                            color: "text.primary",
                          },
                        },
                      }
                    : {}),
                  ...(!disabled
                    ? {
                        "&:active": {
                          bgcolor: colors.addHoverBg,
                          color: "text.primary",
                        },
                      }
                    : {}),
                  "&:focus": {
                    outline: "none",
                  },
                }}
              >
                <AddIcon aria-hidden="true" sx={{ fontSize: `${PANE_TAB_BAR.ADD_ICON_FONT_SIZE_PX}px` }} />
              </Box>
            </Tooltip>
          </Box>
        </Box>

        <Popover
          id={menuPopoverId}
          open={isMenuOpen}
          anchorEl={menuAnchorEl}
          onClose={() => closeMenu(true)}
          marginThreshold={menuMarginStartPx}
          disableAutoFocus
          disableRestoreFocus
          transitionDuration={0}
          anchorOrigin={{
            vertical: "bottom",
            horizontal: isRtl ? "right" : "left",
          }}
          transformOrigin={{
            vertical: "top",
            horizontal: isRtl ? "right" : "left",
          }}
          slotProps={{
            paper: {
              [KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE]: menuShortcutScope,
              "data-testid": `pane-tab-menu-${paneId}`,
              sx: [
                secondaryToolbarMenuPaperSx,
                {
                  mt: 0.5,
                  width: `${PANE_TAB_BAR.MENU_POPOVER_WIDTH_PX}px`,
                  maxWidth: `calc(100vw - ${menuMarginStartPx * 2}px)`,
                  overflow: "hidden",
                  borderRadius: 1,
                },
              ],
            } as Record<string, unknown>,
          }}
        >
          <Box
            ref={handleMenuListRef}
            role="list"
            aria-label={groupAriaLabel}
            onKeyDown={handleMenuKeyDown}
            sx={{
              position: "relative",
              py: 0.5,
              maxHeight: `min(${PANE_TAB_BAR.MENU_POPOVER_MAX_HEIGHT_PX}px, 70vh)`,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            {resolvedTabMeta.map(({ tab, displayLabel, fullLocation, selectAriaLabel, closeAriaLabel }, index) => {
              const isSelected = tab.id === selectedTabId;
              const isFocusedRow = index === safeFocusedMenuIndex;
              return (
                <Box
                  key={tab.id}
                  role="listitem"
                  data-testid={`pane-tab-menu-item-${paneId}-${index}`}
                  data-selected={isSelected ? "true" : "false"}
                  data-focused={isFocusedRow ? "true" : "false"}
                  onMouseEnter={() => {
                    setFocusedMenuIndex(index);
                    menuSelectRefs.current.get(tab.id)?.focus({ preventScroll: true });
                  }}
                  onAuxClick={(event) => handleMiddleClickClose(event, tab.id)}
                  sx={{
                    position: "relative",
                    display: "flex",
                    alignItems: "stretch",
                    minHeight: `${menuRowMinHeightPx}px`,
                    bgcolor: isFocusedRow ? "action.selected" : "transparent",
                  }}
                >
                  <Box
                    component="button"
                    type="button"
                    ref={(node: HTMLButtonElement | null) => {
                      if (node) {
                        menuSelectRefs.current.set(tab.id, node);
                      } else {
                        menuSelectRefs.current.delete(tab.id);
                      }
                    }}
                    aria-label={selectAriaLabel}
                    aria-current={isSelected ? "true" : undefined}
                    onFocus={() => {
                      setFocusedMenuIndex(index);
                    }}
                    onClick={() => {
                      onSelectTab(tab.id);
                      closeMenu(true);
                    }}
                    sx={{
                      appearance: "none",
                      border: 0,
                      margin: 0,
                      paddingBlock: 0.75,
                      paddingInlineStart: 2,
                      paddingInlineEnd: isClosable ? 0.5 : 2,
                      flex: "1 1 auto",
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "center",
                      gap: 0.125,
                      bgcolor: "transparent",
                      color: "text.primary",
                      fontFamily: theme.typography.fontFamily,
                      textAlign: "start",
                      cursor: "pointer",
                      outline: "none",
                      "&:focus": {
                        outline: "none",
                      },
                    }}
                  >
                    <bdi
                      dir="auto"
                      style={{
                        display: "block",
                        width: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: PANE_TAB_BAR.TAB_FONT_SIZE_REM,
                        fontWeight: isSelected ? 600 : 400,
                        lineHeight: 1.3,
                      }}
                    >
                      {displayLabel}
                    </bdi>
                    <Box
                      component="span"
                      title={fullLocation}
                      sx={{
                        display: "block",
                        width: "100%",
                        color: "text.secondary",
                        fontSize: PANE_TAB_BAR.MENU_LOCATION_FONT_SIZE_REM,
                        fontWeight: 400,
                        lineHeight: 1.25,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <bdi dir="auto">{fullLocation}</bdi>
                    </Box>
                  </Box>

                  {isClosable && (
                    <Tooltip
                      title={closeMenuTabTooltip}
                      describeChild
                      disableFocusListener
                      disableTouchListener
                      disableInteractive
                      enterDelay={400}
                    >
                      <Box
                        component="button"
                        type="button"
                        data-testid={`pane-tab-menu-close-${paneId}-${index}`}
                        tabIndex={-1}
                        aria-label={closeAriaLabel}
                        onMouseDown={preventMouseFocus}
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseTab(tab.id);
                        }}
                        sx={{
                          appearance: "none",
                          border: 0,
                          margin: 0,
                          padding: 0,
                          flex: `0 0 ${useTouchControls ? PANE_TAB_BAR.CONTROL_TARGET_TOUCH_PX : 34}px`,
                          width: `${useTouchControls ? PANE_TAB_BAR.CONTROL_TARGET_TOUCH_PX : 34}px`,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          bgcolor: "transparent",
                          color: "text.secondary",
                          cursor: "pointer",
                          ...(!useTouchControls
                            ? {
                                [FINE_POINTER_HOVER_MEDIA]: {
                                  "&:hover": {
                                    color: "text.primary",
                                  },
                                  "&:hover .pane-tab-menu-close-pill": {
                                    bgcolor: colors.closePillHoverBg,
                                  },
                                },
                              }
                            : {}),
                          "&:active": {
                            color: "text.primary",
                          },
                          "&:active .pane-tab-menu-close-pill": {
                            bgcolor: colors.closePillHoverBg,
                          },
                          "&:focus": {
                            outline: "none",
                          },
                        }}
                      >
                        <Box
                          component="span"
                          className="pane-tab-menu-close-pill"
                          sx={{
                            width: `${closePillSizePx}px`,
                            height: `${closePillSizePx}px`,
                            borderRadius: "4px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <CloseIcon aria-hidden="true" sx={{ fontSize: `${PANE_TAB_BAR.CLOSE_ICON_FONT_SIZE_PX}px` }} />
                        </Box>
                      </Box>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>
        </Popover>
      </>
    );
  }
);

PaneTabBar.displayName = "PaneTabBar";
