from __future__ import annotations

import errno
import os
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from app.core.logging import get_logger
from app.models.health_monitoring import (
    HOST_STALE_SECONDS,
    STORAGE_STALE_SECONDS,
    ContainerMemoryLimitState,
    ContainerMemoryMetricRead,
    CpuTemperatureLimitOrigin,
    CpuTemperatureOverrideState,
    CpuTemperatureSourceSettingsRead,
    CpuTemperatureSummaryRead,
    HealthSeverity,
    MemoryMetricRead,
    MetricAvailability,
    PersistedCpuTempOverride,
    StorageMetricRead,
    StorageSpaceSemantics,
    SystemLoadMetricRead,
    format_millidegrees_celsius,
)
from app.services.health_monitoring_settings import resolve_cpu_override_evaluation

logger = get_logger(__name__)

MEMORY_Sustained_SECONDS = 60.0
MEMORY_HYSTERESIS_TENTHS_PERCENT = 50
LOAD_HYSTERESIS_HUNDREDTHS = 10
STORAGE_HYSTERESIS_TENTHS_PERCENT = 20
CPU_TEMP_FALLBACK_HYSTERESIS_MILLIDEGREES = 2000
CPU_DISCOVERY_INTERVAL_SECONDS = 60.0
UNLIMITED_CGROUP_V1_SENTINEL_BYTES = 1 << 60
MIN_PLAUSIBLE_SENSOR_MILLIDEGREES = -273_150
MAX_PLAUSIBLE_SENSOR_MILLIDEGREES = (1 << 53) - 1

DEFAULT_HOST_PROC_MEMINFO = Path("/host/proc/meminfo")
DEFAULT_HOST_PROC_LOADAVG = Path("/host/proc/loadavg")
DEFAULT_HOST_PROC_CPUINFO = Path("/host/proc/cpuinfo")
DEFAULT_HOST_SYS_ROOT = Path("/host/sys")
DEFAULT_CGROUP_ROOT = Path("/sys/fs/cgroup")

_CPUINFO_PROCESSOR_RE = re.compile(r"^processor\s*:\s*(\d+)\s*$")
_TRIP_TYPE_RE = re.compile(r"^trip_point_(\d+)_type$")


def _classify_os_error(error: OSError) -> MetricAvailability:
    if isinstance(error, PermissionError) or error.errno in {errno.EACCES, errno.EPERM}:
        return MetricAvailability.PERMISSION_DENIED
    if isinstance(error, TimeoutError) or error.errno == errno.ETIMEDOUT:
        return MetricAvailability.TIMEOUT
    if error.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EHOSTDOWN, errno.ECONNREFUSED, errno.ENOTCONN}:
        return MetricAvailability.OFFLINE
    return MetricAvailability.UNAVAILABLE


def _is_within_root(candidate: Path, root: Path) -> bool:
    try:
        return candidate.is_relative_to(root)
    except ValueError:
        return False


def _parse_strict_int_text(raw: str) -> int | None:
    stripped = raw.strip()
    if not stripped:
        return None
    if stripped[0] in "+-":
        digits = stripped[1:]
    else:
        digits = stripped
    if not digits.isdigit():
        return None
    try:
        return int(stripped, 10)
    except ValueError:
        return None


@dataclass
class SustainedMemoryEvaluator:
    """Evaluates high-trigger memory thresholds with 60-second sustained entry and 60-second recovery."""

    policy_signature: tuple[int, int] | None = None
    committed_severity: HealthSeverity = HealthSeverity.OK
    has_reading: bool = False
    warning_breach_active: bool = False
    warning_breach_elapsed: float = 0.0
    error_breach_active: bool = False
    error_breach_elapsed: float = 0.0
    warning_clear_active: bool = False
    warning_clear_elapsed: float = 0.0
    error_clear_active: bool = False
    error_clear_elapsed: float = 0.0
    last_fresh_monotonic: float | None = None
    had_missing_or_stale_gap: bool = False

    def reset_for_policy(self, warning_tenths: int, error_tenths: int) -> None:
        self.policy_signature = (warning_tenths, error_tenths)
        self.committed_severity = HealthSeverity.OK
        self.warning_breach_active = False
        self.warning_breach_elapsed = 0.0
        self.error_breach_active = False
        self.error_breach_elapsed = 0.0
        self.warning_clear_active = False
        self.warning_clear_elapsed = 0.0
        self.error_clear_active = False
        self.error_clear_elapsed = 0.0
        self.last_fresh_monotonic = None
        self.had_missing_or_stale_gap = False

    def record_missing(self) -> None:
        """Freeze counters without advancing or resetting on missing/stale data."""
        self.had_missing_or_stale_gap = True

    def evaluate(
        self,
        *,
        used_bytes: int,
        total_bytes: int,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
        stale_seconds: float = HOST_STALE_SECONDS,
    ) -> tuple[HealthSeverity, bool]:
        if self.policy_signature != (warning_tenths, error_tenths):
            self.reset_for_policy(warning_tenths, error_tenths)

        dt = 0.0
        if (
            self.last_fresh_monotonic is not None
            and not self.had_missing_or_stale_gap
            and 0.0 <= (now_monotonic - self.last_fresh_monotonic) <= stale_seconds
        ):
            dt = now_monotonic - self.last_fresh_monotonic

        self.last_fresh_monotonic = now_monotonic
        self.had_missing_or_stale_gap = False
        self.has_reading = True

        lhs = 1000 * used_bytes
        is_error = lhs >= error_tenths * total_bytes
        is_warning_or_error = is_error or (lhs >= warning_tenths * total_bytes)

        clear_w_tenths = max(0, warning_tenths - MEMORY_HYSTERESIS_TENTHS_PERCENT)
        clear_e_tenths = max(warning_tenths, error_tenths - MEMORY_HYSTERESIS_TENTHS_PERCENT)
        clear_w_met = lhs <= clear_w_tenths * total_bytes
        clear_e_met = lhs < clear_e_tenths * total_bytes

        if is_error:
            if self.error_breach_active:
                self.error_breach_elapsed += dt
            else:
                self.error_breach_active = True
                self.error_breach_elapsed = 0.0
        else:
            self.error_breach_active = False
            self.error_breach_elapsed = 0.0

        if is_warning_or_error:
            if self.warning_breach_active:
                self.warning_breach_elapsed += dt
            else:
                self.warning_breach_active = True
                self.warning_breach_elapsed = 0.0
        else:
            self.warning_breach_active = False
            self.warning_breach_elapsed = 0.0

        if self.committed_severity == HealthSeverity.OK:
            self.warning_clear_active = False
            self.warning_clear_elapsed = 0.0
            self.error_clear_active = False
            self.error_clear_elapsed = 0.0
            if self.error_breach_active and self.error_breach_elapsed >= MEMORY_Sustained_SECONDS:
                self.committed_severity = HealthSeverity.ERROR
            elif self.warning_breach_active and self.warning_breach_elapsed >= MEMORY_Sustained_SECONDS:
                self.committed_severity = HealthSeverity.WARNING
        elif self.committed_severity == HealthSeverity.WARNING:
            self.error_clear_active = False
            self.error_clear_elapsed = 0.0
            if self.error_breach_active and self.error_breach_elapsed >= MEMORY_Sustained_SECONDS:
                self.committed_severity = HealthSeverity.ERROR
                self.warning_clear_active = False
                self.warning_clear_elapsed = 0.0
            elif clear_w_met:
                if self.warning_clear_active:
                    self.warning_clear_elapsed += dt
                else:
                    self.warning_clear_active = True
                    self.warning_clear_elapsed = 0.0
                if self.warning_clear_elapsed >= MEMORY_Sustained_SECONDS:
                    self.committed_severity = HealthSeverity.OK
                    self.warning_clear_active = False
                    self.warning_clear_elapsed = 0.0
            else:
                self.warning_clear_active = False
                self.warning_clear_elapsed = 0.0
        elif self.committed_severity == HealthSeverity.ERROR:
            if is_error:
                self.error_clear_active = False
                self.error_clear_elapsed = 0.0
                self.warning_clear_active = False
                self.warning_clear_elapsed = 0.0
            else:
                if clear_e_met:
                    if self.error_clear_active:
                        self.error_clear_elapsed += dt
                    else:
                        self.error_clear_active = True
                        self.error_clear_elapsed = 0.0
                else:
                    self.error_clear_active = False
                    self.error_clear_elapsed = 0.0

                if clear_w_met:
                    if self.warning_clear_active:
                        self.warning_clear_elapsed += dt
                    else:
                        self.warning_clear_active = True
                        self.warning_clear_elapsed = 0.0
                else:
                    self.warning_clear_active = False
                    self.warning_clear_elapsed = 0.0

                if (
                    self.error_clear_active
                    and self.error_clear_elapsed >= MEMORY_Sustained_SECONDS
                    and self.warning_clear_active
                    and self.warning_clear_elapsed >= MEMORY_Sustained_SECONDS
                ):
                    self.committed_severity = HealthSeverity.OK
                    self.error_clear_active = False
                    self.error_clear_elapsed = 0.0
                    self.warning_clear_active = False
                    self.warning_clear_elapsed = 0.0
                elif self.error_clear_active and self.error_clear_elapsed >= MEMORY_Sustained_SECONDS:
                    self.committed_severity = HealthSeverity.WARNING
                    self.error_clear_active = False
                    self.error_clear_elapsed = 0.0

        recovery_pending = (self.committed_severity == HealthSeverity.WARNING and self.warning_clear_active) or (
            self.committed_severity == HealthSeverity.ERROR and self.error_clear_active
        )
        return self.committed_severity, recovery_pending


