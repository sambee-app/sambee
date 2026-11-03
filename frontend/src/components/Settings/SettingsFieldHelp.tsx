import { FormHelperText, type SxProps, type Theme } from "@mui/material";
import type { ReactNode } from "react";

interface SettingsFieldHelpProps {
  children: ReactNode;
  sx?: SxProps<Theme>;
  id?: string;
  error?: boolean;
}

/** Use below settings controls when their explanation is not provided by TextField. */
export function SettingsFieldHelp({ children, sx, id, error }: SettingsFieldHelpProps) {
  return (
    <FormHelperText id={id} error={error} sx={sx}>
      {children}
    </FormHelperText>
  );
}
