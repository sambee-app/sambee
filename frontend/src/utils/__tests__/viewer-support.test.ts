import { describe, expect, it } from "vitest";
import {
  getCompatibleViewerIds,
  getFileTypesByCategory,
  hasViewerSupport,
  isImageFile,
  requiresServerImageConversion,
} from "../FileTypeRegistry";
import { languages } from "../fileLanguages";

describe("hasViewerSupport", () => {
  it("returns true for image formats", () => {
    expect(hasViewerSupport("image/png")).toBe(true);
    expect(hasViewerSupport("image/jpeg")).toBe(true);
    expect(hasViewerSupport("image/gif")).toBe(true);
    expect(hasViewerSupport("image/webp")).toBe(true);
    expect(hasViewerSupport("image/svg+xml")).toBe(true);
  });

  it("returns true for advanced image formats", () => {
    expect(hasViewerSupport("image/vnd.adobe.photoshop")).toBe(true); // PSD
    expect(hasViewerSupport("application/postscript")).toBe(true); // EPS/AI
    expect(hasViewerSupport("image/x-eps")).toBe(true); // EPS
    expect(hasViewerSupport("image/tiff")).toBe(true); // TIFF
  });

  it("returns true for markdown", () => {
    expect(hasViewerSupport("text/markdown")).toBe(true);
  });

  it("returns true for common text and code formats", () => {
    expect(hasViewerSupport("text/plain")).toBe(true);
    expect(hasViewerSupport("application/json")).toBe(true);
    expect(hasViewerSupport("text/html")).toBe(true);
    expect(hasViewerSupport("text/css")).toBe(true);
  });

  it("returns true for PDF", () => {
    expect(hasViewerSupport("application/pdf")).toBe(true);
  });

  it("returns false for unknown MIME types", () => {
    expect(hasViewerSupport("application/octet-stream")).toBe(false);
    expect(hasViewerSupport("application/x-unknown")).toBe(false);
  });

  it("returns false for document formats without view", () => {
    expect(hasViewerSupport("application/msword")).toBe(false);
    expect(hasViewerSupport("application/vnd.ms-excel")).toBe(false);
  });
});

describe("isImageFile", () => {
  it("returns true for AI files", () => {
    expect(isImageFile("document.ai")).toBe(true);
    expect(isImageFile("logo.AI")).toBe(true);
  });

  it("returns true for EPS files", () => {
    expect(isImageFile("graphic.eps")).toBe(true);
    expect(isImageFile("vector.EPS")).toBe(true);
  });

  it("returns true for PSD files", () => {
    expect(isImageFile("design.psd")).toBe(true);
    expect(isImageFile("layer.psb")).toBe(true);
  });

  it("returns true for standard image formats", () => {
    expect(isImageFile("photo.jpg")).toBe(true);
    expect(isImageFile("icon.png")).toBe(true);
    expect(isImageFile("animation.gif")).toBe(true);
  });

  it("returns false for non-image files", () => {
    expect(isImageFile("document.pdf")).toBe(false);
    expect(isImageFile("spreadsheet.xlsx")).toBe(false);
    expect(isImageFile("text.txt")).toBe(false);
  });
});

describe("requiresServerImageConversion", () => {
  it("identifies formats that cannot be previewed from local raw bytes", () => {
    expect(requiresServerImageConversion("photo.jxl")).toBe(true);
    expect(requiresServerImageConversion("design.psd")).toBe(true);
    expect(requiresServerImageConversion("scan.tiff")).toBe(true);
  });

  it("leaves browser-native images eligible for raw local preview", () => {
    expect(requiresServerImageConversion("photo.jpg")).toBe(false);
    expect(requiresServerImageConversion("diagram.png")).toBe(false);
    expect(requiresServerImageConversion("animation.webp")).toBe(false);
  });
});

describe("getCompatibleViewerIds", () => {
  it("falls back to the extension when MIME metadata is too generic for markdown", () => {
    expect(getCompatibleViewerIds("notes.MD", "text/plain")).toEqual(["markdown"]);
  });

  it("routes common text and code files to the text viewer", () => {
    expect(getCompatibleViewerIds("notes.txt", "text/plain")).toEqual(["text"]);
    expect(getCompatibleViewerIds("app.ts", "application/octet-stream")).toEqual(["text"]);
    expect(getCompatibleViewerIds("index.html", "text/html")).toEqual(["text"]);
    expect(getCompatibleViewerIds("styles.css", "text/css")).toEqual(["text"]);
  });

  it("does not route mp4 files to the text viewer", () => {
    expect(getCompatibleViewerIds("clip.mp4", "video/mp4")).toEqual([]);
  });

  it("routes every language extension to text except dedicated viewers", () => {
    const dedicatedViewers = new Map([
      ["md", "markdown"],
      ["markdown", "markdown"],
      ["svg", "image"],
    ]);
    for (const language of languages) {
      for (const extension of language.extensions) {
        const expected = dedicatedViewers.get(extension.toLowerCase()) ?? "text";
        for (const variant of [extension.toLowerCase(), extension.toUpperCase()]) {
          expect(getCompatibleViewerIds(`example.${variant}`, "application/octet-stream"), `${language.name}: ${variant}`).toEqual([
            expected,
          ]);
        }
      }
    }
  });

  it.each(["Dockerfile", "BUILD", "Gemfile", "CMakeLists.txt", "extensions.conf", "EXTENSIONS.CONF", "nginx.conf", "NGINX.CONF"])(
    "routes special filename %s to text",
    (filename) => {
      expect(getCompatibleViewerIds(filename, "application/octet-stream")).toEqual(["text"]);
    }
  );

  it.each(["dockerfile", "build", "gemfile", "example.unknown", "", "example."])(
    "does not automatically open unmatched filename %s as text",
    (filename) => {
      expect(getCompatibleViewerIds(filename, "text/plain")).toEqual([]);
    }
  );

  it.each(["txt", "conf", "log", "env", "bat", "cmd"])("retains plain text support for .%s", (extension) => {
    expect(getCompatibleViewerIds(`example.${extension}`, "text/plain")).toEqual(["text"]);
  });

  it("preserves dedicated viewers and specific MIME precedence", () => {
    expect(getCompatibleViewerIds("diagram.svg", "application/octet-stream")).toEqual(["image"]);
    expect(getCompatibleViewerIds("report.pdf", "application/octet-stream")).toEqual(["pdf"]);
    expect(getCompatibleViewerIds("notes.markdown", "application/octet-stream")).toEqual(["markdown"]);
    expect(getCompatibleViewerIds("example.clj", "application/pdf")).toEqual(["pdf"]);
    expect(getCompatibleViewerIds("photo.png", "application/json")).toEqual(["text"]);
  });

  it("retains every existing text and code extension and MIME mapping", () => {
    for (const category of ["text", "code"] as const) {
      for (const fileType of getFileTypesByCategory(category)) {
        for (const extension of fileType.extensions) {
          const expected = [".md", ".markdown"].includes(extension) ? "markdown" : "text";
          expect(getCompatibleViewerIds(`example${extension}`, "application/octet-stream"), extension).toEqual([expected]);
        }
        for (const mimeType of fileType.mimeTypes) {
          expect(hasViewerSupport(mimeType), mimeType).toBe(true);
        }
      }
    }
  });
});
