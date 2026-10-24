import type { Root, RootContent } from "mdast";
import type { Plugin } from "unified";

export const MARKDOWN_TREE_BATCH_RECORDS = 512;
export const MARKDOWN_TREE_BATCH_UNITS = 16_384;
export const MARKDOWN_TREE_TEXT_UNITS = 2_048;
const TREE_TEXT_FIELDS = new Set(["value", "lang", "meta", "url", "title", "alt", "identifier", "label", "referenceType", "align"]);

function validNodeMetadata(node: Record<string, unknown>): boolean {
  return Object.entries(node).every(([key, value]) => {
    if (key === "type") return typeof value === "string" && value.length <= MARKDOWN_TREE_TEXT_UNITS;
    if (TREE_TEXT_FIELDS.has(key)) return value === null || value === undefined;
    if (key === "depth" || key === "start") return value === null || Number.isSafeInteger(value);
    if (key === "ordered" || key === "spread" || key === "checked") return value === null || typeof value === "boolean";
    if (key !== "position" || !value || typeof value !== "object" || Object.keys(value).length !== 2) return false;
    return ["start", "end"].every((boundary) => {
      const point = (value as Record<string, unknown>)[boundary];
      return (
        point !== null &&
        typeof point === "object" &&
        Object.keys(point).length === 3 &&
        ["line", "column", "offset"].every((coordinate) => {
          const number = (point as Record<string, unknown>)[coordinate];
          return typeof number === "number" && Number.isSafeInteger(number) && number >= (coordinate === "offset" ? 0 : 1);
        })
      );
    });
  });
}

type MarkdownNode = Root | RootContent;
export type MarkdownTreeRecord =
  | { kind: "node"; id: number; parent: number | null; node: Record<string, unknown>; children: boolean }
  | { kind: "text"; id: number; key: string; value: string };

export function* markdownTreeRecords(tree: Root): Generator<MarkdownTreeRecord> {
  const pending: { node: MarkdownNode; parent: number | null }[] = [{ node: tree, parent: null }];
  let nextId = 0;
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    const id = nextId++;
    const data: Record<string, unknown> = {};
    const text: [string, string][] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "children") continue;
      if (key === "align") text.push([key, JSON.stringify(value)]);
      else if (typeof value === "string" && key !== "type") text.push([key, value]);
      else data[key] = value;
    }
    const children = "children" in node ? node.children : null;
    yield { kind: "node", id, parent, node: data, children: children !== null };
    for (const [key, value] of text) {
      for (let offset = 0; offset < Math.max(1, value.length); offset += MARKDOWN_TREE_TEXT_UNITS)
        yield { kind: "text", id, key, value: value.slice(offset, offset + MARKDOWN_TREE_TEXT_UNITS) };
    }
    if (children) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) pending.push({ node: child, parent: id });
      }
    }
  }
}

export function createMarkdownTreeReceiver() {
  const nodes: Record<string, unknown>[] = [];
  const fields = new Map<number, Map<string, string[]>>();
  let finished = false;
  return {
    consume(records: readonly MarkdownTreeRecord[]) {
      if (finished || records.length > MARKDOWN_TREE_BATCH_RECORDS) throw new Error("Invalid Markdown tree batch");
      let units = 0;
      for (const record of records) {
        if (!Number.isSafeInteger(record.id) || record.id < 0) throw new Error("Invalid Markdown tree node identifier");
        if (record.kind === "node") {
          if (
            record.id !== nodes.length ||
            typeof record.node["type"] !== "string" ||
            record.node["type"].length > MARKDOWN_TREE_TEXT_UNITS ||
            (record.id === 0 ? record.parent !== null || record.node["type"] !== "root" : record.parent === null) ||
            typeof record.children !== "boolean" ||
            !validNodeMetadata(record.node)
          )
            throw new Error("Invalid Markdown tree node");
          const node = { ...record.node, ...(record.children ? { children: [] } : {}) };
          if (record.parent !== null) {
            const children = nodes[record.parent]?.["children"];
            if (!Number.isSafeInteger(record.parent) || !Array.isArray(children)) throw new Error("Invalid Markdown tree parent");
            children.push(node);
          }
          nodes.push(node);
          units += record.node["type"].length;
        } else if (record.kind === "text") {
          if (
            !nodes[record.id] ||
            !TREE_TEXT_FIELDS.has(record.key) ||
            typeof record.value !== "string" ||
            record.value.length > MARKDOWN_TREE_TEXT_UNITS
          )
            throw new Error("Invalid Markdown tree text");
          const nodeFields = fields.get(record.id) ?? new Map<string, string[]>();
          const chunks = nodeFields.get(record.key) ?? [];
          chunks.push(record.value);
          nodeFields.set(record.key, chunks);
          fields.set(record.id, nodeFields);
          units += record.value.length;
        } else throw new Error("Unexpected Markdown tree record");
      }
      if (units > MARKDOWN_TREE_BATCH_UNITS) throw new Error("Markdown tree batch exceeded its text bound");
    },
    finish(): Root {
      if (finished || nodes[0]?.["type"] !== "root" || !Array.isArray(nodes[0]?.["children"])) throw new Error("Incomplete Markdown tree");
      finished = true;
      for (const [id, nodeFields] of fields) {
        const node = nodes[id];
        if (!node) throw new Error("Missing Markdown tree node for text fields");
        for (const [key, chunks] of nodeFields) {
          const text = chunks.join("");
          if (key === "align") {
            const alignment: unknown = JSON.parse(text);
            if (!Array.isArray(alignment) || alignment.some((value) => value !== null && !["left", "right", "center"].includes(value)))
              throw new Error("Invalid Markdown table alignment");
            node[key] = alignment;
          } else node[key] = text;
        }
      }
      fields.clear();
      return nodes[0] as unknown as Root;
    },
  };
}

export const remarkPreparedMarkdownTree: Plugin<[Root | undefined], Root> = function (tree) {
  if (tree)
    this.parser = () => {
      const start = performance.now();
      try {
        return structuredClone(tree);
      } finally {
        const name = "sambee:preview-preparation:render-prepared-tree";
        performance.clearMeasures?.(name);
        performance.measure?.(name, { start, end: performance.now() });
      }
    };
};
