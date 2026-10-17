import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeSharing } from "../../components/Sharing/useNativeSharing";
import { useViewerSharing } from "../useViewerSharing";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared viewer sharing", () => {
  it("retains valid prepared bytes across availability changes but invalidates a saved-file version", async () => {
    const saved = new File(["saved"], "note.txt");
    const updated = new File(["updated"], "note.txt");
    const loadFile = vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce(updated);
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    const { result, rerender } = renderHook(
      ({ enabled, identity }) => useViewerSharing({ entryPoint: "text", identity, enabled, loadFile }),
      { initialProps: { enabled: true, identity: "version-one" } }
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ enabled: false, identity: "version-one" });
    expect(result.current.ready).toBe(false);
    rerender({ enabled: true, identity: "version-one" });
    expect(result.current.ready).toBe(true);
    expect(loadFile).toHaveBeenCalledTimes(1);
    act(() => result.current.shareFile());
    expect(share).toHaveBeenLastCalledWith({ files: [saved] });
    await waitFor(() => expect(result.current.sharing).toBe(false));
    rerender({ enabled: false, identity: "version-two" });
    rerender({ enabled: true, identity: "version-two" });
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.shareFile());
    expect(share).toHaveBeenLastCalledWith({ files: [updated] });
    expect(loadFile).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.sharing).toBe(false));
  });

  it("aborts pending work when unavailable and ignores its completion after re-enabling", async () => {
    let resolveOld: (file: File) => void = () => {};
    const activeFile = new File(["active"], "note.txt");
    const loadFile = vi
      .fn<(signal: AbortSignal) => Promise<File>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue(activeFile);
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    const { result, rerender } = renderHook(({ enabled }) => useViewerSharing({ entryPoint: "text", identity: "one", enabled, loadFile }), {
      initialProps: { enabled: true },
    });
    const signal = loadFile.mock.calls[0]?.[0];
    rerender({ enabled: false });
    expect(signal?.aborted).toBe(true);
    expect(result.current.preparing).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => resolveOld(new File(["stale"], "note.txt")));
    expect(share).not.toHaveBeenCalled();
    act(() => result.current.shareFile());
    expect(share).toHaveBeenLastCalledWith({ files: [activeFile] });
    await waitFor(() => expect(result.current.sharing).toBe(false));
  });

  it("retains failure details across action visibility changes but clears them for a new source", async () => {
    vi.stubGlobal("navigator", { share: vi.fn().mockRejectedValue(new DOMException("private", "NotAllowedError")) });
    const file = new File(["saved"], "file.txt");
    function Harness({ enabled, identity }: { enabled: boolean; identity: string }) {
      const sharing = useViewerSharing({ entryPoint: "text", identity, enabled, file });
      return (
        <>
          <button type="button" onClick={sharing.shareFile}>
            Attempt
          </button>
          {sharing.failureDialog}
        </>
      );
    }
    const { rerender } = render(<Harness enabled={true} identity="one" />);
    fireEvent.click(screen.getByText("Attempt"));
    fireEvent.click(await screen.findByRole("button", { name: "viewer.share.detailsAction" }));
    await screen.findByText(/"reason": "NotAllowedError"/);
    rerender(<Harness enabled={false} identity="one" />);
    expect(screen.getByText(/"reason": "NotAllowedError"/)).not.toBeNull();
    rerender(<Harness enabled={false} identity="two" />);
    await waitFor(() => expect(screen.queryByText(/"reason": "NotAllowedError"/)).toBeNull());
  });

  it("offers preparation retry without automatically opening the native share sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    const loadFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("private download failure"))
      .mockResolvedValue(new File(["saved"], "file.txt"));
    function Harness() {
      const sharing = useViewerSharing({ entryPoint: "text", identity: "one", enabled: true, loadFile });
      return (
        <>
          {sharing.ready ? "ready" : "pending"}
          {sharing.failureDialog}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "common.actions.retry" }));
    await screen.findByText("ready");
    expect(share).not.toHaveBeenCalled();
    expect(loadFile).toHaveBeenCalledTimes(2);
  });

  it("aborts preparation on close and ignores late completion", async () => {
    let finish: (file: File) => void = () => {};
    const loadFile = vi.fn(
      (signal: AbortSignal) =>
        new Promise<File>((resolve) => {
          finish = resolve;
          expect(signal.aborted).toBe(false);
        })
    );
    const { unmount } = renderHook(() => useViewerSharing({ entryPoint: "text", identity: "one", enabled: true, loadFile }));
    const signal = loadFile.mock.calls[0]?.[0];
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(new File(["late"], "late.txt")));
  });
  it("prepares without network hints and invokes synchronously from the next action", async () => {
    const file = new File(["saved"], "note.txt", { type: "text/plain" });
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true, connection: { saveData: true, effectiveType: "2g" } });
    const loadFile = vi.fn().mockResolvedValue(file);
    const { result } = renderHook(() => useViewerSharing({ entryPoint: "text", identity: "one", enabled: true, loadFile }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(share).not.toHaveBeenCalled();
    act(() => {
      result.current.shareFile();
      expect(share).toHaveBeenCalledExactlyOnceWith({ files: [file], title: "note.txt" });
    });
    await waitFor(() => expect(result.current.sharing).toBe(false));
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  it("ignores stale preparation and keeps text independent of attachment readiness", async () => {
    let resolveOld: (file: File) => void = () => {};
    const loadFile = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<File>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValue(new File(["new"], "new.txt"));
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share });
    const { result, rerender } = renderHook(({ identity }) => useViewerSharing({ entryPoint: "text", identity, enabled: true, loadFile }), {
      initialProps: { identity: "one" },
    });
    act(() => result.current.shareText("unsaved"));
    expect(share).toHaveBeenCalledExactlyOnceWith({ text: "unsaved" });
    rerender({ identity: "two" });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => resolveOld(new File(["old"], "old.txt")));
    act(() => result.current.shareFile());
    expect(share).toHaveBeenLastCalledWith({ files: [expect.objectContaining({ name: "new.txt" })] });
    await waitFor(() => expect(result.current.sharing).toBe(false));
  });

  it("uses displayed files directly and invalidates on replacement", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    const file = new File(["normalized document"], "document.pdf", { type: "application/pdf" });
    const { result, rerender } = renderHook(
      ({ file }: { file: File | null }) => useViewerSharing({ entryPoint: "pdf", identity: "one", enabled: true, file }),
      { initialProps: { file: file as File | null } }
    );
    act(() => result.current.shareFile());
    expect(share).toHaveBeenCalledWith({ files: [file], title: file.name });
    await waitFor(() => expect(result.current.sharing).toBe(false));
    rerender({ file: null });
    expect(result.current.ready).toBe(false);
    act(() => result.current.shareFile());
    expect(share).toHaveBeenCalledTimes(1);
  });
});

