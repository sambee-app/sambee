import { createMockAuthToken } from "../../test/fixtures/users";
/**
 * FileBrowser — URL Routing Tests (Phase 3)
 * ==========================================
 *
 * Verifies:
 * - Single-pane typed URLs load correctly
 * - Dual-pane mode is restored when ?p2= is present in the URL
 * - Right pane connection and path are restored from ?p2=type/id/path
 * - Active pane is restored from ?active=2
 * - Invalid typed p2 targets are handled gracefully
 * - Local-drive routes participate in URL restoration
 * - URL query param constants are correct
 */

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { type ApiMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { FileType } from "../../types";
import { type BrowseRouteState, parseBrowseRoute, serializeBrowseRoute } from "../FileBrowser/routing";
import { ACTIVE_PANE_QUERY_KEY, RIGHT_PANE_QUERY_KEY } from "../FileBrowser/types";
import { mockDirectoryListing, renderBrowser } from "./FileBrowser.test.utils";

const expectDirectoryLoad = (connectionId: string, path: string) => {
  expect(api.listDirectory).toHaveBeenCalledWith(
    connectionId,
    path,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    })
  );
};

// Mock the API module
vi.mock("../../services/api");
vi.mock("../AccountSettings", () => ({ AccountSettings: () => <div>Account content</div> }));

