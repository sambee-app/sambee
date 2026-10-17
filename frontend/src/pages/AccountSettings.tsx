import { LockReset as LockResetIcon, Refresh as RefreshIcon } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  ListItem,
  ListItemText,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminDialogActionButtonSx, adminDialogEndActionRowSx } from "../components/Admin/dialogActionStyles";
import { DialogNotice } from "../components/Dialog/DialogNotice";
import { ResponsiveDialogShell } from "../components/Dialog/ResponsiveDialogShell";
import { FormGroup, FormRow, FormSurface, formOutlinedControlSx } from "../components/Form/FormLayout";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsList } from "../components/Settings/SettingsList";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsPasswordVisibilityToggle } from "../components/Settings/SettingsPasswordVisibilityToggle";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { settingsPrimaryButtonSx, settingsUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { clearCurrentBrowserSession, signOutCurrentBrowser } from "../services/accountSession";
import api from "../services/api";
import { PASSWORD_CHANGED_MARKER } from "../services/passwordChange";
import type { AccountSessionKind, CurrentAccount, CurrentAccountSession, OidcBrowserSession } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";
import { dialogEnterKeyHandler } from "../utils/keyboardUtils";
import { formatLocalizedDateTime } from "../utils/localeFormatting";

const PASSWORD_CONFIRMATION_MISMATCH_MESSAGE = "The new password and confirmation do not match.";
const PASSWORD_FIELDS_REQUIRED_MESSAGE = "Complete all password fields.";

function formatTimestamp(value: string | null): string {
  return value ? formatLocalizedDateTime(value, {}) : "Never";
}

function formatIdentitySource(value: CurrentAccount["identity_source"]): string {
  return value === "oidc" ? "OIDC" : "Local";
}

interface AccountSessionRow {
  kind: AccountSessionKind;
  id: string | null;
  started_at: string | null;
  last_active_at: string | null;
  browser_name: string | null;
  operating_system: string | null;
  current: boolean;
}

function toAccountSessionRow(session: CurrentAccountSession): AccountSessionRow {
  return { ...session, current: true };
}

function toAccountSessionRowFromOidc(session: OidcBrowserSession): AccountSessionRow {
  return {
    kind: "oidc",
    id: session.id,
    started_at: session.created_at,
    last_active_at: session.last_seen_at,
    browser_name: session.browser_name,
    operating_system: session.operating_system,
    current: session.current,
  };
}

function formatBrowserSessionLabel(session: AccountSessionRow): string {
  if (session.kind === "password") {
    return "Password sign-in";
  }
  if (session.browser_name && session.operating_system) {
    return `${session.browser_name} on ${session.operating_system}`;
  }
  return session.browser_name ?? session.operating_system ?? "Browser session";
}

function formatBrowserSessionMetadata(session: AccountSessionRow): string {
  const startedAt = session.started_at ? `Started ${formatTimestamp(session.started_at)}.` : "Sign-in time unavailable.";
  return session.last_active_at ? `${startedAt} Last active ${formatTimestamp(session.last_active_at)}.` : startedAt;
}

interface BrowserSessionListProps {
  browserSessions: AccountSessionRow[];
  revoking: string | null;
  signingOut: boolean;
  onEndSession: (browserSession: AccountSessionRow) => Promise<void>;
}

function BrowserSessionList({ browserSessions, revoking, signingOut, onEndSession }: BrowserSessionListProps) {
  return (
    <SettingsList>
      {browserSessions.map((browserSession, index) => (
        <ListItem
          key={browserSession.id}
          divider={index < browserSessions.length - 1}
          secondaryAction={
            <Button color="error" onClick={() => void onEndSession(browserSession)} disabled={revoking !== null || signingOut}>
              {browserSession.current ? "Sign out" : "Revoke"}
            </Button>
          }
          sx={{ px: 0, pr: 12 }}
        >
          <ListItemText primary={formatBrowserSessionLabel(browserSession)} secondary={formatBrowserSessionMetadata(browserSession)} />
        </ListItem>
      ))}
    </SettingsList>
  );
}

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmation: string;
}

const EMPTY_PASSWORD_FORM: PasswordForm = {
  currentPassword: "",
  newPassword: "",
  confirmation: "",
};

