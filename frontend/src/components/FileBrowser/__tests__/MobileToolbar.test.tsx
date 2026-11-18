import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { renderWithStyles as render } from "../../../test/utils/renderWithStyles";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { MobileToolbar } from "../MobileToolbar";
import type { SearchProvider } from "../search/types";

const mockSearchProvider: SearchProvider = {
  id: "navigate",
  sourceKey: "demo",
  placeholder: "Navigate to any directory",
  minQueryLength: 0,
  debounceMs: 150,
  fetchResults: async () => [],
  onSelect: () => undefined,
  getStatusInfo: () => null,
};

async function renderWithProvider(component: React.ReactElement) {
  await act(async () => {
    render(<SambeeThemeProvider>{component}</SambeeThemeProvider>);
  });
}

describe("MobileToolbar", () => {
  afterEach(async () => {
    await act(async () => {
      await setLocale("en");
    });
  });

  it("renders the Quick Bar between symmetric edge-aligned menu and navigate-up buttons without a folder title", async () => {
    await setLocale("en");

    await renderWithProvider(
      <MobileToolbar
        searchProvider={mockSearchProvider}
        showSearch={true}
        onOpenMenu={vi.fn()}
        onNavigateUp={vi.fn()}
        canNavigateUp={true}
        statusAction={<button type="button">Status warning</button>}
      />
    );

    const openMenuButton = screen.getByRole("button", { name: "Open menu" });
    const quickBarInput = screen.getByPlaceholderText("Navigate to any directory");
    const statusButton = screen.getByRole("button", { name: "Status warning" });
    const navigateUpButton = screen.getByRole("button", { name: "Navigate to parent directory" });

    // Order: Open menu -> Quick Bar -> Status warning -> Navigate up
    expect(openMenuButton.compareDocumentPosition(quickBarInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quickBarInput.compareDocumentPosition(statusButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(statusButton.compareDocumentPosition(navigateUpButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Optical edge margins: -12px on Open menu (24px full-bleed SVG) and -16px on Navigate up (compensating for 4px internal SVG inset)
    expect(openMenuButton).toHaveStyle({ marginLeft: "-12px" });
    expect(navigateUpButton).toHaveStyle({ marginRight: "-16px" });
  });

  it("hides the Quick Bar when showSearch is false while preserving outer controls and translated labels", async () => {
    await setLocale("en-XA");

    await renderWithProvider(
      <MobileToolbar
        searchProvider={mockSearchProvider}
        showSearch={false}
        onOpenMenu={vi.fn()}
        onNavigateUp={vi.fn()}
        canNavigateUp={true}
      />
    );

    expect(screen.getByRole("button", { name: "[Óṕéń ḿéńú]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[Ńåṽíğåťé ťó ṕåŕéńť ďíŕéćťóŕý]" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Navigate to any directory")).not.toBeInTheDocument();
  });
});
