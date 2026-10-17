import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ViewerShareMenu } from "../ViewerShareMenu";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("viewer sharing menu", () => {
  it.each(["file", "text"])("invokes only the selected %s action directly", (mode) => {
    const onFile = vi.fn();
    const onText = vi.fn();
    render(<ViewerShareMenu onFile={onFile} onText={onText} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "common.actions.share" }));
    fireEvent.click(screen.getByRole("menuitem", { name: mode === "file" ? "viewer.share.asFile" : "viewer.share.asText" }));
    expect(mode === "file" ? onFile : onText).toHaveBeenCalledTimes(1);
    expect(mode === "file" ? onText : onFile).not.toHaveBeenCalled();
  });

  it("keeps text available while files prepare and restores focus after Escape", async () => {
    const user = userEvent.setup();
    const onFile = vi.fn();
    const onText = vi.fn();
    render(<ViewerShareMenu onFile={onFile} onText={onText} fileDisabled />);
    const trigger = screen.getByRole("button", { name: "common.actions.share" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "viewer.share.asFile" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "viewer.share.asText" })).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onFile).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });
});
