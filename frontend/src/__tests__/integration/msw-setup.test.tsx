/**
 * MSW Setup Verification Test
 *
 * This test verifies that MSW (Mock Service Worker) is properly configured
 * and can intercept HTTP requests. These tests verify MSW interception only,
 * not full application flows (which require the complete App component).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, it } from "vitest";
import Login from "../../pages/Login";
import { assertErrorShown, mockApiError, mockUnauthorized } from "../../test/integration-utils";

// Helper to render Login with Router
function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe("MSW Setup Verification", () => {
  it("should intercept login failure requests", async () => {
    renderLogin();

    const user = userEvent.setup();

    // Wait for auth config check to complete
    await screen.findByLabelText(/username/i);

    // Try to login with invalid credentials
    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/password/i, { selector: "input" });
    const loginButton = screen.getByRole("button", { name: /sign in/i });

    await user.type(usernameInput, "wronguser");
    await user.type(passwordInput, "wrongpass");
    await user.click(loginButton);

    // Should show error (MSW returns 401)
    await assertErrorShown(/invalid username or password/i);
  });

  it("should handle explicit error responses", async () => {
    renderLogin();

    const user = userEvent.setup();

    // Wait for auth config check to complete
    await screen.findByLabelText(/username/i);

    // Try to login (MSW will return default 401 for unknown credentials)
    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/password/i, { selector: "input" });
    const loginButton = screen.getByRole("button", { name: /sign in/i });

    await user.type(usernameInput, "baduser");
    await user.type(passwordInput, "badpass");
    await user.click(loginButton);

    // Should show error message (Login component converts all errors to this message)
    await assertErrorShown(/invalid username or password/i);
  });

  it("should handle API errors from MSW", async () => {
    // Mock API error for login endpoint
    mockApiError("/api/auth/token", 500);

    renderLogin();

    const user = userEvent.setup();

    // Wait for auth config check to complete
    await screen.findByLabelText(/username/i);

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/password/i, { selector: "input" });
    const loginButton = screen.getByRole("button", { name: /sign in/i });

    await user.type(usernameInput, "testuser");
    await user.type(passwordInput, "testpass");
    await user.click(loginButton);

    // Should show error (MSW returns 500 error)
    await assertErrorShown();
  });

  it("should handle unauthorized responses from MSW", async () => {
    // Mock unauthorized response
    mockUnauthorized("/api/auth/token");

    renderLogin();

    const user = userEvent.setup();

    // Wait for auth config check to complete
    await screen.findByLabelText(/username/i);

    const usernameInput = screen.getByLabelText(/username/i);
    const passwordInput = screen.getByLabelText(/password/i, { selector: "input" });
    const loginButton = screen.getByRole("button", { name: /sign in/i });

    await user.type(usernameInput, "testuser");
    await user.type(passwordInput, "testpass");
    await user.click(loginButton);

    // Should show unauthorized error
    await assertErrorShown();
  });
});
