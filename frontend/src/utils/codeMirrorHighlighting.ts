import { error as logError } from "../services/logger";
import { createStaticHighlighter, loadNativeLanguage as loadLanguage } from "./codeMirrorHighlightingCore";
import type { LanguageId } from "./syntaxHighlighting";

export {
  createMarkdownSupport,
  MAX_MARKDOWN_LEVELS,
  MAX_STATIC_BLOCK_LENGTH,
  nativeSyntaxHighlighting,
  resolveFence,
  resolveFilename,
  yieldHighlightingTask,
} from "./codeMirrorHighlightingCore";

export const codeMirrorHighlighting = createStaticHighlighter((...args) => logError(...args));

export function loadNativeLanguage(id: LanguageId) {
  return loadLanguage(id, logError);
}
