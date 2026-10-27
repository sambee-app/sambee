import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { type BrowserCommandContext, getEnabledBrowserCommands } from "../browserCommands";

function createContext(): BrowserCommandContext {
  return {
    isDualMode: true,
    useCompactLayout: false,
    settingsOpen: false,
    mobileSettingsOpen: false,
    helpOpen: false,
    quickBarMode: "navigate",
    hasFiles: true,
    hasFocusedFile: true,
    connectionSelected: true,
    connectionWritable: true,
    canCreateArchive: true,
    canExtractArchive: true,
    canOpenFocusedFileInApp: true,
    canCopyToOtherPane: true,
    canMoveToOtherPane: true,
    canOpenLocationInNewTab: true,
    canMatchPaneLocations: true,
    openLocationInNewTab: () => {},
    matchLeftPaneLocation: () => {},
    matchRightPaneLocation: () => {},
    openQuickNav: () => {},
    openFileSearch: () => {},
    openCommandMode: () => {},
    openSettings: () => {},
    openConnectionsSettings: () => {},
    openHelp: () => {},
    refresh: () => {},
    navigateUp: () => {},
    openFocusedItem: () => {},
    renameFocusedItem: () => {},
    deleteFocusedItem: () => {},
    newDirectory: () => {},
    newFile: () => {},
    createArchive: () => {},
    extractArchive: () => {},
    openInApp: () => {},
    openInViewerPicker: () => {},
    openInNativePicker: () => {},
    toggleDualPane: () => {},
    focusLeftPane: () => {},
    focusRightPane: () => {},
    switchPane: () => {},
    copyToOtherPane: () => {},
    moveToOtherPane: () => {},
  };
}

describe("browserCommands", () => {
  afterEach(async () => {
    await setLocale("en");
  });

  it("localizes command titles and categories", async () => {
    const context = createContext();

    expect(getEnabledBrowserCommands(context)[0]).toMatchObject({
      title: "Open Navigate Mode",
      category: "Navigation",
      description: "Jump to directories from the quick bar",
    });

    await setLocale("en-XA");

    expect(getEnabledBrowserCommands(context)[0]).toMatchObject({
      title: "[Óṕéń Ńåṽíğåťé Ḿóďé]",
      category: "[Ńåṽíğåťíóń]",
      description: "[Ĵúḿṕ ťó ďíŕéćťóŕíéš ƒŕóḿ ťħé qúíćķ ƀåŕ]",
    });
  });

  it("omits write commands for read-only connections", () => {
    const context = createContext();
    context.connectionWritable = false;
    context.canCreateArchive = false;
    context.canExtractArchive = false;
    context.canOpenFocusedFileInApp = false;
    context.canCopyToOtherPane = false;
    context.canMoveToOtherPane = false;

    const commandIds = getEnabledBrowserCommands(context).map((command) => command.id);

    expect(commandIds).not.toContain("browser.rename");
    expect(commandIds).not.toContain("browser.delete");
    expect(commandIds).not.toContain("browser.newDirectory");
    expect(commandIds).not.toContain("browser.newFile");
    expect(commandIds).not.toContain("browser.createArchive");
    expect(commandIds).not.toContain("browser.extractArchive");
    expect(commandIds).not.toContain("browser.openInApp");
    expect(commandIds).not.toContain("browser.copyToOtherPane");
    expect(commandIds).not.toContain("browser.moveToOtherPane");
  });

  it.each([
    ["browser.openLocationInNewTab", "openLocationInNewTab", "Ctrl+Alt+T"],
    ["browser.matchLeftPaneLocation", "matchLeftPaneLocation", "Ctrl+Left"],
    ["browser.matchRightPaneLocation", "matchRightPaneLocation", "Ctrl+Right"],
  ] as const)("runs %s without requiring writable files", (id, handler, shortcutLabel) => {
    const context = createContext();
    context.connectionWritable = false;
    context.hasFiles = false;
    context.hasFocusedFile = false;
    context[handler] = vi.fn();
    const command = getEnabledBrowserCommands(context).find((candidate) => candidate.id === id);
    expect(command).toMatchObject({ shortcutLabel });
    command?.run(context);
    expect(context[handler]).toHaveBeenCalledOnce();
  });

  it("omits location commands when their location is unavailable", () => {
    const context = createContext();
    context.canOpenLocationInNewTab = false;
    context.canMatchPaneLocations = false;
    const ids = getEnabledBrowserCommands(context).map((command) => command.id);
    expect(ids).not.toContain("browser.openLocationInNewTab");
    expect(ids).not.toContain("browser.matchLeftPaneLocation");
    expect(ids).not.toContain("browser.matchRightPaneLocation");
  });

  it("runs archive creation only when a writable selection has an available executor", () => {
    const context = createContext();
    let invoked = 0;
    context.createArchive = () => {
      invoked += 1;
    };

    const archiveCommand = getEnabledBrowserCommands(context).find((command) => command.id === "browser.createArchive");
    archiveCommand?.run(context);

    expect(invoked).toBe(1);
    expect(archiveCommand).toMatchObject({ defaultShortcutIds: ["create-archive"], shortcutLabel: "Alt+F5" });
    context.canCreateArchive = false;
    expect(getEnabledBrowserCommands(context).map((command) => command.id)).not.toContain("browser.createArchive");
  });

  it("runs archive extraction only while an archive can be extracted", () => {
    const context = createContext();
    let invoked = 0;
    context.extractArchive = () => {
      invoked += 1;
    };

    const archiveCommand = getEnabledBrowserCommands(context).find((command) => command.id === "browser.extractArchive");
    archiveCommand?.run(context);

    expect(invoked).toBe(1);
    expect(archiveCommand).toMatchObject({ defaultShortcutIds: ["extract-archive"], shortcutLabel: "Alt+F9" });
    context.canExtractArchive = false;
    expect(getEnabledBrowserCommands(context).map((command) => command.id)).not.toContain("browser.extractArchive");
  });
});
