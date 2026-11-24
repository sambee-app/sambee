import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme";
import { SettingsCategoryList } from "../SettingsCategoryList";
import { getVisibleSettingsSections } from "../settingsNavigation";

function renderList(isAdmin = false) {
  const onSelect = vi.fn();

  render(
    <SambeeThemeProvider>
      <SettingsCategoryList
        sections={getVisibleSettingsSections(isAdmin)}
        onSelect={onSelect}
        selectedItem="appearance"
        listRole="listbox"
        itemRole="option"
      />
    </SambeeThemeProvider>
  );

  return { onSelect };
}

describe("SettingsCategoryList", () => {
  it("uses the shared category label and icon sizes", () => {
    renderList();

    const appearanceOption = screen.getByRole("option", { name: /^appearance$/i });
    const label = screen.getByText("Appearance", { exact: true });
    const icon = appearanceOption.querySelector("svg");

    if (!icon) {
      throw new Error("Appearance option is missing its category icon.");
    }

    expect(label).toHaveClass("MuiTypography-body1");
    expect([
      { label: "1rem", icon: "1.5rem" },
      { label: "16px", icon: "24px" },
      { label: "0.875rem", icon: "1.25rem" },
      { label: "14px", icon: "20px" },
    ]).toContainEqual({
      label: window.getComputedStyle(label).fontSize,
      icon: window.getComputedStyle(icon).fontSize,
    });
  });

  it("shows local drives as a top-level category without child UI", () => {
    renderList();

    expect(screen.getByRole("option", { name: /^connections$/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /text editor/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /local drives/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /expand|collapse/i })).not.toBeInTheDocument();
  });

  it("renders the dedicated SMB server icon for administrators", () => {
    renderList(true);

    const smbOption = screen.getByRole("option", { name: /^smb$/i });
    expect(smbOption.querySelector('[data-testid="DnsIcon"]')).toBeInTheDocument();
  });

  it("renders the Recent Files category icon for administrators", () => {
    renderList(true);

    const fileSearchOption = screen.getByRole("option", { name: /^recent files$/i });
    expect(fileSearchOption.querySelector('[data-testid="ManageSearchIcon"]')).toBeInTheDocument();
  });

  it("navigates when local drives is selected", async () => {
    const user = userEvent.setup();
    const { onSelect } = renderList();

    await user.click(screen.getByRole("option", { name: /local drives/i }));

    expect(onSelect).toHaveBeenCalledWith("local-drives");
  });
});
