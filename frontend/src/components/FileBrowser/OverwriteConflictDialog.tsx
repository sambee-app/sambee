//
// OverwriteConflictDialog
//

/**
 * Overwrite Conflict Dialog
 * =========================
 *
 * Shown when an operation encounters an item that already exists at the
 * target. Displays metadata for the source and existing target so the user
 * can make an informed decision.
 *
 * Actions:
 *   - **Skip**    – leave the existing file untouched and continue
 *   - **Overwrite** – replace the existing target with the source
 *
 * An "Apply to all remaining conflicts" checkbox lets the user convert
 * their choice into a batch decision for all subsequent conflicts in
 * the current multi-file operation.
 */

import ArrowUpwardOutlinedIcon from "@mui/icons-material/ArrowUpwardOutlined";
import { Box, Button, Checkbox, FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Typography } from "@mui/material";
import type React from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ConflictInfo, FileType } from "../../types";
import { dialogEnterKeyHandler } from "../../utils/keyboardUtils";
import { formatLocalizedDateTime, formatLocalizedNumber } from "../../utils/localeFormatting";
import { DialogNotice } from "../Dialog/DialogNotice";
import { DialogReadOnlyField } from "../Dialog/DialogReadOnlyField";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";
import { DialogIdentifierDisplay } from "./DialogIdentifierDisplay";
import { validateItemName } from "./nameDialogStrings";
import { OVERWRITE_CONFLICT_STRINGS as S } from "./overwriteConflictStrings";

// ============================================================================
// Types
// ============================================================================

export type ConflictResolution = "skip" | "overwrite" | "overwrite-older" | "rename";
export type OverwriteOperation = "copy" | "move" | "extract" | "upload";

export interface ConflictDecision {
  resolution: ConflictResolution;
  applyToAll: boolean;
  targetName?: string;
}

export interface OverwriteConflictDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Conflict metadata (existing + incoming file info). */
  conflict: ConflictInfo | null;
  operation?: OverwriteOperation;
  /** Resolution choices the operation owner can honor for this conflict. */
  allowedActions: readonly ConflictResolution[];
  /** Whether the owner permits an all-remaining policy for a resolution. */
  canApplyToAll?: (resolution: "skip" | "overwrite" | "overwrite-older") => boolean;
  progress?: { current: number; total: number; conflictsSoFar: number };
  /** True while the operation owner persists the submitted decision. */
  isSubmitting?: boolean;
  /** Owner-level error that does not have a field-level remedy. */
  error?: string | null;
  /** Full source path, including its connection name. */
  sourcePath?: string;
  /** Full target directory path, including its connection name. */
  targetDirectoryPath?: string;
  /** Uploads may encounter folder/file type conflicts before any file progress exists. */
  uploadKind?: "file" | "directory";
  onResolve: (decision: ConflictDecision) => void;
  onCancel: () => void;
}

const DETAIL_ROW_COLUMNS = "minmax(4.5rem, 6rem) 1.5rem minmax(0, 1fr)";
const CONFLICT_METADATA_SECTION_MARGIN_BOTTOM = 3;

// ============================================================================
// Helpers
// ============================================================================

