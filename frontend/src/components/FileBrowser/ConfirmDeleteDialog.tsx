//
// ConfirmDeleteDialog
//

/**
 * Confirm Delete Dialog
 * =====================
 *
 * Modal dialog to confirm deletion of files or directories.
 */

import { Box, Button, CircularProgress, Typography } from "@mui/material";
import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type FileEntry, FileType } from "../../types";
import { dialogEnterKeyHandler } from "../../utils/keyboardUtils";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";
import { CONFIRM_DELETE_STRINGS } from "./confirmDeleteDialogStrings";
import { DialogIdentifierDisplay } from "./DialogIdentifierDisplay";
import { DialogOperationContext } from "./DialogOperationContext";

// ============================================================================
// Props
// ============================================================================

interface ConfirmDeleteDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Files and directories to delete */
  items: FileEntry[];
  /** Whether a delete operation is in progress */
  isDeleting: boolean;
  /** Called when the user cancels */
  onClose: () => void;
  /** Called when the user confirms deletion */
  onConfirm: () => void;
  /** Prevent the dialog from returning focus to its trigger. */
  disableRestoreFocus?: boolean;
  /** Called after the dialog's close transition completes. */
  onTransitionExited?: () => void;
}

// ============================================================================
// Component
// ============================================================================

const DELETE_LIST_MAX_VISIBLE_ROWS = 6;

//
// ConfirmDeleteDialog
//
const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  open,
  items,
  isDeleting,
  onClose,
  onConfirm,
  disableRestoreFocus,
  onTransitionExited,
}) => {
  const { t } = useTranslation();
  const isSingleItem = items.length === 1;
  const item = items[0];
  const isDirectory = item?.type === FileType.DIRECTORY;
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  // Set focus after the modal sets up its focus trap.
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => deleteButtonRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);

  const title = isSingleItem
    ? isDirectory
      ? CONFIRM_DELETE_STRINGS.TITLE_DIRECTORY
      : CONFIRM_DELETE_STRINGS.TITLE_FILE
    : CONFIRM_DELETE_STRINGS.TITLE_MULTI;
  const description = isSingleItem
    ? isDirectory
      ? CONFIRM_DELETE_STRINGS.CONFIRM_DIRECTORY
      : CONFIRM_DELETE_STRINGS.CONFIRM_FILE
    : CONFIRM_DELETE_STRINGS.CONFIRM_MULTI(items.length);
  const visibleItems = items.slice(0, DELETE_LIST_MAX_VISIBLE_ROWS);
  const remainingItemCount = items.length - visibleItems.length;

  const handleKeyDown = useMemo(() => dialogEnterKeyHandler(), []);

  return (
    <ResponsiveDialogShell
      open={open}
      onClose={onClose}
      disableClose={isDeleting}
      disableRestoreFocus={disableRestoreFocus}
      onTransitionExited={onTransitionExited}
      onKeyDown={handleKeyDown}
      title={title}
      description={description}
      maxWidth="sm"
      actions={
        <>
          <Button onClick={onClose} disabled={isDeleting} variant="outlined" sx={settingsUtilityButtonSx}>
            {CONFIRM_DELETE_STRINGS.BUTTON_CANCEL}
          </Button>
          <Button
            ref={deleteButtonRef}
            onClick={onConfirm}
            color="error"
            variant="contained"
            disabled={isDeleting}
            startIcon={isDeleting ? <CircularProgress size={16} /> : undefined}
          >
            {isDeleting ? CONFIRM_DELETE_STRINGS.BUTTON_DELETING : CONFIRM_DELETE_STRINGS.BUTTON_DELETE}
          </Button>
        </>
      }
    >
      {isSingleItem && item ? (
        <DialogOperationContext entries={[{ label: CONFIRM_DELETE_STRINGS.ARIA_LABEL_ITEM, value: item.name, kind: "fileName" }]} />
      ) : (
        <Box
          component="section"
          aria-label={CONFIRM_DELETE_STRINGS.ARIA_LABEL_ITEMS}
          sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}
        >
          <Typography variant="body2" sx={{ color: (theme) => theme.palette.text.secondary }}>
            {CONFIRM_DELETE_STRINGS.ARIA_LABEL_ITEMS}
          </Typography>
          {visibleItems.map((visibleItem) => (
            <DialogIdentifierDisplay key={visibleItem.path} value={visibleItem.name} kind="fileName" />
          ))}
          {remainingItemCount > 0 ? (
            <Typography variant="body2">{t("fileBrowser.confirmDelete.moreItems", { count: remainingItemCount })}</Typography>
          ) : null}
        </Box>
      )}
    </ResponsiveDialogShell>
  );
};

export default ConfirmDeleteDialog;
