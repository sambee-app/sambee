type TranslationTree = {
  [key: string]: string | TranslationTree;
};

export const EN_TRANSLATIONS = {
  app: {
    title: "Sambee Companion",
    idleMessage: "Running in system tray. No active edit operations.",
  },
  common: {
    actions: {
      cancel: "Cancel",
      close: "Close",
      open: "Open",
    },
  },
  pairing: {
    idleMessage: "Waiting for a pairing request.",
    eyebrow: "Approve Browser Origin",
    title: "Confirm this browser origin",
    closeTitle: "Close",
    body: "Sambee in the browser wants this origin to access local drives through this companion.",
    labels: {
      requestingOrigin: "Requesting origin",
      verificationCode: "Verification code",
    },
    hint: "Approve only if the same code is visible in the Sambee pairing dialog.",
    actions: {
      reject: "Reject",
      codesMatch: "Codes Match",
      close: "Close now",
    },
    approved: {
      title: "Approval sent",
      body: "The codes matched for {{origin}}.",
      hint: "Waiting for Sambee to finish storing trust for this origin.",
    },
    success: {
      title: "Origin approved",
      body: "This browser origin is now trusted by Sambee Companion and can access local drives.",
      hint: "This window will close automatically in a moment.",
    },
  },
  doneEditing: {
    waitingForContext: "Waiting for edit context…",
    openedIn: "Opened in: {{appName}}",
    statusLabel: "Status:",
    modifiedAt: "Modified at {{time}}",
    unchanged: "Unchanged",
    parseConflictError: "Failed to parse conflict info",
    authRefreshedRetryUpload: "Authentication was refreshed. Hold Done Editing again to retry the upload.",
    lifecycle: {
      renewalRequired: "This edit session expired before Companion could renew it. Reopen the file from Sambee, then try saving again.",
      authFailed: "Companion could not prove this edit session is still authorized. Reopen the file from Sambee to start a fresh session.",
      lockLost: "This edit lock is no longer active on the server. Reopen the file from Sambee before trying to upload again.",
      recoveryRequired: "This edit session expired and cannot be resumed. Reopen the file from Sambee to start a new recovery flow.",
    },
    buttons: {
      doneUpload: "✓ Done Editing — Hold to Upload",
      retryUpload: "✓ Done Editing — Hold to Retry Upload",
      reopenRequired: "Session Expired — Reopen from Sambee",
      authFailed: "Authentication Failed — Reopen from Sambee",
      lockLost: "Lock Lost — Reopen from Sambee",
      recoveryRequired: "Recovery Required — Reopen from Sambee",
      doneClose: "✓ Done Editing — Hold to Close",
      uploading: "✓ Uploading…",
      closing: "✓ Closing…",
      discardHold: "Discard Changes — Hold",
    },
    aria: {
      confirmUpload: "Hold for {{seconds}} seconds to confirm upload",
      retryUpload: "Hold for {{seconds}} seconds to retry the upload after reauthentication",
      confirmClose: "Hold for {{seconds}} seconds to close and release lock",
      discardChanges: "Hold for {{seconds}} seconds to discard changes",
      actionUnavailable: "This action is unavailable until the file is reopened from Sambee",
      reopenInBrowser: "Open Sambee in your browser to start a new edit session",
      uploadProgress: "Upload progress",
    },
  },
  conflictDialog: {
    title: "⚠ Conflict Detected",
    body: "This file was modified on the server by another user while you were editing it.",
    labels: {
      yourDownload: "Your download:",
      serverVersion: "Server version:",
    },
    actions: {
      overwrite: "Overwrite Server Version",
      saveCopy: "Save as Copy",
      cancel: "Cancel",
    },
    authRefreshedRetry: "Authentication was refreshed. Choose Overwrite or Save as Copy again to retry the upload.",
    lifecycle: {
      renewalRequired:
        "This edit session expired before the upload could be authorized. Close this dialog and reopen the file from Sambee.",
      authFailed: "Companion could not prove this edit session is still authorized. Close this dialog and reopen the file from Sambee.",
      lockLost: "The server lock for this edit session is no longer active. Close this dialog and reopen the file from Sambee.",
      recoveryRequired: "This edit session expired and cannot be resumed. Close this dialog and reopen the file from Sambee.",
    },
  },
  largeFileWarning: {
    title: "⚠ Large File",
    body: "This file is {{sizeMb}} MB (limit: {{limitMb}} MB). Downloading and syncing large files may be slow and use significant disk space.",
    actions: {
      continue: "Continue Anyway",
      cancel: "Cancel",
    },
  },
  recovery: {
    title: "Unsaved Files Found",
    subtitle_one: "{{count}} file from a previous session needs attention.",
    subtitle_other: "{{count}} files from a previous session need attention.",
    detail: "{{remotePath}} — modified {{localModified}}",
    authRefreshedRetryUpload: "Authentication was refreshed. Click Upload again to retry sending this file to the server.",
    lifecycle: {
      renewalRequired: "This recovered edit session expired before it could upload. Reopen the file from Sambee or discard this temp copy.",
      authFailed:
        "Companion could not prove this recovered edit session is still authorized. Reopen the file from Sambee or discard this temp copy.",
      lockLost: "The server lock for this recovered edit session is gone. Reopen the file from Sambee or discard this temp copy.",
      recoveryRequired: "This recovered edit session expired and cannot be resumed. Reopen the file from Sambee or discard this temp copy.",
    },
    actions: {
      upload: "Upload",
      retryUpload: "Retry Upload",
      discard: "Discard",
      later: "Later",
      dismissAll: "Dismiss All",
    },
  },
  appPicker: {
    title: "Choose an app to open this .{{extension}} file",
    loading: "Loading available applications…",
    browseDialogTitle: "Browse for application",
    empty: "No registered applications found for .{{extension}} files.",
    sectionDefault: "Default",
    sectionSuggested: "Suggested apps",
    sectionMoreOptions: "More options",
    defaultBadge: "(default)",
    alwaysUse: "Always use this app for .{{extension}} files",
    browseButton: "Browse for another app…",
    chooseAnotherApp: "Choose another app",
    iconAlt: "{{appName}} icon",
  },
  preferences: {
    loading: "Loading preferences…",
    title: "Preferences",
    closeTitle: "Close",
    sections: {
      pairedBrowsers: "Trusted Browser Origins",
      localization: "Localization",
      editingBehavior: "Editing Behavior",
      startup: "Startup",
      updates: "Updates",
      notifications: "Notifications",
      tempFileCleanup: "Temp File Cleanup",
    },
    pairedBrowsersHint:
      "These trusted browser origins can access local drives through this companion. Removing one forces that origin to request approval again.",
    pairedBrowsersEmpty: "No browser origins are currently trusted by this companion.",
    directoryPolicy: {
      title: "Directory-Index Policy",
      loading: "Directory policy status is loading.",
      unavailable: "Directory policy is unavailable. Wait briefly and refresh its status, or restart the companion.",
      resetFailed: "Policy owner could not be reset. Check private configuration storage and retry.",
      active: "Approved backend policy is active.",
      defaults: "Local default policy is active. No backend owner is approved.",
      owner: "Approved Owner",
      revision: "Effective Revision",
      refresh: "Refresh Policy Status",
      reset: "Reset Policy Owner",
      resetTitle: "Reset Directory-Index Policy Owner?",
      resetBody:
        "Remove the approved backend owner and restore local policy defaults? Existing directory indexes are retained. Another backend will need local approval.",
      resetting: "Resetting Policy Owner",
      confirmReset: "Reset Owner",
    },
    localizationStatusHint: "Shows the last localization synchronized from a trusted Sambee browser origin.",
    localizationStatus: {
      syncedBadge: "Synced from browser",
      languageLabel: "Language",
      regionalLocaleLabel: "Regional locale",
      updatedAtLabel: "Last updated",
      sourceOriginLabel: "Source origin",
      empty: "No browser localization has been synchronized yet.",
    },
    unpairTitle: "Remove trusted origin",
    unpairButton: "Remove",
    conflictResolutionLabel: "Upload conflict resolution",
    conflictResolutionHint: "What to do when the file on the server changed while you were editing.",
    conflictActions: {
      ask: "Ask me every time",
      overwrite: "Always overwrite server copy",
      saveCopy: "Always save as new copy",
    },
    startupLabel: "Start Sambee Companion when I sign in",
    startupHint: "Recommended for Local Drives. Browser access to local drives only works while the companion is running.",
    updateChannelLabel: "Update channel",
    updateChannelHint: "Controls which promoted feed this companion uses for automatic updates.",
    updateChannels: {
      stable: "Stable",
      beta: "Beta",
      test: "Test",
    },
    preReleaseWarning: "{{channel}} builds may contain unfinished features or regressions.",
    confirmUpdateChannel: {
      title: "Switch update channel?",
      body: "Switching from Stable to {{channel}} may install preview builds that are less tested.",
      confirm: "Switch channel",
    },
    updateActions: {
      checkNow: "Check for updates",
      checking: "Checking…",
      install: "Install update",
      installing: "Installing…",
    },
    updateStatus: {
      statusLabel: "Update status",
      lastChecked: "Last checked: {{time}}",
      currentVersionLabel: "Current version",
      latestVersionLabel: "Available version",
      publishedAtLabel: "Published",
      errorLabel: "Details",
      upToDate: "You are up to date on the {{channel}} channel.",
      updateAvailable: "Update {{version}} is available on the {{channel}} channel.",
      installing: "Installing update {{version}} from the {{channel}} channel.",
      installed: "Update {{version}} has been installed. Restart the app if it does not relaunch automatically.",
      checkFailed: "Could not check for updates on the {{channel}} channel.",
      unknownVersion: "Unknown",
      unknownError: "Unknown error",
    },
    notificationsLabel: "Show desktop notifications",
    notificationsHint: "Display system notifications for edit events such as upload success or failure.",
    retentionLabel: "Keep temp files for (days)",
    retentionHint: "Recycled temp files older than this are automatically deleted on startup (1–90).",
    savedIndicator: "Saved ✓",
    confirmUnpair: {
      title: "Remove trusted origin?",
      body: "{{origin}} will lose access to local drives until it requests approval from this companion again.",
      unpairing: "Removing…",
    },
  },
} satisfies TranslationTree;

