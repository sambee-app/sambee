import type { ViewUpdate } from "@codemirror/view";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

const USER_EDIT_EVENTS = ["input", "delete", "move", "undo", "redo"] as const;

function hasExplicitUserEdit(viewUpdate: ViewUpdate): boolean {
  return viewUpdate.transactions.some((transaction) => USER_EDIT_EVENTS.some((event) => transaction.isUserEvent(event)));
}

interface UseMarkdownEditSessionOptions {
  isEditing: boolean;
  isSaving: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  hasPendingUnsavedChangesAction: boolean;
  restoreEditingFocus: () => (() => void) | undefined;
  setDraftContent: (markdown: string) => void;
  setEditBaselineContent: (markdown: string) => void;
}

export interface MarkdownEditSessionController {
  beginBaselineSyncWindow: () => void;
  clearBaselineSyncWindow: () => void;
  clearPendingBaselineSync: () => void;
  handleEditorChange: (markdown: string) => void;
  handleEditorUserEdit: (viewUpdate?: ViewUpdate) => void;
  getEditGeneration: () => number;
  hasUserEditedInSession: boolean;
  markEditSessionPristine: () => void;
  requestRestoreEditingFocus: () => void;
}

export function useMarkdownEditSession({
  isEditing,
  isSaving,
  contentRef,
  hasPendingUnsavedChangesAction,
  restoreEditingFocus,
  setDraftContent,
  setEditBaselineContent,
}: UseMarkdownEditSessionOptions): MarkdownEditSessionController {
  const hasUserEditedRef = useRef(false);
  const editGenerationRef = useRef(0);
  const [hasUserEditedInSession, setHasUserEditedInSession] = useState(false);
  const allowBaselineSyncRef = useRef(false);
  const pendingRestoreEditorFocusRef = useRef(false);
  const pendingBaselineSyncRequestIdRef = useRef(0);

  const clearPendingBaselineSync = useCallback(() => {
    pendingBaselineSyncRequestIdRef.current += 1;
  }, []);

  const clearBaselineSyncWindow = useCallback(() => {
    allowBaselineSyncRef.current = false;
  }, []);

  const beginBaselineSyncWindow = useCallback(() => {
    clearBaselineSyncWindow();
    allowBaselineSyncRef.current = true;
  }, [clearBaselineSyncWindow]);

  const markEditSessionPristine = useCallback(() => {
    hasUserEditedRef.current = false;
    setHasUserEditedInSession(false);
  }, []);

  const getEditGeneration = useCallback(() => editGenerationRef.current, []);

  const requestRestoreEditingFocus = useCallback(() => {
    pendingRestoreEditorFocusRef.current = true;
  }, []);

  const handleEditorChange = useCallback(
    (nextMarkdown: string) => {
      editGenerationRef.current += 1;
      if (isEditing && allowBaselineSyncRef.current && !hasUserEditedRef.current) {
        clearPendingBaselineSync();
        const requestId = pendingBaselineSyncRequestIdRef.current;

        queueMicrotask(() => {
          if (pendingBaselineSyncRequestIdRef.current !== requestId) {
            return;
          }

          if (allowBaselineSyncRef.current && !hasUserEditedRef.current) {
            setEditBaselineContent(nextMarkdown);
            return;
          }

          setDraftContent(nextMarkdown);
        });

        return;
      }

      setDraftContent(nextMarkdown);
    },
    [clearPendingBaselineSync, isEditing, setDraftContent, setEditBaselineContent]
  );

  const handleEditorUserEdit = useCallback(
    (viewUpdate?: ViewUpdate) => {
      if (allowBaselineSyncRef.current && viewUpdate && !hasExplicitUserEdit(viewUpdate)) {
        return;
      }

      clearBaselineSyncWindow();
      editGenerationRef.current += 1;
      hasUserEditedRef.current = true;
      setHasUserEditedInSession(true);
    },
    [clearBaselineSyncWindow]
  );

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const interactionRoot = contentRef.current;

    if (!interactionRoot) {
      return;
    }

    const handleEditorInteractionStart = (event: Event) => {
      const target = event.target;

      if (target instanceof Element && target.closest('.cm-editor, [contenteditable="true"], textarea')) {
        clearBaselineSyncWindow();
      }
    };

    const handleToolbarInteractionStart = (event: Event) => {
      const target = event.target;

      if (target instanceof HTMLElement && target.closest('[data-toolbar-item="true"], [data-toolbar-item]')) {
        clearBaselineSyncWindow();
      }
    };

    interactionRoot.addEventListener("keydown", handleEditorInteractionStart);
    interactionRoot.addEventListener("pointerdown", handleEditorInteractionStart);
    interactionRoot.addEventListener("beforeinput", handleEditorInteractionStart);
    interactionRoot.addEventListener("paste", handleEditorInteractionStart);
    interactionRoot.addEventListener("cut", handleEditorInteractionStart);
    interactionRoot.addEventListener("drop", handleEditorInteractionStart);
    interactionRoot.addEventListener("keydown", handleToolbarInteractionStart);
    interactionRoot.addEventListener("pointerdown", handleToolbarInteractionStart);

    return () => {
      interactionRoot.removeEventListener("keydown", handleEditorInteractionStart);
      interactionRoot.removeEventListener("pointerdown", handleEditorInteractionStart);
      interactionRoot.removeEventListener("beforeinput", handleEditorInteractionStart);
      interactionRoot.removeEventListener("paste", handleEditorInteractionStart);
      interactionRoot.removeEventListener("cut", handleEditorInteractionStart);
      interactionRoot.removeEventListener("drop", handleEditorInteractionStart);
      interactionRoot.removeEventListener("keydown", handleToolbarInteractionStart);
      interactionRoot.removeEventListener("pointerdown", handleToolbarInteractionStart);
    };
  }, [clearBaselineSyncWindow, contentRef, isEditing]);

  useEffect(() => {
    if (!isEditing || isSaving || !pendingRestoreEditorFocusRef.current || hasPendingUnsavedChangesAction) {
      return;
    }

    pendingRestoreEditorFocusRef.current = false;

    return restoreEditingFocus();
  }, [hasPendingUnsavedChangesAction, isEditing, isSaving, restoreEditingFocus]);

  useEffect(() => {
    return () => {
      clearPendingBaselineSync();
      clearBaselineSyncWindow();
    };
  }, [clearBaselineSyncWindow, clearPendingBaselineSync]);

  return {
    beginBaselineSyncWindow,
    clearBaselineSyncWindow,
    clearPendingBaselineSync,
    handleEditorChange,
    handleEditorUserEdit,
    getEditGeneration,
    hasUserEditedInSession,
    markEditSessionPristine,
    requestRestoreEditingFocus,
  };
}
