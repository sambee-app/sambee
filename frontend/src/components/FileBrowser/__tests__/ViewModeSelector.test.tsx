import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { ViewModeSelector } from "../ViewModeSelector";

describe("ViewModeSelector", () => {
  afterEach(async () => {
    cleanup();
    await setLocale("en");
  });

  it("uses translated view mode strings", async () => {
    await setLocale("en-XA");

    render(
      <SambeeThemeProvider>
        <ViewModeSelector viewMode="details" onViewModeChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: "[Ṽíéŵ ḿóďé óṕťíóńš]" })).toBeInTheDocument();
    expect(screen.getByText("[Ďéťåíĺš]")).toBeInTheDocument();
  });

  it("keeps the pill background while keyboard-focused", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <ViewModeSelector viewMode="list" onViewModeChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    const trigger = screen.getByRole("button", { name: "View mode options" });
    const backgroundBeforeFocus = window.getComputedStyle(trigger).backgroundColor;

    await user.tab();

    expect(trigger).toHaveClass("Mui-focusVisible");
    expect(window.getComputedStyle(trigger).backgroundColor).toBe(backgroundBeforeFocus);
  });

  it("describes the view-mode menu trigger", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <ViewModeSelector viewMode="list" onViewModeChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    await user.hover(screen.getByRole("button", { name: "View mode options" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("View mode options");
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
    ["ArrowDown", "{ArrowDown}"],
  ])("opens and keeps the top-bar menu open when %s is pressed", async (_label, sequence) => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <ViewModeSelector viewMode="list" onViewModeChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    const trigger = screen.getByRole("button", { name: "View mode options" });
    trigger.focus();

    await user.keyboard(sequence);

    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    expect(screen.getByText("Details")).toBeInTheDocument();
  });
});
