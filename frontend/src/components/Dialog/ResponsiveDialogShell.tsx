import CloseIcon from "@mui/icons-material/Close";
import {
  AppBar,
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  type DialogProps,
  DialogTitle,
  Drawer,
  IconButton,
  type SxProps,
  type Theme,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { type ReactNode, type Ref, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE,
  KeyboardShortcutScopeContext,
  useKeyboardShortcutScope,
} from "../../hooks/useKeyboardShortcuts";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import {
  mobileFullscreenDrawerPaperSx,
  mobileSafeAreaAppBarSx,
  mobileSafeAreaToolbarSx,
  mobileScrollableContentSx,
  SAFE_AREA_INSET,
} from "../../theme/mobileShell";
import { FORM_SURFACE_CSS_VARIABLE, getOverlaySurfaceTokens, OVERLAY_SURFACE_CSS_VARIABLE } from "../../theme/palette";
import { DirectionalBackButton } from "../DirectionalBackButton";

interface ResponsiveDialogShellProps {
  open: boolean;
  onClose: () => void;
  disableClose?: boolean;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  contextualNotice?: ReactNode;
  actionNotice?: ReactNode;
  actions?: ReactNode;
  showCloseButton?: boolean;
  closeButtonAriaLabel?: string;
  maxWidth?: DialogProps["maxWidth"];
  onKeyDown?: DialogProps["onKeyDown"];
  onEscape?: () => void;
  contentSx?: SxProps<Theme>;
  paperSx?: SxProps<Theme>;
  paperRef?: Ref<HTMLDivElement>;
  paperOverlay?: ReactNode;
  fullWidth?: boolean;
  dialogZIndexOffset?: number;
  container?: DialogProps["container"];
  mobileActionLabel?: string;
  disableAutoFocus?: boolean;
  disableEnforceFocus?: boolean;
  disableRestoreFocus?: boolean;
  restoreFocusEl?: HTMLElement | null;
  onTransitionEntered?: () => void;
  onTransitionExited?: () => void;
}

export const responsiveDialogShellContentPaddingSx: SxProps<Theme> = {
  px: { xs: 2, sm: 3 },
  py: 2,
};

export function ResponsiveDialogShell({
  open,
  onClose,
  disableClose = false,
  title,
  description,
  children,
  contextualNotice,
  actionNotice,
  actions,
  showCloseButton = false,
  closeButtonAriaLabel,
  maxWidth = "sm",
  onKeyDown,
  onEscape,
  contentSx,
  paperSx,
  paperRef,
  paperOverlay,
  fullWidth = true,
  dialogZIndexOffset = 1,
  container,
  mobileActionLabel,
  disableAutoFocus = false,
  disableEnforceFocus = false,
  disableRestoreFocus = false,
  restoreFocusEl = null,
  onTransitionEntered,
  onTransitionExited,
}: ResponsiveDialogShellProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const shortcutScopeId = useKeyboardShortcutScope(open);
  const resolvedContainerRef = useRef<Element | null>(null);
  const [openContainer, setOpenContainer] = useState<Element | null>(null);
  useLayoutEffect(() => {
    if (!open || !container) {
      resolvedContainerRef.current = null;
      setOpenContainer(null);
      return;
    }
    if (!resolvedContainerRef.current) {
      const element = (typeof container === "function" ? container() : container) ?? document.body;
      resolvedContainerRef.current = element;
      setOpenContainer(element);
    }
  }, [container, open]);
  // Wait for the target before mounting the portal so it never moves out of fullscreen while open.
  const modalOpen = open && (!container || Boolean(openContainer));
  const modalContainer = openContainer ?? undefined;
  const disableScrollLock = Boolean(modalContainer && modalContainer !== document.body);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(open);
  const renderedDescription = description ? (
    <Box id={descriptionId} sx={{ mb: 3 }}>
      {typeof description === "string" ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {description}
        </Typography>
      ) : (
        description
      )}
    </Box>
  ) : null;

  useEffect(() => {
    if (!disableRestoreFocus && open && !wasOpenRef.current) {
      if (restoreFocusEl) {
        triggerElementRef.current = restoreFocusEl;
      } else if (document.activeElement instanceof HTMLElement) {
        triggerElementRef.current = document.activeElement;
      }
    }

    if (!disableRestoreFocus && !open && wasOpenRef.current) {
      const triggerElement = triggerElementRef.current;
      if (triggerElement?.isConnected) {
        setTimeout(() => {
          if (triggerElement.isConnected) {
            triggerElement.focus();
          }
        }, 0);
      }
    }

    wasOpenRef.current = open;
  }, [disableRestoreFocus, open, restoreFocusEl]);

  const handleRequestClose = () => {
    if (!disableClose) {
      onClose();
    }
  };

  const handleShellKeyDown: DialogProps["onKeyDown"] = (event) => {
    event.stopPropagation();
    if (event.key !== "Escape") {
      onKeyDown?.(event);
    }
  };

  const handleShellClose = (_event: unknown, reason: string) => {
    if (reason === "escapeKeyDown" && onEscape) {
      onEscape();
      return;
    }
    handleRequestClose();
  };

  const getSurfaceSx = (currentTheme: Theme) => {
    const surfaces = getOverlaySurfaceTokens(
      currentTheme.palette.background.default,
      currentTheme.palette.mode,
      currentTheme.palette.chrome
    );
    return {
      backgroundColor: surfaces.paper,
      [OVERLAY_SURFACE_CSS_VARIABLE]: surfaces.paper,
      [FORM_SURFACE_CSS_VARIABLE]: surfaces.form,
    };
  };

  if (isMobile) {
    return (
      <KeyboardShortcutScopeContext value={shortcutScopeId}>
        <Drawer
          {...{ [KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE]: shortcutScopeId }}
          anchor="right"
          open={modalOpen}
          ModalProps={{ container: modalContainer, disableScrollLock }}
          onClose={handleShellClose}
          onKeyDown={handleShellKeyDown}
          disableAutoFocus={disableAutoFocus}
          disableEnforceFocus={disableEnforceFocus}
          disableRestoreFocus={disableRestoreFocus || Boolean(restoreFocusEl)}
          sx={{ zIndex: (currentTheme) => currentTheme.zIndex.modal + dialogZIndexOffset }}
          slotProps={{
            transition: { onEntered: onTransitionEntered, onExited: onTransitionExited },
            paper: {
              ref: paperRef,
              sx: [
                (currentTheme) => ({ ...mobileFullscreenDrawerPaperSx, ...getSurfaceSx(currentTheme) }),
                ...(Array.isArray(paperSx) ? paperSx : paperSx ? [paperSx] : []),
              ],
            },
          }}
        >
          <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            <AppBar position="static" sx={mobileSafeAreaAppBarSx}>
              <Toolbar sx={mobileSafeAreaToolbarSx}>
                {!showCloseButton && (
                  <DirectionalBackButton
                    onClick={handleRequestClose}
                    aria-label={mobileActionLabel ?? t("common.navigation.goBack")}
                    disabled={disableClose}
                  />
                )}
                <Typography
                  id={titleId}
                  variant="h6"
                  component="h1"
                  sx={{
                    flex: 1,
                    marginInlineStart: showCloseButton ? 0 : 2,
                    fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_TITLE_PX}px`,
                  }}
                >
                  {title}
                </Typography>
                {showCloseButton && (
                  <IconButton
                    edge="end"
                    color="inherit"
                    onClick={handleRequestClose}
                    aria-label={closeButtonAriaLabel ?? t("common.actions.close")}
                    disabled={disableClose}
                  >
                    <CloseIcon />
                  </IconButton>
                )}
              </Toolbar>
            </AppBar>
            <Box
              sx={[
                responsiveDialogShellContentPaddingSx,
                {
                  ...mobileScrollableContentSx,
                  pb: `calc(16px + ${SAFE_AREA_INSET.BOTTOM})`,
                  fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_BODY_PX}px`,
                  "& .MuiTypography-body1, & .MuiTypography-body2, & .MuiDialogContentText-root": {
                    fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_BODY_PX}px`,
                  },
                  "& .MuiInputLabel-root": {
                    fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_FORM_LABEL_PX}px`,
                  },
                },
                ...(Array.isArray(contentSx) ? contentSx : contentSx ? [contentSx] : []),
              ]}
            >
              {renderedDescription}
              {contextualNotice}
              {children}
              {actionNotice}
            </Box>
            {actions && (
              <Box
                data-testid="responsive-form-dialog-mobile-actions"
                sx={{
                  position: "sticky",
                  bottom: 0,
                  display: "flex",
                  gap: 1,
                  flexShrink: 0,
                  mt: "auto",
                  p: 2,
                  pb: `calc(16px + ${SAFE_AREA_INSET.BOTTOM})`,
                  pl: `calc(16px + ${SAFE_AREA_INSET.LEFT})`,
                  pr: `calc(16px + ${SAFE_AREA_INSET.RIGHT})`,
                  borderTop: 1,
                  borderColor: "divider",
                  zIndex: 1,
                }}
              >
                {actions}
              </Box>
            )}
          </Box>
        </Drawer>
      </KeyboardShortcutScopeContext>
    );
  }

  return (
    <KeyboardShortcutScopeContext value={shortcutScopeId}>
      <Dialog
        {...{ [KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE]: shortcutScopeId }}
        open={modalOpen}
        container={modalContainer}
        disableScrollLock={disableScrollLock}
        onClose={handleShellClose}
        onKeyDown={handleShellKeyDown}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        maxWidth={maxWidth}
        fullWidth={fullWidth}
        disableAutoFocus={disableAutoFocus}
        disableEnforceFocus={disableEnforceFocus}
        disableRestoreFocus={disableRestoreFocus || Boolean(restoreFocusEl)}
        slotProps={{
          paper: {
            ref: paperRef,
            sx: [(currentTheme) => getSurfaceSx(currentTheme), ...(Array.isArray(paperSx) ? paperSx : paperSx ? [paperSx] : [])],
          },
          transition: { onEntered: onTransitionEntered, onExited: onTransitionExited },
        }}
        sx={{ zIndex: (currentTheme) => currentTheme.zIndex.modal + dialogZIndexOffset }}
      >
        <DialogTitle id={titleId} sx={showCloseButton ? { pr: 7 } : undefined}>
          {title}
        </DialogTitle>
        {showCloseButton && (
          <IconButton
            onClick={handleRequestClose}
            aria-label={closeButtonAriaLabel ?? t("common.actions.close")}
            disabled={disableClose}
            size="small"
            sx={{ position: "absolute", right: 8, top: 8, zIndex: 1 }}
          >
            <CloseIcon />
          </IconButton>
        )}
        {paperOverlay}
        <DialogContent
          sx={[
            { ".MuiDialogTitle-root + &&": { pt: 2 } },
            responsiveDialogShellContentPaddingSx,
            ...(Array.isArray(contentSx) ? contentSx : contentSx ? [contentSx] : []),
          ]}
        >
          {renderedDescription}
          {contextualNotice}
          {children}
          {actionNotice}
        </DialogContent>
        {actions && (
          <DialogActions data-testid="responsive-form-dialog-desktop-actions" sx={{ borderTop: 1, borderColor: "divider" }}>
            {actions}
          </DialogActions>
        )}
      </Dialog>
    </KeyboardShortcutScopeContext>
  );
}
