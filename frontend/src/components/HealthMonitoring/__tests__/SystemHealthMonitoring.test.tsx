import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractActiveSmbConnectionIds,
  type SystemHealthViewState,
  useSystemHealthMonitoring,
} from "../../../hooks/useSystemHealthMonitoring";
import { publishHealthMonitoringSettingsChanged } from "../../../services/healthMonitoringEvents";
import { SambeeThemeProvider } from "../../../theme/ThemeContext";
import type { HealthMonitoringClientPolicy, HealthMonitoringSnapshot } from "../../../types";
import { MobileToolbar } from "../../FileBrowser/MobileToolbar";
import HamburgerMenu from "../../Mobile/HamburgerMenu";
import { HealthMonitorIcon } from "../HealthStatusIcon";
import { SystemHealthDialog } from "../SystemHealthDialog";

vi.mock("../../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "admin" }),
    getHealthMonitoringClientPolicy: vi.fn(),
    getHealthMonitoringSnapshot: vi.fn(),
  },
}));

vi.mock("../../../services/companion", () => ({
  default: {
    getDrivesCapacity: vi.fn(),
  },
  hasStoredSecret: vi.fn(() => true),
  isCompanionAuthSignatureMismatch: vi.fn(() => false),
  isCompanionCapacityUnsupported: vi.fn(
    (err: unknown) => typeof err === "object" && err !== null && (err as { response?: { status?: number } }).response?.status === 404
  ),
  isCompanionPairingMissing: vi.fn(() => false),
}));

import api from "../../../services/api";
import companionService from "../../../services/companion";

const baseSnapshot: HealthMonitoringSnapshot = {
  generated_at: "2026-11-13T12:00:00Z",
  thresholds: {
    memory_warning_tenths_percent: 850,
    memory_error_tenths_percent: 950,
    load_warning_hundredths: 75,
    load_error_hundredths: 90,
    available_space_warning_tenths_percent: 100,
    available_space_error_tenths_percent: 50,
  },
  summary: {
    severity: "ok",
    headline: "Available checks are OK; temperature is not available.",
    incomplete_coverage: true,
    coverage_notes: ["CPU temperature is not available."],
    last_updated_at: "2026-11-13T12:00:00Z",
  },
  host_memory: {
    severity: "ok",
    availability: "available",
    source: "/host/proc/meminfo",
    used_bytes: 4 * 1024 ** 3,
    available_bytes: 12 * 1024 ** 3,
    total_bytes: 16 * 1024 ** 3,
    used_tenths_percent: 250,
    used_percent: 25.0,
    warning_tenths_percent: 850,
    error_tenths_percent: 950,
    recovery_pending: false,
    sampled_at: "2026-11-13T12:00:00Z",
    age_seconds: 2.0,
    is_stale: false,
    message: null,
    action: null,
  },
  system_load: {
    severity: "ok",
    availability: "available",
    source: "/host/proc/loadavg, /host/proc/cpuinfo",
    logical_cpu_count: 8,
    normalized_1m: 0.25,
    normalized_5m: 0.4,
    normalized_15m: 0.35,
    evaluated_window: "5m",
    warning_hundredths: 75,
    error_hundredths: 90,
    recovery_pending: false,
    sampled_at: "2026-11-13T12:00:00Z",
    age_seconds: 2.0,
    is_stale: false,
    message: null,
    action: null,
  },
  cpu_temperature: {
    severity: "unknown",
    availability: "unsupported",
    source_id: null,
    label: null,
    driver: null,
    source: "/host/sys",
    package_count: 0,
    assessed_package_count: 0,
    incomplete_coverage: true,
    current_millidegrees: null,
    detected_warning_millidegrees: null,
    detected_error_millidegrees: null,
    detected_limit_origin: null,
    effective_warning_millidegrees: null,
    effective_warning_origin: null,
    effective_error_millidegrees: null,
    effective_error_origin: null,
    warning_override_millidegrees: null,
    error_override_millidegrees: null,
    warning_exceeds_detected: false,
    error_exceeds_detected: false,
    override_state: "none",
    unusable_attributes: [],
    recovery_pending: false,
    sampled_at: null,
    age_seconds: null,
    is_stale: false,
    message: "No supported CPU package or Raspberry Pi CPU thermal sensor is exposed under /host/sys.",
    action: null,
  },
  container_memory: {
    severity: "informational",
    availability: "available",
    limit_state: "unlimited",
    source: "/sys/fs/cgroup",
    used_bytes: 128 * 1024 ** 2,
    cache_bytes: 256 * 1024 ** 2,
    working_set_bytes: 256 * 1024 ** 2,
    limit_bytes: null,
    used_tenths_percent: null,
    used_percent: null,
    warning_tenths_percent: null,
    error_tenths_percent: null,
    recovery_pending: false,
    sampled_at: "2026-11-13T12:00:00Z",
    age_seconds: 2.0,
    is_stale: false,
    message: "No memory limit configured.",
    action: null,
  },
  application_storage: [
    {
      id: "app-data",
      kind: "application_data",
      label: "Application data",
      source: "/app/data",
      semantics: "posix_unprivileged_blocks",
      severity: "ok",
      availability: "available",
      available_bytes: 40 * 1024 ** 3,
      total_bytes: 100 * 1024 ** 3,
      available_tenths_percent: 400,
      available_percent: 40.0,
      warning_tenths_percent: 100,
      error_tenths_percent: 50,
      recovery_pending: false,
      sampled_at: "2026-11-13T12:00:00Z",
      age_seconds: 5.0,
      is_stale: false,
      message: null,
      action: null,
    },
  ],
  smb_storage: [
    {
      id: "smb-1",
      kind: "smb",
      connection_id: "conn-1",
      label: "Media Archive With A Very Long Descriptive Connection Name",
      source: "//nas.local/media",
      semantics: "caller_quota",
      severity: "error",
      availability: "available",
      available_bytes: 18 * 1024 ** 3,
      total_bytes: 450 * 1024 ** 3,
      actual_free_bytes: 120 * 1024 ** 3,
      available_tenths_percent: 40,
      available_percent: 4.0,
      warning_tenths_percent: 100,
      error_tenths_percent: 50,
      recovery_pending: false,
      sampled_at: "2026-11-13T12:00:00Z",
      age_seconds: 5.0,
      is_stale: false,
      message: "Available space reflects the caller quota on this share.",
      action: "Free space or select another location.",
    },
  ],
};

