import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap } from "@codemirror/view";
import { buildSelectionLayerExtension } from "./buildEditorSelectionLayer";
import { sourceRegexSearchLifecycle } from "./sourceRegexSearch";

interface CommonEditorExtensionsOptions {
  defaultSyntaxHighlighting?: boolean;
  highlightSelectionMatches?: boolean;
  lineWrapping?: boolean;
}

const EDITOR_VIEWPORT_SCROLL_DIRECTION = {
  UP: -1,
  DOWN: 1,
} as const;

function scrollEditorViewport(
  view: EditorView,
  direction: (typeof EDITOR_VIEWPORT_SCROLL_DIRECTION)[keyof typeof EDITOR_VIEWPORT_SCROLL_DIRECTION]
): boolean {
  const { scrollDOM } = view;
  const previousScrollTop = scrollDOM.scrollTop;
  const maximumScrollTop = Math.max(0, scrollDOM.scrollHeight - scrollDOM.clientHeight);
  const nextScrollTop = Math.max(0, Math.min(maximumScrollTop, previousScrollTop + view.defaultLineHeight * direction));
  const scrollDelta = nextScrollTop - previousScrollTop;

  const selection = view.state.selection.main;
  const cursorCoords = selection.empty ? view.coordsAtPos(selection.head, selection.assoc) : null;
  const scrollerRect = scrollDOM.getBoundingClientRect();
  const caretMovement =
    cursorCoords && direction === EDITOR_VIEWPORT_SCROLL_DIRECTION.DOWN
      ? {
          forward: true,
          distance: scrollerRect.top + scrollDelta - cursorCoords.top,
        }
      : cursorCoords
        ? {
            forward: false,
            distance: cursorCoords.bottom - (scrollerRect.bottom + scrollDelta),
          }
        : null;

  if (scrollDelta !== 0 && caretMovement && caretMovement.distance > 0) {
    view.dispatch({
      selection: view.moveVertically(selection, caretMovement.forward, caretMovement.distance),
      scrollIntoView: false,
    });
  }

  scrollDOM.scrollTop = nextScrollTop;

  return true;
}

const editorViewportScrollKeymap = [
  {
    key: "Ctrl-ArrowUp",
    preventDefault: true,
    run: (view: EditorView) => scrollEditorViewport(view, EDITOR_VIEWPORT_SCROLL_DIRECTION.UP),
  },
  {
    key: "Ctrl-ArrowDown",
    preventDefault: true,
    run: (view: EditorView) => scrollEditorViewport(view, EDITOR_VIEWPORT_SCROLL_DIRECTION.DOWN),
  },
];

export function buildCommonEditorExtensions({
  defaultSyntaxHighlighting = true,
  highlightSelectionMatches: includeSelectionMatches = true,
  lineWrapping = false,
}: CommonEditorExtensionsOptions = {}): Extension[] {
  return [
    history(),
    drawSelection(),
    buildSelectionLayerExtension(),
    closeBrackets(),
    indentOnInput(),
    ...(defaultSyntaxHighlighting ? [syntaxHighlighting(defaultHighlightStyle, { fallback: true })] : []),
    bracketMatching(),
    search({ top: true }),
    sourceRegexSearchLifecycle,
    ...(includeSelectionMatches ? [highlightSelectionMatches()] : []),
    highlightActiveLine(),
    ...(lineWrapping ? [EditorView.lineWrapping] : []),
    keymap.of([indentWithTab, ...closeBracketsKeymap, ...editorViewportScrollKeymap, ...defaultKeymap, ...historyKeymap]),
  ];
}
