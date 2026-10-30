import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, translate } from "../../../i18n";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import { type FileEntry, FileType } from "../../../types";
import { StatusBar } from "../StatusBar";

const baseFile: FileEntry = {
  name: "notes.txt",
  path: "/notes.txt",
  type: FileType.FILE,
  size: 1024,
  modified_at: undefined,
  is_readable: true,
  is_hidden: false,
};

function renderWithProvider(component: React.ReactElement) {
  return render(<SambeeThemeProvider>{component}</SambeeThemeProvider>);
}

describe("StatusBar", () => {
  afterEach(async () => {
    cleanup();
    await setLocale("en");
  });

  it("remains visible for an empty directory", () => {
    renderWithProvider(<StatusBar files={[]} focusedIndex={-1} canResolveShortcutTargets={false} />);

    expect(screen.queryByText("No selection")).not.toBeInTheDocument();
    expect(screen.getByText("0 items")).toBeInTheDocument();
  });

  it("replaces focused details with a translated selection count while keeping the total", async () => {
    const { rerender } = renderWithProvider(
      <StatusBar files={[baseFile]} focusedIndex={0} selectedCount={0} canResolveShortcutTargets={false} />
    );
    expect(screen.getByTestId("status-bar-focused-file-name")).toHaveTextContent("notes.txt");

    rerender(
      <SambeeThemeProvider>
        <StatusBar files={[baseFile]} focusedIndex={0} selectedCount={1} canResolveShortcutTargets={false} />
      </SambeeThemeProvider>
    );
    expect(screen.getByText("1 item selected")).toBeInTheDocument();
    expect(screen.queryByTestId("status-bar-focused-file-name")).not.toBeInTheDocument();
    expect(screen.getByText("1 item")).toBeInTheDocument();

    await act(async () => {
      await setLocale("en-XA");
    });
    rerender(
      <SambeeThemeProvider>
        <StatusBar files={[baseFile]} focusedIndex={0} selectedCount={2} canResolveShortcutTargets={false} />
      </SambeeThemeProvider>
    );
    expect(screen.getByText(translate("fileBrowser.compactActions.selectedCount", { count: 2 }))).toBeInTheDocument();
  });

  it("uses the translated item count without a selected file", async () => {
    await setLocale("en-XA");

    renderWithProvider(<StatusBar files={[baseFile]} focusedIndex={5} canResolveShortcutTargets={false} />);

    expect(screen.queryByText("[Ńó šéĺéćťíóń]")).not.toBeInTheDocument();
    expect(screen.getByText("[1 íťéḿ]")).toBeInTheDocument();
  });

  it("reports a missing shortcut target for the selected item", () => {
    renderWithProvider(
      <StatusBar
        files={[
          {
            ...baseFile,
            link_kind: "windows_shortcut",
            link_target: {
              source_path: "notes.txt.lnk",
              state: "missing",
            },
          },
        ]}
        focusedIndex={0}
        canResolveShortcutTargets
      />
    );

    expect(screen.getByText("Shortcut target not found")).toBeInTheDocument();
  });

  it("reports an unresolved shortcut extension for the selected item", () => {
    renderWithProvider(<StatusBar files={[{ ...baseFile, name: "My Drive.lnk" }]} focusedIndex={0} canResolveShortcutTargets={false} />);

    expect(screen.getByText("Shortcut targets can only be resolved on local drives")).toBeInTheDocument();
  });

  it("reports a Companion unresolvable target independently of connection type", () => {
    renderWithProvider(
      <StatusBar
        files={[
          {
            ...baseFile,
            name: "Broken.lnk",
            link_kind: "windows_shortcut",
            link_target: {
              source_path: "Broken.lnk",
              state: "unresolvable",
            },
          },
        ]}
        focusedIndex={0}
        canResolveShortcutTargets
      />
    );

    expect(screen.getByText("Shortcut target cannot be resolved")).toBeInTheDocument();
  });
});
