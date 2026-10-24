import { getDefaultTheme } from "./themes";
import { HEX_COLOR_PATTERN, SYNTAX_COLOR_ROLES, type ThemeConfig } from "./types";

export function resolveSyntaxTheme(theme: ThemeConfig): ThemeConfig {
  const syntax = theme.components?.syntax;
  if (syntax !== undefined || Object.keys(theme.components ?? {}).includes("syntax")) {
    if (
      !syntax ||
      typeof syntax !== "object" ||
      Array.isArray(syntax) ||
      Object.keys(syntax).length !== SYNTAX_COLOR_ROLES.length ||
      SYNTAX_COLOR_ROLES.some((role) => typeof syntax[role] !== "string" || !HEX_COLOR_PATTERN.test(syntax[role]))
    ) {
      throw new Error("Syntax colors must contain exactly all eight valid #RRGGBB or #RRGGBBAA roles.");
    }
    return structuredClone(theme);
  }
  return {
    ...structuredClone(theme),
    components: { ...structuredClone(theme.components), syntax: { ...getDefaultTheme(theme.mode).components!.syntax! } },
  };
}
