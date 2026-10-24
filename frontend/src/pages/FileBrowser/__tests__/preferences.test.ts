import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { wordWrapCommitMock } = vi.hoisted(() => ({ wordWrapCommitMock: vi.fn() }));

vi.mock("../../../services/userSettingsStore", () => ({
  useCurrentUserSetting: (field: string) => ({
    confirmedValue: field === "text_editor.word_wrap_enabled" ? null : field === "text_editor.max_file_size_bytes" ? 52428800 : undefined,
    pending: false,
    error: null,
    commit: wordWrapCommitMock,
    clearError: vi.fn(),
  }),
}));

import { authSession } from "../../../services/authSession";
import {
  isQuickBarKeyboardEvidenceEvent,
  shouldUseTouchSelectionControls,
  useQuickBarKeyboardHints,
  useTextEditorMaxFileSizeBytesPreference,
  useTextEditorWordWrapPreference,
  useTouchFriendlyFileSelectionPreference,
} from "../preferences";

describe("File Browser preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    authSession.clear();
    wordWrapCommitMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the confirmed text editor size from the current-user setting store", async () => {
    const { result } = renderHook(() => useTextEditorMaxFileSizeBytesPreference());

    await waitFor(() => {
      expect(result.current[0]).toBe(52428800);
    });
  });

  it("keeps the established text and Markdown defaults until a word-wrap override is saved", async () => {
    const textPreference = renderHook(() => useTextEditorWordWrapPreference(false));
    const markdownPreference = renderHook(() => useTextEditorWordWrapPreference(true));

    await waitFor(() => {
      expect(textPreference.result.current[0]).toBe(false);
      expect(markdownPreference.result.current[0]).toBe(true);
    });

    act(() => {
      markdownPreference.result.current[1](false);
    });

    expect(textPreference.result.current[0]).toBe(false);
    expect(markdownPreference.result.current[0]).toBe(false);
  });

  it("applies word-wrap changes immediately through its field store", async () => {
    const { result } = renderHook(() => useTextEditorWordWrapPreference(false));

    act(() => {
      result.current[1](false);
    });

    expect(result.current[0]).toBe(false);
    expect(wordWrapCommitMock).toHaveBeenCalledWith(false);
  });

  it("uses the persisted touch-friendly file-selection preference", () => {
    const { result } = renderHook(() => useTouchFriendlyFileSelectionPreference());

    expect(result.current[0]).toBe("auto");
    act(() => {
      result.current[1]("always");
    });

    expect(wordWrapCommitMock).toHaveBeenCalledWith("always");
  });

  it("enables touch selection for compact layouts, explicit preference, or a coarse primary pointer", () => {
    expect(shouldUseTouchSelectionControls("never", true, false)).toBe(true);
    expect(shouldUseTouchSelectionControls("always", false, false)).toBe(true);
    expect(shouldUseTouchSelectionControls("auto", false, true)).toBe(true);
    expect(shouldUseTouchSelectionControls("auto", false, false)).toBe(false);
    expect(shouldUseTouchSelectionControls("never", false, true)).toBe(false);
  });

  it("shows Quick Bar hints according to compact layout, saved evidence, and visibility mode", () => {
    const { result, rerender } = renderHook<boolean, { visibility: "auto" | "always" | "never"; compact: boolean }>(
      ({ visibility, compact }) => useQuickBarKeyboardHints(visibility, compact),
      {
        initialProps: { visibility: "auto" as const, compact: true },
      }
    );

    expect(result.current).toBe(false);

    rerender({ visibility: "always", compact: true });
    expect(result.current).toBe(true);

    rerender({ visibility: "never", compact: false });
    expect(result.current).toBe(false);

    rerender({ visibility: "auto", compact: false });
    expect(result.current).toBe(true);

    sessionStorage.setItem("quick-bar-keyboard-evidence", "true");
    const restored = renderHook(() => useQuickBarKeyboardHints("auto", true));
    expect(restored.result.current).toBe(true);
  });

  it("records only trusted non-composing non-modifier keyboard events as evidence", () => {
    expect(isQuickBarKeyboardEvidenceEvent({ isTrusted: true, isComposing: false, key: "k" })).toBe(true);
    expect(isQuickBarKeyboardEvidenceEvent({ isTrusted: false, isComposing: false, key: "k" })).toBe(false);
    expect(isQuickBarKeyboardEvidenceEvent({ isTrusted: true, isComposing: true, key: "k" })).toBe(false);
    expect(isQuickBarKeyboardEvidenceEvent({ isTrusted: true, isComposing: false, key: "Control" })).toBe(false);
  });

  it("cleans up the compact auto-mode keyboard listener", () => {
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useQuickBarKeyboardHints("auto", true));

    unmount();

    expect(removeEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);
  });
});
