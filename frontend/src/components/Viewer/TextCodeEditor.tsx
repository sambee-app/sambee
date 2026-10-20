import { findNext, findPrevious, replaceAll, replaceNext } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { loadNativeLanguage, resolveFilename } from "../../utils/codeMirrorHighlighting";
import { buildPassiveSearchHighlightExtension } from "../Editor/buildCodeMirrorSearchHighlights";
import { buildCommonEditorExtensions } from "../Editor/buildCommonEditorExtensions";
import { buildTextEditorTheme, type TextEditorThemeOptions } from "../Editor/buildTextEditorTheme";
import { SourceTextEditor } from "../Editor/SourceTextEditor";
import type { SourceTextEditorHandle } from "../Editor/sourceTextEditorTypes";
import {
  getCodeMirrorFindReplaceMetrics,
  shouldAutoNavigateCodeMirrorFindReplace,
  updateCodeMirrorFindReplaceQuery,
} from "./codeMirrorFindReplace";

export interface TextCodeEditorHandle {
  focus: () => void;
  flushPendingEdits: () => Promise<void>;
  getCanonicalText: () => string;
  getPrimarySelectionText: () => string;
  preserveSelection: () => void;
  restorePreservedSelection: () => boolean;
  focusCurrentSearchResult: () => boolean;
  nextSearchResult: () => void;
  previousSearchResult: () => void;
  replaceAllSearchResults: () => void;
  replaceCurrentSearchResult: () => void;
}

export interface TextCodeEditorSearchState {
  searchText: string;
  searchMatches: number;
  currentMatch: number;
  isSearchOpen: boolean;
  isSearchable: boolean;
  isValid: boolean;
  viewMode: "source";
}

export interface TextCodeEditorProps {
  text: string;
  filename: string;
  onChange: (text: string) => void;
  onUserEdit?: () => void;
  ariaLabel: string;
  theme: TextEditorThemeOptions;
  autoFocus?: boolean;
  readOnly?: boolean;
  lineWrapping?: boolean;
  className?: string;
  searchText?: string;
  searchOpen?: boolean;
  searchAutoNavigate?: boolean;
  searchCaseSensitive?: boolean;
  searchRegexp?: boolean;
  searchReplaceText?: string;
  searchWholeWord?: boolean;
  onSearchStateChange?: (state: TextCodeEditorSearchState) => void;
}

const EMPTY_EXTENSIONS: Extension[] = [];

