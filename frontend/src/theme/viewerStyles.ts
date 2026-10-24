/**
 * Viewer styling utilities
 *
 * Shared utilities and default colors for viewer components
 * (ImageViewer, PDFViewer, MarkdownViewer).
 */

import { alpha, type Theme } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import { resolveThemePalette, VIEWER_FALLBACKS } from "./palette";
import type { ThemeConfig } from "./types";

//
// Default viewer colors
//

/**
 * Default fallback colors for viewer components.
 * These are used when theme doesn't provide specific viewer colors.
 */
export const VIEWER_DEFAULTS = VIEWER_FALLBACKS;

//
// Viewer color types
//

/** Colors for a viewer component */
export interface ViewerColors {
  viewerBg: string;
  toolbarBg: string;
  toolbarText: string;
}

/** Extended colors for markdown viewer (includes text color) */
export interface MarkdownViewerColors extends ViewerColors {
  viewerText: string;
  linkColor: string;
  linkHoverColor: string;
}

export interface ViewerToolbarForegroundColors {
  border: string;
  borderHover: string;
  disabled: string;
  muted: string;
  subtleBackground: string;
}

export function getViewerToolbarForegroundColors(toolbarText: string): ViewerToolbarForegroundColors {
  return {
    border: alpha(toolbarText, 0.3),
    borderHover: alpha(toolbarText, 0.5),
    disabled: alpha(toolbarText, 0.4),
    muted: alpha(toolbarText, 0.7),
    subtleBackground: alpha(toolbarText, 0.08),
  };
}

//
// getViewerColors
//

/**
 * Get viewer colors from theme with fallbacks.
 * Centralizes the color extraction logic that was duplicated across viewers.
 *
 * @param theme - The current Sambee theme configuration
 * @param viewerType - Which viewer to get colors for
 * @returns ViewerColors object with background and toolbar colors
 *
 * @example
 * ```tsx
 * const { currentTheme } = useSambeeTheme();
 * const colors = getViewerColors(currentTheme, 'image');
 * ```
 */
export function getViewerColors(theme: ThemeConfig, viewerType: "image"): ViewerColors;
export function getViewerColors(theme: ThemeConfig, viewerType: "pdf"): ViewerColors;
export function getViewerColors(theme: ThemeConfig, viewerType: "markdown"): MarkdownViewerColors;
export function getViewerColors(theme: ThemeConfig, viewerType: "image" | "pdf" | "markdown"): ViewerColors | MarkdownViewerColors {
  return resolveThemePalette(theme).viewers[viewerType];
}

//
// Markdown content styles
//

/**
 * Markdown styling colors aligned with the website docs code surfaces.
 */
export const MARKDOWN_COLORS = {
  /** Code block and inline code background */
  CODE_BG: "#f0eee9",
  /** Border used by docs code surfaces */
  CODE_BORDER: "#d4c4ae",
  /** Table and blockquote border */
  BORDER: "#dfe2e5",
  /** Table header border */
  BORDER_STRONG: "#c6cbd1",
  /** Table row background */
  ROW_BG: "#fff",
  /** Table alternate row background */
  ROW_BG_ALT: "#f6f8fa",
  /** Blockquote text color */
  MUTED_TEXT: "#6a737d",
  /** Heading border */
  HEADING_BORDER: "#eaecef",
} as const;

