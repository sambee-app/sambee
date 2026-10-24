import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createMockConnection } from "../../../test/fixtures/connections";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { SecondaryActionStrip } from "../SecondaryActionStrip";

describe("SecondaryActionStrip", () => {
  it("does not render when the user has no available connections", () => {
    const { container } = render(
      <SambeeThemeProvider>
        <SecondaryActionStrip
          connections={[]}
          selectedConnectionId=""
          onConnectionChange={vi.fn()}
          viewMode="list"
          onViewModeChange={vi.fn()}
          isDualPane={false}
          onToggleDualPane={vi.fn()}
          sortBy="name"
          onSortChange={vi.fn()}
          sortDirection="asc"
          onDirectionChange={vi.fn()}
          hasFiles={false}
        />
      </SambeeThemeProvider>
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("combobox", { name: "Select connection" })).not.toBeInTheDocument();
  });

  it("does not leak flex layout props onto DOM wrappers", () => {
    const { container } = render(
      <SambeeThemeProvider>
        <SecondaryActionStrip
          connections={[
            createMockConnection({
              id: "demo-conn",
              name: "Demo",
              type: "smb",
              host: "demo",
              port: 445,
              share_name: "share",
              username: "demo-user",
              created_at: "2026-03-11T00:00:00Z",
              updated_at: "2026-03-11T00:00:00Z",
            }),
          ]}
          selectedConnectionId="demo-conn"
          onConnectionChange={vi.fn()}
          viewMode="list"
          onViewModeChange={vi.fn()}
          isDualPane={false}
          onToggleDualPane={vi.fn()}
          sortBy="name"
          onSortChange={vi.fn()}
          sortDirection="asc"
          onDirectionChange={vi.fn()}
          hasFiles={true}
        />
      </SambeeThemeProvider>
    );

    const stripRoot = container.firstElementChild;
    const connectionTriggerContent = screen.getByRole("combobox", { name: "Select connection" }).firstElementChild;
    const dualPaneToggle = screen.getByRole("button", { name: "Toggle dual-pane view" });
    const viewModeTriggerContent = screen.getByRole("button", { name: "View mode options" }).firstElementChild;
    const sortTriggerContent = screen.getByRole("button", { name: "Sort options" }).firstElementChild;

    for (const element of [stripRoot, connectionTriggerContent, viewModeTriggerContent, sortTriggerContent]) {
      expect(element).not.toHaveAttribute("display");
      expect(element).not.toHaveAttribute("alignitems");
      expect(element).not.toHaveAttribute("justifycontent");
    }

    expect(
      dualPaneToggle.compareDocumentPosition(viewModeTriggerContent?.parentElement as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps the dual-pane toggle available for empty directories", async () => {
    const user = userEvent.setup();
    const onToggleDualPane = vi.fn();

    render(
      <SambeeThemeProvider>
        <SecondaryActionStrip
          connections={[
            createMockConnection({
              id: "demo-conn",
              name: "Demo",
              type: "smb",
              host: "demo",
              port: 445,
              share_name: "share",
              username: "demo-user",
              created_at: "2026-03-11T00:00:00Z",
              updated_at: "2026-03-11T00:00:00Z",
            }),
          ]}
          selectedConnectionId="demo-conn"
          onConnectionChange={vi.fn()}
          viewMode="list"
          onViewModeChange={vi.fn()}
          isDualPane={false}
          onToggleDualPane={onToggleDualPane}
          sortBy="name"
          onSortChange={vi.fn()}
          sortDirection="asc"
          onDirectionChange={vi.fn()}
          hasFiles={false}
        />
      </SambeeThemeProvider>
    );

    const dualPaneToggle = screen.getByRole("button", { name: "Toggle dual-pane view" });
    const viewModeToggle = screen.queryByRole("button", { name: "View mode options" });

    expect(dualPaneToggle).toHaveAttribute("aria-pressed", "false");
    expect(viewModeToggle).not.toBeInTheDocument();

    await user.click(dualPaneToggle);

    expect(onToggleDualPane).toHaveBeenCalledOnce();
  });

  it("describes the connection selector and its keyboard shortcut", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <SecondaryActionStrip
          connections={[
            createMockConnection({
              id: "demo-conn",
              name: "Demo",
              type: "smb",
              host: "demo",
              port: 445,
              share_name: "share",
              username: "demo-user",
              created_at: "2026-03-11T00:00:00Z",
              updated_at: "2026-03-11T00:00:00Z",
            }),
          ]}
          selectedConnectionId="demo-conn"
          onConnectionChange={vi.fn()}
          viewMode="list"
          onViewModeChange={vi.fn()}
          isDualPane={false}
          onToggleDualPane={vi.fn()}
          sortBy="name"
          onSortChange={vi.fn()}
          sortDirection="asc"
          onDirectionChange={vi.fn()}
          hasFiles={false}
        />
      </SambeeThemeProvider>
    );

    await user.hover(screen.getByRole("combobox", { name: "Select connection" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Open connection selector (Ctrl+Down)");
  });
});
