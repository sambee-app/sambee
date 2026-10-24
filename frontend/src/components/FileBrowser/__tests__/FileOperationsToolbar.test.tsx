import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileOperationAction } from "../../../pages/FileBrowser/fileOperationActions";
import { requireTestValue } from "../../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { FileOperationsToolbar } from "../FileOperationsToolbar";

function createAction(id: FileOperationAction["id"], overrides: Partial<FileOperationAction> = {}): FileOperationAction {
  return {
    id,
    surface: "desktop-toolbar",
    scope: "selection",
    priority: 1,
    label: id,
    shortcut: "F1",
    tooltip: `${id} (F1)`,
    enabled: true,
    onClick: vi.fn(),
    ...overrides,
  };
}

function renderToolbar(actions: FileOperationAction[]) {
  return render(
    <SambeeThemeProvider>
      <FileOperationsToolbar actions={actions} moreLabel="More" />
    </SambeeThemeProvider>
  );
}

describe("FileOperationsToolbar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders text command buttons and delegates enabled actions", () => {
    const onClick = vi.fn();
    renderToolbar([createAction("copy", { label: "Copy", tooltip: "Copy (F5)", onClick })]);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not clip the first command's focus indicator", () => {
    renderToolbar([createAction("new-directory", { label: "New folder" })]);

    const toolbar = screen.getByTestId("file-operations-toolbar");
    expect(getComputedStyle(toolbar).overflow).toBe("visible");
    expect(getComputedStyle(toolbar.parentElement as HTMLElement).height).toBe("44px");
    expect(getComputedStyle(toolbar.parentElement as HTMLElement).paddingLeft).toBe("4px");
    expect(getComputedStyle(screen.getByRole("button", { name: "New folder" })).minHeight).toBe("36px");
  });

  it("does not invoke disabled actions", () => {
    const onClick = vi.fn();
    renderToolbar([createAction("delete", { label: "Delete", enabled: false, onClick })]);

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows the command shortcut in a button tooltip", async () => {
    const user = userEvent.setup();
    renderToolbar([createAction("copy", { label: "Copy", tooltip: "Copy (F5)" })]);

    await user.hover(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copy (F5)");
  });

  it("renders an accessible vertical-dots control for overflowing commands", async () => {
    const user = userEvent.setup();
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(_target: Element) {
          observers.at(-1)?.([{ contentRect: { width: 180 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset["operationId"]) return { width: 100 } as DOMRect;
      if (this.hasAttribute("data-more-button")) return { width: 44 } as DOMRect;
      if (this.dataset["testid"] === "file-operations-toolbar") return { width: 180 } as DOMRect;
      return { width: 0 } as DOMRect;
    });

    renderToolbar([createAction("copy", { label: "Copy" }), createAction("move", { label: "Move" })]);

    const moreButton = await screen.findByRole("button", { name: "More" });
    expect(moreButton.querySelector('[data-testid="MoreVertIcon"]')).not.toBeNull();
    await user.hover(moreButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("More");
  });

  it("moves lower-priority commands into More when the toolbar is narrow", async () => {
    const observers: ResizeObserverCallback[] = [];
    let toolbarWidth = 180;
    let operationWidth = 100;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(_target: Element) {
          observers.at(-1)?.([{ contentRect: { width: toolbarWidth } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset["operationId"]) return { width: operationWidth } as DOMRect;
      if (this.hasAttribute("data-more-button")) return { width: 60 } as DOMRect;
      if (this.dataset["testid"] === "file-operations-toolbar") return { width: toolbarWidth } as DOMRect;
      return { width: 0 } as DOMRect;
    });
    const copy = createAction("copy", { label: "Copy" });
    const move = createAction("move", { label: "Move" });

    const { rerender } = renderToolbar([copy, move]);

    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Move" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move" }));
    expect(move.onClick).toHaveBeenCalledOnce();

    toolbarWidth = 600;
    act(() => requireTestValue(observers[0])([], {} as ResizeObserver));

    await waitFor(() => expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();

    toolbarWidth = 220;
    operationWidth = 150;
    rerender(
      <SambeeThemeProvider>
        <FileOperationsToolbar actions={[copy, { ...move, label: "Move selected items" }]} moreLabel="More" />
      </SambeeThemeProvider>
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument());
  });

  it("keeps a mounted upload anchor after its overflow action closes", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callback([{ contentRect: { width: 80 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset["operationId"]) return { width: 100 } as DOMRect;
      if (this.hasAttribute("data-more-button")) return { width: 60 } as DOMRect;
      if (this.dataset["testid"] === "file-operations-toolbar") return { width: 80 } as DOMRect;
      return { width: 0 } as DOMRect;
    });
    const onUploadTriggerChange = vi.fn();
    const onClick = vi.fn();
    render(
      <SambeeThemeProvider>
        <FileOperationsToolbar
          actions={[createAction("upload", { label: "Upload", onClick })]}
          moreLabel="More"
          onUploadTriggerChange={onUploadTriggerChange}
        />
      </SambeeThemeProvider>
    );

    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onUploadTriggerChange).toHaveBeenCalledWith(more);
    expect(more.isConnected).toBe(true);
  });

  it("keeps a disabled command in More without delegating its click", async () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(_target: Element) {
          observers.at(-1)?.([{ contentRect: { width: 180 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset["operationId"]) return { width: 100 } as DOMRect;
      if (this.hasAttribute("data-more-button")) return { width: 60 } as DOMRect;
      if (this.dataset["testid"] === "file-operations-toolbar") return { width: 180 } as DOMRect;
      return { width: 0 } as DOMRect;
    });
    const move = createAction("move", { label: "Move", enabled: false });

    renderToolbar([createAction("copy", { label: "Copy" }), move]);

    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const moveMenuItem = screen.getByRole("menuitem", { name: "Move" });
    expect(moveMenuItem).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(moveMenuItem);
    expect(move.onClick).not.toHaveBeenCalled();
  });
});
