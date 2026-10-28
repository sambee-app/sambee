import { Close, NavigateNext, Refresh } from "@mui/icons-material";
import { Alert, Box, IconButton, Snackbar, Tooltip } from "@mui/material";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DialogIdentifierDisplay } from "./FileBrowser/DialogIdentifierDisplay";

const NOTICE_PRIORITY = { error: 0, warning: 1, info: 2 } as const;
const BROWSER_NOTICE_CONTROL_CLEARANCE_PX = 80;
export const NOTICE_DURATION_MS = { information: 6_000, failure: 10_000, editor: 15_000 } as const;
export const BROWSER_NOTICE_DURATION_MS = NOTICE_DURATION_MS.failure;

export function formatNoticeTarget(connectionName: string | undefined, path: string): string {
  const fullPath = path.startsWith("/") ? path : `/${path}`;
  return connectionName ? `${connectionName}: ${fullPath}` : fullPath;
}

export interface OperationNotice {
  id: string;
  message: string;
  severity: keyof typeof NOTICE_PRIORITY;
  occurrence?: number;
  duration?: number;
  persistent?: boolean;
  content?: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
  onExpire?: () => void;
  failureKey?: string;
  targetLabel?: string;
}

type NoticeSource = { notices: readonly OperationNotice[]; onDismiss?: () => void };

function createNoticeStore() {
  const sources = new Map<string, NoticeSource>();
  const listeners = new Set<() => void>();
  let snapshot: readonly OperationNotice[] = [];
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    update(id: string, source?: NoticeSource) {
      if (source) sources.set(id, source);
      else sources.delete(id);
      const failures = new Set<string>();
      snapshot = [...sources.entries()].flatMap(([owner, value]) =>
        value.notices.flatMap((notice) => {
          if (notice.failureKey && failures.has(notice.failureKey)) return [];
          if (notice.failureKey) failures.add(notice.failureKey);
          return [{ ...notice, id: `${owner}:${notice.id}` }];
        })
      );
      for (const listener of listeners) listener();
    },
    dismiss(notice: OperationNotice) {
      for (const [owner, source] of sources) {
        if (source.notices.some((candidate) => `${owner}:${candidate.id}` === notice.id)) source.onDismiss?.();
      }
    },
  };
}

const NoticeStoreContext = createContext<ReturnType<typeof createNoticeStore> | null>(null);

export function OperationNotificationProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createNoticeStore);
  return (
    <NoticeStoreContext.Provider value={store}>
      {children}
      <SharedNotificationHost />
    </NoticeStoreContext.Provider>
  );
}

function SharedNotificationHost() {
  const store = useContext(NoticeStoreContext);
  if (!store) throw new Error("OperationNotificationProvider is required");
  const notices = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [container, setContainer] = useState<HTMLElement>(document.body);
  useEffect(() => {
    const updateContainer = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].filter(
        (dialog) => !dialog.closest('[aria-hidden="true"]')
      );
      setContainer(dialogs.at(-1) ?? document.body);
    };
    updateContainer();
    const observer = new MutationObserver(updateContainer);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden"] });
    return () => observer.disconnect();
  }, []);
  return <NotificationPresentation notices={notices} onDismiss={store.dismiss} container={container} />;
}

function noticeKey(notice: OperationNotice): string {
  return JSON.stringify([notice.failureKey ?? notice.id, notice.message, notice.occurrence ?? 0]);
}

export function OperationNotifications({
  notices,
  toolbarBackground,
  toolbarText,
  suppressed = false,
  onDismiss,
}: {
  notices: readonly OperationNotice[];
  toolbarBackground?: string;
  toolbarText?: string;
  suppressed?: boolean;
  onDismiss?: () => void;
}) {
  const store = useContext(NoticeStoreContext);
  const sourceId = useId();
  useEffect(() => {
    if (!store) return;
    store.update(sourceId, { notices: suppressed ? [] : notices, onDismiss });
  }, [store, sourceId, notices, suppressed, onDismiss]);
  useEffect(() => () => store?.update(sourceId), [store, sourceId]);
  if (store) return null;
  return (
    <NotificationPresentation
      notices={notices}
      toolbarBackground={toolbarBackground}
      toolbarText={toolbarText}
      suppressed={suppressed}
      onDismiss={onDismiss}
    />
  );
}

