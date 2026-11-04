import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_AUTH_PROTOCOL_VERSION,
  COMPANION_PAIR_CONFIRMATION_PENDING_CODE,
  COMPANION_PAIR_CONFIRMATION_PENDING_DETAIL,
  default as companionService,
  getCompanionAuthProtocolStatus,
  isCompanionPairingMissing,
} from "../companion";
import { companionSession } from "../companionSession";
import { getLocalDrivePairingErrorKind } from "../localDrivePairing";
import { logger } from "../logger";

describe("companion authentication protocol", () => {
  it("distinguishes older, matching, and newer Companion versions", () => {
    const health = { status: "healthy", paired: true };
    expect(getCompanionAuthProtocolStatus(health)).toBe("companion_update_required");
    expect(getCompanionAuthProtocolStatus({ ...health, auth_protocol_version: COMPANION_AUTH_PROTOCOL_VERSION - 1 })).toBe(
      "companion_update_required"
    );
    expect(getCompanionAuthProtocolStatus({ ...health, auth_protocol_version: COMPANION_AUTH_PROTOCOL_VERSION })).toBe("compatible");
    expect(getCompanionAuthProtocolStatus({ ...health, auth_protocol_version: COMPANION_AUTH_PROTOCOL_VERSION + 1 })).toBe(
      "browser_update_required"
    );
  });

  it("identifies a missing origin pairing without treating other forbidden responses as pairing errors", () => {
    expect(isCompanionPairingMissing({ response: { status: 403, data: { code: "companion_pairing_not_found" } } })).toBe(true);
    expect(isCompanionPairingMissing({ response: { status: 403, data: { detail: "Not paired with this origin" } } })).toBe(true);
    expect(isCompanionPairingMissing({ response: { status: 403, data: { detail: "Permission denied" } } })).toBe(false);
    expect(isCompanionPairingMissing({ response: { status: 500, data: { code: "companion_pairing_not_found" } } })).toBe(false);
  });
});

describe("local drive listing pairing errors", () => {
  beforeEach(() => localStorage.clear());

  it("does not classify errors from remote connections", () => {
    expect(getLocalDrivePairingErrorKind("remote-connection", new Error("Network Error"))).toBeNull();
  });

  it("prioritizes rejected signatures even when no secret is stored", () => {
    expect(
      getLocalDrivePairingErrorKind("local-drive:c", {
        response: { status: 403, data: { code: "companion_auth_signature_mismatch" } },
      })
    ).toBe("signature");
  });

  it("requires pairing when the secret is missing or the companion reports a missing pairing", () => {
    expect(getLocalDrivePairingErrorKind("local-drive:c", new Error("Network Error"))).toBe("pairing_required");

    localStorage.setItem("companion_secret", "shared-secret");
    expect(
      getLocalDrivePairingErrorKind("local-drive:c", {
        response: { status: 403, data: { code: "companion_pairing_not_found" } },
      })
    ).toBe("pairing_required");
    expect(getLocalDrivePairingErrorKind("local-drive:c", new Error("Network Error"))).toBeNull();
  });
});

describe("companion request signatures", () => {
  it("binds method and URL while normalizing query order", async () => {
    localStorage.setItem("companion_secret", "shared-secret");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const first = await companionSession.getSigningHeaders("GET", "http://localhost:21549/api/viewer/root/file?z=2&A=1");
      const reordered = await companionSession.getSigningHeaders("GET", "http://localhost:21549/api/viewer/root/file?A=1&z=2");
      const differentPath = await companionSession.getSigningHeaders("GET", "http://localhost:21549/api/viewer/root/download?A=1&z=2");
      const differentMethod = await companionSession.getSigningHeaders("DELETE", "http://localhost:21549/api/viewer/root/file?A=1&z=2");
      expect(first["X-Companion-Secret"]).toBe("2213e964861fc8d4db9ae41c96188ce038ed113c0d064d8d6c96c5314c033d33");
      expect(first["X-Companion-Secret"]).toBe(reordered["X-Companion-Secret"]);
      expect(first["X-Companion-Secret"]).not.toBe(differentPath["X-Companion-Secret"]);
      expect(first["X-Companion-Secret"]).not.toBe(differentMethod["X-Companion-Secret"]);
    } finally {
      clock.mockRestore();
    }
  });
});

const { mockAxiosInstance } = vi.hoisted(() => ({
  mockAxiosInstance: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: "http://localhost:21549/api" },
    interceptors: {
      request: { use: vi.fn(), eject: vi.fn() },
      response: { use: vi.fn(), eject: vi.fn() },
    },
  },
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => mockAxiosInstance),
  },
}));

