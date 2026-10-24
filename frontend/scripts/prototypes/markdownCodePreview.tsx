import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { error as logError } from "../../src/services/logger";
import { syntaxTokenStyles } from "../../src/theme/syntaxStyles";
import { getDefaultTheme } from "../../src/theme/themes";
import { yieldHighlightingTask } from "../../src/utils/codeMirrorHighlighting";
import { highlightingService } from "../../src/utils/highlightingService";
import {
  CODE_PREVIEW_SCAN_MAX_UNITS,
  type CodePreviewModel,
  createCodePreviewModel,
  createCodePreviewModelAsync,
  findCodePreviewFragment,
} from "../../src/utils/markdownCodePreviewModel";
import type { DocumentSearchOptions } from "../../src/utils/markdownDocumentSearch";
import { TOKEN_CATEGORIES, tokenClasses } from "../../src/utils/syntaxHighlighting";
import {
  createDocumentSyntaxSession,
  PREPARATION_CHUNK_ITEMS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  prepareCodePreviewInWorker,
  shutdownCodePreviewWorker,
} from "./markdownCodePreparation";
import { mountMarkdownDocument, renderMarkdownDocumentBaseline } from "./markdownDocumentPreview";
import type { DocumentSearchResult } from "./markdownDocumentSearch";

const ROW_HEIGHT = 20;
const VIEWPORT_HEIGHT = 480;
const OVERSCAN = 3;
const PUBLICATION_BATCH_ROWS = 64;
const PRIORITY_NEIGHBOR_ROWS = 3;
const SOURCE_INDEX_BLOCK_BATCH = 16;

interface Match {
  from: number;
  to: number;
}

interface Fixture {
  sourceIndexingYields: number;
  sourceIndexingMs: number;
  preparationComplete: boolean;
  preparationError: string | null;
  refresh?: () => void;
  sourceChunks: number;
  largestSourceChunkUnits: number;
  sourceUnitsSent: number;
  execution: "main-thread" | "worker";
  transferChunks: number;
  largestChunkItems: number;
  clientAssemblyMs: number;
  preparationWallMs: number;
  generation: number;
  loadStartedAt: number;
  models: CodePreviewModel[];
  rows: { block: number; fragment: number }[];
  offsets: number[];
  blockBounds: Match[];
  rowStarts: number[];
  matches: Match[];
  preparationMs: number;
  indexingMs: number;
  text: string;
}

interface PrototypeControl {
  searchDocument: (query: string, options?: DocumentSearchOptions) => Promise<DocumentSearchResult>;
  jumpDocument: (ordinal: number) => Promise<{ pending: boolean }>;
  shutdownDocument: () => void;
  loadDocument: (source: string) => Promise<void>;
  baselineDocument: (source: string) => Promise<void>;
  inspect: () => { models: readonly CodePreviewModel[]; matches: readonly Match[] };
  load: (
    blocks: string[],
    virtual: boolean | "retained-text" | "retained-text-worker" | "retained-text-worker-progressive"
  ) => Promise<void>;
  jump: (ordinal: number) => { pending: boolean };
  stats: () => Record<string, unknown>;
}

declare global {
  interface Window {
    codePreviewPrototype: PrototypeControl;
  }
}

