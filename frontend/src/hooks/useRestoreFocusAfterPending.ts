import { useEffect, useRef } from "react";

/** Restores focus after a pending state temporarily disables the active control. */
export function useRestoreFocusAfterPending(pending: boolean): () => void {
  const focusTarget = useRef<HTMLElement | null>(null);
  const wasPending = useRef(pending);

  useEffect(() => {
    if (wasPending.current && !pending) {
      const target = focusTarget.current;
      focusTarget.current = null;

      const activeElement = document.activeElement;
      const focusFellBack =
        activeElement === document.body ||
        (activeElement instanceof HTMLElement && activeElement.tabIndex === -1 && target !== null && activeElement.contains(target));

      if (focusFellBack && target?.isConnected && !target.matches(":disabled")) {
        target.focus();
      }
    }

    wasPending.current = pending;
  }, [pending]);

  return () => {
    const activeElement = document.activeElement;
    focusTarget.current = activeElement instanceof HTMLElement ? activeElement : null;
  };
}
