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
import { AdvancedSettings } from "../AdvancedSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "editor" }),
    getAdvancedSettings: vi.fn(),
    updateAdvancedSettings: vi.fn(),
    getDirectoryIndexSettings: vi.fn(),
    updateDirectoryIndexSettings: vi.fn(),
    issueDirectoryPolicyGrant: vi.fn(),
  },
}));

import api from "../../services/api";

vi.mock("../../services/companion", () => ({
  default: { getDirectoryPolicyStatus: vi.fn(), requestDirectoryPolicyChallenge: vi.fn(), redeemDirectoryPolicyGrant: vi.fn() },
}));

import companionService from "../../services/companion";

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
    vi.mocked(companionService.getDirectoryPolicyStatus).mockResolvedValue({
      version: 1,
      companion_id: "native-id",
      status: "unowned",
      owner_origin: null,
      backend_identity: null,
      effective_revision: null,
      policy: directorySettings("companion").policy,
      challenge: null,
      approved: false,
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
    expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
    expect(screen.queryByText(/exact value:/i)).not.toBeInTheDocument();
  });

  it("shows separate directory scopes and persists only the selected host", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    const fields = await screen.findAllByLabelText("SQLite page-cache target");
    expect(fields).toHaveLength(2);
    expect(await screen.findByText("Desired policy is saved. Companion approval or delivery is pending.")).toBeInTheDocument();
    await user.clear(fields[0]!);
    await user.type(fields[0]!, "1024");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(api.updateDirectoryIndexSettings).toHaveBeenCalledWith(
        "backend",
        { field: "page_cache_kib", value: 1024 },
        expect.objectContaining({ signal: expect.anything() })
      )
    );
    expect(fields[1]).toHaveValue("2048");
    expect(api.updateAdvancedSettings).not.toHaveBeenCalled();
  });

  it("delivers only an opaque grant after native approval", async () => {
    const user = userEvent.setup();
    const pending = {
      version: 1,
      companion_id: "native-id",
      status: "pending_delivery" as const,
      owner_origin: null,
      backend_identity: null,
      effective_revision: null,
      policy: directorySettings("companion").policy,
      challenge: "native-challenge",
      approved: true,
      message: null,
    };
    vi.mocked(companionService.requestDirectoryPolicyChallenge).mockResolvedValue(pending);
    vi.mocked(api.issueDirectoryPolicyGrant).mockResolvedValue({
      grant: "opaque-grant",
      expires_in_seconds: 60,
      revision: 0,
      backend_identity: "verified-backend",
    });
    vi.mocked(companionService.redeemDirectoryPolicyGrant).mockResolvedValue({
      ...pending,
      status: "applied",
      challenge: null,
      owner_origin: window.location.origin,
      backend_identity: "verified-backend",
      effective_revision: 0,
    });
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    await user.click(await screen.findByRole("button", { name: "Apply To This Companion" }));
    await waitFor(() =>
      expect(api.issueDirectoryPolicyGrant).toHaveBeenCalledWith(
        { companion_id: "native-id", challenge: "native-challenge", origin: window.location.origin },
        expect.objectContaining({ signal: expect.anything() })
      )
    );
    expect(companionService.redeemDirectoryPolicyGrant).toHaveBeenCalledWith(
      "opaque-grant",
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(await screen.findByText("Companion policy is active.")).toBeInTheDocument();
  });

  it("does not issue a grant after the settings surface is closed", async () => {
    const user = userEvent.setup();
    let approve!: (status: Awaited<ReturnType<typeof companionService.requestDirectoryPolicyChallenge>>) => void;
    vi.mocked(companionService.requestDirectoryPolicyChallenge).mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    const view = render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    await user.click(await screen.findByRole("button", { name: "Apply To This Companion" }));
    view.unmount();
    approve({
      version: 1,
      companion_id: "native-id",
      status: "pending_delivery",
      owner_origin: null,
      backend_identity: null,
      effective_revision: null,
      policy: directorySettings("companion").policy,
      challenge: "native-challenge",
      approved: true,
      message: null,
    });
    await Promise.resolve();
    expect(api.issueDirectoryPolicyGrant).not.toHaveBeenCalled();
    expect(companionService.redeemDirectoryPolicyGrant).not.toHaveBeenCalled();
  });

  it("requires native owner reset instead of delivering to a conflicting owner", async () => {
    vi.mocked(companionService.getDirectoryPolicyStatus).mockResolvedValue({
      version: 1,
      companion_id: "native-id",
      status: "owner_conflict",
      owner_origin: "https://other.example",
      backend_identity: "other-backend",
      effective_revision: 0,
      policy: directorySettings("companion").policy,
      challenge: null,
      approved: false,
      message: null,
    });
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    expect(await screen.findByText("Another backend owns companion policy. Reset that owner in native Preferences.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply To This Companion" })).toBeDisabled();
    expect(api.issueDirectoryPolicyGrant).not.toHaveBeenCalled();
  });

  it("does not treat an equal revision from a different backend identity as active", async () => {
    vi.mocked(companionService.getDirectoryPolicyStatus).mockResolvedValue({
      version: 1,
      companion_id: "native-id",
      status: "applied",
      owner_origin: window.location.origin,
      backend_identity: "previous-backend",
      effective_revision: 0,
      policy: directorySettings("companion").policy,
      challenge: null,
      approved: false,
      message: null,
    });
    render(
      <SambeeThemeProvider>
        <AdvancedSettings />
      </SambeeThemeProvider>
    );
    expect(await screen.findByText("Another backend owns companion policy. Reset that owner in native Preferences.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply To This Companion" })).toBeDisabled();
    expect(screen.queryByText("Companion policy is active.")).not.toBeInTheDocument();
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
