import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { CONNECTION_TYPE_LOCAL, LOCAL_DRIVE_PREFIX } from "../../../services/backendRouter";
import { createMockConnection } from "../../../test/fixtures/connections";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { ConnectionSelector } from "../ConnectionSelector";

describe("ConnectionSelector", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  const connections = [
    createMockConnection({
      id: "server-1",
      name: "Office Share",
      type: "smb",
      host: "fileserver",
      port: 445,
      share_name: "team",
      username: "alex",
      created_at: "2026-03-11T00:00:00Z",
      updated_at: "2026-03-11T00:00:00Z",
    }),
    createMockConnection({
      id: `${LOCAL_DRIVE_PREFIX}c`,
      name: "Local Disk (C:)",
      type: CONNECTION_TYPE_LOCAL,
      host: "localhost",
      port: 21549,
      share_name: "c",
      username: "",
      created_at: "2026-03-11T00:00:00Z",
      updated_at: "2026-03-11T00:00:00Z",
    }),
  ];

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
    ["ArrowDown", "{ArrowDown}"],
  ])("opens and keeps the top-bar connection menu open when %s is pressed", async (_label, sequence) => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <ConnectionSelector connections={connections} selectedConnectionId="server-1" onConnectionChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    const trigger = screen.getByRole("combobox", { name: "Select connection" });
    trigger.focus();

    await user.keyboard(sequence);

    await waitFor(() => {
      expect(screen.getByText("Local Disk (C:)")).toBeInTheDocument();
    });

    expect(screen.getByText("Office Share (fileserver/team)")).toBeInTheDocument();
  });

  it("uses translated fallback label when no connection is selected", async () => {
    await setLocale("en-XA");

    render(
      <SambeeThemeProvider>
        <ConnectionSelector connections={connections} selectedConnectionId="missing" onConnectionChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("combobox", { name: "[Šéĺéćť ćóńńéćťíóń]" })).toBeInTheDocument();
    expect(screen.getByText("[Šéĺéćť ćóńńéćťíóń]")).toBeInTheDocument();
  });

  it("keeps Local Drives settings reachable when Companion needs an update", async () => {
    const user = userEvent.setup();
    const openSettings = vi.fn();
    render(
      <SambeeThemeProvider>
        <ConnectionSelector
          connections={connections}
          selectedConnectionId="server-1"
          onConnectionChange={vi.fn()}
          companionStatus="update_required"
          onOpenConnectionsSettings={openSettings}
        />
      </SambeeThemeProvider>
    );

    await user.click(screen.getByRole("combobox", { name: "Select connection" }));
    await user.click(screen.getByText("Manage Local Drives..."));
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
