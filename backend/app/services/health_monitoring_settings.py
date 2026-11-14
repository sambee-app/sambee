from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.core.logging import get_logger
from app.core.system_setting_definitions import (
    DEFAULT_HEALTH_MONITORING_AUDIENCE,
    DEFAULT_HEALTH_MONITORING_ENABLED,
    HEALTH_MONITORING_CPU_OVERRIDE_KEY_PREFIX,
    HEALTH_MONITORING_SETTING_KEYS,
    SYSTEM_SETTING_DEFINITIONS,
    HealthMonitoringAudience,
    SystemSettingKey,
    SystemSettingSource,
)
from app.models.health_monitoring import (
    CpuTemperatureLimitOrigin,
    CpuTemperatureOverrideState,
    CpuTemperatureSourceSettingsRead,
    HealthMonitoringClientPolicyRead,
    HealthMonitoringCpuTempErrorOverrideUpdate,
    HealthMonitoringCpuTempWarningOverrideUpdate,
    HealthMonitoringIntegerThresholdUpdate,
    HealthMonitoringPolicy,
    HealthMonitoringSettingsRead,
    HealthMonitoringSettingsUpdate,
    HealthMonitoringSettingsUpdateResult,
    HealthMonitoringThresholdsRead,
    MetricAvailability,
    PersistedCpuTempOverride,
    format_hundredths,
    format_millidegrees_celsius,
    format_tenths_percent,
)
from app.models.system_settings import IntegerSystemSettingRead, SystemSetting
from app.models.user import User, UserRole
from app.services.system_settings import (
    PublicSupportReportAliases,
    _append_report_setting,
    _begin_immediate_transaction,
    _parse_override_value,
    _write_system_setting,
    store,
)

logger = get_logger(__name__)


def cpu_override_setting_key(source_id: str) -> str:
    digest = hashlib.sha256(source_id.encode("utf-8")).hexdigest()
    return f"{HEALTH_MONITORING_CPU_OVERRIDE_KEY_PREFIX}{digest}"


def can_view_health_monitoring(user: User, policy: HealthMonitoringPolicy) -> bool:
    """Enforce audience visibility on backend policy and snapshot reads."""

    if not policy.enabled:
        return False
    if user.role == UserRole.VIEWER:
        return False
    if policy.audience == HealthMonitoringAudience.ADMINS:
        return user.role == UserRole.ADMIN
    if policy.audience == HealthMonitoringAudience.EDITORS:
        return user.role == UserRole.EDITOR
    return user.role in {UserRole.ADMIN, UserRole.EDITOR}


def _parse_bool_setting(raw_value: str | None, *, default: bool, key: SystemSettingKey) -> tuple[bool, SystemSettingSource]:
    if raw_value is None:
        return default, SystemSettingSource.DEFAULT
    normalized = raw_value.strip().lower()
    if normalized == "true":
        return True, SystemSettingSource.DATABASE
    if normalized == "false":
        return False, SystemSettingSource.DATABASE
    raise ValueError(f"Stored override for {key.value} is not a valid boolean.")


def _parse_audience_setting(raw_value: str | None) -> tuple[HealthMonitoringAudience, SystemSettingSource]:
    if raw_value is None:
        return DEFAULT_HEALTH_MONITORING_AUDIENCE, SystemSettingSource.DEFAULT
    return HealthMonitoringAudience(raw_value.strip()), SystemSettingSource.DATABASE


def load_persisted_cpu_overrides(session: Session | None = None) -> dict[str, PersistedCpuTempOverride]:
    """Load persisted per-source CPU temperature overrides from the system settings table."""

    if session is not None:
        rows = session.exec(select(SystemSetting).where(SystemSetting.key.startswith(HEALTH_MONITORING_CPU_OVERRIDE_KEY_PREFIX))).all()
        raw_items = [(row.key, row.value) for row in rows]
    else:
        raw_items = sorted(store.get_overrides_by_prefix(HEALTH_MONITORING_CPU_OVERRIDE_KEY_PREFIX).items())

    overrides: dict[str, PersistedCpuTempOverride] = {}
    for key, raw_value in raw_items:
        try:
            payload = json.loads(raw_value)
            parsed = PersistedCpuTempOverride.model_validate(payload)
        except Exception as exc:
            logger.error("Ignoring malformed CPU temperature override row %s: %s", key, exc)
            continue
        if parsed.warning_override_millidegrees is None and parsed.error_override_millidegrees is None:
            continue
        overrides[parsed.source_id] = parsed
    return overrides


