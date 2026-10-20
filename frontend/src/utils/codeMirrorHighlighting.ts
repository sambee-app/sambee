import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  type Language,
  LanguageDescription,
  type LanguageSupport,
  languageDataProp,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Extension } from "@codemirror/state";
import { highlightTree, styleTags, type Tag, tags } from "@lezer/highlight";
import { error as logError } from "../services/logger";
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
};

const codeRules: { tag: Tag | readonly Tag[]; categories: readonly TokenCategory[] }[] = [
  { tag: tags.keyword, categories: ["keyword"] },
  { tag: [tags.string, tags.regexp, tags.escape, tags.character], categories: ["string"] },
  { tag: [tags.number, tags.bool, tags.null], categories: ["number"] },
  { tag: tags.comment, categories: ["comment"] },
  { tag: [tags.typeName, tags.className, tags.namespace], categories: ["type"] },
  { tag: [tags.name, tags.variableName, tags.propertyName], categories: ["identifier"] },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], categories: ["function"] },
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
  return markdown({
    base: markdownLanguage,
    codeLanguages,
    extensions: [{ props: [styleTags({ CodeText: [], CodeInfo: tags.meta })] }],
  });
}

export async function loadNativeLanguage(id: LanguageId): Promise<LanguageSupport> {
  const description = getDescription(id);
  try {
    const support = await description.load();
    return support.language.name === "markdown" ? createMarkdownSupport() : support;
  } catch (error) {
    logError(
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

async function prepareLanguage(
  text: string,
  id: LanguageId,
  level: number,
  preparedLanguages: Map<LanguageId, Language>,
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
    logError(
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
    const label = text.slice(info.from, info.to);
    const nested = resolveFence(label);
    if (!("language" in nested)) continue;
    await yieldHighlightingTask(signal);
    await prepareLanguage(text.slice(code.from, code.to), nested.language, level + 1, preparedLanguages, signal);
  } while (cursor.next());
  checkAbort(signal);
  const configured = createMarkdownSupport((label) => {
    const nested = resolveFence(label);
    return "language" in nested ? (preparedLanguages.get(nested.language) ?? null) : null;
  }).language;
  preparedLanguages.set(id, configured);
  return configured;
}

export const codeMirrorHighlighting: HighlightingService = {
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
        const language = await prepareLanguage(block.text, resolved.language, 1, new Map(), signal);
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
          logError(
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
