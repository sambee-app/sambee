import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeMarkdownTableCellLineBreaks,
  remarkRenderMarkdownTableCellLineBreaks,
} from "../../components/Viewer/markdownTableCellLineBreaks";
import {
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  prepareCodePreviewInWorker,
  WORKER_PROGRESS_TIMEOUT_MS,
} from "../markdownCodePreparation";
import {
  createMarkdownDocumentModel,
  DOCUMENT_RECORD_BATCH_ITEMS,
  DOCUMENT_TEXT_CHUNK_UNITS,
  documentSyntaxPage,
  markdownDocumentRecords,
} from "../markdownDocumentPreviewModel";
import { createDocumentSearchIndex, documentSearchMatches } from "../markdownDocumentSearch";
import { rehypeMarkdownHeadingLinks } from "../markdownHeadingLinks";
import {
  createMarkdownTreeReceiver,
  MARKDOWN_TREE_BATCH_UNITS,
  MARKDOWN_TREE_TEXT_UNITS,
  markdownTreeRecords,
  remarkPreparedMarkdownTree,
} from "../markdownPreparedTree";
import {
  collectMarkdownCodeBlocks,
  rehypeMeasureMarkdownPreparation,
  rehypePreparedSyntax,
  remarkCollectMarkdownCodeBlocks,
  remarkMeasureMarkdownPreparation,
} from "../markdownSyntax";
import { MAX_VIEWPORT_SYNTAX_RANGES, publishMarkdownSyntax, visibleSyntaxColumnWindows } from "../markdownSyntaxPublication";
import { prepareMarkdownSyntax } from "../markdownSyntaxWorker";
import {
  SYNTAX_RESULT_PAGE_RANGES,
  SYNTAX_SOURCE_CHUNK_UNITS,
  type SyntaxWorkerRequest,
  type SyntaxWorkerResponse,
} from "../markdownSyntaxWorkerProtocol";
import { TOKEN_COLOR_ROLES } from "../syntaxHighlighting";

function mockSyntaxIntersections() {
  let notify: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
  );
  return {
    disconnect,
    publish: (targets: Element[], isIntersecting = true) =>
      notify(
        targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
        {} as IntersectionObserver
      ),
  };
}

