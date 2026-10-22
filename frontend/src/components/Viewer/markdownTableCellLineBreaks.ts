import type { Break, Html, List, ListItem, Parent, PhrasingContent, Root, Table, TableCell } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

const BREAK_HTML_PATTERN = /^<\/?br\s*\/?>$/i;
const NUMERIC_LINE_BREAK_ENTITY_PATTERN = /&#(?:0*10|x0*a);/gi;

function createMdastBreakNode(): Break {
  return { type: "break" };
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

interface MarkdownReplacement {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

interface MarkdownTableSnapshot {
  semanticSignature: string;
  source: string;
  startOffset: number;
  endOffset: number;
}

function isBreakHtmlNode(node: PhrasingContent | undefined): node is Html {
  return node?.type === "html" && typeof node.value === "string" && BREAK_HTML_PATTERN.test(node.value.trim());
}

function hasPhrasingChildren(node: PhrasingContent): node is Parent & PhrasingContent & { children: PhrasingContent[] } {
  return "children" in node && Array.isArray(node.children);
}

function convertCanonicalBreakHtmlToMdastBreaks(children: PhrasingContent[]): PhrasingContent[] {
  const renderedChildren: PhrasingContent[] = [];

  for (const child of children) {
    if (isBreakHtmlNode(child)) {
      renderedChildren.push(createMdastBreakNode());
      continue;
    }

    if (hasPhrasingChildren(child)) {
      renderedChildren.push({
        ...child,
        children: convertCanonicalBreakHtmlToMdastBreaks(child.children),
      } as PhrasingContent);
      continue;
    }

    renderedChildren.push(child);
  }

  return renderedChildren;
}

function collectCanonicalBreakHtmlReplacements(children: PhrasingContent[], replacements: MarkdownReplacement[]): void {
  for (const child of children) {
    if (isBreakHtmlNode(child)) {
      const startOffset = child.position?.start.offset;
      const endOffset = child.position?.end.offset;

      if (typeof startOffset === "number" && typeof endOffset === "number") {
        replacements.push({ startOffset, endOffset, replacement: "<br>" });
      }

      continue;
    }

    if (hasPhrasingChildren(child)) {
      collectCanonicalBreakHtmlReplacements(child.children, replacements);
    }
  }
}

function applyMarkdownReplacements(markdown: string, replacements: MarkdownReplacement[]): string {
  if (replacements.length === 0) {
    return markdown;
  }

  let nextMarkdown = markdown;

  for (const { startOffset, endOffset, replacement } of [...replacements].sort((left, right) => right.startOffset - left.startOffset)) {
    nextMarkdown = `${nextMarkdown.slice(0, startOffset)}${replacement}${nextMarkdown.slice(endOffset)}`;
  }

  return nextMarkdown;
}

function setMarkdownReplacement(replacements: Map<string, MarkdownReplacement>, replacement: MarkdownReplacement): void {
  for (const [key, existingReplacement] of replacements) {
    const overlaps = replacement.startOffset < existingReplacement.endOffset && replacement.endOffset > existingReplacement.startOffset;

    if (overlaps) {
      replacements.delete(key);
    }
  }

  replacements.set(`${replacement.startOffset}:${replacement.endOffset}`, replacement);
}

function collectTableCellBreakReplacements(
  markdown: string,
  children: PhrasingContent[],
  replacements: Map<string, MarkdownReplacement>
): void {
  for (const child of children) {
    const startOffset = child.position?.start.offset;
    const endOffset = child.position?.end.offset;

    if (isBreakHtmlNode(child) && typeof startOffset === "number" && typeof endOffset === "number") {
      setMarkdownReplacement(replacements, { startOffset, endOffset, replacement: "<br />" });
      continue;
    }

    if (child.type === "text" && child.value.includes("\n") && typeof startOffset === "number" && typeof endOffset === "number") {
      const source = markdown.slice(startOffset, endOffset);

      for (const match of source.matchAll(NUMERIC_LINE_BREAK_ENTITY_PATTERN)) {
        if (typeof match.index !== "number") {
          continue;
        }

        const entityStartOffset = startOffset + match.index;
        setMarkdownReplacement(replacements, {
          startOffset: entityStartOffset,
          endOffset: entityStartOffset + match[0].length,
          replacement: "<br />",
        });
      }
    }

    if (hasPhrasingChildren(child)) {
      collectTableCellBreakReplacements(markdown, child.children, replacements);
    }
  }
}

function collectTrailingTableCellBreakReplacements(
  markdown: string,
  children: PhrasingContent[],
  replacements: Map<string, MarkdownReplacement>
): boolean {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];

    if (!child) {
      continue;
    }

    const startOffset = child.position?.start.offset;
    const endOffset = child.position?.end.offset;

    if (isBreakHtmlNode(child) && typeof startOffset === "number" && typeof endOffset === "number") {
      setMarkdownReplacement(replacements, { startOffset, endOffset, replacement: "" });
      continue;
    }

    if (child.type === "text" && child.value.endsWith("\n") && typeof startOffset === "number" && typeof endOffset === "number") {
      const source = markdown.slice(startOffset, endOffset);
      const trailingEntities = /(?:&#(?:0*10|x0*a);)+$/i.exec(source);

      if (trailingEntities?.index !== undefined) {
        setMarkdownReplacement(replacements, {
          startOffset: startOffset + trailingEntities.index,
          endOffset,
          replacement: "",
        });
      }

      if (child.value.replace(/\n+$/, "").length === 0) {
        continue;
      }
    }

    if (hasPhrasingChildren(child) && collectTrailingTableCellBreakReplacements(markdown, child.children, replacements)) {
      continue;
    }

    return false;
  }

  return true;
}

function collectListMarkerReplacements(markdown: string, tree: Root, replacements: Map<string, MarkdownReplacement>): void {
  visit(tree, "listItem", (node, _index, parent) => {
    const listItem = node as ListItem;
    const list = parent as List | undefined;
    const startOffset = listItem.position?.start.offset;

    if (typeof startOffset !== "number" || list?.type !== "list") {
      return;
    }

    const marker = /^(?:[-+*]|\d+[.)])(?=\s)/.exec(markdown.slice(startOffset));

    if (!marker) {
      return;
    }

    setMarkdownReplacement(replacements, {
      startOffset,
      endOffset: startOffset + marker[0].length,
      replacement: list.ordered ? "1." : "-",
    });
  });
}

