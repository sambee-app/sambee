import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import {
  clearForegroundArchiveOperation,
  loadForegroundArchiveOperation,
  storeForegroundArchiveOperation,
} from "../../services/foregroundArchiveOperation";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import { createMockAuthToken } from "../../test/fixtures/users";
import { type ApiMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { renderBrowserAndFlush } from "./FileBrowser.test.utils";

vi.mock("../../services/api");

describe("FileBrowser archive interruption recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentUserSettingsStoreForTests();
    clearForegroundArchiveOperation();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  it("retries a persisted backend cancellation after reload and clears it on success", async () => {
    storeForegroundArchiveOperation("operation-id");
    vi.mocked(api.cancelArchiveOperation).mockResolvedValue({} as never);

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(api.cancelArchiveOperation).toHaveBeenCalledWith("operation-id");
    });
    expect(loadForegroundArchiveOperation()).toBeNull();
    expect(await screen.findByText("Archive work was interrupted. Check its destination before retrying.")).toBeInTheDocument();
  });

  it("retains the persisted marker when reload cancellation fails", async () => {
    storeForegroundArchiveOperation("operation-id");
    vi.mocked(api.cancelArchiveOperation).mockRejectedValue(new Error("offline"));

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(api.cancelArchiveOperation).toHaveBeenCalledWith("operation-id");
    });
    expect(loadForegroundArchiveOperation()?.operationId).toBe("operation-id");
    expect(await screen.findByText("Archive work was interrupted. Check its destination before retrying.")).toBeInTheDocument();
  });

  it("cancels marked archive work on pagehide and warns before unload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findByText("Documents");
    storeForegroundArchiveOperation("operation-id");

    fireEvent(window, new Event("pagehide"));
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/archive/v2/operations/operation-id/cancel",
      expect.objectContaining({ credentials: "include", keepalive: true, method: "POST" })
    );
    expect(beforeUnload.defaultPrevented).toBe(true);
    expect(loadForegroundArchiveOperation()?.operationId).toBe("operation-id");
  });
});
