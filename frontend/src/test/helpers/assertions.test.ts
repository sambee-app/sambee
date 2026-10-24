import { describe, expect, it } from "vitest";
import { requireTestElement, requireTestValue, uninitializedTestCallback } from "./assertions";

describe("requireTestValue", () => {
  it.each([null, undefined])("fails explicitly for %s", (value) => {
    expect(() => requireTestValue(value)).toThrow("Expected a test fixture or result to be present");
  });

  it.each([false, 0, "", { value: 1 }])("preserves an existing value", (value) => {
    expect(requireTestValue(value)).toBe(value);
  });
});

it("fails explicitly for an uninitialized callback", () => {
  expect(uninitializedTestCallback).toThrow("Test callback invoked before initialization");
});

it("requires the actual DOM element type", () => {
  const textarea = document.createElement("textarea");
  expect(requireTestElement(textarea, HTMLTextAreaElement)).toBe(textarea);
  expect(() => requireTestElement(document.createElement("div"), HTMLTextAreaElement)).toThrow(
    "Expected a HTMLTextAreaElement test element"
  );
  expect(() => requireTestElement(null, HTMLElement)).toThrow("Expected a HTMLElement test element");
});
