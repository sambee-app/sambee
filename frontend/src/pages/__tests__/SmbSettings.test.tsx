import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import type { SmbSettings as SmbSettingsData } from "../../types";
import { SmbSettings } from "../SmbSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getSmbSettings: vi.fn(),
    updateSmbSettings: vi.fn(),
  },
}));

import api from "../../services/api";

const smbSettings: SmbSettingsData = {
  read_chunk_size_bytes: {
    key: "smb.read_chunk_size_bytes",
    label: "SMB read chunk size",
    description: "Chunk size used when streaming files from SMB shares.",
    value: 4194304,
    source: "default",
    default_value: 4194304,
    min_value: 65536,
    max_value: 16777216,
    step: 65536,
  },
  policy: {
    authentication_mode: "negotiate",
    encryption_mode: "signing_only",
    connection_timeout_seconds: 30,
  },
  require_signing: true,
  require_encryption: false,
};

describe("SmbSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    vi.mocked(api.getSmbSettings).mockResolvedValue(smbSettings);
    vi.mocked(api.updateSmbSettings).mockImplementation(async (update) => update);
  });

  it("loads SMB controls and persists a valid timeout on blur", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    expect(await screen.findByRole("heading", { name: "Protection" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connection behavior" })).toBeInTheDocument();
    expect(screen.getByLabelText("SMB read chunk size")).toHaveValue(4194304);
    expect(screen.getByRole("combobox", { name: "Transport protection" })).toHaveTextContent("Signing only (SMB 2 compatible)");

    await user.clear(screen.getByLabelText("Connection timeout"));
    await user.type(screen.getByLabelText("Connection timeout"), "45");
    await user.tab();

    await waitFor(() => {
      expect(api.updateSmbSettings).toHaveBeenCalledWith(
        {
          field: "connection_timeout_seconds",
          value: 45,
        },
        expect.objectContaining({ signal: expect.anything() })
      );
    });
    expect(screen.queryByRole("button", { name: "Save SMB settings" })).not.toBeInTheDocument();
  });

  it("shows a retry action when the initial settings load fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSmbSettings).mockRejectedValueOnce(new Error("SMB settings unavailable")).mockResolvedValueOnce(smbSettings);

    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    expect(await screen.findByText("Failed to load SMB settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Protection" })).toBeInTheDocument();
    expect(api.getSmbSettings).toHaveBeenCalledTimes(2);
  });

  it("persists encryption-required protection when selected", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    const protection = await screen.findByRole("combobox", { name: "Transport protection" });
    await user.click(protection);
    await user.click(screen.getByRole("option", { name: "Signing and encryption (SMB 3+)" }));

    await waitFor(() => {
      expect(api.updateSmbSettings).toHaveBeenCalledWith(
        {
          field: "encryption_mode",
          value: "encryption_required",
        },
        expect.objectContaining({ signal: expect.anything() })
      );
    });
  });

  it("restores protection select focus after saving", async () => {
    const user = userEvent.setup();
    let resolveUpdate: ((update: { field: "encryption_mode"; value: "encryption_required" }) => void) | undefined;
    vi.mocked(api.updateSmbSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        })
    );
    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    const protection = await screen.findByRole("combobox", { name: "Transport protection" });
    protection.focus();
    await user.click(protection);
    await user.click(screen.getByRole("option", { name: "Signing and encryption (SMB 3+)" }));

    await waitFor(() => expect(protection).toHaveAttribute("aria-disabled", "true"));
    protection.blur();
    resolveUpdate?.({ field: "encryption_mode", value: "encryption_required" });

    await waitFor(() => expect(protection).toHaveFocus());
  });

  it("retains invalid chunk-size input without sending an update", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    const chunkSize = await screen.findByLabelText("SMB read chunk size");
    await user.clear(chunkSize);
    await user.type(chunkSize, "1");
    await user.tab();

    expect(await screen.findByText("Enter a whole number within the allowed chunk-size range.")).toBeInTheDocument();
    expect(api.updateSmbSettings).not.toHaveBeenCalled();
  });

  it("does not save an unchanged timeout when it loses focus", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <SmbSettings />
      </SambeeThemeProvider>
    );

    const timeout = await screen.findByLabelText("Connection timeout");
    await user.click(timeout);
    await user.tab();

    expect(api.updateSmbSettings).not.toHaveBeenCalled();
    expect(timeout).toBeEnabled();
  });
});
