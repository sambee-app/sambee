import type { PaletteMode } from "@mui/material";

export const SYNTAX_COLOR_ROLES = ["keyword", "string", "number", "comment", "type", "function", "operator", "punctuation"] as const;
export const HEX_COLOR_PATTERN = /^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/;
export type SyntaxPalette = Record<(typeof SYNTAX_COLOR_ROLES)[number], string>;

//
// Theme types
//

/**
 * Theme configuration that can be persisted and switched
 */
export interface ThemeConfig {
  /** Unique identifier for the theme */
  id: string;
  /** Display name of the theme */
  name: string;
  /** Theme description */
  description?: string;
  /** Light or dark mode */
  mode: PaletteMode;
  /** Primary color palette */
  primary: {
    main: string;
    light?: string;
    dark?: string;
    contrastText?: string;
  };
  /** Background colors */
  background?: {
    default?: string;
    /** MUI compatibility value. Standard application surfaces use default instead. */
    paper?: string;
    chrome?: string;
  };
  /** Standard UI foreground colors. Use semantic exceptions for disabled, status, and content-rendering colors. */
  text?: {
    /** High-emphasis text for headings, values, active labels, and primary task information. */
    primary?: string;
    /** Supporting text and passive icons for descriptions, metadata, captions, and helper copy. */
    secondary?: string;
  };
  /** Action/interaction colors */
  action?: {
    selected?: string;
    /** Darker selected state for controls that need stronger contrast than the default selection fill. */
    selectedDarker?: string;
    /** Legacy stored value, ignored: focus is derived from text.primary. */
    focus?: string;
  };
  /** Component-specific semantic colors */
  components?: {
    syntax?: SyntaxPalette;
    /** Link colors */
    link?: {
      /** Default link color */
      main: string;
      /** Link hover color */
      hover?: string;
    };
    /** Search highlight colors shared across viewers and editors */
    search?: {
      /** Background color for non-current search matches */
      otherMatch: string;
      /** Background color for the current/selected search match */
      currentMatch: string;
    };
    /** PDF viewer colors */
    pdfViewer?: {
      /** Background color for PDF viewer */
      viewerBackground: string;
      /** Background color for top toolbar */
      toolbarBackground: string;
      /** Text color in top toolbar */
      toolbarText: string;
    };
    /** Image viewer colors */
    imageViewer?: {
      /** Background color for image viewer */
      viewerBackground: string;
      /** Background color for top toolbar */
      toolbarBackground: string;
      /** Text color in top toolbar */
      toolbarText: string;
    };
    /** Markdown viewer colors */
    markdownViewer?: {
      /** Background color for markdown viewer */
      viewerBackground: string;
      /** Background color for top toolbar */
      toolbarBackground: string;
      /** Text color in top toolbar */
      toolbarText: string;
      /** Text color for markdown content */
      viewerText: string;
      /** Selected-state background for the secondary markdown editor toolbar */
      secondaryToolbarSelected?: string;
      document?: {
        blockBackground: string;
        inlineBackground: string;
        blockBorder: string;
        inlineBorder: string;
        codeText: string;
        activeLineGutterBackground: string;
        tableBackground: string;
        alternateRowBackground: string;
        headerBackground: string;
        headerText: string;
        tableBorder: string;
        blockquoteBorder: string;
        blockquoteText: string;
        headingBorder: string;
      };
    };
    /** Alert message styles for info/success/warning/error states */
    alert?: {
      /** Info alert colors */
      info: {
        background: string;
        text: string;
        icon: string;
      };
      /** Success alert colors */
      success: {
        background: string;
        text: string;
        icon: string;
      };
      /** Warning alert colors */
      warning: {
        background: string;
        text: string;
        icon: string;
      };
      /** Error alert colors */
      error: {
        background: string;
        text: string;
        icon: string;
      };
    };
  };
}

//
// Theme schema for UI builder
//

/**
 * Field type in theme schema
 */