export const TextCodeEditor = forwardRef<TextCodeEditorHandle, TextCodeEditorProps>(
  (
    {
      text,
      filename,
      onChange,
      onUserEdit,
      ariaLabel,
      theme,
      autoFocus = false,
      readOnly = false,
      lineWrapping = false,
      className,
      searchText = "",
      searchOpen = false,
      searchAutoNavigate = true,
      searchCaseSensitive = false,
      searchRegexp = false,
      searchReplaceText = "",
      searchWholeWord = false,
      onSearchStateChange,
    },
    ref
  ) => {
    const editorRef = useRef<SourceTextEditorHandle | null>(null);
    const [languageExtensions, setLanguageExtensions] = useState<Extension[]>(EMPTY_EXTENSIONS);
    const previousSearchRequestRef = useRef<{
      caseSensitive: boolean;
      regexp: boolean;
      searchOpen: boolean;
      searchText: string;
      wholeWord: boolean;
    } | null>(null);
    const extensions = useMemo(
      () => [
        ...buildCommonEditorExtensions({ defaultSyntaxHighlighting: false, highlightSelectionMatches: false, lineWrapping }),
        ...buildTextEditorTheme(theme),
        buildPassiveSearchHighlightExtension(),
        ...languageExtensions,
      ],
      [languageExtensions, lineWrapping, theme]
    );
    useEffect(() => {
      let cancelled = false;
      const resolved = resolveFilename(filename);

      if (!("language" in resolved)) {
        setLanguageExtensions(EMPTY_EXTENSIONS);
        return;
      }

      void loadNativeLanguage(resolved.language)
        .then((support) => {
          if (cancelled) {
            return;
          }

          setLanguageExtensions([support]);
        })
        .catch(() => {
          if (!cancelled) {
            setLanguageExtensions(EMPTY_EXTENSIONS);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [filename]);

    const reportSearchState = useCallback(() => {
      if (!onSearchStateChange) {
        return;
      }

      const metrics = getCodeMirrorFindReplaceMetrics(editorRef.current?.getView());
      onSearchStateChange({
        searchText: searchOpen ? searchText : "",
        searchMatches: searchOpen ? metrics.matches : 0,
        currentMatch: searchOpen ? metrics.currentMatch : 0,
        isSearchOpen: searchOpen,
        isSearchable: metrics.isSearchable,
        isValid: metrics.isValid,
        viewMode: "source",
      });
    }, [onSearchStateChange, searchOpen, searchText]);

    useEffect(() => {
      const currentRequest = {
        caseSensitive: searchCaseSensitive,
        regexp: searchRegexp,
        searchOpen,
        searchText,
        wholeWord: searchWholeWord,
      };
      const previousRequest = previousSearchRequestRef.current;
      previousSearchRequestRef.current = currentRequest;

      if (!searchOpen || searchText.trim().length === 0) {
        updateCodeMirrorFindReplaceQuery(editorRef.current?.getView(), {
          caseSensitive: searchCaseSensitive,
          regexp: searchRegexp,
          replace: searchReplaceText,
          searchText: "",
          wholeWord: searchWholeWord,
        });
        reportSearchState();
        return;
      }

      updateCodeMirrorFindReplaceQuery(editorRef.current?.getView(), {
        caseSensitive: searchCaseSensitive,
        regexp: searchRegexp,
        replace: searchReplaceText,
        searchText,
        wholeWord: searchWholeWord,
      });

      if (shouldAutoNavigateCodeMirrorFindReplace(previousRequest, currentRequest, searchAutoNavigate)) {
        editorRef.current?.runCommand(findNext);
      }

      reportSearchState();
    }, [
      reportSearchState,
      searchAutoNavigate,
      searchCaseSensitive,
      searchOpen,
      searchRegexp,
      searchReplaceText,
      searchText,
      searchWholeWord,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          editorRef.current?.focus();
        },
        flushPendingEdits: async () => {},
        getCanonicalText: () => editorRef.current?.getValue() ?? text,
        getPrimarySelectionText: () => editorRef.current?.getPrimarySelectionText() ?? "",
        preserveSelection: () => {
          editorRef.current?.preserveSelection();
        },
        restorePreservedSelection: () => editorRef.current?.restorePreservedSelection() ?? false,
        focusCurrentSearchResult: () => {
          editorRef.current?.focus();
          return editorRef.current?.getView()?.hasFocus ?? false;
        },
        nextSearchResult: () => {
          editorRef.current?.runCommand(findNext);
          reportSearchState();
        },
        previousSearchResult: () => {
          editorRef.current?.runCommand(findPrevious);
          reportSearchState();
        },
        replaceCurrentSearchResult: () => {
          editorRef.current?.runCommand(replaceNext);
          reportSearchState();
        },
        replaceAllSearchResults: () => {
          editorRef.current?.runCommand(replaceAll);
          reportSearchState();
        },
      }),
      [reportSearchState, text]
    );

    return (
      <SourceTextEditor
        ref={editorRef}
        className={className}
        value={text}
        extensions={extensions}
        readOnly={readOnly}
        autoFocus={autoFocus}
        ariaLabel={ariaLabel}
        onChange={onChange}
        onUserEdit={onUserEdit}
        onUpdate={() => {
          reportSearchState();
        }}
      />
    );
  }
);

TextCodeEditor.displayName = "TextCodeEditor";
