import { describe, expect, it } from "vitest";
import fixtures from "../../../../../../shared/directory-index/search-fixtures.json";
import {
  findSearchHighlights,
  getSearchRelevance,
  MAX_SEARCH_QUERY_BYTES,
  MAX_SEARCH_TERMS,
  normalizeSearchText,
  rankHistorySearchResults,
  searchTerms,
} from "../recentHistory";
import type { SearchResult } from "../types";

describe("shared search contract", () => {
  it("uses code-point ordering for terms and deterministic result ties", () => {
    expect(searchTerms("😀 \ue000")).toEqual(["\ue000", "😀"]);
    const rows: SearchResult[] = ["😀", "\ue000"].map((text) => ({
      kind: "result",
      id: text,
      value: text,
      icon: "directory",
      primaryText: text,
      matchedTermCount: 1,
      matchRank: 3,
    }));
    expect(rankHistorySearchResults(rows, "test").map((row) => row.value)).toEqual(["\ue000", "😀"]);
  });
  it("uses language-neutral normalization and term fixtures", () => {
    for (const fixture of fixtures.normalization) expect(normalizeSearchText(fixture.input)).toBe(fixture.expected);
    for (const fixture of fixtures.queries) expect(searchTerms(fixture.query)).toEqual([...fixture.terms].sort());
  });

  it("maps case-fold expansion, combining marks, overlaps, and separate terms to original text", () => {
    expect(findSearchHighlights("Straße", "ss")).toEqual([{ start: 4, end: 5 }]);
    expect(findSearchHighlights("Cafe\u0301", "cafe")).toEqual([{ start: 0, end: 5 }]);
    expect(findSearchHighlights("banana", "ana nan")).toEqual([{ start: 1, end: 6 }]);
    expect(findSearchHighlights("Alpha/Béta", "beta alpha")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 10 },
    ]);
    expect(findSearchHighlights("𝒜lpha", "alpha")).toEqual([{ start: 0, end: 6 }]);
    expect(findSearchHighlights("anything", "\u0301")).toEqual([]);
  });

  it("deduplicates terms and ranks matched-term count before history usage", () => {
    expect(getSearchRelevance("alpha/beta", searchTerms("ALPHA alpha beta"), "beta")).toEqual({ matchedTermCount: 2, matchRank: 0 });
    const rows: SearchResult[] = [
      {
        kind: "result",
        id: "history",
        value: "history",
        icon: "recent-directory",
        primaryText: "alpha",
        matchedTermCount: 1,
        matchRank: 0,
        usageScore: 1000,
      },
      { kind: "result", id: "index", value: "index", icon: "directory", primaryText: "alpha/beta", matchedTermCount: 2, matchRank: 3 },
    ];
    expect(rankHistorySearchResults(rows, "alpha beta").map((row) => row.value)).toEqual(["index", "history"]);
  });

  it("rejects invalid characters and excess input without silently dropping terms", () => {
    expect(() => searchTerms("x".repeat(MAX_SEARCH_QUERY_BYTES + 1))).toThrow("UTF-8 bytes");
    expect(() => searchTerms(Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, index) => `term${index}`).join(" "))).toThrow(
      "distinct terms"
    );
    expect(() => searchTerms("\ud800")).toThrow("unsupported character");
  });
});
