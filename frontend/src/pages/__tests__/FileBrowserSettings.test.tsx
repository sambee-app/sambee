import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../../test/utils/test-utils";
import { FileBrowserSettings } from "../FileBrowserSettings";

const {
  clearRecentDirectoriesMock,
  clearRecentFilesMock,
  publishRecentDirectoriesChangedMock,
  publishRecentFilesChangedMock,
  commitMock,
  settingStates,
} = vi.hoisted(() => ({
  clearRecentDirectoriesMock: vi.fn(),
  clearRecentFilesMock: vi.fn(),
  publishRecentDirectoriesChangedMock: vi.fn(),
  publishRecentFilesChangedMock: vi.fn(),
  commitMock: vi.fn(),
  settingStates: {
    includeDotDirectories: { error: null as string | null, pending: false, saved: false },
    shortcutHints: { error: null as string | null, pending: false, saved: false },
    touchFriendlyFileSelection: { error: null as string | null, pending: false, saved: false },
  },
}));

vi.mock("../../services/userSettingsStore", () => ({
  useCurrentUserSetting: (field: string) => {
    const state =
      field === "browser.quick_nav_include_dot_directories"
        ? settingStates.includeDotDirectories
        : field === "browser.touch_friendly_file_selection"
          ? settingStates.touchFriendlyFileSelection
          : settingStates.shortcutHints;
    return {
      confirmedValue: field === "browser.quick_nav_include_dot_directories" ? false : "auto",
      ...state,
      commit: commitMock,
      clearError: vi.fn(),
    };
  },
}));

vi.mock("../../services/api", () => ({
  default: {
    clearRecentDirectories: clearRecentDirectoriesMock,
    clearRecentFiles: clearRecentFilesMock,
  },
}));

vi.mock("../../services/recentFilesSync", () => ({
  publishRecentFilesChanged: publishRecentFilesChangedMock,
}));

vi.mock("../../services/recentDirectoriesSync", () => ({
  publishRecentDirectoriesChanged: publishRecentDirectoriesChangedMock,
}));

describe("FileBrowserSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRecentDirectoriesMock.mockResolvedValue(0);
    clearRecentFilesMock.mockResolvedValue(0);
    commitMock.mockResolvedValue(undefined);
    for (const state of Object.values(settingStates)) {
      state.error = null;
      state.pending = false;
      state.saved = false;
    }
  });

  it("renders the quick navigation settings group", () => {
    render(<FileBrowserSettings />);

    expect(screen.getByText("File Browser")).toBeInTheDocument();
    expect(screen.getByText("Quick navigation")).toBeInTheDocument();
    expect(screen.queryByText("Choose how quick navigation discovers folders in the file browser.")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include dot directories in quick nav" })).toBeInTheDocument();
  });

  it("updates the dot-directory preference", async () => {
    const user = userEvent.setup();
    render(<FileBrowserSettings />);

    await user.click(screen.getByRole("checkbox", { name: "Include dot directories in quick nav" }));
    expect(commitMock).toHaveBeenCalledWith(true);
  });

  it("updates the shortcut-hint visibility preference", async () => {
    const user = userEvent.setup();
    render(<FileBrowserSettings />);

    await user.click(screen.getByRole("combobox", { name: "Keyboard shortcut hints" }));
    await user.click(screen.getByRole("option", { name: "Never show" }));

    expect(commitMock).toHaveBeenCalledWith("never");
  });

  it("updates the touch-friendly file-selection preference", async () => {
    const user = userEvent.setup();
    render(<FileBrowserSettings />);

    await user.click(screen.getByRole("combobox", { name: "Touch-friendly file selection" }));
    await user.click(screen.getByRole("option", { name: "Always on" }));

    expect(commitMock).toHaveBeenCalledWith("always");
  });

  it("renders checkbox and select persistence feedback", () => {
    settingStates.includeDotDirectories.pending = true;
    const { rerender } = render(<FileBrowserSettings />);

    expect(screen.getByRole("checkbox", { name: "Include dot directories in quick nav" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Saving setting" })).toBeInTheDocument();

    settingStates.includeDotDirectories.pending = false;
    settingStates.includeDotDirectories.saved = true;
    settingStates.shortcutHints.error = "Unable to save shortcut hints.";
    rerender(<FileBrowserSettings />);
    expect(screen.getByRole("status", { name: "Setting saved" })).toBeInTheDocument();
    expect(screen.getByText("Unable to save shortcut hints.")).toBeInTheDocument();
  });

  it("restores checkbox focus after saving", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FileBrowserSettings />);
    const includeDotDirectories = screen.getByRole("checkbox", { name: "Include dot directories in quick nav" });

    await act(async () => includeDotDirectories.focus());
    await user.keyboard(" ");
    expect(commitMock).toHaveBeenCalledWith(true);

    settingStates.includeDotDirectories.pending = true;
    rerender(<FileBrowserSettings />);
    await act(async () => includeDotDirectories.blur());
    settingStates.includeDotDirectories.pending = false;
    rerender(<FileBrowserSettings />);

    await waitFor(() => expect(includeDotDirectories).toHaveFocus());
  });

  it("cancels clear-history confirmation and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<FileBrowserSettings />);

    const trigger = screen.getByRole("button", { name: "Clear recent files" });
    await act(async () => trigger.focus());
    await user.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "This permanently removes your File Search history from the server without affecting any files or folders."
    );
    expect(dialog).not.toHaveTextContent("This does not affect any files or folders.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveClass("MuiButton-outlined");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(clearRecentFilesMock).not.toHaveBeenCalled();
  });

  it("shows a pending state, publishes success, and restores trigger focus after clearing history", async () => {
    const user = userEvent.setup();
    let resolveClear: ((deletedCount: number) => void) | undefined;
    clearRecentFilesMock.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveClear = resolve;
        })
    );
    render(<FileBrowserSettings />);

    const trigger = screen.getByRole("button", { name: "Clear recent files" });
    await act(async () => trigger.focus());
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear recent files" });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveClear?.(3);

    await waitFor(() => {
      expect(clearRecentFilesMock).toHaveBeenCalledOnce();
      expect(publishRecentFilesChangedMock).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  it("keeps the confirmation open and shows an error when clearing history fails", async () => {
    const user = userEvent.setup();
    clearRecentFilesMock.mockRejectedValueOnce(new Error("network failure"));
    render(<FileBrowserSettings />);

    await user.click(screen.getByRole("button", { name: "Clear recent files" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear recent files" }));

    expect(await screen.findByText("Could not clear recent files. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(publishRecentFilesChangedMock).not.toHaveBeenCalled();
  });

  it("clears recent directories and publishes the dedicated history event", async () => {
    const user = userEvent.setup();
    render(<FileBrowserSettings />);

    await user.click(screen.getByRole("button", { name: "Clear recent directories" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear recent directories" }));

    await waitFor(() => {
      expect(clearRecentDirectoriesMock).toHaveBeenCalledOnce();
      expect(publishRecentDirectoriesChangedMock).toHaveBeenCalledOnce();
    });
  });
});
