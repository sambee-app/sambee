import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Menu,
  MenuItem,
  Popover,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { type ChangeEvent, useRef, useState } from "react";
import { HexAlphaColorPicker } from "react-colorful";
import api, { getThemeRequestError, type StoredTheme } from "../../services/api";
import { resolveSyntaxTheme } from "../../theme/resolveSyntaxTheme";
import {
  COLOR_ROLES,
  colorAt,
  editableDefinition,
  getThemeCopyName,
  HEX_COLOR_PATTERN,
  normalizeHexColor,
  parseThemeImport,
  THEME_DEFINITION_VERSION,
  validateThemeDefinition,
  withColor,
} from "../../theme/themeDefinition";
import type { ThemeConfig } from "../../theme/types";
import { adminDialogActionButtonSx, adminDialogActionGroupSx, adminDialogSplitActionRowSx } from "../Admin/dialogActionStyles";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { FormFieldLabel, FormGroup, FormRow, FormSurface, formOutlinedControlSx } from "../Form/FormLayout";
import { settingsPrimaryButtonSx, settingsUtilityButtonSx } from "./settingsButtonStyles";

interface ThemeEditorDialogProps {
  theme: ThemeConfig;
  stored: StoredTheme | undefined;
  storedThemes: StoredTheme[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (themeId: string, isCopy: boolean) => Promise<void>;
}

const GROUPS = ["Core", "Viewers", "Markdown", "Syntax", "Search", "Alerts"] as const;

export function ThemeEditorDialog({ theme, stored, storedThemes, isAdmin, onClose, onSaved }: ThemeEditorDialogProps) {
  const muiTheme = useTheme();
  const usesDesktopFormLayout = useMediaQuery(muiTheme.breakpoints.up("md"));
  const [draft, setDraft] = useState<ThemeConfig>(() => resolveSyntaxTheme(theme));
  const [inputColors, setInputColors] = useState<Record<string, string>>({});
  const [group, setGroup] = useState<string | null>("Core");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [activeColor, setActiveColor] = useState<string | null>(null);
  const [copyMenuAnchor, setCopyMenuAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const writable = Boolean(stored && (stored.scope === "user" || isAdmin));
  const storageGroup = stored ? (stored.scope === "site" ? "site" : "personal") : "built-in";

  const close = () => {
    if (pending) return;
    onClose();
  };

  const changeColor = (path: string, value: string) => {
    setInputColors((previous) => ({ ...previous, [path]: value }));
    if (HEX_COLOR_PATTERN.test(value)) {
      setDraft((previous) => withColor(previous, path, value));
      setError(null);
    }
  };

  const save = async (copyScope?: StoredTheme["scope"]) => {
    const invalid = Object.entries(inputColors).find(([, value]) => !HEX_COLOR_PATTERN.test(value));
    const validationError = invalid ? `${invalid[0]}: enter #RRGGBB or #RRGGBBAA.` : validateThemeDefinition(draft);
    if (validationError) {
      setError(validationError);
      const role = invalid
        ? COLOR_ROLES.find((candidate) => candidate.path === invalid[0])
        : COLOR_ROLES.find((candidate) => validationError.startsWith(`${candidate.label}:`));
      if (role) setGroup(role.group);
      requestAnimationFrame(() => document.getElementById(role ? `${role.path}-input` : "theme-name")?.focus());
      return;
    }
    if (!copyScope && !writable) return;
    const name = copyScope
      ? getThemeCopyName(
          draft.name.trim(),
          storedThemes.filter((candidate) => candidate.scope === copyScope).map((candidate) => candidate.definition.name)
        )
      : draft.name.trim();
    if (name !== draft.name.trim()) setDraft((previous) => ({ ...previous, name }));
    setPending(true);
    setError(null);
    try {
      const definition = editableDefinition({ ...draft, name });
      const saved = copyScope ? await api.createTheme(definition, copyScope) : await api.updateTheme(stored!, definition);
      await onSaved(saved.id, Boolean(copyScope));
      onClose();
    } catch (cause) {
      setError(getThemeRequestError(cause));
    } finally {
      setPending(false);
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = parseThemeImport(await file.text());
      setDraft({ ...imported, id: theme.id });
      setInputColors({});
      setError(null);
      setImportError(null);
    } catch (cause) {
      setImportError(`${file.name}: ${cause instanceof Error ? cause.message : "Could not read the theme file."}`);
    }
  };

  const exportDraft = () => {
    const blob = new Blob([JSON.stringify({ version: THEME_DEFINITION_VERSION, definition: editableDefinition(draft) }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "theme.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ResponsiveDialogShell
      open
      onClose={close}
      disableClose={pending}
      title={`Edit ${theme.name} (${storageGroup})`}
      maxWidth="md"
      actionNotice={error ? <Alert severity="error">{error}</Alert> : null}
      actions={
        <Box sx={{ width: "100%" }}>
          {importError && (
            <Alert severity="error" onClose={() => setImportError(null)} sx={{ mb: 1, overflowWrap: "anywhere" }}>
              {importError}
            </Alert>
          )}
          <Box sx={adminDialogSplitActionRowSx}>
            <Box sx={{ display: "flex", gap: 1, width: { xs: "100%", sm: "auto" }, flexWrap: "wrap" }}>
              <Button
                variant="outlined"
                onClick={() => fileInput.current?.click()}
                disabled={pending}
                sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}
              >
                Import
              </Button>
              <Button variant="outlined" onClick={exportDraft} disabled={pending} sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}>
                Export
              </Button>
            </Box>
            <Box sx={adminDialogActionGroupSx}>
              <Button variant="outlined" onClick={close} disabled={pending} sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}>
                Cancel
              </Button>
              <Button
                variant="outlined"
                onClick={(event) => setCopyMenuAnchor(event.currentTarget)}
                disabled={pending}
                aria-haspopup="menu"
                aria-controls={copyMenuAnchor ? "theme-save-copy-menu" : undefined}
                aria-expanded={Boolean(copyMenuAnchor)}
                sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}
              >
                Save copy
              </Button>
              <Button
                variant="contained"
                onClick={() => void save()}
                disabled={!writable || pending}
                sx={[settingsPrimaryButtonSx, adminDialogActionButtonSx]}
              >
                Save
              </Button>
              <Menu
                id="theme-save-copy-menu"
                anchorEl={copyMenuAnchor}
                open={Boolean(copyMenuAnchor)}
                onClose={() => setCopyMenuAnchor(null)}
                autoFocus
                sx={{ zIndex: (currentTheme) => currentTheme.zIndex.modal + 2 }}
              >
                <MenuItem
                  onClick={() => {
                    setCopyMenuAnchor(null);
                    void save("user");
                  }}
                >
                  Your themes
                </MenuItem>
                {isAdmin && (
                  <MenuItem
                    onClick={() => {
                      setCopyMenuAnchor(null);
                      void save("site");
                    }}
                  >
                    Site themes
                  </MenuItem>
                )}
              </Menu>
            </Box>
          </Box>
        </Box>
      }
    >
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        tabIndex={-1}
        onChange={(event) => void importFile(event)}
      />
      <FormSurface>
        <FormGroup>
          <FormRow>
            <Box sx={{ display: { xs: "none", md: "block" } }}>
              <FormFieldLabel
                label="Name"
                description="Name shown in the theme picker"
                descriptionId="theme-name-help"
                htmlFor="theme-name"
              />
            </Box>
            <TextField
              id="theme-name"
              label={usesDesktopFormLayout ? undefined : "Name"}
              size={usesDesktopFormLayout ? "small" : "medium"}
              slotProps={{ htmlInput: { "aria-label": "Name" } }}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              helperText={usesDesktopFormLayout ? undefined : "Name shown in the theme picker"}
              fullWidth
              sx={formOutlinedControlSx}
            />
          </FormRow>
          <FormRow>
            <Box sx={{ display: { xs: "none", md: "block" } }}>
              <FormFieldLabel
                label="Description"
                description="Optional text below the theme name"
                descriptionId="theme-description-help"
                htmlFor="theme-description"
              />
            </Box>
            <TextField
              id="theme-description"
              label={usesDesktopFormLayout ? undefined : "Description"}
              size={usesDesktopFormLayout ? "small" : "medium"}
              slotProps={{ htmlInput: { "aria-label": "Description" } }}
              value={draft.description ?? ""}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              helperText={usesDesktopFormLayout ? undefined : "Optional text below the theme name"}
              fullWidth
              sx={formOutlinedControlSx}
            />
          </FormRow>
          <FormRow>
            <Box sx={{ display: { xs: "none", md: "block" } }}>
              <FormFieldLabel
                label="Mode"
                description="Is this a light or dark theme?"
                descriptionId="theme-mode-help"
                htmlFor="theme-mode"
              />
            </Box>
            <TextField
              select
              id="theme-mode"
              label={usesDesktopFormLayout ? undefined : "Mode"}
              size={usesDesktopFormLayout ? "small" : "medium"}
              slotProps={{ select: { inputProps: { "aria-label": "Mode" } } }}
              value={draft.mode}
              onChange={(event) => setDraft({ ...draft, mode: event.target.value as ThemeConfig["mode"] })}
              helperText={usesDesktopFormLayout ? undefined : "Is this a light or dark theme?"}
              fullWidth
              sx={formOutlinedControlSx}
            >
              <MenuItem value="light">Light</MenuItem>
              <MenuItem value="dark">Dark</MenuItem>
            </TextField>
          </FormRow>
        </FormGroup>
        {GROUPS.map((section) => (
          <Accordion
            key={section}
            expanded={group === section}
            onChange={(_, expanded) => setGroup(expanded ? section : null)}
            disableGutters
            sx={{
              bgcolor: "transparent",
              boxShadow: "none",
              "&.Mui-expanded::before": { opacity: 1 },
              "&.Mui-expanded + &::before": { display: "block" },
              "&:has(.MuiAccordionSummary-root.Mui-focusVisible)::before": { opacity: 0, transition: "none" },
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              sx={{
                width: (theme) => `calc(100% + ${theme.spacing(2)})`,
                mx: -1,
                px: 1,
                "&.Mui-focusVisible": { bgcolor: "transparent", boxShadow: (theme) => `inset 0 0 0 2px ${theme.palette.primary.main}` },
              }}
            >
              <Typography variant="subtitle1">{section}</Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <FormGroup>
                {COLOR_ROLES.filter((role) => role.group === section).map((role) => {
                  const color = colorAt(draft, role.path) ?? "";
                  const input = inputColors[role.path] ?? color;
                  const invalid = inputColors[role.path] !== undefined && !HEX_COLOR_PATTERN.test(input);
                  return (
                    <FormRow key={role.path}>
                      <Box sx={{ display: { xs: "none", md: "block" } }}>
                        <FormFieldLabel
                          label={role.label}
                          description={role.description}
                          descriptionId={`${role.path}-help`}
                          htmlFor={`${role.path}-input`}
                          feedback={invalid ? { severity: "error", message: "Use #RRGGBB or #RRGGBBAA." } : null}
                        />
                      </Box>
                      <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start", justifyContent: { md: "flex-end" }, minWidth: 0 }}>
                        <Box
                          component="button"
                          type="button"
                          aria-label={`Choose ${role.label} color`}
                          onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                            setAnchor(event.currentTarget);
                            setActiveColor(role.path);
                          }}
                          sx={{
                            width: 36,
                            height: { xs: 54, md: 38 },
                            flexShrink: 0,
                            mt: "1px",
                            borderRadius: 1,
                            border: "1px solid",
                            borderColor: "divider",
                            cursor: "pointer",
                            "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 0 },
                            backgroundImage:
                              "linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%), linear-gradient(45deg, #8884 25%, transparent 25%, transparent 75%, #8884 75%)",
                            backgroundSize: "12px 12px",
                            backgroundPosition: "0 0, 6px 6px",
                          }}
                        >
                          <Box sx={{ width: "100%", height: "100%", bgcolor: color }} />
                        </Box>
                        <TextField
                          id={`${role.path}-input`}
                          label={usesDesktopFormLayout ? undefined : role.label}
                          size={usesDesktopFormLayout ? "small" : "medium"}
                          slotProps={{
                            htmlInput: { "aria-label": role.label },
                          }}
                          value={input}
                          onChange={(event) => changeColor(role.path, event.target.value)}
                          onBlur={() => {
                            if (HEX_COLOR_PATTERN.test(input))
                              setInputColors((previous) => ({ ...previous, [role.path]: normalizeHexColor(input) }));
                          }}
                          error={invalid}
                          helperText={usesDesktopFormLayout ? undefined : invalid ? "Use #RRGGBB or #RRGGBBAA." : role.description}
                          sx={[formOutlinedControlSx, { width: { xs: "100%", md: 160 }, minWidth: 0 }]}
                        />
                      </Box>
                    </FormRow>
                  );
                })}
              </FormGroup>
            </AccordionDetails>
          </Accordion>
        ))}
      </FormSurface>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => {
          setAnchor(null);
          setActiveColor(null);
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        {activeColor && (
          <Box
            sx={{
              p: 2,
              ".react-colorful__alpha": {
                backgroundImage:
                  "linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%), linear-gradient(45deg, #ccc 25%, transparent 25%, transparent 75%, #ccc 75%)",
                backgroundSize: "12px 12px",
                backgroundPosition: "0 0, 6px 6px",
              },
            }}
          >
            <HexAlphaColorPicker
              color={colorAt(draft, activeColor) ?? "#000000"}
              onChange={(value) => changeColor(activeColor, normalizeHexColor(value))}
            />
          </Box>
        )}
      </Popover>
    </ResponsiveDialogShell>
  );
}