def resolve_cpu_override_evaluation(
    *,
    detected_max: int | None,
    detected_crit: int | None,
    detected_origin: CpuTemperatureLimitOrigin | None,
    override: PersistedCpuTempOverride | None,
) -> tuple[
    int | None,
    CpuTemperatureLimitOrigin | None,
    int | None,
    CpuTemperatureLimitOrigin | None,
    bool,
    bool,
    CpuTemperatureOverrideState,
    str | None,
]:
    """Resolve effective CPU thresholds, exceed warnings, and hardware-limit change/conflict state."""

    warn_override = override.warning_override_millidegrees if override is not None else None
    err_override = override.error_override_millidegrees if override is not None else None
    has_override = warn_override is not None or err_override is not None

    eff_warn = warn_override if warn_override is not None else detected_max
    eff_warn_origin = (
        CpuTemperatureLimitOrigin.ADMIN_OVERRIDE if warn_override is not None else (detected_origin if detected_max is not None else None)
    )
    eff_err = err_override if err_override is not None else detected_crit
    eff_err_origin = (
        CpuTemperatureLimitOrigin.ADMIN_OVERRIDE if err_override is not None else (detected_origin if detected_crit is not None else None)
    )

    warn_exceeds = bool(warn_override is not None and detected_max is not None and warn_override > detected_max)
    err_exceeds = bool(err_override is not None and detected_crit is not None and err_override > detected_crit)

    if not has_override or override is None:
        return (
            eff_warn,
            eff_warn_origin,
            eff_err,
            eff_err_origin,
            False,
            False,
            CpuTemperatureOverrideState.NONE,
            None,
        )

    hardware_limits_changed = (detected_max is not None and override.observed_max_millidegrees != detected_max) or (
        detected_crit is not None and override.observed_crit_millidegrees != detected_crit
    )
    if eff_warn is not None and eff_err is not None and eff_warn > eff_err:
        return (
            eff_warn,
            eff_warn_origin,
            eff_err,
            eff_err_origin,
            warn_exceeds,
            err_exceeds,
            CpuTemperatureOverrideState.CONFLICT,
            (
                f"Effective CPU warning threshold ({format_millidegrees_celsius(eff_warn)}) exceeds the effective error threshold "
                f"({format_millidegrees_celsius(eff_err)}) after a hardware or policy limit change. "
                "Adjust, reconfirm, or clear the override in Health Monitoring settings."
            ),
        )

    if hardware_limits_changed:
        return (
            eff_warn,
            eff_warn_origin,
            eff_err,
            eff_err_origin,
            warn_exceeds,
            err_exceeds,
            CpuTemperatureOverrideState.REVIEW_REQUIRED,
            (
                "Detected CPU temperature limits changed since this override was saved. "
                "Reconfirm, adjust, or return the override to Automatic in Health Monitoring settings."
            ),
        )

    return (
        eff_warn,
        eff_warn_origin,
        eff_err,
        eff_err_origin,
        warn_exceeds,
        err_exceeds,
        CpuTemperatureOverrideState.ACTIVE,
        None,
    )


def build_health_monitoring_policy(session: Session | None = None) -> HealthMonitoringPolicy:
    """Return the validated Health Monitoring policy for runtime callers."""

    if session is not None:
        return build_health_monitoring_settings_read(session, include_cpu_discovery=False).policy

    enabled_raw = store.get_override(SystemSettingKey.HEALTH_MONITORING_ENABLED)
    audience_raw = store.get_override(SystemSettingKey.HEALTH_MONITORING_AUDIENCE)
    try:
        enabled, _ = _parse_bool_setting(
            enabled_raw,
            default=DEFAULT_HEALTH_MONITORING_ENABLED,
            key=SystemSettingKey.HEALTH_MONITORING_ENABLED,
        )
        audience, _ = _parse_audience_setting(audience_raw)
        values: dict[str, object] = {"enabled": enabled, "audience": audience}
        for field_name, key in HEALTH_MONITORING_SETTING_KEYS.items():
            definition = SYSTEM_SETTING_DEFINITIONS[key]
            raw_override = store.get_override(key)
            values[field_name] = definition.default_value if raw_override is None else _parse_override_value(definition, raw_override)
        return HealthMonitoringPolicy.model_validate(values)
    except ValueError as exc:
        logger.error("Invalid persisted Health Monitoring policy; falling back to defaults: %s", exc)
        return HealthMonitoringPolicy()


