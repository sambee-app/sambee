import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../i18n";
import { DoneEditingWindow, DoneEditingWindowView } from "../DoneEditingWindow";

const HOLD_DURATION_MS = 1500;
const DONE_EDITING_DEFAULT_HEIGHT = 200;
const DONE_EDITING_EXPANDED_HEIGHT = 240;

const { invokeMock, listenHandlers, setSizeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  setSizeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((eventName: string, callback: (event: { payload: unknown }) => void) => {
    listenHandlers.set(eventName, callback);
    return Promise.resolve(() => {
      listenHandlers.delete(eventName);
    });
  }),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    width: number;
    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "done-editing-test",
    setSize: setSizeMock,
  }),
}));

function emitEvent<TPayload>(eventName: string, payload: TPayload) {
  const handler = listenHandlers.get(eventName);

  if (!handler) {
    throw new Error(`Missing listener for ${eventName}`);
  }

  act(() => {
    handler({ payload });
  });
}

describe("DoneEditingWindow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenHandlers.clear();
    setSizeMock.mockReset();
    setSizeMock.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await setLocale("en");
  });

  it("renders translated modified-state UI and uploads after a completed hold", async () => {
    await setLocale("en-XA");

    invokeMock.mockImplementation((command: string) => {
      if (command === "get_done_editing_context") {
        return Promise.resolve({
          operation_id: "edit-1",
          filename: "report.docx",
          app_name: "LibreOffice Writer",
          server_url: "https://sambee.example.test",
        });
      }

      if (command === "finish_editing") {
        return Promise.resolve({ status: "completed" });
      }

      return Promise.resolve(undefined);
    });

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) =>
        window.setTimeout(() => {
          now = HOLD_DURATION_MS;
          callback(now);
        }, 16)
      )
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((handle: number) => {
        window.clearTimeout(handle);
      })
    );

    render(<DoneEditingWindow />);

    await waitFor(() => {
      expect(screen.getByText("✎ report.docx")).toBeInTheDocument();
    });

    expect(setSizeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 340, height: DONE_EDITING_DEFAULT_HEIGHT }));

    const initialDoneButton = screen.getByText(translate("doneEditing.buttons.doneClose")).closest("button");

    expect(initialDoneButton).not.toBeNull();
    expect(initialDoneButton).toHaveFocus();

    expect(screen.getByText(translate("doneEditing.openedIn", { appName: "LibreOffice Writer" }))).toBeInTheDocument();

    emitEvent("file-status", {
      kind: "modified",
      modifiedAt: "12:34:56",
    });

    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent === `${translate("doneEditing.statusLabel")} ${translate("doneEditing.modifiedAt", { time: "12:34:56" })}`
      )
    ).toBeInTheDocument();
    expect(screen.getByText(translate("doneEditing.buttons.discardHold"))).toBeInTheDocument();

    await waitFor(() => {
      expect(setSizeMock).toHaveBeenCalledWith(expect.objectContaining({ width: 340, height: DONE_EDITING_EXPANDED_HEIGHT }));
    });

    await waitFor(() => {
      expect(screen.getByText(translate("doneEditing.buttons.doneUpload"))).toBeInTheDocument();
    });

    const doneButton = screen.getByText(translate("doneEditing.buttons.doneUpload")).closest("button");

    expect(doneButton).not.toBeNull();

    fireEvent.mouseDown(doneButton!);
    vi.advanceTimersByTime(16);

    expect(invokeMock).not.toHaveBeenCalledWith("finish_editing", { operationId: "edit-1" });

    fireEvent.mouseUp(doneButton!);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("finish_editing", { operationId: "edit-1" });
    });

    emitEvent("upload-progress", { progress: 0.42 });

    const uploadProgress = screen.getByRole("progressbar", { name: translate("doneEditing.aria.uploadProgress") });
    expect(uploadProgress).toHaveAttribute("aria-valuenow", "42");
  });

  it("shows an explicit retry state after reauthentication refreshes upload auth", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_done_editing_context") {
        return Promise.resolve({
          operation_id: "edit-2",
          filename: "report.docx",
          app_name: "LibreOffice Writer",
          server_url: "https://sambee.example.test",
        });
      }

      if (command === "finish_editing") {
        return Promise.resolve({ status: "auth_retry", reason: "upload" });
      }

      return Promise.resolve(undefined);
    });

    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) =>
        window.setTimeout(() => {
          now = HOLD_DURATION_MS;
          callback(now);
        }, 16)
      )
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((handle: number) => {
        window.clearTimeout(handle);
      })
    );

    render(<DoneEditingWindow />);

    await waitFor(() => {
      expect(screen.getByText("✎ report.docx")).toBeInTheDocument();
    });

    emitEvent("file-status", {
      kind: "modified",
      modifiedAt: "12:34:56",
    });

    await waitFor(() => {
      expect(screen.getByText(translate("doneEditing.buttons.doneUpload"))).toBeInTheDocument();
    });

    const doneButton = screen.getByText(translate("doneEditing.buttons.doneUpload")).closest("button");
    expect(doneButton).not.toBeNull();

    fireEvent.mouseDown(doneButton!);
    vi.advanceTimersByTime(16);
    fireEvent.mouseUp(doneButton!);

    await waitFor(() => {
      expect(screen.getByText(translate("doneEditing.authRefreshedRetryUpload"))).toBeInTheDocument();
    });

    expect(screen.getByText(translate("doneEditing.buttons.retryUpload"))).toBeInTheDocument();
  });

  it("uses a clickable primary action when reopen in Sambee is required", () => {
    const onPrimaryClick = vi.fn();

    render(
      <DoneEditingWindowView
        context={{
          operation_id: "edit-3",
          filename: "report.docx",
          app_name: "LibreOffice Writer",
          server_url: "https://sambee.example.test",
        }}
        fileStatus={{ kind: "modified", modifiedAt: "12:34:56" }}
        processing={false}
        uploadProgress={0}
        notice={null}
        error={translate("doneEditing.lifecycle.renewalRequired", { message: "renew now" })}
        conflict={null}
        holdProgress={0}
        discardHoldProgress={0}
        doneButtonLabel={translate("doneEditing.buttons.reopenRequired")}
        doneAriaLabel={translate("doneEditing.aria.reopenInBrowser")}
        discardAriaLabel={translate("doneEditing.aria.discardChanges", { seconds: HOLD_DURATION_MS / 1000 })}
        doneHandlers={{}}
        discardHandlers={{}}
        onPrimaryClick={onPrimaryClick}
        onConflictResolved={() => undefined}
      />
    );

    expect(setSizeMock).not.toHaveBeenCalled();

    const reopenButton = screen.getByRole("button", { name: translate("doneEditing.aria.reopenInBrowser") });
    expect(reopenButton).toHaveTextContent(translate("doneEditing.buttons.reopenRequired"));

    fireEvent.click(reopenButton);

    expect(onPrimaryClick).toHaveBeenCalledTimes(1);
  });
});
