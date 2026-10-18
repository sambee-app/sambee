import { ContentCopy } from "@mui/icons-material";
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { adminDialogActionButtonSx, adminDialogEndActionRowSx } from "../components/Admin/dialogActionStyles";
import { DialogNotice } from "../components/Dialog/DialogNotice";
import { ResponsiveDialogShell } from "../components/Dialog/ResponsiveDialogShell";
import {
  FormFieldLabel,
  FormGroup,
  FormRow,
  FormSurface,
  formFieldControlSx,
  formOutlinedControlSx,
  formSelectControlSx,
  formSelectMenuProps,
  formSelectSx,
} from "../components/Form/FormLayout";
import { SettingsFormSection } from "../components/Settings/SettingsFormLayout";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsPasswordVisibilityToggle } from "../components/Settings/SettingsPasswordVisibilityToggle";
import { SettingsSelectMenuItem } from "../components/Settings/SettingsSelectMenuItem";
import { settingsPrimaryButtonSx, settingsUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { loadAuthenticationSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { clearCachedAsyncData, getCachedAsyncData, primeCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useRemoveLocationFragment } from "../hooks/useRemoveLocationFragment";
import api from "../services/api";
import { clearAuthConfigCache } from "../services/authConfig";
import { authSession } from "../services/authSession";
import { loginPath } from "../services/oidcAuth";
import {
  type AuthenticationMode,
  isApiError,
  type OidcAdminConfigurationRead,
  type OidcConfigurationCandidate,
  type OidcReviewedPolicy,
  type OidcTestedIdentity,
} from "../types";
import { getApiErrorMessage, getOidcMappingValidationErrors } from "../utils/apiErrors";

const DEFAULT_CANDIDATE: OidcConfigurationCandidate = {
  display_name: "",
  issuer_url: "",
  client_id: "",
  scopes: ["openid", "profile", "email"],
  username_claim: "preferred_username",
  name_claim: "name",
  email_claim: "email",
  groups_claim: "groups",
  sign_in_mode: "oidc_or_password",
  interactive_reauthentication_max_age_days: 30,
  no_refresh_session_limit_hours: 8,
  admission_mode: "all_idp_users",
  admission_groups: [],
  role_assignment_mode: "uniform",
  uniform_role: "editor",
  role_mappings: { admin: [], editor: [], viewer: [] },
  auto_link_by_username: true,
};

const listValue = (values: string[]) => values.join(", ");
const parseList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
type OidcGroupDrafts = {
  admission: string;
  admin: string;
  editor: string;
  viewer: string;
};
type OidcGroupDraftField = keyof OidcGroupDrafts;
const groupDraftsFor = (candidate: OidcConfigurationCandidate): OidcGroupDrafts => ({
  admission: listValue(candidate.admission_groups),
  admin: listValue(candidate.role_mappings.admin),
  editor: listValue(candidate.role_mappings.editor),
  viewer: listValue(candidate.role_mappings.viewer),
});
const candidateWithGroupDrafts = (candidate: OidcConfigurationCandidate, drafts: OidcGroupDrafts): OidcConfigurationCandidate => ({
  ...candidate,
  admission_groups: parseList(drafts.admission),
  role_mappings: {
    ...candidate.role_mappings,
    admin: parseList(drafts.admin),
    editor: parseList(drafts.editor),
    viewer: parseList(drafts.viewer),
  },
});
const sameStringList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const sameGroupConfiguration = (left: OidcConfigurationCandidate, right: OidcConfigurationCandidate) =>
  sameStringList(left.admission_groups, right.admission_groups) &&
  sameStringList(left.role_mappings.admin, right.role_mappings.admin) &&
  sameStringList(left.role_mappings.editor, right.role_mappings.editor) &&
  sameStringList(left.role_mappings.viewer, right.role_mappings.viewer);
const optionalClaim = (value: string) => value.trim() || null;
const OIDC_SETUP_FLOW_STORAGE_KEY = "sambee.oidc.setupFlowId";
const OIDC_REVIEWED_POLICY_STORAGE_KEY = "sambee.oidc.reviewedPolicy";
const AUTHENTICATION_MODE_LABELS: Record<AuthenticationMode, string> = {
  none: "No authentication",
  password_only: "Password only",
  oidc_or_password: "OIDC or password",
  oidc_only: "OIDC only",
};
const OIDC_PENDING_FINALIZATION_STORAGE_KEY = "sambee.oidc.pendingFinalization";
const PROVIDER_DESKTOP_FIELD_WIDTH_PX = 360;
const PROVIDER_INTERVAL_DESKTOP_FIELD_WIDTH_PX = 112;
const REVIEWABLE_POLICY_KEYS = new Set<keyof OidcConfigurationCandidate>([
  "sign_in_mode",
  "interactive_reauthentication_max_age_days",
  "no_refresh_session_limit_hours",
  "admission_mode",
  "admission_groups",
  "role_assignment_mode",
  "uniform_role",
  "role_mappings",
  "auto_link_by_username",
]);

function clearAuthenticationCaches() {
  clearCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication);
  clearAuthConfigCache();
}

const normalizedGroupKey = (value: string) => value.normalize("NFKC").trim().toLowerCase();
const duplicateGroupKeys = (values: string[]) => {
  const keys = values.map(normalizedGroupKey);
  return new Set(keys.filter((key, index) => key && keys.indexOf(key) !== index));
};
const editableCandidate = ({
  client_secret_configured: _,
  configuration_revision: __,
  identity_mapping_revision: ___,
  role_mappings,
  ...candidate
}: NonNullable<OidcAdminConfigurationRead["configuration"]>): OidcConfigurationCandidate => ({
  ...candidate,
  role_mappings: { ...role_mappings, viewer: role_mappings.viewer ?? [] },
});
const reviewedPolicyFor = (candidate: OidcConfigurationCandidate): OidcReviewedPolicy => ({
  sign_in_mode: candidate.sign_in_mode,
  interactive_reauthentication_max_age_days: candidate.interactive_reauthentication_max_age_days,
  no_refresh_session_limit_hours: candidate.no_refresh_session_limit_hours,
  admission_mode: candidate.admission_mode,
  admission_groups: candidate.admission_groups,
  role_assignment_mode: candidate.role_assignment_mode,
  uniform_role: candidate.uniform_role,
  role_mappings: candidate.role_mappings,
  auto_link_by_username: candidate.auto_link_by_username,
});
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isReviewedPolicy = (value: unknown): value is OidcReviewedPolicy => {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Record<string, unknown>;
  const roleMappings = policy["role_mappings"];
  return (
    (policy["sign_in_mode"] === "oidc_or_password" || policy["sign_in_mode"] === "oidc_only") &&
    typeof policy["interactive_reauthentication_max_age_days"] === "number" &&
    typeof policy["no_refresh_session_limit_hours"] === "number" &&
    (policy["admission_mode"] === "all_idp_users" || policy["admission_mode"] === "selected_groups") &&
    isStringArray(policy["admission_groups"]) &&
    (policy["role_assignment_mode"] === "uniform" || policy["role_assignment_mode"] === "group_based") &&
    (policy["uniform_role"] === "admin" || policy["uniform_role"] === "editor" || policy["uniform_role"] === "viewer") &&
    typeof roleMappings === "object" &&
    roleMappings !== null &&
    isStringArray((roleMappings as Record<string, unknown>)["admin"]) &&
    isStringArray((roleMappings as Record<string, unknown>)["editor"]) &&
    isStringArray((roleMappings as Record<string, unknown>)["viewer"]) &&
    typeof policy["auto_link_by_username"] === "boolean"
  );
};
const storedReviewedPolicy = (): OidcReviewedPolicy | undefined => {
  const stored = sessionStorage.getItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const policy: unknown = JSON.parse(stored);
    if (isReviewedPolicy(policy)) return policy;
  } catch {
    // Invalid persisted state is discarded below.
  }
  sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
  return undefined;
};
interface PendingOidcFinalization {
  flow_id: string;
  reviewed_policy: OidcReviewedPolicy;
  replacement_mappings: Array<{ target_user_id: string; expected_username: string }>;
  expected_identity_mapping_revision: number | null;
  omitted_account_acknowledgements: string[];
}
type FinalizationFailureKind = "ambiguous" | "reauthentication" | "mapping_stale" | "configuration_changed" | "validation" | "other";
const isPendingOidcFinalization = (value: unknown): value is PendingOidcFinalization => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request["flow_id"] === "string" &&
    request["flow_id"].length > 0 &&
    isReviewedPolicy(request["reviewed_policy"]) &&
    Array.isArray(request["replacement_mappings"]) &&
    request["replacement_mappings"].every(
      (mapping) =>
        typeof mapping === "object" &&
        mapping !== null &&
        typeof (mapping as Record<string, unknown>)["target_user_id"] === "string" &&
        typeof (mapping as Record<string, unknown>)["expected_username"] === "string"
    ) &&
    (request["expected_identity_mapping_revision"] === null ||
      (typeof request["expected_identity_mapping_revision"] === "number" &&
        Number.isInteger(request["expected_identity_mapping_revision"]) &&
        request["expected_identity_mapping_revision"] >= 0)) &&
    isStringArray(request["omitted_account_acknowledgements"])
  );
};
const storedPendingFinalization = (): PendingOidcFinalization | undefined => {
  const stored = sessionStorage.getItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const request: unknown = JSON.parse(stored);
    if (isPendingOidcFinalization(request)) return request;
  } catch {
    // Invalid persisted state is discarded below.
  }
  sessionStorage.removeItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
  return undefined;
};
const finalizeOidcRequest = (request: PendingOidcFinalization) =>
  api.finalizeOidcConfiguration(
    request.flow_id,
    request.reviewed_policy,
    request.replacement_mappings,
    request.expected_identity_mapping_revision,
    request.omitted_account_acknowledgements
  );
