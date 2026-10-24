import type { Element, ElementContent, Root } from "hast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  normalizeMarkdownTableCellLineBreaks,
  remarkRenderMarkdownTableCellLineBreaks,
} from "../components/Viewer/markdownTableCellLineBreaks";
import { createCodePreviewModel } from "./markdownCodePreviewModel";
import type { CodeBlockRequest, SyntaxRange } from "./syntaxHighlighting";

export const DOCUMENT_RECORD_BATCH_ITEMS = 64;
export const DOCUMENT_PUBLICATION_BATCH_ITEMS = 512;
export const DOCUMENT_PUBLICATION_BATCH_UNITS = 16_384;
export const DOCUMENT_TEXT_CHUNK_UNITS = 2_048;
export const DOCUMENT_SYNTAX_CACHE_RANGES = 4_000;
export const DOCUMENT_SYNTAX_WINDOW_PARTS = 40;
const TABLE_STRUCTURE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

export type MarkdownDocumentRecord =
  | { kind: "element"; id: number; parent: number; tag: string; fragment?: boolean }
  | { kind: "attribute"; id: number; name: string; value: string; final: boolean }
  | { kind: "text"; id: number; parent: number; value: string; from: number }
  | { kind: "syntax"; id: number; range: SyntaxRange }
  | { kind: "fallback"; id: number; reason: string };

export interface MarkdownDocumentModel {
  source: string;
  tree: Root;
  codeBlocks: (CodeBlockRequest & { id: number })[];
}

export interface DocumentSyntaxWindow {
  id: number;
  from: number;
  to: number;
}

export function documentSyntaxPage(
  ranges: readonly SyntaxRange[],
  window: DocumentSyntaxWindow,
  offset: number
): { records: Extract<MarkdownDocumentRecord, { kind: "syntax" }>[]; next: number | null } {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(window.from) ||
    !Number.isSafeInteger(window.to) ||
    window.from < 0 ||
    window.to < window.from
  )
    throw new Error("Invalid document syntax window");
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle];
    if (range && range.to <= window.from) low = middle + 1;
    else high = middle;
  }
  const records: Extract<MarkdownDocumentRecord, { kind: "syntax" }>[] = [];
  let index = low + offset;
  for (; index < ranges.length && records.length < DOCUMENT_RECORD_BATCH_ITEMS; index += 1) {
    const range = ranges[index];
    if (!range || range.from >= window.to) break;
    records.push({ kind: "syntax", id: window.id, range });
  }
  const nextRange = ranges[index];
  return { records, next: nextRange && nextRange.from < window.to ? index - low : null };
}

export async function createMarkdownDocumentModel(
  source: string,
  options: { normalizeSource?: boolean } = {}
): Promise<MarkdownDocumentModel> {
  const normalizedSource = options.normalizeSource ? normalizeMarkdownTableCellLineBreaks(source) : source;
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRenderMarkdownTableCellLineBreaks)
    .use(remarkRehype, { allowDangerousHtml: true });
  const tree = (await processor.run(processor.parse(normalizedSource))) as Root;
  return { source: normalizedSource, tree, codeBlocks: [] };
}

export function* markdownDocumentRecords(model: MarkdownDocumentModel): Generator<MarkdownDocumentRecord> {
  let nextId = 1;
  const stack: { node: ElementContent; parent: number; parentTag?: string; from?: number; fragment?: boolean }[] = [...model.tree.children]
    .reverse()
    .map((node) => ({ node: node as ElementContent, parent: 0 }));
  while (stack.length) {
    const entry = stack.pop()!;
    const { node, parent } = entry;
    if ("value" in node && typeof node.value === "string") {
      if (TABLE_STRUCTURE_TAGS.has(entry.parentTag ?? "") && /^\s*$/.test(node.value)) continue;
      for (let from = 0; from < node.value.length; from += DOCUMENT_TEXT_CHUNK_UNITS) {
        yield {
          kind: "text",
          id: nextId++,
          parent,
          value: node.value.slice(from, from + DOCUMENT_TEXT_CHUNK_UNITS),
          from: (entry.from ?? 0) + from,
        };
      }
      continue;
    }
    if (node.type !== "element") continue;
    const id = nextId++;
    yield { kind: "element", id, parent, tag: node.tagName, fragment: entry.fragment };
    for (const [name, value] of Object.entries(node.properties)) {
      if (value === null || value === undefined || value === false) continue;
      const text = Array.isArray(value) ? value.join(" ") : value === true ? "" : String(value);
      for (let from = 0; from < Math.max(1, text.length); from += DOCUMENT_TEXT_CHUNK_UNITS) {
        yield {
          kind: "attribute",
          id,
          name,
          value: text.slice(from, from + DOCUMENT_TEXT_CHUNK_UNITS),
          final: from + DOCUMENT_TEXT_CHUNK_UNITS >= text.length,
        };
      }
    }
    if (node.tagName === "code" && entry.parentTag === "pre" && node.children.every((child) => child.type === "text")) {
      const text = node.children.map((child) => (child.type === "text" ? child.value : "")).join("");
      const label = Array.isArray(node.properties["className"])
        ? node.properties["className"].find((name) => String(name).startsWith("language-"))
        : undefined;
      model.codeBlocks.push({ id, text, label: label ? String(label).slice("language-".length) : null });
      for (const fragment of [...createCodePreviewModel(text, []).fragments].reverse()) {
        const span: Element = {
          type: "element",
          tagName: "span",
          properties: {},
          children: [{ type: "text", value: text.slice(fragment.from, fragment.to) }],
        };
        stack.push({ node: span, parent: id, from: fragment.from, fragment: true });
      }
    } else {
      for (const child of [...node.children].reverse()) stack.push({ node: child, parent: id, parentTag: node.tagName, from: entry.from });
    }
  }
}