const MARKDOWN_CODE_FONT_SIZE = "0.875em";
const MARKDOWN_INLINE_CODE_PADDING = "0.125rem 0.375rem";
const MARKDOWN_CODE_BLOCK_PADDING = "1.25rem";
const MARKDOWN_CODE_BLOCK_LINE_HEIGHT = 1.65;
const MARKDOWN_CODE_BLOCK_LIGHT_TEXT = "#1f262b";
const MARKDOWN_CODE_BLOCK_DARK_TEXT = "#ebe8e2";
const MARKDOWN_CODE_BLOCK_DARK_BG = "#1f1914";
const MARKDOWN_CODE_INLINE_DARK_BG = "#2b2925";
const MARKDOWN_CODE_BLOCK_DARK_BORDER = "#504535";
const MARKDOWN_CODE_INLINE_DARK_BORDER = "#3b3935";
const MARKDOWN_CODE_BLOCK_DARK_ACTIVE_LINE_BG = "#3d3d3d";
export const MARKDOWN_CODE_BLOCK_ACTIVE_LINE_NUMBER_BG = "rgba(212, 196, 174, 0.35)";
export const MARKDOWN_CONTENT_PADDING = { xs: 2, sm: 4 } as const;
export const CODEMIRROR_EDITOR_CONTENT_PADDING = { xs: 2, sm: 4 } as const;
export const CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE = "--sambee-codemirror-editor-horizontal-inset";
export const VIEWER_SCROLL_END_PADDING = {
  xs: "clamp(64px, 18dvh, 192px)",
  sm: "clamp(64px, 18dvh, 192px)",
} as const;
export const MARKDOWN_VIEWER_PRINT_STYLES = {
  "@media print": {
    "body:has([data-markdown-print-viewer])": { height: "auto !important", overflow: "visible !important" },
    "body:has([data-markdown-print-viewer]) > :not([data-markdown-print-viewer])": { display: "none !important" },
    "[data-markdown-print-viewer]": { position: "static !important", overflow: "visible" },
    "[data-markdown-print-viewer] .MuiBackdrop-root, [data-markdown-print-frame] > :not([data-testid='markdown-viewer-content'])": {
      display: "none !important",
    },
    "[data-markdown-print-viewer] .MuiDialog-paper, [data-markdown-print-viewer] [data-markdown-search-root]": {
      color: "#000 !important",
      backgroundColor: "#fff !important",
    },
    "[data-markdown-print-viewer] [data-markdown-search-root]": {
      "--sambee-syntax-foreground": "#000 !important",
      "--sambee-syntax-keyword": "#000 !important",
      "--sambee-syntax-string": "#000 !important",
      "--sambee-syntax-number": "#000 !important",
      "--sambee-syntax-comment": "#000 !important",
      "--sambee-syntax-type": "#000 !important",
      "--sambee-syntax-function": "#000 !important",
      "--sambee-syntax-operator": "#000 !important",
      "--sambee-syntax-punctuation": "#000 !important",
      "--sambee-search-foreground": "#000 !important",
      "--sambee-search-other": "transparent !important",
      "--sambee-search-current": "transparent !important",
    },
    "[data-markdown-print-viewer] [data-markdown-search-root] *": {
      color: "#000 !important",
      backgroundColor: "transparent !important",
      boxShadow: "none !important",
      textShadow: "none !important",
    },
    "[data-markdown-print-viewer] .MuiDialog-container, [data-markdown-print-viewer] .MuiDialog-paper, [data-markdown-print-frame], [data-markdown-print-viewer] [data-testid='markdown-viewer-content']":
      {
        position: "static",
        display: "block",
        width: "auto",
        maxWidth: "none",
        height: "auto",
        maxHeight: "none",
        minHeight: 0,
        overflow: "visible",
        flex: "none",
        margin: 0,
        paddingBottom: 0,
      },
    "[data-markdown-print-viewer] [data-markdown-search-root] pre, [data-markdown-print-viewer] [data-markdown-search-root] pre code": {
      minWidth: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      overflow: "visible",
    },
    "[data-markdown-print-viewer] [data-markdown-search-root] table": {
      display: "table",
      width: "100%",
      tableLayout: "fixed",
      overflowWrap: "anywhere",
    },
    "[data-markdown-print-viewer] thead": { display: "table-header-group" },
    "[data-markdown-print-viewer] tr, [data-markdown-print-viewer] img": { breakInside: "avoid" },
    "[data-markdown-print-viewer] h1, [data-markdown-print-viewer] h2, [data-markdown-print-viewer] h3": { breakAfter: "avoid" },
    "[data-markdown-print-viewer] p": { orphans: 3, widows: 3 },
    "[data-markdown-print-viewer] img": { maxWidth: "100%", maxHeight: "240mm", objectFit: "contain" },
  },
} as const;
export const MARKDOWN_TABLE_CELL_PADDING_INLINE = "0.675rem";
export const MARKDOWN_TABLE_CELL_PADDING_BLOCK = "0.8em";
export const MARKDOWN_TABLE_FONT_SIZE = "0.9375em";
export const MARKDOWN_TABLE_HEADER_FONT_SIZE = "0.75rem";
export const MARKDOWN_TABLE_HEADER_LETTER_SPACING = "0.16em";
const MARKDOWN_TABLE_LIGHT_BG = "#fbf9f4";
const MARKDOWN_TABLE_LIGHT_ROW_ALT_BG = "#f5f3ee";
const MARKDOWN_TABLE_LIGHT_HEADER_BG = "#eae8e3";
const MARKDOWN_TABLE_LIGHT_BORDER = "#d4c4ae";
const MARKDOWN_TABLE_DARK_BG = "#1b1c19";
const MARKDOWN_TABLE_DARK_ROW_ALT_BG = "#24231f";
const MARKDOWN_TABLE_DARK_HEADER_BG = "#302e2a";
const MARKDOWN_TABLE_DARK_BORDER = "#3b3935";
const MARKDOWN_TABLE_DARK_HEADER_TEXT = "#ebe8e2";

