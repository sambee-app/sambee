import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../../../../shared/directory-index/contract.json";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import { DIRECTORY_INDEX_POLICY_FIELDS, type DirectoryIndexPolicyScope, type DirectoryIndexSettings } from "../../types";
import { DirectorySearchSettings } from "../DirectorySearchSettings";

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

describe("DirectorySearchSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
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

  it("does not reload directory policies on idle renders or uncommitted edits", async () => {
    const user = userEvent.setup();
    const view = render(
      <SambeeThemeProvider>
        <DirectorySearchSettings />
      </SambeeThemeProvider>
    );
    const fields = await screen.findAllByLabelText("SQLite page-cache target");
    expect(api.getDirectoryIndexSettings).toHaveBeenCalledTimes(2);
    expect(api.getDirectoryIndexSettings).toHaveBeenCalledWith("backend");
    expect(api.getDirectoryIndexSettings).toHaveBeenCalledWith("companion");

    view.rerender(
      <SambeeThemeProvider>
        <DirectorySearchSettings />
      </SambeeThemeProvider>
    );
    await user.clear(fields[0]!);
    await user.type(fields[0]!, "1024");

    expect(api.getDirectoryIndexSettings).toHaveBeenCalledTimes(2);
    expect(api.updateDirectoryIndexSettings).not.toHaveBeenCalled();
  });

  it("shows separate directory scopes and persists only the selected host", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <DirectorySearchSettings />
      </SambeeThemeProvider>
    );
    const fields = await screen.findAllByLabelText("SQLite page-cache target");
    expect(fields).toHaveLength(2);
    expect(companionService.getSettingsStatus).not.toHaveBeenCalled();
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

  it("keeps invalid drafts local and associates a failed save with the Companion field", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateDirectoryIndexSettings).mockRejectedValue({
      response: { data: { detail: "Policy save failed. Retry this field." } },
    });
    render(<DirectorySearchSettings />);
    const fields = await screen.findAllByLabelText("SQLite page-cache target");
    const companionField = fields[1]!;
    await user.clear(companionField);
    await user.type(companionField, "1");
    await user.keyboard("{Enter}");
    expect(api.updateDirectoryIndexSettings).not.toHaveBeenCalled();
    await user.clear(companionField);
    await user.type(companionField, "1024");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(companionField).toHaveAccessibleDescription("Policy save failed. Retry this field."));
    expect(api.updateDirectoryIndexSettings).toHaveBeenCalledWith(
      "companion",
      { field: "page_cache_kib", value: 1024 },
      expect.objectContaining({ signal: expect.anything() })
    );
    expect(fields[0]).toHaveValue("2048");
    expect(fields[0]).not.toHaveAttribute("aria-invalid", "true");
  });
});
