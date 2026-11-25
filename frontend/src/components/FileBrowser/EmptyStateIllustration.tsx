//
// EmptyStateIllustration
//

import { Box, type SxProps, type Theme } from "@mui/material";
import { useTranslation } from "react-i18next";

interface EmptyStateIllustrationProps {
  /** Width of the illustration (default: 200) */
  width?: number;
  /** Custom sx props */
  sx?: SxProps<Theme>;
}

/**
 * A friendly illustration shown when no connections are configured.
 * Displays a stylized server/network icon with a subtle animation.
 */
export function EmptyStateIllustration({ width = 200, sx }: EmptyStateIllustrationProps) {
  const { t } = useTranslation();
  const height = width * 0.8;

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        ...sx,
      }}
    >
      <svg width={width} height={height} viewBox="0 0 200 160" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <title>{t("common.uiText.serverIllustration")}</title>
        {/* Background circle */}
        <circle cx="100" cy="80" r="70" fill="currentColor" opacity="0.05" />

        {/* Server/Storage icon */}
        <g transform="translate(55, 35)">
          {/* Server box 1 (top) */}
          <rect
            x="0"
            y="0"
            width="90"
            height="25"
            rx="4"
            fill="currentColor"
            opacity="0.15"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity="0.3"
          />
          {/* LED indicators */}
          <circle cx="15" cy="12.5" r="4" fill="currentColor" opacity="0.4" />
          <circle cx="28" cy="12.5" r="4" fill="currentColor" opacity="0.25" />
          {/* Ventilation lines */}
          <line x1="50" y1="8" x2="80" y2="8" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="12.5" x2="80" y2="12.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="17" x2="80" y2="17" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />

          {/* Server box 2 (middle) */}
          <rect
            x="0"
            y="32"
            width="90"
            height="25"
            rx="4"
            fill="currentColor"
            opacity="0.15"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity="0.3"
          />
          <circle cx="15" cy="44.5" r="4" fill="currentColor" opacity="0.25" />
          <circle cx="28" cy="44.5" r="4" fill="currentColor" opacity="0.25" />
          <line x1="50" y1="40" x2="80" y2="40" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="44.5" x2="80" y2="44.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="49" x2="80" y2="49" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />

          {/* Server box 3 (bottom) */}
          <rect
            x="0"
            y="64"
            width="90"
            height="25"
            rx="4"
            fill="currentColor"
            opacity="0.15"
            stroke="currentColor"
            strokeWidth="2"
            strokeOpacity="0.3"
          />
          <circle cx="15" cy="76.5" r="4" fill="currentColor" opacity="0.25" />
          <circle cx="28" cy="76.5" r="4" fill="currentColor" opacity="0.25" />
          <line x1="50" y1="72" x2="80" y2="72" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="76.5" x2="80" y2="76.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
          <line x1="50" y1="81" x2="80" y2="81" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
        </g>

        {/* Plus icon overlay (indicating "add connection") */}
        <g transform="translate(130, 95)">
          <circle cx="20" cy="20" r="18" fill="currentColor" opacity="0.1" stroke="currentColor" strokeWidth="2" strokeOpacity="0.4" />
          <line x1="20" y1="10" x2="20" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.5" />
          <line x1="10" y1="20" x2="30" y2="20" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeOpacity="0.5" />
        </g>
      </svg>
    </Box>
  );
}
