import type { Extension } from "@codemirror/state";
import { nativeSyntaxHighlighting } from "../../utils/codeMirrorHighlighting";
import { buildCodeMirrorSurfaceTheme, type CodeMirrorSurfaceThemeOptions } from "./buildCodeMirrorSurfaceTheme";
import { buildSelectionLayerTheme } from "./buildEditorSelectionLayer";

export interface TextEditorThemeOptions extends CodeMirrorSurfaceThemeOptions {
  accentColor: string;
  selectionBackground: string;
}

export function buildTextEditorTheme({ accentColor, ...surfaceOptions }: TextEditorThemeOptions): Extension[] {
  return [
    ...buildCodeMirrorSurfaceTheme(surfaceOptions),
    buildSelectionLayerTheme({
      selectionBackground: surfaceOptions.selectionBackground,
      surfaceBackground: surfaceOptions.surfaceBackground,
    }),
    nativeSyntaxHighlighting,
  ];
}
