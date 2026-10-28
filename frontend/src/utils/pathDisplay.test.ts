import { afterEach, describe, expect, it, vi } from "vitest";
import { abbreviateFileName, abbreviatePath, truncateTextByGrapheme } from "./pathDisplay";

const measureCharacters = (text: string) => text.length;

describe("abbreviatePath", () => {
  it("preserves a connection prefix and basename while collapsing ancestors", () => {
    expect(abbreviatePath("Demo:/Users/sambee/Projects/Archive/report.pdf", 20, measureCharacters)).toBe("Demo:/.../report.pdf");
  });

  it("preserves a spaced connection prefix while collapsing ancestors", () => {
    expect(abbreviatePath("Demo: /Users/sambee/Projects/Archive/report.pdf", 21, measureCharacters)).toBe("Demo: /.../report.pdf");
  });

  it("keeps an omission indicator when only the connection and basename fit", () => {
    expect(abbreviatePath("Demo:/Test/Test dir", 17, measureCharacters)).toBe("Demo:/...Test dir");
  });

  it("leaves a path unchanged when it fits", () => {
    expect(abbreviatePath("Demo:/Test/report.pdf", 100, measureCharacters)).toBe("Demo:/Test/report.pdf");
  });

  it("retains a terminal filename suffix when it cannot fit in full", () => {
    expect(abbreviatePath("/Users/sambee/very-long-report.pdf", 14, measureCharacters)).toBe("...-report.pdf");
  });
});

describe("abbreviateFileName", () => {
  it("preserves the filename prefix and final extension", () => {
    expect(abbreviateFileName("annual-report-final.pdf", 18, measureCharacters)).toBe("annual-repor...pdf");
  });

  it("does not treat a dotfile as having an extension", () => {
    expect(abbreviateFileName(".gitignore", 7, measureCharacters)).toBe(".git...");
  });

  it("does not split a Unicode grapheme cluster", () => {
    expect(abbreviateFileName("report-e\u0301-final.txt", 15, measureCharacters)).toBe("report-e\u0301...txt");
  });

  it("does not split a ZWJ emoji sequence when Intl.Segmenter is unavailable", () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });

    expect(abbreviateFileName("👩‍💻-annual-report.txt", 8, measureCharacters)).toBe("...txt");
  });
});

describe("truncateTextByGrapheme", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the shared grapheme-aware breadcrumb truncation", () => {
    expect(truncateTextByGrapheme("report-e\u0301-final", 9)).toBe("report-e\u0301…");
  });
});
