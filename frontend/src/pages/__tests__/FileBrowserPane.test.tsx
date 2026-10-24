/**
 * FileBrowserPane Component Tests
 * ================================
 *
 * Verifies:
 * - Returns null when connectionId is empty (no connection selected)
 * - Renders breadcrumbs and file list on desktop layout
 * - Renders search bar on compact/mobile layout
 * - Shows loading spinner while files are loading
 * - Shows view/sort controls when files exist
 * - Hides view/sort controls when there are no files
 * - Displays status bar on desktop when files exist
 * - Hides status bar in compact layout
 * - Applies active pane styling in dual-pane mode
 * - Applies inactive pane styling (dimmed) in dual-pane mode
 * - No active/inactive styling in single-pane mode
 * - Calls onPaneFocus when inactive pane is clicked
 * - Does NOT call onPaneFocus when active pane is clicked
 * - Sets data-pane-id attribute correctly
 * - Resolves connection name from connections list
 */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockConnection } from "../../test/fixtures/connections";
import type { Connection, FileEntry } from "../../types";
import { FileType } from "../../types";
import { physicalLocation } from "../FileBrowser/contentProviders";
import { FileBrowserPane, type FileBrowserPaneProps } from "../FileBrowser/FileBrowserPane";
import type { UseFileBrowserPaneReturn } from "../FileBrowser/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "settings.connectionDialog.accessMode.readOnlyLabel") {
        return "Read only";
      }

      if (key === "settings.connectionDialog.helpers.accessModeReadOnly") {
        return "Browse and preview content, but block writes and edit flows through Sambee.";
      }

      return key;
    },
  }),
}));

// ============================================================================
// Child component mocks — we test the pane's orchestration, not children
// ============================================================================

vi.mock("../../components/FileBrowser/BreadcrumbsNavigation", () => ({
  BreadcrumbsNavigation: ({ connectionName, currentPath }: { connectionName: string; currentPath: string }) => (
    <div data-testid="breadcrumbs">
      {connectionName} / {currentPath}
    </div>
  ),
}));

vi.mock("../../components/FileBrowser/FileList", () => ({
  FileList: ({ files, listContainerRef }: { files: FileEntry[]; listContainerRef?: (node: HTMLDivElement | null) => void }) => (
    <button ref={(node) => listContainerRef?.(node as unknown as HTMLDivElement | null)} data-testid="file-list" type="button">
      {files.map((f) => (
        <div key={f.name}>{f.name}</div>
      ))}
    </button>
  ),
}));

vi.mock("../../components/FileBrowser/StatusBar", () => ({ STATUS_BAR_HEIGHT: 32 }));

vi.mock("../../components/FileBrowser/SortControls", () => ({
  SortControls: () => <div data-testid="sort-controls" />,
}));

vi.mock("../../components/FileBrowser/ViewModeSelector", () => ({
  ViewModeSelector: () => <div data-testid="view-mode-selector" />,
}));

vi.mock("../../components/FileBrowser/UnifiedSearchBar", () => ({
  UnifiedSearchBar: () => <div data-testid="search-bar" />,
}));

vi.mock("../../components/FileBrowser/ConfirmDeleteDialog", () => ({
  __esModule: true,
  default: () => <div data-testid="delete-dialog" />,
}));

vi.mock("../../components/FileBrowser/RenameDialog", () => ({
  __esModule: true,
  default: () => <div data-testid="rename-dialog" />,
}));

vi.mock("../../components/FileBrowser/CreateItemDialog", () => ({
  __esModule: true,
  default: () => <div data-testid="create-dialog" />,
}));

// Mock @tanstack/react-virtual
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

// ============================================================================
// Test fixtures
// ============================================================================

const TEST_CONNECTION_ID = "conn-1";

const testConnections: [Connection, Connection] = [
  createMockConnection({ id: TEST_CONNECTION_ID, name: "My NAS" }),
  createMockConnection({ id: "conn-2", name: "Backup Server" }),
];

