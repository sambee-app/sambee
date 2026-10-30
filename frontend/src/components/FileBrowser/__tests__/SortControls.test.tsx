import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { SortControls } from "../SortControls";

describe("SortControls", () => {
  afterEach(async () => {
    cleanup();
    await setLocale("en");
  });

  it("uses translated sort labels", async () => {
    await setLocale("en-XA");

    render(
      <SambeeThemeProvider>
        <SortControls sortBy="size" onSortChange={vi.fn()} sortDirection="desc" onDirectionChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    expect(screen.getByRole("button", { name: "[Šóŕť óṕťíóńš]" })).toBeInTheDocument();
    expect(screen.getByText("[Šížé]")).toBeInTheDocument();
  });

  it("describes the sort menu trigger", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <SortControls sortBy="name" onSortChange={vi.fn()} sortDirection="asc" onDirectionChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    await user.hover(screen.getByRole("button", { name: "Sort options" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Sort options");
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
    ["ArrowDown", "{ArrowDown}"],
  ])("opens and keeps the top-bar sort menu open when %s is pressed", async (_label, sequence) => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <SortControls sortBy="name" onSortChange={vi.fn()} sortDirection="asc" onDirectionChange={vi.fn()} />
      </SambeeThemeProvider>
    );

    const trigger = screen.getByRole("button", { name: "Sort options" });
    trigger.focus();

    await user.keyboard(sequence);

    await waitFor(() => {
      expect(screen.getByText("Ascending")).toBeInTheDocument();
    });

    expect(screen.getByText("Descending")).toBeInTheDocument();
  });
});
