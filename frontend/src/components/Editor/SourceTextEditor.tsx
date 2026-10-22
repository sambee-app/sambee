import { Annotation, Compartment, EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { type Command, EditorView, type ViewUpdate } from "@codemirror/view";
import { useTheme } from "@mui/material";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { getSyntaxVariables } from "../../theme/syntaxStyles";
import { CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE } from "../../theme/viewerStyles";
import { getCodeMirrorHorizontalInset } from "./getCodeMirrorHorizontalInset";
import type { SourceTextEditorHandle, SourceTextEditorProps } from "./sourceTextEditorTypes";

const EXTERNAL_SYNC_ANNOTATION = Annotation.define<boolean>();

const sourceTextEditorBaseTheme = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-editor": {
    height: "100%",
  },
  ".cm-scroller": {
    overflow: "auto",
    minHeight: "100%",
  },
  ".cm-content": {
    minHeight: "100%",
    boxSizing: "border-box",
    padding: `16px var(${CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE}, 16px) 16px var(${CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE}, 16px)`,
  },
  ".cm-line": {
    padding: 0,
  },
});

const sourceTextEditorScrollMargins = EditorView.scrollMargins.of((view) => {
  const horizontalInset = getCodeMirrorHorizontalInset(view);
  return { left: horizontalInset, right: horizontalInset };
});

interface PreservedSelectionSnapshot {
  selection: {
    ranges: Array<{
      anchor: number;
      head: number;
    }>;
    main: number;
  };
  scrollTop: number;
  scrollLeft: number;
}

function createReadOnlyExtension(readOnly: boolean) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function createContentAttributesExtension(ariaLabel: string, contentAttributes: Record<string, string> = {}) {
  return EditorView.contentAttributes.of({ "aria-label": ariaLabel, ...contentAttributes });
}

function clampSelectionSnapshot(snapshot: PreservedSelectionSnapshot, docLength: number): PreservedSelectionSnapshot {
  return {
    ...snapshot,
    selection: {
      main: Math.min(snapshot.selection.main, Math.max(snapshot.selection.ranges.length - 1, 0)),
      ranges: snapshot.selection.ranges.map((range) => ({
        anchor: Math.min(range.anchor, docLength),
        head: Math.min(range.head, docLength),
      })),
    },
  };
}

