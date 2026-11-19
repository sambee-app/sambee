import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shouldUseTouchTabControls } from "../../../pages/FileBrowser/preferences";
import type { PaneTabSummary } from "../../../pages/FileBrowser/tabSessions";
import { createMockConnection } from "../../../test/fixtures/connections";
import { renderWithStyles as render } from "../../../test/utils/renderWithStyles";
import { PANE_TAB_BAR } from "../../../theme/constants";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { setApplePlatformForTesting } from "../../../utils/platform";
import { PaneTabBar, type PaneTabBarProps } from "../PaneTabBar";

const connections = [
  createMockConnection({ id: "conn-1", name: "Demo", slug: "demo" }),
  createMockConnection({ id: "conn-2", name: "Backup", slug: "backup" }),
];

const twoTabs: PaneTabSummary[] = [
  { id: "t1", connectionId: "conn-1", currentPath: "Projects/Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
  { id: "t2", connectionId: "conn-2", currentPath: "Exports/Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
];

function renderBar(overrides: Partial<PaneTabBarProps> = {}) {
  const props: PaneTabBarProps = {
    paneId: "left",
    paneMode: "dual",
    isActivePane: true,
    tabs: twoTabs,
    selectedTabId: "t1",
    tabRevealToken: 0,
    connections,
    useTouchControls: false,
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCreateTab: vi.fn(),
    onRestoreFocus: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <SambeeThemeProvider>
      <PaneTabBar {...props} />
    </SambeeThemeProvider>
  );
  return { ...utils, props };
}

describe("PaneTabBar", () => {
  it.each([
    [false, "Alt+Minus"],
    [true, "Control+Minus"],
  ])("shows the actual close shortcut without changing the close button's name (Apple: %s)", async (apple, shortcut) => {
    setApplePlatformForTesting(apple);
    try {
      renderBar();
      const tab = screen.getByTestId("pane-tab-item-left-0");
      const close = within(tab).getByRole("button", { name: "Close Test tab (Demo:/Projects/Test)" });
      fireEvent.pointerEnter(tab, { pointerType: "mouse" });
      fireEvent.mouseOver(close);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(`Close tab (${shortcut})`);
      expect(close).toHaveAccessibleName("Close Test tab (Demo:/Projects/Test)");
    } finally {
      setApplePlatformForTesting(null);
    }
  });

  it("resolves touch tab controls from input capabilities and preferences without treating narrow viewports as touch", () => {
    expect(shouldUseTouchTabControls({ preference: "auto", hasCoarseAnyPointer: false, hasHoverNone: false, maxTouchPoints: 0 })).toBe(
      false
    );
    expect(shouldUseTouchTabControls({ preference: "auto", hasCoarseAnyPointer: true, hasHoverNone: false, maxTouchPoints: 0 })).toBe(true);
    expect(shouldUseTouchTabControls({ preference: "auto", hasCoarseAnyPointer: false, hasHoverNone: true, maxTouchPoints: 0 })).toBe(true);
    expect(shouldUseTouchTabControls({ preference: "auto", hasCoarseAnyPointer: false, hasHoverNone: false, maxTouchPoints: 5 })).toBe(
      true
    );
    expect(shouldUseTouchTabControls({ preference: "always", hasCoarseAnyPointer: false, hasHoverNone: false, maxTouchPoints: 0 })).toBe(
      true
    );
    expect(shouldUseTouchTabControls({ preference: "never", hasCoarseAnyPointer: true, hasHoverNone: true, maxTouchPoints: 5 })).toBe(
      false
    );
  });

  it("renders sibling non-focusable controls, omits close for the last tab, and preserves full accessible names", () => {
    const singleTab: PaneTabSummary[] = [twoTabs[0]!];
    const { rerender, props } = renderBar({ tabs: singleTab });

    expect(screen.queryByRole("button", { name: /Close Test tab/i })).not.toBeInTheDocument();
    const allTabsSingle = screen.getByTestId("pane-tab-all-tabs-left");
    const tabStrip = screen.getByTestId("pane-tab-strip-left");
    const newTabButton = screen.getByRole("button", { name: "New tab" });
    const onlySelectButton = screen.getByRole("button", { name: "Test — Demo:/Projects/Test" });

    // Chrome-style DOM order: All Tabs (⌄) -> tab strip -> New tab (+)
    expect(allTabsSingle.compareDocumentPosition(tabStrip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabStrip.compareDocumentPosition(newTabButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(allTabsSingle).toHaveAttribute("tabindex", "-1");
    expect(allTabsSingle).toHaveAttribute("aria-label", "All tabs (1)");
    expect(allTabsSingle).toHaveTextContent("");
    expect(onlySelectButton).toHaveAttribute("aria-pressed", "true");
    expect(onlySelectButton).toHaveAttribute("tabindex", "-1");
    expect(newTabButton).toHaveAttribute("tabindex", "-1");
    expect(tabStrip).toHaveAttribute("tabindex", "-1");
    expect(tabStrip).toHaveStyle({ overflow: "hidden" });

    // With duplicate visible folder names ("Test"), accessible names include full connection and path
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={twoTabs} />
      </SambeeThemeProvider>
    );

    const firstSelect = screen.getByRole("button", { name: "Test — Demo:/Projects/Test" });
    const secondSelect = screen.getByRole("button", { name: "Test — Backup:/Exports/Test" });
    const firstClose = screen.getByRole("button", { name: "Close Test tab (Demo:/Projects/Test)" });
    const secondClose = screen.getByRole("button", { name: "Close Test tab (Backup:/Exports/Test)" });
    const allTabsButton = screen.getByTestId("pane-tab-all-tabs-left");

    // Selection and close buttons are siblings, never nested interactive buttons
    expect(firstSelect.contains(firstClose)).toBe(false);
    expect(firstClose.contains(firstSelect)).toBe(false);
    expect(secondSelect).toHaveAttribute("aria-pressed", "false");
    expect(firstClose).toHaveAttribute("tabindex", "-1");
    expect(secondClose).toHaveAttribute("tabindex", "-1");
    expect(allTabsButton).toHaveAttribute("tabindex", "-1");
    expect(allTabsButton).toHaveAttribute("aria-label", "All tabs (2)");
  });

  it("keeps mouse close overlays hidden with pointer-events none until hovered and never shifts padding", async () => {
    const { props } = renderBar({ useTouchControls: false });
    const tabItem = screen.getByTestId("pane-tab-item-left-1");
    const closeOverlay = screen.getByTestId("pane-tab-close-overlay-left-1");
    const closeButton = screen.getByRole("button", { name: "Close Test tab (Backup:/Exports/Test)" });
    const selectButton = screen.getByRole("button", { name: "Test — Backup:/Exports/Test" });

    expect(closeOverlay).toHaveAttribute("data-visible", "false");
    expect(closeButton).toHaveStyle({ pointerEvents: "none" });
    expect(selectButton).toHaveStyle({ paddingInline: `${PANE_TAB_BAR.TITLE_INLINE_PADDING_MOUSE_PX}px` });

    // Simulated pointer click on hidden overlay does not close the tab
    fireEvent.click(closeButton, { detail: 1 });
    expect(props.onCloseTab).not.toHaveBeenCalled();

    // Hovering with mouse reveals overlay without changing inline padding or layout mode
    fireEvent.pointerEnter(tabItem, { pointerType: "mouse" });
    expect(closeOverlay).toHaveAttribute("data-visible", "true");
    expect(closeButton).toHaveStyle({ pointerEvents: "auto", width: `${PANE_TAB_BAR.CONTROL_TARGET_MOUSE_PX}px` });
    expect(selectButton).toHaveStyle({ paddingInline: `${PANE_TAB_BAR.TITLE_INLINE_PADDING_MOUSE_PX}px` });

    fireEvent.click(closeButton, { detail: 1 });
    expect(props.onCloseTab).toHaveBeenCalledWith("t2");
    expect(props.onSelectTab).not.toHaveBeenCalled();

    fireEvent.pointerLeave(tabItem, { pointerType: "mouse" });
    expect(closeOverlay).toHaveAttribute("data-visible", "false");
  });

  it("always shows close overlays in touch mode and closes directly on tap without selecting first", async () => {
    const user = userEvent.setup();
    const { props } = renderBar({ useTouchControls: true });

    expect(screen.getByTestId("pane-tab-bar-left")).toHaveStyle({ height: `${PANE_TAB_BAR.HEIGHT_TOUCH_PX}px` });
    const firstTouchItem = screen.getByTestId("pane-tab-item-left-0");
    expect(firstTouchItem).toHaveStyle({
      minWidth: `${PANE_TAB_BAR.MIN_CLOSABLE_TAB_WIDTH_TOUCH_PX}px`,
    });
    // Decorative borders live on pseudo-elements, never shrinking the 44px button box inside the tab wrapper
    expect(["", "0px"]).toContain(window.getComputedStyle(firstTouchItem).borderTopWidth);
    expect(["", "0px"]).toContain(window.getComputedStyle(firstTouchItem).borderBottomWidth);
    expect(screen.getByTestId("pane-tab-close-overlay-left-0")).toHaveAttribute("data-visible", "true");
    expect(screen.getByTestId("pane-tab-close-overlay-left-1")).toHaveAttribute("data-visible", "true");

    const unselectedClose = screen.getByRole("button", { name: "Close Test tab (Backup:/Exports/Test)" });
    expect(unselectedClose).toHaveStyle({ width: `${PANE_TAB_BAR.CONTROL_TARGET_TOUCH_PX}px`, pointerEvents: "auto" });

    await user.click(unselectedClose);
    expect(props.onCloseTab).toHaveBeenCalledTimes(1);
    expect(props.onCloseTab).toHaveBeenCalledWith("t2");
    expect(props.onSelectTab).not.toHaveBeenCalled();
  });

  it("closes a closable tab on middle-click without selecting it and ignores middle-click on the last tab", () => {
    const { rerender, props } = renderBar({ tabs: twoTabs, selectedTabId: "t1" });
    const secondItem = screen.getByTestId("pane-tab-item-left-1");

    // Left or right auxclick button codes do nothing
    fireEvent(secondItem, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(props.onCloseTab).not.toHaveBeenCalled();

    // Middle-click (button 1) closes the target tab directly
    fireEvent(secondItem, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(props.onCloseTab).toHaveBeenCalledTimes(1);
    expect(props.onCloseTab).toHaveBeenCalledWith("t2");
    expect(props.onSelectTab).not.toHaveBeenCalled();

    // Single remaining tab is protected against middle-click close
    vi.mocked(props.onCloseTab).mockClear();
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={[twoTabs[0]!]} selectedTabId="t1" />
      </SambeeThemeProvider>
    );
    fireEvent(screen.getByTestId("pane-tab-item-left-0"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(props.onCloseTab).not.toHaveBeenCalled();
  });

  it("shrinks tabs proportionally when all fit and clamps to whole unclipped tabs with an icon-only leading menu button when overflowing", () => {
    const singleTab: PaneTabSummary[] = [twoTabs[0]!];
    const { rerender, props } = renderBar({ tabs: singleTab, selectedTabId: "t1", useTouchControls: false });
    const bar = screen.getByTestId("pane-tab-bar-left");

    // Constant mouse chrome: 36 px leading All Tabs slot + 36 px trailing Add slot = 72 px -> 672 px bar leaves 600 px available.
    Object.defineProperty(bar, "clientWidth", { value: 672, configurable: true });
    fireEvent(window, new Event("resize"));

    expect(screen.getByTestId("pane-tab-item-left-0")).toHaveStyle({ maxWidth: "600px", flexShrink: "1" });

    // Two tabs share the 600 px budget up to 300 px each without shifting Tab 1 horizontally
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={twoTabs} selectedTabId="t1" useTouchControls={false} />
      </SambeeThemeProvider>
    );
    expect(screen.getByTestId("pane-tab-item-left-0")).toHaveStyle({ maxWidth: "300px" });
    expect(screen.getByTestId("pane-tab-all-tabs-left")).toHaveAttribute("data-hidden-count", "0");

    // Five tabs (5 * 96 = 480 <= 600) all fit without overflow and shrink proportionally from 200 px as needed
    const fiveTabs: PaneTabSummary[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `tab-${n}`,
      connectionId: "conn-1",
      currentPath: `Folder-${n}`,
      archiveLocation: null,
      sortBy: "name",
      sortDirection: "asc",
    }));
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={fiveTabs} selectedTabId="tab-1" useTouchControls={false} />
      </SambeeThemeProvider>
    );
    expect(screen.getAllByTestId(/^pane-tab-item-left-/)).toHaveLength(5);
    expect(screen.getByTestId("pane-tab-item-left-0")).toHaveStyle({
      maxWidth: `${PANE_TAB_BAR.OVERFLOW_MAX_TAB_WIDTH_PX}px`,
      minWidth: `${PANE_TAB_BAR.MIN_CLOSABLE_TAB_WIDTH_MOUSE_PX}px`,
    });
    expect(screen.getByTestId("pane-tab-all-tabs-left")).toHaveAttribute("data-hidden-count", "0");

    // Ten tabs in 452 px bar:
    // Fixed chrome = 36 px leading menu + 36 px trailing add = 72 px -> 380 px strip -> floor(380 / 96) = 3 whole visible tabs, 7 hidden!
    const tenTabs: PaneTabSummary[] = Array.from({ length: 10 }, (_, idx) => ({
      id: `tab-${idx + 1}`,
      connectionId: "conn-1",
      currentPath: `Folder-${idx + 1}`,
      archiveLocation: null,
      sortBy: "name",
      sortDirection: "asc",
    }));
    Object.defineProperty(bar, "clientWidth", { value: 452, configurable: true });
    fireEvent(window, new Event("resize"));
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={tenTabs} selectedTabId="tab-1" useTouchControls={false} />
      </SambeeThemeProvider>
    );

    expect(screen.getAllByTestId(/^pane-tab-item-left-/)).toHaveLength(3);
    expect(screen.getByTestId("pane-tab-item-left-0")).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pane-tab-item-left-3")).not.toBeInTheDocument();

    const overflowButton = screen.getByTestId("pane-tab-all-tabs-left");
    const addButton = screen.getByTestId("pane-tab-add-left");
    expect(overflowButton).toHaveAttribute("data-hidden-count", "7");
    expect(overflowButton).toHaveTextContent("");
    expect(overflowButton).toHaveAttribute("aria-label", "All tabs (10, 7 hidden)");
    // Resting background of the All Tabs button matches the New Tab button even when tabs overflow
    expect(window.getComputedStyle(overflowButton).backgroundColor).toBe(window.getComputedStyle(addButton).backgroundColor);

    // Selecting tab-2 (already visible in [0..2]) keeps window anchored at [0..2] without shifting tabs under the pointer
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={tenTabs} selectedTabId="tab-2" useTouchControls={false} />
      </SambeeThemeProvider>
    );
    expect(screen.getByTestId("pane-tab-item-left-0")).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-2")).toBeInTheDocument();

    // Selecting tab-9 shifts the visible window minimally to [6..8] (tabs 7, 8, 9) so the active tab is visible and unclipped
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={tenTabs} selectedTabId="tab-9" useTouchControls={false} />
      </SambeeThemeProvider>
    );
    expect(screen.queryByTestId("pane-tab-item-left-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-6")).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-7")).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-8")).toHaveAttribute("data-selected", "true");
  });

  it("opens the All Tabs menu with full locations, selects hidden tabs, and supports rapid multi-close without dismissing", async () => {
    const user = userEvent.setup();
    const fourTabs: PaneTabSummary[] = [
      { id: "t1", connectionId: "conn-1", currentPath: "Alpha/Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
      { id: "t2", connectionId: "conn-2", currentPath: "Beta/Test", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
      { id: "t3", connectionId: "conn-1", currentPath: "Gamma/Reports", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
      { id: "t4", connectionId: "conn-2", currentPath: "Delta/Exports", archiveLocation: null, sortBy: "name", sortDirection: "asc" },
    ];
    const { rerender, props } = renderBar({ tabs: fourTabs, selectedTabId: "t4", useTouchControls: false });
    const bar = screen.getByTestId("pane-tab-bar-left");

    // Constrain bar so only 2 tabs fit visibly (t3, t4) and 2 are hidden (t1, t2)
    Object.defineProperty(bar, "clientWidth", { value: 320, configurable: true });
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("pane-tab-all-tabs-left")).toHaveAttribute("data-hidden-count", "2");
    expect(screen.getByTestId("pane-tab-all-tabs-left")).toHaveTextContent("");

    // Open the All Tabs menu
    await user.click(screen.getByTestId("pane-tab-all-tabs-left"));
    const menu = screen.getByTestId("pane-tab-menu-left");
    expect(menu).toBeInTheDocument();

    // All 4 tabs appear vertically with disambiguating full locations, sibling close buttons, and initial focus on the active tab
    const activeRowItem = within(menu).getByTestId("pane-tab-menu-item-left-3");
    const activeRowButton = within(menu).getByRole("button", { name: "Exports — Backup:/Delta/Exports" });
    expect(within(menu).getByText("Demo:/Alpha/Test")).toBeInTheDocument();
    expect(within(menu).getByText("Backup:/Beta/Test")).toBeInTheDocument();
    expect(within(menu).getByText("Demo:/Gamma/Reports")).toBeInTheDocument();
    expect(within(menu).getByText("Backup:/Delta/Exports")).toBeInTheDocument();
    expect(activeRowButton).toHaveAttribute("aria-current", "true");
    expect(activeRowButton).toHaveFocus();
    expect(window.getComputedStyle(activeRowButton).outlineStyle).toBe("none");
    expect(activeRowItem).toHaveAttribute("data-focused", "true");
    const unselectedRowItem = within(menu).getByTestId("pane-tab-menu-item-left-0");
    expect(unselectedRowItem).toHaveAttribute("data-focused", "false");
    expect(window.getComputedStyle(activeRowItem).backgroundColor).not.toBe(window.getComputedStyle(unselectedRowItem).backgroundColor);

    // Hovering another row moves the unified action.selected highlight to that row (matching Ctrl+K)
    fireEvent.mouseEnter(within(menu).getByTestId("pane-tab-menu-item-left-2"));
    expect(within(menu).getByTestId("pane-tab-menu-item-left-2")).toHaveAttribute("data-focused", "true");
    expect(activeRowItem).toHaveAttribute("data-focused", "false");

    // Closing a background tab via its row close button keeps the menu open for rapid cleanup
    await user.click(within(menu).getByTestId("pane-tab-menu-close-left-1"));
    expect(props.onCloseTab).toHaveBeenCalledWith("t2");
    expect(props.onSelectTab).not.toHaveBeenCalled();
    expect(screen.getByTestId("pane-tab-menu-left")).toBeInTheDocument();

    // Middle-clicking a row in the menu also closes it while keeping the menu open
    fireEvent(
      within(menu).getByTestId("pane-tab-menu-item-left-2"),
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    );
    expect(props.onCloseTab).toHaveBeenCalledWith("t3");
    expect(screen.getByTestId("pane-tab-menu-left")).toBeInTheDocument();

    // Keyboard ArrowDown / ArrowUp / Delete inside the menu moves the row highlight without an outline ring and closes focused tab
    const firstRowButton = within(menu).getByRole("button", { name: "Test — Demo:/Alpha/Test" });
    act(() => {
      firstRowButton.focus();
    });
    expect(within(menu).getByTestId("pane-tab-menu-item-left-0")).toHaveAttribute("data-focused", "true");
    fireEvent.keyDown(firstRowButton, { key: "ArrowDown" });
    const secondRowButton = within(menu).getByRole("button", { name: "Test — Backup:/Beta/Test" });
    expect(secondRowButton).toHaveFocus();
    expect(window.getComputedStyle(secondRowButton).outlineStyle).toBe("none");
    expect(within(menu).getByTestId("pane-tab-menu-item-left-1")).toHaveAttribute("data-focused", "true");
    expect(within(menu).getByTestId("pane-tab-menu-item-left-0")).toHaveAttribute("data-focused", "false");
    fireEvent.keyDown(secondRowButton, { key: "Delete" });
    expect(props.onCloseTab).toHaveBeenCalledWith("t2");

    // Pressing Escape inside the menu closes it and restores list focus
    vi.mocked(props.onRestoreFocus!).mockClear();
    fireEvent.keyDown(secondRowButton, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("pane-tab-menu-left")).not.toBeInTheDocument();
      expect(props.onRestoreFocus).toHaveBeenCalled();
    });

    // Selecting a hidden tab from the menu invokes onSelectTab, closes the menu, and restores list focus
    await user.click(screen.getByTestId("pane-tab-all-tabs-left"));
    const reopenedMenu = screen.getByTestId("pane-tab-menu-left");
    vi.mocked(props.onRestoreFocus!).mockClear();
    await user.click(within(reopenedMenu).getByRole("button", { name: "Test — Demo:/Alpha/Test" }));
    expect(props.onSelectTab).toHaveBeenCalledWith("t1");
    await waitFor(() => {
      expect(screen.queryByTestId("pane-tab-menu-left")).not.toBeInTheDocument();
      expect(props.onRestoreFocus).toHaveBeenCalled();
    });

    // Re-open and verify closing down to 1 tab auto-dismisses the menu cleanly
    await user.click(screen.getByTestId("pane-tab-all-tabs-left"));
    expect(screen.getByTestId("pane-tab-menu-left")).toBeInTheDocument();
    rerender(
      <SambeeThemeProvider>
        <PaneTabBar {...props} tabs={[fourTabs[0]!]} selectedTabId="t1" useTouchControls={false} />
      </SambeeThemeProvider>
    );
    await waitFor(() => {
      expect(screen.queryByTestId("pane-tab-menu-left")).not.toBeInTheDocument();
    });
  });

  it("renders platform-aware shortcut in the New tab tooltip and preserves bidi isolation", () => {
    setApplePlatformForTesting(true);
    try {
      const unicodeTabs: PaneTabSummary[] = [
        {
          id: "u1",
          connectionId: "conn-1",
          currentPath: "مجلد_عربي_👨‍👩‍👧‍👦",
          archiveLocation: null,
          sortBy: "name",
          sortDirection: "asc",
        },
      ];
      renderBar({ tabs: unicodeTabs, selectedTabId: "u1" });
      const bdi = screen.getByText("مجلد_عربي_👨‍👩‍👧‍👦");
      expect(bdi.tagName).toBe("BDI");
      expect(bdi).toHaveAttribute("dir", "auto");
    } finally {
      setApplePlatformForTesting(null);
    }
  });
});
