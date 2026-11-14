import { Box } from "@mui/material";
import { screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { renderWithStyles } from "./renderWithStyles";

describe("renderWithStyles", () => {
  afterAll(() => {
    expect(document.querySelectorAll("style[data-emotion]")).toHaveLength(0);
  });

  it.each([false, true])("preserves styles through rerender and Strict Mode (%s)", (reactStrictMode) => {
    const Wrapper = ({ children }: React.PropsWithChildren) => <section aria-label="Test wrapper">{children}</section>;
    const { rerender } = renderWithStyles(<Box data-testid="styled" sx={{ color: "rgb(1, 2, 3)" }} />, {
      wrapper: Wrapper,
      reactStrictMode,
    });

    expect(screen.getByTestId("styled")).toHaveStyle({ color: "rgb(1, 2, 3)" });
    expect(screen.getByRole("region", { name: "Test wrapper" })).toContainElement(screen.getByTestId("styled"));

    rerender(<Box data-testid="styled" sx={{ color: "rgb(4, 5, 6)" }} />);
    expect(screen.getByTestId("styled")).toHaveStyle({ color: "rgb(4, 5, 6)" });
  });
});
