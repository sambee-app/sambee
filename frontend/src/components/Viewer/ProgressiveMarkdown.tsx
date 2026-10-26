import { Box, CircularProgress } from "@mui/material";
import type { Element, Root, RootContent } from "hast";
import { type ComponentType, memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import type { Plugin } from "unified";

export const PROGRESSIVE_MARKDOWN_MIN_UNITS = 50_000;
export const PROGRESSIVE_MARKDOWN_BATCH_NODES = 1_024;
export const PROGRESSIVE_MARKDOWN_BATCH_UNITS = 8_192;
export const PROGRESSIVE_MARKDOWN_FRAME_MS = 4;
export const PROGRESSIVE_MARKDOWN_FRAME_BATCHES = 4;
export const PROGRESSIVE_MARKDOWN_VIEWPORTS = 2;
export const PROGRESSIVE_MARKDOWN_FEEDBACK_MS = 200;
const SLOT_TAG = "sambee-markdown-stage";
const TABLE_CONTAINERS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;

interface Weight {
  nodes: number;
  units: number;
}

interface Slot {
  id: number;
  children: RootContent[];
  index: number;
  offset: number;
  sequence: number;
  first?: PublicationBatch;
}

interface PublicationBatch {
  id: number;
  children: RootContent[];
}

function createPublication(source: Options["children"]) {
  const weights = new WeakMap<RootContent, Weight>();
  const slots = new Map<number, Slot>();
  const queued = new Map<number, () => void>();
  let nextId = 0;
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let root: HTMLElement | null = null;
  let ready = false;
  let advancing = false;
  let initialViewportFilled = false;
  let onComplete = () => {};
  let onFailure = (_error: unknown) => {};

  function register(children: RootContent[], parentTag?: string): Element {
    const id = nextId++;
    const content =
      parentTag && TABLE_CONTAINERS.has(parentTag)
        ? children.filter((child) => child.type !== "text" || child.value.trim().length > 0)
        : children;
    slots.set(id, { id, children: content, index: 0, offset: 0, sequence: 0 });
    return { type: "element", tagName: SLOT_TAG, properties: { stageId: id }, children: [] };
  }

  function take(slot: Slot): PublicationBatch {
    const batch: RootContent[] = [];
    let nodes = 0;
    let units = 0;
    while (slot.index < slot.children.length && nodes < PROGRESSIVE_MARKDOWN_BATCH_NODES && units < PROGRESSIVE_MARKDOWN_BATCH_UNITS) {
      const child = slot.children[slot.index];
      if (!child) throw new Error("Markdown publication is missing a staged node.");
      const weight = weights.get(child) ?? { nodes: 1, units: "value" in child ? child.value.length : 0 };
      if ((child.type === "text" || child.type === "raw") && child.value.length - slot.offset > PROGRESSIVE_MARKDOWN_BATCH_UNITS - units) {
        let end = slot.offset + PROGRESSIVE_MARKDOWN_BATCH_UNITS - units;
        const boundary = child.value.charCodeAt(end - 1);
        if (boundary >= HIGH_SURROGATE_START && boundary <= HIGH_SURROGATE_END) end -= 1;
        if (end === slot.offset) break;
        batch.push({ type: "text", value: child.value.slice(slot.offset, end) });
        slot.offset = end;
        break;
      }
      if (
        child.type === "element" &&
        (weight.nodes > PROGRESSIVE_MARKDOWN_BATCH_NODES || weight.units > PROGRESSIVE_MARKDOWN_BATCH_UNITS)
      ) {
        if (batch.length) break;
        batch.push({ ...child, properties: { ...child.properties }, children: [register(child.children, child.tagName)] });
        slot.index += 1;
        break;
      } else {
        if (
          batch.length &&
          (nodes + weight.nodes > PROGRESSIVE_MARKDOWN_BATCH_NODES || units + weight.units > PROGRESSIVE_MARKDOWN_BATCH_UNITS)
        )
          break;
        batch.push(
          slot.offset && (child.type === "text" || child.type === "raw") ? { ...child, value: child.value.slice(slot.offset) } : child
        );
        nodes += weight.nodes;
        units += weight.units;
      }
      slot.index += 1;
      slot.offset = 0;
    }
    return { id: slot.sequence++, children: batch };
  }

  function cancelFrame() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  }

  function schedule() {
    if (!root || ready || advancing || frame !== undefined || timer !== undefined) return;
    if (document.hidden) timer = setTimeout(advance, 0);
    else frame = requestAnimationFrame(advance);
  }

  function advance() {
    frame = undefined;
    timer = undefined;
    if (!root) return;
    advancing = true;
    try {
      const start = performance.now();
      const viewportHeight = initialViewportFilled
        ? 0
        : root.closest<HTMLElement>('[data-testid="markdown-viewer-content"]')?.clientHeight || window.innerHeight;
      if (!initialViewportFilled && root.getBoundingClientRect().height >= viewportHeight * PROGRESSIVE_MARKDOWN_VIEWPORTS)
        initialViewportFilled = true;
      let batches = 0;
      while (queued.size) {
        const [id, append] = queued.entries().next().value!;
        queued.delete(id);
        flushSync(append);
        if (!root) return;
        batches += 1;
        if (performance.now() - start >= PROGRESSIVE_MARKDOWN_FRAME_MS || batches >= PROGRESSIVE_MARKDOWN_FRAME_BATCHES) break;
        if (!initialViewportFilled && root.getBoundingClientRect().height >= viewportHeight * PROGRESSIVE_MARKDOWN_VIEWPORTS) {
          initialViewportFilled = true;
          break;
        }
      }
      if (!queued.size) {
        ready = true;
        onComplete();
      }
    } catch (error) {
      queued.clear();
      root = null;
      onFailure(error);
    } finally {
      advancing = false;
      schedule();
    }
  }

  const stage: Plugin<[], Root> = () => (tree) => {
    const pending: { node: RootContent; visited: boolean }[] = tree.children.map((node) => ({ node, visited: false }));
    while (pending.length) {
      const entry = pending.pop()!;
      if (!entry.visited && "children" in entry.node) {
        pending.push({ ...entry, visited: true });
        for (const child of entry.node.children) pending.push({ node: child as RootContent, visited: false });
      } else {
        const weight = { nodes: 1, units: "value" in entry.node ? entry.node.value.length : 0 };
        if ("children" in entry.node)
          for (const child of entry.node.children) {
            const childWeight = weights.get(child as RootContent)!;
            weight.nodes += childWeight.nodes;
            weight.units += childWeight.units;
          }
        weights.set(entry.node, weight);
      }
    }
    tree.children = [register(tree.children)];
  };

  return {
    source,
    stage,
    slots,
    take,
    enqueue(id: number, append: () => void) {
      queued.set(id, append);
      schedule();
      return () => {
        queued.delete(id);
      };
    },
    start(element: HTMLElement, complete: () => void, failure: (error: unknown) => void) {
      root = element;
      onComplete = complete;
      onFailure = failure;
      const visibilityChanged = () => {
        cancelFrame();
        schedule();
      };
      document.addEventListener("visibilitychange", visibilityChanged);
      schedule();
      return () => {
        root = null;
        cancelFrame();
        document.removeEventListener("visibilitychange", visibilityChanged);
      };
    },
  };
}

