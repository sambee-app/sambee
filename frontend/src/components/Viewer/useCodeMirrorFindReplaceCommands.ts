import { useCallback, useState } from "react";
import { CODEMIRROR_FIND_HISTORY_STORAGE_KEY, CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY } from "./codeMirrorFindReplaceConstants";
import {
  addCodeMirrorFindReplaceHistoryEntry,
  readCodeMirrorFindReplaceHistory,
  writeCodeMirrorFindReplaceHistory,
} from "./codeMirrorFindReplaceHistory";

function useFieldHistory(storageKey: string) {
  const [history, setHistory] = useState(() => readCodeMirrorFindReplaceHistory(storageKey));
  const record = useCallback(
    (value: string) => {
      if (value === history[0]) return;

      const nextHistory = addCodeMirrorFindReplaceHistoryEntry(history, value);
      if (nextHistory === history) return;

      setHistory(nextHistory);
      writeCodeMirrorFindReplaceHistory(storageKey, nextHistory);
    },
    [history, storageKey]
  );
  return [history, record] as const;
}

interface FindReplaceCommandOptions {
  available: boolean;
  replaceMode: boolean;
  replacement: string;
  searchText: string;
  regexp: boolean;
  searchState: {
    searchText: string;
    searchMatches: number;
    isSearchOpen: boolean;
    isValid: boolean;
    pending?: boolean;
    error?: string;
  };
}

export function useCodeMirrorFindReplaceCommands({
  available,
  replaceMode,
  replacement,
  searchText,
  regexp,
  searchState,
}: FindReplaceCommandOptions) {
  const [findHistory, recordFind] = useFieldHistory(CODEMIRROR_FIND_HISTORY_STORAGE_KEY);
  const [replaceHistory, recordReplacement] = useFieldHistory(CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY);
  const activeQuery =
    available && searchState.isSearchOpen && searchState.isValid && searchState.searchText === searchText && searchText.trim().length > 0;
  const hasMatches = searchState.searchMatches > 0;
  const canNavigate = activeQuery && (hasMatches || (regexp && Boolean(searchState.pending || searchState.error)));
  const canReplace = activeQuery && replaceMode && hasMatches && !searchState.pending && !searchState.error;

  const runFind = useCallback(
    (command: () => void) => {
      if (!canNavigate) return;
      command();
      recordFind(searchText);
    },
    [canNavigate, recordFind, searchText]
  );
  const runReplace = useCallback(
    (command: () => void) => {
      if (!canReplace) return;
      command();
      recordFind(searchText);
      recordReplacement(replacement);
    },
    [canReplace, recordFind, recordReplacement, replacement, searchText]
  );

  return { canNavigate, canReplace, findHistory, replaceHistory, runFind, runReplace };
}