def build_client_policy_read(current_user: User, session: Session | None = None) -> HealthMonitoringClientPolicyRead:
    policy = build_health_monitoring_policy(session)
    permitted = can_view_health_monitoring(current_user, policy)
    if not permitted:
        return HealthMonitoringClientPolicyRead(enabled=policy.enabled, permitted=False, thresholds=None)
    return HealthMonitoringClientPolicyRead(
        enabled=policy.enabled,
        permitted=True,
        thresholds=HealthMonitoringThresholdsRead(
            memory_warning_tenths_percent=policy.memory_warning_tenths_percent,
            memory_error_tenths_percent=policy.memory_error_tenths_percent,
            load_warning_hundredths=policy.load_warning_hundredths,
            load_error_hundredths=policy.load_error_hundredths,
            available_space_warning_tenths_percent=policy.available_space_warning_tenths_percent,
            available_space_error_tenths_percent=policy.available_space_error_tenths_percent,
        ),
    )


def build_health_monitoring_settings_read(
    session: Session,
    *,
    include_cpu_discovery: bool = True,
) -> HealthMonitoringSettingsRead:
    enabled_row = session.get(SystemSetting, SystemSettingKey.HEALTH_MONITORING_ENABLED.value)
    audience_row = session.get(SystemSetting, SystemSettingKey.HEALTH_MONITORING_AUDIENCE.value)
    enabled, enabled_source = _parse_bool_setting(
        enabled_row.value if enabled_row is not None else None,
        default=DEFAULT_HEALTH_MONITORING_ENABLED,
        key=SystemSettingKey.HEALTH_MONITORING_ENABLED,
    )
    audience, audience_source = _parse_audience_setting(audience_row.value if audience_row is not None else None)

    fields: dict[str, IntegerSystemSettingRead] = {}
    values: dict[str, object] = {"enabled": enabled, "audience": audience}
    for field_name, key in HEALTH_MONITORING_SETTING_KEYS.items():
        definition = SYSTEM_SETTING_DEFINITIONS[key]
        override_row = session.get(SystemSetting, key.value)
        resolved_value = definition.default_value if override_row is None else _parse_override_value(definition, override_row.value)
        values[field_name] = resolved_value
        fields[field_name] = IntegerSystemSettingRead(
            key=key,
            label=definition.label,
            description=definition.description,
            value=resolved_value,
            source=SystemSettingSource.DEFAULT if override_row is None else SystemSettingSource.DATABASE,
            default_value=definition.default_value,
            min_value=definition.min_value,
            max_value=definition.max_value,
            step=definition.step,
        )

    policy = HealthMonitoringPolicy.model_validate(values)
    cpu_sources: list[CpuTemperatureSourceSettingsRead] = []
    discovery_status = MetricAvailability.NOT_MOUNTED
    discovery_message: str | None = None

    if include_cpu_discovery:
        from app.services.health_monitoring import get_health_monitoring_coordinator

        persisted_overrides = load_persisted_cpu_overrides(session)
        cpu_sources, discovery_status, discovery_message = get_health_monitoring_coordinator().describe_cpu_sources_for_settings(
            persisted_overrides
        )

    return HealthMonitoringSettingsRead(
        enabled=enabled,
        enabled_source=enabled_source,
        audience=audience,
        audience_source=audience_source,
        policy=policy,
        fields=fields,
        cpu_sources=cpu_sources,
        cpu_sensor_discovery_status=discovery_status,
        cpu_sensor_discovery_message=discovery_message,
    )


def _describe_threshold_pair_error(payload: HealthMonitoringIntegerThresholdUpdate, current: HealthMonitoringPolicy) -> str:
    field = payload.field
    val = payload.value
    if field == "memory_warning_tenths_percent" and val > current.memory_error_tenths_percent:
        err_text = format_tenths_percent(current.memory_error_tenths_percent)
        return (
            f"Memory warning threshold cannot exceed the memory error threshold ({err_text}). "
            f"Increase the memory error threshold first or enter {err_text} or lower."
        )
    if field == "memory_error_tenths_percent" and val < current.memory_warning_tenths_percent:
        warn_text = format_tenths_percent(current.memory_warning_tenths_percent)
        return (
            f"Memory error threshold cannot be below the memory warning threshold ({warn_text}). "
            f"Lower the memory warning threshold first or enter {warn_text} or higher."
        )
    if field == "load_warning_hundredths" and val > current.load_error_hundredths:
        err_text = format_hundredths(current.load_error_hundredths)
        return (
            f"Normalized 5-minute load warning threshold cannot exceed the error threshold ({err_text}). "
            f"Increase the load error threshold first or enter {err_text} or lower."
        )
    if field == "load_error_hundredths" and val < current.load_warning_hundredths:
        warn_text = format_hundredths(current.load_warning_hundredths)
        return (
            f"Normalized 5-minute load error threshold cannot be below the warning threshold ({warn_text}). "
            f"Lower the load warning threshold first or enter {warn_text} or higher."
        )
    if field == "available_space_warning_tenths_percent" and val < current.available_space_error_tenths_percent:
        err_text = format_tenths_percent(current.available_space_error_tenths_percent)
        return (
            f"Available-space warning threshold cannot be below the error threshold ({err_text}). "
            f"Lower the available-space error threshold first or enter {err_text} or higher."
        )
    if field == "available_space_error_tenths_percent" and val > current.available_space_warning_tenths_percent:
        warn_text = format_tenths_percent(current.available_space_warning_tenths_percent)
        return (
            f"Available-space error threshold cannot exceed the warning threshold ({warn_text}). "
            f"Increase the available-space warning threshold first or enter {warn_text} or lower."
        )
    return ""


