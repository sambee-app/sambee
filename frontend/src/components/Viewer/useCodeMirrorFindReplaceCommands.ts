import { useCallback, useEffect, useRef, useState } from "react";
import { CODEMIRROR_FIND_HISTORY_STORAGE_KEY, CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY } from "./codeMirrorFindReplaceConstants";
import {
  addCodeMirrorFindReplaceHistoryEntry,
  readCodeMirrorFindReplaceHistory,
  writeCodeMirrorFindReplaceHistory,
} from "./codeMirrorFindReplaceHistory";

function useFieldHistory(storageKey: string) {
  const [history, setHistory] = useState(() => readCodeMirrorFindReplaceHistory(storageKey));
  const unsavedEntries = useRef<string[]>([]);
  const readLatest = useCallback(
    () => unsavedEntries.current.reduceRight(addCodeMirrorFindReplaceHistoryEntry, readCodeMirrorFindReplaceHistory(storageKey)),
    [storageKey]
  );
  const updateHistory = useCallback((nextHistory: string[]) => {
    setHistory((previous) =>
      previous.length === nextHistory.length && previous.every((entry, index) => entry === nextHistory[index]) ? previous : nextHistory
    );
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if ((event.key === storageKey || event.key === null) && event.storageArea === window.localStorage) updateHistory(readLatest());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [readLatest, storageKey, updateHistory]);

  const record = useCallback(
    (value: string) => {
      if (value.trim().length === 0) return;

      // Another tab can write before its storage event reaches this editor.
      const latest = readLatest();
      const nextHistory = value === latest[0] ? latest : addCodeMirrorFindReplaceHistoryEntry(latest, value);
      if (nextHistory !== latest || unsavedEntries.current.length > 0) {
        unsavedEntries.current = writeCodeMirrorFindReplaceHistory(storageKey, nextHistory)
          ? []
          : addCodeMirrorFindReplaceHistoryEntry(unsavedEntries.current, value);
      }
      updateHistory(nextHistory);
    },
    [readLatest, storageKey, updateHistory]
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
