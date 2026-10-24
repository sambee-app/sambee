import { describe, expect, it } from "vitest";
import {
  CODE_PREVIEW_FRAGMENT_MAX_LINES,
  CODE_PREVIEW_FRAGMENT_MAX_UNITS,
  CODE_PREVIEW_SCAN_MAX_UNITS,
  CODE_PREVIEW_STEP_MAX_OPERATIONS,
  createCodePreviewModel,
  createCodePreviewModelAsync,
  findCodePreviewFragment,
} from "../markdownCodePreviewModel";

describe("P1 code preview fragmentation", () => {
  it("cooperatively produces identical models for dense, Unicode, and oversized source", async () => {
    for (const text of [
      "",
      "let x=1;\n".repeat(6_000),
      `${" \t\u{1f30d}\r\n\n".repeat(100)}end`,
      "x".repeat(CODE_PREVIEW_SCAN_MAX_UNITS * 3),
    ]) {
      let yields = 0;
      const ranges = text.length ? [{ from: 0, to: text.length, categories: ["string"] as const }] : [];
      const model = await createCodePreviewModelAsync(text, ranges, {
        yieldTask: async () => {
          yields += 1;
        },
      });
      expect(model).toEqual(createCodePreviewModel(text, ranges));
      if (text.length > CODE_PREVIEW_SCAN_MAX_UNITS) expect(yields).toBeGreaterThan(0);
    }
  });

  it("stops a single oversized-line scan at its first cooperative boundary", async () => {
    const controller = new AbortController();
    let yields = 0;
    await expect(
      createCodePreviewModelAsync("x".repeat(CODE_PREVIEW_SCAN_MAX_UNITS * 10), [], {
        signal: controller.signal,
        yieldTask: async () => {
          yields += 1;
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(1);
  });

  it("keeps scan-window boundaries independent from line and token boundaries", async () => {
    for (const units of [
      CODE_PREVIEW_SCAN_MAX_UNITS - 1,
      CODE_PREVIEW_SCAN_MAX_UNITS,
      CODE_PREVIEW_SCAN_MAX_UNITS + 1,
      CODE_PREVIEW_SCAN_MAX_UNITS * 2 + 1,
    ]) {
      const text = `${"x".repeat(units)}\n${"a\n".repeat(CODE_PREVIEW_FRAGMENT_MAX_LINES)}last`;
      const ranges = [{ from: units - 1, to: units + 2, categories: ["string"] as const }];
      const model = await createCodePreviewModelAsync(text, ranges, { yieldTask: async () => undefined });
      const middleEnd = units + 1 + CODE_PREVIEW_FRAGMENT_MAX_LINES * "a\n".length;
      expect(model.fragments).toEqual([
        { from: 0, to: units + 1, firstRange: 0, rangeEnd: 1, oversizedLine: true },
        { from: units + 1, to: middleEnd, firstRange: 0, rangeEnd: 1, oversizedLine: false },
        { from: middleEnd, to: text.length, firstRange: 1, rangeEnd: 1, oversizedLine: false },
      ]);
    }
  });

  it("propagates scheduling failures without returning a partial model", async () => {
    const failure = new Error("Index scheduling failed");
    await expect(
      createCodePreviewModelAsync("x".repeat(CODE_PREVIEW_SCAN_MAX_UNITS), [], {
        yieldTask: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
  });

  it("checks cancellation before reading ranges and during range validation", async () => {
    const controller = new AbortController();
    let reads = 0;
    const ranges = new Proxy(
      Array.from({ length: CODE_PREVIEW_STEP_MAX_OPERATIONS * 3 }, (_, index) => ({
        from: index,
        to: index + 1,
        categories: ["keyword"] as const,
      })),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      }
    );
    await expect(
      createCodePreviewModelAsync("x".repeat(ranges.length), ranges, {
        signal: controller.signal,
        yieldTask: async () => {
          controller.abort();
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(CODE_PREVIEW_STEP_MAX_OPERATIONS);
    reads = 0;
    await expect(
      createCodePreviewModelAsync("x", ranges, {
        signal: controller.signal,
        yieldTask: async () => undefined,
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(reads).toBe(0);
  });

  it("retains all 54,000 code units without a cumulative cutoff", () => {
    const text = "let x=1;\n".repeat(6_000);
    const model = createCodePreviewModel(text, []);
    expect(text.length).toBe(54_000);
    expect(model.fragments.map(({ from, to }) => text.slice(from, to)).join("")).toBe(text);
    expect(model.fragments).toHaveLength(Math.ceil(6_000 / CODE_PREVIEW_FRAGMENT_MAX_LINES));
    for (const fragment of model.fragments) {
      expect(fragment.to - fragment.from).toBeLessThanOrEqual(CODE_PREVIEW_FRAGMENT_MAX_UNITS);
      expect(fragment.oversizedLine).toBe(false);
    }
    const many = createCodePreviewModel(text.repeat(10), []);
    expect(many.fragments.at(-1)?.to).toBe(540_000);
  });

  it("preserves tabs, CRLF, Unicode, blank lines, and an unterminated final line", () => {
    const text = `${" \t\u{1f30d}\r\n\n".repeat(100)}end`;
    const model = createCodePreviewModel(text, []);
    expect(model.fragments.map(({ from, to }) => text.slice(from, to)).join("")).toBe(text);
    for (const { from, to } of model.fragments) {
      expect(findCodePreviewFragment(model, from)).toBe(model.fragments.findIndex((fragment) => fragment.from === from));
      expect(findCodePreviewFragment(model, to - 1)).not.toBeNull();
    }
    for (const invalid of [-1, text.length, Number.NaN, 1.5]) expect(findCodePreviewFragment(model, invalid)).toBeNull();
    expect(createCodePreviewModel("", []).fragments).toEqual([]);
  });

  it("associates crossing tokens and neutral gaps with only their overlapping fragments", () => {
    const text = "a\n".repeat(CODE_PREVIEW_FRAGMENT_MAX_LINES * 3);
    const boundary = CODE_PREVIEW_FRAGMENT_MAX_LINES * 2;
    const ranges = [
      { from: 0, to: 1, categories: ["keyword"] as const },
      { from: boundary - 1, to: boundary + 1, categories: ["string"] as const },
      { from: boundary * 2 + 1, to: boundary * 2 + 2, categories: ["comment"] as const },
    ];
    const model = createCodePreviewModel(text, ranges);
    expect(model.fragments.map(({ firstRange, rangeEnd }) => [firstRange, rangeEnd])).toEqual([
      [0, 2],
      [1, 2],
      [2, 3],
    ]);
    expect(ranges).toEqual(model.ranges);
  });

  it("indexes ranges in a single ordered pass rather than rescanning per fragment", () => {
    const text = "x\n".repeat(10_000);
    const ranges = Array.from({ length: 10_000 }, (_, index) => ({ from: index * 2, to: index * 2 + 1, categories: ["keyword"] as const }));
    let reads = 0;
    const observed = new Proxy(ranges, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const model = createCodePreviewModel(text, observed);
    expect(model.fragments.length).toBeGreaterThan(100);
    expect(reads).toBeLessThan(ranges.length * 8);
  });

  it("flags oversized lines instead of claiming to bound their DOM work or changing their wrapping", () => {
    const longLine = "\u{1f30d}".repeat(CODE_PREVIEW_FRAGMENT_MAX_UNITS);
    const text = `first\n${longLine}\nlast`;
    const model = createCodePreviewModel(text, []);
    expect(model.fragments.map(({ oversizedLine }) => oversizedLine)).toEqual([false, true, false]);
    expect(model.fragments.map(({ from, to }) => text.slice(from, to)).join("")).toBe(text);
  });

  it("rejects invalid token data before publication", () => {
    for (const ranges of [
      [{ from: -1, to: 1, categories: ["keyword"] as const }],
      [{ from: 0, to: 4, categories: ["keyword"] as const }],
      [{ from: 1, to: 1, categories: ["keyword"] as const }],
      [{ from: 0, to: 1.5, categories: ["keyword"] as const }],
      [
        { from: 0, to: 2, categories: ["keyword"] as const },
        { from: 1, to: 3, categories: ["string"] as const },
      ],
    ])
      expect(() => createCodePreviewModel("abc", ranges)).toThrow(RangeError);
  });
});
