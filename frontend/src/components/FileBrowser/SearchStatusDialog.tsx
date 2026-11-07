import { Box, Button, CircularProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import type { SearchStatusDetails, SearchStatusInfo } from "./search/types";

const STATUS_DETAILS_TABLE_BREAKPOINT = "40rem";

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
  const issues = [...(details?.issues ?? [])].sort(
    (left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path)
  );
  const reasons = [...new Set(issues.map((issue) => issue.code))];
  return (
    <ResponsiveDialogShell
      open
      title={t("fileBrowser.search.statusDetails.title")}
      onClose={onClose}
      maxWidth={issues.length ? "lg" : "sm"}
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
              <Box sx={{ containerType: "inline-size" }}>
                <TableContainer
                  sx={{
                    overflowX: "visible",
                    [`@container (max-width: ${STATUS_DETAILS_TABLE_BREAKPOINT})`]: {
                      "& table, & tbody, & tr, & td": { display: "block", width: "100%" },
                      "& thead": { display: "none" },
                      "& tr": { borderBottom: 1, borderColor: "divider", py: 1 },
                      "& td": { border: 0, px: 0, py: 0.5 },
                      "& .status-details-cell-label": { display: "block" },
                    },
                  }}
                >
                  <Table size="small" aria-label={t("fileBrowser.search.statusDetails.locations")} sx={{ tableLayout: "fixed" }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ width: "70%" }}>{t("fileBrowser.search.statusDetails.location")}</TableCell>
                        <TableCell>{t("fileBrowser.search.statusDetails.reason")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {issues.map((issue) => (
                        <TableRow key={`${issue.path}:${issue.code}`}>
                          <TableCell sx={{ verticalAlign: "top", overflowWrap: "anywhere" }}>
                            <Typography className="status-details-cell-label" variant="caption" sx={{ display: "none" }}>
                              {t("fileBrowser.search.statusDetails.location")}
                            </Typography>
                            {issue.scope !== "directory" && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                                {t("fileBrowser.search.statusDetails.containingDirectory")}
                              </Typography>
                            )}
                            <Box component="bdi" dir="auto" sx={{ userSelect: "text" }}>
                              {issue.path}
                            </Box>
                          </TableCell>
                          <TableCell sx={{ verticalAlign: "top", overflowWrap: "anywhere" }}>
                            <Typography className="status-details-cell-label" variant="caption" sx={{ display: "none" }}>
                              {t("fileBrowser.search.statusDetails.reason")}
                            </Typography>
                            {t(`fileBrowser.search.statusDetails.reasons.${issue.code}`)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
              <Box sx={{ mt: 2 }}>
                {reasons.map((reason) => (
                  <Typography key={reason} variant="body2" sx={{ mb: 1, overflowWrap: "anywhere" }}>
                    <Box component="span" sx={{ fontWeight: "fontWeightMedium" }}>
                      {t(`fileBrowser.search.statusDetails.reasons.${reason}`)}:
                    </Box>{" "}
                    {t(`fileBrowser.search.statusDetails.actions.${reason}`)}
                  </Typography>
                ))}
              </Box>
            </>
          )}
        </>
      )}
    </ResponsiveDialogShell>
  );
}
