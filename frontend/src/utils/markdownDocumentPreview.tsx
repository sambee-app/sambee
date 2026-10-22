import { useLayoutEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  normalizeMarkdownTableCellLineBreaks,
  remarkRenderMarkdownTableCellLineBreaks,
} from "../components/Viewer/markdownTableCellLineBreaks";
import { yieldHighlightingTask } from "./codeMirrorHighlighting";
import {
  DOCUMENT_PUBLICATION_BATCH_ITEMS,
  DOCUMENT_PUBLICATION_BATCH_UNITS,
  DOCUMENT_RECORD_BATCH_ITEMS,
  DOCUMENT_SYNTAX_CACHE_RANGES,
  DOCUMENT_SYNTAX_WINDOW_PARTS,
  type DocumentSyntaxWindow,
  type MarkdownDocumentRecord,
} from "./markdownDocumentPreviewModel";
import { DocumentSearchIndexer, type DocumentSearchOptions } from "./markdownDocumentSearch";
import { createDocumentSearchSession, type DocumentMatch, type DocumentSearchResult } from "./markdownDocumentSearchWorker";
import { visibleSyntaxColumnWindows } from "./markdownSyntaxPublication";
import { type SyntaxRange, TOKEN_CATEGORIES } from "./syntaxHighlighting";

const MAX_DECORATION_RANGES = 4_000;
const PUBLICATION_BATCHES_PER_FRAME = 8;
const PUBLICATION_ASSEMBLY_BUDGET_MS = 4;
const ALLOWED_TAGS = new Set(
  "a blockquote br code del div em h1 h2 h3 h4 h5 h6 hr img input li ol p pre section span strong sup table tbody td th thead tr ul".split(
    " "
  )
);

interface DocumentSyntaxSession {
  dispose(): void;
  page(
    window: DocumentSyntaxWindow,
    offset: number
  ): Promise<{
    records: Extract<MarkdownDocumentRecord, { kind: "syntax" }>[];
    next: number | null;
  }>;
}

interface DocumentView {
  search: (query: string, options?: DocumentSearchOptions) => Promise<DocumentSearchResult>;
  jump: (ordinal: number) => Promise<{ pending: boolean }>;
  consume: (records: readonly MarkdownDocumentRecord[]) => Promise<void>;
  finish: (workerPipelineWallMs: number, syntaxRanges: number, session: DocumentSyntaxSession) => void;
  dispose: () => void;
  stats: () => Record<string, unknown>;
}

async function yieldDocumentPublication(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (document.hidden) return yieldHighlightingTask(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", visibility);
    };
    const complete = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const visibility = () => {
      if (document.hidden) complete();
    };
    const frame = requestAnimationFrame(complete);
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", visibility);
  });
}

function DocumentHost({ ready }: { ready: (element: HTMLDivElement) => (() => void) | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? ready(ref.current) : undefined), [ready]);
  return <div ref={ref} data-markdown-document className="document-proof" style={{ height: 480, overflow: "auto" }} />;
}

