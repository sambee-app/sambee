/**
 * ConfirmDeleteDialog Component Tests
 *
 * Verifies:
 * - Renders with correct item name and type label
 * - Delete button receives initial focus
 * - onConfirm/onClose callbacks fire correctly
 * - Buttons are disabled during isDeleting
 * - Uses centralized string constants
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithStyles as render } from "../../../test/utils/renderWithStyles";
import { FileType } from "../../../types";
import ConfirmDeleteDialog from "../ConfirmDeleteDialog";
import { CONFIRM_DELETE_STRINGS } from "../confirmDeleteDialogStrings";

describe("ConfirmDeleteDialog", () => {
  const defaultProps = {
    open: true,
    items: [{ name: "readme.txt", path: "readme.txt", type: FileType.FILE, size: 0, modified_at: "", is_readable: true, is_hidden: false }],
    isDeleting: false,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  };

  it("renders the file name and type", () => {
    render(<ConfirmDeleteDialog {...defaultProps} />);

    expect(screen.getByText(CONFIRM_DELETE_STRINGS.TITLE_FILE)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_DELETE_STRINGS.CONFIRM_FILE)).toBeInTheDocument();
    expect(screen.getByText("Item to delete:")).toBeInTheDocument();
    expect(screen.getByLabelText("readme.txt")).toHaveTextContent("readme.txt");
  });

  it("renders directory title and prompt when itemType is DIRECTORY", () => {
    render(<ConfirmDeleteDialog {...defaultProps} items={[{ ...defaultProps.items[0]!, name: "Photos", type: FileType.DIRECTORY }]} />);

    expect(screen.getByText(CONFIRM_DELETE_STRINGS.TITLE_DIRECTORY)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_DELETE_STRINGS.CONFIRM_DIRECTORY)).toBeInTheDocument();
  });

  it("lists selected items as independent one-line values", () => {
    render(
      <ConfirmDeleteDialog
        {...defaultProps}
        items={[defaultProps.items[0]!, { ...defaultProps.items[0]!, name: "notes.md", path: "notes.md" }]}
      />
    );

    expect(screen.getByText(CONFIRM_DELETE_STRINGS.TITLE_MULTI)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_DELETE_STRINGS.CONFIRM_MULTI(2))).toBeInTheDocument();
    expect(screen.getByText("Items to delete")).toBeInTheDocument();
    expect(screen.getByLabelText("readme.txt")).toHaveTextContent("readme.txt");
    expect(screen.getByLabelText("notes.md")).toHaveTextContent("notes.md");
  });

  it("limits the preview to six items and identifies the remainder", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ...defaultProps.items[0]!,
      name: `item-${index}.txt`,
      path: `item-${index}.txt`,
    }));
    render(<ConfirmDeleteDialog {...defaultProps} items={items} />);

    expect(screen.getByLabelText("item-5.txt")).toBeInTheDocument();
    expect(screen.queryByLabelText("item-6.txt")).not.toBeInTheDocument();
    expect(screen.getByText("and 2 more items")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDeleteDialog {...defaultProps} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onConfirm when Delete is clicked", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDeleteDialog {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cannot confirm again while deleting", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDeleteDialog {...defaultProps} isDeleting={true} onConfirm={onConfirm} />);

    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deleting/i })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows 'Deleting…' text when isDeleting", () => {
    render(<ConfirmDeleteDialog {...defaultProps} isDeleting={true} />);

    expect(screen.getByText("Deleting…")).toBeInTheDocument();
  });

  it("focuses Delete on opening and confirms with Enter", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDeleteDialog {...defaultProps} onConfirm={onConfirm} onClose={onClose} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());

    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still cancels with Enter after moving focus to Cancel", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ConfirmDeleteDialog {...defaultProps} onConfirm={onConfirm} onClose={onClose} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not render when open is false", () => {
    render(<ConfirmDeleteDialog {...defaultProps} open={false} />);

    expect(screen.queryByText(CONFIRM_DELETE_STRINGS.TITLE_FILE)).not.toBeInTheDocument();
  });
});
