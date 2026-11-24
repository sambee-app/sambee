import { describe, expect, it } from "vitest";
import unicode from "../../../../shared/directory-index/unicode.json";
import { FILESYSTEM_SEARCH_QUERY_MAX_BYTES, validateFilesystemSearchQuery } from "../filesystemSearchContract";

describe("file-system search query validation", () => {
  it("matches the shared Python whitespace set across the BMP", () => {
    const whitespace = new Set(unicode.whitespace);
    for (let codepoint = 0; codepoint <= 0xffff; codepoint += 1) {
      const character = String.fromCharCode(codepoint);
      expect(validateFilesystemSearchQuery(character) === "empty").toBe(whitespace.has(character));
    }
    expect(validateFilesystemSearchQuery("\u001c")).toBe("empty");
    expect(validateFilesystemSearchQuery("\ufeff")).toBeNull();
  });

  it("uses the shared UTF-8 byte limit", () => {
    const boundary = "é".repeat(FILESYSTEM_SEARCH_QUERY_MAX_BYTES / 2);
    expect(validateFilesystemSearchQuery(boundary)).toBeNull();
    expect(validateFilesystemSearchQuery(`${boundary}é`)).toBe("too-long");
  });
});
