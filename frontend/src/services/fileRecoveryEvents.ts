export interface MissingPhysicalFile {
  connectionId: string;
  path: string;
}

const listeners = new Set<(file: MissingPhysicalFile) => void>();

export function publishMissingPhysicalFile(file: MissingPhysicalFile): void {
  for (const listener of listeners) listener(file);
}

export function subscribeMissingPhysicalFiles(listener: (file: MissingPhysicalFile) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
