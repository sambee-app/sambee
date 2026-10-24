import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useRef } from "react";

interface UseSelectableListboxOptions<T extends string> {
  open: boolean;
  options: ReadonlyArray<{ value: T }>;
  selectedValue: T;
  onSelectValue: (value: T) => void;
  onConfirm?: () => void;
}

interface UseSelectableListboxResult {
  listRef: (listElement: HTMLUListElement | null) => void;
  focusList: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
}

/**
 * Shared chooser/listbox behavior for dialog-based pickers.
 *
 * Owns two concerns that are easy to duplicate incorrectly:
 * - handing initial focus to a portaled listbox when the dialog opens
 * - keyboard navigation and activation for a selected list option
 */
export function useSelectableListbox<T extends string>({
  open,
  options,
  selectedValue,
  onSelectValue,
  onConfirm,
}: UseSelectableListboxOptions<T>): UseSelectableListboxResult {
  const listElementRef = useRef<HTMLUListElement | null>(null);

  const focusList = useCallback(() => {
    const listElement = listElementRef.current;
    if (!listElement) {
      return;
    }

    listElement.focus();
  }, []);

  const listRef = useCallback(
    (listElement: HTMLUListElement | null) => {
      listElementRef.current = listElement;

      if (!open || !listElement) {
        return;
      }

      listElement.focus();
      queueMicrotask(() => {
        listElement.focus();
      });
      window.requestAnimationFrame(() => {
        listElement.focus();
      });
    },
    [open]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLUListElement>) => {
      if (options.length === 0) {
        return;
      }

      const currentIndex = Math.max(
        0,
        options.findIndex((option) => option.value === selectedValue)
      );
      const selectIndex = (index: number) => {
        const option = options[index];
        if (option) onSelectValue(option.value);
      };

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const nextIndex = Math.min(currentIndex + 1, options.length - 1);
          selectIndex(nextIndex);
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const nextIndex = Math.max(currentIndex - 1, 0);
          selectIndex(nextIndex);
          break;
        }
        case "Home": {
          event.preventDefault();
          selectIndex(0);
          break;
        }
        case "End": {
          event.preventDefault();
          selectIndex(options.length - 1);
          break;
        }
        case "Enter":
        case " ": {
          if (!onConfirm) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          onConfirm();
          break;
        }
      }
    },
    [onConfirm, onSelectValue, options, selectedValue]
  );

  return {
    listRef,
    focusList,
    onKeyDown,
  };
}
