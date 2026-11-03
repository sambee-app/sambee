import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import contract from "../../../../../shared/directory-index/contract.json";
import { clearCachedAsyncData } from "../../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../../theme";
import { DIRECTORY_INDEX_POLICY_FIELDS, type DirectoryIndexPolicyScope, type DirectoryIndexSettings } from "../../../types";
import { CompanionDirectoryStatus, CompanionPolicyDelivery } from "../CompanionPolicyDelivery";

vi.mock("../../../services/api", () => ({
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

import api from "../../../services/api";

vi.mock("../../../services/companion", () => ({
  default: { getDirectoryPolicyStatus: vi.fn(), requestDirectoryPolicyChallenge: vi.fn(), redeemDirectoryPolicyGrant: vi.fn() },
}));

import companionService from "../../../services/companion";

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

describe("CompanionPolicyDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
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

  it.each([
    [404, "Companion update required. This Companion has no policy approval support.", true],
    [503, "Companion is offline or unavailable. Its last approved policy remains active.", false],
    [403, "Companion authorization is unavailable. Check pairing in Local Drives, then refresh its status.", false],
  ])("shows actionable companion policy status for HTTP %s and recovers after refresh", async (status, message, blocked) => {
    const user = userEvent.setup();
    vi.mocked(companionService.getDirectoryPolicyStatus).mockRejectedValueOnce({ response: { status } });
    render(
      <SambeeThemeProvider>
        <CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />
      </SambeeThemeProvider>
    );
    expect(await screen.findByText(message)).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply To This Companion" });
    if (blocked) expect(apply).toBeDisabled();
    else expect(apply).toBeEnabled();
    expect(api.issueDirectoryPolicyGrant).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Refresh Status" }));
    expect(await screen.findByText("Desired policy is saved. Companion approval or delivery is pending.")).toBeInTheDocument();
    expect(apply).toBeEnabled();
  });

  it("shows native status without admin reads or approval controls for non-admins", async () => {
    render(<CompanionDirectoryStatus isAdmin={false} />);
    expect(await screen.findByText(/Contact an administrator to apply it/)).toBeInTheDocument();
    expect(api.getDirectoryIndexSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Apply To This Companion" })).not.toBeInTheDocument();
    expect(api.issueDirectoryPolicyGrant).not.toHaveBeenCalled();
    await waitFor(() => expect(companionService.getDirectoryPolicyStatus).toHaveBeenCalledOnce());
  });

  it("loads desired policy only for admins and does not apply it automatically", async () => {
    render(<CompanionDirectoryStatus isAdmin />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply To This Companion" })).toBeEnabled());
    expect(api.getDirectoryIndexSettings).toHaveBeenCalledExactlyOnceWith("companion");
    expect(companionService.getDirectoryPolicyStatus).toHaveBeenCalledOnce();
    expect(companionService.requestDirectoryPolicyChallenge).not.toHaveBeenCalled();
  });

  it("keeps native status readable and allows retry when the admin policy read fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getDirectoryIndexSettings).mockRejectedValueOnce({ response: { data: { detail: "Policy read failed. Retry." } } });
    render(<CompanionDirectoryStatus isAdmin />);
    expect(await screen.findByText("Policy read failed. Retry.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply To This Companion" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply To This Companion" })).toBeEnabled());
  });

  it("aborts an old approval when the desired policy changes", async () => {
    const user = userEvent.setup();
    let approve!: (status: Awaited<ReturnType<typeof companionService.requestDirectoryPolicyChallenge>>) => void;
    vi.mocked(companionService.requestDirectoryPolicyChallenge).mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        })
    );
    const view = render(<CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />);
    await user.click(await screen.findByRole("button", { name: "Apply To This Companion" }));
    const options = vi.mocked(companionService.requestDirectoryPolicyChallenge).mock.calls[0]![0];
    view.rerender(<CompanionPolicyDelivery desiredRevision={1} backendIdentity="verified-backend" />);
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => {
      approve({
        version: 1,
        companion_id: "native-id",
        status: "pending_delivery",
        owner_origin: null,
        backend_identity: null,
        effective_revision: null,
        policy: directorySettings("companion").policy,
        challenge: "stale",
        approved: true,
        message: null,
      });
    });
    expect(api.issueDirectoryPolicyGrant).not.toHaveBeenCalled();
    expect(companionService.redeemDirectoryPolicyGrant).not.toHaveBeenCalled();
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
        <CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />
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
        <CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />
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
        <CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />
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
        <CompanionPolicyDelivery desiredRevision={0} backendIdentity="verified-backend" />
      </SambeeThemeProvider>
    );
    expect(await screen.findByText("Another backend owns companion policy. Reset that owner in native Preferences.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply To This Companion" })).toBeDisabled();
    expect(screen.queryByText("Companion policy is active.")).not.toBeInTheDocument();
  });
});
