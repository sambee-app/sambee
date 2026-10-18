import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { parseViewerRoute } from "../pages/FileBrowser/routing";

interface BlockedTransition {
  proceed: () => void;
  reset: () => void;
}
export interface ViewerLeaveGuard {
  shouldBlock: () => boolean;
  requestLeave: (transition: BlockedTransition) => void;
}
export interface ViewerNavigation {
  mode: "view" | "edit";
  onModeChange: (mode: "view" | "edit", replace?: boolean) => void;
  onGuardChange: (guard: ViewerLeaveGuard | null) => void;
}

export function WorkspaceNavigationGuard({ guard }: { guard: ViewerLeaveGuard }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (!guard.shouldBlock()) return false;
    const current = parseViewerRoute(new URLSearchParams(currentLocation.search), true);
    const next = parseViewerRoute(new URLSearchParams(nextLocation.search), true);
    return (
      currentLocation.pathname !== nextLocation.pathname ||
      !current ||
      !next ||
      (current.mode === "edit" && next.mode !== "edit") ||
      JSON.stringify(current.file) !== JSON.stringify(next.file) ||
      current.viewerId !== next.viewerId ||
      current.paneId !== next.paneId
    );
  });
  const requested = useRef<string | null>(null);
  useEffect(() => {
    if (blocker.state !== "blocked") {
      requested.current = null;
      return;
    }
    if (requested.current === blocker.location.key) return;
    requested.current = blocker.location.key;
    guard.requestLeave({ proceed: blocker.proceed, reset: blocker.reset });
  }, [blocker, guard]);
  return null;
}

export function useRoutedViewerEditing({
  navigation,
  isEditing,
  isSaving,
  isAcquiring,
  loading,
  dirty,
  enterEdit,
  exitEdit,
  cancelAcquisition,
  requestUnsavedChanges,
}: {
  navigation?: ViewerNavigation;
  isEditing: boolean;
  isSaving: boolean;
  isAcquiring: boolean;
  loading: boolean;
  dirty: boolean;
  enterEdit: () => Promise<boolean>;
  exitEdit: () => Promise<void>;
  cancelAcquisition: () => void;
  requestUnsavedChanges: () => void;
}) {
  const pending = useRef<BlockedTransition | null>(null);
  const alive = useRef(true);
  const acquisitionCancelled = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [requested, setRequested] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const exitPromise = useRef<Promise<void> | null>(null);
  const blocking = useRef(false);
  blocking.current = dirty || isSaving || isAcquiring;
  const attemptedMode = useRef<string | null>(null);
  const enter = useEffectEvent(enterEdit);
  const exit = useEffectEvent(() => {
    if (exitPromise.current) return exitPromise.current;
    setIsExiting(true);
    const promise = exitEdit().finally(() => {
      exitPromise.current = null;
      if (alive.current) setIsExiting(false);
    });
    exitPromise.current = promise;
    return promise;
  });
  const changeMode = useEffectEvent((mode: "view" | "edit", replace = false) => navigation?.onModeChange(mode, replace));
  const cancelAcquire = useEffectEvent(cancelAcquisition);
  const showUnsaved = useEffectEvent(requestUnsavedChanges);
  const requestLeave = useEffectEvent((transition: BlockedTransition) => {
    acquisitionCancelled.current = true;
    cancelAcquire();
    pending.current = transition;
    setRequested(true);
  });
  const onGuardChange = navigation?.onGuardChange;
  const active = isEditing || isAcquiring || isSaving;
  useEffect(() => {
    if (!onGuardChange || !active) return;
    onGuardChange({ requestLeave, shouldBlock: () => blocking.current });
    return () => onGuardChange(null);
  }, [onGuardChange, active]);

  useEffect(() => {
    if (!requested || isSaving) return;
    if (dirty) showUnsaved();
    else {
      const transition = pending.current;
      if (!transition) return;
      pending.current = null;
      setRequested(false);
      void exit().then(() => transition?.proceed());
    }
  }, [requested, isSaving, dirty]);

  useEffect(() => {
    const mode = navigation?.mode;
    if (!mode || loading || isAcquiring || isExiting || exitPromise.current || attemptedMode.current === mode) return;
    attemptedMode.current = mode;
    if (mode === "edit" && !isEditing) {
      acquisitionCancelled.current = false;
      void enter().then((success) => {
        if (!success && alive.current && !acquisitionCancelled.current) changeMode("view", true);
      });
    } else if (mode === "view" && isEditing && !pending.current) void exit();
  }, [navigation?.mode, loading, isAcquiring, isEditing, isExiting]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return {
    isExiting,
    cancelNavigation: () => {
      pending.current?.reset();
      pending.current = null;
      setRequested(false);
    },
    completeNavigation: async () => {
      const transition = pending.current;
      if (!transition) return false;
      pending.current = null;
      setRequested(false);
      await exit();
      transition.proceed();
      return true;
    },
  };
}