function NotificationPresentation({
  notices,
  toolbarBackground,
  toolbarText,
  suppressed = false,
  onDismiss,
  container,
}: {
  notices: readonly OperationNotice[];
  toolbarBackground?: string;
  toolbarText?: string;
  suppressed?: boolean;
  onDismiss?: (notice: OperationNotice) => void;
  container?: HTMLElement;
}) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(new Set());
  const returnFocus = useRef<HTMLElement | null>(null);
  const activeKeys = JSON.stringify(notices.map(noticeKey));
  useEffect(() => {
    const active = new Set<string>(JSON.parse(activeKeys));
    setDismissed((previous) => {
      const next = new Set([...previous].filter((key) => active.has(key)));
      return next.size === previous.size ? previous : next;
    });
    setDeferred((previous) => {
      const next = new Set([...previous].filter((key) => active.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [activeKeys]);
  const pending = notices
    .filter((candidate) => !dismissed.has(noticeKey(candidate)))
    .sort(
      (left, right) =>
        Number(deferred.has(noticeKey(left))) - Number(deferred.has(noticeKey(right))) ||
        NOTICE_PRIORITY[left.severity] - NOTICE_PRIORITY[right.severity]
    );
  const notice = pending[0];
  if (!notice || suppressed) return null;
  const key = noticeKey(notice);
  const hide = (notifyOwner: boolean) => {
    const focusedNotice = document.activeElement?.closest(".MuiSnackbar-root");
    setDismissed((previous) => new Set([...previous, key]));
    if (notifyOwner) {
      notice.onDismiss?.();
      onDismiss?.(notice);
    } else notice.onExpire?.();
    if (focusedNotice)
      window.requestAnimationFrame(() => {
        const scope = container ?? document.body;
        const nextAction = scope.querySelector<HTMLElement>(".MuiSnackbar-root button");
        const previous = returnFocus.current;
        if (nextAction) nextAction.focus();
        else if (
          previous?.isConnected &&
          !previous.closest('[aria-hidden="true"], [inert]') &&
          (scope === document.body || scope.contains(previous))
        )
          previous.focus();
        else if (scope !== document.body) scope.querySelector<HTMLElement>('button, [href], input, [tabindex="0"]')?.focus();
      });
  };
  const dismiss = () => hide(true);
  const presentation = (
    <Snackbar
      key={JSON.stringify([notice.id, notice.occurrence ?? 0])}
      open
      autoHideDuration={
        notice.persistent
          ? null
          : (notice.duration ?? (notice.severity === "info" ? NOTICE_DURATION_MS.information : NOTICE_DURATION_MS.failure))
      }
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") hide(reason !== "timeout");
      }}
      sx={{
        bottom: {
          xs: `calc(${BROWSER_NOTICE_CONTROL_CLEARANCE_PX}px + env(safe-area-inset-bottom))`,
          sm: `calc(${BROWSER_NOTICE_CONTROL_CLEARANCE_PX}px + env(safe-area-inset-bottom))`,
        },
        left: { xs: 16, sm: "50%" },
        right: { xs: 16, sm: "auto" },
        maxWidth: "calc(100% - 32px)",
        pointerEvents: "auto",
        zIndex: (theme) => theme.zIndex.modal + 1,
      }}
    >
      <Alert
        onFocusCapture={(event) => {
          if (event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget))
            returnFocus.current = event.relatedTarget;
        }}
        severity={notice.severity}
        role={notice.severity === "error" ? "alert" : "status"}
        onClose={dismiss}
        action={
          <>
            {pending.length > 1 && (
              <Tooltip title={t("common.actions.nextNotice", { defaultValue: "Next notification" })}>
                <IconButton
                  color="inherit"
                  aria-label={`${t("common.actions.nextNotice", { defaultValue: "Next notification" })} (${pending.length - 1})`}
                  onClick={() => {
                    setDeferred((previous) => {
                      const next = new Set([...previous].filter((candidate) => pending.some((entry) => noticeKey(entry) === candidate)));
                      next.add(key);
                      if (pending.every((entry) => next.has(noticeKey(entry)))) return new Set([key]);
                      return next;
                    });
                  }}
                >
                  <NavigateNext />
                </IconButton>
              </Tooltip>
            )}
            {notice.action}
            {notice.onRetry ? (
              <Tooltip title={t("common.actions.retry")}>
                <IconButton color="inherit" aria-label={t("common.actions.retry")} onClick={notice.onRetry}>
                  <Refresh fontSize="small" />
                </IconButton>
              </Tooltip>
            ) : null}
            <Tooltip title={t("common.actions.close")}>
              <IconButton color="inherit" aria-label={t("common.actions.close")} onClick={dismiss}>
                <Close fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        }
        sx={{
          width: "100%",
          maxHeight: "50dvh",
          overflowY: "auto",
          overflowWrap: "anywhere",
          flexWrap: { xs: "wrap", sm: "nowrap" },
          "& .MuiAlert-action": {
            flexWrap: "wrap",
            alignItems: "center",
            flexBasis: { xs: "100%", sm: "auto" },
            justifyContent: "flex-end",
            marginLeft: { xs: 0, sm: "auto" },
          },
          "& .MuiIconButton-root": { minWidth: 44, minHeight: 44 },
          "& .MuiAlert-message": { minWidth: 0, flex: "1 1 0" },
          "&&":
            notice.severity === "info"
              ? { backgroundColor: toolbarBackground, color: toolbarText, "& .MuiAlert-icon": { color: "inherit" } }
              : {},
        }}
      >
        {notice.content ?? notice.message}
        {notice.targetLabel ? (
          <Box sx={{ mt: 0.5, typography: "caption", fontWeight: "regular" }}>
            <DialogIdentifierDisplay value={notice.targetLabel} kind="path" appearance="text" />
          </Box>
        ) : null}
      </Alert>
    </Snackbar>
  );
  return container ? createPortal(presentation, container) : presentation;
}

export function useOperationError() {
  const [failure, setFailure] = useState<{ message: string | null; occurrence: number }>({ message: null, occurrence: 0 });
  const setError: Dispatch<SetStateAction<string | null>> = useCallback((update) => {
    setFailure((previous) => {
      const message = typeof update === "function" ? update(previous.message) : update;
      return { message, occurrence: previous.occurrence + (message === null ? 0 : 1) };
    });
  }, []);
  return [failure.message, setError, failure.occurrence] as const;
}
