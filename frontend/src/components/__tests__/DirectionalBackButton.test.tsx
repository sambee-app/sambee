import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "../../i18n";
import { renderWithStyles } from "../../test/utils/renderWithStyles";
import { DirectionalBackButton } from "../DirectionalBackButton";

const originalDirection = document.documentElement.dir;

describe("DirectionalBackButton", () => {
  afterEach(() => {
    document.documentElement.dir = originalDirection;
  });

  it("uses the forward arrow and end edge in right-to-left layouts", () => {
    document.documentElement.dir = "rtl";
    renderWithStyles(<DirectionalBackButton aria-label="Go back" onClick={() => undefined} />);

    expect(screen.getByTestId("ArrowForwardIcon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go back" })).toHaveClass("MuiIconButton-edgeEnd");
  });

  it("uses the back arrow and start edge in left-to-right layouts", () => {
    document.documentElement.dir = "ltr";
    renderWithStyles(<DirectionalBackButton aria-label="Go back" onClick={() => undefined} />);

    expect(screen.getByTestId("ArrowBackIcon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go back" })).toHaveClass("MuiIconButton-edgeStart");
  });
});
