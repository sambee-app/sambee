import { Alert, Button, Container, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { FormGroup, FormRow, FormSurface, formOutlinedControlSx } from "../components/Form/FormLayout";
import { SettingsPasswordVisibilityToggle } from "../components/Settings/SettingsPasswordVisibilityToggle";
import { signOutCurrentBrowser } from "../services/accountSession";
import api from "../services/api";
import { authSession } from "../services/authSession";
import { logger } from "../services/logger";
import { loginPath, sanitizeReturnPath } from "../services/oidcAuth";
import {
  isPasswordChangeRequired,
  PASSWORD_CHANGE_PATH,
  PASSWORD_CHANGED_MARKER,
  setPasswordChangeRequired,
  subscribePasswordChange,
} from "../services/passwordChange";
import { getApiErrorMessage } from "../utils/apiErrors";

export function PasswordChangeGate({ ready }: { ready: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  const required = useSyncExternalStore(subscribePasswordChange, isPasswordChangeRequired);
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const [checkedEpoch, setCheckedEpoch] = useState<number | null>(null);
  const [error, setError] = useState<{ detail: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => authSession.subscribeToIdentity(() => setIdentityEpoch((value) => value + 1)), []);
  useEffect(() => {
    if (!ready || required) return;
    let active = true;
    setError(null);
    if (!authSession.hasUsableAccessToken()) {
      setCheckedEpoch(identityEpoch);
      return;
    }
    void api.getCurrentAccount().then(
      (account) => {
        if (!active) return;
        setPasswordChangeRequired(account.password_change_required);
        setCheckedEpoch(identityEpoch);
      },
      (failure: unknown) => {
        logger.warn("Account access check failed; retry the account check", { error: failure, attempt }, "auth");
        if (active) setError({ detail: getApiErrorMessage(failure, "") });
      }
    );
    return () => {
      active = false;
    };
  }, [ready, required, identityEpoch, attempt]);

  if (required) {
    return <Navigate replace to={`${PASSWORD_CHANGE_PATH}?return_path=${encodeURIComponent(location.pathname + location.search)}`} />;
  }
  if (error) {
    return (
      <Container maxWidth="sm" sx={{ py: 4 }}>
        <Alert severity="error">{error.detail || t("auth.passwordChange.checkFailed")}</Alert>
        <Button onClick={() => setAttempt((value) => value + 1)}>{t("auth.passwordChange.retry")}</Button>
      </Container>
    );
  }
  if (!ready || checkedEpoch !== identityEpoch)
    return (
      <Container role="status" sx={{ py: 4 }}>
        {t("auth.passwordChange.checking")}
      </Container>
    );
  return <Outlet />;
}

export default function PasswordChange() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const requestedPath = sanitizeReturnPath(new URLSearchParams(location.search).get("return_path"));
  const returnPath = requestedPath.startsWith(PASSWORD_CHANGE_PATH) || requestedPath.startsWith("/login") ? "/browse" : requestedPath;
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ detail: string; kind: "checkForChangeFailed" | "changeFailed" } | null>(null);
  const mismatch = confirmation !== "" && confirmation !== newPassword;

  useEffect(() => {
    let active = true;
    setError(null);
    void api.getCurrentAccount().then(
      (account) => {
        if (!active) return;
        setPasswordChangeRequired(account.password_change_required);
        if (!account.password_change_required) navigate(returnPath, { replace: true });
        else setChecked(true);
      },
      (failure: unknown) => {
        logger.warn("Password-change account check failed; sign in again or retry", { error: failure, attempt }, "auth");
        if (active) setError({ detail: getApiErrorMessage(failure, ""), kind: "checkForChangeFailed" });
      }
    );
    return () => {
      active = false;
    };
  }, [navigate, returnPath, attempt]);

  const signOut = async () => {
    await signOutCurrentBrowser();
    navigate(loginPath(returnPath), { replace: true });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !checked || !currentPassword || !newPassword || newPassword !== confirmation) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      sessionStorage.setItem(PASSWORD_CHANGED_MARKER, "1");
      await signOut();
    } catch (failure) {
      setError({ detail: getApiErrorMessage(failure, ""), kind: "changeFailed" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Typography component="h1" variant="h5" sx={{ mb: 2 }}>
        {t("auth.passwordChange.title")}
      </Typography>
      <Typography sx={{ mb: 3 }}>{t("auth.passwordChange.required")}</Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error.detail || t(`auth.passwordChange.${error.kind}`)}
        </Alert>
      )}
      {!checked && !error && <Typography role="status">{t("auth.passwordChange.checking")}</Typography>}
      {checked && (
        <form onSubmit={(event) => void submit(event)}>
          <FormSurface>
            <FormGroup>
              {(
                [
                  { key: "current", value: currentPassword, setValue: setCurrentPassword, autocomplete: "current-password" },
                  { key: "new", value: newPassword, setValue: setNewPassword, autocomplete: "new-password" },
                  { key: "confirmation", value: confirmation, setValue: setConfirmation, autocomplete: "new-password" },
                ] as const
              ).map((field, index) => (
                <FormRow key={field.key} sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
                  <TextField
                    label={t(`auth.passwordChange.${field.key}`)}
                    value={field.value}
                    onChange={(event) => field.setValue(event.target.value)}
                    type={visible ? "text" : "password"}
                    autoComplete={field.autocomplete}
                    autoFocus={index === 0}
                    fullWidth
                    required
                    disabled={submitting}
                    sx={formOutlinedControlSx}
                    error={index === 2 && mismatch}
                    helperText={index === 2 && mismatch ? t("auth.passwordChange.mismatch") : undefined}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <SettingsPasswordVisibilityToggle
                            visible={visible}
                            onToggle={() => setVisible((value) => !value)}
                            showLabel={t("auth.passwordChange.show")}
                            hideLabel={t("auth.passwordChange.hide")}
                          />
                        ),
                      },
                    }}
                  />
                </FormRow>
              ))}
            </FormGroup>
          </FormSurface>
          <Stack direction="row" spacing={2} sx={{ mt: 3, justifyContent: "flex-end" }}>
            <Button variant="outlined" disabled={submitting} onClick={() => void signOut()}>
              {t("auth.passwordChange.signOut")}
            </Button>
            <Button
              type="submit"
              variant="contained"
              disabled={submitting || !currentPassword || !newPassword || !confirmation || mismatch}
            >
              {t(submitting ? "auth.passwordChange.changing" : "auth.passwordChange.title")}
            </Button>
          </Stack>
        </form>
      )}
      {!checked && error && (
        <Stack direction="row" spacing={2}>
          <Button onClick={() => void signOut()}>{t("auth.passwordChange.signOut")}</Button>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t("auth.passwordChange.retry")}</Button>
        </Stack>
      )}
    </Container>
  );
}
