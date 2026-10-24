import { Close, FindReplace, KeyboardArrowDown, KeyboardArrowUp, PlaylistAddCheck } from "@mui/icons-material";
import { Box, Button, IconButton, InputAdornment, Portal, TextField, Tooltip, Typography, useTheme } from "@mui/material";
import { type MutableRefObject, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CODEMIRROR_EDITOR_SHORTCUTS, COMMON_SHORTCUTS } from "../../config/keyboardShortcuts";
import { withShortcut } from "../../hooks/useKeyboardShortcuts";
import { SCROLLBAR, TOOLBAR_HEIGHT } from "../../theme/constants";
import { getOverlaySurfaceTokens } from "../../theme/palette";
import {
  CODEMIRROR_FIND_HISTORY_STORAGE_KEY,
  CODEMIRROR_FIND_REPLACE_REPLACE_INPUT_ATTRIBUTE,
  CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY,
} from "./codeMirrorFindReplaceConstants";
import {
  addCodeMirrorFindReplaceHistoryEntry,
  readCodeMirrorFindReplaceHistory,
  writeCodeMirrorFindReplaceHistory,
} from "./codeMirrorFindReplaceHistory";

const FOCUSABLE_ELEMENT_SELECTOR = 'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface CodeMirrorFindReplacePopoverProps {
  caseSensitive: boolean;
  currentMatch: number;
  disabled?: boolean;
  focusTarget: "find" | "replace" | null;
  isReplaceMode: boolean;
  isSearchValid: boolean;
  onCaseSensitiveChange: (enabled: boolean) => void;
  onClose: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onFocusHandled: () => void;
  onRegexChange: (enabled: boolean) => void;
  onReplaceAll: () => void;
  onReplaceChange: (value: string) => void;
  onReplaceCurrent: () => void;
  onSearchChange: (value: string) => void;
  onWholeWordChange: (enabled: boolean) => void;
  open: boolean;
  regex: boolean;
  replaceText: string;
  searchMatches: number;
  searchPending?: boolean;
  searchError?: string;
  searchText: string;
  wholeWord: boolean;
}

function navigateHistory(
  event: ReactKeyboardEvent<HTMLElement>,
  history: string[],
  historyIndexRef: MutableRefObject<number | null>,
  historyDraftRef: MutableRefObject<string>,
  value: string,
  onValueChange: (value: string) => void
): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (history.length === 0) {
    return;
  }

  const historyIndex = historyIndexRef.current;
  if (event.key === "ArrowDown" && historyIndex === null) {
    return;
  }

  if (historyIndex === null) {
    historyDraftRef.current = value;
  }

  if (event.key === "ArrowUp") {
    const nextHistoryIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, history.length - 1);
    const entry = history[nextHistoryIndex];
    if (entry === undefined) return;
    historyIndexRef.current = nextHistoryIndex;
    onValueChange(entry);
    return;
  }

  if (historyIndex === null) return;
  const nextHistoryIndex = historyIndex - 1;
  if (nextHistoryIndex < 0) {
    historyIndexRef.current = null;
    onValueChange(historyDraftRef.current);
    return;
  }

  const entry = history[nextHistoryIndex];
  if (entry === undefined) return;
  historyIndexRef.current = nextHistoryIndex;
  onValueChange(entry);
}

