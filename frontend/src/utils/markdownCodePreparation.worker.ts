import type { Root } from "mdast";
import {
  normalizeMarkdownTableCellLineBreaks,
  preserveUnchangedMarkdownTableSource,
} from "../components/Viewer/markdownTableCellLineBreaks";
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
let baselineParts: string[] = [];
let sourceBlock = 0;
let sourceSequence = 0;
let sourceFinal = false;
let running = false;
let prepareTree = false;
let preserveTableSource = false;
let preserveOnly = false;

function send(response: PreparationResponse): void {
  postMessage(response);
}

async function normalizeSource(source: string, generation: number, baseline?: string): Promise<void> {
  const start = performance.now();
  let tree: Root | undefined;
  const normalized = preserveOnly
    ? source
    : normalizeMarkdownTableCellLineBreaks(
        source,
        prepareTree
          ? (_source, parsed) => {
              tree = parsed;
            }
          : undefined
      );
  const normalizedAt = performance.now();
  const text = baseline === undefined ? normalized : preserveUnchangedMarkdownTableSource(baseline, normalized);
  const preparedAt = performance.now();
  const normalizationMs = normalizedAt - start;
  const preservationMs = preparedAt - normalizedAt;
  const preparationMs = preparedAt - start;
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
  send({ type: "complete", generation, preparationMs, normalizationMs, preservationMs });
}

globalThis.onmessage = (event: MessageEvent<PreparationRequest>) => {
  const request = event.data;
  if (request.type === "prepare") {
    if (
      activeGeneration !== null ||
      !Number.isSafeInteger(request.generation) ||
      (request.prepareTree && request.preserveTableSource) ||
      (request.preserveOnly && !request.preserveTableSource)
    ) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid or overlapping job" });
      return;
    }
    activeGeneration = request.generation;
    prepareTree = request.prepareTree === true;
    preserveTableSource = request.preserveTableSource === true;
    preserveOnly = request.preserveOnly === true;
    sourceParts = [];
    baselineParts = [];
    sourceBlock = 0;
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
      (sourceFinal && (!preserveTableSource || sourceBlock !== 0)) ||
      request.sequence !== sourceSequence + 1 ||
      request.block !== sourceBlock + (sourceFinal ? 1 : 0) ||
      typeof request.text !== "string" ||
      request.text.length > PREPARATION_SOURCE_CHUNK_UNITS ||
      typeof request.final !== "boolean" ||
      (!request.final && request.text.length === 0)
    ) {
      send({ type: "error", generation: request.generation, message: "Preparation worker received an invalid source chunk" });
      return;
    }
    sourceBlock = request.block;
    (sourceBlock === 0 ? sourceParts : baselineParts).push(request.text);
    sourceFinal = request.final;
    sourceSequence = request.sequence;
    send({ type: "source-ack", generation: request.generation, sequence: sourceSequence });
    return;
  }
  if (request.type !== "run" || running || !sourceFinal || sourceBlock !== (preserveTableSource ? 1 : 0)) {
    send({ type: "error", generation: request.generation, message: "Preparation worker cannot run before source transfer completes" });
    return;
  }
  running = true;
  const source = sourceParts.join("");
  const baseline = preserveTableSource ? baselineParts.join("") : undefined;
  sourceParts = [];
  baselineParts = [];
  void normalizeSource(source, request.generation, baseline)
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
      baselineParts = [];
      sourceBlock = 0;
      sourceFinal = false;
      running = false;
    });
};
