import { Box, FormControl, InputAdornment, MenuItem, Stack, TextField } from "@mui/material";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingPersistenceIndicator } from "../../hooks/useSystemSettingPersistence";
import { translate } from "../../i18n";
import type { IntegerSystemSetting } from "../../types";
import { formatLocalizedNumber } from "../../utils/localeFormatting";
import { SettingsFieldHelp } from "./SettingsFieldHelp";

const DESKTOP_FIELD_ROW_MAX_WIDTH = 440;
const DESKTOP_VALUE_FIELD_MAX_WIDTH = 220;
const DESKTOP_UNIT_FIELD_WIDTH = 120;
const DESKTOP_NUMERIC_FIELD_MAX_WIDTH = 240;

const BYTE_UNITS = [
  { label: "B", factor: 1 },
  { label: "KiB", factor: 1024 },
  { label: "MiB", factor: 1024 * 1024 },
  { label: "GiB", factor: 1024 * 1024 * 1024 },
] as const;

type ByteUnitLabel = (typeof BYTE_UNITS)[number]["label"];

function formatInteger(value: number): string {
  return formatLocalizedNumber(value);
}

function formatByteSize(bytes: number): string {
  const matchingUnit = [...BYTE_UNITS].reverse().find((unit) => bytes >= unit.factor && bytes % unit.factor === 0) ?? BYTE_UNITS[0];
  return `${formatInteger(bytes / matchingUnit.factor)} ${matchingUnit.label}`;
}

function formatBytesWithExactValue(bytes: number): string {
  return `${formatByteSize(bytes)} (${formatInteger(bytes)} bytes)`;
}

function getPreferredByteUnit(bytes: number): ByteUnitLabel {
  return ([...BYTE_UNITS].reverse().find((unit) => bytes >= unit.factor && bytes % unit.factor === 0) ?? BYTE_UNITS[0]).label;
}

function getByteUnitFactor(unitLabel: ByteUnitLabel): number {
  return BYTE_UNITS.find((unit) => unit.label === unitLabel)?.factor ?? 1;
}

function validateIntegerSetting(setting: IntegerSystemSetting, value: number | null, unitLabel?: string): string | null {
  if (value === null) {
    return translate("settings.advanced.validation.enterLabel", { label: setting.label });
  }

  if (!Number.isInteger(value)) {
    return translate("settings.advanced.validation.wholeNumber", { label: setting.label });
  }

  if (value < setting.min_value || value > setting.max_value) {
    if (unitLabel) {
      return translate("settings.advanced.validation.betweenRangeWithUnit", {
        label: setting.label,
        min: formatInteger(setting.min_value),
        max: formatInteger(setting.max_value),
        unit: unitLabel,
      });
    }

    return translate("settings.advanced.validation.betweenRange", {
      label: setting.label,
      min: formatInteger(setting.min_value),
      max: formatInteger(setting.max_value),
    });
  }

  return null;
}

function validateByteSizeSetting(setting: IntegerSystemSetting, value: number | null): string | null {
  if (value === null) {
    return translate("settings.advanced.validation.enterLabel", { label: setting.label });
  }

  if (!Number.isInteger(value)) {
    return translate("settings.advanced.validation.wholeNumber", { label: setting.label });
  }

  if (value < setting.min_value || value > setting.max_value) {
    return translate("settings.advanced.validation.betweenRange", {
      label: setting.label,
      min: formatByteSize(setting.min_value),
      max: formatByteSize(setting.max_value),
    });
  }

  return null;
}

export function SettingField({
  setting,
  value,
  onChange,
  onCommit,
  persistenceError,
  pending,
  saved,
  unitAdornment,
}: {
  setting: IntegerSystemSetting;
  value: number | null;
  onChange: (value: number | null) => void;
  onCommit: (value: number) => void;
  persistenceError?: string;
  pending: boolean;
  saved: boolean;
  unitAdornment?: string;
}) {
  const { t } = useTranslation();
  const helperId = useId();
  const [displayValue, setDisplayValue] = useState<string>(value === null ? "" : String(value));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setDisplayValue(value === null ? "" : String(value));
  }, [value]);

  const validationError = validateIntegerSetting(setting, value, unitAdornment);
  const errorText = persistenceError ?? (touched ? validationError : null);
  const helperText = errorText
    ? errorText
    : t("settings.advanced.helperText.integer", {
        description: setting.description,
        defaultValue: setting.default_value,
        minValue: setting.min_value,
        maxValue: setting.max_value,
      });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, py: 1.5 }}>
      <TextField
        type="text"
        label={setting.label}
        value={displayValue}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (!/^\d*$/.test(nextValue)) {
            return;
          }

          setDisplayValue(nextValue);
          onChange(nextValue ? Number(nextValue) : null);
        }}
        onBlur={() => {
          setTouched(true);
          if (!validationError && value !== null) onCommit(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setTouched(true);
            if (!validationError && value !== null) onCommit(value);
          }
        }}
        variant="outlined"
        sx={{ width: "100%", maxWidth: { xs: "100%", sm: DESKTOP_NUMERIC_FIELD_MAX_WIDTH } }}
        disabled={pending}
        error={Boolean(errorText)}
        slotProps={{
          htmlInput: { inputMode: "numeric", pattern: "[0-9]*", "aria-describedby": helperId },
          input:
            unitAdornment || pending || saved
              ? {
                  endAdornment: (
                    <InputAdornment position="end">
                      {unitAdornment}
                      <SettingPersistenceIndicator
                        pending={pending}
                        saved={saved}
                        savingLabel="Saving setting"
                        savedLabel="Setting saved"
                      />
                    </InputAdornment>
                  ),
                }
              : undefined,
        }}
      />
      <SettingsFieldHelp id={helperId} error={Boolean(errorText)} sx={{ mx: 0 }}>
        {helperText}
      </SettingsFieldHelp>
    </Box>
  );
}