const finalizeOidcRequestWithRetry = async (request: PendingOidcFinalization) => {
  try {
    return await finalizeOidcRequest(request);
  } catch (firstAttemptError: unknown) {
    if (!isApiError(firstAttemptError) || firstAttemptError.response !== undefined) throw firstAttemptError;
    return finalizeOidcRequest(request);
  }
};
const finalizationFailureKind = (error: unknown): FinalizationFailureKind => {
  if (!isApiError(error)) return "other";
  if (error.response === undefined) return "ambiguous";
  if (error.response.status === 401) return "reauthentication";
  const errorCode = getApiErrorMessage(error, "");
  if (errorCode === "oidc_mapping_review_stale") return "mapping_stale";
  if (errorCode === "oidc_configuration_changed") return "configuration_changed";
  if (getOidcMappingValidationErrors(error).length > 0) return "validation";
  return "other";
};
const mappingValidationFieldErrors = (errors: ReturnType<typeof getOidcMappingValidationErrors>) =>
  Object.fromEntries(
    errors
      .filter((mappingError) => mappingError.target_user_id !== null)
      .map((mappingError) => [mappingError.target_user_id, mappingError.message])
  );
const mappingValidationActionError = (errors: ReturnType<typeof getOidcMappingValidationErrors>) =>
  errors
    .filter((mappingError) => mappingError.target_user_id === null)
    .map((mappingError) => mappingError.message)
    .join(" ");
const mappingReviewFor = (identity: OidcTestedIdentity) =>
  Object.fromEntries(
    identity.replacement_mappings.map((mapping) => [
      mapping.target_user_id,
      {
        selected: mapping.selected_by_default,
        expectedUsername: mapping.selected_by_default ? mapping.suggested_username : "",
        omissionAcknowledged: false,
      },
    ])
  );

