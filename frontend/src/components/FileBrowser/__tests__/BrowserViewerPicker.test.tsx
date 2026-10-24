import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserViewerPicker } from "../BrowserViewerPicker";

const persistenceProps = { saving: false, saveError: null, onOpenWithoutSaving: vi.fn() };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "common.actions.cancel": "Cancel",
        "fileBrowser.viewerPicker.title": "Choose Viewer",
        "fileBrowser.viewerPicker.open": "Open",
        "fileBrowser.viewerPicker.openWithoutSaving": "Open without saving",
        "fileBrowser.viewerPicker.alwaysUse": "Always use this viewer for this file type",
        "fileBrowser.viewerPicker.default": "Default",
        "fileBrowser.viewerPicker.openInNativeApp": "Open in native app",
        "fileBrowser.viewerPicker.nativeDescription": "Use your desktop application instead of a Sambee viewer",
        "fileBrowser.viewerPicker.viewers.image": "Image Viewer",
        "fileBrowser.viewerPicker.viewers.markdown": "Markdown Viewer",
        "fileBrowser.viewerPicker.viewers.pdf": "PDF Viewer",
        "fileBrowser.viewerPicker.viewers.text": "Text Editor",
      };

      return translations[key] ?? key;
    },
  }),
}));

describe("BrowserViewerPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with always-use checked when a preferred viewer already exists", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf", "markdown"]}
        defaultViewerId="pdf"
        preferredViewerId="pdf"
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: "pdf",
      rememberSelection: true,
    });
  });

  it("keeps always-use enabled when switching to a different Sambee viewer", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf", "markdown"]}
        defaultViewerId="pdf"
        preferredViewerId="pdf"
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByText("Markdown Viewer"));

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeEnabled();
    expect(checkbox).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: "markdown",
      rememberSelection: true,
    });
  });

  it("offers native app fallback when no compatible Sambee viewer exists", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="archive.bin"
        viewerIds={["image", "markdown", "pdf"]}
        defaultViewerId={null}
        preferredViewerId={null}
        showNativeOption={true}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("Open in native app")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Open in native app"));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: null,
      rememberSelection: false,
    });
  });

  it("preselects the default viewer when there is no saved association", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="notes.MD"
        viewerIds={["image", "markdown", "pdf"]}
        defaultViewerId="markdown"
        preferredViewerId={null}
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeEnabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: "markdown",
      rememberSelection: false,
    });
  });

  it("renders the text viewer option when provided", () => {
    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="notes.txt"
        viewerIds={["text"]}
        defaultViewerId="text"
        preferredViewerId={null}
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByText("Text Editor")).toBeInTheDocument();
  });

  it("focuses the viewer list when the dialog opens", async () => {
    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf", "markdown"]}
        defaultViewerId="pdf"
        preferredViewerId="pdf"
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    const list = screen.getByRole("listbox");

    await vi.waitFor(() => {
      expect(list).toHaveFocus();
    });
  });

  it("moves between viewers with arrow keys", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf", "markdown"]}
        defaultViewerId="pdf"
        preferredViewerId="pdf"
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    const list = screen.getByRole("listbox");

    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: "markdown",
      rememberSelection: true,
    });
  });

  it("applies the current selection when Enter is pressed", () => {
    const onConfirm = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf", "markdown"]}
        defaultViewerId="pdf"
        preferredViewerId="pdf"
        showNativeOption={false}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Choose Viewer" }), { key: "Enter" });

    expect(onConfirm).toHaveBeenCalledWith({
      viewerId: "pdf",
      rememberSelection: true,
    });
  });

  it("offers an explicit unsaved open after a remembered-selection write fails", () => {
    const onConfirm = vi.fn();
    const onOpenWithoutSaving = vi.fn();

    render(
      <BrowserViewerPicker
        {...persistenceProps}
        open={true}
        fileName="report.pdf"
        viewerIds={["pdf"]}
        defaultViewerId="pdf"
        preferredViewerId={null}
        showNativeOption={false}
        saving={false}
        saveError="Unable to save viewer preference."
        onClose={vi.fn()}
        onConfirm={onConfirm}
        onOpenWithoutSaving={onOpenWithoutSaving}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open without saving" }));

    expect(onOpenWithoutSaving).toHaveBeenCalledWith({ viewerId: "pdf" });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
