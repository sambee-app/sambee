import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAsyncData } from "../../hooks/useCachedAsyncData";
import { SambeeThemeProvider } from "../../theme";
import type { HealthMonitoringSettings as HealthMonitoringSettingsData, HealthMonitoringSettingsUpdate } from "../../types";
import { HealthMonitoringSettings } from "../HealthMonitoringSettings";

vi.mock("../../services/api", () => ({
  default: {
    getThemes: () => Promise.resolve({ themes: [], site_default_id: "sambee-light" }),
    getCurrentUser: () => Promise.resolve({ role: "admin" }),
    getHealthMonitoringSettings: vi.fn(),
    updateHealthMonitoringSettings: vi.fn(),
  },
}));

import api from "../../services/api";

const initialSettings: HealthMonitoringSettingsData = {
  enabled: true,
  enabled_source: "default",
  audience: "admins",
  audience_source: "default",
  policy: {
    enabled: true,
    audience: "admins",
    memory_warning_tenths_percent: 850,
    memory_error_tenths_percent: 950,
    load_warning_hundredths: 75,
    load_error_hundredths: 90,
    available_space_warning_tenths_percent: 100,
    available_space_error_tenths_percent: 50,
  },
  fields: {
    memory_warning_tenths_percent: {
      key: "health_monitoring.memory_warning_tenths_percent",
      label: "Memory warning threshold",
      description: "",
      value: 850,
      source: "default",
      default_value: 850,
      min_value: 1,
      max_value: 1000,
      step: 1,
    },
    memory_error_tenths_percent: {
      key: "health_monitoring.memory_error_tenths_percent",
      label: "Memory error threshold",
      description: "",
      value: 950,
      source: "default",
      default_value: 950,
      min_value: 1,
      max_value: 1000,
      step: 1,
    },
    load_warning_hundredths: {
      key: "health_monitoring.load_warning_hundredths",
      label: "Normalized 5-minute load warning threshold",
      description: "",
      value: 75,
      source: "default",
      default_value: 75,
      min_value: 1,
      max_value: Number.MAX_SAFE_INTEGER,
      step: 1,
    },
    load_error_hundredths: {
      key: "health_monitoring.load_error_hundredths",
      label: "Normalized 5-minute load error threshold",
      description: "",
      value: 90,
      source: "default",
      default_value: 90,
      min_value: 1,
      max_value: Number.MAX_SAFE_INTEGER,
      step: 1,
    },
    available_space_warning_tenths_percent: {
      key: "health_monitoring.available_space_warning_tenths_percent",
      label: "Available-space warning threshold",
      description: "",
      value: 100,
      source: "default",
      default_value: 100,
      min_value: 0,
      max_value: 999,
      step: 1,
    },
    available_space_error_tenths_percent: {
      key: "health_monitoring.available_space_error_tenths_percent",
      label: "Available-space error threshold",
      description: "",
      value: 50,
      source: "default",
      default_value: 50,
      min_value: 0,
      max_value: 999,
      step: 1,
    },
  },
  cpu_sources: [
    {
      source_id: "coretemp:devices/platform/coretemp.0:Package id 0",
      label: "CPU package (Package id 0)",
      driver: "coretemp",
      device_path: "devices/platform/coretemp.0",
      discovered: true,
      availability: "available",
      detected_warning_millidegrees: 85000,
      detected_error_millidegrees: 100000,
      detected_limit_origin: "hardware",
      warning_override_millidegrees: 90000,
      error_override_millidegrees: null,
      effective_warning_millidegrees: 90000,
      effective_warning_origin: "admin_override",
      effective_error_millidegrees: 100000,
      effective_error_origin: "hardware",
      warning_exceeds_detected: true,
      error_exceeds_detected: false,
      override_state: "active",
      override_notice: null,
      unusable_attributes: [],
    },
  ],
  cpu_sensor_discovery_status: "available",
  cpu_sensor_discovery_message: null,
};

const automaticSettings: HealthMonitoringSettingsData = {
  ...initialSettings,
  cpu_sources: initialSettings.cpu_sources.map((source) => ({
    ...source,
    warning_override_millidegrees: null,
    effective_warning_millidegrees: source.detected_warning_millidegrees,
    effective_warning_origin: "hardware",
    override_state: "none",
    warning_exceeds_detected: false,
  })),
};

