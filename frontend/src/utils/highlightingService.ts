import { codeMirrorHighlighting } from "./codeMirrorHighlighting";
import type { HighlightingService } from "./syntaxHighlighting";

export const highlightingService: HighlightingService = codeMirrorHighlighting;