function RetainedTextPreview({ fixture, onCommit }: { fixture: Fixture; onCommit: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<number, HTMLElement>());
  const active = useRef(-1);
  const painted = useRef({ rows: 0, ranges: 0 });

  useLayoutEffect(() => {
    if (typeof Highlight === "undefined" || !CSS.highlights) throw new Error("Retained-text prototype requires the CSS Highlight API");
    const container = scrollRef.current;
    if (!container) return;
    let frame: number | null = null;
    let publicationTimer: ReturnType<typeof setTimeout> | null = null;
    let publishedRows = 0;
    let publicationBatches = 0;
    let largestPublicationBatch = 0;
    let firstContentMs: number | null = null;
    let publicationMs: number | null = null;
    let pendingRow: number | null = null;
    let activeRow: number | null = null;
    let nextSequentialRow = 0;
    let priorityRows: number[] = [];
    let priorityPublishedRows = 0;
    const publishedIndices: number[] = [];
    const blocks = new Map<number, HTMLElement>();
    const publicationStart = performance.now();
    container.style.overflowAnchor = "none";
    const visible = new Set<number>();
    const paint = () => {
      frame = null;
      if (fixture.generation !== generation) return;
      const categories = new Map<string, Range[]>();
      const search: Range[] = [];
      const selected: Range[] = [];
      let rangeCount = 0;
      for (const index of visible) {
        const element = nodes.current.get(index);
        const textNode = element?.firstChild;
        if (!(textNode instanceof Text)) continue;
        const row = fixture.rows[index];
        const model = fixture.models[row.block];
        const fragment = model.fragments[row.fragment];
        const range = (from: number, to: number) => {
          const result = new Range();
          result.setStart(textNode, Math.max(fragment.from, from) - fragment.from);
          result.setEnd(textNode, Math.min(fragment.to, to) - fragment.from);
          rangeCount += 1;
          return result;
        };
        for (let tokenIndex = fragment.firstRange; tokenIndex < fragment.rangeEnd; tokenIndex += 1) {
          const token = model.ranges[tokenIndex];
          for (const category of token.categories) {
            const ranges = categories.get(category) ?? [];
            ranges.push(range(token.from, token.to));
            categories.set(category, ranges);
          }
        }
        const blockOffset = fixture.offsets[row.block];
        for (
          let matchIndex = firstOverlap(fixture.matches, blockOffset + fragment.from);
          matchIndex < fixture.matches.length && fixture.matches[matchIndex].from < blockOffset + fragment.to;
          matchIndex += 1
        ) {
          const match = fixture.matches[matchIndex];
          search.push(range(match.from - blockOffset, match.to - blockOffset));
          if (matchIndex === active.current) selected.push(range(match.from - blockOffset, match.to - blockOffset));
        }
      }
      for (const category of TOKEN_CATEGORIES)
        CSS.highlights.set(`preview-${category}`, new Highlight(...(categories.get(category) ?? [])));
      const searchHighlight = new Highlight(...search);
      searchHighlight.priority = 1;
      CSS.highlights.set("preview-search", searchHighlight);
      const activeHighlight = new Highlight(...selected);
      activeHighlight.priority = 2;
      CSS.highlights.set("preview-active", activeHighlight);
      painted.current = { rows: visible.size, ranges: rangeCount };
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    fixture.refresh = schedule;
    const revealPendingJump = () => {
      if (pendingRow === null) return;
      const element = nodes.current.get(pendingRow);
      if (!element?.isConnected) return;
      element.scrollIntoView({ block: "center" });
      pendingRow = null;
      schedule();
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting) visible.add(index);
          else visible.delete(index);
        }
        schedule();
      },
      { root: container, rootMargin: `${VIEWPORT_HEIGHT}px 0px` }
    );
    window.codePreviewPrototype.jump = (ordinal) => {
      if (!fixture.preparationComplete) throw new Error("Prototype search preparation is pending");
      const match = fixture.matches[ordinal];
      if (!match) throw new RangeError("Prototype match ordinal is out of bounds");
      const block = firstOverlap(fixture.blockBounds, match.from);
      const fragment = findCodePreviewFragment(fixture.models[block], match.from - fixture.offsets[block]);
      if (fragment === null) throw new Error("Prototype match has no fragment");
      active.current = ordinal;
      pendingRow = fixture.rowStarts[block] + fragment;
      activeRow = pendingRow;
      priorityRows = [];
      for (let distance = 0; distance <= PRIORITY_NEIGHBOR_ROWS; distance += 1) {
        const candidates = distance === 0 ? [pendingRow] : [pendingRow - distance, pendingRow + distance];
        for (const index of candidates) {
          if (index >= 0 && index < fixture.rows.length && !nodes.current.has(index)) priorityRows.push(index);
        }
      }
      revealPendingJump();
      schedule();
      return { pending: pendingRow !== null };
    };
    window.codePreviewPrototype.stats = () => ({
      preparationMs: fixture.preparationMs,
      sourceIndexingMs: fixture.sourceIndexingMs,
      sourceIndexingYields: fixture.sourceIndexingYields,
      preparationComplete: fixture.preparationComplete,
      preparationError: fixture.preparationError,
      searchComplete: fixture.preparationComplete,
      execution: fixture.execution,
      transferChunks: fixture.transferChunks,
      largestChunkItems: fixture.largestChunkItems,
      transferChunkLimit: PREPARATION_CHUNK_ITEMS,
      sourceChunks: fixture.sourceChunks,
      largestSourceChunkUnits: fixture.largestSourceChunkUnits,
      sourceUnitsSent: fixture.sourceUnitsSent,
      sourceChunkLimit: PREPARATION_SOURCE_CHUNK_UNITS,
      clientAssemblyMs: fixture.clientAssemblyMs,
      preparationWallMs: fixture.preparationWallMs,
      indexingMs: fixture.indexingMs,
      sourceUnits: fixture.text.length,
      generation: fixture.generation,
      totalRows: fixture.rows.length,
      mountedRows: nodes.current.size,
      publishedRows,
      publicationBatches,
      largestPublicationBatch,
      publicationBatchLimit: PUBLICATION_BATCH_ROWS,
      publicationComplete: publishedRows === fixture.rows.length,
      priorityPublishedRows,
      activeRow,
      firstContentMs,
      publicationMs,
      mountedSpans: nodes.current.size,
      mountedTokenSpans: 0,
      decoratedRows: painted.current.rows,
      highlightRanges: painted.current.ranges,
      matchCount: fixture.matches.length,
      active: active.current,
      pendingMatch: pendingRow === null ? null : active.current,
      activeMounted: pendingRow === null && (CSS.highlights.get("preview-active")?.size ?? 0) > 0,
      scrollTop: container.scrollTop,
      oversizedLines: fixture.models.flatMap((model) => model.fragments).filter((fragment) => fragment.oversizedLine).length,
      mountedTextUnits: container.textContent?.length ?? 0,
    });
    const publish = () => {
      publicationTimer = null;
      if (fixture.generation !== generation) return;
      const anchor = activeRow === null ? null : nodes.current.get(activeRow);
      const anchorRect = anchor?.getBoundingClientRect();
      const viewport = anchorRect ? container.getBoundingClientRect() : null;
      const anchorTop =
        anchorRect && viewport && anchorRect.bottom > viewport.top && anchorRect.top < viewport.bottom ? anchorRect.top : null;
      let batchRows = 0;
      while (batchRows < PUBLICATION_BATCH_ROWS && publishedRows < fixture.rows.length) {
        let index = priorityRows.shift();
        const prioritized = index !== undefined;
        if (index === undefined) {
          while (nodes.current.has(nextSequentialRow)) nextSequentialRow += 1;
          index = nextSequentialRow++;
        }
        if (nodes.current.has(index)) continue;
        const row = fixture.rows[index];
        const model = fixture.models[row.block];
        const fragment = model.fragments[row.fragment];
        const text = model.text.slice(fragment.from, fragment.to);
        const lines = Math.max(1, text.split("\n").length - Number(text.endsWith("\n")));
        const element = document.createElement("span");
        element.dataset.index = String(index);
        element.textContent = text;
        Object.assign(element.style, {
          margin: "0",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontSize: "14px",
          lineHeight: `${ROW_HEIGHT}px`,
          display: "inline-block",
          verticalAlign: "top",
          width: "100%",
          contain: "layout style",
          minHeight: `${lines * ROW_HEIGHT}px`,
        });
        let block = blocks.get(row.block);
        if (!block) {
          block = document.createElement("pre");
          block.dataset.block = String(row.block);
          Object.assign(block.style, { margin: "0", whiteSpace: "normal", fontSize: "14px", lineHeight: `${ROW_HEIGHT}px` });
          let successorBlock: HTMLElement | null = null;
          for (const child of container.children) {
            if (Number((child as HTMLElement).dataset.block) > row.block) {
              successorBlock = child as HTMLElement;
              break;
            }
          }
          container.insertBefore(block, successorBlock);
          blocks.set(row.block, block);
        }
        let low = 0;
        let high = publishedIndices.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          if (publishedIndices[middle] < index) low = middle + 1;
          else high = middle;
        }
        const successor = publishedIndices[low];
        const successorNode = successor === undefined ? null : nodes.current.get(successor);
        block.insertBefore(element, successorNode?.parentNode === block ? successorNode : null);
        publishedIndices.splice(low, 0, index);
        nodes.current.set(index, element);
        observer.observe(element);
        publishedRows += 1;
        batchRows += 1;
        if (prioritized) priorityPublishedRows += 1;
      }
      if (anchorTop !== null && anchor) container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
      revealPendingJump();
      largestPublicationBatch = Math.max(largestPublicationBatch, batchRows);
      publicationBatches += 1;
      firstContentMs ??= performance.now() - fixture.loadStartedAt;
      if (publishedRows < fixture.rows.length) publicationTimer = setTimeout(publish, 0);
      else {
        container.style.overflowAnchor = "auto";
        publicationMs = performance.now() - publicationStart;
        onCommit();
      }
    };
    publish();
    return () => {
      observer.disconnect();
      delete fixture.refresh;
      if (frame !== null) cancelAnimationFrame(frame);
      if (publicationTimer !== null) clearTimeout(publicationTimer);
      nodes.current.clear();
      blocks.clear();
      container.replaceChildren();
      for (const category of TOKEN_CATEGORIES) CSS.highlights.delete(`preview-${category}`);
      CSS.highlights.delete("preview-search");
      CSS.highlights.delete("preview-active");
    };
  }, [fixture, onCommit]);

  return <div ref={scrollRef} data-prototype-scroll data-retained-text style={{ height: VIEWPORT_HEIGHT, overflow: "auto" }} />;
}

