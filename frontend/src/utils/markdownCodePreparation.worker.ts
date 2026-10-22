import type { Root } from "mdast";
import { normalizeMarkdownTableCellLineBreaks } from "../components/Viewer/markdownTableCellLineBreaks";
import { PREPARATION_SOURCE_CHUNK_UNITS, type PreparationRequest, type PreparationResponse } from "./markdownCodePreparationProtocol";
import {
  MARKDOWN_TREE_BATCH_RECORDS,
  MARKDOWN_TREE_BATCH_UNITS,
  type MarkdownTreeRecord,
  markdownTreeRecords,
} from "./markdownPreparedTree";

let acknowledge: (() => void) | null = null;
let activeGeneration: number | null = null;
let sourceParts: string[] = [];
let sourceSequence = 0;
let sourceFinal = false;
let running = false;
let prepareTree = false;

function send(response: PreparationResponse): void {
  postMessage(response);
}

async function normalizeSource(source: string, generation: number): Promise<void> {
  const start = performance.now();
  let tree: Root | undefined;
  const text = normalizeMarkdownTableCellLineBreaks(
    source,
    prepareTree
      ? (_source, parsed) => {
          tree = parsed;
        }
      : undefined
  );
  const preparationMs = performance.now() - start;
  let sequence = 0;
  for (let offset = 0; offset < Math.max(1, text.length); offset += PREPARATION_SOURCE_CHUNK_UNITS) {
    const chunk = text.slice(offset, offset + PREPARATION_SOURCE_CHUNK_UNITS);
    await new Promise<void>((resolve) => {
      acknowledge = resolve;
      send({ type: "normalized-source", generation, sequence: ++sequence, text: chunk, final: offset + chunk.length === text.length });
    });
  }
  if (tree) {
    let records: MarkdownTreeRecord[] = [];
    let units = 0;
    let treeSequence = 0;
    const flush = async (final: boolean) => {
      const batch = records;
      records = [];
      units = 0;
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
        send({ type: "tree-chunk", generation, sequence: ++treeSequence, records: batch, final });
      });
    };
    for (const record of markdownTreeRecords(tree)) {
      const size = record.kind === "text" ? record.value.length : String(record.node.type).length;
      if (records.length === MARKDOWN_TREE_BATCH_RECORDS || units + size > MARKDOWN_TREE_BATCH_UNITS) await flush(false);
      records.push(record);
      units += size;
    }
    await flush(true);
  }
  send({ type: "complete", generation, preparationMs });
}

globalThis.onmessage = (event: MessageEvent<PreparationRequest>) => {
  const request = event.data;
  if (request.type === "prepare") {
    if (activeGeneration !== null || !Number.isSafeInteger(request.generation)) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid or overlapping job" });
      return;
    }
    activeGeneration = request.generation;
    prepareTree = request.prepareTree === true;
    sourceParts = [];
    sourceSequence = 0;
    sourceFinal = false;
    running = false;
    send({ type: "source-ack", generation: request.generation, sequence: sourceSequence });
    return;
  }
  if (request.generation !== activeGeneration) return;
  if (request.type === "ack") {
    const resume = acknowledge;
    acknowledge = null;
    resume?.();
    return;
  }
  if (request.type === "source") {
    if (
      running ||
      sourceFinal ||
      request.sequence !== sourceSequence + 1 ||
      request.block !== 0 ||
      typeof request.text !== "string" ||
      request.text.length > PREPARATION_SOURCE_CHUNK_UNITS ||
      typeof request.final !== "boolean" ||
      (!request.final && request.text.length === 0)
    ) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid source chunk" });
      return;
    }
    sourceParts.push(request.text);
    sourceFinal = request.final;
    sourceSequence = request.sequence;
    send({ type: "source-ack", generation: request.generation, sequence: sourceSequence });
    return;
  }
  if (request.type !== "run" || running || !sourceFinal) {
    send({ type: "error", generation: request.generation, message: "Preparation worker cannot run before source transfer completes" });
    return;
  }
  running = true;
  const source = sourceParts.join("");
  sourceParts = [];
  void normalizeSource(source, request.generation)
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
      sourceParts = [];
      sourceFinal = false;
      running = false;
    });
};
