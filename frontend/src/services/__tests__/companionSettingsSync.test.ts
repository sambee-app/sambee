import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAuthToken } from "../../test/fixtures/users";
import type { CompanionSettingsMetadata, CompanionSettingsStatus } from "../../types/companionSettings";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  status: vi.fn(),
  challenge: vi.fn(),
  redeem: vi.fn(),
  grant: vi.fn(),
  identity: null as null | (() => void),
  clear: null as null | (() => void),
  authenticated: true,
  hasSecret: true,
}));
vi.mock("../api", () => ({ default: { getCompanionSettingsMetadata: mocks.metadata, issueCompanionSettingsGrant: mocks.grant } }));
vi.mock("../companion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../companion")>()),
  default: { getSettingsStatus: mocks.status, requestSettingsChallenge: mocks.challenge, redeemSettingsGrant: mocks.redeem },
}));
vi.mock("../authConfig", () => ({ isAuthRequired: async () => true }));
vi.mock("../authSession", () => ({
  authSession: {
    getUserId: () => "user",
    beginNewLogin: vi.fn(),
    setAuthenticated: vi.fn(),
    completeLoginBootstrap: vi.fn(),
    notifyNewLogin: vi.fn(),
    hasUsableAccessToken: () => mocks.authenticated,
    subscribeToIdentity: (listener: () => void) => {
      mocks.identity = listener;
      return vi.fn();
    },
    subscribeToClear: (listener: () => void) => {
      mocks.clear = listener;
      return vi.fn();
    },
    subscribeToBootstrap: () => vi.fn(),
  },
}));
vi.mock("../companionSession", () => ({ companionSession: { hasSecret: () => mocks.hasSecret, subscribe: () => vi.fn() } }));
vi.mock("../logger", () => ({ logger: { initializeBackendTracing: vi.fn().mockResolvedValue(undefined) } }));

import { emitBackendRecoveryConfirmed } from "../backendRecoveryEvents";
import { notifyCompanionSettingsChanged } from "../companionSettingsEvents";
import { changedSettingsSections, companionSettingsSync } from "../companionSettingsSync";
import { completeAuthentication } from "../oidcAuth";

