import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  Language,
  LanguageDescription,
  type LanguageSupport,
  languageDataProp,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { NodeType, Parser, type PartialParse, Tree } from "@lezer/common";
import { highlightTree, styleTags, type Tag, tags } from "@lezer/highlight";
import {
  type HighlightingService,
  type LanguageId,
  type LanguageResolution,
  type PlainTextReason,
  type PreparedCodeBlock,
  type SyntaxRange,
  type TokenCategory,
  tokenClasses,
} from "./syntaxHighlighting";

export type SyntaxDiagnosticReporter = (message: string, context?: Record<string, unknown>, component?: string, failure?: Error) => void;
export const MAX_STATIC_BLOCK_LENGTH = 100_000;
export const MAX_MARKDOWN_LEVELS = 4;
const PLAIN_LABELS = new Set(["", "text", "txt", "plaintext", "plain", "none"]);
const FENCE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  html: "html",
  cs: "c#",
  csharp: "c#",
  cpp: "c++",
  rb: "ruby",
  rs: "rust",
  ps1: "powershell",
  shellsession: "shell",
  console: "shell",
  docker: "dockerfile",
  htm: "html",
  kt: "kotlin",
  mssql: "ms sql",
  mariadb: "mariadb sql",
};
const codeRules: { tag: Tag | readonly Tag[]; categories: readonly TokenCategory[] }[] = [
  { tag: tags.keyword, categories: ["keyword"] },
  { tag: [tags.string, tags.character], categories: ["string"] },
  { tag: tags.regexp, categories: ["regexp"] },
  { tag: tags.escape, categories: ["escape"] },
  { tag: tags.number, categories: ["number"] },
  { tag: tags.bool, categories: ["boolean"] },
  { tag: tags.null, categories: ["null"] },
  { tag: tags.comment, categories: ["comment"] },
  { tag: [tags.typeName, tags.className, tags.namespace], categories: ["type"] },
  { tag: [tags.name, tags.variableName], categories: ["identifier"] },
  { tag: tags.propertyName, categories: ["property"] },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], categories: ["function"] },
  {
    tag: [
      tags.standard(tags.variableName),
      tags.standard(tags.propertyName),
      tags.standard(tags.function(tags.variableName)),
      tags.standard(tags.function(tags.propertyName)),
    ],
    categories: ["builtin"],
  },
  { tag: tags.meta, categories: ["metadata"] },
  { tag: tags.operator, categories: ["operator"] },
  { tag: [tags.punctuation, tags.bracket], categories: ["punctuation"] },
];
const markdownRules: typeof codeRules = [
  { tag: tags.heading, categories: ["heading"] },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], categories: ["structure"] },
  { tag: [tags.link, tags.url, tags.labelName], categories: ["link"] },
  { tag: tags.monospace, categories: ["inlineCode"] },
  { tag: tags.emphasis, categories: ["emphasis"] },
  { tag: tags.strong, categories: ["strong"] },
  { tag: tags.strikethrough, categories: ["strikethrough"] },
];
const toStyle = (rules: typeof codeRules) => rules.map(({ tag, categories }) => ({ tag, class: tokenClasses(categories) }));
const codeStyle = HighlightStyle.define(toStyle(codeRules));
const sourceStyle = HighlightStyle.define(toStyle(markdownRules), { scope: markdownLanguage });
const scopedCodeStyle = {
  style: codeStyle.style,
  scope: (node: Parameters<NonNullable<typeof sourceStyle.scope>>[0]) => node.prop(languageDataProp) !== markdownLanguage.data,
};
export const nativeSyntaxHighlighting: Extension = [syntaxHighlighting(scopedCodeStyle), syntaxHighlighting(sourceStyle)];

