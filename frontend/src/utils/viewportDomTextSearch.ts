import { createDomTextIndex, findLogicalMatches, type IndexedDomText, type LogicalMatch } from "./domTextSearch";

export const MAX_VIEWPORT_SEARCH_RANGES = 1_000;
const SEGMENTS_PER_FRAME = 32;
const SEARCH_MEASURE_PREFIX = "sambee:preview-search:";
let sessionId = 0;

function measure<Result>(stage: string, operation: () => Result): Result {
  const start = performance.now();
  try {
    return operation();
  } finally {
    const name = `${SEARCH_MEASURE_PREFIX}${stage}`;
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start, end: performance.now() });
  }
}

export function createViewportDomTextSearch(root: HTMLElement, viewport: HTMLElement, onInvalidated: () => void) {
  const prefix = `markdown-search-${++sessionId}`;
  const otherName = `${prefix}-other`;
  const currentName = `${prefix}-current`;
  const registry = globalThis.CSS?.highlights;
  const HighlightType = globalThis.Highlight;
  const supported = typeof HighlightType !== "undefined" && !!registry && typeof IntersectionObserver !== "undefined";
  const style = document.createElement("style");
  style.textContent = `::highlight(${otherName}) { background-color: var(--sambee-search-other); color: var(--sambee-search-foreground); }
::highlight(${currentName}) { background-color: var(--sambee-search-current); color: var(--sambee-search-foreground); }`;
  if (supported) document.head.append(style);
  let indexed: IndexedDomText | null = null;
  let indexedRevision = 0;
  let matches: LogicalMatch[] = [];
  let current = 0;
  let frame: number | null = null;
  let disposed = false;
  let nextSegment = 0;
  let pendingSegments: number[] = [];
  const segmentIndices = new Map<Element, number[]>();
  const visibleSegments = new Set<number>();
  let ranges: Range[] = [];

  const locate = (offset: number) => {
    const segments = indexed!.segments;
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (segments[middle].end <= offset) low = middle + 1;
      else high = middle;
    }
    return segments[low];
  };
  const rangeAt = (from: number, to: number) => {
    const first = locate(from);
    const last = locate(Math.max(from, to - 1));
    if (!first || !last) return null;
    const range = document.createRange();
    range.setStart(first.node, Math.min(first.node.length, Math.max(0, from - first.start)));
    range.setEnd(last.node, Math.min(last.node.length, Math.max(0, to - last.start)));
    return range;
  };
  const firstMatchAt = (offset: number) => {
    let low = 0;
    let high = matches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (matches[middle].end <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const paint = () => {
    frame = null;
    if (disposed || !supported || !indexed) return;
    measure("presentation", () => {
      const bounds = viewport.getBoundingClientRect();
      const limit = Math.min(pendingSegments.length, nextSegment + SEGMENTS_PER_FRAME);
      for (; nextSegment < limit && ranges.length < MAX_VIEWPORT_SEARCH_RANGES; nextSegment += 1) {
        const segment = indexed!.segments[pendingSegments[nextSegment]];
        const parent = segment.node.parentElement;
        if (!parent) continue;
        const box = parent.getBoundingClientRect();
        if (box.bottom < bounds.top || box.top > bounds.bottom) continue;
        const offsetAt = (top: number) => {
          let low = segment.start;
          let high = segment.end;
          while (low < high) {
            const middle = (low + high) >>> 1;
            const range = rangeAt(middle, middle + 1)!;
            if (range.getBoundingClientRect().bottom < top) low = middle + 1;
            else high = middle;
          }
          return low;
        };
        const from = box.top >= bounds.top ? segment.start : offsetAt(bounds.top);
        const to = box.bottom <= bounds.bottom ? segment.end : Math.min(segment.end, offsetAt(bounds.bottom) + 1);
        const pre = parent.closest("pre");
        const horizontal =
          pre &&
          pre.scrollWidth > pre.clientWidth &&
          getComputedStyle(pre).whiteSpace === "pre" &&
          getComputedStyle(pre).direction !== "rtl";
        const clip = horizontal ? pre.getBoundingClientRect() : bounds;
        if (horizontal && (clip.right < bounds.left || clip.left > bounds.right)) continue;
        let lineStart = from;
        while (lineStart < to && ranges.length < MAX_VIEWPORT_SEARCH_RANGES) {
          const newline = horizontal ? segment.node.data.indexOf("\n", lineStart - segment.start) : -1;
          const lineEnd = newline < 0 ? to : Math.min(to, segment.start + newline + 1);
          const columnAt = (edge: number, start = lineStart) => {
            let low = start;
            let high = lineEnd;
            if (low < high && rangeAt(low, low + 1)!.getBoundingClientRect().right >= edge) return low;
            while (low < high) {
              const middle = (low + high) >>> 1;
              if (rangeAt(middle, middle + 1)!.getBoundingClientRect().right < edge) low = middle + 1;
              else high = middle;
            }
            return low;
          };
          const visibleFrom = horizontal ? columnAt(Math.max(bounds.left, clip.left)) : lineStart;
          const visibleTo = horizontal ? Math.min(lineEnd, columnAt(Math.min(bounds.right, clip.right), visibleFrom) + 1) : lineEnd;
          for (let index = firstMatchAt(visibleFrom); index < matches.length && ranges.length < MAX_VIEWPORT_SEARCH_RANGES; index += 1) {
            const match = matches[index];
            if (match.start >= visibleTo) break;
            const range = rangeAt(Math.max(visibleFrom, match.start), Math.min(visibleTo, match.end));
            if (range) ranges.push(range);
          }
          lineStart = lineEnd;
        }
      }
      registry.set(otherName, new HighlightType(...ranges));
      if (nextSegment < pendingSegments.length && ranges.length < MAX_VIEWPORT_SEARCH_RANGES) frame = requestAnimationFrame(paint);
    });
  };
  const refresh = () => {
    if (disposed) return;
    ranges = [];
    pendingSegments = [...visibleSegments].sort((left, right) => left - right);
    nextSegment = 0;
    if (supported) {
      if (!matches.length) {
        registry.delete(otherName);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      } else if (frame === null) frame = requestAnimationFrame(paint);
    }
  };
  const intersections = supported
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            for (const index of segmentIndices.get(entry.target) ?? []) {
              if (entry.isIntersecting) visibleSegments.add(index);
              else visibleSegments.delete(index);
            }
          }
          refresh();
        },
        { root: viewport }
      )
    : null;
  const resetVisibility = () => {
    intersections?.disconnect();
    segmentIndices.clear();
    visibleSegments.clear();
  };
  const observeSegments = () => {
    resetVisibility();
    if (!supported || !indexed) return;
    indexed.segments.forEach((segment, index) => {
      const parent = segment.node.parentElement;
      if (!parent) return;
      const indices = segmentIndices.get(parent) ?? [];
      indices.push(index);
      segmentIndices.set(parent, indices);
    });
    for (const parent of segmentIndices.keys()) intersections?.observe(parent);
  };
  const activate = (match: number, scroll = true) => {
    if (disposed || current === match) return;
    current = match;
    if (supported) registry.delete(currentName);
    const logical = matches[current - 1];
    if (!logical || !indexed) return;
    const range = measure("navigation-lookup", () => rangeAt(logical.start, logical.end));
    if (!range) return;
    if (supported) {
      measure("navigation-publication", () => {
        const highlight = new HighlightType(range);
        highlight.priority = 1;
        registry.set(currentName, highlight);
      });
    }
    if (scroll && typeof range.getBoundingClientRect === "function") {
      const { box, bounds } = measure("navigation-geometry", () => ({
        box: range.getBoundingClientRect(),
        bounds: viewport.getBoundingClientRect(),
      }));
      measure("navigation-scroll", () => {
        viewport.scrollTop += box.top - bounds.top - viewport.clientHeight / 2;
        const pre = locate(logical.start)?.node.parentElement?.closest("pre");
        if (pre && pre.scrollWidth > pre.clientWidth) {
          pre.scrollLeft += box.left - pre.getBoundingClientRect().left - pre.clientWidth / 2;
        }
      });
      refresh();
    }
  };
  const invalidate = () => {
    if (disposed) return;
    indexed = null;
    resetVisibility();
    matches = [];
    current = 0;
    if (supported) registry.delete(currentName);
    refresh();
    onInvalidated();
  };
  const mutations = new MutationObserver(invalidate);
  mutations.observe(root, { subtree: true, childList: true, characterData: true });
  const resize = new ResizeObserver(refresh);
  resize.observe(viewport);
  viewport.addEventListener("scroll", refresh, { passive: true });
  root.addEventListener("scroll", refresh, { capture: true, passive: true });
  root.addEventListener("load", refresh, true);
  document.fonts?.addEventListener("loadingdone", refresh);

  return {
    supported,
    setQuery(query: string, revision = 0): number {
      if (disposed) return 0;
      if (mutations.takeRecords().length || indexedRevision !== revision) indexed = null;
      indexedRevision = revision;
      if (query.trim()) {
        if (!indexed) {
          indexed = measure("capture", () => createDomTextIndex(root));
          observeSegments();
        }
        matches = measure("matching", () => findLogicalMatches(indexed!.fullText, query));
      } else {
        matches = [];
      }
      current = 0;
      if (supported) {
        registry.delete(currentName);
        registry.delete(otherName);
      }
      measure("clear", refresh);
      return matches.length;
    },
    activate,
    dispose() {
      if (disposed) return;
      disposed = true;
      resetVisibility();
      mutations.disconnect();
      resize.disconnect();
      viewport.removeEventListener("scroll", refresh);
      root.removeEventListener("scroll", refresh, true);
      root.removeEventListener("load", refresh, true);
      document.fonts?.removeEventListener("loadingdone", refresh);
      if (frame !== null) cancelAnimationFrame(frame);
      if (supported) {
        registry.delete(otherName);
        registry.delete(currentName);
      }
      indexed = null;
      matches = [];
      ranges = [];
      style.remove();
    },
  };
}
