/**
 * Theme constants
 *
 * Centralized definitions for shared styling values used across the application.
 * Using constants prevents magic numbers and ensures consistency.
 */

//
// Focus indicators
//

/** Focus outline width in pixels for keyboard navigation */
export const FOCUS_OUTLINE_WIDTH_PX = 3;

/** Focus outline offset in pixels */
export const FOCUS_OUTLINE_OFFSET_PX = 0;

//
// Touch targets (WCAG 2.5.5)
//

/** Minimum touch target size for WCAG 2.5.5 compliance */
export const TOUCH_TARGET_MIN_SIZE_PX = 44;

//
// Z-Index scale
//

/** Hierarchical z-index values for layering UI elements */
export const Z_INDEX = {
  /** Sticky headers within scrollable content */
  STICKY_HEADER: 10,
  /** Overlays and dropdowns */
  OVERLAY: 100,
  /** MUI modal default */
  MODAL: 1300,
  /** Viewer toolbars (above everything) */
  VIEWER_TOOLBAR: 9999,
} as const;

//
// Toolbar dimensions
//

/** Toolbar heights matching MUI AppBar */
export const TOOLBAR_HEIGHT = {
  MOBILE_PX: 56,
  DESKTOP_PX: 64,
} as const;

/** File-browser row heights for compact/mobile and desktop layouts. */
export const FILE_BROWSER_ROW_HEIGHT = {
  MOBILE_PX: 72,
  TOUCH_PX: 48,
  DESKTOP_PX: 40,
} as const;

/** Geometry, spacing, and interaction targets for per-pane folder tab bars. */
export const PANE_TAB_BAR = {
  HEIGHT_MOUSE_PX: 38,
  HEIGHT_TOUCH_PX: 48,
  BAR_TOP_INSET_PX: 4,
  BAR_INLINE_START_PADDING_MOUSE_PX: 8,
  BAR_INLINE_START_PADDING_TOUCH_PX: 4,
  MIN_CLOSABLE_TAB_WIDTH_MOUSE_PX: 96,
  MIN_CLOSABLE_TAB_WIDTH_TOUCH_PX: 104,
  MIN_SINGLE_TAB_WIDTH_MOUSE_PX: 64,
  MIN_SINGLE_TAB_WIDTH_TOUCH_PX: 76,
  /** Per-tab width cap once multiple tabs compete for horizontal space. */
  OVERFLOW_MAX_TAB_WIDTH_PX: 200,
  TITLE_INLINE_PADDING_MOUSE_PX: 14,
  TITLE_INLINE_PADDING_TOUCH_PX: 16,
  TAB_GAP_PX: 0,
  TAB_TOP_RADIUS_PX: 6,
  TAB_FONT_SIZE_REM: "0.8125rem",
  UNSELECTED_DIVIDER_HEIGHT_PX: 14,
  CONTROL_TARGET_MOUSE_PX: 26,
  CONTROL_TARGET_TOUCH_PX: 44,
  CLOSE_PILL_MOUSE_PX: 20,
  CLOSE_PILL_TOUCH_PX: 28,
  CLOSE_ICON_FONT_SIZE_PX: 14,
  ADD_BUTTON_SIZE_MOUSE_PX: 28,
  ADD_BUTTON_SIZE_TOUCH_PX: 44,
  ADD_BUTTON_MARGIN_START_PX: 4,
  ADD_BUTTON_MARGIN_END_MOUSE_PX: 4,
  ADD_BUTTON_MARGIN_END_TOUCH_PX: 2,
  ADD_ICON_FONT_SIZE_PX: 18,
  MENU_BUTTON_SIZE_MOUSE_PX: 28,
  MENU_BUTTON_SIZE_TOUCH_PX: 44,
  MENU_BUTTON_MARGIN_START_MOUSE_PX: 4,
  MENU_BUTTON_MARGIN_START_TOUCH_PX: 2,
  MENU_BUTTON_MARGIN_END_MOUSE_PX: 4,
  MENU_BUTTON_MARGIN_END_TOUCH_PX: 2,
  MENU_ICON_FONT_SIZE_PX: 18,
  MENU_POPOVER_WIDTH_PX: 340,
  MENU_POPOVER_MAX_HEIGHT_PX: 420,
  MENU_ITEM_MIN_HEIGHT_MOUSE_PX: 44,
  MENU_ITEM_MIN_HEIGHT_TOUCH_PX: 52,
  MENU_LOCATION_FONT_SIZE_REM: "0.75rem",
  CLOSE_OVERLAY_FADE_WIDTH_PX: 14,
  MAX_LABEL_GRAPHEMES: 120,
} as const;

/** Visual scale used by the compact layout without changing its fixed geometry. */
export const COMPACT_LAYOUT_SIZE = {
  FILE_ROW_TEXT_PX: 17,
  FILE_ROW_METADATA_PX: 12,
  FILE_ROW_ICON_PX: 28,
  MENU_TEXT_PX: 17,
  MENU_ICON_PX: 24,
  DIALOG_TITLE_PX: 20,
  DIALOG_BODY_PX: 17,
  DIALOG_FORM_LABEL_PX: 16,
  DRAWER_SECTION_LABEL_PX: 14,
  SEARCH_RESULT_GROUP_HEADING_PX: 14,
  SEARCH_RESULT_PRIMARY_TEXT_PX: 16,
  SETTINGS_APP_BAR_TITLE_PX: 18,
  SETTINGS_PAGE_TITLE_PX: 22,
  SETTINGS_SECTION_TITLE_PX: 20,
  SETTINGS_SUBSECTION_TITLE_PX: 18,
  SETTINGS_PRIMARY_TEXT_PX: 17,
  SETTINGS_SECONDARY_TEXT_PX: 16,
  SETTINGS_LABEL_PX: 16,
  SETTINGS_METADATA_TEXT_PX: 14,
  SETTINGS_CATEGORY_ICON_PX: 28,
} as const;

//
// Page input field sizing
//

/** Dimensions for page number input fields in PDF/document viewers */
export const PAGE_INPUT = {
  WIDTH_MOBILE_PX: 40,
  WIDTH_DESKTOP_PX: 60,
  PADDING_MOBILE_PX: 4,
  PADDING_DESKTOP_PX: 6,
} as const;

//
// Scrollbar styling
//

export const SCROLLBAR = {
  WIDTH_PX: 12,
  THUMB_BORDER_RADIUS_PX: 8,
  THUMB_MIN_HEIGHT_PX: 24,
  THUMB_BORDER_PX: 3,
} as const;

//
// Responsive typography
//

/** Responsive font sizes for common use cases */
export const RESPONSIVE_FONT_SIZE = {
  /** Body text: smaller on mobile, larger on desktop */
  BODY: { xs: "0.875rem", sm: "1.25rem" },
  /** Input fields: 16px on iOS to prevent zoom on focus */
  INPUT_IOS_SAFE: { xs: "16px", sm: "14px" },
  /** Smaller captions */
  CAPTION: { xs: "0.7rem", sm: "0.875rem" },
} as const;

//
// Search highlight colors
//

/** Colors for search result highlighting */
export const SEARCH_HIGHLIGHT = {
  /** Orange highlight for current/active match */
  CURRENT_MATCH: "rgba(255, 152, 0, 0.4)",
  /** Yellow highlight for other matches */
  OTHER_MATCHES: "rgba(255, 255, 0, 0.4)",
} as const;
