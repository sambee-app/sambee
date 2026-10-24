import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../i18n";
import type { FileOperationAction } from "../../../pages/FileBrowser/fileOperationActions";
import { requireTestValue } from "../../../test/helpers/assertions";
import { CompactCreateMenu } from "../CompactCreateMenu";

const actions: FileOperationAction[] = [
  {
    id: "new-directory",
    surface: "compact-create-menu",
    scope: "pane",
    priority: 1,
    label: "New folder",
    shortcut: "F7",
    tooltip: "New folder (F7)",
    enabled: true,
    onClick: vi.fn(),
  },
  {
    id: "new-file",
    surface: "compact-create-menu",
    scope: "pane",
    priority: 2,
    label: "New file",
    shortcut: "Shift+F7",
    tooltip: "New file (Shift+F7)",
    enabled: false,
    unavailableReason: "This location is read-only.",
    onClick: vi.fn(),
  },
];

describe("CompactCreateMenu", () => {
  beforeEach(async () => {
    await setLocale("en");
  });

  it("opens creation commands and only invokes enabled actions", () => {
    render(<CompactCreateMenu actions={actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Create new item" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
    expect(requireTestValue(actions[0]).onClick).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Create new item" }));
    expect(screen.getByRole("menuitem", { name: "New file" })).toHaveAttribute("aria-disabled", "true");
  });

  it("does not render when no creation action is available", () => {
    render(<CompactCreateMenu actions={actions.map((action) => ({ ...action, enabled: false }))} />);

    expect(screen.queryByRole("button", { name: "Create new item" })).not.toBeInTheDocument();
  });
});
