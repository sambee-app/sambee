import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../../../../shared/filesystem-search/contract.json";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { renderWithStyles as render } from "../../test/utils/renderWithStyles";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("FilesystemSearchSettings", () => {
  beforeEach(() => {
    clearCachedAsyncData();
    vi.mocked(api.getFilesystemSearchSettings).mockReset().mockResolvedValue(settings());
    vi.mocked(api.updateFilesystemSearchSettings)
      .mockReset()
      .mockImplementation(async (update) => update);
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

  it.each([
    { scenario: "without editing", retryValue: 40 },
    { scenario: "after editing", retryValue: 41 },
  ])("retains the save error until edited and permits retry $scenario", async ({ retryValue }) => {
    const user = userEvent.setup();
    const message = "Policy was not saved. Retry.";
    const firstSave = deferred<FilesystemSearchSettingUpdate>();
    const retry = deferred<FilesystemSearchSettingUpdate>();
    const firstUpdate = { field: "max_seconds", value: 40 } satisfies FilesystemSearchSettingUpdate;
    const retryUpdate = { ...firstUpdate, value: retryValue };
    const options = expect.objectContaining({ signal: expect.anything() });
    const update = vi.mocked(api.updateFilesystemSearchSettings);
    update.mockReturnValueOnce(firstSave.promise).mockReturnValueOnce(retry.promise);

    render(<FilesystemSearchSettings />);
    const field = await screen.findByRole("textbox", { name: "Maximum scan time" });
    const description = field.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    await user.clear(field);
    await user.type(field, "40");
    await user.keyboard("{Enter}");
    expect(update).toHaveBeenCalledExactlyOnceWith(firstUpdate, options);
    expect(field).toBeDisabled();

    await act(async () => firstSave.reject({ response: { data: { detail: message } } }));
    expect(field).toBeEnabled();
    expect(field).toHaveFocus();
    expect(field).toHaveValue("40");
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("{ArrowLeft}");
    expect(field).toHaveAccessibleDescription(message);
    expect(field).toHaveAttribute("aria-describedby", description);
    expect(update).toHaveBeenCalledTimes(1);

    if (retryValue !== firstUpdate.value) {
      await user.clear(field);
      await user.type(field, String(retryValue));
      expect(field).toHaveAccessibleDescription(/Range: 1–60/);
      expect(field).toHaveAttribute("aria-invalid", "false");
      expect(update).toHaveBeenCalledTimes(1);
    }
    await user.keyboard("{Enter}");
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenNthCalledWith(2, retryUpdate, options);
    expect(field).toBeDisabled();

    await act(async () => retry.resolve(retryUpdate));
    expect(field).toBeEnabled();
    expect(field).toHaveValue(String(retryValue));
    expect(field).toHaveAttribute("aria-invalid", "false");
    expect(field).toHaveAccessibleDescription(/Range: 1–60/);
  });

  it("disables only the field that is saving", async () => {
    const save = deferred<FilesystemSearchSettingUpdate>();
    vi.mocked(api.updateFilesystemSearchSettings).mockReturnValueOnce(save.promise);
    render(<FilesystemSearchSettings />);
    const field = await screen.findByRole("textbox", { name: "Maximum results" });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "700" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Maximum scan time" })).toBeEnabled();
    act(() => field.blur());
    await act(async () => save.resolve({ field: "max_results", value: 700 }));
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
