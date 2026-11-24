import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  notify: vi.fn(),
  interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}));
vi.mock("axios", () => ({ default: { create: () => mocks, isCancel: () => false } }));
vi.mock("../companionSettingsEvents", () => ({ notifyCompanionSettingsChanged: mocks.notify }));

import api from "../api";

describe("file-system search settings API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requests policy and notifies Companion after a successful update", async () => {
    const policy = { policy: { max_results: 500 } };
    mocks.get.mockResolvedValueOnce({ data: policy });
    expect(await api.getFilesystemSearchSettings()).toBe(policy);
    expect(mocks.get).toHaveBeenCalledWith("/admin/settings/filesystem-search");
    const update = { field: "max_results", value: 800 } as const;
    mocks.put.mockResolvedValueOnce({ data: update });
    expect(await api.updateFilesystemSearchSettings(update)).toEqual(update);
    expect(mocks.put).toHaveBeenCalledWith("/admin/settings/filesystem-search", update, undefined);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("does not trigger delivery after a failed update", async () => {
    mocks.put.mockRejectedValueOnce(new Error("Cannot save policy"));
    await expect(api.updateFilesystemSearchSettings({ field: "max_results", value: 800 })).rejects.toThrow("Cannot save policy");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