describe("engine-neutral Markdown syntax adapter", () => {
  it("creates safe, stable heading targets and resolves Unicode and duplicate fragments", () => {
    const markdown =
      "# Location\n\n## Café **déjà**\n\n## Repeat\n\n## Repeat\n\n[Unicode](#caf%C3%A9-d%C3%A9j%C3%A0) [Duplicate](#repeat-1) [Existing](#sambee-markdown-repeat)\n";
    const first = render(<ReactMarkdown rehypePlugins={[rehypeMarkdownHeadingLinks]}>{markdown}</ReactMarkdown>);
    const ids = [...first.container.querySelectorAll("h1,h2")].map((heading) => heading.id);
    expect(ids).toEqual(["sambee-markdown-location", "sambee-markdown-café-déjà", "sambee-markdown-repeat", "sambee-markdown-repeat-1"]);
    expect([...first.container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "#sambee-markdown-caf%C3%A9-d%C3%A9j%C3%A0",
      "#sambee-markdown-repeat-1",
      "#sambee-markdown-repeat",
    ]);
    first.unmount();
    const second = render(<ReactMarkdown rehypePlugins={[rehypeMarkdownHeadingLinks]}>{markdown}</ReactMarkdown>);
    expect([...second.container.querySelectorAll("h1,h2")].map((heading) => heading.id)).toEqual(ids);
  });

  it("leaves unknown, malformed and non-heading fragments and external links alone", () => {
    const markdown =
      "# Known\n\n[Missing](#absent) [Malformed](#%ZZ) [External](https://example.org/#known)\n\nFootnote[^note].\n\n[^note]: Note text.\n";
    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeMarkdownHeadingLinks]}>
        {markdown}
      </ReactMarkdown>
    );
    expect([...container.querySelectorAll("a")].slice(0, 3).map((link) => link.getAttribute("href"))).toEqual([
      "#absent",
      "#%ZZ",
      "https://example.org/#known",
    ]);
    const reference = container.querySelector("a[data-footnote-ref]")!;
    expect(reference.getAttribute("href")).toBe("#user-content-fn-note");
    expect(container.querySelector('[id="user-content-fn-note"]')).not.toBeNull();
  });

  it("keeps production normalization independent of retired preview proofs", () => {
    for (const filename of ["markdownCodePreparation.ts", "markdownCodePreparation.worker.ts", "markdownCodePreparationProtocol.ts"]) {
      const source = readFileSync(`src/utils/${filename}`, "utf8");
      expect(source).not.toMatch(/markdown(?:CodePreviewModel|DocumentPreviewModel|DocumentSearch)|createStaticHighlighter|MATCH_QUERY/);
    }
  });

  it.each([
    "# Heading\n\nPlain **strong** [safe](https://example.com).\n\n<script>unsafe()</script>\n",
    "* item\n\n| A | B |\n| - | - |\n| a\\&b | first<BR>second |\n\n```md\n* literal<BR>\n```\n",
    `[link][ref]\n\n[ref]: https://example.com "title"\n\n![alt](image.png)\n\n~~~js meta\n${"const rocket = '🚀';\n".repeat(200)}~~~\n`,
  ])("reuses an equivalent canonical tree without changing ReactMarkdown output (%#)", (source) => {
    let tree: ReturnType<ReturnType<typeof createMarkdownTreeReceiver>["finish"]> | undefined;
    const canonical = normalizeMarkdownTableCellLineBreaks(source, (_text, parsed) => {
      tree = parsed;
    });
    expect(tree).toEqual(unified().use(remarkParse).use(remarkGfm).parse(canonical));
    const receiver = createMarkdownTreeReceiver();
    for (const record of markdownTreeRecords(tree!)) receiver.consume([record]);
    const restored = receiver.finish();
    expect(restored).toEqual(tree);
    const baseline = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkRenderMarkdownTableCellLineBreaks]}>{canonical}</ReactMarkdown>
    );
    const html = baseline.container.innerHTML;
    baseline.unmount();
    const prepared = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkPreparedMarkdownTree, restored], remarkRenderMarkdownTableCellLineBreaks]}>
        {canonical}
      </ReactMarkdown>
    );
    expect(prepared.container.innerHTML).toBe(html);
    prepared.unmount();
    expect(restored).toEqual(tree);
  });

  it("rejects malformed and oversized tree records", () => {
    const receiver = createMarkdownTreeReceiver();
    expect(() => receiver.finish()).toThrow("Incomplete");
    expect(() => receiver.consume([{ kind: "node", id: 1, parent: null, node: { type: "text" }, children: false }])).toThrow("Invalid");
    receiver.consume([{ kind: "node", id: 0, parent: null, node: { type: "root" }, children: true }]);
    expect(() => receiver.consume([{ kind: "text", id: 0, key: "__proto__", value: "bad" }])).toThrow("Invalid");
    expect(() => receiver.consume([{ kind: "text", id: 0, key: "value", value: "x".repeat(MARKDOWN_TREE_TEXT_UNITS + 1) }])).toThrow(
      "Invalid"
    );
    expect(() =>
      receiver.consume(
        Array.from({ length: MARKDOWN_TREE_BATCH_UNITS / MARKDOWN_TREE_TEXT_UNITS + 1 }, () => ({
          kind: "text" as const,
          id: 0,
          key: "value",
          value: "x".repeat(MARKDOWN_TREE_TEXT_UNITS),
        }))
      )
    ).toThrow("text bound");
  });

  it("chunks wide-table alignment metadata without imposing a column cutoff", () => {
    const source = `|${" header |".repeat(600)}\n|${" :---: |".repeat(600)}\n|${" value |".repeat(600)}\n`;
    const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
    const receiver = createMarkdownTreeReceiver();
    for (const record of markdownTreeRecords(tree)) receiver.consume([record]);
    expect(receiver.finish()).toEqual(tree);
  });

  it.each([
    { type: "root", value: "unbounded inline text" },
    { type: "root", align: Array(600).fill(null) },
    { type: "root", position: { start: { line: 1, column: 1, offset: "unbounded metadata" }, end: { line: 1, column: 1, offset: 0 } } },
  ])("rejects text and arrays outside the bounded field channel (%#)", (node) => {
    expect(() => createMarkdownTreeReceiver().consume([{ kind: "node", id: 0, parent: null, node, children: true }])).toThrow("tree node");
  });

  it("isolates normalization workers, bounds results and cleans up success, cancellation, decode errors and timeouts", async () => {
    class PreparationWorker extends EventTarget {
      static instances: PreparationWorker[] = [];
      onmessage: ((event: MessageEvent<PreparationResponse>) => void) | null = null;
      postMessage = vi.fn<(message: PreparationRequest) => void>();
      terminate = vi.fn();
      constructor() {
        super();
        PreparationWorker.instances.push(this);
      }
      receive(response: PreparationResponse) {
        this.onmessage?.(new MessageEvent("message", { data: response }));
      }
    }
    vi.stubGlobal("Worker", PreparationWorker);
    const location = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
    try {
      const controller = new AbortController();
      const pending = prepareCodePreviewInWorker(["* item"], 1, controller.signal, vi.fn());
      const worker = PreparationWorker.instances[0];
      expect(worker.postMessage.mock.calls[0][0]).toEqual({ type: "prepare", generation: 1, prepareTree: undefined });
      const cancelledController = new AbortController();
      const cancelled = prepareCodePreviewInWorker(["new"], 2, cancelledController.signal, vi.fn());
      const cancelledWorker = PreparationWorker.instances[1];
      expect(cancelledWorker).not.toBe(worker);
      worker.receive({ type: "source-ack", generation: 1, sequence: 0 });
      worker.receive({ type: "source-ack", generation: 1, sequence: 1 });
      expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "run", generation: 1 });
      worker.receive({ type: "normalized-source", generation: 1, sequence: 1, text: "- ", final: false });
      worker.receive({ type: "normalized-source", generation: 1, sequence: 2, text: "item", final: true });
      worker.receive({ type: "complete", generation: 1, preparationMs: 1 });
      expect((await pending).normalizedSource).toBe("- item");
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
      const treeJob = prepareCodePreviewInWorker([""], 20, new AbortController().signal, vi.fn(), { prepareTree: true });
      const treeWorker = PreparationWorker.instances.at(-1)!;
      treeWorker.receive({ type: "source-ack", generation: 20, sequence: 0 });
      treeWorker.receive({ type: "source-ack", generation: 20, sequence: 1 });
      treeWorker.receive({ type: "normalized-source", generation: 20, sequence: 1, text: "", final: true });
      treeWorker.receive({
        type: "tree-chunk",
        generation: 20,
        sequence: 1,
        records: [{ kind: "node", id: 0, parent: null, node: { type: "root" }, children: true }],
        final: true,
      });
      expect(treeWorker.postMessage).toHaveBeenLastCalledWith({ type: "ack", generation: 20 });
      treeWorker.postMessage.mockClear();
      expect(treeWorker.postMessage).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(treeWorker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ack", generation: 20 }));
      treeWorker.receive({ type: "complete", generation: 20, preparationMs: 1 });
      expect((await treeJob).preparedTree).toEqual({ type: "root", children: [] });
      expect(treeWorker.terminate).toHaveBeenCalledOnce();
      PreparationWorker.instances.pop();
      for (const mode of ["missing-final", "stale-then-cancel", "bad-sequence"] as const) {
        const treeController = new AbortController();
        const incomplete = prepareCodePreviewInWorker([""], 21, treeController.signal, vi.fn(), { prepareTree: true });
        const incompleteWorker = PreparationWorker.instances.at(-1)!;
        incompleteWorker.receive({ type: "source-ack", generation: 21, sequence: 0 });
        incompleteWorker.receive({ type: "source-ack", generation: 21, sequence: 1 });
        incompleteWorker.receive({ type: "normalized-source", generation: 21, sequence: 1, text: "", final: true });
        const page = {
          type: "tree-chunk" as const,
          generation: 21,
          sequence: 1,
          records: [{ kind: "node" as const, id: 0, parent: null, node: { type: "root" }, children: true }],
          final: false,
        };
        if (mode === "missing-final") {
          incompleteWorker.receive(page);
          incompleteWorker.receive({ type: "complete", generation: 21, preparationMs: 0 });
          await expect(incomplete).rejects.toThrow("final tree chunk");
        } else if (mode === "bad-sequence") {
          incompleteWorker.receive({ ...page, sequence: 2 });
          await expect(incomplete).rejects.toThrow("tree sequence");
        } else {
          incompleteWorker.receive({ ...page, generation: 22 });
          incompleteWorker.receive(page);
          const sends = incompleteWorker.postMessage.mock.calls.length;
          treeController.abort();
          await expect(incomplete).rejects.toMatchObject({ name: "AbortError" });
          expect(incompleteWorker.postMessage.mock.calls).toHaveLength(sends);
        }
        expect(incompleteWorker.terminate).toHaveBeenCalledOnce();
        expect(incompleteWorker.onmessage).toBeNull();
        PreparationWorker.instances.pop();
      }
      const late = cancelledWorker.onmessage;
      cancelledController.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      late?.(new MessageEvent("message", { data: { type: "complete", generation: 2, preparationMs: 0, indexingMs: 0 } }));
      expect(cancelledWorker.terminate).toHaveBeenCalledOnce();
      expect(cancelledWorker.onmessage).toBeNull();

      const malformed = prepareCodePreviewInWorker(["bad"], 3, new AbortController().signal, vi.fn());
      const malformedWorker = PreparationWorker.instances[2];
      malformedWorker.receive({ type: "source-ack", generation: 3, sequence: 0 });
      malformedWorker.receive({ type: "source-ack", generation: 3, sequence: 1 });
      malformedWorker.receive({
        type: "normalized-source",
        generation: 3,
        sequence: 1,
        text: "x".repeat(PREPARATION_SOURCE_CHUNK_UNITS + 1),
        final: true,
      });
      await expect(malformed).rejects.toThrow("Invalid normalized Markdown source chunk");
      expect(malformedWorker.terminate).toHaveBeenCalledOnce();

      const undecodable = prepareCodePreviewInWorker(["bad"], 4, new AbortController().signal, vi.fn());
      const undecodableWorker = PreparationWorker.instances[3];
      undecodableWorker.dispatchEvent(new Event("messageerror"));
      await expect(undecodable).rejects.toThrow("could not be decoded");
      expect(undecodableWorker.terminate).toHaveBeenCalledOnce();

      vi.useFakeTimers();
      const stalled = prepareCodePreviewInWorker(["bad"], 5, new AbortController().signal, vi.fn());
      const stalledWorker = PreparationWorker.instances[4];
      const rejection = expect(stalled).rejects.toThrow("made no progress");
      await vi.advanceTimersByTimeAsync(WORKER_PROGRESS_TIMEOUT_MS);
      await rejection;
      expect(stalledWorker.terminate).toHaveBeenCalledOnce();
      vi.useRealTimers();

      const source = "x".repeat(PREPARATION_SOURCE_CHUNK_UNITS * 2 + 1);
      const chunked = prepareCodePreviewInWorker([source], 6, new AbortController().signal, vi.fn());
      const chunkedWorker = PreparationWorker.instances.at(-1)!;
      for (let sequence = 0; sequence <= 3; sequence += 1) {
        chunkedWorker.receive({ type: "source-ack", generation: 6, sequence });
      }
      const sent = chunkedWorker.postMessage.mock.calls.map(([message]) => message).filter((message) => message.type === "source");
      expect(sent.map((message) => message.text).join("")).toBe(source);
      expect(sent.map((message) => message.text.length)).toEqual([PREPARATION_SOURCE_CHUNK_UNITS, PREPARATION_SOURCE_CHUNK_UNITS, 1]);
      expect(sent.map((message) => message.final)).toEqual([false, false, true]);
      expect(chunkedWorker.postMessage).toHaveBeenLastCalledWith({ type: "run", generation: 6 });
      for (const [index, message] of sent.entries()) {
        chunkedWorker.receive({ type: "normalized-source", generation: 6, sequence: index + 1, text: message.text, final: message.final });
      }
      chunkedWorker.receive({ type: "complete", generation: 6, preparationMs: 1 });
      await expect(chunked).resolves.toMatchObject({ normalizedSource: source });
      expect(chunkedWorker.terminate).toHaveBeenCalledOnce();
      await expect(prepareCodePreviewInWorker([], 7, new AbortController().signal, vi.fn())).rejects.toThrow("one source document");
      await expect(prepareCodePreviewInWorker(["a", "b"], 7, new AbortController().signal, vi.fn())).rejects.toThrow("one source document");
    } finally {
      vi.useRealTimers();
      location.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("normalizes document preparation with the existing canonical source rules only when requested", async () => {
    const source = "* item\n\n| A | B |\n| - | - |\n| a\\&b | first<BR>second |\n\n```md\n* literal<BR>\n```\n";
    const canonical = "- item\n\n| A | B |\n| - | - |\n| a&b | first<br />second |\n\n```md\n* literal<BR>\n```\n";
    const original = await createMarkdownDocumentModel(source);
    expect(original.source).toBe(source);
    const normalized = await createMarkdownDocumentModel(source, { normalizeSource: true });
    expect(normalized.source).toBe(canonical);
    const baseline = await createMarkdownDocumentModel(canonical);
    expect([...markdownDocumentRecords(normalized)]).toEqual([...markdownDocumentRecords(baseline)]);
  });

  it.each([
    {
      source: '> ```TS title\n> const rocket = "\ud83d\ude80";\n> ```\n\n~~~unknown metadata\nraw\n~~~\n\n```\nplain\n```\n',
      expected: [
        { text: 'const rocket = "\ud83d\ude80";', label: "TS" },
        { text: "raw", label: "unknown" },
        { text: "plain", label: null },
      ],
    },
    { source: "1. item\n\n   ```python\n   print(1)\n   ```\n", expected: [{ text: "print(1)", label: "python" }] },
    { source: "# Heading\n\n    alpha\n    beta\n", expected: [{ text: "alpha\nbeta", label: null }] },
    { source: "Paragraph with `inline code`.\n", expected: [] },
  ])("collects identical ordered code requests from the render tree: $source", ({ source, expected }) => {
    const collected = vi.fn();
    const preview = render(
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkCollectMarkdownCodeBlocks, collected]]}>{source}</ReactMarkdown>
    );
    expect(collected).toHaveBeenCalledExactlyOnceWith(expected);
    expect(collectMarkdownCodeBlocks(source)).toEqual(expected);
    expect([...preview.container.querySelectorAll("pre code")].map((code) => code.textContent)).toEqual(
      expected.map((request) => `${request.text}\n`)
    );
    preview.unmount();
  });

  it("measures render parsing and transforms without changing semantic output", () => {
    const source = "# Title\n\nsam**bee** [safe](https://example.com)\n\n```js\nlet x=1;\n```\n";
    const baseline = render(<ReactMarkdown>{source}</ReactMarkdown>);
    const expected = baseline.container.innerHTML;
    baseline.unmount();
    const expectedRequests = collectMarkdownCodeBlocks(source);
    const measure = vi.spyOn(performance, "measure");
    const ready = vi.fn();
    const collected = vi.fn();
    try {
      const measured = render(
        <ReactMarkdown
          remarkPlugins={[remarkMeasureMarkdownPreparation, [remarkCollectMarkdownCodeBlocks, collected]]}
          rehypePlugins={[[rehypeMeasureMarkdownPreparation, ready]]}
        >
          {source}
        </ReactMarkdown>
      );
      expect(measured.container.innerHTML).toBe(expected);
      expect(ready).toHaveBeenCalledOnce();
      expect(collected).toHaveBeenCalledExactlyOnceWith(expectedRequests);
      expect(measure.mock.calls.some(([name]) => name === "sambee:preview-preparation:collection-parse")).toBe(false);
      for (const stage of ["render-parse", "render-transform", "collection-walk"]) {
        expect(measure.mock.calls.some(([name]) => name === `sambee:preview-preparation:${stage}`)).toBe(true);
      }
      measured.unmount();
    } finally {
      measure.mockRestore();
    }
  });

  it("bounds worker transfer, acknowledges result pages asynchronously and cancels pending work", async () => {
    class SyntaxWorker extends EventTarget {
      static instances: SyntaxWorker[] = [];
      postMessage = vi.fn<(message: SyntaxWorkerRequest) => void>();
      terminate = vi.fn();
      constructor() {
        super();
        SyntaxWorker.instances.push(this);
      }
      receive(response: SyntaxWorkerResponse) {
        this.dispatchEvent(new MessageEvent("message", { data: response }));
      }
    }
    vi.stubGlobal("Worker", SyntaxWorker);
    const locationString = vi.spyOn(window.location, "toString").mockReturnValue("http://localhost:3000/");
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const text = "x".repeat(SYNTAX_SOURCE_CHUNK_UNITS * 2 + 1);
      const pending = prepareMarkdownSyntax(
        [{ text, label: "js" }, { text: "x".repeat(100_001) }, { text: "end", label: "py" }],
        controller.signal
      );
      const worker = SyntaxWorker.instances[0];
      expect(worker.postMessage.mock.calls[0][0]).toEqual({
        type: "source",
        block: 0,
        text: text.slice(0, SYNTAX_SOURCE_CHUNK_UNITS),
        label: "js",
        final: false,
      });
      worker.receive({ type: "source-ack" });
      worker.receive({ type: "source-ack" });
      expect(worker.postMessage.mock.calls[2][0]).toMatchObject({ text: "x", final: true });
      const ranges = Array.from({ length: SYNTAX_RESULT_PAGE_RANGES }, (_, index) => ({
        from: index,
        to: index + 1,
        categories: ["keyword"] as const,
      }));
      worker.receive({ type: "ranges", block: 0, ranges });
      expect(worker.postMessage).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.postMessage.mock.calls[3][0]).toEqual({ type: "ack" });
      worker.receive({ type: "complete", block: 0 });
      expect(worker.postMessage.mock.calls[4][0]).toEqual({ type: "source", block: 1, text: "end", label: "py", final: true });
      worker.receive({ type: "complete", block: 1, reason: "unknown-language" });
      await expect(pending).resolves.toEqual([{ ranges }, { reason: "block-too-large" }, { reason: "unknown-language" }]);
      expect(worker.terminate).toHaveBeenCalledOnce();
      const cancelled = prepareMarkdownSyntax([{ text: "new" }], controller.signal);
      const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejection;
      expect(SyntaxWorker.instances[1].terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      locationString.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it("bounds live syntax ranges without changing text or selection and cancels queued publication", () => {
    const intersections = mockSyntaxIntersections();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const highlights = new Map<string, Set<Range>>();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const source = "x ".repeat(MAX_VIEWPORT_SYNTAX_RANGES + 1);
    const { container, unmount } = render(<ReactMarkdown>{`\`\`\`js\n${source}\n\`\`\``}</ReactMarkdown>);
    const code = container.querySelector("code")!;
    const node = code.firstChild;
    const rect = { top: 0, bottom: 10 } as DOMRect;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 20 } as DOMRect);
    vi.spyOn(code, "getBoundingClientRect").mockReturnValue(rect);
    const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(rect);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    const controller = new AbortController();
    try {
      const measurements = vi.spyOn(performance, "measure");
      const dispose = publishMarkdownSyntax(
        container,
        container,
        {
          requests: [{ text: source, label: "js" }],
          results: [
            {
              ranges: Array.from({ length: MAX_VIEWPORT_SYNTAX_RANGES + 1 }, (_, index) => ({
                from: index * 2,
                to: index * 2 + 1,
                categories: ["keyword"],
              })),
            },
          ],
        },
        controller.signal
      );
      const style = [...document.head.querySelectorAll("style")].find((element) =>
        element.textContent?.includes("::highlight(markdown-syntax-")
      );
      expect(style).toBeDefined();
      for (const [category, role] of Object.entries(TOKEN_COLOR_ROLES)) {
        expect(style!.textContent).toMatch(new RegExp(`-${category}\\) \\{ color: var\\(--sambee-syntax-${role}\\); \\}`));
      }
      const runFrame = () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      };
      intersections.publish([code]);
      runFrame();
      expect(geometry).not.toHaveBeenCalled();
      for (const stage of ["task", "viewport-geometry", "block-geometry", "mapping", "offset-geometry", "ranges", "publication"]) {
        expect(measurements.mock.calls.some(([name]) => name === `sambee:preview-syntax:${stage}`)).toBe(true);
      }
      measurements.mockRestore();
      expect([...highlights.values()].reduce((total, ranges) => total + ranges.size, 0)).toBe(MAX_VIEWPORT_SYNTAX_RANGES);
      expect([...highlights.values()].every((highlight) => (highlight as Set<Range> & { priority: number }).priority === -1)).toBe(true);
      expect(code.firstChild).toBe(node);
      expect(code.textContent).toBe(`${source}\n`);
      expect(selection.toString()).toBe(selected);
      container.dispatchEvent(new Event("scroll"));
      expect(frames.size).toBe(1);
      controller.abort();
      expect(frames.size).toBe(0);
      expect(highlights.size).toBe(0);
      expect(style!.isConnected).toBe(false);
      expect(intersections.disconnect).toHaveBeenCalledOnce();
      dispose();
    } finally {
      controller.abort();
      selection.removeAllRanges();
      geometry.mockRestore();
      vi.unstubAllGlobals();
      unmount();
    }
  });
  it.each([
    [0, 5],
    [5, 7],
    [7, 9],
    [9, 10],
    [10, 10],
    [11, 12],
  ])("retains exact horizontal boundaries with nonuniform and coincident UTF-16 positions (%s/%s)", (left, right) => {
    const text = "\tA\u{1f642}\u754ce\u0301";
    const characterRights = [4, 5, 7, 7, 9, 10, 10];
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre";
    Object.defineProperties(pre, { scrollWidth: { value: 20 }, clientWidth: { value: 1 } });
    const rect = vi.spyOn(pre, "getBoundingClientRect").mockReturnValue({ left, right } as DOMRect);
    const rangeAt = (from: number) => ({ getBoundingClientRect: () => ({ right: characterRights[from] }) }) as Range;
    const expected = (edge: number) => {
      const index = characterRights.findIndex((position) => position >= edge);
      return index < 0 ? text.length : index;
    };
    try {
      expect(visibleSyntaxColumnWindows(text, rangeAt, { left, right }, 0, text.length, pre)).toEqual([
        { from: expected(left), to: Math.min(text.length, expected(right) + 1) },
      ]);
    } finally {
      rect.mockRestore();
    }
  });

  it.each([
    { left: -200, right: -100 },
    { left: 100, right: 200 },
  ])("skips character probes when the horizontal clip is outside the viewport (%#)", (clip) => {
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre";
    Object.defineProperties(pre, { scrollWidth: { value: 100 }, clientWidth: { value: 50 } });
    const rect = vi.spyOn(pre, "getBoundingClientRect").mockReturnValue(clip as DOMRect);
    const rangeAt = vi.fn();
    try {
      expect(visibleSyntaxColumnWindows("text", rangeAt, { left: 0, right: 50 }, 0, 4, pre)).toEqual([]);
      expect(rangeAt).not.toHaveBeenCalled();
    } finally {
      rect.mockRestore();
    }
  });

  it.each(["load", "loadingdone"])("refreshes clipped syntax after nested scroll and %s without changing text", (eventType) => {
    const intersections = mockSyntaxIntersections();
    const frames = new Map<number, FrameRequestCallback>();
    const highlights = new Map<string, Set<Range>>();
    let nextFrame = 0;
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      }
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const source = "x ".repeat(6_000);
    const { container, unmount } = render(<ReactMarkdown>{`\`\`\`js\n${source}\n\`\`\``}</ReactMarkdown>);
    const code = container.querySelector("code")!;
    const pre = container.querySelector("pre")!;
    pre.style.whiteSpace = "pre";
    Object.defineProperties(pre, { scrollWidth: { value: source.length }, clientWidth: { value: 100 } });
    const rect = { top: 0, bottom: 10, left: 0, right: 100 } as DOMRect;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(code, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(pre, "getBoundingClientRect").mockReturnValue(rect);
    const fonts = new EventTarget();
    const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const removeFontListener = vi.spyOn(fonts, "removeEventListener");
    const removeRootListener = vi.spyOn(container, "removeEventListener");
    const loadTarget = document.createElement("img");
    container.append(loadTarget);
    let characterWidth = 1;
    const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect").mockImplementation(function (this: Range) {
      return { ...rect, left: this.startOffset * characterWidth - pre.scrollLeft, right: this.endOffset * characterWidth - pre.scrollLeft };
    });
    const controller = new AbortController();
    const runFrame = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    };
    try {
      publishMarkdownSyntax(
        container,
        container,
        {
          requests: [{ text: source, label: "js" }],
          results: [
            { ranges: Array.from({ length: 6_000 }, (_, index) => ({ from: index * 2, to: index * 2 + 1, categories: ["keyword"] })) },
          ],
        },
        controller.signal
      );
      intersections.publish([code]);
      runFrame();
      const visible = () => [...highlights.values()].flatMap((ranges) => [...ranges]);
      expect(visible().length).toBeGreaterThan(0);
      expect(visible().length).toBeLessThan(100);
      expect(Math.max(...visible().map((range) => range.endOffset))).toBeLessThanOrEqual(102);
      expect(geometry.mock.calls.length).toBeLessThan(20);
      pre.scrollLeft = 10_000;
      pre.dispatchEvent(new Event("scroll"));
      expect(frames.size).toBe(1);
      runFrame();
      expect(Math.min(...visible().map((range) => range.startOffset))).toBeGreaterThanOrEqual(9_999);
      pre.scrollLeft = 0;
      characterWidth = 0.5;
      const target = eventType === "load" ? loadTarget : fonts;
      target.dispatchEvent(new Event(eventType));
      target.dispatchEvent(new Event(eventType));
      expect(frames.size).toBe(1);
      runFrame();
      expect(Math.min(...visible().map((range) => range.startOffset))).toBe(0);
      expect(Math.max(...visible().map((range) => range.endOffset))).toBeGreaterThan(190);
      expect(Math.max(...visible().map((range) => range.endOffset))).toBeLessThanOrEqual(202);
      expect(code.textContent).toBe(`${source}\n`);
      controller.abort();
      expect(frames.size).toBe(0);
      expect(highlights.size).toBe(0);
      expect(removeFontListener).toHaveBeenCalledWith("loadingdone", expect.any(Function));
      expect(removeRootListener).toHaveBeenCalledWith("load", expect.any(Function), true);
      target.dispatchEvent(new Event(eventType));
      expect(frames.size).toBe(0);
    } finally {
      controller.abort();
      if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
      else Reflect.deleteProperty(document, "fonts");
      removeFontListener.mockRestore();
      removeRootListener.mockRestore();
      geometry.mockRestore();
      vi.unstubAllGlobals();
      unmount();
    }
  });

  it("publishes a late visible block during continuous scrolling without scanning off-screen blocks", () => {
    const intersections = mockSyntaxIntersections();
    const frames = new Map<number, FrameRequestCallback>();
    const highlights = new Map<string, Set<Range>>();
    let nextFrame = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      }
    );
    const { container, unmount } = render(<ReactMarkdown>{"```js\nx\n```\n\n".repeat(600)}</ReactMarkdown>);
    const blocks = [...container.querySelectorAll("code")];
    const destination = blocks[599];
    const bounds = { top: 0, bottom: 20 } as DOMRect;
    const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(bounds);
    const probes = blocks.map((block, index) =>
      vi.spyOn(block, "getBoundingClientRect").mockReturnValue(index === 599 ? bounds : ({ top: -20, bottom: -10 } as DOMRect))
    );
    const controller = new AbortController();
    try {
      publishMarkdownSyntax(
        container,
        container,
        {
          requests: blocks.map(() => ({ text: "x", label: "js" })),
          results: blocks.map(() => ({ ranges: [{ from: 0, to: 1, categories: ["keyword"] }] })),
        },
        controller.signal
      );
      intersections.publish([destination]);
      for (let iteration = 0; iteration < 60; iteration += 1) {
        container.dispatchEvent(new Event("scroll"));
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
        const ranges = [...highlights.values()].flatMap((collection) => [...collection]);
        expect(ranges).toHaveLength(1);
        expect(ranges[0].startContainer).toBe(destination.firstChild);
      }
      expect(probes.slice(0, -1).every((probe) => probe.mock.calls.length === 0)).toBe(true);
      intersections.publish([destination], false);
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
      expect([...highlights.values()].every((collection) => collection.size === 0)).toBe(true);
      controller.abort();
      expect(intersections.disconnect).toHaveBeenCalledOnce();
      expect(highlights.size).toBe(0);
      expect(frames.size).toBe(0);
    } finally {
      controller.abort();
      geometry.mockRestore();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      unmount();
    }
  });

  it("pages only intersecting syntax ranges without losing boundary tokens", () => {
    const ranges = Array.from({ length: 200 }, (_, index) => ({ from: index * 3, to: index * 3 + 2, categories: ["keyword"] as const }));
    const window = { id: 7, from: 4, to: 502 };
    const collected = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = documentSyntaxPage(ranges, window, offset);
      expect(page.records.length).toBeLessThanOrEqual(DOCUMENT_RECORD_BATCH_ITEMS);
      collected.push(...page.records);
      offset = page.next;
    }
    expect(collected.map((record) => record.range)).toEqual(ranges.filter((range) => range.to > window.from && range.from < window.to));
    expect(documentSyntaxPage(ranges, { id: 7, from: 2, to: 3 }, 0).records).toEqual([]);
    expect(() => documentSyntaxPage(ranges, window, -1)).toThrow("Invalid document syntax window");
  });
  it("indexes rendered Markdown across inline markup, blocks and text chunks without joining words", async () => {
    const model = await createMarkdownDocumentModel(
      `# Header\n\nA **bold** word.\n\nNext paragraph.\n\n\`\`\`text\n${"x".repeat(2_047)}🌍 end\n\`\`\``
    );
    const index = createDocumentSearchIndex(markdownDocumentRecords(model));
    expect(index.text).toBe(`Header\nA bold word.\nNext paragraph.\n${"x".repeat(2_047)}🌍 end\n`);
    for (const query of ["bold word", "word.\nNext", "🌍 end"]) {
      expect([...documentSearchMatches(index.text, query)]).toEqual([
        { from: index.text.indexOf(query), to: index.text.indexOf(query) + query.length },
      ]);
    }
    expect([...documentSearchMatches(index.text, "word.Next")]).toEqual([]);
    expect([...documentSearchMatches("WORD word sword", "word", { wholeWord: true })]).toHaveLength(2);
    expect([...documentSearchMatches("WORD word sword", "word", { wholeWord: true, caseSensitive: true })]).toEqual([{ from: 5, to: 9 }]);
    expect([...documentSearchMatches("ab\nab", "a.", { regexp: true })]).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ]);
    expect([...documentSearchMatches("🌍", "(?=.)", { regexp: true })].length).toBeGreaterThan(0);
    expect(() => [...documentSearchMatches("text", "[", { regexp: true })]).toThrow("Invalid document search expression");
    const match = [...documentSearchMatches(index.text, "🌍 end")][0];
    expect(index.segments.filter((segment) => segment.to > match.from && segment.from < match.to)).toHaveLength(2);
  });
  it("streams semantic whole-Markdown records with bounded text and source-ordered parents", async () => {
    const source = `# Heading\n\n**Strong** and [safe](https://example.com).\n\n| A | B |\n| - | - |\n| first<br>second | cell |\n\n- [x] done\n\n\`\`\`js\n${"let x=1;\n".repeat(600)}\`\`\`\n\n<script>ignored()</script>`;
    const model = await createMarkdownDocumentModel(source);
    const records = [...markdownDocumentRecords(model)];
    const ids = new Set([0]);
    for (const record of records) {
      if (record.kind === "element" || record.kind === "text") {
        expect(ids.has(record.parent)).toBe(true);
        expect(ids.has(record.id)).toBe(false);
        ids.add(record.id);
      }
      if (record.kind === "text" || record.kind === "attribute") expect(record.value.length).toBeLessThanOrEqual(DOCUMENT_TEXT_CHUNK_UNITS);
    }
    const tags = records.filter((record) => record.kind === "element").map((record) => record.tag);
    for (const tag of ["h1", "strong", "a", "table", "br", "ul", "input", "pre", "code"]) expect(tags).toContain(tag);
    expect(tags).not.toContain("script");
    expect(
      records
        .filter((record) => record.kind === "text")
        .map((record) => record.value)
        .join("")
    ).toContain("<script>ignored()</script>");
    const tableParents = new Set(
      records
        .filter((record) => record.kind === "element" && ["table", "thead", "tbody", "tr"].includes(record.tag))
        .map((record) => record.id)
    );
    expect(records.filter((record) => record.kind === "text" && tableParents.has(record.parent))).toEqual([]);
    expect(model.codeBlocks.map(({ text, label }) => ({ text, label }))).toEqual([{ text: "let x=1;\n".repeat(600), label: "js" }]);
  });
  it("keeps the contract and renderer independent of engine imports", () => {
    const contract = readFileSync("src/utils/syntaxHighlighting.ts", "utf8");
    const renderer = readFileSync("src/utils/markdownSyntax.ts", "utf8");
    const presentation = readFileSync("src/theme/syntaxStyles.ts", "utf8");
    for (const source of [contract, renderer, presentation]) {
      expect(source).not.toMatch(/from\s+["'][^"']*(?:@codemirror|@lezer|codeMirrorHighlighting|highlightingService)[^"']*["']/);
    }
    expect(contract).not.toMatch(/\bimport\b/);
  });
  it("collects exact code occurrences from the Markdown AST", () => {
    expect(collectMarkdownCodeBlocks("```js\nlet x=1\n```\n\n```js\nlet x=1\n```\n\n    plain")).toEqual([
      { text: "let x=1", label: "js" },
      { text: "let x=1", label: "js" },
      { text: "plain", label: null },
    ]);
  });

  it("renders prepared ranges, combinations, neutral gaps and Unicode without a parser engine", () => {
    const source = "```js\nlet x='🌍';\n```\n\n```js\nlet x='🌍';\n```";
    const requests = collectMarkdownCodeBlocks(source);
    const results = [
      {
        ranges: [
          { from: 0, to: 3, categories: ["keyword", "strong"] as const },
          { from: 6, to: 10, categories: ["string"] as const },
        ],
      },
      { reason: "parsing-failure" as const },
    ];
    const { container } = render(<ReactMarkdown rehypePlugins={[[rehypePreparedSyntax, { requests, results }]]}>{source}</ReactMarkdown>);
    const blocks = container.querySelectorAll("pre code");
    expect(blocks[0]!.textContent).toBe("let x='🌍';\n");
    expect(blocks[1]!.textContent).toBe(blocks[0]!.textContent);
    expect(blocks[0]!.querySelector(".sambee-syntax-keyword.sambee-syntax-strong")).not.toBeNull();
    expect(blocks[1]!.querySelector("span")).toBeNull();
  });

  it("keeps stale, invalid and empty results neutral without changing text", () => {
    const source = "```\nhello\n```";
    const requests = collectMarkdownCodeBlocks(source);
    for (const result of [{ ranges: [] }, { ranges: [{ from: 0, to: 99, categories: ["keyword"] as const }] }]) {
      const { container, unmount } = render(
        <ReactMarkdown rehypePlugins={[[rehypePreparedSyntax, { requests, results: [result] }]]}>{source}</ReactMarkdown>
      );
      expect(container.querySelector("code")?.textContent).toBe("hello\n");
      expect(container.querySelector("span")).toBeNull();
      unmount();
    }
  });
});
