import { highlightingService } from "../../src/utils/highlightingService";
import { createCodePreviewModel } from "../../src/utils/markdownCodePreviewModel";
import {
  createMarkdownDocumentModel,
  DOCUMENT_CODE_PUBLICATION_BATCH_ITEMS,
  DOCUMENT_PUBLICATION_BATCH_ITEMS,
  documentSyntaxPage,
  type MarkdownDocumentRecord,
  markdownDocumentRecords,
} from "../../src/utils/markdownDocumentPreviewModel";
import type { SyntaxRange } from "../../src/utils/syntaxHighlighting";
import {
  PREPARATION_CHUNK_ITEMS,
  PREPARATION_SOURCE_CHUNK_UNITS,
  type PreparationRequest,
  type PreparationResponse,
  type PreviewMatch,
} from "./markdownCodePreparation";

const MATCH_QUERY = "let x";
let acknowledge: (() => void) | null = null;
let activeGeneration: number | null = null;
let sourceBlocks: string[] = [];
let sourceParts: string[] = [];
let expectedBlocks = 0;
let sourceSequence = 0;
let running = false;
let documentMode = false;
let documentGeneration: number | null = null;
const documentSyntax = new Map<number, readonly SyntaxRange[]>();

async function prepareDocument(source: string, generation: number): Promise<void> {
  const start = performance.now();
  const model = await createMarkdownDocumentModel(source);
  documentGeneration = generation;
  let batch: MarkdownDocumentRecord[] = [];
  let batchLimit = DOCUMENT_PUBLICATION_BATCH_ITEMS;
  const flush = async () => {
    if (!batch.length) return;
    const records = batch;
    batch = [];
    await new Promise<void>((resolve) => {
      acknowledge = resolve;
      send({ type: "document-chunk", generation, records });
    });
  };
  const emit = async (record: MarkdownDocumentRecord) => {
    if (record.kind === "element") batchLimit = record.fragment ? DOCUMENT_CODE_PUBLICATION_BATCH_ITEMS : DOCUMENT_PUBLICATION_BATCH_ITEMS;
    batch.push(record);
    if (batch.length >= batchLimit) await flush();
  };
  for (const record of markdownDocumentRecords(model)) await emit(record);
  await flush();
  for (const block of model.codeBlocks) {
    const [result] = await highlightingService.prepare([block]);
    if (!result) throw new Error("Markdown code preparation returned no result");
    if ("ranges" in result) {
      documentSyntax.set(block.id, result.ranges);
    } else await emit({ kind: "fallback", id: block.id, reason: result.reason });
  }
  await flush();
  send({
    type: "complete",
    generation,
    preparationMs: performance.now() - start,
    indexingMs: 0,
    syntaxRanges: [...documentSyntax.values()].reduce((count, ranges) => count + ranges.length, 0),
  });
}

function send(response: PreparationResponse): void {
  postMessage(response);
}

export function error(message: string, context?: Record<string, unknown>, component?: string, failure?: Error): void {
  send({
    type: "diagnostic",
    generation: activeGeneration ?? -1,
    message,
    context,
    component,
    error: failure ? { message: failure.message, name: failure.name } : undefined,
  });
}

