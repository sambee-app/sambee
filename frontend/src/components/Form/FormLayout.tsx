import { alpha, Box, FormLabel, type SxProps, type Theme, Typography } from "@mui/material";
import type { ReactNode } from "react";
import { FORM_SURFACE_CSS_VARIABLE, getModeAdjustedSurfaceColor, OVERLAY_SURFACE_CSS_VARIABLE } from "../../theme/palette";

interface FormContainerProps {
  children: ReactNode;
  sx?: SxProps<Theme>;
  testId?: string;
}

export type FormGroupEdge = "none" | "start" | "end" | "both";

interface FormGroupProps extends FormContainerProps {
  edge?: FormGroupEdge;
}

interface FormFieldLabelProps {
  label: string;
  description: string;
  descriptionId: string;
  htmlFor?: string;
  required?: boolean;
  id?: string;
  feedback?: FieldFeedback;
}

export type FieldFeedback = {
  message: ReactNode;
  severity: "error" | "warning";
} | null;

const ACCORDION_FOCUS_RING_WIDTH_PX = 2;

export const formAccordionSummarySx = {
  width: (theme: Theme) => `calc(100% + ${theme.spacing(2)})`,
  mx: -1,
  px: 1,
  "&.Mui-focusVisible": {
    bgcolor: "transparent",
    boxShadow: (theme: Theme) => `inset 0 0 0 ${ACCORDION_FOCUS_RING_WIDTH_PX}px ${theme.palette.primary.main}`,
  },
};

export const formFieldControlSx = {
  display: "flex",
  justifyContent: { md: "flex-end" },
  justifySelf: { md: "end" },
  width: "100%",
};
export const formSelectControlSx = { justifySelf: { md: "end" }, width: { md: "fit-content" } };
export const formSelectSx: SxProps<Theme> = {
  "& .MuiSelect-select, & .MuiSelect-icon": {
    color: "text.primary",
  },
};
export const formSelectMenuProps = {
  sx: {
    "& .MuiMenuItem-root": {
      color: "text.primary",
    },
  },
};
export const formOutlinedControlSx = {
  "& .MuiOutlinedInput-root": {
    bgcolor: (theme: Theme) => `var(${OVERLAY_SURFACE_CSS_VARIABLE}, ${theme.palette.background.default})`,
  },
  '& input[type="date"], & input[type="datetime-local"], & input[type="month"], & input[type="time"], & input[type="week"]': {
    colorScheme: (theme: Theme) => theme.palette.mode,
  },
  "& .MuiInputLabel-root.MuiInputLabel-shrink": {
    bgcolor: (theme: Theme) => `var(${OVERLAY_SURFACE_CSS_VARIABLE}, ${theme.palette.background.default})`,
    px: 0.5,
    ml: -0.5,
  },
  "& .MuiOutlinedInput-notchedOutline": {
    borderColor: (theme: Theme) => alpha(theme.palette.text.primary, 0.2),
  },
  "&:hover .MuiOutlinedInput-notchedOutline": {
    borderColor: (theme: Theme) => alpha(theme.palette.text.primary, 0.35),
  },
  "& .MuiOutlinedInput-root.Mui-error .MuiOutlinedInput-notchedOutline": {
    borderColor: "error.main",
    borderWidth: 2,
  },
};

export function FormSurface({ children, sx, testId }: FormContainerProps) {
  return (
    <Box
      data-testid={testId}
      sx={[
        (theme) => ({
          display: "flex",
          flexDirection: "column",
          gap: 0,
          mt: { md: 1 },
          p: 2,
          bgcolor: `var(${FORM_SURFACE_CSS_VARIABLE}, ${getModeAdjustedSurfaceColor(theme.palette.background.default, theme.palette.mode)})`,
          borderRadius: 1,
        }),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  );
}

export function FormGroup({ children, sx, testId, edge = "none" }: FormGroupProps) {
  const trimsStartEdge = edge === "start" || edge === "both";
  const trimsEndEdge = edge === "end" || edge === "both";

  return (
    <Box
      data-testid={testId}
      sx={[
        (theme) => ({
          display: "flex",
          flexDirection: "column",
          gap: 0,
          [theme.breakpoints.up("md")]: {
            "& > :not(:last-child)": {
              borderBottom: `1px solid ${alpha(theme.palette.text.primary, 0.2)}`,
            },
          },
          ...(trimsStartEdge ? { "& > :first-of-type": { pt: 0 } } : {}),
          ...(trimsEndEdge ? { "& > :last-of-type": { pb: 0 } } : {}),
        }),
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  );
}

export function FormRow({ children, sx }: Omit<FormContainerProps, "testId">) {
  return (
    <Box
      sx={[
        {
          display: { md: "grid" },
          gridTemplateColumns: { md: "minmax(0, 1fr) minmax(0, 1fr)" },
          columnGap: { md: 2 },
          py: { xs: 1, md: 2 },
          alignItems: "start",
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  );
}

export function FormFieldLabel({ label, description, descriptionId, htmlFor, required = false, id, feedback = null }: FormFieldLabelProps) {
  const message = feedback?.message ?? description;

  return (
    <Box>
      <FormLabel id={id} htmlFor={htmlFor} required={required} sx={{ textAlign: "left" }}>
        {label}
      </FormLabel>
      <Typography
        id={descriptionId}
        variant="caption"
        component="p"
        sx={{
          mt: 0,
          color: (theme) =>
            feedback?.severity === "error"
              ? theme.palette.error.main
              : feedback?.severity === "warning"
                ? theme.palette.warning.main
                : theme.palette.text.secondary,
        }}
      >
        {feedback?.severity === "warning" ? <>Warning: {message}</> : message}
      </Typography>
    </Box>
  );
}
