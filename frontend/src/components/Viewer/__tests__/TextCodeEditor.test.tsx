import { history, redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll as nativeReplaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { EditorSelection, EditorState, StateEffect, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { requireTestValue } from "../../../test/helpers/assertions";
import { buildPassiveSearchHighlightExtension } from "../../Editor/buildCodeMirrorSearchHighlights";
import type { TextEditorThemeOptions } from "../../Editor/buildTextEditorTheme";
import { findSelectedCodeMirrorSearchMatch } from "../../Editor/codeMirrorSearchMatches";
import { runSourceRegexSearchCommand, sourceRegexSearchLifecycle } from "../../Editor/sourceRegexSearch";
import {
  SOURCE_SEARCH_CHUNK_UNITS,
  SOURCE_SEARCH_TIMEOUT_MS,
  type SourceSearchOperation,
  type SourceSearchRequest,
  type SourceSearchResponse,
} from "../../Editor/sourceRegexSearchProtocol";
import {
  beginSourceReplacementFeedback,
  isSourceReplacementPending,
  SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS,
} from "../../Editor/sourceReplacementFeedback";
import { getCodeMirrorFindReplaceMetrics, replaceAll } from "../codeMirrorFindReplace";
import { TextCodeEditor, type TextCodeEditorHandle } from "../TextCodeEditor";

const TEST_TEXT_THEME: TextEditorThemeOptions = {
  accentColor: "rgb(194, 68, 0)",
  activeLineBackground: "rgba(244, 196, 48, 0.18)",
  borderColor: "rgba(31, 38, 43, 0.16)",
  isDarkMode: false,
  otherSearchMatchBackground: "rgba(244, 196, 48, 0.18)",
  currentSearchMatchBackground: "rgba(244, 196, 48, 0.42)",
  selectionBackground: "rgba(194, 68, 0, 0.18)",
  surfaceBackground: "rgb(251, 249, 244)",
  textColor: "rgb(31, 38, 43)",
};

function mockSearchWorkers() {
  const location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage?: ((event: { data: SourceSearchResponse }) => void) | null;
    onerror?: ((event: ErrorEvent) => void) | null;
    postMessage = vi.fn();
    terminate = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor() {
      workers.push(this);
    }
    emit(message: SourceSearchResponse) {
      this.onmessage?.({ data: message });
    }
  }
  vi.stubGlobal("Worker", MockWorker);
  return {
    workers,
    restore: () => {
      vi.unstubAllGlobals();
      location.mockRestore();
    },
  };
}

describe("TextCodeEditor", () => {
  it("matches native search, replacement, positions and history after repeatable generated edits in the real worker", async () => {
    const randomConfig = { seed: 0x5eed1234, multiplier: 1_664_525, increment: 1_013_904_223, steps: 16, maximumDeletion: 5 };
    const tokens = ["alpha", "Alpha", "ALPHA", "alphabet", "alpha2", "_alpha", "-alpha-", "\n", "\uD83D\uDE80", "e\u0301", " "];
    const replacements = ["", "$2:$1", "ALPHA\nalpha", "\uD83D\uDE80alpha"];
    const operations: SourceSearchOperation[] = ["count", "next", "previous", "replace-one", "replace-all"];
    const commands = { next: findNext, previous: findPrevious, "replace-one": replaceNext, "replace-all": nativeReplaceAll };
    const responses: SourceSearchResponse[] = [];
    const effectiveOperations = new Set<SourceSearchOperation>();
    const selectionDirections = new Set<number>();
    vi.stubGlobal("postMessage", (response: SourceSearchResponse) => responses.push(response));
    vi.stubGlobal("onmessage", null);
    try {
      await import("../../Editor/sourceRegexSearch.worker");
      expect(responses.splice(0)).toEqual([{ type: "ready" }]);
      const handler = globalThis.onmessage!;
      const send = (message: SourceSearchRequest) => handler.call(window, new MessageEvent("message", { data: message }));
      for (const expression of ["(alpha)(\\d?)", "(?=alpha)"]) {
        for (const caseSensitive of [false, true]) {
          for (const wholeWord of [false, true]) {
            for (const wordChars of ["", "-"]) {
              let seed = randomConfig.seed;
              const choose = (limit: number) => {
                seed = (Math.imul(seed, randomConfig.multiplier) + randomConfig.increment) >>> 0;
                return (seed >>> 8) % limit;
              };
              let state = EditorState.create({
                doc: tokens.join(" "),
                extensions: [search(), history(), EditorState.languageData.of(() => [{ wordChars }])],
              });
              for (let step = 0; step < randomConfig.steps; step += 1) {
                const from = choose(state.doc.length + 1);
                const to = from + choose(Math.min(randomConfig.maximumDeletion, state.doc.length - from) + 1);
                state = state.update({ changes: { from, to, insert: tokens[choose(tokens.length)] }, userEvent: "input.type" }).state;
                const anchor = choose(state.doc.length + 1);
                const head = step % 3 === 0 ? anchor : choose(state.doc.length + 1);
                selectionDirections.add(Math.sign(head - anchor));
                const replace = requireTestValue(replacements[step % replacements.length]);
                const query = new SearchQuery({ search: expression, replace, regexp: true, literal: true, caseSensitive, wholeWord });
                state = state.update({ selection: EditorSelection.range(anchor, head), effects: setSearchQuery.of(query) }).state;
                const operation = requireTestValue(operations[step % operations.length]);
                const context = JSON.stringify({
                  seed: randomConfig.seed,
                  step,
                  expression,
                  caseSensitive,
                  wholeWord,
                  wordChars,
                  operation,
                });
                const changes: { from: number; to: number; insert: string }[] = [];
                const ranges: { from: number; to: number }[] = [];
                let completion: Extract<SourceSearchResponse, { type: "complete" }> | undefined;
                let sourceOffset = 0;
                responses.length = 0;
                send({
                  type: "start",
                  operation,
                  query: { search: expression, replace, caseSensitive, wholeWord, wordChars, literal: true },
                  selection: { anchor, head },
                });
                for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
                  const response = requireTestValue(responses[responseIndex]);
                  if (response.type === "source-ack") {
                    const text = state.doc.sliceString(sourceOffset, sourceOffset + SOURCE_SEARCH_CHUNK_UNITS);
                    sourceOffset += text.length;
                    send({ type: "source", text, complete: sourceOffset === state.doc.length });
                  } else if (response.type === "ranges") {
                    ranges.push(...response.ranges);
                    send({ type: "ack" });
                  } else if (response.type === "change") {
                    if (response.continued) {
                      expect(changes.at(-1), context).toMatchObject({ from: response.from, to: response.to });
                      requireTestValue(changes[changes.length - 1]).insert += response.insert;
                    } else changes.push({ from: response.from, to: response.to, insert: response.insert });
                    send({ type: "ack" });
                  } else if (response.type === "announcement") send({ type: "ack" });
                  else if (response.type === "complete") completion = response;
                  else throw new Error(`${context}: unexpected worker response ${JSON.stringify(response)}`);
                }
                expect(completion, context).toBeDefined();
                if (operation === "count") {
                  const expectedRanges = [];
                  const cursor = query.getCursor(state);
                  for (let match = cursor.next(); !match.done; match = cursor.next())
                    expectedRanges.push({ from: match.value.from, to: match.value.to });
                  expect(ranges, context).toEqual(expectedRanges);
                  expect(changes, context).toEqual([]);
                  if (ranges.length) effectiveOperations.add(operation);
                  continue;
                }
                let expectedTransaction: Transaction | undefined;
                commands[operation]({
                  state,
                  plugin: () => null,
                  dispatch: (spec: TransactionSpec) => {
                    expectedTransaction = state.update(spec);
                  },
                } as unknown as EditorView);
                const expected = expectedTransaction?.state ?? state;
                const replay = state.update({ changes, selection: completion!.selection, userEvent: completion!.userEvent });
                expect(replay.state.doc.toString(), context).toBe(expected.doc.toString());
                expect(replay.state.selection.toJSON(), context).toEqual(expected.selection.toJSON());
                if (replay.docChanged || !replay.state.selection.eq(state.selection)) effectiveOperations.add(requireTestValue(operation));
                expect(completion!.userEvent, context).toBe(expectedTransaction?.annotation(Transaction.userEvent));
                const expectedChanges = expectedTransaction?.changes ?? state.changes();
                for (let position = 0; position <= state.doc.length; position += 1) {
                  for (const association of [-1, 1])
                    expect(replay.changes.mapPos(position, association), context).toBe(expectedChanges.mapPos(position, association));
                }
                let actualHistory = replay.state;
                let expectedHistory = expected;
                for (const historyCommand of [undo, redo]) {
                  const actualResult = historyCommand({
                    state: actualHistory,
                    dispatch: (transaction) => {
                      actualHistory = transaction.state;
                    },
                  });
                  const expectedResult = historyCommand({
                    state: expectedHistory,
                    dispatch: (transaction) => {
                      expectedHistory = transaction.state;
                    },
                  });
                  expect(actualResult, context).toBe(expectedResult);
                  expect(actualHistory.doc.toString(), context).toBe(expectedHistory.doc.toString());
                  expect(actualHistory.selection.toJSON(), context).toEqual(expectedHistory.selection.toJSON());
                }
                state = replay.state;
              }
            }
          }
        }
      }
      for (const expression of ["alpha", "(?=alpha)", "a.a", "a+"]) {
        for (const wholeWord of [false, true]) {
          const query = new SearchQuery({ search: expression, regexp: true, wholeWord });
          let requestWordChars = "$";
          let reference = EditorState.create({
            doc: "alpha alphabet ALPHA $alpha\nalpha alpha",
            selection: EditorSelection.range(10, 2),
            extensions: [search(), EditorState.languageData.of(() => [{ wordChars: requestWordChars }])],
          });
          reference = reference.update({ effects: setSearchQuery.of(query) }).state;
          const navigation: ("next" | "previous")[] = ["next", "next", "previous", "next", "next", "next", "next", "previous", "previous"];
          for (const [index, operation] of navigation.entries()) {
            requestWordChars = index % 2 ? "" : "$";
            const selection = { anchor: reference.selection.main.anchor, head: reference.selection.main.head };
            responses.length = 0;
            if (index === 0) {
              send({
                type: "start",
                operation,
                query: { search: expression, replace: "", caseSensitive: false, wholeWord, wordChars: requestWordChars, literal: true },
                selection,
              });
              expect(responses.splice(0)).toEqual([{ type: "source-ack" }]);
              send({ type: "source", text: reference.doc.toString(), complete: true });
            } else send({ type: "navigate", operation, selection, wordChars: requestWordChars });
            commands[operation]({
              state: reference,
              plugin: () => null,
              dispatch: (spec: TransactionSpec) => {
                reference = reference.update(spec).state;
              },
            } as unknown as EditorView);
            let completion: Extract<SourceSearchResponse, { type: "complete" }> | undefined;
            for (let responseIndex = 0; responseIndex < responses.length; responseIndex += 1) {
              const response = requireTestValue(responses[responseIndex]);
              if (response.type === "announcement") send({ type: "ack" });
              else if (response.type === "complete") completion = response;
              else throw new Error(`Unexpected navigation response ${JSON.stringify(response)}`);
            }
            expect(completion).toBeDefined();
            expect(completion!.selection ?? selection).toEqual({
              anchor: reference.selection.main.anchor,
              head: reference.selection.main.head,
            });
          }
        }
      }
      expect([...effectiveOperations].sort()).toEqual([...operations].sort());
      expect([...selectionDirections].sort()).toEqual([-1, 0, 1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { name: "case-sensitive", search: "alpha", caseSensitive: true, wholeWord: false },
    { name: "whole-word", search: "alpha", caseSensitive: false, wholeWord: true },
    { name: "case-sensitive whole-word", search: "alpha", caseSensitive: true, wholeWord: true },
    { name: "zero-length", search: "(?=alpha)", caseSensitive: false, wholeWord: false },
  ])("preserves native position mapping and history for $name worker replacements", ({ search: expression, ...options }) => {
    const mock = mockSearchWorkers();
    const source = "\uD83D\uDE80 Alpha alpha alphabet _alpha alpha_\nalpha tail";
    const query = new SearchQuery({ ...options, search: expression, replace: "XY\nZ", regexp: true, literal: true });
    const transactions: Transaction[] = [];
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: EditorSelection.range(source.length - 2, 3),
        extensions: [
          search(),
          history(),
          sourceRegexSearchLifecycle,
          EditorView.updateListener.of((update) => {
            transactions.push(...update.transactions.filter((transaction) => transaction.docChanged));
          }),
        ],
      }),
    });
    const reference = new EditorView({
      state: EditorState.create({ doc: source, selection: view.state.selection, extensions: [search(), history()] }),
    });
    try {
      for (const editor of [view, reference]) editor.dispatch({ effects: setSearchQuery.of(query) });
      const before = view.state;
      let expectedTransaction: Transaction | undefined;
      const dispatch = vi.spyOn(reference, "dispatch").mockImplementation((...specs) => {
        expectedTransaction = reference.state.update(...specs);
        reference.update([expectedTransaction]);
      });
      nativeReplaceAll(reference);
      dispatch.mockRestore();
      expect(expectedTransaction?.docChanged).toBe(true);
      runSourceRegexSearchCommand(view, "replace-all");
      const worker = mock.workers.at(-1)!;
      expectedTransaction!.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        worker.emit({ type: "change", from, to, insert: inserted.toString(), continued: false });
      });
      worker.emit({ type: "complete", announcements: [] });
      expect(transactions).toHaveLength(1);
      expect(view.state.doc.eq(reference.state.doc)).toBe(true);
      expect(view.state.selection.toJSON()).toEqual(reference.state.selection.toJSON());
      for (let position = 0; position <= source.length; position += 1) {
        for (const association of [-1, 1]) {
          expect(requireTestValue(transactions[0]).changes.mapPos(position, association)).toBe(
            expectedTransaction!.changes.mapPos(position, association)
          );
        }
      }
      expect(undo(view)).toBe(true);
      expect(view.state.doc.eq(before.doc)).toBe(true);
      expect(view.state.selection.toJSON()).toEqual(before.selection.toJSON());
      expect(redo(view)).toBe(true);
      expect(view.state.doc.eq(reference.state.doc)).toBe(true);
      expect(view.state.selection.toJSON()).toEqual(reference.state.selection.toJSON());
    } finally {
      view.destroy();
      reference.destroy();
      mock.restore();
    }
  });

  it("keeps quick literal replacements synchronous without busy feedback", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "alpha alpha", extensions: [search()] }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", replace: "done" })) });
      replaceAll(view);
      expect(view.state.doc.toString()).toBe("done done");
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(isSourceReplacementPending(view)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("delays preparation feedback and removes it immediately on completion", async () => {
    vi.useFakeTimers();
    const view = new EditorView({ state: EditorState.create({ doc: "alpha", extensions: [search()] }) });
    try {
      const quick = beginSourceReplacementFeedback(view);
      quick.apply(
        () => {},
        false,
        () => {}
      );
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      const slow = beginSourceReplacementFeedback(view);
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS - 1);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(view.dom.querySelector('[role="status"]')).not.toBeNull();
      slow.dispose();
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(view.dom).not.toHaveAttribute("aria-busy");
    } finally {
      view.destroy();
      vi.useRealTimers();
    }
  });

  it("paints heavy literal feedback before applying once and cancels stale work", async () => {
    vi.useFakeTimers();
    const source = "alpha ".repeat(10_000);
    const view = new EditorView({ state: EditorState.create({ doc: source, extensions: [search()] }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", replace: "done" })) });
      replaceAll(view);
      replaceAll(view);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.dom.querySelector('[role="status"]')).not.toBeNull();
      view.dispatch({ changes: { from: 0, insert: "new " } });
      await vi.advanceTimersByTimeAsync(100);
      expect(view.state.doc.toString()).toBe(`new ${source}`);
      expect(isSourceReplacementPending(view)).toBe(false);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
    } finally {
      view.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps quick worker replacements free of feedback and delays slow preparation", async () => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({ state: EditorState.create({ doc: "aa aa", extensions: [search(), sourceRegexSearchLifecycle] }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", replace: "b", regexp: true })) });
      runSourceRegexSearchCommand(view, "replace-all");
      const quick = mock.workers.at(-1)!;
      quick.emit({ type: "change", from: 0, to: 2, insert: "b", continued: false });
      quick.emit({ type: "complete", announcements: [] });
      expect(view.state.doc.toString()).toBe("b aa");
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      runSourceRegexSearchCommand(view, "replace-all");
      const slow = mock.workers.at(-1)!;
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS - 1);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(view.dom.querySelector('[role="status"]')).not.toBeNull();
      slow.emit({ type: "error", message: "Replacement failed; retry." });
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(isSourceReplacementPending(view)).toBe(false);
    } finally {
      view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("applies a heavy literal plan once with native undo and redo", async () => {
    vi.useFakeTimers();
    const source = "alpha ".repeat(10_000);
    let transactions = 0;
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        extensions: [
          search(),
          history(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) transactions += 1;
          }),
        ],
      }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", replace: "done" })) });
      replaceAll(view);
      replaceAll(view);
      expect(view.state.doc.toString()).toBe(source);
      expect(view.contentDOM).toHaveAttribute("aria-busy", "true");
      await vi.advanceTimersByTimeAsync(100);
      expect(view.state.doc.toString()).toBe("done ".repeat(10_000));
      expect(transactions).toBe(1);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(view.contentDOM).not.toHaveAttribute("aria-busy");
      undo(view);
      expect(view.state.doc.toString()).toBe(source);
      redo(view);
      expect(view.state.doc.toString()).toBe("done ".repeat(10_000));
    } finally {
      view.destroy();
      vi.useRealTimers();
    }
  });

  it.each(["selection", "query", "read-only", "destroy"])("cancels a deferred heavy replacement on %s", async (reason) => {
    vi.useFakeTimers();
    const source = "alpha ".repeat(10_000);
    const view = new EditorView({ state: EditorState.create({ doc: source, extensions: [search()] }) });
    const destroyView = vi.spyOn(view, "destroy");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", replace: "done" })) });
      replaceAll(view);
      if (reason === "selection") view.dispatch({ selection: { anchor: 2 } });
      if (reason === "query") view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "other" })) });
      if (reason === "read-only") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
      if (reason === "destroy") view.destroy();
      await vi.advanceTimersByTimeAsync(100);
      expect(view.state.doc.toString()).toBe(source);
      expect(isSourceReplacementPending(view)).toBe(false);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
    } finally {
      if (!(destroyView.mock.calls.length > 0)) view.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps slow worker feedback through the paint boundary and clears pending on selection cancellation", async () => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({ state: EditorState.create({ doc: "aa aa", extensions: [search(), sourceRegexSearchLifecycle] }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", replace: "b", regexp: true })) });
      runSourceRegexSearchCommand(view, "replace-all");
      const worker = mock.workers.at(-1)!;
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS);
      worker.emit({ type: "change", from: 0, to: 2, insert: "b", continued: false });
      worker.emit({ type: "complete", announcements: [] });
      expect(view.state.doc.toString()).toBe("aa aa");
      view.dispatch({ selection: { anchor: 3 } });
      await vi.advanceTimersByTimeAsync(100);
      expect(view.state.doc.toString()).toBe("aa aa");
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(false);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
    } finally {
      view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("completes heavy work in a hidden document and clears feedback after an application error", async () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const view = new EditorView({ state: EditorState.create({ doc: "alpha", extensions: [search()] }) });
    try {
      const action = vi.fn(() => {
        throw new Error("Apply failed");
      });
      const failure = vi.fn();
      beginSourceReplacementFeedback(view).apply(action, true, failure);
      await vi.advanceTimersByTimeAsync(1);
      expect(action).toHaveBeenCalledOnce();
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: "Apply failed" }));
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(isSourceReplacementPending(view)).toBe(false);
    } finally {
      view.destroy();
      hidden.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["timeout", "destroy"])("clears slow worker feedback on %s", async (reason) => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({ state: EditorState.create({ doc: "alpha", extensions: [search(), sourceRegexSearchLifecycle] }) });
    const destroyView = vi.spyOn(view, "destroy");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a", regexp: true })) });
      runSourceRegexSearchCommand(view, "replace-all");
      const worker = mock.workers.at(-1)!;
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS);
      expect(view.dom.querySelector('[role="status"]')).not.toBeNull();
      if (reason === "destroy") view.destroy();
      else await vi.advanceTimersByTimeAsync(SOURCE_SEARCH_TIMEOUT_MS);
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(isSourceReplacementPending(view)).toBe(false);
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      if (!(destroyView.mock.calls.length > 0)) view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("does not animate replacement feedback when reduced motion is requested", async () => {
    vi.useFakeTimers();
    const view = new EditorView({ state: EditorState.create({ doc: "alpha", extensions: [search()] }) });
    const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const animate = vi.fn();
    const previousAnimate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = animate;
    try {
      const feedback = beginSourceReplacementFeedback(view);
      await vi.advanceTimersByTimeAsync(SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS);
      expect(view.dom.querySelector('[role="status"]')).not.toBeNull();
      expect(animate).not.toHaveBeenCalled();
      feedback.dispose();
    } finally {
      view.destroy();
      HTMLElement.prototype.animate = previousAnimate;
      matchMedia.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retains an unchanged regex session when passive decorations are reconfigured", () => {
    const mock = mockSearchWorkers();
    const extensions = () => [search(), sourceRegexSearchLifecycle, buildPassiveSearchHighlightExtension()];
    const view = new EditorView({ state: EditorState.create({ doc: "aa", extensions: extensions() }) });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      view.dispatch({ effects: StateEffect.reconfigure.of(extensions()) });
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(true);
      expect(mock.workers).toHaveLength(1);
      expect(requireTestValue(mock.workers[0]).terminate).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      mock.restore();
    }
    expect(requireTestValue(mock.workers[0]).terminate).toHaveBeenCalledOnce();
  });

  it("publishes exact regex counts only after the final worker batch without recounting selection changes", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(true);
      const worker = requireTestValue(mock.workers[0]);
      worker.emit({ type: "ready" });
      expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ wordChars: "" }) }));
      worker.emit({ type: "source-ack" });
      worker.emit({
        type: "ranges",
        ranges: [
          { from: 0, to: 2 },
          { from: 3, to: 5 },
        ],
      });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 0, pending: true });
      worker.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      view.dispatch({ selection: { anchor: 3, head: 5 } });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 2, currentMatch: 2, pending: false });
      expect(mock.workers).toHaveLength(1);
      expect(cursor).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      cursor.mockRestore();
      view.destroy();
      mock.restore();
    }
  });

  it.each(["complete", "failure", "cancel", "destroy"])("releases regex worker callbacks after %s", async (reason) => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), sourceRegexSearchLifecycle] }),
    });
    const destroyView = vi.spyOn(view, "destroy");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      getCodeMirrorFindReplaceMetrics(view);
      const worker = requireTestValue(mock.workers[0]);
      const decode = worker.addEventListener.mock.calls.find(([type]) => type === "messageerror")?.[1];
      expect(decode).toBeTypeOf("function");
      if (reason === "complete") worker.emit({ type: "complete", announcements: [] });
      else if (reason === "failure") worker.emit({ type: "error", message: "Search failed" });
      else if (reason === "cancel") view.dispatch({ changes: { from: 0, insert: "new " } });
      else view.destroy();
      await Promise.resolve();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();
      expect(worker.removeEventListener).toHaveBeenCalledWith("messageerror", decode);
    } finally {
      if (!(destroyView.mock.calls.length > 0)) view.destroy();
      mock.restore();
    }
  });

  it("preserves repeated regex navigation without restarting the active worker", () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa aa aa", extensions: [search(), sourceRegexSearchLifecycle] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      getCodeMirrorFindReplaceMetrics(view);
      requireTestValue(mock.workers[0]).emit({
        type: "ranges",
        ranges: [0, 3, 6, 9].map((from) => ({ from, to: from + 2 })),
      });
      requireTestValue(mock.workers[0]).emit({ type: "complete", announcements: [] });
      for (let index = 0; index < 3; index += 1) runSourceRegexSearchCommand(view, "next");
      expect(mock.workers).toHaveLength(2);
      const worker = requireTestValue(mock.workers[1]);
      expect(worker.terminate).not.toHaveBeenCalled();
      for (const from of [0, 3, 6]) {
        worker.emit({ type: "complete", selection: { anchor: from, head: from + 2 }, announcements: [] });
        expect(view.state.selection.main.from).toBe(from);
      }
      expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
        { type: "navigate", operation: "next", selection: { anchor: 0, head: 2 }, wordChars: "" },
        { type: "navigate", operation: "next", selection: { anchor: 3, head: 5 }, wordChars: "" },
      ]);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ pending: false, matches: 4, currentMatch: 3 });
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it.each(["next", "previous"] as const)("keeps mixed queued regex navigation in order after %s", (operation) => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({
        doc: "$alpha alpha",
        extensions: [search(), sourceRegexSearchLifecycle, EditorState.languageData.of(() => [{ wordChars: "$" }])],
      }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", regexp: true, wholeWord: true })) });
      runSourceRegexSearchCommand(view, operation);
      runSourceRegexSearchCommand(view, "previous");
      runSourceRegexSearchCommand(view, "next");
      const worker = mock.workers.at(-1)!;
      worker.emit({ type: "complete", selection: { anchor: 7, head: 12 }, announcements: [] });
      expect(getCodeMirrorFindReplaceMetrics(view).pending).toBe(true);
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        type: "navigate",
        operation: "previous",
        selection: { anchor: 7, head: 12 },
        wordChars: "$",
      });
      worker.emit({ type: "complete", announcements: [] });
      expect(worker.postMessage).toHaveBeenLastCalledWith({
        type: "navigate",
        operation: "next",
        selection: { anchor: 7, head: 12 },
        wordChars: "$",
      });
      worker.emit({ type: "complete", selection: { anchor: 7, head: 12 }, announcements: [] });
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it.each(["selection", "document", "query", "destroy", "error", "timeout"])("cancels queued regex navigation on %s", async (reason) => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({ state: EditorState.create({ doc: "aa aa", extensions: [search(), sourceRegexSearchLifecycle] }) });
    const destroyView = vi.spyOn(view, "destroy");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      runSourceRegexSearchCommand(view, "next");
      runSourceRegexSearchCommand(view, "previous");
      const worker = mock.workers.at(-1)!;
      if (reason === "selection") {
        view.dispatch({ selection: { anchor: 3 } });
        view.dispatch({ selection: { anchor: 0 } });
      } else if (reason === "document") view.dispatch({ changes: { from: 0, insert: "new " } });
      else if (reason === "query") view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "b+", regexp: true })) });
      else if (reason === "destroy") view.destroy();
      else if (reason === "error") worker.emit({ type: "error", message: "Navigation failed" });
      else await vi.advanceTimersByTimeAsync(SOURCE_SEARCH_TIMEOUT_MS);
      worker.emit({ type: "complete", selection: { anchor: 0, head: 2 }, announcements: [] });
      expect(view.state.selection.main.empty).toBe(true);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "navigate" }));
    } finally {
      if (!(destroyView.mock.calls.length > 0)) view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("allows pending navigation but rejects a replacement after selection changes away and back", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      expect(runSourceRegexSearchCommand(view, "next")).toBe(true);
      expect(requireTestValue(mock.workers[0]).terminate).toHaveBeenCalledOnce();
      requireTestValue(mock.workers[1]).emit({ type: "complete", selection: { anchor: 0, head: 2 }, announcements: [] });
      expect(view.state.selection.main.to).toBe(2);
      runSourceRegexSearchCommand(view, "replace-all");
      const worker = mock.workers.at(-1)!;
      worker.emit({ type: "change", from: 0, to: 2, insert: "replacement", continued: false });
      expect(view.state.doc.toString()).toBe("aa aa");
      view.dispatch({ selection: { anchor: 3 } });
      view.dispatch({ selection: { anchor: 0, head: 2 } });
      worker.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe("aa aa");
      expect(getCodeMirrorFindReplaceMetrics(view).error).toMatch(/selection changed/);
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("terminates a stalled regex worker and permits a fresh-worker retry", async () => {
    vi.useFakeTimers();
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aaaa!", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "(a+)+$", regexp: true })) });
      requireTestValue(mock.workers[0]).emit({ type: "ready" });
      await vi.advanceTimersByTimeAsync(SOURCE_SEARCH_TIMEOUT_MS);
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ pending: false, matches: 0 });
      expect(getCodeMirrorFindReplaceMetrics(view).error).toMatch(/timed out/);
      expect(requireTestValue(mock.workers[0]).terminate).toHaveBeenCalledOnce();
      runSourceRegexSearchCommand(view, "next");
      expect(mock.workers).toHaveLength(2);
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ pending: true, error: undefined });
    } finally {
      view.destroy();
      mock.restore();
      vi.useRealTimers();
    }
  });

  it("discards buffered replacements after a document or query revision changes", async () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({ doc: "aa aa", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "a+", regexp: true })) });
      runSourceRegexSearchCommand(view, "replace-all");
      const staleDocument = mock.workers.at(-1)!;
      staleDocument.emit({ type: "change", from: 0, to: 2, insert: "wrong", continued: false });
      view.dispatch({ changes: { from: 0, insert: "new " } });
      staleDocument.emit({ type: "complete", announcements: [] });
      expect(view.state.doc.toString()).toBe("new aa aa");
      runSourceRegexSearchCommand(view, "replace-all");
      const staleQuery = mock.workers.at(-1)!;
      staleQuery.emit({ type: "change", from: 4, to: 6, insert: "wrong", continued: false });
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "new", regexp: true })) });
      staleQuery.emit({ type: "complete", announcements: [] });
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe("new aa aa");
      expect(staleDocument.terminate).toHaveBeenCalledOnce();
      expect(staleQuery.terminate).toHaveBeenCalledOnce();
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("passes native language word characters to the regex worker", () => {
    const mock = mockSearchWorkers();
    const view = new EditorView({
      state: EditorState.create({
        doc: "$alpha alpha",
        extensions: [search(), buildPassiveSearchHighlightExtension(), EditorState.languageData.of(() => [{ wordChars: "$" }])],
      }),
    });
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "alpha", regexp: true, wholeWord: true })) });
      requireTestValue(mock.workers[0]).emit({ type: "ready" });
      expect(requireTestValue(mock.workers[0]).postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ wordChars: "$" }) })
      );
    } finally {
      view.destroy();
      mock.restore();
    }
  });

  it("does not execute regex cursors on the main thread while worker results are pending", () => {
    const location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener() {}
        terminate() {}
      }
    );
    const view = new EditorView({
      state: EditorState.create({ doc: "aaaa!", extensions: [search(), buildPassiveSearchHighlightExtension()] }),
    });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "(a+)+$", regexp: true })) });
      view.dispatch({ selection: { anchor: 0, head: 4 } });
      expect(getCodeMirrorFindReplaceMetrics(view)).toMatchObject({ matches: 0, pending: true });
      expect(cursor).not.toHaveBeenCalled();
    } finally {
      cursor.mockRestore();
      view.destroy();
      vi.unstubAllGlobals();
      location.mockRestore();
    }
  });

  it("bounds cold decoration cursors to the selection or viewport and reuses warm metrics", () => {
    const passiveHighlights = buildPassiveSearchHighlightExtension();
    const view = new EditorView({
      state: EditorState.create({ doc: "word\n".repeat(6_000), extensions: [search(), passiveHighlights] }),
    });
    Object.defineProperty(view, "visibleRanges", { configurable: true, get: () => [{ from: 0, to: 20 }] });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    const refreshViewport = () => {
      const plugin = view.plugin(
        passiveHighlights as ViewPlugin<{
          update: (update: Pick<ViewUpdate, "view" | "state" | "startState" | "docChanged" | "selectionSet" | "viewportChanged">) => void;
        }>
      );
      if (!plugin) throw new Error("Expected passive search decorations");
      plugin.update({ view, state: view.state, startState: view.state, docChanged: false, selectionSet: false, viewportChanged: true });
    };
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "word" })) });
      for (const index of [0, 2_999, 5_999]) view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
      refreshViewport();
      expect(cursor.mock.calls.length).toBeGreaterThan(0);
      expect(
        cursor.mock.calls.every(
          ([, from, to]) => (from === 0 && to === 20) || [0, 2_999, 5_999].some((index) => from === index * 5 && to === index * 5 + 4)
        )
      ).toBe(true);
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(6_000);
      cursor.mockClear();
      for (const index of [0, 2_999, 5_999]) view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
      refreshViewport();
      expect(cursor.mock.calls.every(([, from, to]) => from === 0 && to === 20)).toBe(true);
    } finally {
      cursor.mockRestore();
      view.destroy();
    }
  });

  it("locates a contained active match with logarithmic range access", () => {
    const ranges = Array.from({ length: 60_000 }, (_, index) => ({ from: index * 5, to: index * 5 + 4 }));
    let reads = 0;
    const indexed = new Proxy(ranges, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(findSelectedCodeMirrorSearchMatch(indexed, { from: 299_990, to: 300_000 })).toBe(59_998);
    expect(reads).toBeLessThan(20);
    expect(findSelectedCodeMirrorSearchMatch(ranges, { from: 1, to: 4 })).toBe(-1);
    expect(findSelectedCodeMirrorSearchMatch([], { from: 0, to: 0 })).toBe(-1);
  });

  it("reuses counts across selection changes and invalidates them on edits or query changes", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "word ".repeat(6_000), extensions: [search()] }) });
    const cursor = vi.spyOn(SearchQuery.prototype, "getCursor");
    try {
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "word" })) });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(6_000);
      const initialCalls = cursor.mock.calls.length;
      for (const index of [0, 2_999, 5_999]) {
        view.dispatch({ selection: { anchor: index * 5, head: index * 5 + 4 } });
        expect(getCodeMirrorFindReplaceMetrics(view).currentMatch).toBe(index + 1);
      }
      expect(cursor).toHaveBeenCalledTimes(initialCalls);
      view.dispatch({ selection: { anchor: 1, head: 9 } });
      expect(getCodeMirrorFindReplaceMetrics(view).currentMatch).toBe(2);
      expect(cursor).toHaveBeenCalledTimes(initialCalls);
      view.dispatch({ changes: { from: 0, to: 5, insert: "" } });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(5_999);
      expect(cursor.mock.calls.length).toBeGreaterThan(initialCalls);
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "missing" })) });
      expect(getCodeMirrorFindReplaceMetrics(view).matches).toBe(0);
    } finally {
      cursor.mockRestore();
      view.destroy();
    }
  });
  it("captures source snapshots and rejects capture after cancellation or unmount", async () => {
    const editorRef = createRef<TextCodeEditorHandle>();
    const { unmount } = render(
      <TextCodeEditor
        ref={editorRef}
        ariaLabel="Snapshot text"
        filename="notes.txt"
        text="latest text"
        theme={TEST_TEXT_THEME}
        onChange={() => {}}
      />
    );
    await screen.findByLabelText("Snapshot text");
    const handle = editorRef.current;
    if (!handle) throw new Error("Expected a mounted text editor");
    const snapshot = await handle.captureSnapshot();
    expect(handle.captureSnapshotSync().serialize()).toBe("latest text");
    const editor = screen.getByLabelText("Snapshot text");
    editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(() => handle.captureSnapshotSync()).toThrow(/composition/);
    editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(snapshot.serialize()).toBe("latest text");
    const abort = new AbortController();
    abort.abort();
    await expect(handle.captureSnapshot(abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    unmount();

    expect(snapshot.serialize()).toBe("latest text");
    expect(() => handle.captureSnapshotSync()).toThrow(/disposed/);
    await expect(handle.captureSnapshot()).rejects.toThrow(/disposed/);
  });

  it.each(["dark", "custom-alpha"])("preserves editor identity, search and undo across a %s theme change", async (variant) => {
    const text = "const alpha = 1;\n".repeat(120);
    const onChange = vi.fn();
    const props = {
      ariaLabel: "Theme text",
      filename: "sample.js",
      text,
      theme: TEST_TEXT_THEME,
      onChange,
      searchOpen: true,
      searchText: "alpha",
    };
    const { rerender } = render(<TextCodeEditor {...props} />);
    const editor = await screen.findByLabelText("Theme text");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("Expected a mounted text editor");
    await act(async () => {
      view.dispatch({ changes: { from: text.length, insert: "// draft" }, selection: { anchor: 6, head: 11 } });
    });
    const doc = view.state.doc;
    const selection = view.state.selection;
    const query = getSearchQuery(view.state);
    const metrics = getCodeMirrorFindReplaceMetrics(view);
    view.scrollDOM.scrollTop = 240;
    view.scrollDOM.scrollLeft = 30;
    onChange.mockClear();

    rerender(
      <TextCodeEditor
        {...props}
        text={doc.toString()}
        theme={{
          ...TEST_TEXT_THEME,
          isDarkMode: true,
          textColor: "rgb(240, 242, 244)",
          surfaceBackground: variant === "dark" ? "rgb(24, 26, 28)" : "rgba(24, 26, 28, 0.8)",
          selectionBackground: "rgba(60, 180, 210, 0.4)",
        }}
      />
    );

    await waitFor(() => expect(view.state.facet(EditorView.darkTheme)).toBe(true));
    expect(EditorView.findFromDOM(screen.getByLabelText("Theme text"))).toBe(view);
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection).toBe(selection);
    expect(getSearchQuery(view.state)).toBe(query);
    expect(getCodeMirrorFindReplaceMetrics(view)).toEqual(metrics);
    expect(view.scrollDOM.scrollTop).toBe(240);
    expect(view.scrollDOM.scrollLeft).toBe(30);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(text);
  });

  it("reconfigures line wrapping without recreating the editor", async () => {
    const { rerender } = render(
      <TextCodeEditor
        ariaLabel="Text editor"
        filename="notes.txt"
        lineWrapping={false}
        onChange={() => {}}
        text="A long line"
        theme={TEST_TEXT_THEME}
      />
    );

    const editor = await screen.findByLabelText("Text editor");
    expect(editor).not.toHaveClass("cm-lineWrapping");

    rerender(
      <TextCodeEditor
        ariaLabel="Text editor"
        filename="notes.txt"
        lineWrapping={true}
        onChange={() => {}}
        text="A long line"
        theme={TEST_TEXT_THEME}
      />
    );

    await waitFor(() => {
      expect(editor).toHaveClass("cm-lineWrapping");
    });
    expect(editor).toHaveTextContent("A long line");
  });

  it("replaces the selected and remaining CodeMirror search matches", async () => {
    const editorRef = createRef<TextCodeEditorHandle>();

    render(
      <TextCodeEditor
        ref={editorRef}
        ariaLabel="Text editor"
        filename="notes.txt"
        onChange={() => {}}
        searchOpen={true}
        searchReplaceText="done"
        searchText="alpha"
        text="alpha beta alpha"
        theme={TEST_TEXT_THEME}
      />
    );

    const editor = await screen.findByLabelText("Text editor");

    expect(editor.closest(".cm-editor")?.querySelector(".cm-selectionLayer")).not.toBeNull();
    expect(editor.closest(".cm-editor")?.querySelector(".sambee-editor-selection-layer")).not.toBeNull();

    editorRef.current?.replaceCurrentSearchResult();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalText()).toBe("done beta alpha");
    });

    editorRef.current?.replaceAllSearchResults();

    await waitFor(() => {
      expect(editorRef.current?.getCanonicalText()).toBe("done beta done");
    });
  });
});
