//
// Search Provider Types
//

/**
 * Modular Search Provider Interface
 * ==================================
 *
 * Defines the contract for pluggable search functionality in the unified
 * search bar. Different providers can implement this interface to supply
 * domain-specific search results (e.g., directory navigation, file search).
 *
 * Each provider controls:
 * - How search queries are executed (fetchResults)
 * - What happens when a result is selected (onSelect)
 * - Which structured presentation data each result supplies
 * - Placeholder text and status indicators
 */

import type React from "react";

// ============================================================================
// Result types
// ============================================================================

/** Icons understood by the shared quick-bar result renderer. */
export type SearchResultIcon = "command" | "directory" | "recent-directory" | "file" | "recent-file";

/** An inclusive-exclusive text range highlighted by the shared renderer. */
export interface SearchTextHighlight {
  start: number;
  end: number;
}

/** A selectable quick-bar result. Providers describe data; the shared renderer owns presentation. */
export interface SearchResultItem {
  kind: "result";
  /** Unique identifier for the result. */
  id: string;
  /** The raw value passed to onSelect when chosen. */
  value: string;
  /** Semantic icon selected by the shared renderer. */
  icon: SearchResultIcon;
  /** Main result label. */
  primaryText: string;
  /** Optional muted result context. */
  secondaryText?: string;
  /** Optional highlighted range in the primary label. */
  primaryHighlight?: SearchTextHighlight | SearchTextHighlight[];
  /** Optional highlighted range in the secondary label. */
  secondaryHighlight?: SearchTextHighlight | SearchTextHighlight[];
  /** Optional keyboard shortcut badge, used by commands. */
  shortcutLabel?: string;
  matchRank?: number;
  matchedTermCount?: number;
  sortPath?: string;
  depth?: number;
  lastUsedAt?: string;
  usageScore?: number;
}

/** A non-selectable group label in the quick-bar result list. */
export interface SearchResultGroupHeader {
  kind: "group-header";
  id: string;
  /** Group headers have no selectable value. */
  value: "";
  label: string;
}

/** A structured result rendered by UnifiedSearchBar. */
export type SearchResult = SearchResultItem | SearchResultGroupHeader;

export type SearchResultsUpdate = (results: SearchResult[]) => void;

/** Status information from the provider (e.g., indexing progress) */
export interface SearchStatusInfo {
  /** Short text label describing current status */
  label: string;
  /** Whether an activity spinner should be shown */
  showSpinner: boolean;
}

export type SearchSelectionFocusTarget = "file-list" | "quick-bar" | "none";

export interface SearchSelectionBehavior {
  /** Where focus should go after a result is selected. */
  focusTarget?: SearchSelectionFocusTarget;
}

export type SearchSelectionAction = "associated-viewer" | "force-viewer-picker" | "associated-native-app" | "force-native-picker";

// ============================================================================
// Provider interface
// ============================================================================

export interface SearchProvider {
  /** Unique identifier for this provider */
  id: string;
  sourceKey?: string;
  invalidateResults?: () => void;

  /** Stable mode identifier used for UI logic without coupling to translated labels. */
  modeId?: string;

  /** Short visible label for the current quick-bar mode. */
  modeLabel?: string;

  /** Placeholder text shown in the search input */
  placeholder: string;

  /** Debounce delay in milliseconds for search input */
  debounceMs: number;

  /** Minimum query length to trigger a search (0 = search on empty string) */
  minQueryLength: number;

  /** Optional query-aware minimum length for providers whose threshold depends on the current input. */
  getMinQueryLength?: (query: string) => number;

  /**
   * Fetch results for a given query.
   * @param query The search string
   * @param signal AbortSignal for cancellation
   * @returns Array of search results
   */
  fetchResults: (query: string, signal: AbortSignal, onUpdate?: SearchResultsUpdate) => Promise<SearchResult[]>;

  getRefreshIntervalMs?: () => number | null;

  /**
   * Called when a result is selected (via click or Enter).
   * @param value The value of the selected result
   */
  onSelect: (value: string, action?: SearchSelectionAction) => SearchSelectionBehavior | undefined;

  /**
   * Optionally remove the selected result without closing the quick bar.
   * Returns true only when a result was removed and should be refreshed.
   */
  onRemoveSelected?: (value: string) => Promise<boolean>;

  /**
   * Optional status info to display (e.g., "Indexing... 42 directories found").
   * Return null to hide the status bar.
   */
  getStatusInfo: () => SearchStatusInfo | null;

  /**
   * Called when the search bar gains focus or becomes active.
   * Providers can use this to warm up caches or prefetch data.
   */
  onActivate?: () => void;

  /**
   * Called whenever the visible query changes, including explicit clears.
   * Providers can use this to keep derived UI state in sync with the raw input.
   */
  onQueryChange?: (query: string) => void;

  /**
   * Called when the search bar is dismissed.
   * Providers can use this to cancel in-flight requests or reset state.
   */
  onDeactivate?: () => void;

  /** Hint content shown in the footer (e.g., keyboard shortcuts). Supports ReactNode for rich formatting. */
  footerHint?: React.ReactNode;

  /** Optional selected-result-aware footer hint. */
  getFooterHint?: (selectedResult: SearchResult | undefined) => React.ReactNode;

  /** Optional: dynamic footer info based on result count (e.g., "5 results") */
  footerInfo?: (resultCount: number) => string | undefined;

  /** Optional keyboard shortcut hint shown inside the search input (e.g., "Ctrl+K") */
  shortcutHint?: string;

  /**
   * Optional message shown when query is non-empty but below minQueryLength.
   * E.g., "Type at least 2 characters to search"
   */
  belowMinimumMessage?: string;

  /** Optional query-aware below-minimum hint for providers whose guidance depends on the current input. */
  getBelowMinimumMessage?: (query: string) => string | undefined;
}