function getPhrasingSemanticSignature(children: PhrasingContent[]): string {
  return JSON.stringify(
    children.map((child) => {
      if (child.type === "text") {
        return { type: "text", value: child.value };
      }

      if (isBreakHtmlNode(child)) {
        return { type: "break" };
      }

      if (hasPhrasingChildren(child)) {
        return {
          type: child.type,
          children: getPhrasingSemanticSignature(child.children),
        };
      }

      return child;
    })
  );
}

function collectMarkdownTableSnapshots(markdown: string): MarkdownTableSnapshot[] {
  const tree = markdownParser.parse(markdown) as Root;
  const tables: MarkdownTableSnapshot[] = [];

  visit(tree, "table", (node) => {
    const tableNode = node as Table;
    const startOffset = tableNode.position?.start.offset;
    const endOffset = tableNode.position?.end.offset;

    if (typeof startOffset !== "number" || typeof endOffset !== "number") {
      return;
    }

    tables.push({
      semanticSignature: JSON.stringify({
        align: tableNode.align,
        rows: tableNode.children.map((row) => row.children.map((cell) => getPhrasingSemanticSignature((cell as TableCell).children))),
      }),
      source: markdown.slice(startOffset, endOffset),
      startOffset,
      endOffset,
    });
  });

  return tables;
}

function haveEquivalentMarkdownTables(previousMarkdown: string, nextMarkdown: string): boolean {
  const previousTables = collectMarkdownTableSnapshots(previousMarkdown);
  const nextTables = collectMarkdownTableSnapshots(nextMarkdown);

  return (
    previousTables.length === nextTables.length &&
    previousTables.every((previousTable, index) => previousTable.semanticSignature === nextTables[index]?.semanticSignature)
  );
}

