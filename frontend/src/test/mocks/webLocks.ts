import { onTestFinished } from "vitest";

export function mockWebLocks(): void {
  const held = new Set<string>();
  const locks = {
    query: async () => ({ held: Array.from(held, (name) => ({ name })), pending: [] }),
    async request<T>(name: string, _options: LockOptions, callback: LockGrantedCallback<T>) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
  };
  const original = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true, writable: true });
  onTestFinished(() => {
    if (original) Object.defineProperty(navigator, "locks", original);
    else Reflect.deleteProperty(navigator, "locks");
  });
}
