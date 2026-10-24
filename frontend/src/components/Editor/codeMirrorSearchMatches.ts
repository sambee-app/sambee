import { getSearchQuery, type SearchQuery } from "@codemirror/search";
import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getSourceRegexSearch } from "./sourceRegexSearch";

interface SearchMatchRange {
  from: number;
  to: number;
}

interface CachedSearchMatches {
  document: Text;
  query: SearchQuery;
  ranges: SearchMatchRange[];
}

const matchCache = new WeakMap<EditorView, CachedSearchMatches>();

export function getCachedCodeMirrorSearchMatches(view: EditorView): readonly SearchMatchRange[] | null {
  if (getSearchQuery(view.state).regexp) return getSourceRegexSearch(view).ranges;
  const cached = matchCache.get(view);
  return cached?.document === view.state.doc && cached.query.eq(getSearchQuery(view.state)) ? cached.ranges : null;
}

export function getCodeMirrorSearchMatches(view: EditorView): readonly SearchMatchRange[] {
  const cached = getCachedCodeMirrorSearchMatches(view);
  if (cached) return cached;
  const query = getSearchQuery(view.state);
  const ranges: SearchMatchRange[] = [];
  const cursor = query.getCursor(view.state);
  for (let match = cursor.next(); !match.done; match = cursor.next()) ranges.push({ from: match.value.from, to: match.value.to });
  matchCache.set(view, { document: view.state.doc, query, ranges });
  return ranges;
}

export function findSelectedCodeMirrorSearchMatch(ranges: readonly SearchMatchRange[], selection: SearchMatchRange): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (!range) return -1;
    if (range.from < selection.from) low = middle + 1;
    else high = middle;
  }
  const match = ranges[low];
  return match && match.to <= selection.to ? low : -1;
}
