import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { MockedObject } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCachedImageGallery } from "../../hooks/useCachedImageGallery";
import apiService from "../../services/api";
import { authSession } from "../../services/authSession";
import { createMockConnection } from "../../test/fixtures/connections";
import { createMockAuthToken } from "../../test/fixtures/users";
import { requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import { FileType } from "../../types";
import type { ViewerComponentProps } from "../../utils/FileTypeRegistry";
import FileBrowser from "../FileBrowser";

const FILE_LIST_READY_TIMEOUT_MS = 5000;

const { loadImageBlob, recordFilename } = vi.hoisted(() => ({
  loadImageBlob: vi.fn(),
  recordFilename: vi.fn(),
}));

// Mock the API service
vi.mock("../../services/api");
const mockedApi = apiService as MockedObject<typeof apiService>;

// Mock @tanstack/react-virtual for virtualized list rendering
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

// Mock the view components
vi.mock("../../utils/FileTypeRegistry", async () => {
  const actual = await vi.importActual<typeof import("../../utils/FileTypeRegistry")>("../../utils/FileTypeRegistry");
  return {
    ...actual,
    getViewerComponentLoadResult: vi.fn((mimeType: string) => {
      if (mimeType?.startsWith("image/")) {
        return Promise.resolve({
          status: "loaded",
          component: function ImageView({
            path,
            images = [path],
            currentIndex: initialIndex = 0,
            onCurrentIndexChange,
            onClose,
            connectionId,
            navigation,
          }: ViewerComponentProps) {
            const { currentIndex, setCurrentIndex, filename, errorStates, retryCurrentImage } = useCachedImageGallery({
              connectionId,
              images,
              initialIndex,
              selectionKey: navigation?.selectionKey,
              onIndexChange: onCurrentIndexChange,
              loadImageBlob,
            });
            useEffect(() => recordFilename(filename), [filename]);
            const error = errorStates.get(currentIndex);
            return (
              <div data-testid="image-view" data-path={path} data-filename={filename}>
                Image View
                {error ? (
                  <div role="alert">
                    {error}
                    <button type="button" onClick={retryCurrentImage}>
                      Retry
                    </button>
                  </div>
                ) : null}
                <button type="button" onClick={() => setCurrentIndex(currentIndex + 1)}>
                  Next image
                </button>
                <button type="button" onClick={onClose}>
                  Close image
                </button>
              </div>
            );
          },
        });
      }
      if (mimeType === "text/markdown") {
        return Promise.resolve({
          status: "loaded",
          component: function MarkdownView() {
            return <div data-testid="markdown-view">Markdown View</div>;
          },
        });
      }
      return Promise.resolve({ status: "unsupported" });
    }),
    getViewerComponent: vi.fn((mimeType: string) => {
      if (mimeType?.startsWith("image/")) {
        return Promise.resolve(function ImageView() {
          return <div data-testid="image-view">Image View</div>;
        });
      }
      if (mimeType === "text/markdown") {
        return Promise.resolve(function MarkdownView() {
          return <div data-testid="markdown-view">Markdown View</div>;
        });
      }
      return Promise.resolve(null);
    }),
  };
});

describe("Browser - Image View Integration", () => {
  const renderBrowser = async (initialPath = "/browse/smb/test-server-1") => {
    const router = createMemoryRouter(
      [
        { path: "/browse/:targetType/:targetId/*", element: <FileBrowser /> },
        { path: "/browse", element: <FileBrowser /> },
        { path: "/login", element: <div>Login Page</div> },
      ],
      { initialEntries: [initialPath] }
    );
    let result: ReturnType<typeof render> | undefined;
    await act(async () => {
      result = render(
        <SambeeThemeProvider>
          <RouterProvider router={router} />
        </SambeeThemeProvider>
      );
    });
    return {
      ...requireTestValue(result),
      router,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    loadImageBlob.mockResolvedValue(new Blob(["image"], { type: "image/jpeg" }));

    // Set up authentication
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);

    // Mock successful API responses
    mockedApi.getConnections.mockResolvedValue([
      createMockConnection({
        id: "conn-1",
        name: "Test Server",
        slug: "test-server-1",
        type: "smb",
        host: "test.local",
        share_name: "share",
        port: 445,
        username: "user",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      }),
    ]);
  });

  it("pushes gallery images without filename rollback or reloading cached images and restores Back and Forward", async () => {
    mockedApi.listDirectory.mockResolvedValue({
      path: "/",
      total: 2,
      items: ["one.jpg", "two.jpg"].map((name) => ({
        name,
        path: name,
        type: FileType.FILE,
        mime_type: "image/jpeg",
        size: 10,
        is_readable: true,
        is_hidden: false,
      })),
    });
    mockedApi.getFileInfo.mockResolvedValue({ type: FileType.FILE, mime_type: "image/jpeg", size: 10 } as never);
    const { router } = await renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: /: one\.jpg$/ }, { timeout: FILE_LIST_READY_TIMEOUT_MS }));
    expect(await screen.findByTestId("image-view")).toHaveAttribute("data-path", "one.jpg");
    await waitFor(() => expect(loadImageBlob).toHaveBeenCalledTimes(2));
    recordFilename.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("file")).toBe("smb/test-server-1/two.jpg"));
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "two.jpg"));
    expect(
      recordFilename.mock.calls
        .map(([filename]) => filename)
        .filter((filename, index, values) => index === 0 || filename !== values[index - 1])
    ).toEqual(["two.jpg"]);
    expect(loadImageBlob).toHaveBeenCalledTimes(2);
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "one.jpg"));
    expect(screen.getByTestId("image-view")).toHaveAttribute("data-filename", "one.jpg");
    await act(() => router.navigate(1));
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "two.jpg"));
    expect(screen.getByTestId("image-view")).toHaveAttribute("data-filename", "two.jpg");
    expect(loadImageBlob).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close image" }));
    await waitFor(() => expect(screen.queryByTestId("image-view")).not.toBeInTheDocument());
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "two.jpg"));
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "one.jpg"));
    await act(() => router.navigate(2));
    await waitFor(() => expect(screen.queryByTestId("image-view")).not.toBeInTheDocument());
  });

  it("shows the selected image error and retries without retaining the previous filename", async () => {
    mockedApi.listDirectory.mockResolvedValue({
      path: "",
      total: 2,
      items: ["one.jpg", "two.jpg"].map((name) => ({
        name,
        path: name,
        type: FileType.FILE,
        mime_type: "image/jpeg",
        size: 10,
        is_readable: true,
        is_hidden: false,
      })),
    });
    mockedApi.getFileInfo.mockResolvedValue({ type: FileType.FILE, mime_type: "image/jpeg", size: 10 } as never);
    loadImageBlob.mockImplementation(async (path: string) => {
      if (path === "two.jpg") throw { response: { status: 404, data: { detail: { code: "item_not_found" } } } };
      return new Blob(["image"], { type: "image/jpeg" });
    });
    await renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: /: one\.jpg$/ }, { timeout: FILE_LIST_READY_TIMEOUT_MS }));
    await screen.findByTestId("image-view");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await screen.findByRole("alert");
    expect(screen.getByTestId("image-view")).toHaveAttribute("data-path", "two.jpg");
    expect(screen.getByTestId("image-view")).toHaveAttribute("data-filename", "two.jpg");
    const attempts = loadImageBlob.mock.calls.length;
    loadImageBlob.mockResolvedValue(new Blob(["restored image"], { type: "image/jpeg" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(loadImageBlob.mock.calls.length).toBeGreaterThan(attempts);
  });

  it("restores an unchanged routed index when Back immediately follows an optimistic gallery move", async () => {
    mockedApi.listDirectory.mockResolvedValue({
      path: "/",
      total: 2,
      items: ["one.jpg", "two.jpg"].map((name) => ({
        name,
        path: name,
        type: FileType.FILE,
        mime_type: "image/jpeg",
        size: 10,
        is_readable: true,
        is_hidden: false,
      })),
    });
    mockedApi.getFileInfo.mockResolvedValue({ type: FileType.FILE, mime_type: "image/jpeg", size: 10 } as never);
    const { router } = await renderBrowser();
    fireEvent.click(await screen.findByRole("button", { name: /: one\.jpg$/ }, { timeout: FILE_LIST_READY_TIMEOUT_MS }));
    await screen.findByTestId("image-view");
    await waitFor(() => expect(loadImageBlob).toHaveBeenCalledTimes(2));
    let backNavigation: Promise<void> | undefined;
    const unsubscribe = router.subscribe(({ location }) => {
      if (new URLSearchParams(location.search).get("file") === "smb/test-server-1/two.jpg") {
        unsubscribe();
        backNavigation = router.navigate(-1);
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    await act(async () => backNavigation);

    expect(new URLSearchParams(router.state.location.search).get("file")).toBe("smb/test-server-1/one.jpg");
    await waitFor(() => expect(screen.getByTestId("image-view")).toHaveAttribute("data-filename", "one.jpg"));
    expect(loadImageBlob).toHaveBeenCalledTimes(2);
  });

  it("renders image view when clicking on image file", async () => {
    // Mock browse response with single image file
    mockedApi.listDirectory.mockResolvedValue({
      path: "/",
      items: [
        {
          name: "image1.jpg",
          path: "/image1.jpg",
          type: FileType.FILE,
          size: 1024,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/jpeg",
          is_readable: true,
          is_hidden: false,
        },
      ],
      total: 1,
    });

    await renderBrowser();

    // Wait for files to load
    await waitFor(() => {
      const elements = screen.getAllByText("image1.jpg");
      expect(elements.length).toBeGreaterThan(0);
    });
    const imageButtons = screen.getAllByRole("button", { name: /image1\.jpg/i });
    const imageFile = imageButtons[0];

    // Click on the image file
    fireEvent.click(requireTestValue(imageFile));

    // Image view should open
    const view = await screen.findByTestId("image-view");
    expect(view).toBeInTheDocument();
  });

  it("enables gallery mode when directory has multiple images", async () => {
    // Mock browse response with multiple images
    mockedApi.listDirectory.mockResolvedValue({
      path: "/photos",
      items: [
        {
          name: "image1.jpg",
          path: "/photos/image1.jpg",
          type: FileType.FILE,
          size: 1024,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/jpeg",
          is_readable: true,
          is_hidden: false,
        },
        {
          name: "image2.png",
          path: "/photos/image2.png",
          type: FileType.FILE,
          size: 2048,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/png",
          is_readable: true,
          is_hidden: false,
        },
        {
          name: "image3.gif",
          path: "/photos/image3.gif",
          type: FileType.FILE,
          size: 3072,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/gif",
          is_readable: true,
          is_hidden: false,
        },
        {
          name: "document.pdf",
          path: "/photos/document.pdf",
          type: FileType.FILE,
          size: 4096,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "application/pdf",
          is_readable: true,
          is_hidden: false,
        },
      ],
      total: 4,
    });

    await renderBrowser();

    // Wait for files to load and click second image (image2.png)
    const imageFile = await screen.findByText("image2.png");
    fireEvent.click(imageFile);

    // Image view should open
    const view = await screen.findByTestId("image-view");
    expect(view).toBeInTheDocument();
  });

  it("does not show gallery mode for single image", async () => {
    // Mock browse response with single image file
    mockedApi.listDirectory.mockResolvedValue({
      path: "/",
      items: [
        {
          name: "single-photo.jpg",
          path: "/single-photo.jpg",
          type: FileType.FILE,
          size: 1024,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/jpeg",
          is_readable: true,
          is_hidden: false,
        },
      ],
      total: 1,
    });

    await renderBrowser();

    // Wait for files to load
    await waitFor(() => {
      const elements = screen.getAllByText("single-photo.jpg");
      expect(elements.length).toBeGreaterThan(0);
    });
    const imageButtons = screen.getAllByRole("button", { name: /single-photo\.jpg/i });
    const imageFile = imageButtons[0];

    // Click on the image file
    fireEvent.click(requireTestValue(imageFile));

    // Image view should open
    const view = await screen.findByTestId("image-view");
    expect(view).toBeInTheDocument();
  });

  it("opens image view in dialog when image is clicked", async () => {
    mockedApi.listDirectory.mockResolvedValue({
      items: [
        {
          name: "photo.jpg",
          type: FileType.FILE,
          path: "/photo.jpg",
          size: 1024 * 1024,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "image/jpeg",
          is_readable: true,
          is_hidden: false,
        },
      ],
      path: "/",
      total: 1,
    });

    await renderBrowser();

    // Wait for files to load and click image
    await waitFor(() => {
      const elements = screen.getAllByText("photo.jpg");
      expect(elements.length).toBeGreaterThan(0);
    });
    const imageButtons = screen.getAllByRole("button", { name: /photo\.jpg/i });
    const imageFile = imageButtons[0];
    fireEvent.click(requireTestValue(imageFile));

    // Wait for view to open
    const view = await screen.findByTestId("image-view");
    expect(view).toBeInTheDocument();
  });

  it("still supports markdown view for backward compatibility", async () => {
    mockedApi.listDirectory.mockResolvedValue({
      items: [
        {
          name: "readme.md",
          type: FileType.FILE,
          path: "/readme.md",
          size: 2048,
          modified_at: "2024-01-01T00:00:00Z",
          mime_type: "text/markdown",
          is_readable: true,
          is_hidden: false,
        },
      ],
      path: "/",
      total: 1,
    });

    await renderBrowser();

    // Wait for files to load
    await waitFor(() => {
      const elements = screen.getAllByText("readme.md");
      expect(elements.length).toBeGreaterThan(0);
    });
    const markdownButtons = screen.getAllByRole("button", { name: /readme\.md/i });
    const markdownFile = markdownButtons[0];

    // Click on the markdown file
    fireEvent.click(requireTestValue(markdownFile));

    // Markdown view should open
    const view = await screen.findByTestId("markdown-view");
    expect(view).toBeInTheDocument();
  });
});