describe("companionService.initiatePairing", () => {
  it("does not log the pairing identity, code, or nonces", async () => {
    const pairingId = "private-pairing-identity";
    const nonceCompanion = "private-companion-nonce";
    mockAxiosInstance.post.mockResolvedValueOnce({ data: { pairing_id: pairingId, nonce_companion: nonceCompanion } });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const result = await companionService.initiatePairing();
    expect(result.pairingId).toBe(pairingId);
    expect(result.pairingCode).toHaveLength(6);
    expect(info).toHaveBeenCalledWith("Pairing initiated", {}, "companion");
    const logged = JSON.stringify(info.mock.calls);
    for (const privateValue of [pairingId, result.pairingCode, result.nonceBrowser, nonceCompanion]) {
      expect(logged).not.toContain(privateValue);
    }
  });
});

describe("companionService.confirmPairing", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("retries while the companion is still waiting for local approval", async () => {
    mockAxiosInstance.post
      .mockRejectedValueOnce({
        response: {
          data: {
            code: COMPANION_PAIR_CONFIRMATION_PENDING_CODE,
            detail: COMPANION_PAIR_CONFIRMATION_PENDING_DETAIL,
          },
        },
      })
      .mockRejectedValueOnce({
        response: {
          data: {
            code: COMPANION_PAIR_CONFIRMATION_PENDING_CODE,
            detail: COMPANION_PAIR_CONFIRMATION_PENDING_DETAIL,
          },
        },
      })
      .mockResolvedValueOnce({ data: { secret: "shared-secret" } });

    await companionService.confirmPairing("pair-1");

    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(3);
    expect(mockAxiosInstance.post).toHaveBeenNthCalledWith(
      1,
      "/pair/confirm",
      expect.objectContaining({
        pairing_id: "pair-1",
        origin: window.location.origin,
      })
    );
    expect(localStorage.getItem("companion_secret")).toBe("shared-secret");
  });

  it("fails immediately for non-retriable confirmation errors", async () => {
    const error = { response: { data: { detail: "Pairing has expired" } } };
    mockAxiosInstance.post.mockRejectedValueOnce(error);

    await expect(companionService.confirmPairing("pair-2")).rejects.toBe(error);
    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(1);
  });

  it("still retries when the companion returns only the stable pending code", async () => {
    mockAxiosInstance.post
      .mockRejectedValueOnce({
        response: {
          data: {
            code: COMPANION_PAIR_CONFIRMATION_PENDING_CODE,
            detail: "A different message should not break the retry",
          },
        },
      })
      .mockResolvedValueOnce({ data: { secret: "shared-secret" } });

    await companionService.confirmPairing("pair-3");

    expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("companion_secret")).toBe("shared-secret");
  });
});

describe("companionService.getPairStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes the current browser origin as a query fallback", async () => {
    mockAxiosInstance.get.mockResolvedValueOnce({
      data: {
        current_origin: window.location.origin,
        current_origin_paired: false,
        status: "unpaired",
      },
    });

    await companionService.getPairStatus();

    expect(mockAxiosInstance.get).toHaveBeenCalledWith("/pair/status", {
      params: { origin: window.location.origin },
    });
  });
});

describe("companionService shared settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("companion_secret", "shared-secret");
  });

  it("sends an authenticated opaque grant without browser settings values", async () => {
    mockAxiosInstance.post.mockResolvedValueOnce({
      data: {
        applied: true,
        language: "en-XA",
        regional_locale: "en-GB",
        updated_at: "2026-03-22T12:00:00.000Z",
        source_origin: "http://localhost:5173",
      },
    });

    await companionService.redeemSettingsGrant("opaque-grant");
    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/settings/redeem",
      {
        version: 1,
        grant: "opaque-grant",
      },
      {
        headers: expect.objectContaining({
          "X-Companion-Secret": expect.any(String),
          "X-Companion-Timestamp": expect.any(String),
        }),
      }
    );
  });
});

describe("companionService.createArchive", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    localStorage.setItem("companion_secret", "shared-secret");
  });

  it("forwards an abort signal for direct local archive creation", async () => {
    const controller = new AbortController();
    mockAxiosInstance.post.mockResolvedValueOnce({
      data: { files_created: 1, directories_created: 0, source_bytes: 4 },
    });

    await companionService.createArchive("c", ["source.txt"], "archive.zip", controller.signal);

    expect(mockAxiosInstance.post).toHaveBeenCalledWith(
      "/browse/c/archive",
      { source_paths: ["source.txt"], target_path: "archive.zip" },
      {
        headers: expect.objectContaining({
          "X-Companion-Secret": expect.any(String),
          "X-Companion-Timestamp": expect.any(String),
        }),
        signal: controller.signal,
      }
    );
  });
});
