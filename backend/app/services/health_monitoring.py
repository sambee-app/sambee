from __future__ import annotations

import asyncio
import hashlib
import tempfile
import threading
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Literal

from sqlmodel import Session

from app.api._smb_helpers import build_smb_backend, disconnect_backend_safely
from app.core.config import static
from app.core.logging import get_logger
from app.models.connection import Connection
from app.models.health_monitoring import (
    HOST_SAMPLE_INTERVAL_SECONDS,
    STORAGE_REFRESH_INTERVAL_SECONDS,
    AggregateHealthSeverity,
    ContainerMemoryMetricRead,
    CpuTemperatureSourceSettingsRead,
    CpuTemperatureSummaryRead,
    HealthMonitoringPolicy,
    HealthMonitoringSnapshotRead,
    HealthMonitoringThresholdsRead,
    HealthSeverity,
    HealthSummaryRead,
    MemoryMetricRead,
    MetricAvailability,
    PersistedCpuTempOverride,
    StorageMetricRead,
    StorageSpaceSemantics,
    SystemLoadMetricRead,
)
from app.models.user import User
from app.services.connection_access import can_view_connection
from app.services.health_monitoring_collectors import (
    ContainerMemoryCollector,
    CpuTemperatureCollector,
    HostMemoryCollector,
    PosixFilesystemCapacity,
    SampleCountEvaluator,
    SystemLoadCollector,
    _classify_os_error,
    build_storage_metric_read,
    evaluate_storage_capacity,
    query_posix_statvfs,
)
from app.services.health_monitoring_settings import (
    build_health_monitoring_policy,
    load_persisted_cpu_overrides,
)
from app.services.system_settings import get_smb_policy_settings
from app.storage.smb import SMBBackend, SMBVolumeCapacity
from app.storage.smb_errors import SMBOperationTimeout

logger = get_logger(__name__)

MAX_STORAGE_PROBES_IN_FLIGHT = 2
MAX_SMB_CACHE_ENTRIES = 32
MAX_USER_SMB_TRIGGERS_PER_WINDOW = 4
USER_SMB_TRIGGER_WINDOW_SECONDS = 60.0
MAX_TRACKED_RATE_LIMIT_USERS = 256
STORAGE_PROBE_STAGGER_SECONDS = 0.15
STORAGE_PROBE_TIMEOUT_SECONDS = 10.0
INITIAL_RETRY_BACKOFF_SECONDS = 15.0
MAX_RETRY_BACKOFF_SECONDS = 60.0


def _compute_retry_backoff(consecutive_failures: int) -> float:
    if consecutive_failures <= 0:
        return 0.0
    return float(min(MAX_RETRY_BACKOFF_SECONDS, INITIAL_RETRY_BACKOFF_SECONDS * (2 ** (consecutive_failures - 1))))