function SharingHarness() {
  const sharing = useNativeSharing("image", "displayed-resource");
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void sharing.invoke({ file: new File(["secret bytes"], "private.png", { type: "image/png" }), title: "secret title" })
        }
      >
        Attempt
      </button>
      {sharing.failureDialog}
    </>
  );
}

describe("sharing failure details", () => {
  it.each(["missing", "rejected"])("retains selectable details when clipboard is %s", async (clipboardState) => {
    const clipboard = clipboardState === "missing" ? undefined : { writeText: vi.fn().mockRejectedValue(new Error("denied")) };
    vi.stubGlobal("navigator", { share: vi.fn().mockRejectedValue(new Error("private")), clipboard });
    render(<SharingHarness />);
    fireEvent.click(screen.getByText("Attempt"));
    fireEvent.click(await screen.findByRole("button", { name: "viewer.share.detailsAction" }));
    const report = await screen.findByText(/"reason": "share-rejected"/);
    expect(report.tagName).toBe("PRE");
    if (clipboardState === "missing") {
      expect(screen.queryByRole("button", { name: "viewer.share.copyDetails" })).toBeNull();
    } else {
      fireEvent.click(screen.getByRole("button", { name: "viewer.share.copyDetails" }));
      await screen.findByText("viewer.share.copyError");
      expect(screen.getByText(/"reason": "share-rejected"/).textContent).toBe(report.textContent);
    }
  });
  it("reveals only sanitized evidence on request and copies exactly the report", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockRejectedValue(new DOMException("private.png https://private.example/token secret bytes", "NotAllowedError"));
    vi.stubGlobal("navigator", { share, canShare, clipboard: { writeText } });
    render(<SharingHarness />);
    fireEvent.click(screen.getByText("Attempt"));
    await screen.findByText("viewer.share.failed");
    expect(screen.queryByText(/NotAllowedError/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "viewer.share.detailsAction" }));
    const report = await screen.findByText(/"reason": "NotAllowedError"/);
    expect(report.textContent).not.toMatch(/private|secret|token/);
    fireEvent.click(screen.getByRole("button", { name: "viewer.share.copyDetails" }));
    expect(writeText).toHaveBeenCalledWith(report.textContent);
    await screen.findByText("viewer.share.copySuccess");
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation silent", async () => {
    vi.stubGlobal("navigator", { share: vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError")) });
    render(<SharingHarness />);
    fireEvent.click(screen.getByText("Attempt"));
    await act(async () => {});
    expect(screen.queryByText("viewer.share.failed")).toBeNull();
  });
});