export type ThemeFieldType = "text" | "color" | "select";

/**
 * Schema definition for a theme field
 */
export interface ThemeFieldSchema {
  /** Field label for UI */
  label: string;
  /** Description shown to users */
  description: string;
  /** Input type */
  type: ThemeFieldType;
  /** Whether field is required */
  required: boolean;
  /** Options for select fields */
  options?: readonly string[];
  /** Nested schema for object fields */
  fields?: Record<string, ThemeFieldSchema>;
}

/**
 * Complete theme schema with metadata for all fields
 * Used by theme builder UI to generate forms and validation
 */
export const THEME_SCHEMA: Record<string, ThemeFieldSchema> = {
  id: {
    label: "Theme ID",
    description: "Unique identifier for the theme (lowercase, no spaces)",
    type: "text",
    required: true,
  },
  name: {
    label: "Theme Name",
    description: "Display name shown in the theme selector",
    type: "text",
    required: true,
  },
  description: {
    label: "Description",
    description: "Brief description of the theme's style and purpose",
    type: "text",
    required: false,
  },
  mode: {
    label: "Theme Mode",
    description: "Use light or dark backgrounds and text",
    type: "select",
    required: true,
    options: ["light", "dark"] as const,
  },
  primary: {
    label: "Primary Color",
    description: "Colors for buttons and selected items",
    type: "color",
    required: true,
    fields: {
      main: {
        label: "Main",
        description: "Main color for buttons and selected navigation",
        type: "color",
        required: true,
      },
      light: {
        label: "Light Variant",
        description: "Lighter shade used for emphasis in dark mode",
        type: "color",
        required: false,
      },
      dark: {
        label: "Dark Variant",
        description: "Darker shade used for pressed buttons in light mode",
        type: "color",
        required: false,
      },
      contrastText: {
        label: "Contrast Text",
        description: "Text on buttons with the main color",
        type: "color",
        required: false,
      },
    },
  },
  background: {
    label: "Background Colors",
    description: "Colors behind pages and app bars",
    type: "color",
    required: false,
    fields: {
      default: {
        label: "Default Background",
        description: "Main page background color",
        type: "color",
        required: false,
      },
      paper: {
        label: "Paper Background",
        description: "Background for Material UI components",
        type: "color",
        required: false,
      },
      chrome: { label: "Chrome Background", description: "Dark app bars and dialogs", type: "color", required: true },
    },
  },
  text: {
    label: "Text Colors",
    description: "Colors for main and secondary text",
    type: "color",
    required: false,
    fields: {
      primary: {
        label: "Primary Text",
        description: "Headings and important text",
        type: "color",
        required: false,
      },
      secondary: {
        label: "Secondary Text",
        description: "Descriptions, captions, and less important text",
        type: "color",
        required: false,
      },
    },
  },
  action: {
    label: "Action Colors",
    description: "Colors for selected items",
    type: "color",
    required: false,
    fields: {
      selected: {
        label: "Selected State",
        description: "Background color for selected items in the file list",
        type: "color",
        required: false,
      },
      selectedDarker: {
        label: "Selected State Darker",
        description: "Darker selection color for editor toolbars",
        type: "color",
        required: false,
      },
    },
  },
  components: {
    label: "Component Colors",
    description: "Colors for viewers, links, search, and alerts",
    type: "color",
    required: false,
    fields: {
      syntax: {
        label: "Syntax",
        description: "Shared code foreground colors",
        type: "color",
        required: false,
        fields: Object.fromEntries(
          SYNTAX_COLOR_ROLES.map((role) => [
            role,
            {
              label: `${role.charAt(0).toUpperCase()}${role.slice(1)}`,
              description: `Code ${role} foreground`,
              type: "color" as const,
              required: true,
            },
          ])
        ),
      },
      link: {
        label: "Links",
        description: "Colors for links and their hover state",
        type: "color",
        required: false,
        fields: {
          main: { label: "Link", description: "Default link color", type: "color", required: true },
          hover: { label: "Hover", description: "Link color on hover", type: "color", required: false },
        },
      },
      search: {
        label: "Search Highlights",
        description: "Colors for search matches",
        type: "color",
        required: false,
        fields: {
          otherMatch: {
            label: "Other Matches",
            description: "Matches other than the selected one",
            type: "color",
            required: false,
          },
          currentMatch: {
            label: "Current Match",
            description: "The selected search match",
            type: "color",
            required: false,
          },
        },
      },
      pdfViewer: {
        label: "PDF Viewer",
        description: "Colors for PDF viewer",
        type: "color",
        required: false,
        fields: {
          viewerBackground: {
            label: "Viewer Background",
            description: "Background color for PDF viewer",
            type: "color",
            required: false,
          },
          toolbarBackground: {
            label: "Top Bar Background",
            description: "Background color for top toolbar",
            type: "color",
            required: false,
          },
          toolbarText: {
            label: "Top Bar Text",
            description: "Text color in top toolbar",
            type: "color",
            required: false,
          },
        },
      },
      imageViewer: {
        label: "Image Viewer",
        description: "Colors for image viewer",
        type: "color",
        required: false,
        fields: {
          viewerBackground: {
            label: "Viewer Background",
            description: "Background color for image viewer",
            type: "color",
            required: false,
          },
          toolbarBackground: {
            label: "Top Bar Background",
            description: "Background color for top toolbar",
            type: "color",
            required: false,
          },
          toolbarText: {
            label: "Top Bar Text",
            description: "Text color in top toolbar",
            type: "color",
            required: false,
          },
        },
      },
      markdownViewer: {
        label: "Markdown Viewer",
        description: "Colors for markdown viewer",
        type: "color",
        required: false,
        fields: {
          viewerBackground: {
            label: "Viewer Background",
            description: "Background color for markdown viewer",
            type: "color",
            required: false,
          },
          toolbarBackground: {
            label: "Top Bar Background",
            description: "Background color for top toolbar",
            type: "color",
            required: false,
          },
          toolbarText: {
            label: "Top Bar Text",
            description: "Text color in top toolbar",
            type: "color",
            required: false,
          },
          viewerText: {
            label: "Viewer Text",
            description: "Text color for markdown content",
            type: "color",
            required: false,
          },
          secondaryToolbarSelected: {
            label: "Secondary Toolbar Selected",
            description: "Selected buttons in the markdown editor toolbar",
            type: "color",
            required: false,
          },
          document: {
            label: "Document",
            description: "Markdown code, tables, blockquotes, and headings",
            type: "color",
            required: true,
            fields: Object.fromEntries(
              [
                "blockBackground",
                "inlineBackground",
                "blockBorder",
                "inlineBorder",
                "codeText",
                "activeLineGutterBackground",
                "tableBackground",
                "alternateRowBackground",
                "headerBackground",
                "headerText",
                "tableBorder",
                "blockquoteBorder",
                "blockquoteText",
                "headingBorder",
              ].map((role) => [
                role,
                {
                  label: role.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()),
                  description: `Markdown ${role.replace(/([A-Z])/g, " $1").toLowerCase()}`,
                  type: "color",
                  required: true,
                },
              ])
            ),
          },
        },
      },
      alert: {
        label: "Alerts",
        description: "Info, success, warning, and error message colors",
        type: "color",
        required: false,
        fields: Object.fromEntries(
          (["info", "success", "warning", "error"] as const).map((kind) => [
            kind,
            {
              label: kind[0].toUpperCase() + kind.slice(1),
              description: `${kind} message colors`,
              type: "color",
              required: true,
              fields: {
                background: { label: "Background", description: "Alert surface", type: "color", required: true },
                text: { label: "Text", description: "Alert message", type: "color", required: true },
                icon: { label: "Icon", description: "Alert icon", type: "color", required: true },
              },
            },
          ])
        ),
      },
    },
  },
};
