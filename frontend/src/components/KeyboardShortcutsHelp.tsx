import ClearIcon from "@mui/icons-material/Clear";
import SearchIcon from "@mui/icons-material/Search";
import { Box, IconButton, InputAdornment, Table, TableBody, TableCell, TableRow, TextField, Typography } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardShortcut, ShortcutHelpGroup } from "../hooks/useKeyboardShortcuts";
import { ResponsiveDialogShell } from "./Dialog/ResponsiveDialogShell";
import {
  RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX,
  type ResizableDialogConfig,
  ResizableDialogHandle,
  useResizableDialogSize,
} from "./ResizableDialog";

interface KeyboardShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
  shortcuts: KeyboardShortcut[];
  title?: string;
}

/**
 * Group shortcuts by description to combine multiple shortcuts for the same action
 */
interface GroupedShortcut {
  description: string;
  labels: string[];
}

interface ShortcutHelpSection {
  id: ShortcutHelpGroup;
  shortcuts: GroupedShortcut[];
}

const DEFAULT_SHORTCUT_HELP_GROUP: ShortcutHelpGroup = "general";

const SHORTCUT_HELP_GROUP_ORDER: ShortcutHelpGroup[] = [
  "general",
  "search",
  "navigation",
  "selection",
  "fileActions",
  "editing",
  "view",
  "panes",
];
const SHORTCUTS_HELP_DIALOG_HEIGHT = "min(720px, calc(100dvh - 64px))";
const SHORTCUTS_HELP_FOCUS_ACCENT_OFFSET_PX = 14;
const SHORTCUTS_HELP_FOCUS_ACCENT_WIDTH_PX = 3;
const SHORTCUTS_HELP_DIALOG_DEFAULT_WIDTH_PX = 768;
const SHORTCUTS_HELP_DIALOG_RESIZE_CONFIG = {
  storageKey: "keyboard-shortcuts-dialog-size",
  minWidth: 640,
  minHeight: 480,
  maxWidth: 800,
} satisfies ResizableDialogConfig;

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Unified keyboard shortcuts help dialog
 * Displays all shortcuts passed to it (does not filter by enabled state)
 * The enabled property controls whether shortcuts function, not whether they appear in help
 * Groups shortcuts with the same description into a single row
 */
