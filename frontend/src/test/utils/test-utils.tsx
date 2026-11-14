import { createTheme, ThemeProvider } from "@mui/material";
import CssBaseline from "@mui/material/CssBaseline";
import type { RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { BrowserRouter } from "react-router-dom";
import "../../i18n";
import { LocalePreferencesProvider } from "../../i18n/LocalePreferencesProvider";
import { renderWithStyles } from "./renderWithStyles";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#1976d2",
    },
    secondary: {
      main: "#dc004e",
    },
  },
});

interface AllProvidersProps {
  children: React.ReactNode;
}

function AllProviders({ children }: AllProvidersProps) {
  return (
    <LocalePreferencesProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>{children}</BrowserRouter>
      </ThemeProvider>
    </LocalePreferencesProvider>
  );
}

function customRender(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return renderWithStyles(ui, { wrapper: AllProviders, ...options });
}

export * from "@testing-library/react";
export { customRender as render };