function firstOverlap(matches: readonly Match[], offset: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (matches[middle].to <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fragmentContent(model: CodePreviewModel, fragmentIndex: number, matches: Match[], active: number, blockOffset: number) {
  const fragment = model.fragments[fragmentIndex];
  const tokens = model.ranges.slice(fragment.firstRange, fragment.rangeEnd);
  const initialMatch = firstOverlap(matches, blockOffset + fragment.from);
  const boundaries = new Set([fragment.from, fragment.to]);
  for (const token of tokens) {
    boundaries.add(Math.max(fragment.from, token.from));
    boundaries.add(Math.min(fragment.to, token.to));
  }
  for (let index = initialMatch; index < matches.length && matches[index].from < blockOffset + fragment.to; index += 1) {
    boundaries.add(Math.max(fragment.from, matches[index].from - blockOffset));
    boundaries.add(Math.min(fragment.to, matches[index].to - blockOffset));
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  let tokenIndex = 0;
  let matchIndex = initialMatch;
  return ordered.slice(0, -1).map((from, index) => {
    const to = ordered[index + 1];
    while (tokenIndex < tokens.length && tokens[tokenIndex].to <= from) tokenIndex += 1;
    while (matchIndex < matches.length && matches[matchIndex].to <= blockOffset + from) matchIndex += 1;
    const token = tokens[tokenIndex];
    const matched = matches[matchIndex]?.from <= blockOffset + from;
    const text = model.text.slice(from, to);
    const content = matched ? <mark data-active={matchIndex === active ? "true" : undefined}>{text}</mark> : text;
    return (
      <span key={from} className={token?.from <= from ? tokenClasses(token.categories) : undefined}>
        {content}
      </span>
    );
  });
}

function Preview({ fixture, virtual }: { fixture: Fixture; virtual: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const virtualizer = useVirtualizer({
    count: fixture.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = fixture.rows[index];
      const model = fixture.models[row.block];
      const fragment = model.fragments[row.fragment];
      const text = model.text.slice(fragment.from, fragment.to);
      return Math.max(1, text.split("\n").length - Number(text.endsWith("\n"))) * ROW_HEIGHT;
    },
    overscan: OVERSCAN,
  });

  useLayoutEffect(() => {
    window.codePreviewPrototype.jump = (ordinal) => {
      const match = fixture.matches[ordinal];
      if (!match) throw new RangeError("Prototype match ordinal is out of bounds");
      const block = firstOverlap(fixture.blockBounds, match.from);
      const fragment = findCodePreviewFragment(fixture.models[block], match.from - fixture.offsets[block]);
      if (fragment === null) throw new Error("Prototype match has no fragment");
      const rowIndex = fixture.rowStarts[block] + fragment;
      setActive(ordinal);
      if (virtual) virtualizer.scrollToIndex(rowIndex, { align: "center" });
      else scrollRef.current?.querySelector(`[data-index="${rowIndex}"]`)?.scrollIntoView({ block: "center" });
      return { pending: false };
    };
    window.codePreviewPrototype.stats = () => ({
      preparationMs: fixture.preparationMs,
      indexingMs: fixture.indexingMs,
      sourceUnits: fixture.text.length,
      totalRows: fixture.rows.length,
      mountedRows: scrollRef.current?.querySelectorAll("[data-index]").length ?? 0,
      mountedSpans: scrollRef.current?.querySelectorAll("span").length ?? 0,
      matchCount: fixture.matches.length,
      active,
      activeMounted: Boolean(scrollRef.current?.querySelector('[data-active="true"]')),
      scrollTop: scrollRef.current?.scrollTop,
      oversizedLines: fixture.models.flatMap((model) => model.fragments).filter((fragment) => fragment.oversizedLine).length,
      mountedTextUnits: scrollRef.current?.textContent?.length ?? 0,
    });
  });

  const rows = virtual ? virtualizer.getVirtualItems() : fixture.rows.map((_, index) => ({ index, start: 0, key: index }));
  return (
    <div ref={scrollRef} data-prototype-scroll style={{ height: VIEWPORT_HEIGHT, overflow: "auto", overflowAnchor: "none" }}>
      <div style={virtual ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined}>
        {rows.map((item) => {
          const row = fixture.rows[item.index];
          return (
            <pre
              key={item.key}
              data-index={item.index}
              ref={virtual ? virtualizer.measureElement : undefined}
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontSize: 14,
                lineHeight: `${ROW_HEIGHT}px`,
                ...(virtual ? { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` } : {}),
              }}
            >
              <code>{fragmentContent(fixture.models[row.block], row.fragment, fixture.matches, active, fixture.offsets[row.block])}</code>
            </pre>
          );
        })}
      </div>
    </div>
  );
}

const rootElement = document.getElementById("prototype");
if (!rootElement) throw new Error("Prototype root is missing");
const root = createRoot(rootElement);
const palette = getDefaultTheme("light").components?.syntax;
if (!palette) throw new Error("Built-in light theme is missing its syntax palette");
for (const [role, color] of Object.entries(palette)) rootElement.style.setProperty(`--sambee-syntax-${role}`, color);
const style = document.createElement("style");
style.textContent = `${Object.entries(syntaxTokenStyles)
  .map(
    ([selector, properties]) =>
      `${selector}{${Object.entries(properties)
        .map(([name, value]) => `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
        .join(";")}}`
  )
  .join("\n")}
${Object.entries(syntaxTokenStyles)
  .map(
    ([selector, properties]) => `::highlight(preview-${selector.slice(".sambee-syntax-".length)}){color:${properties.color ?? "inherit"}}`
  )
  .join("\n")}
mark,::highlight(preview-search){background:#ffe082}mark[data-active="true"],::highlight(preview-active){background:#ff8a65}body{margin:16px}
@media print{[data-retained-text]{height:auto!important;overflow:visible!important}[data-retained-text] pre{content-visibility:visible!important}}`;
style.textContent += `
.document-proof{font-size:14px;line-height:20px;overflow-wrap:anywhere}
.document-proof pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:20px;contain:layout style}
.document-proof code:has(>.document-code-fragment){white-space:normal}
.document-code-fragment{display:inline-block;vertical-align:top;width:100%;white-space:pre-wrap;overflow-wrap:anywhere;contain:layout style}
.document-proof table{border-collapse:collapse;width:100%;table-layout:fixed}.document-proof th,.document-proof td{border:1px solid #999;padding:4px;vertical-align:top}
::highlight(document-search){background:#ffcc66;color:#171717}
@media print{[data-markdown-document]{height:auto!important;overflow:visible!important}}
${Object.entries(syntaxTokenStyles)
  .map(
    ([selector, properties]) => `::highlight(document-${selector.slice(".sambee-syntax-".length)}){color:${properties.color ?? "inherit"}}`
  )
  .join("\n")}`;
document.head.append(style);
let generation = 0;
let pendingLoad: { controller: AbortController; cancelPublication?: () => void } | null = null;
let disposeDocument: (() => void) | null = null;

function createFixture(
  models: CodePreviewModel[],
  matches: Match[] | null,
  metadata: Omit<Fixture, "models" | "matches" | "rows" | "offsets" | "rowStarts" | "blockBounds" | "text" | "refresh">
): Fixture {
  const offsets: number[] = [];
  const rowStarts: number[] = [];
  const blockBounds: Match[] = [];
  let offset = 0;
  let rowStart = 0;
  for (const model of models) {
    offsets.push(offset);
    rowStarts.push(rowStart);
    blockBounds.push({ from: offset, to: offset + model.text.length });
    offset += model.text.length;
    rowStart += model.fragments.length;
  }
  const text = models.map((model) => model.text).join("");
  if (matches === null) {
    matches = [];
    for (let from = text.indexOf("let x"); from !== -1; from = text.indexOf("let x", from + "let x".length))
      matches.push({ from, to: from + "let x".length });
  }
  return {
    ...metadata,
    models,
    matches,
    offsets,
    rowStarts,
    blockBounds,
    text,
    rows: models.flatMap((model, block) => model.fragments.map((_, fragment) => ({ block, fragment }))),
  };
}

window.codePreviewPrototype = {
  async searchDocument() {
    throw new Error("Load a Markdown document before searching");
  },
  async jumpDocument() {
    throw new Error("Load and search a Markdown document before navigating");
  },
  async loadDocument(source) {
    pendingLoad?.controller.abort();
    pendingLoad?.cancelPublication?.();
    disposeDocument?.();
    const request = { controller: new AbortController() };
    pendingLoad = request;
    const current = ++generation;
    window.codePreviewPrototype.stats = () => ({ complete: false, error: null, batches: 0, generation: current });
    try {
      if (
        typeof Highlight === "undefined" ||
        !CSS.highlights ||
        typeof IntersectionObserver === "undefined" ||
        typeof ResizeObserver === "undefined"
      ) {
        throw new Error("Whole-Markdown preview requires CSS Highlights, IntersectionObserver and ResizeObserver; no fallback was used");
      }
      const view = await mountMarkdownDocument(root, request.controller.signal, source);
      request.controller.signal.throwIfAborted();
      disposeDocument = view.dispose;
      window.codePreviewPrototype.stats = () => ({ ...view.stats(), generation: current });
      window.codePreviewPrototype.inspect = () => ({ models: [], matches: [] });
      window.codePreviewPrototype.searchDocument = view.search;
      window.codePreviewPrototype.jumpDocument = view.jump;
      window.codePreviewPrototype.jump = () => {
        throw new Error("Whole-Markdown navigation is asynchronous; use jumpDocument");
      };
      const result = await prepareCodePreviewInWorker(
        [source],
        current,
        request.controller.signal,
        (diagnostic) => logError(diagnostic.message, diagnostic.context, diagnostic.component),
        view.consume
      );
      request.controller.signal.throwIfAborted();
      view.finish(result.preparationMs, result.syntaxRanges, createDocumentSyntaxSession(current));
    } catch (error) {
      if (current === generation) {
        const stats = window.codePreviewPrototype.stats();
        window.codePreviewPrototype.stats = () => ({
          ...stats,
          complete: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (pendingLoad === request) pendingLoad = null;
    }
  },
  async baselineDocument(source) {
    pendingLoad?.controller.abort();
    pendingLoad?.cancelPublication?.();
    disposeDocument?.();
    disposeDocument = null;
    pendingLoad = null;
    generation += 1;
    await renderMarkdownDocumentBaseline(root, source);
  },
  shutdownDocument() {
    pendingLoad?.controller.abort();
    pendingLoad?.cancelPublication?.();
    pendingLoad = null;
    generation += 1;
    disposeDocument?.();
    disposeDocument = null;
    shutdownCodePreviewWorker();
    window.codePreviewPrototype.stats = () => ({ complete: false, error: null, disposed: true, generation });
  },
  inspect() {
    throw new Error("Load a fixture before inspecting prepared data");
  },
  async load(blocks, virtual) {
    disposeDocument?.();
    disposeDocument = null;
    pendingLoad?.controller.abort();
    pendingLoad?.cancelPublication?.();
    const request: NonNullable<typeof pendingLoad> = { controller: new AbortController() };
    pendingLoad = request;
    const current = ++generation;
    const prepareStart = performance.now();
    const progressive = virtual === "retained-text-worker-progressive";
    let earlyFixture: Fixture | null = null;
    let publication: Promise<void> | null = null;
    const render = (fixture: Fixture) =>
      new Promise<void>((resolve, reject) => {
        request.cancelPublication = () => reject(new DOMException("Prototype publication superseded", "AbortError"));
        root.render(<Commit key={current} fixture={fixture} virtual={virtual} onCommit={resolve} />);
      });
    try {
      if (progressive) {
        const sourceIndexStart = performance.now();
        let sourceIndexingYields = 0;
        const yieldSourceIndexing = async () => {
          sourceIndexingYields += 1;
          await yieldHighlightingTask(request.controller.signal);
        };
        const plainModels: CodePreviewModel[] = [];
        let batchUnits = 0;
        let batchBlocks = 0;
        for (const text of blocks) {
          plainModels.push(
            await createCodePreviewModelAsync(text, [], {
              signal: request.controller.signal,
              yieldTask: yieldSourceIndexing,
            })
          );
          batchUnits += text.length;
          batchBlocks += 1;
          if (
            plainModels.length < blocks.length &&
            (batchUnits >= CODE_PREVIEW_SCAN_MAX_UNITS || batchBlocks >= SOURCE_INDEX_BLOCK_BATCH)
          ) {
            await yieldSourceIndexing();
            batchUnits = 0;
            batchBlocks = 0;
          }
        }
        request.controller.signal.throwIfAborted();
        earlyFixture = createFixture(plainModels, [], {
          sourceIndexingYields,
          sourceIndexingMs: 0,
          preparationComplete: false,
          preparationError: null,
          sourceChunks: 0,
          largestSourceChunkUnits: 0,
          sourceUnitsSent: 0,
          execution: "worker",
          transferChunks: 0,
          largestChunkItems: 0,
          clientAssemblyMs: 0,
          preparationWallMs: 0,
          generation: current,
          loadStartedAt: prepareStart,
          preparationMs: 0,
          indexingMs: 0,
        });
        earlyFixture.sourceIndexingMs = performance.now() - sourceIndexStart;
        publication = render(earlyFixture);
        void publication.catch(() => undefined);
      }
      const workerPrepared =
        virtual === "retained-text-worker" || progressive
          ? await prepareCodePreviewInWorker(blocks, current, request.controller.signal, (diagnostic) => {
              const failure = diagnostic.error ? new Error(diagnostic.error.message) : undefined;
              if (failure && diagnostic.error) failure.name = diagnostic.error.name;
              logError(diagnostic.message, diagnostic.context, diagnostic.component, failure);
            })
          : null;
      const prepared = workerPrepared
        ? null
        : await highlightingService.prepare(
            blocks.map((text) => ({ text, label: "javascript" })),
            request.controller.signal
          );
      if (current !== generation) throw new DOMException("Prototype load superseded", "AbortError");
      const preparationWallMs = performance.now() - prepareStart;
      const preparationMs = workerPrepared?.preparationMs ?? preparationWallMs;
      const indexStart = performance.now();
      const models =
        workerPrepared?.models ??
        blocks.map((text, index) => {
          const result = prepared![index];
          if (!("ranges" in result)) throw new Error(`Prototype preparation failed: ${result.reason}`);
          return createCodePreviewModel(text, result.ranges);
        });
      const fixture = createFixture(models, workerPrepared?.matches ?? null, {
        sourceIndexingYields: earlyFixture?.sourceIndexingYields ?? 0,
        sourceIndexingMs: earlyFixture?.sourceIndexingMs ?? 0,
        preparationComplete: true,
        preparationError: null,
        sourceChunks: workerPrepared?.sourceChunks ?? 0,
        largestSourceChunkUnits: workerPrepared?.largestSourceChunkUnits ?? 0,
        sourceUnitsSent: workerPrepared?.sourceUnitsSent ?? 0,
        execution: workerPrepared ? "worker" : "main-thread",
        transferChunks: workerPrepared?.chunks ?? 0,
        largestChunkItems: workerPrepared?.largestChunkItems ?? 0,
        clientAssemblyMs: workerPrepared?.clientAssemblyMs ?? 0,
        preparationWallMs,
        generation: current,
        loadStartedAt: prepareStart,
        preparationMs,
        indexingMs: workerPrepared?.indexingMs ?? 0,
      });
      fixture.indexingMs += performance.now() - indexStart;
      if (earlyFixture) {
        Object.assign(earlyFixture, fixture);
        earlyFixture.refresh?.();
        await publication;
      } else await render(fixture);
    } catch (error) {
      if (earlyFixture && current === generation) {
        earlyFixture.preparationError = error instanceof Error ? error.message : "Prototype preparation failed";
        earlyFixture.refresh?.();
        await publication;
      }
      throw error;
    } finally {
      if (pendingLoad === request) pendingLoad = null;
    }
  },
  jump() {
    throw new Error("Load a fixture before navigating");
  },
  stats() {
    throw new Error("Load a fixture before reading metrics");
  },
};

function Commit({
  fixture,
  virtual,
  onCommit,
}: {
  fixture: Fixture;
  virtual: boolean | "retained-text" | "retained-text-worker" | "retained-text-worker-progressive";
  onCommit: () => void;
}) {
  useLayoutEffect(() => {
    window.codePreviewPrototype.inspect = () => ({ models: fixture.models, matches: fixture.matches });
    if (typeof virtual !== "string") onCommit();
  }, [fixture, virtual, onCommit]);
  return typeof virtual === "string" ? (
    <RetainedTextPreview fixture={fixture} onCommit={onCommit} />
  ) : (
    <Preview fixture={fixture} virtual={virtual} />
  );
}