const injectTree: Plugin<[RootContent[]], Root> = (children) => (tree) => {
  tree.children = children;
};

type ProgressiveMarkdownProps = Pick<Options, "children" | "remarkPlugins" | "rehypePlugins" | "components"> & {
  onPending?: () => void;
  onReady: () => void;
  onFailure: (error: unknown) => void;
};

export function ProgressiveMarkdown({
  onPending,
  onReady,
  onFailure,
  children,
  remarkPlugins,
  rehypePlugins,
  components: linkComponents,
}: ProgressiveMarkdownProps) {
  const { t } = useTranslation();
  const heavy = (children?.length ?? 0) >= PROGRESSIVE_MARKDOWN_MIN_UNITS;
  const renderOptions = useMemo(
    () => ({ children, remarkPlugins, rehypePlugins, components: linkComponents }),
    [children, remarkPlugins, rehypePlugins, linkComponents]
  );
  const publication = useMemo(() => createPublication(renderOptions.children), [renderOptions]);
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPending, onReady, onFailure });
  callbacks.current = { onPending, onReady, onFailure };
  const [complete, setComplete] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const Stage = useMemo(() => {
    // biome-ignore lint/correctness/noComponentHookFactories: The memoized component identity resets batches only when the publication changes.
    const Batch = memo(({ children }: { children: RootContent[] }) => (
      <ReactMarkdown components={components} rehypePlugins={[[injectTree, children]]}>
        {""}
      </ReactMarkdown>
    ));
    // biome-ignore lint/correctness/noComponentHookFactories: Slot state belongs to this publication and must reset when the memoized stage changes.
    const SlotComponent = ({ node }: { node: Element }) => {
      const slot = publication.slots.get(Number(node.properties["stageId"]))!;
      const [batches, setBatches] = useState(() => {
        if (!slot.first) slot.first = publication.take(slot);
        return [slot.first];
      });
      useLayoutEffect(() => {
        if (!batches.length || slot.index >= slot.children.length) return;
        return publication.enqueue(slot.id, () => {
          const next = publication.take(slot);
          setBatches((current) => [...current, next]);
        });
      }, [batches.length, slot]);
      return batches.map((batch) => <Batch key={batch.id}>{batch.children}</Batch>);
    };
    const components = { ...linkComponents, [SLOT_TAG]: SlotComponent as ComponentType<unknown> } as Components;
    return { components };
  }, [publication, linkComponents]);
  const stagedDocument = useMemo(
    () => (
      <ReactMarkdown
        components={Stage.components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={[...(rehypePlugins ?? []), publication.stage]}
      >
        {children}
      </ReactMarkdown>
    ),
    [publication, Stage, children, remarkPlugins, rehypePlugins]
  );

  useLayoutEffect(() => {
    if (!heavy) {
      callbacks.current.onReady();
      return;
    }
    if (!root.current) return;
    callbacks.current.onPending?.();
    setComplete(false);
    setFeedback(false);
    const stop = publication.start(
      root.current,
      () => {
        clearTimeout(feedbackTimer);
        setFeedback(false);
        setComplete(true);
        callbacks.current.onReady();
      },
      (error) => callbacks.current.onFailure(error)
    );
    const feedbackTimer = setTimeout(() => setFeedback(true), PROGRESSIVE_MARKDOWN_FEEDBACK_MS);
    return () => {
      clearTimeout(feedbackTimer);
      stop();
    };
  }, [heavy, publication]);

  if (!heavy)
    return (
      <ReactMarkdown components={linkComponents} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    );
  return (
    <div ref={root} aria-busy={!complete} data-markdown-publication={complete ? "complete" : "loading"}>
      {stagedDocument}
      {feedback && !complete && (
        <Box
          role="status"
          aria-label={t("app.loading")}
          sx={{
            position: "sticky",
            bottom: 8,
            height: 20,
            marginTop: "-20px",
            display: "flex",
            justifyContent: "flex-end",
            pointerEvents: "none",
            "@media (prefers-reduced-motion: reduce)": {
              "& .MuiCircularProgress-root, & .MuiCircularProgress-circle": { animation: "none" },
            },
          }}
        >
          <CircularProgress size={20} disableShrink />
        </Box>
      )}
    </div>
  );
}
