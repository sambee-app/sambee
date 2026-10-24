import { SearchQuery } from "@codemirror/search";
import { Text } from "@codemirror/state";
import type { MarkdownDocumentRecord } from "./markdownDocumentPreviewModel";

const BLOCK_TAGS = new Set("blockquote br div h1 h2 h3 h4 h5 h6 hr li ol p pre section table tbody td th thead tr ul".split(" "));

export interface DocumentSearchOptions {
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
}

export interface DocumentSearchSegment {
  id: number;
  from: number;
  to: number;
}

export interface DocumentSearchIndex {
  text: string;
  segments: DocumentSearchSegment[];
}

export class DocumentSearchIndexer {
  length = 0;
  private endsWithNewline = false;
  private ancestors = [{ id: 0, block: false, pre: false }];

  private separator() {
    if (!this.length || this.endsWithNewline) return;
    this.length += 1;
    this.endsWithNewline = true;
  }

  append(record: MarkdownDocumentRecord): DocumentSearchSegment | null {
    if (record.kind !== "element" && record.kind !== "text") return null;
    while (this.ancestors.at(-1)?.id !== record.parent) {
      if (this.ancestors.length === 1) throw new Error("Search record has no source-ordered parent");
      if (this.ancestors.pop()!.block) this.separator();
    }
    if (record.kind === "element") {
      const block = BLOCK_TAGS.has(record.tag);
      if (block) this.separator();
      this.ancestors.push({ id: record.id, block, pre: record.tag === "pre" || this.ancestors.at(-1)!.pre });
    } else {
      if (!this.ancestors.at(-1)!.pre && record.value.includes("\n") && /^\s*$/.test(record.value)) return null;
      const segment = { id: record.id, from: this.length, to: this.length + record.value.length };
      this.length = segment.to;
      this.endsWithNewline = record.value.endsWith("\n");
      return segment;
    }
    return null;
  }

  finish(): void {
    while (this.ancestors.length > 1) if (this.ancestors.pop()!.block) this.separator();
  }
}

export function createDocumentSearchIndex(records: Iterable<MarkdownDocumentRecord>): DocumentSearchIndex {
  const chunks: string[] = [];
  const segments: DocumentSearchSegment[] = [];
  const indexer = new DocumentSearchIndexer();
  for (const record of records) {
    const before = indexer.length;
    const segment = indexer.append(record);
    if ((segment?.from ?? indexer.length) > before) chunks.push("\n");
    if (segment && record.kind === "text") {
      segments.push(segment);
      chunks.push(record.value);
    }
  }
  const before = indexer.length;
  indexer.finish();
  if (indexer.length > before) chunks.push("\n");
  return { text: chunks.join(""), segments };
}

export function* documentSearchMatches(
  text: string | Text,
  query: string,
  options: DocumentSearchOptions = {}
): Generator<{ from: number; to: number }> {
  if (!query) return;
  const search = new SearchQuery({ search: query, literal: true, ...options });
  if (!search.valid) throw new Error("Invalid document search expression");
  const cursor = search.getCursor(typeof text === "string" ? Text.of(text.split("\n")) : text);
  for (let result = cursor.next(); !result.done; result = cursor.next()) yield { from: result.value.from, to: result.value.to };
}
