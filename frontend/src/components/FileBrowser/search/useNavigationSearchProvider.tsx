import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { compareText, rankHistorySearchResults, searchTerms } from "./recentHistory";
import type { SearchProvider, SearchResult, SearchSelectionAction, SearchStatusInfo } from "./types";

export type NavigationItemType = "all" | "directories" | "files";
export type NavigationScope = "connection" | "subtree" | "descendants_only";

type ProviderKind = "directories" | "files";

function prefixResults(kind: ProviderKind, results: SearchResult[]): SearchResult[] {
  return results.map((result) =>
    result.kind === "group-header"
      ? { ...result, id: `${kind}:${result.id}` }
      : { ...result, id: `${kind}:${result.id}`, value: `${kind}:${result.value}` }
  );
}

function decodeResult(value: string): { kind: ProviderKind; value: string } | null {
  for (const kind of ["directories", "files"] as const) {
    const prefix = `${kind}:`;
    if (value.startsWith(prefix)) return { kind, value: value.slice(prefix.length) };
  }
  return null;
}

export function useNavigationSearchProvider(
  directories: SearchProvider,
  files: SearchProvider,
  itemType: NavigationItemType
): SearchProvider {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const generationRef = useRef(0);
  const includeDirectories = itemType !== "files";
  const includeFiles = itemType !== "directories";

  const fetchResults: SearchProvider["fetchResults"] = useCallback(
    async (query, signal, onUpdate, refresh) => {
      setFailed(false);
      const generation = ++generationRef.current;
      const isCurrent = () => !signal.aborted && generation === generationRef.current;
      let directoryRows: SearchResult[] = [];
      let fileRows: SearchResult[] = [];
      const hasQuery = searchTerms(query).length > 0;
      const merged = (): SearchResult[] => {
        const items = [...directoryRows, ...fileRows].filter((row) => row.kind === "result");
        if (items.length === 0) return [];
        return [
          {
            kind: "group-header",
            id: "navigation-results",
            value: "",
            label: t(hasQuery ? "fileBrowser.search.groups.matches" : "fileBrowser.search.groups.recentItems"),
          },
          ...(hasQuery
            ? rankHistorySearchResults(items, query)
            : items.sort(
                (left, right) =>
                  (Date.parse(right.lastUsedAt ?? "") || 0) - (Date.parse(left.lastUsedAt ?? "") || 0) || compareText(left.id, right.id)
              )),
        ];
      };
      const publish = () => {
        if (isCurrent()) onUpdate?.(merged());
      };
      const requests: Promise<void>[] = [];
      const request = (provider: SearchProvider, kind: ProviderKind) =>
        Promise.resolve().then(async () => {
          const update = (rows: SearchResult[]) => {
            if (kind === "directories") directoryRows = prefixResults(kind, rows);
            else fileRows = prefixResults(kind, rows);
            publish();
          };
          update(await provider.fetchResults(query, signal, update, refresh));
        });
      if (includeDirectories) requests.push(request(directories, "directories"));
      if (includeFiles) requests.push(request(files, "files"));
      const outcomes = await Promise.allSettled(requests);
      if (isCurrent()) setFailed(outcomes.some((outcome) => outcome.status === "rejected"));
      return isCurrent() ? merged() : [];
    },
    [directories, files, includeDirectories, includeFiles, t]
  );

  const onSelect = useCallback(
    (value: string, action?: SearchSelectionAction) => {
      const decoded = decodeResult(value);
      if (!decoded) return undefined;
      return (decoded.kind === "directories" ? directories : files).onSelect(decoded.value, action);
    },
    [directories, files]
  );

  const getStatusInfo = useCallback((): SearchStatusInfo | null => {
    const statuses = [
      ...(includeDirectories ? [directories.getStatusInfo()] : []),
      ...(includeFiles ? [files.getStatusInfo()] : []),
      ...(failed ? [{ label: t("fileBrowser.search.results.failed"), showSpinner: false }] : []),
    ].filter((status): status is SearchStatusInfo => status !== null);
    if (!statuses.length) return null;
    return {
      ...statuses[0],
      label: statuses.map((status) => status.label).join(" "),
      showSpinner: statuses.some((status) => status.showSpinner),
      suppressEmpty: statuses.some((status) => status.suppressEmpty),
    };
  }, [directories, failed, files, includeDirectories, includeFiles, t]);

  return {
    ...directories,
    id: "navigation-search",
    placeholder: t("fileBrowser.search.modes.quickNav"),
    sourceKey: JSON.stringify([directories.sourceKey, files.sourceKey, itemType]),
    fetchResults,
    onSelect,
    onRemoveSelected: async (value) => {
      const decoded = decodeResult(value);
      if (!decoded) return false;
      return (decoded.kind === "directories" ? directories : files).onRemoveSelected?.(decoded.value) ?? false;
    },
    getStatusInfo,
    onActivate: () => {
      if (includeDirectories) directories.onActivate?.();
      if (includeFiles) files.onActivate?.();
    },
    onDeactivate: () => {
      generationRef.current += 1;
      directories.onDeactivate?.();
      files.onDeactivate?.();
    },
    invalidateResults: () => {
      directories.invalidateResults?.();
      files.invalidateResults?.();
    },
    getRefreshIntervalMs: () => (includeDirectories ? (directories.getRefreshIntervalMs?.() ?? null) : null),
    getFooterHint: (selected) => {
      if (selected?.kind !== "result") return directories.getFooterHint?.(selected);
      const decoded = decodeResult(selected.value);
      if (!decoded) return undefined;
      const provider = decoded.kind === "directories" ? directories : files;
      return provider.getFooterHint?.({ ...selected, value: decoded.value });
    },
  };
}
