//
// SettingsDialog
//

import CloseIcon from "@mui/icons-material/Close";
import { Box, Dialog, Divider, IconButton, Typography } from "@mui/material";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FORM_SURFACE_CSS_VARIABLE, getOverlaySurfaceTokens, OVERLAY_SURFACE_CSS_VARIABLE } from "../../theme/palette";
import { RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX, ResizableDialogHandle, useResizableDialogSize } from "../ResizableDialog";
import { SettingsCategoryContent } from "./SettingsCategoryContent";
import { SettingsCategoryList } from "./SettingsCategoryList";
import { settingsSubduedIconButtonSx } from "./settingsButtonStyles";
import { prefetchSettingsDataForItems } from "./settingsDataSources";
import { SETTINGS_DIALOG_DEFAULT_MAX_HEIGHT_PX, SETTINGS_DIALOG_RESIZE_CONFIG } from "./settingsDialogSize";
import {
  DEFAULT_SETTINGS_CATEGORY,
  getVisibleSettingsNavItems,
  getVisibleSettingsSections,
  type SettingsCategory,
  type SettingsNavItem,
} from "./settingsNavigation";
import { getSettingsPageSurfaceColor } from "./settingsSurface";
import { SettingsAccessProvider, useSettingsAccess } from "./useSettingsAccess";

const SETTINGS_CATEGORY_FIRST_INDEX = 0;

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Initial category to show when dialog opens */
  initialCategory?: SettingsCategory;
  category?: SettingsCategory;
  onNavigate?: (item: SettingsNavItem) => void;
  /** Callback when connections are added, updated, or deleted */
  onConnectionsChanged?: () => void;
}

function SettingsCategoryFocus({
  open,
  selectedItem,
  availableItems,
  categoryRefs,
}: {
  open: boolean;
  selectedItem: SettingsNavItem;
  availableItems: SettingsNavItem[];
  categoryRefs: RefObject<Partial<Record<SettingsNavItem, HTMLDivElement | null>>>;
}) {
  const initialized = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    const item = availableItems.includes(selectedItem) ? selectedItem : (availableItems[0] ?? DEFAULT_SETTINGS_CATEGORY);
    const element = categoryRefs.current[item];
    if (!element) return;
    const ownsFocus = Object.values(categoryRefs.current).some((category) => category === element.ownerDocument.activeElement);
    if (!initialized.current || ownsFocus) element.focus();
    initialized.current = true;
  }, [open, selectedItem, availableItems, categoryRefs]);
  return null;
}

/**
 * SettingsDialog
 *
 * Modal dialog for settings on desktop.
 * Contains sidebar navigation and content area for the consolidated
 * Appearance, Connections, User Management, and System settings.
 */
