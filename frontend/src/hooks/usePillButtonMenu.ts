import type React from "react";
import { useRef, useState } from "react";

const SPACE_TRIGGER_KEYS = new Set([" ", "Space", "Spacebar"]);

interface PillButtonMenuOptions {
  openOnSpaceKeyDown?: boolean;
  restoreFocus?: boolean;
}

function hasModifierKey(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

function isSpaceTriggerKey(key: string): boolean {
  return SPACE_TRIGGER_KEYS.has(key);
}

/**
 * usePillButtonMenu
 *
 * Custom hook for managing menu state and focus behavior for pill button components.
 * Automatically blurs the button and calls onAfterClose when menu closes,
 * ensuring keyboard focus is properly transferred (e.g., to file list).
 */
export function usePillButtonMenu(onAfterClose?: () => void, options?: PillButtonMenuOptions) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const pendingSpaceActivationRef = useRef<HTMLElement | null>(null);
  const suppressSpaceKeyUpRef = useRef<HTMLElement | null>(null);
  const suppressNextClickRef = useRef<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const openMenu = (element: HTMLElement) => {
    setAnchorEl(element);
  };

  const handleClick = (event: React.MouseEvent<HTMLElement>) => {
    if (suppressNextClickRef.current === event.currentTarget) {
      suppressNextClickRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    setAnchorEl(event.currentTarget);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      setAnchorEl(event.currentTarget);
      return;
    }

    if (event.key === "ArrowDown" && !hasModifierKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      setAnchorEl(event.currentTarget);
      return;
    }

    if (isSpaceTriggerKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();

      if (options?.openOnSpaceKeyDown) {
        suppressSpaceKeyUpRef.current = event.currentTarget;
        suppressNextClickRef.current = event.currentTarget;
        setAnchorEl(event.currentTarget);
        return;
      }

      pendingSpaceActivationRef.current = event.currentTarget;
      return;
    }

    if (event.key === "Escape" && onAfterClose) {
      event.preventDefault();
      onAfterClose();
    }
  };

  const handleKeyUp = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isSpaceTriggerKey(event.key)) {
      return;
    }

    if (suppressSpaceKeyUpRef.current === event.currentTarget) {
      suppressSpaceKeyUpRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (pendingSpaceActivationRef.current !== event.currentTarget) {
      return;
    }

    pendingSpaceActivationRef.current = null;
    event.preventDefault();
    event.stopPropagation();
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    const buttonEl = anchorEl;
    pendingSpaceActivationRef.current = null;
    suppressSpaceKeyUpRef.current = null;
    suppressNextClickRef.current = null;
    setAnchorEl(null);
    if (options?.restoreFocus) return;
    // Defer focus change to ensure menu closes first
    setTimeout(() => {
      if (buttonEl) {
        buttonEl.blur();
      }
      onAfterClose?.();
    }, 0);
  };

  return {
    anchorEl,
    open,
    handleClick,
    handleKeyDown,
    handleKeyUp,
    handleClose,
    openMenu,
  };
}
