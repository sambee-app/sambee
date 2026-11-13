import type { IntegerSystemSetting, SystemSettingSource } from "./index";

export type AggregateHealthSeverity = "ok" | "warning" | "error" | "unknown";
export type HealthSeverity = "ok" | "warning" | "error" | "unknown" | "informational";
export type HealthMonitoringAudience = "admins" | "editors" | "both";

export type MetricAvailability =
  | "available"
  | "collecting"
  | "not_mounted"
  | "unsupported"
  | "permission_denied"
  | "offline"
  | "timeout"
  | "stale"
  | "invalid"
  | "unavailable";

export type StorageSpaceSemantics = "posix_unprivileged_blocks" | "caller_quota";
export type ContainerMemoryLimitState = "finite" | "unlimited" | "unknown";
export type CpuTemperatureLimitOrigin = "hardware" | "kernel_policy" | "admin_override";
export type CpuTemperatureOverrideState = "none" | "active" | "review_required" | "conflict";

export interface HealthMonitoringThresholds {
  memory_warning_tenths_percent: number;
  memory_error_tenths_percent: number;
  load_warning_hundredths: number;
  load_error_hundredths: number;
  available_space_warning_tenths_percent: number;
  available_space_error_tenths_percent: number;
}

export interface HealthMonitoringPolicy extends HealthMonitoringThresholds {
  enabled: boolean;
  audience: HealthMonitoringAudience;
}

export interface CpuTemperatureSourceSettings {
  source_id: string;
  label: string;
  driver: string;
  device_path: string;
  discovered: boolean;
  availability: MetricAvailability;
  detected_warning_millidegrees: number | null;
  detected_error_millidegrees: number | null;
  detected_limit_origin: CpuTemperatureLimitOrigin | null;
  warning_override_millidegrees: number | null;
  error_override_millidegrees: number | null;
  effective_warning_millidegrees: number | null;
  effective_warning_origin: CpuTemperatureLimitOrigin | null;
  effective_error_millidegrees: number | null;
  effective_error_origin: CpuTemperatureLimitOrigin | null;
  warning_exceeds_detected: boolean;
  error_exceeds_detected: boolean;
  override_state: CpuTemperatureOverrideState;
  override_notice: string | null;
  unusable_attributes: string[];
}

export type HealthMonitoringIntegerField =
  | "memory_warning_tenths_percent"
  | "memory_error_tenths_percent"
  | "load_warning_hundredths"
  | "load_error_hundredths"
  | "available_space_warning_tenths_percent"
  | "available_space_error_tenths_percent";

export interface HealthMonitoringSettings {
  enabled: boolean;
  enabled_source: SystemSettingSource;
  audience: HealthMonitoringAudience;
  audience_source: SystemSettingSource;
  policy: HealthMonitoringPolicy;
  fields: Record<HealthMonitoringIntegerField, IntegerSystemSetting>;
  cpu_sources: CpuTemperatureSourceSettings[];
  cpu_sensor_discovery_status: MetricAvailability;
  cpu_sensor_discovery_message: string | null;
}

export type HealthMonitoringSettingsUpdate =
  | { field: "enabled"; value: boolean }
  | { field: "audience"; value: HealthMonitoringAudience }
  | { field: HealthMonitoringIntegerField; value: number }
  | { field: "cpu_temp_warning_override"; source_id: string; value_millidegrees: number | null }
  | { field: "cpu_temp_error_override"; source_id: string; value_millidegrees: number | null };

export interface HealthMonitoringClientPolicy {
  enabled: boolean;
  permitted: boolean;
  thresholds: HealthMonitoringThresholds | null;
  summary_poll_seconds: number;
  dialog_poll_seconds: number;
  host_stale_seconds: number;
  storage_stale_seconds: number;
}

export interface HealthSummary {
  severity: AggregateHealthSeverity;
  headline: string;
  incomplete_coverage: boolean;
  coverage_notes: string[];
  last_updated_at: string | null;
}

