import type { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export { languages };

const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "conf", "log", "env", "bat", "cmd"]);

export function matchFileLanguage(filename: string): LanguageDescription | null {
  const filenameMatch = languages.find((description) => description.filename?.test(filename));
  if (filenameMatch) return filenameMatch;
  const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
  return extension
    ? (languages.find((description) => description.extensions.some((candidate) => candidate.toLowerCase() === extension)) ?? null)
    : null;
}

export function isTextFilename(filename: string): boolean {
  const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
  return (extension !== undefined && PLAIN_TEXT_EXTENSIONS.has(extension)) || matchFileLanguage(filename) !== null;
}
