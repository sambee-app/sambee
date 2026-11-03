import {
  Article as ArticleIcon,
  ChevronRight as ChevronRightIcon,
  Dns as DnsIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  InfoOutlined as InfoOutlinedIcon,
  ManageAccounts as ManageAccountsIcon,
  ManageSearch as ManageSearchIcon,
  Palette as PaletteIcon,
  PeopleAlt as PeopleAltIcon,
  Public as PublicIcon,
  Storage as StorageIcon,
  Tune as TuneIcon,
  Usb as UsbIcon,
  VpnKey as VpnKeyIcon,
} from "@mui/icons-material";
import {
  Box,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  type SxProps,
  type Theme,
  Typography,
  type TypographyProps,
} from "@mui/material";
import type { KeyboardEventHandler, Ref } from "react";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import { getSettingsCategoryLabel, type SettingsNavItem, type VisibleSettingsSection } from "./settingsNavigation";

type Resolvable<T> = T | ((selected: boolean, item: SettingsNavItem) => T);

const SETTINGS_PARENT_ICON_GLYPH_SX: SxProps<Theme> = {
  fontSize: {
    xs: `${COMPACT_LAYOUT_SIZE.SETTINGS_CATEGORY_ICON_PX}px`,
    sm: "1.25rem",
  },
  transition: "none",
};
const SETTINGS_PARENT_TYPOGRAPHY_PROPS: Partial<TypographyProps> = {
  variant: "body1",
  sx: {
    fontSize: {
      xs: `${COMPACT_LAYOUT_SIZE.SETTINGS_PRIMARY_TEXT_PX}px`,
      sm: "0.875rem",
    },
  },
};
const SETTINGS_SUBHEADER_SX: SxProps<Theme> = {
  bgcolor: "transparent",
  fontWeight: 600,
  lineHeight: 2.5,
  textTransform: "uppercase",
  letterSpacing: 0.8,
};

interface SettingsCategoryListProps {
  sections: VisibleSettingsSection[];
  onSelect: (item: SettingsNavItem) => void;
  selectedItem?: SettingsNavItem;
  showChevron?: boolean;
  showDividers?: boolean;
  wrapItemsInListItem?: boolean;
  listRole?: string;
  listAriaLabel?: string;
  itemRole?: string;
  onItemKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  getItemRef?: (item: SettingsNavItem) => Ref<HTMLDivElement> | undefined;
  getItemTabIndex?: (item: SettingsNavItem) => number | undefined;
  getItemAriaSelected?: (item: SettingsNavItem) => boolean | undefined;
  listSx?: SxProps<Theme>;
  sectionSx?: SxProps<Theme>;
  subheaderSx?: SxProps<Theme>;
  itemButtonSx?: Resolvable<SxProps<Theme>>;
  itemIconSx?: Resolvable<SxProps<Theme>>;
  iconGlyphSx?: SxProps<Theme>;
  primaryTypographyProps?: Resolvable<Partial<TypographyProps>>;
}

function resolveProp<T>(value: Resolvable<T> | undefined, selected: boolean, item: SettingsNavItem): T | undefined {
  if (typeof value === "function") {
    return (value as (selected: boolean, item: SettingsNavItem) => T)(selected, item);
  }

  return value;
}

function appendSx(base: SxProps<Theme> | undefined, extra: SxProps<Theme>): SxProps<Theme> {
  if (!base) {
    return extra;
  }

  return (Array.isArray(base) ? [...base, extra] : [base, extra]) as SxProps<Theme>;
}

function mergeTypographyProps(base: Partial<TypographyProps>, extra: Partial<TypographyProps> | undefined): Partial<TypographyProps> {
  if (!extra) {
    return base;
  }

  return {
    ...base,
    ...extra,
    sx: extra.sx ? appendSx(base.sx as SxProps<Theme> | undefined, extra.sx as SxProps<Theme>) : base.sx,
  };
}

