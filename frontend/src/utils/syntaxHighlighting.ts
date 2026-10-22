export const TOKEN_CATEGORIES = [
  "keyword",
  "string",
  "number",
  "comment",
  "type",
  "function",
  "operator",
  "punctuation",
  "identifier",
  "builtin",
  "property",
  "boolean",
  "null",
  "regexp",
  "escape",
  "metadata",
  "heading",
  "structure",
  "link",
  "inlineCode",
  "emphasis",
  "strong",
  "strikethrough",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];
export const TOKEN_COLOR_ROLES = {
  keyword: "keyword",
  string: "string",
  number: "number",
  comment: "comment",
  type: "type",
  function: "function",
  operator: "operator",
  punctuation: "punctuation",
  identifier: "foreground",
  builtin: "function",
  property: "type",
  boolean: "keyword",
  null: "keyword",
  regexp: "type",
  escape: "operator",
  metadata: "keyword",
  heading: "keyword",
  structure: "keyword",
  link: "link",
  inlineCode: "foreground",
  emphasis: "emphasis",
  strong: "strong",
  strikethrough: "strikethrough",
} as const satisfies Record<TokenCategory, string>;
declare const languageId: unique symbol;
export type LanguageId = string & { readonly [languageId]: true };
export type PlainTextReason =
  | "unknown-language"
  | "plain-text"
  | "block-too-large"
  | "nesting-depth"
  | "loading-failure"
  | "parsing-failure";
export type LanguageResolution = { language: LanguageId } | { reason: "unknown-language" | "plain-text" };
export interface SyntaxRange {
  from: number;
  to: number;
  categories: readonly TokenCategory[];
}
export interface CodeBlockRequest {
  text: string;
  label?: string | null;
}
export type PreparedCodeBlock = { ranges: readonly SyntaxRange[] } | { reason: PlainTextReason };
export interface HighlightingService {
  resolveFilename(filename: string): LanguageResolution;
  resolveFence(label?: string | null): LanguageResolution;
  prepare(blocks: readonly CodeBlockRequest[], signal?: AbortSignal): Promise<readonly PreparedCodeBlock[]>;
}

export function tokenClasses(categories: readonly TokenCategory[]): string {
  return categories.map((category) => `sambee-syntax-${category}`).join(" ");
}
