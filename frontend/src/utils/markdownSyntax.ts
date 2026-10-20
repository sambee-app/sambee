import type { Element, ElementContent, Root } from "hast";
import type { Root as MarkdownRoot } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { type CodeBlockRequest, type PreparedCodeBlock, tokenClasses } from "./syntaxHighlighting";

export interface PreparedMarkdownSyntax {
  requests: readonly CodeBlockRequest[];
  results: readonly PreparedCodeBlock[];
}

export function collectMarkdownCodeBlocks(source: string): CodeBlockRequest[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as MarkdownRoot;
  const blocks: CodeBlockRequest[] = [];
  const visit = (node: MarkdownRoot | MarkdownRoot["children"][number]) => {
    if (node.type === "code") blocks.push({ text: node.value, label: node.lang });
    if ("children" in node) for (const child of node.children) visit(child as MarkdownRoot["children"][number]);
  };
  visit(tree);
  return blocks;
}

export function rehypePreparedSyntax(prepared?: PreparedMarkdownSyntax) {
  return (tree: Root): void => {
    if (!prepared) return;
    let index = 0;
    const visit = (node: Root | Element): void => {
      if (node.type === "element" && node.tagName === "pre") {
        const code = node.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
        if (!code) return;
        const request = prepared.requests[index];
        const result = prepared.results[index++];
        if (!request || !result || !("ranges" in result) || code.children.some((child) => child.type !== "text")) return;
        const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
        if (text !== request.text && text !== `${request.text}\n`) return;
        const children: ElementContent[] = [];
        let offset = 0;
        for (const range of result.ranges) {
          if (range.from < offset || range.to <= range.from || range.to > request.text.length) return;
          if (range.from > offset) children.push({ type: "text", value: text.slice(offset, range.from) });
          children.push({
            type: "element",
            tagName: "span",
            properties: { className: tokenClasses(range.categories).split(" ") },
            children: [{ type: "text", value: text.slice(range.from, range.to) }],
          });
          offset = range.to;
        }
        if (offset < text.length) children.push({ type: "text", value: text.slice(offset) });
        code.children = children;
        return;
      }
      for (const child of node.children) if (child.type === "element") visit(child);
    };
    visit(tree);
  };
}