export const SourceTextEditor = forwardRef<SourceTextEditorHandle, SourceTextEditorProps>(
  (
    {
      value,
      extensions = [],
      readOnly = false,
      autoFocus = false,
      ariaLabel,
      contentAttributes,
      className,
      onChange,
      onUserEdit,
      onUpdate,
    },
    ref
  ) => {
    const muiTheme = useTheme();
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const revisionRef = useRef(0);
    const preservedSelectionRef = useRef<PreservedSelectionSnapshot | null>(null);
    const readOnlyCompartmentRef = useRef(new Compartment());
    const extensionsCompartmentRef = useRef(new Compartment());
    const contentAttributesCompartmentRef = useRef(new Compartment());
    const initialValueRef = useRef(value);
    const publishedValueRef = useRef(value);
    const initialExtensionsRef = useRef(extensions);
    const appliedExtensionsRef = useRef(extensions);
    const initialReadOnlyRef = useRef(readOnly);
    const initialAutoFocusRef = useRef(autoFocus);
    const initialAriaLabelRef = useRef(ariaLabel);
    const initialContentAttributesRef = useRef(contentAttributes);
    const onChangeRef = useRef(onChange);
    const onUserEditRef = useRef(onUserEdit);
    const onUpdateRef = useRef(onUpdate);

    useEffect(() => {
      onChangeRef.current = onChange;
      onUserEditRef.current = onUserEdit;
      onUpdateRef.current = onUpdate;
    }, [onChange, onUpdate, onUserEdit]);

    useEffect(() => {
      const container = containerRef.current;

      if (!container || viewRef.current) {
        return;
      }

      const updateListener = EditorView.updateListener.of((viewUpdate: ViewUpdate) => {
        if (viewUpdate.docChanged) revisionRef.current += 1;
        onUpdateRef.current?.(viewUpdate, viewUpdate.view);

        if (!viewUpdate.docChanged) {
          return;
        }

        const isExternalSync = viewUpdate.transactions.some((transaction) => transaction.annotation(EXTERNAL_SYNC_ANNOTATION) === true);

        if (isExternalSync) {
          return;
        }

        onUserEditRef.current?.(viewUpdate);
        const nextValue = viewUpdate.state.doc.toString();
        publishedValueRef.current = nextValue;
        onChangeRef.current(nextValue, viewUpdate);
      });

      const initialState = EditorState.create({
        doc: initialValueRef.current,
        extensions: [
          sourceTextEditorBaseTheme,
          sourceTextEditorScrollMargins,
          updateListener,
          readOnlyCompartmentRef.current.of(createReadOnlyExtension(initialReadOnlyRef.current)),
          extensionsCompartmentRef.current.of(initialExtensionsRef.current),
          contentAttributesCompartmentRef.current.of(
            createContentAttributesExtension(initialAriaLabelRef.current, initialContentAttributesRef.current)
          ),
        ],
      });

      const view = new EditorView({
        state: initialState,
        parent: container,
      });

      viewRef.current = view;

      if (initialAutoFocusRef.current) {
        window.requestAnimationFrame(() => {
          view.focus();
        });
      }

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;

      if (!view) {
        return;
      }

      view.dispatch({ effects: readOnlyCompartmentRef.current.reconfigure(createReadOnlyExtension(readOnly)) });
    }, [readOnly]);

    useEffect(() => {
      const view = viewRef.current;

      if (!view) {
        return;
      }

      view.dispatch({
        effects: contentAttributesCompartmentRef.current.reconfigure(createContentAttributesExtension(ariaLabel, contentAttributes)),
      });
    }, [ariaLabel, contentAttributes]);

    useEffect(() => {
      const view = viewRef.current;

      if (!view) {
        return;
      }

      if (appliedExtensionsRef.current === extensions) {
        return;
      }

      appliedExtensionsRef.current = extensions;
      view.dispatch({
        effects: extensionsCompartmentRef.current.reconfigure(extensions),
      });
    }, [extensions]);

    useEffect(() => {
      const view = viewRef.current;

      if (!view) {
        return;
      }

      if (publishedValueRef.current === value) {
        return;
      }

      publishedValueRef.current = value;
      const currentSelection = view.state.selection.main;
      const nextAnchor = Math.min(currentSelection.anchor, value.length);
      const nextHead = Math.min(currentSelection.head, value.length);

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        selection: { anchor: nextAnchor, head: nextHead },
        annotations: EXTERNAL_SYNC_ANNOTATION.of(true),
      });
    }, [value]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          viewRef.current?.focus();
        },
        captureSnapshot: () => {
          const view = viewRef.current;
          if (!view) throw new Error("Cannot capture a snapshot after the source editor is disposed");
          if (
            view.compositionStarted ||
            Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-editor")).some(
              (element) => EditorView.findFromDOM(element)?.compositionStarted
            )
          ) {
            throw new DOMException(
              "Finish the current input method composition before saving or creating a recovery snapshot.",
              "InvalidStateError"
            );
          }
          const doc = view.state.doc;
          return Object.freeze({ revision: revisionRef.current, serialize: () => doc.toString() });
        },
        getValue: () => viewRef.current?.state.doc.toString() ?? value,
        getPrimarySelectionText: () => {
          const view = viewRef.current;

          if (!view) {
            return "";
          }

          const mainSelection = view.state.selection.main;

          if (mainSelection.empty) {
            return "";
          }

          return view.state.sliceDoc(mainSelection.from, mainSelection.to);
        },
        getView: () => viewRef.current,
        preserveSelection: () => {
          const view = viewRef.current;

          if (!view) {
            preservedSelectionRef.current = null;
            return;
          }

          preservedSelectionRef.current = {
            selection: view.state.selection.toJSON(),
            scrollTop: view.scrollDOM.scrollTop,
            scrollLeft: view.scrollDOM.scrollLeft,
          };
        },
        restorePreservedSelection: () => {
          const view = viewRef.current;
          const snapshot = preservedSelectionRef.current;

          if (!view || !snapshot) {
            return false;
          }

          const clampedSnapshot = clampSelectionSnapshot(snapshot, view.state.doc.length);

          view.dispatch({
            selection: EditorSelection.fromJSON(clampedSnapshot.selection),
            scrollIntoView: false,
          });
          view.focus();
          view.scrollDOM.scrollTop = clampedSnapshot.scrollTop;
          view.scrollDOM.scrollLeft = clampedSnapshot.scrollLeft;

          return view.hasFocus;
        },
        dispatch: (...specs: TransactionSpec[]) => {
          const view = viewRef.current;

          if (!view || specs.length === 0) {
            return;
          }

          view.dispatch(...specs);
        },
        runCommand: (command: Command) => {
          const view = viewRef.current;

          if (!view) {
            return false;
          }

          return command(view);
        },
      }),
      [value]
    );

    return <div ref={containerRef} className={className} style={getSyntaxVariables(muiTheme)} />;
  }
);

SourceTextEditor.displayName = "SourceTextEditor";
