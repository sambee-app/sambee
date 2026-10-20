import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { nativeSyntaxHighlighting } from "../../utils/codeMirrorHighlighting";
import { buildCodeMirrorSurfaceTheme } from "./buildCodeMirrorSurfaceTheme";
import { buildSelectionLayerTheme } from "./buildEditorSelectionLayer";

export interface MarkdownEditorThemeOptions {
  activeLineBackground: string;
  borderColor: string;
  currentSearchMatchBackground: string;
  isDarkMode: boolean;
  linkColor: string;
  otherSearchMatchBackground: string;
  selectionBackground: string;
  surfaceBackground: string;
  tableAlternateRowBackground: string;
  tableBackground: string;
  tableBorderColor: string;
  tableHeaderBackground: string;
  tableHeaderText?: string;
  textColor: string;
}

export function buildMarkdownEditorTheme({
  activeLineBackground,
  borderColor,
  currentSearchMatchBackground,
  isDarkMode,
  linkColor,
  otherSearchMatchBackground,
  selectionBackground,
  surfaceBackground,
  textColor,
}: MarkdownEditorThemeOptions): Extension[] {
  return [
    ...buildCodeMirrorSurfaceTheme({
      activeLineBackground,
      borderColor,
      currentSearchMatchBackground,
      isDarkMode,
      otherSearchMatchBackground,
      surfaceBackground,
      textColor,
    }),
    buildSelectionLayerTheme({ selectionBackground, surfaceBackground }),
    nativeSyntaxHighlighting,
    EditorView.theme({ "&": { "--sambee-syntax-link": linkColor } }),
  ];
}
