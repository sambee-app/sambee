import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../i18n";
import type { SettingsSyncSnapshot } from "../../../services/companionSettingsSync";
import { CompanionDirectoryStatus } from "../CompanionPolicyDelivery";

const { request, snapshot } = vi.hoisted(() => ({
  request: vi.fn(),
  snapshot: { phase: "defaults_active", status: null, message: null, sections: {} } as SettingsSyncSnapshot,
}));

vi.mock("../../../services/companionSettingsSync", () => ({
  companionSettingsSync: { request },
  useCompanionSettingsSync: () => snapshot,
}));

describe("Companion shared synchronization status", () => {
  beforeEach(() => {
    request.mockClear();
    Object.assign(snapshot, { phase: "defaults_active", status: null, message: null, sections: {} });
  });

  it.each([false, true])("uses the shared surface and status for administrator=%s", (isAdmin) => {
    render(<CompanionDirectoryStatus isAdmin={isAdmin} />);
    expect(screen.getByTestId("companion-settings-surface")).toBeInTheDocument();
    expect(screen.getByText("Directory Search on This Device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply To This Companion" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Status" })).toBeEnabled();
  });

  it("retries through the shared synchronizer without changing user scope", async () => {
    snapshot.phase = "delivery_failed";
    render(<CompanionDirectoryStatus isAdmin={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(request).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("shows pairing recovery instructions instead of a delivery failure", async () => {
    snapshot.phase = "pairing_required";
    render(<CompanionDirectoryStatus isAdmin={false} />);
    expect(screen.getByText("Theme: Pairing required")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Pair this browser in Settings > Local Drives");
    expect(screen.queryByText(/Delivery failed/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(request).toHaveBeenCalledExactlyOnceWith(false, true);
  });

  it("disables refresh during delivery and keeps notices inside the surface", () => {
    snapshot.phase = "synchronizing";
    render(<CompanionDirectoryStatus isAdmin={false} />);
    expect(screen.getByRole("button", { name: "Refresh Status" })).toBeDisabled();
    expect(screen.getByTestId("companion-settings-surface")).toContainElement(screen.getByRole("status"));
  });

  it.each([
    "defaults_active",
    "synchronized",
    "synchronizing",
    "update_required",
    "authority_conflict",
    "pairing_required",
    "delivery_failed",
  ] as const)("keeps every %s state inside the shared surface", (phase) => {
    snapshot.phase = phase;
    snapshot.sections = { theme: phase, localization: "synchronized", directory_index: "defaults_active" };
    render(<CompanionDirectoryStatus isAdmin={false} />);
    const surface = screen.getByTestId("companion-settings-surface");
    expect(surface).toContainElement(screen.getByRole("status"));
    expect(surface).toHaveTextContent("Localization: Synchronized");
    expect(surface).toHaveTextContent("Directory search policy: Built-in defaults");
  });
});
