/**
 * Login Flow Integration Tests (Phase 2)
 *
 * These tests verify login workflows using MSW to mock API responses.
 * Note: Full app navigation tests require more complex setup and are deferred to Phase 3+.
 * These tests focus on login behavior, error handling, and API interactions.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import Login from "../../pages/Login";
import { assertErrorShown, mockApiError } from "../../test/integration-utils";

// Helper to render Login with Router
function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe("Login Flow Integration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // TODO: E2E Tests for Successful Login
  // The following scenarios require full App routing context with useNavigate() and should be
  // implemented as E2E tests (Playwright/Cypress):
  // - Successful login should store token in localStorage and redirect to browser
  // - Admin login should store admin token and redirect appropriately
  // - Token should persist across page reloads

  describe("Login Errors", () => {
    it("should show error for invalid credentials", async () => {
      renderLogin();

      const user = userEvent.setup();

      // Wait for auth config check to complete
      await screen.findByLabelText(/username/i);

      const usernameInput = screen.getByLabelText(/username/i);
      const passwordInput = screen.getByLabelText(/^password/i);
      const loginButton = screen.getByRole("button", { name: /sign in/i });

      await user.type(usernameInput, "wronguser");
      await user.type(passwordInput, "wrongpass");
      await user.click(loginButton);

      // Should show error
      await assertErrorShown(/invalid username or password/i);

      // Should not store token
      expect(localStorage.getItem("access_token")).toBeNull();
    });

    // TODO: E2E Test - Error clearing on retry with successful login (requires navigation)

    it("should handle server errors", async () => {
      // Mock 500 error
      mockApiError("/api/auth/token", 500);

      renderLogin();

      const user = userEvent.setup();

      // Wait for auth config check to complete
      await screen.findByLabelText(/username/i);

      const usernameInput = screen.getByLabelText(/username/i);
      const passwordInput = screen.getByLabelText(/^password/i);
      const loginButton = screen.getByRole("button", { name: /sign in/i });

      await user.type(usernameInput, "testuser");
      await user.type(passwordInput, "testpass");
      await user.click(loginButton);

      // Should show error
      await assertErrorShown(/invalid username or password/i);

      // Should not store token
      expect(localStorage.getItem("access_token")).toBeNull();
    });
  });

  // TODO: E2E Tests for Multiple Login Attempts
  // The following scenarios require navigation testing and should be E2E tests:
  // - Rapid login button clicks should not cause duplicate requests or break navigation
  // - Switching between different user accounts should update token and navigate correctly
  // - Logout followed by login as different user should work properly

  describe("Form Validation", () => {
    it("should require username and password", async () => {
      renderLogin();

      const user = userEvent.setup();

      // Wait for auth config check to complete
      await screen.findByRole("button", { name: /sign in/i });

      const loginButton = screen.getByRole("button", { name: /sign in/i });

      // Try to submit empty form
      await user.click(loginButton);

      // Form should prevent submission (browser validation)
      // No token should be stored
      expect(localStorage.getItem("access_token")).toBeNull();
    });

    it("should handle empty username", async () => {
      renderLogin();

      const user = userEvent.setup();

      // Wait for auth config check to complete
      await screen.findByLabelText(/^password/i);

      const passwordInput = screen.getByLabelText(/^password/i);
      const loginButton = screen.getByRole("button", { name: /sign in/i });

      // Only fill password
      await user.type(passwordInput, "testpass");
      await user.click(loginButton);

      // No token should be stored
      expect(localStorage.getItem("access_token")).toBeNull();
    });

    it("should handle empty password", async () => {
      renderLogin();

      const user = userEvent.setup();

      // Wait for auth config check to complete
      await screen.findByLabelText(/username/i);

      const usernameInput = screen.getByLabelText(/username/i);
      const loginButton = screen.getByRole("button", { name: /sign in/i });

      // Only fill username
      await user.type(usernameInput, "testuser");
      await user.click(loginButton);

      // No token should be stored
      expect(localStorage.getItem("access_token")).toBeNull();
    });
  });
});
