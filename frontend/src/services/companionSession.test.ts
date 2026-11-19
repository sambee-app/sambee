import { describe, expect, it, vi } from "vitest";
import { CompanionSession } from "./companionSession";

describe("CompanionSession", () => {
  it("publishes revised snapshots when pairing state or drives change", () => {
    const session = new CompanionSession();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.setState("paired", [{ driveId: "c", name: "System", path: "" }]);

    expect(listener).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({
      status: "paired",
      revision: 1,
      drives: [{ driveId: "c", name: "System" }],
    });

    unsubscribe();
    session.setState("unavailable");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not publish when the companion state is unchanged", () => {
    const session = new CompanionSession();
    const listener = vi.fn();
    session.subscribe(listener);
    const drives = [{ driveId: "c", name: "System", path: "" }];

    session.setState("paired", drives);
    const firstSnapshot = session.getSnapshot();
    session.setState("paired", [...drives]);

    expect(listener).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toBe(firstSnapshot);
  });

  it("invalidates old requests when a paired browser receives a replacement secret", () => {
    const session = new CompanionSession();
    try {
      session.storeSecret("first-test-secret");
      const before = session.getSnapshot();
      session.storeSecret("replacement-test-secret");
      expect(session.getSnapshot()).toMatchObject({ status: "paired", revision: before.revision + 1 });
    } finally {
      session.clearPairing();
    }
  });
});
