import unicode from "../../../../../shared/directory-index/unicode.json";
import type { SearchResult, SearchResultItem, SearchTextHighlight } from "./types";

export const MAX_SEARCH_QUERY_BYTES = 4096;
export const MAX_SEARCH_TERMS = 32;
export const SEARCH_CONTRACT_VERSION = 1;
const NORMALIZATION_KEYS = new Map(unicode.normalization.map(([source, key]) => [source ?? "", key ?? ""]));
const QUERY_WHITESPACE = new Set(unicode.whitespace);

function isWordCharacter(character: string): boolean {
  const codepoint = character.codePointAt(0) ?? -1;
  let low = 0;
  let high = unicode.word_ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = unicode.word_ranges[middle];
    if (!range) return false;
    const start = range[0] ?? -1;
    const end = range[1] ?? -1;
    if (codepoint < start) high = middle - 1;
    else if (codepoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

export function normalizeSearchText(value: string): string {
  return Array.from(value, (character) => NORMALIZATION_KEYS.get(character) ?? character).join("");
}

export function searchTerms(query: string): string[] {
  if (/[\uD800-\uDFFF]/u.test(query)) throw new Error("Search text contains an unsupported character. Remove that character and retry.");
  if (new TextEncoder().encode(query).length > MAX_SEARCH_QUERY_BYTES) {
    throw new Error(`Search text must use at most ${MAX_SEARCH_QUERY_BYTES} UTF-8 bytes. Shorten the search text.`);
  }
  const terms = new Set<string>();
  let rawTerm = "";
  const addTerm = () => {
    const term = normalizeSearchText(rawTerm);
    if (term) terms.add(term);
    rawTerm = "";
  };
  for (const character of query) {
    if (QUERY_WHITESPACE.has(character)) addTerm();
    else rawTerm += character;
  }
  addTerm();
  if (terms.size > MAX_SEARCH_TERMS)
    throw new Error(`Search text must contain at most ${MAX_SEARCH_TERMS} distinct terms. Remove some terms.`);
  return [...terms].sort(compareText);
}

function singleTermRank(name: string, term: string): number {
  if (name === term) return 0;
  if (name.startsWith(term)) return 1;
  let offset = 0;
  for (const character of name) {
    offset += character.length;
    if (!isWordCharacter(character) && name.startsWith(term, offset)) return 2;
  }
  return 3;
}

export function getSearchRelevance(
  field: string,
  terms: readonly string[],
  basename = field
): { matchedTermCount: number; matchRank: number } {
  const key = normalizeSearchText(field);
  const basenameKey = normalizeSearchText(basename);
  const matched = terms.filter((term) => key.includes(term));
  return {
    matchedTermCount: matched.length,
    matchRank: matched.length ? Math.min(...matched.map((term) => singleTermRank(basenameKey, term))) : 3,
  };
}

export function findSearchHighlights(text: string, query: string): SearchTextHighlight[] {
  const terms = searchTerms(query);
  let normalized = "";
  const offsets: SearchTextHighlight[] = [];
  let originalOffset = 0;
  for (const character of text) {
    const key = normalizeSearchText(character);
    const end = originalOffset + character.length;
    if (!key && offsets.length) {
      const previous = offsets[offsets.length - 1];
      if (previous) previous.end = end;
    }
    for (let index = 0; index < key.length; index += 1) offsets.push({ start: originalOffset, end });
    normalized += key;
    originalOffset = end;
  }
  const ranges: SearchTextHighlight[] = [];
  for (const term of terms) {
    for (let start = normalized.indexOf(term); start >= 0; start = normalized.indexOf(term, start + 1)) {
      const first = offsets[start];
      const last = offsets[start + term.length - 1];
      if (first && last) ranges.push({ start: first.start, end: last.end });
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchTextHighlight[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function findTextHighlight(text: string, query: string): SearchTextHighlight | SearchTextHighlight[] | undefined {
  const ranges = findSearchHighlights(text, query);
  return ranges.length === 1 ? ranges[0] : ranges.length ? ranges : undefined;
}

export function historyMatchRank(name: string, query: string): number {
  return getSearchRelevance(name, searchTerms(query)).matchRank;
}

/** Typed searches rank across sources; empty searches keep their history groups. */
export function rankHistorySearchResults(results: SearchResult[], query: string): SearchResult[] {
  if (!searchTerms(query).length) return results;
  return results
    .filter((result): result is SearchResultItem => result.kind === "result")
    .sort(
      (left, right) =>
        (right.matchedTermCount ?? 1) - (left.matchedTermCount ?? 1) ||
        (left.matchRank ?? 3) - (right.matchRank ?? 3) ||
        (right.usageScore ?? 0) - (left.usageScore ?? 0) ||
        (Date.parse(right.lastUsedAt ?? "") || 0) - (Date.parse(left.lastUsedAt ?? "") || 0) ||
        (left.depth ?? 0) - (right.depth ?? 0) ||
        Number(!left.icon.startsWith("recent-")) - Number(!right.icon.startsWith("recent-")) ||
        compareText(normalizeSearchText(left.sortPath ?? left.primaryText), normalizeSearchText(right.sortPath ?? right.primaryText)) ||
        compareText(left.sortPath ?? left.primaryText, right.sortPath ?? right.primaryText) ||
        compareText(left.value, right.value)
    );
}

function compareText(left: string, right: string): number {
  const leftCharacters = left[Symbol.iterator]();
  const rightCharacters = right[Symbol.iterator]();
  while (true) {
    const leftCharacter = leftCharacters.next();
    const rightCharacter = rightCharacters.next();
    if (leftCharacter.done || rightCharacter.done) return Number(rightCharacter.done) - Number(leftCharacter.done);
    const difference = (leftCharacter.value.codePointAt(0) ?? 0) - (rightCharacter.value.codePointAt(0) ?? 0);
    if (difference) return difference;
  }
}

export async function removeRecentHistoryResult<T>({
  value,
  prefix,
  records,
  remove,
  publish,
}: {
  value: string;
  prefix: string;
  records: Map<string, T>;
  remove: (recordId: string) => Promise<void>;
  publish: () => void;
}): Promise<boolean> {
  if (!value.startsWith(prefix)) {
    return false;
  }

  const recordId = value.slice(prefix.length);
  if (!records.has(recordId)) {
    return false;
  }

  await remove(recordId);
  records.delete(recordId);
  publish();
  return true;
}