function descriptionForFence(label?: string | null): LanguageDescription | null {
  const normalized = label?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (PLAIN_LABELS.has(normalized)) return null;
  return LanguageDescription.matchLanguageName(languages, FENCE_ALIASES[normalized] ?? normalized, false);
}
function resolution(description: LanguageDescription | null): LanguageResolution {
  return description ? { language: description.name.toLowerCase() as LanguageId } : { reason: "unknown-language" };
}
export function resolveFilename(filename: string): LanguageResolution {
  return resolution(LanguageDescription.matchFilename(languages, filename));
}
export function resolveFence(label?: string | null): LanguageResolution {
  const normalized = label?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return PLAIN_LABELS.has(normalized) ? { reason: "plain-text" } : resolution(descriptionForFence(label));
}
function getDescription(id: LanguageId): LanguageDescription {
  const description = languages.find((candidate) => candidate.name.toLowerCase() === id);
  if (!description) throw new Error(`Unsupported application language: ${id}`);
  return description;
}
export function createMarkdownSupport(
  codeLanguages: NonNullable<Parameters<typeof markdown>[0]>["codeLanguages"] = descriptionForFence
): LanguageSupport {
  return markdown({ base: markdownLanguage, codeLanguages, extensions: [{ props: [styleTags({ CodeText: [], CodeInfo: tags.meta })] }] });
}
export async function loadNativeLanguage(id: LanguageId, report: SyntaxDiagnosticReporter): Promise<LanguageSupport> {
  const description = getDescription(id);
  try {
    const support = await description.load();
    return support.language.name === "markdown" ? createMarkdownSupport() : support;
  } catch (error) {
    report(
      "Syntax language loading failed; using plain text",
      { language: id, operation: "load" },
      "syntaxHighlighting",
      error instanceof Error ? error : undefined
    );
    throw error;
  }
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Highlighting cancelled", "AbortError");
}
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Highlighting cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function yieldHighlightingTask(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } }).scheduler;
  await abortable(scheduler ? scheduler.yield() : new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
  checkAbort(signal);
}
class PreparationFailure extends Error {
  constructor(readonly reason: PlainTextReason) {
    super(reason);
  }
}
function isolateNestedParser(language: Language, id: LanguageId, report: SyntaxDiagnosticReporter, signal?: AbortSignal): Language {
  const parser = new (class extends Parser {
    createParse(...args: Parameters<Parser["createParse"]>): PartialParse {
      const ranges = args[2];
      const from = ranges[0].from;
      const end = ranges[ranges.length - 1].to;
      let partial: PartialParse | undefined;
      let stoppedAt: number | null = null;
      const fail = (error: unknown) => {
        checkAbort(signal);
        partial = undefined;
        report(
          "Nested syntax parsing failed; retaining plain text for this fence",
          { language: id, operation: "parse" },
          "syntaxHighlighting",
          error instanceof Error ? error : undefined
        );
      };
      try {
        partial = language.parser.startParse(...args);
      } catch (error) {
        fail(error);
      }
      return {
        advance() {
          checkAbort(signal);
          try {
            if (partial) return partial.advance();
          } catch (error) {
            fail(error);
          }
          return new Tree(NodeType.none, [], [], Math.max(0, Math.min(end, stoppedAt ?? end) - from));
        },
        get parsedPos() {
          return partial?.parsedPos ?? Math.min(end, stoppedAt ?? end);
        },
        get stoppedAt() {
          return partial?.stoppedAt ?? stoppedAt;
        },
        stopAt(position) {
          stoppedAt = position;
          try {
            partial?.stopAt(position);
          } catch (error) {
            fail(error);
          }
        },
      };
    }
  })();
  return new Language(language.data, parser, [], language.name);
}
async function prepareLanguage(
  text: string,
  id: LanguageId,
  level: number,
  preparedLanguages: Map<LanguageId, Language>,
  report: SyntaxDiagnosticReporter,
  signal?: AbortSignal
): Promise<Language> {
  checkAbort(signal);
  if (text.length > MAX_STATIC_BLOCK_LENGTH) throw new PreparationFailure("block-too-large");
  const description = getDescription(id);
  const isMarkdown = description.name.toLowerCase() === "markdown";
  if (isMarkdown && level > MAX_MARKDOWN_LEVELS) throw new PreparationFailure("nesting-depth");
  let support: LanguageSupport;
  try {
    support = await abortable(description.load(), signal);
  } catch (error) {
    checkAbort(signal);
    report(
      "Syntax language loading failed; using plain text",
      { language: id, operation: "load" },
      "syntaxHighlighting",
      error instanceof Error ? error : undefined
    );
    throw new PreparationFailure("loading-failure");
  }
  checkAbort(signal);
  if (!isMarkdown) {
    preparedLanguages.set(id, support.language);
    return support.language;
  }
  const discovery = createMarkdownSupport(() => null);
  const tree = discovery.language.parser.parse(text);
  const cursor = tree.cursor();
  do {
    if (cursor.name !== "FencedCode") continue;
    const info = cursor.node.getChild("CodeInfo");
    const code = cursor.node.getChild("CodeText");
    if (!info || !code) continue;
    const nested = resolveFence(text.slice(info.from, info.to));
    if (!("language" in nested)) continue;
    await yieldHighlightingTask(signal);
    try {
      await prepareLanguage(text.slice(code.from, code.to), nested.language, level + 1, preparedLanguages, report, signal);
    } catch (error) {
      checkAbort(signal);
      if (!(error instanceof PreparationFailure) || error.reason !== "loading-failure") throw error;
    }
  } while (cursor.next());
  checkAbort(signal);
  const configured = createMarkdownSupport((label) => {
    const nested = resolveFence(label);
    if (!("language" in nested)) return null;
    const language = preparedLanguages.get(nested.language);
    return language ? isolateNestedParser(language, nested.language, report, signal) : null;
  }).language;
  preparedLanguages.set(id, configured);
  return configured;
}
export function createStaticHighlighter(report: SyntaxDiagnosticReporter): HighlightingService {
  return {
    resolveFilename,
    resolveFence,
    async prepare(blocks, signal) {
      const results: PreparedCodeBlock[] = [];
      for (const block of blocks) {
        await yieldHighlightingTask(signal);
        if (block.text.length > MAX_STATIC_BLOCK_LENGTH) {
          results.push({ reason: "block-too-large" });
          continue;
        }
        const resolved = resolveFence(block.label);
        if (!("language" in resolved)) {
          results.push(resolved);
          continue;
        }
        try {
          const language = await prepareLanguage(block.text, resolved.language, 1, new Map(), report, signal);
          checkAbort(signal);
          const ranges: SyntaxRange[] = [];
          highlightTree(language.parser.parse(block.text), [scopedCodeStyle, sourceStyle], (from, to, classes) => {
            ranges.push({ from, to, categories: classes.split(" ").map((name) => name.slice("sambee-syntax-".length) as TokenCategory) });
          });
          results.push({ ranges });
        } catch (error) {
          checkAbort(signal);
          if (error instanceof PreparationFailure) results.push({ reason: error.reason });
          else {
            report(
              "Syntax parsing failed; using plain text",
              { language: resolved.language, operation: "parse" },
              "syntaxHighlighting",
              error instanceof Error ? error : undefined
            );
            results.push({ reason: "parsing-failure" });
          }
        }
      }
      checkAbort(signal);
      return results;
    },
  };
}