export function ByteSizeSettingField({
  setting,
  fixedUnit,
  value,
  onChange,
  onCommit,
  persistenceError,
  pending,
  saved,
}: {
  setting: IntegerSystemSetting;
  fixedUnit?: ByteUnitLabel;
  value: number | null;
  onChange: (value: number | null) => void;
  onCommit: (value: number) => void;
  persistenceError?: string;
  pending: boolean;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const helperId = useId();
  const [unit, setUnit] = useState<ByteUnitLabel>(() => fixedUnit ?? getPreferredByteUnit(value ?? setting.min_value));
  const [displayValue, setDisplayValue] = useState<string>(() =>
    value === null ? "" : String(value / getByteUnitFactor(fixedUnit ?? getPreferredByteUnit(value)))
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (value === null) {
      setDisplayValue("");
      return;
    }

    const factor = getByteUnitFactor(unit);
    if (!fixedUnit && factor > value && value > 0) {
      const nextUnit = getPreferredByteUnit(value);
      setUnit(nextUnit);
      setDisplayValue(String(value / getByteUnitFactor(nextUnit)));
      return;
    }

    setDisplayValue(String(value / factor));
  }, [fixedUnit, unit, value]);

  const factor = getByteUnitFactor(unit);
  const validationError =
    validateByteSizeSetting(setting, value) ??
    (fixedUnit && value !== null && value % setting.step !== 0 ? `${setting.label} must use whole ${fixedUnit} increments` : null);
  const errorText = persistenceError ?? (touched ? validationError : null);

  const handleValueChange = (nextValue: string) => {
    if (!/^\d*$/.test(nextValue)) {
      return;
    }

    setDisplayValue(nextValue);

    if (!nextValue) {
      onChange(null);
      return;
    }

    onChange(Number(nextValue) * factor);
  };

  const handleValueBlur = () => {
    setTouched(true);
    if (!validationError && value !== null) onCommit(value);
  };

  const handleUnitChange = (nextUnit: ByteUnitLabel) => {
    setUnit(nextUnit);
  };

  const availableUnits = BYTE_UNITS.filter((option) =>
    fixedUnit ? option.label === fixedUnit : value === null || value % option.factor === 0 || option.label === unit
  );
  const helperMessage = errorText
    ? errorText
    : t("settings.advanced.helperText.byteSize", {
        description: setting.description,
        defaultValue: formatBytesWithExactValue(setting.default_value),
        minValue: formatByteSize(setting.min_value),
        maxValue: formatByteSize(setting.max_value),
      });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, py: 1.5 }}>
      <FormControl error={Boolean(errorText)} sx={{ width: "100%" }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ maxWidth: { xs: "100%", sm: DESKTOP_FIELD_ROW_MAX_WIDTH } }}>
          <TextField
            type="text"
            label={setting.label}
            value={displayValue}
            onChange={(event) => handleValueChange(event.target.value)}
            onBlur={handleValueBlur}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleValueBlur();
              }
            }}
            slotProps={{
              htmlInput: { inputMode: "numeric", pattern: "[0-9]*", "aria-describedby": helperId },
              input:
                pending || saved
                  ? {
                      endAdornment: (
                        <InputAdornment position="end">
                          <SettingPersistenceIndicator
                            pending={pending}
                            saved={saved}
                            savingLabel="Saving setting"
                            savedLabel="Setting saved"
                          />
                        </InputAdornment>
                      ),
                    }
                  : undefined,
            }}
            variant="outlined"
            sx={{ width: "100%", maxWidth: { xs: "100%", sm: DESKTOP_VALUE_FIELD_MAX_WIDTH } }}
            disabled={pending}
            error={Boolean(errorText)}
          />
          <TextField
            select
            label={t("settings.advanced.fields.unit")}
            value={unit}
            onChange={(event) => handleUnitChange(event.target.value as ByteUnitLabel)}
            variant="outlined"
            disabled={pending || Boolean(fixedUnit)}
            error={Boolean(errorText)}
            sx={{ width: { xs: "100%", sm: DESKTOP_UNIT_FIELD_WIDTH } }}
          >
            {availableUnits.map((option) => (
              <MenuItem key={option.label} value={option.label}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <SettingsFieldHelp id={helperId} error={Boolean(errorText)} sx={{ mt: 1, mx: 0 }}>
          {helperMessage}
        </SettingsFieldHelp>
      </FormControl>
    </Box>
  );
}