export interface MemoryMetric {
  severity: HealthSeverity;
  availability: MetricAvailability;
  source: string;
  used_bytes: number | null;
  available_bytes: number | null;
  total_bytes: number | null;
  used_tenths_percent: number | null;
  used_percent: number | null;
  warning_tenths_percent: number;
  error_tenths_percent: number;
  recovery_pending: boolean;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message: string | null;
  action: string | null;
}

export interface SystemLoadMetric {
  severity: HealthSeverity;
  availability: MetricAvailability;
  source: string;
  logical_cpu_count: number | null;
  normalized_1m: number | null;
  normalized_5m: number | null;
  normalized_15m: number | null;
  evaluated_window: "5m";
  warning_hundredths: number;
  error_hundredths: number;
  recovery_pending: boolean;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message: string | null;
  action: string | null;
}

export interface CpuTemperatureSummary {
  severity: HealthSeverity;
  availability: MetricAvailability;
  source_id: string | null;
  label: string | null;
  driver: string | null;
  source: string;
  package_count: number;
  assessed_package_count: number;
  incomplete_coverage: boolean;
  current_millidegrees: number | null;
  detected_warning_millidegrees: number | null;
  detected_error_millidegrees: number | null;
  detected_limit_origin: CpuTemperatureLimitOrigin | null;
  effective_warning_millidegrees: number | null;
  effective_warning_origin: CpuTemperatureLimitOrigin | null;
  effective_error_millidegrees: number | null;
  effective_error_origin: CpuTemperatureLimitOrigin | null;
  warning_override_millidegrees: number | null;
  error_override_millidegrees: number | null;
  warning_exceeds_detected: boolean;
  error_exceeds_detected: boolean;
  override_state: CpuTemperatureOverrideState;
  unusable_attributes: string[];
  recovery_pending: boolean;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message: string | null;
  action: string | null;
}

export interface ContainerMemoryMetric {
  severity: HealthSeverity;
  availability: MetricAvailability;
  limit_state: ContainerMemoryLimitState;
  source: string;
  used_bytes: number | null;
  cache_bytes: number | null;
  working_set_bytes: number | null;
  limit_bytes: number | null;
  used_tenths_percent: number | null;
  used_percent: number | null;
  warning_tenths_percent: number | null;
  error_tenths_percent: number | null;
  recovery_pending: boolean;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message: string | null;
  action: string | null;
}

export interface StorageMetric {
  id: string;
  kind: "application_data" | "application_temp" | "application_combined" | "smb" | "local_drive";
  connection_id?: string | null;
  label: string;
  is_placeholder?: boolean;
  source: string;
  semantics: StorageSpaceSemantics;
  severity: HealthSeverity;
  availability: MetricAvailability;
  available_bytes: number | null;
  total_bytes: number | null;
  actual_free_bytes?: number | null;
  available_tenths_percent: number | null;
  available_percent: number | null;
  warning_tenths_percent: number;
  error_tenths_percent: number;
  recovery_pending: boolean;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message: string | null;
  action: string | null;
}

export interface HealthMonitoringSnapshot {
  generated_at: string;
  thresholds: HealthMonitoringThresholds;
  summary: HealthSummary;
  host_memory: MemoryMetric;
  system_load: SystemLoadMetric;
  cpu_temperature: CpuTemperatureSummary;
  container_memory: ContainerMemoryMetric;
  application_storage: StorageMetric[];
  smb_storage: StorageMetric[];
}

export type CompanionDriveCapacityAvailability =
  | "available"
  | "collecting"
  | "unsupported"
  | "permission_denied"
  | "offline"
  | "timeout"
  | "stale"
  | "invalid"
  | "unavailable";

export interface CompanionDriveCapacityItem {
  id: string;
  name: string;
  drive_type: "fixed" | "removable" | "network" | "virtual" | "unknown";
  availability: CompanionDriveCapacityAvailability;
  semantics: StorageSpaceSemantics;
  available_bytes: number | null;
  total_bytes: number | null;
  actual_free_bytes?: number | null;
  sampled_at: string | null;
  age_seconds: number | null;
  is_stale: boolean;
  message?: string | null;
}

export interface CompanionDriveCapacityListing {
  generated_at: string;
  items: CompanionDriveCapacityItem[];
}
