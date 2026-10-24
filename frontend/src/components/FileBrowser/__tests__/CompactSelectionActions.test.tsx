import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import type { FileOperationAction } from "../../../pages/FileBrowser/fileOperationActions";
import { requireTestValue } from "../../../test/helpers/assertions";
import { CompactSelectionActions } from "../CompactSelectionActions";

const actions: FileOperationAction[] = [
  {
    id: "create-archive",
    surface: "compact-selection-menu",
    scope: "selection",
    priority: 3,
    label: "Create archive",
    shortcut: "Alt+F5",
    tooltip: "Create archive (Alt+F5)",
    enabled: true,
    onClick: vi.fn(),
  },
  {
    id: "delete",
    surface: "compact-selection-menu",
    scope: "selection",
    priority: 4,
    label: "Delete",
    shortcut: "Del",
    tooltip: "Delete (Del)",
    enabled: false,
    unavailableReason: "This location is read-only.",
    onClick: vi.fn(),
  },
];

describe("CompactSelectionActions", () => {
  beforeEach(async () => {
    await setLocale("en");
  });

  it("announces selected count, clears selection, and invokes enabled menu actions", () => {
    const onClearSelection = vi.fn();
    render(<CompactSelectionActions actions={actions} selectedCount={2} onClearSelection={onClearSelection} />);

    expect(screen.getByTestId("compact-selection-dock")).toHaveStyle({ minHeight: "64px" });
    expect(screen.getByText("2 items selected")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create archive" }));
    expect(requireTestValue(actions[0]).onClick).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the action snapshot that was present when the menu opened", () => {
    const firstAction = { ...requireTestValue(actions[0]), onClick: vi.fn() };
    const secondAction = { ...requireTestValue(actions[0]), label: "Later action", onClick: vi.fn() };
    const { rerender } = render(
      <CompactSelectionActions actions={actions} getActions={() => [firstAction]} selectedCount={1} onClearSelection={() => {}} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }));
    rerender(<CompactSelectionActions actions={actions} getActions={() => [secondAction]} selectedCount={2} onClearSelection={() => {}} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create archive" }));

    expect(firstAction.onClick).toHaveBeenCalledOnce();
    expect(secondAction.onClick).not.toHaveBeenCalled();
  });
});
