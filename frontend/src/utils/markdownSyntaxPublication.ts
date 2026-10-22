import type { PreparedMarkdownSyntax } from "./markdownSyntax";
import { TOKEN_CATEGORIES, TOKEN_COLOR_ROLES, type TokenCategory } from "./syntaxHighlighting";

export const MAX_VIEWPORT_SYNTAX_RANGES = 4_000;
const BLOCKS_PER_FRAME = 16;
const SYNTAX_HIGHLIGHT_PRIORITY = -1;
let publicationId = 0;

function measureSyntaxStage<Result>(stage: string, operation: () => Result): Result {
  const start = performance.now();
  try {
    return operation();
  } finally {
    const name = `sambee:preview-syntax:${stage}`;
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start, end: performance.now() });
  }
}

export function visibleSyntaxColumnWindows(
  text: string,
  rangeAt: (from: number, to: number) => Range,
  bounds: Pick<DOMRect, "left" | "right">,
  from: number,
  to: number,
  pre: HTMLElement | null
): { from: number; to: number }[] {
  if (!pre || pre.scrollWidth <= pre.clientWidth || getComputedStyle(pre).whiteSpace !== "pre" || getComputedStyle(pre).direction === "rtl")
    return [{ from, to }];
  const clip = pre.getBoundingClientRect();
  if (clip.right < bounds.left || clip.left > bounds.right) return [];
  const windows: { from: number; to: number }[] = [];
  let lineStart = from;
  while (lineStart < to) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? to : Math.min(to, newline + 1);
    const columnAt = (edge: number, start = lineStart) => {
      let low = start;
      let high = lineEnd;
      if (low < high && rangeAt(low, low + 1).getBoundingClientRect().right >= edge) return low;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (rangeAt(middle, middle + 1).getBoundingClientRect().right < edge) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const visibleFrom = columnAt(Math.max(bounds.left, clip.left));
    windows.push({
      from: visibleFrom,
      to: Math.min(lineEnd, columnAt(Math.min(bounds.right, clip.right), visibleFrom) + 1),
    });
    lineStart = lineEnd;
  }
  return windows;
}

