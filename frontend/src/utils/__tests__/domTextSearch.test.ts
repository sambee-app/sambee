import { describe, expect, it } from "vitest";
import {
  activateDomTextSearchMatch,
  applyDomTextSearchHighlights,
  buildHighlightSlices,
  clearDomTextSearchHighlights,
  DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE,
  DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR,
  DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE,
} from "../domTextSearch";

describe("domTextSearch", () => {
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
});
