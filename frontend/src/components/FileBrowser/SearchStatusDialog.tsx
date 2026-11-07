import { Box, Button, CircularProgress, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import type { SearchStatusDetails, SearchStatusInfo } from "./search/types";

export function SearchStatusDialog({ status, onClose }: { status: SearchStatusInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<SearchStatusDetails | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetails(null);
    setFailed(false);
    status
      .loadDetails?.(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDetails(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [status]);

  const hasDetails = !!details?.message || !!details?.issues?.length;
  return (
    <ResponsiveDialogShell
      open
      title={t("fileBrowser.search.statusDetails.title")}
      onClose={onClose}
      actions={
        <Button autoFocus variant="contained" onClick={onClose}>
          {t("common.actions.close")}
        </Button>
      }
    >
      {!details && !failed && <CircularProgress size={24} aria-label={t("app.loading")} />}
      {failed && <Typography role="alert">{t("fileBrowser.search.statusDetails.failed")}</Typography>}
      {details && !hasDetails && <Typography role="status">{t("fileBrowser.search.statusDetails.unavailable")}</Typography>}
      {details && hasDetails && (
        <>
          <Typography variant="caption">{t("fileBrowser.search.statusDetails.source")}</Typography>
          <Typography sx={{ overflowWrap: "anywhere", mb: 2 }}>{details.source}</Typography>
          {details.message && <Typography sx={{ mb: 2, overflowWrap: "anywhere" }}>{details.message}</Typography>}
          {!!details.issues?.length && (
            <>
              <Typography variant="body2" sx={{ mb: 2 }}>
                {t("fileBrowser.search.statusDetails.impact")}
              </Typography>
              {details.incomplete && (
                <Typography role="status" variant="body2" sx={{ mb: 2 }}>
                  {t("fileBrowser.search.statusDetails.incomplete")}
                </Typography>
              )}
              <Box component="ul" sx={{ m: 0, pl: 2 }}>
                {details.issues.map((issue) => (
                  <Box component="li" key={`${issue.path}:${issue.code}`} sx={{ mb: 2 }}>
                    <Typography component="bdi" dir="auto" sx={{ display: "block", overflowWrap: "anywhere", userSelect: "text" }}>
                      {issue.path}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {t(`fileBrowser.search.statusDetails.reasons.${issue.code}`)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </>
      )}
    </ResponsiveDialogShell>
  );
}