async function prepare(blocks: string[], generation: number): Promise<void> {
  let preparationMs = 0;
  let indexingMs = 0;
  for (let block = 0; block < blocks.length; block += 1) {
    const text = blocks[block];
    const start = performance.now();
    const [result] = await highlightingService.prepare([{ text, label: "javascript" }]);
    preparationMs += performance.now() - start;
    if (!("ranges" in result)) throw new Error(`Prototype block ${block} preparation failed: ${result.reason}`);
    const indexStart = performance.now();
    const model = createCodePreviewModel(text, result.ranges);
    const matches: PreviewMatch[] = [];
    for (let from = text.indexOf(MATCH_QUERY); from !== -1; from = text.indexOf(MATCH_QUERY, from + MATCH_QUERY.length)) {
      matches.push({ from, to: from + MATCH_QUERY.length });
    }
    indexingMs += performance.now() - indexStart;
    let rangeOffset = 0;
    let fragmentOffset = 0;
    let matchOffset = 0;
    while (rangeOffset < model.ranges.length || fragmentOffset < model.fragments.length || matchOffset < matches.length) {
      const ranges = model.ranges.slice(rangeOffset, rangeOffset + PREPARATION_CHUNK_ITEMS);
      const fragments = model.fragments.slice(fragmentOffset, fragmentOffset + PREPARATION_CHUNK_ITEMS - ranges.length);
      const matchChunk = matches.slice(matchOffset, matchOffset + PREPARATION_CHUNK_ITEMS - ranges.length - fragments.length);
      rangeOffset += ranges.length;
      fragmentOffset += fragments.length;
      matchOffset += matchChunk.length;
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
        send({
          type: "chunk",
          generation,
          block,
          ranges,
          fragments,
          matches: matchChunk,
        });
      });
    }
  }
  send({ type: "complete", generation, preparationMs, indexingMs });
}

globalThis.onmessage = (event: MessageEvent<PreparationRequest>) => {
  const request = event.data;
  if (request.type === "syntax-window") {
    if (request.generation !== documentGeneration) return;
    try {
      send({
        type: "syntax-page",
        generation: request.generation,
        requestId: request.requestId,
        ...documentSyntaxPage(documentSyntax.get(request.window.id) ?? [], request.window, request.offset),
      });
    } catch (error) {
      send({ type: "error", generation: request.generation, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.type === "prepare") {
    if (activeGeneration !== null || !Number.isSafeInteger(request.blockCount) || request.blockCount < 0) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid or overlapping job" });
      return;
    }
    activeGeneration = request.generation;
    documentSyntax.clear();
    documentGeneration = null;
    documentMode = request.document === true;
    if (documentMode && request.blockCount !== 1) {
      send({ type: "error", generation: request.generation, message: "Markdown document preparation requires one source document" });
      return;
    }
    expectedBlocks = request.blockCount;
    sourceBlocks = [];
    sourceParts = [];
    sourceSequence = 0;
    running = false;
    send({ type: "source-ack", generation: request.generation, sequence: sourceSequence });
    return;
  }
  if (request.generation !== activeGeneration) return;
  if (request.type === "ack") {
    if (request.generation === activeGeneration) {
      const resume = acknowledge;
      acknowledge = null;
      resume?.();
    }
    return;
  }
  if (request.type === "source") {
    if (
      running ||
      request.sequence !== sourceSequence + 1 ||
      request.block !== sourceBlocks.length ||
      request.block >= expectedBlocks ||
      typeof request.text !== "string" ||
      request.text.length > PREPARATION_SOURCE_CHUNK_UNITS ||
      typeof request.final !== "boolean" ||
      (!request.final && request.text.length === 0)
    ) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid source chunk" });
      return;
    }
    sourceParts.push(request.text);
    if (request.final) {
      sourceBlocks.push(sourceParts.join(""));
      sourceParts = [];
    }
    sourceSequence = request.sequence;
    send({ type: "source-ack", generation: request.generation, sequence: sourceSequence });
    return;
  }
  if (running || sourceBlocks.length !== expectedBlocks || sourceParts.length > 0) {
    send({ type: "error", generation: request.generation, message: "Preparation worker cannot run before source transfer completes" });
    return;
  }
  running = true;
  void (documentMode ? prepareDocument(sourceBlocks[0]!, request.generation) : prepare(sourceBlocks, request.generation))
    .catch((error: unknown) => {
      send({
        type: "error",
        generation: request.generation,
        message: error instanceof Error ? error.message : "Worker preparation failed",
      });
    })
    .finally(() => {
      acknowledge = null;
      activeGeneration = null;
      sourceBlocks = [];
      sourceParts = [];
      running = false;
    });
};
