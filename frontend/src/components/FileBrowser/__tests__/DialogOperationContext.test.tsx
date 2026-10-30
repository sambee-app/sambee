import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogOperationContext } from "../DialogOperationContext";

class ResizeObserverMock {
  private static callback: ResizeObserverCallback | null = null;
  private static width = 12;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    ResizeObserverMock.callback = this.callback;
    vi.spyOn(target, "clientWidth", "get").mockImplementation(() => ResizeObserverMock.width);
    this.callback([], this as unknown as ResizeObserver);
  }

  static resize(width: number) {
    ResizeObserverMock.width = width;
    if (ResizeObserverMock.callback) {
      ResizeObserverMock.callback([], {} as ResizeObserver);
    }
  }

  static reset() {
    ResizeObserverMock.callback = null;
    ResizeObserverMock.width = 12;
  }

  disconnect() {}

  unobserve() {}
}

describe("DialogOperationContext", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    ResizeObserverMock.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders labelled values as vertical definition-list entries", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    render(
      <DialogOperationContext
        entries={[
          { label: "Source item", value: "report.pdf", kind: "fileName" },
          { label: "Destination directory", value: "Demo:/Archive", kind: "path" },
        ]}
      />
    );

    expect(screen.getByText("Source item:").tagName).toBe("DT");
    expect(screen.getByText("Source item:").parentElement?.querySelector("dd")).not.toBeNull();
    expect(screen.getByText("Destination directory:").tagName).toBe("DT");
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();
  });

  it("uses muted labels and primary identifier values", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    render(<DialogOperationContext entries={[{ label: "Source item", value: "report.pdf", kind: "fileName" }]} />);

    const label = screen.getByText("Source item:");
    const value = screen.getByLabelText("report.pdf");

    expect(getComputedStyle(label).color).not.toBe(getComputedStyle(value).color);
  });

  it("retains the complete accessible value and exposes a shortened value on hover only", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length }),
    } as CanvasRenderingContext2D);
    const user = userEvent.setup();
    const value = "annual-report-final.pdf";
    render(<DialogOperationContext entries={[{ label: "Source item", value, kind: "fileName", testId: "source" }]} />);

    const identifier = screen.getByTestId("source");
    expect(identifier).toHaveAccessibleName(value);
    expect(identifier).toHaveAttribute("dir", "auto");

    await user.hover(identifier);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(value);
    await user.unhover(identifier);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    fireEvent.focus(identifier);
    fireEvent.touchStart(identifier);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("recalculates the displayed value when the available width changes", async () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text.length }),
    } as CanvasRenderingContext2D);
    const value = "annual-report-final.pdf";
    render(<DialogOperationContext entries={[{ label: "Source item", value, kind: "fileName", testId: "source" }]} />);

    const identifier = screen.getByTestId("source");
    expect(identifier).not.toHaveTextContent(value);

    act(() => ResizeObserverMock.resize(100));
    await waitFor(() => expect(screen.getByTestId("source")).toHaveTextContent(value));
    expect(screen.getByTestId("source")).toBe(identifier);

    act(() => ResizeObserverMock.resize(12));
    await waitFor(() => expect(screen.getByTestId("source")).not.toHaveTextContent(value));
    expect(screen.getByTestId("source")).toBe(identifier);
  });
});
