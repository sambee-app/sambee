import type { Theme } from "@mui/material";
import type { CSSProperties } from "react";
import { TOKEN_CATEGORIES, tokenClasses } from "../utils/syntaxHighlighting";
import { getDefaultTheme } from "./themes";
import { SYNTAX_COLOR_ROLES } from "./types";

export const syntaxTokenStyles = Object.fromEntries(
  TOKEN_CATEGORIES.map((category) => {
    const role = category === "heading" || category === "structure" ? "keyword" : category;
    const color =
      category === "identifier" || category === "inlineCode"
        ? "var(--sambee-syntax-foreground, inherit)"
        : category === "emphasis" || category === "strong" || category === "strikethrough"
          ? "inherit"
          : `var(--sambee-syntax-${role})`;
    return [
      `.${tokenClasses([category])}`,
      {
        ...(category === "emphasis" || category === "strong" || category === "strikethrough" ? {} : { color }),
        ...(category === "emphasis" ? { fontStyle: "italic" } : {}),
        ...(category === "strong" ? { fontWeight: "bold" } : {}),
        ...(category === "strikethrough" ? { textDecoration: "line-through" } : {}),
      },
    ];
  })
);

export function getSyntaxVariables(theme: Theme, linkColor?: string): CSSProperties {
  const palette = theme.palette.syntax ?? getDefaultTheme(theme.palette.mode).components!.syntax!;
  return {
    ...Object.fromEntries(SYNTAX_COLOR_ROLES.map((role) => [`--sambee-syntax-${role}`, palette[role]])),
    "--sambee-syntax-foreground": theme.palette.markdownDocument?.codeText ?? "inherit",
    "--sambee-syntax-link": linkColor ?? theme.palette.link?.main ?? getDefaultTheme(theme.palette.mode).components!.link!.main,
  } as CSSProperties;
}
