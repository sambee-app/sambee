/**
 * Test Fixtures - Users
 * Reusable user data for tests
 */

import type { AdminUser, AdminUserListResponse, AuthToken, User } from "../../types";

export function createMockAuthToken(overrides: Partial<AuthToken> = {}): AuthToken {
  return {
    access_token: "mock-token",
    token_type: "bearer",
    username: "test-user",
    ...overrides,
  };
}

export function createMockAdminUser(
  overrides: Omit<Partial<AdminUser>, "oidc"> & { oidc?: Partial<NonNullable<AdminUser["oidc"]>> | null } = {}
): AdminUser {
  return {
    id: "user-1",
    username: "test-user",
    role: "editor",
    is_active: true,
    must_change_password: false,
    has_local_password: true,
    oidc_role_assignment: null,
    pending_oidc: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
    oidc: overrides.oidc
      ? {
          identity_id: "identity-1",
          user_id: overrides.id ?? "user-1",
          provider_display_name: "Test provider",
          issuer: "https://identity.example.test",
          subject: overrides.id ?? "user-1",
          last_seen_username: overrides.username ?? "test-user",
          last_groups: [],
          created_at: "2024-01-01T00:00:00Z",
          last_login_at: null,
          ...overrides.oidc,
        }
      : null,
  };
}

export function createMockAdminUserList(items: AdminUser[]): AdminUserListResponse {
  return {
    items,
    total: items.length,
    summary: {
      total: items.length,
      active_admins: items.filter((user) => user.is_active && user.role === "admin").length,
      disabled: items.filter((user) => !user.is_active).length,
      expiring_soon: 0,
      pending_oidc: items.filter((user) => user.pending_oidc !== null).length,
      unavailable_sign_in: items.filter((user) => !user.has_local_password && user.oidc === null).length,
    },
  };
}

/**
 * Standard admin user for testing
 */
export const mockAdminUser: User = {
  username: "admin",
  role: "admin",
  created_at: "2024-01-01T00:00:00",
};

/**
 * Standard regular user for testing
 */
export const mockRegularUser: User = {
  username: "testuser",
  role: "editor",
  created_at: "2024-01-02T00:00:00",
};

/**
 * Additional test users
 */
export const mockUsers: User[] = [
  mockAdminUser,
  mockRegularUser,
  {
    username: "user1",
    role: "editor",
    created_at: "2024-01-03T00:00:00",
  },
];

/**
 * Create a custom user with overrides
 */
export function createMockUser(overrides: Partial<User> = {}): User {
  return {
    username: "testuser",
    role: "editor",
    created_at: "2024-01-01T00:00:00",
    ...overrides,
  };
}