export function mountMarkdownDocument(
  root: Root | HTMLDivElement,
  signal: AbortSignal,
  source: string,
  options: {
    hostSearch?: boolean;
    viewport?: HTMLElement;
    highlightPrefix?: string;
    configureLink?: (anchor: HTMLAnchorElement, href: string) => void;
  } = {}
): Promise<DocumentView> {
  signal.throwIfAborted();
  const highlightPrefix = options.highlightPrefix ?? "document";
  const searchSession = createDocumentSearchSession(source);
  return new Promise((resolve, reject) => {
    const abort = () => {
      searchSession.dispose();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const ready = (container: HTMLDivElement) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const started = performance.now();
      let assemblyMs = 0;
      let largestAssemblyMs = 0;
      let frameWaitMs = 0;
      let viewportPaintMs = 0;
      let largestViewportPaintMs = 0;
      let publicationRecords = 0;
      let largestBatchUnits = 0;
      let batchesSinceYield = 0;
      let assemblySinceYieldMs = 0;
      const elements = new Map<number, HTMLElement>([[0, container]]);
      const fragmentCodes = new Map<number, number>();
      const parts = new Map<number, { node: Text; from: number; to: number }[]>();
      const tokens = new Map<number, SyntaxRange[]>();
      const attributes = new Map<string, string>();
      const searchIndexer = new DocumentSearchIndexer();
      const searchNodes: { node: Text; from: number; to: number }[] = [];
      let searchController: AbortController | null = null;
      let searchQuery = "";
      let searchOptions: DocumentSearchOptions = {};
      let searchResult: DocumentSearchResult | null = null;
      let searchRevision = 0;
      let activeMatch: (DocumentMatch & { ordinal: number; pending: boolean }) | null = null;
      const reveal = () => {
        if (!activeMatch?.pending || disposed) return;
        const locate = (offset: number) => {
          let low = 0;
          let high = searchNodes.length;
          while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (searchNodes[middle].to < offset) low = middle + 1;
            else high = middle;
          }
          return searchNodes[low];
        };
        const start = locate(activeMatch.from);
        const end = locate(activeMatch.to);
        if (!start || !end) return;
        const range = new Range();
        range.setStart(start.node, Math.max(0, Math.min(start.node.length, activeMatch.from - start.from)));
        range.setEnd(end.node, Math.max(0, Math.min(end.node.length, activeMatch.to - end.from)));
        CSS.highlights.set(`${highlightPrefix}-search`, new Highlight(range));
        activeMatch.pending = false;
        const rect = range.getBoundingClientRect();
        const viewport = (options.viewport ?? container).getBoundingClientRect();
        (options.viewport ?? container).scrollTop += rect.top - viewport.top - (options.viewport ?? container).clientHeight / 2;
      };
      const visible = new Set<number>();
      let frame: number | null = null;
      let disposed = false;
      let batches = 0;
      let largestBatch = 0;
      let firstContentMs: number | null = null;
      let complete = false;
      let workerPipelineWallMs = 0;
      let highlightRanges = 0;
      let decorationLimited = false;
      let mountedSpans = 0;
      let textUnits = 0;
      let syntaxSession: DocumentSyntaxSession | null = null;
      let workerSyntaxRanges = 0;
      let cachedSyntaxRanges = 0;
      let peakCachedSyntaxRanges = 0;
      let syntaxPages = 0;
      let largestSyntaxPage = 0;
      let syntaxError: string | null = null;
      let syntaxFetching = false;
      let syntaxWindowLimited = false;
      let geometryProbes = 0;
      let desiredWindows: DocumentSyntaxWindow[] = [];
      let desiredKey = "";
      let appliedKey = "";
      let syntaxRevision = 0;
      let decorationKey = "";
      const fetchWindow = () => {
        if (!syntaxSession || syntaxFetching || disposed || desiredKey === appliedKey || syntaxError) return;
        syntaxFetching = true;
        void (async () => {
          while (!disposed && desiredKey !== appliedKey) {
            const key = desiredKey;
            const windows = desiredWindows;
            tokens.clear();
            syntaxRevision += 1;
            cachedSyntaxRanges = 0;
            syntaxWindowLimited = false;
            for (const window of windows) {
              let offset: number | null = 0;
              do {
                const page = await syntaxSession!.page(window, offset);
                if (disposed || key !== desiredKey) break;
                syntaxPages += 1;
                largestSyntaxPage = Math.max(largestSyntaxPage, page.records.length);
                const collection = tokens.get(window.id) ?? [];
                for (const record of page.records) {
                  const last = collection.at(-1);
                  if (last?.from === record.range.from && last.to === record.range.to) continue;
                  if (cachedSyntaxRanges === DOCUMENT_SYNTAX_CACHE_RANGES) {
                    syntaxWindowLimited = true;
                    break;
                  }
                  collection.push(record.range);
                  cachedSyntaxRanges += 1;
                }
                tokens.set(window.id, collection);
                syntaxRevision += 1;
                peakCachedSyntaxRanges = Math.max(peakCachedSyntaxRanges, cachedSyntaxRanges);
                offset = page.next;
                schedule();
                if (cachedSyntaxRanges === DOCUMENT_SYNTAX_CACHE_RANGES) {
                  syntaxWindowLimited = true;
                  break;
                }
              } while (offset !== null);
              if (disposed || key !== desiredKey || syntaxWindowLimited) break;
            }
            if (key === desiredKey) appliedKey = key;
          }
        })()
          .catch((error: unknown) => {
            if (!disposed) {
              syntaxError = error instanceof Error ? error.message : String(error);
              tokens.clear();
              syntaxRevision += 1;
              cachedSyntaxRanges = 0;
              schedule();
            }
          })
          .finally(() => {
            syntaxFetching = false;
          });
      };
      const fallbacks: { id: number; reason: string }[] = [];
      const paintViewport = () => {
        frame = null;
        if (disposed || signal.aborted) return;
        if (visible.size === 0 && highlightRanges === 0 && desiredWindows.length === 0) return;
        const categories = new Map<string, Range[]>();
        const viewport = (options.viewport ?? container).getBoundingClientRect();
        const viewportParts = new Map<number, { node: Text; from: number; to: number }[]>();
        const windows: DocumentSyntaxWindow[] = [];
        geometryProbes = 0;
        let inspectedFragments = 0;
        for (const id of visible) {
          if (inspectedFragments++ === DOCUMENT_SYNTAX_WINDOW_PARTS || windows.length === DOCUMENT_SYNTAX_WINDOW_PARTS) break;
          const collection = parts.get(id) ?? [];
          const rectFor = (index: number) => {
            geometryProbes += 1;
            const range = new Range();
            range.selectNodeContents(collection[index].node);
            return range.getBoundingClientRect();
          };
          let low = 0;
          let high = collection.length;
          while (low < high) {
            const middle = low + Math.floor((high - low) / 2);
            if (rectFor(middle).bottom < viewport.top - (options.viewport ?? container).clientHeight) low = middle + 1;
            else high = middle;
          }
          const selected = [];
          for (let index = low; index < collection.length && windows.length < DOCUMENT_SYNTAX_WINDOW_PARTS; index += 1) {
            if (rectFor(index).top > viewport.bottom + (options.viewport ?? container).clientHeight) break;
            const part = collection[index];
            const pre = part.node.parentElement?.closest("pre") ?? null;
            const rangeAt = (from: number, to: number) => {
              const range = new Range();
              range.setStart(part.node, from);
              range.setEnd(part.node, to);
              return range;
            };
            const clipped = visibleSyntaxColumnWindows(part.node.data, rangeAt, viewport, 0, part.node.length, pre);
            selected.push(part);
            for (const window of clipped) {
              if (window.to <= window.from || windows.length === DOCUMENT_SYNTAX_WINDOW_PARTS) continue;
              windows.push({ id: fragmentCodes.get(id)!, from: part.from + window.from, to: part.from + window.to });
            }
          }
          viewportParts.set(id, selected);
        }
        windows.sort((left, right) => left.id - right.id || left.from - right.from);
        const key = JSON.stringify(windows);
        if (key !== desiredKey) {
          desiredWindows = windows;
          desiredKey = key;
          tokens.clear();
          syntaxRevision += 1;
          cachedSyntaxRanges = 0;
        }
        fetchWindow();
        const nextDecorationKey = `${key}:${syntaxRevision}`;
        if (nextDecorationKey === decorationKey) return;
        decorationKey = nextDecorationKey;
        highlightRanges = 0;
        decorationLimited = false;
        for (const [id, selected] of viewportParts) {
          const ranges = tokens.get(fragmentCodes.get(id)!) ?? [];
          for (const part of selected) {
            let low = 0;
            let high = ranges.length;
            while (low < high) {
              const middle = low + Math.floor((high - low) / 2);
              if (ranges[middle].to <= part.from) low = middle + 1;
              else high = middle;
            }
            for (let index = low; index < ranges.length && ranges[index].from < part.to; index += 1) {
              const token = ranges[index];
              for (const category of token.categories) {
                if (highlightRanges === MAX_DECORATION_RANGES) {
                  decorationLimited = true;
                  break;
                }
                const range = new Range();
                range.setStart(part.node, Math.max(part.from, token.from) - part.from);
                range.setEnd(part.node, Math.min(part.to, token.to) - part.from);
                const collection = categories.get(category) ?? [];
                collection.push(range);
                categories.set(category, collection);
                highlightRanges += 1;
              }
              if (decorationLimited) break;
            }
            if (decorationLimited) break;
          }
          if (decorationLimited) break;
        }
        for (const category of TOKEN_CATEGORIES)
          CSS.highlights.set(`${highlightPrefix}-${category}`, new Highlight(...(categories.get(category) ?? [])));
      };
      const paint = () => {
        const start = performance.now();
        try {
          paintViewport();
        } finally {
          const end = performance.now();
          viewportPaintMs += end - start;
          largestViewportPaintMs = Math.max(largestViewportPaintMs, end - start);
          const name = "sambee:preview-preparation:retained-viewport-paint";
          performance.clearMeasures(name);
          performance.measure(name, { start, end });
        }
      };
      const schedule = () => {
        if (!disposed && frame === null) frame = requestAnimationFrame(paint);
      };
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = Number((entry.target as HTMLElement).dataset.documentFragment);
            if (entry.isIntersecting) visible.add(id);
            else visible.delete(id);
          }
          schedule();
        },
        { root: options.viewport ?? container, rootMargin: "480px 0px" }
      );
      const resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(options.viewport ?? container);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        signal.removeEventListener("abort", dispose);
        searchRevision += 1;
        searchController?.abort();
        searchSession.dispose();
        syntaxSession?.dispose();
        syntaxSession = null;
        searchNodes.length = 0;
        searchResult = null;
        activeMatch = null;
        CSS.highlights.delete(`${highlightPrefix}-search`);
        observer.disconnect();
        resizeObserver.disconnect();
        container.removeEventListener("scroll", schedule);
        container.removeEventListener("scroll", schedule, true);
        options.viewport?.removeEventListener("scroll", schedule);
        container.removeEventListener("load", schedule, true);
        document.fonts.removeEventListener("loadingdone", schedule);
        if (frame !== null) cancelAnimationFrame(frame);
        for (const category of TOKEN_CATEGORIES) CSS.highlights.delete(`${highlightPrefix}-${category}`);
        elements.clear();
        parts.clear();
        tokens.clear();
        attributes.clear();
        visible.clear();
        fragmentCodes.clear();
        fallbacks.length = 0;
        desiredWindows = [];
        container.replaceChildren();
      };
      container.addEventListener("scroll", schedule, { passive: true });
      container.addEventListener("scroll", schedule, true);
      options.viewport?.addEventListener("scroll", schedule, { passive: true });
      container.addEventListener("load", schedule, true);
      document.fonts.addEventListener("loadingdone", schedule);
      signal.addEventListener("abort", dispose, { once: true });
      resolve({
        async search(query, options = {}) {
          if (disposed) throw new DOMException("Document preview disposed", "AbortError");
          searchController?.abort();
          searchController = new AbortController();
          const revision = ++searchRevision;
          searchQuery = query;
          searchOptions = { ...options };
          searchResult = null;
          activeMatch = null;
          CSS.highlights.delete(`${highlightPrefix}-search`);
          const result = await searchSession.search(query, searchOptions, searchController.signal);
          if (revision !== searchRevision || disposed) throw new DOMException("Document search superseded", "AbortError");
          searchResult = result;
          if (result.matches[0]) {
            activeMatch = { ...result.matches[0], ordinal: 0, pending: true };
            reveal();
          }
          return result;
        },
        async jump(ordinal) {
          if (disposed) throw new DOMException("Document preview disposed", "AbortError");
          if (!searchResult) throw new Error("Document search results are pending or unavailable");
          if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= searchResult.count)
            throw new Error("Document match ordinal is out of range");
          searchController?.abort();
          searchController = new AbortController();
          const revision = ++searchRevision;
          let result = searchResult;
          if (ordinal < result.offset || ordinal >= result.offset + result.matches.length)
            result = await searchSession.search(searchQuery, searchOptions, searchController.signal, ordinal);
          if (revision !== searchRevision || disposed) throw new DOMException("Document navigation superseded", "AbortError");
          searchResult = result;
          const match = result.matches[ordinal - result.offset];
          if (!match) throw new Error("Document search returned no requested match");
          activeMatch = { ...match, ordinal, pending: true };
          reveal();
          return { pending: activeMatch.pending };
        },
        async consume(records) {
          const assemblyStart = performance.now();
          signal.throwIfAborted();
          if (disposed) throw new DOMException("Document preview disposed", "AbortError");
          const additions = new Map<HTMLElement, DocumentFragment>();
          const append = (parent: HTMLElement, node: Node) => {
            let fragment = additions.get(parent);
            if (!fragment) {
              fragment = document.createDocumentFragment();
              additions.set(parent, fragment);
            }
            fragment.append(node);
          };
          for (const record of records) {
            const searchSegment = options.hostSearch ? null : searchIndexer.append(record);
            if (record.kind === "element") {
              if (!ALLOWED_TAGS.has(record.tag) || !elements.has(record.parent) || elements.has(record.id))
                throw new Error("Invalid Markdown element record");
              const element = document.createElement(record.tag);
              if (record.tag === "span") mountedSpans += 1;
              if (record.fragment) {
                element.dataset.documentFragment = String(record.id);
                element.className = "document-code-fragment";
                fragmentCodes.set(record.id, record.parent);
                observer.observe(element);
              }
              append(elements.get(record.parent)!, element);
              elements.set(record.id, element);
            } else if (record.kind === "text") {
              const parent = elements.get(record.parent);
              if (!parent) throw new Error("Markdown text has no parent");
              const node = document.createTextNode(record.value);
              textUnits += record.value.length;
              append(parent, node);
              if (searchSegment) searchNodes.push({ node, from: searchSegment.from, to: searchSegment.to });
              if (fragmentCodes.has(record.parent)) {
                const collection = parts.get(record.parent) ?? [];
                collection.push({ node, from: record.from, to: record.from + record.value.length });
                parts.set(record.parent, collection);
              }
            } else if (record.kind === "attribute") {
              if (/^on/i.test(record.name) || record.name === "style") throw new Error("Unsafe Markdown attribute");
              const key = `${record.id}:${record.name}`;
              const value = (attributes.get(key) ?? "") + record.value;
              if (!record.final) attributes.set(key, value);
              else {
                attributes.delete(key);
                const element = elements.get(record.id);
                if (!element) throw new Error("Markdown attribute has no element");
                const name =
                  record.name === "className"
                    ? "class"
                    : record.name.startsWith("aria")
                      ? `aria-${record.name.slice(4).toLowerCase()}`
                      : record.name.startsWith("data")
                        ? record.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
                        : record.name.toLowerCase();
                element.setAttribute(name, name === "href" || name === "src" ? defaultUrlTransform(value) : value);
                if (name === "href" && element instanceof HTMLAnchorElement) options.configureLink?.(element, value);
                if (name === "align" && ["left", "center", "right"].includes(value)) element.style.textAlign = value;
              }
            } else if (record.kind === "syntax") {
              throw new Error("Full-document syntax records are not accepted by the viewport renderer");
            } else fallbacks.push(record);
          }
          for (const [parent, fragment] of [...additions].reverse()) parent.append(fragment);
          batches += 1;
          largestBatch = Math.max(largestBatch, records.length);
          largestBatchUnits = Math.max(
            largestBatchUnits,
            records.reduce((units, record) => units + (record.kind === "text" || record.kind === "attribute" ? record.value.length : 0), 0)
          );
          if (textUnits > 0) firstContentMs ??= performance.now() - started;
          schedule();
          reveal();
          const assemblyDuration = performance.now() - assemblyStart;
          assemblyMs += assemblyDuration;
          largestAssemblyMs = Math.max(largestAssemblyMs, assemblyDuration);
          publicationRecords += records.length;
          batchesSinceYield += 1;
          assemblySinceYieldMs += assemblyDuration;
          if (batchesSinceYield >= PUBLICATION_BATCHES_PER_FRAME || assemblySinceYieldMs >= PUBLICATION_ASSEMBLY_BUDGET_MS) {
            const waitStart = performance.now();
            await yieldDocumentPublication(signal);
            frameWaitMs += performance.now() - waitStart;
            batchesSinceYield = 0;
            assemblySinceYieldMs = 0;
          }
        },
        finish(wallMs, syntaxRanges, session) {
          if (!options.hostSearch) searchIndexer.finish();
          syntaxSession = session;
          workerSyntaxRanges = syntaxRanges;
          workerPipelineWallMs = wallMs;
          complete = true;
          schedule();
        },
        dispose,
        stats: () => ({
          complete,
          assemblyMs,
          largestAssemblyMs,
          frameWaitMs,
          viewportPaintMs,
          largestViewportPaintMs,
          publicationRecords,
          error: null,
          batches,
          largestBatch,
          batchLimit: DOCUMENT_PUBLICATION_BATCH_ITEMS,
          largestBatchUnits,
          batchUnitLimit: DOCUMENT_PUBLICATION_BATCH_UNITS,
          syntaxPageLimit: DOCUMENT_RECORD_BATCH_ITEMS,
          firstContentMs,
          workerPipelineWallMs,
          highlightRanges,
          decorationLimited,
          cachedSyntaxRanges,
          peakCachedSyntaxRanges,
          syntaxCacheLimit: DOCUMENT_SYNTAX_CACHE_RANGES,
          syntaxPages,
          largestSyntaxPage,
          syntaxFetching,
          syntaxWindowLimited,
          syntaxError,
          workerSyntaxRanges,
          geometryProbes,
          fallbacks,
          mountedElements: elements.size - 1,
          mountedSpans,
          textUnits,
          search: searchSession.stats(),
          activeMatch: activeMatch ? { ...activeMatch } : null,
        }),
      });
      return dispose;
    };
    if (root instanceof HTMLDivElement) ready(root);
    else root.render(<DocumentHost ready={ready} />);
  });
}

export function renderMarkdownDocumentBaseline(root: Root, source: string): Promise<void> {
  return new Promise((resolve) =>
    root.render(
      <div
        className="document-proof"
        data-markdown-baseline
        style={{ height: 480, overflow: "auto" }}
        ref={(element) => {
          if (element) resolve();
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkRenderMarkdownTableCellLineBreaks]}>
          {normalizeMarkdownTableCellLineBreaks(source)}
        </ReactMarkdown>
      </div>
    )
  );
}
