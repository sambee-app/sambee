import {
  getSearchQuery,
  findNext as nativeFindNext,
  findPrevious as nativeFindPrevious,
  replaceAll as nativeReplaceAll,
  replaceNext as nativeReplaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { t } from "i18next";
import { logger } from "../../services/logger";
import { findSelectedCodeMirrorSearchMatch, getCodeMirrorSearchMatches } from "../Editor/codeMirrorSearchMatches";
import { getSourceRegexSearch, runSourceRegexSearchCommand } from "../Editor/sourceRegexSearch";
import {
  beginSourceReplacementFeedback,
  isHeavySourceReplacement,
  isSourceReplacementPending,
  SOURCE_REPLACEMENT_HEAVY_MATCHES,
} from "../Editor/sourceReplacementFeedback";

export const findNext = (view: EditorView): boolean => runSourceRegexSearchCommand(view, "next") || nativeFindNext(view);
export const findPrevious = (view: EditorView): boolean => runSourceRegexSearchCommand(view, "previous") || nativeFindPrevious(view);
export const replaceNext = (view: EditorView): boolean => runSourceRegexSearchCommand(view, "replace-one") || nativeReplaceNext(view);
export const replaceAll = (view: EditorView): boolean => {
  if (isSourceReplacementPending(view)) return true;
  if (runSourceRegexSearchCommand(view, "replace-all")) return true;
  const query = getSearchQuery(view.state);
  if (!query.valid || view.state.readOnly) return nativeReplaceAll(view);
  const cursor = query.getCursor(view.state);
  let matches = 0;
  for (let match = cursor.next(); !match.done && matches < SOURCE_REPLACEMENT_HEAVY_MATCHES; match = cursor.next()) matches += 1;
  if (!isHeavySourceReplacement(view.state.doc.length, matches, matches * query.replace.length)) return nativeReplaceAll(view);
  beginSourceReplacementFeedback(view).apply(
    () => nativeReplaceAll(view),
    true,
    (error) => {
      logger.error("Atomic replacement failed; retry Replace All.", { error });
      view.dispatch({ effects: EditorView.announce.of(t("viewer.edit.replacementFailed")) });
    }
  );
  return true;
};

export interface CodeMirrorFindReplaceRequest {
  caseSensitive: boolean;
  regexp: boolean;
  searchOpen: boolean;
  searchText: string;
  wholeWord: boolean;
}

export interface CodeMirrorFindReplaceMetrics {
  pending: boolean;
  error?: string;
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
    return { currentMatch: 0, isSearchable, isValid: true, matches: 0, searchText, pending: false };
  }

  if (!query.valid) {
    return { currentMatch: 0, isSearchable, isValid: false, matches: 0, searchText, pending: false };
  }

  const ranges = getCodeMirrorSearchMatches(view);
  const currentMatch = findSelectedCodeMirrorSearchMatch(ranges, view.state.selection.main) + 1;
  const regex = query.regexp ? getSourceRegexSearch(view) : undefined;
  return {
    currentMatch,
    isSearchable,
    isValid: true,
    matches: ranges.length,
    searchText,
    pending: isSourceReplacementPending(view) || (regex?.pending ?? false),
    error: regex?.error,
  };
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
    return { currentMatch: 0, isSearchable: false, isValid: true, matches: 0, searchText: "", pending: false };
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
