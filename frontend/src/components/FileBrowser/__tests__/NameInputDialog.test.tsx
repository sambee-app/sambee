/**
 * NameInputDialog Component Tests
 *
 * Tests the shared base dialog component used by both
 * RenameDialog and CreateItemDialog.
 *
 * Verifies:
 * - Renders with correct title, labels, and initial value
 * - Input field auto-focuses on open
 * - Client-side validation (base + extra)
 * - Submit via button click and Enter key
 * - Cancel via button click
 * - Disabled state during submission
 * - API error display below the input in a reserved Alert slot
 * - Does not render when open is false
 * - Clears validation error on typing
 * - Preserves whitespace before confirming
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import NameInputDialog from "../NameInputDialog";
import { NAME_DIALOG_STRINGS } from "../nameDialogStrings";

const defaultProps = {
  open: true,
  title: "Test Dialog",
  inputLabel: "Name",
  initialValue: "",
  submitLabel: "Submit",
  submittingLabel: "Submitting…",
  isSubmitting: false,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
  apiError: null as string | null,
};

describe("NameInputDialog", () => {
  // ── Rendering ──────────────────────────────────────────────────────────

  it("renders with the provided title", () => {
    render(<NameInputDialog {...defaultProps} title="New directory" />);
    expect(screen.getByText("New directory")).toBeInTheDocument();
  });

  it("renders with the provided input label", () => {
    render(<NameInputDialog {...defaultProps} inputLabel="Folder name" />);
    expect(screen.getByLabelText("Folder name")).toBeInTheDocument();
    expect(screen.getByLabelText("Folder name").closest(".MuiInputBase-root")).not.toHaveClass("MuiInputBase-sizeSmall");
  });

  it("renders no validation helper text when no validation error is present", () => {
    render(<NameInputDialog {...defaultProps} />);

    expect(screen.getByLabelText("Name").closest(".MuiFormControl-root")?.querySelector(".MuiFormHelperText-root")).not.toBeInTheDocument();
  });

  it("renders a readable validation message without a tooltip", async () => {
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: "Submit" }));
    const feedback = screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_EMPTY);
    expect(feedback).not.toHaveStyle({ overflow: "hidden", whiteSpace: "nowrap" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders no API error alert when the API has not failed", () => {
    render(<NameInputDialog {...defaultProps} />);

    expect(screen.queryByTestId("name-input-api-error")).not.toBeInTheDocument();
  });

  it("renders with initial value pre-filled", async () => {
    render(<NameInputDialog {...defaultProps} initialValue="readme.txt" />);

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveValue("readme.txt");
    });
  });

  it("renders the submit button with the provided label", () => {
    render(<NameInputDialog {...defaultProps} submitLabel="Create" />);
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("renders Cancel button", () => {
    render(<NameInputDialog {...defaultProps} />);
    expect(screen.getByRole("button", { name: NAME_DIALOG_STRINGS.BUTTON_CANCEL })).toBeInTheDocument();
  });

  it("uses the active-operation cancellation action while submitting", async () => {
    const user = userEvent.setup();
    const onCancelSubmitting = vi.fn();
    render(
      <NameInputDialog
        {...defaultProps}
        isSubmitting
        cancelSubmittingLabel="Cancel archive creation"
        onCancelSubmitting={onCancelSubmitting}
      />
    );

    await user.click(screen.getByRole("button", { name: "Cancel archive creation" }));

    expect(onCancelSubmitting).toHaveBeenCalledOnce();
  });

  it("focuses the active-operation cancellation action while submitting", async () => {
    render(<NameInputDialog {...defaultProps} isSubmitting cancelSubmittingLabel="Cancel archive creation" onCancelSubmitting={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel archive creation" })).toHaveFocus());
  });

  it("replaces the form with active-operation content while submitting", () => {
    render(
      <NameInputDialog
        {...defaultProps}
        isSubmitting
        onCancelSubmitting={vi.fn()}
        submittingContent={<div>Creating archive progress</div>}
      />
    );

    expect(screen.getByText("Creating archive progress")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit" })).not.toBeInTheDocument();
  });

  it("does not render when open is false", () => {
    render(<NameInputDialog {...defaultProps} open={false} />);
    expect(screen.queryByText("Test Dialog")).not.toBeInTheDocument();
  });

  // ── Focus ──────────────────────────────────────────────────────────────

  it("focuses the input field when dialog opens", async () => {
    render(<NameInputDialog {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveFocus();
    });
  });

  // ── Submit ─────────────────────────────────────────────────────────────

  it("calls onConfirm with leading whitespace intact when submit button is clicked", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "  new-folder");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onConfirm).toHaveBeenCalledWith("  new-folder");
  });

  it("calls onConfirm when Enter is pressed", async () => {
    const onConfirm = vi.fn();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "my-file.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledWith("my-file.txt");
  });

  it("keeps decomposed Unicode while typing and submits the NFC name", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    const nfdName = "Auftragsbesta\u0308tigung.pdf";
    const nfcName = "Auftragsbestätigung.pdf";
    fireEvent.change(input, { target: { value: nfdName } });

    expect(input).toHaveValue(nfdName);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onConfirm).toHaveBeenCalledWith(nfcName);
  });

  it("does not submit on Enter when isSubmitting is true", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} isSubmitting={true} onConfirm={onConfirm} initialValue="test" />);

    await user.keyboard("{Enter}");

    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ── Cancel ─────────────────────────────────────────────────────────────

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: NAME_DIALOG_STRINGS.BUTTON_CANCEL }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onClose={onClose} />);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Base validation ────────────────────────────────────────────────────

  it("shows validation error for empty name", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_EMPTY)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows validation error for invalid characters", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "file/name" } });
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_INVALID_CHARS)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows validation error for dot names", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: ".." } });
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_DOT_NAMES)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows validation error for trailing period", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "myfile." } });
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_TRAILING)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows validation error for trailing whitespace", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} />);

    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "myfile " } });
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_TRAILING)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ── Extra validation ───────────────────────────────────────────────────

  it("runs extraValidate and shows its error", async () => {
    const onConfirm = vi.fn();
    const extraValidate = (name: string) => (name === "taken" ? "That name is taken" : null);
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} extraValidate={extraValidate} />);

    const input = screen.getByLabelText("Name");
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "taken");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(screen.getByText("That name is taken")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("passes when extraValidate returns null", async () => {
    const onConfirm = vi.fn();
    const extraValidate = () => null;
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} onConfirm={onConfirm} extraValidate={extraValidate} />);

    const input = screen.getByLabelText("Name");
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "valid-name");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onConfirm).toHaveBeenCalledWith("valid-name");
  });

  // ── Validation error clearing ──────────────────────────────────────────

  it("clears validation error when user types", async () => {
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} />);

    // Trigger empty validation error
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_EMPTY)).toBeInTheDocument();

    // Type something — error should clear
    const input = screen.getByLabelText("Name");
    fireEvent.change(input, { target: { value: "a" } });

    expect(screen.queryByText(NAME_DIALOG_STRINGS.VALIDATION_EMPTY)).not.toBeInTheDocument();
  });

  // ── Submitting state ───────────────────────────────────────────────────

  it("disables buttons when isSubmitting is true", () => {
    render(<NameInputDialog {...defaultProps} isSubmitting={true} />);

    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /submitting/i })).toBeDisabled();
  });

  it("shows submitting label when isSubmitting is true", () => {
    render(<NameInputDialog {...defaultProps} isSubmitting={true} />);
    expect(screen.getByText("Submitting…")).toBeInTheDocument();
  });

  it("disables the input when isSubmitting is true", () => {
    render(<NameInputDialog {...defaultProps} isSubmitting={true} />);
    expect(screen.getByLabelText("Name")).toBeDisabled();
  });

  // ── API error display ──────────────────────────────────────────────────

  it("displays API error in an Alert", () => {
    render(<NameInputDialog {...defaultProps} apiError="Item already exists" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Item already exists");
    expect(screen.getByTestId("name-input-api-error")).toBeInTheDocument();
  });

  it("does not repeat API error text in field helper text", () => {
    render(<NameInputDialog {...defaultProps} apiError="Item already exists" />);

    const input = screen.getByLabelText("Name");
    expect(input.closest(".MuiFormControl-root")?.querySelector(".MuiFormHelperText-root")).not.toBeInTheDocument();
  });

  it("shows validation error when submitting with empty name despite API error", async () => {
    const user = userEvent.setup();
    render(<NameInputDialog {...defaultProps} apiError="Item already exists" />);

    // Clear the input and submit via Enter (button may be pointer-events:none)
    const input = screen.getByLabelText("Name");
    await user.clear(input);
    await user.keyboard("{Enter}");

    // Validation helper text is shown
    expect(screen.getByText(NAME_DIALOG_STRINGS.VALIDATION_EMPTY)).toBeInTheDocument();
  });

  // ── Reset on re-open ──────────────────────────────────────────────────

  it("resets value and validation error when dialog reopens", async () => {
    function ReopenableDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open name dialog
          </button>
          <NameInputDialog {...defaultProps} initialValue="original" open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    const user = userEvent.setup();
    render(<ReopenableDialog />);
    await user.click(screen.getByRole("button", { name: "Open name dialog" }));
    const input = screen.getByLabelText("Name");
    await waitFor(() => expect(input).toHaveFocus());
    await user.clear(input);
    await user.type(input, "modified");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Name")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Open name dialog" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveValue("original");
      expect(screen.getByLabelText("Name")).toHaveFocus();
    });
  });
});
