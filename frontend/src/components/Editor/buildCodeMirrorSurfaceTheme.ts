import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { PASSIVE_SEARCH_MATCH_CLASS, PASSIVE_SELECTED_SEARCH_MATCH_CLASS } from "./buildCodeMirrorSearchHighlights";
import { EDITOR_HAS_SELECTION_CLASS } from "./buildEditorSelectionLayer";

export interface CodeMirrorSurfaceThemeOptions {
  activeLineBackground: string;
  borderColor: string;
  currentSearchMatchBackground: string;
  isDarkMode: boolean;
  otherSearchMatchBackground: string;
  surfaceBackground: string;
  textColor: string;
}

export function buildCodeMirrorSurfaceTheme({
  activeLineBackground,
  borderColor,
  currentSearchMatchBackground,
  isDarkMode,
  otherSearchMatchBackground,
  surfaceBackground,
  textColor,
}: CodeMirrorSurfaceThemeOptions): Extension[] {
  return [
    EditorView.theme(
      {
        ".cm-editor": {
          color: textColor,
          backgroundColor: "transparent",
        },
        ".cm-scroller, .cm-content": {
          color: textColor,
          backgroundColor: "transparent",
          caretColor: textColor,
        },
        "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: "transparent",
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: "transparent",
        },
        ".cm-searchMatch": {
          backgroundColor: otherSearchMatchBackground,
        },
        [`.${PASSIVE_SEARCH_MATCH_CLASS}`]: {
          backgroundColor: otherSearchMatchBackground,
        },
        ".cm-searchMatch-selected": {
          backgroundColor: currentSearchMatchBackground,
        },
        [`.${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`]: {
          backgroundColor: currentSearchMatchBackground,
        },
        [`.cm-content .cm-searchMatch, .cm-content .cm-searchMatch *, .cm-content .${PASSIVE_SEARCH_MATCH_CLASS}, .cm-content .${PASSIVE_SEARCH_MATCH_CLASS} *`]:
          {
            color: textColor,
          },
        ".cm-cursor": {
          borderLeft: `2px solid ${textColor}`,
          marginLeft: 0,
        },
        ".cm-dropCursor": {
          borderLeftColor: textColor,
        },
        ".cm-activeLine": {
          backgroundColor: "transparent",
        },
        "&.cm-focused .cm-activeLine": {
          backgroundColor: activeLineBackground,
        },
        [`&.cm-focused.${EDITOR_HAS_SELECTION_CLASS} .cm-activeLine`]: {
          backgroundColor: "transparent",
        },
        ".cm-matchingBracket, .cm-nonmatchingBracket": {
          outline: `1px solid ${borderColor}`,
        },
        ".cm-tooltip": {
          backgroundColor: surfaceBackground,
          border: `1px solid ${borderColor}`,
          color: textColor,
        },
        ".sambee-source-replacement-feedback": {
          backgroundColor: surfaceBackground,
          border: `1px solid ${borderColor}`,
          color: textColor,
        },
        ".cm-tooltip-autocomplete ul li[aria-selected]": {
          backgroundColor: activeLineBackground,
          color: textColor,
        },
        ".cm-completionIcon": {
          opacity: 0.75,
        },
        ".cm-panels": {
          backgroundColor: surfaceBackground,
          color: textColor,
          borderBottom: `1px solid ${borderColor}`,
        },
        ".cm-panels.cm-panels-bottom": {
          borderBottom: 0,
          borderTop: `1px solid ${borderColor}`,
        },
      },
      { dark: isDarkMode }
    ),
  ];
}
