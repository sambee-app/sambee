import { alpha, Box, Tooltip } from "@mui/material";
import type { ReactNode } from "react";
import { SettingsGroup } from "./SettingsGroup";

interface SettingsFormSectionProps {
  title: ReactNode;
}
interface DialogFieldFeedbackProps {
  message: string | null | undefined;
}

const dialogFeedbackMessageSx = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function SettingsFormSection({ title }: SettingsFormSectionProps) {
  return (
    <SettingsGroup
      title={title}
      headerSx={{
        borderTop: (theme) => `1px solid ${alpha(theme.palette.text.primary, 0.2)}`,
        pt: 2,
      }}
      titleSx={{ mb: 0 }}
    />
  );
}

export function DialogFieldFeedback({ message }: DialogFieldFeedbackProps) {
  if (!message) {
    return <span aria-hidden="true">&nbsp;</span>;
  }

  return (
    <Tooltip title={message} disableFocusListener disableTouchListener>
      <Box component="span" aria-label={message} sx={dialogFeedbackMessageSx}>
        {message}
      </Box>
    </Tooltip>
  );
}