/** Format byte count into a human-readable string (e.g. "1.5 MB"). */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatLocalizedNumber(kb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${formatLocalizedNumber(mb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  const gb = mb / 1024;
  return `${formatLocalizedNumber(gb, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
}

/** Format an ISO date string with the active application locale. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatLocalizedDateTime(iso, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function suggestCopyName(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) return `${fileName} (copy)`;
  return `${fileName.slice(0, extensionIndex)} (copy)${fileName.slice(extensionIndex)}`;
}

function getParentDirectory(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex < 0) return "/";
  return path.slice(0, separatorIndex) || "/";
}

function joinDirectoryAndName(directory: string, name: string): string {
  if (!directory || directory === "/") return `/${name}`;
  return `${directory.replace(/\/+$/, "")}/${name}`;
}

// ============================================================================
// Component
// ============================================================================

const OverwriteConflictDialog: React.FC<OverwriteConflictDialogProps> = ({
  open,
  conflict,
  operation = "copy",
  allowedActions,
  canApplyToAll: ownerCanApplyToAll,
  progress,
  isSubmitting: ownerIsSubmitting = false,
  error = null,
  sourcePath: ownerSourcePath,
  targetDirectoryPath: ownerTargetDirectoryPath,
  uploadKind,
  onResolve,
  onCancel,
}) => {
  const [applyToAll, setApplyToAll] = useState(false);
  const [resolution, setResolution] = useState<ConflictResolution>("skip");
  const [renameDraft, setRenameDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const targetNameRef = useRef<HTMLInputElement>(null);
  const resolutionGroupRef = useRef<HTMLFieldSetElement>(null);
  const previousConflictIdentityRef = useRef<string | null>(null);
  const shouldFocusInitialControlRef = useRef(false);
  const shouldFocusRenameInputRef = useRef(false);

  const sourcePath = ownerSourcePath ?? conflict?.incoming_file.path ?? "";
  const existingTargetName = conflict?.existing_file.name ?? "";
  const targetDirectory = ownerTargetDirectoryPath ?? getParentDirectory(conflict?.existing_file.path ?? "");
  const conflictIdentity = `${conflict?.incoming_file.path ?? ""}\u0000${conflict?.existing_file.path ?? ""}`;
  const allowedActionsIdentity = allowedActions.join("\u0000");
  const dialogStateIdentity = `${conflictIdentity}\u0000${allowedActionsIdentity}`;
  const safeDefaultResolution = allowedActions.includes("skip") ? "skip" : (allowedActions[0] ?? "skip");
  const hasAvailableResolution = allowedActions.length > 0;
  const isRename = resolution === "rename";
  const isSubmittingOrPending = isSubmitting || ownerIsSubmitting;
  const targetNameError = isRename
    ? (validateItemName(renameDraft) ?? (renameDraft === existingTargetName ? S.ERROR_TARGET_NAME_UNCHANGED : null))
    : null;
  const canApplyToAll =
    (resolution === "skip" || resolution === "overwrite" || resolution === "overwrite-older") &&
    (ownerCanApplyToAll?.(resolution) ?? Boolean(progress && progress.current < progress.total));
  const canContinue = allowedActions.includes(resolution) && !targetNameError && !isSubmittingOrPending;
  const displayedError = error ?? (hasAvailableResolution ? null : S.ERROR_NO_RESOLUTION_AVAILABLE);
  const description = (
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {uploadKind === "directory"
        ? S.FOLDER_CONFLICT
        : operation === "upload" && conflict?.existing_file.type === FileType.DIRECTORY
          ? S.FILE_FOLDER_CONFLICT
          : S.ALREADY_EXISTS}
    </Typography>
  );

  const focusInitialControl = useCallback(() => {
    if (!shouldFocusInitialControlRef.current) return;
    shouldFocusInitialControlRef.current = false;
    if (!hasAvailableResolution) return;
    if (safeDefaultResolution === "rename") {
      targetNameRef.current?.focus();
      return;
    }
    resolutionGroupRef.current?.querySelector<HTMLInputElement>(`input[value="${safeDefaultResolution}"]`)?.focus();
  }, [hasAvailableResolution, safeDefaultResolution]);

  useLayoutEffect(() => {
    if (!open) {
      previousConflictIdentityRef.current = null;
      shouldFocusInitialControlRef.current = false;
      shouldFocusRenameInputRef.current = false;
      return;
    }

    if (previousConflictIdentityRef.current === dialogStateIdentity) return;

    previousConflictIdentityRef.current = dialogStateIdentity;
    setApplyToAll(false);
    setResolution(safeDefaultResolution);
    setRenameDraft(suggestCopyName(existingTargetName));
    setIsSubmitting(false);
    shouldFocusInitialControlRef.current = true;
    shouldFocusRenameInputRef.current = safeDefaultResolution === "rename";
  }, [dialogStateIdentity, existingTargetName, open, safeDefaultResolution]);

  useEffect(() => {
    if (!open || isSubmittingOrPending || !shouldFocusInitialControlRef.current) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      if (!shouldFocusInitialControlRef.current) {
        return;
      }
      focusInitialControl();
    });
    return () => cancelAnimationFrame(frameId);
  }, [focusInitialControl, isSubmittingOrPending, open]);

  useEffect(() => {
    if (!open || !ownerIsSubmitting) {
      setIsSubmitting(false);
    }
  }, [open, ownerIsSubmitting]);

  useLayoutEffect(() => {
    if (open && isRename && shouldFocusRenameInputRef.current) {
      targetNameRef.current?.focus();
      targetNameRef.current?.select();
      shouldFocusRenameInputRef.current = false;
    }
  }, [isRename, open]);

  const handleResolutionChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextResolution = event.target.value as ConflictResolution;
      shouldFocusRenameInputRef.current = nextResolution === "rename" && resolution !== "rename";
      setResolution(nextResolution);
      setApplyToAll(false);
    },
    [resolution]
  );

  const handleContinue = useCallback(() => {
    if (!canContinue) return;
    setIsSubmitting(true);
    onResolve({
      resolution,
      applyToAll: canApplyToAll ? applyToAll : false,
      targetName: isRename ? renameDraft : undefined,
    });
  }, [applyToAll, canApplyToAll, canContinue, isRename, onResolve, renameDraft, resolution]);

  const fallbackEnterHandler = useMemo(() => dialogEnterKeyHandler(handleContinue), [handleContinue]);
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => fallbackEnterHandler(event), [fallbackEnterHandler]);

  const targetDetails = [
    { label: S.LABEL_PATH, value: joinDirectoryAndName(targetDirectory, existingTargetName), testId: "overwrite-conflict-target-path" },
    ...(operation === "upload" && conflict?.existing_file.type === FileType.DIRECTORY
      ? []
      : [
          { label: S.LABEL_MODIFIED, value: formatDate(conflict?.existing_file.modified_at) },
          { label: S.LABEL_SIZE, value: formatBytes(conflict?.existing_file.size) },
        ]),
  ];
  const sourceDetails = [
    { label: S.LABEL_PATH, value: sourcePath, testId: "overwrite-conflict-source-path" },
    ...(operation === "upload" && (uploadKind === "directory" || conflict?.incoming_file.type === FileType.DIRECTORY)
      ? []
      : [
          { label: S.LABEL_MODIFIED, value: formatDate(conflict?.incoming_file.modified_at) },
          { label: S.LABEL_SIZE, value: formatBytes(conflict?.incoming_file.size) },
        ]),
  ];

  return (
    <ResponsiveDialogShell
      open={open}
      onClose={onCancel}
      onKeyDown={handleKeyDown}
      title={S.TITLE}
      description={description}
      maxWidth="sm"
      disableClose={isSubmittingOrPending}
      onTransitionEntered={focusInitialControl}
      actionNotice={<DialogNotice message={displayedError} testId="overwrite-conflict-notice" />}
      actions={
        <>
          <Button onClick={onCancel} disabled={isSubmittingOrPending} variant="outlined" sx={settingsUtilityButtonSx}>
            {S.CANCEL_OPERATION(operation)}
          </Button>
          <Button
            onClick={handleContinue}
            variant="contained"
            color={resolution === "overwrite" || resolution === "overwrite-older" ? "error" : "primary"}
            disabled={!canContinue}
          >
            {S.BUTTON_CONTINUE}
          </Button>
        </>
      }
    >
      <Box
        role="group"
        aria-label={S.RESOLUTION_LABEL}
        tabIndex={hasAvailableResolution ? undefined : -1}
        aria-busy={isSubmittingOrPending}
      >
        <Box component="section" aria-label={S.METADATA_LABEL} sx={{ mb: CONFLICT_METADATA_SECTION_MARGIN_BOTTOM }}>
          {[
            { label: S.LABEL_EXISTING, details: targetDetails, testId: "overwrite-conflict-target-details" },
            { label: S.LABEL_INCOMING, details: sourceDetails, testId: "overwrite-conflict-source-details" },
          ].map(({ label, details, testId }, index) => (
            <Fragment key={label}>
              {index > 0 ? (
                <Box
                  aria-hidden="true"
                  data-testid="overwrite-conflict-direction"
                  sx={{ color: "text.secondary", display: "grid", gridTemplateColumns: DETAIL_ROW_COLUMNS, my: 0.5 }}
                >
                  <ArrowUpwardOutlinedIcon fontSize="small" sx={{ gridColumn: 1, justifySelf: "end" }} />
                </Box>
              ) : null}
              <Box data-testid={testId}>
                <Typography component="h3" variant="subtitle2" sx={{ mb: 0.25 }}>
                  {label}
                </Typography>
                <Box component="dl" sx={{ display: "grid", gap: 0.25, m: 0 }}>
                  {details.map((detail) => (
                    <Box component="div" key={detail.label} sx={{ display: "grid", gridTemplateColumns: DETAIL_ROW_COLUMNS }}>
                      <Typography component="dt" variant="caption" sx={{ color: (theme) => theme.palette.text.secondary }}>
                        {detail.label}
                      </Typography>
                      <Box component="dd" data-testid={detail.testId} sx={{ gridColumn: 3, m: 0, minWidth: 0 }}>
                        {detail.testId ? (
                          <DialogIdentifierDisplay value={detail.value} kind="path" testId={`${detail.testId}-value`} />
                        ) : (
                          <Typography variant="body2">{detail.value}</Typography>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Fragment>
          ))}
        </Box>

        <FormControl component="fieldset" fullWidth disabled={isSubmittingOrPending} ref={resolutionGroupRef} key={dialogStateIdentity}>
          <FormLabel component="legend">{S.RESOLUTION_LABEL}</FormLabel>
          <RadioGroup
            value={resolution}
            onChange={handleResolutionChange}
            sx={{ columnGap: 2, display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" } }}
          >
            {allowedActions.includes("skip") && (
              <FormControlLabel
                value="skip"
                control={<Radio size="small" />}
                label={uploadKind === "directory" ? S.BUTTON_SKIP_FOLDER : S.BUTTON_SKIP}
              />
            )}
            {allowedActions.includes("overwrite") && (
              <FormControlLabel value="overwrite" control={<Radio size="small" />} label={S.BUTTON_OVERWRITE} />
            )}
            {allowedActions.includes("overwrite-older") && (
              <FormControlLabel value="overwrite-older" control={<Radio size="small" />} label={S.BUTTON_OVERWRITE_ONLY_OLDER} />
            )}
            {allowedActions.includes("rename") && (
              <FormControlLabel
                value="rename"
                control={<Radio size="small" />}
                label={uploadKind === "directory" ? S.BUTTON_RENAME_FOLDER : S.BUTTON_RENAME}
              />
            )}
          </RadioGroup>
        </FormControl>

        <Box
          aria-hidden={!canApplyToAll}
          data-testid="overwrite-conflict-apply-all-slot"
          sx={{ mt: 0.5, visibility: canApplyToAll ? "visible" : "hidden" }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={applyToAll}
                onChange={(event) => setApplyToAll(event.target.checked)}
                size="small"
                disabled={isSubmittingOrPending}
              />
            }
            label={S.APPLY_TO_ALL}
          />
        </Box>
        {progress && (
          <Typography variant="caption" sx={{ display: "block", mt: 0.5, color: "text.secondary" }}>
            {S.PROGRESS_CONTEXT(progress.current, progress.total, progress.conflictsSoFar)}
          </Typography>
        )}
        {isRename ? (
          <Box sx={{ mt: 2 }}>
            <DialogReadOnlyField
              ariaLabel={S.LABEL_TARGET_NAME}
              label={S.LABEL_TARGET_NAME}
              value={renameDraft}
              editable={!isSubmittingOrPending}
              onChange={(event) => setRenameDraft(event.target.value)}
              inputRef={targetNameRef}
              error={Boolean(targetNameError)}
              helperText={targetNameError}
              autoFocus={safeDefaultResolution === "rename"}
              showFormSurface
            />
          </Box>
        ) : null}
      </Box>
    </ResponsiveDialogShell>
  );
};

export { OverwriteConflictDialog as OverwriteResolutionDialog };
export default OverwriteConflictDialog;
