import { getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { findSelectedCodeMirrorSearchMatch, getCodeMirrorSearchMatches } from "../Editor/codeMirrorSearchMatches";

export interface CodeMirrorFindReplaceRequest {
  caseSensitive: boolean;
  regexp: boolean;
  searchOpen: boolean;
  searchText: string;
  wholeWord: boolean;
}

export interface CodeMirrorFindReplaceMetrics {
  currentMatch: number;
  isSearchable: boolean;
  isValid: boolean;
  matches: number;
  searchText: string;
}

export interface CodeMirrorFindReplaceOptions {
  caseSensitive: boolean;
  regexp: boolean;
  replace: string;
  searchText: string;
  wholeWord: boolean;
}

function resolveSearchMatchState(view: EditorView): CodeMirrorFindReplaceMetrics {
  const query = getSearchQuery(view.state);
  const searchText = query.search;
  const isSearchable = view.state.doc.length > 0;

  if (!searchText) {
    return { currentMatch: 0, isSearchable, isValid: true, matches: 0, searchText };
  }

  if (!query.valid) {
    return { currentMatch: 0, isSearchable, isValid: false, matches: 0, searchText };
  }

  const ranges = getCodeMirrorSearchMatches(view);
  const currentMatch = findSelectedCodeMirrorSearchMatch(ranges, view.state.selection.main) + 1;
  return { currentMatch, isSearchable, isValid: true, matches: ranges.length, searchText };
}

export function updateCodeMirrorFindReplaceQuery(view: EditorView | null | undefined, options: CodeMirrorFindReplaceOptions): void {
  if (!view) {
    return;
  }

  view.dispatch({
    effects: setSearchQuery.of(
      new SearchQuery({
        caseSensitive: options.caseSensitive,
        literal: true,
        regexp: options.regexp,
        replace: options.replace,
        search: options.searchText,
        wholeWord: options.wholeWord,
      })
    ),
  });
}

export function getCodeMirrorFindReplaceMetrics(view: EditorView | null | undefined): CodeMirrorFindReplaceMetrics {
  if (!view) {
    return { currentMatch: 0, isSearchable: false, isValid: true, matches: 0, searchText: "" };
  }

  return resolveSearchMatchState(view);
}

export function shouldAutoNavigateCodeMirrorFindReplace(
  previousRequest: CodeMirrorFindReplaceRequest | null,
  currentRequest: CodeMirrorFindReplaceRequest,
  searchAutoNavigate: boolean
): boolean {
  return (
    searchAutoNavigate &&
    currentRequest.searchOpen &&
    currentRequest.searchText.trim().length > 0 &&
    (!previousRequest ||
      previousRequest.searchText !== currentRequest.searchText ||
      previousRequest.searchOpen !== currentRequest.searchOpen)
  );
}