export function CodeMirrorFindReplacePopover({
  caseSensitive,
  currentMatch,
  disabled = false,
  focusTarget,
  isReplaceMode,
  isSearchValid,
  onCaseSensitiveChange,
  onClose,
  onFindNext,
  onFindPrevious,
  onFocusHandled,
  onRegexChange,
  onReplaceAll,
  onReplaceChange,
  onReplaceCurrent,
  onSearchChange,
  onWholeWordChange,
  open,
  regex,
  replaceText,
  searchMatches,
  searchPending = false,
  searchError,
  searchText,
  wholeWord,
}: CodeMirrorFindReplacePopoverProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const findHistoryIndexRef = useRef<number | null>(null);
  const replaceHistoryIndexRef = useRef<number | null>(null);
  const findHistoryDraftRef = useRef("");
  const replaceHistoryDraftRef = useRef("");
  const popoverRef = useRef<HTMLElement | null>(null);
  const [findHistory, setFindHistory] = useState(() => readCodeMirrorFindReplaceHistory(CODEMIRROR_FIND_HISTORY_STORAGE_KEY));
  const [replaceHistory, setReplaceHistory] = useState(() => readCodeMirrorFindReplaceHistory(CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY));
  const hasMatches = isSearchValid && searchMatches > 0;
  const canNavigate = hasMatches || (isSearchValid && regex && Boolean(searchText) && (searchPending || Boolean(searchError)));
  const replaceDisabled = disabled || searchPending || Boolean(searchError) || !hasMatches;
  const dialogSurfaces = getOverlaySurfaceTokens(theme.palette.background.default, theme.palette.mode);

  useEffect(() => {
    if (open) {
      return;
    }

    findHistoryIndexRef.current = null;
    replaceHistoryIndexRef.current = null;
    findHistoryDraftRef.current = "";
    replaceHistoryDraftRef.current = "";
  }, [open]);

  const setFindInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && focusTarget === "find") {
        element.focus();
        onFocusHandled();
      }
    },
    [focusTarget, onFocusHandled]
  );

  const setReplaceInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && focusTarget === "replace") {
        element.focus();
        onFocusHandled();
      }
    },
    [focusTarget, onFocusHandled]
  );

  const recordFindHistory = () => {
    setFindHistory((previousHistory) => {
      const nextHistory = addCodeMirrorFindReplaceHistoryEntry(previousHistory, searchText);
      writeCodeMirrorFindReplaceHistory(CODEMIRROR_FIND_HISTORY_STORAGE_KEY, nextHistory);
      return nextHistory;
    });
  };

  const recordReplaceHistory = () => {
    setReplaceHistory((previousHistory) => {
      const nextHistory = addCodeMirrorFindReplaceHistoryEntry(previousHistory, replaceText);
      writeCodeMirrorFindReplaceHistory(CODEMIRROR_REPLACE_HISTORY_STORAGE_KEY, nextHistory);
      return nextHistory;
    });
  };

  const handleClose = () => {
    recordFindHistory();
    recordReplaceHistory();
    onClose();
  };

  const handleFindPrevious = () => {
    recordFindHistory();
    onFindPrevious();
  };

  const handleFindNext = () => {
    recordFindHistory();
    onFindNext();
  };

  const handleReplaceCurrent = () => {
    recordFindHistory();
    recordReplaceHistory();
    onReplaceCurrent();
  };

  const handleReplaceAll = () => {
    recordFindHistory();
    recordReplaceHistory();
    onReplaceAll();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleClose();
      return;
    }

    if (event.key !== "Tab" || !popoverRef.current) {
      return;
    }

    const focusableElements = Array.from(popoverRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_ELEMENT_SELECTOR));
    const activeElementIndex = focusableElements.indexOf(document.activeElement as HTMLElement);

    if (activeElementIndex === -1) {
      return;
    }

    const lastFocusableElementIndex = focusableElements.length - 1;
    if (!event.shiftKey && activeElementIndex === lastFocusableElementIndex) {
      event.preventDefault();
      focusableElements[0]?.focus();
    } else if (event.shiftKey && activeElementIndex === 0) {
      event.preventDefault();
      focusableElements[lastFocusableElementIndex]?.focus();
    }
  };

  if (!open) {
    return null;
  }

  return (
    <Portal>
      <Box
        aria-label={t("viewer.edit.findReplace")}
        component="section"
        data-testid="code-mirror-find-replace-popover"
        onKeyDown={handleKeyDown}
        ref={popoverRef}
        role="search"
        sx={{
          backgroundColor: dialogSurfaces.paper,
          border: 1,
          borderColor: "divider",
          boxShadow: 8,
          display: "grid",
          fontSize: "0.875rem",
          gap: 0.625,
          maxWidth: `calc(100vw - ${SCROLLBAR.WIDTH_PX + 24}px)`,
          p: 1,
          position: "fixed",
          right: { xs: `${SCROLLBAR.WIDTH_PX + 8}px`, sm: `${SCROLLBAR.WIDTH_PX + 16}px` },
          top: {
            xs: `calc(${TOOLBAR_HEIGHT.MOBILE_PX}px + 8px)`,
            sm: `calc(${TOOLBAR_HEIGHT.DESKTOP_PX}px + 8px)`,
          },
          width: { xs: "calc(100vw - 16px)", sm: "26rem" },
          zIndex: (currentTheme) => currentTheme.zIndex.modal + 1,
        }}
      >
        {searchError && (
          <Typography color="error" role="alert" sx={{ fontSize: "0.875rem", overflowWrap: "anywhere" }}>
            {searchError}
          </Typography>
        )}
        <Box
          sx={{
            alignItems: "center",
            display: "grid",
            gap: 0.625,
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gridTemplateRows: isReplaceMode ? "34px 34px" : "34px",
            minWidth: 0,
          }}
        >
          <TextField
            autoComplete="off"
            disabled={disabled}
            inputRef={setFindInputRef}
            onChange={(event) => {
              findHistoryIndexRef.current = null;
              findHistoryDraftRef.current = event.target.value;
              onSearchChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) {
                  handleFindPrevious();
                } else {
                  handleFindNext();
                }
                return;
              }

              navigateHistory(event, findHistory, findHistoryIndexRef, findHistoryDraftRef, searchText, onSearchChange);
            }}
            placeholder={t("viewer.edit.findWithHistory")}
            size="small"
            slotProps={{
              htmlInput: { "aria-label": t("viewer.edit.find") },
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Typography
                      aria-live="polite"
                      color={hasMatches || searchPending ? "text.secondary" : "error"}
                      sx={{ fontSize: "0.875rem", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
                    >
                      {searchPending
                        ? t("app.loading")
                        : searchError
                          ? "?"
                          : isSearchValid
                            ? `${currentMatch} / ${searchMatches}`
                            : t("viewer.edit.invalidRegularExpression")}
                    </Typography>
                  </InputAdornment>
                ),
              },
            }}
            sx={{
              gridColumn: 1,
              gridRow: 1,
              minWidth: 0,
              "& .MuiInputBase-input": { fontSize: "0.875rem", py: 0.625 },
              "& .MuiOutlinedInput-root": { minHeight: 34 },
            }}
            value={searchText}
          />
          {isReplaceMode && (
            <TextField
              autoComplete="off"
              disabled={disabled}
              inputRef={setReplaceInputRef}
              onChange={(event) => {
                replaceHistoryIndexRef.current = null;
                replaceHistoryDraftRef.current = event.target.value;
                onReplaceChange(event.target.value);
              }}
              onKeyDown={(event) =>
                navigateHistory(event, replaceHistory, replaceHistoryIndexRef, replaceHistoryDraftRef, replaceText, onReplaceChange)
              }
              placeholder={t("viewer.edit.replaceWithHistory")}
              size="small"
              slotProps={{
                htmlInput: {
                  "aria-label": t("viewer.edit.replace"),
                  [CODEMIRROR_FIND_REPLACE_REPLACE_INPUT_ATTRIBUTE]: "true",
                },
              }}
              sx={{
                gridColumn: 1,
                gridRow: 2,
                minWidth: 0,
                "& .MuiInputBase-input": { fontSize: "0.875rem", py: 0.625 },
                "& .MuiOutlinedInput-root": { minHeight: 34 },
              }}
              value={replaceText}
            />
          )}
          <Box sx={{ alignItems: "center", display: "flex", gap: 0.25, gridColumn: 2, gridRow: 1, justifyContent: "end", minWidth: 0 }}>
            <Box aria-label={t("viewer.edit.matchOptions")} sx={{ alignItems: "center", display: "flex", gap: 0 }}>
              <Tooltip describeChild title={withShortcut(CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_CASE_SENSITIVE)}>
                <span>
                  <IconButton
                    aria-label={t("viewer.edit.caseSensitive")}
                    aria-pressed={caseSensitive}
                    disabled={disabled}
                    onClick={() => onCaseSensitiveChange(!caseSensitive)}
                    size="small"
                    sx={{ color: caseSensitive ? "primary.main" : "inherit", height: 30, p: 0.25, width: 28 }}
                  >
                    <Typography component="span" sx={{ fontSize: "0.875rem", fontWeight: 600, lineHeight: 1 }}>
                      Aa
                    </Typography>
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip describeChild title={withShortcut(CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WHOLE_WORD)}>
                <span>
                  <IconButton
                    aria-label={t("viewer.edit.wholeWord")}
                    aria-pressed={wholeWord}
                    disabled={disabled}
                    onClick={() => onWholeWordChange(!wholeWord)}
                    size="small"
                    sx={{ color: wholeWord ? "primary.main" : "inherit", height: 30, p: 0.25, width: 28 }}
                  >
                    <Typography component="span" sx={{ fontSize: "0.875rem", fontWeight: 600, lineHeight: 1 }}>
                      ab
                    </Typography>
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip describeChild title={withShortcut(CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_REGULAR_EXPRESSION)}>
                <span>
                  <IconButton
                    aria-label={t("viewer.edit.regularExpression")}
                    aria-pressed={regex}
                    disabled={disabled}
                    onClick={() => onRegexChange(!regex)}
                    size="small"
                    sx={{ color: regex ? "primary.main" : "inherit", height: 30, p: 0.25, width: 28 }}
                  >
                    <Typography component="span" sx={{ fontSize: "0.875rem", fontWeight: 600, lineHeight: 1 }}>
                      .*
                    </Typography>
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            <Box sx={{ alignItems: "center", display: "flex", gap: 0, ml: 0.25 }}>
              <Tooltip describeChild title={withShortcut(COMMON_SHORTCUTS.PREVIOUS_MATCH)}>
                <span>
                  <IconButton
                    aria-label={t("viewer.edit.previousMatch")}
                    disabled={disabled || !canNavigate}
                    onClick={handleFindPrevious}
                    size="small"
                    sx={{ height: 30, p: 0.25, width: 26 }}
                  >
                    <KeyboardArrowUp sx={{ fontSize: "1.125rem" }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip describeChild title={withShortcut(COMMON_SHORTCUTS.NEXT_MATCH)}>
                <span>
                  <IconButton
                    aria-label={t("viewer.edit.nextMatch")}
                    disabled={disabled || !canNavigate}
                    onClick={handleFindNext}
                    size="small"
                    sx={{ height: 30, p: 0.25, width: 26 }}
                  >
                    <KeyboardArrowDown sx={{ fontSize: "1.125rem" }} />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            <Tooltip describeChild title={withShortcut(COMMON_SHORTCUTS.CLOSE)}>
              <IconButton
                aria-label={t("common.actions.close")}
                onClick={handleClose}
                size="small"
                sx={{ height: 30, ml: 0.25, p: 0.25, width: 30 }}
              >
                <Close sx={{ fontSize: "1.125rem" }} />
              </IconButton>
            </Tooltip>
          </Box>
          {isReplaceMode && (
            <Box sx={{ alignItems: "center", display: "flex", gap: 0.25, gridColumn: 2, gridRow: 2, justifyContent: "end", minWidth: 0 }}>
              <Tooltip describeChild title={withShortcut(CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_CURRENT)}>
                <span>
                  <Button
                    aria-label={t("viewer.edit.replaceCurrent")}
                    disabled={replaceDisabled}
                    onClick={handleReplaceCurrent}
                    size="small"
                    startIcon={<FindReplace sx={{ fontSize: "1rem" }} />}
                    sx={{ fontSize: "0.875rem", minHeight: 34, px: 0.75 }}
                    variant="text"
                  >
                    {t("common.actions.replace")}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip describeChild title={withShortcut(CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_ALL)}>
                <span>
                  <Button
                    aria-label={t("viewer.edit.replaceAll")}
                    disabled={replaceDisabled}
                    onClick={handleReplaceAll}
                    size="small"
                    startIcon={<PlaylistAddCheck sx={{ fontSize: "1rem" }} />}
                    sx={{ fontSize: "0.875rem", minHeight: 34, px: 0.75 }}
                    variant="text"
                  >
                    {t("viewer.edit.replaceAll")}
                  </Button>
                </span>
              </Tooltip>
            </Box>
          )}
        </Box>
      </Box>
    </Portal>
  );
}