export const KeyboardShortcutsHelp: React.FC<KeyboardShortcutsHelpProps> = ({ open, onClose, shortcuts, title }) => {
  const { t } = useTranslation();
  const dialogTitle = title ?? t("keyboardShortcutsHelp.defaultTitle");
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { displayedSize, paperRef, resizeHandleProps } = useResizableDialogSize(SHORTCUTS_HELP_DIALOG_RESIZE_CONFIG);

  useEffect(() => {
    if (open) {
      setSearchQuery("");
    }
  }, [open]);

  const groupedShortcuts = useMemo<ShortcutHelpSection[]>(() => {
    const normalizedQuery = normalizeSearchValue(searchQuery);
    const sections = new Map<ShortcutHelpGroup, GroupedShortcut[]>();
    const sectionDescriptions = new Map<ShortcutHelpGroup, Map<string, GroupedShortcut>>();

    for (const shortcut of shortcuts) {
      const sectionId = shortcut.helpGroup ?? DEFAULT_SHORTCUT_HELP_GROUP;
      const label = shortcut.label || shortcut.keys.toString();
      const sectionLabel = t(`keyboardShortcutsHelp.groups.${sectionId}`);

      if (
        normalizedQuery &&
        ![sectionLabel, label, shortcut.description].some((value) => normalizeSearchValue(value).includes(normalizedQuery))
      ) {
        continue;
      }

      let sectionShortcuts = sections.get(sectionId);
      if (!sectionShortcuts) {
        sectionShortcuts = [];
        sections.set(sectionId, sectionShortcuts);
      }

      let descriptionMap = sectionDescriptions.get(sectionId);
      if (!descriptionMap) {
        descriptionMap = new Map<string, GroupedShortcut>();
        sectionDescriptions.set(sectionId, descriptionMap);
      }

      const existing = descriptionMap.get(shortcut.description);
      if (existing) {
        if (!existing.labels.includes(label)) {
          existing.labels.push(label);
        }
        continue;
      }

      const groupedShortcut = {
        description: shortcut.description,
        labels: [label],
      };

      descriptionMap.set(shortcut.description, groupedShortcut);
      sectionShortcuts.push(groupedShortcut);
    }

    return SHORTCUT_HELP_GROUP_ORDER.flatMap((sectionId) => {
      const sectionShortcuts = sections.get(sectionId);
      return sectionShortcuts && sectionShortcuts.length > 0 ? [{ id: sectionId, shortcuts: sectionShortcuts }] : [];
    });
  }, [searchQuery, shortcuts, t]);

  const hasSearchQuery = searchQuery.trim() !== "";

  return (
    <ResponsiveDialogShell
      open={open}
      onClose={onClose}
      title={dialogTitle}
      maxWidth={false}
      fullWidth={false}
      showCloseButton
      closeButtonAriaLabel={t("keyboardShortcutsHelp.closeAriaLabel")}
      contentSx={{
        display: { xs: "block", sm: "flex" },
        flexDirection: "column",
        height: { sm: "100%" },
        overflow: { sm: "hidden" },
      }}
      paperRef={paperRef}
      paperSx={{
        height: { sm: displayedSize ? `${displayedSize.height}px` : SHORTCUTS_HELP_DIALOG_HEIGHT },
        maxHeight: `calc(100dvh - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px)`,
        maxWidth: `calc(100dvw - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px)`,
        overflow: "hidden",
        width: {
          sm: displayedSize
            ? `${displayedSize.width}px`
            : `min(${SHORTCUTS_HELP_DIALOG_DEFAULT_WIDTH_PX}px, calc(100dvw - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px))`,
        },
      }}
      paperOverlay={<ResizableDialogHandle {...resizeHandleProps} testId="keyboard-shortcuts-dialog-resize-handle" />}
      onTransitionEntered={() => searchInputRef.current?.focus()}
    >
      <Box sx={{ display: { xs: "grid", sm: "flex" }, flexDirection: "column", gap: 2, height: { sm: "100%" }, minHeight: 0 }}>
        <TextField
          autoFocus
          fullWidth
          inputRef={searchInputRef}
          placeholder={t("keyboardShortcutsHelp.searchPlaceholder")}
          size="small"
          slotProps={{
            htmlInput: {
              "aria-label": t("keyboardShortcutsHelp.searchAriaLabel"),
            },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: searchQuery ? (
                <InputAdornment position="end">
                  <IconButton aria-label={t("common.search.clear")} edge="end" onClick={() => setSearchQuery("")} size="small">
                    <ClearIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : undefined,
            },
          }}
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <Box
          sx={{
            flex: { sm: 1 },
            minHeight: 0,
            position: "relative",
            "&:focus-within::before": {
              bgcolor: "primary.main",
              bottom: 0,
              content: '""',
              left: -SHORTCUTS_HELP_FOCUS_ACCENT_OFFSET_PX,
              pointerEvents: "none",
              position: "absolute",
              top: 0,
              width: SHORTCUTS_HELP_FOCUS_ACCENT_WIDTH_PX,
            },
          }}
        >
          <Box
            aria-label={t("keyboardShortcutsHelp.resultsAriaLabel")}
            role="region"
            tabIndex={0}
            sx={{ height: "100%", outline: "none", overflowY: { sm: "auto" } }}
          >
            {groupedShortcuts.length === 0 ? (
              <Box sx={{ py: 2, textAlign: "center", color: "text.secondary" }}>
                {t(hasSearchQuery ? "keyboardShortcutsHelp.noSearchResults" : "keyboardShortcutsHelp.emptyState")}
              </Box>
            ) : (
              <Box>
                {groupedShortcuts.map((section, index) => (
                  <Box key={section.id} component="section" sx={{ mt: index === 0 ? 0 : 2.5 }}>
                    <Typography
                      component="h3"
                      variant="subtitle2"
                      sx={{ mb: 1, color: "text.secondary", letterSpacing: 0.6, textTransform: "uppercase" }}
                    >
                      {t(`keyboardShortcutsHelp.groups.${section.id}`)}
                    </Typography>
                    <Table size="small">
                      <TableBody>
                        {section.shortcuts.map((group, shortcutIndex) => {
                          const isLastShortcut = shortcutIndex === section.shortcuts.length - 1;
                          const cellSx = isLastShortcut ? { borderBottom: 0 } : undefined;

                          return (
                            <TableRow key={`${section.id}-${group.description}`}>
                              <TableCell sx={{ borderBottom: cellSx?.borderBottom, whiteSpace: "nowrap", width: { xs: "1%", sm: "35%" } }}>
                                <strong>{group.labels.join(" / ")}</strong>
                              </TableCell>
                              <TableCell sx={cellSx}>{group.description}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        </Box>
      </Box>
    </ResponsiveDialogShell>
  );
};
