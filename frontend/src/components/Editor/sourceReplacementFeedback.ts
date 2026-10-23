import { getSearchQuery } from "@codemirror/search";
import { StateEffect } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { t } from "i18next";

export const SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS = 200;
export const SOURCE_REPLACEMENT_HEAVY_MATCHES = 1_000;
export const SOURCE_REPLACEMENT_HEAVY_UNITS = 50_000;
const FEEDBACK_CLASS = "sambee-source-replacement-feedback";
const feedbackUpdated = StateEffect.define<null>();

const pending = new WeakMap<EditorView, SourceReplacementFeedback>();

const feedbackTheme = EditorView.baseTheme({
  [`& .${FEEDBACK_CLASS}`]: {
    position: "absolute",
    bottom: "8px",
    right: "16px",
    zIndex: "5",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px",
    borderRadius: "4px",
    backgroundColor: "Canvas",
    color: "CanvasText",
    boxShadow: "0 1px 4px #0004",
    pointerEvents: "none",
    fontSize: "13px",
  },
  [`& .${FEEDBACK_CLASS} .sambee-replacement-spinner`]: {
    width: "14px",
    height: "14px",
    flexShrink: "0",
    border: "2px solid currentColor",
    borderRightColor: "transparent",
    borderRadius: "50%",
  },
});

const feedbackLifecycle = ViewPlugin.fromClass(
  class {
    constructor(private view: EditorView) {}

    update() {
      const feedback = pending.get(this.view);
      if (feedback && !feedback.current()) feedback.dispose();
    }

    destroy() {
      pending.get(this.view)?.dispose();
    }
  }
);

export const sourceReplacementFeedbackExtension = [feedbackLifecycle, feedbackTheme];

export function isSourceReplacementPending(view: EditorView): boolean {
  return pending.has(view);
}

export function isHeavySourceReplacement(documentUnits: number, matches: number, insertedUnits: number): boolean {
  return matches >= SOURCE_REPLACEMENT_HEAVY_MATCHES && Math.max(documentUnits, insertedUnits) >= SOURCE_REPLACEMENT_HEAVY_UNITS;
}

export function beginSourceReplacementFeedback(view: EditorView, onDispose?: () => void): SourceReplacementFeedback {
  if (!view.plugin(feedbackLifecycle)) view.dispatch({ effects: StateEffect.appendConfig.of(sourceReplacementFeedbackExtension) });
  pending.get(view)?.dispose();
  const feedback = new SourceReplacementFeedback(view, onDispose);
  pending.set(view, feedback);
  feedback.notify();
  return feedback;
}

class SourceReplacementFeedback {
  private readonly document;
  private readonly query;
  private readonly selection;
  private indicator?: HTMLElement;
  private animation?: Animation;
  private delayTimer?: ReturnType<typeof setTimeout>;
  private hiddenTimer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private disposed = false;
  private applyPending?: () => void;

  constructor(
    private readonly view: EditorView,
    private readonly onDispose?: () => void
  ) {
    this.document = view.state.doc;
    this.query = getSearchQuery(view.state);
    this.selection = view.state.selection;
    this.delayTimer = setTimeout(() => this.show(), SOURCE_REPLACEMENT_FEEDBACK_DELAY_MS);
  }

  current(): boolean {
    return (
      !this.disposed &&
      !this.view.destroyed &&
      this.view.state.doc === this.document &&
      this.view.state.selection === this.selection &&
      this.query.eq(getSearchQuery(this.view.state)) &&
      !this.view.state.readOnly
    );
  }

  notify(): void {
    queueMicrotask(() => {
      if (!this.view.destroyed) this.view.dispatch({ effects: feedbackUpdated.of(null) });
    });
  }

  private show(): void {
    if (!this.current() || this.indicator) return;
    const indicator = this.view.dom.ownerDocument.createElement("div");
    indicator.className = FEEDBACK_CLASS;
    indicator.setAttribute("role", "status");
    indicator.textContent = t("viewer.edit.replacing", { defaultValue: "Replacing matches..." });
    const spinner = this.view.dom.ownerDocument.createElement("span");
    spinner.className = "sambee-replacement-spinner";
    spinner.setAttribute("aria-hidden", "true");
    indicator.prepend(spinner);
    this.view.dom.append(indicator);
    if (!this.view.dom.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.animation = spinner.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
        duration: 800,
        iterations: Number.POSITIVE_INFINITY,
      });
    }
    this.view.contentDOM.setAttribute("aria-busy", "true");
    this.indicator = indicator;
  }

  apply(action: () => void, heavy: boolean, onError: (error: unknown) => void): void {
    clearTimeout(this.delayTimer);
    const commit = () => {
      try {
        if (this.current()) action();
      } catch (error) {
        onError(error);
      } finally {
        this.dispose();
      }
    };
    if (!this.indicator && !heavy) {
      commit();
      return;
    }
    this.show();
    this.applyPending = commit;
    const document = this.view.dom.ownerDocument;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    if (document.hidden) {
      this.hiddenTimer = setTimeout(commit, 0);
    } else {
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(commit);
      });
    }
  }

  private onVisibilityChange = (): void => {
    if (!this.view.dom.ownerDocument.hidden || !this.applyPending) return;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    clearTimeout(this.hiddenTimer);
    this.hiddenTimer = setTimeout(this.applyPending, 0);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.delayTimer);
    clearTimeout(this.hiddenTimer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.view.dom.ownerDocument.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.applyPending = undefined;
    this.animation?.cancel();
    this.indicator?.remove();
    this.view.contentDOM.removeAttribute("aria-busy");
    if (pending.get(this.view) === this) pending.delete(this.view);
    this.onDispose?.();
    this.notify();
  }
}