export function publishMarkdownSyntax(
  root: HTMLElement,
  viewport: HTMLElement,
  prepared: PreparedMarkdownSyntax,
  signal: AbortSignal
): () => void {
  if (signal.aborted || typeof Highlight === "undefined" || !globalThis.CSS?.highlights || typeof IntersectionObserver === "undefined")
    return () => {};
  const prefix = `markdown-syntax-${++publicationId}`;
  const names = new Map(TOKEN_CATEGORIES.map((category) => [category, `${prefix}-${category}`]));
  const style = document.createElement("style");
  style.textContent = TOKEN_CATEGORIES.map((category) => {
    const color = TOKEN_COLOR_ROLES[category];
    return `::highlight(${names.get(category)}) { color: var(--sambee-syntax-${color}); }`;
  }).join("\n");
  document.head.append(style);
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre > code"));
  const blockIndices = new Map(blocks.map((block, index) => [block, index]));
  const visibleBlocks = new Set<number>();
  let pendingBlocks: number[] = [];
  let frame: number | null = null;
  let disposed = false;
  let nextBlock = 0;
  let count = 0;
  const categories = new Map<TokenCategory, Range[]>();

  const paint = () => measureSyntaxStage("task", paintTask);
  const paintTask = () => {
    frame = null;
    if (disposed || signal.aborted) return;
    const bounds = measureSyntaxStage("viewport-geometry", () => viewport.getBoundingClientRect());
    const limit = Math.min(pendingBlocks.length, nextBlock + BLOCKS_PER_FRAME);
    for (; nextBlock < limit && count < MAX_VIEWPORT_SYNTAX_RANGES; nextBlock += 1) {
      const index = pendingBlocks[nextBlock];
      const code = blocks[index];
      const result = prepared.results[index];
      const request = prepared.requests[index];
      const rect = measureSyntaxStage("block-geometry", () => code.getBoundingClientRect());
      if (!request || !result || !("ranges" in result) || rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
      const { nodes, length, valid } = measureSyntaxStage("mapping", () => {
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        const nodes: { node: Text; from: number; to: number }[] = [];
        let length = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          nodes.push({ node, from: length, to: length + node.length });
          length += node.length;
        }
        return { nodes, length, valid: code.textContent === request.text || code.textContent === `${request.text}\n` };
      });
      if (!nodes.length || !valid) continue;
      const locate = (offset: number) => {
        let low = 0;
        let high = nodes.length - 1;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (nodes[middle].to <= offset) low = middle + 1;
          else high = middle;
        }
        return nodes[low];
      };
      const rangeAt = (from: number, to: number) => {
        const start = locate(from);
        const end = locate(to);
        const range = new Range();
        range.setStart(start.node, Math.min(start.node.length, from - start.from));
        range.setEnd(end.node, Math.min(end.node.length, to - end.from));
        return range;
      };
      const offsetAt = (top: number) => {
        let low = 0;
        let high = Math.min(request.text.length, length);
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (rangeAt(middle, Math.min(middle + 1, length)).getBoundingClientRect().bottom < top) low = middle + 1;
          else high = middle;
        }
        return low;
      };
      const windows = measureSyntaxStage("offset-geometry", () => {
        const from = rect.top >= bounds.top ? 0 : offsetAt(bounds.top);
        const to = rect.bottom <= bounds.bottom ? request.text.length : Math.min(request.text.length, offsetAt(bounds.bottom) + 1);
        return visibleSyntaxColumnWindows(request.text, rangeAt, bounds, from, to, code.closest("pre"));
      });
      measureSyntaxStage("ranges", () => {
        for (const { from, to } of windows) {
          let low = 0;
          let high = result.ranges.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (result.ranges[middle].to <= from) low = middle + 1;
            else high = middle;
          }
          for (let index = low; index < result.ranges.length && count < MAX_VIEWPORT_SYNTAX_RANGES; index += 1) {
            const token = result.ranges[index];
            if (token.from >= to) break;
            const range = rangeAt(Math.max(from, token.from), Math.min(to, token.to));
            for (const category of token.categories) {
              if (count === MAX_VIEWPORT_SYNTAX_RANGES) break;
              const ranges = categories.get(category) ?? [];
              ranges.push(range);
              categories.set(category, ranges);
              count += 1;
            }
          }
        }
      });
    }
    measureSyntaxStage("publication", () => {
      for (const [category, name] of names) {
        const highlight = new Highlight(...(categories.get(category) ?? []));
        highlight.priority = SYNTAX_HIGHLIGHT_PRIORITY;
        CSS.highlights.set(name, highlight);
      }
    });
    if (nextBlock < pendingBlocks.length && count < MAX_VIEWPORT_SYNTAX_RANGES) frame = requestAnimationFrame(paint);
  };
  const refresh = () => {
    if (disposed || signal.aborted) return;
    pendingBlocks = [...visibleBlocks].sort((left, right) => left - right);
    nextBlock = 0;
    count = 0;
    categories.clear();
    if (frame === null) frame = requestAnimationFrame(paint);
  };
  const intersections = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = blockIndices.get(entry.target as HTMLElement);
        if (index === undefined) continue;
        if (entry.isIntersecting) visibleBlocks.add(index);
        else visibleBlocks.delete(index);
      }
      refresh();
    },
    { root: viewport }
  );
  for (const block of blocks) intersections.observe(block);
  const observer = new ResizeObserver(refresh);
  observer.observe(viewport);
  const mutations = new MutationObserver(refresh);
  mutations.observe(root, { subtree: true, childList: true, characterData: true });
  viewport.addEventListener("scroll", refresh, { passive: true });
  root.addEventListener("scroll", refresh, { capture: true, passive: true });
  root.addEventListener("load", refresh, true);
  const fonts = document.fonts;
  fonts?.addEventListener("loadingdone", refresh);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    intersections.disconnect();
    observer.disconnect();
    mutations.disconnect();
    viewport.removeEventListener("scroll", refresh);
    root.removeEventListener("scroll", refresh, true);
    root.removeEventListener("load", refresh, true);
    fonts?.removeEventListener("loadingdone", refresh);
    signal.removeEventListener("abort", dispose);
    for (const name of names.values()) CSS.highlights.delete(name);
    style.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  refresh();
  return dispose;
}
