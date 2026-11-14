import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { DesktopToolbarActions } from "../DesktopToolbarActions";

function renderWithProvider(component: React.ReactElement) {
  return render(<SambeeThemeProvider>{component}</SambeeThemeProvider>);
}

describe("DesktopToolbarActions", () => {
  it("shows help and settings tooltips", async () => {
    const user = userEvent.setup();

    renderWithProvider(<DesktopToolbarActions onOpenHelp={vi.fn()} onOpenDocumentation={vi.fn()} onOpenSettings={vi.fn()} />);

    await user.hover(screen.getByLabelText("Help"));
    expect(await screen.findByText("Help")).toBeInTheDocument();

    await user.unhover(screen.getByLabelText("Help"));
    await user.hover(screen.getByLabelText("Open settings"));
    expect(await screen.findByText("Open settings (Ctrl+,)")).toBeInTheDocument();
  });

  it("opens the help menu and runs its actions and external links", () => {
    const onOpenHelp = vi.fn();
    const onOpenDocumentation = vi.fn();
    const openExternalUrl = vi.spyOn(window, "open").mockImplementation(() => null);

    renderWithProvider(
      <DesktopToolbarActions onOpenHelp={onOpenHelp} onOpenDocumentation={onOpenDocumentation} onOpenSettings={vi.fn()} />
    );

    fireEvent.click(screen.getByLabelText("Help"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    expect(onOpenHelp).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Help"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Documentation" }));
    expect(onOpenDocumentation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Help"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Issues" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/sambee-app/sambee/issues", "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByLabelText("Help"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Discussions" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/sambee-app/sambee/discussions", "_blank", "noopener,noreferrer");
  });

  it("renders distinct status shapes immediately to the right of Settings and hides when disabled", () => {
    const onOpenHealth = vi.fn();
    const { rerender } = renderWithProvider(
      <DesktopToolbarActions
        onOpenHelp={vi.fn()}
        onOpenDocumentation={vi.fn()}
        onOpenSettings={vi.fn()}
        systemHealth={{
          visible: true,
          severity: "warning",
          headline: "One storage volume has low free space.",
          onOpen: onOpenHealth,
        }}
      />
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Help",
      "Open settings",
      "System health: Warning. One storage volume has low free space.",
    ]);
    expect(buttons[2]?.querySelector('[data-health-shape="triangle"]')).toBeTruthy();
    expect(buttons[2]?.querySelector('[data-health-symbol="monitor-pulse"]')).toBeTruthy();

    fireEvent.click(buttons[2]!);
    expect(onOpenHealth).toHaveBeenCalledTimes(1);

    rerender(
      <SambeeThemeProvider>
        <DesktopToolbarActions
          onOpenHelp={vi.fn()}
          onOpenDocumentation={vi.fn()}
          onOpenSettings={vi.fn()}
          systemHealth={{
            visible: true,
            severity: "error",
            headline: "CPU temperature is at or above the critical threshold.",
            onOpen: onOpenHealth,
          }}
        />
      </SambeeThemeProvider>
    );
    expect(screen.getByLabelText(/System health: Error\./).querySelector('[data-health-shape="octagon"]')).toBeTruthy();

    rerender(
      <SambeeThemeProvider>
        <DesktopToolbarActions
          onOpenHelp={vi.fn()}
          onOpenDocumentation={vi.fn()}
          onOpenSettings={vi.fn()}
          systemHealth={{ visible: false, severity: "unknown", headline: "", onOpen: onOpenHealth }}
        />
      </SambeeThemeProvider>
    );
    expect(screen.queryByLabelText(/System health:/)).not.toBeInTheDocument();
  });
});
