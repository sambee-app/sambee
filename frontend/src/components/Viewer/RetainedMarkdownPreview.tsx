import { useLayoutEffect, useRef, useState } from "react";
import { error as logError } from "../../services/logger";
import { syntaxTokenStyles } from "../../theme/syntaxStyles";
import { openExternalUrl } from "../../utils/externalLinks";
import { prepareCodePreviewInWorker } from "../../utils/markdownCodePreparation";
import { mountMarkdownDocument } from "../../utils/markdownDocumentPreview";
import { recordMarkdownPreparation } from "../../utils/markdownSyntax";

interface RetainedMarkdownPreviewProps {
  generation: { id: number; source: string };
  onExternalLink: () => void;
  resolveLink: (href: string) => string | null;
}

export function RetainedMarkdownPreview({ generation, onExternalLink, resolveLink }: RetainedMarkdownPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{ generation: number; message: string } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    const viewport = element?.parentElement?.parentElement;
    if (!element || !viewport) return;
    const controller = new AbortController();
    const prefix = `markdown-retained-${generation.id}`;
    let view: Awaited<ReturnType<typeof mountMarkdownDocument>> | undefined;
    let syntaxSession: Awaited<ReturnType<typeof prepareCodePreviewInWorker>>["syntaxSession"];
    const style = document.createElement("style");
    style.textContent = Object.entries(syntaxTokenStyles)
      .map(
        ([selector, properties]) =>
          `::highlight(${prefix}-${selector.slice(".sambee-syntax-".length)}){color:${properties.color ?? "inherit"}}`
      )
      .join("\n");
    document.head.append(style);
    element.dataset.markdownRetainedState = "pending";
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
      view = await mountMarkdownDocument(element, controller.signal, generation.source, {
        hostSearch: true,
        viewport,
        highlightPrefix: prefix,
        configureLink,
      });
      const result = await prepareCodePreviewInWorker(
        [generation.source],
        generation.id,
        controller.signal,
        (diagnostic) => {
          logError(
            diagnostic.message,
            diagnostic.context,
            diagnostic.component,
            diagnostic.error ? new Error(diagnostic.error.message) : undefined
          );
        },
        (records) => view!.consume(records),
        { isolated: true, canonicalSource: true }
      );
      syntaxSession = result.syntaxSession;
      controller.signal.throwIfAborted();
      if (!syntaxSession) throw new Error("Retained Markdown preparation returned no syntax session");
      view.finish(performance.now() - start, result.syntaxRanges, syntaxSession);
      recordMarkdownPreparation("retained-document-complete", start);
      Object.defineProperty(element, "retainedMarkdownStats", {
        configurable: true,
        value: () => ({ ...view?.stats(), documentTimings: result.documentTimings, transportTimings: result.transportTimings }),
      });
      element.dataset.markdownRetainedState = "complete";
    })().catch((error: unknown) => {
      syntaxSession?.dispose();
      if (controller.signal.aborted) return;
      view?.dispose();
      element.dataset.markdownRetainedState = "failed";
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
  }, [generation, onExternalLink, resolveLink]);
  return (
    <>
      <div ref={host} data-markdown-retained-root="true" />
      {failure?.generation === generation.id ? <div role="alert">{failure.message}</div> : null}
    </>
  );
}
