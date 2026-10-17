import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompactBadge, MAX_BADGE_LABEL_LENGTH } from "../CompactBadge";

describe("CompactBadge", () => {
  it("preserves short status labels", () => {
    render(<CompactBadge label="Pwd change req'd" />);
    expect(screen.getByText("Pwd change req'd")).toBeInTheDocument();
  });

  it.each([
    "Password reset pending",
    "OIDC setup pending: 999999",
    "Role source: Individual override",
    "Long label with combining marks e\u0301e\u0301e\u0301e\u0301",
  ])("limits visible labels while retaining the full accessible text: %s", (label) => {
    const { container } = render(<CompactBadge label={label} />);
    const visibleLabel = container.querySelector(".MuiChip-label")?.textContent ?? "";
    const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visibleLabel));
    expect(graphemes.length).toBeLessThanOrEqual(MAX_BADGE_LABEL_LENGTH);
    expect(container.querySelector(".MuiChip-root")).toHaveAttribute("aria-label", label);
  });
});