function metadata(): CompanionSettingsMetadata {
  return {
    version: 1,
    backend_identity: "backend",
    theme: { version: 1, marker: "theme", user_scope: "user" },
    localization: { version: 1, marker: "locale", user_scope: "user" },
    directory_index: { version: 1, marker: "0", user_scope: null },
  };
}
function status(): CompanionSettingsStatus {
  const desired = metadata();
  return {
    version: 1,
    companion_id: "companion",
    status: "synchronized",
    authority_generation: 1,
    authoritative_origin: window.location.origin,
    challenge: null,
    message: null,
    sections: Object.fromEntries(
      (["theme", "localization", "directory_index"] as const).map((name) => [
        name,
        {
          ...desired[name],
          origin: window.location.origin,
          backend_identity: desired.backend_identity,
          result: "synchronized",
        },
      ])
    ),
  };
}
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("shared Companion settings lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.authenticated = true;
    mocks.hasSecret = true;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.metadata.mockResolvedValue(metadata());
    mocks.status.mockResolvedValue(status());
    mocks.challenge.mockResolvedValue({ ...status(), challenge: "challenge" });
    mocks.grant.mockResolvedValue({ ...metadata(), grant: "grant", expires_in_seconds: 60 });
    mocks.redeem.mockResolvedValue(status());
  });
  afterEach(() => {
    companionSettingsSync.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("checks on startup without Settings or administrator access and avoids matching grants", async () => {
    companionSettingsSync.start();
    await settle();
    expect(mocks.metadata).toHaveBeenCalledOnce();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(companionSettingsSync.getSnapshot().phase).toBe("synchronized");
  });

  it("does not request settings without a stored pairing secret", async () => {
    mocks.hasSecret = false;
    companionSettingsSync.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it.each([
    { code: "companion_auth_signature_mismatch", detail: "Invalid authentication" },
    { code: "companion_pairing_not_found", detail: "Not paired with this origin" },
    { detail: "Invalid authentication" },
    { detail: "Not paired with this origin" },
  ])("blocks automatic retries after pairing failure: $detail ($code)", async (data) => {
    mocks.status.mockRejectedValue({ response: { status: 403, data } });
    companionSettingsSync.start();
    await settle();

    expect(companionSettingsSync.getSnapshot()).toMatchObject({ phase: "pairing_required", message: null });
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    emitBackendRecoveryConfirmed("pairing-retry-test");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    companionSettingsSync.request(false, true);
    await settle();
    expect(mocks.status).toHaveBeenCalledTimes(2);

    mocks.status.mockResolvedValue(status());
    notifyCompanionSettingsChanged(true);
    await settle();
    expect(mocks.status).toHaveBeenCalledTimes(3);
    expect(companionSettingsSync.getSnapshot().phase).toBe("synchronized");
  });

  it("delivers only a changed theme section", async () => {
    const native = status();
    native.sections.theme!.marker = "old";
    mocks.status.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ sections: ["theme"], switch_user: false }), expect.anything());
    expect(mocks.redeem).toHaveBeenCalledWith("grant", expect.objectContaining({ signal: expect.anything() }));
  });

  it("retries failed restored sections even when their markers match", async () => {
    companionSettingsSync.start();
    await settle();
    const native = status();
    native.status = "delivery_failed";
    native.sections.theme!.result = "delivery_failed";
    native.sections.localization!.result = "delivery_failed";
    mocks.status.mockResolvedValue(native);
    companionSettingsSync.request(false, true);
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ["theme", "localization"], switch_user: false }),
      expect.anything()
    );
    expect(companionSettingsSync.getSnapshot().phase).toBe("synchronized");
  });

  it("does not switch users during periodic checks", () => {
    const desired = metadata();
    desired.theme.user_scope = "other";
    desired.localization.user_scope = "other";
    expect(changedSettingsSections(desired, status(), false)).toEqual([]);
    expect(changedSettingsSections(desired, status(), true)).toEqual(["theme", "localization"]);
  });

  it("does not switch users when a saved session restores its identity", async () => {
    const native = status();
    native.sections.theme!.user_scope = "previous-user";
    native.sections.localization!.user_scope = "previous-user";
    mocks.status.mockResolvedValue(native);
    mocks.authenticated = false;
    companionSettingsSync.start();
    await settle();
    mocks.authenticated = true;
    mocks.identity?.();
    await settle();
    expect(mocks.metadata).toHaveBeenCalledOnce();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("does not compare user scopes across backend identities", () => {
    const desired = metadata();
    desired.backend_identity = "new-backend";
    desired.theme.user_scope = "new-server-user";
    desired.localization.user_scope = "new-server-user";
    expect(changedSettingsSections(desired, status(), false)).toEqual(["theme", "localization", "directory_index"]);
  });

  it("permits an explicit preference change to update user scope", async () => {
    companionSettingsSync.start();
    await settle();
    mocks.status.mockResolvedValue({ ...status(), sections: {} });
    companionSettingsSync.request(true, true);
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ switch_user: true }), expect.anything());
  });

  it("does not continuously retry an authority conflict", async () => {
    mocks.status.mockResolvedValue({ ...status(), authoritative_origin: "https://other.example", status: "authority_conflict" });
    companionSettingsSync.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.metadata).toHaveBeenCalledOnce();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(companionSettingsSync.getSnapshot().phase).toBe("authority_conflict");
  });

  it("reports update required for an incompatible Companion", async () => {
    mocks.status.mockResolvedValue({ ...status(), version: 2 });
    companionSettingsSync.start();
    await settle();
    expect(companionSettingsSync.getSnapshot().phase).toBe("update_required");
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("pauses checks while the tab is hidden and checks on return", async () => {
    companionSettingsSync.start();
    await settle();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.metadata).toHaveBeenCalledOnce();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
  });

  it("cancels stale work on logout", async () => {
    let resolve!: (value: CompanionSettingsMetadata) => void;
    mocks.metadata.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        })
    );
    companionSettingsSync.start();
    await settle();
    const signal = mocks.metadata.mock.calls[0]![0].signal as AbortSignal;
    mocks.authenticated = false;
    mocks.clear?.();
    resolve(metadata());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(mocks.grant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.metadata).toHaveBeenCalledOnce();
  });

  it("uses one cross-tab lock for comparison and delivery", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback());
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
    companionSettingsSync.start();
    await settle();
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sambee-companion-settings",
      expect.objectContaining({ signal: expect.anything() }),
      expect.any(Function)
    );
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  });

  it("retries a failure but removes timers on disposal", async () => {
    mocks.metadata.mockRejectedValueOnce(new Error("Backend unavailable. Retry."));
    companionSettingsSync.start();
    await settle();
    expect(companionSettingsSync.getSnapshot().phase).toBe("delivery_failed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    companionSettingsSync.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
  });

  it("does not start a timer while sign-in is required", async () => {
    mocks.authenticated = false;
    companionSettingsSync.start();
    await settle();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.metadata).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    mocks.authenticated = true;
    mocks.identity?.();
    await settle();
    expect(mocks.metadata).toHaveBeenCalledOnce();
  });

  it("refreshes after backend recovery without switching users", async () => {
    companionSettingsSync.start();
    await settle();
    emitBackendRecoveryConfirmed("backend-online");
    await settle();
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("checks periodically and delivers only changed localization", async () => {
    companionSettingsSync.start();
    await settle();
    const native = status();
    native.sections.localization!.marker = "old-locale";
    mocks.status.mockResolvedValue(native);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ["localization"], switch_user: false }),
      expect.anything()
    );
  });

  it("discards a previous user's response after login", async () => {
    let resolve!: (value: CompanionSettingsMetadata) => void;
    mocks.metadata.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        })
    );
    companionSettingsSync.start();
    await settle();
    const signal = mocks.metadata.mock.calls[0]![0].signal as AbortSignal;
    mocks.identity?.();
    resolve(metadata());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it.each([true, false])("permits explicit login to switch user scope with renewable=%s", async (renewable) => {
    companionSettingsSync.start();
    await settle();
    const native = status();
    native.sections.theme!.user_scope = "previous-user";
    native.sections.localization!.user_scope = "previous-user";
    mocks.status.mockResolvedValue(native);
    await completeAuthentication(createMockAuthToken({ access_token: "login-token", user_id: "user" }), "/browse", renewable);
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ["theme", "localization"], switch_user: true }),
      expect.anything()
    );
  });

  it("retains a pending user change when the tab is hidden", async () => {
    const native = status();
    native.sections.theme!.user_scope = "previous-user";
    native.sections.localization!.user_scope = "previous-user";
    mocks.status.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    let resolve!: (value: CompanionSettingsMetadata) => void;
    mocks.metadata.mockImplementationOnce(
      () =>
        new Promise((complete) => {
          resolve = complete;
        })
    );
    notifyCompanionSettingsChanged(true);
    await settle();
    const signal = mocks.metadata.mock.calls[1]![0].signal as AbortSignal;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    resolve(metadata());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(mocks.grant).not.toHaveBeenCalled();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ["theme", "localization"], switch_user: true }),
      expect.anything()
    );
    mocks.grant.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it("clears a paused user change on logout before restoring a session", async () => {
    const native = status();
    native.sections.theme!.user_scope = "previous-user";
    native.sections.localization!.user_scope = "previous-user";
    mocks.status.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    notifyCompanionSettingsChanged(true);
    mocks.authenticated = false;
    mocks.clear?.();
    mocks.authenticated = true;
    mocks.identity?.();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves failures for another user with a stored theme=%s", async (storedTheme) => {
    const native = status();
    native.status = "delivery_failed";
    native.message = "Theme settings were not saved. Check private storage.";
    native.sections.theme!.result = "delivery_failed";
    native.sections.theme!.user_scope = "other-user";
    native.sections.localization!.user_scope = "other-user";
    native.results = { theme: "delivery_failed", localization: "synchronized", directory_index: "synchronized" };
    if (!storedTheme) delete native.sections.theme;
    mocks.status.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(companionSettingsSync.getSnapshot()).toMatchObject({
      phase: "delivery_failed",
      message: native.message,
      sections: { theme: "delivery_failed", localization: "synchronized", directory_index: "synchronized" },
    });
  });

  it("preserves an omitted section's failure after successful directory policy delivery", async () => {
    const native = status();
    native.status = "delivery_failed";
    native.message = "Theme settings were not saved. Check private storage.";
    native.sections.theme!.result = "delivery_failed";
    native.sections.theme!.user_scope = "other-user";
    native.sections.localization!.user_scope = "other-user";
    const outdated = structuredClone(native);
    outdated.sections.directory_index!.marker = "old-policy";
    mocks.status.mockResolvedValue(outdated);
    mocks.redeem.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(
      expect.objectContaining({ sections: ["directory_index"], switch_user: false }),
      expect.anything()
    );
    expect(companionSettingsSync.getSnapshot()).toMatchObject({
      phase: "delivery_failed",
      message: native.message,
      sections: { theme: "delivery_failed", localization: "synchronized", directory_index: "synchronized" },
    });
  });

  it("stops retries when native retrieval reports an old backend", async () => {
    mocks.status.mockRejectedValueOnce({
      response: { status: 400, data: { code: "settings_update_required", detail: "Update Sambee and Companion." } },
    });
    companionSettingsSync.start();
    await settle();
    expect(companionSettingsSync.getSnapshot().phase).toBe("update_required");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.status).toHaveBeenCalledOnce();
  });

  it("does not report a failed native section as synchronized", async () => {
    const native = status();
    native.sections.theme!.result = "delivery_failed";
    mocks.status.mockResolvedValue(native);
    mocks.redeem.mockResolvedValue(native);
    companionSettingsSync.start();
    await settle();
    expect(mocks.grant).toHaveBeenCalledWith(expect.objectContaining({ sections: ["theme"] }), expect.anything());
    expect(companionSettingsSync.getSnapshot().phase).toBe("delivery_failed");
  });
});
