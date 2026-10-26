import type { SearchResult, SearchResultItem } from "./types";

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
}

export function historyMatchRank(name: string, query: string): number {
  const normalizedName = normalizeSearchText(name);
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return 3;
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(normalizedName)) return 2;
  return 3;
}

/** Typed searches rank across sources; empty searches keep their history groups. */
export function rankHistorySearchResults(results: SearchResult[], query: string): SearchResult[] {
  if (!query.trim()) return results;
  return results
    .filter((result): result is SearchResultItem => result.kind === "result")
    .sort((left, right) => (left.matchRank ?? 3) - (right.matchRank ?? 3) || (right.usageScore ?? 0) - (left.usageScore ?? 0));
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