def _update_cpu_temp_override(
    payload: HealthMonitoringCpuTempWarningOverrideUpdate | HealthMonitoringCpuTempErrorOverrideUpdate,
    *,
    updated_by_user_id: uuid.UUID | None,
    session: Session,
) -> HealthMonitoringSettingsUpdateResult:
    from app.services.health_monitoring import get_health_monitoring_coordinator

    coordinator = get_health_monitoring_coordinator()
    discovered_map = coordinator.get_discovered_cpu_sources_by_id()
    persisted_map = load_persisted_cpu_overrides(session)

    discovered = discovered_map.get(payload.source_id)
    existing = persisted_map.get(payload.source_id)
    if discovered is None and existing is None:
        raise ValueError("CPU temperature source is not recognized or available for override.")

    detected_max = discovered.detected_warning_millidegrees if discovered is not None else None
    detected_crit = discovered.detected_error_millidegrees if discovered is not None else None

    next_warn_override = (
        payload.value_millidegrees
        if payload.field == "cpu_temp_warning_override"
        else (existing.warning_override_millidegrees if existing is not None else None)
    )
    next_err_override = (
        payload.value_millidegrees
        if payload.field == "cpu_temp_error_override"
        else (existing.error_override_millidegrees if existing is not None else None)
    )

    eff_warn = next_warn_override if next_warn_override is not None else detected_max
    eff_err = next_err_override if next_err_override is not None else detected_crit

    if eff_warn is not None and eff_err is not None and eff_warn > eff_err:
        warn_text = format_millidegrees_celsius(eff_warn)
        err_text = format_millidegrees_celsius(eff_err)
        if payload.field == "cpu_temp_warning_override":
            if payload.value_millidegrees is None:
                raise ValueError(
                    f"Automatic CPU warning limit ({warn_text}) exceeds the effective error threshold ({err_text}). "
                    "Increase or clear the CPU error override first."
                )
            raise ValueError(
                f"CPU warning threshold ({warn_text}) cannot exceed the effective error threshold ({err_text}). "
                f"Increase the CPU error threshold first or enter {err_text} or lower."
            )
        if payload.value_millidegrees is None:
            raise ValueError(
                f"Automatic CPU critical limit ({err_text}) is below the manual warning threshold ({warn_text}). "
                "Lower or clear the CPU warning override first."
            )
        raise ValueError(
            f"CPU error threshold ({err_text}) cannot be below the effective warning threshold ({warn_text}). "
            f"Lower the CPU warning threshold first or enter {warn_text} or higher."
        )

    setting_key = cpu_override_setting_key(payload.source_id)
    existing_row = session.get(SystemSetting, setting_key)

    if next_warn_override is None and next_err_override is None:
        if existing_row is not None:
            session.delete(existing_row)
        return payload

    record = PersistedCpuTempOverride(
        source_id=payload.source_id,
        label=discovered.label if discovered is not None else (existing.label if existing is not None else payload.source_id),
        driver=discovered.driver if discovered is not None else (existing.driver if existing is not None else ""),
        device_path=discovered.device_path if discovered is not None else (existing.device_path if existing is not None else ""),
        warning_override_millidegrees=next_warn_override,
        error_override_millidegrees=next_err_override,
        observed_max_millidegrees=(
            detected_max if discovered is not None else (existing.observed_max_millidegrees if existing is not None else None)
        ),
        observed_crit_millidegrees=(
            detected_crit if discovered is not None else (existing.observed_crit_millidegrees if existing is not None else None)
        ),
    )
    serialized = record.model_dump_json()
    now = datetime.now(timezone.utc)
    if existing_row is None:
        session.add(SystemSetting(key=setting_key, value=serialized, updated_at=now, updated_by_user_id=updated_by_user_id))
    else:
        existing_row.value = serialized
        existing_row.updated_at = now
        existing_row.updated_by_user_id = updated_by_user_id
        session.add(existing_row)
    return payload


