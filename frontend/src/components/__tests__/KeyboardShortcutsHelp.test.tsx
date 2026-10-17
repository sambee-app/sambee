import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardShortcut } from "../../hooks/useKeyboardShortcuts";
import { setLocale } from "../../i18n";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { KeyboardShortcutsHelp } from "../KeyboardShortcutsHelp";

describe("KeyboardShortcutsHelp", () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await setLocale("en");
  });

  const createShortcuts = (): KeyboardShortcut[] => [
    {
      id: "save",
      keys: "s",
      description: "Save",
      label: "Ctrl+S",
      helpGroup: "editing",
      ctrl: true,
      handler: vi.fn(),
    },
    {
      id: "open",
      keys: "o",
      description: "Open",
      label: "Ctrl+O",
      helpGroup: "fileActions",
      ctrl: true,
      handler: vi.fn(),
    },
  ];

  describe("Display", () => {
    it("should render dialog when open", () => {
      const shortcuts = createShortcuts();
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
      expect(screen.getByTestId("keyboard-shortcuts-dialog-resize-handle")).toBeInTheDocument();
    });

    it("should not render dialog when closed", () => {
      const shortcuts = createShortcuts();
      render(<KeyboardShortcutsHelp open={false} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("should show custom title", () => {
      const shortcuts = createShortcuts();
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} title="PDF Viewer Shortcuts" />);

      expect(screen.getByText("PDF Viewer Shortcuts")).toBeInTheDocument();
    });

    it("focuses the shortcut search input when opened", async () => {
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={createShortcuts()} />);

      await waitFor(() => {
        expect(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" })).toHaveFocus();
      });
    });

    it("moves focus from search to the named shortcut results region", async () => {
      const user = userEvent.setup();
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={createShortcuts()} />);

      const searchInput = screen.getByRole("searchbox", { name: "Search keyboard shortcuts" });
      const resultsRegion = screen.getByRole("region", { name: "Keyboard shortcut results" });
      searchInput.focus();

      await user.tab();

      expect(resultsRegion).toHaveFocus();
      expect(resultsRegion).toHaveAttribute("tabindex", "0");
    });

    it("should display all shortcuts", () => {
      const shortcuts = createShortcuts();
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.getByText("File actions")).toBeInTheDocument();
      expect(screen.getByText("Editing")).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
      expect(screen.getByText("Open")).toBeInTheDocument();
      expect(screen.getByText("Ctrl+S")).toBeInTheDocument();
      expect(screen.getByText("Ctrl+O")).toBeInTheDocument();
    });

    it("should show message when no shortcuts", () => {
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={[]} />);

      expect(screen.getByText("No keyboard shortcuts available")).toBeInTheDocument();
    });

    it("should use translated default strings", async () => {
      await setLocale("en-XA");

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={[]} />);

      expect(screen.getByText("[Ķéýƀóåŕď Šħóŕťćúťš]")).toBeInTheDocument();
      expect(screen.getByText("[Ńó ķéýƀóåŕď šħóŕťćúťš åṽåíĺåƀĺé]")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "[Ćĺóšé ķéýƀóåŕď šħóŕťćúťš]" })).toBeInTheDocument();
    });

    it("should show shortcuts even when they are currently disabled", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "enabled",
          keys: "p",
          description: "Open quick navigation",
          label: "Ctrl+P",
          helpGroup: "search",
          ctrl: true,
          handler: vi.fn(),
          enabled: true,
        },
        {
          id: "disabled",
          keys: ",",
          description: "Open settings",
          label: "Ctrl+,",
          helpGroup: "general",
          ctrl: true,
          handler: vi.fn(),
          enabled: false,
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.getByText("Open quick navigation")).toBeInTheDocument();
      expect(screen.getByText("Open settings")).toBeInTheDocument();
      expect(screen.getByText("Ctrl+,")).toBeInTheDocument();
    });
  });

  describe("Grouping", () => {
    it("should group shortcuts with same description", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "next1",
          keys: "ArrowRight",
          description: "Next page",
          label: "Right",
          helpGroup: "navigation",
          handler: vi.fn(),
        },
        {
          id: "next2",
          keys: "PageDown",
          description: "Next page",
          label: "Page Down",
          helpGroup: "navigation",
          handler: vi.fn(),
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      // Should have one row with combined labels
      expect(screen.getByText("Right / Page Down")).toBeInTheDocument();
      // Description should appear only once
      const descriptions = screen.getAllByText("Next page");
      expect(descriptions).toHaveLength(1);
    });

    it("should preserve order from input", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "download",
          keys: "d",
          description: "Download",
          label: "D",
          helpGroup: "fileActions",
          handler: vi.fn(),
        },
        {
          id: "zoom-in",
          keys: "+",
          description: "Zoom in",
          label: "+",
          helpGroup: "view",
          handler: vi.fn(),
        },
        {
          id: "zoom-out",
          keys: "-",
          description: "Zoom out",
          label: "-",
          helpGroup: "view",
          handler: vi.fn(),
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      const cells = screen.getAllByRole("cell");
      const descriptions = cells.filter((cell) => ["Download", "Zoom in", "Zoom out"].includes(cell.textContent || ""));

      expect(descriptions[0]).toHaveTextContent("Download");
      expect(descriptions[1]).toHaveTextContent("Zoom in");
      expect(descriptions[2]).toHaveTextContent("Zoom out");
    });

    it("should order sections consistently across shortcut sets", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "zoom-in",
          keys: "+",
          description: "Zoom in",
          label: "+",
          helpGroup: "view",
          handler: vi.fn(),
        },
        {
          id: "search",
          keys: "f",
          description: "Search",
          label: "Ctrl+F",
          helpGroup: "search",
          ctrl: true,
          handler: vi.fn(),
        },
        {
          id: "download",
          keys: "d",
          description: "Download",
          label: "D",
          helpGroup: "fileActions",
          handler: vi.fn(),
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
      expect(headings).toEqual(["Search", "File actions", "View"]);
    });

    it("should fall back to the general section when a shortcut has no help group", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "close",
          keys: "Escape",
          description: "Close",
          label: "Esc",
          handler: vi.fn(),
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.getByText("General")).toBeInTheDocument();
      expect(screen.getByRole("cell", { name: "Close" })).toBeInTheDocument();
    });

    it("should handle shortcuts with no duplicates", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "save",
          keys: "s",
          description: "Save",
          label: "Ctrl+S",
          helpGroup: "editing",
          ctrl: true,
          handler: vi.fn(),
        },
        {
          id: "open",
          keys: "o",
          description: "Open",
          label: "Ctrl+O",
          helpGroup: "fileActions",
          ctrl: true,
          handler: vi.fn(),
        },
      ];

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      expect(screen.getByText("Ctrl+S")).toBeInTheDocument();
      expect(screen.getByText("Ctrl+O")).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
      expect(screen.getByText("Open")).toBeInTheDocument();
    });
  });

  describe("Interaction", () => {
    it("should call onClose when the header close button is clicked", async () => {
      const user = userEvent.setup();
      const shortcuts = createShortcuts();

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      const closeButton = screen.getByRole("button", { name: "Close keyboard shortcuts" });
      await user.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("filters shortcuts by shortcut, section, or action text", async () => {
      const user = userEvent.setup();
      const shortcuts = createShortcuts();

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      await user.type(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }), "ctrl+s");

      expect(screen.getByText("Save")).toBeInTheDocument();
      expect(screen.queryByText("Open")).not.toBeInTheDocument();

      await user.clear(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }));
      await user.type(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }), "file actions");

      expect(screen.getByText("Open")).toBeInTheDocument();
      expect(screen.queryByText("Save")).not.toBeInTheDocument();
    });

    it("shows a specific empty state when a search has no matching shortcuts", async () => {
      const user = userEvent.setup();
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={createShortcuts()} />);

      await user.type(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }), "nonexistent");

      expect(screen.getByText("No matching keyboard shortcuts")).toBeInTheDocument();
    });

    it("does not render an empty action row", () => {
      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={createShortcuts()} />);

      expect(screen.queryByTestId("responsive-form-dialog-desktop-actions")).not.toBeInTheDocument();
    });

    it("should call onClose when backdrop clicked", async () => {
      const user = userEvent.setup();
      const shortcuts = createShortcuts();

      const { container } = render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      // Find backdrop (the div behind the dialog)
      const backdrop = container.querySelector(".MuiBackdrop-root");
      if (backdrop) {
        await user.click(backdrop);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });

    it("should call onClose when Escape key pressed", async () => {
      const user = userEvent.setup();
      const shortcuts = createShortcuts();

      render(<KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />);

      await user.keyboard("{Escape}");

      expect(mockOnClose).toHaveBeenCalledOnce();
    });

    it.each([false, true])("leaves Escape to the dialog above Help (mobile: %s)", async (isMobile) => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: isMobile,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }))
      );
      const user = userEvent.setup();
      const topClose = vi.fn();
      const renderDialogs = (topOpen: boolean) => (
        <>
          <KeyboardShortcutsHelp open onClose={mockOnClose} shortcuts={createShortcuts()} />
          <ResponsiveDialogShell open={topOpen} onClose={topClose} title="Top dialog">
            <div tabIndex={-1}>Top content</div>
          </ResponsiveDialogShell>
        </>
      );
      const { rerender } = render(renderDialogs(false));
      await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search keyboard shortcuts" })).toHaveFocus());
      rerender(renderDialogs(true));
      act(() => screen.getByText("Top content").focus());
      await user.keyboard("{Escape}");
      expect(topClose).toHaveBeenCalledOnce();
      expect(mockOnClose).not.toHaveBeenCalled();
      rerender(renderDialogs(false));
      await waitFor(() => expect(screen.queryByText("Top content")).not.toBeInTheDocument());
      act(() => screen.getByRole("searchbox", { name: "Search keyboard shortcuts" }).focus());
      await user.keyboard("{Escape}");
      expect(mockOnClose).toHaveBeenCalledOnce();
      expect(topClose).toHaveBeenCalledOnce();
    });

    it("should stop Escape from bubbling to parent React handlers", async () => {
      const user = userEvent.setup();
      const shortcuts = createShortcuts();
      const parentKeyDown = vi.fn();

      render(
        <button type="button" onKeyDown={parentKeyDown}>
          <KeyboardShortcutsHelp open={true} onClose={mockOnClose} shortcuts={shortcuts} />
        </button>
      );

      await user.keyboard("{Escape}");

      expect(mockOnClose).toHaveBeenCalledTimes(1);
      expect(parentKeyDown).not.toHaveBeenCalled();
    });
  });
});