@dataclass
class SampleCountEvaluator:
    """Evaluates sample-counted entry and recovery transitions with explicit hysteresis boundaries."""

    policy_signature: tuple[object, ...] | None = None
    committed_severity: HealthSeverity = HealthSeverity.OK
    warning_entry_streak: int = 0
    error_entry_streak: int = 0
    warning_clear_streak: int = 0
    error_clear_streak: int = 0

    def reset_for_policy(self, signature: tuple[object, ...]) -> None:
        self.policy_signature = signature
        self.committed_severity = HealthSeverity.OK
        self.warning_entry_streak = 0
        self.error_entry_streak = 0
        self.warning_clear_streak = 0
        self.error_clear_streak = 0

    def evaluate(
        self,
        *,
        signature: tuple[object, ...],
        has_warning_threshold: bool,
        has_error_threshold: bool,
        is_warning: bool,
        is_error: bool,
        clear_warning_met: bool,
        clear_error_met: bool,
        warning_entry_samples: int = 1,
        error_entry_samples: int = 1,
        recovery_samples: int = 2,
    ) -> tuple[HealthSeverity, bool]:
        if self.policy_signature != signature:
            self.reset_for_policy(signature)

        if not has_warning_threshold and not has_error_threshold:
            return HealthSeverity.INFORMATIONAL, False

        self.error_entry_streak = (self.error_entry_streak + 1) if (has_error_threshold and is_error) else 0
        self.warning_entry_streak = (self.warning_entry_streak + 1) if (has_warning_threshold and (is_warning or is_error)) else 0

        if self.committed_severity in {HealthSeverity.OK, HealthSeverity.INFORMATIONAL}:
            self.warning_clear_streak = 0
            self.error_clear_streak = 0
            if has_error_threshold and self.error_entry_streak >= error_entry_samples:
                self.committed_severity = HealthSeverity.ERROR
            elif has_warning_threshold and self.warning_entry_streak >= warning_entry_samples:
                self.committed_severity = HealthSeverity.WARNING
            else:
                self.committed_severity = HealthSeverity.OK
        elif self.committed_severity == HealthSeverity.WARNING:
            self.error_clear_streak = 0
            if has_error_threshold and self.error_entry_streak >= error_entry_samples:
                self.committed_severity = HealthSeverity.ERROR
                self.warning_clear_streak = 0
            elif not has_warning_threshold:
                self.committed_severity = HealthSeverity.OK
                self.warning_clear_streak = 0
            elif clear_warning_met:
                self.warning_clear_streak += 1
                if self.warning_clear_streak >= recovery_samples:
                    self.committed_severity = HealthSeverity.OK
                    self.warning_clear_streak = 0
            else:
                self.warning_clear_streak = 0
        elif self.committed_severity == HealthSeverity.ERROR:
            if not has_error_threshold:
                self.committed_severity = HealthSeverity.WARNING if (has_warning_threshold and is_warning) else HealthSeverity.OK
                self.error_clear_streak = 0
                self.warning_clear_streak = 0
            elif is_error:
                self.error_clear_streak = 0
                self.warning_clear_streak = 0
            else:
                self.error_clear_streak = (self.error_clear_streak + 1) if clear_error_met else 0
                self.warning_clear_streak = (self.warning_clear_streak + 1) if (not has_warning_threshold or clear_warning_met) else 0
                if self.error_clear_streak >= recovery_samples and self.warning_clear_streak >= recovery_samples:
                    self.committed_severity = HealthSeverity.OK
                    self.error_clear_streak = 0
                    self.warning_clear_streak = 0
                elif self.error_clear_streak >= recovery_samples:
                    self.committed_severity = HealthSeverity.WARNING if has_warning_threshold else HealthSeverity.OK
                    self.error_clear_streak = 0

        recovery_pending = (self.committed_severity == HealthSeverity.WARNING and self.warning_clear_streak > 0) or (
            self.committed_severity == HealthSeverity.ERROR and self.error_clear_streak > 0
        )
        return self.committed_severity, recovery_pending


@dataclass
class HostMemorySample:
    used_bytes: int
    available_bytes: int
    total_bytes: int
    sampled_at: datetime
    sampled_monotonic: float


class HostMemoryCollector:
    """Collects host memory from /host/proc/meminfo using MemAvailable."""

    def __init__(self, meminfo_path: Path = DEFAULT_HOST_PROC_MEMINFO) -> None:
        self._path = meminfo_path
        self._ever_observed = False
        self._last_sample: HostMemorySample | None = None
        self._last_severity: HealthSeverity = HealthSeverity.UNKNOWN
        self._last_recovery_pending: bool = False
        self._failure_availability: MetricAvailability | None = None
        self._failure_message: str | None = None
        self._evaluator = SustainedMemoryEvaluator()

    @property
    def ever_observed(self) -> bool:
        return self._ever_observed

    def clear(self) -> None:
        self._ever_observed = False
        self._last_sample = None
        self._last_severity = HealthSeverity.UNKNOWN
        self._last_recovery_pending = False
        self._failure_availability = None
        self._failure_message = None
        self._evaluator = SustainedMemoryEvaluator()

    def reevaluate_policy(self, *, warning_tenths: int, error_tenths: int, now_monotonic: float) -> None:
        self._evaluator.reset_for_policy(warning_tenths, error_tenths)
        if (
            self._last_sample is not None
            and self._failure_availability is None
            and (now_monotonic - self._last_sample.sampled_monotonic) <= HOST_STALE_SECONDS
        ):
            self._last_severity, self._last_recovery_pending = self._evaluator.evaluate(
                used_bytes=self._last_sample.used_bytes,
                total_bytes=self._last_sample.total_bytes,
                warning_tenths=warning_tenths,
                error_tenths=error_tenths,
                now_monotonic=now_monotonic,
            )

    def sample(
        self,
        *,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
        now_utc: datetime,
    ) -> None:
        if not self._path.exists():
            self._evaluator.record_missing()
            if not self._ever_observed:
                self._failure_availability = MetricAvailability.NOT_MOUNTED
                self._failure_message = "Optional host mount /host/proc/meminfo is not configured."
            else:
                self._failure_availability = MetricAvailability.UNAVAILABLE
                self._failure_message = "Host memory mount /host/proc/meminfo is no longer reachable."
            return

        self._ever_observed = True
        try:
            content = self._path.read_text(encoding="utf-8")
        except OSError as exc:
            self._evaluator.record_missing()
            self._failure_availability = _classify_os_error(exc)
            self._failure_message = "Host memory information could not be read. Check read permission for /host/proc/meminfo."
            return

        mem_total_kib: int | None = None
        mem_available_kib: int | None = None
        for line in content.splitlines():
            if line.startswith("MemTotal:"):
                parts = line.split()
                if len(parts) >= 2:
                    mem_total_kib = _parse_strict_int_text(parts[1])
            elif line.startswith("MemAvailable:"):
                parts = line.split()
                if len(parts) >= 2:
                    mem_available_kib = _parse_strict_int_text(parts[1])

        if mem_total_kib is None or mem_total_kib <= 0 or mem_available_kib is None or mem_available_kib < 0:
            self._evaluator.record_missing()
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Host /proc/meminfo did not provide valid MemTotal and MemAvailable values."
            return

        total_bytes = mem_total_kib * 1024
        available_bytes = min(total_bytes, mem_available_kib * 1024)
        used_bytes = total_bytes - available_bytes

        self._last_sample = HostMemorySample(
            used_bytes=used_bytes,
            available_bytes=available_bytes,
            total_bytes=total_bytes,
            sampled_at=now_utc,
            sampled_monotonic=now_monotonic,
        )
        self._failure_availability = None
        self._failure_message = None
        self._last_severity, self._last_recovery_pending = self._evaluator.evaluate(
            used_bytes=used_bytes,
            total_bytes=total_bytes,
            warning_tenths=warning_tenths,
            error_tenths=error_tenths,
            now_monotonic=now_monotonic,
        )

    def read(
        self,
        *,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
    ) -> tuple[MemoryMetricRead, bool]:
        """Return the host memory metric read and whether this metric is required in aggregate assessment."""

        source = str(self._path)
        sample = self._last_sample
        age = max(0.0, now_monotonic - sample.sampled_monotonic) if sample is not None else None
        is_stale = age is not None and age > HOST_STALE_SECONDS
        if is_stale:
            self._evaluator.record_missing()

        if sample is None:
            availability = self._failure_availability or MetricAvailability.COLLECTING
            required = availability != MetricAvailability.NOT_MOUNTED
            action = (
                "Mount /proc/meminfo to /host/proc/meminfo:ro on Linux hosts to enable host memory monitoring."
                if availability == MetricAvailability.NOT_MOUNTED
                else (
                    "Check the /host/proc/meminfo read-only mount and file permissions."
                    if availability != MetricAvailability.COLLECTING
                    else None
                )
            )
            return (
                MemoryMetricRead(
                    severity=HealthSeverity.UNKNOWN if required else HealthSeverity.INFORMATIONAL,
                    availability=availability,
                    source=source,
                    warning_tenths_percent=warning_tenths,
                    error_tenths_percent=error_tenths,
                    message=self._failure_message or "Waiting for initial host memory sample.",
                    action=action,
                ),
                required,
            )

        used_tenths = (1000 * sample.used_bytes) // sample.total_bytes
        used_percent = round((100.0 * sample.used_bytes) / sample.total_bytes, 1)

        if self._failure_availability is not None or is_stale:
            availability = self._failure_availability or MetricAvailability.STALE
            msg = self._failure_message or "Last host memory sample is older than 15 seconds."
            return (
                MemoryMetricRead(
                    severity=HealthSeverity.UNKNOWN,
                    availability=availability,
                    source=source,
                    used_bytes=sample.used_bytes,
                    available_bytes=sample.available_bytes,
                    total_bytes=sample.total_bytes,
                    used_tenths_percent=used_tenths,
                    used_percent=used_percent,
                    warning_tenths_percent=warning_tenths,
                    error_tenths_percent=error_tenths,
                    recovery_pending=False,
                    sampled_at=sample.sampled_at,
                    age_seconds=round(age or 0.0, 1),
                    is_stale=True,
                    message=f"{msg} Last severity: {self._last_severity.value}.",
                    action="Verify backend host health and check the /host/proc/meminfo mount.",
                ),
                True,
            )

        active_action: str | None = None
        if self._last_severity in {HealthSeverity.WARNING, HealthSeverity.ERROR}:
            active_action = "Reduce host memory demand or add available host RAM."

        message = (
            "Recovery in progress; waiting for memory usage to remain below the recovery threshold for 60 seconds."
            if self._last_recovery_pending
            else None
        )
        return (
            MemoryMetricRead(
                severity=self._last_severity,
                availability=MetricAvailability.AVAILABLE,
                source=source,
                used_bytes=sample.used_bytes,
                available_bytes=sample.available_bytes,
                total_bytes=sample.total_bytes,
                used_tenths_percent=used_tenths,
                used_percent=used_percent,
                warning_tenths_percent=warning_tenths,
                error_tenths_percent=error_tenths,
                recovery_pending=self._last_recovery_pending,
                sampled_at=sample.sampled_at,
                age_seconds=round(age or 0.0, 1),
                is_stale=False,
                message=message,
                action=active_action,
            ),
            True,
        )


@dataclass
class SystemLoadSample:
    raw_load5: Decimal
    logical_cpu_count: int
    normalized_1m: float
    normalized_5m: float
    normalized_15m: float
    sampled_at: datetime
    sampled_monotonic: float


