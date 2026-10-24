import { describe, expect, it, vi } from "vitest";
import { createFileOperationActions, type FileOperationActionId } from "./fileOperationActions";

const actionIds: FileOperationActionId[] = [
  "new-directory",
  "new-file",
  "rename",
  "delete",
  "copy",
  "move",
  "create-archive",
  "extract-archive",
  "download",
  "share",
  "upload",
  "refresh",
];

function createContext(hasTwoPanes: boolean) {
  return {
    hasTwoPanes,
    availability: Object.fromEntries(actionIds.map((id) => [id, { available: id !== "delete", reason: "blocked" }])) as Record<
      FileOperationActionId,
      { available: boolean; reason: string }
    >,
    labels: Object.fromEntries(actionIds.map((id) => [id, id])) as Record<FileOperationActionId, string>,
    shortcuts: Object.fromEntries(actionIds.map((id) => [id, "F1"])) as Record<FileOperationActionId, string>,
    unavailableReasons: { delete: "Select an item to delete." },
    handlers: {
      "new-directory": vi.fn(),
      "new-file": vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
      copy: vi.fn(),
      move: vi.fn(),
      "create-archive": vi.fn(),
      "extract-archive": vi.fn(),
      download: vi.fn(),
      share: vi.fn(),
      upload: vi.fn(),
      refresh: vi.fn(),
    } satisfies Record<FileOperationActionId, () => void>,
  };
}

describe("createFileOperationActions", () => {
  it("keeps actions in priority order and omits transfers in single-pane mode", () => {
    const actions = createFileOperationActions(createContext(false));

    expect(actions.map((action) => action.id)).toEqual([
      "new-directory",
      "new-file",
      "rename",
      "delete",
      "create-archive",
      "extract-archive",
      "download",
      "upload",
      "refresh",
    ]);
    expect(actions.map((action) => action.priority)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11]);
    expect(actions[0]).toMatchObject({ shortcut: "F1" });
  });

  it("includes transfer commands in two-pane mode and appends a disabled reason to the tooltip", () => {
    const actions = createFileOperationActions(createContext(true));
    const deleteAction = actions.find((action) => action.id === "delete");

    expect(actions.map((action) => action.id)).toContain("copy");
    expect(actions.map((action) => action.id)).toContain("move");
    expect(deleteAction).toMatchObject({ enabled: false, tooltip: "delete (F1): Select an item to delete." });
  });

  it("uses surface-specific placements and scopes", () => {
    const itemActions = createFileOperationActions({ ...createContext(false), surface: "compact-item-menu" });
    const createActions = createFileOperationActions({ ...createContext(false), surface: "compact-create-menu" });
    const selectionActions = createFileOperationActions({ ...createContext(true), surface: "compact-selection-menu" });

    expect(itemActions.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: "rename", scope: "item" },
      { id: "delete", scope: "item" },
      { id: "extract-archive", scope: "item" },
      { id: "download", scope: "item" },
      { id: "share", scope: "item" },
    ]);
    expect(createActions.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: "new-directory", scope: "pane" },
      { id: "new-file", scope: "pane" },
      { id: "upload", scope: "pane" },
    ]);
    expect(selectionActions.map(({ id, scope }) => ({ id, scope }))).toEqual([
      { id: "copy", scope: "selection" },
      { id: "move", scope: "selection" },
      { id: "create-archive", scope: "selection" },
      { id: "delete", scope: "selection" },
      { id: "download", scope: "selection" },
      { id: "share", scope: "selection" },
    ]);
    expect(createFileOperationActions({ ...createContext(false), surface: "compact-selection-menu" }).map((action) => action.id)).toEqual([
      "create-archive",
      "delete",
      "download",
      "share",
    ]);
  });
});
