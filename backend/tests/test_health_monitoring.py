from __future__ import annotations

import asyncio
import os
import shutil
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import monotonic
from unittest.mock import MagicMock

import pytest
from sqlmodel import Session, select

from app.core.system_setting_definitions import HealthMonitoringAudience
from app.models.connection import Connection
from app.models.health_monitoring import (
    ContainerMemoryLimitState,
    ContainerMemoryMetricRead,
    CpuTemperatureLimitOrigin,
    CpuTemperatureOverrideState,
    HealthMonitoringPolicy,
    HealthSeverity,
    MemoryMetricRead,
    MetricAvailability,
    StorageSpaceSemantics,
    SystemLoadMetricRead,
)
from app.models.system_settings import SystemSetting
from app.models.user import User
from app.services.health_monitoring import (
    MAX_SMB_CACHE_ENTRIES,
    MAX_STORAGE_PROBES_IN_FLIGHT,
    HealthMonitoringCoordinator,
    StorageProbeEntry,
    _compute_summary,
    _connection_context_fingerprint,
)
from app.services.health_monitoring_collectors import (
    ContainerMemoryCollector,
    CpuTemperatureCollector,
    HostMemoryCollector,
    PosixFilesystemCapacity,
    SampleCountEvaluator,
    SystemLoadCollector,
    evaluate_storage_capacity,
)
from app.services.system_settings import store as system_settings_store
from app.storage.smb import SMBBackend, SMBVolumeCapacity
from app.storage.smb_pool import SMBConnectionPool


class FakeClock:
    def __init__(self) -> None:
        self.mono = 1000.0
        self.utc = datetime(2026, 11, 13, 12, 0, 0, tzinfo=timezone.utc)

    def advance(self, seconds: float) -> None:
        self.mono += seconds
        self.utc += timedelta(seconds=seconds)


def _write_hwmon_device(
    sys_root: Path,
    *,
    hwmon_index: int,
    device_rel_path: str,
    driver_name: str,
    files: dict[str, str],
) -> Path:
    device_dir = sys_root / device_rel_path
    hwmon_real_dir = device_dir / "hwmon" / f"hwmon{hwmon_index}"
    hwmon_real_dir.mkdir(parents=True, exist_ok=True)
    (hwmon_real_dir / "name").write_text(f"{driver_name}\n", encoding="utf-8")
    device_symlink = hwmon_real_dir / "device"
    if not device_symlink.exists() and not device_symlink.is_symlink():
        device_symlink.symlink_to(os.path.relpath(device_dir, hwmon_real_dir))

    for filename, value in files.items():
        (hwmon_real_dir / filename).write_text(f"{value}\n", encoding="utf-8")

    class_hwmon = sys_root / "class" / "hwmon"
    class_hwmon.mkdir(parents=True, exist_ok=True)
    entry_link = class_hwmon / f"hwmon{hwmon_index}"
    if entry_link.exists() or entry_link.is_symlink():
        entry_link.unlink()
    entry_link.symlink_to(os.path.relpath(hwmon_real_dir, class_hwmon))
    return hwmon_real_dir


def _write_rpi_thermal_zone(
    sys_root: Path,
    *,
    board_compatible: list[str],
    zone_index: int,
    zone_type: str,
    temp_millidegrees: str,
    trips: list[tuple[int, str, str, str | None]],
) -> Path:
    dt_base = sys_root / "firmware" / "devicetree" / "base"
    dt_base.mkdir(parents=True, exist_ok=True)
    compat_bytes = b"\x00".join(item.encode("utf-8") for item in board_compatible) + b"\x00"
    (dt_base / "compatible").write_bytes(compat_bytes)

    zone_real = sys_root / "devices" / "virtual" / "thermal" / f"thermal_zone{zone_index}"
    zone_real.mkdir(parents=True, exist_ok=True)
    (zone_real / "type").write_text(f"{zone_type}\n", encoding="utf-8")
    (zone_real / "temp").write_text(f"{temp_millidegrees}\n", encoding="utf-8")
    for idx, t_type, t_temp, t_hyst in trips:
        (zone_real / f"trip_point_{idx}_type").write_text(f"{t_type}\n", encoding="utf-8")
        (zone_real / f"trip_point_{idx}_temp").write_text(f"{t_temp}\n", encoding="utf-8")
        if t_hyst is not None:
            (zone_real / f"trip_point_{idx}_hyst").write_text(f"{t_hyst}\n", encoding="utf-8")

    class_thermal = sys_root / "class" / "thermal"
    class_thermal.mkdir(parents=True, exist_ok=True)
    link = class_thermal / f"thermal_zone{zone_index}"
    if link.exists() or link.is_symlink():
        link.unlink()
    link.symlink_to(os.path.relpath(zone_real, class_thermal))
    return zone_real


@pytest.fixture(autouse=True)
def _clean_health_coordinator_and_settings_cache(session: Session):
    from app.services.health_monitoring import get_health_monitoring_coordinator

    system_settings_store.refresh_from_session(session)
    get_health_monitoring_coordinator().clear_runtime_state()
    yield
    get_health_monitoring_coordinator().clear_runtime_state()
    system_settings_store._loaded = False
    system_settings_store._cache.clear()


@pytest.mark.parametrize("sys_mounted", [False, True])
def test_optional_host_sources_are_informational_and_do_not_block_health(tmp_path: Path, sys_mounted: bool) -> None:
    clock = FakeClock()
    memory = HostMemoryCollector(meminfo_path=tmp_path / "meminfo")
    load = SystemLoadCollector(loadavg_path=tmp_path / "loadavg", cpuinfo_path=tmp_path / "cpuinfo")
    sys_root = tmp_path / "sys"
    if sys_mounted:
        sys_root.mkdir()
    cpu = CpuTemperatureCollector(sys_root=sys_root)

    memory.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    load.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    cpu.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    memory_read = memory.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    load_read = load.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    cpu_read = cpu.read_summary(overrides={}, now_monotonic=clock.mono)

    for metric, required in (memory_read, load_read, cpu_read):
        assert metric.severity == HealthSeverity.INFORMATIONAL
        assert required is False
    assert cpu_read[0].availability == (MetricAvailability.UNSUPPORTED if sys_mounted else MetricAvailability.NOT_MOUNTED)
    summary = _compute_summary(
        host_memory=memory_read,
        system_load=load_read,
        cpu_temperature=cpu_read,
        container_memory=(
            ContainerMemoryMetricRead(
                severity=HealthSeverity.OK,
                availability=MetricAvailability.AVAILABLE,
                source="container",
                limit_state=ContainerMemoryLimitState.FINITE,
            ),
            True,
        ),
        application_storage=[],
        smb_storage=[],
    )
    assert summary.severity.value == HealthSeverity.OK.value
    assert summary.incomplete_coverage