class SystemLoadCollector:
    """Collects normalized 1-, 5-, and 15-minute Linux load using host logical CPU count."""

    def __init__(
        self,
        loadavg_path: Path = DEFAULT_HOST_PROC_LOADAVG,
        cpuinfo_path: Path = DEFAULT_HOST_PROC_CPUINFO,
    ) -> None:
        self._loadavg_path = loadavg_path
        self._cpuinfo_path = cpuinfo_path
        self._ever_observed = False
        self._last_sample: SystemLoadSample | None = None
        self._last_severity: HealthSeverity = HealthSeverity.UNKNOWN
        self._last_recovery_pending: bool = False
        self._failure_availability: MetricAvailability | None = None
        self._failure_message: str | None = None
        self._evaluator = SampleCountEvaluator()

    def clear(self) -> None:
        self._ever_observed = False
        self._last_sample = None
        self._last_severity = HealthSeverity.UNKNOWN
        self._last_recovery_pending = False
        self._failure_availability = None
        self._failure_message = None
        self._evaluator = SampleCountEvaluator()

    def _evaluate_sample(self, sample: SystemLoadSample, warning_hundredths: int, error_hundredths: int) -> tuple[HealthSeverity, bool]:
        lhs = sample.raw_load5 * Decimal(100)
        cpu = Decimal(sample.logical_cpu_count)
        is_error = lhs >= Decimal(error_hundredths) * cpu
        is_warning = (not is_error) and (lhs >= Decimal(warning_hundredths) * cpu)
        clear_w = max(0, warning_hundredths - LOAD_HYSTERESIS_HUNDREDTHS)
        clear_e = max(warning_hundredths, error_hundredths - LOAD_HYSTERESIS_HUNDREDTHS)
        clear_w_met = lhs <= Decimal(clear_w) * cpu
        clear_e_met = lhs < Decimal(clear_e) * cpu
        return self._evaluator.evaluate(
            signature=(warning_hundredths, error_hundredths),
            has_warning_threshold=True,
            has_error_threshold=True,
            is_warning=is_warning,
            is_error=is_error,
            clear_warning_met=clear_w_met,
            clear_error_met=clear_e_met,
            warning_entry_samples=1,
            error_entry_samples=1,
            recovery_samples=2,
        )

    def reevaluate_policy(self, *, warning_hundredths: int, error_hundredths: int, now_monotonic: float) -> None:
        self._evaluator.reset_for_policy((warning_hundredths, error_hundredths))
        if (
            self._last_sample is not None
            and self._failure_availability is None
            and (now_monotonic - self._last_sample.sampled_monotonic) <= HOST_STALE_SECONDS
        ):
            self._last_severity, self._last_recovery_pending = self._evaluate_sample(
                self._last_sample,
                warning_hundredths,
                error_hundredths,
            )

    def sample(
        self,
        *,
        warning_hundredths: int,
        error_hundredths: int,
        now_monotonic: float,
        now_utc: datetime,
    ) -> None:
        load_exists = self._loadavg_path.exists()
        cpu_exists = self._cpuinfo_path.exists()

        if not load_exists and not cpu_exists:
            if not self._ever_observed:
                self._failure_availability = MetricAvailability.NOT_MOUNTED
                self._failure_message = "Optional host mounts /host/proc/loadavg and /host/proc/cpuinfo are not configured."
            else:
                self._failure_availability = MetricAvailability.UNAVAILABLE
                self._failure_message = "Host load mounts /host/proc/loadavg and /host/proc/cpuinfo are no longer reachable."
            return

        self._ever_observed = True
        if not load_exists or not cpu_exists:
            missing_file = str(self._cpuinfo_path if not cpu_exists else self._loadavg_path)
            self._failure_availability = MetricAvailability.UNAVAILABLE
            self._failure_message = (
                f"Normalized system load requires both /host/proc/loadavg and /host/proc/cpuinfo ({missing_file} is missing)."
            )
            return

        try:
            load_text = self._loadavg_path.read_text(encoding="utf-8").strip()
            cpu_text = self._cpuinfo_path.read_text(encoding="utf-8")
        except OSError as exc:
            self._failure_availability = _classify_os_error(exc)
            self._failure_message = "Host load or CPU inventory could not be read. Check read permissions on /host/proc."
            return

        cpu_count = sum(1 for line in cpu_text.splitlines() if _CPUINFO_PROCESSOR_RE.match(line))
        if cpu_count <= 0:
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Host logical CPU count could not be determined from /host/proc/cpuinfo."
            return

        tokens = load_text.split()
        if len(tokens) < 3:
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Host /proc/loadavg did not contain 1-, 5-, and 15-minute load averages."
            return

        try:
            load1 = Decimal(tokens[0])
            load5 = Decimal(tokens[1])
            load15 = Decimal(tokens[2])
        except InvalidOperation:
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Host /proc/loadavg contained non-numeric load values."
            return

        if any(not val.is_finite() or val < 0 for val in (load1, load5, load15)):
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Host /proc/loadavg contained invalid load values."
            return

        cpu_dec = Decimal(cpu_count)
        sample = SystemLoadSample(
            raw_load5=load5,
            logical_cpu_count=cpu_count,
            normalized_1m=round(float(load1 / cpu_dec), 2),
            normalized_5m=round(float(load5 / cpu_dec), 2),
            normalized_15m=round(float(load15 / cpu_dec), 2),
            sampled_at=now_utc,
            sampled_monotonic=now_monotonic,
        )
        self._last_sample = sample
        self._failure_availability = None
        self._failure_message = None
        self._last_severity, self._last_recovery_pending = self._evaluate_sample(sample, warning_hundredths, error_hundredths)

    def read(
        self,
        *,
        warning_hundredths: int,
        error_hundredths: int,
        now_monotonic: float,
    ) -> tuple[SystemLoadMetricRead, bool]:
        source = f"{self._loadavg_path}, {self._cpuinfo_path}"
        sample = self._last_sample
        age = max(0.0, now_monotonic - sample.sampled_monotonic) if sample is not None else None
        is_stale = age is not None and age > HOST_STALE_SECONDS

        if sample is None:
            availability = self._failure_availability or MetricAvailability.COLLECTING
            required = availability != MetricAvailability.NOT_MOUNTED
            action = (
                "Mount /proc/loadavg and /proc/cpuinfo read-only under /host/proc to enable normalized load monitoring."
                if availability == MetricAvailability.NOT_MOUNTED
                else (
                    "Check /host/proc/loadavg and /host/proc/cpuinfo mounts and permissions."
                    if availability != MetricAvailability.COLLECTING
                    else None
                )
            )
            return (
                SystemLoadMetricRead(
                    severity=HealthSeverity.UNKNOWN if required else HealthSeverity.INFORMATIONAL,
                    availability=availability,
                    source=source,
                    warning_hundredths=warning_hundredths,
                    error_hundredths=error_hundredths,
                    message=self._failure_message or "Waiting for initial host system-load sample.",
                    action=action,
                ),
                required,
            )

        if self._failure_availability is not None or is_stale:
            availability = self._failure_availability or MetricAvailability.STALE
            msg = self._failure_message or "Last system-load sample is older than 15 seconds."
            return (
                SystemLoadMetricRead(
                    severity=HealthSeverity.UNKNOWN,
                    availability=availability,
                    source=source,
                    logical_cpu_count=sample.logical_cpu_count,
                    normalized_1m=sample.normalized_1m,
                    normalized_5m=sample.normalized_5m,
                    normalized_15m=sample.normalized_15m,
                    warning_hundredths=warning_hundredths,
                    error_hundredths=error_hundredths,
                    recovery_pending=False,
                    sampled_at=sample.sampled_at,
                    age_seconds=round(age or 0.0, 1),
                    is_stale=True,
                    message=f"{msg} Last severity: {self._last_severity.value}.",
                    action="Check both /host/proc/loadavg and /host/proc/cpuinfo read-only mounts.",
                ),
                True,
            )

        action = (
            "Inspect runnable processes or storage I/O wait on the backend host."
            if self._last_severity in {HealthSeverity.WARNING, HealthSeverity.ERROR}
            else None
        )
        message = (
            "Recovery in progress; waiting for a second consecutive sample below the recovery boundary."
            if self._last_recovery_pending
            else None
        )
        return (
            SystemLoadMetricRead(
                severity=self._last_severity,
                availability=MetricAvailability.AVAILABLE,
                source=source,
                logical_cpu_count=sample.logical_cpu_count,
                normalized_1m=sample.normalized_1m,
                normalized_5m=sample.normalized_5m,
                normalized_15m=sample.normalized_15m,
                warning_hundredths=warning_hundredths,
                error_hundredths=error_hundredths,
                recovery_pending=self._last_recovery_pending,
                sampled_at=sample.sampled_at,
                age_seconds=round(age or 0.0, 1),
                is_stale=False,
                message=message,
                action=action,
            ),
            True,
        )


@dataclass
class DiscoveredCpuSensor:
    source_id: str
    kind: Literal["hwmon_coretemp", "hwmon_k10temp", "rpi_cpu_thermal"]
    driver: str
    device_path: str
    channel_label: str
    label: str
    sensor_dir: Path
    source_display: str


@dataclass
class CpuCandidateReading:
    source_id: str
    label: str
    driver: str
    device_path: str
    source_display: str
    current_millidegrees: int | None
    detected_warning_millidegrees: int | None
    detected_error_millidegrees: int | None
    detected_warning_hyst_millidegrees: int | None
    detected_error_hyst_millidegrees: int | None
    detected_limit_origin: CpuTemperatureLimitOrigin
    unusable_attributes: list[str]
    sampled_at: datetime | None
    sampled_monotonic: float | None
    failure_availability: MetricAvailability | None = None
    failure_message: str | None = None


def _failed_cpu_reading(
    sensor: DiscoveredCpuSensor,
    availability: MetricAvailability,
    message: str,
    *,
    unusable_attributes: list[str] | None = None,
) -> CpuCandidateReading:
    """Build a failed sample; the collector retains any previous successful reading separately."""
    return CpuCandidateReading(
        source_id=sensor.source_id,
        label=sensor.label,
        driver=sensor.driver,
        device_path=sensor.device_path,
        source_display=sensor.source_display,
        current_millidegrees=None,
        detected_warning_millidegrees=None,
        detected_error_millidegrees=None,
        detected_warning_hyst_millidegrees=None,
        detected_error_hyst_millidegrees=None,
        detected_limit_origin=(
            CpuTemperatureLimitOrigin.KERNEL_POLICY if sensor.kind == "rpi_cpu_thermal" else CpuTemperatureLimitOrigin.HARDWARE
        ),
        unusable_attributes=unusable_attributes if unusable_attributes is not None else [],
        sampled_at=None,
        sampled_monotonic=None,
        failure_availability=availability,
        failure_message=message,
    )


@dataclass
class CpuCandidateState:
    sensor: DiscoveredCpuSensor
    ever_succeeded: bool = False
    last_reading: CpuCandidateReading | None = None
    evaluator: SampleCountEvaluator = field(default_factory=SampleCountEvaluator)
    last_severity: HealthSeverity = HealthSeverity.UNKNOWN
    last_recovery_pending: bool = False