const baseHealth: SystemHealthViewState = {
  visible: true,
  severity: "error",
  headline: "One storage volume has critically low free space.",
  incompleteCoverage: true,
  coverageNotes: baseSnapshot.summary.coverage_notes,
  lastUpdatedAt: baseSnapshot.summary.last_updated_at,
  backendUnavailable: false,
  snapshot: baseSnapshot,
  localDrives: [],
  companionUpdateRequired: false,
};

describe("System Health Monitoring UI and Hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("uses a common monitor symbol with distinct state badges and independent SVG masks", () => {
    const { container } = render(
      <div>
        <HealthMonitorIcon status="ok" />
        <HealthMonitorIcon status="warning" />
        <HealthMonitorIcon status="error" />
        <HealthMonitorIcon status="unknown" />
        <HealthMonitorIcon status="informational" />
      </div>
    );
    expect(container.querySelector('[data-health-shape="circle"]')).toBeTruthy();
    expect(container.querySelector('[data-health-shape="triangle"]')).toBeTruthy();
    expect(container.querySelector('[data-health-shape="octagon"]')).toBeTruthy();
    expect(container.querySelector('[data-health-status="unknown"][data-health-shape="question-circle"]')).toBeTruthy();
    expect(container.querySelector('[data-health-status="informational"][data-health-shape="info-circle"]')).toBeTruthy();
    const icons = container.querySelectorAll('svg[data-health-symbol="monitor-pulse"]');
    expect(icons).toHaveLength(5);
    const maskIds = Array.from(container.querySelectorAll("mask"), (mask) => mask.id);
    expect(new Set(maskIds).size).toBe(10);
    for (const icon of icons) {
      for (const layer of icon.querySelectorAll("g[mask]")) {
        const maskId = layer.getAttribute("mask")?.slice("url(#".length, -1);
        expect(Array.from(icon.querySelectorAll("mask"), (mask) => mask.id)).toContain(maskId);
      }
    }
  });

  it("filters active SMB connection IDs to at most two deduplicated non-local IDs", () => {
    expect(extractActiveSmbConnectionIds(["local-drive:root", "smb-a", "smb-a", "smb-b", "smb-c"])).toEqual(["smb-a", "smb-b"]);
  });

  it("groups storage by purpose, separates connection types from names, and expands only the selected metric", async () => {
    const health: SystemHealthViewState = {
      visible: true,
      severity: "error",
      headline: "One storage volume has critically low free space.",
      incompleteCoverage: true,
      coverageNotes: ["CPU temperature is not available.", "Update Companion to show drive space."],
      lastUpdatedAt: "2026-11-13T12:00:00Z",
      backendUnavailable: false,
      snapshot: {
        ...baseSnapshot,
        application_storage: [
          ...baseSnapshot.application_storage,
          ...baseSnapshot.application_storage.map((item) => ({
            ...item,
            id: "app-temp",
            kind: "application_temp" as const,
            label: "Temporary storage",
            source: "/tmp",
            available_bytes: 25 * 1024 ** 3,
            available_percent: 25,
            available_tenths_percent: 250,
          })),
        ],
      },
      localDrives: [
        {
          id: "companion-update-required",
          kind: "local_drive",
          label: "Local drives",
          is_placeholder: true,
          source: "Companion localhost:21549",
          semantics: "posix_unprivileged_blocks",
          severity: "unknown",
          availability: "unsupported",
          available_bytes: null,
          total_bytes: null,
          available_tenths_percent: null,
          available_percent: null,
          warning_tenths_percent: 100,
          error_tenths_percent: 50,
          recovery_pending: false,
          sampled_at: null,
          age_seconds: null,
          is_stale: false,
          message: "Update Companion to show drive space.",
          action: "Update Companion to show drive space.",
        },
      ],
      companionUpdateRequired: true,
    };

    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog open={true} onClose={vi.fn()} health={health} />
        </SambeeThemeProvider>
      );
    });

    expect(screen.getByText("Action needed")).toBeInTheDocument();
    expect(screen.getByText("25% used")).toBeInTheDocument();
    expect(screen.getByText("18.0 GB free (4%)")).toBeInTheDocument();
    expect(screen.getByText("No limit set")).toBeInTheDocument();
    expect(screen.getByText("Container memory")).toBeInTheDocument();
    expect(screen.getByText("128.0 MB used")).toBeInTheDocument();
    expect(screen.getByText("Media Archive With A Very Long Descriptive Connection Name")).toBeInTheDocument();
    expect(screen.getByText(/Free space or select another location\./)).toBeInTheDocument();
    expect(screen.getByText(/Update Companion to show drive space\./)).toBeInTheDocument();
    expect(screen.queryByText(/Source:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Warning ≥/)).not.toBeInTheDocument();
    expect(screen.queryByText("5 min (evaluated):")).not.toBeInTheDocument();
    expect(screen.queryByText(/CPU usage/i)).not.toBeInTheDocument();

    const server = within(screen.getByTestId("system-health-resource-overview"));
    expect(screen.queryByText("Sambee storage")).not.toBeInTheDocument();
    expect(server.getByText("Container application data")).toBeInTheDocument();
    expect(server.getByText("Container temporary storage")).toBeInTheDocument();
    expect(server.queryByText("Local drives")).not.toBeInTheDocument();
    expect(screen.getByText("Connection storage")).toBeInTheDocument();
    const storage = screen.getByTestId("system-health-connection-storage");
    const labels = within(storage).getAllByText(/Media Archive|Local drives/);
    expect(labels.map((label) => label.textContent)).toEqual([
      "Media Archive With A Very Long Descriptive Connection Name",
      "Local drives",
    ]);
    expect(within(storage).getByText("SMB connection")).toBeInTheDocument();
    expect(within(storage).queryByText("Local drive")).not.toBeInTheDocument();
    expect(within(storage).queryByText("Container application data")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Technical details" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector('[data-health-symbol="monitor-pulse"]')).toBeNull();

    const user = userEvent.setup();
    const loadButton = screen.getByRole("button", { name: /^Server load/ });
    await user.click(loadButton);
    const loadDetails = within(screen.getByRole("region", { name: /^Server load/ }));
    expect(loadButton).toHaveAttribute("aria-expanded", "true");
    expect(loadDetails.getByText("5 min (evaluated):")).toBeInTheDocument();
    expect(loadDetails.getByText(/8 logical CPUs/)).toBeInTheDocument();
    expect(screen.getAllByText(/Source:/)).toHaveLength(1);
    expect(screen.queryByText("Capacity: 450.0 GB")).not.toBeInTheDocument();
    await user.click(loadButton);
    await waitFor(() => expect(screen.queryByText(/Source:/)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Media Archive/ }));
    const details = within(screen.getByRole("region", { name: /^Media Archive/ }));
    expect(screen.getAllByText("128.0 MB used")).toHaveLength(1);
    expect(screen.getAllByText("18.0 GB free (4%)")).toHaveLength(1);
    expect(screen.getAllByText("Media Archive With A Very Long Descriptive Connection Name")).toHaveLength(1);
    expect(details.queryByText(/128\.0 MB|4\.0% available|No memory limit/)).not.toBeInTheDocument();
    expect(details.queryByText(health.headline)).not.toBeInTheDocument();
    for (const note of health.coverageNotes) {
      expect(details.queryByText(note)).not.toBeInTheDocument();
    }
    expect(details.getByText("Capacity: 450.0 GB")).toBeInTheDocument();
    expect(details.queryByText(/Caller-available space/)).not.toBeInTheDocument();
    expect(details.getByText(/Total physical free on share/)).toBeInTheDocument();
    await user.click(server.getByRole("button", { name: /Container application data/ }));
    const containerStorageDetails = within(screen.getByRole("region", { name: /Container application data/ }));
    expect(containerStorageDetails.getByText("Capacity: 100.0 GB")).toBeInTheDocument();
    expect(containerStorageDetails.queryByText(/Unprivileged filesystem blocks|statvfs/)).not.toBeInTheDocument();
    await user.click(within(storage).getByRole("button", { name: /^Local drives/ }));
    const localDetails = within(screen.getByRole("region", { name: /^Local drives/ }));
    expect(localDetails.queryByText(/Unprivileged filesystem blocks|statvfs/)).not.toBeInTheDocument();
  });

  it("keeps a shared application and temporary filesystem as one container storage row", async () => {
    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog
            open
            onClose={vi.fn()}
            health={{
              ...baseHealth,
              snapshot: {
                ...baseSnapshot,
                application_storage: baseSnapshot.application_storage.map((item) => ({
                  ...item,
                  kind: "application_combined",
                  label: "Application data and temporary storage",
                })),
              },
            }}
          />
        </SambeeThemeProvider>
      );
    });
    const server = within(screen.getByTestId("system-health-resource-overview"));
    expect(server.getByRole("button", { name: /Container application data and temporary storage/ })).toBeInTheDocument();
    expect(server.getAllByText("40.0 GB free (40%)")).toHaveLength(1);
    expect(server.queryByText("Container application data", { exact: true })).not.toBeInTheDocument();
    expect(server.queryByText("Container temporary storage", { exact: true })).not.toBeInTheDocument();
  });

  it("shows each unavailable source once without raw messages or setup instructions", async () => {
    const source = baseSnapshot.host_memory.source;
    const health: SystemHealthViewState = {
      ...baseHealth,
      severity: "unknown",
      snapshot: {
        ...baseSnapshot,
        host_memory: {
          ...baseSnapshot.host_memory,
          severity: "unknown",
          availability: "not_mounted",
          total_bytes: null,
          used_bytes: null,
          available_bytes: null,
          used_percent: null,
          message: `Optional host mount ${source} is not configured.`,
          action: `Mount /proc/meminfo to ${source}:ro to enable monitoring.`,
        },
        container_memory: {
          ...baseSnapshot.container_memory,
          severity: "unknown",
          availability: "permission_denied",
          is_stale: true,
        },
      },
    };
    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog open onClose={vi.fn()} health={health} />
        </SambeeThemeProvider>
      );
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Server memory/ }));
    await user.click(screen.getByRole("button", { name: /^Container memory/ }));
    const memoryDetails = within(screen.getByRole("region", { name: /^Server memory/ }));
    const containerDetails = within(screen.getByRole("region", { name: /^Container memory/ }));
    expect(screen.getByRole("dialog").textContent?.split(source)).toHaveLength(2);
    expect(memoryDetails.getByText(/Not available \(mount not configured\)/)).toBeInTheDocument();
    expect(containerDetails.getByText(/Permission denied · Old data/)).toBeInTheDocument();
    expect(screen.queryByText(/Optional host mount|Mount \/proc\/meminfo|No supported CPU package/)).not.toBeInTheDocument();
  });

  it("shows finite container usage once and retains its separate memory limit", async () => {
    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog
            open
            onClose={vi.fn()}
            health={{
              ...baseHealth,
              snapshot: {
                ...baseSnapshot,
                container_memory: {
                  ...baseSnapshot.container_memory,
                  severity: "ok",
                  limit_state: "finite",
                  limit_bytes: 512 * 1024 ** 2,
                  used_percent: 25,
                  warning_tenths_percent: 850,
                  error_tenths_percent: 950,
                },
              },
            }}
          />
        </SambeeThemeProvider>
      );
    });
    await userEvent.setup().click(screen.getByRole("button", { name: /Container memory/ }));
    expect(screen.getAllByText("128.0 MB used (25%)")).toHaveLength(1);
    expect(screen.getByText("File cache: 256.0 MB")).toBeInTheDocument();
    expect(screen.queryByText("256.0 MB used (25%)")).not.toBeInTheDocument();
    expect(screen.getByText("Memory limit: 512.0 MB")).toBeInTheDocument();
    expect(screen.queryByText("No limit set")).not.toBeInTheDocument();
  });

  it("marks server readings as out of date without hiding current local-drive health", async () => {
    const localDrives = baseSnapshot.application_storage.map((item) => ({
      ...item,
      id: "local",
      kind: "local_drive" as const,
      label: "Local disk",
    }));
    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog
            open
            onClose={vi.fn()}
            health={{ ...baseHealth, severity: "unknown", backendUnavailable: true, localDrives }}
          />
        </SambeeThemeProvider>
      );
    });

    expect(
      screen.getByText("Cannot update server checks. Checks retry automatically. Check your network connection if this continues.")
    ).toBeInTheDocument();
    const resources = within(screen.getByTestId("system-health-resource-overview"));
    expect(resources.getAllByText("Out of date")).toHaveLength(5);
    expect(resources.getByRole("button", { name: /Container application data Out of date/ })).toBeInTheDocument();
    expect(resources.queryByText("25% used")).not.toBeInTheDocument();
    const storage = within(screen.getByTestId("system-health-connection-storage"));
    expect(storage.getAllByText("Out of date")).toHaveLength(1);
    expect(storage.getByText("Local drive")).toBeInTheDocument();
    expect(storage.getByText("40.0 GB free (40%)")).toBeInTheDocument();
    expect(storage.getByTitle("OK")).toBeInTheDocument();
    expect(storage.queryByText("18.0 GB free (4%)")).not.toBeInTheDocument();
  });

  it("does not present stale storage values as current and offers only Close", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <SambeeThemeProvider>
          <SystemHealthDialog
            open
            onClose={onClose}
            health={{
              ...baseHealth,
              snapshot: {
                ...baseSnapshot,
                smb_storage: baseSnapshot.smb_storage.map((item) => ({
                  ...item,
                  is_stale: true,
                  availability: "stale",
                  severity: "unknown",
                })),
              },
            }}
          />
        </SambeeThemeProvider>
      );
    });
    expect(screen.getByText("Out of date")).toBeInTheDocument();
    expect(screen.queryByText("18.0 GB free (4%)")).not.toBeInTheDocument();
    const user = userEvent.setup();
    expect(screen.queryByRole("button", { name: /retry|refresh/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the main Sambee icon after opening System health from the mobile drawer and closing the dialog", async () => {
    const health: SystemHealthViewState = {
      visible: true,
      severity: "ok",
      headline: "All monitored checks are OK.",
      incompleteCoverage: false,
      coverageNotes: [],
      lastUpdatedAt: "2026-11-13T12:00:00Z",
      backendUnavailable: false,
      snapshot: baseSnapshot,
      localDrives: [],
      companionUpdateRequired: false,
    };

    function MobileFlowHarness() {
      const [drawerOpen, setDrawerOpen] = useState(false);
      const [dialogOpen, setDialogOpen] = useState(false);
      const triggerRef = useRef<HTMLElement | null>(null);
      const [restoreEl, setRestoreEl] = useState<HTMLElement | null>(null);

      return (
        <SambeeThemeProvider>
          <BrowserRouter>
            <MobileToolbar
              currentDirectoryName="demo"
              onOpenMenu={() => {
                if (document.activeElement instanceof HTMLElement) {
                  triggerRef.current = document.activeElement;
                }
                setDrawerOpen(true);
              }}
              onNavigateUp={vi.fn()}
              canNavigateUp={false}
            />
            <HamburgerMenu
              open={drawerOpen}
              onClose={() => setDrawerOpen(false)}
              connections={[]}
              selectedConnectionId=""
              onConnectionChange={vi.fn()}
              onNavigateToRoot={vi.fn()}
              onOpenDocumentation={vi.fn()}
              onOpenSettings={vi.fn()}
              systemHealth={{
                visible: true,
                severity: "ok",
                headline: health.headline,
                onOpen: () => {
                  setRestoreEl(triggerRef.current);
                  setDialogOpen(true);
                },
              }}
              onLogout={vi.fn()}
            />
            <SystemHealthDialog open={dialogOpen} onClose={() => setDialogOpen(false)} health={health} restoreFocusEl={restoreEl} />
          </BrowserRouter>
        </SambeeThemeProvider>
      );
    }

    const user = userEvent.setup();
    await act(async () => {
      render(<MobileFlowHarness />);
    });

    // Mobile toolbar has NO duplicate health button
    expect(screen.queryByLabelText(/System health:/)).not.toBeInTheDocument();

    const sambeeMenuButton = screen.getByLabelText("Open menu");
    await user.click(sambeeMenuButton);

    const drawerHealthItem = await screen.findByText("System health");
    const drawerHealthButton = screen.getByRole("button", { name: /system health/i });
    expect(drawerHealthButton.querySelector('[data-health-symbol="monitor-pulse"]')).toBeNull();
    expect(drawerHealthButton.querySelector('[data-health-shape="circle"]')).not.toBeNull();
    await user.click(drawerHealthItem);

    // Drawer closes and details dialog opens
    expect(await screen.findByRole("heading", { name: "System Health" })).toBeInTheDocument();

    const closeButton = screen.getByRole("button", { name: "Close" });
    await user.click(closeButton);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(document.activeElement).toBe(sambeeMenuButton);
  });

  it("handles older Companion 404 compatibility, evaluates local-drive thresholds, and writes nothing to browser storage", async () => {
    vi.mocked(api.getHealthMonitoringClientPolicy).mockResolvedValue({
      enabled: true,
      permitted: true,
      thresholds: baseSnapshot.thresholds,
      summary_poll_seconds: 15,
      dialog_poll_seconds: 5,
      host_stale_seconds: 15,
      storage_stale_seconds: 180,
    });
    vi.mocked(api.getHealthMonitoringSnapshot).mockResolvedValue({
      ...baseSnapshot,
      smb_storage: [],
      summary: {
        severity: "ok",
        headline: "All monitored checks are OK.",
        incomplete_coverage: false,
        coverage_notes: [],
        last_updated_at: "2026-11-13T12:00:00Z",
      },
    });
    vi.mocked(companionService.getDrivesCapacity).mockRejectedValueOnce({
      response: { status: 404, data: { detail: "Not Found" } },
    });

    const localSetItemSpy = vi.spyOn(window.localStorage, "setItem");
    const sessionSetItemSpy = vi.spyOn(window.sessionStorage, "setItem");

    const { result } = renderHook(() =>
      useSystemHealthMonitoring({
        authenticated: true,
        activeConnectionIds: ["smb-1"],
        dialogOpen: false,
        companionStatus: "paired",
        companionLifecycleStatus: null,
      })
    );

    await waitFor(() => {
      expect(result.current.visible).toBe(true);
      expect(result.current.companionUpdateRequired).toBe(true);
    });

    expect(result.current.severity).toBe("unknown");
    expect(result.current.localDrives[0]?.label).toBe("Local drives");
    expect(result.current.localDrives[0]?.is_placeholder).toBe(true);
    expect(result.current.headline).toContain("Update Companion to show drive space");
    expect(localSetItemSpy).not.toHaveBeenCalled();
    expect(sessionSetItemSpy).not.toHaveBeenCalled();
  });

  describe("polling lifecycle", () => {
    const permittedPolicy: HealthMonitoringClientPolicy = {
      enabled: true,
      permitted: true,
      thresholds: baseSnapshot.thresholds,
      summary_poll_seconds: 15,
      dialog_poll_seconds: 5,
      host_stale_seconds: 15,
      storage_stale_seconds: 180,
    };
    const options = {
      authenticated: true,
      activeConnectionIds: ["smb-1"],
      dialogOpen: false,
      companionStatus: "paired" as const,
      companionLifecycleStatus: null,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(api.getHealthMonitoringClientPolicy).mockReset().mockResolvedValue(permittedPolicy);
      vi.mocked(api.getHealthMonitoringSnapshot).mockReset().mockResolvedValue(baseSnapshot);
      vi.mocked(companionService.getDrivesCapacity).mockReset().mockResolvedValue({
        generated_at: baseSnapshot.generated_at,
        items: [],
      });
    });

    afterEach(() => {
      cleanup();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("rechecks policy and both metric sources each time the dialog opens", async () => {
      const { rerender } = renderHook(({ dialogOpen }) => useSystemHealthMonitoring({ ...options, dialogOpen }), {
        initialProps: { dialogOpen: false },
      });
      await act(async () => {});

      await act(async () => {
        rerender({ dialogOpen: true });
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(2);
      expect(companionService.getDrivesCapacity).toHaveBeenCalledTimes(2);

      await act(async () => {
        rerender({ dialogOpen: false });
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);

      await act(async () => {
        rerender({ dialogOpen: true });
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(3);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(4);
      expect(companionService.getDrivesCapacity).toHaveBeenCalledTimes(4);
    });

    it("stops metric requests if permission is revoked before the dialog opens", async () => {
      const { result, rerender } = renderHook(({ dialogOpen }) => useSystemHealthMonitoring({ ...options, dialogOpen }), {
        initialProps: { dialogOpen: false },
      });
      await act(async () => {});
      vi.mocked(api.getHealthMonitoringClientPolicy).mockResolvedValue({
        ...permittedPolicy,
        permitted: false,
        thresholds: null,
      });

      await act(async () => {
        rerender({ dialogOpen: true });
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);
      expect(companionService.getDrivesCapacity).toHaveBeenCalledTimes(1);
      expect(result.current.visible).toBe(false);
    });

    it.each([
      { dialogOpen: false, intervalMs: 15_000 },
      { dialogOpen: true, intervalMs: 5_000 },
    ])("uses the normal interval for collecting checks (dialog: $dialogOpen)", async ({ dialogOpen, intervalMs }) => {
      vi.mocked(api.getHealthMonitoringSnapshot).mockImplementation(
        async (): Promise<HealthMonitoringSnapshot> => ({
          ...baseSnapshot,
          generated_at: new Date().toISOString(),
          smb_storage: baseSnapshot.smb_storage.map((item) => ({
            ...item,
            availability: "collecting",
            severity: "unknown",
          })),
        })
      );
      renderHook(() => useSystemHealthMonitoring({ ...options, dialogOpen }));
      await act(async () => {});

      await act(async () => {
        await vi.advanceTimersByTimeAsync(intervalMs - 1);
      });
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(1);
    });

    it.each([
      { enabled: false, permitted: false },
      { enabled: true, permitted: false },
    ])("rechecks policy without metric requests while denied: %o", async (initialPolicy) => {
      vi.mocked(api.getHealthMonitoringClientPolicy)
        .mockResolvedValueOnce({ ...permittedPolicy, ...initialPolicy, thresholds: null })
        .mockResolvedValue(permittedPolicy);
      const { result } = renderHook(() => useSystemHealthMonitoring(options));
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(result.current.visible).toBe(false);
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(1);
      expect(api.getHealthMonitoringSnapshot).not.toHaveBeenCalled();
      expect(companionService.getDrivesCapacity).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);
      expect(companionService.getDrivesCapacity).toHaveBeenCalledTimes(1);
      expect(result.current.visible).toBe(true);
    });

    it.each([10_000, 120_000])("rechecks policy on return after %i ms hidden and stops on sign-out", async (hiddenMs) => {
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      vi.mocked(api.getHealthMonitoringClientPolicy)
        .mockResolvedValueOnce({ ...permittedPolicy, enabled: false, permitted: false, thresholds: null })
        .mockResolvedValue(permittedPolicy);
      const { result, rerender } = renderHook(({ authenticated }) => useSystemHealthMonitoring({ ...options, authenticated }), {
        initialProps: { authenticated: true },
      });
      await act(async () => {});
      await act(async () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        publishHealthMonitoringSettingsChanged();
        await vi.advanceTimersByTimeAsync(hiddenMs);
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(1);
      expect(api.getHealthMonitoringSnapshot).not.toHaveBeenCalled();

      await act(async () => {
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current.visible).toBe(true);
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);

      await act(async () => {
        rerender({ authenticated: false });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(result.current.visible).toBe(false);
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);
      expect(companionService.getDrivesCapacity).toHaveBeenCalledTimes(1);
    });

    it("rechecks policy immediately after local settings changes", async () => {
      vi.mocked(api.getHealthMonitoringClientPolicy)
        .mockResolvedValueOnce({ ...permittedPolicy, enabled: false, permitted: false, thresholds: null })
        .mockResolvedValue(permittedPolicy);
      const { result } = renderHook(() => useSystemHealthMonitoring(options));
      await act(async () => {});
      expect(result.current.visible).toBe(false);
      await act(async () => {
        publishHealthMonitoringSettingsChanged();
      });
      expect(result.current.visible).toBe(true);
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(api.getHealthMonitoringSnapshot).toHaveBeenCalledTimes(1);
    });

    it("does not grant access when a policy recheck fails and retries on the next policy interval", async () => {
      vi.mocked(api.getHealthMonitoringClientPolicy)
        .mockResolvedValueOnce({ ...permittedPolicy, permitted: false, thresholds: null })
        .mockRejectedValueOnce(new Error("Backend unavailable"))
        .mockResolvedValue(permittedPolicy);
      const { result } = renderHook(() => useSystemHealthMonitoring(options));
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(2);
      expect(result.current.visible).toBe(false);
      expect(api.getHealthMonitoringSnapshot).not.toHaveBeenCalled();
      expect(companionService.getDrivesCapacity).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(api.getHealthMonitoringClientPolicy).toHaveBeenCalledTimes(3);
      expect(result.current.visible).toBe(true);
    });
  });
});
