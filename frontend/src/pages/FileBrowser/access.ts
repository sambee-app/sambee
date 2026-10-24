import { isLocalDrive } from "../../services/backendRouter";
import type { Connection } from "../../types";

export function getConnectionById(connections: Connection[], connectionId: string): Connection | undefined {
  return connections.find((connection) => connection.id === connectionId);
}

export function isConnectionReadOnly(connection: Connection | undefined): boolean {
  if (!connection) {
    return false;
  }

  return !isLocalDrive(connection.id) && connection.access_mode === "read_only";
}

export function isConnectionWritable(connection: Connection | undefined): boolean {
  return Boolean(connection) && !isConnectionReadOnly(connection);
}

export function canOpenFileInApp(connection: Connection | undefined): boolean {
  return connection !== undefined && (isLocalDrive(connection.id) || !isConnectionReadOnly(connection));
}

export function canCopyToConnection(sourceConnection: Connection | undefined, destinationConnection: Connection | undefined): boolean {
  return Boolean(sourceConnection) && isConnectionWritable(destinationConnection);
}

export function canMoveBetweenConnections(
  sourceConnection: Connection | undefined,
  destinationConnection: Connection | undefined
): boolean {
  return isConnectionWritable(sourceConnection) && isConnectionWritable(destinationConnection);
}