class CpuTemperatureCollector:
    """Discovers and samples Intel coretemp, AMD k10temp, and Raspberry Pi cpu-thermal sources."""

    def __init__(self, sys_root: Path = DEFAULT_HOST_SYS_ROOT) -> None:
        self._sys_root = sys_root
        self._ever_mounted = False
        self._last_discovery_monotonic: float | None = None
        self._discovery_problem: tuple[MetricAvailability, str] | None = None
        self._candidates: dict[str, CpuCandidateState] = {}

    def clear(self) -> None:
        self._ever_mounted = False
        self._last_discovery_monotonic = None
        self._discovery_problem = None
        self._candidates.clear()

    def reset_source_state(self, source_id: str) -> None:
        candidate = self._candidates.get(source_id)
        if candidate is not None:
            candidate.evaluator = SampleCountEvaluator()

    def _read_raspberry_pi_board(self, resolved_root: Path) -> str | None:
        compatible_path = resolved_root / "firmware" / "devicetree" / "base" / "compatible"
        try:
            if not compatible_path.exists():
                return None
            resolved_compat = compatible_path.resolve()
            if not _is_within_root(resolved_compat, resolved_root):
                return None
            raw = resolved_compat.read_bytes()
        except OSError:
            return None

        for part in raw.split(b"\x00"):
            if not part:
                continue
            token = part.decode("utf-8", errors="ignore").strip()
            if token.startswith("raspberrypi,"):
                return token
        return None

    def _discover_sensors(self, now_monotonic: float) -> None:
        self._last_discovery_monotonic = now_monotonic
        if not self._sys_root.exists():
            if not self._ever_mounted:
                self._discovery_problem = (
                    MetricAvailability.NOT_MOUNTED,
                    "Optional host mount /host/sys is not configured.",
                )
            else:
                self._discovery_problem = (
                    MetricAvailability.UNAVAILABLE,
                    "Host sysfs mount /host/sys is no longer reachable.",
                )
            return

        try:
            resolved_root = self._sys_root.resolve()
        except OSError as exc:
            self._discovery_problem = (_classify_os_error(exc), "Host sysfs root /host/sys could not be resolved.")
            return

        self._ever_mounted = True
        found: dict[str, DiscoveredCpuSensor] = {}
        broken_links_detected = False
        permission_problem = False

        hwmon_class = resolved_root / "class" / "hwmon"
        if hwmon_class.exists():
            try:
                hwmon_entries = sorted(hwmon_class.iterdir(), key=lambda item: item.name)
            except OSError as exc:
                if _classify_os_error(exc) == MetricAvailability.PERMISSION_DENIED:
                    permission_problem = True
                hwmon_entries = []

            k10temp_entries: list[tuple[Path, str, str]] = []
            for entry in hwmon_entries:
                if not entry.name.startswith("hwmon"):
                    continue
                try:
                    resolved_hwmon = entry.resolve()
                except OSError:
                    broken_links_detected = True
                    continue
                if not resolved_hwmon.exists() or not _is_within_root(resolved_hwmon, resolved_root):
                    broken_links_detected = True
                    continue

                try:
                    driver_name = (resolved_hwmon / "name").read_text(encoding="utf-8").strip()
                except OSError as exc:
                    if _classify_os_error(exc) == MetricAvailability.PERMISSION_DENIED:
                        permission_problem = True
                    continue

                if driver_name in {"cpu_thermal", "raspberrypi-hwmon"}:
                    continue
                if driver_name not in {"coretemp", "k10temp"}:
                    continue

                device_link = resolved_hwmon / "device"
                if device_link.exists() or device_link.is_symlink():
                    try:
                        resolved_device = device_link.resolve()
                    except OSError:
                        broken_links_detected = True
                        continue
                    if not resolved_device.exists() or not _is_within_root(resolved_device, resolved_root):
                        broken_links_detected = True
                        continue
                    device_rel = resolved_device.relative_to(resolved_root).as_posix()
                else:
                    device_rel = resolved_hwmon.relative_to(resolved_root).as_posix()

                if driver_name == "coretemp":
                    label_path = resolved_hwmon / "temp1_label"
                    input_path = resolved_hwmon / "temp1_input"
                    if not label_path.exists() or not input_path.exists():
                        continue
                    try:
                        channel_label = label_path.read_text(encoding="utf-8").strip()
                    except OSError:
                        continue
                    if not channel_label.startswith("Package id "):
                        continue
                    source_id = f"coretemp:{device_rel}:{channel_label}"
                    found[source_id] = DiscoveredCpuSensor(
                        source_id=source_id,
                        kind="hwmon_coretemp",
                        driver="coretemp",
                        device_path=device_rel,
                        channel_label=channel_label,
                        label=f"CPU package ({channel_label})",
                        sensor_dir=resolved_hwmon,
                        source_display=f"{self._sys_root}/{device_rel} (coretemp {channel_label})",
                    )
                elif driver_name == "k10temp":
                    input_path = resolved_hwmon / "temp1_input"
                    if not input_path.exists():
                        continue
                    label_path = resolved_hwmon / "temp1_label"
                    channel_label = "Tctl"
                    if label_path.exists():
                        try:
                            raw_label = label_path.read_text(encoding="utf-8").strip()
                        except OSError:
                            continue
                        if raw_label and raw_label != "Tctl":
                            continue
                    k10temp_entries.append((resolved_hwmon, device_rel, channel_label))

            multi_k10 = len(k10temp_entries) > 1
            for resolved_hwmon, device_rel, channel_label in k10temp_entries:
                source_id = f"k10temp:{device_rel}:{channel_label}"
                device_leaf = Path(device_rel).name
                label = f"CPU control temperature (Tctl, {device_leaf})" if multi_k10 else "CPU control temperature (Tctl)"
                found[source_id] = DiscoveredCpuSensor(
                    source_id=source_id,
                    kind="hwmon_k10temp",
                    driver="k10temp",
                    device_path=device_rel,
                    channel_label=channel_label,
                    label=label,
                    sensor_dir=resolved_hwmon,
                    source_display=f"{self._sys_root}/{device_rel} (k10temp Tctl)",
                )

        rpi_board = self._read_raspberry_pi_board(resolved_root)
        if rpi_board is not None:
            thermal_class = resolved_root / "class" / "thermal"
            if thermal_class.exists():
                try:
                    zone_entries = sorted(thermal_class.iterdir(), key=lambda item: item.name)
                except OSError as exc:
                    if _classify_os_error(exc) == MetricAvailability.PERMISSION_DENIED:
                        permission_problem = True
                    zone_entries = []

                matching_zones: list[tuple[Path, str]] = []
                for zone_entry in zone_entries:
                    if not zone_entry.name.startswith("thermal_zone"):
                        continue
                    try:
                        resolved_zone = zone_entry.resolve()
                    except OSError:
                        broken_links_detected = True
                        continue
                    if not resolved_zone.exists() or not _is_within_root(resolved_zone, resolved_root):
                        broken_links_detected = True
                        continue
                    try:
                        zone_type = (resolved_zone / "type").read_text(encoding="utf-8").strip()
                    except OSError:
                        continue
                    if zone_type != "cpu-thermal":
                        continue

                    device_link = resolved_zone / "device"
                    device_suffix = rpi_board
                    if device_link.exists() or device_link.is_symlink():
                        try:
                            resolved_dev = device_link.resolve()
                            if resolved_dev.exists() and _is_within_root(resolved_dev, resolved_root):
                                device_suffix = f"{rpi_board}/{resolved_dev.relative_to(resolved_root).as_posix()}"
                        except OSError:
                            pass
                    matching_zones.append((resolved_zone, device_suffix))

                for idx, (resolved_zone, device_suffix) in enumerate(matching_zones):
                    stable_device = rpi_board if len(matching_zones) == 1 else device_suffix
                    source_id = f"raspberrypi-cpu-thermal:{stable_device}:cpu-thermal"
                    label = (
                        "Raspberry Pi CPU thermal zone (cpu-thermal)"
                        if len(matching_zones) == 1
                        else f"Raspberry Pi CPU thermal zone {idx + 1} (cpu-thermal)"
                    )
                    found[source_id] = DiscoveredCpuSensor(
                        source_id=source_id,
                        kind="rpi_cpu_thermal",
                        driver="raspberrypi-cpu-thermal",
                        device_path=stable_device,
                        channel_label="cpu-thermal",
                        label=label,
                        sensor_dir=resolved_zone,
                        source_display=f"{self._sys_root}/class/thermal ({rpi_board} cpu-thermal)",
                    )

        for source_id, sensor in found.items():
            existing = self._candidates.get(source_id)
            if existing is None:
                self._candidates[source_id] = CpuCandidateState(sensor=sensor)
            else:
                existing.sensor = sensor

        for source_id, existing in list(self._candidates.items()):
            if source_id not in found and not existing.ever_succeeded:
                self._candidates.pop(source_id, None)

        if found:
            self._discovery_problem = None
        elif permission_problem:
            self._discovery_problem = (
                MetricAvailability.PERMISSION_DENIED,
                "Permission denied while inspecting /host/sys thermal interfaces.",
            )
        elif broken_links_detected:
            self._discovery_problem = (
                MetricAvailability.UNAVAILABLE,
                "Sensor device symlinks under /host/sys could not be resolved. Mount the full /sys:/host/sys:ro tree.",
            )
        else:
            self._discovery_problem = (
                MetricAvailability.UNSUPPORTED,
                "No supported CPU package or Raspberry Pi CPU thermal sensor is exposed under /host/sys.",
            )

    def _read_hwmon_candidate(
        self,
        sensor: DiscoveredCpuSensor,
        *,
        now_utc: datetime,
        now_monotonic: float,
    ) -> CpuCandidateReading:
        sensor_dir = sensor.sensor_dir
        unusable: list[str] = []

        enable_path = sensor_dir / "temp1_enable"
        if enable_path.exists():
            try:
                enabled_val = _parse_strict_int_text(enable_path.read_text(encoding="utf-8"))
            except OSError as exc:
                return _failed_cpu_reading(sensor, _classify_os_error(exc), "CPU temperature enable attribute could not be read.")
            if enabled_val == 0:
                return _failed_cpu_reading(
                    sensor,
                    MetricAvailability.UNAVAILABLE,
                    "CPU temperature channel is disabled by the kernel driver.",
                    unusable_attributes=["temp1_enable"],
                )
            if enabled_val != 1:
                return _failed_cpu_reading(
                    sensor,
                    MetricAvailability.INVALID,
                    "CPU temperature enable attribute reported an invalid value.",
                    unusable_attributes=["temp1_enable"],
                )

        fault_path = sensor_dir / "temp1_fault"
        if fault_path.exists():
            try:
                fault_val = _parse_strict_int_text(fault_path.read_text(encoding="utf-8"))
            except OSError as exc:
                return _failed_cpu_reading(sensor, _classify_os_error(exc), "CPU temperature fault attribute could not be read.")
            if fault_val != 0:
                return _failed_cpu_reading(
                    sensor,
                    MetricAvailability.UNAVAILABLE if fault_val == 1 else MetricAvailability.INVALID,
                    "CPU temperature sensor reported a hardware fault.",
                    unusable_attributes=["temp1_fault"],
                )

        input_path = sensor_dir / "temp1_input"
        try:
            raw_input = input_path.read_text(encoding="utf-8")
        except OSError as exc:
            return _failed_cpu_reading(sensor, _classify_os_error(exc), "CPU temperature reading could not be read from sysfs.")

        current_temp = _parse_strict_int_text(raw_input)
        if current_temp is None or not (MIN_PLAUSIBLE_SENSOR_MILLIDEGREES <= current_temp <= MAX_PLAUSIBLE_SENSOR_MILLIDEGREES):
            return _failed_cpu_reading(
                sensor,
                MetricAvailability.INVALID,
                "CPU temperature sensor returned a malformed temperature reading.",
                unusable_attributes=["temp1_input"],
            )

        def _read_optional_positive_limit(attr_name: str) -> int | None:
            attr_path = sensor_dir / attr_name
            if not attr_path.exists():
                return None
            try:
                text = attr_path.read_text(encoding="utf-8")
            except OSError as err:
                if err.errno in {errno.ENOENT, errno.ENODATA, errno.EOPNOTSUPP, errno.EINVAL}:
                    return None
                unusable.append(attr_name)
                return None
            parsed = _parse_strict_int_text(text)
            if parsed is None or parsed <= 0 or parsed > MAX_PLAUSIBLE_SENSOR_MILLIDEGREES:
                unusable.append(attr_name)
                return None
            return parsed

        detected_max = _read_optional_positive_limit("temp1_max")
        detected_crit = _read_optional_positive_limit("temp1_crit")
        if detected_max is not None and detected_crit is not None and detected_max > detected_crit:
            unusable.extend(["temp1_max", "temp1_crit"])
            detected_max = None
            detected_crit = None

        warn_hyst: int | None = None
        if detected_max is not None and (sensor_dir / "temp1_max_hyst").exists():
            raw_warn_hyst = _read_optional_positive_limit("temp1_max_hyst")
            if raw_warn_hyst is not None:
                if raw_warn_hyst < detected_max:
                    warn_hyst = raw_warn_hyst
                else:
                    unusable.append("temp1_max_hyst")

        err_hyst: int | None = None
        if detected_crit is not None and (sensor_dir / "temp1_crit_hyst").exists():
            raw_err_hyst = _read_optional_positive_limit("temp1_crit_hyst")
            if raw_err_hyst is not None:
                if raw_err_hyst < detected_crit:
                    err_hyst = raw_err_hyst
                else:
                    unusable.append("temp1_crit_hyst")

        return CpuCandidateReading(
            source_id=sensor.source_id,
            label=sensor.label,
            driver=sensor.driver,
            device_path=sensor.device_path,
            source_display=sensor.source_display,
            current_millidegrees=current_temp,
            detected_warning_millidegrees=detected_max,
            detected_error_millidegrees=detected_crit,
            detected_warning_hyst_millidegrees=warn_hyst,
            detected_error_hyst_millidegrees=err_hyst,
            detected_limit_origin=CpuTemperatureLimitOrigin.HARDWARE,
            unusable_attributes=unusable,
            sampled_at=now_utc,
            sampled_monotonic=now_monotonic,
        )

    def _read_rpi_thermal_candidate(
        self,
        sensor: DiscoveredCpuSensor,
        *,
        now_utc: datetime,
        now_monotonic: float,
    ) -> CpuCandidateReading:
        zone_dir = sensor.sensor_dir
        unusable: list[str] = []

        try:
            raw_temp = (zone_dir / "temp").read_text(encoding="utf-8")
        except OSError as exc:
            return _failed_cpu_reading(sensor, _classify_os_error(exc), "Raspberry Pi CPU thermal zone temperature could not be read.")

        current_temp = _parse_strict_int_text(raw_temp)
        if current_temp is None or not (MIN_PLAUSIBLE_SENSOR_MILLIDEGREES <= current_temp <= MAX_PLAUSIBLE_SENSOR_MILLIDEGREES):
            return _failed_cpu_reading(
                sensor,
                MetricAvailability.INVALID,
                "Raspberry Pi CPU thermal zone returned a malformed temperature reading.",
                unusable_attributes=["temp"],
            )

        critical_trips: list[tuple[int, int | None]] = []
        warning_trips: list[tuple[int, int | None]] = []

        try:
            entries = sorted(zone_dir.iterdir(), key=lambda item: item.name)
        except OSError:
            entries = []

        for entry in entries:
            match = _TRIP_TYPE_RE.match(entry.name)
            if not match:
                continue
            trip_idx = match.group(1)
            temp_attr = f"trip_point_{trip_idx}_temp"
            hyst_attr = f"trip_point_{trip_idx}_hyst"
            try:
                trip_type = entry.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if trip_type == "active":
                continue
            if trip_type not in {"critical", "hot", "passive"}:
                continue

            try:
                raw_trip_temp = (zone_dir / temp_attr).read_text(encoding="utf-8")
            except OSError:
                unusable.append(temp_attr)
                continue

            trip_temp = _parse_strict_int_text(raw_trip_temp)
            if trip_temp is None or trip_temp <= 0 or trip_temp > MAX_PLAUSIBLE_SENSOR_MILLIDEGREES:
                unusable.append(temp_attr)
                continue

            clear_temp: int | None = None
            hyst_path = zone_dir / hyst_attr
            if hyst_path.exists():
                try:
                    hyst_delta = _parse_strict_int_text(hyst_path.read_text(encoding="utf-8"))
                except OSError:
                    hyst_delta = None
                if hyst_delta is None or hyst_delta < 0:
                    unusable.append(hyst_attr)
                elif 0 < hyst_delta < trip_temp:
                    clear_temp = trip_temp - hyst_delta
                elif hyst_delta >= trip_temp:
                    unusable.append(hyst_attr)

            if trip_type == "critical":
                critical_trips.append((trip_temp, clear_temp))
            else:
                warning_trips.append((trip_temp, clear_temp))

        detected_crit: int | None = None
        err_hyst: int | None = None
        if critical_trips:
            critical_trips.sort(key=lambda item: item[0])
            detected_crit, err_hyst = critical_trips[0]

        eligible_warnings = [item for item in warning_trips if detected_crit is None or item[0] < detected_crit]
        detected_warn: int | None = None
        warn_hyst: int | None = None
        if eligible_warnings:
            eligible_warnings.sort(key=lambda item: item[0])
            detected_warn, warn_hyst = eligible_warnings[0]

        return CpuCandidateReading(
            source_id=sensor.source_id,
            label=sensor.label,
            driver=sensor.driver,
            device_path=sensor.device_path,
            source_display=sensor.source_display,
            current_millidegrees=current_temp,
            detected_warning_millidegrees=detected_warn,
            detected_error_millidegrees=detected_crit,
            detected_warning_hyst_millidegrees=warn_hyst,
            detected_error_hyst_millidegrees=err_hyst,
            detected_limit_origin=CpuTemperatureLimitOrigin.KERNEL_POLICY,
            unusable_attributes=unusable,
            sampled_at=now_utc,
            sampled_monotonic=now_monotonic,
        )

    def _evaluate_candidate(
        self,
        state: CpuCandidateState,
        reading: CpuCandidateReading,
        override: PersistedCpuTempOverride | None,
    ) -> tuple[HealthSeverity, bool]:
        (
            eff_warn,
            eff_warn_origin,
            eff_err,
            eff_err_origin,
            _warn_exceeds,
            _err_exceeds,
            override_state,
            _override_notice,
        ) = resolve_cpu_override_evaluation(
            detected_max=reading.detected_warning_millidegrees,
            detected_crit=reading.detected_error_millidegrees,
            detected_origin=reading.detected_limit_origin,
            override=override,
        )

        if override_state == CpuTemperatureOverrideState.CONFLICT:
            state.evaluator = SampleCountEvaluator()
            return HealthSeverity.UNKNOWN, False

        assert reading.current_millidegrees is not None
        temp = reading.current_millidegrees

        is_error = eff_err is not None and temp >= eff_err
        is_warning = (not is_error) and (eff_warn is not None and temp >= eff_warn)

        use_hw_warn_hyst = (
            eff_warn is not None
            and eff_warn_origin != CpuTemperatureLimitOrigin.ADMIN_OVERRIDE
            and reading.detected_warning_hyst_millidegrees is not None
            and 0 < reading.detected_warning_hyst_millidegrees < eff_warn
        )
        if eff_warn is None:
            clear_w_met = True
            warn_clear_sig: object = None
        elif use_hw_warn_hyst:
            assert reading.detected_warning_hyst_millidegrees is not None
            clear_w_met = temp <= reading.detected_warning_hyst_millidegrees
            warn_clear_sig = ("hw", reading.detected_warning_hyst_millidegrees)
        else:
            clear_w_bound = max(0, eff_warn - CPU_TEMP_FALLBACK_HYSTERESIS_MILLIDEGREES)
            clear_w_met = temp <= clear_w_bound
            warn_clear_sig = ("fallback", clear_w_bound)

        use_hw_err_hyst = (
            eff_err is not None
            and eff_err_origin != CpuTemperatureLimitOrigin.ADMIN_OVERRIDE
            and reading.detected_error_hyst_millidegrees is not None
            and 0 < reading.detected_error_hyst_millidegrees < eff_err
            and (eff_warn is None or reading.detected_error_hyst_millidegrees >= eff_warn)
        )
        if eff_err is None:
            clear_e_met = True
            err_clear_sig: object = None
        elif use_hw_err_hyst:
            assert reading.detected_error_hyst_millidegrees is not None
            clear_e_met = temp <= reading.detected_error_hyst_millidegrees
            err_clear_sig = ("hw", reading.detected_error_hyst_millidegrees)
        else:
            clear_e_bound = (
                max(eff_warn, eff_err - CPU_TEMP_FALLBACK_HYSTERESIS_MILLIDEGREES)
                if eff_warn is not None
                else max(0, eff_err - CPU_TEMP_FALLBACK_HYSTERESIS_MILLIDEGREES)
            )
            clear_e_met = temp < clear_e_bound
            err_clear_sig = ("fallback", clear_e_bound)

        signature = (
            reading.source_id,
            reading.detected_warning_millidegrees,
            reading.detected_error_millidegrees,
            eff_warn,
            eff_warn_origin,
            eff_err,
            eff_err_origin,
            warn_clear_sig,
            err_clear_sig,
        )
        return state.evaluator.evaluate(
            signature=signature,
            has_warning_threshold=eff_warn is not None,
            has_error_threshold=eff_err is not None,
            is_warning=is_warning,
            is_error=is_error,
            clear_warning_met=clear_w_met,
            clear_error_met=clear_e_met,
            warning_entry_samples=2,
            error_entry_samples=1,
            recovery_samples=2,
        )

    def ensure_discovered(self, now_monotonic: float) -> None:
        if self._last_discovery_monotonic is None or (now_monotonic - self._last_discovery_monotonic) >= CPU_DISCOVERY_INTERVAL_SECONDS:
            self._discover_sensors(now_monotonic)

    def reevaluate_overrides(self, overrides: dict[str, PersistedCpuTempOverride], now_monotonic: float) -> None:
        for source_id, state in self._candidates.items():
            reading = state.last_reading
            if (
                reading is not None
                and reading.failure_availability is None
                and reading.current_millidegrees is not None
                and reading.sampled_monotonic is not None
                and (now_monotonic - reading.sampled_monotonic) <= HOST_STALE_SECONDS
            ):
                state.last_severity, state.last_recovery_pending = self._evaluate_candidate(
                    state,
                    reading,
                    overrides.get(source_id),
                )

    def sample(
        self,
        *,
        overrides: dict[str, PersistedCpuTempOverride],
        now_monotonic: float,
        now_utc: datetime,
    ) -> None:
        self.ensure_discovered(now_monotonic)

        needs_rediscovery = any(not state.sensor.sensor_dir.exists() for state in self._candidates.values())
        if needs_rediscovery:
            self._discover_sensors(now_monotonic)

        for source_id, state in self._candidates.items():
            sensor = state.sensor
            if not sensor.sensor_dir.exists():
                failure = _failed_cpu_reading(
                    sensor, MetricAvailability.UNAVAILABLE, "Previously detected CPU temperature sensor is no longer present."
                )
                state.last_reading = (
                    replace(
                        state.last_reading,
                        source_id=sensor.source_id,
                        label=sensor.label,
                        driver=sensor.driver,
                        device_path=sensor.device_path,
                        source_display=sensor.source_display,
                        failure_availability=failure.failure_availability,
                        failure_message=failure.failure_message,
                    )
                    if state.last_reading is not None
                    else failure
                )
                continue

            if sensor.kind == "rpi_cpu_thermal":
                reading = self._read_rpi_thermal_candidate(sensor, now_utc=now_utc, now_monotonic=now_monotonic)
            else:
                reading = self._read_hwmon_candidate(sensor, now_utc=now_utc, now_monotonic=now_monotonic)

            if reading.failure_availability is not None:
                prev = state.last_reading
                if prev is not None and prev.current_millidegrees is not None:
                    reading.current_millidegrees = prev.current_millidegrees
                    reading.detected_warning_millidegrees = prev.detected_warning_millidegrees
                    reading.detected_error_millidegrees = prev.detected_error_millidegrees
                    reading.detected_warning_hyst_millidegrees = prev.detected_warning_hyst_millidegrees
                    reading.detected_error_hyst_millidegrees = prev.detected_error_hyst_millidegrees
                    reading.sampled_at = prev.sampled_at
                    reading.sampled_monotonic = prev.sampled_monotonic
                state.last_reading = reading
                continue

            state.ever_succeeded = True
            state.last_reading = reading
            state.last_severity, state.last_recovery_pending = self._evaluate_candidate(
                state,
                reading,
                overrides.get(source_id),
            )

    def describe_sources_for_settings(
        self,
        overrides: dict[str, PersistedCpuTempOverride],
        *,
        now_monotonic: float,
    ) -> tuple[list[CpuTemperatureSourceSettingsRead], MetricAvailability, str | None]:
        self.ensure_discovered(now_monotonic)
        results: list[CpuTemperatureSourceSettingsRead] = []
        seen_ids: set[str] = set()

        for source_id in sorted(self._candidates.keys()):
            seen_ids.add(source_id)
            state = self._candidates[source_id]
            sensor = state.sensor
            reading = state.last_reading
            if reading is None:
                if sensor.kind == "rpi_cpu_thermal":
                    reading = self._read_rpi_thermal_candidate(
                        sensor,
                        now_utc=datetime.now(timezone.utc),
                        now_monotonic=now_monotonic,
                    )
                else:
                    reading = self._read_hwmon_candidate(
                        sensor,
                        now_utc=datetime.now(timezone.utc),
                        now_monotonic=now_monotonic,
                    )
                state.last_reading = reading

            override = overrides.get(source_id)
            (
                eff_warn,
                eff_warn_origin,
                eff_err,
                eff_err_origin,
                warn_exceeds,
                err_exceeds,
                override_state,
                override_notice,
            ) = resolve_cpu_override_evaluation(
                detected_max=reading.detected_warning_millidegrees,
                detected_crit=reading.detected_error_millidegrees,
                detected_origin=reading.detected_limit_origin,
                override=override,
            )

            availability = reading.failure_availability or MetricAvailability.AVAILABLE
            results.append(
                CpuTemperatureSourceSettingsRead(
                    source_id=source_id,
                    label=sensor.label,
                    driver=sensor.driver,
                    device_path=sensor.device_path,
                    discovered=sensor.sensor_dir.exists(),
                    availability=availability,
                    detected_warning_millidegrees=reading.detected_warning_millidegrees,
                    detected_error_millidegrees=reading.detected_error_millidegrees,
                    detected_limit_origin=reading.detected_limit_origin,
                    warning_override_millidegrees=override.warning_override_millidegrees if override else None,
                    error_override_millidegrees=override.error_override_millidegrees if override else None,
                    effective_warning_millidegrees=eff_warn,
                    effective_warning_origin=eff_warn_origin,
                    effective_error_millidegrees=eff_err,
                    effective_error_origin=eff_err_origin,
                    warning_exceeds_detected=warn_exceeds,
                    error_exceeds_detected=err_exceeds,
                    override_state=override_state,
                    override_notice=override_notice,
                    unusable_attributes=list(reading.unusable_attributes),
                )
            )

        for source_id, override in sorted(overrides.items()):
            if source_id in seen_ids:
                continue
            eff_warn = override.warning_override_millidegrees
            eff_err = override.error_override_millidegrees
            results.append(
                CpuTemperatureSourceSettingsRead(
                    source_id=source_id,
                    label=override.label or source_id,
                    driver=override.driver,
                    device_path=override.device_path,
                    discovered=False,
                    availability=MetricAvailability.UNAVAILABLE,
                    detected_warning_millidegrees=override.observed_max_millidegrees,
                    detected_error_millidegrees=override.observed_crit_millidegrees,
                    detected_limit_origin=(
                        CpuTemperatureLimitOrigin.KERNEL_POLICY
                        if override.driver == "raspberrypi-cpu-thermal"
                        else CpuTemperatureLimitOrigin.HARDWARE
                    ),
                    warning_override_millidegrees=eff_warn,
                    error_override_millidegrees=eff_err,
                    effective_warning_millidegrees=eff_warn,
                    effective_warning_origin=CpuTemperatureLimitOrigin.ADMIN_OVERRIDE if eff_warn is not None else None,
                    effective_error_millidegrees=eff_err,
                    effective_error_origin=CpuTemperatureLimitOrigin.ADMIN_OVERRIDE if eff_err is not None else None,
                    override_state=CpuTemperatureOverrideState.ACTIVE,
                    override_notice="Sensor is not currently detected on this host. Saved override can be adjusted or cleared.",
                )
            )

        if self._candidates:
            return results, MetricAvailability.AVAILABLE, None
        assert self._discovery_problem is not None
        return results, self._discovery_problem[0], self._discovery_problem[1]

    def read_summary(
        self,
        *,
        overrides: dict[str, PersistedCpuTempOverride],
        now_monotonic: float,
    ) -> tuple[CpuTemperatureSummaryRead, bool]:
        """Build the single CPU thermal summary and whether CPU thermal is required in aggregate severity."""

        base_source = str(self._sys_root)
        if not self._candidates:
            if self._discovery_problem is None:
                return (
                    CpuTemperatureSummaryRead(
                        severity=HealthSeverity.UNKNOWN,
                        availability=MetricAvailability.COLLECTING,
                        source=base_source,
                        message="Waiting for initial CPU thermal discovery.",
                    ),
                    False,
                )
            availability, message = self._discovery_problem
            required = availability not in {MetricAvailability.NOT_MOUNTED, MetricAvailability.UNSUPPORTED}
            action = (
                "Mount /sys to /host/sys:ro on supported Linux hosts to enable CPU thermal monitoring."
                if availability == MetricAvailability.NOT_MOUNTED
                else ("Check /host/sys mount permissions and symlink targets." if required else None)
            )
            return (
                CpuTemperatureSummaryRead(
                    severity=HealthSeverity.UNKNOWN if required else HealthSeverity.INFORMATIONAL,
                    availability=availability,
                    source=base_source,
                    incomplete_coverage=True,
                    message=message,
                    action=action,
                ),
                required,
            )

        evaluated_summaries: list[tuple[tuple[int, int, int, int, str], CpuTemperatureSummaryRead, bool]] = []
        package_count = len(self._candidates)
        assessed_packages = 0
        any_incomplete = False
        any_required_failure = False

        severity_rank = {
            HealthSeverity.ERROR: 4,
            HealthSeverity.WARNING: 3,
            HealthSeverity.UNKNOWN: 2,
            HealthSeverity.OK: 1,
            HealthSeverity.INFORMATIONAL: 0,
        }

        for source_id, state in self._candidates.items():
            sensor = state.sensor
            reading = state.last_reading
            override = overrides.get(source_id)

            if reading is None:
                any_incomplete = True
                summary = CpuTemperatureSummaryRead(
                    severity=HealthSeverity.UNKNOWN,
                    availability=MetricAvailability.COLLECTING,
                    source_id=source_id,
                    label=sensor.label,
                    driver=sensor.driver,
                    source=sensor.source_display,
                    package_count=package_count,
                    incomplete_coverage=True,
                    message="Waiting for initial CPU temperature reading.",
                )
                evaluated_summaries.append(((-severity_rank[HealthSeverity.UNKNOWN], 0, 10**15, 0, source_id), summary, False))
                continue

            age = max(0.0, now_monotonic - reading.sampled_monotonic) if reading.sampled_monotonic is not None else None
            is_stale = age is not None and age > HOST_STALE_SECONDS

            (
                eff_warn,
                eff_warn_origin,
                eff_err,
                eff_err_origin,
                warn_exceeds,
                err_exceeds,
                override_state,
                override_notice,
            ) = resolve_cpu_override_evaluation(
                detected_max=reading.detected_warning_millidegrees,
                detected_crit=reading.detected_error_millidegrees,
                detected_origin=reading.detected_limit_origin,
                override=override,
            )

            summary = CpuTemperatureSummaryRead(
                severity=state.last_severity,
                availability=MetricAvailability.AVAILABLE,
                source_id=source_id,
                label=sensor.label,
                driver=sensor.driver,
                source=sensor.source_display,
                package_count=package_count,
                current_millidegrees=reading.current_millidegrees,
                detected_warning_millidegrees=reading.detected_warning_millidegrees,
                detected_error_millidegrees=reading.detected_error_millidegrees,
                detected_limit_origin=reading.detected_limit_origin,
                effective_warning_millidegrees=eff_warn,
                effective_warning_origin=eff_warn_origin,
                effective_error_millidegrees=eff_err,
                effective_error_origin=eff_err_origin,
                warning_override_millidegrees=override.warning_override_millidegrees if override else None,
                error_override_millidegrees=override.error_override_millidegrees if override else None,
                warning_exceeds_detected=warn_exceeds,
                error_exceeds_detected=err_exceeds,
                override_state=override_state,
                unusable_attributes=list(reading.unusable_attributes),
                sampled_at=reading.sampled_at,
                age_seconds=round(age, 1) if age is not None else None,
            )

            if reading.failure_availability is not None or is_stale:
                any_incomplete = True
                any_required_failure = True
                summary.severity = HealthSeverity.UNKNOWN
                summary.availability = reading.failure_availability or MetricAvailability.STALE
                summary.incomplete_coverage = True
                summary.is_stale = reading.current_millidegrees is not None
                summary.message = reading.failure_message or "Last CPU temperature reading is older than 15 seconds."
                summary.action = "Check host thermal sensor availability and /host/sys read-only mount."
                evaluated_summaries.append(((-severity_rank[HealthSeverity.UNKNOWN], 0, 10**15, 0, source_id), summary, True))
                continue

            if override_state == CpuTemperatureOverrideState.CONFLICT:
                any_incomplete = True
                any_required_failure = True
                summary.severity = HealthSeverity.UNKNOWN
                summary.availability = MetricAvailability.INVALID
                summary.incomplete_coverage = True
                summary.message = override_notice
                summary.action = "Review and update CPU temperature overrides in Health Monitoring settings."
                evaluated_summaries.append(((-severity_rank[HealthSeverity.UNKNOWN], 0, 10**15, 0, source_id), summary, True))
                continue

            candidate_incomplete = eff_warn is None or eff_err is None or bool(reading.unusable_attributes)
            if candidate_incomplete:
                any_incomplete = True
            if eff_warn is not None or eff_err is not None:
                assessed_packages += 1

            sev = state.last_severity
            notes: list[str] = []
            if sev == HealthSeverity.INFORMATIONAL:
                notes.append("Temperature limits are not available. An administrator can set monitoring thresholds.")
            elif eff_warn is None:
                notes.append("Warning temperature threshold is not available; evaluating critical threshold only.")
            elif eff_err is None:
                notes.append("Critical temperature threshold is not available; evaluating warning threshold only.")

            if reading.unusable_attributes:
                notes.append(f"Ignored unusable sensor limit attributes: {', '.join(reading.unusable_attributes)}.")
            if override_notice:
                notes.append(override_notice)
            if warn_exceeds and reading.detected_warning_millidegrees is not None:
                notes.append(
                    f"Manual warning override exceeds detected limit ({format_millidegrees_celsius(reading.detected_warning_millidegrees)})."
                )
            if err_exceeds and reading.detected_error_millidegrees is not None:
                notes.append(
                    f"Manual error override exceeds detected limit ({format_millidegrees_celsius(reading.detected_error_millidegrees)})."
                )
            if state.last_recovery_pending:
                notes.append("Recovery in progress; waiting for a second consecutive sample below the recovery boundary.")

            action = None
            if sev in {HealthSeverity.WARNING, HealthSeverity.ERROR}:
                action = "Check host cooling, airflow, and sustained CPU workload."
            elif override_state == CpuTemperatureOverrideState.REVIEW_REQUIRED:
                action = "Reconfirm, adjust, or clear CPU temperature overrides in Health Monitoring settings."

            current_temp = reading.current_millidegrees or 0
            has_err_flag = 1 if eff_err is not None else 0
            margin_to_err = (eff_err - current_temp) if eff_err is not None else 10**15

            summary.incomplete_coverage = candidate_incomplete
            summary.recovery_pending = state.last_recovery_pending
            summary.message = " ".join(notes) if notes else None
            summary.action = action
            sort_key = (
                -severity_rank[sev],
                -has_err_flag,
                margin_to_err,
                -current_temp,
                source_id,
            )
            evaluated_summaries.append((sort_key, summary, sev != HealthSeverity.INFORMATIONAL))

        evaluated_summaries.sort(key=lambda item: item[0])
        selected = evaluated_summaries[0][1]
        selected.package_count = package_count
        selected.assessed_package_count = assessed_packages
        selected.incomplete_coverage = any_incomplete or (assessed_packages < package_count)
        if package_count > 1 and assessed_packages < package_count and selected.severity != HealthSeverity.UNKNOWN:
            extra_note = f"Assessed {assessed_packages} of {package_count} CPU packages; one or more packages have incomplete thermal data."
            selected.message = f"{selected.message} {extra_note}".strip() if selected.message else extra_note

        required = any_required_failure or any(item[2] for item in evaluated_summaries)
        return selected, required