const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open,
  onClose,
  initialCategory = DEFAULT_SETTINGS_CATEGORY,
  onConnectionsChanged,
  category,
  onNavigate,
}) => {
  const [localSelectedItem, setLocalSelectedItem] = useState<SettingsNavItem>(initialCategory);
  const selectedItem = category ?? localSelectedItem;
  const setSelectedItem = onNavigate ?? setLocalSelectedItem;
  const { isAdmin, canWrite } = useSettingsAccess(open);
  const { t } = useTranslation();

  // Refs for category list items (for arrow key navigation and initial focus)
  const categoryRefs = useRef<Partial<Record<SettingsNavItem, HTMLDivElement | null>>>({});
  const { displayedSize, paperRef, resizeHandleProps } = useResizableDialogSize(SETTINGS_DIALOG_RESIZE_CONFIG);

  // Build list of available items based on admin status
  const availableItems = useMemo(() => getVisibleSettingsNavItems(isAdmin), [isAdmin]);
  const visibleSections = useMemo(() => getVisibleSettingsSections(isAdmin), [isAdmin]);

  const focusCategoryButton = useCallback((item: SettingsNavItem) => {
    categoryRefs.current[item]?.focus();
  }, []);

  //
  // handleCategoryKeyDown
  //
  const handleCategoryKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
        return;
      }

      e.preventDefault();
      const currentIndex = availableItems.indexOf(selectedItem);
      let newIndex = currentIndex;

      switch (e.key) {
        case "ArrowDown":
          newIndex = Math.min(currentIndex + 1, availableItems.length - 1);
          break;
        case "ArrowUp":
          newIndex = Math.max(currentIndex - 1, SETTINGS_CATEGORY_FIRST_INDEX);
          break;
        case "Home":
        case "PageUp":
          newIndex = SETTINGS_CATEGORY_FIRST_INDEX;
          break;
        case "End":
        case "PageDown":
          newIndex = availableItems.length - 1;
          break;
      }

      if (newIndex !== currentIndex) {
        const newItem = availableItems[newIndex];
        if (newItem) {
          setSelectedItem(newItem);
          focusCategoryButton(newItem);
        }
      }
    },
    [availableItems, focusCategoryButton, selectedItem, setSelectedItem]
  );

  useEffect(() => {
    if (open) {
      prefetchSettingsDataForItems(availableItems);
    }
  }, [availableItems, open]);

  // Set category when dialog opens (use initialCategory prop)
  useEffect(() => {
    if (open && category === undefined) {
      setLocalSelectedItem(availableItems.includes(initialCategory) ? initialCategory : (availableItems[0] ?? DEFAULT_SETTINGS_CATEGORY));
    }
  }, [availableItems, initialCategory, open, category]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      slotProps={{
        backdrop: {
          sx: (theme) => {
            const surfaces = getOverlaySurfaceTokens(theme.palette.background.default, theme.palette.mode);
            return surfaces.backdrop ? { bgcolor: surfaces.backdrop } : undefined;
          },
        },
        paper: {
          sx: (theme) => {
            const surfaces = getOverlaySurfaceTokens(theme.palette.background.default, theme.palette.mode);
            return {
              [OVERLAY_SURFACE_CSS_VARIABLE]: surfaces.paper,
              [FORM_SURFACE_CSS_VARIABLE]: surfaces.form,
              height: displayedSize ? `${displayedSize.height}px` : `calc(100dvh - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px)`,
              width: displayedSize
                ? `${displayedSize.width}px`
                : `min(1200px, calc(100dvw - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px))`,
              maxHeight: displayedSize
                ? `calc(100dvh - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px)`
                : SETTINGS_DIALOG_DEFAULT_MAX_HEIGHT_PX,
              maxWidth: `calc(100dvw - ${RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2}px)`,
              overflow: "hidden",
            };
          },
          ref: paperRef,
        },
      }}
    >
      {/* Close button in upper-right corner */}
      <IconButton
        onClick={onClose}
        size="small"
        aria-label={t("settings.shell.closeAriaLabel")}
        sx={{
          position: "absolute",
          right: 8,
          top: 8,
          zIndex: 1,
          ...settingsSubduedIconButtonSx,
        }}
      >
        <CloseIcon />
      </IconButton>

      <ResizableDialogHandle {...resizeHandleProps} testId="settings-dialog-resize-handle" />

      <Box sx={{ display: "flex", height: "100%" }}>
        {/* Left Sidebar */}
        <Box
          sx={{
            width: 280,
            borderRight: 1,
            borderColor: "divider",
            display: "flex",
            flexDirection: "column",
            bgcolor: getSettingsPageSurfaceColor,
          }}
        >
          <Box sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {t("settings.shell.title")}
            </Typography>
          </Box>
          <Divider sx={{ mb: 2 }} />
          <SettingsCategoryList
            sections={visibleSections}
            onSelect={setSelectedItem}
            selectedItem={selectedItem}
            listSx={{ flex: 1, minHeight: 0, overflowY: "auto", py: 0 }}
            listRole="listbox"
            listAriaLabel={t("settings.shell.categoriesAriaLabel")}
            sectionSx={{ mb: 1 }}
            subheaderSx={{ px: 1.5 }}
            wrapItemsInListItem
            getItemRef={(item) => (element) => {
              categoryRefs.current[item] = element;
            }}
            getItemTabIndex={(item) => (selectedItem === item ? 0 : -1)}
            getItemAriaSelected={(item) => selectedItem === item}
            itemRole="option"
            onItemKeyDown={handleCategoryKeyDown}
            itemButtonSx={() => ({ py: 0.5, px: 1.5 })}
            itemIconSx={(selected: boolean) => ({ minWidth: 40, color: selected ? "primary.main" : "text.secondary" })}
            primaryTypographyProps={(selected) => ({
              sx: { fontWeight: selected ? "medium" : "normal" },
            })}
          />
          <SettingsCategoryFocus open={open} selectedItem={selectedItem} availableItems={availableItems} categoryRefs={categoryRefs} />
        </Box>

        {/* Right Content Area */}
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            overflow: "hidden",
            bgcolor: getSettingsPageSurfaceColor,
          }}
        >
          <SettingsAccessProvider value={{ isAdmin, canWrite }}>
            <SettingsCategoryContent
              item={selectedItem}
              isAdmin={isAdmin}
              onConnectionsChanged={onConnectionsChanged}
              dialogSafeHeader
              forceDesktopLayout
            />
          </SettingsAccessProvider>
        </Box>
      </Box>
    </Dialog>
  );
};

export default SettingsDialog;
