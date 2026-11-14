import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Divider, Stack, Typography } from "@mui/material";
import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import type { SystemHealthViewState } from "../../hooks/useSystemHealthMonitoring";
import { formatDate, formatFileSize } from "../../pages/FileBrowser/formatters";
import type {
  AggregateHealthSeverity,
  ContainerMemoryMetric,
  CpuTemperatureLimitOrigin,
  CpuTemperatureSummary,
  HealthSeverity,
  MemoryMetric,
  StorageMetric,
  SystemLoadMetric,
} from "../../types";
import { formatLocalizedNumber } from "../../utils/localeFormatting";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { FormSurface, formAccordionSummarySx } from "../Form/FormLayout";
import { HealthStatusIcon } from "./HealthStatusIcon";

interface SystemHealthDialogProps {
  open: boolean;
  onClose: () => void;
  health: SystemHealthViewState;
  restoreFocusEl?: HTMLElement | null;
}

function formatTenthsPercent(tenths: number): string {
  return `${formatLocalizedNumber(tenths / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function formatHundredths(hundredths: number): string {
  return formatLocalizedNumber(hundredths / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMillidegrees(millidegrees: number): string {
  return `${formatLocalizedNumber(millidegrees / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
}

function getSeverityColor(severity: AggregateHealthSeverity | HealthSeverity): string {
  switch (severity) {
    case "error":
      return "error.main";
    case "warning":
      return "warning.main";
    case "ok":
      return "success.main";
    default:
      return "text.secondary";
  }
}

type OverviewMetric = Pick<MemoryMetric, "severity" | "availability" | "is_stale">;
type SourceMetric = Pick<MemoryMetric, "source" | "availability" | "age_seconds" | "is_stale">;

const SEVERITY_ORDER: Record<HealthSeverity, number> = { error: 0, warning: 1, unknown: 2, ok: 3, informational: 4 };
const PERCENT_SCALE = 100;

export function SystemHealthDialog({ open, onClose, health, restoreFocusEl = null }: SystemHealthDialogProps) {
  const { t } = useTranslation();
  const detailsId = useId();

  const originLabel = (origin: CpuTemperatureLimitOrigin | null): string => {
    switch (origin) {
      case "hardware":
        return t("settings.healthMonitoring.fields.originHardware");
      case "kernel_policy":
        return t("settings.healthMonitoring.fields.originKernelPolicy");
      case "admin_override":
        return t("settings.healthMonitoring.fields.originAdminOverride");
      default:
        return t("systemHealth.statuses.notAvailable");
    }
  };

  const renderAge = (ageSeconds: number | null, isStale: boolean) => {
    if (ageSeconds === null) {
      return null;
    }
    const seconds = Math.max(0, Math.round(ageSeconds));
    return isStale ? t("systemHealth.metrics.staleTag", { seconds }) : t("systemHealth.metrics.ageSeconds", { seconds });
  };

  const renderSource = (metric: SourceMetric, local = false) => {
    const stale = metric.is_stale || metric.availability === "stale" || (!local && health.backendUnavailable);
    const availability = metric.availability !== "available" ? metric.availability : stale ? "stale" : "available";
    const ageText = renderAge(metric.age_seconds, stale);
    return (
      <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5, overflowWrap: "anywhere" }}>
        {t("systemHealth.metrics.sourceLabel", { source: metric.source })}
        {availability !== "available" && !(availability === "stale" && ageText)
          ? ` · ${t(`systemHealth.availability.${availability}`)}`
          : ""}
        {ageText ? ` · ${ageText}` : ""}
      </Typography>
    );
  };

  const renderHostMemory = (metric: MemoryMetric) => {
    return (
      <Box sx={{ py: 1 }}>
        {metric.total_bytes !== null && metric.available_bytes !== null ? (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {t("systemHealth.metrics.memoryCapacity", {
              total: formatFileSize(metric.total_bytes),
              available: formatFileSize(metric.available_bytes),
            })}
          </Typography>
        ) : null}
        <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
          {t("systemHealth.metrics.thresholdsHigh", {
            warning: formatTenthsPercent(metric.warning_tenths_percent),
            error: formatTenthsPercent(metric.error_tenths_percent),
          })}
        </Typography>
        {renderSource(metric)}
      </Box>
    );
  };

  const renderSystemLoad = (metric: SystemLoadMetric) => {
    const hasNormalized = metric.normalized_1m !== null && metric.normalized_5m !== null && metric.normalized_15m !== null;

    return (
      <Box sx={{ py: 1 }}>
        {hasNormalized && (
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2, mt: 0.5 }}>
            <Typography variant="body2">
              {t("systemHealth.metrics.load1m")}:{" "}
              <strong>{formatLocalizedNumber(metric.normalized_1m!, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </Typography>
            <Typography variant="body2">
              {t("systemHealth.metrics.load5mEvaluated")}:{" "}
              <strong>{formatLocalizedNumber(metric.normalized_5m!, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </Typography>
            <Typography variant="body2">
              {t("systemHealth.metrics.load15m")}:{" "}
              <strong>{formatLocalizedNumber(metric.normalized_15m!, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
            </Typography>
          </Box>
        )}
        <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
          {t("systemHealth.metrics.thresholdsHigh", {
            warning: formatHundredths(metric.warning_hundredths),
            error: formatHundredths(metric.error_hundredths),
          })}
          {metric.logical_cpu_count !== null
            ? ` · ${t("systemHealth.metrics.logicalCpuMetadata", { count: metric.logical_cpu_count })}`
            : ""}
        </Typography>
        {renderSource(metric)}
      </Box>
    );
  };

  const renderCpuTemperature = (metric: CpuTemperatureSummary) => {
    return (
      <Box sx={{ py: 1 }}>
        {metric.label && <Typography variant="body2">{metric.label}</Typography>}
        {(metric.detected_warning_millidegrees !== null ||
          metric.detected_error_millidegrees !== null ||
          metric.effective_warning_millidegrees !== null ||
          metric.effective_error_millidegrees !== null) && (
          <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
            {t("systemHealth.metrics.detectedLimits", {
              warning:
                metric.detected_warning_millidegrees !== null
                  ? formatMillidegrees(metric.detected_warning_millidegrees)
                  : t("systemHealth.statuses.notAvailable"),
              error:
                metric.detected_error_millidegrees !== null
                  ? formatMillidegrees(metric.detected_error_millidegrees)
                  : t("systemHealth.statuses.notAvailable"),
            })}
            {" · "}
            {t("systemHealth.metrics.effectiveThresholds", {
              warning:
                metric.effective_warning_millidegrees !== null
                  ? formatMillidegrees(metric.effective_warning_millidegrees)
                  : t("systemHealth.statuses.notAvailable"),
              warningOrigin: originLabel(metric.effective_warning_origin),
              error:
                metric.effective_error_millidegrees !== null
                  ? formatMillidegrees(metric.effective_error_millidegrees)
                  : t("systemHealth.statuses.notAvailable"),
              errorOrigin: originLabel(metric.effective_error_origin),
            })}
          </Typography>
        )}
        {renderSource(metric)}
      </Box>
    );
  };

  const renderContainerMemory = (metric: ContainerMemoryMetric) => {
    return (
      <Box sx={{ py: 0.5 }}>
        <Typography variant="caption" component="div" sx={{ color: "text.secondary" }}>
          {t("systemHealth.metrics.containerMemoryScope")}
        </Typography>
        {metric.limit_state === "unlimited" && (
          <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
            {t("systemHealth.metrics.noMemoryLimit")}
            {containerMemoryPercent !== null ? ` ${t("systemHealth.metrics.hostMemoryPercent")}` : ""}
          </Typography>
        )}
        {metric.cache_bytes !== null && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {t("systemHealth.metrics.fileCache", { cache: formatFileSize(metric.cache_bytes) })}
          </Typography>
        )}
        {metric.limit_state === "finite" && metric.limit_bytes !== null && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {t("systemHealth.metrics.memoryLimit", { limit: formatFileSize(metric.limit_bytes) })}
          </Typography>
        )}
        {metric.limit_state === "finite" && metric.warning_tenths_percent !== null && metric.error_tenths_percent !== null && (
          <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5 }}>
            {t("systemHealth.metrics.thresholdsHigh", {
              warning: formatTenthsPercent(metric.warning_tenths_percent),
              error: formatTenthsPercent(metric.error_tenths_percent),
            })}
          </Typography>
        )}
        {renderSource(metric)}
      </Box>
    );
  };

  const renderStorageItem = (item: StorageMetric) => {
    return (
      <Box key={item.id} sx={{ py: 1 }}>
        {item.total_bytes !== null && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {t("systemHealth.metrics.storageCapacity", { total: formatFileSize(item.total_bytes) })}
          </Typography>
        )}
        <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.5, overflowWrap: "anywhere" }}>
          {t("systemHealth.metrics.thresholdsLow", {
            warning: formatTenthsPercent(item.warning_tenths_percent),
            error: formatTenthsPercent(item.error_tenths_percent),
          })}
        </Typography>
        {renderSource(item, item.kind === "local_drive")}
        {item.actual_free_bytes !== undefined &&
          item.actual_free_bytes !== null &&
          item.available_bytes !== null &&
          item.actual_free_bytes > item.available_bytes && (
            <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.25 }}>
              {t("systemHealth.metrics.actualFreeNote", { actual: formatFileSize(item.actual_free_bytes) })}
            </Typography>
          )}
      </Box>
    );
  };

  const overviewStatus = (metric: OverviewMetric, local = false) => {
    const stale = metric.is_stale || metric.availability === "stale" || (!local && health.backendUnavailable);
    const severity = stale ? "unknown" : metric.severity;
    const current = !stale && metric.availability === "available";
    const label = stale
      ? t("systemHealth.overview.oldData")
      : metric.availability === "collecting"
        ? t("systemHealth.overview.checking")
        : !current
          ? t("systemHealth.statuses.notAvailable")
          : t(`systemHealth.statuses.${severity}`);
    return { severity, current, label } as const;
  };

  const renderOverviewItem = (
    id: string,
    title: string,
    metric: OverviewMetric,
    value: string | null,
    details: ReactNode,
    { local = false, note, type }: { local?: boolean; note?: string; type?: string } = {}
  ) => {
    const state = overviewStatus(metric, local);
    const showStatus = !state.current || (state.severity !== "ok" && state.severity !== "informational") || !value;
    const rowId = `${detailsId}-${encodeURIComponent(id)}`;
    return (
      <Accordion
        disableGutters
        elevation={0}
        sx={{ bgcolor: "transparent", "&::before": { display: "none" } }}
        slotProps={{ transition: { unmountOnExit: true } }}
      >
        <AccordionSummary
          expandIcon={<ExpandMoreIcon />}
          id={`${rowId}-summary`}
          aria-controls={`${rowId}-content`}
          sx={{ ...formAccordionSummarySx, "& .MuiAccordionSummary-content": { my: 0.75, minWidth: 0 } }}
        >
          <Box component="span" sx={{ width: "100%", minWidth: 0 }}>
            <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <HealthStatusIcon
                status={state.severity}
                titleAccess={showStatus ? undefined : state.label}
                fontSize="small"
                sx={{ color: getSeverityColor(state.severity), flexShrink: 0 }}
              />
              <Box component="span" sx={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                <Typography component="span" variant="body2" sx={{ display: "block", fontWeight: 600 }}>
                  {title}
                </Typography>
                {type && (
                  <Typography component="span" variant="caption" sx={{ display: "block", color: "text.secondary" }}>
                    {type}
                  </Typography>
                )}
                {note && (
                  <Typography variant="caption" component="span" sx={{ display: "block", mt: 0.25, color: "text.secondary" }}>
                    {note}
                  </Typography>
                )}
              </Box>
              <Box component="span" sx={{ textAlign: "right", flexShrink: 0, maxWidth: "55%", pr: 1, overflowWrap: "anywhere" }}>
                {state.current && value && (
                  <Typography
                    component="span"
                    variant="body2"
                    sx={{ display: "block", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
                  >
                    {value}
                  </Typography>
                )}
                {showStatus && (
                  <Typography variant="caption" component="span" sx={{ display: "block", color: getSeverityColor(state.severity) }}>
                    {state.label}
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 3.5, pt: 0, pb: 1, overflowWrap: "anywhere" }}>{details}</AccordionDetails>
      </Accordion>
    );
  };

  const percentUsed = (percent: number | null) =>
    percent === null
      ? null
      : t("systemHealth.overview.percentUsed", { percent: formatLocalizedNumber(percent, { maximumFractionDigits: 1 }) });

  const snapshot = health.snapshot;

  const getContainerMemoryPercent = (): number | null => {
    if (!snapshot) return null;
    const { container_memory: container, host_memory: host } = snapshot;
    if (container.limit_state !== "unlimited") return container.used_percent;
    if (
      container.used_bytes === null ||
      !overviewStatus(host).current ||
      host.total_bytes === null ||
      !Number.isFinite(host.total_bytes) ||
      host.total_bytes <= 0
    ) {
      return null;
    }
    return (container.used_bytes / host.total_bytes) * PERCENT_SCALE;
  };
  const containerMemoryPercent = getContainerMemoryPercent();

  const storageLabel = (item: StorageMetric): string => {
    switch (item.kind) {
      case "application_data":
        return t("systemHealth.overview.containerApplicationData");
      case "application_temp":
        return t("systemHealth.overview.containerTemporaryStorage");
      case "application_combined":
        return t("systemHealth.overview.containerCombinedStorage");
      default:
        return item.label;
    }
  };

  const renderStorageRows = (items: StorageMetric[]) =>
    [...items]
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .map((item, index) => {
        const state = overviewStatus(item, item.kind === "local_drive");
        const note =
          state.current && (state.severity === "error" || state.severity === "warning")
            ? t("systemHealth.metrics.localDriveAction")
            : item.kind === "local_drive" && !state.current
              ? health.companionUpdateRequired
                ? t("systemHealth.metrics.updateCompanion")
                : t("systemHealth.overview.localDriveHelp")
              : undefined;
        return (
          <Box key={item.id}>
            {index > 0 && <Divider />}
            {renderOverviewItem(
              item.id,
              storageLabel(item),
              item,
              item.available_bytes === null || item.available_percent === null
                ? null
                : t("systemHealth.overview.spaceFree", {
                    available: formatFileSize(item.available_bytes),
                    percent: formatLocalizedNumber(item.available_percent, { maximumFractionDigits: 1 }),
                  }),
              renderStorageItem(item),
              {
                local: item.kind === "local_drive",
                note,
                type:
                  item.kind === "local_drive" && !item.is_placeholder
                    ? t("systemHealth.overview.localDrive")
                    : item.kind === "smb"
                      ? t("systemHealth.overview.smb")
                      : undefined,
              }
            )}
          </Box>
        );
      });

  const connectionStorage = [...(snapshot?.smb_storage ?? []), ...health.localDrives];

  return (
    <ResponsiveDialogShell
      open={open}
      onClose={onClose}
      restoreFocusEl={restoreFocusEl}
      maxWidth="sm"
      title={t("systemHealth.dialogTitle")}
      actions={
        <Button variant="contained" onClick={onClose}>
          {t("common.actions.close")}
        </Button>
      }
    >
      <Stack spacing={1.5}>
        <FormSurface testId="system-health-summary-surface">
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <HealthStatusIcon status={health.severity} sx={{ color: getSeverityColor(health.severity), flexShrink: 0 }} />
            <Box sx={{ minWidth: 0 }}>
              <Box role="status">
                <Typography variant="subtitle1" sx={{ fontWeight: 700, color: getSeverityColor(health.severity) }}>
                  {t(`systemHealth.overview.${health.severity}`)}
                </Typography>
                {(health.backendUnavailable ||
                  health.severity === "warning" ||
                  health.severity === "error" ||
                  (health.severity === "ok" && health.incompleteCoverage)) && (
                  <Typography variant="body2" sx={{ mt: 0.5, color: "text.secondary" }}>
                    {health.backendUnavailable
                      ? t("systemHealth.overview.connectionHelp")
                      : health.severity === "warning" || health.severity === "error"
                        ? t("systemHealth.overview.attentionHelp")
                        : t("systemHealth.overview.partialChecks")}
                  </Typography>
                )}
              </Box>
              <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mt: 0.25 }}>
                {t("systemHealth.summary.lastUpdatedLabel")}:{" "}
                {health.lastUpdatedAt ? formatDate(health.lastUpdatedAt) : t("systemHealth.summary.neverUpdated")}
              </Typography>
            </Box>
          </Box>
        </FormSurface>

        {snapshot && (
          <>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {t("systemHealth.overview.server")}
              </Typography>
              <FormSurface testId="system-health-resource-overview" sx={{ py: 0.5 }}>
                {renderOverviewItem(
                  "host-memory",
                  t("systemHealth.overview.hostMemory"),
                  snapshot.host_memory,
                  percentUsed(snapshot.host_memory.used_percent),
                  renderHostMemory(snapshot.host_memory)
                )}
                <Divider />
                {renderOverviewItem(
                  "system-load",
                  t("systemHealth.overview.systemLoad"),
                  snapshot.system_load,
                  snapshot.system_load.normalized_5m === null
                    ? null
                    : formatLocalizedNumber(snapshot.system_load.normalized_5m, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                  renderSystemLoad(snapshot.system_load)
                )}
                <Divider />
                {renderOverviewItem(
                  "cpu-temperature",
                  t("systemHealth.metrics.cpuTemperature"),
                  snapshot.cpu_temperature,
                  snapshot.cpu_temperature.current_millidegrees === null
                    ? null
                    : formatMillidegrees(snapshot.cpu_temperature.current_millidegrees),
                  renderCpuTemperature(snapshot.cpu_temperature)
                )}
              </FormSurface>
            </Box>
            <Box>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {t("systemHealth.overview.container")}
              </Typography>
              <FormSurface testId="system-health-container-overview" sx={{ py: 0.5 }}>
                {renderOverviewItem(
                  "container-memory",
                  t("systemHealth.overview.containerMemory"),
                  snapshot.container_memory,
                  snapshot.container_memory.used_bytes === null
                    ? null
                    : containerMemoryPercent !== null
                      ? t("systemHealth.overview.memoryUsed", {
                          used: formatFileSize(snapshot.container_memory.used_bytes),
                          percent: formatLocalizedNumber(containerMemoryPercent, { maximumFractionDigits: 1 }),
                        })
                      : t("systemHealth.overview.bytesUsed", { used: formatFileSize(snapshot.container_memory.used_bytes) }),
                  renderContainerMemory(snapshot.container_memory)
                )}
                {snapshot.application_storage.length > 0 && <Divider />}
                {renderStorageRows(snapshot.application_storage)}
              </FormSurface>
            </Box>
          </>
        )}

        {connectionStorage.length > 0 && (
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("systemHealth.overview.connectionStorage")}
            </Typography>
            <FormSurface testId="system-health-connection-storage" sx={{ py: 0.5 }}>
              {renderStorageRows(connectionStorage)}
            </FormSurface>
          </Box>
        )}
      </Stack>
    </ResponsiveDialogShell>
  );
}
