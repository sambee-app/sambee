export const DOM_TEXT_SEARCH_HIGHLIGHT_ATTRIBUTE = "data-text-search-highlight";
export const DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE = "data-text-search-current";
export const DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE = "data-text-search-match-id";
export const DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR = `mark[${DOM_TEXT_SEARCH_HIGHLIGHT_ATTRIBUTE}="true"]`;

export interface DomTextSearchMatch {
  id: number;
  elements: HTMLElement[];
}

const activeMatches = new WeakMap<DomTextSearchMatch[], DomTextSearchMatch>();

function measureSearchStage<Result>(stage: string, operation: () => Result): Result {
  const start = performance.now();
  try {
    return operation();
  } finally {
    const name = `sambee:preview-search:${stage}`;
    performance.clearMeasures?.(name);
    performance.measure?.(name, { start, end: performance.now() });
  }
}

export interface IndexedTextSegment {
  node: Text;
  start: number;
  end: number;
}

export interface IndexedDomText {
  fullText: string;
  segments: IndexedTextSegment[];
}

interface DomTextIndexBuilder {
  chunks: string[];
  length: number;
  lastCharacter: string;
  segments: IndexedTextSegment[];
}

export interface LogicalMatch {
  id: number;
  start: number;
  end: number;
}

interface HighlightSlice {
  startOffset: number;
  endOffset: number;
  matchId: number;
}

const BLOCK_BOUNDARY_TAG_NAMES = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

export function clearDomTextSearchHighlights(container: ParentNode | null): void {
  if (!container) {
    return;
  }

  measureSearchStage("clear", () => clearHighlights(container));
}

function clearHighlights(container: ParentNode): void {
  const highlights = container.querySelectorAll(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR);
  const parents = new Set<Node>();
  for (const highlight of highlights) {
    const parent = highlight.parentNode;
    if (parent) parents.add(parent);
  }
  for (const parent of parents) {
    const fragment = document.createDocumentFragment();
    let text = "";
    for (const child of Array.from(parent.childNodes)) {
      if (child instanceof Text || (child instanceof HTMLElement && child.matches(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR))) {
        text += child.textContent ?? "";
      } else {
        if (text) fragment.append(document.createTextNode(text));
        text = "";
        fragment.append(child);
      }
    }
    if (text) fragment.append(document.createTextNode(text));
    parent.replaceChildren(fragment);
  }
}

function appendBlockSeparator(indexedText: DomTextIndexBuilder): void {
  if (!indexedText.length || indexedText.lastCharacter === "\n") {
    return;
  }

  indexedText.chunks.push("\n");
  indexedText.length += 1;
  indexedText.lastCharacter = "\n";
}

function indexTextNode(node: Text, indexedText: DomTextIndexBuilder): void {
  const text = node.textContent ?? "";
  if (!text || (!text.trim() && !node.parentElement?.closest("pre"))) {
    return;
  }

  const start = indexedText.length;
  indexedText.chunks.push(text);
  indexedText.length += text.length;
  indexedText.lastCharacter = text[text.length - 1];
  indexedText.segments.push({
    node,
    start,
    end: indexedText.length,
  });
}

function buildIndexedDomText(node: Node, indexedText: DomTextIndexBuilder, isRoot = false): void {
  if (node instanceof Text) {
    if (node.parentElement?.closest(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)) {
      return;
    }

    indexTextNode(node, indexedText);
    return;
  }

  if (!(node instanceof HTMLElement)) {
    return;
  }

  if (node.matches(DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR)) {
    return;
  }

  if (!isRoot && BLOCK_BOUNDARY_TAG_NAMES.has(node.tagName)) {
    appendBlockSeparator(indexedText);
  }

  for (const child of node.childNodes) {
    buildIndexedDomText(child, indexedText);
  }

  if (!isRoot && BLOCK_BOUNDARY_TAG_NAMES.has(node.tagName)) {
    appendBlockSeparator(indexedText);
  }
}

export function createDomTextIndex(container: HTMLElement): IndexedDomText {
  const indexedText: DomTextIndexBuilder = {
    chunks: [],
    length: 0,
    lastCharacter: "",
    segments: [],
  };

  buildIndexedDomText(container, indexedText, true);

  return { fullText: indexedText.chunks.join(""), segments: indexedText.segments };
}