def test_system_load_normalization_5m_evaluation_and_no_raw_load_exposed(tmp_path: Path) -> None:
    clock = FakeClock()
    loadavg = tmp_path / "loadavg"
    cpuinfo = tmp_path / "cpuinfo"
    collector = SystemLoadCollector(loadavg_path=loadavg, cpuinfo_path=cpuinfo)

    # Unmounted optional host paths report not_mounted and are not required
    read_unmounted, required = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    assert read_unmounted.severity == HealthSeverity.UNKNOWN
    assert read_unmounted.availability == MetricAvailability.COLLECTING

    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    read_unmounted, required = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    assert read_unmounted.availability == MetricAvailability.NOT_MOUNTED
    assert required is False

    # Partial mount (loadavg without cpuinfo) -> Unknown and required=True, no raw load exposed
    loadavg.write_text("8.00 8.00 8.00 1/200 1234\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    read_missing_cpu, required = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    assert read_missing_cpu.severity == HealthSeverity.UNKNOWN
    assert required is True
    assert read_missing_cpu.normalized_1m is None
    assert read_missing_cpu.normalized_5m is None
    assert read_missing_cpu.normalized_15m is None
    payload = read_missing_cpu.model_dump()
    assert not any("raw" in key or "cpu_usage" in key or "percent" in key for key in payload)

    # Zero CPUs in cpuinfo -> Invalid / Unknown
    cpuinfo.write_text("model name : Synthetic\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    read_zero_cpu, required = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    assert read_zero_cpu.severity == HealthSeverity.UNKNOWN
    assert read_zero_cpu.availability == MetricAvailability.INVALID
    assert required is True

    # 4 logical CPUs: high 1m (3.96 -> 0.99) and high 15m (4.00 -> 1.00), 5m just below 0.75 (2.96 -> 0.74) -> OK!
    cpuinfo.write_text("\n".join(f"processor\t: {i}" for i in range(4)) + "\n", encoding="utf-8")
    loadavg.write_text("3.96 2.96 4.00 2/300 1235\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    read_ok, required = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)
    assert read_ok.severity == HealthSeverity.OK
    assert read_ok.logical_cpu_count == 4
    assert read_ok.normalized_1m == 0.99
    assert read_ok.normalized_5m == 0.74
    assert read_ok.normalized_15m == 1.0

    # Exact Warning boundary: 5m = 3.00 / 4 = 0.75 -> Warning on first sample!
    loadavg.write_text("0.40 3.00 0.40 1/300 1236\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    assert collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING

    # Exact Error boundary: 5m = 3.60 / 4 = 0.90 -> Error on first sample!
    loadavg.write_text("0.40 3.60 0.40 1/300 1237\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    assert collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0].severity == HealthSeverity.ERROR

    # Error recovery requires strictly below max(0.75, 0.90 - 0.10) = 0.80 across TWO samples:
    # At 0.80 (3.20 / 4): does NOT clear Error
    loadavg.write_text("0.40 3.20 0.40 1/300 1238\n", encoding="utf-8")
    for _ in range(2):
        clock.advance(5)
        collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    assert collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0].severity == HealthSeverity.ERROR

    # At 0.79 (3.16 / 4): 1st sample -> recovery_pending=True, still Error; 2nd sample -> recovers to Warning!
    loadavg.write_text("0.40 3.16 0.40 1/300 1239\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    r1 = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0]
    assert r1.severity == HealthSeverity.ERROR
    assert r1.recovery_pending is True
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    r2 = collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0]
    assert r2.severity == HealthSeverity.WARNING

    # Warning recovery requires at or below max(0, 0.75 - 0.10) = 0.65 (2.60 / 4) across 2 samples:
    loadavg.write_text("0.40 2.60 0.40 1/300 1240\n", encoding="utf-8")
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    assert collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING
    clock.advance(5)
    collector.sample(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono, now_utc=clock.utc)
    assert collector.read(warning_hundredths=75, error_hundredths=90, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK


def test_host_and_container_memory_sustained_timing_working_set_and_unlimited_cgroup(tmp_path: Path) -> None:
    clock = FakeClock()
    meminfo = tmp_path / "meminfo"
    cgroup_root = tmp_path / "cgroup"
    cgroup_root.mkdir()

    host_collector = HostMemoryCollector(meminfo_path=meminfo)
    container_collector = ContainerMemoryCollector(cgroup_root=cgroup_root)

    # MemFree is tiny (10 MiB) while MemAvailable is 200 MiB out of 1000 MiB (80% used -> OK, uses MemAvailable!)
    meminfo.write_text(
        "MemTotal:        1024000 kB\nMemFree:           10240 kB\nMemAvailable:     204800 kB\n",
        encoding="utf-8",
    )
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    host_read, _ = host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert host_read.severity == HealthSeverity.OK
    assert host_read.used_tenths_percent == 800

    # Jump to 85.0% used (MemAvailable = 153600 kB): must stay true for 60s before entering Warning
    meminfo.write_text(
        "MemTotal:        1024000 kB\nMemFree:            1024 kB\nMemAvailable:     153600 kB\n",
        encoding="utf-8",
    )
    clock.advance(5)
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK

    for _ in range(11):  # 55s elapsed since breach started -> still OK
        clock.advance(5)
        host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK

    # At 60s sustained -> enters Warning!
    clock.advance(5)
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING

    # Recovery requires <= 80.0% (85% - 5%) for 60s, and missing/stale gaps do NOT advance recovery!
    meminfo.write_text("MemTotal:        1024000 kB\nMemAvailable:     256000 kB\n", encoding="utf-8")
    clock.advance(5)
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    for _ in range(6):  # 30s of valid recovery
        clock.advance(5)
        host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].recovery_pending is True

    # Simulate 40s stale gap -> becomes Unknown/stale, does not recover!
    clock.advance(40)
    stale_read, _ = host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert stale_read.severity == HealthSeverity.UNKNOWN
    assert stale_read.availability == MetricAvailability.STALE
    assert stale_read.is_stale is True

    # Resume sampling: still needs remaining 30s of verified samples before entering OK!
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING
    for _ in range(5):  # +25s -> 55s total verified clear -> still Warning
        clock.advance(5)
        host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING
    clock.advance(5)  # +5s -> 60s verified clear -> OK!
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK

    # Container working-set memory: 950 MiB total current, 600 MiB inactive_file cache on 1000 MiB limit -> 350 MiB (35% -> OK!)
    mib = 1024 * 1024
    (cgroup_root / "memory.max").write_text(str(1000 * mib), encoding="utf-8")
    (cgroup_root / "memory.current").write_text(str(950 * mib), encoding="utf-8")
    (cgroup_root / "memory.stat").write_text(f"anon {350 * mib}\nfile {600 * mib}\nshmem 0\ninactive_file {600 * mib}\n", encoding="utf-8")
    container_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    cont_finite, cont_req = container_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert cont_finite.severity == HealthSeverity.OK
    assert cont_finite.limit_state == ContainerMemoryLimitState.FINITE
    assert cont_finite.working_set_bytes == 350 * mib
    assert cont_finite.used_tenths_percent == 350
    assert cont_req is True

    # Unlimited container cgroup ("max"): working-set bytes shown, no percentage, informational, excluded from aggregate!
    (cgroup_root / "memory.max").write_text("max\n", encoding="utf-8")
    clock.advance(5)
    container_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    cont_unlim, cont_req_unlim = container_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert cont_unlim.severity == HealthSeverity.INFORMATIONAL
    assert cont_unlim.limit_state == ContainerMemoryLimitState.UNLIMITED
    assert cont_unlim.working_set_bytes == 350 * mib
    assert cont_unlim.used_percent is None
    assert cont_unlim.used_tenths_percent is None
    assert cont_unlim.message == "No memory limit configured."
    assert cont_req_unlim is False

    # Malformed container cgroup -> Unknown (never labeled unlimited), while host memory stays OK!
    (cgroup_root / "memory.max").write_text("corrupted\n", encoding="utf-8")
    clock.advance(5)
    host_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    container_collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    cont_bad, cont_req_bad = container_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert cont_bad.severity == HealthSeverity.UNKNOWN
    assert cont_bad.limit_state == ContainerMemoryLimitState.UNKNOWN
    assert cont_bad.message != "No memory limit configured."
    assert cont_req_bad is True
    assert host_collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK


@pytest.mark.parametrize("version", [1, 2])
def test_container_memory_excludes_all_file_cache_but_keeps_shared_memory(tmp_path: Path, version: int) -> None:
    clock = FakeClock()
    mib = 1024 * 1024
    root = tmp_path / "cgroup"
    memory_dir = root if version == 2 else root / "memory"
    memory_dir.mkdir(parents=True)
    if version == 2:
        (memory_dir / "memory.current").write_text(str(1000 * mib))
        (memory_dir / "memory.max").write_text(str(1000 * mib))
        stat = f"file {900 * mib}\nshmem {100 * mib}\ninactive_file {100 * mib}\n"
    else:
        (memory_dir / "memory.usage_in_bytes").write_text(str(1000 * mib))
        (memory_dir / "memory.limit_in_bytes").write_text(str(1000 * mib))
        stat = (
            f"total_cache {900 * mib}\ntotal_shmem {100 * mib}\ntotal_inactive_file {100 * mib}\n"
            f"cache {10 * mib}\nshmem 0\ninactive_file 0\n"
        )
    (memory_dir / "memory.stat").write_text(stat)
    collector = ContainerMemoryCollector(cgroup_root=root)
    for _ in range(13):
        collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
        clock.advance(5)
    reading, required = collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert reading.used_bytes == 200 * mib
    assert reading.cache_bytes == 800 * mib
    assert reading.working_set_bytes == 900 * mib
    assert reading.used_percent == 20
    assert reading.severity == HealthSeverity.OK
    assert required is True
    (memory_dir / "memory.stat").unlink()
    collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    stale, _ = collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert stale.severity == HealthSeverity.UNKNOWN
    assert stale.is_stale is True
    assert stale.used_bytes == reading.used_bytes


@pytest.mark.parametrize(
    "stat",
    [None, "inactive_file 0\n", "file 800\nshmem invalid\ninactive_file 0\n", "file 100\nshmem 200\ninactive_file 0\n"],
)
def test_container_memory_does_not_guess_when_cache_accounting_is_unavailable(tmp_path: Path, stat: str | None) -> None:
    clock = FakeClock()
    (tmp_path / "memory.current").write_text("1000")
    (tmp_path / "memory.max").write_text("2000")
    if stat is not None:
        (tmp_path / "memory.stat").write_text(stat)
    collector = ContainerMemoryCollector(cgroup_root=tmp_path)
    collector.sample(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono, now_utc=clock.utc)
    reading, required = collector.read(warning_tenths=850, error_tenths=950, now_monotonic=clock.mono)
    assert reading.severity == HealthSeverity.UNKNOWN
    assert reading.availability != MetricAvailability.AVAILABLE
    assert reading.used_bytes is None
    assert reading.used_percent is None
    assert reading.message
    assert required is True


def test_cpu_thermal_intel_amd_raspberry_pi_hysteresis_multi_package_and_overrides(tmp_path: Path) -> None:
    clock = FakeClock()

    # 1. Intel coretemp: selects Package id 0, ignores Core 0 and unrelated nvme hwmon, ignores latched crit_alarm
    intel_sys = tmp_path / "intel_sys"
    _write_hwmon_device(
        intel_sys,
        hwmon_index=0,
        device_rel_path="devices/pci0000:00/nvme0",
        driver_name="nvme",
        files={"temp1_input": "95000", "temp1_label": "Composite"},
    )
    pkg0_dir = _write_hwmon_device(
        intel_sys,
        hwmon_index=2,
        device_rel_path="devices/platform/coretemp.0",
        driver_name="coretemp",
        files={
            "temp1_label": "Package id 0",
            "temp1_input": "72000",
            "temp1_max": "85000",
            "temp1_crit": "100000",
            "temp1_crit_alarm": "1",  # Latched historical alarm must NOT trigger Error!
            "temp2_label": "Core 0",
            "temp2_input": "99000",
            "temp2_max": "85000",
            "temp2_crit": "100000",
        },
    )
    intel_collector = CpuTemperatureCollector(sys_root=intel_sys)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    summary, req = intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert req is True
    assert summary.severity == HealthSeverity.OK
    assert summary.current_millidegrees == 72000
    assert summary.detected_warning_millidegrees == 85000
    assert summary.detected_error_millidegrees == 100000
    assert summary.detected_limit_origin == CpuTemperatureLimitOrigin.HARDWARE

    # Warning requires 2 consecutive samples >= 85.0 C; Error is immediate on 1 sample >= 100.0 C
    (pkg0_dir / "temp1_input").write_text("86000\n", encoding="utf-8")
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING

    (pkg0_dir / "temp1_input").write_text("100000\n", encoding="utf-8")
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.ERROR

    # 2.0 C (2000 mC) fallback recovery when hardware hysteresis is absent:
    # Clear Error strictly below 98000, clear Warning at or below 83000 across 2 samples -> direct Error-to-OK at 83000!
    (pkg0_dir / "temp1_input").write_text("83000\n", encoding="utf-8")
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.ERROR
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK

    # Renumbering hwmon2 -> hwmon5 preserves stable source_id!
    old_source_id = summary.source_id
    (intel_sys / "class" / "hwmon" / "hwmon2").unlink()
    _write_hwmon_device(
        intel_sys,
        hwmon_index=5,
        device_rel_path="devices/platform/coretemp.0",
        driver_name="coretemp",
        files={
            "temp1_label": "Package id 0",
            "temp1_input": "70000",
            "temp1_max": "85000",
            "temp1_crit": "100000",
        },
    )
    shutil.rmtree(pkg0_dir)
    clock.advance(5)
    intel_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    renumbered_summary, _ = intel_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert renumbered_summary.source_id == old_source_id
    assert renumbered_summary.current_millidegrees == 70000

    # 2. AMD k10temp: Tctl only, ignores Tdie & Tccd1, no limits -> Informational!
    amd_sys = tmp_path / "amd_sys"
    _write_hwmon_device(
        amd_sys,
        hwmon_index=1,
        device_rel_path="devices/pci0000:00/0000:00:18.3",
        driver_name="k10temp",
        files={
            "temp1_label": "Tctl",
            "temp1_input": "62500",
            "temp2_label": "Tdie",
            "temp2_input": "95000",
            "temp3_label": "Tccd1",
            "temp3_input": "98000",
        },
    )
    amd_collector = CpuTemperatureCollector(sys_root=amd_sys)
    amd_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    amd_summary, amd_req = amd_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert amd_summary.label == "CPU control temperature (Tctl)"
    assert amd_summary.current_millidegrees == 62500
    assert amd_summary.severity == HealthSeverity.INFORMATIONAL
    assert amd_req is False
    assert "Temperature limits are not available" in (amd_summary.message or "")

    # 3. Raspberry Pi 5 fixture: ignores active fan trips, deduplicates cpu_thermal/raspberrypi-hwmon, uses delta hyst!
    rpi_sys = tmp_path / "rpi_sys"
    _write_hwmon_device(
        rpi_sys,
        hwmon_index=0,
        device_rel_path="devices/virtual/hwmon0",
        driver_name="cpu_thermal",
        files={"temp1_input": "99000"},
    )
    _write_hwmon_device(
        rpi_sys,
        hwmon_index=1,
        device_rel_path="devices/platform/soc/rpi-hwmon",
        driver_name="raspberrypi-hwmon",
        files={"temp1_input": "99000"},
    )
    rpi_zone = _write_rpi_thermal_zone(
        rpi_sys,
        board_compatible=["raspberrypi,5-model-b", "brcm,bcm2712"],
        zone_index=2,  # Deliberately non-zero thermal_zone2!
        zone_type="cpu-thermal",
        temp_millidegrees="55000",
        trips=[
            (0, "active", "50000", "5000"),  # Fan trip at 50 C must be IGNORED!
            (1, "active", "67500", "5000"),
            (2, "passive", "85000", "5000"),  # Warning = 85 C, clear = 80 C (delta!)
            (3, "critical", "110000", "5000"),  # Critical = 110 C, clear = 105 C
        ],
    )
    rpi_collector = CpuTemperatureCollector(sys_root=rpi_sys)
    rpi_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    rpi_summary, rpi_req = rpi_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert rpi_req is True
    assert rpi_summary.package_count == 1
    assert rpi_summary.severity == HealthSeverity.OK  # 55 C > 50 C active fan trip, still OK!
    assert rpi_summary.detected_warning_millidegrees == 85000
    assert rpi_summary.detected_error_millidegrees == 110000
    assert rpi_summary.detected_limit_origin == CpuTemperatureLimitOrigin.KERNEL_POLICY

    # Verify thermal-zone delta hysteresis: enter Warning after 2 samples at 85 C, remain Warning at 81 C, clear at 80 C
    (rpi_zone / "temp").write_text("85000\n", encoding="utf-8")
    for _ in range(2):
        clock.advance(5)
        rpi_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert rpi_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING

    (rpi_zone / "temp").write_text("81000\n", encoding="utf-8")
    for _ in range(2):
        clock.advance(5)
        rpi_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert rpi_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.WARNING

    (rpi_zone / "temp").write_text("80000\n", encoding="utf-8")
    for _ in range(2):
        clock.advance(5)
        rpi_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    assert rpi_collector.read_summary(overrides={}, now_monotonic=clock.mono)[0].severity == HealthSeverity.OK

    # 4. Multi-package selection: selects highest severity, then smallest margin to Error, preserves Error when socket 1 faults
    dual_sys = tmp_path / "dual_sys"
    _write_hwmon_device(
        dual_sys,
        hwmon_index=0,
        device_rel_path="devices/platform/coretemp.0",
        driver_name="coretemp",
        files={"temp1_label": "Package id 0", "temp1_input": "70000", "temp1_max": "85000", "temp1_crit": "100000"},
    )
    sock1_dir = _write_hwmon_device(
        dual_sys,
        hwmon_index=1,
        device_rel_path="devices/platform/coretemp.1",
        driver_name="coretemp",
        files={"temp1_label": "Package id 1", "temp1_input": "78000", "temp1_max": "85000", "temp1_crit": "95000"},
    )
    dual_collector = CpuTemperatureCollector(sys_root=dual_sys)
    dual_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    dual_sum, _ = dual_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert dual_sum.package_count == 2
    assert dual_sum.label == "CPU package (Package id 1)"  # Smaller margin to crit (17 C vs 30 C)

    # Socket 0 enters Error while Socket 1 has hardware fault -> Error remains visible + incomplete_coverage=True!
    (dual_sys / "devices/platform/coretemp.0/hwmon/hwmon0/temp1_input").write_text("101000\n", encoding="utf-8")
    (sock1_dir / "temp1_fault").write_text("1\n", encoding="utf-8")
    clock.advance(5)
    dual_collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
    fault_sum, _ = dual_collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert fault_sum.severity == HealthSeverity.ERROR
    assert fault_sum.label == "CPU package (Package id 0)"
    assert fault_sum.incomplete_coverage is True


def test_equal_and_close_threshold_recovery_formulas() -> None:
    # Equal storage thresholds: W = 50 (5.0%), E = 50 (5.0%) -> Error takes precedence at 5.0%!
    # clear_E = min(50, 70) = 50 (strictly > 5.0%), clear_W = min(1000, 70) = 70 (>= 7.0%)
    ev = SampleCountEvaluator()
    sev, _ = evaluate_storage_capacity(ev, available_bytes=50, total_bytes=1000, warning_tenths=50, error_tenths=50)
    assert sev == HealthSeverity.ERROR

    # At 5.0% again: stays Error (does NOT clear because Error requires strictly > 5.0%!)
    sev, _ = evaluate_storage_capacity(ev, available_bytes=50, total_bytes=1000, warning_tenths=50, error_tenths=50)
    assert sev == HealthSeverity.ERROR

    # At 6.0% (60/1000): > 5.0% and < 7.0% -> after 2 readings, transitions Error -> Warning!
    sev, pending = evaluate_storage_capacity(ev, available_bytes=60, total_bytes=1000, warning_tenths=50, error_tenths=50)
    assert sev == HealthSeverity.ERROR and pending is True
    sev, _ = evaluate_storage_capacity(ev, available_bytes=60, total_bytes=1000, warning_tenths=50, error_tenths=50)
    assert sev == HealthSeverity.WARNING

    # At 7.0% (70/1000): >= 7.0% -> after 2 readings, transitions Warning -> OK!
    evaluate_storage_capacity(ev, available_bytes=70, total_bytes=1000, warning_tenths=50, error_tenths=50)
    sev, _ = evaluate_storage_capacity(ev, available_bytes=70, total_bytes=1000, warning_tenths=50, error_tenths=50)
    assert sev == HealthSeverity.OK

    # Zero available bytes gives Error immediately even when E = 0 (0.0%)!
    ev_zero = SampleCountEvaluator()
    sev_zero, _ = evaluate_storage_capacity(ev_zero, available_bytes=0, total_bytes=1000, warning_tenths=10, error_tenths=0)
    assert sev_zero == HealthSeverity.ERROR


def test_settings_validation_audience_authorization_overrides_and_support_report(
    client,
    session: Session,
    auth_headers_admin: dict,
    auth_headers_user: dict,
    auth_headers_viewer: dict,
    user_private_connection: Connection,
    other_private_connection: Connection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.services.health_monitoring as hm_module

    sys_root = tmp_path / "sys"
    pkg_dir = _write_hwmon_device(
        sys_root,
        hwmon_index=0,
        device_rel_path="devices/platform/coretemp.0",
        driver_name="coretemp",
        files={"temp1_label": "Package id 0", "temp1_input": "55000", "temp1_max": "85000", "temp1_crit": "100000"},
    )
    cgroup_root = tmp_path / "cgroup"
    cgroup_root.mkdir()
    (cgroup_root / "memory.max").write_text("max\n", encoding="utf-8")
    (cgroup_root / "memory.current").write_text("104857600\n", encoding="utf-8")
    (cgroup_root / "memory.stat").write_text("file 4194304\nshmem 0\ninactive_file 4194304\n", encoding="utf-8")

    coord = HealthMonitoringCoordinator(
        meminfo_path=tmp_path / "missing_meminfo",
        loadavg_path=tmp_path / "missing_loadavg",
        cpuinfo_path=tmp_path / "missing_cpuinfo",
        sys_root=sys_root,
        cgroup_root=cgroup_root,
        data_dir=tmp_path,
        temp_dir=tmp_path,
    )
    coord.sample_host_once()
    monkeypatch.setattr(hm_module, "get_health_monitoring_coordinator", lambda: coord)

    # Admin settings require admin capability
    assert client.get("/api/admin/settings/health-monitoring", headers=auth_headers_user).status_code == 403
    assert client.get("/api/admin/settings/health-monitoring", headers=auth_headers_viewer).status_code == 403

    settings_resp = client.get("/api/admin/settings/health-monitoring", headers=auth_headers_admin)
    assert settings_resp.status_code == 200
    initial_settings = settings_resp.json()
    assert initial_settings["enabled"] is True
    assert initial_settings["audience"] == HealthMonitoringAudience.ADMINS.value
    assert len(initial_settings["cpu_sources"]) == 1
    cpu_source_id = initial_settings["cpu_sources"][0]["source_id"]

    # Default audience = Admins: admin permitted, editor & viewer forbidden on snapshot
    assert client.get("/api/health-monitoring/policy", headers=auth_headers_admin).json()["permitted"] is True
    assert client.get("/api/health-monitoring/policy", headers=auth_headers_user).json() == {
        "enabled": True,
        "permitted": False,
        "thresholds": None,
        "summary_poll_seconds": 15,
        "dialog_poll_seconds": 5,
        "host_stale_seconds": 15,
        "storage_stale_seconds": 180,
    }
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_user).status_code == 403
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_viewer).status_code == 403

    snap_resp = client.get("/api/health-monitoring/snapshot", headers=auth_headers_admin)
    assert snap_resp.status_code == 200
    assert snap_resp.headers["Cache-Control"] == "no-store"

    # Audience = Editors: editor permitted, admin not in snapshot audience (though admin still manages settings!), viewer forbidden
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "audience", "value": "editors"},
        ).status_code
        == 200
    )
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_user).status_code == 200
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_admin).status_code == 403
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_viewer).status_code == 403
    assert client.get("/api/admin/settings/health-monitoring", headers=auth_headers_admin).status_code == 200

    # Audience = Both: admin & editor permitted, viewer still forbidden; private connections isolated!
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "audience", "value": "both"},
        ).status_code
        == 200
    )
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_viewer).status_code == 403
    leak_check = client.get(
        f"/api/health-monitoring/snapshot?connection_id={other_private_connection.id}",
        headers=auth_headers_user,
    )
    assert leak_check.status_code == 200
    assert leak_check.json()["smb_storage"] == []

    # Reject > 2 connection_ids with 422
    three_ids = "&".join(f"connection_id={uuid.uuid4()}" for _ in range(3))
    assert client.get(f"/api/health-monitoring/snapshot?{three_ids}", headers=auth_headers_admin).status_code == 422

    # Scaled-integer & pair-ordering validation (no float rounding, load > 1.0 accepted!)
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "memory_warning_tenths_percent", "value": 850.5},
        ).status_code
        == 422
    )
    cross_mem = client.put(
        "/api/admin/settings/health-monitoring",
        headers=auth_headers_admin,
        json={"field": "memory_warning_tenths_percent", "value": 960},
    )
    assert cross_mem.status_code == 400
    assert "Increase the memory error threshold first" in cross_mem.json()["detail"]

    cross_space = client.put(
        "/api/admin/settings/health-monitoring",
        headers=auth_headers_admin,
        json={"field": "available_space_error_tenths_percent", "value": 150},
    )
    assert cross_space.status_code == 400
    assert "Increase the available-space warning threshold first" in cross_space.json()["detail"]

    # Load thresholds > 1.0 (e.g. 2.50 = 250 hundredths) and equality are accepted
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "load_error_hundredths", "value": 250},
        ).status_code
        == 200
    )
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "load_warning_hundredths", "value": 250},
        ).status_code
        == 200
    )

    # CPU override validation: reject unknown source_id, reject non-100mC step, accept valid override above detected limit with warning
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "cpu_temp_warning_override", "source_id": "arbitrary:fake:id", "value_millidegrees": 80000},
        ).status_code
        == 400
    )
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "cpu_temp_warning_override", "source_id": cpu_source_id, "value_millidegrees": 80050},
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "cpu_temp_warning_override", "source_id": cpu_source_id, "value_millidegrees": 90000},
        ).status_code
        == 200
    )
    updated_cpu = client.get("/api/admin/settings/health-monitoring", headers=auth_headers_admin).json()["cpu_sources"][0]
    assert updated_cpu["warning_override_millidegrees"] == 90000
    assert updated_cpu["warning_exceeds_detected"] is True
    assert updated_cpu["effective_warning_origin"] == CpuTemperatureLimitOrigin.ADMIN_OVERRIDE.value

    # Hardware-limit change -> review_required when pair still valid; conflict + Unknown when mixed pair becomes invalid!
    (pkg_dir / "temp1_crit").write_text("95000\n", encoding="utf-8")
    coord.sample_host_once()
    review_cpu = client.get("/api/admin/settings/health-monitoring", headers=auth_headers_admin).json()["cpu_sources"][0]
    assert review_cpu["override_state"] == CpuTemperatureOverrideState.REVIEW_REQUIRED.value

    (pkg_dir / "temp1_crit").write_text("88000\n", encoding="utf-8")  # Below 90 C warning override!
    coord.sample_host_once()
    conflict_snap = client.get("/api/health-monitoring/snapshot", headers=auth_headers_admin).json()
    assert conflict_snap["cpu_temperature"]["override_state"] == CpuTemperatureOverrideState.CONFLICT.value
    assert conflict_snap["cpu_temperature"]["severity"] == HealthSeverity.UNKNOWN.value

    # Public Support Report includes [ui_configuration.health_monitoring] with aliased source_id and no raw path
    report = client.get("/api/admin/settings/support-report", headers=auth_headers_admin).json()["content"]
    assert "[ui_configuration.health_monitoring]" in report
    assert "cpu-thermal-source-1" in report
    assert "coretemp.0" not in report

    # Return CPU override to Automatic (null) deletes persisted row
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "cpu_temp_warning_override", "source_id": cpu_source_id, "value_millidegrees": None},
        ).status_code
        == 200
    )
    override_rows = session.exec(select(SystemSetting).where(SystemSetting.key.startswith("health_monitoring.cpu_temp_override."))).all()
    assert override_rows == []

    # Disabling monitoring returns 403 on snapshot and clears RAM state without writing metric rows to DB
    assert (
        client.put(
            "/api/admin/settings/health-monitoring",
            headers=auth_headers_admin,
            json={"field": "enabled", "value": False},
        ).status_code
        == 200
    )
    assert client.get("/api/health-monitoring/snapshot", headers=auth_headers_admin).status_code == 403


