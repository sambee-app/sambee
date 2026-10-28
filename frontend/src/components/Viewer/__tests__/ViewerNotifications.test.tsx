import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "../../../i18n";
import { formatNoticeTarget, NOTICE_DURATION_MS, OperationNotificationProvider } from "../../OperationNotifications";
import { type ViewerNotice, ViewerNotifications } from "../ViewerNotifications";

describe("ViewerNotifications", () => {
  const warning: ViewerNotice = { id: "storage", message: "Draft recovery unavailable", severity: "warning" };
  const failure: ViewerNotice = { id: "save", message: "Save failed", severity: "error", occurrence: 1 };
  const host = (notices: ViewerNotice[]) => <ViewerNotifications notices={notices} toolbarBackground="#000" toolbarText="#fff" />;

  it.each([
    ["Demo", "Projects/Reports/report.txt", "Demo: /Projects/Reports/report.txt"],
    ["Demo", "Projects/Reports", "Demo: /Projects/Reports"],
    ["Demo", "", "Demo: /"],
    ["Demo", "/", "Demo: /"],
    [undefined, "Projects/report.txt", "/Projects/report.txt"],
    ["Demo", "/Projects/report.txt", "Demo: /Projects/report.txt"],
  ])("formats the complete target for %s and %s", (connection, path, expected) => {
    expect(formatNoticeTarget(connection, path)).toBe(expected);
  });

  it("shows the message before separate, non-bold target context", () => {
    const targetLabel = formatNoticeTarget("Demo", "Projects/Reports/report.txt");
    render(host([{ ...failure, targetLabel }]));
    const message = screen.getByText(failure.message);
    const context = screen.getByLabelText(targetLabel);
    expect(message.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.tagName).toBe("BDI");
    expect(context).toHaveAttribute("dir", "auto");
    expect(context.closest("strong, b")).toBeNull();
    expect(context.parentElement).toHaveStyle({ fontWeight: 400 });
    expect(within(context).getByText(targetLabel).tagName).toBe("SPAN");
    expect(within(context).getByText(targetLabel)).toHaveStyle({ whiteSpace: "nowrap" });
  });

  it("shortens a long path during a scale-in transition and exposes its full value", async () => {
    const targetLabel = formatNoticeTarget("Demo", "Projects/AnnualReports/ArchivedDocuments/report.pdf");
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 0,
      height: 20,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 20,
      toJSON: () => ({}),
    });
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(220);
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (value: string) => ({ width: value.length * 6 }),
    } as CanvasRenderingContext2D);
    try {
      render(host([{ ...failure, targetLabel }]));
      const context = screen.getByLabelText(targetLabel);
      expect(context).toHaveTextContent("Demo: /.../report.pdf");
      expect(context).not.toHaveTextContent("ArchivedDocuments");
      expect(context).toHaveAttribute("dir", "auto");
      fireEvent.mouseOver(context);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(targetLabel);
    } finally {
      bounds.mockRestore();
      width.mockRestore();
      canvas.mockRestore();
    }
  });

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

  it("keeps retry and dismissal available for an operation failure", () => {
    const retry = vi.fn();
    render(host([{ ...failure, onRetry: retry }]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

  it("coordinates both panes and viewer notices through one host", () => {
    const retryLeft = vi.fn();
    const retryRight = vi.fn();
    render(
      <OperationNotificationProvider>
        <ViewerNotifications notices={[{ ...failure, id: "left", onRetry: retryLeft }]} />
        <ViewerNotifications notices={[{ ...failure, id: "right", message: "Right file missing", onRetry: retryRight }]} />
      </OperationNotificationProvider>
    );
    expect(document.querySelectorAll(".MuiSnackbar-root")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Right file missing");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryRight).toHaveBeenCalledOnce();
    expect(retryLeft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });

  it("deduplicates reports of one target while keeping another target distinct", () => {
    const sameTarget = { ...failure, failureKey: "same-target", targetLabel: "Demo: original.txt" };
    render(
      <OperationNotificationProvider>
        <ViewerNotifications notices={[sameTarget]} />
        <ViewerNotifications notices={[{ ...sameTarget, id: "duplicate" }]} />
        <ViewerNotifications notices={[{ ...failure, failureKey: "other-target", targetLabel: "Demo: other.txt" }]} />
      </OperationNotificationProvider>
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Demo: original.txt");
    fireEvent.click(screen.getByRole("button", { name: "Next notification (1)" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Demo: other.txt");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Demo: original.txt");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("expires failures without dismissing their underlying state", async () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const onNoticeDismiss = vi.fn();
      const { rerender } = render(<ViewerNotifications notices={[{ ...failure, onDismiss: onNoticeDismiss }]} onDismiss={onDismiss} />);
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(onNoticeDismiss).not.toHaveBeenCalled();
      rerender(<ViewerNotifications notices={[{ ...failure, onDismiss: onNoticeDismiss }]} onDismiss={onDismiss} />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      rerender(<ViewerNotifications notices={[{ ...failure, occurrence: 2 }]} onDismiss={onDismiss} />);
      expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { severity: "info" as const, duration: NOTICE_DURATION_MS.information },
    { severity: "warning" as const, duration: NOTICE_DURATION_MS.failure },
    { severity: "error" as const, duration: NOTICE_DURATION_MS.failure },
    { severity: "error" as const, duration: NOTICE_DURATION_MS.editor },
  ])("expires $severity notices after $duration ms", async ({ severity, duration }) => {
    vi.useFakeTimers();
    try {
      render(host([{ ...failure, severity, duration: duration === NOTICE_DURATION_MS.editor ? duration : undefined }]));
      await act(async () => vi.advanceTimersByTime(duration - 1));
      expect(screen.getByText(failure.message)).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps explicit operation controls until the notice becomes timed", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(host([{ ...warning, message: "Preparing files", persistent: true }]));
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(screen.getByText("Preparing files")).toBeInTheDocument();
      rerender(host([{ ...warning, message: "Ready to share", persistent: true }]));
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(screen.getByText("Ready to share")).toBeInTheDocument();
      rerender(host([{ ...warning, message: "Sharing files", severity: "info", persistent: false }]));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.information));
      expect(screen.queryByText("Sharing files")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a queued notice timer only when it becomes visible", async () => {
    vi.useFakeTimers();
    try {
      render(host([failure, { ...warning, severity: "info" }]));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.failure));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
      expect(screen.getByText(warning.message)).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.information - 1));
      expect(screen.getByText(warning.message)).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTime(1));
      expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["hover", "focus"])("pauses expiry during %s interaction", async (interaction) => {
    vi.useFakeTimers();
    try {
      render(host([failure]));
      const notice = screen.getByRole("alert");
      const close = screen.getByRole("button", { name: "Close" });
      if (interaction === "hover") fireEvent.mouseEnter(notice);
      else act(() => close.focus());
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.failure * 2));
      expect(screen.getByText(failure.message)).toBeInTheDocument();
      if (interaction === "hover") fireEvent.mouseLeave(notice);
      else act(() => close.blur());
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.failure));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart a timer when only the message updates", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(host([{ ...warning, severity: "info", message: "Sharing one file" }]));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.information / 2));
      rerender(host([{ ...warning, severity: "info", message: "Sharing two files" }]));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.information / 2));
      expect(screen.queryByText("Sharing two files")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call shared owners on expiry but calls them on explicit dismissal", async () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      const onNoticeDismiss = vi.fn();
      const view = (occurrence: number) => (
        <OperationNotificationProvider>
          <ViewerNotifications notices={[{ ...failure, occurrence, onDismiss: onNoticeDismiss }]} onDismiss={onDismiss} />
        </OperationNotificationProvider>
      );
      const { rerender } = render(view(1));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.failure));
      expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(onNoticeDismiss).not.toHaveBeenCalled();
      rerender(view(2));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(onNoticeDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only runs explicit expiry cleanup and permits a later identical result", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const onDismiss = vi.fn();
      const result = { ...warning, severity: "info" as const, onExpire, onDismiss };
      const { rerender } = render(host([result]));
      await act(async () => vi.advanceTimersByTime(NOTICE_DURATION_MS.information));
      expect(onExpire).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      rerender(host([]));
      rerender(host([result]));
      expect(screen.getByText(result.message)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(onExpire).toHaveBeenCalledOnce();
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps actions active inside a suspended nested media dialog", async () => {
    render(
      <OperationNotificationProvider>
        <ViewerNotifications notices={[failure]} />
        <div role="dialog" aria-label="Viewer">
          <div role="dialog" aria-label="Lightbox" style={{ pointerEvents: "none" }} />
        </div>
      </OperationNotificationProvider>
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").closest('[role="dialog"]')).toBe(screen.getByRole("dialog", { name: "Lightbox" }))
    );
    expect(screen.getByRole("alert").closest(".MuiSnackbar-root")).toHaveStyle({ pointerEvents: "auto" });
  });

  it("moves actions into the top dialog without reviving dismissed notices", async () => {
    const view = (modal: boolean) => (
      <OperationNotificationProvider>
        <ViewerNotifications notices={[failure, warning]} />
        {modal && (
          <div role="dialog" aria-label="Settings">
            <button type="button">Settings action</button>
          </div>
        )}
      </OperationNotificationProvider>
    );
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerender(view(true));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("status")).toHaveTextContent(warning.message));
    expect(screen.queryByText(failure.message)).not.toBeInTheDocument();
    within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }).focus();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" })).toHaveFocus();
  });
});