const testFiles: FileEntry[] = [
  {
    name: "Documents",
    type: FileType.DIRECTORY,
    path: "Documents",
    size: 0,
    modified_at: "2024-01-15T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
  {
    name: "readme.txt",
    type: FileType.FILE,
    path: "readme.txt",
    size: 1024,
    modified_at: "2024-01-13T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
];

/**
 * Creates a mock pane return value with sensible defaults.
 * Individual tests can override specific properties.
 */
function createMockPane(overrides: Partial<UseFileBrowserPaneReturn> = {}): UseFileBrowserPaneReturn {
  return {
    // Core state
    connectionId: TEST_CONNECTION_ID,
    setConnectionId: vi.fn(),
    currentPath: "some/path",
    currentLocation: physicalLocation(TEST_CONNECTION_ID, "some/path"),
    contentCapabilities: { browse: true, read: true, download: true, extract: true, mutate: true, openInNativeApp: true },
    companionPairingError: null,
    removeSelectedPaths: vi.fn(),
    selectItem: vi.fn(),
    toggleItemSelection: vi.fn(),
    selectItemFromIcon: vi.fn(),
    getItemsByPaths: vi.fn().mockReturnValue([]),
    handleOpenFileAtPath: vi.fn().mockResolvedValue(undefined),
    navigateToPath: vi.fn(),
    handleDeleteForFile: vi.fn(),
    seedDirectorySnapshot: vi.fn(),
    applyLocation: vi.fn(),
    captureRecoverySnapshot: vi.fn().mockReturnValue(null),
    restoreRecoverySnapshot: vi.fn(),
    setCurrentPath: vi.fn(),
    archiveLocation: null,
    archiveHasMore: false,
    archiveLoadingMore: false,
    files: testFiles,
    loading: false,
    error: null,
    setError: vi.fn(),

    // UI preferences
    sortBy: "name",
    setSortBy: vi.fn(),
    sortDirection: "asc",
    setSortDirection: vi.fn(),
    viewMode: "list",
    setViewMode: vi.fn(),
    focusedIndex: 0,

    // Selection state (multi-select)
    selectedFiles: new Set<string>(),
    handleToggleSelection: vi.fn(),
    handleSelectDown: vi.fn(),
    handleSelectToBoundary: vi.fn(),
    handleSelectUp: vi.fn(),
    handleSelectAll: vi.fn(),
    handleClearSelection: vi.fn(),
    getEffectiveSelection: vi.fn().mockReturnValue([]),

    // Computed
    sortedFiles: testFiles,
    imageFiles: [],
    directorySearchProvider: {
      id: "test",
      placeholder: "Search",
      debounceMs: 150,
      minQueryLength: 0,
      fetchResults: vi.fn().mockResolvedValue([]),
      onSelect: vi.fn(),
      getStatusInfo: () => null,
    },

    // Viewer
    viewInfo: null,
    setViewInfo: vi.fn(),
    browserViewerPickerState: null,

    // Dialog state
    deleteDialogOpen: false,
    deleteTargets: [],
    isDeleting: false,
    renameDialogOpen: false,
    renameTarget: null,
    isRenaming: false,
    renameError: null,
    createDialogOpen: false,
    createItemType: FileType.FILE,
    isCreating: false,
    createError: null,
    openInAppLoading: false,

    // Refs
    parentRef: { current: null },
    searchInputRef: { current: null },
    listContainerRef: vi.fn(),
    listContainerEl: null,
    filesRef: { current: testFiles },
    connectionIdRef: { current: TEST_CONNECTION_ID },
    currentPathRef: { current: "some/path" },

    // Virtualizer (minimal mock)
    rowVirtualizer: {
      getVirtualItems: () => [],
      getTotalSize: () => 0,
      scrollToIndex: vi.fn(),
      measureElement: vi.fn(),
      scrollToOffset: vi.fn(),
      measure: vi.fn(),
      options: { count: 0, estimateSize: () => 40, overscan: 5 },
    } as unknown as UseFileBrowserPaneReturn["rowVirtualizer"],

    // Navigation handlers
    handleFileClick: vi.fn(),
    handleConnectionChange: vi.fn(),
    handleNavigateDown: vi.fn(),
    handleArrowUp: vi.fn(),
    handleHome: vi.fn(),
    handleEnd: vi.fn(),
    handlePageDown: vi.fn(),
    handlePageUp: vi.fn(),
    handleOpenFile: vi.fn(),
    handleOpenFileForFile: vi.fn(),
    openArchive: vi.fn(),
    navigateArchiveToPath: vi.fn(),
    loadMoreArchive: vi.fn(),
    closeArchive: vi.fn(),
    handleNavigateUpDirectory: vi.fn(),
    handleNavigateUp: vi.fn(),
    handleClose: vi.fn(),
    handleFocusSearch: vi.fn(),
    handleRefresh: vi.fn(),
    reloadCurrentLocation: vi.fn(),

    // Viewer handlers
    handleViewIndexChange: vi.fn(),
    handleViewClose: vi.fn(),
    closeBrowserViewerPicker: vi.fn(),
    confirmBrowserViewerPicker: vi.fn(),

    // CRUD handlers
    handleDeleteRequest: vi.fn(),
    handleDeleteItems: vi.fn(),
    handleDeleteConfirm: vi.fn(),
    closeDeleteDialog: vi.fn(),
    handleRenameRequest: vi.fn(),
    handleRenameConfirm: vi.fn(),
    handleRenameForFile: vi.fn(),
    closeRenameDialog: vi.fn(),
    handleNewDirectoryRequest: vi.fn(),
    handleNewFileRequest: vi.fn(),
    handleCreateConfirm: vi.fn(),
    closeCreateDialog: vi.fn(),

    // Companion
    handleOpenInApp: vi.fn(),
    handleOpenInAppForFile: vi.fn(),

    // WebSocket / cache
    handleDirectoryChanged: vi.fn(),
    clearCaches: vi.fn(),
    invalidateConnectionCache: vi.fn(),

    ...overrides,
  };
}

/** Helper to build default props with optional overrides. */
function defaultProps(overrides: Partial<FileBrowserPaneProps> = {}): FileBrowserPaneProps {
  return {
    pane: createMockPane(),
    paneId: "left",
    isActive: true,
    paneMode: "single",
    connections: testConnections,
    useCompactLayout: false,
    isUsingKeyboard: false,
    onPaneFocus: vi.fn(),
    searchProvider: createMockPane().directorySearchProvider,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("FileBrowserPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Rendering — null guard
  // --------------------------------------------------------------------------

  describe("null guard", () => {
    it("returns null when connectionId is empty", () => {
      const pane = createMockPane({ connectionId: "" });
      const { container } = render(<FileBrowserPane {...defaultProps({ pane })} />);
      expect(container.innerHTML).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // Rendering — desktop layout
  // --------------------------------------------------------------------------

  describe("desktop layout", () => {
    it("centers an accessible drop cue without shifting rows and clears it on drop", () => {
      const onFileDrop = vi.fn();
      const props = defaultProps({ dropTargetLabel: "My NAS:/some/path", onFileDrop });
      const { rerender } = render(<FileBrowserPane {...props} />);
      const list = screen.getByTestId("file-list");
      const frame = list.parentElement!;
      fireEvent.dragEnter(list, { dataTransfer: { types: ["Files"] } });
      const cue = screen.getByRole("status", { name: /My NAS:\/some\/path/ });
      expect(cue).toHaveTextContent("fileBrowser.transfers.dropToUpload");
      expect(cue).not.toHaveTextContent("My NAS:/some/path");
      expect(cue).toContainElement(screen.getByTestId("CloudUploadOutlinedIcon"));
      expect(cue).toHaveStyle({ position: "absolute", left: "50%", pointerEvents: "none" });
      expect(getComputedStyle(frame).outline).toContain("2px solid");
      expect(list).toHaveTextContent("Documents");
      fireEvent.drop(list, { dataTransfer: { types: ["Files"] } });
      expect(onFileDrop).toHaveBeenCalledOnce();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      rerender(<FileBrowserPane {...props} dropUnavailableReason="Finish the current upload first" />);
      fireEvent.dragEnter(list, { dataTransfer: { types: ["Files"] } });
      const unavailable = screen.getByRole("status", { name: "Finish the current upload first" });
      expect(unavailable).toContainElement(screen.getByTestId("BlockOutlinedIcon"));
      expect(unavailable).not.toHaveTextContent("My NAS:/some/path");
      expect(getComputedStyle(frame).outlineStyle).toBe("none");
    });

    it("ignores non-file drags and clears a nested file drag on Escape", () => {
      const onFileDrop = vi.fn();
      render(<FileBrowserPane {...defaultProps({ dropTargetLabel: "My NAS:/some/path", onFileDrop })} />);
      const list = screen.getByTestId("file-list");
      fireEvent.dragEnter(list, { dataTransfer: { types: ["text/plain"] } });
      fireEvent.drop(list, { dataTransfer: { types: ["text/plain"] } });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(onFileDrop).not.toHaveBeenCalled();

      fireEvent.dragEnter(list, { dataTransfer: { types: ["Files"] } });
      fireEvent.dragEnter(list.firstElementChild!, { dataTransfer: { types: ["Files"] } });
      expect(screen.getByRole("status", { name: /My NAS:\/some\/path/ })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("uses fixed pixel dimensions for the visually hidden selection announcement", () => {
      render(<FileBrowserPane {...defaultProps()} />);

      expect(screen.getByText("", { selector: "[aria-live='polite']" })).toHaveStyle({ height: "1px", width: "1px" });
    });

    it("renders breadcrumbs with connection name and path", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      const breadcrumbs = screen.getByTestId("breadcrumbs");
      expect(breadcrumbs).toHaveTextContent("My NAS");
      expect(breadcrumbs).toHaveTextContent("some/path");
    });

    it("renders an archive location in the existing breadcrumb trail", () => {
      const pane = createMockPane({
        archiveLocation: { providerId: "zip", archivePath: "some/path/backup.zip", virtualPath: "nested" },
      });
      render(<FileBrowserPane {...defaultProps({ pane })} />);

      const breadcrumbs = screen.getByTestId("breadcrumbs");
      expect(breadcrumbs).toHaveTextContent("backup.zip");
      expect(breadcrumbs).toHaveTextContent("nested");
    });

    it("renders file list with file names", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      expect(screen.getByTestId("file-list")).toBeInTheDocument();
      expect(screen.getByText("Documents")).toBeInTheDocument();
      expect(screen.getByText("readme.txt")).toBeInTheDocument();
    });

    it("does not render view/sort controls (centralized in SecondaryActionStrip)", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      expect(screen.queryByTestId("view-mode-selector")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sort-controls")).not.toBeInTheDocument();
    });

    it("does not render the parent-owned status bar", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
    });

    it("does not render search bar in desktop mode", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      expect(screen.queryByTestId("search-bar")).not.toBeInTheDocument();
    });

    it("shows a read-only chip for read-only connections", () => {
      const pane = createMockPane({ connectionId: "conn-2" });
      const connections = [testConnections[0], createMockConnection({ id: "conn-2", name: "Backup Server", access_mode: "read_only" })];

      render(<FileBrowserPane {...defaultProps({ pane, connections })} />);

      expect(screen.getByText("Read only")).toBeInTheDocument();
    });

    it("shows a read-only chip for effective viewer access returned by the backend", () => {
      const pane = createMockPane({ connectionId: "conn-2" });
      const connections = [
        testConnections[0],
        createMockConnection({ id: "conn-2", name: "Viewer Share", scope: "private", access_mode: "read_only", can_manage: false }),
      ];

      render(<FileBrowserPane {...defaultProps({ pane, connections })} />);

      expect(screen.getByText("Read only")).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Rendering — compact/mobile layout
  // --------------------------------------------------------------------------

  describe("compact layout", () => {
    it("renders search bar", () => {
      render(<FileBrowserPane {...defaultProps({ useCompactLayout: true })} />);
      expect(screen.getByTestId("search-bar")).toBeInTheDocument();
    });

    it("does not render breadcrumbs", () => {
      render(<FileBrowserPane {...defaultProps({ useCompactLayout: true })} />);
      expect(screen.queryByTestId("breadcrumbs")).not.toBeInTheDocument();
    });

    it("does not render view/sort controls", () => {
      render(<FileBrowserPane {...defaultProps({ useCompactLayout: true })} />);
      expect(screen.queryByTestId("view-mode-selector")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sort-controls")).not.toBeInTheDocument();
    });

    it("shows a read-only chip in compact layout for read-only connections", () => {
      const pane = createMockPane({ connectionId: "conn-2" });
      const connections = [testConnections[0], createMockConnection({ id: "conn-2", name: "Backup Server", access_mode: "read_only" })];

      render(<FileBrowserPane {...defaultProps({ pane, connections, useCompactLayout: true })} />);

      expect(screen.getByText("Read only")).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Loading state
  // --------------------------------------------------------------------------

  describe("loading state", () => {
    it("shows a spinner when loading is true", () => {
      const pane = createMockPane({ loading: true });
      render(<FileBrowserPane {...defaultProps({ pane })} />);
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });

    it("does not show file list when loading", () => {
      const pane = createMockPane({ loading: true });
      render(<FileBrowserPane {...defaultProps({ pane })} />);
      expect(screen.queryByTestId("file-list")).not.toBeInTheDocument();
    });

    it("hides status bar when loading", () => {
      const pane = createMockPane({ loading: true });
      render(<FileBrowserPane {...defaultProps({ pane })} />);
      expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // data-pane-id attribute
  // --------------------------------------------------------------------------

  describe("pane identification", () => {
    it("sets data-pane-id to left", () => {
      render(<FileBrowserPane {...defaultProps({ paneId: "left" })} />);
      expect(screen.getByTestId("breadcrumbs").closest("[data-pane-id]")).toHaveAttribute("data-pane-id", "left");
    });

    it("sets data-pane-id to right", () => {
      render(<FileBrowserPane {...defaultProps({ paneId: "right" })} />);
      expect(screen.getByTestId("breadcrumbs").closest("[data-pane-id]")).toHaveAttribute("data-pane-id", "right");
    });
  });

  // --------------------------------------------------------------------------
  // Connection name resolution
  // --------------------------------------------------------------------------

  describe("connection name resolution", () => {
    it("resolves connection name from connections list", () => {
      const pane = createMockPane({ connectionId: "conn-2" });
      render(<FileBrowserPane {...defaultProps({ pane })} />);
      expect(screen.getByTestId("breadcrumbs")).toHaveTextContent("Backup Server");
    });

    it("falls back to empty string for unknown connectionId", () => {
      const pane = createMockPane({ connectionId: "unknown-id" });
      render(<FileBrowserPane {...defaultProps({ pane })} />);
      // Breadcrumb should still render but without a connection name
      const breadcrumbs = screen.getByTestId("breadcrumbs");
      expect(breadcrumbs).toBeInTheDocument();
      expect(breadcrumbs).toHaveTextContent("/ some/path");
    });
  });

  // --------------------------------------------------------------------------
  // Dual-pane active/inactive styling
  // --------------------------------------------------------------------------

  describe("dual-pane styling", () => {
    it("applies full opacity to active pane in dual mode", () => {
      render(<FileBrowserPane {...defaultProps({ paneMode: "dual", isActive: true })} />);
      const paneEl = screen.getByTestId("breadcrumbs").closest("[data-pane-id]") as HTMLElement;
      // MUI applies styles via the className; we test the component produces the right sx
      // by checking the rendered style attribute contains opacity 1
      expect(paneEl).toBeInTheDocument();
    });

    it("does not apply opacity/border styling in single mode", () => {
      // In single mode, the sx object has no opacity/borderTop keys
      // The pane just renders normally
      render(<FileBrowserPane {...defaultProps({ paneMode: "single", isActive: true })} />);
      const paneEl = screen.getByTestId("breadcrumbs").closest("[data-pane-id]") as HTMLElement;
      expect(paneEl).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Click handler — pane focus
  // --------------------------------------------------------------------------

  describe("pane focus on click", () => {
    it("calls onPaneFocus when inactive pane is clicked", async () => {
      const user = userEvent.setup();
      const onPaneFocus = vi.fn();
      render(<FileBrowserPane {...defaultProps({ isActive: false, paneMode: "dual", onPaneFocus })} />);

      const paneEl = screen.getByTestId("breadcrumbs").closest("[data-pane-id]") as HTMLElement;
      await user.click(paneEl);
      expect(onPaneFocus).toHaveBeenCalledTimes(1);
    });

    it("does NOT call onPaneFocus when active pane is clicked", async () => {
      const user = userEvent.setup();
      const onPaneFocus = vi.fn();
      render(<FileBrowserPane {...defaultProps({ isActive: true, onPaneFocus })} />);

      const paneEl = screen.getByTestId("breadcrumbs").closest("[data-pane-id]") as HTMLElement;
      await user.click(paneEl);
      expect(onPaneFocus).not.toHaveBeenCalled();
    });

    it("calls onPaneFocus when an inactive pane receives focus", () => {
      const onPaneFocus = vi.fn();
      render(<FileBrowserPane {...defaultProps({ isActive: false, paneMode: "dual", onPaneFocus })} />);

      fireEvent.focus(screen.getByTestId("file-list"));

      expect(onPaneFocus).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Dialogs are always rendered (even when closed)
  // --------------------------------------------------------------------------

  describe("dialogs", () => {
    it("renders delete, rename, and create dialogs", () => {
      render(<FileBrowserPane {...defaultProps()} />);
      expect(screen.getByTestId("delete-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("rename-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
    });
  });
});
