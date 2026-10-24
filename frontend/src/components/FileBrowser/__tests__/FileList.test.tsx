import type { Virtualizer } from "@tanstack/react-virtual";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale, translate } from "../../../i18n";
import { requireTestValue } from "../../../test/helpers/assertions";
import { FILE_BROWSER_ROW_HEIGHT } from "../../../theme/constants";
import { type FileEntry, FileType } from "../../../types";
import { FileList } from "../FileList";

const rowVirtualizerStub = {
  getVirtualItems: () => [],
  getTotalSize: () => 0,
} as unknown as Virtualizer<HTMLDivElement, Element>;

const fileRowStylesStub = {
  iconBox: {},
  contentBox: {},
  buttonSelected: {},
  buttonNotSelected: {},
  buttonMultiSelected: {},
  buttonFocusedMultiSelected: {},
};

describe("FileList", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("dismisses desktop selection on row or empty space without opening during the same gesture", () => {
    const file: FileEntry = {
      name: "readme.txt",
      path: "readme.txt",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const virtualizer = {
      getVirtualItems: () => [{ index: 0, key: "file-0", start: 0, size: 40 }],
      getTotalSize: () => 40,
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    const onFileClick = vi.fn();
    const onClearSelection = vi.fn();
    const renderList = (selectedFiles: Set<string>) => (
      <FileList
        files={[file]}
        focusedIndex={0}
        selectedFiles={selectedFiles}
        onFileClick={onFileClick}
        onIconClick={vi.fn()}
        onClearSelection={onClearSelection}
        rowVirtualizer={virtualizer}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        viewMode="list"
      />
    );
    const { rerender } = render(renderList(new Set([file.path])));
    const row = screen.getByRole("button", { name: /readme.txt/i });
    fireEvent.click(row, { detail: 1 });
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onFileClick).not.toHaveBeenCalled();

    rerender(renderList(new Set()));
    fireEvent.click(row, { detail: 2 });
    expect(onFileClick).not.toHaveBeenCalled();
    fireEvent.click(row, { detail: 1 });
    expect(onFileClick).toHaveBeenCalledWith(file, 0);

    rerender(renderList(new Set([file.path])));
    fireEvent.click(screen.getByTestId("virtual-list"));
    expect(onClearSelection).toHaveBeenCalledTimes(2);
  });

  it("renders the translated empty state", async () => {
    await setLocale("en-XA");

    render(
      <FileList
        files={[]}
        focusedIndex={-1}
        selectedFiles={new Set()}
        onFileClick={() => {}}
        rowVirtualizer={rowVirtualizerStub}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout={false}
        viewMode="list"
      />
    );

    expect(screen.getByText(translate("fileBrowser.list.emptyDirectory"))).toBeInTheDocument();
  });

  it("suppresses the empty state when requested", () => {
    render(
      <FileList
        files={[]}
        showEmptyState={false}
        focusedIndex={-1}
        selectedFiles={new Set()}
        onFileClick={() => {}}
        rowVirtualizer={rowVirtualizerStub}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout={false}
        viewMode="list"
      />
    );

    expect(screen.queryByText(translate("fileBrowser.list.emptyDirectory"))).not.toBeInTheDocument();
  });

  it("does not wire dynamic row measurement for fixed-height rows", () => {
    const measureElement = vi.fn();
    const rowVirtualizerWithItems = {
      getVirtualItems: () => [{ index: 0, key: "file-0", start: 0, size: 40 }],
      getTotalSize: () => 40,
      measureElement,
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    const files: FileEntry[] = [
      {
        name: "readme.txt",
        path: "readme.txt",
        type: FileType.FILE,
        size: 123,
        mime_type: "text/plain",
        modified_at: "2026-07-15T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    render(
      <FileList
        files={files}
        focusedIndex={0}
        selectedFiles={new Set()}
        onFileClick={() => {}}
        rowVirtualizer={rowVirtualizerWithItems}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout={false}
        viewMode="list"
      />
    );

    expect(screen.getByText("readme.txt")).toBeInTheDocument();
    expect(measureElement).not.toHaveBeenCalled();
  });

  it("opens compact item actions from the visible more actions button", () => {
    const files: FileEntry[] = [
      {
        name: "readme.txt",
        path: "readme.txt",
        type: FileType.FILE,
        size: 123,
        modified_at: "2026-07-15T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];
    const rowVirtualizerWithItems = {
      getVirtualItems: () => [{ index: 0, key: "file-0", start: 0, size: FILE_BROWSER_ROW_HEIGHT.MOBILE_PX }],
      getTotalSize: () => FILE_BROWSER_ROW_HEIGHT.MOBILE_PX,
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    const onFileClick = vi.fn();
    const onSelectItem = vi.fn();

    render(
      <FileList
        files={files}
        focusedIndex={0}
        selectedFiles={new Set()}
        onFileClick={onFileClick}
        onSelectItem={onSelectItem}
        getCompactItemActions={(file, index) => [
          {
            id: "select",
            label: "Select",
            onClick: () => onSelectItem(file, index),
          },
        ]}
        rowVirtualizer={rowVirtualizerWithItems}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout
        viewMode="list"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for readme.txt" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));

    expect(onSelectItem).toHaveBeenCalledWith(files[0], 0);
    expect(onFileClick).not.toHaveBeenCalled();
    expect(screen.getByText("123 B \u00b7 07/15/2026, 12:00 AM")).toBeInTheDocument();
  });

  it("enables touch selection controls while retaining the desktop row layout", () => {
    const files: FileEntry[] = [
      {
        name: "readme.txt",
        path: "readme.txt",
        type: FileType.FILE,
        size: 123,
        modified_at: "2026-07-15T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];
    const rowVirtualizerWithItems = {
      getVirtualItems: () => [{ index: 0, key: "file-0", start: 0, size: FILE_BROWSER_ROW_HEIGHT.TOUCH_PX }],
      getTotalSize: () => FILE_BROWSER_ROW_HEIGHT.TOUCH_PX,
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    const onToggleItemSelection = vi.fn();

    render(
      <FileList
        files={files}
        focusedIndex={0}
        selectedFiles={new Set([requireTestValue(files[0]).path])}
        onFileClick={() => {}}
        onToggleItemSelection={onToggleItemSelection}
        onSelectItem={() => {}}
        getCompactItemActions={() => []}
        rowVirtualizer={rowVirtualizerWithItems}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useTouchSelectionControls
        viewMode="list"
      />
    );

    const row = screen.getByRole("button", { name: /file: readme\.txt/i });
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(row.closest("[data-index='0']")).toHaveStyle({ height: "48px" });
    expect(screen.getByRole("button", { name: "More actions for readme.txt" })).toBeInTheDocument();
    expect(onToggleItemSelection).toHaveBeenCalledWith(files[0], 0);
  });

  it("reserves virtual-list space for the compact selection dock", () => {
    const files: FileEntry[] = [
      {
        name: "readme.txt",
        path: "readme.txt",
        type: FileType.FILE,
        size: 123,
        modified_at: "2026-07-15T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    render(
      <FileList
        files={files}
        focusedIndex={0}
        selectedFiles={new Set([requireTestValue(files[0]).path])}
        onFileClick={() => {}}
        compactOverlay={<div data-testid="selection-dock-overlay" />}
        compactOverlayLayout="dock"
        rowVirtualizer={rowVirtualizerStub}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout
        viewMode="list"
      />
    );

    expect(screen.getByTestId("virtual-list").style.paddingBottom).toBe("calc(64px + env(safe-area-inset-bottom))");
    expect(screen.getByTestId("selection-dock-overlay").parentElement).toHaveStyle({ left: "0px", right: "0px", bottom: "0px" });
  });

  it("offers archive extraction only for eligible compact item actions", () => {
    const files: FileEntry[] = [
      {
        name: "backup.zip",
        path: "backup.zip",
        type: FileType.FILE,
        size: 123,
        modified_at: "2026-07-15T00:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];
    const rowVirtualizerWithItems = {
      getVirtualItems: () => [{ index: 0, key: "file-0", start: 0, size: FILE_BROWSER_ROW_HEIGHT.MOBILE_PX }],
      getTotalSize: () => FILE_BROWSER_ROW_HEIGHT.MOBILE_PX,
    } as unknown as Virtualizer<HTMLDivElement, Element>;
    const onExtractArchive = vi.fn();

    render(
      <FileList
        files={files}
        focusedIndex={0}
        selectedFiles={new Set()}
        onFileClick={() => {}}
        getCompactItemActions={(file) =>
          file.name.endsWith(".zip")
            ? [{ id: "extract-archive", label: "Extract archive", enabled: true, onClick: () => onExtractArchive(file, 0) }]
            : []
        }
        rowVirtualizer={rowVirtualizerWithItems}
        parentRef={{ current: null }}
        listContainerRef={() => {}}
        fileRowStyles={fileRowStylesStub}
        useCompactLayout
        viewMode="list"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "More actions for backup.zip" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Extract archive" }));

    expect(onExtractArchive).toHaveBeenCalledWith(files[0], 0);
  });
});
