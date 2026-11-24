import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../../../../shared/filesystem-search/contract.json";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import type { FilesystemSearchSettingUpdate, FilesystemSearchSettings as SettingsData } from "../../types";
import { FilesystemSearchSettings } from "../FilesystemSearchSettings";

vi.mock("../../services/api", () => ({
  default: {
    getFilesystemSearchSettings: vi.fn(),
    updateFilesystemSearchSettings: vi.fn(),
  },
}));

import api from "../../services/api";

function settings(): SettingsData {
  const fields = Object.fromEntries(
    Object.entries(contract.policy_bounds).map(([field, bounds]) => [
      field,
      {
        value: contract.policy_defaults[field as keyof typeof contract.policy_defaults],
        default_value: contract.policy_defaults[field as keyof typeof contract.policy_defaults],
        min_value: bounds.min,
        max_value: bounds.max,
        source: "default",
      },
    ])
  ) as SettingsData["fields"];
  return { policy: { ...contract.policy_defaults }, fields };
}

describe("FilesystemSearchSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    vi.mocked(api.getFilesystemSearchSettings).mockResolvedValue(settings());
    vi.mocked(api.updateFilesystemSearchSettings).mockImplementation(async (update) => update);
  });

  it("shows server bounds and saves only a valid committed field", async () => {
    const user = userEvent.setup();
    render(<FilesystemSearchSettings />);
    const field = await screen.findByRole("textbox", { name: "Maximum results" });
    expect(field).toHaveValue("500");
    expect(field).toHaveAccessibleDescription(/Range: 1–1,?000/);
    await user.clear(field);
    await user.type(field, "1001{Enter}");
    expect(api.updateFilesystemSearchSettings).not.toHaveBeenCalled();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/whole number from 1 to 1000/);
    await user.clear(field);
    await user.type(field, "800{Enter}");
    await waitFor(() =>
      expect(api.updateFilesystemSearchSettings).toHaveBeenCalledWith(
        { field: "max_results", value: 800 },
        expect.objectContaining({ signal: expect.anything() })
      )
    );
    expect(await screen.findByDisplayValue("800")).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("textbox", { name: "Maximum scan time" })).toHaveValue("30");
  });

  it("retains field errors until edited and permits retry", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFilesystemSearchSettings)
      .mockRejectedValueOnce({ response: { data: { detail: "Policy was not saved. Retry." } } })
      .mockImplementation(async (update) => update);
    render(<FilesystemSearchSettings />);
    const field = await screen.findByRole("textbox", { name: "Maximum scan time" });
    await user.clear(field);
    await user.type(field, "40{Enter}");
    await waitFor(() => expect(field).toHaveAccessibleDescription("Policy was not saved. Retry."));
    await user.type(field, "{Enter}");
    await waitFor(() => expect(api.updateFilesystemSearchSettings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "false"));
  });

  it("disables only the field that is saving", async () => {
    let finish!: (value: FilesystemSearchSettingUpdate) => void;
    vi.mocked(api.updateFilesystemSearchSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<FilesystemSearchSettings />);
    const field = await screen.findByRole("textbox", { name: "Maximum results" });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "700" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Maximum scan time" })).toBeEnabled();
    act(() => field.blur());
    await act(async () => finish({ field: "max_results", value: 700 }));
    await waitFor(() => expect(field).toBeEnabled());
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("offers a retry when settings cannot load", async () => {
    vi.mocked(api.getFilesystemSearchSettings).mockRejectedValueOnce(new Error("Cannot load policy. Retry."));
    render(<FilesystemSearchSettings />);
    expect(
      await screen.findByText("Could not load file-system search settings. Check the backend connection, then retry.")
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("textbox", { name: "Maximum results" })).toBeInTheDocument();
  });

  it("explains when an older backend does not provide search settings", async () => {
    vi.mocked(api.getFilesystemSearchSettings).mockRejectedValueOnce({ response: { status: 404 } });
    render(<FilesystemSearchSettings />);
    expect(await screen.findByText("Update Sambee to configure file-system search limits.")).toBeInTheDocument();
  });
});
