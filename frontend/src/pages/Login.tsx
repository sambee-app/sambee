import { Alert, Box, Button, Container, Divider, Paper, TextField, Typography } from "@mui/material";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { login } from "../services/api";
import { type AuthConfig, getAuthConfig } from "../services/authConfig";
import { authSession } from "../services/authSession";
import { logger } from "../services/logger";
import {
  completeAuthentication,
  loginReturnPath,
  OIDC_ATTEMPT_MARKER,
  OIDC_LOGIN_CHANNEL,
  OIDC_LOGOUT_MARKER,
  OIDC_RETURN_PATH_MARKER,
  startOidcAuthorization,
} from "../services/oidcAuth";
import { PASSWORD_CHANGED_MARKER } from "../services/passwordChange";

const OIDC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  oidc_authorization_state_invalid: "This sign-in request expired or is invalid. Start again.",
  oidc_provider_unavailable: "The identity provider is temporarily unavailable. Try again later.",
  oidc_required_claim_missing: "The identity provider did not supply required account information. Contact your Sambee administrator.",
  oidc_user_not_admitted: "You do not have permission to sign in to this Sambee instance.",
  oidc_username_collision: "This identity cannot be connected automatically. Contact your Sambee administrator.",
  oidc_mapping_conflict: "The account mapping changed or conflicts with another account. Contact your Sambee administrator.",
  oidc_configuration_changed: "Authentication settings changed during sign-in. Start again.",
  oidc_last_administrator_role_conflict:
    "Your administrator access changed. Restore the IdP group or use your local password after the operator enables Password only.",
  oidc_last_administrator_role_conflict_no_password:
    "Your administrator access changed and no local password exists. Restore the administrator group at the identity provider.",
  oidc_rate_limited: "Too many sign-in attempts. Wait and try again.",
};

const oidcErrorFromFragment = (): string => {
  const code = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("error");
  return code ? (OIDC_ERROR_MESSAGES[code] ?? "") : "";
};

