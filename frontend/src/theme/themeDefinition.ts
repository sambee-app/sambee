import { resolveSyntaxTheme } from "./resolveSyntaxTheme";
import { HEX_COLOR_PATTERN, THEME_SCHEMA, type ThemeConfig, type ThemeFieldSchema } from "./types";

export { HEX_COLOR_PATTERN } from "./types";

export const THEME_DEFINITION_VERSION = 1;
const COPY_SUFFIX = " (copy)";

export function getThemeCopyName(name: string, existingNames: Iterable<string>, alwaysCopy = false): string {
  const names = new Set(Array.from(existingNames, (existing) => existing.trim().toLocaleLowerCase()));
  if (!alwaysCopy && !names.has(name.toLocaleLowerCase())) return name;
  let copyName = `${name}${COPY_SUFFIX}`;
  for (let number = 2; names.has(copyName.toLocaleLowerCase()); number++) {
    copyName = `${name} (copy ${number})`;
  }
  return copyName;
}

export interface ColorRole {
  path: string;
  label: string;
  description: string;
  group: string;
}

const NON_EDITABLE_ROLES = new Set(["background.paper", "action.focus", "action.selectedDarker"]);

function collectColors(schema: ThemeFieldSchema, prefix: string, group: string): ColorRole[] {
  if (!schema.fields) {
    return NON_EDITABLE_ROLES.has(prefix) ? [] : [{ path: prefix, label: schema.label, description: schema.description, group }];
  }
  return Object.entries(schema.fields).flatMap(([key, child]) => collectColors(child, `${prefix}.${key}`, group));
}

export const COLOR_ROLES: ColorRole[] = [
  ...collectColors(THEME_SCHEMA["components"]!.fields!["syntax"]!, "components.syntax", "Syntax"),
  ...["primary", "background", "text", "action"].flatMap((key) => collectColors(THEME_SCHEMA[key]!, key, "Core")),
  ...["pdfViewer", "imageViewer", "markdownViewer"].flatMap((key) =>
    collectColors(THEME_SCHEMA.components!.fields![key]!, `components.${key}`, key === "markdownViewer" ? "Markdown" : "Viewers")
  ),
  ...["link", "search", "alert"].flatMap((key) =>
    collectColors(
      THEME_SCHEMA.components!.fields![key]!,
      `components.${key}`,
      key === "link" ? "Core" : key === "search" ? "Search" : "Alerts"
    )
  ),
];

export function colorAt(theme: ThemeConfig, path: string): string | undefined {
  let value: unknown = theme;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

export function normalizeHexColor(color: string): string {
  const normalized = color.toUpperCase();
  return HEX_COLOR_PATTERN.test(normalized) && normalized.length === 9 && normalized.endsWith("FF") ? normalized.slice(0, -2) : normalized;
}

export function withColor(theme: ThemeConfig, path: string, color: string): ThemeConfig {
  const copy = structuredClone(theme);
  const keys = path.split(".");
  let target: Record<string, unknown> = copy as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = target[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[keys[keys.length - 1]!] = normalizeHexColor(color);
  return copy;
}

export function validateThemeDefinition(theme: ThemeConfig): string | null {
  try {
    theme = resolveSyntaxTheme(theme);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid syntax colors.";
  }
  if (!theme.name.trim()) return "Enter a theme name.";
  if (theme.mode !== "light" && theme.mode !== "dark") return "Choose light or dark mode.";
  for (const role of COLOR_ROLES) {
    if (!HEX_COLOR_PATTERN.test(colorAt(theme, role.path) ?? "")) return `${role.label}: enter #RRGGBB or #RRGGBBAA.`;
  }
  return null;
}

export function editableDefinition(theme: ThemeConfig): Omit<ThemeConfig, "id"> {
  const copy = resolveSyntaxTheme(theme);
  const { id: _id, ...definition } = copy;
  void _id;
  delete definition.background?.paper;
  delete definition.action?.focus;
  delete definition.action?.selectedDarker;
  return definition;
}

export function parseThemeImport(source: string): ThemeConfig {
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Import a versioned theme definition.");
  const exportFile = parsed as Record<string, unknown>;
  if (
    exportFile.version !== THEME_DEFINITION_VERSION ||
    !exportFile.definition ||
    typeof exportFile.definition !== "object" ||
    Array.isArray(exportFile.definition)
  ) {
    throw new Error("Unsupported theme format or version.");
  }
  const definition = exportFile.definition as Record<string, unknown>;
  if (typeof definition.name !== "string" || (definition.description !== undefined && typeof definition.description !== "string")) {
    throw new Error("Theme name and description must be text.");
  }
  const allowedPaths = new Set(["id", "name", "description", "mode"]);
  for (const role of COLOR_ROLES) {
    const parts = role.path.split(".");
    for (let depth = 1; depth <= parts.length; depth++) allowedPaths.add(parts.slice(0, depth).join("."));
  }
  const checkPaths = (value: Record<string, unknown>, prefix = "") => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!allowedPaths.has(path)) throw new Error(`Unknown color role: ${path}`);
      if (child && typeof child === "object" && !Array.isArray(child)) checkPaths(child as Record<string, unknown>, path);
    }
  };
  checkPaths(definition);
  const theme = resolveSyntaxTheme({ ...(exportFile.definition as ThemeConfig), id: "draft" });
  for (const role of COLOR_ROLES) {
    const value = colorAt(theme, role.path);
    if (!HEX_COLOR_PATTERN.test(value ?? "")) {
      throw new Error(
        `${role.path} (${role.label}): ${value === undefined ? "missing or not text" : JSON.stringify(value.slice(0, 40))} is not a valid color. Use #RRGGBB or #RRGGBBAA.`
      );
    }
  }
  const error = validateThemeDefinition(theme);
  if (error) throw new Error(error);
  return theme;
}