// Mock components using lazy mock factories
vi.mock("../../components/Viewer/MarkdownViewer", () => ({
  default: ({
    onClose,
    navigation,
    path,
    isTransitioning,
  }: {
    onClose: () => void;
    path: string;
    isTransitioning?: boolean;
    navigation?: { mode: string; onModeChange: (mode: "view" | "edit") => void };
  }) => (
    <div role="dialog" data-testid="markdown-viewer" data-mode={navigation?.mode} data-path={path} data-pending={isTransitioning}>
      Markdown Viewer
      <button type="button" onClick={() => navigation?.onModeChange("edit")}>
        Enter editor
      </button>
      <button type="button" onClick={() => navigation?.onModeChange("view")}>
        Leave editor
      </button>
      <button type="button" onClick={onClose}>
        Close Viewer
      </button>
    </div>
  ),
}));
vi.mock("../../components/Settings/SettingsDialog", () => ({
  default: ({
    open,
    category,
    onNavigate,
    onClose,
  }: {
    open: boolean;
    category: string;
    onNavigate: (value: string) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="settings-dialog" data-category={category}>
        <button type="button" onClick={() => onNavigate("account")}>
          Account category
        </button>
        <button type="button" onClick={() => onNavigate("connections")}>
          Connections category
        </button>
        <button type="button" onClick={onClose}>
          Close Settings
        </button>
      </div>
    ) : null,
}));
// @tanstack/react-virtual mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

describe("FileBrowser — URL Routing (Phase 3)", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");
    localStorage.removeItem("dual-pane-mode");
    localStorage.removeItem("active-pane");
    localStorage.removeItem("companion_secret");

    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  // --------------------------------------------------------------------------
  // Constants
  // --------------------------------------------------------------------------

  describe("URL query param constants", () => {
    it("round trips independent viewer targets, edit intent, settings, and unrelated query state", () => {
      const route: BrowseRouteState = {
        left: { kind: "smb", targetId: "test-server-1", path: "Documents" },
        right: { kind: "local", targetId: "drive %", path: "" },
        activePaneId: "right",
        viewer: {
          file: {
            kind: "smb",
            targetId: "other server",
            path: "archive.zip/notes/100% #.md",
            virtualLocation: { providerId: "zip", sourcePath: "archive.zip", virtualPath: "notes/100% #.md" },
          },
          paneId: "right",
          viewerId: "markdown",
          mode: "edit",
        },
        settings: "admin-users",
        extraSearch: "q=someone&page=2",
      };
      const url = new URL(serializeBrowseRoute(route), "http://localhost");
      expect(parseBrowseRoute({ targetType: "smb", targetId: "test-server-1", path: "Documents", searchParams: url.searchParams })).toEqual(
        route
      );
    });

    it.each([
      "file=smb%2Fdemo%2Ffile.txt&viewer=unknown",
      "file=smb%2Fdemo%2Ffile.txt&viewer=text&pane=2",
      "file=smb%2Fdemo%2Fimage.png&viewer=image&mode=edit",
      "file=smb%2Fdemo%2F%25broken&viewer=text&virtual=invalid",
    ])("ignores invalid workspace descriptors: %s", (search) => {
      expect(parseBrowseRoute({ searchParams: new URLSearchParams(search) }).viewer).toBeUndefined();
    });

    it("RIGHT_PANE_QUERY_KEY is 'p2'", () => {
      expect(RIGHT_PANE_QUERY_KEY).toBe("p2");
    });

    it("ACTIVE_PANE_QUERY_KEY is 'active'", () => {
      expect(ACTIVE_PANE_QUERY_KEY).toBe("active");
    });

    it("serializes independent virtual locations as slash-delimited pane paths", () => {
      const route = {
        left: {
          kind: "smb" as const,
          targetId: "test-server-1",
          path: "Archives",
          virtualLocation: { providerId: "zip", sourcePath: "Archives/left.zip", virtualPath: "docs" },
        },
        right: {
          kind: "smb" as const,
          targetId: "test-server-2",
          path: "Backups",
          virtualLocation: { providerId: "zip", sourcePath: "Backups/right.zip", virtualPath: "inside" },
        },
        activePaneId: "right" as const,
      };

      const url = serializeBrowseRoute(route);
      expect(url).toBe("/browse/smb/test-server-1/Archives/left.zip/docs?p2=smb%2Ftest-server-2%2FBackups%2Fright.zip%2Finside&active=2");

      const parsedUrl = new URL(url, "http://localhost");
      expect(
        parseBrowseRoute({
          targetType: "smb",
          targetId: "test-server-1",
          path: "Archives/left.zip/docs",
          searchParams: parsedUrl.searchParams,
        })
      ).toEqual({
        left: { kind: "smb", targetId: "test-server-1", path: "Archives/left.zip/docs" },
        right: { kind: "smb", targetId: "test-server-2", path: "Backups/right.zip/inside" },
        activePaneId: "right",
      });
    });
  });

  describe("settings dialog routing", () => {
    it("commits category navigation synchronously while retaining category history", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1?settings=appearance");
      await screen.findByTestId("settings-dialog");
      const navigate = vi.spyOn(router, "navigate");
      await user.click(screen.getByRole("button", { name: "Account category" }));
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: "?settings=account" }),
        expect.objectContaining({ flushSync: true })
      );
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", "appearance");
      await act(() => router.navigate(1));
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
    });

    it("uses observed mobile category history even when the main view was a direct link", async () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches: query.includes("max-width"),
          media: query,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }))
      );
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1?settings=main");
      const drawer = await screen.findByRole("dialog");
      await user.click(within(drawer).getByText("Account", { exact: true }));
      expect(router.state.location.search).toContain("settings=account");
      await user.click(screen.getByRole("button", { name: "Go back" }));
      await waitFor(() => expect(router.state.location.search).toContain("settings=main"));
      await act(() => router.navigate(1));
      await waitFor(() => expect(router.state.location.search).toContain("settings=account"));
    });
    it("records settings Close and retraces category history with Back and Forward", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1");
      await user.click(await screen.findByRole("button", { name: /open settings/i }));
      const initialCategory = (await screen.findByTestId("settings-dialog")).getAttribute("data-category");
      await user.click(await screen.findByRole("button", { name: "Account category" }));
      await user.click(screen.getByRole("button", { name: "Connections category" }));
      expect(router.state.location.search).toContain("settings=connections");
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
      await user.click(screen.getByRole("button", { name: "Close Settings" }));
      await waitFor(() => expect(router.state.location.search).not.toContain("settings="));
      await act(() => router.navigate(-1));
      expect(await screen.findByTestId("settings-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("settings-dialog")).toHaveAttribute("data-category", initialCategory);
      await act(() => router.navigate(2));
      await waitFor(() => expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument());
    });

    it("dismisses a direct category link without leaving the workspace", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1?settings=account");
      await user.click(await screen.findByRole("button", { name: "Close Settings" }));
      expect(router.state.location.pathname).toBe("/browse/smb/test-server-1");
      expect(router.state.location.search).not.toContain("settings=");
    });
    it("opens the requested settings category from the settings query parameter", async () => {
      renderBrowser("/browse/smb/test-server-1?settings=admin-authentication#flow=test-flow");

      const dialog = await screen.findByTestId("settings-dialog");

      expect(dialog).toHaveAttribute("data-category", "admin-authentication");
    });

    it("opens the File Search settings category from the settings query parameter", async () => {
      renderBrowser("/browse/smb/test-server-1?settings=admin-file-search");

      const dialog = await screen.findByTestId("settings-dialog");

      expect(dialog).toHaveAttribute("data-category", "admin-file-search");
    });
  });

  describe("viewer history", () => {
    beforeEach(() => {
      vi.mocked(api.listDirectory).mockResolvedValue({
        ...mockDirectoryListing,
        items: [
          ...mockDirectoryListing.items,
          {
            name: "readme.md",
            path: "readme.md",
            type: FileType.FILE,
            mime_type: "text/markdown",
            size: 20,
            is_readable: true,
            is_hidden: false,
          },
        ],
      });
      vi.mocked(api.getFileInfo).mockResolvedValue({ type: FileType.FILE, size: 20, mime_type: "text/markdown" } as never);
    });
    it("pushes a viewer location and restores it with Back and Forward", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1");
      await user.click(await screen.findByRole("button", { name: /file: readme\.md/i }));
      expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
      expect(new URLSearchParams(router.state.location.search).get("viewer")).toBe("markdown");
      await act(() => router.navigate(-1));
      await waitFor(() => expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument());
      expect(router.state.location.pathname).toBe("/browse/smb/test-server-1");
      await act(() => router.navigate(1));
      expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
    });

    it.each([false, true])("records viewer Close and restores the file with Back (direct link: %s)", async (direct) => {
      const user = userEvent.setup();
      const directory = "/browse/smb/test-server-1/Documents";
      const viewer = `${directory}?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown&keep=1#anchor`;
      const { router } = renderBrowser(direct ? viewer : `${directory}?keep=1#anchor`);
      if (!direct) await user.click(await screen.findByRole("button", { name: /file: readme\.md/i }));
      await user.click(await screen.findByRole("button", { name: "Close Viewer" }));
      await waitFor(() => expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument());
      expect(router.state.location.pathname).toBe(directory);
      expect(router.state.location.search).toBe("?keep=1");
      expect(router.state.location.hash).toBe("#anchor");

      await act(() => router.navigate(-1));
      expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
      if (!direct) {
        await act(() => router.navigate(-1));
        await waitFor(() => expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument());
        expect(router.state.location.pathname).toBe(directory);
        await act(() => router.navigate(1));
        expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
      }
      await act(() => router.navigate(1));
      await waitFor(() => expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument());
    });

    it("records edit exit without overwriting the prior editor entry", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown");
      await user.click(await screen.findByRole("button", { name: "Enter editor" }));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "edit"));
      await user.click(screen.getByRole("button", { name: "Leave editor" }));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "view"));
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "edit");
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "view");
      await act(() => router.navigate(2));
      expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "view");
    });

    it("records settings Close while preserving its underlying viewer", async () => {
      const user = userEvent.setup();
      const { router } = renderBrowser(
        "/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown&settings=account&keep=1#anchor"
      );
      await screen.findByTestId("markdown-viewer");
      await user.click(await screen.findByRole("button", { name: "Close Settings" }));
      await waitFor(() => expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument());
      expect(screen.getByTestId("markdown-viewer")).toBeInTheDocument();
      expect(router.state.location.search).toContain("keep=1");
      expect(router.state.location.hash).toBe("#anchor");
      await act(() => router.navigate(-1));
      expect(await screen.findByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
      await act(() => router.navigate(1));
      await waitFor(() => expect(screen.queryByTestId("settings-dialog")).not.toBeInTheDocument());
      expect(screen.getByTestId("markdown-viewer")).toBeInTheDocument();
    });

    it("opens a fresh viewer URL without a file-row click", async () => {
      const { router } = renderBrowser("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown");
      expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
      expect(router.state.location.search).toContain("viewer=markdown");
      expect(api.getFileInfo).toHaveBeenCalled();
    });

    it("keeps the same viewer mounted through delayed file navigation and Back", async () => {
      const first = "/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown";
      const second = "/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Fother.md&viewer=markdown";
      const { router } = renderBrowser(first);
      const outgoing = await screen.findByTestId("markdown-viewer");
      let finishMetadata!: (metadata: never) => void;
      vi.mocked(api.getFileInfo).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMetadata = resolve;
          })
      );
      await act(() => router.navigate(second));
      expect(screen.getByTestId("markdown-viewer")).toBe(outgoing);
      expect(outgoing).toHaveAttribute("data-path", "readme.md");
      expect(outgoing).toHaveAttribute("data-pending", "true");
      expect(screen.queryByRole("dialog", { name: /^loading$/i })).not.toBeInTheDocument();
      await act(async () => finishMetadata({ type: FileType.FILE, size: 20, mime_type: "text/markdown" } as never));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-path", "other.md"));
      const incoming = screen.getByTestId("markdown-viewer");
      vi.mocked(api.getFileInfo).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMetadata = resolve;
          })
      );
      await act(() => router.navigate(-1));
      expect(screen.getByTestId("markdown-viewer")).toBe(incoming);
      expect(incoming).toHaveAttribute("data-path", "other.md");
      await act(async () => finishMetadata({ type: FileType.FILE, size: 20, mime_type: "text/markdown" } as never));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-path", "readme.md"));
    });

    it("cancels a pending file change on Escape and ignores its late metadata", async () => {
      const { router } = renderBrowser("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown");
      await screen.findByTestId("markdown-viewer");
      let finishMetadata!: (metadata: never) => void;
      vi.mocked(api.getFileInfo).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMetadata = resolve;
          })
      );
      await act(() => router.navigate("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Fother.md&viewer=markdown"));
      const user = userEvent.setup();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(router.state.location.search).not.toContain("viewer="));
      await act(async () => finishMetadata({ type: FileType.FILE, size: 20, mime_type: "text/markdown" } as never));
      expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument();
    });

    it("offers retry for an unavailable file and closes a direct link safely", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getFileInfo).mockRejectedValueOnce(new Error("File unavailable"));
      const { router } = renderBrowser("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown");
      expect(await screen.findByText(/File unavailable/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /retry/i }));
      expect(await screen.findByTestId("markdown-viewer")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Close Viewer" }));
      await waitFor(() => expect(router.state.location.search).not.toContain("viewer="));
      expect(router.state.location.pathname).toBe("/browse/smb/test-server-1");
    });

    it.each([1, 2])("reuses resolved viewer metadata after %s failed attempts", async (failures) => {
      const user = userEvent.setup();
      for (let attempt = 0; attempt < failures; attempt += 1) {
        vi.mocked(api.getFileInfo).mockRejectedValueOnce(new Error("File unavailable"));
      }
      const { router } = renderBrowser("/browse/smb/test-server-1?file=smb%2Ftest-server-1%2Freadme.md&viewer=markdown");
      for (let attempt = 0; attempt < failures; attempt += 1) {
        await screen.findByText(/File unavailable/);
        await user.click(screen.getByRole("button", { name: /retry/i }));
      }
      await screen.findByTestId("markdown-viewer");
      expect(api.getFileInfo).toHaveBeenCalledTimes(failures + 1);
      await user.click(screen.getByRole("button", { name: "Enter editor" }));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "edit"));
      await user.click(screen.getByRole("button", { name: "Leave editor" }));
      await waitFor(() => expect(screen.getByTestId("markdown-viewer")).toHaveAttribute("data-mode", "view"));
      await act(() => router.navigate(`${router.state.location.pathname}${router.state.location.search}&settings=account`));
      expect(await screen.findByTestId("settings-dialog")).toHaveAttribute("data-category", "account");
      await act(() => router.navigate(-1));
      await act(() => router.navigate(1));
      expect(api.getFileInfo).toHaveBeenCalledTimes(failures + 1);
    });

    it("normalizes an invalid workspace descriptor while preserving unrelated query and hash", async () => {
      const { router } = renderBrowser("/browse/smb/test-server-1?file=bad&viewer=unknown&settings=unknown&keep=1#anchor");
      await waitFor(() => expect(router.state.location.search).toBe("?keep=1"));
      expect(router.state.location.hash).toBe("#anchor");
      expect(router.state.location.pathname).toBe("/browse/smb/test-server-1");
    });
  });

  // --------------------------------------------------------------------------
  // Single-pane backward compatibility
  // --------------------------------------------------------------------------

  describe("single-pane typed routes", () => {
    it("loads single-pane mode from a clean URL without query params", async () => {
      renderBrowser("/browse/smb/test-server-1");

      // Should load and display files in single pane
      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
      });

      // Files should render
      await waitFor(() => {
        const docs = screen.getAllByText("Documents");
        expect(docs.length).toBeGreaterThan(0);
      });
    });

    it("loads single-pane mode with a subpath", async () => {
      renderBrowser("/browse/smb/test-server-1/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });
    });

    it("serializes archive navigation and restores a virtual archive deep link", async () => {
      vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") => ({
        path,
        items:
          path === "Archives"
            ? [
                {
                  name: "backup.zip",
                  path: "Archives/backup.zip",
                  type: FileType.FILE,
                  is_readable: true,
                  is_hidden: false,
                },
              ]
            : [],
        total: path === "Archives" ? 1 : 0,
      }));
      vi.mocked(api.listArchiveDirectory).mockImplementation(async (_connectionId, archivePath, virtualPath = "") => ({
        archive: { path: archivePath, size: 1 },
        path: virtualPath,
        items:
          virtualPath === ""
            ? [{ name: "nested", path: "nested", type: FileType.DIRECTORY, state: "readable", is_hidden: false }]
            : [{ name: "member.txt", path: "nested/member.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
        total: 1,
        page_size: 100,
      }));
      vi.mocked(api.getFileInfo).mockImplementation(
        async (_connectionId, path) =>
          ({
            type: path === "Archives/backup.zip" ? FileType.FILE : FileType.DIRECTORY,
          }) as never
      );

      const user = userEvent.setup();
      renderBrowser("/browse/smb/test-server-1/Archives");

      await user.click(await screen.findByRole("button", { name: /file: backup\.zip/i }));
      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Archives/backup.zip");
      });

      await user.click(await screen.findByRole("button", { name: /folder: nested/i }));
      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Archives/backup.zip/nested");
      });

      await user.keyboard("{Backspace}");
      await user.keyboard("{Backspace}");
      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Archives");
      });
    });

    it("hydrates an archive deep link through its virtual provider", async () => {
      vi.mocked(api.listArchiveDirectory).mockImplementation(async (_connectionId, archivePath, virtualPath = "") => ({
        archive: { path: archivePath, size: 1 },
        path: virtualPath,
        items:
          virtualPath === ""
            ? [{ name: "nested", path: "nested", type: FileType.DIRECTORY, state: "readable", is_hidden: false }]
            : [{ name: "member.txt", path: "nested/member.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
        total: 1,
        page_size: 100,
      }));
      vi.mocked(api.getFileInfo).mockImplementation(
        async (_connectionId, path) =>
          ({
            type: path === "Archives/backup.zip" ? FileType.FILE : FileType.DIRECTORY,
          }) as never
      );

      renderBrowser("/browse/smb/test-server-1/Archives/backup.zip/nested");
      await waitFor(() => {
        expect(api.listArchiveDirectory).toHaveBeenCalledWith("conn-1", "Archives/backup.zip", "nested", {
          pageSize: 100,
          signal: expect.any(AbortSignal),
        });
      });
      expect((await screen.findAllByText("member.txt")).length).toBeGreaterThan(0);
    });

    it("keeps physical directory semantics for a directory named with an archive extension", async () => {
      vi.mocked(api.getFileInfo).mockResolvedValue({ type: FileType.DIRECTORY } as never);

      renderBrowser("/browse/smb/test-server-1/folder.zip/child");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "folder.zip/child");
      });
      expect(api.listArchiveDirectory).not.toHaveBeenCalled();
    });

    it("replaces a missing archive route with its deepest existing physical ancestor", async () => {
      vi.mocked(api.getFileInfo).mockImplementation(async (_connectionId, path) => {
        if (path === "Existing/missing.zip") {
          throw { isAxiosError: true, response: { status: 404 } };
        }
        return { type: FileType.DIRECTORY } as never;
      });

      renderBrowser("/browse/smb/test-server-1/Existing/missing.zip");

      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Existing");
        expectDirectoryLoad("conn-1", "Existing");
      });
    });

    it("replaces an invalid archive route with the physical parent directory", async () => {
      vi.mocked(api.getFileInfo).mockImplementation(
        async (_connectionId, path) =>
          ({
            type: path === "Archives/broken.zip" ? FileType.FILE : FileType.DIRECTORY,
          }) as never
      );
      vi.mocked(api.listArchiveDirectory).mockRejectedValue({ isAxiosError: true, response: { status: 422 } });

      renderBrowser("/browse/smb/test-server-1/Archives/broken.zip/nested");

      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Archives");
        expectDirectoryLoad("conn-1", "Archives");
      });
    });
  });

  // --------------------------------------------------------------------------
  // Dual-pane restoration from URL
  // --------------------------------------------------------------------------

  describe("dual-pane restoration from URL", () => {
    it("activates dual-pane mode when ?p2= is present", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb/test-server-2");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      // Both panes should request directory listings
      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
      });

      await waitFor(() => {
        expectDirectoryLoad("conn-2", "");
      });
    });

    it("restores right pane path from ?p2=type/id/path/segments", async () => {
      renderBrowser("/browse/smb/test-server-1/Documents?p2=smb/test-server-2/Pictures");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      // Left pane should load Documents
      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });

      // Right pane should load Pictures
      await waitFor(() => {
        expectDirectoryLoad("conn-2", "Pictures");
      });
    });

    it("restores both panes to the same connection", async () => {
      renderBrowser("/browse/smb/test-server-1/Documents?p2=smb/test-server-1/Pictures");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      // Both calls should use conn-1 with different paths
      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Pictures");
      });
    });

    it("persists dual-pane mode through the current-user settings store when restored from URL", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb/test-server-2");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
      });
    });
  });

  // --------------------------------------------------------------------------
  // Active pane restoration
  // --------------------------------------------------------------------------

  describe("active pane restoration from URL", () => {
    it("defaults to left pane when ?active is absent", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb/test-server-2");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1?p2=smb/test-server-2");
      });
    });

    it("restores right pane as active when ?active=2", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb/test-server-2&active=2");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1?p2=smb/test-server-2&active=2");
      });
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe("edge cases", () => {
    it("ignores malformed encoded right-pane paths without breaking the left pane", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb%2Ftest-server-2%2Fbad%25name&active=2");

      await waitFor(() => expectDirectoryLoad("conn-1", ""));
      expect(vi.mocked(api.listDirectory).mock.calls.some(([connectionId]) => connectionId === "conn-2")).toBe(false);
    });

    it("preserves valid encoded percent signs in right-pane paths", () => {
      const route = serializeBrowseRoute({
        left: { kind: "smb", targetId: "test-server-1", path: "" },
        right: { kind: "smb", targetId: "test-server-2", path: "100% ready" },
        activePaneId: "right",
      });
      const url = new URL(route, "http://localhost");
      expect(parseBrowseRoute({ targetType: "smb", targetId: "test-server-1", searchParams: url.searchParams }).right?.path).toBe(
        "100% ready"
      );
    });

    it("ignores invalid SMB p2 targets gracefully", async () => {
      renderBrowser("/browse/smb/test-server-1?p2=smb/nonexistent-server/photos");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      // Left pane should still load normally
      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
      });

      // Right pane should NOT have loaded (invalid connection slug)
      // Only conn-1 calls should exist
      const listDirCalls = vi.mocked(api.listDirectory).mock.calls;
      const conn2Calls = listDirCalls.filter((call) => call[0] === "conn-2");
      expect(conn2Calls).toHaveLength(0);
    });

    it("handles p2 with no path (root of connection)", async () => {
      renderBrowser("/browse/smb/test-server-1/Documents?p2=smb/test-server-2");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      // Right pane should load root
      await waitFor(() => {
        expectDirectoryLoad("conn-2", "");
      });
    });

    it("loads local drives from typed left-pane URLs", async () => {
      renderBrowser("/browse/local/c/Users");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expectDirectoryLoad("local-drive:c", "Users");
      });
    });

    it("restores a local drive in the right pane from p2", async () => {
      renderBrowser("/browse/smb/test-server-1/Documents?p2=local/c/Users");

      await waitFor(() => {
        expect(api.getConnections).toHaveBeenCalled();
      });

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });

      await waitFor(() => {
        expectDirectoryLoad("local-drive:c", "Users");
      });
    });

    it("opens local-drive recovery rather than retrying a rejected left-pane signature", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue({
        response: { status: 403, data: { code: "companion_auth_signature_mismatch", detail: "Invalid authentication" } },
      });

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByText(/Sambee Companion rejected this browser's pairing/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reload Sambee" })).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: "Local Drives" }));
      expect(await screen.findByTestId("settings-dialog")).toHaveAttribute("data-category", "local-drives");
    });

    it("identifies the failing pane when a local drive rejects a signature in dual-pane mode", async () => {
      vi.mocked(api.listDirectory).mockImplementation(async (connectionId) => {
        if (connectionId === "local-drive:c") {
          throw { response: { status: 403, data: { code: "companion_auth_signature_mismatch", detail: "Invalid authentication" } } };
        }
        return mockDirectoryListing;
      });

      renderBrowser("/browse/smb/test-server-1?p2=local/c/Users");

      const alert = (await screen.findByText(/Sambee Companion rejected this browser's pairing/i)).closest("[role='alert']");
      expect(alert).toHaveTextContent("Right pane:");
      expect(alert).toHaveTextContent(/Sambee Companion rejected this browser's pairing/i);
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("recognizes the old browser signing protocol without presenting Retry", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue({
        response: {
          status: 403,
          data: { code: "companion_browser_update_required", detail: "Sambee browser is out of date. Reload the page." },
        },
      });

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByText(/Sambee Companion rejected this browser's pairing/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reload Sambee" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("opens pairing settings when Companion has removed this origin's pairing", async () => {
      localStorage.setItem("companion_secret", "old-secret");
      vi.mocked(api.listDirectory).mockRejectedValue({
        response: { status: 403, data: { code: "companion_pairing_not_found", detail: "Not paired with this origin" } },
      });

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByText(/This browser is not paired with Sambee Companion/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reload Sambee" })).not.toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole("button", { name: "Local Drives" }));
      expect(await screen.findByTestId("settings-dialog")).toHaveAttribute("data-category", "local-drives");
    });

    it("opens pairing settings when the browser secret is missing", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(new Error("Not paired with companion"));

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByText(/This browser is not paired with Sambee Companion/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reload Sambee" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Local Drives" })).toBeInTheDocument();
    });

    it("keeps Retry for unrelated local-drive permission errors", async () => {
      localStorage.setItem("companion_secret", "valid-secret");
      vi.mocked(api.listDirectory).mockRejectedValue({ response: { status: 403, data: { detail: "Permission denied" } } });

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByText("Permission denied")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Local Drives" })).not.toBeInTheDocument();
    });

    it("keeps Retry for a temporary local-drive network failure", async () => {
      localStorage.setItem("companion_secret", "valid-secret");
      vi.mocked(api.listDirectory).mockRejectedValue(new Error("Network Error"));

      renderBrowser("/browse/local/c/Users");

      expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Local Drives" })).not.toBeInTheDocument();
    });
  });
});