const Login: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(oidcErrorFromFragment);
  const [isLoading, setIsLoading] = useState(true);
  const [configurationUnavailable, setConfigurationUnavailable] = useState(false);
  const [configurationAttempt, setConfigurationAttempt] = useState(0);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [oidcOnlyState, setOidcOnlyState] = useState<"redirecting" | "failed" | "signed-out" | null>(null);
  const [returnPath] = useState(() => loginReturnPath(window.location.search));
  const signInMode = useRef<AuthConfig["sign_in_mode"] | null>(null);
  const recoveryPromise = useRef<Promise<void> | null>(null);
  const recoveredInAnotherTab = useRef(false);
  const [passwordChanged] = useState(() => {
    const changed = sessionStorage.getItem(PASSWORD_CHANGED_MARKER) === "1";
    sessionStorage.removeItem(PASSWORD_CHANGED_MARKER);
    return changed;
  });

  useEffect(() => {
    if (oidcErrorFromFragment()) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let pendingIsLoginHint = false;
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(OIDC_LOGIN_CHANNEL);
      } catch (error) {
        logger.warn("Could not listen for OIDC sign-in in other tabs; recovery on focus is still available", { error }, "auth");
      }
    }

    const recoverSession = (fromLoginHint: boolean) => {
      if (
        recoveredInAnotherTab.current ||
        signInMode.current === "none" ||
        signInMode.current === "password_only" ||
        sessionStorage.getItem(OIDC_LOGOUT_MARKER)
      )
        return;
      if (recoveryPromise.current && (!fromLoginHint || pendingIsLoginHint)) return;
      pendingIsLoginHint = fromLoginHint;
      const pending = authSession
        .requestRefresh({ newLogin: true })
        .then(() => {
          if (!active || recoveryPromise.current !== pending) return;
          recoveredInAnotherTab.current = true;
          authSession.completeLoginBootstrap();
          sessionStorage.removeItem(OIDC_ATTEMPT_MARKER);
          sessionStorage.removeItem(OIDC_RETURN_PATH_MARKER);
          navigate(returnPath, { replace: true });
        })
        .catch(() => undefined)
        .finally(() => {
          if (recoveryPromise.current === pending) recoveryPromise.current = null;
        });
      recoveryPromise.current = pending;
    };
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "completed") recoverSession(true);
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") recoverSession(false);
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      window.removeEventListener("focus", onFocus);
    };
  }, [navigate, returnPath]);

  // Check if authentication is required
  useEffect(() => {
    const checkAuthConfig = async () => {
      const attempt = configurationAttempt;
      setIsLoading(true);
      setConfigurationUnavailable(false);
      try {
        const config = await getAuthConfig();
        signInMode.current = config.sign_in_mode;
        while (recoveryPromise.current) await recoveryPromise.current;
        if (recoveredInAnotherTab.current) return;
        if (config.sign_in_mode === "none") {
          logger.info("Auth method is 'none' - redirecting to requested page", { returnPath }, "auth");
          await logger.initializeBackendTracing();
          navigate(returnPath, { replace: true });
          return;
        }
        setAuthConfig(config);
        if (config.sign_in_mode === "oidc_only" && config.oidc) {
          if (sessionStorage.getItem(OIDC_LOGOUT_MARKER)) {
            setOidcOnlyState("signed-out");
          } else if (sessionStorage.getItem(OIDC_ATTEMPT_MARKER)) {
            setOidcOnlyState("failed");
          } else {
            sessionStorage.setItem(OIDC_ATTEMPT_MARKER, "1");
            setOidcOnlyState("redirecting");
            startOidcAuthorization(config.oidc.authorization_path, returnPath);
            return;
          }
        }
      } catch (error) {
        logger.error("Failed to check auth config", { error, attempt }, "auth");
        setError((current) => current || "Authentication is temporarily unavailable.");
        setConfigurationUnavailable(true);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuthConfig();
  }, [configurationAttempt, navigate, returnPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const response = await login(username, password);
      const authenticatedReturnPath = await completeAuthentication(response, returnPath, false);
      navigate(authenticatedReturnPath);
    } catch (_err) {
      setError(t("auth.login.invalidCredentials"));
    }
  };

  const startProviderLogin = () => {
    if (!authConfig?.oidc) return;
    sessionStorage.setItem(OIDC_ATTEMPT_MARKER, "1");
    sessionStorage.removeItem(OIDC_LOGOUT_MARKER);
    startOidcAuthorization(authConfig.oidc.authorization_path, returnPath);
  };

  if (isLoading || oidcOnlyState === "redirecting") {
    return null;
  }

  if (configurationUnavailable) {
    return (
      <Container maxWidth="sm" sx={{ py: 10 }}>
        <Alert severity="error">{error}</Alert>
        <Typography component="h1" variant="h5" sx={{ mt: 3 }}>
          Sign in unavailable
        </Typography>
        <Button
          variant="contained"
          sx={{ mt: 3 }}
          onClick={() => {
            setError("");
            setConfigurationAttempt((attempt) => attempt + 1);
          }}
        >
          Try again
        </Button>
      </Container>
    );
  }

  if (!authConfig) return null;

  if (authConfig?.sign_in_mode === "oidc_only") {
    const signedOut = oidcOnlyState === "signed-out";
    return (
      <Container maxWidth="sm" sx={{ py: 10 }}>
        {!signedOut && <Alert severity="error">{error || "Sign in is temporarily unavailable."}</Alert>}
        <Typography component="h1" variant="h5" sx={{ mt: 3 }}>
          {signedOut ? "Signed out" : "Sign in unavailable"}
        </Typography>
        <Button variant="contained" sx={{ mt: 3 }} onClick={startProviderLogin}>
          {signedOut ? "Sign in again" : "Try again"}
        </Button>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          marginTop: 8,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <Paper elevation={3} sx={{ p: 4, width: "100%" }}>
          <Typography component="h1" variant="h5" align="center" gutterBottom>
            {t("auth.login.title")}
          </Typography>
          {passwordChanged && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Password changed. Sign in with your new password.
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {authConfig?.sign_in_mode === "oidc_or_password" && authConfig.oidc && (
            <>
              <Button fullWidth variant="contained" sx={{ mt: 2, mb: 3 }} onClick={startProviderLogin}>
                {t("auth.login.submitWithOidc", { providerName: authConfig.oidc.display_name })}
              </Button>
              <Divider>or</Divider>
            </>
          )}
          <form onSubmit={handleSubmit}>
            <TextField
              margin="normal"
              required
              fullWidth
              label={t("auth.login.usernameLabel")}
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              margin="normal"
              required
              fullWidth
              label={t("auth.login.passwordLabel")}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" fullWidth variant="outlined" sx={{ mt: 3, mb: 2 }}>
              {authConfig.sign_in_mode === "oidc_or_password" ? t("auth.login.submitWithPassword") : t("auth.login.submit")}
            </Button>
          </form>
        </Paper>
      </Box>
    </Container>
  );
};

export default Login;
