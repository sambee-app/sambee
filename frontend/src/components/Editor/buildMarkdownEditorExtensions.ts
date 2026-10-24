import type { CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { pasteURLAsLink } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { markdownTableAutocompleter, markdownTables } from "codemirror-markdown-tables";
import { createMarkdownSupport } from "../../utils/codeMirrorHighlighting";
import { buildPassiveSearchHighlightExtension } from "./buildCodeMirrorSearchHighlights";
import { buildCommonEditorExtensions } from "./buildCommonEditorExtensions";
import { EDITOR_SELECTION_RANGE_CLASS, getSelectionLineSegments, type SelectionLineSegment } from "./buildEditorSelectionLayer";
import { buildMarkdownAutocompleteUi, createMarkdownSnippetAutocompleter } from "./buildMarkdownAutocomplete";
import { buildMarkdownEditorTheme, type MarkdownEditorThemeOptions } from "./buildMarkdownEditorTheme";
import { buildMarkdownTableTheme } from "./buildMarkdownTableTheme";

const MARKDOWN_TABLE_AUTOCOMPLETE_OPTIONS = [
  { rows: 2, cols: 2 },
  { rows: 3, cols: 3 },
  { rows: 4, cols: 4 },
] as const;

export const MARKDOWN_SELECTION_RANGE_CLASS = EDITOR_SELECTION_RANGE_CLASS;
export type MarkdownSelectionLineSegment = SelectionLineSegment;
export const getMarkdownSelectionLineSegments = getSelectionLineSegments;

export function buildMarkdownEditorExtensions(
  theme: MarkdownEditorThemeOptions,
  lineWrapping: boolean = true,
  onNestedUpdate?: (update: ViewUpdate) => void
): Extension[] {
  const markdownLanguageSupport = createMarkdownSupport();
  const snippetAutocompleter = createMarkdownSnippetAutocompleter();
  const tableAutocompleter = markdownTableAutocompleter({ options: MARKDOWN_TABLE_AUTOCOMPLETE_OPTIONS });
  const markdownAutocompleteData = markdownLanguageSupport.language.data.of({
    autocomplete: (context: CompletionContext) => snippetAutocompleter(context) ?? tableAutocompleter(context),
  });
  const markdownTableTheme = buildMarkdownTableTheme(theme);

  return [
    ...buildCommonEditorExtensions({
      defaultSyntaxHighlighting: false,
      highlightSelectionMatches: false,
      lineWrapping,
    }),
    ...buildMarkdownEditorTheme(theme),
    buildPassiveSearchHighlightExtension(),
    buildMarkdownAutocompleteUi(),
    pasteURLAsLink,
    EditorView.contentAttributes.of({
      spellcheck: "true",
      autocorrect: "on",
      autocapitalize: "sentences",
    }),
    markdownLanguageSupport,
    markdownAutocompleteData,
    markdownTables({
      ...markdownTableTheme,
      selectionType: "codemirror",
      handlePosition: "inside",
      lineWrapping: "wrap",
      extensions: [keymap.of(defaultKeymap), ...(onNestedUpdate ? [EditorView.updateListener.of(onNestedUpdate)] : [])],
      globalKeyBindings: [...historyKeymap, ...searchKeymap],
      markdownConfig: {
        completeHTMLTags: true,
        pasteURLAsLink: true,
      },
    }),
  ];
}
