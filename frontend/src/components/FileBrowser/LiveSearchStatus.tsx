import { Box, Button, CircularProgress, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { translate } from "../../i18n";
import type { FilesystemSearchSession } from "../../pages/FileBrowser/filesystemSearchSessions";
import { COMPANION_SEARCH_UPDATE_REQUIRED, isFilesystemSearchClientError } from "../../services/filesystemSearchContract";

export function getLiveSearchMessage(session: FilesystemSearchSession): string {
  const companionUpdateRequired = session.status === "interrupted" && session.errorCode === COMPANION_SEARCH_UPDATE_REQUIRED;
  const archiveFailure = (() => {
    if (session.request.root.kind !== "archive" || session.terminal?.reason !== "source_failure") return undefined;
    if (session.terminal.skips.some((skip) => skip.reason === "archive_too_large")) return "archive_too_large";
    if (session.terminal.skips.some((skip) => skip.reason === "archive_unreadable")) return "archive_unreadable";
    return undefined;
  })();
  return session.status === "running"
    ? translate("fileBrowser.search.live.running")
    : session.status === "interrupted"
      ? companionUpdateRequired
        ? translate("fileBrowser.search.live.companionUpdateRequired")
        : isFilesystemSearchClientError(session.errorCode)
          ? translate(`fileBrowser.search.live.errors.${session.errorCode}`)
          : session.error
            ? translate("fileBrowser.search.live.interruptedDetail", { error: session.error })
            : translate("fileBrowser.search.live.interrupted")
      : translate(`fileBrowser.search.live.terminal.${archiveFailure ?? session.terminal?.reason ?? "source_failure"}`);
}

/** Announces scan state, not individual streamed rows. */
export function LiveSearchStatus({
  session,
  onOpenLocalDrivesSettings,
}: {
  session: FilesystemSearchSession;
  onOpenLocalDrivesSettings?: () => void;
}) {
  const { t } = useTranslation();
  const companionUpdateRequired = session.status === "interrupted" && session.errorCode === COMPANION_SEARCH_UPDATE_REQUIRED;
  const message = getLiveSearchMessage(session);
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0 }}>
      {session.status === "running" && <CircularProgress size={16} aria-hidden="true" sx={{ flexShrink: 0 }} />}
      <Typography variant="caption" role="status" aria-live="polite" noWrap title={message}>
        {message}
      </Typography>
      {companionUpdateRequired && onOpenLocalDrivesSettings && (
        <Button size="small" onClick={onOpenLocalDrivesSettings} sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
          {t("fileBrowser.search.live.companionUpdateAction")}
        </Button>
      )}
    </Box>
  );
}
