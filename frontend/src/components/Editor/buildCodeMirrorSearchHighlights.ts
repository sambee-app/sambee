import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type EditorView, ViewPlugin } from "@codemirror/view";
import { findSelectedCodeMirrorSearchMatch, getCachedCodeMirrorSearchMatches } from "./codeMirrorSearchMatches";
import { disposeSourceRegexSearch, sourceRegexSearchLifecycle, sourceRegexSearchUpdated } from "./sourceRegexSearch";

export const PASSIVE_SEARCH_MATCH_CLASS = "sambee-passive-search-match";
export const PASSIVE_SELECTED_SEARCH_MATCH_CLASS = "sambee-passive-search-match-selected";

interface SearchMatchRange {
  from: number;
  to: number;
}

const passiveSearchMatchMark = Decoration.mark({ class: PASSIVE_SEARCH_MATCH_CLASS });
const passiveSelectedSearchMatchMark = Decoration.mark({
  class: `${PASSIVE_SEARCH_MATCH_CLASS} ${PASSIVE_SELECTED_SEARCH_MATCH_CLASS}`,
});

function rangeEquals(left: SearchMatchRange | null, right: SearchMatchRange): boolean {
  return left !== null && left.from === right.from && left.to === right.to;
}

function resolveCurrentSearchRange(view: EditorView): SearchMatchRange | null {
  const ranges = getCachedCodeMirrorSearchMatches(view);
  const selection = view.state.selection.main;
  if (!ranges) {
    const query = getSearchQuery(view.state);
    if (selection.empty && !query.regexp) return null;
    const match = query.getCursor(view.state, selection.from, selection.to).next();
    return match.done ? null : { from: match.value.from, to: match.value.to };
  }
  const index = findSelectedCodeMirrorSearchMatch(ranges, selection);
  return index < 0 ? null : (ranges[index] ?? null);
}

export function buildPassiveSearchHighlightExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations;

      constructor(private view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: {
        view: EditorView;
        state: EditorView["state"];
        startState: EditorView["state"];
        docChanged: boolean;
        selectionSet: boolean;
        viewportChanged: boolean;
        transactions?: readonly { effects: readonly { is: (effect: typeof sourceRegexSearchUpdated) => boolean }[] }[];
      }) {
        const query = getSearchQuery(update.state);
        const previousQuery = getSearchQuery(update.startState);

        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions?.some((transaction) => transaction.effects.some((effect) => effect.is(sourceRegexSearchUpdated))) ||
          !query.eq(previousQuery) ||
          searchPanelOpen(update.state) !== searchPanelOpen(update.startState)
        ) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const query = getSearchQuery(view.state);

        if (!query.valid || query.search.length === 0) {
          return Decoration.none;
        }

        const panelOpen = searchPanelOpen(view.state);
        const currentRange = resolveCurrentSearchRange(view);
        const mainSelection = view.state.selection.main;
        const mainSelectionRange = { from: mainSelection.from, to: mainSelection.to };

        if (panelOpen) {
          if (currentRange === null || rangeEquals(currentRange, mainSelectionRange)) {
            return Decoration.none;
          }

          return Decoration.set([passiveSelectedSearchMatchMark.range(currentRange.from, currentRange.to)], true);
        }

        const builder = new RangeSetBuilder<Decoration>();

        if (query.regexp) {
          const ranges = getCachedCodeMirrorSearchMatches(view) ?? [];
          for (const visible of view.visibleRanges) {
            let low = 0;
            let high = ranges.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              const range = ranges[middle];
              if (!range) break;
              if (range.from < visible.from) low = middle + 1;
              else high = middle;
            }
            for (let index = low; index < ranges.length; index += 1) {
              const match = ranges[index];
              if (!match || match.from > visible.to) break;
              if (match.from === match.to) continue;
              builder.add(match.from, match.to, rangeEquals(currentRange, match) ? passiveSelectedSearchMatchMark : passiveSearchMatchMark);
            }
          }
          return builder.finish();
        }

        for (const { from, to } of view.visibleRanges) {
          const cursor = query.getCursor(view.state, from, to);

          for (let nextMatch = cursor.next(); !nextMatch.done; nextMatch = cursor.next()) {
            const match = nextMatch.value;
            const selected = rangeEquals(currentRange, { from: match.from, to: match.to });

            if (selected) {
              builder.add(match.from, match.to, passiveSelectedSearchMatchMark);
              continue;
            }

            builder.add(match.from, match.to, passiveSearchMatchMark);
          }
        }

        return builder.finish();
      }

      destroy() {
        if (!this.view.plugin(sourceRegexSearchLifecycle)) disposeSourceRegexSearch(this.view);
      }
    },
    {
      decorations: (value) => value.decorations,
    }
  );
}