@dataclass
class ContainerMemorySample:
    used_bytes: int
    cache_bytes: int
    working_set_bytes: int
    limit_state: ContainerMemoryLimitState
    limit_bytes: int | None
    sampled_at: datetime
    sampled_monotonic: float


class ContainerMemoryCollector:
    """Collects container memory without file cache, retaining shared memory and kernel allocations."""

    def __init__(self, cgroup_root: Path = DEFAULT_CGROUP_ROOT) -> None:
        self._root = cgroup_root
        self._last_sample: ContainerMemorySample | None = None
        self._last_severity: HealthSeverity = HealthSeverity.UNKNOWN
        self._last_recovery_pending: bool = False
        self._failure_availability: MetricAvailability | None = None
        self._failure_message: str | None = None
        self._evaluator = SustainedMemoryEvaluator()

    def clear(self) -> None:
        self._last_sample = None
        self._last_severity = HealthSeverity.UNKNOWN
        self._last_recovery_pending = False
        self._failure_availability = None
        self._failure_message = None
        self._evaluator = SustainedMemoryEvaluator()

    def reevaluate_policy(self, *, warning_tenths: int, error_tenths: int, now_monotonic: float) -> None:
        self._evaluator.reset_for_policy(warning_tenths, error_tenths)
        sample = self._last_sample
        if (
            sample is not None
            and self._failure_availability is None
            and (now_monotonic - sample.sampled_monotonic) <= HOST_STALE_SECONDS
            and sample.limit_state == ContainerMemoryLimitState.FINITE
            and sample.limit_bytes is not None
        ):
            self._last_severity, self._last_recovery_pending = self._evaluator.evaluate(
                used_bytes=sample.used_bytes,
                total_bytes=sample.limit_bytes,
                warning_tenths=warning_tenths,
                error_tenths=error_tenths,
                now_monotonic=now_monotonic,
            )

    def _parse_memory_stat(self, stat_path: Path, *, keys: tuple[str, str, str]) -> tuple[int, int, MetricAvailability | None, str | None]:
        try:
            content = stat_path.read_text(encoding="utf-8")
        except OSError as exc:
            return 0, 0, _classify_os_error(exc), f"Container cgroup stat file {stat_path} could not be read."

        values: dict[str, str] = {}
        for line in content.splitlines():
            parts = line.split()
            if len(parts) == 2:
                values[parts[0]] = parts[1]

        counters: list[int] = []
        for key in keys:
            if key not in values:
                return 0, 0, MetricAvailability.UNAVAILABLE, f"Container cgroup {key} counter is missing from {stat_path}."
            parsed = _parse_strict_int_text(values[key])
            if parsed is None or parsed < 0:
                return 0, 0, MetricAvailability.INVALID, f"Container cgroup {key} value in {stat_path} is malformed."
            counters.append(parsed)
        file_bytes, shmem_bytes, inactive_bytes = counters
        if shmem_bytes > file_bytes:
            return 0, 0, MetricAvailability.INVALID, f"Container cgroup shared memory exceeds file memory in {stat_path}."
        # File accounting includes tmpfs/shared memory, which must remain in memory usage.
        return file_bytes - shmem_bytes, inactive_bytes, None, None

    def sample(
        self,
        *,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
        now_utc: datetime,
    ) -> None:
        v2_max = self._root / "memory.max"
        v2_current = self._root / "memory.current"
        v2_stat = self._root / "memory.stat"

        v1_dir = self._root / "memory"
        v1_limit = v1_dir / "memory.limit_in_bytes"
        v1_usage = v1_dir / "memory.usage_in_bytes"
        v1_stat = v1_dir / "memory.stat"

        if v2_max.exists() or v2_current.exists():
            try:
                raw_max = v2_max.read_text(encoding="utf-8").strip()
                raw_current = v2_current.read_text(encoding="utf-8").strip()
            except OSError as exc:
                self._evaluator.record_missing()
                self._failure_availability = _classify_os_error(exc)
                self._failure_message = "Container cgroup v2 memory files could not be read."
                return

            current_bytes = _parse_strict_int_text(raw_current)
            if current_bytes is None or current_bytes < 0:
                self._evaluator.record_missing()
                self._failure_availability = MetricAvailability.INVALID
                self._failure_message = "Container cgroup memory.current reported an invalid value."
                return

            if raw_max == "max":
                limit_state = ContainerMemoryLimitState.UNLIMITED
                limit_bytes: int | None = None
            else:
                parsed_max = _parse_strict_int_text(raw_max)
                if parsed_max is None or parsed_max <= 0:
                    self._evaluator.record_missing()
                    self._failure_availability = MetricAvailability.INVALID
                    self._failure_message = "Container cgroup memory.max reported an invalid value."
                    return
                if parsed_max >= UNLIMITED_CGROUP_V1_SENTINEL_BYTES:
                    limit_state = ContainerMemoryLimitState.UNLIMITED
                    limit_bytes = None
                else:
                    limit_state = ContainerMemoryLimitState.FINITE
                    limit_bytes = parsed_max

            cache_bytes, inactive_bytes, stat_err, stat_msg = self._parse_memory_stat(v2_stat, keys=("file", "shmem", "inactive_file"))
            if stat_err is not None:
                self._evaluator.record_missing()
                self._failure_availability = stat_err
                self._failure_message = stat_msg
                return
        elif v1_limit.exists() or v1_usage.exists():
            try:
                raw_limit = v1_limit.read_text(encoding="utf-8").strip()
                raw_usage = v1_usage.read_text(encoding="utf-8").strip()
            except OSError as exc:
                self._evaluator.record_missing()
                self._failure_availability = _classify_os_error(exc)
                self._failure_message = "Container cgroup v1 memory files could not be read."
                return

            current_bytes = _parse_strict_int_text(raw_usage)
            parsed_limit = _parse_strict_int_text(raw_limit)
            if current_bytes is None or current_bytes < 0 or parsed_limit is None or parsed_limit <= 0:
                self._evaluator.record_missing()
                self._failure_availability = MetricAvailability.INVALID
                self._failure_message = "Container cgroup v1 memory files reported invalid values."
                return

            if parsed_limit >= UNLIMITED_CGROUP_V1_SENTINEL_BYTES:
                limit_state = ContainerMemoryLimitState.UNLIMITED
                limit_bytes = None
            else:
                limit_state = ContainerMemoryLimitState.FINITE
                limit_bytes = parsed_limit

            cache_bytes, inactive_bytes, stat_err, stat_msg = self._parse_memory_stat(
                v1_stat,
                keys=("total_cache", "total_shmem", "total_inactive_file"),
            )
            if stat_err is not None:
                self._evaluator.record_missing()
                self._failure_availability = stat_err
                self._failure_message = stat_msg
                return
        else:
            self._evaluator.record_missing()
            self._failure_availability = MetricAvailability.UNAVAILABLE
            self._failure_message = "Container cgroup memory files are unavailable in /sys/fs/cgroup."
            return

        if cache_bytes > current_bytes:
            self._evaluator.record_missing()
            self._failure_availability = MetricAvailability.INVALID
            self._failure_message = "Container cgroup file cache exceeds total memory usage. Waiting for a consistent sample."
            return
        used_bytes = current_bytes - cache_bytes
        working_set_bytes = max(0, current_bytes - inactive_bytes)
        self._last_sample = ContainerMemorySample(
            used_bytes=used_bytes,
            cache_bytes=cache_bytes,
            working_set_bytes=working_set_bytes,
            limit_state=limit_state,
            limit_bytes=limit_bytes,
            sampled_at=now_utc,
            sampled_monotonic=now_monotonic,
        )
        self._failure_availability = None
        self._failure_message = None

        if limit_state == ContainerMemoryLimitState.FINITE and limit_bytes is not None:
            self._last_severity, self._last_recovery_pending = self._evaluator.evaluate(
                used_bytes=used_bytes,
                total_bytes=limit_bytes,
                warning_tenths=warning_tenths,
                error_tenths=error_tenths,
                now_monotonic=now_monotonic,
            )
        else:
            self._evaluator.reset_for_policy(warning_tenths, error_tenths)
            self._last_severity = HealthSeverity.INFORMATIONAL
            self._last_recovery_pending = False

    def read(
        self,
        *,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
    ) -> tuple[ContainerMemoryMetricRead, bool]:
        source = str(self._root)
        sample = self._last_sample
        age = max(0.0, now_monotonic - sample.sampled_monotonic) if sample is not None else None
        is_stale = age is not None and age > HOST_STALE_SECONDS
        if is_stale:
            self._evaluator.record_missing()

        if sample is None:
            availability = self._failure_availability or MetricAvailability.COLLECTING
            return (
                ContainerMemoryMetricRead(
                    severity=HealthSeverity.UNKNOWN,
                    availability=availability,
                    limit_state=ContainerMemoryLimitState.UNKNOWN,
                    source=source,
                    message=self._failure_message or "Waiting for initial container memory sample.",
                    action=(
                        "Verify /sys/fs/cgroup is readable inside the container and not masked by a /sys mount."
                        if availability != MetricAvailability.COLLECTING
                        else None
                    ),
                ),
                True,
            )

        if self._failure_availability is not None or is_stale:
            availability = self._failure_availability or MetricAvailability.STALE
            msg = self._failure_message or "Last container memory sample is older than 15 seconds."
            used_tenths = (
                (1000 * sample.used_bytes) // sample.limit_bytes
                if sample.limit_state == ContainerMemoryLimitState.FINITE and sample.limit_bytes
                else None
            )
            used_pct = (
                round((100.0 * sample.used_bytes) / sample.limit_bytes, 1)
                if sample.limit_state == ContainerMemoryLimitState.FINITE and sample.limit_bytes
                else None
            )
            return (
                ContainerMemoryMetricRead(
                    severity=HealthSeverity.UNKNOWN,
                    availability=availability,
                    limit_state=ContainerMemoryLimitState.UNKNOWN if self._failure_availability is not None else sample.limit_state,
                    source=source,
                    used_bytes=sample.used_bytes,
                    cache_bytes=sample.cache_bytes,
                    working_set_bytes=sample.working_set_bytes,
                    limit_bytes=sample.limit_bytes,
                    used_tenths_percent=used_tenths,
                    used_percent=used_pct,
                    warning_tenths_percent=warning_tenths if sample.limit_state == ContainerMemoryLimitState.FINITE else None,
                    error_tenths_percent=error_tenths if sample.limit_state == ContainerMemoryLimitState.FINITE else None,
                    sampled_at=sample.sampled_at,
                    age_seconds=round(age or 0.0, 1),
                    is_stale=True,
                    message=msg,
                    action="Verify /sys/fs/cgroup visibility for the container runtime.",
                ),
                True,
            )

        if sample.limit_state == ContainerMemoryLimitState.UNLIMITED:
            return (
                ContainerMemoryMetricRead(
                    severity=HealthSeverity.INFORMATIONAL,
                    availability=MetricAvailability.AVAILABLE,
                    limit_state=ContainerMemoryLimitState.UNLIMITED,
                    source=source,
                    used_bytes=sample.used_bytes,
                    cache_bytes=sample.cache_bytes,
                    working_set_bytes=sample.working_set_bytes,
                    limit_bytes=None,
                    used_tenths_percent=None,
                    used_percent=None,
                    warning_tenths_percent=None,
                    error_tenths_percent=None,
                    recovery_pending=False,
                    sampled_at=sample.sampled_at,
                    age_seconds=round(age or 0.0, 1),
                    is_stale=False,
                    message="No memory limit configured.",
                ),
                False,
            )

        assert sample.limit_bytes is not None
        used_tenths = (1000 * sample.used_bytes) // sample.limit_bytes
        used_pct = round((100.0 * sample.used_bytes) / sample.limit_bytes, 1)
        action = (
            "Increase the container memory limit or reduce concurrent preview/archive workloads."
            if self._last_severity in {HealthSeverity.WARNING, HealthSeverity.ERROR}
            else None
        )
        message = (
            "Recovery in progress; waiting for memory usage without file cache to remain below the recovery threshold for 60 seconds."
            if self._last_recovery_pending
            else None
        )
        return (
            ContainerMemoryMetricRead(
                severity=self._last_severity,
                availability=MetricAvailability.AVAILABLE,
                limit_state=ContainerMemoryLimitState.FINITE,
                source=source,
                used_bytes=sample.used_bytes,
                cache_bytes=sample.cache_bytes,
                working_set_bytes=sample.working_set_bytes,
                limit_bytes=sample.limit_bytes,
                used_tenths_percent=used_tenths,
                used_percent=used_pct,
                warning_tenths_percent=warning_tenths,
                error_tenths_percent=error_tenths,
                recovery_pending=self._last_recovery_pending,
                sampled_at=sample.sampled_at,
                age_seconds=round(age or 0.0, 1),
                is_stale=False,
                message=message,
                action=action,
            ),
            True,
        )