export function AuthenticationSettings() {
  const navigate = useNavigate();
  const removeLocationFragment = useEffectEvent(useRemoveLocationFragment());
  const theme = useTheme();
  const usesDesktopFormLayout = useMediaQuery(theme.breakpoints.up("md"));
  const formFieldSize = usesDesktopFormLayout ? "small" : "medium";
  const providerFieldSx = [formOutlinedControlSx, { width: { md: PROVIDER_DESKTOP_FIELD_WIDTH_PX } }];
  const providerIntervalFieldSx = [formOutlinedControlSx, { width: { md: PROVIDER_INTERVAL_DESKTOP_FIELD_WIDTH_PX } }];
  const [candidate, setCandidate] = useState<OidcConfigurationCandidate>(DEFAULT_CANDIDATE);
  const [groupDrafts, setGroupDrafts] = useState<OidcGroupDrafts>(() => groupDraftsFor(DEFAULT_CANDIDATE));
  const [configuration, setConfiguration] = useState<OidcAdminConfigurationRead | null>(() =>
    getCachedAsyncData<OidcAdminConfigurationRead>(SETTINGS_DATA_CACHE_KEYS.adminAuthentication)
  );
  const [scopesInput, setScopesInput] = useState(() => listValue(DEFAULT_CANDIDATE.scopes));
  const [authMode, setAuthMode] = useState<AuthenticationMode>("password_only");
  const [clientSecret, setClientSecret] = useState("");
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [oidcDialogOpen, setOidcDialogOpen] = useState(false);
  const [oidcReviewOpen, setOidcReviewOpen] = useState(false);
  const [testedIdentity, setTestedIdentity] = useState<OidcTestedIdentity | null>(null);
  const [mappingReview, setMappingReview] = useState<
    Record<string, { selected: boolean; expectedUsername: string; omissionAcknowledged: boolean }>
  >({});
  const [mappingErrors, setMappingErrors] = useState<Record<string, string>>({});
  const [reviewPending, setReviewPending] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [testError, setTestError] = useState("");
  const [notice, setNotice] = useState("");
  const [configurationActionError, setConfigurationActionError] = useState("");
  const [configurationActionNotice, setConfigurationActionNotice] = useState("");
  const [reviewContextualError, setReviewContextualError] = useState("");
  const [reviewActionError, setReviewActionError] = useState("");
  const [finalizationUnresolved, setFinalizationUnresolved] = useState(() => storedPendingFinalization() !== undefined);
  const providerNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setScopesInput(listValue(candidate.scopes));
  }, [candidate.scopes]);

  const previewRequestSequence = useRef(0);
  const initializeOidcDraft = useCallback((nextCandidate: OidcConfigurationCandidate) => {
    setCandidate(nextCandidate);
    setGroupDrafts(groupDraftsFor(nextCandidate));
    setScopesInput(listValue(nextCandidate.scopes));
  }, []);
  const applyOidcPreviewResult = (identity: OidcTestedIdentity) => {
    setCandidate(editableCandidate(identity.candidate));
    setTestedIdentity(identity);
    setMappingErrors({});
    setMappingReview(mappingReviewFor(identity));
    setReviewPending(false);
  };
  const effectiveCandidate = candidateWithGroupDrafts(candidate, groupDrafts);
  const selectedMappings = testedIdentity?.replacement_mappings.filter((mapping) => mappingReview[mapping.target_user_id]?.selected) ?? [];
  const replacementUsernames = selectedMappings.map((mapping) => mappingReview[mapping.target_user_id]?.expectedUsername.trim() ?? "");
  const requiredOmissions =
    testedIdentity?.replacement_mappings.filter(
      (mapping) =>
        mapping.omission_acknowledgement_required &&
        !mappingReview[mapping.target_user_id]?.selected &&
        !mappingReview[mapping.target_user_id]?.omissionAcknowledged
    ) ?? [];
  const omittedPasswordlessMappings =
    testedIdentity?.replacement_mappings.filter(
      (mapping) =>
        mapping.target_state === "active" &&
        !mapping.has_local_password &&
        !mappingReview[mapping.target_user_id]?.selected &&
        testedIdentity.candidate.sign_in_mode === "oidc_or_password"
    ) ?? [];
  const replacementPlanInvalid =
    replacementUsernames.some((username) => !username || username === testedIdentity?.username.trim()) ||
    new Set(replacementUsernames).size !== replacementUsernames.length ||
    requiredOmissions.length > 0;
  const duplicateAdmissionGroups = duplicateGroupKeys(effectiveCandidate.admission_groups);
  const duplicateAdminGroups = duplicateGroupKeys(effectiveCandidate.role_mappings.admin);
  const duplicateEditorGroups = duplicateGroupKeys(effectiveCandidate.role_mappings.editor);
  const duplicateViewerGroups = duplicateGroupKeys(effectiveCandidate.role_mappings.viewer);
  const adminGroupKeys = new Set(effectiveCandidate.role_mappings.admin.map(normalizedGroupKey));
  const editorGroupKeys = new Set(effectiveCandidate.role_mappings.editor.map(normalizedGroupKey));
  const viewerGroupKeys = new Set(effectiveCandidate.role_mappings.viewer.map(normalizedGroupKey));
  const allRoleGroupKeys = [...adminGroupKeys, ...editorGroupKeys, ...viewerGroupKeys];
  const crossRoleGroupKeys = new Set(allRoleGroupKeys.filter((key, index) => allRoleGroupKeys.indexOf(key) !== index));
  const usesGroupBasedRoleAssignment = effectiveCandidate.role_assignment_mode === "group_based";
  const admissionGroupError =
    effectiveCandidate.admission_mode === "selected_groups" && effectiveCandidate.admission_groups.length === 0
      ? "Members of these groups can sign in. Enter at least one group name. Separate multiple groups by commas."
      : duplicateAdmissionGroups.size > 0
        ? "Admission groups must be unique after normalization."
        : "";
  const adminGroupError =
    usesGroupBasedRoleAssignment && duplicateAdminGroups.size > 0
      ? "Administrator groups must be unique after normalization."
      : usesGroupBasedRoleAssignment && crossRoleGroupKeys.size > 0
        ? "A group cannot grant more than one role."
        : "";
  const editorGroupError =
    usesGroupBasedRoleAssignment && duplicateEditorGroups.size > 0
      ? "Editor groups must be unique after normalization."
      : usesGroupBasedRoleAssignment && crossRoleGroupKeys.size > 0
        ? "A group cannot grant more than one role."
        : "";
  const viewerGroupError =
    usesGroupBasedRoleAssignment && duplicateViewerGroups.size > 0
      ? "Viewer groups must be unique after normalization."
      : usesGroupBasedRoleAssignment && crossRoleGroupKeys.size > 0
        ? "A group cannot grant more than one role."
        : "";
  const scopesError = candidate.scopes.includes("openid") ? "" : "Scopes must include openid.";
  const groupConfigurationInvalid = Boolean(admissionGroupError || adminGroupError || editorGroupError || viewerGroupError);
  const testedIdentityCanActivate = !reviewPending && testedIdentity?.admitted === true;
  const isOidcMode = authMode === "oidc_or_password" || authMode === "oidc_only";
  const isActiveOidcMode = configuration?.auth_mode === "oidc_or_password" || configuration?.auth_mode === "oidc_only";
  const oidcModeActivationPending = isOidcMode && configuration?.configuration !== null && configuration?.auth_mode !== authMode;
  const hasHealthyActiveOidcConfiguration = Boolean(
    isActiveOidcMode && configuration?.configuration && configuration.health.status === "healthy"
  );
  const oidcStatusTitle = oidcModeActivationPending
    ? "Changes pending"
    : hasHealthyActiveOidcConfiguration
      ? "Active"
      : isActiveOidcMode
        ? "Needs attention"
        : configuration?.configuration
          ? "Configured, not active"
          : "Not configured";
  const oidcStatusDescription = oidcModeActivationPending
    ? "Test the provider again to activate the selected OIDC sign-in mode."
    : hasHealthyActiveOidcConfiguration
      ? "OIDC sign-in is available and the provider configuration is healthy."
      : isActiveOidcMode && configuration?.health.reasons.includes("public_url_missing")
        ? "Set Sambee's externally reachable public URL in network settings."
        : isActiveOidcMode
          ? "OIDC is active, but the provider configuration needs attention."
          : configuration?.configuration
            ? "Provider settings are saved. Select an OIDC authentication mode to activate them."
            : "Set up a provider so people can sign in with an existing identity service.";
  const isSelectedNonOidcModeActive = !isOidcMode && configuration?.auth_mode === authMode;

  const renderDesktopFieldLabel = (
    label: string,
    description: string,
    descriptionId: string,
    htmlFor?: string,
    required = false,
    hasError = false
  ) =>
    usesDesktopFormLayout ? (
      <FormFieldLabel
        label={label}
        description={description}
        descriptionId={descriptionId}
        htmlFor={htmlFor}
        required={required}
        feedback={hasError ? { message: description, severity: "error" } : null}
      />
    ) : null;

  const renderFormRow = (
    label: string,
    description: string,
    descriptionId: string,
    htmlFor: string,
    control: ReactNode,
    required = false,
    hasError = false
  ) => (
    <FormRow>
      {renderDesktopFieldLabel(label, description, descriptionId, htmlFor, required, hasError)}
      <Box sx={formFieldControlSx}>{control}</Box>
    </FormRow>
  );

  const pageActionButtonSx = {
    flex: { xs: 1, sm: "0 0 auto" },
    minWidth: { sm: 180 },
  };

  useEffect(() => {
    let active = true;
    const restore = async () => {
      let recoveredFinalization = false;
      let replayFailure: FinalizationFailureKind | null = null;
      let replayValidationErrors: ReturnType<typeof getOidcMappingValidationErrors> = [];
      const fragmentFlowId = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("flow");
      if (fragmentFlowId) {
        sessionStorage.setItem(OIDC_SETUP_FLOW_STORAGE_KEY, fragmentFlowId);
        removeLocationFragment(["flow"]);
      }
      const pendingFinalization = storedPendingFinalization();
      if (pendingFinalization) {
        setFinalizationUnresolved(true);
        try {
          const result = await finalizeOidcRequestWithRetry(pendingFinalization);
          if (!active) return;
          clearAuthConfigCache();
          setFinalizationUnresolved(false);
          sessionStorage.removeItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
          sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
          sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
          if (result.reauthentication_required) {
            localStorage.removeItem("access_token");
            authSession.clear();
            navigate(loginPath(window.location.pathname + window.location.search), { replace: true });
            return;
          }
          setNotice("Authentication configuration activated.");
          recoveredFinalization = true;
        } catch (caught: unknown) {
          if (!active) return;
          replayFailure = finalizationFailureKind(caught);
          if (replayFailure === "validation") {
            replayValidationErrors = getOidcMappingValidationErrors(caught);
          }
          if (replayFailure === "ambiguous") {
            setError("Activation may have completed, but the server response was not received. Reload this page to confirm the result.");
            return;
          }
          if (replayFailure === "reauthentication") return;
          setFinalizationUnresolved(false);
          sessionStorage.removeItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
          if (replayFailure === "configuration_changed") {
            sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
            sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
            setError("The OIDC configuration changed after this test. Connect and test the provider again.");
          }
        }
      }

      const response = await primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication, loadAuthenticationSettingsData);
      if (!active) return;
      setConfiguration(response);
      setAuthMode(response.auth_mode);
      if (response.configuration) initializeOidcDraft(editableCandidate(response.configuration));
      if (recoveredFinalization || replayFailure === "configuration_changed") return;
      const flowId = fragmentFlowId ?? sessionStorage.getItem(OIDC_SETUP_FLOW_STORAGE_KEY);
      if (!flowId) return;
      try {
        const identity = await api.getOidcTestResult(flowId, storedReviewedPolicy());
        if (!active) return;
        initializeOidcDraft(editableCandidate(identity.candidate));
        setAuthMode(identity.candidate.sign_in_mode);
        setTestedIdentity(identity);
        setOidcDialogOpen(true);
        setOidcReviewOpen(true);
        setMappingErrors(replayFailure === "validation" ? mappingValidationFieldErrors(replayValidationErrors) : {});
        setMappingReview(mappingReviewFor(identity));
        sessionStorage.setItem(OIDC_REVIEWED_POLICY_STORAGE_KEY, JSON.stringify(reviewedPolicyFor(identity.candidate)));
        if (replayFailure === "mapping_stale") {
          setReviewContextualError("The account mapping review changed. Review the refreshed mappings before activating.");
        } else if (replayFailure === "validation" && mappingValidationActionError(replayValidationErrors)) {
          setReviewContextualError(mappingValidationActionError(replayValidationErrors));
        } else if (replayFailure === "other") {
          setReviewContextualError("The tested configuration could not be activated. Review it before trying again.");
        }
      } catch (caught: unknown) {
        if (!active) return;
        if (isApiError(caught) && caught.response?.status === 404) {
          sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
          sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
          setError("The saved OIDC test has expired. Connect and test the provider again.");
          return;
        }
        setError("The OIDC test result could not be loaded. Retry by reopening this page.");
      }
    };
    void restore()
      .catch(() => {
        if (active) setError("Authentication settings could not be loaded.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [navigate, initializeOidcDraft]);

  const applyCandidateUpdate = (nextCandidate: OidcConfigurationCandidate, changedField: keyof OidcConfigurationCandidate) => {
    if (finalizationUnresolved) return;
    setCandidate(nextCandidate);
    setTestError("");
    if (testedIdentity && REVIEWABLE_POLICY_KEYS.has(changedField)) {
      const requestSequence = ++previewRequestSequence.current;
      const reviewedPolicy = reviewedPolicyFor(nextCandidate);
      sessionStorage.setItem(OIDC_REVIEWED_POLICY_STORAGE_KEY, JSON.stringify(reviewedPolicy));
      setReviewPending(true);
      setReviewContextualError("");
      setReviewActionError("");
      void api
        .getOidcTestResult(testedIdentity.flow_id, reviewedPolicy)
        .then((identity) => {
          if (requestSequence !== previewRequestSequence.current) return;
          applyOidcPreviewResult(identity);
        })
        .catch((caught: unknown) => {
          if (requestSequence !== previewRequestSequence.current) return;
          if (isApiError(caught) && caught.response?.status === 404) {
            sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
            sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
            setTestedIdentity(null);
            setOidcReviewOpen(false);
            setMappingReview({});
            setConfigurationActionError("The OIDC test expired. Connect and test the provider again.");
            return;
          }
          if (getApiErrorMessage(caught, "") === "oidc_configuration_changed") {
            sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
            sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
            setTestedIdentity(null);
            setOidcReviewOpen(false);
            setMappingReview({});
            setConfigurationActionError("The OIDC configuration changed after this test. Connect and test the provider again.");
            return;
          }
          setReviewActionError("The reviewed access policy could not be evaluated. Change it or retry before activating.");
        });
      setNotice("");
      return;
    }
    ++previewRequestSequence.current;
    setReviewPending(false);
    setTestedIdentity(null);
    setMappingReview({});
    setMappingErrors({});
    sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
    sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
    setNotice("");
  };

  const update = <Key extends keyof OidcConfigurationCandidate>(key: Key, value: OidcConfigurationCandidate[Key]) => {
    applyCandidateUpdate({ ...candidate, [key]: value }, key);
  };

  const updateGroupDraft = (field: OidcGroupDraftField, rawValue: string) => {
    if (finalizationUnresolved) return;
    const nextDrafts = { ...groupDrafts, [field]: rawValue };
    const nextCandidate = candidateWithGroupDrafts(candidate, nextDrafts);
    setGroupDrafts(nextDrafts);
    if (!sameGroupConfiguration(candidate, nextCandidate)) {
      applyCandidateUpdate(nextCandidate, field === "admission" ? "admission_groups" : "role_mappings");
    }
  };

  const resetOidcDraft = () => {
    const nextCandidate = configuration?.configuration
      ? editableCandidate(configuration.configuration)
      : { ...DEFAULT_CANDIDATE, sign_in_mode: isOidcMode ? authMode : DEFAULT_CANDIDATE.sign_in_mode };

    initializeOidcDraft(nextCandidate);
    setClientSecret("");
    setShowClientSecret(false);
    setTestError("");
    setConfigurationActionError("");
    setConfigurationActionNotice("");
  };

  const openOidcDialog = () => {
    setConfigurationActionError("");
    setConfigurationActionNotice("");
    setTestError("");
    setOidcDialogOpen(true);
  };

  const startTest = async (candidateToTest: OidcConfigurationCandidate = effectiveCandidate, clientSecretToTest = clientSecret) => {
    if (finalizationUnresolved) return;
    setBusy(true);
    setError("");
    setConfigurationActionError("");
    setConfigurationActionNotice("");
    setTestError("");
    try {
      const payload = { ...candidateToTest };
      if (clientSecretToTest.trim()) payload.client_secret = clientSecretToTest;
      const result = await api.startOidcTest(payload);
      sessionStorage.setItem(OIDC_SETUP_FLOW_STORAGE_KEY, result.flow_id);
      sessionStorage.setItem(OIDC_REVIEWED_POLICY_STORAGE_KEY, JSON.stringify(reviewedPolicyFor(candidateToTest)));
      window.location.assign(result.authorization_url);
    } catch (caught: unknown) {
      setTestError(getApiErrorMessage(caught, "The OIDC configuration could not be validated."));
      setBusy(false);
    }
  };

  const activate = async () => {
    if (finalizationUnresolved || !testedIdentity || replacementPlanInvalid || !testedIdentityCanActivate) return;
    setBusy(true);
    setError("");
    setReviewActionError("");
    const finalizationRequest: PendingOidcFinalization = {
      flow_id: testedIdentity.flow_id,
      reviewed_policy: reviewedPolicyFor(effectiveCandidate),
      replacement_mappings: selectedMappings.map(({ target_user_id }) => ({
        target_user_id,
        expected_username: mappingReview[target_user_id]?.expectedUsername.trim() ?? "",
      })),
      expected_identity_mapping_revision: testedIdentity.expected_identity_mapping_revision,
      omitted_account_acknowledgements: testedIdentity.replacement_mappings
        .filter(
          (mapping) =>
            mapping.omission_acknowledgement_required &&
            !mappingReview[mapping.target_user_id]?.selected &&
            mappingReview[mapping.target_user_id]?.omissionAcknowledged
        )
        .map((mapping) => mapping.target_user_id),
    };
    sessionStorage.setItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY, JSON.stringify(finalizationRequest));
    setFinalizationUnresolved(true);
    let result: Awaited<ReturnType<typeof finalizeOidcRequestWithRetry>>;
    try {
      result = await finalizeOidcRequestWithRetry(finalizationRequest);
    } catch (caught: unknown) {
      const failureKind = finalizationFailureKind(caught);
      if (failureKind !== "ambiguous" && failureKind !== "reauthentication") {
        setFinalizationUnresolved(false);
        sessionStorage.removeItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
      }
      const validationErrors = getOidcMappingValidationErrors(caught);
      if (failureKind === "mapping_stale") {
        try {
          const refreshedIdentity = await api.getOidcTestResult(testedIdentity.flow_id, reviewedPolicyFor(effectiveCandidate));
          applyOidcPreviewResult(refreshedIdentity);
          setReviewActionError("The account mapping review changed. Review the refreshed mappings before activating.");
        } catch (refreshError: unknown) {
          if (isApiError(refreshError) && refreshError.response?.status === 404) {
            sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
            sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
            setTestedIdentity(null);
            setOidcReviewOpen(false);
            setMappingReview({});
            setMappingErrors({});
            setConfigurationActionError("The OIDC test expired while refreshing mappings. Connect and test the provider again.");
          } else {
            setReviewActionError("The current mapping review could not be loaded. Retry activation to refresh it.");
          }
        }
      } else if (failureKind === "configuration_changed") {
        sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
        sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
        setTestedIdentity(null);
        setOidcReviewOpen(false);
        setMappingReview({});
        setMappingErrors({});
        setConfigurationActionError("The OIDC configuration changed after this test. Connect and test the provider again.");
      } else if (failureKind === "validation") {
        setMappingErrors(mappingValidationFieldErrors(validationErrors));
        setReviewActionError(mappingValidationActionError(validationErrors));
      } else if (failureKind === "ambiguous") {
        setReviewActionError(
          "Activation may have completed, but the server response was not received. Reload this page to confirm the result."
        );
      } else {
        setReviewActionError("The tested configuration could not be activated. Run the test again.");
      }
      setBusy(false);
      return;
    }

    clearAuthenticationCaches();
    setFinalizationUnresolved(false);
    setTestedIdentity(null);
    setMappingReview({});
    sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
    sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
    sessionStorage.removeItem(OIDC_PENDING_FINALIZATION_STORAGE_KEY);
    setClientSecret("");
    setShowClientSecret(false);
    setOidcDialogOpen(false);
    setOidcReviewOpen(false);
    if (result.reauthentication_required) {
      localStorage.removeItem("access_token");
      authSession.clear();
      navigate(loginPath(window.location.pathname + window.location.search), { replace: true });
      setBusy(false);
      return;
    }
    setNotice("Authentication configuration activated.");
    try {
      const refreshed = await primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication, loadAuthenticationSettingsData, true);
      setConfiguration(refreshed);
      if (refreshed.configuration) initializeOidcDraft(editableCandidate(refreshed.configuration));
    } catch {
      setError("Authentication was activated, but the current settings could not be reloaded. Reload this page to refresh them.");
    } finally {
      setBusy(false);
    }
  };

  const cancelTestFlow = async () => {
    if (finalizationUnresolved || !testedIdentity) return;
    setBusy(true);
    setError("");
    setReviewActionError("");
    try {
      await api.cancelOidcTestFlow(testedIdentity.flow_id);
      sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
      sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
      setTestedIdentity(null);
      setMappingReview({});
      setMappingErrors({});
      resetOidcDraft();
      setOidcDialogOpen(false);
      setOidcReviewOpen(false);
      setNotice("OIDC setup canceled.");
    } catch {
      setReviewActionError("The OIDC setup flow could not be canceled. It may already have expired.");
    } finally {
      setBusy(false);
    }
  };

  const closeOidcDialog = () => {
    if (busy || finalizationUnresolved) return;
    if (testedIdentity) {
      void cancelTestFlow();
      return;
    }

    resetOidcDraft();
    setOidcDialogOpen(false);
  };

  const returnToOidcConfiguration = () => {
    if (busy || finalizationUnresolved) return;
    setReviewActionError("");
    setReviewContextualError("");
    setOidcReviewOpen(false);
  };

  const setPasswordOnly = async () => {
    if (finalizationUnresolved) return;
    const activeConfiguration = configuration?.configuration;
    if (!activeConfiguration) return;
    const passwordlessCount = configuration.active_passwordless_user_count;
    setBusy(true);
    setError("");
    try {
      await api.setPasswordOnlyAuthentication(activeConfiguration.configuration_revision, passwordlessCount, passwordlessCount > 0);
      clearAuthenticationCaches();
      setTestedIdentity(null);
      setClientSecret("");
      setShowClientSecret(false);
      localStorage.removeItem("access_token");
      authSession.clear();
      navigate(loginPath(window.location.pathname + window.location.search), { replace: true });
    } catch (caught: unknown) {
      const errorCode = getApiErrorMessage(caught, "");
      if (errorCode === "oidc_configuration_changed" || errorCode === "passwordless_account_count_changed") {
        try {
          const refreshed = await primeCachedAsyncData(SETTINGS_DATA_CACHE_KEYS.adminAuthentication, loadAuthenticationSettingsData, true);
          setConfiguration(refreshed);
          if (refreshed.configuration) initializeOidcDraft(editableCandidate(refreshed.configuration));
          setError("Authentication settings changed. Review the current Password-only impact and confirm again.");
        } catch {
          setError("Authentication settings changed and could not be refreshed. Reload this page before trying again.");
        }
      } else if (errorCode === "passwordless_account_loss_not_acknowledged") {
        setError("Confirm that active accounts without local passwords will lose sign-in access.");
      } else {
        setError("Password-only mode requires an active administrator with a local password.");
      }
    } finally {
      setBusy(false);
    }
  };

  const activateNonOidcMode = async () => {
    if (finalizationUnresolved || isOidcMode) return;
    if (authMode === "password_only" && configuration?.configuration) {
      await setPasswordOnly();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.activateAuthenticationMode(authMode, authMode === "none");
      clearAuthenticationCaches();
      localStorage.removeItem("access_token");
      authSession.clear();
      navigate(loginPath(window.location.pathname + window.location.search), { replace: true });
    } catch (caught: unknown) {
      setError(getApiErrorMessage(caught, "Authentication mode could not be activated."));
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      category="admin-authentication"
      footerPrimaryActions={
        !isOidcMode ? (
          <Button
            variant="contained"
            sx={[settingsPrimaryButtonSx, pageActionButtonSx].flat()}
            disabled={busy || finalizationUnresolved || isSelectedNonOidcModeActive}
            onClick={() => void activateNonOidcMode()}
          >
            {authMode === "none" ? "Activate No authentication" : "Activate Password-only mode"}
          </Button>
        ) : undefined
      }
    >
      <Box sx={{ maxWidth: 820 }}>
        {busy && !configuration ? (
          <Box sx={{ display: "flex", justifyContent: "center", pt: 5 }}>
            <CircularProgress aria-label="Loading authentication settings" />
          </Box>
        ) : null}
        {!(busy && !configuration) && (
          <>
            {error && !oidcDialogOpen && !oidcReviewOpen && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            {notice && !oidcDialogOpen && !oidcReviewOpen && (
              <Alert severity="success" sx={{ mb: 2 }}>
                {notice}
              </Alert>
            )}
            {configuration?.auth_enforcement_disabled && (
              <Alert severity="warning" sx={{ mb: 3 }}>
                Authentication is disabled in the configuration file.
              </Alert>
            )}
            <Stack spacing={2.5}>
              <FormSurface testId="authentication-mode-form-surface">
                <FormGroup edge="both">
                  <FormRow>
                    {renderDesktopFieldLabel(
                      "Authentication mode",
                      "Choose available sign-in methods",
                      "authentication-mode-description",
                      "authentication-mode"
                    )}
                    <TextField
                      id="authentication-mode"
                      select
                      fullWidth={!usesDesktopFormLayout}
                      size={formFieldSize}
                      label={usesDesktopFormLayout ? undefined : "Authentication mode"}
                      value={authMode}
                      onChange={(event) => {
                        const mode = event.target.value as AuthenticationMode;
                        setAuthMode(mode);
                        setTestError("");
                        if (mode === "oidc_or_password" || mode === "oidc_only") {
                          update("sign_in_mode", mode);
                          return;
                        }
                        ++previewRequestSequence.current;
                        setReviewPending(false);
                        setTestedIdentity(null);
                        setMappingReview({});
                        setMappingErrors({});
                        sessionStorage.removeItem(OIDC_SETUP_FLOW_STORAGE_KEY);
                        sessionStorage.removeItem(OIDC_REVIEWED_POLICY_STORAGE_KEY);
                      }}
                      disabled={finalizationUnresolved}
                      helperText={usesDesktopFormLayout ? undefined : "Choose available sign-in methods"}
                      slotProps={{
                        select: {
                          SelectDisplayProps: { tabIndex: 0 },
                          MenuProps: formSelectMenuProps,
                          renderValue: (selected) => AUTHENTICATION_MODE_LABELS[selected as AuthenticationMode],
                        },
                        htmlInput: { "aria-describedby": usesDesktopFormLayout ? "authentication-mode-description" : undefined },
                      }}
                      sx={[formSelectControlSx, formOutlinedControlSx, formSelectSx].flat()}
                    >
                      <SettingsSelectMenuItem
                        value="none"
                        label={AUTHENTICATION_MODE_LABELS.none}
                        description="No sign-in required; use only behind a trusted proxy or network perimeter"
                      />
                      <SettingsSelectMenuItem
                        value="password_only"
                        label={AUTHENTICATION_MODE_LABELS.password_only}
                        description={
                          configuration?.active_passwordless_user_count
                            ? `${configuration.active_passwordless_user_count} active account${configuration.active_passwordless_user_count === 1 ? "" : "s"} without a local password will lose sign-in access`
                            : "Local username and password sign-in only"
                        }
                      />
                      <SettingsSelectMenuItem
                        value="oidc_or_password"
                        label={AUTHENTICATION_MODE_LABELS.oidc_or_password}
                        description="Sign in with the identity provider or a local password"
                      />
                      <SettingsSelectMenuItem
                        value="oidc_only"
                        label={AUTHENTICATION_MODE_LABELS.oidc_only}
                        description="Redirect users to the identity provider"
                      />
                    </TextField>
                  </FormRow>
                </FormGroup>
              </FormSurface>

              {(isOidcMode || isActiveOidcMode) && (
                <SettingsGroup title="OpenID Connect">
                  <FormSurface testId="authentication-oidc-status-surface">
                    <Stack spacing={2}>
                      <Box
                        sx={{
                          display: "flex",
                          flexDirection: { xs: "column", sm: "row" },
                          alignItems: { sm: "center" },
                          justifyContent: "space-between",
                          gap: 2,
                        }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                            {oidcStatusTitle}
                          </Typography>
                          <Typography variant="body2" sx={{ color: "text.secondary" }}>
                            {oidcStatusDescription}
                          </Typography>
                        </Box>
                        <Button
                          variant="contained"
                          sx={settingsPrimaryButtonSx}
                          disabled={busy || finalizationUnresolved}
                          onClick={openOidcDialog}
                        >
                          {oidcModeActivationPending ? "Review and activate OIDC mode" : "Configure OIDC"}
                        </Button>
                      </Box>
                    </Stack>
                  </FormSurface>
                </SettingsGroup>
              )}

              <ResponsiveDialogShell
                open={oidcDialogOpen && !oidcReviewOpen}
                onClose={closeOidcDialog}
                disableClose={busy || finalizationUnresolved}
                title="Configure OIDC"
                maxWidth="md"
                contextualNotice={
                  <DialogNotice
                    message={
                      configuration?.health.status === "unhealthy"
                        ? configuration.health.reasons.includes("public_url_missing")
                          ? "Set Sambee's externally reachable public URL in network settings before testing this provider."
                          : "Complete the required configuration before testing this provider."
                        : null
                    }
                    severity="warning"
                    testId="oidc-configuration-health-warning"
                  />
                }
                actionNotice={
                  configurationActionError || configurationActionNotice || testError ? (
                    <Stack spacing={1}>
                      <DialogNotice message={configurationActionError} testId="oidc-configuration-action-error" />
                      {configurationActionNotice && (
                        <Alert data-testid="oidc-configuration-action-notice" severity="success" role="status">
                          {configurationActionNotice}
                        </Alert>
                      )}
                      <DialogNotice
                        message={
                          testError ? (
                            <>
                              <AlertTitle>Connection test failed</AlertTitle>
                              {testError}
                            </>
                          ) : null
                        }
                        testId="oidc-configuration-test-error"
                      />
                    </Stack>
                  ) : null
                }
                onTransitionEntered={() => {
                  const activeElement = document.activeElement;
                  const userIsAlreadyInteracting =
                    activeElement instanceof HTMLInputElement ||
                    activeElement instanceof HTMLTextAreaElement ||
                    activeElement instanceof HTMLButtonElement ||
                    activeElement?.getAttribute("role") === "combobox";
                  if (!testedIdentity && !testError && !userIsAlreadyInteracting) providerNameInputRef.current?.focus();
                }}
                actions={
                  <Box sx={adminDialogEndActionRowSx}>
                    <Button
                      onClick={closeOidcDialog}
                      disabled={busy || finalizationUnresolved}
                      variant="outlined"
                      sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => (testedIdentity ? setOidcReviewOpen(true) : void startTest(effectiveCandidate))}
                      disabled={
                        busy ||
                        finalizationUnresolved ||
                        (testedIdentity
                          ? reviewPending
                          : configuration?.health.status !== "healthy" || groupConfigurationInvalid || Boolean(scopesError))
                      }
                      variant="contained"
                      sx={[settingsPrimaryButtonSx, adminDialogActionButtonSx]}
                    >
                      {testedIdentity ? "Review test" : "Connect and test"}
                    </Button>
                  </Box>
                }
              >
                <Stack spacing={2}>
                  <FormSurface testId="authentication-oidc-form-surface" sx={{ gap: 2 }}>
                    <FormGroup edge="start" testId="authentication-provider-form-group">
                      {configuration?.health.redirect_uri &&
                        renderFormRow(
                          "Redirect URI",
                          "Register this callback URL with the identity provider",
                          "redirect-uri-description",
                          "redirect-uri",
                          <TextField
                            id="redirect-uri"
                            fullWidth={!usesDesktopFormLayout}
                            size={formFieldSize}
                            label={usesDesktopFormLayout ? undefined : "Redirect URI"}
                            value={configuration.health.redirect_uri}
                            sx={providerFieldSx}
                            slotProps={{
                              input: {
                                readOnly: true,
                                endAdornment:
                                  typeof navigator.clipboard?.writeText === "function" ? (
                                    <InputAdornment position="end">
                                      <Tooltip title="Copy redirect URI">
                                        <IconButton
                                          aria-label="Copy redirect URI"
                                          edge="end"
                                          onClick={() => {
                                            void navigator.clipboard
                                              .writeText(configuration.health.redirect_uri ?? "")
                                              .then(() => setConfigurationActionNotice("Redirect URI copied."))
                                              .catch(() => setConfigurationActionError("The redirect URI could not be copied."));
                                          }}
                                        >
                                          <ContentCopy />
                                        </IconButton>
                                      </Tooltip>
                                    </InputAdornment>
                                  ) : undefined,
                              },
                              htmlInput: { "aria-describedby": usesDesktopFormLayout ? "redirect-uri-description" : undefined },
                            }}
                          />
                        )}
                      {renderFormRow(
                        "Provider name",
                        "Name shown for this provider",
                        "provider-name-description",
                        "provider-name",
                        <TextField
                          id="provider-name"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Provider name"}
                          value={candidate.display_name}
                          inputRef={providerNameInputRef}
                          onChange={(event) => update("display_name", event.target.value)}
                          disabled={finalizationUnresolved}
                          required
                          helperText={usesDesktopFormLayout ? undefined : "Name shown for this provider"}
                          sx={providerFieldSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "provider-name-description" : undefined },
                          }}
                        />,
                        true
                      )}
                      {renderFormRow(
                        "Issuer URL",
                        "OpenID Connect issuer URL from the provider",
                        "issuer-url-description",
                        "issuer-url",
                        <TextField
                          id="issuer-url"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Issuer URL"}
                          value={candidate.issuer_url}
                          onChange={(event) => update("issuer_url", event.target.value)}
                          disabled={finalizationUnresolved}
                          required
                          helperText={usesDesktopFormLayout ? undefined : "OpenID Connect issuer URL from the provider"}
                          sx={providerFieldSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "issuer-url-description" : undefined },
                          }}
                        />,
                        true
                      )}
                      {renderFormRow(
                        "Client ID",
                        "OAuth client ID registered with the provider",
                        "client-id-description",
                        "client-id",
                        <TextField
                          id="client-id"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Client ID"}
                          value={candidate.client_id}
                          onChange={(event) => update("client_id", event.target.value)}
                          disabled={finalizationUnresolved}
                          required
                          helperText={usesDesktopFormLayout ? undefined : "OAuth client ID registered with the provider"}
                          sx={providerFieldSx}
                          slotProps={{ htmlInput: { "aria-describedby": usesDesktopFormLayout ? "client-id-description" : undefined } }}
                        />,
                        true
                      )}
                      {renderFormRow(
                        "Client secret",
                        configuration?.configuration?.client_secret_configured
                          ? "Leave blank to keep the stored secret"
                          : "Required for the first test",
                        "client-secret-description",
                        "client-secret",
                        <TextField
                          id="client-secret"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Client secret"}
                          type={showClientSecret ? "text" : "password"}
                          value={clientSecret}
                          disabled={finalizationUnresolved}
                          onChange={(event) => {
                            setClientSecret(event.target.value);
                            setTestError("");
                            setTestedIdentity(null);
                          }}
                          helperText={
                            usesDesktopFormLayout
                              ? undefined
                              : configuration?.configuration?.client_secret_configured
                                ? "Leave blank to keep the stored secret"
                                : "Required for the first test"
                          }
                          sx={providerFieldSx}
                          slotProps={{
                            input: {
                              endAdornment: (
                                <SettingsPasswordVisibilityToggle
                                  visible={showClientSecret}
                                  onToggle={() => setShowClientSecret((current) => !current)}
                                  showLabel="Show client secret"
                                  hideLabel="Hide client secret"
                                />
                              ),
                            },
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "client-secret-description" : undefined },
                          }}
                        />
                      )}
                      {renderFormRow(
                        "Scopes",
                        scopesError || "Separate with commas; openid is required. Add offline_access only if your provider supports it.",
                        "scopes-description",
                        "scopes",
                        <TextField
                          id="scopes"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Scopes"}
                          value={scopesInput}
                          onChange={(event) => setScopesInput(event.target.value)}
                          onBlur={() => update("scopes", parseList(scopesInput))}
                          disabled={finalizationUnresolved}
                          error={Boolean(scopesError)}
                          helperText={
                            usesDesktopFormLayout
                              ? undefined
                              : scopesError ||
                                "Separate with commas; openid is required. Add offline_access only if your provider supports it."
                          }
                          sx={providerFieldSx}
                          slotProps={{ htmlInput: { "aria-describedby": usesDesktopFormLayout ? "scopes-description" : undefined } }}
                        />,
                        false,
                        Boolean(scopesError)
                      )}
                      {renderFormRow(
                        "Interactive sign-in interval (days)",
                        "Background renewal stops when this interval expires",
                        "interactive-sign-in-interval-description",
                        "interactive-sign-in-interval",
                        <TextField
                          id="interactive-sign-in-interval"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Interactive sign-in interval (days)"}
                          type="number"
                          value={candidate.interactive_reauthentication_max_age_days}
                          onChange={(event) => update("interactive_reauthentication_max_age_days", Number(event.target.value))}
                          disabled={finalizationUnresolved}
                          slotProps={{
                            htmlInput: {
                              min: 1,
                              max: 365,
                              "aria-describedby": usesDesktopFormLayout ? "interactive-sign-in-interval-description" : undefined,
                            },
                          }}
                          helperText={usesDesktopFormLayout ? undefined : "Background renewal stops when this interval expires"}
                          sx={providerIntervalFieldSx}
                        />
                      )}
                      {renderFormRow(
                        "Session limit without refresh token (hours)",
                        "Applies only when sign-in does not return a refresh token",
                        "no-refresh-session-limit-description",
                        "no-refresh-session-limit",
                        <TextField
                          id="no-refresh-session-limit"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Session limit without refresh token (hours)"}
                          type="number"
                          value={candidate.no_refresh_session_limit_hours}
                          onChange={(event) => update("no_refresh_session_limit_hours", Number(event.target.value))}
                          disabled={finalizationUnresolved}
                          slotProps={{
                            htmlInput: {
                              min: 1,
                              max: 24,
                              "aria-describedby": usesDesktopFormLayout ? "no-refresh-session-limit-description" : undefined,
                            },
                          }}
                          helperText={usesDesktopFormLayout ? undefined : "Applies only when sign-in does not return a refresh token"}
                          sx={providerIntervalFieldSx}
                        />
                      )}
                      {renderFormRow(
                        "Automatically link OIDC identities to local accounts by username",
                        "When an admitted identity-provider user has the same username as a local account, link the identity to that account.",
                        "auto-link-by-username-description",
                        "auto-link-by-username",
                        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1 }}>
                          {!usesDesktopFormLayout && (
                            <Typography variant="body2" sx={{ mr: "auto" }}>
                              Automatically link OIDC identities to local accounts by username
                            </Typography>
                          )}
                          <Typography component="span" variant="body2" aria-live="polite">
                            {candidate.auto_link_by_username ? "On" : "Off"}
                          </Typography>
                          <Switch
                            checked={candidate.auto_link_by_username}
                            disabled={finalizationUnresolved}
                            onChange={(event) => update("auto_link_by_username", event.target.checked)}
                            slotProps={{
                              input: {
                                id: "auto-link-by-username",
                                "aria-label": `Automatically link OIDC identities to local accounts by username: ${
                                  candidate.auto_link_by_username ? "On" : "Off"
                                }`,
                                "aria-describedby": usesDesktopFormLayout ? "auto-link-by-username-description" : undefined,
                              },
                            }}
                          />
                        </Box>
                      )}
                    </FormGroup>
                    <SettingsFormSection title="Access" />
                    <FormGroup testId="authentication-access-form-group">
                      {renderFormRow(
                        "Admission",
                        "Choose which provider users can sign in",
                        "admission-description",
                        "admission-mode",
                        <TextField
                          id="admission-mode"
                          select
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Admission"}
                          value={candidate.admission_mode}
                          onChange={(event) => update("admission_mode", event.target.value as OidcConfigurationCandidate["admission_mode"])}
                          disabled={finalizationUnresolved}
                          helperText={usesDesktopFormLayout ? undefined : "Choose which provider users can sign in"}
                          sx={[formSelectControlSx, formOutlinedControlSx, formSelectSx].flat()}
                          slotProps={{
                            select: { MenuProps: formSelectMenuProps },
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "admission-description" : undefined },
                          }}
                        >
                          <MenuItem value="all_idp_users">All authenticated users</MenuItem>
                          <MenuItem value="selected_groups">Only selected groups</MenuItem>
                        </TextField>
                      )}
                      {candidate.admission_mode === "selected_groups" &&
                        renderFormRow(
                          "Admission groups",
                          admissionGroupError || "Members of these groups can sign in; enter exact names, separated by commas",
                          "admission-groups-description",
                          "admission-groups",
                          <TextField
                            id="admission-groups"
                            fullWidth={!usesDesktopFormLayout}
                            size={formFieldSize}
                            label={usesDesktopFormLayout ? undefined : "Admission groups"}
                            value={groupDrafts.admission}
                            onChange={(event) => updateGroupDraft("admission", event.target.value)}
                            disabled={finalizationUnresolved}
                            error={Boolean(admissionGroupError)}
                            helperText={
                              usesDesktopFormLayout
                                ? undefined
                                : admissionGroupError || "Members of these groups can sign in; enter exact names, separated by commas"
                            }
                            sx={formOutlinedControlSx}
                            slotProps={{
                              htmlInput: { "aria-describedby": usesDesktopFormLayout ? "admission-groups-description" : undefined },
                            }}
                          />,
                          false,
                          Boolean(admissionGroupError)
                        )}
                    </FormGroup>
                    <SettingsFormSection title="Role assignment" />
                    <FormGroup testId="authentication-role-form-group">
                      {renderFormRow(
                        "Role assignment",
                        "Set one role for all users or map roles from provider groups",
                        "role-assignment-description",
                        "role-assignment-mode",
                        <TextField
                          id="role-assignment-mode"
                          select
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Role assignment"}
                          value={candidate.role_assignment_mode}
                          onChange={(event) =>
                            update("role_assignment_mode", event.target.value as OidcConfigurationCandidate["role_assignment_mode"])
                          }
                          disabled={finalizationUnresolved}
                          helperText={usesDesktopFormLayout ? undefined : "Set one role for all users or map roles from provider groups"}
                          sx={[formSelectControlSx, formOutlinedControlSx, formSelectSx].flat()}
                          slotProps={{
                            select: { MenuProps: formSelectMenuProps },
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "role-assignment-description" : undefined },
                          }}
                        >
                          <MenuItem value="uniform">All users are assigned to the same role</MenuItem>
                          <MenuItem value="group_based">Group-based</MenuItem>
                        </TextField>
                      )}
                      {candidate.role_assignment_mode === "uniform" ? (
                        renderFormRow(
                          "Assigned role",
                          "Role assigned to all admitted users",
                          "assigned-role-description",
                          "assigned-role",
                          <TextField
                            id="assigned-role"
                            select
                            fullWidth={!usesDesktopFormLayout}
                            size={formFieldSize}
                            label={usesDesktopFormLayout ? undefined : "Assigned role"}
                            value={candidate.uniform_role}
                            onChange={(event) => update("uniform_role", event.target.value as OidcConfigurationCandidate["uniform_role"])}
                            disabled={finalizationUnresolved}
                            helperText={usesDesktopFormLayout ? undefined : "Role assigned to all admitted users"}
                            sx={[formSelectControlSx, formOutlinedControlSx, formSelectSx].flat()}
                            slotProps={{
                              select: { MenuProps: formSelectMenuProps },
                              htmlInput: { "aria-describedby": usesDesktopFormLayout ? "assigned-role-description" : undefined },
                            }}
                          >
                            <MenuItem value="admin">Administrator</MenuItem>
                            <MenuItem value="editor">Editor</MenuItem>
                            <MenuItem value="viewer">Viewer</MenuItem>
                          </TextField>
                        )
                      ) : (
                        <>
                          {renderFormRow(
                            "Administrator groups",
                            adminGroupError || "Members get administrator access; enter exact names, separated by commas",
                            "administrator-groups-description",
                            "administrator-groups",
                            <TextField
                              id="administrator-groups"
                              fullWidth={!usesDesktopFormLayout}
                              size={formFieldSize}
                              label={usesDesktopFormLayout ? undefined : "Administrator groups"}
                              value={groupDrafts.admin}
                              onChange={(event) => updateGroupDraft("admin", event.target.value)}
                              disabled={finalizationUnresolved}
                              error={Boolean(adminGroupError)}
                              helperText={
                                usesDesktopFormLayout
                                  ? undefined
                                  : adminGroupError || "Members get administrator access; enter exact names, separated by commas"
                              }
                              sx={formOutlinedControlSx}
                              slotProps={{
                                htmlInput: {
                                  "aria-describedby": usesDesktopFormLayout ? "administrator-groups-description" : undefined,
                                },
                              }}
                            />,
                            false,
                            Boolean(adminGroupError)
                          )}
                          {renderFormRow(
                            "Editor groups",
                            editorGroupError || "Members can edit content; enter exact names, separated by commas",
                            "editor-groups-description",
                            "editor-groups",
                            <TextField
                              id="editor-groups"
                              fullWidth={!usesDesktopFormLayout}
                              size={formFieldSize}
                              label={usesDesktopFormLayout ? undefined : "Editor groups"}
                              value={groupDrafts.editor}
                              onChange={(event) => updateGroupDraft("editor", event.target.value)}
                              disabled={finalizationUnresolved}
                              error={Boolean(editorGroupError)}
                              helperText={
                                usesDesktopFormLayout
                                  ? undefined
                                  : editorGroupError || "Members can edit content; enter exact names, separated by commas"
                              }
                              sx={formOutlinedControlSx}
                              slotProps={{
                                htmlInput: { "aria-describedby": usesDesktopFormLayout ? "editor-groups-description" : undefined },
                              }}
                            />,
                            false,
                            Boolean(editorGroupError)
                          )}
                          {renderFormRow(
                            "Viewer groups",
                            viewerGroupError || "Members get viewer access; enter exact names, separated by commas",
                            "viewer-groups-description",
                            "viewer-groups",
                            <TextField
                              id="viewer-groups"
                              fullWidth={!usesDesktopFormLayout}
                              size={formFieldSize}
                              label={usesDesktopFormLayout ? undefined : "Viewer groups"}
                              value={groupDrafts.viewer}
                              onChange={(event) => updateGroupDraft("viewer", event.target.value)}
                              disabled={finalizationUnresolved}
                              error={Boolean(viewerGroupError)}
                              helperText={
                                usesDesktopFormLayout
                                  ? undefined
                                  : viewerGroupError || "Members get viewer access; enter exact names, separated by commas"
                              }
                              sx={formOutlinedControlSx}
                              slotProps={{
                                htmlInput: { "aria-describedby": usesDesktopFormLayout ? "viewer-groups-description" : undefined },
                              }}
                            />,
                            false,
                            Boolean(viewerGroupError)
                          )}
                        </>
                      )}
                    </FormGroup>
                    <Alert severity="info">
                      The administrator connecting this provider keeps an individual Administrator assignment. Individual assignments always
                      override this configured role policy.
                    </Alert>
                    <SettingsFormSection title="Advanced claims" />
                    <Typography sx={{ color: "text.secondary" }}>The default claim names work with most providers</Typography>
                    <FormGroup edge="end" testId="authentication-claims-form-group">
                      {renderFormRow(
                        "Username claim",
                        "Claim used for the Sambee username",
                        "username-claim-description",
                        "username-claim",
                        <TextField
                          id="username-claim"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Username claim"}
                          value={candidate.username_claim}
                          onChange={(event) => update("username_claim", event.target.value)}
                          disabled={finalizationUnresolved}
                          required
                          helperText={usesDesktopFormLayout ? undefined : "Claim used for the Sambee username"}
                          sx={formOutlinedControlSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "username-claim-description" : undefined },
                          }}
                        />,
                        true
                      )}
                      {renderFormRow(
                        "Name claim",
                        "Optional claim for the user's display name",
                        "name-claim-description",
                        "name-claim",
                        <TextField
                          id="name-claim"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Name claim"}
                          value={candidate.name_claim ?? ""}
                          onChange={(event) => update("name_claim", optionalClaim(event.target.value))}
                          disabled={finalizationUnresolved}
                          helperText={usesDesktopFormLayout ? undefined : "Optional claim for the user's display name"}
                          sx={formOutlinedControlSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "name-claim-description" : undefined },
                          }}
                        />
                      )}
                      {renderFormRow(
                        "Email claim",
                        "Optional claim for the user's email address",
                        "email-claim-description",
                        "email-claim",
                        <TextField
                          id="email-claim"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Email claim"}
                          value={candidate.email_claim ?? ""}
                          onChange={(event) => update("email_claim", optionalClaim(event.target.value))}
                          disabled={finalizationUnresolved}
                          helperText={usesDesktopFormLayout ? undefined : "Optional claim for the user's email address"}
                          sx={formOutlinedControlSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "email-claim-description" : undefined },
                          }}
                        />
                      )}
                      {renderFormRow(
                        "Groups claim",
                        "Required for group-based admission or roles",
                        "groups-claim-description",
                        "groups-claim",
                        <TextField
                          id="groups-claim"
                          fullWidth={!usesDesktopFormLayout}
                          size={formFieldSize}
                          label={usesDesktopFormLayout ? undefined : "Groups claim"}
                          value={candidate.groups_claim ?? ""}
                          onChange={(event) => update("groups_claim", optionalClaim(event.target.value))}
                          disabled={finalizationUnresolved}
                          helperText={usesDesktopFormLayout ? undefined : "Required for group-based admission or roles"}
                          sx={formOutlinedControlSx}
                          slotProps={{
                            htmlInput: { "aria-describedby": usesDesktopFormLayout ? "groups-claim-description" : undefined },
                          }}
                        />
                      )}
                    </FormGroup>
                  </FormSurface>
                </Stack>
              </ResponsiveDialogShell>

              {testedIdentity && (
                <ResponsiveDialogShell
                  open={oidcReviewOpen}
                  onClose={returnToOidcConfiguration}
                  disableClose={busy || finalizationUnresolved}
                  title="Review OIDC connection"
                  description="Review the tested identity and account impact before activating this configuration."
                  maxWidth="md"
                  contextualNotice={
                    reviewContextualError || !testedIdentityCanActivate || omittedPasswordlessMappings.length > 0 ? (
                      <Stack spacing={1}>
                        <DialogNotice message={reviewContextualError} testId="oidc-review-contextual-error" />
                        <DialogNotice
                          message={
                            !testedIdentityCanActivate
                              ? "The tested identity must pass the admission rule before this configuration can be activated."
                              : null
                          }
                          testId="oidc-review-admission-error"
                        />
                        <DialogNotice
                          message={
                            omittedPasswordlessMappings.length > 0 ? (
                              <>
                                {omittedPasswordlessMappings.length} active passwordless account
                                {omittedPasswordlessMappings.length === 1 ? " is" : "s are"} omitted. These users cannot sign in until
                                mapped. An unmapped OIDC login may collide with an existing username or create a separate account.
                              </>
                            ) : null
                          }
                          severity="warning"
                          testId="oidc-review-omitted-accounts-warning"
                        />
                      </Stack>
                    ) : null
                  }
                  actionNotice={<DialogNotice message={reviewActionError} testId="oidc-review-action-error" />}
                  actions={
                    <Box sx={adminDialogEndActionRowSx}>
                      <Button
                        onClick={returnToOidcConfiguration}
                        disabled={busy || finalizationUnresolved}
                        variant="outlined"
                        sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}
                      >
                        Back
                      </Button>
                      <Button
                        onClick={() => void cancelTestFlow()}
                        disabled={busy || finalizationUnresolved}
                        variant="outlined"
                        sx={[settingsUtilityButtonSx, adminDialogActionButtonSx]}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => void activate()}
                        disabled={busy || finalizationUnresolved || reviewPending || replacementPlanInvalid || !testedIdentityCanActivate}
                        variant="contained"
                        sx={[settingsPrimaryButtonSx, adminDialogActionButtonSx]}
                      >
                        Activate configuration
                      </Button>
                    </Box>
                  }
                >
                  <Stack spacing={2}>
                    <FormSurface sx={{ gap: 2 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: "medium" }}>
                        Test results
                      </Typography>
                      <Box sx={{ borderLeft: 3, borderColor: "success.main", pl: 2, py: 1 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: "medium" }}>
                          Tested identity
                        </Typography>
                        <Typography>Username: {testedIdentity.username}</Typography>
                        {testedIdentity.email && <Typography>Email: {testedIdentity.email}</Typography>}
                        <Typography>Groups: {testedIdentity.groups.join(", ") || "None"}</Typography>
                        <Typography>Admission: {testedIdentity.admitted ? "Allowed" : "Denied"}</Typography>
                        <Typography>
                          Session renewal:{" "}
                          {testedIdentity.refresh_token_returned
                            ? "Refresh token returned in this test"
                            : "No refresh token returned in this test; users will need to sign in again after the configured session limit."}
                        </Typography>
                        {testedIdentity.matching_admission_group && (
                          <Typography>Matching admission group: {testedIdentity.matching_admission_group}</Typography>
                        )}
                        <Typography sx={{ color: "text.secondary" }}>Account mapping does not override the admission policy.</Typography>
                        {testedIdentity.replacement_mappings.length > 0 && (
                          <Stack spacing={2} sx={{ mt: 2 }}>
                            <Typography variant="subtitle1">Review existing accounts</Typography>
                            {testedIdentity.replacement_mappings
                              .filter((mapping) => mapping.selectable)
                              .map((mapping) => {
                                const review = mappingReview[mapping.target_user_id];
                                const serverError = mappingErrors[mapping.target_user_id];
                                const expectedUsername = review?.expectedUsername ?? "";
                                const hintLabel =
                                  mapping.prefill_source === "pending"
                                    ? "Previous pending"
                                    : mapping.prefill_source === "last_seen"
                                      ? "Last seen"
                                      : "Unverified";
                                return (
                                  <Box key={mapping.target_user_id} sx={{ borderBottom: 1, borderColor: "divider", pb: 2 }}>
                                    <FormControlLabel
                                      control={
                                        <Checkbox
                                          checked={review?.selected ?? false}
                                          disabled={finalizationUnresolved}
                                          onChange={(event) => {
                                            if (!event.target.checked) {
                                              setMappingErrors((current) => {
                                                const next = { ...current };
                                                delete next[mapping.target_user_id];
                                                return next;
                                              });
                                            }
                                            setMappingReview((current) => ({
                                              ...current,
                                              [mapping.target_user_id]: {
                                                ...(current[mapping.target_user_id] ?? {
                                                  selected: false,
                                                  expectedUsername: "",
                                                  omissionAcknowledged: false,
                                                }),
                                                selected: event.target.checked,
                                                expectedUsername:
                                                  event.target.checked && !current[mapping.target_user_id]?.expectedUsername
                                                    ? mapping.suggested_username
                                                    : (current[mapping.target_user_id]?.expectedUsername ?? ""),
                                                omissionAcknowledged: false,
                                              },
                                            }));
                                          }}
                                        />
                                      }
                                      label={`Map ${mapping.local_username}`}
                                    />
                                    <TextField
                                      fullWidth
                                      label={`Provider username for ${mapping.local_username}`}
                                      value={expectedUsername}
                                      placeholder={mapping.suggested_username}
                                      helperText={serverError ?? `${hintLabel}: ${mapping.suggested_username}`}
                                      disabled={finalizationUnresolved || !review?.selected}
                                      error={
                                        Boolean(serverError) ||
                                        (Boolean(review?.selected) &&
                                          (!expectedUsername.trim() ||
                                            expectedUsername.trim() === testedIdentity.username.trim() ||
                                            replacementUsernames.filter((value) => value === expectedUsername.trim()).length > 1))
                                      }
                                      onChange={(event) => {
                                        setMappingErrors((current) => {
                                          const next = { ...current };
                                          delete next[mapping.target_user_id];
                                          return next;
                                        });
                                        setMappingReview((current) => ({
                                          ...current,
                                          [mapping.target_user_id]: {
                                            ...(current[mapping.target_user_id] ?? {
                                              selected: false,
                                              expectedUsername: "",
                                              omissionAcknowledged: false,
                                            }),
                                            expectedUsername: event.target.value,
                                          },
                                        }));
                                      }}
                                      required={review?.selected}
                                    />
                                    {mapping.omission_acknowledgement_required && !review?.selected && (
                                      <FormControlLabel
                                        control={
                                          <Checkbox
                                            checked={review?.omissionAcknowledged ?? false}
                                            disabled={finalizationUnresolved}
                                            onChange={(event) =>
                                              setMappingReview((current) => ({
                                                ...current,
                                                [mapping.target_user_id]: {
                                                  ...(current[mapping.target_user_id] ?? {
                                                    selected: false,
                                                    expectedUsername: "",
                                                    omissionAcknowledged: false,
                                                  }),
                                                  omissionAcknowledged: event.target.checked,
                                                },
                                              }))
                                            }
                                          />
                                        }
                                        label={`I understand ${mapping.local_username} cannot use a local password in OIDC only mode`}
                                      />
                                    )}
                                  </Box>
                                );
                              })}
                            {testedIdentity.replacement_mappings.some((mapping) => !mapping.selectable) && (
                              <Box>
                                <Typography variant="subtitle2">Inactive or expired accounts</Typography>
                                {testedIdentity.replacement_mappings
                                  .filter((mapping) => !mapping.selectable)
                                  .map((mapping) => (
                                    <Typography key={mapping.target_user_id} sx={{ color: "text.secondary" }}>
                                      {mapping.local_username} ({mapping.target_state}) must be reactivated before mapping.
                                    </Typography>
                                  ))}
                              </Box>
                            )}
                          </Stack>
                        )}
                      </Box>
                    </FormSurface>
                  </Stack>
                </ResponsiveDialogShell>
              )}
            </Stack>
          </>
        )}
      </Box>
    </SettingsPage>
  );
}
