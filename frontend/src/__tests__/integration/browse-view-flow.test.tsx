import { createMockAuthToken } from "../../test/fixtures/users";
/**
 * Browse → View Flow Integration Tests (Phase 3)
 *
 * Tests the view functionality using MSW to mock file content API.
 * Note: Full browse navigation is tested in unit tests. These integration tests
 * focus on the view dialog interaction and file content loading.
 *
 * TODO: E2E Tests for View Flow
 * The following scenarios cannot be tested with MSW in jsdom due to GET request interception
 * issues. These should be implemented as E2E tests (Playwright/Cypress):
 *
 * Happy Path:
 * - Load and display markdown view with formatted content
 * - Display plain text file view
 * - Close view with close button click
 * - Close view with ESC key press
 *
 * Different File Types:
 * - Render markdown with headers (h1, h2, h3)
 * - Render markdown with lists (ordered/unordered)
 * - Render markdown with code blocks and syntax highlighting
 * - Render markdown with links and verify href attributes
 *
 * Large Files:
 * - Handle large markdown files without performance issues
 * - Handle large text files
 *
 * Loading States:
 * - Show loading indicator while fetching content
 * - Hide loading indicator after content loads
 *
 * Path Display:
 * - Display full file path in dialog title
 * - Display root-level file paths correctly
 */

import { render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownViewer from "../../components/Viewer/MarkdownViewer";
import { ContentProviderRegistryContext } from "../../pages/FileBrowser/contentProviders";
import apiService from "../../services/api";
import { authSession } from "../../services/authSession";
import { createStorageBackedTestContentProviderRegistry } from "../../test/helpers";
import { SambeeThemeProvider } from "../../theme";

const contentProviders = createStorageBackedTestContentProviderRegistry();

vi.mock("../../components/Viewer/MarkdownRichEditor", () => {
  const MockMarkdownRichEditor = forwardRef<
    {
      focus: () => void;
      nextSearchResult: () => void;
      previousSearchResult: () => void;
      toggleInlineCode: () => void;
      insertCodeBlock: () => void;
    },
    {
      markdown: string;
      onChange: (markdown: string) => void;
      ariaLabel: string;
      readOnly?: boolean;
      className?: string;
    }
  >(({ markdown, onChange, ariaLabel, readOnly = false, className }, ref) => {
    useImperativeHandle(ref, () => ({
      focus: () => {},
      nextSearchResult: () => {},
      previousSearchResult: () => {},
      toggleInlineCode: () => {},
      insertCodeBlock: () => {},
    }));

    return (
      <textarea
        aria-label={ariaLabel}
        className={className}
        readOnly={readOnly}
        value={markdown}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  });

  MockMarkdownRichEditor.displayName = "MockMarkdownRichEditor";

  return {
    __esModule: true,
    default: MockMarkdownRichEditor,
  };
});

describe("Browse → View Flow", () => {
  beforeEach(() => {
    // Clear any previous state
    localStorage.clear();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "mock-token", token_type: "bearer" }), false);
  });

  const renderMarkdownViewer = (props: { connectionId: string; path: string; onClose: () => void }) => {
    return render(
      <ContentProviderRegistryContext.Provider value={contentProviders}>
        <SambeeThemeProvider>
          <MarkdownViewer {...props} />
        </SambeeThemeProvider>
      </ContentProviderRegistryContext.Provider>
    );
  };

  describe("Error Handling", () => {
    it("should show error when file view fails", async () => {
      // Mock API to return 500 error
      const getFileContentSpy = vi.spyOn(apiService, "getFileContent");
      getFileContentSpy.mockRejectedValueOnce({
        response: { status: 500, data: { detail: "Internal server error" } },
        message: "Request failed with status code 500",
      });

      renderMarkdownViewer({ connectionId: "test-conn", path: "/broken.md", onClose: () => {} });

      // Wait for error message (longer timeout in case of retry)
      await waitFor(
        () => {
          expect(screen.getByText("The file could not be opened. Check the connection and retry.")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      // Loading indicator should be gone
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

      getFileContentSpy.mockRestore();
    });

    it("should show error for unauthorized access", async () => {
      // Mock API to return 401 error
      const getFileContentSpy = vi.spyOn(apiService, "getFileContent");
      getFileContentSpy.mockRejectedValueOnce({
        response: { status: 401, data: { detail: "Unauthorized" } },
        message: "Request failed with status code 401",
      });

      renderMarkdownViewer({ connectionId: "test-conn", path: "/secure.md", onClose: () => {} });

      // Wait for error message (longer timeout in case of retry)
      await waitFor(
        () => {
          expect(screen.getByText("The file could not be opened. Check the connection and retry.")).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      getFileContentSpy.mockRestore();
    });

    it("should handle network errors gracefully", async () => {
      // Mock network error (no response object)
      const getFileContentSpy = vi.spyOn(apiService, "getFileContent");
      getFileContentSpy.mockRejectedValue({
        code: "ERR_NETWORK",
        message: "Network Error",
      });

      renderMarkdownViewer({ connectionId: "test-conn", path: "/test.md", onClose: () => {} });

      // Network errors trigger retry, so wait longer and expect "Server is busy" message
      await waitFor(
        () => {
          expect(screen.getByText(/server is busy/i)).toBeInTheDocument();
        },
        { timeout: 3000 }
      );

      getFileContentSpy.mockRestore();
    });
  });
});
