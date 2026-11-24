import CheckIcon from "@mui/icons-material/Check";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CheckBoxOutlinedIcon from "@mui/icons-material/CheckBoxOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, MenuItem, MenuList, Typography } from "@mui/material";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FilesystemSearchRequest } from "../../services/filesystemSearchContract";
import { getQuickBarDropdownLabelSx, quickBarDropdownActiveRow, quickBarDropdownRowPadding } from "./QuickBarResultRow";

export type LiveSearchOptions = Pick<FilesystemSearchRequest, "case_sensitive" | "folder_depth" | "item_type" | "search_archives">;

export const DEFAULT_LIVE_SEARCH_OPTIONS: LiveSearchOptions = {
  case_sensitive: false,
  folder_depth: "recursive",
  item_type: "all",
  search_archives: false,
};

interface Props {
  options: LiveSearchOptions;
  onChange: (options: LiveSearchOptions) => void;
  listRef: RefObject<HTMLUListElement | null>;
  onEscape: () => void;
  onTab: () => void;
  useCompactLayout: boolean;
  showKeyboardHints: boolean;
}

type Choice = "folder_depth" | "item_type";

export function focusLiveSearchOption(list: HTMLUListElement | null, edge: "first" | "last") {
  const rows = list?.querySelectorAll<HTMLElement>("[role^='menuitem']");
  (edge === "first" ? rows?.[0] : rows?.[rows.length - 1])?.focus();
}

/** Options share the quick-bar dropdown surface, but have their own focus and selection behavior. */
export function LiveSearchOptionsPanel({ options, onChange, listRef, onEscape, onTab, useCompactLayout, showKeyboardHints }: Props) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<Choice | null>(null);
  const parentRow = useRef<Choice | null>(null);
  const depthLabel = t("fileBrowser.search.live.folderDepth");
  const typeLabel = t("fileBrowser.search.navigation.itemTypeLabel");
  const depthValue = (value: LiveSearchOptions["folder_depth"]) => t(`fileBrowser.search.live.depth.${value}`);
  const itemTypeValue = (value: LiveSearchOptions["item_type"]) => t(`fileBrowser.search.navigation.itemType.${value}`);

  useLayoutEffect(() => {
    if (choice) {
      listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    } else if (parentRow.current) {
      listRef.current?.querySelector<HTMLElement>(`[data-option="${parentRow.current}"]`)?.focus();
      parentRow.current = null;
    }
  }, [choice, listRef]);

  const openChoice = (next: Choice) => {
    parentRow.current = next;
    setChoice(next);
  };
  const rowSx = {
    ...quickBarDropdownRowPadding,
    minHeight: 44,
    gap: 1.25,
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    "&:hover": { backgroundColor: "action.hover" },
    "&&.Mui-focusVisible": {
      ...quickBarDropdownActiveRow,
      outline: "none",
      "@media (forced-colors: active)": {
        outline: "2px solid Highlight",
        outlineOffset: "-2px",
      },
    },
  } as const;
  const rowLabel = (label: string) => (
    <Box component="span" sx={{ ...getQuickBarDropdownLabelSx(useCompactLayout), minWidth: 0 }}>
      {label}
    </Box>
  );
  const rowContent = (label: string, value: string) => (
    <>
      {rowLabel(label)}
      <Box
        component="span"
        sx={{ typography: "caption", color: "text.secondary", marginInlineStart: "auto", textAlign: "end", minWidth: 0 }}
      >
        {value}
      </Box>
      <ChevronRightIcon
        fontSize="small"
        aria-hidden="true"
        sx={{ flexShrink: 0, color: "text.secondary", transform: (theme) => (theme.direction === "rtl" ? "rotate(180deg)" : undefined) }}
      />
    </>
  );
  const checkmark = (checked: boolean) => (
    <Box sx={{ width: 20, height: 20, flexShrink: 0, marginInlineStart: "auto", color: "text.secondary" }}>
      {checked && <CheckIcon fontSize="small" aria-hidden="true" />}
    </Box>
  );
  const checkbox = (checked: boolean) => {
    const Icon = checked ? CheckBoxOutlinedIcon : CheckBoxOutlineBlankIcon;
    return <Icon fontSize="small" aria-hidden="true" sx={{ marginInlineStart: "auto", flexShrink: 0, color: "text.secondary" }} />;
  };

  return (
    <>
      <MenuList
        ref={listRef}
        disablePadding
        aria-label={choice === "folder_depth" ? depthLabel : choice === "item_type" ? typeLabel : t("fileBrowser.search.live.options")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (choice) setChoice(null);
            else onEscape();
          } else if (event.key === "Tab") {
            onTab();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // MenuList moves focus before calling this handler.
            event.stopPropagation();
          }
        }}
        sx={{ maxHeight: "min(45dvh, 18rem)", overflowY: "auto" }}
      >
        {choice === "folder_depth" ? (
          (["current", "recursive"] as const).map((value) => (
            <MenuItem
              key={value}
              role="menuitemradio"
              aria-checked={options.folder_depth === value}
              tabIndex={-1}
              onClick={() => {
                onChange({ ...options, folder_depth: value });
                setChoice(null);
              }}
              sx={rowSx}
            >
              {rowLabel(depthValue(value))}
              {checkmark(options.folder_depth === value)}
            </MenuItem>
          ))
        ) : choice === "item_type" ? (
          (["all", "directories", "files"] as const).map((value) => (
            <MenuItem
              key={value}
              role="menuitemradio"
              aria-checked={options.item_type === value}
              tabIndex={-1}
              onClick={() => {
                onChange({ ...options, item_type: value });
                setChoice(null);
              }}
              sx={rowSx}
            >
              {rowLabel(itemTypeValue(value))}
              {checkmark(options.item_type === value)}
            </MenuItem>
          ))
        ) : (
          <>
            <MenuItem data-option="folder_depth" aria-haspopup="menu" tabIndex={-1} onClick={() => openChoice("folder_depth")} sx={rowSx}>
              {rowContent(depthLabel, depthValue(options.folder_depth))}
            </MenuItem>
            <MenuItem data-option="item_type" aria-haspopup="menu" tabIndex={-1} onClick={() => openChoice("item_type")} sx={rowSx}>
              {rowContent(typeLabel, itemTypeValue(options.item_type))}
            </MenuItem>
            <MenuItem
              role="menuitemcheckbox"
              aria-checked={options.case_sensitive}
              tabIndex={-1}
              onClick={() => onChange({ ...options, case_sensitive: !options.case_sensitive })}
              sx={rowSx}
            >
              {rowLabel(t("fileBrowser.search.live.caseSensitive"))}
              {checkbox(options.case_sensitive)}
            </MenuItem>
            <MenuItem
              role="menuitemcheckbox"
              aria-checked={options.search_archives}
              tabIndex={-1}
              onClick={() => onChange({ ...options, search_archives: !options.search_archives })}
              sx={rowSx}
            >
              {rowLabel(t("fileBrowser.search.live.archives"))}
              {checkbox(options.search_archives)}
            </MenuItem>
          </>
        )}
      </MenuList>
      {showKeyboardHints && (
        <Typography
          variant="caption"
          component="div"
          color="text.secondary"
          sx={{ ...quickBarDropdownRowPadding, borderTop: 1, borderColor: "divider", bgcolor: "action.hover" }}
        >
          {t("fileBrowser.search.live.optionsKeyboardHint")}
        </Typography>
      )}
    </>
  );
}
