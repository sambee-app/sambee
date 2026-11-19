import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import HelpOutlineOutlinedIcon from "@mui/icons-material/HelpOutlineOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportGmailerrorredOutlinedIcon from "@mui/icons-material/ReportGmailerrorredOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { SvgIcon, type SvgIconProps } from "@mui/material";
import { useId } from "react";
import type { AggregateHealthSeverity, HealthSeverity } from "../../types";

interface HealthStatusIconProps extends SvgIconProps {
  status: AggregateHealthSeverity | HealthSeverity;
}

const CIRCLE_BADGE = "M0-4.8a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 1 0 0-9.6";
const EXCLAMATION_MARK = "M0-2.4V.8M0 2.7v.1";
// Center the painted monitor and badge in the round toolbar button without changing their scale.
const MONITOR_VIEW_BOX = "-0.5 -0.5 28 28";

const STATUS_BADGES: Record<HealthSeverity, { shape: string; outline: string; mark: string }> = {
  ok: {
    shape: "circle",
    outline: CIRCLE_BADGE,
    mark: "m-2.5 0 1.6 1.7L2.7-2",
  },
  warning: {
    shape: "triangle",
    outline: "m0-5.3 5.7 10H-5.7Z",
    mark: EXCLAMATION_MARK,
  },
  error: {
    shape: "octagon",
    outline: "M-2.2-5.2h4.4l3 3v4.4l-3 3h-4.4l-3-3v-4.4Z",
    mark: EXCLAMATION_MARK,
  },
  unknown: {
    shape: "question-circle",
    outline: CIRCLE_BADGE,
    mark: "M-1.6-1.7a1.6 1.6 0 0 1 3.2 0c0 1.3-1.6 1-1.6 2.7M0 2.5v.1",
  },
  informational: {
    shape: "info-circle",
    outline: CIRCLE_BADGE,
    mark: "M0-2.5v.1M0-.3v3",
  },
};

export function HealthStatusIcon({ status, ...svgProps }: HealthStatusIconProps) {
  const icons = {
    ok: CheckCircleOutlinedIcon,
    warning: WarningAmberIcon,
    error: ReportGmailerrorredOutlinedIcon,
    unknown: HelpOutlineOutlinedIcon,
    informational: InfoOutlinedIcon,
  };
  const Icon = icons[status];
  return <Icon {...svgProps} data-health-status={status} data-health-shape={STATUS_BADGES[status].shape} />;
}

/** Identifies the toolbar's health action without relying on its status badge alone. */
export function HealthMonitorIcon({ status, ...svgProps }: HealthStatusIconProps) {
  const id = useId();
  const badge = STATUS_BADGES[status];

  return (
    <SvgIcon
      {...svgProps}
      viewBox={MONITOR_VIEW_BOX}
      data-health-status={status}
      data-health-shape={badge.shape}
      data-health-symbol="monitor-pulse"
    >
      <defs>
        <mask id={`${id}-monitor`} maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="28">
          <rect width="28" height="28" fill="white" />
          <circle cx="21" cy="20" r="6.3" fill="black" />
        </mask>
        <mask id={`${id}-badge`} maskUnits="userSpaceOnUse" x="-7" y="-7" width="14" height="14">
          <rect x="-7" y="-7" width="14" height="14" fill="white" />
          <path d={badge.mark} fill="none" stroke="black" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${id}-monitor)`}>
        <rect x="2" y="3" width="19" height="14" rx="2" />
        <path d="M5 10h3l2-4 3 8 2-4h3M11 17v4M7 21h8" />
      </g>
      <g transform="translate(21 20)" mask={`url(#${id}-badge)`} fill="currentColor">
        <path d={badge.outline} />
      </g>
    </SvgIcon>
  );
}
