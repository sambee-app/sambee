import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme";
import { MobileSettingsDrawer } from "../MobileSettingsDrawer";

vi.mock("../../Settings/settingsDataSources", () => ({
  prefetchSettingsDataForItems: vi.fn(),
}));

vi.mock("../../Settings/settingsPageLoaders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../Settings/settingsPageLoaders")>()),
  scheduleSettingsPagePrefetch: vi.fn(),
}));

const mockUseSettingsAccess = vi.fn(() => ({ isAdmin: false }));

vi.mock("../../Settings/useSettingsAccess", () => ({
  useSettingsAccess: () => mockUseSettingsAccess(),
}));

vi.mock("../../../pages/ConnectionSettings", () => ({
  ConnectionSettings: ({ sectionTitle }: { sectionTitle?: string }) => <div>SMB Content: {sectionTitle}</div>,
}));

vi.mock("../../../pages/LocalDrivesSettings", () => ({
  LocalDrivesSettings: ({ sectionTitle }: { sectionTitle?: string }) => <div>Local Drives Content: {sectionTitle}</div>,
}));

vi.mock("../../../pages/AccountSettings", () => ({
  AccountSettings: () => <div>Account Settings Content</div>,
}));

function renderDrawer() {
  return render(
    <SambeeThemeProvider>
      <MemoryRouter>
        <MobileSettingsDrawer open onClose={vi.fn()} initialView="main" />
      </MemoryRouter>
    </SambeeThemeProvider>
  );
}

describe("MobileSettingsDrawer", () => {
  beforeEach(() => {
    mockUseSettingsAccess.mockReturnValue({ isAdmin: false });
  });

  it("shows local drives as a top-level settings item and returns to the list from its page", async () => {
    const user = userEvent.setup();

    renderDrawer();

    expect(screen.getByText(/^File Browser$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Connections$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Local Drives$/i)).toBeInTheDocument();

    await user.click(screen.getByText(/^Local Drives$/i));

    expect(await screen.findByText("Local Drives Content: Local Drives")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /go back/i }));

    expect(screen.getByText(/^Connections$/i)).toBeInTheDocument();
    expect(screen.queryByText("Local Drives Content: Local Drives")).not.toBeInTheDocument();
    expect(screen.getByText(/^Appearance$/i)).toBeInTheDocument();
  });

  it("does not show category descriptions in the mobile settings list", () => {
    renderDrawer();

    expect(screen.queryByText(/manage smb shares and local-drive access in one place\./i)).not.toBeInTheDocument();
    expect(screen.queryByText(/customize the application theme and language behavior\./i)).not.toBeInTheDocument();
  });

  it("scopes compact typography to drawer settings content", () => {
    renderDrawer();

    expect(screen.getByTestId("settings-mobile-typography-scope")).toBeInTheDocument();
  });

  it("renders Account settings when Account is selected", async () => {
    const user = userEvent.setup();
    renderDrawer();

    await user.click(screen.getByText(/^Account$/i));

    expect(await screen.findByText("Account Settings Content")).toBeInTheDocument();
  });

  it("adds breathing room above the mobile section headers", () => {
    mockUseSettingsAccess.mockReturnValue({ isAdmin: true });

    renderDrawer();

    expect(screen.getByRole("list")).toHaveStyle({ paddingTop: "8px" });
    expect(screen.getByText(/^Administration$/i).parentElement).toHaveStyle({ marginTop: "16px" });
  });
});
