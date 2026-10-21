import { render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import {
  normalizeMarkdownTableCellLineBreaks,
  prepareMarkdownTableCellLineBreaksForEditor,
  preserveUnchangedMarkdownTableSource,
  remarkRenderMarkdownTableCellLineBreaks,
} from "../markdownTableCellLineBreaks";

describe("markdownTableCellLineBreaks", () => {
  it("normalizes uppercase br tags in table cells to the canonical form", () => {
    const markdown = ["| Column |", "| --- |", "| foo<BR>bar |", ""].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toContain("foo<br />bar");
  });

  it("normalizes malformed closing br tags in table cells to the canonical form", () => {
    const markdown = ["| Column |", "| --- |", "| foo</br>bar |", ""].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toContain("foo<br />bar");
  });

  it("normalizes numeric newline entities in table cells to the canonical form", () => {
    const markdown = ["| Left | Right |", "| --- | --- |", "| foo&#10;bar | baz&#x000A;qux |", ""].join("\n");
    const normalized = normalizeMarkdownTableCellLineBreaks(markdown);

    expect(normalized).toContain("foo<br />bar");
    expect(normalized).toContain("baz<br />qux");
  });

  it("strips trailing table-cell line breaks during normalization", () => {
    const markdown = ["| HTML | Entity |", "| --- | --- |", "| foo<br /><br /> | bar&#10;&#xA; |", ""].join("\n");
    const normalized = normalizeMarkdownTableCellLineBreaks(markdown);

    expect(normalized).toContain("foo");
    expect(normalized).not.toContain("foo<br");
    expect(normalized).toContain("bar");
    expect(normalized).not.toContain("bar<br");
  });

  it("is idempotent for already-canonical table-cell markdown", () => {
    const markdown = ["| Column |", "| --- |", "| foo<br />bar |", ""].join("\n");
    const normalized = normalizeMarkdownTableCellLineBreaks(markdown);

    expect(normalizeMarkdownTableCellLineBreaks(normalized)).toBe(normalized);
  });

  it("canonicalizes list markers while preserving list-like text in fenced code", () => {
    const markdown = [
      "* first",
      "* second",
      "",
      "1. first",
      "2. second",
      "",
      "```md",
      "* literal bullet",
      "2. literal number",
      "```",
      "",
    ].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(
      ["- first", "- second", "", "1. first", "1. second", "", "```md", "* literal bullet", "2. literal number", "```", ""].join("\n")
    );
  });

  it("preserves unrelated Markdown source while normalizing table-cell breaks", () => {
    const markdown = [
      "## Closed heading ##",
      "",
      "__strong__ and _emphasis_",
      "",
      "|Name|Value|",
      "|:--|--:|",
      "| punctuation | asterisk (*) and a&b |",
      "| break | foo<BR>bar |",
      "",
    ].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(markdown.replace("foo<BR>bar", "foo<br />bar"));
  });

  it("removes redundant legacy escapes from table-cell punctuation", () => {
    const markdown = ["| Value |", "| --- |", "| asterisk (\\*) and a\\&b |", ""].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(["| Value |", "| --- |", "| asterisk (*) and a&b |", ""].join("\n"));
  });

  it("reparses changed escape offsets before normalizing later breaks and list markers", () => {
    const markdown = [
      "| Left | Right |",
      "| --- | --- |",
      "| a\\&b | foo<BR>bar |",
      "",
      "* item",
      "",
      "```md",
      "* literal<BR>",
      "```",
      "",
    ].join("\n");
    const expected = [
      "| Left | Right |",
      "| --- | --- |",
      "| a&b | foo<br />bar |",
      "",
      "- item",
      "",
      "```md",
      "* literal<BR>",
      "```",
      "",
    ].join("\n");
    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(expected);
    expect(normalizeMarkdownTableCellLineBreaks(expected)).toBe(expected);
  });

  it("keeps table-cell escapes that preserve Markdown semantics", () => {
    const markdown = ["| Value |", "| --- |", "| \\*literal\\* and \\&copy; |", ""].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(markdown);
  });

  it("leaves list-like text inside table cells unchanged", () => {
    const markdown = ["| Items |", "| --- |", "| * first<br />2. second |", ""].join("\n");

    expect(normalizeMarkdownTableCellLineBreaks(markdown)).toBe(markdown);
  });

  it("renders canonical breaks visually only inside table cells", async () => {
    render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRenderMarkdownTableCellLineBreaks]}>
        {["Paragraph <br /> text", "", "| Column |", "| --- |", "| foo<br />bar |", ""].join("\n")}
      </ReactMarkdown>
    );

    const paragraph = await screen.findByText("Paragraph <br /> text");
    const tableCell = await screen.findByRole("cell", { name: /foo\s+bar/ });

    expect(paragraph.querySelector("br")).toBeNull();
    expect(tableCell.querySelectorAll("br")).toHaveLength(1);
  });

  it("maps canonical table-cell breaks to editor-form br tags only inside tables", () => {
    const markdown = ["Paragraph <br /> text", "", "| Column |", "| --- |", "| foo<br />bar |", ""].join("\n");

    const prepared = prepareMarkdownTableCellLineBreaksForEditor(markdown);

    expect(prepared).toContain("| foo<br>bar |");
    expect(prepared).toContain("Paragraph <br /> text");
  });

  it("does not reformat unrelated markdown while preparing table-cell editor breaks", () => {
    const markdown = ["Paragraph <br /> text", "", "* one", "* two", "", "| A |", "| - |", "| foo<br />bar |", ""].join("\n");

    const prepared = prepareMarkdownTableCellLineBreaksForEditor(markdown);

    expect(prepared).toBe(["Paragraph <br /> text", "", "* one", "* two", "", "| A |", "| - |", "| foo<br>bar |", ""].join("\n"));
  });

  it("does not rewrite outside-table br text when no table-cell break replacement is needed", () => {
    const markdown = ["```html", "<br />", "```", "", "Outside <br /> stays literal.", ""].join("\n");

    expect(prepareMarkdownTableCellLineBreaksForEditor(markdown)).toBe(markdown);
  });

  it("restores original source for semantically unchanged tables", () => {
    const previousMarkdown = ["Outside <br /> stays literal.", "", "| A |", "| - |", "| foo<br />bar |", ""].join("\n");
    const nextMarkdown = ["Outside <br /> stays literal.", "", "| A            |", "| ------------ |", "| foo<br />bar |", ""].join("\n");

    expect(preserveUnchangedMarkdownTableSource(previousMarkdown, nextMarkdown)).toBe(previousMarkdown);
  });
});
