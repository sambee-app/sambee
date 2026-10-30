import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { COMPANION_PAIRING_DIALOG_COPY } from "../../Settings/localDrivesCopy";
import CompanionPairingDialog from "../CompanionPairingDialog";

describe("CompanionPairingDialog", () => {
  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("starts pairing when %s is pressed on the focused start button", async (_label, key) => {
    const onInitiate = vi.fn().mockResolvedValue({ pairingId: "pair-1", pairingCode: "ABC123" });
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(
      <CompanionPairingDialog
        open={true}
        onClose={vi.fn()}
        onInitiate={onInitiate}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />
    );

    const startButton = screen.getByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.startButton });
    act(() => startButton.focus());

    fireEvent.keyDown(startButton, { key });

    await waitFor(() => {
      expect(onInitiate).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("confirms pairing when %s is pressed on the focused confirm button", async (_label, key) => {
    const user = userEvent.setup();
    const onInitiate = vi.fn().mockResolvedValue({ pairingId: "pair-1", pairingCode: "ABC123" });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(<CompanionPairingDialog open={true} onClose={vi.fn()} onInitiate={onInitiate} onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.startButton }));

    const confirmButton = await screen.findByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.confirmButton });
    confirmButton.focus();

    fireEvent.keyDown(confirmButton, { key });

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith("pair-1");
    });
  });

  it("cancels a pending pairing when the parent closes the dialog", async () => {
    const user = userEvent.setup();
    const onInitiate = vi.fn().mockResolvedValue({ pairingId: "pair-1", pairingCode: "ABC123" });
    const onCancel = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <CompanionPairingDialog
        open={true}
        onClose={vi.fn()}
        onInitiate={onInitiate}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />
    );

    await user.click(screen.getByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.startButton }));
    await screen.findByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.confirmButton });

    rerender(
      <CompanionPairingDialog
        open={false}
        onClose={vi.fn()}
        onInitiate={onInitiate}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />
    );

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("pair-1");
    });
  });

  it("does not cancel pairing when moving from code verification to confirming", async () => {
    const user = userEvent.setup();
    const onInitiate = vi.fn().mockResolvedValue({ pairingId: "pair-1", pairingCode: "ABC123" });
    const onCancel = vi.fn().mockResolvedValue(undefined);

    let resolveConfirm: (() => void) | undefined;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );

    render(<CompanionPairingDialog open={true} onClose={vi.fn()} onInitiate={onInitiate} onConfirm={onConfirm} onCancel={onCancel} />);

    await user.click(screen.getByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.startButton }));
    await user.click(await screen.findByRole("button", { name: COMPANION_PAIRING_DIALOG_COPY.confirmButton }));

    expect(onConfirm).toHaveBeenCalledWith("pair-1");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText(COMPANION_PAIRING_DIALOG_COPY.confirming)).toBeInTheDocument();

    resolveConfirm?.();
    await waitFor(() => {
      expect(screen.getByText(COMPANION_PAIRING_DIALOG_COPY.success)).toBeInTheDocument();
    });
  });
});
