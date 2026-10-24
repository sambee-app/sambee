import { act, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../../i18n";
import { formatDate, formatFileSize } from "../../../pages/FileBrowser/formatters";
import { FILE_BROWSER_ROW_HEIGHT } from "../../../theme/constants";
import { type FileInfo, FileType } from "../../../types";
import { FileRow, shortenTargetPath } from "../FileRow";

function createDefaultFileRowProps() {
  const file: FileInfo = {
    name: "report.pdf",
    path: "/report.pdf",
    type: FileType.FILE,
    size: 1024,
    modified_at: "2024-01-01T00:00:00Z",
    is_readable: true,
    is_hidden: false,
  };
  return {
    file,
    useCompactLayout: false,
    index: 0,
    isSelected: true,
    isMultiSelected: true,
    virtualStart: 0,
    virtualSize: 48,
    onClick: vi.fn(),
    fileRowStyles: {
      buttonSelected: {},
      buttonNotSelected: {},
      buttonMultiSelected: {},
      buttonFocusedMultiSelected: {},
      iconBox: {},
      contentBox: {},
    },
    viewMode: "list" as const,
    onOpenAssociatedViewer: vi.fn(),
    onOpenViewerPicker: vi.fn(),
    onOpenAssociatedNativeApp: vi.fn(),
    onOpenNativePicker: vi.fn(),
    onRename: vi.fn(),
  };
}

describe("FileRow", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await setLocale("en");
  });

  it("selects through a labeled icon without opening or activating twice in a double click", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    const onIconClick = vi.fn();
    render(<FileRow {...props} selectionMode={false} onIconClick={onIconClick} />);

    const icon = screen.getByRole("checkbox", { name: "Select: report.pdf" });
    expect(icon).toHaveAttribute("aria-checked", "false");
    fireEvent.click(icon, { detail: 1, shiftKey: true });
    fireEvent.click(icon, { detail: 2 });
    expect(onIconClick).toHaveBeenCalledTimes(1);
    expect(onIconClick).toHaveBeenCalledWith(props.file, props.index, true, false);
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it("does not render an application context menu on desktop", async () => {
    await setLocale("en-XA");

    render(<FileRow {...createDefaultFileRowProps()} />);

    const expectedAriaLabel = `${translate("fileBrowser.row.itemTypes.file")}: report.pdf${translate("fileBrowser.row.selectedSuffix")}`;
    const rowButton = screen.getByRole("button", { name: expectedAriaLabel });

    expect(rowButton).toBeInTheDocument();

    fireEvent.contextMenu(rowButton);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("invokes onClick when the row button is pressed", () => {
    const props = createDefaultFileRowProps();

    render(<FileRow {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /report\.pdf/i }));

    expect(props.onClick).toHaveBeenCalledWith(props.file, props.index);
  });

  it("shows an accessible marker for an unsaved local draft", async () => {
    await setLocale("en-XA");
    render(<FileRow {...createDefaultFileRowProps()} hasUnsavedLocalDraft />);

    const markerLabel = translate("fileBrowser.row.unsavedLocalDraft");
    expect(screen.getByRole("img", { name: markerLabel })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `${translate("fileBrowser.row.itemTypes.file")}: report.pdf${translate("fileBrowser.row.unsavedLocalDraftSuffix")}${translate("fileBrowser.row.selectedSuffix")}`,
      })
    ).toBeInTheDocument();
  });

  it("rerenders a selected row when its styles change", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    props.fileRowStyles = {
      ...props.fileRowStyles,
      buttonSelected: { backgroundColor: "rgb(1, 2, 3)" },
    };
    const { rerender } = render(<FileRow {...props} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    expect(rowButton).toHaveStyle({ backgroundColor: "rgb(1, 2, 3)" });

    rerender(
      <FileRow
        {...props}
        fileRowStyles={{
          ...props.fileRowStyles,
          buttonSelected: { backgroundColor: "rgb(4, 5, 6)" },
        }}
      />
    );

    expect(rowButton).toHaveStyle({ backgroundColor: "rgb(4, 5, 6)" });
  });

  it("disables unavailable archive entries and hides their actions", () => {
    const props = createDefaultFileRowProps();
    props.file = { ...props.file, is_readable: false, archive_entry_state: "blocked" };

    render(<FileRow {...props} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    expect(rowButton).toBeDisabled();
    fireEvent.click(rowButton);
    fireEvent.contextMenu(rowButton);

    expect(props.onClick).not.toHaveBeenCalled();
    expect(screen.queryByText(translate("fileBrowser.row.openInBrowserViewer"))).not.toBeInTheDocument();
  });

  it("keeps readable archive directories enabled for navigation", () => {
    const props = createDefaultFileRowProps();
    props.file = {
      ...props.file,
      name: "nested",
      path: "nested",
      type: FileType.DIRECTORY,
      is_readable: true,
      archive_entry_state: "readable",
    };

    render(<FileRow {...props} />);

    const rowButton = screen.getByRole("button", { name: /nested/i });
    expect(rowButton).not.toBeDisabled();
    fireEvent.click(rowButton);
    expect(props.onClick).toHaveBeenCalledWith(props.file, props.index);
  });

  it("updates archive entry actions when a refresh marks the entry unavailable", () => {
    const props = createDefaultFileRowProps();
    const { rerender } = render(<FileRow {...props} />);

    rerender(<FileRow {...props} file={{ ...props.file, is_readable: false, archive_entry_state: "blocked" }} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    expect(rowButton).toBeDisabled();
    fireEvent.contextMenu(rowButton);
    expect(screen.queryByText(translate("fileBrowser.row.openInBrowserViewer"))).not.toBeInTheDocument();
  });

  it("opens compact item actions without activating the row", () => {
    const props = createDefaultFileRowProps();
    const onOpenItemActions = vi.fn();

    render(<FileRow {...props} useCompactLayout showCompactActions onOpenItemActions={onOpenItemActions} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));

    expect(onOpenItemActions).toHaveBeenCalledWith(props.file, props.index, expect.any(HTMLElement));
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it("enters compact selection mode after a touch long press without activating the row", () => {
    vi.useFakeTimers();
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    const onLongPressSelect = vi.fn();

    render(<FileRow {...props} useCompactLayout onLongPressSelect={onLongPressSelect} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    fireEvent.pointerDown(rowButton, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(450));
    const contextMenuEvent = createEvent.contextMenu(rowButton);
    fireEvent(rowButton, contextMenuEvent);
    fireEvent.pointerUp(rowButton, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(rowButton);

    expect(onLongPressSelect).toHaveBeenCalledWith(props.file, props.index);
    expect(props.onClick).not.toHaveBeenCalled();
    expect(contextMenuEvent.defaultPrevented).toBe(true);
  });

  it("enters selection mode after a touch long press in desktop layout when touch controls are enabled", () => {
    vi.useFakeTimers();
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    const onLongPressSelect = vi.fn();

    render(<FileRow {...props} useTouchSelectionControls onLongPressSelect={onLongPressSelect} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    fireEvent.pointerDown(rowButton, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.pointerUp(rowButton, { pointerId: 1, pointerType: "touch" });
    fireEvent.click(rowButton);

    expect(onLongPressSelect).toHaveBeenCalledWith(props.file, props.index);
    expect(props.onClick).not.toHaveBeenCalled();
  });

  it("cancels compact long press when the touch becomes a scroll gesture", () => {
    vi.useFakeTimers();
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    const onLongPressSelect = vi.fn();

    render(<FileRow {...props} useCompactLayout onLongPressSelect={onLongPressSelect} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    fireEvent.pointerDown(rowButton, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(rowButton, { pointerId: 1, pointerType: "touch", clientX: 21, clientY: 10 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.click(rowButton);

    expect(onLongPressSelect).not.toHaveBeenCalled();
    expect(props.onClick).toHaveBeenCalledWith(props.file, props.index);
  });

  it("does not apply long-press selection when selection mode is already active", () => {
    vi.useFakeTimers();
    const props = createDefaultFileRowProps();
    const onLongPressSelect = vi.fn();

    render(<FileRow {...props} useCompactLayout selectionMode onLongPressSelect={onLongPressSelect} />);

    const rowButton = screen.getByRole("button", { name: /report\.pdf/i });
    fireEvent.pointerDown(rowButton, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(450));

    expect(onLongPressSelect).not.toHaveBeenCalled();
  });

  it("exposes compact selection mode through aria-pressed", () => {
    const props = createDefaultFileRowProps();
    render(<FileRow {...props} useCompactLayout selectionMode />);

    expect(screen.getByRole("button", { name: /report\.pdf/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an unselected icon for compact rows in selection mode", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;

    render(<FileRow {...props} useCompactLayout selectionMode />);

    expect(screen.getByTestId("CircleOutlinedIcon")).toHaveStyle({ fontSize: "28px" });
    expect(screen.queryByTestId("CheckCircleIcon")).not.toBeInTheDocument();
  });

  it("renders a shortcut's full target path", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    props.file = {
      ...props.file,
      name: "Project.lnk",
      link_kind: "windows_shortcut",
      link_target: {
        source_path: "Project.lnk",
        state: "resolved",
        target: { name: "Project Archive", path: "C:\\Users\\Sambee\\Projects\\Project Archive", type: "directory" },
      },
    };

    render(<FileRow {...props} />);

    expect(screen.getByTitle("C:\\Users\\Sambee\\Projects\\Project Archive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /shortcut target: C:\\Users\\Sambee\\Projects\\Project Archive/i })).toBeInTheDocument();
    expect(screen.getByText(/\u2192/)).toBeInTheDocument();
    expect(screen.getByTestId("ShortcutIcon")).toBeInTheDocument();
    expect(screen.queryByTestId("FolderIcon")).not.toBeInTheDocument();
    expect(screen.getByTitle("Project.lnk")).toHaveStyle({ flex: "0 1 auto" });
    expect(screen.getByTitle("C:\\Users\\Sambee\\Projects\\Project Archive")).toHaveStyle({ flex: "1 1 auto" });
  });

  it("renders an unresolved shortcut extension with the shortcut icon", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    props.file = { ...props.file, name: "My Drive.lnk" };

    render(<FileRow {...props} />);

    expect(screen.getByTestId("ShortcutIcon")).toBeInTheDocument();
  });

  it("shortens target paths from the ancestor end while retaining the basename", () => {
    const measureCharacters = (text: string) => text.length;

    expect(shortenTargetPath("/Users/sambee/Projects/Archive/report.pdf", 17, measureCharacters)).toBe("/.../report.pdf");
    expect(shortenTargetPath("C:\\Users\\sambee\\Projects\\report.pdf", 18, measureCharacters)).toBe("C:\\...\\report.pdf");
    expect(shortenTargetPath("/Users/sambee/report.pdf", 100, measureCharacters)).toBe("/Users/sambee/report.pdf");
    expect(shortenTargetPath("report.pdf", 3, measureCharacters)).toBe("...");
    expect(shortenTargetPath("/Users/sambee/very-long-report.pdf", 14, measureCharacters)).toBe("...-report.pdf");
  });

  it("rerenders when compact layout changes", () => {
    const props = createDefaultFileRowProps();
    const { rerender } = render(<FileRow {...props} />);

    rerender(<FileRow {...props} useCompactLayout />);

    expect(screen.getByText("report.pdf")).toHaveStyle({ fontSize: "17px" });
    expect(screen.getByTestId("CheckCircleIcon")).toHaveStyle({ fontSize: "28px" });
  });

  it("renders compact file metadata in a fixed-height secondary line", () => {
    const props = createDefaultFileRowProps();
    const metadata = `${formatFileSize(props.file.size)} \u00b7 ${formatDate(props.file.modified_at)}`;
    const { container } = render(
      <FileRow
        {...props}
        useCompactLayout
        showCompactActions
        virtualSize={FILE_BROWSER_ROW_HEIGHT.MOBILE_PX}
        onOpenItemActions={() => {}}
      />
    );

    expect(container.querySelector("[data-index='0']")).toHaveStyle({ height: "72px" });
    expect(screen.getByText(metadata)).toHaveStyle({
      color: "rgba(0, 0, 0, 0.6)",
      fontSize: "12px",
      fontVariantNumeric: "tabular-nums",
      marginTop: "1px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    expect(screen.getByRole("button", { name: "More actions for report.pdf" })).toHaveStyle({ height: "44px", width: "44px" });
  });

  it("renders only available compact file metadata values without a dangling separator", () => {
    const props = createDefaultFileRowProps();
    const { rerender } = render(<FileRow {...props} useCompactLayout file={{ ...props.file, modified_at: undefined }} />);

    expect(screen.getByText(formatFileSize(props.file.size))).toBeInTheDocument();
    expect(screen.queryByText(/\u00b7/)).not.toBeInTheDocument();

    rerender(<FileRow {...props} useCompactLayout file={{ ...props.file, size: undefined }} />);

    expect(screen.getByText(formatDate(props.file.modified_at))).toBeInTheDocument();
    expect(screen.queryByText(/\u00b7/)).not.toBeInTheDocument();
  });

  it("does not render compact metadata for folders or directory shortcuts", () => {
    const props = createDefaultFileRowProps();
    const metadata = `${formatFileSize(props.file.size)} \u00b7 ${formatDate(props.file.modified_at)}`;
    const { rerender } = render(
      <FileRow {...props} useCompactLayout file={{ ...props.file, name: "Documents", type: FileType.DIRECTORY }} />
    );

    expect(screen.queryByText(metadata)).not.toBeInTheDocument();

    rerender(
      <FileRow
        {...props}
        useCompactLayout
        file={{
          ...props.file,
          name: "Documents.lnk",
          link_kind: "windows_shortcut",
          link_target: {
            source_path: "Documents.lnk",
            state: "resolved",
            target: { name: "Documents", type: FileType.DIRECTORY },
          },
        }}
      />
    );

    expect(screen.queryByText(metadata)).not.toBeInTheDocument();
  });

  it("rerenders when deferred shortcut metadata arrives", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    props.file = {
      ...props.file,
      name: "Project.lnk",
      link_kind: "windows_shortcut",
    };

    const { rerender } = render(<FileRow {...props} />);

    expect(screen.queryByText(/-> Project Archive/)).not.toBeInTheDocument();

    rerender(
      <FileRow
        {...props}
        file={{
          ...props.file,
          link_target: {
            source_path: "Project.lnk",
            state: "resolved",
            target: { name: "Project Archive", type: "directory" },
          },
        }}
      />
    );

    expect(screen.getByText("Project Archive")).toBeInTheDocument();
  });

  it("does not attach application context actions to shortcut rows", () => {
    const props = createDefaultFileRowProps();
    props.isMultiSelected = false;
    props.file = {
      ...props.file,
      name: "Project.lnk",
      link_kind: "windows_shortcut",
      link_target: {
        source_path: "Project.lnk",
        state: "resolved",
        target: { name: "Project Archive", type: "directory" },
      },
    };

    render(<FileRow {...props} />);
    const rowButton = screen.getByRole("button", { name: /shortcut target: Project Archive/i });
    fireEvent.contextMenu(rowButton);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
