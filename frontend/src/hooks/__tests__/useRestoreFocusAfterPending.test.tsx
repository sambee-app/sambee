import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRestoreFocusAfterPending } from "../useRestoreFocusAfterPending";

describe("useRestoreFocusAfterPending", () => {
  const elements: HTMLElement[] = [];

  const createButton = () => {
    const button = document.createElement("button");
    document.body.append(button);
    elements.push(button);
    return button;
  };

  afterEach(() => {
    for (const element of elements) element.remove();
    elements.length = 0;
  });

  it.each(["body", "container"])("restores a temporarily disabled control when focus falls back to its %s", (fallback) => {
    const control = createButton();
    const container = document.createElement("div");
    container.tabIndex = -1;
    document.body.append(container);
    elements.push(container);
    container.append(control);
    control.focus();
    const { result, rerender } = renderHook(({ pending }) => useRestoreFocusAfterPending(pending), {
      initialProps: { pending: false },
    });

    act(() => result.current());
    rerender({ pending: true });
    control.disabled = true;
    control.blur();
    if (fallback === "container") container.focus();
    control.disabled = false;
    rerender({ pending: false });

    expect(control).toHaveFocus();
  });

  it("does not steal focus after the user focuses another element", () => {
    const control = createButton();
    const otherControl = createButton();
    control.focus();
    const { result, rerender } = renderHook(({ pending }) => useRestoreFocusAfterPending(pending), {
      initialProps: { pending: false },
    });

    act(() => result.current());
    rerender({ pending: true });
    control.disabled = true;
    otherControl.focus();
    control.disabled = false;
    rerender({ pending: false });

    expect(otherControl).toHaveFocus();
  });
});