function getPasswordConfirmationError(newPassword: string, confirmation: string): string | null {
  return newPassword && confirmation && newPassword !== confirmation ? PASSWORD_CONFIRMATION_MISMATCH_MESSAGE : null;
}

interface AccountIdentityRowProps {
  label: string;
  value: string;
  isLast?: boolean;
}

function AccountIdentityRow({ label, value, isLast = false }: AccountIdentityRowProps) {
  return (
    <TableRow
      sx={
        isLast
          ? {
              "& th, & td": { borderBottom: 0 },
            }
          : undefined
      }
    >
      <TableCell
        component="th"
        scope="row"
        sx={{
          width: { xs: "42%", sm: "32%" },
          px: 0,
          py: 1,
          pr: 2,
          verticalAlign: "top",
          color: "text.secondary",
          fontWeight: 500,
        }}
      >
        {label}
      </TableCell>
      <TableCell align="right" sx={{ px: 0, py: 1, verticalAlign: "top", overflowWrap: "anywhere" }}>
        {value}
      </TableCell>
    </TableRow>
  );
}

export function AccountSettings({ dialogSafe = false }: { dialogSafe?: boolean }) {
  const navigate = useNavigate();
  const [account, setAccount] = useState<CurrentAccount | null>(null);
  const [sessions, setSessions] = useState<OidcBrowserSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordConfirmationError, setPasswordConfirmationError] = useState<string | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordVisibility, setPasswordVisibility] = useState({ current: false, new: false, confirmation: false });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const currentPasswordInputRef = useRef<HTMLInputElement>(null);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const currentBrowserSession = account?.current_session ? toAccountSessionRow(account.current_session) : null;
  const otherBrowserSessions = (sessions ?? [])
    .filter((browserSession) => browserSession.id !== currentBrowserSession?.id)
    .map(toAccountSessionRowFromOidc);

  const loadAccount = useEffectEvent(async () => {
    setLoading(true);
    setError(null);
    setAccount(null);
    setSessions(null);
    try {
      const currentAccount = await api.getCurrentAccount();
      setAccount(currentAccount);
      if (!currentAccount.browser_session_management_available) {
        setSessions([]);
        return;
      }
      try {
        setSessions((await api.getOidcBrowserSessions()).sessions);
      } catch (sessionLoadError) {
        setError(getApiErrorMessage(sessionLoadError, "Browser sessions could not be loaded."));
      }
    } catch (accountLoadError) {
      setError(getApiErrorMessage(accountLoadError, "Account information could not be loaded."));
    } finally {
      setLoading(false);
    }
  });

  useEffect(() => {
    void loadAccount();
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await signOutCurrentBrowser();
      navigate("/login", { replace: true });
    } finally {
      setSigningOut(false);
    }
  };

  const endSession = async (browserSession: AccountSessionRow) => {
    if (browserSession.id === null) {
      await signOut();
      return;
    }
    setRevoking(browserSession.id);
    setError(null);
    try {
      await api.revokeOidcBrowserSession(browserSession.id);
      if (browserSession.current) {
        clearCurrentBrowserSession();
        navigate("/login", { replace: true });
        return;
      }
      await loadAccount();
    } catch (revokeError) {
      setError(getApiErrorMessage(revokeError, "The session could not be revoked."));
    } finally {
      setRevoking(null);
    }
  };

  const closePasswordDialog = () => {
    if (passwordSubmitting) {
      return;
    }
    setPasswordDialogOpen(false);
    setPasswordForm(EMPTY_PASSWORD_FORM);
    setPasswordError(null);
    setPasswordConfirmationError(null);
    setPasswordVisibility({ current: false, new: false, confirmation: false });
  };

  const openPasswordDialog = () => {
    setPasswordForm(EMPTY_PASSWORD_FORM);
    setPasswordError(null);
    setPasswordConfirmationError(null);
    setPasswordVisibility({ current: false, new: false, confirmation: false });
    setPasswordDialogOpen(true);
  };

  const updateNewPassword = (newPassword: string) => {
    setPasswordForm((current) => ({ ...current, newPassword }));
    setPasswordConfirmationError(getPasswordConfirmationError(newPassword, passwordForm.confirmation));
    setPasswordError(null);
  };

  const updatePasswordConfirmation = (confirmation: string) => {
    setPasswordForm((current) => ({ ...current, confirmation }));
    setPasswordConfirmationError(getPasswordConfirmationError(passwordForm.newPassword, confirmation));
    setPasswordError(null);
  };

  const submitPasswordChange = async () => {
    if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmation) {
      setPasswordError(PASSWORD_FIELDS_REQUIRED_MESSAGE);
      currentPasswordInputRef.current?.focus();
      return;
    }
    const confirmationError = getPasswordConfirmationError(passwordForm.newPassword, passwordForm.confirmation);
    if (confirmationError) {
      setPasswordConfirmationError(confirmationError);
      confirmationInputRef.current?.focus();
      return;
    }

    setPasswordSubmitting(true);
    setPasswordError(null);
    try {
      await api.changePassword(passwordForm.currentPassword, passwordForm.newPassword);
      sessionStorage.setItem(PASSWORD_CHANGED_MARKER, "1");
      await signOut();
    } catch (changeError) {
      setPasswordError(getApiErrorMessage(changeError, "The password could not be changed."));
    } finally {
      setPasswordSubmitting(false);
    }
  };

  return (
    <>
      <SettingsPage category="account" dialogSafeHeader={dialogSafe}>
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress aria-label="Loading account" size={28} />
          </Box>
        ) : account === null ? (
          <Box>
            <Button variant="outlined" sx={settingsUtilityButtonSx} startIcon={<RefreshIcon />} onClick={() => void loadAccount()}>
              Try again
            </Button>
          </Box>
        ) : (
          <SettingsSectionList>
            {account.must_change_password && account.password_change_available && (
              <Alert severity="warning">Your administrator requires you to change your local password.</Alert>
            )}
            <SettingsGroup title="Your identity" contentSpacing="compact">
              <Table aria-label="Your identity" size="small" sx={{ tableLayout: "fixed", width: "100%" }}>
                <TableBody>
                  <AccountIdentityRow label="Username" value={account.username} />
                  {account.name && <AccountIdentityRow label="Name" value={account.name} />}
                  {account.email && <AccountIdentityRow label="Email" value={account.email} />}
                  <AccountIdentityRow label="Identity source" value={formatIdentitySource(account.identity_source)} />
                  <AccountIdentityRow label="Role" value={account.role} isLast />
                </TableBody>
              </Table>
            </SettingsGroup>

            {account.password_change_available && (
              <SettingsGroup title="Password">
                <Button
                  variant="outlined"
                  startIcon={<LockResetIcon />}
                  onClick={openPasswordDialog}
                  disabled={passwordSubmitting}
                  sx={[settingsUtilityButtonSx, { alignSelf: "flex-start" }]}
                >
                  Change password
                </Button>
              </SettingsGroup>
            )}

            <SettingsGroup title="Sessions">
              {currentBrowserSession === null ? (
                <Typography sx={{ color: "text.secondary" }}>
                  Session information is not available because authentication is not enforced.
                </Typography>
              ) : (
                <SettingsSectionList level="subsection">
                  <SettingsGroup title="This browser" level="subsection">
                    <BrowserSessionList
                      browserSessions={[currentBrowserSession]}
                      revoking={revoking}
                      signingOut={signingOut}
                      onEndSession={endSession}
                    />
                  </SettingsGroup>
                  {sessions === null && account.browser_session_management_available ? (
                    <SettingsGroup title="Other sessions" level="subsection">
                      <Typography sx={{ color: "text.secondary" }}>Other sessions could not be loaded.</Typography>
                      <Button
                        sx={[settingsUtilityButtonSx, { mt: 2 }]}
                        variant="outlined"
                        startIcon={<RefreshIcon />}
                        onClick={() => void loadAccount()}
                        disabled={revoking !== null || signingOut}
                      >
                        Try again
                      </Button>
                    </SettingsGroup>
                  ) : otherBrowserSessions.length > 0 ? (
                    <SettingsGroup title="Other sessions" level="subsection">
                      <BrowserSessionList
                        browserSessions={otherBrowserSessions}
                        revoking={revoking}
                        signingOut={signingOut}
                        onEndSession={endSession}
                      />
                    </SettingsGroup>
                  ) : null}
                </SettingsSectionList>
              )}
            </SettingsGroup>
          </SettingsSectionList>
        )}
      </SettingsPage>

      <ResponsiveDialogShell
        open={passwordDialogOpen}
        onClose={closePasswordDialog}
        disableClose={passwordSubmitting}
        title="Change password"
        description="Enter your current password and choose a new one. You will be signed out after the change."
        actionNotice={<DialogNotice message={passwordError} testId="change-password-error" />}
        actions={
          <Box sx={adminDialogEndActionRowSx}>
            <Button
              onClick={closePasswordDialog}
              disabled={passwordSubmitting}
              variant="outlined"
              sx={{ ...settingsUtilityButtonSx, ...adminDialogActionButtonSx }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitPasswordChange()}
              variant="contained"
              disabled={passwordSubmitting || passwordConfirmationError !== null}
              startIcon={passwordSubmitting ? <CircularProgress size={18} color="inherit" /> : undefined}
              sx={{ ...settingsPrimaryButtonSx, ...adminDialogActionButtonSx }}
            >
              {passwordSubmitting ? "Changing password" : "Change password"}
            </Button>
          </Box>
        }
        onKeyDown={dialogEnterKeyHandler(() => {
          void submitPasswordChange();
        })}
        onTransitionEntered={() => {
          if (!(document.activeElement instanceof HTMLInputElement)) {
            currentPasswordInputRef.current?.focus();
          }
        }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <FormSurface testId="change-password-form-surface">
            <FormGroup edge="both">
              <FormRow sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
                <TextField
                  autoFocus
                  inputRef={currentPasswordInputRef}
                  label="Current password"
                  type={passwordVisibility.current ? "text" : "password"}
                  autoComplete="current-password"
                  value={passwordForm.currentPassword}
                  onChange={(event) => {
                    setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }));
                    setPasswordError(null);
                  }}
                  disabled={passwordSubmitting}
                  fullWidth
                  sx={formOutlinedControlSx}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <SettingsPasswordVisibilityToggle
                          visible={passwordVisibility.current}
                          onToggle={() => setPasswordVisibility((current) => ({ ...current, current: !current.current }))}
                          showLabel="Show current password"
                          hideLabel="Hide current password"
                        />
                      ),
                    },
                  }}
                />
              </FormRow>
              <FormRow sx={{ gridTemplateColumns: { md: "minmax(0, 1fr)" } }}>
                <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <TextField
                    label="New password"
                    type={passwordVisibility.new ? "text" : "password"}
                    autoComplete="new-password"
                    value={passwordForm.newPassword}
                    onChange={(event) => updateNewPassword(event.target.value)}
                    disabled={passwordSubmitting}
                    fullWidth
                    sx={formOutlinedControlSx}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <SettingsPasswordVisibilityToggle
                            visible={passwordVisibility.new}
                            onToggle={() => setPasswordVisibility((current) => ({ ...current, new: !current.new }))}
                            showLabel="Show new password"
                            hideLabel="Hide new password"
                          />
                        ),
                      },
                    }}
                  />
                  <TextField
                    inputRef={confirmationInputRef}
                    label="Confirm new password"
                    type={passwordVisibility.confirmation ? "text" : "password"}
                    autoComplete="new-password"
                    value={passwordForm.confirmation}
                    onChange={(event) => updatePasswordConfirmation(event.target.value)}
                    disabled={passwordSubmitting}
                    error={passwordConfirmationError !== null}
                    helperText={passwordConfirmationError}
                    fullWidth
                    sx={formOutlinedControlSx}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <SettingsPasswordVisibilityToggle
                            visible={passwordVisibility.confirmation}
                            onToggle={() => setPasswordVisibility((current) => ({ ...current, confirmation: !current.confirmation }))}
                            showLabel="Show password confirmation"
                            hideLabel="Hide password confirmation"
                          />
                        ),
                      },
                    }}
                  />
                </Box>
              </FormRow>
            </FormGroup>
          </FormSurface>
        </Box>
      </ResponsiveDialogShell>
    </>
  );
}