export function getMarkdownCodeSurfaceColors(theme: Theme) {
  const document = theme.palette.markdownDocument;
  if (document) {
    return {
      blockBackground: document.blockBackground,
      inlineBackground: document.inlineBackground,
      blockBorder: document.blockBorder,
      inlineBorder: document.inlineBorder,
      textColor: document.codeText,
      activeLineGutterBackground: document.activeLineGutterBackground,
    };
  }
  if (theme.palette.mode === "dark") {
    return {
      blockBackground: MARKDOWN_CODE_BLOCK_DARK_BG,
      inlineBackground: MARKDOWN_CODE_INLINE_DARK_BG,
      blockBorder: MARKDOWN_CODE_BLOCK_DARK_BORDER,
      inlineBorder: MARKDOWN_CODE_INLINE_DARK_BORDER,
      textColor: MARKDOWN_CODE_BLOCK_DARK_TEXT,
      activeLineGutterBackground: MARKDOWN_CODE_BLOCK_DARK_ACTIVE_LINE_BG,
    };
  }

  return {
    blockBackground: MARKDOWN_COLORS.CODE_BG,
    inlineBackground: MARKDOWN_COLORS.CODE_BG,
    blockBorder: MARKDOWN_COLORS.CODE_BORDER,
    inlineBorder: MARKDOWN_COLORS.CODE_BORDER,
    textColor: MARKDOWN_CODE_BLOCK_LIGHT_TEXT,
    activeLineGutterBackground: MARKDOWN_CODE_BLOCK_ACTIVE_LINE_NUMBER_BG,
  };
}

export function getMarkdownTableSurfaceColors(theme: Theme) {
  const document = theme.palette.markdownDocument;
  if (document) {
    return {
      tableBackground: document.tableBackground,
      alternateRowBackground: document.alternateRowBackground,
      headerBackground: document.headerBackground,
      headerText: document.headerText,
      border: document.tableBorder,
    };
  }
  if (theme.palette.mode === "dark") {
    return {
      tableBackground: MARKDOWN_TABLE_DARK_BG,
      alternateRowBackground: MARKDOWN_TABLE_DARK_ROW_ALT_BG,
      headerBackground: MARKDOWN_TABLE_DARK_HEADER_BG,
      headerText: MARKDOWN_TABLE_DARK_HEADER_TEXT,
      border: MARKDOWN_TABLE_DARK_BORDER,
    };
  }

  return {
    tableBackground: MARKDOWN_TABLE_LIGHT_BG,
    alternateRowBackground: MARKDOWN_TABLE_LIGHT_ROW_ALT_BG,
    headerBackground: MARKDOWN_TABLE_LIGHT_HEADER_BG,
    headerText: undefined,
    border: MARKDOWN_TABLE_LIGHT_BORDER,
  };
}