export function findLogicalMatches(fullText: string, query: string): LogicalMatch[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const normalizedText = fullText.toLocaleLowerCase();
  const matches: LogicalMatch[] = [];
  let searchStartIndex = 0;
  let nextId = 0;

  while (searchStartIndex < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchStartIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push({
      id: nextId,
      start: matchIndex,
      end: matchIndex + normalizedQuery.length,
    });

    nextId += 1;
    searchStartIndex = matchIndex + normalizedQuery.length;
  }

  return matches;
}

export function buildHighlightSlices(indexedText: IndexedDomText, matches: LogicalMatch[]): Map<Text, HighlightSlice[]> {
  const slicesByNode = new Map<Text, HighlightSlice[]>();
  let segmentIndex = 0;

  for (const match of matches) {
    while (segmentIndex < indexedText.segments.length && indexedText.segments[segmentIndex].end <= match.start) {
      segmentIndex += 1;
    }
    for (let overlapIndex = segmentIndex; overlapIndex < indexedText.segments.length; overlapIndex += 1) {
      const segment = indexedText.segments[overlapIndex];
      if (segment.start >= match.end) break;

      const overlappingStart = Math.max(match.start, segment.start);
      const overlappingEnd = Math.min(match.end, segment.end);

      if (overlappingStart >= overlappingEnd) {
        continue;
      }

      const slices = slicesByNode.get(segment.node) ?? [];
      slices.push({
        startOffset: overlappingStart - segment.start,
        endOffset: overlappingEnd - segment.start,
        matchId: match.id,
      });
      slicesByNode.set(segment.node, slices);
    }
  }

  return slicesByNode;
}

function applyHighlightSlices(slicesByNode: Map<Text, HighlightSlice[]>, matchCount: number): DomTextSearchMatch[] {
  const elementsByMatchId = new Map<number, HTMLElement[]>();

  for (let matchId = 0; matchId < matchCount; matchId += 1) {
    elementsByMatchId.set(matchId, []);
  }

  for (const [textNode, slices] of slicesByNode.entries()) {
    const workingNode = textNode;
    const sortedSlices = [...slices].sort((left, right) => right.startOffset - left.startOffset);

    for (const slice of sortedSlices) {
      workingNode.splitText(slice.endOffset);
      const matchNode = workingNode.splitText(slice.startOffset);

      const highlight = document.createElement("mark");
      highlight.setAttribute(DOM_TEXT_SEARCH_HIGHLIGHT_ATTRIBUTE, "true");
      highlight.setAttribute(DOM_TEXT_SEARCH_MATCH_ID_ATTRIBUTE, String(slice.matchId));
      matchNode.parentNode?.replaceChild(highlight, matchNode);
      highlight.appendChild(matchNode);

      elementsByMatchId.get(slice.matchId)?.push(highlight);
    }
  }

  return Array.from(elementsByMatchId.entries()).map(([id, elements]) => ({ id, elements }));
}

export function applyDomTextSearchHighlights(container: HTMLElement, query: string): DomTextSearchMatch[] {
  const indexedText = measureSearchStage("capture", () => createDomTextIndex(container));
  const matches = measureSearchStage("matching", () => findLogicalMatches(indexedText.fullText, query));

  if (matches.length === 0) {
    return [];
  }

  const slicesByNode = measureSearchStage("slices", () => buildHighlightSlices(indexedText, matches));
  return measureSearchStage("markers", () => applyHighlightSlices(slicesByNode, matches.length));
}

export function activateDomTextSearchMatch(matches: DomTextSearchMatch[], currentMatch: number, scroll = true): HTMLElement | null {
  const previous = activeMatches.get(matches);
  const current = currentMatch > 0 ? matches[currentMatch - 1] : undefined;
  if (previous !== current) {
    for (const highlight of previous?.elements ?? []) highlight.removeAttribute(DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE);
    for (const highlight of current?.elements ?? []) highlight.setAttribute(DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE, "true");
    if (current) activeMatches.set(matches, current);
    else activeMatches.delete(matches);
  }

  const activeHighlight = current?.elements[0] ?? null;
  if (scroll && activeHighlight && typeof activeHighlight.scrollIntoView === "function") {
    activeHighlight.scrollIntoView({ block: "center", inline: "nearest" });
  }

  return activeHighlight ?? null;
}