function renderCategoryIcon(item: SettingsNavItem, iconGlyphSx?: SxProps<Theme>) {
  switch (item) {
    case "appearance":
      return <PaletteIcon sx={iconGlyphSx} />;
    case "account":
      return <ManageAccountsIcon sx={iconGlyphSx} />;
    case "file-browser":
      return <FolderOpenIcon sx={iconGlyphSx} />;
    case "text-editor":
      return <ArticleIcon sx={iconGlyphSx} />;
    case "connections":
      return <StorageIcon sx={iconGlyphSx} />;
    case "local-drives":
      return <UsbIcon sx={iconGlyphSx} />;
    case "admin-network":
      return <PublicIcon sx={iconGlyphSx} />;
    case "admin-authentication":
      return <VpnKeyIcon sx={iconGlyphSx} />;
    case "admin-users":
      return <PeopleAltIcon sx={iconGlyphSx} />;
    case "admin-smb":
      return <DnsIcon sx={iconGlyphSx} />;
    case "admin-file-search":
      return <ManageSearchIcon sx={iconGlyphSx} />;
    case "admin-directory-search":
      return <FolderIcon sx={iconGlyphSx} />;
    case "admin-system":
      return <TuneIcon sx={iconGlyphSx} />;
    case "admin-about":
      return <InfoOutlinedIcon sx={iconGlyphSx} />;
  }
}

export function SettingsCategoryList({
  sections,
  onSelect,
  selectedItem,
  showChevron = false,
  showDividers = false,
  wrapItemsInListItem = false,
  listRole,
  listAriaLabel,
  itemRole,
  onItemKeyDown,
  getItemRef,
  getItemTabIndex,
  getItemAriaSelected,
  listSx,
  sectionSx,
  subheaderSx,
  itemButtonSx,
  itemIconSx,
  iconGlyphSx,
  primaryTypographyProps,
}: SettingsCategoryListProps) {
  const resolvedSubheaderSx = subheaderSx ? appendSx(SETTINGS_SUBHEADER_SX, subheaderSx) : SETTINGS_SUBHEADER_SX;

  return (
    <List sx={listSx} role={listRole} aria-label={listAriaLabel}>
      {sections.map((section) => (
        <Box key={section.section} sx={sectionSx}>
          <ListSubheader disableSticky sx={resolvedSubheaderSx}>
            {section.label}
          </ListSubheader>
          {section.categories.map((category) => {
            const isSelected = selectedItem === category;
            const parentTypographyProps = mergeTypographyProps(
              SETTINGS_PARENT_TYPOGRAPHY_PROPS,
              resolveProp(primaryTypographyProps, isSelected, category)
            );
            const parentIconGlyphSx = iconGlyphSx ? appendSx(SETTINGS_PARENT_ICON_GLYPH_SX, iconGlyphSx) : SETTINGS_PARENT_ICON_GLYPH_SX;
            const button = (
              <ListItemButton
                ref={getItemRef?.(category)}
                onClick={() => onSelect(category)}
                onKeyDown={onItemKeyDown}
                selected={isSelected}
                disableRipple
                disableTouchRipple
                tabIndex={getItemTabIndex?.(category)}
                role={itemRole}
                aria-selected={getItemAriaSelected?.(category)}
                sx={appendSx(resolveProp(itemButtonSx, isSelected, category), {
                  transition: "none",
                  "& .MuiTouchRipple-root": {
                    display: "none",
                  },
                  "& .MuiTypography-root": {
                    transition: "none",
                  },
                  "& .MuiListItemIcon-root": {
                    transition: "none",
                  },
                  "& .MuiSvgIcon-root": {
                    transition: "none",
                  },
                })}
              >
                <ListItemIcon sx={resolveProp(itemIconSx, isSelected, category)}>
                  {renderCategoryIcon(category, parentIconGlyphSx)}
                </ListItemIcon>
                <ListItemText primary={<Typography {...parentTypographyProps}>{getSettingsCategoryLabel(category)}</Typography>} />
                {showChevron && (
                  <ChevronRightIcon
                    sx={{
                      color: "text.secondary",
                      fontSize: { xs: `${COMPACT_LAYOUT_SIZE.SETTINGS_CATEGORY_ICON_PX}px`, sm: "1.25rem" },
                    }}
                  />
                )}
              </ListItemButton>
            );

            if (wrapItemsInListItem) {
              return (
                <Box key={category}>
                  <ListItem disablePadding>{button}</ListItem>
                  {showDividers && <Divider />}
                </Box>
              );
            }

            return (
              <Box key={category}>
                {button}
                {showDividers && <Divider />}
              </Box>
            );
          })}
        </Box>
      ))}
    </List>
  );
}