function getMarkdownDocumentStyles(viewerText: string, linkColor: string, linkHoverColor: string): SystemStyleObject<Theme> {
  return {
    color: viewerText,
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: 1.5,

    // Ensure all children respect container width.
    "& *": {
      boxSizing: "border-box",
      minWidth: 0,
      maxWidth: "100%",
    },

    // Keep block spacing consistent between viewer and editor.
    "& p, & ul, & ol, & blockquote, & pre, & table": {
      marginTop: 0,
      marginBottom: "16px",
    },
    "& ul, & ol": {
      paddingLeft: "2em",
    },
    "& ul ul, & ul ol, & ol ul, & ol ol": {
      marginTop: 0,
      marginBottom: 0,
    },
    "& li": {
      marginTop: "0.25em",
      marginBottom: "0.25em",
    },

    // Code blocks: fixed width with internal scrolling.
    "& pre": {
      backgroundColor: (theme) => getMarkdownCodeSurfaceColors(theme).blockBackground,
      color: (theme) => getMarkdownCodeSurfaceColors(theme).textColor,
      border: (theme) => `1px solid ${getMarkdownCodeSurfaceColors(theme).blockBorder}`,
      borderRadius: 0,
      fontSize: MARKDOWN_CODE_FONT_SIZE,
      padding: MARKDOWN_CODE_BLOCK_PADDING,
      margin: "1.25rem 0",
      overflowX: "auto",
      lineHeight: MARKDOWN_CODE_BLOCK_LINE_HEIGHT,
      width: "100%",
    },

    // Inline code mirrors docs styling.
    "& code:not(pre code)": {
      backgroundColor: (theme) => getMarkdownCodeSurfaceColors(theme).inlineBackground,
      color: (theme) => getMarkdownCodeSurfaceColors(theme).textColor,
      fontSize: MARKDOWN_CODE_FONT_SIZE,
      fontWeight: "normal",
      padding: MARKDOWN_INLINE_CODE_PADDING,
      border: (theme) => `1px solid ${getMarkdownCodeSurfaceColors(theme).inlineBorder}`,
      borderRadius: 0,
      overflowWrap: "break-word",
    },

    // Code inside pre inherits the containing code surface.
    // Match highlight.js specificity so its default block padding cannot reintroduce
    // a second inset inside viewer-mode code blocks.
    "& pre code, & pre code.hljs": {
      display: "block",
      minWidth: "max-content",
      color: "inherit",
      border: 0,
      padding: 0,
      backgroundColor: "transparent",
      overflowWrap: "normal",
    },

    // Images: scale to fit.
    "& img": {
      maxWidth: "100%",
      height: "auto",
      display: "block",
    },

    // Tables mirror the website docs treatment.
    "& table": {
      display: "block",
      width: "max-content",
      maxWidth: "100%",
      overflowX: "auto",
      borderCollapse: "collapse",
      margin: "1.25rem 0",
      fontSize: MARKDOWN_TABLE_FONT_SIZE,
      border: 0,
      boxShadow: (theme) => `inset 0 0 0 1px ${getMarkdownTableSurfaceColors(theme).border}`,
      backgroundColor: (theme) => getMarkdownTableSurfaceColors(theme).tableBackground,
    },
    "& table td, & table th": {
      border: (theme) => `1px solid ${getMarkdownTableSurfaceColors(theme).border}`,
      paddingBlock: MARKDOWN_TABLE_CELL_PADDING_BLOCK,
      paddingInline: MARKDOWN_TABLE_CELL_PADDING_INLINE,
      textAlign: "left",
      verticalAlign: "top",
    },
    "& table thead th": {
      backgroundColor: (theme) => getMarkdownTableSurfaceColors(theme).headerBackground,
      color: (theme) => getMarkdownTableSurfaceColors(theme).headerText,
      fontSize: MARKDOWN_TABLE_HEADER_FONT_SIZE,
      fontWeight: 700,
      letterSpacing: MARKDOWN_TABLE_HEADER_LETTER_SPACING,
      textTransform: "uppercase",
    },
    "& table tbody tr:nth-of-type(even)": {
      backgroundColor: (theme) => getMarkdownTableSurfaceColors(theme).alternateRowBackground,
    },

    // Blockquotes.
    "& blockquote": {
      borderLeft: (theme) => `4px solid ${theme.palette.markdownDocument?.blockquoteBorder ?? MARKDOWN_COLORS.BORDER}`,
      marginTop: 0,
      marginBottom: "16px",
      paddingLeft: "16px",
      color: (theme) => theme.palette.markdownDocument?.blockquoteText ?? MARKDOWN_COLORS.MUTED_TEXT,
    },

    // Headings: break long words.
    "& h1, & h2, & h3, & h4, & h5, & h6": {
      marginTop: "24px",
      marginBottom: "16px",
      fontWeight: 600,
      lineHeight: 1.25,
      overflowWrap: "break-word",
    },
    "& h1": {
      paddingBottom: "0.3em",
      fontSize: "2em",
      borderBottom: (theme) => `1px solid ${theme.palette.markdownDocument?.headingBorder ?? MARKDOWN_COLORS.HEADING_BORDER}`,
    },
    "& h2": {
      paddingBottom: "0.3em",
      fontSize: "1.5em",
      borderBottom: (theme) => `1px solid ${theme.palette.markdownDocument?.headingBorder ?? MARKDOWN_COLORS.HEADING_BORDER}`,
    },
    "& h3": {
      fontSize: "1.25em",
    },

    // Links.
    "& a": {
      color: linkColor,
      textDecoration: "none",
      overflowWrap: "break-word",
      "&:hover": {
        color: linkHoverColor,
      },
    },
  };
}

//
// getMarkdownContentStyles
//

/**
 * Get the sx prop for styling markdown content.
 * Encapsulates all GitHub-flavored markdown styling.
 *
 * @param viewerText - Text color for the markdown content
 * @param linkColor - Default color for markdown links
 * @param linkHoverColor - Hover color for markdown links
 * @returns SxProps for the markdown container
 */
export function getMarkdownContentStyles(viewerText: string, linkColor: string, linkHoverColor: string): SystemStyleObject<Theme> {
  return {
    // Layout
    minHeight: 0,
    minWidth: 0,
    width: "100%",
    maxWidth: "100%",
    flexShrink: 0,
    p: MARKDOWN_CONTENT_PADDING,
    pb: VIEWER_SCROLL_END_PADDING,
    ...getMarkdownDocumentStyles(viewerText, linkColor, linkHoverColor),
  };
}
