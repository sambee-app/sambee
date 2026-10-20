import { describe, expect, it } from "vitest";
import { resolveSyntaxTheme } from "../resolveSyntaxTheme";
import { syntaxTokenStyles } from "../syntaxStyles";
import { editableDefinition, parseThemeImport } from "../themeDefinition";
import { getDefaultTheme } from "../themes";

describe("syntax theme compatibility", () => {
  it("does not let typography-only classes override combined heading or link colors", () => {
    for (const category of ["emphasis", "strong", "strikethrough"]) {
      expect(syntaxTokenStyles[`.sambee-syntax-${category}`]).not.toHaveProperty("color");
    }
  });
  it.each(["light", "dark"] as const)("resolves legacy %s themes without mutation", (mode) => {
    const legacy = structuredClone(getDefaultTheme(mode));
    delete legacy.components!.syntax;
    const snapshot = structuredClone(legacy);
    const resolved = resolveSyntaxTheme(legacy);
    expect(resolved.components!.syntax).toEqual(getDefaultTheme(mode).components!.syntax);
    expect(legacy).toEqual(snapshot);
    expect(resolveSyntaxTheme(resolved)).toEqual(resolved);
    expect(parseThemeImport(JSON.stringify({ version: 1, definition: editableDefinition(legacy) })).components!.syntax).toEqual(
      resolved.components!.syntax
    );
    const oldExport = editableDefinition(legacy);
    delete oldExport.components!.syntax;
    expect(parseThemeImport(JSON.stringify({ version: 1, definition: oldExport })).components!.syntax).toEqual(resolved.components!.syntax);
  });

  it.each([
    null,
    {},
    { keyword: "#123456" },
    { ...getDefaultTheme().components!.syntax, extra: "#123456" },
    { ...getDefaultTheme().components!.syntax, string: "red" },
  ])("rejects supplied malformed groups %j", (syntax) => {
    const theme = structuredClone(getDefaultTheme());
    Object.assign(theme.components!, { syntax });
    expect(() => resolveSyntaxTheme(theme)).toThrow("Syntax colors");
  });

  it("retains custom alpha colors through export and import", () => {
    const theme = structuredClone(getDefaultTheme());
    theme.components!.syntax!.keyword = "#12345678";
    expect(parseThemeImport(JSON.stringify({ version: 1, definition: editableDefinition(theme) })).components!.syntax).toEqual(
      theme.components!.syntax
    );
  });
});