function removeRedundantTableCellEscapes(markdown: string, tree: Root): string {
  const escapeOffsetGroups: number[][] = [];

  visit(tree, "tableCell", (node) => {
    const tableCell = node as TableCell;
    const startOffset = tableCell.position?.start.offset;
    const endOffset = tableCell.position?.end.offset;

    if (typeof startOffset !== "number" || typeof endOffset !== "number") {
      return;
    }

    const source = markdown.slice(startOffset, endOffset);
    const escapeOffsets: number[] = [];

    for (const match of source.matchAll(/\\[&*]/g)) {
      if (typeof match.index === "number") {
        escapeOffsets.push(startOffset + match.index);
      }
    }

    if (escapeOffsets.length > 0) {
      escapeOffsetGroups.push(escapeOffsets);
    }
  });

  let normalizedMarkdown = markdown;

  for (const escapeOffsets of escapeOffsetGroups.sort((left, right) => (right[0] ?? 0) - (left[0] ?? 0))) {
    const safeEscapeOffsets = escapeOffsets.filter((escapeOffset) => {
      const candidateMarkdown = `${normalizedMarkdown.slice(0, escapeOffset)}${normalizedMarkdown.slice(escapeOffset + 1)}`;
      return haveEquivalentMarkdownTables(normalizedMarkdown, candidateMarkdown);
    });

    let candidateMarkdown = normalizedMarkdown;

    for (const escapeOffset of safeEscapeOffsets.sort((left, right) => right - left)) {
      candidateMarkdown = `${candidateMarkdown.slice(0, escapeOffset)}${candidateMarkdown.slice(escapeOffset + 1)}`;
    }

    if (haveEquivalentMarkdownTables(normalizedMarkdown, candidateMarkdown)) {
      normalizedMarkdown = candidateMarkdown;
    }
  }

  return normalizedMarkdown;
}

export function normalizeMarkdownTableCellLineBreaks(markdown: string, onPrepared?: (source: string, tree: Root) => void): string {
  const sourceTree = markdownParser.parse(markdown) as Root;
  const sourceMarkdown = removeRedundantTableCellEscapes(markdown, sourceTree);
  const tree = sourceMarkdown === markdown ? sourceTree : (markdownParser.parse(sourceMarkdown) as Root);
  const replacements = new Map<string, MarkdownReplacement>();

  visit(tree, "tableCell", (node) => {
    const tableCellNode = node as TableCell;
    collectTableCellBreakReplacements(sourceMarkdown, tableCellNode.children, replacements);
    collectTrailingTableCellBreakReplacements(sourceMarkdown, tableCellNode.children, replacements);
  });

  collectListMarkerReplacements(sourceMarkdown, tree, replacements);

  const normalized = applyMarkdownReplacements(sourceMarkdown, [...replacements.values()]);
  if (onPrepared) onPrepared(normalized, normalized === sourceMarkdown ? tree : (markdownParser.parse(normalized) as Root));
  return normalized;
}

export function prepareMarkdownTableCellLineBreaksForEditor(markdown: string): string {
  if (!markdown.includes("<br")) {
    return markdown;
  }

  const tree = markdownParser.parse(markdown) as Root;
  const replacements: MarkdownReplacement[] = [];

  visit(tree, "tableCell", (node) => {
    const tableCellNode = node as TableCell;
    collectCanonicalBreakHtmlReplacements(tableCellNode.children, replacements);
  });

  return applyMarkdownReplacements(markdown, replacements);
}

export function preserveUnchangedMarkdownTableSource(previousMarkdown: string, nextMarkdown: string): string {
  if (previousMarkdown === nextMarkdown) {
    return nextMarkdown;
  }

  const previousTables = collectMarkdownTableSnapshots(previousMarkdown);
  const nextTables = collectMarkdownTableSnapshots(nextMarkdown);

  if (previousTables.length === 0 || previousTables.length !== nextTables.length) {
    return nextMarkdown;
  }

  const replacements: MarkdownReplacement[] = [];

  for (let index = 0; index < nextTables.length; index += 1) {
    const previousTable = previousTables[index];
    const nextTable = nextTables[index];

    if (!previousTable || !nextTable || previousTable.semanticSignature !== nextTable.semanticSignature) {
      continue;
    }

    replacements.push({
      startOffset: nextTable.startOffset,
      endOffset: nextTable.endOffset,
      replacement: previousTable.source,
    });
  }

  return applyMarkdownReplacements(nextMarkdown, replacements);
}

export function remarkRenderMarkdownTableCellLineBreaks() {
  return (tree: Root) => {
    // Viewer rendering is scoped structurally to table cells so literal <br />
    // text outside tables stays literal markdown content.
    visit(tree, "tableCell", (node) => {
      const tableCellNode = node as TableCell;
      const children = tableCellNode.children;
      tableCellNode.children = convertCanonicalBreakHtmlToMdastBreaks(children);
    });
  };
}
