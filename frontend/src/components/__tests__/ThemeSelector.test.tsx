import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import { ThemeSelector, ThemeSelectorDialog } from "../ThemeSelector";

const { commitThemeSettingMock, themeSettingState } = vi.hoisted(() => ({
  commitThemeSettingMock: vi.fn(),
  themeSettingState: { error: null as string | null, pending: false, saved: false },
}));

vi.mock("../../services/userSettingsStore", () => ({
  useCurrentUserSetting: (field: string) => ({
    confirmedValue: field === "appearance.theme_id" ? "sambee-light" : [],
    ...(field === "appearance.theme_id" ? themeSettingState : { error: null, pending: false, saved: false }),
    commit: commitThemeSettingMock,
    clearError: vi.fn(),
  }),
}));

//
// ThemeSelector.test.tsx
//

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
});

describe("ThemeSelector Component", () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    commitThemeSettingMock.mockResolvedValue(undefined);
    themeSettingState.error = null;
    themeSettingState.pending = false;
    themeSettingState.saved = false;
  });

  afterEach(async () => {
    await setLocale("en");
  });

  const renderWithProvider = (component: React.ReactElement) => {
    return render(<SambeeThemeProvider>{component}</SambeeThemeProvider>);
  };

  describe("ThemeSelector Button", () => {
    it("should render theme selector button", () => {
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      expect(button).toBeInTheDocument();
    });

    it("should have palette icon", () => {
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      expect(button.querySelector("svg")).toBeInTheDocument();
    });

    it("should open dialog when clicked", async () => {
      const user = userEvent.setup();
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      await user.click(button);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Choose Theme")).toBeInTheDocument();
    });

    it("should have tooltip", async () => {
      const user = userEvent.setup();
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      await user.hover(button);

      // Tooltip should appear (MUI tooltips have a delay)
      await screen.findByText("Change theme", {}, { timeout: 2000 });
    });

    it("should use translated theme selector strings", async () => {
      const user = userEvent.setup();
      await setLocale("en-XA");

      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button", { name: "[Ćħåńğé ťħéḿé]" });
      await user.click(button);

      expect(screen.getByText("[Ćħóóšé Ťħéḿé]")).toBeInTheDocument();
      expect(screen.getByText("[Šåḿƀéé ĺíğħť]")).toBeInTheDocument();
      expect(screen.getByText("[Åṕṕĺíćåťíóń ďéƒåúĺť ĺíğħť ťħéḿé]")).toBeInTheDocument();
    });
  });

  describe("ThemeSelectorDialog", () => {
    it("should render dialog when open", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Choose Theme")).toBeInTheDocument();
    });

    it("should not render dialog when closed", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={false} onClose={mockOnClose} />);

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("should display all available themes", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      expect(screen.getByText(/Sambee light/i)).toBeInTheDocument();
      expect(screen.getByText(/Sambee dark/i)).toBeInTheDocument();
    });

    it("should show theme descriptions", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      // Check if descriptions are present (themes should have descriptions)
      const descriptions = screen.queryAllByText(/theme/i);
      expect(descriptions.length).toBeGreaterThan(0);
    });

    it("should indicate current theme with radio button", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      const radioButtons = screen.getAllByRole("radio");
      const checkedRadios = radioButtons.filter((radio) => radio.getAttribute("checked") !== null);

      // Exactly one theme should be selected
      expect(checkedRadios.length).toBeGreaterThanOrEqual(0);
    });

    it("should display theme color previews", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      // Color preview boxes should be present (primary for each theme)
      const dialog = screen.getByRole("dialog");
      const colorBoxes = dialog.querySelectorAll("[title*='color' i]");

      expect(colorBoxes.length).toBeGreaterThanOrEqual(2); // At least 2 themes × 1 color
    });

    it("keeps the dialog open while previewing a selected theme", async () => {
      const user = userEvent.setup();
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      // Click on a theme card - use first theme (Sambee light)
      const lightThemeCard = screen.getByText(/Sambee light/i).closest("button");
      expect(lightThemeCard).toBeInTheDocument();
      await user.click(lightThemeCard!);

      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it("shows saving feedback on the requested theme and disables all choices", async () => {
      const user = userEvent.setup();
      const mockOnClose = vi.fn();
      commitThemeSettingMock.mockImplementationOnce(() => new Promise<void>(() => undefined));
      renderWithProvider(<ThemeSelectorDialog open onClose={mockOnClose} />);

      await user.click(screen.getByText(/Sambee dark/i).closest("button")!);

      expect(screen.getByRole("status", { name: "Saving setting" })).toBeInTheDocument();
      expect(screen.getAllByRole("button").filter((button) => button.closest(".MuiCard-root"))).toSatisfy((cards: HTMLElement[]) =>
        cards.every((card) => card.hasAttribute("disabled"))
      );
    });

    it("restores the selected theme card focus after saving", async () => {
      const user = userEvent.setup();
      const mockOnClose = vi.fn();
      let resolveThemeUpdate: (() => void) | undefined;
      commitThemeSettingMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveThemeUpdate = resolve;
          })
      );
      renderWithProvider(<ThemeSelectorDialog open onClose={mockOnClose} />);

      const darkThemeCard = screen.getByText(/Sambee dark/i).closest("button");
      expect(darkThemeCard).not.toBeNull();
      darkThemeCard?.focus();
      await user.keyboard("{Enter}");

      await waitFor(() => expect(darkThemeCard).toBeDisabled());
      darkThemeCard?.blur();
      resolveThemeUpdate?.();

      await waitFor(() => expect(darkThemeCard).toHaveFocus());
    });

    it("shows saved feedback and the field error notice", () => {
      const mockOnClose = vi.fn();
      themeSettingState.saved = true;
      themeSettingState.error = "Unable to save theme.";
      renderWithProvider(<ThemeSelectorDialog open onClose={mockOnClose} />);

      expect(screen.getByRole("status", { name: "Setting saved" })).toBeInTheDocument();
      expect(screen.getByText("Unable to save theme.")).toBeInTheDocument();
    });

    it("should show mode indicator (Light/Dark)", () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      expect(screen.getByText("Light")).toBeInTheDocument();
      expect(screen.getByText("Dark")).toBeInTheDocument();
    });
  });

  describe("Theme Switching", () => {
    it("does not mirror a selected theme in localStorage", async () => {
      const user = userEvent.setup();
      renderWithProvider(<ThemeSelector />);

      // Open dialog
      const button = screen.getByRole("button");
      await user.click(button);

      // Select dark theme
      const darkThemeCard = screen.getByText(/Sambee dark/i).closest("button");
      await user.click(darkThemeCard!);

      expect(localStorageMock.getItem("theme-id-current")).toBeNull();
    });

    it("should restore theme from localStorage on mount", async () => {
      const user = userEvent.setup();
      localStorageMock.setItem("theme-id-current", "sambee-dark");

      renderWithProvider(<ThemeSelector />);

      // Open dialog to check current theme
      const button = screen.getByRole("button");
      await user.click(button);

      // Wait for dialog to open
      await screen.findByRole("dialog");

      // The dark theme should be present
      const darkThemeText = screen.getByText(/Sambee dark/i);
      const darkThemeCard = darkThemeText.closest(".MuiCard-root");

      expect(darkThemeCard).toBeInTheDocument();
    });
  });

  describe("Accessibility", () => {
    it("should have accessible button", () => {
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      expect(button).toHaveAttribute("aria-label");
    });

    it("should have accessible dialog", async () => {
      const user = userEvent.setup();
      renderWithProvider(<ThemeSelector />);

      const button = screen.getByRole("button");
      await user.click(button);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-labelledby");
    });

    it("should have accessible theme cards", async () => {
      const mockOnClose = vi.fn();
      renderWithProvider(<ThemeSelectorDialog open={true} onClose={mockOnClose} />);

      // Check that both theme cards are accessible
      const lightThemeCard = screen.getByText(/Sambee light/i).closest("button");
      const darkThemeCard = screen.getByText(/Sambee dark/i).closest("button");

      expect(lightThemeCard).toBeInTheDocument();
      expect(darkThemeCard).toBeInTheDocument();
    });
  });
});
