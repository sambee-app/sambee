import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateDomTextSearchMatch,
  applyDomTextSearchHighlights,
  buildHighlightSlices,
  clearDomTextSearchHighlights,
  createDomTextIndex,
  DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE,
  DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR,
  DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE,
} from "../domTextSearch";
import { createViewportDomTextSearch, MAX_VIEWPORT_SEARCH_RANGES } from "../viewportDomTextSearch";

describe("domTextSearch", () => {
  it("assembles many blocks without inspecting a growing concatenated string", () => {
    const container = document.createElement("div");
    const text = "let x=1;\n".repeat(101);
    container.innerHTML = Array.from({ length: 600 }, () => `<pre><code>${text}</code></pre>`).join("");
    const original = String.prototype.endsWith;
    let growingStringChecks = 0;
    const endsWith = vi.spyOn(String.prototype, "endsWith").mockImplementation(function (this: string, search, end) {
      if (this.length > text.length) growingStringChecks += 1;
      return original.call(this, search, end);
    });
    try {
      const index = createDomTextIndex(container);
      expect(index.fullText).toBe(text.repeat(600));
      expect(index.segments).toHaveLength(600);
      expect(index.segments.at(-1)?.end).toBe(index.fullText.length);
      expect(growingStringChecks).toBe(0);
    } finally {
      endsWith.mockRestore();
    }
  });

  it("reports separate search stages and retains only the latest entry per stage", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>Alpha beta alpha</p>";
    const measure = vi.spyOn(performance, "measure");
    const clear = vi.spyOn(performance, "clearMeasures");
    try {
      for (let iteration = 0; iteration < 2; iteration += 1) {
        applyDomTextSearchHighlights(container, "alpha");
        clearDomTextSearchHighlights(container);
      }
      const names = ["capture", "matching", "slices", "markers", "clear"].map((stage) => `sambee:preview-search:${stage}`);
      expect(measure.mock.calls.map(([name]) => name)).toEqual([...names, ...names]);
      expect(clear.mock.calls.map(([name]) => name)).toEqual([...names, ...names]);
      for (const [, options] of measure.mock.calls) {
        expect(options).toEqual({ start: expect.any(Number), end: expect.any(Number) });
      }
    } finally {
      measure.mockRestore();
      clear.mockRestore();
    }
  });

  it("updates only the old and new match when navigating many results", () => {
    const matches = Array.from({ length: 6_000 }, (_, id) => ({ id, elements: [document.createElement("mark")] }));
    activateDomTextSearchMatch(matches, 1, false);
    const set = vi.spyOn(Element.prototype, "setAttribute");
    const remove = vi.spyOn(Element.prototype, "removeAttribute");
    try {
      activateDomTextSearchMatch(matches, matches.length, false);
      expect(set).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      activateDomTextSearchMatch(matches, matches.length, false);
      expect(set).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      activateDomTextSearchMatch(matches, 0, false);
      expect(remove).toHaveBeenCalledTimes(2);
    } finally {
      set.mockRestore();
      remove.mockRestore();
    }
  });
  it("highlights case-insensitive matches within text nodes", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>Alpha beta ALPHA</p>";

    const matches = applyDomTextSearchHighlights(container, "alpha");

    expect(matches).toHaveLength(2);
    expect(container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)).toHaveLength(2);
  });

  it("activates the requested current match", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>Alpha beta alpha</p>";

    const matches = applyDomTextSearchHighlights(container, "alpha");
    const activeHighlight = activateDomTextSearchMatch(matches, 2);

    expect(activeHighlight).toBe(matches[1]?.elements[0]);
    expect(matches[0]?.elements[0]?.hasAttribute(DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE)).toBe(false);
    expect(matches[1]?.elements[0]?.getAttribute(DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE)).toBe("true");
  });

  it("matches a term across inline element boundaries as a single logical match", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>sam<strong>bee</strong> sambee</p>";

    const matches = applyDomTextSearchHighlights(container, "sambee");

    expect(matches).toHaveLength(2);
    expect(matches[0]?.elements).toHaveLength(2);
    expect(matches[1]?.elements).toHaveLength(1);
    expect(container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)).toHaveLength(3);
    expect(matches[0]?.elements[0]?.getAttribute(DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE)).toBe("0");
    expect(matches[0]?.elements[1]?.getAttribute(DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE)).toBe("0");
  });

  it("does not create false matches across block boundaries", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>sam</p><p>bee</p>";

    const matches = applyDomTextSearchHighlights(container, "sambee");

    expect(matches).toHaveLength(0);
    expect(container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)).toHaveLength(0);
  });

  it.each(["const x", "x  =", "=\t1", "1;\nconst"])("preserves isolated code whitespace for %j", (query) => {
    const container = document.createElement("div");
    container.innerHTML = "<pre><code><span>const</span> <span>x</span>  <span>=</span>\t<span>1;</span>\n<span>const</span></code></pre>";
    const original = container.textContent;
    const matches = applyDomTextSearchHighlights(container, query);
    expect(matches).toHaveLength(1);
    expect(matches[0].elements.map((element) => element.textContent).join("")).toBe(query);
    clearDomTextSearchHighlights(container);
    expect(container.textContent).toBe(original);
    expect(applyDomTextSearchHighlights(container, query)).toHaveLength(1);
  });

  it("does not index prose layout indentation", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p><span>sam</span>\n  <strong>bee</strong></p>";
    expect(applyDomTextSearchHighlights(container, "sambee")).toHaveLength(1);
  });

  it("walks ordered segments proportionally to matches and emitted slices", () => {
    let inspections = 0;
    const repetitions = 6000;
    const segments = Array.from({ length: repetitions * 2 }, (_, index) => ({
      node: document.createTextNode(index % 2 === 0 ? "let" : " "),
      get start() {
        inspections += 1;
        return Math.floor(index / 2) * 4 + (index % 2 === 0 ? 0 : 3);
      },
      get end() {
        inspections += 1;
        return Math.floor(index / 2) * 4 + (index % 2 === 0 ? 3 : 4);
      },
    }));
    const matches = Array.from({ length: repetitions }, (_, index) => ({ id: index, start: index * 4, end: index * 4 + 3 }));
    const slices = buildHighlightSlices({ fullText: "let ".repeat(repetitions), segments }, matches);
    expect(slices.size).toBe(repetitions);
    expect(inspections).toBeLessThan((segments.length + matches.length) * 8);
  });

  it("clears highlights and restores the original text content", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p>Alpha <strong>beta</strong> alpha</p>";

    applyDomTextSearchHighlights(container, "alpha");
    clearDomTextSearchHighlights(container);

    expect(container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)).toHaveLength(0);
    expect(container.textContent).toBe("Alpha beta alpha");
  });

  it("coalesces dense marker text without normalizing live ranges or replacing inline elements", () => {
    const container = document.createElement("div");
    container.innerHTML = `<p>${"alpha ".repeat(6_000)}<strong>beta</strong> alpha</p>`;
    const strong = container.querySelector("strong");
    const original = container.textContent;
    applyDomTextSearchHighlights(container, "alpha");
    const normalize = vi.spyOn(Node.prototype, "normalize");
    try {
      clearDomTextSearchHighlights(container);
      expect(normalize).not.toHaveBeenCalled();
      expect(container.textContent).toBe(original);
      expect(container.querySelector("strong")).toBe(strong);
      expect(container.firstChild?.childNodes).toHaveLength(3);
      expect(container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)).toHaveLength(0);
    } finally {
      normalize.mockRestore();
    }
  });
});

