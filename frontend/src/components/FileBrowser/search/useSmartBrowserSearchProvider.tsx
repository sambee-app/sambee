import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SearchProvider, SearchResult, SearchResultsUpdate, SearchSelectionBehavior, SearchStatusInfo } from "./types";

interface SmartBrowserSearchProviderOptions {
  directoryProvider: SearchProvider;
  commandsProvider: SearchProvider;
}

const COMMAND_PREFIX = ">";

type ResultPrefix = "directory" | "command";

function prefixResults(prefix: ResultPrefix, results: SearchResult[]): SearchResult[] {
  return results.map((result) => {
    if (result.kind === "group-header") {
      return { ...result, id: `${prefix}:${result.id}` };
    }

    return {
      ...result,
      id: `${prefix}:${result.id}`,
      value: `${prefix}:${result.value}`,
    };
  });
}

function decodeValue(value: string): { prefix: ResultPrefix; rawValue: string } | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const prefix = value.slice(0, separatorIndex);
  if (prefix !== "directory" && prefix !== "command") {
    return null;
  }

  return {
    prefix,
    rawValue: value.slice(separatorIndex + 1),
  };
}

export function useSmartBrowserSearchProvider({ directoryProvider, commandsProvider }: SmartBrowserSearchProviderOptions): SearchProvider {
  const { t } = useTranslation();
  const [isCommandQuery, setIsCommandQuery] = useState(false);

  const getMinQueryLength = useCallback(
    (query: string): number => {
      if (query.startsWith(COMMAND_PREFIX)) {
        return 1;
      }

      return directoryProvider.getMinQueryLength?.(query) ?? directoryProvider.minQueryLength;
    },
    [directoryProvider]
  );

  const getBelowMinimumMessage = useCallback(
    (query: string): string | undefined => {
      if (query.startsWith(COMMAND_PREFIX)) {
        return undefined;
      }

      return directoryProvider.getBelowMinimumMessage?.(query) ?? directoryProvider.belowMinimumMessage;
    },
    [directoryProvider]
  );

  const fetchResults = useCallback(
    async (query: string, signal: AbortSignal, onUpdate?: SearchResultsUpdate, refresh?: boolean): Promise<SearchResult[]> => {
      if (query.startsWith(COMMAND_PREFIX)) {
        setIsCommandQuery(true);
        const commandQuery = query.slice(COMMAND_PREFIX.length).trimStart();
        const commandResults = await commandsProvider.fetchResults(
          commandQuery,
          signal,
          onUpdate ? (results) => onUpdate(prefixResults("command", results)) : undefined
        );
        return prefixResults("command", commandResults);
      }

      setIsCommandQuery(false);

      if (query.length < directoryProvider.minQueryLength) {
        return [];
      }

      const directoryResults = await directoryProvider.fetchResults(
        query,
        signal,
        onUpdate ? (results) => onUpdate(prefixResults("directory", results)) : undefined,
        refresh
      );
      return prefixResults("directory", directoryResults);
    },
    [commandsProvider, directoryProvider]
  );

  const onSelect = useCallback(
    (value: string): SearchSelectionBehavior | undefined => {
      const decoded = decodeValue(value);
      if (!decoded) {
        return undefined;
      }

      switch (decoded.prefix) {
        case "command":
          return commandsProvider.onSelect(decoded.rawValue);
        case "directory":
          return directoryProvider.onSelect(decoded.rawValue);
      }
    },
    [commandsProvider, directoryProvider]
  );

  const getStatusInfo = useCallback((): SearchStatusInfo | null => {
    if (isCommandQuery) {
      return null;
    }

    return directoryProvider.getStatusInfo();
  }, [directoryProvider, isCommandQuery]);

  const onQueryChange = useCallback((query: string) => {
    setIsCommandQuery(query.startsWith(COMMAND_PREFIX));
  }, []);

  const onActivate = useCallback(() => {
    setIsCommandQuery(false);
    directoryProvider.onActivate?.();
  }, [directoryProvider]);

  const onDeactivate = useCallback(() => {
    directoryProvider.onDeactivate?.();
    setIsCommandQuery(false);
  }, [directoryProvider]);

  const footerHint = useMemo(() => {
    if (isCommandQuery) {
      return commandsProvider.footerHint;
    }

    return (
      <>
        ↑↓ {t("fileBrowser.search.footer.navigate")}&ensp;↵ {t("fileBrowser.search.footer.open")}&ensp;<kbd>&gt;</kbd>{" "}
        {t("fileBrowser.search.footer.commands")}&ensp;<kbd>esc</kbd> {t("fileBrowser.search.footer.close")}
      </>
    );
  }, [commandsProvider.footerHint, isCommandQuery, t]);

  const footerInfo = useCallback(
    (resultCount: number): string | undefined => {
      if (isCommandQuery) {
        return commandsProvider.footerInfo?.(resultCount);
      }

      return t("fileBrowser.search.results.count", { count: resultCount });
    },
    [commandsProvider, isCommandQuery, t]
  );

  return {
    id: "smart-browser-search",
    modeId: isCommandQuery ? "commands" : "navigate",
    modeLabel: isCommandQuery ? t("fileBrowser.search.modes.commands") : t("fileBrowser.search.modes.navigate"),
    placeholder: isCommandQuery ? t("fileBrowser.search.placeholders.command") : t("fileBrowser.search.placeholders.smart"),
    debounceMs: 0,
    minQueryLength: directoryProvider.minQueryLength,
    getMinQueryLength,
    fetchResults,
    onSelect,
    getStatusInfo,
    onActivate,
    onQueryChange,
    onDeactivate,
    footerHint,
    footerInfo,
    shortcutHint: isCommandQuery ? commandsProvider.shortcutHint : directoryProvider.shortcutHint,
    belowMinimumMessage: directoryProvider.belowMinimumMessage,
    getBelowMinimumMessage,
  };
}