@dataclass(frozen=True)
class PosixFilesystemCapacity:
    filesystem_identity: tuple[int, int]
    total_bytes: int
    available_bytes: int


def query_posix_statvfs(target_path: Path) -> PosixFilesystemCapacity:
    """Query POSIX statvfs counters without directory traversal or file scans."""

    probe_path = target_path
    while not probe_path.exists() and probe_path.parent != probe_path:
        probe_path = probe_path.parent

    stat_res = os.stat(probe_path)
    vfs_res = os.statvfs(probe_path)
    frsize = int(vfs_res.f_frsize or vfs_res.f_bsize)
    total_bytes = int(vfs_res.f_blocks) * frsize
    available_bytes = int(vfs_res.f_bavail) * frsize
    fsid = int(getattr(vfs_res, "f_fsid", 0))
    return PosixFilesystemCapacity(
        filesystem_identity=(int(stat_res.st_dev), fsid),
        total_bytes=total_bytes,
        available_bytes=min(total_bytes, max(0, available_bytes)) if total_bytes > 0 else 0,
    )


def evaluate_storage_capacity(
    evaluator: SampleCountEvaluator,
    *,
    available_bytes: int,
    total_bytes: int,
    warning_tenths: int,
    error_tenths: int,
) -> tuple[HealthSeverity, bool]:
    """Evaluate low-trigger storage free-space thresholds with 1-reading entry and 2-reading recovery."""

    lhs = 1000 * available_bytes
    is_error = available_bytes == 0 or (lhs <= error_tenths * total_bytes)
    is_warning = (not is_error) and (lhs <= warning_tenths * total_bytes)

    clear_w = min(1000, warning_tenths + STORAGE_HYSTERESIS_TENTHS_PERCENT)
    clear_e = min(warning_tenths, error_tenths + STORAGE_HYSTERESIS_TENTHS_PERCENT)
    clear_w_met = available_bytes > 0 and (lhs >= clear_w * total_bytes)
    clear_e_met = available_bytes > 0 and (lhs > clear_e * total_bytes)

    return evaluator.evaluate(
        signature=(warning_tenths, error_tenths),
        has_warning_threshold=True,
        has_error_threshold=True,
        is_warning=is_warning,
        is_error=is_error,
        clear_warning_met=clear_w_met,
        clear_error_met=clear_e_met,
        warning_entry_samples=1,
        error_entry_samples=1,
        recovery_samples=2,
    )


