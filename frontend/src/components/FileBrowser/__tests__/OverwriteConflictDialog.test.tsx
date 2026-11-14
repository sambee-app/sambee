import { createTheme } from "@mui/material/styles";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConflictInfo, FileType } from "../../../types";
import OverwriteConflictDialog from "../OverwriteConflictDialog";
import { OVERWRITE_CONFLICT_STRINGS as S } from "../overwriteConflictStrings";

const conflict: ConflictInfo = {
  incoming_file: {
    name: "report.txt",
    path: "source/report.txt",
    type: FileType.FILE,
    size: 1024,
    modified_at: "2025-01-01T12:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
  existing_file: {
    name: "report.txt",
    path: "target/report.txt",
    type: FileType.FILE,
    size: 2048,
    modified_at: "2025-01-02T12:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
};

describe("OverwriteConflictDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultProps = {
    open: true,
    conflict,
    allowedActions: ["skip", "overwrite", "overwrite-older", "rename"] as const,
    onResolve: vi.fn(),
    onCancel: vi.fn(),
  };

  it("shows concise stacked target and source details", () => {
    render(<OverwriteConflictDialog {...defaultProps} />);

    expect(screen.getByRole("heading", { name: S.TITLE })).toBeInTheDocument();
    expect(screen.getByText(S.ALREADY_EXISTS)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: S.LABEL_TARGET_NAME })).not.toBeInTheDocument();
    const targetDetails = screen.getByTestId("overwrite-conflict-target-details");
    const sourceDetails = screen.getByTestId("overwrite-conflict-source-details");
    expect(within(targetDetails).getByRole("heading", { name: S.LABEL_EXISTING })).toBeInTheDocument();
    expect(within(sourceDetails).getByRole("heading", { name: S.LABEL_INCOMING })).toBeInTheDocument();
    expect(screen.getByTestId("overwrite-conflict-target-path")).toHaveTextContent("target/report.txt");
    const sourcePath = screen.getByTestId("overwrite-conflict-source-path");
    expect(sourcePath).toHaveTextContent("source/report.txt");
    expect(within(sourcePath).getByText("source/report.txt").closest("bdi")).not.toBeNull();
    const metadata = screen.getByRole("region", { name: S.METADATA_LABEL });
    expect(within(metadata).getAllByText(S.LABEL_PATH)).toHaveLength(2);
    expect(within(metadata).getAllByText(S.LABEL_MODIFIED)).toHaveLength(2);
    expect(within(metadata).getAllByText(S.LABEL_SIZE)).toHaveLength(2);
    const direction = screen.getByTestId("overwrite-conflict-direction");
    expect(direction).toHaveStyle({ display: "grid" });
    expect(direction.querySelector("svg")).toBeInTheDocument();
    expect(targetDetails.compareDocumentPosition(sourceDetails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("responsive-form-dialog-desktop-actions")).toBeInTheDocument();
  });

  it("shows upload-specific actions and folder metadata for a directory/file conflict", () => {
    render(
      <OverwriteConflictDialog
        {...defaultProps}
        operation="upload"
        uploadKind="directory"
        allowedActions={["skip", "rename"]}
        conflict={{
          incoming_file: { ...conflict.incoming_file, name: "Reports", type: FileType.DIRECTORY },
          existing_file: conflict.existing_file,
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Cancel upload" })).toBeInTheDocument();
    expect(screen.getByText(S.FOLDER_CONFLICT)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: S.BUTTON_OVERWRITE })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("overwrite-conflict-source-details")).queryByText(S.LABEL_SIZE)).not.toBeInTheDocument();
    expect(within(screen.getByTestId("overwrite-conflict-target-details")).getByText(S.LABEL_SIZE)).toBeInTheDocument();
  });

  it("shows owner-supplied connection-qualified source and target paths", () => {
    render(
      <OverwriteConflictDialog
        {...defaultProps}
        sourcePath="Source connection:/archive.zip/source/report.txt"
        targetDirectoryPath="Target connection:/destination"
      />
    );

    expect(screen.getByTestId("overwrite-conflict-target-path")).toHaveTextContent("Target connection:/destination");
    expect(screen.getByTestId("overwrite-conflict-source-path")).toHaveTextContent("Source connection:/archive.zip/source");
  });

  it("preserves long target and path values without creating an input until Rename", async () => {
    const sourceName = `source-${"a".repeat(240)}.txt`;
    const targetName = `target-${"b".repeat(240)}.txt`;
    const targetDirectory = Array.from({ length: 20 }, (_, index) => `directory-${index}`).join("/");
    const longNameConflict: ConflictInfo = {
      incoming_file: { ...conflict.incoming_file, name: sourceName, path: `source/${sourceName}` },
      existing_file: { ...conflict.existing_file, name: targetName, path: `${targetDirectory}/${targetName}` },
    };

    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} conflict={longNameConflict} />);

    const sourcePath = screen.getByTestId("overwrite-conflict-source-path");
    const targetDirectoryCode = screen.getByTestId("overwrite-conflict-target-path-value");

    expect(screen.queryByRole("textbox", { name: S.LABEL_TARGET_NAME })).not.toBeInTheDocument();
    expect(sourcePath).toHaveTextContent(`source/${sourceName}`);
    expect(targetDirectoryCode).toHaveTextContent(`${targetDirectory}/${targetName}`);
    expect(targetDirectoryCode.querySelector("code")).toHaveStyle({ overflow: "hidden", whiteSpace: "nowrap" });
    await user.click(screen.getByRole("radio", { name: S.BUTTON_RENAME }));
    const targetInput = screen.getByRole("textbox", { name: S.LABEL_TARGET_NAME }) as HTMLInputElement;
    expect(targetInput).toHaveValue(`${targetName.slice(0, -4)} (copy).txt`);
    expect(targetInput).not.toHaveAttribute("readonly");
  });

  it("uses a compact grid for desktop resolution choices", () => {
    render(<OverwriteConflictDialog {...defaultProps} />);

    expect(screen.getByRole("radiogroup")).toHaveStyle({ display: "grid" });
  });

  it("changes Continue's tone only for overwrite resolutions", async () => {
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} />);

    expect(screen.getByRole("button", { name: S.CANCEL_OPERATION("copy") })).toHaveClass("MuiButton-outlined");
    const continueButton = screen.getByRole("button", { name: S.BUTTON_CONTINUE });
    expect(continueButton).toHaveClass("MuiButton-contained", "MuiButton-colorPrimary");

    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE }));
    expect(continueButton).toHaveClass("MuiButton-contained", "MuiButton-colorError");
    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE_ONLY_OLDER }));
    expect(continueButton).toHaveClass("MuiButton-colorError");
    await user.click(screen.getByRole("radio", { name: S.BUTTON_RENAME }));
    expect(continueButton).toHaveClass("MuiButton-colorPrimary");
    await user.click(screen.getByRole("radio", { name: S.BUTTON_SKIP }));
    expect(continueButton).toHaveClass("MuiButton-colorPrimary");
  });

  it("focuses Skip and submits the selected bulk resolution", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onResolve={onResolve} progress={{ current: 2, total: 3, conflictsSoFar: 1 }} />);

    const skipRadio = screen.getByRole("radio", { name: S.BUTTON_SKIP });
    await waitFor(() => expect(skipRadio).toHaveFocus());
    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE }));
    await user.click(screen.getByRole("checkbox", { name: S.APPLY_TO_ALL }));
    await user.click(screen.getByRole("button", { name: S.BUTTON_CONTINUE }));

    expect(onResolve).toHaveBeenCalledWith({ resolution: "overwrite", applyToAll: true, targetName: undefined });
  });

  it("submits the focused safe resolution when Enter is pressed", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onResolve={onResolve} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toHaveFocus());
    await user.keyboard("{Enter}");

    expect(onResolve).toHaveBeenCalledWith({ resolution: "skip", applyToAll: false, targetName: undefined });
  });

  it("resets radio selection and keyboard focus for the next conflict", async () => {
    const user = userEvent.setup();
    const nextConflict: ConflictInfo = {
      incoming_file: { ...conflict.incoming_file, path: "source/next-report.txt" },
      existing_file: { ...conflict.existing_file, path: "target/next-report.txt" },
    };
    const { rerender } = render(<OverwriteConflictDialog {...defaultProps} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE })).toBeChecked();

    rerender(<OverwriteConflictDialog {...defaultProps} conflict={nextConflict} />);

    const skipRadio = screen.getByRole("radio", { name: S.BUTTON_SKIP });
    await waitFor(() => {
      expect(skipRadio).toBeChecked();
      expect(skipRadio).toHaveFocus();
    });
    await user.keyboard("{ArrowDown}");

    const overwriteRadio = screen.getByRole("radio", { name: S.BUTTON_OVERWRITE });
    expect(overwriteRadio).toBeChecked();
    expect(overwriteRadio).toHaveFocus();
  });

  it.each([false, true])(
    "focuses the next conflict without waiting for a transition (opening finished: %s)",
    async (transitionFinished) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
      const nextConflict: ConflictInfo = {
        incoming_file: { ...conflict.incoming_file, path: "source/next-report.txt" },
        existing_file: { ...conflict.existing_file, path: "target/next-report.txt" },
      };
      const { rerender } = render(<OverwriteConflictDialog {...defaultProps} />);

      await act(async () => vi.advanceTimersToNextFrame());
      if (transitionFinished) {
        await act(() => vi.advanceTimersByTimeAsync(createTheme().transitions.duration.enteringScreen));
      }
      const overwriteRadio = screen.getByRole("radio", { name: S.BUTTON_OVERWRITE });
      act(() => overwriteRadio.focus());
      fireEvent.click(overwriteRadio);
      expect(overwriteRadio).toBeChecked();
      expect(overwriteRadio).toHaveFocus();

      rerender(<OverwriteConflictDialog {...defaultProps} conflict={nextConflict} />);
      await act(async () => vi.advanceTimersToNextFrame());

      const skipRadio = screen.getByRole("radio", { name: S.BUTTON_SKIP });
      expect(skipRadio).toBeChecked();
      expect(skipRadio).toHaveFocus();
    }
  );

  it("focuses the safe resolution after the next conflict's pending state clears", async () => {
    const nextConflict: ConflictInfo = {
      incoming_file: { ...conflict.incoming_file, path: "source/pending-report.txt" },
      existing_file: { ...conflict.existing_file, path: "target/pending-report.txt" },
    };
    const { rerender } = render(<OverwriteConflictDialog {...defaultProps} />);

    rerender(<OverwriteConflictDialog {...defaultProps} conflict={nextConflict} isSubmitting />);
    expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toBeChecked();

    rerender(<OverwriteConflictDialog {...defaultProps} conflict={nextConflict} isSubmitting={false} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toHaveFocus());
  });

  it("defers initial focus until submission clears after the opening transition", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const { rerender } = render(<OverwriteConflictDialog {...defaultProps} isSubmitting />);

    await act(() => vi.advanceTimersByTimeAsync(createTheme().transitions.duration.enteringScreen));
    const skipRadio = screen.getByRole("radio", { name: S.BUTTON_SKIP });
    expect(skipRadio).toBeDisabled();
    expect(skipRadio).not.toHaveFocus();

    rerender(<OverwriteConflictDialog {...defaultProps} isSubmitting={false} />);
    await act(async () => vi.advanceTimersToNextFrame());

    expect(skipRadio).toBeEnabled();
    expect(skipRadio).toHaveFocus();
  });

  it("shows the bulk-choice control for Overwrite only older", async () => {
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} progress={{ current: 1, total: 3, conflictsSoFar: 1 }} />);

    const bulkChoiceSlot = screen.getByTestId("overwrite-conflict-apply-all-slot");
    expect(bulkChoiceSlot).toHaveStyle({ visibility: "visible" });

    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE_ONLY_OLDER }));

    expect(bulkChoiceSlot).toHaveStyle({ visibility: "visible" });
    expect(screen.getByRole("checkbox", { name: S.APPLY_TO_ALL })).toBeInTheDocument();
  });

  it("clears bulk scope when the resolution changes", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onResolve={onResolve} progress={{ current: 2, total: 3, conflictsSoFar: 1 }} />);

    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE }));
    const checkbox = screen.getByRole("checkbox", { name: S.APPLY_TO_ALL });
    await user.click(checkbox);
    await user.click(screen.getByRole("radio", { name: S.BUTTON_SKIP }));

    expect(checkbox).not.toBeChecked();
  });

  it("shows the Target name field below resolution controls for Rename", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onResolve={onResolve} />);

    expect(screen.queryByRole("textbox", { name: S.LABEL_TARGET_NAME })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: S.BUTTON_RENAME }));

    const targetName = screen.getByRole("textbox", { name: S.LABEL_TARGET_NAME });
    expect(targetName).toHaveValue("report (copy).txt");
    expect(targetName).not.toHaveAttribute("readonly");
    expect(targetName.closest(".MuiFormControl-root")?.querySelector(".MuiFormHelperText-root")).not.toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup").compareDocumentPosition(targetName.closest(".MuiFormControl-root")!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await user.clear(targetName);
    await user.type(targetName, "renamed.txt");
    await user.click(screen.getByRole("button", { name: S.BUTTON_CONTINUE }));

    expect(onResolve).toHaveBeenCalledWith({ resolution: "rename", applyToAll: false, targetName: "renamed.txt" });
  });

  it("submits Overwrite only older with a bulk decision", async () => {
    const onResolve = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onResolve={onResolve} progress={{ current: 1, total: 3, conflictsSoFar: 1 }} />);

    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE_ONLY_OLDER }));

    await user.click(screen.getByRole("checkbox", { name: S.APPLY_TO_ALL }));
    await user.click(screen.getByRole("button", { name: S.BUTTON_CONTINUE }));

    expect(onResolve).toHaveBeenCalledWith({ resolution: "overwrite-older", applyToAll: true, targetName: undefined });
  });

  it("renders only owner-supported resolution choices", () => {
    render(<OverwriteConflictDialog {...defaultProps} allowedActions={["skip", "overwrite"]} />);

    expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: S.BUTTON_OVERWRITE_ONLY_OLDER })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: S.BUTTON_RENAME })).not.toBeInTheDocument();
  });

  it("disables continuation when the owner supplies no resolution choices", () => {
    render(<OverwriteConflictDialog {...defaultProps} allowedActions={[]} />);

    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: S.BUTTON_CONTINUE })).toBeDisabled();
  });

  it("explains the no-resolution state without moving focus to its alert", () => {
    render(<OverwriteConflictDialog {...defaultProps} allowedActions={[]} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(S.ERROR_NO_RESOLUTION_AVAILABLE);
    expect(alert).not.toHaveFocus();
  });

  it("resets the selected resolution when owner capabilities change", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OverwriteConflictDialog {...defaultProps} allowedActions={["skip", "overwrite"]} />);

    await user.click(screen.getByRole("radio", { name: S.BUTTON_OVERWRITE }));
    rerender(<OverwriteConflictDialog {...defaultProps} allowedActions={["skip"]} />);

    await waitFor(() => expect(screen.getByRole("radio", { name: S.BUTTON_SKIP })).toBeChecked());
    expect(screen.queryByRole("radio", { name: S.BUTTON_OVERWRITE })).not.toBeInTheDocument();
  });

  it("shows unavailable metadata placeholders for directory conflicts", () => {
    const directoryConflict: ConflictInfo = {
      incoming_file: { ...conflict.incoming_file, type: FileType.DIRECTORY, size: undefined, modified_at: undefined },
      existing_file: { ...conflict.existing_file, type: FileType.DIRECTORY, size: undefined, modified_at: undefined },
    };
    render(<OverwriteConflictDialog {...defaultProps} conflict={directoryConflict} allowedActions={["skip", "rename"]} />);

    expect(screen.getAllByText(S.LABEL_SIZE)).toHaveLength(2);
    expect(screen.getAllByText(S.LABEL_MODIFIED)).toHaveLength(2);
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("focuses and selects Target name when Rename is the only available action", async () => {
    render(<OverwriteConflictDialog {...defaultProps} allowedActions={["rename"]} />);

    const targetName = screen.getByRole("textbox", { name: S.LABEL_TARGET_NAME }) as HTMLInputElement;
    await waitFor(() => expect(targetName).toHaveFocus());
    expect(targetName.selectionStart).toBe(0);
    expect(targetName.selectionEnd).toBe(targetName.value.length);
  });

  it("does not focus an owner-level error after a failed decision", () => {
    render(<OverwriteConflictDialog {...defaultProps} error="Unable to save this decision." />);

    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveFocus();
  });

  it("cancels the operation on Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<OverwriteConflictDialog {...defaultProps} onCancel={onCancel} />);

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