def update_health_monitoring_settings(
    payload: HealthMonitoringSettingsUpdate,
    *,
    updated_by_user_id: uuid.UUID | None,
    session: Session,
) -> HealthMonitoringSettingsUpdateResult:
    """Persist one validated Health Monitoring setting transactionally and refresh runtime policy."""

    _begin_immediate_transaction(session)
    current = build_health_monitoring_settings_read(session, include_cpu_discovery=False).policy

    if isinstance(payload, (HealthMonitoringCpuTempWarningOverrideUpdate, HealthMonitoringCpuTempErrorOverrideUpdate)):
        result = _update_cpu_temp_override(payload, updated_by_user_id=updated_by_user_id, session=session)
        session.commit()
        store.refresh_from_session(session)
        from app.services.health_monitoring import get_health_monitoring_coordinator

        get_health_monitoring_coordinator().on_cpu_override_changed(payload.source_id, session=session)
        return result

    if payload.field == "enabled":
        next_policy = HealthMonitoringPolicy.model_validate(current.model_dump() | {"enabled": payload.value})
        _write_system_setting(
            session,
            SystemSettingKey.HEALTH_MONITORING_ENABLED,
            "true" if next_policy.enabled else "false",
            updated_by_user_id,
        )
        session.commit()
        store.refresh_from_session(session)
        from app.services.health_monitoring import get_health_monitoring_coordinator

        get_health_monitoring_coordinator().on_policy_changed(next_policy)
        return payload

    if payload.field == "audience":
        next_policy = HealthMonitoringPolicy.model_validate(current.model_dump() | {"audience": payload.value})
        _write_system_setting(
            session,
            SystemSettingKey.HEALTH_MONITORING_AUDIENCE,
            next_policy.audience.value,
            updated_by_user_id,
        )
        session.commit()
        store.refresh_from_session(session)
        from app.services.health_monitoring import get_health_monitoring_coordinator

        get_health_monitoring_coordinator().on_policy_changed(next_policy)
        return payload

    pair_error = _describe_threshold_pair_error(payload, current)
    if pair_error:
        raise ValueError(pair_error)

    next_policy = HealthMonitoringPolicy.model_validate(current.model_dump() | {payload.field: payload.value})
    _write_system_setting(
        session,
        HEALTH_MONITORING_SETTING_KEYS[payload.field],
        str(getattr(next_policy, payload.field)),
        updated_by_user_id,
    )
    session.commit()
    store.refresh_from_session(session)
    from app.services.health_monitoring import get_health_monitoring_coordinator

    get_health_monitoring_coordinator().on_policy_changed(next_policy)
    return payload


def append_health_monitoring_settings_report(
    lines: list[str],
    session: Session,
    aliases: PublicSupportReportAliases,
) -> None:
    """Append redacted Health Monitoring configuration to the Public Support Report."""

    settings_read = build_health_monitoring_settings_read(session, include_cpu_discovery=False)
    lines.append("[ui_configuration.health_monitoring]")
    _append_report_setting(
        lines, SystemSettingKey.HEALTH_MONITORING_ENABLED.value, settings_read.enabled, settings_read.enabled_source.value
    )
    _append_report_setting(
        lines,
        SystemSettingKey.HEALTH_MONITORING_AUDIENCE.value,
        settings_read.audience.value,
        settings_read.audience_source.value,
    )
    for field_name in (
        "memory_warning_tenths_percent",
        "memory_error_tenths_percent",
        "load_warning_hundredths",
        "load_error_hundredths",
        "available_space_warning_tenths_percent",
        "available_space_error_tenths_percent",
    ):
        setting = settings_read.fields[field_name]
        _append_report_setting(lines, setting.key.value, setting.value, setting.source.value)

    persisted_overrides = load_persisted_cpu_overrides(session)
    aliased_overrides = [
        {
            "source_id": aliases.value("cpu-thermal-source", source_id),
            "warning_override_millidegrees": item.warning_override_millidegrees,
            "error_override_millidegrees": item.error_override_millidegrees,
        }
        for source_id, item in sorted(persisted_overrides.items())
    ]
    _append_report_setting(
        lines,
        "health_monitoring.cpu_temp_overrides",
        aliased_overrides,
        "database" if aliased_overrides else "default",
    )
