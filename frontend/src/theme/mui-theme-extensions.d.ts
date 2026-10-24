/**
 * Extend Material-UI theme types to include our custom component semantic tokens
 */

import "@mui/material/styles";
import type { SyntaxPalette, ThemeConfig } from "./types";

type MarkdownDocumentColors = NonNullable<NonNullable<ThemeConfig["components"]>["markdownViewer"]>["document"];

declare module "@mui/material/styles" {
  interface Palette {
    link?: { main: string; hover: string };
    syntax?: SyntaxPalette;
    chrome?: string;
    markdownDocument?: MarkdownDocumentColors;
    appBar?: {
      background: string;
      text: string;
      focus?: string;
    };
    statusBar?: {
      background: string;
      text: string;
      textSecondary: string;
    };
  }

  interface PaletteOptions {
    link?: { main: string; hover: string };
    syntax?: SyntaxPalette;
    chrome?: string;
    markdownDocument?: MarkdownDocumentColors;
    appBar?: {
      background: string;
      text: string;
      focus?: string;
    };
    statusBar?: {
      background: string;
      text: string;
      textSecondary: string;
    };
  }
}
