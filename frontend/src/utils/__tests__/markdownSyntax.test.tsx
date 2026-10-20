import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import {
  createMarkdownDocumentModel,
  DOCUMENT_RECORD_BATCH_ITEMS,
  DOCUMENT_TEXT_CHUNK_UNITS,
  documentSyntaxPage,
  markdownDocumentRecords,
} from "../markdownDocumentPreviewModel";
import { createDocumentSearchIndex, documentSearchMatches } from "../markdownDocumentSearch";
import { collectMarkdownCodeBlocks, rehypePreparedSyntax } from "../markdownSyntax";

describe("engine-neutral Markdown syntax adapter", () => {
  it("pages only intersecting syntax ranges without losing boundary tokens", () => {
    const ranges = Array.from({ length: 200 }, (_, index) => ({ from: index * 3, to: index * 3 + 2, categories: ["keyword"] as const }));
    const window = { id: 7, from: 4, to: 502 };
    const collected = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = documentSyntaxPage(ranges, window, offset);
      expect(page.records.length).toBeLessThanOrEqual(DOCUMENT_RECORD_BATCH_ITEMS);
      collected.push(...page.records);
      offset = page.next;
    }
    expect(collected.map((record) => record.range)).toEqual(ranges.filter((range) => range.to > window.from && range.from < window.to));
    expect(documentSyntaxPage(ranges, { id: 7, from: 2, to: 3 }, 0).records).toEqual([]);
    expect(() => documentSyntaxPage(ranges, window, -1)).toThrow("Invalid document syntax window");
  });
  it("indexes rendered Markdown across inline markup, blocks and text chunks without joining words", async () => {
    const model = await createMarkdownDocumentModel(
      `# Header\n\nA **bold** word.\n\nNext paragraph.\n\n\`\`\`text\n${"x".repeat(2_047)}🌍 end\n\`\`\``
    );
    const index = createDocumentSearchIndex(markdownDocumentRecords(model));
    expect(index.text).toBe(`Header\nA bold word.\nNext paragraph.\n${"x".repeat(2_047)}🌍 end\n`);
    for (const query of ["bold word", "word.\nNext", "🌍 end"]) {
      expect([...documentSearchMatches(index.text, query)]).toEqual([
        { from: index.text.indexOf(query), to: index.text.indexOf(query) + query.length },
      ]);
    }
    expect([...documentSearchMatches(index.text, "word.Next")]).toEqual([]);
    expect([...documentSearchMatches("WORD word sword", "word", { wholeWord: true })]).toHaveLength(2);
    expect([...documentSearchMatches("WORD word sword", "word", { wholeWord: true, caseSensitive: true })]).toEqual([{ from: 5, to: 9 }]);
    expect([...documentSearchMatches("ab\nab", "a.", { regexp: true })]).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ]);
    expect([...documentSearchMatches("🌍", "(?=.)", { regexp: true })].length).toBeGreaterThan(0);
    expect(() => [...documentSearchMatches("text", "[", { regexp: true })]).toThrow("Invalid document search expression");
    const match = [...documentSearchMatches(index.text, "🌍 end")][0];
    expect(index.segments.filter((segment) => segment.to > match.from && segment.from < match.to)).toHaveLength(2);
  });
  it("streams semantic whole-Markdown records with bounded text and source-ordered parents", async () => {
    const source = `# Heading\n\n**Strong** and [safe](https://example.com).\n\n| A | B |\n| - | - |\n| first<br>second | cell |\n\n- [x] done\n\n\`\`\`js\n${"let x=1;\n".repeat(600)}\`\`\`\n\n<script>ignored()</script>`;
    const model = await createMarkdownDocumentModel(source);
    const records = [...markdownDocumentRecords(model)];
    const ids = new Set([0]);
    for (const record of records) {
      if (record.kind === "element" || record.kind === "text") {
        expect(ids.has(record.parent)).toBe(true);
        expect(ids.has(record.id)).toBe(false);
        ids.add(record.id);
      }
      if (record.kind === "text" || record.kind === "attribute") expect(record.value.length).toBeLessThanOrEqual(DOCUMENT_TEXT_CHUNK_UNITS);
    }
    const tags = records.filter((record) => record.kind === "element").map((record) => record.tag);
    for (const tag of ["h1", "strong", "a", "table", "br", "ul", "input", "pre", "code"]) expect(tags).toContain(tag);
    expect(tags).not.toContain("script");
    expect(
      records
        .filter((record) => record.kind === "text")
        .map((record) => record.value)
        .join("")
    ).toContain("<script>ignored()</script>");
    const tableParents = new Set(
      records
        .filter((record) => record.kind === "element" && ["table", "thead", "tbody", "tr"].includes(record.tag))
        .map((record) => record.id)
    );
    expect(records.filter((record) => record.kind === "text" && tableParents.has(record.parent))).toEqual([]);
    expect(model.codeBlocks.map(({ text, label }) => ({ text, label }))).toEqual([{ text: "let x=1;\n".repeat(600), label: "js" }]);
  });
  it("keeps the contract and renderer independent of engine imports", () => {
    const contract = readFileSync("src/utils/syntaxHighlighting.ts", "utf8");
    const renderer = readFileSync("src/utils/markdownSyntax.ts", "utf8");
    const presentation = readFileSync("src/theme/syntaxStyles.ts", "utf8");
    for (const source of [contract, renderer, presentation]) {
      expect(source).not.toMatch(/from\s+["'][^"']*(?:@codemirror|@lezer|codeMirrorHighlighting|highlightingService)[^"']*["']/);
    }
    expect(contract).not.toMatch(/\bimport\b/);
  });
  it("collects exact code occurrences from the Markdown AST", () => {
    expect(collectMarkdownCodeBlocks("```js\nlet x=1\n```\n\n```js\nlet x=1\n```\n\n    plain")).toEqual([
      { text: "let x=1", label: "js" },
      { text: "let x=1", label: "js" },
      { text: "plain", label: null },
    ]);
  });

  it("renders prepared ranges, combinations, neutral gaps and Unicode without a parser engine", () => {
    const source = "```js\nlet x='🌍';\n```\n\n```js\nlet x='🌍';\n```";
    const requests = collectMarkdownCodeBlocks(source);
    const results = [
      {
        ranges: [
          { from: 0, to: 3, categories: ["keyword", "strong"] as const },
          { from: 6, to: 10, categories: ["string"] as const },
        ],
      },
      { reason: "parsing-failure" as const },
    ];
    const { container } = render(<ReactMarkdown rehypePlugins={[[rehypePreparedSyntax, { requests, results }]]}>{source}</ReactMarkdown>);
    const blocks = container.querySelectorAll("pre code");
    expect(blocks[0]!.textContent).toBe("let x='🌍';\n");
    expect(blocks[1]!.textContent).toBe(blocks[0]!.textContent);
    expect(blocks[0]!.querySelector(".sambee-syntax-keyword.sambee-syntax-strong")).not.toBeNull();
    expect(blocks[1]!.querySelector("span")).toBeNull();
  });

  it("keeps stale, invalid and empty results neutral without changing text", () => {
    const source = "```\nhello\n```";
    const requests = collectMarkdownCodeBlocks(source);
    for (const result of [{ ranges: [] }, { ranges: [{ from: 0, to: 99, categories: ["keyword"] as const }] }]) {
      const { container, unmount } = render(
        <ReactMarkdown rehypePlugins={[[rehypePreparedSyntax, { requests, results: [result] }]]}>{source}</ReactMarkdown>
      );
      expect(container.querySelector("code")?.textContent).toBe("hello\n");
      expect(container.querySelector("span")).toBeNull();
      unmount();
    }
  });
});