def build_storage_metric_read(
    *,
    metric_id: str,
    kind: Literal["application_data", "application_temp", "application_combined", "smb"],
    connection_id: object | None = None,
    label: str,
    source: str,
    semantics: StorageSpaceSemantics,
    warning_tenths: int,
    error_tenths: int,
    now_monotonic: float,
    total_bytes: int | None,
    available_bytes: int | None,
    actual_free_bytes: int | None,
    sampled_at: datetime | None,
    sampled_monotonic: float | None,
    severity: HealthSeverity,
    recovery_pending: bool,
    failure_availability: MetricAvailability | None,
    failure_message: str | None,
) -> StorageMetricRead:
    import uuid as uuid_module

    resolved_conn_id = connection_id if isinstance(connection_id, uuid_module.UUID) else None
    age = max(0.0, now_monotonic - sampled_monotonic) if sampled_monotonic is not None else None
    is_stale = age is not None and age > STORAGE_STALE_SECONDS

    if sampled_monotonic is None or total_bytes is None or available_bytes is None:
        availability = failure_availability or MetricAvailability.COLLECTING
        action = None
        if availability == MetricAvailability.PERMISSION_DENIED:
            action = "Check access permissions for this storage volume."
        elif availability in {MetricAvailability.OFFLINE, MetricAvailability.TIMEOUT, MetricAvailability.UNAVAILABLE}:
            action = "Verify that the storage server or volume is reachable and retry."
        return StorageMetricRead(
            id=metric_id,
            kind=kind,
            connection_id=resolved_conn_id,
            label=label,
            source=source,
            semantics=semantics,
            severity=HealthSeverity.UNKNOWN,
            availability=availability,
            warning_tenths_percent=warning_tenths,
            error_tenths_percent=error_tenths,
            message=failure_message or "Checking storage capacity.",
            action=action,
        )

    avail_tenths = (1000 * available_bytes) // total_bytes if total_bytes > 0 else None
    avail_pct = round((100.0 * available_bytes) / total_bytes, 1) if total_bytes > 0 else None

    if failure_availability is not None or is_stale:
        availability = failure_availability or MetricAvailability.STALE
        msg = failure_message or "Last storage capacity reading is older than 180 seconds."
        return StorageMetricRead(
            id=metric_id,
            kind=kind,
            connection_id=resolved_conn_id,
            label=label,
            source=source,
            semantics=semantics,
            severity=HealthSeverity.UNKNOWN,
            availability=availability,
            available_bytes=available_bytes,
            total_bytes=total_bytes,
            actual_free_bytes=actual_free_bytes,
            available_tenths_percent=avail_tenths,
            available_percent=avail_pct,
            warning_tenths_percent=warning_tenths,
            error_tenths_percent=error_tenths,
            recovery_pending=False,
            sampled_at=sampled_at,
            age_seconds=round(age or 0.0, 1),
            is_stale=True,
            message=f"{msg} Last severity: {severity.value}.",
            action="Verify storage connectivity and permissions.",
        )

    action = "Free space or select another location." if severity in {HealthSeverity.WARNING, HealthSeverity.ERROR} else None
    notes: list[str] = []
    if recovery_pending:
        notes.append("Recovery in progress; waiting for a second consecutive reading above the recovery boundary.")
    if semantics == StorageSpaceSemantics.CALLER_QUOTA and actual_free_bytes is not None and actual_free_bytes > available_bytes:
        notes.append("Available space reflects the caller quota on this share.")

    return StorageMetricRead(
        id=metric_id,
        kind=kind,
        connection_id=resolved_conn_id,
        label=label,
        source=source,
        semantics=semantics,
        severity=severity,
        availability=MetricAvailability.AVAILABLE,
        available_bytes=available_bytes,
        total_bytes=total_bytes,
        actual_free_bytes=actual_free_bytes,
        available_tenths_percent=avail_tenths,
        available_percent=avail_pct,
        warning_tenths_percent=warning_tenths,
        error_tenths_percent=error_tenths,
        recovery_pending=recovery_pending,
        sampled_at=sampled_at,
        age_seconds=round(age or 0.0, 1),
        is_stale=False,
        message=" ".join(notes) if notes else None,
        action=action,
    )
