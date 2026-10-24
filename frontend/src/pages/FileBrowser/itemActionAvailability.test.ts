import { describe, expect, it } from "vitest";
import { type FileEntry, FileType } from "../../types";
import type { ContentOperationEnvironment } from "./contentOperations";
import { type BrowserItem, physicalItemHandle } from "./contentProviders";
import { getItemActionAvailability } from "./itemActionAvailability";

const nativeEnvironment = {
  isCompanionPaired: true,
  history: {} as never,
  storageRegistry: {
    resolveItem: () => ({ resolvedTarget: { kind: "smb", connectionId: "demo" } }),
    getCapabilities: () => ({ canOpenInNativeApp: true }),
  },
} as unknown as ContentOperationEnvironment;

function createItem(name: string, type = FileType.FILE): BrowserItem {
  const entry: FileEntry = {
    name,
    path: name,
    type,
    size: 1,
    modified_at: "2026-01-01T00:00:00Z",
    is_readable: true,
    is_hidden: false,
  };

  return { key: name, entry, handle: physicalItemHandle("demo", name) };
}

describe("getItemActionAvailability", () => {
  it("excludes browser and native opening for directories", () => {
    expect(
      getItemActionAvailability({
        item: createItem("documents", FileType.DIRECTORY),
        nativeAppCapability: true,
        isCompanionPaired: true,
        environment: nativeEnvironment,
      })
    ).toEqual({
      canOpenInBrowserViewer: false,
      canChooseBrowserViewer: false,
      canOpenInNativeApp: false,
      canChooseNativeApp: false,
    });
  });

  it("treats links to directories as folders", () => {
    const item = createItem("documents-link");
    item.entry.link_target = { source_path: item.entry.path, state: "resolved", target: { name: "target", type: FileType.DIRECTORY } };

    expect(
      getItemActionAvailability({
        item,
        nativeAppCapability: true,
        isCompanionPaired: true,
        environment: nativeEnvironment,
      })
    ).toEqual({
      canOpenInBrowserViewer: false,
      canChooseBrowserViewer: false,
      canOpenInNativeApp: false,
      canChooseNativeApp: false,
    });
  });

  it("shows only compatible browser viewer actions", () => {
    const unsupported = getItemActionAvailability({
      item: createItem("archive.unknown"),
      nativeAppCapability: false,
      isCompanionPaired: false,
      environment: nativeEnvironment,
    });
    const textFile = getItemActionAvailability({
      item: createItem("notes.txt"),
      nativeAppCapability: false,
      isCompanionPaired: false,
      environment: nativeEnvironment,
    });

    expect(unsupported.canOpenInBrowserViewer).toBe(false);
    expect(unsupported.canChooseBrowserViewer).toBe(false);
    expect(textFile.canOpenInBrowserViewer).toBe(true);
    expect(textFile.canChooseBrowserViewer).toBe(true);
  });

  it("requires a paired Companion and native item capability", () => {
    const input = {
      item: createItem("notes.txt"),
      nativeAppCapability: true,
      environment: nativeEnvironment,
    };

    expect(getItemActionAvailability({ ...input, isCompanionPaired: false }).canOpenInNativeApp).toBe(false);
    expect(getItemActionAvailability({ ...input, isCompanionPaired: true }).canOpenInNativeApp).toBe(true);
  });
});
