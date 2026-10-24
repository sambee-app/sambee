/**
 * Test Fixtures - Connections
 * Reusable connection data for tests
 */

import type { Connection } from "../../types";

/**
 * Standard test connections for general use
 */
export const mockConnections: [Connection, Connection] = [
  {
    id: "conn-1",
    name: "Test Server 1",
    slug: "test-server-1",
    type: "SMB",
    host: "192.168.1.100",
    port: 445,
    share_name: "share1",
    username: "user1",
    path_prefix: "/",
    scope: "shared",
    access_mode: "read_write",
    can_manage: true,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "conn-2",
    name: "Test Server 2",
    slug: "test-server-2",
    type: "SMB",
    host: "192.168.1.101",
    port: 445,
    share_name: "share2",
    username: "user2",
    path_prefix: "/",
    scope: "shared",
    access_mode: "read_write",
    can_manage: true,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

/**
 * Single connection for tests that need one connection
 */
export const mockConnection: Connection = mockConnections[0];

/**
 * Create a custom connection with overrides
 */
export function createMockConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-test",
    name: "Test Server",
    slug: "test-server",
    type: "smb",
    host: "192.168.1.100",
    port: 445,
    share_name: "share1",
    username: "testuser",
    path_prefix: "/",
    scope: "shared",
    access_mode: "read_write",
    can_manage: true,
    created_at: "2024-01-01T00:00:00",
    updated_at: "2024-01-01T00:00:00",
    ...overrides,
  };
}

/**
 * Empty connections array for testing empty states
 */
export const mockEmptyConnections: Connection[] = [];
