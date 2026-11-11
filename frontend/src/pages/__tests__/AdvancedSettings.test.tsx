import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../../../../shared/directory-index/contract.json";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import {
  type AdvancedSystemSettings,
  DIRECTORY_INDEX_POLICY_FIELDS,
  type DirectoryIndexPolicyScope,
  type DirectoryIndexSettings,
} from "../../types";
import { AdvancedSettings as AdvancedSettingsPage } from "../AdvancedSettings";

const AdvancedSettings = () => <AdvancedSettingsPage category="admin-image-viewer" />;

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getAdvancedSettings: vi.fn(),
    updateAdvancedSettings: vi.fn(),
    getDirectoryIndexSettings: vi.fn(),
    updateDirectoryIndexSettings: vi.fn(),
    issueCompanionSettingsGrant: vi.fn(),
  },
}));

import api from "../../services/api";

vi.mock("../../services/companion", () => ({
  default: { getSettingsStatus: vi.fn(), requestSettingsChallenge: vi.fn(), redeemSettingsGrant: vi.fn() },
}));

import companionService from "../../services/companion";

const mockAdvancedSettings: AdvancedSystemSettings = {
  image_conversion_threshold_bytes: {
    key: "image_viewer.conversion_threshold_bytes",
    label: "Image conversion threshold",
    description: "Resize browser-native images larger than this size.",
    value: 5242880,
    default_value: 5242880,
    source: "default",
    min_value: 0,
    max_value: 1073741824,
    step: 1,
  },
  image_conversion_preference: {
    key: "image_viewer.conversion_preference",
    label: "Image conversion preference",
    description: "Applies to backend image previews, including libvips conversions. Local-drive images are unchanged.",
    value: "speed",
    default_value: "speed",
    source: "default",
  },
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

function directorySettings(scope: DirectoryIndexPolicyScope): DirectoryIndexSettings {
  return {
    scope,
    backend_identity: "verified-backend",
    revision: 0,
    policy: {
      version: 1,
      ...Object.fromEntries(DIRECTORY_INDEX_POLICY_FIELDS.map((field) => [field, contract.policy[field].default])),
    } as DirectoryIndexSettings["policy"],
    fields: Object.fromEntries(
      DIRECTORY_INDEX_POLICY_FIELDS.map((field) => [
        field,
        {
          key: `directory_index.${scope}.${field}`,
          label: contract.policy[field].label,
          description: contract.policy[field].description,
          value: contract.policy[field].default,
          source: "default",
          default_value: contract.policy[field].default,
          min_value: contract.policy[field].minimum,
          max_value: contract.policy[field].maximum,
          step: contract.policy[field].step,
        },
      ])
    ) as DirectoryIndexSettings["fields"],
  };
}

describe("AdvancedSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    vi.mocked(api.getAdvancedSettings).mockResolvedValue(mockAdvancedSettings);
    vi.mocked(api.updateAdvancedSettings).mockImplementation(async (update) => update);
    vi.mocked(api.getDirectoryIndexSettings).mockImplementation(async (scope) => directorySettings(scope));
    vi.mocked(api.updateDirectoryIndexSettings).mockImplementation(async (_scope, update) => update);
    vi.mocked(companionService.getSettingsStatus).mockResolvedValue({
      version: 1,
      companion_id: "native-id",
      status: "defaults_active",
      authoritative_origin: null,
      authority_generation: 0,
      sections: {},
      challenge: null,
      message: null,
    });
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
    expect(screen.getByLabelText("Image conversion threshold")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Image Viewer" })).toHaveLength(1);
    expect(screen.queryByText("Preprocessors")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
    expect(screen.queryByText(/exact value:/i)).not.toBeInTheDocument();
    expect(api.getDirectoryIndexSettings).not.toHaveBeenCalled();
    expect(companionService.getSettingsStatus).not.toHaveBeenCalled();
    expect(screen.queryByText("Companion Directory Indexes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Conversion timeout")).toHaveAccessibleDescription(/Maximum time allowed/);
    expect(screen.getByLabelText("Maximum file size")).toHaveAccessibleDescription(/Largest input file/);
  });

  it("keeps image controls out of the system category", async () => {
    render(<AdvancedSettingsPage />);
    await waitFor(() => expect(api.getAdvancedSettings).toHaveBeenCalled());
    expect(screen.queryByLabelText("Image conversion threshold")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Conversion timeout")).not.toBeInTheDocument();
  });

  it("keeps the desktop select label inside its control with help text below", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = (query) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    try {
      render(<AdvancedSettings />);
      const select = await screen.findByRole("combobox", { name: "Image conversion preference" });
      expect(select).toHaveAccessibleDescription(/Applies to backend image previews, including libvips/);
      expect(select).toHaveTextContent("Conversion speed");
      expect(select.closest(".MuiFormControl-root")?.querySelector(".MuiInputLabel-root")).toHaveTextContent("Image conversion preference");
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("saves the preference on change and keeps it after a numeric save", async () => {
    const user = userEvent.setup();
    render(<AdvancedSettings />);
    const select = await screen.findByRole("combobox", { name: "Image conversion preference" });
    expect(select).toHaveTextContent("Conversion speed");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Target size/ }));
    await waitFor(() =>
      expect(api.updateAdvancedSettings).toHaveBeenCalledWith(
        { field: "image_viewer.conversion_preference", value: "size" },
        expect.objectContaining({ signal: expect.anything() })
      )
    );
    expect(select).toHaveTextContent("Target size");
    const timeout = screen.getByLabelText("Conversion timeout");
    expect(timeout).toHaveValue("30");
    await user.clear(timeout);
    await user.type(timeout, "45");
    await user.tab();
    await waitFor(() => expect(api.updateAdvancedSettings).toHaveBeenCalledTimes(2));
    expect(select).toHaveTextContent("Target size");
    expect(timeout).toHaveValue("45");
  });

  it("keeps the confirmed preference after failure and permits retry", async () => {
    vi.mocked(api.updateAdvancedSettings).mockRejectedValueOnce({
      response: { data: { detail: "Check the server connection and try again." } },
    });
    const user = userEvent.setup();
    render(<AdvancedSettings />);
    const select = await screen.findByRole("combobox", { name: "Image conversion preference" });
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Target size/ }));
    expect(await screen.findByText("Check the server connection and try again.")).toBeInTheDocument();
    expect(select).toHaveTextContent("Conversion speed");
    await user.click(select);
    await user.click(await screen.findByRole("option", { name: /Target size/ }));
    await waitFor(() => expect(select).toHaveTextContent("Target size"));
    expect(screen.queryByText("Check the server connection and try again.")).not.toBeInTheDocument();
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
    vi.mocked(api.getAdvancedSettings).mockResolvedValue({ ...mockAdvancedSettings, preprocessors: {} });
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    expect(await screen.findByLabelText("Image conversion threshold")).toBeInTheDocument();
    expect(screen.queryByText("Preprocessors")).not.toBeInTheDocument();
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
    const unit = (await screen.findAllByLabelText("Unit"))[1]!;
    await user.click(unit);
    await user.click(await screen.findByRole("option", { name: "KiB" }));

    expect(maximumFileSize).toHaveValue("102400");
    expect(api.updateAdvancedSettings).not.toHaveBeenCalled();
  });

  it("commits a byte-size value on Enter without changing its unit", async () => {
    const user = userEvent.setup();
    render(<AdvancedSettings />);
    const maximumFileSize = await screen.findByLabelText("Maximum file size");
    await user.clear(maximumFileSize);
    await user.type(maximumFileSize, "128");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(api.updateAdvancedSettings).toHaveBeenCalledWith(
        { field: "preprocessors.imagemagick.max_file_size_bytes", value: 134217728 },
        expect.objectContaining({ signal: expect.anything() })
      )
    );
  });
});
