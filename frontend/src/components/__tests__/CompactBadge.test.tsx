import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CompactBadge, MAX_BADGE_LABEL_LENGTH } from "../CompactBadge";

describe("CompactBadge", () => {
  it("preserves short status labels", () => {
    render(<CompactBadge label="Pwd change req'd" />);
    expect(screen.getByText("Pwd change req'd")).toBeInTheDocument();
  });

  it("uses an explicit title for the tooltip instead of passing it to the chip", async () => {
    const consoleError = vi.spyOn(console, "error");
    try {
      const user = userEvent.setup();
      render(<CompactBadge label="Read only" title="Writes are disabled" />);

      const badge = screen.getByText("Read only").closest(".MuiChip-root");
      expect(badge).not.toHaveAttribute("title");
      await user.hover(screen.getByText("Read only"));
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Writes are disabled");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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
