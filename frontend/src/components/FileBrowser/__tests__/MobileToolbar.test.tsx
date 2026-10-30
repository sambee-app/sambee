import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { MobileToolbar } from "../MobileToolbar";

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

  it("uses the compact toolbar title size", async () => {
    await setLocale("en");

    await renderWithProvider(
      <MobileToolbar currentDirectoryName="Documents" onOpenMenu={vi.fn()} onNavigateUp={vi.fn()} canNavigateUp={true} />
    );

    expect(screen.getByText("Documents")).toHaveStyle({ fontSize: "18px" });
  });

  it("uses translated mobile toolbar labels", async () => {
    await setLocale("en-XA");

    await renderWithProvider(
      <MobileToolbar currentDirectoryName="Documents" onOpenMenu={vi.fn()} onNavigateUp={vi.fn()} canNavigateUp={true} />
    );

    expect(screen.getByRole("button", { name: "[Óṕéń ḿéńú]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[Ńåṽíğåťé ťó ṕåŕéńť ďíŕéćťóŕý]" })).toBeInTheDocument();
  });
});
