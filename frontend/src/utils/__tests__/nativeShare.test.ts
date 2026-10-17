import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDisplayedShareFile,
  createShareFile,
  shareNativeContent,
  shouldWarmNativeSharePayload,
  supportsNativeShare,
} from "../nativeShare";

const originalNavigator = globalThis.navigator;

function setNavigatorMock(mockNavigator: Partial<Navigator>) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: mockNavigator,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: originalNavigator,
  });
  vi.restoreAllMocks();
});

describe("nativeShare", () => {
  it("reports absent API without attempting preflight", async () => {
    const canShare = vi.fn();
    const onDiagnostic = vi.fn();
    setNavigatorMock({ canShare });
    expect(await shareNativeContent({ file: new File(["saved"], "private.txt"), onDiagnostic })).toBe("unsupported");
    expect(canShare).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "api-unavailable", invoked: false }));
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private.txt");
  });

  it("uses the actual converted format without changing displayed content", () => {
    const file = createDisplayedShareFile(new Blob(["displayed PNG"], { type: "image/png" }), "photo.heic");
    expect(file).toMatchObject({ name: "photo.png", type: "image/png", size: 13 });
    expect(createDisplayedShareFile(new Blob(["jpeg"], { type: "image/jpeg" }), "photo.jpeg").name).toBe("photo.jpeg");
    expect(createShareFile(new Blob(["saved"], { type: "application/octet-stream; charset=utf-8" }), "note.txt").type).toBe("text/plain");
    expect(createShareFile(new Blob(["unknown"]), "file.unknown").type).toBe("application/octet-stream");
  });

  it("shares explicit text without file preflight", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn();
    setNavigatorMock({ share, canShare });
    expect(await shareNativeContent({ text: "unsaved markdown" })).toBe("shared");
    expect(share).toHaveBeenCalledExactlyOnceWith({ text: "unsaved markdown" });
    expect(canShare).not.toHaveBeenCalled();
  });

  it("reports actual rejection after positive preflight without retrying", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("private path /secrets", "NotAllowedError"));
    const onDiagnostic = vi.fn();
    setNavigatorMock({ share, canShare: () => true });
    await expect(shareNativeContent({ files: [new File(["secret"], "private.md")], onDiagnostic })).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    expect(share).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "NotAllowedError", preflight: "accepted", invoked: true }));
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|secret/);
  });

  it("attempts every attachment once when preflight throws and records safe evidence", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const onDiagnostic = vi.fn();
    setNavigatorMock({
      share,
      canShare: () => {
        throw new TypeError("private filename and token");
      },
    });
    const files = [new File(["one"], "one.txt"), new File(["two"], "two.md")];
    expect(await shareNativeContent({ files, title: "private", onDiagnostic })).toBe("shared");
    expect(share).toHaveBeenCalledExactlyOnceWith({ files });
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ preflight: "thrown", preflightError: "TypeError", reason: "api-completed" })
    );
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|token/);
  });
  it("reports whether native share is supported", () => {
    setNavigatorMock({ share: vi.fn() as unknown as Navigator["share"] });

    expect(supportsNativeShare()).toBe(true);
  });

  it("skips warming when save-data is enabled", () => {
    setNavigatorMock({
      share: vi.fn() as unknown as Navigator["share"],
      connection: { saveData: true },
    } as Partial<Navigator>);

    expect(shouldWarmNativeSharePayload()).toBe(false);
  });

  it("skips warming on slow connection hints", () => {
    setNavigatorMock({
      share: vi.fn() as unknown as Navigator["share"],
      connection: { effectiveType: "3g" },
    } as Partial<Navigator>);

    expect(shouldWarmNativeSharePayload()).toBe(false);
  });

  it("allows warming when no constrained-network hint is present", () => {
    setNavigatorMock({
      share: vi.fn() as unknown as Navigator["share"],
      connection: { effectiveType: "4g", saveData: false },
    } as Partial<Navigator>);

    expect(shouldWarmNativeSharePayload()).toBe(true);
  });

  it("creates a File with the blob type", () => {
    const file = createShareFile(new Blob(["hello"], { type: "text/plain" }), "hello.txt");

    expect(file.name).toBe("hello.txt");
    expect(file.type).toBe("text/plain");
  });

  it("uses the listed MIME type when raw content lacks one", () => {
    expect(createShareFile(new Blob(["hello"]), "hello.txt", "text/plain").type).toBe("text/plain");
  });

  it("uses the listed MIME type when the raw download is generic", () => {
    const rawBlob = new Blob(["%PDF-1.4"], { type: "application/octet-stream" });
    expect(createShareFile(rawBlob, "document.pdf", "application/pdf").type).toBe("application/pdf");
  });

  it.each(["", "application/octet-stream; charset=utf-8"])("ignores generic listed metadata for a %s download", (type) => {
    const blob = new Blob(["saved bytes"], { type });
    expect(createShareFile(blob, "note.txt", " Application/Octet-Stream; charset=utf-8 ").type).toBe("text/plain");
    expect(createShareFile(blob, "file.unknown", "application/octet-stream").type).toBe("application/octet-stream");
    expect(createShareFile(blob, "note.txt", "text/markdown; charset=utf-8").type).toBe("text/markdown");
  });

  it("prefers the actual representation MIME type over listed metadata and extensions", () => {
    expect(createShareFile(new Blob(["PNG bytes"], { type: "image/png" }), "photo.heic", "image/heic").type).toBe("image/png");
  });

  it("shares files when file sharing is supported", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    setNavigatorMock({
      share: share as unknown as Navigator["share"],
      canShare: canShare as unknown as Navigator["canShare"],
    });

    const file = createShareFile(new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const result = await shareNativeContent({ file, title: "hello.txt" });

    expect(result).toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(share).toHaveBeenCalledWith({ files: [file], title: "hello.txt" });
  });

  it("shares multiple original files in one invocation", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    setNavigatorMock({ share, canShare } as Partial<Navigator>);

    const files = [createShareFile(new Blob(["first"]), "first.txt"), createShareFile(new Blob(["second"]), "second.txt")];
    expect(await shareNativeContent({ files })).toBe("shared");
    expect(canShare).toHaveBeenCalledWith({ files });
    expect(share).toHaveBeenCalledWith({ files });
  });

  it("never falls back to text when a file-only share is unsupported", async () => {
    const share = vi.fn();
    setNavigatorMock({ share, canShare: vi.fn().mockReturnValue(false) } as Partial<Navigator>);

    const files = [createShareFile(new Blob(["first"]), "first.txt")];
    expect(await shareNativeContent({ files, title: "first.txt" })).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });

  it("never replaces a singular attachment with text when preflight rejects it", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(false);
    setNavigatorMock({
      share: share as unknown as Navigator["share"],
      canShare: canShare as unknown as Navigator["canShare"],
    });

    const file = createShareFile(new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const result = await shareNativeContent({ file, title: "hello.txt", text: "hello" });

    expect(result).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });

  it.each(["missing", "throwing"])("attempts attachments only when preflight is %s", async (condition) => {
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorMock({
      share,
      ...(condition === "throwing"
        ? {
            canShare: () => {
              throw new Error("preflight");
            },
          }
        : {}),
    });
    const file = createShareFile(new Blob(["hello"]), "hello.txt");
    expect(await shareNativeContent({ file, title: "hello.txt", text: "hello", url: "https://example.com" })).toBe("shared");
    expect(share).toHaveBeenCalledExactlyOnceWith({ files: [file] });
  });

  it("normalizes MIME parameters without changing bytes", () => {
    const file = createShareFile(new Blob(["hello"], { type: "text/plain; charset=utf-8" }), "hello.txt");
    expect(file.type).toBe("text/plain");
    expect(file.size).toBe(5);
  });

  it("returns unsupported when no shareable data remains", async () => {
    const share = vi.fn();
    const canShare = vi.fn().mockReturnValue(false);
    setNavigatorMock({
      share: share as unknown as Navigator["share"],
      canShare: canShare as unknown as Navigator["canShare"],
    });

    const file = createShareFile(new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const result = await shareNativeContent({ file });

    expect(result).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
  });

  it("treats user cancellation as a non-error outcome", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const canShare = vi.fn().mockReturnValue(true);
    setNavigatorMock({
      share: share as unknown as Navigator["share"],
      canShare: canShare as unknown as Navigator["canShare"],
    });

    const file = createShareFile(new Blob(["hello"], { type: "text/plain" }), "hello.txt");
    const result = await shareNativeContent({ file });

    expect(result).toBe("cancelled");
  });
});
