import { act, cleanup, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewerDocumentTitle } from "../useViewerDocumentTitle";

let previousTitle: string;

beforeEach(() => {
  previousTitle = document.title;
  document.title = "Sambee";
});

afterEach(() => {
  cleanup();
  document.title = previousTitle;
  vi.restoreAllMocks();
});

describe("viewer document titles", () => {
  it.each([
    { filename: "note.md", printTitle: "note" },
    { filename: "report.v2.PDF", printTitle: "report.v2" },
    { filename: ".notes.md", printTitle: ".notes" },
    { filename: ".notes", printTitle: ".notes" },
    { filename: "README", printTitle: "README" },
  ])("uses $filename in the tab and $printTitle during native printing", ({ filename, printTitle }) => {
    const { unmount } = renderHook(() => useViewerDocumentTitle(filename));
    expect(document.title).toBe(filename);
    act(() => window.dispatchEvent(new Event("beforeprint")));
    act(() => window.dispatchEvent(new Event("beforeprint")));
    expect(document.title).toBe(printTitle);
    act(() => window.dispatchEvent(new Event("afterprint")));
    expect(document.title).toBe(filename);
    unmount();
    expect(document.title).toBe("Sambee");
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("afterprint"));
    expect(document.title).toBe("Sambee");
  });

  it("updates the title when the active file changes, including during print", () => {
    const { rerender, unmount } = renderHook(({ filename }) => useViewerDocumentTitle(filename), {
      initialProps: { filename: "first.png" },
    });
    act(() => window.dispatchEvent(new Event("beforeprint")));
    rerender({ filename: "second.jpg" });
    expect(document.title).toBe("second.jpg");
    act(() => window.dispatchEvent(new Event("beforeprint")));
    expect(document.title).toBe("second");
    unmount();
    expect(document.title).toBe("Sambee");
  });

  it.each([false, true])("restores the filename after toolbar printing (failure: %s)", (fails) => {
    const failure = new Error("Printing blocked");
    vi.spyOn(window, "print").mockImplementation(() => {
      expect(document.title).toBe("note");
      if (fails) throw failure;
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    });
    const { result } = renderHook(() => useViewerDocumentTitle("note.md"));
    if (fails) expect(() => result.current()).toThrow(failure);
    else act(() => result.current());
    expect(document.title).toBe("note.md");
  });

  it("keeps the short title until afterprint when the print dialog opens asynchronously", () => {
    vi.spyOn(window, "print").mockImplementation(() => {});
    const { result } = renderHook(() => useViewerDocumentTitle("note.md"));
    act(() => result.current());
    expect(document.title).toBe("note");
    act(() => window.dispatchEvent(new Event("beforeprint")));
    expect(document.title).toBe("note");
    act(() => window.dispatchEvent(new Event("afterprint")));
    expect(document.title).toBe("note.md");
  });

  it("does not overwrite a title changed by another owner", () => {
    const { unmount } = renderHook(() => useViewerDocumentTitle("note.md"));
    document.title = "Another page";
    act(() => window.dispatchEvent(new Event("beforeprint")));
    act(() => window.dispatchEvent(new Event("afterprint")));
    unmount();
    expect(document.title).toBe("Another page");
  });

  it("restores the original title after Strict Mode effect replay", () => {
    const { unmount } = renderHook(() => useViewerDocumentTitle("note.md"), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });
    expect(document.title).toBe("note.md");
    unmount();
    expect(document.title).toBe("Sambee");
  });
});