def _connection_context_fingerprint(connection: Connection) -> str:
    try:
        smb_policy = get_smb_policy_settings()
        policy_part = f"{smb_policy.authentication_mode.value}:{smb_policy.encryption_mode.value}:{smb_policy.connection_timeout_seconds}"
    except Exception:
        policy_part = "invalid_policy"

    normalized_prefix = SMBBackend._normalize_prefix(connection.path_prefix)
    raw = "|".join(
        [
            str(connection.id),
            connection.host.lower(),
            str(connection.port),
            connection.share_name or "",
            normalized_prefix,
            connection.username or "",
            connection.password_encrypted or "",
            policy_part,
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _classify_smb_error(error: Exception) -> tuple[MetricAvailability, str]:
    if isinstance(error, (TimeoutError, asyncio.TimeoutError, SMBOperationTimeout)):
        return MetricAvailability.TIMEOUT, "SMB storage capacity check timed out."
    if isinstance(error, PermissionError):
        return MetricAvailability.PERMISSION_DENIED, "Access denied while reading SMB share capacity."
    if isinstance(error, FileNotFoundError):
        return MetricAvailability.UNAVAILABLE, "Configured SMB share or path was not found."
    if isinstance(error, OSError):
        avail = _classify_os_error(error)
        if avail == MetricAvailability.OFFLINE:
            return MetricAvailability.OFFLINE, "SMB server is unreachable."
        if avail == MetricAvailability.PERMISSION_DENIED:
            return MetricAvailability.PERMISSION_DENIED, "Access denied while reading SMB share capacity."
        if avail == MetricAvailability.TIMEOUT:
            return MetricAvailability.TIMEOUT, "SMB storage capacity check timed out."
    text = str(error).lower()
    if "access denied" in text or "0xc0000022" in text or "logon failure" in text or "0xc000006d" in text:
        return MetricAvailability.PERMISSION_DENIED, "Access denied while reading SMB share capacity."
    if "not supported" in text or "0xc00000bb" in text or "invalid info class" in text:
        return MetricAvailability.UNSUPPORTED, "SMB server does not support volume capacity queries."
    if "timed out" in text or "timeout" in text:
        return MetricAvailability.TIMEOUT, "SMB storage capacity check timed out."
    if "unreachable" in text or "refused" in text or "disconnected" in text or "reset" in text:
        return MetricAvailability.OFFLINE, "SMB server is unreachable."
    return MetricAvailability.UNAVAILABLE, "SMB storage capacity could not be read."


@dataclass
class StorageProbeEntry:
    metric_id: str
    kind: Literal["application_data", "application_temp", "application_combined", "smb"]
    label: str
    source: str
    semantics: StorageSpaceSemantics
    connection_id: uuid.UUID | None = None
    context_fingerprint: str = ""
    filesystem_identity: tuple[int, int] | None = None
    total_bytes: int | None = None
    available_bytes: int | None = None
    actual_free_bytes: int | None = None
    sampled_at: datetime | None = None
    sampled_monotonic: float | None = None
    last_attempt_monotonic: float | None = None
    retry_not_before_monotonic: float = 0.0
    consecutive_failures: int = 0
    in_flight: bool = False
    failure_availability: MetricAvailability | None = None
    failure_message: str | None = None
    evaluator: SampleCountEvaluator = field(default_factory=SampleCountEvaluator)
    severity: HealthSeverity = HealthSeverity.UNKNOWN
    recovery_pending: bool = False

    def reevaluate_thresholds(self, warning_tenths: int, error_tenths: int, now_monotonic: float) -> None:
        self.evaluator.reset_for_policy((warning_tenths, error_tenths))
        if (
            self.total_bytes is not None
            and self.total_bytes > 0
            and self.available_bytes is not None
            and self.failure_availability is None
            and self.sampled_monotonic is not None
            and (now_monotonic - self.sampled_monotonic) <= 180.0
        ):
            self.severity, self.recovery_pending = evaluate_storage_capacity(
                self.evaluator,
                available_bytes=self.available_bytes,
                total_bytes=self.total_bytes,
                warning_tenths=warning_tenths,
                error_tenths=error_tenths,
            )


class HealthMonitoringCoordinator:
    """Process-owned RAM-only health sampler and bounded storage capacity coordinator."""

    def __init__(
        self,
        *,
        meminfo_path: Path | None = None,
        loadavg_path: Path | None = None,
        cpuinfo_path: Path | None = None,
        sys_root: Path | None = None,
        cgroup_root: Path | None = None,
        data_dir: Path | None = None,
        temp_dir: Path | None = None,
        smb_backend_builder: Callable[[Connection], SMBBackend] = build_smb_backend,
        posix_statvfs_fn: Callable[[Path], PosixFilesystemCapacity] = query_posix_statvfs,
        clock_monotonic: Callable[[], float] = monotonic,
        clock_utc: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._lock = threading.RLock()
        self._clock_monotonic = clock_monotonic
        self._clock_utc = clock_utc
        self._host_memory = HostMemoryCollector(meminfo_path) if meminfo_path else HostMemoryCollector()
        self._system_load = SystemLoadCollector(loadavg_path, cpuinfo_path) if (loadavg_path and cpuinfo_path) else SystemLoadCollector()
        self._cpu_temp = CpuTemperatureCollector(sys_root) if sys_root else CpuTemperatureCollector()
        self._container_memory = ContainerMemoryCollector(cgroup_root) if cgroup_root else ContainerMemoryCollector()

        self._data_dir = data_dir if data_dir is not None else static.data_dir
        self._temp_dir = temp_dir if temp_dir is not None else Path(tempfile.gettempdir())
        self._smb_backend_builder = smb_backend_builder
        self._posix_statvfs_fn = posix_statvfs_fn

        self._app_storage: dict[str, StorageProbeEntry] = {}
        self._smb_cache: OrderedDict[uuid.UUID, StorageProbeEntry] = OrderedDict()
        self._user_smb_triggers: OrderedDict[uuid.UUID, deque[float]] = OrderedDict()

        self._active_probe_slots = 0
        self._probe_semaphore = asyncio.BoundedSemaphore(MAX_STORAGE_PROBES_IN_FLIGHT)
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._host_loop_task: asyncio.Task[None] | None = None
        self._running = False
        self._last_logged_host_severity: AggregateHealthSeverity | None = None

    @property
    def active_probe_slots(self) -> int:
        with self._lock:
            return self._active_probe_slots

    def is_source_in_flight(self, key: str | uuid.UUID) -> bool:
        with self._lock:
            if isinstance(key, uuid.UUID):
                entry = self._smb_cache.get(key)
                return bool(entry and entry.in_flight)
            entry = self._app_storage.get(key)
            return bool(entry and entry.in_flight)

    def _retain_task(self, task: asyncio.Task[None]) -> None:
        with self._lock:
            self._background_tasks.add(task)

        def _done(completed: asyncio.Task[None]) -> None:
            with self._lock:
                self._background_tasks.discard(completed)
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(_done)

    async def _acquire_probe_slot(self) -> None:
        await self._probe_semaphore.acquire()
        with self._lock:
            self._active_probe_slots += 1

    def _release_probe_slot(self) -> None:
        with self._lock:
            self._probe_semaphore.release()
            self._active_probe_slots -= 1

    def clear_runtime_state(self) -> None:
        """Clear RAM metric caches and evaluation windows (called when disabled or shut down)."""
        with self._lock:
            self._host_memory.clear()
            self._system_load.clear()
            self._cpu_temp.clear()
            self._container_memory.clear()
            self._app_storage = {k: v for k, v in self._app_storage.items() if v.in_flight}
            self._smb_cache = OrderedDict((k, v) for k, v in self._smb_cache.items() if v.in_flight)
            self._user_smb_triggers.clear()
            self._last_logged_host_severity = None

    def invalidate_smb_connection(self, connection_id: uuid.UUID) -> None:
        with self._lock:
            existing = self._smb_cache.get(connection_id)
            if existing is not None and not existing.in_flight:
                self._smb_cache.pop(connection_id, None)
            elif existing is not None:
                existing.context_fingerprint = "invalidated"

    def invalidate_all_smb_connections(self) -> None:
        with self._lock:
            for cid in list(self._smb_cache.keys()):
                entry = self._smb_cache[cid]
                if not entry.in_flight:
                    self._smb_cache.pop(cid, None)
                else:
                    entry.context_fingerprint = "invalidated"

    def get_discovered_cpu_sources_by_id(self) -> dict[str, CpuTemperatureSourceSettingsRead]:
        with self._lock:
            now_mono = self._clock_monotonic()
            sources, _, _ = self._cpu_temp.describe_sources_for_settings({}, now_monotonic=now_mono)
            return {src.source_id: src for src in sources if src.discovered}

    def describe_cpu_sources_for_settings(
        self,
        persisted_overrides: dict[str, PersistedCpuTempOverride],
    ) -> tuple[list[CpuTemperatureSourceSettingsRead], MetricAvailability, str | None]:
        with self._lock:
            return self._cpu_temp.describe_sources_for_settings(
                persisted_overrides,
                now_monotonic=self._clock_monotonic(),
            )

    def on_policy_changed(self, policy: HealthMonitoringPolicy) -> None:
        if not policy.enabled:
            self.clear_runtime_state()
            logger.info("Health monitoring disabled; cleared in-memory metric caches.")
            return

        now_mono = self._clock_monotonic()
        with self._lock:
            self._host_memory.reevaluate_policy(
                warning_tenths=policy.memory_warning_tenths_percent,
                error_tenths=policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )
            self._container_memory.reevaluate_policy(
                warning_tenths=policy.memory_warning_tenths_percent,
                error_tenths=policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )
            self._system_load.reevaluate_policy(
                warning_hundredths=policy.load_warning_hundredths,
                error_hundredths=policy.load_error_hundredths,
                now_monotonic=now_mono,
            )
            for entry in self._app_storage.values():
                entry.reevaluate_thresholds(
                    policy.available_space_warning_tenths_percent,
                    policy.available_space_error_tenths_percent,
                    now_mono,
                )
            for entry in self._smb_cache.values():
                entry.reevaluate_thresholds(
                    policy.available_space_warning_tenths_percent,
                    policy.available_space_error_tenths_percent,
                    now_mono,
                )

    def on_cpu_override_changed(self, source_id: str, *, session: Session | None = None) -> None:
        overrides = load_persisted_cpu_overrides(session)
        now_mono = self._clock_monotonic()
        with self._lock:
            self._cpu_temp.reset_source_state(source_id)
            self._cpu_temp.reevaluate_overrides(overrides, now_mono)

    def sample_host_once(
        self,
        *,
        policy: HealthMonitoringPolicy | None = None,
        overrides: dict[str, PersistedCpuTempOverride] | None = None,
    ) -> None:
        """Run one synchronous host sample (host memory, normalized load, CPU thermal, container cgroup)."""

        resolved_policy = policy if policy is not None else build_health_monitoring_policy()
        if not resolved_policy.enabled:
            self.clear_runtime_state()
            return

        resolved_overrides = overrides if overrides is not None else load_persisted_cpu_overrides()
        now_mono = self._clock_monotonic()
        now_utc = self._clock_utc()

        with self._lock:
            try:
                self._host_memory.sample(
                    warning_tenths=resolved_policy.memory_warning_tenths_percent,
                    error_tenths=resolved_policy.memory_error_tenths_percent,
                    now_monotonic=now_mono,
                    now_utc=now_utc,
                )
            except Exception as exc:
                logger.warning("Unexpected error in host memory collector (%s).", type(exc).__name__)

            try:
                self._system_load.sample(
                    warning_hundredths=resolved_policy.load_warning_hundredths,
                    error_hundredths=resolved_policy.load_error_hundredths,
                    now_monotonic=now_mono,
                    now_utc=now_utc,
                )
            except Exception as exc:
                logger.warning("Unexpected error in system load collector (%s).", type(exc).__name__)

            try:
                self._cpu_temp.sample(
                    overrides=resolved_overrides,
                    now_monotonic=now_mono,
                    now_utc=now_utc,
                )
            except Exception as exc:
                logger.warning("Unexpected error in CPU thermal collector (%s).", type(exc).__name__)

            try:
                self._container_memory.sample(
                    warning_tenths=resolved_policy.memory_warning_tenths_percent,
                    error_tenths=resolved_policy.memory_error_tenths_percent,
                    now_monotonic=now_mono,
                    now_utc=now_utc,
                )
            except Exception as exc:
                logger.warning("Unexpected error in container memory collector (%s).", type(exc).__name__)

            host_mem, host_mem_req = self._host_memory.read(
                warning_tenths=resolved_policy.memory_warning_tenths_percent,
                error_tenths=resolved_policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )
            load_read, load_req = self._system_load.read(
                warning_hundredths=resolved_policy.load_warning_hundredths,
                error_hundredths=resolved_policy.load_error_hundredths,
                now_monotonic=now_mono,
            )
            cpu_read, cpu_req = self._cpu_temp.read_summary(overrides=resolved_overrides, now_monotonic=now_mono)
            cont_read, cont_req = self._container_memory.read(
                warning_tenths=resolved_policy.memory_warning_tenths_percent,
                error_tenths=resolved_policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )
            host_summary = _compute_summary(
                host_memory=(host_mem, host_mem_req),
                system_load=(load_read, load_req),
                cpu_temperature=(cpu_read, cpu_req),
                container_memory=(cont_read, cont_req),
                application_storage=[],
                smb_storage=[],
            )
            if self._last_logged_host_severity != host_summary.severity:
                if self._last_logged_host_severity is not None:
                    logger.info(
                        "Host health severity changed: %s -> %s",
                        self._last_logged_host_severity.value,
                        host_summary.severity.value,
                    )
                self._last_logged_host_severity = host_summary.severity

    def _ensure_app_storage_entries(self) -> list[StorageProbeEntry]:
        with self._lock:
            if "data" not in self._app_storage:
                self._app_storage["data"] = StorageProbeEntry(
                    metric_id="application-data",
                    kind="application_data",
                    label="Application data",
                    source=str(self._data_dir.resolve() if self._data_dir.exists() else self._data_dir),
                    semantics=StorageSpaceSemantics.POSIX_UNPRIVILEGED_BLOCKS,
                )
            if "temp" not in self._app_storage:
                self._app_storage["temp"] = StorageProbeEntry(
                    metric_id="application-temp",
                    kind="application_temp",
                    label="Temporary storage",
                    source=str(self._temp_dir),
                    semantics=StorageSpaceSemantics.POSIX_UNPRIVILEGED_BLOCKS,
                )
            return [self._app_storage["data"], self._app_storage["temp"]]

    def _should_schedule_probe(self, entry: StorageProbeEntry, now_monotonic: float) -> bool:
        if entry.in_flight:
            return False
        if now_monotonic < entry.retry_not_before_monotonic:
            return False
        if entry.sampled_monotonic is None:
            return True
        return (now_monotonic - entry.sampled_monotonic) >= STORAGE_REFRESH_INTERVAL_SECONDS

    def _consume_user_smb_trigger(self, user_id: uuid.UUID, now_monotonic: float) -> bool:
        with self._lock:
            window = self._user_smb_triggers.get(user_id)
            if window is None:
                window = deque()
                self._user_smb_triggers[user_id] = window
            else:
                self._user_smb_triggers.move_to_end(user_id)

            cutoff = now_monotonic - USER_SMB_TRIGGER_WINDOW_SECONDS
            while window and window[0] <= cutoff:
                window.popleft()

            while len(self._user_smb_triggers) > MAX_TRACKED_RATE_LIMIT_USERS:
                self._user_smb_triggers.popitem(last=False)

            if len(window) >= MAX_USER_SMB_TRIGGERS_PER_WINDOW:
                return False

            window.append(now_monotonic)
            return True

    async def _probe_posix_entry(
        self,
        entry_key: str,
        target_path: Path,
        *,
        stagger_seconds: float,
    ) -> None:
        slot_acquired = False
        worker_started = False

        def _on_worker_done(_fut: asyncio.Future[PosixFilesystemCapacity]) -> None:
            with self._lock:
                target = self._app_storage.get(entry_key)
                if target is not None:
                    target.in_flight = False
            self._release_probe_slot()

        try:
            if stagger_seconds > 0:
                await asyncio.sleep(stagger_seconds)
            await self._acquire_probe_slot()
            slot_acquired = True
            loop = asyncio.get_running_loop()
            fut = loop.run_in_executor(None, self._posix_statvfs_fn, target_path)
            worker_started = True
            fut.add_done_callback(_on_worker_done)
            result = await asyncio.wait_for(asyncio.shield(fut), timeout=STORAGE_PROBE_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            now_mono = self._clock_monotonic()
            with self._lock:
                entry = self._app_storage.get(entry_key)
                if entry is not None:
                    entry.consecutive_failures += 1
                    entry.retry_not_before_monotonic = now_mono + _compute_retry_backoff(entry.consecutive_failures)
                    entry.failure_availability = MetricAvailability.TIMEOUT
                    entry.failure_message = "Filesystem capacity query timed out."
            return
        except Exception as exc:
            now_mono = self._clock_monotonic()
            avail = _classify_os_error(exc) if isinstance(exc, OSError) else MetricAvailability.UNAVAILABLE
            with self._lock:
                entry = self._app_storage.get(entry_key)
                if entry is not None:
                    entry.consecutive_failures += 1
                    entry.retry_not_before_monotonic = now_mono + _compute_retry_backoff(entry.consecutive_failures)
                    entry.failure_availability = avail
                    entry.failure_message = "Filesystem capacity could not be queried."
            return
        finally:
            if not worker_started:
                with self._lock:
                    target = self._app_storage.get(entry_key)
                    if target is not None:
                        target.in_flight = False
                if slot_acquired:
                    self._release_probe_slot()

        policy = build_health_monitoring_policy()
        now_mono = self._clock_monotonic()
        now_utc = self._clock_utc()
        with self._lock:
            entry = self._app_storage.get(entry_key)
            if entry is None:
                return
            if result.total_bytes <= 0:
                entry.consecutive_failures += 1
                entry.retry_not_before_monotonic = now_mono + _compute_retry_backoff(entry.consecutive_failures)
                entry.failure_availability = MetricAvailability.UNSUPPORTED
                entry.failure_message = "Filesystem reported zero total capacity."
                return
            entry.filesystem_identity = result.filesystem_identity
            entry.total_bytes = result.total_bytes
            entry.available_bytes = result.available_bytes
            entry.sampled_at = now_utc
            entry.sampled_monotonic = now_mono
            entry.consecutive_failures = 0
            entry.retry_not_before_monotonic = 0.0
            entry.failure_availability = None
            entry.failure_message = None
            entry.severity, entry.recovery_pending = evaluate_storage_capacity(
                entry.evaluator,
                available_bytes=result.available_bytes,
                total_bytes=result.total_bytes,
                warning_tenths=policy.available_space_warning_tenths_percent,
                error_tenths=policy.available_space_error_tenths_percent,
            )

    async def _probe_smb_entry(
        self,
        connection: Connection,
        expected_fingerprint: str,
        *,
        stagger_seconds: float,
    ) -> None:
        slot_acquired = False
        worker_dispatched = False
        released = False

        def _release_once() -> None:
            nonlocal released
            if released:
                return
            released = True
            with self._lock:
                cached = self._smb_cache.get(connection.id)
                if cached is not None:
                    cached.in_flight = False
            if slot_acquired:
                self._release_probe_slot()

        backend: SMBBackend | None = None
        try:
            if stagger_seconds > 0:
                await asyncio.sleep(stagger_seconds)
            await self._acquire_probe_slot()
            slot_acquired = True
            backend = self._smb_backend_builder(connection)
            await backend.connect()
            worker_dispatched = True
            capacity: SMBVolumeCapacity = await backend.get_volume_capacity(on_worker_exit=_release_once)
        except asyncio.CancelledError:
            if not worker_dispatched:
                _release_once()
            raise
        except Exception as exc:
            if not worker_dispatched:
                _release_once()
            avail, msg = _classify_smb_error(exc)
            now_mono = self._clock_monotonic()
            with self._lock:
                entry = self._smb_cache.get(connection.id)
                if entry is not None and entry.context_fingerprint == expected_fingerprint:
                    entry.consecutive_failures += 1
                    entry.retry_not_before_monotonic = now_mono + _compute_retry_backoff(entry.consecutive_failures)
                    entry.failure_availability = avail
                    entry.failure_message = msg
            return
        finally:
            if backend is not None:
                await disconnect_backend_safely(backend, logger=logger, context=f"SMB capacity probe for {connection.id}")

        policy = build_health_monitoring_policy()
        now_mono = self._clock_monotonic()
        now_utc = self._clock_utc()
        with self._lock:
            entry = self._smb_cache.get(connection.id)
            if entry is None or entry.context_fingerprint != expected_fingerprint:
                return
            if capacity.total_bytes <= 0 or capacity.caller_available_bytes < 0:
                entry.consecutive_failures += 1
                entry.retry_not_before_monotonic = now_mono + _compute_retry_backoff(entry.consecutive_failures)
                entry.failure_availability = MetricAvailability.INVALID
                entry.failure_message = "SMB server returned invalid volume capacity counters."
                return

            avail_bytes = min(capacity.total_bytes, capacity.caller_available_bytes)
            actual_bytes = max(0, capacity.actual_available_bytes)
            entry.total_bytes = capacity.total_bytes
            entry.available_bytes = avail_bytes
            entry.actual_free_bytes = actual_bytes
            entry.sampled_at = now_utc
            entry.sampled_monotonic = now_mono
            entry.consecutive_failures = 0
            entry.retry_not_before_monotonic = 0.0
            entry.failure_availability = None
            entry.failure_message = None
            entry.severity, entry.recovery_pending = evaluate_storage_capacity(
                entry.evaluator,
                available_bytes=avail_bytes,
                total_bytes=capacity.total_bytes,
                warning_tenths=policy.available_space_warning_tenths_percent,
                error_tenths=policy.available_space_error_tenths_percent,
            )

    def _schedule_storage_probes_if_needed(
        self,
        *,
        user_id: uuid.UUID,
        accessible_connections: list[Connection],
        now_monotonic: float,
    ) -> list[StorageProbeEntry]:
        """Schedule non-blocking background probes for due application and active SMB volumes."""

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        stagger_index = 0
        with self._lock:
            data_entry, temp_entry = self._ensure_app_storage_entries()
            for key, entry, target_path in (
                ("data", data_entry, self._data_dir),
                ("temp", temp_entry, self._temp_dir),
            ):
                if loop is not None and self._should_schedule_probe(entry, now_monotonic):
                    entry.in_flight = True
                    entry.last_attempt_monotonic = now_monotonic
                    delay = stagger_index * STORAGE_PROBE_STAGGER_SECONDS
                    stagger_index += 1
                    self._retain_task(loop.create_task(self._probe_posix_entry(key, target_path, stagger_seconds=delay)))

            smb_entries: list[StorageProbeEntry] = []
            for conn in accessible_connections:
                fp = _connection_context_fingerprint(conn)
                prefix = SMBBackend._normalize_prefix(conn.path_prefix)
                share_source = f"//{conn.host}/{conn.share_name}" + (f"/{prefix}" if prefix else "")
                existing = self._smb_cache.get(conn.id)

                if existing is None or existing.context_fingerprint != fp:
                    entry = StorageProbeEntry(
                        metric_id=f"smb-{conn.id}",
                        kind="smb",
                        connection_id=conn.id,
                        label=conn.name,
                        source=share_source,
                        semantics=StorageSpaceSemantics.CALLER_QUOTA,
                        context_fingerprint=fp,
                    )
                    if existing is not None and existing.in_flight:
                        entry.failure_message = (
                            "Connection settings changed. Waiting for the previous storage check to finish before checking this connection."
                        )
                        smb_entries.append(entry)
                        continue
                    if existing is None and len(self._smb_cache) >= MAX_SMB_CACHE_ENTRIES:
                        evictable_id = next((cid for cid, cached in self._smb_cache.items() if not cached.in_flight), None)
                        if evictable_id is None:
                            entry.failure_message = (
                                "Storage check capacity is in use. Wait for an active check to finish; "
                                "this volume will be checked on a later refresh."
                            )
                            smb_entries.append(entry)
                            continue
                        self._smb_cache.pop(evictable_id)
                    self._smb_cache[conn.id] = entry
                else:
                    entry = existing
                    entry.label = conn.name
                    entry.source = share_source
                self._smb_cache.move_to_end(conn.id)

                if loop is not None and entry.context_fingerprint == fp and self._should_schedule_probe(entry, now_monotonic):
                    if self._consume_user_smb_trigger(user_id, now_monotonic):
                        entry.in_flight = True
                        entry.last_attempt_monotonic = now_monotonic
                        delay = stagger_index * STORAGE_PROBE_STAGGER_SECONDS
                        stagger_index += 1
                        conn_copy = conn.model_copy(deep=True)
                        self._retain_task(loop.create_task(self._probe_smb_entry(conn_copy, fp, stagger_seconds=delay)))
                    elif entry.sampled_monotonic is None and entry.failure_availability is None:
                        entry.failure_message = "Storage check queued; waiting for probe rate window."

                smb_entries.append(entry)

            return smb_entries

    def _build_application_storage_reads(
        self,
        *,
        warning_tenths: int,
        error_tenths: int,
        now_monotonic: float,
    ) -> list[StorageMetricRead]:
        with self._lock:
            data_entry, temp_entry = self._ensure_app_storage_entries()
            same_fs = (
                data_entry.filesystem_identity is not None
                and data_entry.filesystem_identity == temp_entry.filesystem_identity
                and data_entry.failure_availability is None
                and temp_entry.failure_availability is None
            )
            if same_fs:
                return [
                    build_storage_metric_read(
                        metric_id="application-combined",
                        kind="application_combined",
                        label="Application data and temporary storage",
                        source=f"{data_entry.source}, {temp_entry.source}",
                        semantics=StorageSpaceSemantics.POSIX_UNPRIVILEGED_BLOCKS,
                        warning_tenths=warning_tenths,
                        error_tenths=error_tenths,
                        now_monotonic=now_monotonic,
                        total_bytes=data_entry.total_bytes,
                        available_bytes=data_entry.available_bytes,
                        actual_free_bytes=None,
                        sampled_at=data_entry.sampled_at,
                        sampled_monotonic=data_entry.sampled_monotonic,
                        severity=data_entry.severity,
                        recovery_pending=data_entry.recovery_pending,
                        failure_availability=data_entry.failure_availability,
                        failure_message=data_entry.failure_message,
                    )
                ]

            return [
                build_storage_metric_read(
                    metric_id=entry.metric_id,
                    kind=entry.kind,
                    label=entry.label,
                    source=entry.source,
                    semantics=entry.semantics,
                    warning_tenths=warning_tenths,
                    error_tenths=error_tenths,
                    now_monotonic=now_monotonic,
                    total_bytes=entry.total_bytes,
                    available_bytes=entry.available_bytes,
                    actual_free_bytes=entry.actual_free_bytes,
                    sampled_at=entry.sampled_at,
                    sampled_monotonic=entry.sampled_monotonic,
                    severity=entry.severity,
                    recovery_pending=entry.recovery_pending,
                    failure_availability=entry.failure_availability,
                    failure_message=entry.failure_message,
                )
                for entry in (data_entry, temp_entry)
            ]

    def build_snapshot(
        self,
        *,
        current_user: User,
        connection_ids: list[uuid.UUID],
        session: Session,
        policy: HealthMonitoringPolicy | None = None,
    ) -> HealthMonitoringSnapshotRead:
        """Return an immediate non-blocking snapshot filtered to resources visible to current_user."""

        resolved_policy = policy if policy is not None else build_health_monitoring_policy(session)
        overrides = load_persisted_cpu_overrides(session)
        now_mono = self._clock_monotonic()
        now_utc = self._clock_utc()

        deduped_ids = list(dict.fromkeys(connection_ids))
        accessible_connections: list[Connection] = []
        for cid in deduped_ids:
            connection = session.get(Connection, cid)
            if connection is not None and can_view_connection(current_user, connection):
                accessible_connections.append(connection)

        assert current_user.id is not None
        smb_entries = self._schedule_storage_probes_if_needed(
            user_id=current_user.id,
            accessible_connections=accessible_connections,
            now_monotonic=now_mono,
        )

        with self._lock:
            host_mem_read, host_mem_req = self._host_memory.read(
                warning_tenths=resolved_policy.memory_warning_tenths_percent,
                error_tenths=resolved_policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )
            load_read, load_req = self._system_load.read(
                warning_hundredths=resolved_policy.load_warning_hundredths,
                error_hundredths=resolved_policy.load_error_hundredths,
                now_monotonic=now_mono,
            )
            cpu_read, cpu_req = self._cpu_temp.read_summary(overrides=overrides, now_monotonic=now_mono)
            cont_read, cont_req = self._container_memory.read(
                warning_tenths=resolved_policy.memory_warning_tenths_percent,
                error_tenths=resolved_policy.memory_error_tenths_percent,
                now_monotonic=now_mono,
            )

            app_storage_reads = self._build_application_storage_reads(
                warning_tenths=resolved_policy.available_space_warning_tenths_percent,
                error_tenths=resolved_policy.available_space_error_tenths_percent,
                now_monotonic=now_mono,
            )
            smb_storage_reads = [
                build_storage_metric_read(
                    metric_id=entry.metric_id,
                    kind="smb",
                    connection_id=entry.connection_id,
                    label=entry.label,
                    source=entry.source,
                    semantics=entry.semantics,
                    warning_tenths=resolved_policy.available_space_warning_tenths_percent,
                    error_tenths=resolved_policy.available_space_error_tenths_percent,
                    now_monotonic=now_mono,
                    total_bytes=entry.total_bytes,
                    available_bytes=entry.available_bytes,
                    actual_free_bytes=entry.actual_free_bytes,
                    sampled_at=entry.sampled_at,
                    sampled_monotonic=entry.sampled_monotonic,
                    severity=entry.severity,
                    recovery_pending=entry.recovery_pending,
                    failure_availability=entry.failure_availability,
                    failure_message=entry.failure_message,
                )
                for entry in smb_entries
            ]

        summary = _compute_summary(
            host_memory=(host_mem_read, host_mem_req),
            system_load=(load_read, load_req),
            cpu_temperature=(cpu_read, cpu_req),
            container_memory=(cont_read, cont_req),
            application_storage=app_storage_reads,
            smb_storage=smb_storage_reads,
        )

        return HealthMonitoringSnapshotRead(
            generated_at=now_utc,
            thresholds=HealthMonitoringThresholdsRead(
                memory_warning_tenths_percent=resolved_policy.memory_warning_tenths_percent,
                memory_error_tenths_percent=resolved_policy.memory_error_tenths_percent,
                load_warning_hundredths=resolved_policy.load_warning_hundredths,
                load_error_hundredths=resolved_policy.load_error_hundredths,
                available_space_warning_tenths_percent=resolved_policy.available_space_warning_tenths_percent,
                available_space_error_tenths_percent=resolved_policy.available_space_error_tenths_percent,
            ),
            summary=summary,
            host_memory=host_mem_read,
            system_load=load_read,
            cpu_temperature=cpu_read,
            container_memory=cont_read,
            application_storage=app_storage_reads,
            smb_storage=smb_storage_reads,
        )

    async def start(self) -> None:
        if self._host_loop_task is not None and not self._host_loop_task.done():
            return
        self._running = True

        policy = build_health_monitoring_policy()
        if policy.enabled:
            await asyncio.to_thread(self.sample_host_once, policy=policy)
            now_mono = self._clock_monotonic()
            with self._lock:
                data_entry, temp_entry = self._ensure_app_storage_entries()
                for idx, (key, entry, target_path) in enumerate(
                    (("data", data_entry, self._data_dir), ("temp", temp_entry, self._temp_dir))
                ):
                    if self._should_schedule_probe(entry, now_monotonic=now_mono):
                        entry.in_flight = True
                        entry.last_attempt_monotonic = now_mono
                        self._retain_task(
                            asyncio.create_task(
                                self._probe_posix_entry(key, target_path, stagger_seconds=idx * STORAGE_PROBE_STAGGER_SECONDS)
                            )
                        )

        async def _host_loop() -> None:
            while self._running:
                try:
                    await asyncio.sleep(HOST_SAMPLE_INTERVAL_SECONDS)
                    await asyncio.to_thread(self.sample_host_once)
                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.warning("Host health sampler iteration failed (%s).", type(exc).__name__)

        self._host_loop_task = asyncio.create_task(_host_loop())

    async def stop(self) -> None:
        self._running = False
        if self._host_loop_task is not None:
            self._host_loop_task.cancel()
            try:
                await self._host_loop_task
            except asyncio.CancelledError:
                pass
            self._host_loop_task = None

        with self._lock:
            tasks = list(self._background_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        self.clear_runtime_state()


def _compute_summary(
    *,
    host_memory: tuple[MemoryMetricRead, bool],
    system_load: tuple[SystemLoadMetricRead, bool],
    cpu_temperature: tuple[CpuTemperatureSummaryRead, bool],
    container_memory: tuple[ContainerMemoryMetricRead, bool],
    application_storage: list[StorageMetricRead],
    smb_storage: list[StorageMetricRead],
) -> HealthSummaryRead:
    all_storage = [*application_storage, *smb_storage]
    checks: list[tuple[str, HealthSeverity, bool]] = [
        ("host_memory", host_memory[0].severity, host_memory[1]),
        ("system_load", system_load[0].severity, system_load[1]),
        ("cpu_temperature", cpu_temperature[0].severity, cpu_temperature[1]),
        ("container_memory", container_memory[0].severity, container_memory[1]),
        *((f"storage:{item.label}", item.severity, True) for item in all_storage),
    ]

    coverage_notes: list[str] = []
    if not host_memory[1]:
        coverage_notes.append("Host memory is not available (optional mount not configured).")
    elif host_memory[0].severity == HealthSeverity.UNKNOWN:
        coverage_notes.append("Host memory data is unavailable or old.")

    if not system_load[1]:
        coverage_notes.append("System load is not available (optional mount not configured).")
    elif system_load[0].severity == HealthSeverity.UNKNOWN:
        coverage_notes.append("System load data is unavailable or old.")

    if cpu_temperature[0].availability in {MetricAvailability.NOT_MOUNTED, MetricAvailability.UNSUPPORTED}:
        coverage_notes.append("CPU temperature is not available.")
    elif cpu_temperature[0].severity == HealthSeverity.INFORMATIONAL:
        coverage_notes.append("CPU temperature limits are not available.")
    elif cpu_temperature[0].severity == HealthSeverity.UNKNOWN:
        coverage_notes.append("CPU temperature data is unavailable or invalid.")
    elif cpu_temperature[0].incomplete_coverage:
        coverage_notes.append("CPU temperature coverage is partial.")

    if container_memory[0].severity == HealthSeverity.UNKNOWN:
        coverage_notes.append("Container memory data is unavailable or old.")

    unavailable_storage = [item for item in all_storage if item.severity == HealthSeverity.UNKNOWN]
    if unavailable_storage:
        coverage_notes.append(
            "One storage volume has unavailable or old capacity data."
            if len(unavailable_storage) == 1
            else f"{len(unavailable_storage)} storage volumes have unavailable or old capacity data."
        )

    timestamps = [
        ts
        for ts in (
            host_memory[0].sampled_at,
            system_load[0].sampled_at,
            cpu_temperature[0].sampled_at,
            container_memory[0].sampled_at,
            *(item.sampled_at for item in all_storage),
        )
        if ts is not None
    ]
    last_updated = max(timestamps) if timestamps else None

    has_error = any(sev == HealthSeverity.ERROR for _, sev, _ in checks)
    has_warning = any(sev == HealthSeverity.WARNING for _, sev, _ in checks)
    has_required_unknown = any(req and sev == HealthSeverity.UNKNOWN for _, sev, req in checks)
    has_ok = any(sev == HealthSeverity.OK for _, sev, _ in checks)

    if has_error:
        agg = AggregateHealthSeverity.ERROR
    elif has_warning:
        agg = AggregateHealthSeverity.WARNING
    elif has_required_unknown or not has_ok:
        agg = AggregateHealthSeverity.UNKNOWN
    else:
        agg = AggregateHealthSeverity.OK

    incomplete = bool(coverage_notes)

    if agg in {AggregateHealthSeverity.ERROR, AggregateHealthSeverity.WARNING}:
        fault_sev = HealthSeverity.ERROR if agg == AggregateHealthSeverity.ERROR else HealthSeverity.WARNING
        fault_storage = [item for item in all_storage if item.severity == fault_sev]
        fault_categories: list[str] = []
        if host_memory[0].severity == fault_sev or container_memory[0].severity == fault_sev:
            fault_categories.append("memory")
        if system_load[0].severity == fault_sev:
            fault_categories.append("system load")
        if cpu_temperature[0].severity == fault_sev:
            fault_categories.append("CPU temperature")
        if fault_storage:
            fault_categories.append("storage")

        if fault_categories == ["storage"]:
            if len(fault_storage) == 1:
                headline = (
                    "One storage volume has critically low free space."
                    if agg == AggregateHealthSeverity.ERROR
                    else "One storage volume has low free space."
                )
            else:
                headline = (
                    f"{len(fault_storage)} storage volumes have critically low free space."
                    if agg == AggregateHealthSeverity.ERROR
                    else f"{len(fault_storage)} storage volumes have low free space."
                )
        elif fault_categories == ["memory"]:
            headline = (
                "Memory usage is at or above the error threshold."
                if agg == AggregateHealthSeverity.ERROR
                else "Memory usage is at or above the warning threshold."
            )
        elif fault_categories == ["system load"]:
            headline = (
                "Normalized 5-minute system load is at or above the error threshold."
                if agg == AggregateHealthSeverity.ERROR
                else "Normalized 5-minute system load is at or above the warning threshold."
            )
        elif fault_categories == ["CPU temperature"]:
            headline = (
                "CPU temperature is at or above the critical threshold."
                if agg == AggregateHealthSeverity.ERROR
                else "CPU temperature is at or above the warning threshold."
            )
        else:
            headline = "Multiple monitored resources require attention."
    elif agg == AggregateHealthSeverity.UNKNOWN:
        headline = "Some required health checks are unavailable or waiting for current data."
    else:
        if coverage_notes == ["CPU temperature is not available."]:
            headline = "Available checks are OK; temperature is not available."
        elif incomplete:
            headline = "Available checks are OK; some optional host checks are not available."
        else:
            headline = "All monitored checks are OK."

    return HealthSummaryRead(
        severity=agg,
        headline=headline,
        incomplete_coverage=incomplete,
        coverage_notes=coverage_notes,
        last_updated_at=last_updated,
    )


_coordinator: HealthMonitoringCoordinator | None = None
_coordinator_lock = threading.Lock()


def get_health_monitoring_coordinator() -> HealthMonitoringCoordinator:
    global _coordinator
    if _coordinator is None:
        with _coordinator_lock:
            if _coordinator is None:
                _coordinator = HealthMonitoringCoordinator()
    return _coordinator


async def start_health_monitoring() -> None:
    await get_health_monitoring_coordinator().start()


async def stop_health_monitoring() -> None:
    global _coordinator
    with _coordinator_lock:
        coordinator = _coordinator
    if coordinator is not None:
        await coordinator.stop()