describe("viewport DOM search", () => {
  let frames: Map<number, FrameRequestCallback>;
  let highlights: Map<string, Set<Range>>;
  let session: ReturnType<typeof createViewportDomTextSearch> | undefined;
  let root: HTMLDivElement;
  let viewport: HTMLDivElement;
  let nextFrame: number;
  let notifyIntersections: IntersectionObserverCallback;
  let disconnectIntersections: ReturnType<typeof vi.fn>;

  function flushFrames() {
    for (let iteration = 0; frames.size && iteration < 100; iteration += 1) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    }
    expect(frames.size).toBe(0);
  }

  beforeEach(() => {
    frames = new Map();
    highlights = new Map();
    nextFrame = 0;
    disconnectIntersections = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notifyIntersections = callback;
        }
        observe(target: Element) {
          notifyIntersections([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
        disconnect = disconnectIntersections;
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      }
    );
    vi.stubGlobal("CSS", { highlights });
    viewport = document.createElement("div");
    root = document.createElement("div");
    viewport.append(root);
    document.body.append(viewport);
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 120 } as DOMRect);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 120 } as DOMRect);
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return { top: this.startOffset, bottom: this.endOffset } as DOMRect;
    });
  });

  afterEach(() => {
    session?.dispose();
    session = undefined;
    viewport.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses capture across queries and preserves text nodes and native selection", () => {
    root.innerHTML = "<p>sam<strong>bee</strong> sambee</p><pre><code>const x  =\t1;\nconst</code></pre>";
    const node = root.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const original = selection.toString();
    const measure = vi.spyOn(performance, "measure");
    const geometry = vi.mocked(Range.prototype.getBoundingClientRect);
    geometry.mockClear();
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    expect(session.setQuery("sambee")).toBe(2);
    session.activate(1, false);
    flushFrames();
    expect(geometry).not.toHaveBeenCalled();
    expect([...highlights.values()].flatMap((set) => [...set]).some((highlight) => highlight.toString() === "sambee")).toBe(true);
    expect(session.setQuery("x  =\t1;\nconst")).toBe(1);
    session.activate(1, false);
    flushFrames();
    expect(measure.mock.calls.filter(([name]) => name === "sambee:preview-search:capture")).toHaveLength(1);
    expect(root.querySelector("p")!.firstChild).toBe(node);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    expect(selection.toString()).toBe(original);
    selection.removeAllRanges();
  });

  it.each([
    { top: 0, bottom: 120 },
    { top: 480, bottom: 600 },
    { top: 120, bottom: 180 },
  ])("retains vertical range lookup when the text box is clipped at $top/$bottom", (bounds) => {
    root.innerHTML = `<p>${"alpha ".repeat(100)}</p>`;
    Object.defineProperty(viewport, "getBoundingClientRect", { configurable: true, value: vi.fn(() => bounds) });
    Object.defineProperty(root.firstElementChild, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() => ({ top: 0, bottom: 600 })),
    });
    const geometry = vi.mocked(Range.prototype.getBoundingClientRect);
    geometry.mockClear();
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    expect(session.setQuery("alpha")).toBe(100);
    flushFrames();
    expect(geometry).toHaveBeenCalled();
    const ranges = [...highlights.values()].flatMap((collection) => [...collection]);
    expect(ranges).toHaveLength((bounds.bottom - bounds.top) / "alpha ".length);
    expect(ranges.every((range) => range.startOffset >= bounds.top && range.endOffset <= bounds.bottom)).toBe(true);
    expect(ranges.every((range) => range.toString() === "alpha")).toBe(true);
  });

  it("reduces horizontal probes while preserving exact search ranges after nested scrolling", () => {
    const source = "alpha ".repeat(6_000);
    root.innerHTML = `<pre style="white-space: pre"><code>${source}</code></pre>`;
    const pre = root.querySelector("pre")!;
    const code = root.querySelector("code")!;
    const node = code.firstChild;
    const bounds = { top: 0, bottom: 120, left: 0, right: 120 };
    Object.defineProperties(pre, { scrollWidth: { value: source.length }, clientWidth: { value: bounds.right } });
    for (const element of [viewport, pre, code])
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: vi.fn(() => bounds),
      });
    const geometry = vi.mocked(Range.prototype.getBoundingClientRect);
    geometry.mockImplementation(function (this: Range) {
      return { ...bounds, left: this.startOffset - pre.scrollLeft, right: this.endOffset - pre.scrollLeft } as DOMRect;
    });
    geometry.mockClear();
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    expect(session.setQuery("alpha")).toBe(6_000);
    flushFrames();
    expect(geometry.mock.calls.length).toBeLessThan(20);
    const visible = () => [...highlights.values()].flatMap((collection) => [...collection]);
    expect(visible()).toHaveLength(20);
    expect(visible().every((range) => range.toString() === "alpha" && range.endOffset <= bounds.right)).toBe(true);
    pre.scrollLeft = 30_000;
    pre.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(visible()).toHaveLength(20);
    expect(
      visible().every(
        (range) => range.toString() === "alpha" && range.startOffset >= pre.scrollLeft && range.endOffset <= pre.scrollLeft + bounds.right
      )
    ).toBe(true);
    expect(code.firstChild).toBe(node);
    expect(code.textContent).toBe(source);
    Object.defineProperty(pre, "getBoundingClientRect", {
      configurable: true,
      value: vi.fn(() => ({ ...bounds, left: 200, right: 320 })),
    });
    geometry.mockClear();
    viewport.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(visible()).toHaveLength(0);
    expect(geometry).not.toHaveBeenCalled();
  });

  it("bounds visible ranges and does not capture or match during viewport updates or navigation", () => {
    root.innerHTML = `<pre><code>${"alpha ".repeat(6_000)}</code></pre>`;
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    expect(session.setQuery("alpha")).toBe(6_000);
    flushFrames();
    const measure = vi.spyOn(performance, "measure");
    session.activate(6_000);
    viewport.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(measure.mock.calls.some(([name]) => name.endsWith(":capture") || name.endsWith(":matching"))).toBe(false);
    for (const stage of ["navigation-lookup", "navigation-publication", "navigation-geometry", "navigation-scroll"]) {
      expect(measure.mock.calls.some(([name]) => name === `sambee:preview-search:${stage}`)).toBe(true);
    }
    expect([...highlights.values()].reduce((sum, set) => sum + set.size, 0)).toBeLessThanOrEqual(MAX_VIEWPORT_SEARCH_RANGES + 1);
    expect(
      [...highlights.entries()]
        .find(([name]) => name.endsWith("-current"))?.[1]
        .values()
        .next()
        .value?.toString()
    ).toBe("alpha");
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
  });

  it("paints late-document matches during continuous scrolling without traversing off-screen segments", () => {
    root.innerHTML = "<p>alpha</p>".repeat(600);
    const paragraphs = [...root.querySelectorAll("p")];
    const destination = paragraphs[599];
    const probes = paragraphs.map((paragraph, index) => {
      const probe = vi.fn(() => (index === 599 ? { top: 0, bottom: 120 } : { top: -20, bottom: -10 }) as DOMRect);
      Object.defineProperty(paragraph, "getBoundingClientRect", { configurable: true, value: probe });
      return probe;
    });
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    expect(session.setQuery("alpha")).toBe(600);
    notifyIntersections(
      paragraphs.map((target) => ({ target, isIntersecting: target === destination }) as IntersectionObserverEntry),
      {} as IntersectionObserver
    );
    const measure = vi.spyOn(performance, "measure");
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const previousFrame = [...frames.keys()][0];
      viewport.dispatchEvent(new Event("scroll"));
      if (previousFrame !== undefined) expect([...frames.keys()]).toEqual([previousFrame]);
      if (iteration > 0) expect([...highlights.values()].some((collection) => collection.size === 1)).toBe(true);
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
      const ranges = [...highlights.values()].flatMap((collection) => [...collection]);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startContainer).toBe(destination.firstChild);
      expect(ranges[0].toString()).toBe("alpha");
    }
    expect(probes.slice(0, -1).every((probe) => probe.mock.calls.length === 0)).toBe(true);
    expect(measure.mock.calls.some(([name]) => name.endsWith(":capture") || name.endsWith(":matching"))).toBe(false);
    notifyIntersections([{ target: destination, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    flushFrames();
    expect([...highlights.values()].every((collection) => collection.size === 0)).toBe(true);
    session.dispose();
    expect(disconnectIntersections).toHaveBeenCalled();
    expect(highlights.size).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("invalidates on text replacement but not theme changes and handles queued mutations before queries", async () => {
    root.innerHTML = "<p>alpha</p>";
    const invalidated = vi.fn();
    session = createViewportDomTextSearch(root, viewport, invalidated);
    expect(session.setQuery("alpha")).toBe(1);
    root.style.color = "red";
    await Promise.resolve();
    expect(invalidated).not.toHaveBeenCalled();
    root.querySelector("p")!.textContent = "beta beta";
    expect(session.setQuery("beta")).toBe(2);
    await Promise.resolve();
    expect(invalidated).not.toHaveBeenCalled();
    root.querySelector("p")!.firstChild!.textContent = "gamma";
    await Promise.resolve();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(session.setQuery("gamma")).toBe(1);
  });

  it("releases owned highlights, styles and scheduled frames on disposal", () => {
    root.innerHTML = "<p>alpha</p>";
    session = createViewportDomTextSearch(root, viewport, vi.fn());
    session.setQuery("alpha");
    session.activate(1, false);
    flushFrames();
    const style = [...document.head.querySelectorAll("style")].find((style) => style.textContent?.includes("markdown-search-"));
    expect(style?.textContent?.match(/color: var\(--sambee-search-foreground\)/g)).toHaveLength(2);
    expect([...highlights.entries()].find(([name]) => name.endsWith("-current"))?.[1]).toHaveProperty("priority", 1);
    viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    session.dispose();
    expect(frames.size).toBe(0);
    expect(highlights.size).toBe(0);
    expect([...document.head.querySelectorAll("style")].some((style) => style.textContent?.includes("markdown-search-"))).toBe(false);
    expect(session.setQuery("alpha")).toBe(0);
  });

  it.each(["Highlight", "IntersectionObserver"])(
    "keeps counts and navigation without marker mutation when %s is unavailable",
    (capability) => {
      vi.stubGlobal(capability, undefined);
      root.innerHTML = "<p>alpha alpha</p>";
      session = createViewportDomTextSearch(root, viewport, vi.fn());
      expect(session.supported).toBe(false);
      expect(session.setQuery("alpha")).toBe(2);
      session.activate(2);
      expect(root.innerHTML).toBe("<p>alpha alpha</p>");
      expect(highlights.size).toBe(0);
    }
  );
});