const PSEUDO_MAP: Record<string, string> = {
  A: "Å",
  B: "Ɓ",
  C: "Ć",
  D: "Ď",
  E: "É",
  F: "Ƒ",
  G: "Ğ",
  H: "Ħ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ĺ",
  M: "Ḿ",
  N: "Ń",
  O: "Ó",
  P: "Ṕ",
  Q: "Q",
  R: "Ŕ",
  S: "Š",
  T: "Ť",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẍ",
  Y: "Ý",
  Z: "Ž",
  a: "å",
  b: "ƀ",
  c: "ć",
  d: "ď",
  e: "é",
  f: "ƒ",
  g: "ğ",
  h: "ħ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ĺ",
  m: "ḿ",
  n: "ń",
  o: "ó",
  p: "ṕ",
  q: "q",
  r: "ŕ",
  s: "š",
  t: "ť",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẍ",
  y: "ý",
  z: "ž",
};

function createPseudoLocaleTranslations(tree: TranslationTree): TranslationTree {
  return Object.fromEntries(
    Object.entries(tree).map(([key, value]) => {
      if (typeof value !== "string") {
        return [key, createPseudoLocaleTranslations(value)];
      }

      return [key, pseudoLocalize(value)];
    })
  );
}

function pseudoLocalize(input: string): string {
  const placeholders: string[] = [];
  const maskedInterpolation = input.replace(/{{\s*[^}]+\s*}}/g, (match) => {
    const index = placeholders.push(match) - 1;
    return `⟪${index}⟫`;
  });
  const transformed = maskedInterpolation.replace(/[A-Za-z]/g, (character) => PSEUDO_MAP[character] ?? character);

  return `[${transformed}]`.replace(/⟪(\d+)⟫/g, (_match, index) => placeholders[Number(index)] ?? "");
}

const PSEUDO_TRANSLATIONS = createPseudoLocaleTranslations(EN_TRANSLATIONS);

export type CompanionTranslations = typeof EN_TRANSLATIONS;

export const DEFAULT_LANGUAGE = "en";

export const resources = {
  en: {
    translation: EN_TRANSLATIONS,
  },
  "en-XA": {
    translation: PSEUDO_TRANSLATIONS,
  },
} as const;

export type SupportedLanguage = keyof typeof resources;

export const SUPPORTED_LANGUAGES = Object.keys(resources) as SupportedLanguage[];
