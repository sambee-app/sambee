import { Alert, Box, CircularProgress, Stack, TextField } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { loadNetworkSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { clearCachedAsyncData, useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { SettingPersistenceAdornment, useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import type { NetworkSettings as NetworkSettingsData, NetworkSettingsUpdate } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

const TRUSTED_PROXY_CIDRS_LABEL = "Trusted proxy CIDRs";

function formatTrustedProxyCidrs(cidrs: string[]): string {
  return cidrs.join("\n");
}

export function NetworkSettings() {
  const [publicUrl, setPublicUrl] = useState("");
  const [trustedProxyCidrs, setTrustedProxyCidrs] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistence = useSystemSettingPersistence<NetworkSettingsUpdate>(
    (update, options) => api.updateNetworkSettings(update, options),
    (saveError) => getApiErrorMessage(saveError, "Network settings could not be saved.")
  );
  const handleLoadError = useCallback(
    (loadError: unknown) => setLoadError(getApiErrorMessage(loadError, "Network settings could not be loaded.")),
    []
  );
  const {
    data: settings,
    loading,
    setData: setSettings,
  } = useCachedAsyncData<NetworkSettingsData>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.adminNetwork,
    load: loadNetworkSettingsData,
    refreshCachedDataOnMount: false,
    onError: handleLoadError,
  });

  useEffect(() => {
    if (!settings) return;
    setPublicUrl(settings.public_url);
    setTrustedProxyCidrs(formatTrustedProxyCidrs(settings.trusted_proxy_cidrs));
  }, [settings]);

  const persistField = async (update: NetworkSettingsUpdate) => {
    const result = await persistence.persist(update, settings?.[update.field]);
    if (result.status === "completed") {
      clearCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication);
      setSettings((current) => (current ? { ...current, [result.update.field]: result.update.value } : current));
    }
  };

  return (
    <SettingsPage category="admin-network" contextualNotice={loadError ? <Alert severity="error">{loadError}</Alert> : null}>
      {loading && !settings ? (
        <Box sx={{ display: "flex", justifyContent: "center", pt: 5 }}>
          <CircularProgress aria-label="Loading network settings" />
        </Box>
      ) : null}
      <Stack spacing={2.5}>
        <TextField
          required
          fullWidth
          label="Public URL"
          value={publicUrl}
          onChange={(event) => {
            setPublicUrl(event.target.value);
            persistence.clearFieldFeedback("public_url");
          }}
          onBlur={() => {
            if (publicUrl.trim()) void persistField({ field: "public_url", value: publicUrl.trim() });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          disabled={persistence.isPending("public_url")}
          error={Boolean(persistence.fieldErrors["public_url"])}
          helperText={
            persistence.fieldErrors["public_url"] ??
            "The externally reachable HTTPS origin, without a path. Changing it cancels incomplete OIDC sign-ins."
          }
          slotProps={{
            input: {
              endAdornment:
                persistence.isPending("public_url") || persistence.isSaved("public_url") ? (
                  <SettingPersistenceAdornment
                    pending={persistence.isPending("public_url")}
                    saved={persistence.isSaved("public_url")}
                    savingLabel="Saving public URL"
                    savedLabel="Public URL saved"
                  />
                ) : null,
            },
          }}
        />
        <TextField
          fullWidth
          multiline
          minRows={3}
          label={TRUSTED_PROXY_CIDRS_LABEL}
          value={trustedProxyCidrs}
          onChange={(event) => {
            setTrustedProxyCidrs(event.target.value);
            persistence.clearFieldFeedback("trusted_proxy_cidrs");
          }}
          onBlur={() =>
            void persistField({
              field: "trusted_proxy_cidrs",
              value: trustedProxyCidrs
                .split(/[,\n]/)
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
          disabled={persistence.isPending("trusted_proxy_cidrs")}
          error={Boolean(persistence.fieldErrors["trusted_proxy_cidrs"])}
          helperText={
            persistence.fieldErrors["trusted_proxy_cidrs"] ??
            "One CIDR per line. Leave empty unless a reverse proxy you operate forwards client IP addresses."
          }
          slotProps={{
            inputLabel: { shrink: true },
            input: {
              endAdornment:
                persistence.isPending("trusted_proxy_cidrs") || persistence.isSaved("trusted_proxy_cidrs") ? (
                  <SettingPersistenceAdornment
                    pending={persistence.isPending("trusted_proxy_cidrs")}
                    saved={persistence.isSaved("trusted_proxy_cidrs")}
                    savingLabel="Saving trusted proxy CIDRs"
                    savedLabel="Trusted proxy CIDRs saved"
                  />
                ) : null,
            },
          }}
        />
      </Stack>
    </SettingsPage>
  );
}
