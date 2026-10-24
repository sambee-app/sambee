import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import type { AdvancedSystemSettings } from "../../types";
import { AdvancedSettings } from "../AdvancedSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getAdvancedSettings: vi.fn(),
    updateAdvancedSettings: vi.fn(),
  },
}));

import api from "../../services/api";

const mockAdvancedSettings: AdvancedSystemSettings = {
  preprocessors: {
    imagemagick: {
      max_file_size_bytes: {
        key: "preprocessors.imagemagick.max_file_size_bytes",
        label: "Maximum file size",
        description: "Largest input file ImageMagick is allowed to preprocess.",
        value: 104857600,
        source: "default",
        default_value: 104857600,
        min_value: 1048576,
        max_value: 1073741824,
        step: 1048576,
      },
      timeout_seconds: {
        key: "preprocessors.imagemagick.timeout_seconds",
        label: "Conversion timeout",
        description: "Maximum time allowed for an ImageMagick preprocessing run.",
        value: 30,
        source: "default",
        default_value: 30,
        min_value: 5,
        max_value: 600,
        step: 1,
      },
    },
  },
};

describe("AdvancedSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    vi.mocked(api.getAdvancedSettings).mockResolvedValue(mockAdvancedSettings);
    vi.mocked(api.updateAdvancedSettings).mockImplementation(async (update) => update);
  });

  it("loads and displays advanced settings", async () => {
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );

    await waitFor(() => {
      expect(api.getAdvancedSettings).toHaveBeenCalled();
    });

    expect(screen.queryByText("Configure limits for server-side preprocessing services.")).not.toBeInTheDocument();
    expect(screen.queryByText("Set the file-size and runtime limits used when ImageMagick conversions run.")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Maximum file size")).toBeInTheDocument();
    expect(screen.getByLabelText("Conversion timeout")).toBeInTheDocument();
    expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
    expect(screen.queryByText(/exact value:/i)).not.toBeInTheDocument();
  });

  it("persists a valid updated value on blur", async () => {
    const user = userEvent.setup();

    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );

    const timeoutInput = await screen.findByLabelText("Conversion timeout");
    await user.clear(timeoutInput);
    await user.type(timeoutInput, "45");
    await user.tab();

    await waitFor(() => {
      expect(api.updateAdvancedSettings).toHaveBeenCalledWith(
        {
          field: "preprocessors.imagemagick.timeout_seconds",
          value: 45,
        },
        expect.objectContaining({ signal: expect.anything() })
      );
    });
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
  });

  it("does not invent settings for an unavailable optional preprocessor", async () => {
    vi.mocked(api.getAdvancedSettings).mockResolvedValue({ preprocessors: {} });
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    expect(await screen.findByText("Preprocessors")).toBeInTheDocument();
    expect(screen.queryByLabelText("Maximum file size")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Conversion timeout")).not.toBeInTheDocument();
    expect(api.updateAdvancedSettings).not.toHaveBeenCalled();
  });

  it("does not save unchanged values when focus leaves a field", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );

    const maximumFileSize = await screen.findByLabelText("Maximum file size");
    await user.click(maximumFileSize);
    await user.tab();

    expect(api.updateAdvancedSettings).not.toHaveBeenCalled();
    expect(maximumFileSize).toBeEnabled();
    expect(screen.queryByRole("status", { name: "Saving setting" })).not.toBeInTheDocument();
  });

  it("changes units without changing the stored byte value", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );

    const maximumFileSize = await screen.findByLabelText("Maximum file size");
    const unit = (await screen.findAllByLabelText("Unit"))[0]!;
    await user.click(unit);
    await user.click(await screen.findByRole("option", { name: "KiB" }));

    expect(maximumFileSize).toHaveValue("102400");
    expect(api.updateAdvancedSettings).not.toHaveBeenCalled();
  });
});