describe("HealthMonitoringSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedAsyncData();
    vi.mocked(api.getHealthMonitoringSettings).mockReset().mockResolvedValue(initialSettings);
    vi.mocked(api.updateHealthMonitoringSettings)
      .mockReset()
      .mockImplementation(async (payload) => payload);
  });

  it("applies only the confirmed field and preserves another field's unsaved draft", async () => {
    let finishSave: (() => void) | undefined;
    vi.mocked(api.updateHealthMonitoringSettings).mockImplementationOnce(
      (payload) =>
        new Promise((resolve) => {
          finishSave = () => resolve(payload);
        })
    );
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <HealthMonitoringSettings />
      </SambeeThemeProvider>
    );
    const warning = await screen.findByLabelText("Memory warning threshold (%)");
    const error = screen.getByLabelText("Memory error threshold (%)");
    await user.clear(warning);
    await user.type(warning, "82.5");
    await user.tab();
    expect(warning).toBeDisabled();
    await user.clear(error);
    await user.type(error, "94.5");
    vi.mocked(api.getHealthMonitoringSettings).mockResolvedValueOnce({ ...initialSettings });

    await act(async () => finishSave?.());

    await waitFor(() => expect(warning).toBeEnabled());
    expect(warning).toHaveValue("82.5");
    expect(error).toHaveValue("94.5");
    expect(api.getHealthMonitoringSettings).toHaveBeenCalledTimes(1);
  });

  it("reports a CPU metadata refresh failure separately from the successful save and permits retry", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <HealthMonitoringSettings />
      </SambeeThemeProvider>
    );
    const automatic = await screen.findByRole("button", { name: "Return to Automatic" });
    vi.mocked(api.getHealthMonitoringSettings).mockRejectedValueOnce(new Error("Metadata unavailable"));
    await user.click(automatic);

    expect(await screen.findByText(/The setting was saved, but CPU temperature details could not be refreshed/)).toBeInTheDocument();
    expect(screen.queryByText("Could not save this health-monitoring setting. Check the value and retry.")).not.toBeInTheDocument();
    vi.mocked(api.getHealthMonitoringSettings).mockResolvedValueOnce(automaticSettings);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Return to Automatic" })).not.toBeInTheDocument());
    expect(api.updateHealthMonitoringSettings).toHaveBeenCalledTimes(1);
  });

  it("merges delayed CPU metadata without replacing confirmed thresholds or other drafts", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <HealthMonitoringSettings />
      </SambeeThemeProvider>
    );
    const automatic = await screen.findByRole("button", { name: "Return to Automatic" });
    let finishRefresh: (() => void) | undefined;
    vi.mocked(api.getHealthMonitoringSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve(automaticSettings);
        })
    );
    await user.click(automatic);
    await waitFor(() => expect(api.getHealthMonitoringSettings).toHaveBeenCalledTimes(2));
    const warning = screen.getByLabelText("Memory warning threshold (%)");
    const error = screen.getByLabelText("Memory error threshold (%)");
    await user.clear(warning);
    await user.type(warning, "82.5");
    await user.tab();
    await waitFor(() => expect(warning).toBeEnabled());
    await user.clear(error);
    await user.type(error, "84.0");

    await act(async () => finishRefresh?.());
    expect(warning).toHaveValue("82.5");
    expect(error).toHaveValue("84.0");
    await user.tab();
    await waitFor(() =>
      expect(api.updateHealthMonitoringSettings).toHaveBeenLastCalledWith(
        { field: "memory_error_tenths_percent", value: 840 },
        { signal: expect.any(AbortSignal) }
      )
    );
    expect(api.getHealthMonitoringSettings).toHaveBeenCalledTimes(2);
  });

  it("rejects a CPU save response for a different source", async () => {
    vi.mocked(api.updateHealthMonitoringSettings).mockImplementationOnce(async (payload): Promise<HealthMonitoringSettingsUpdate> => {
      if (!("source_id" in payload)) throw new Error("Expected a CPU override");
      return { ...payload, source_id: "another-source" };
    });
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <HealthMonitoringSettings />
      </SambeeThemeProvider>
    );
    await user.click(await screen.findByRole("button", { name: "Return to Automatic" }));
    expect(await screen.findByText("Could not save this health-monitoring setting. Check the value and retry.")).toBeInTheDocument();
    expect(api.getHealthMonitoringSettings).toHaveBeenCalledTimes(1);
  });

  it("commits scaled-integer thresholds, rejects excess precision and crossed pairs, and manages CPU overrides", async () => {
    const user = userEvent.setup();
    render(
      <SambeeThemeProvider>
        <HealthMonitoringSettings />
      </SambeeThemeProvider>
    );

    expect(await screen.findByRole("heading", { name: "Monitoring and Visibility" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("85.0 °C (Hardware)")).toBeInTheDocument();
    expect(screen.getByText(/Warning: Manual warning threshold \(90\.0 °C\) exceeds the detected limit/)).toBeInTheDocument();

    // Reject excess precision (85.25%) without rounding
    const memWarnInput = screen.getByLabelText("Memory warning threshold (%)");
    await user.clear(memWarnInput);
    await user.type(memWarnInput, "85.25");
    await user.tab();
    expect(api.updateHealthMonitoringSettings).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a percentage from 0.1 to 100.0 in 0.1 steps.")).toBeInTheDocument();

    // Reject crossing memory error threshold (96.0% > 95.0%)
    await user.clear(memWarnInput);
    await user.type(memWarnInput, "96.0");
    await user.tab();
    expect(api.updateHealthMonitoringSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Increase the error threshold first/)).toBeInTheDocument();

    // Commit valid scaled tenths (82.5% -> 825)
    await user.clear(memWarnInput);
    await user.type(memWarnInput, "82.5");
    await user.tab();
    await waitFor(() => {
      expect(api.updateHealthMonitoringSettings).toHaveBeenCalledWith(
        {
          field: "memory_warning_tenths_percent",
          value: 825,
        },
        { signal: expect.any(AbortSignal) }
      );
    });

    // Return CPU warning override to Automatic
    await user.click(screen.getByRole("button", { name: "Return to Automatic" }));
    await waitFor(() => {
      expect(api.updateHealthMonitoringSettings).toHaveBeenCalledWith(
        {
          field: "cpu_temp_warning_override",
          source_id: "coretemp:devices/platform/coretemp.0:Package id 0",
          value_millidegrees: null,
        },
        { signal: expect.any(AbortSignal) }
      );
    });
  });
});
