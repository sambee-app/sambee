import { useLayoutEffect, useRef, useState } from "react";
import { error as logError } from "../../services/logger";
import { syntaxTokenStyles } from "../../theme/syntaxStyles";
import { openExternalUrl } from "../../utils/externalLinks";
import type { PreparationResponse } from "../../utils/markdownCodePreparation";
import { mountMarkdownDocument } from "../../utils/markdownDocumentPreview";
import { recordMarkdownPreparation } from "../../utils/markdownSyntax";

type DocumentView = Awaited<ReturnType<typeof mountMarkdownDocument>>;

interface RetainedDocumentPreparation {
  syntaxSession: Parameters<DocumentView["finish"]>[2];
  syntaxRanges: number;
  documentTimings?: unknown;
  transportTimings?: unknown;
}

export interface RetainedMarkdownPreviewProps {
  generation: { id: number; source: string };
  onExternalLink: () => void;
  resolveLink: (href: string) => string | null;
  prepareDocument: (request: {
    source: string;
    generation: number;
    signal: AbortSignal;
    onRecords: DocumentView["consume"];
    onDiagnostic: (diagnostic: Extract<PreparationResponse, { type: "diagnostic" }>) => void;
  }) => Promise<RetainedDocumentPreparation>;
}

export function RetainedMarkdownPreview({ generation, onExternalLink, resolveLink, prepareDocument }: RetainedMarkdownPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{ generation: number; message: string } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    const viewport = element?.parentElement?.parentElement;
    if (!element || !viewport) return;
    const controller = new AbortController();
    const prefix = `markdown-retained-${generation.id}`;
    let view: DocumentView | undefined;
    let syntaxSession: RetainedDocumentPreparation["syntaxSession"] | undefined;
    const style = document.createElement("style");
    style.textContent = Object.entries(syntaxTokenStyles)
      .map(
        ([selector, properties]) =>
          `::highlight(${prefix}-${selector.slice(".sambee-syntax-".length)}){color:${properties.color ?? "inherit"}}`
      )
      .join("\n");
    document.head.append(style);
    element.dataset["markdownRetainedState"] = "pending";
    const configureLink = (anchor: HTMLAnchorElement, href: string) => {
      const resolved = resolveLink(href);
      if (!resolved) {
        anchor.removeAttribute("href");
        return;
      }
      anchor.setAttribute("href", resolved);
      if (!resolved.startsWith("#")) {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
      }
    };
    const click = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      const href = anchor?.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      event.preventDefault();
      const resolved = resolveLink(href);
      if (!resolved) return;
      openExternalUrl(resolved);
      onExternalLink();
    };
    element.addEventListener("click", click);
    const start = performance.now();
    void (async () => {
      const mountedView = await mountMarkdownDocument(element, controller.signal, generation.source, {
        hostSearch: true,
        viewport,
        highlightPrefix: prefix,
        configureLink,
      });
      view = mountedView;
      controller.signal.throwIfAborted();
      const result = await prepareDocument({
        source: generation.source,
        generation: generation.id,
        signal: controller.signal,
        onDiagnostic: (diagnostic) => {
          logError(
            diagnostic.message,
            diagnostic.context,
            diagnostic.component,
            diagnostic.error ? new Error(diagnostic.error.message) : undefined
          );
        },
        onRecords: (records) => mountedView.consume(records),
      });
      syntaxSession = result.syntaxSession;
      controller.signal.throwIfAborted();
      if (!syntaxSession) throw new Error("Retained Markdown preparation returned no syntax session");
      view.finish(performance.now() - start, result.syntaxRanges, syntaxSession);
      recordMarkdownPreparation("retained-document-complete", start);
      Object.defineProperty(element, "retainedMarkdownStats", {
        configurable: true,
        value: () => ({ ...view?.stats(), documentTimings: result.documentTimings, transportTimings: result.transportTimings }),
      });
      element.dataset["markdownRetainedState"] = "complete";
    })().catch((error: unknown) => {
      syntaxSession?.dispose();
      view?.dispose();
      if (controller.signal.aborted) return;
      element.dataset["markdownRetainedState"] = "failed";
      logError(
        "Retained Markdown preview failed",
        { operation: "prepare-document" },
        "MarkdownViewer",
        error instanceof Error ? error : undefined
      );
      setFailure({ generation: generation.id, message: error instanceof Error ? error.message : "Markdown preview failed" });
    });
    return () => {
      controller.abort();
      syntaxSession?.dispose();
      view?.dispose();
      element.removeEventListener("click", click);
      style.remove();
      Reflect.deleteProperty(element, "retainedMarkdownStats");
    };
  }, [generation, onExternalLink, resolveLink, prepareDocument]);
  return (
    <>
      <div ref={host} data-markdown-retained-root="true" />
      {failure?.generation === generation.id ? <div role="alert">{failure.message}</div> : null}
    </>
  );
}
