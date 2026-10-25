import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ViewerNotice, ViewerNotifications } from "../ViewerNotifications";

describe("ViewerNotifications", () => {
  const warning: ViewerNotice = { id: "storage", message: "Draft recovery unavailable", severity: "warning" };
  const failure: ViewerNotice = { id: "save", message: "Save failed", severity: "error", occurrence: 1 };
  const host = (notices: ViewerNotice[]) => <ViewerNotifications notices={notices} toolbarBackground="#000" toolbarText="#fff" />;

  it("prioritizes errors and retains pending warnings without stacking", () => {
    render(host([warning, failure]));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("status")).toHaveTextContent(warning.message);
    expect(document.querySelectorAll(".MuiSnackbar-root")).toHaveLength(1);
  });

  it("deduplicates dismissed conditions until resolution and allows recurrence", () => {
    const { rerender } = render(host([warning]));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerender(host([{ ...warning }]));
    expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
    rerender(host([]));
    rerender(host([warning]));
    expect(screen.getByText(warning.message)).toBeInTheDocument();
  });

  it("shows an identical operation failure again for a new occurrence", () => {
    const { rerender } = render(host([failure]));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerender(host([{ ...failure, occurrence: 2 }]));
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
  });

  it("removes resolved queued notices and preserves typing focus", () => {
    const { rerender } = render(
      <>
        <input aria-label="Editor" />
        {host([warning])}
      </>
    );
    screen.getByRole("textbox").focus();
    rerender(
      <>
        <input aria-label="Editor" />
        {host([failure])}
      </>
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("suppresses viewer notices behind a dialog without forgetting dismissed conditions", () => {
    const hostWithDialog = (suppressed: boolean) => (
      <ViewerNotifications notices={[failure, warning]} toolbarBackground="#000" toolbarText="#fff" suppressed={suppressed} />
    );
    const { rerender } = render(hostWithDialog(false));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerender(hostWithDialog(true));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(hostWithDialog(false));
    expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(warning.message);
  });
});
