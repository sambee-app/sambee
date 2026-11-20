import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { IconButton } from "@mui/material";
import { useTranslation } from "react-i18next";

interface DirectionalBackButtonProps {
  "aria-label": string;
  disabled?: boolean;
  onClick: () => void;
}

export function DirectionalBackButton({ "aria-label": ariaLabel, disabled = false, onClick }: DirectionalBackButtonProps) {
  const { i18n } = useTranslation();
  const isRightToLeft = i18n.dir() === "rtl" || (typeof document !== "undefined" && document.documentElement.dir === "rtl");
  const Icon = isRightToLeft ? ArrowForwardIcon : ArrowBackIcon;

  return (
    <IconButton edge={isRightToLeft ? "end" : "start"} color="inherit" onClick={onClick} aria-label={ariaLabel} disabled={disabled}>
      <Icon />
    </IconButton>
  );
}
