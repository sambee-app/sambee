import { Refresh as RefreshIcon } from "@mui/icons-material";
import { Alert, alpha, Box, Button, Stack, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { companionSettingsSync, type SettingsSyncPhase, useCompanionSettingsSync } from "../../services/companionSettingsSync";
import { COMPANION_SETTINGS_SECTIONS } from "../../types/companionSettings";
import { FormRow, FormSurface } from "../Form/FormLayout";
import { SettingsGroup } from "./SettingsGroup";
import { settingsFormSurfaceUtilityButtonSx } from "./settingsButtonStyles";

export function CompanionDirectoryStatus({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("settings.directorySearch.deviceTitle")}>
      <CompanionPolicyDelivery />
    </SettingsGroup>
  );
}

export function CompanionPolicyDelivery() {
  const { t } = useTranslation();
  const snapshot = useCompanionSettingsSync();
  const busy = snapshot.phase === "synchronizing";
  const needsRetry = snapshot.phase === "delivery_failed" || snapshot.phase === "pairing_required";
  const warning = needsRetry || snapshot.phase === "authority_conflict" || snapshot.phase === "update_required";
  const phaseLabel = (phase: SettingsSyncPhase) => t(`settings.companionSync.${phase}`);
  return (
    <FormSurface testId="companion-settings-surface">
      <FormRow>
        <Stack spacing={0.75} sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {COMPANION_SETTINGS_SECTIONS.map((section) => (
            <Typography key={section} variant="body2">
              {t(`settings.companionSync.sections.${section}`)}:{" "}
              {t(`settings.companionSync.results.${snapshot.sections[section] ?? snapshot.phase}`)}
            </Typography>
          ))}
          {snapshot.status?.authoritative_origin && (
            <Typography variant="caption" color="text.secondary">
              {t("settings.companionSync.authority", { origin: snapshot.status.authoritative_origin })}
            </Typography>
          )}
        </Stack>
        <Box sx={{ display: "flex", justifyContent: { md: "flex-end" }, alignItems: "center" }}>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            sx={settingsFormSurfaceUtilityButtonSx}
            disabled={busy}
            onClick={() => companionSettingsSync.request(false, true)}
          >
            {t(needsRetry ? "common.actions.retry" : "settings.directorySearch.refresh")}
          </Button>
        </Box>
      </FormRow>
      <Alert
        severity={warning ? "warning" : "info"}
        role="status"
        sx={{
          mt: 1.5,
          overflowWrap: "anywhere",
          "&&": { color: "text.primary", bgcolor: (theme) => alpha(warning ? theme.palette.warning.main : theme.palette.info.main, 0.12) },
        }}
      >
        {snapshot.message ?? phaseLabel(snapshot.phase)}
      </Alert>
    </FormSurface>
  );
}
