import { MenuItem, TextField } from "@mui/material";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formSelectMenuProps, formSelectSx } from "../components/Form/FormLayout";
import { SettingSaveStatusAdornment } from "../components/Settings/SettingSaveStatus";
import { SettingsFieldHelp } from "../components/Settings/SettingsFieldHelp";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { useCurrentUserSetting } from "../services/userSettingsStore";

export function ImageViewerSettings() {
  const { t } = useTranslation();
  const descriptionId = useId();
  const transition = useCurrentUserSetting("image_viewer.transition");
  const restoreFocus = useRestoreFocusAfterPending(transition.pending);
  return (
    <SettingsPage category="image-viewer">
      <SettingsGroup title={t("settings.imageViewerPage.transition")}>
        <TextField
          select
          label={t("settings.imageViewerPage.transition")}
          value={transition.confirmedValue ?? "none"}
          disabled={transition.pending}
          error={Boolean(transition.error)}
          onFocus={() => restoreFocus()}
          onChange={(event) => {
            transition.clearError();
            void transition.commit(event.target.value as "carousel" | "none").catch(() => undefined);
          }}
          sx={{ width: "100%", maxWidth: 280 }}
          slotProps={{
            select: {
              sx: formSelectSx,
              MenuProps: formSelectMenuProps,
              SelectDisplayProps: { "aria-describedby": descriptionId },
            },
            input: {
              endAdornment: (
                <SettingSaveStatusAdornment
                  pending={transition.pending}
                  saved={transition.saved}
                  savingLabel={t("settings.saveStatus.saving")}
                  savedLabel={t("settings.saveStatus.saved")}
                />
              ),
            },
          }}
        >
          <MenuItem value="carousel">{t("settings.imageViewerPage.carousel")}</MenuItem>
          <MenuItem value="none">{t("settings.imageViewerPage.none")}</MenuItem>
        </TextField>
        <SettingsFieldHelp id={descriptionId} error={Boolean(transition.error)} sx={{ mx: 0 }}>
          {transition.error ?? t("settings.imageViewerPage.transitionDescription")}
        </SettingsFieldHelp>
      </SettingsGroup>
    </SettingsPage>
  );
}