@pytest.mark.asyncio
async def test_smb_capacity_non_aborting_timeout_retains_slot_and_preserves_active_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify a timed-out SMB capacity probe never aborts a shared pooled connection and keeps worker permits until exit."""
    import app.storage.smb as smb_module
    import app.storage.smb_pool as smb_pool_module

    pool = SMBConnectionPool()
    monkeypatch.setattr(smb_module, "get_connection_pool", lambda: asyncio.sleep(0, result=pool))
    monkeypatch.setattr(
        smb_pool_module,
        "get_smbclient_policy_kwargs",
        lambda: {
            "encrypt": False,
            "connection_timeout": 30,
            "auth_protocol": "negotiate",
            "require_signing": True,
        },
    )

    fake_transport = MagicMock()
    fake_transport.connected = True
    fake_conn = MagicMock()
    fake_conn.transport = fake_transport
    shared_cache = {"smb.local:445": fake_conn}

    monkeypatch.setattr(smb_pool_module.smbclient, "register_session", lambda *args, **kwargs: None)

    release_stat_volume = threading.Event()
    stat_volume_started = threading.Event()

    def _blocked_stat_volume(_path: str, **_kwargs: object) -> object:
        stat_volume_started.set()
        release_stat_volume.wait(timeout=5.0)
        res = MagicMock()
        res.total_size = 100 * 1024 * 1024 * 1024
        res.caller_available_size = 50 * 1024 * 1024 * 1024
        res.actual_available_size = 80 * 1024 * 1024 * 1024
        return res

    monkeypatch.setattr(smb_module.smbclient, "stat_volume", _blocked_stat_volume)

    backend = SMBBackend(
        host="smb.local",
        share_name="media",
        username="alice",
        password="secret",
        connection_context_key="shared-conn-1",
    )
    backend._connection_cache = shared_cache

    worker_exited = False

    def _mark_exit() -> None:
        nonlocal worker_exited
        worker_exited = True

    # Simulate an active file operation holding a lease on the exact same pooled connection
    async with pool.get_connection("smb.local", 445, "alice", "secret", "media", connection_cache=shared_cache):
        with pytest.raises(Exception):
            await backend.get_volume_capacity(timeout_seconds=0.05, on_worker_exit=_mark_exit)

        assert stat_volume_started.is_set()
        # Crucial checks: shared transport was NOT aborted or disconnected, and worker exit callback has NOT fired yet!
        assert not pool.generation_aborting(shared_cache)
        fake_transport.disconnect.assert_not_called()
        assert worker_exited is False
        assert pool.get_stats()["total_references"] >= 2  # Active operation + retained timed-out capacity worker

        # Unblock the worker thread and verify clean release
        release_stat_volume.set()
        for _ in range(40):
            if worker_exited:
                break
            await asyncio.sleep(0.02)
        assert worker_exited is True


@pytest.mark.asyncio
async def test_storage_cache_interval_rate_limit_two_probe_cap_and_lru_eviction(
    session: Session,
    admin_user: User,
    tmp_path: Path,
) -> None:
    clock = FakeClock()
    statvfs_calls = 0

    def _fake_statvfs(_path: Path) -> PosixFilesystemCapacity:
        nonlocal statvfs_calls
        statvfs_calls += 1
        return PosixFilesystemCapacity(
            filesystem_identity=(1, 1),
            total_bytes=100 * 1024**3,
            available_bytes=40 * 1024**3,
        )

    smb_calls: list[str] = []

    class FakeSMBBackend:
        def __init__(self, conn: Connection) -> None:
            self._conn = conn

        async def connect(self) -> None:
            return None

        async def disconnect(self) -> None:
            return None

        async def get_volume_capacity(self, *, timeout_seconds: float = 10.0, on_worker_exit=None) -> SMBVolumeCapacity:
            smb_calls.append(self._conn.name)
            try:
                return SMBVolumeCapacity(
                    total_bytes=1000 * 1024**3,
                    caller_available_bytes=250 * 1024**3,
                    actual_available_bytes=500 * 1024**3,
                )
            finally:
                if on_worker_exit is not None:
                    on_worker_exit()

    coord = HealthMonitoringCoordinator(
        meminfo_path=tmp_path / "no_mem",
        loadavg_path=tmp_path / "no_load",
        cpuinfo_path=tmp_path / "no_cpu",
        sys_root=tmp_path / "no_sys",
        cgroup_root=tmp_path / "no_cg",
        data_dir=tmp_path,
        temp_dir=tmp_path,
        smb_backend_builder=FakeSMBBackend,  # type: ignore[arg-type]
        posix_statvfs_fn=_fake_statvfs,
        clock_monotonic=lambda: clock.mono,
        clock_utc=lambda: clock.utc,
    )

    from app.core.security import encrypt_password
    from app.models.connection import ConnectionScope

    conns = []
    for i in range(6):
        c = Connection(
            id=uuid.uuid4(),
            name=f"Share-{i}",
            slug=f"share-{i}",
            host=f"nas-{i}.local",
            share_name="data",
            username="u",
            password_encrypted=encrypt_password("p"),
            port=445,
            scope=ConnectionScope.SHARED,
        )
        session.add(c)
        conns.append(c)
    session.commit()

    # Duplicate connection_ids in dual-pane deduplicate to one probe
    snap1 = coord.build_snapshot(
        current_user=admin_user,
        connection_ids=[conns[0].id, conns[0].id],
        session=session,
        policy=HealthMonitoringPolicy(),
    )
    assert len(snap1.smb_storage) == 1
    await asyncio.sleep(0.35)

    assert smb_calls == ["Share-0"]
    snap_cached = coord.build_snapshot(
        current_user=admin_user,
        connection_ids=[conns[0].id],
        session=session,
        policy=HealthMonitoringPolicy(),
    )
    assert snap_cached.smb_storage[0].severity == HealthSeverity.OK
    assert snap_cached.smb_storage[0].label == conns[0].name
    assert snap_cached.smb_storage[0].semantics == StorageSpaceSemantics.CALLER_QUOTA
    assert snap_cached.smb_storage[0].available_bytes == 250 * 1024**3
    assert snap_cached.smb_storage[0].actual_free_bytes == 500 * 1024**3
    # Same-filesystem data/temp deduplicated into one combined entry
    assert len(snap_cached.application_storage) == 1
    assert snap_cached.application_storage[0].kind == "application_combined"

    # Repeated snapshot refreshes within 60s trigger ZERO additional SMB or POSIX probes!
    prev_statvfs = statvfs_calls
    for _ in range(5):
        clock.advance(5)
        coord.build_snapshot(
            current_user=admin_user,
            connection_ids=[conns[0].id],
            session=session,
            policy=HealthMonitoringPolicy(),
        )
    await asyncio.sleep(0.1)
    assert smb_calls == ["Share-0"]
    assert statvfs_calls == prev_statvfs

    # Per-user SMB trigger rate limit: at most 4 new SMB probes within 60s (1 already used -> only 3 of next 5 run!)
    for idx in range(1, 6):
        coord.build_snapshot(
            current_user=admin_user,
            connection_ids=[conns[idx].id],
            session=session,
            policy=HealthMonitoringPolicy(),
        )
    await asyncio.sleep(0.4)
    assert len(smb_calls) == 4  # Share-0 + Share-1 + Share-2 + Share-3; Share-4 and Share-5 rate-capped!

    # Bounded LRU eviction at MAX_SMB_CACHE_ENTRIES (32)
    for i in range(40):
        clock.advance(65)
        extra = Connection(
            id=uuid.uuid4(),
            name=f"LRU-{i}",
            slug=f"lru-{i}",
            host=f"lru-{i}.local",
            share_name="data",
            username="u",
            password_encrypted=encrypt_password("p"),
            port=445,
            scope=ConnectionScope.SHARED,
        )
        session.add(extra)
        session.commit()
        coord.build_snapshot(
            current_user=admin_user,
            connection_ids=[extra.id],
            session=session,
            policy=HealthMonitoringPolicy(),
        )
    await asyncio.sleep(0.4)
    assert len(coord._smb_cache) <= MAX_SMB_CACHE_ENTRIES


@pytest.mark.parametrize(
    ("temperature", "expected"),
    [(70000, HealthSeverity.UNKNOWN), (86000, HealthSeverity.WARNING), (100000, HealthSeverity.ERROR)],
)
def test_cpu_package_failure_does_not_hide_unknown_or_known_faults(tmp_path: Path, temperature: int, expected: HealthSeverity) -> None:
    for index, value in enumerate((str(temperature), "invalid")):
        _write_hwmon_device(
            tmp_path,
            hwmon_index=index,
            device_rel_path=f"devices/platform/coretemp.{index}",
            driver_name="coretemp",
            files={
                "temp1_label": f"Package id {index}",
                "temp1_input": value,
                "temp1_max": "85000",
                "temp1_crit": "100000",
            },
        )
    collector = CpuTemperatureCollector(sys_root=tmp_path)
    clock = FakeClock()
    for _ in range(2):
        collector.sample(overrides={}, now_monotonic=clock.mono, now_utc=clock.utc)
        clock.advance(5)
    thermal = collector.read_summary(overrides={}, now_monotonic=clock.mono)
    assert thermal[0].severity == expected
    assert thermal[0].incomplete_coverage
    assert thermal[0].assessed_package_count == 1
    assert thermal[1]

    summary = _compute_summary(
        host_memory=(
            MemoryMetricRead(
                severity=HealthSeverity.OK,
                availability=MetricAvailability.AVAILABLE,
                source="host",
                warning_tenths_percent=850,
                error_tenths_percent=950,
            ),
            True,
        ),
        system_load=(
            SystemLoadMetricRead(
                severity=HealthSeverity.OK,
                availability=MetricAvailability.AVAILABLE,
                source="host",
                warning_hundredths=75,
                error_hundredths=90,
            ),
            True,
        ),
        cpu_temperature=thermal,
        container_memory=(
            ContainerMemoryMetricRead(
                severity=HealthSeverity.INFORMATIONAL,
                availability=MetricAvailability.AVAILABLE,
                source="container",
                limit_state=ContainerMemoryLimitState.UNLIMITED,
            ),
            False,
        ),
        application_storage=[],
        smb_storage=[],
    )
    assert summary.severity.value == expected.value


@pytest.mark.asyncio
async def test_busy_smb_cache_defers_admission_without_losing_probe_ownership(tmp_path: Path) -> None:
    clock = FakeClock()
    backend = MagicMock(spec=SMBBackend)
    capacity = SMBVolumeCapacity(total_bytes=1000, caller_available_bytes=400, actual_available_bytes=500)

    async def read_capacity(*, on_worker_exit) -> SMBVolumeCapacity:
        on_worker_exit()
        return capacity

    backend.get_volume_capacity.side_effect = read_capacity
    coord = HealthMonitoringCoordinator(
        data_dir=tmp_path,
        temp_dir=tmp_path,
        smb_backend_builder=lambda _conn: backend,
        clock_monotonic=lambda: clock.mono,
        clock_utc=lambda: clock.utc,
    )
    for entry in coord._ensure_app_storage_entries():
        entry.in_flight = True
    for _ in range(MAX_SMB_CACHE_ENTRIES):
        connection_id = uuid.uuid4()
        coord._smb_cache[connection_id] = StorageProbeEntry(
            metric_id=f"smb-{connection_id}",
            kind="smb",
            label="Busy share",
            source="//nas/data",
            semantics=StorageSpaceSemantics.CALLER_QUOTA,
            in_flight=True,
        )
    connection = Connection(
        id=uuid.uuid4(),
        name="New share",
        slug="new-share",
        host="new.local",
        share_name="data",
        username="user",
        password_encrypted="test",
    )
    user_id = uuid.uuid4()
    for _ in range(3):
        reads = coord._schedule_storage_probes_if_needed(
            user_id=user_id,
            accessible_connections=[connection],
            now_monotonic=clock.mono,
        )
        assert reads[0].severity == HealthSeverity.UNKNOWN
        assert reads[0].failure_message
        assert connection.id not in coord._smb_cache
        assert not coord._background_tasks
        assert not coord._user_smb_triggers
        assert len(coord._smb_cache) == MAX_SMB_CACHE_ENTRIES

    oldest_id = next(iter(coord._smb_cache))
    coord._smb_cache[oldest_id].in_flight = False
    for _ in range(2):
        coord._schedule_storage_probes_if_needed(
            user_id=user_id,
            accessible_connections=[connection],
            now_monotonic=clock.mono,
        )
    assert oldest_id not in coord._smb_cache
    assert connection.id in coord._smb_cache
    assert len(coord._smb_cache) == MAX_SMB_CACHE_ENTRIES
    assert len(coord._background_tasks) == 1
    await asyncio.gather(*coord._background_tasks)
    backend.get_volume_capacity.assert_awaited_once()
    assert coord._smb_cache[connection.id].available_bytes == capacity.caller_available_bytes
    assert not coord._smb_cache[connection.id].in_flight
    assert coord.active_probe_slots == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("host", "new.local"),
        ("share_name", "new-share"),
        ("path_prefix", "/new-path"),
        ("username", "new-user"),
        ("password_encrypted", "new-credentials"),
    ],
)
async def test_smb_context_change_hides_old_readings_until_worker_exit(
    tmp_path: Path,
    field: str,
    value: str,
    session: Session,
    admin_user: User,
) -> None:
    clock = FakeClock()
    worker_started = asyncio.Event()
    worker_exit = asyncio.Event()
    backend = MagicMock(spec=SMBBackend)

    async def read_capacity(*, on_worker_exit) -> SMBVolumeCapacity:
        worker_started.set()
        await worker_exit.wait()
        on_worker_exit()
        return SMBVolumeCapacity(total_bytes=1000, caller_available_bytes=400, actual_available_bytes=500)

    backend.get_volume_capacity.side_effect = read_capacity
    coord = HealthMonitoringCoordinator(
        data_dir=tmp_path,
        temp_dir=tmp_path,
        smb_backend_builder=lambda _conn: backend,
        clock_monotonic=lambda: clock.mono,
        clock_utc=lambda: clock.utc,
    )
    for entry in coord._ensure_app_storage_entries():
        entry.in_flight = True
    connection = Connection(
        id=uuid.uuid4(),
        name="Share",
        slug="share",
        host="old.local",
        share_name="old-share",
        path_prefix="/old-path",
        username="old-user",
        password_encrypted="old-credentials",
        owner_user_id=admin_user.id,
    )
    session.add(connection)
    session.commit()
    old_fingerprint = _connection_context_fingerprint(connection)
    entry = StorageProbeEntry(
        metric_id=f"smb-{connection.id}",
        kind="smb",
        label="Share",
        source="//old.local/old-share",
        semantics=StorageSpaceSemantics.CALLER_QUOTA,
        connection_id=connection.id,
        context_fingerprint=old_fingerprint,
        in_flight=True,
        total_bytes=1000,
        available_bytes=250,
        sampled_at=clock.utc,
        sampled_monotonic=clock.mono,
        severity=HealthSeverity.OK,
    )
    coord._smb_cache[connection.id] = entry
    probe = asyncio.create_task(coord._probe_smb_entry(connection.model_copy(deep=True), old_fingerprint, stagger_seconds=0))
    try:
        await asyncio.wait_for(worker_started.wait(), timeout=1)
        coord.invalidate_smb_connection(connection.id)
        setattr(connection, field, value)
        session.add(connection)
        session.commit()
        for _ in range(2):
            snapshot = coord.build_snapshot(
                current_user=admin_user,
                connection_ids=[connection.id],
                session=session,
                policy=HealthMonitoringPolicy(),
            )
            reading = snapshot.smb_storage[0]
            assert reading.severity == HealthSeverity.UNKNOWN
            assert reading.available_bytes is None
            assert reading.total_bytes is None
            assert reading.sampled_at is None
            assert reading.message
            assert coord._smb_cache[connection.id] is entry
            assert entry.in_flight
            assert coord.active_probe_slots == 1
            assert not coord._background_tasks
        worker_exit.set()
        await probe
        assert entry.available_bytes == 250
        assert not entry.in_flight
        assert coord.active_probe_slots == 0

        coord.build_snapshot(
            current_user=admin_user,
            connection_ids=[connection.id],
            session=session,
            policy=HealthMonitoringPolicy(),
        )
        await asyncio.gather(*coord._background_tasks)
        assert coord._smb_cache[connection.id] is not entry
        assert coord._smb_cache[connection.id].context_fingerprint == _connection_context_fingerprint(connection)
        assert coord._smb_cache[connection.id].available_bytes == 400
    finally:
        worker_exit.set()
        await probe
        await coord.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["posix", "smb"])
async def test_cancelling_queued_probe_clears_its_in_flight_flag(tmp_path: Path, kind: str) -> None:
    coord = HealthMonitoringCoordinator(data_dir=tmp_path, temp_dir=tmp_path)
    if kind == "posix":
        entry = coord._ensure_app_storage_entries()[0]
        coroutine = coord._probe_posix_entry("data", tmp_path, stagger_seconds=0)
    else:
        connection = Connection(id=uuid.uuid4(), name="Share", slug="share", host="nas.local", share_name="data")
        entry = StorageProbeEntry(
            metric_id=f"smb-{connection.id}",
            kind="smb",
            label="Share",
            source="//nas.local/data",
            semantics=StorageSpaceSemantics.CALLER_QUOTA,
        )
        coord._smb_cache[connection.id] = entry
        coroutine = coord._probe_smb_entry(connection, "fingerprint", stagger_seconds=0)
    entry.in_flight = True
    for _ in range(MAX_STORAGE_PROBES_IN_FLIGHT):
        await coord._acquire_probe_slot()
    probe = asyncio.create_task(coroutine)
    try:
        await asyncio.sleep(0)
        assert not probe.done()
        probe.cancel()
        with pytest.raises(asyncio.CancelledError):
            await probe
        assert not entry.in_flight
        assert coord.active_probe_slots == MAX_STORAGE_PROBES_IN_FLIGHT
    finally:
        for _ in range(MAX_STORAGE_PROBES_IN_FLIGHT):
            coord._release_probe_slot()
        await coord.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_probe", [False, True])
async def test_posix_probe_retains_slot_until_timed_out_or_cancelled_worker_exits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cancel_probe: bool
) -> None:
    import app.services.health_monitoring as monitoring

    monkeypatch.setattr(monitoring, "STORAGE_PROBE_TIMEOUT_SECONDS", 0.05)
    started = asyncio.Event()
    release_worker = threading.Event()
    loop = asyncio.get_running_loop()
    worker_count = 0

    def blocked_statvfs(_path: Path) -> PosixFilesystemCapacity:
        nonlocal worker_count
        worker_count += 1
        loop.call_soon_threadsafe(started.set)
        if not release_worker.wait(timeout=5):
            raise TimeoutError("Test did not release its capacity worker.")
        return PosixFilesystemCapacity(filesystem_identity=(1, 1), total_bytes=1000, available_bytes=400)

    coord = HealthMonitoringCoordinator(data_dir=tmp_path, temp_dir=tmp_path, posix_statvfs_fn=blocked_statvfs)
    entry, temp_entry = coord._ensure_app_storage_entries()
    entry.in_flight = True
    temp_entry.in_flight = True
    probe = asyncio.create_task(coord._probe_posix_entry("data", tmp_path, stagger_seconds=0))
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        if cancel_probe:
            probe.cancel()
            with pytest.raises(asyncio.CancelledError):
                await probe
        else:
            await probe
            assert entry.failure_availability == MetricAvailability.TIMEOUT

        assert entry.in_flight
        assert coord.active_probe_slots == 1
        coord._schedule_storage_probes_if_needed(user_id=uuid.uuid4(), accessible_connections=[], now_monotonic=monotonic())
        assert not coord._background_tasks
        assert worker_count == 1
    finally:
        release_worker.set()

        async def wait_for_worker_exit() -> None:
            while coord.active_probe_slots:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(wait_for_worker_exit(), timeout=1)
        await asyncio.gather(probe, return_exceptions=True)
        await coord.stop()
    assert not entry.in_flight
