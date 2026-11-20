import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { getAvailableLanguages, getCurrentLanguage, setLocale, setPreviewTextExpansion, translate } from "../../i18n";
import { PreviewLocalizationControls } from "../PreviewLocalizationControls";
import { usePreviewSettings } from "../usePreviewSettings";

function PreviewSettingsHarness() {
  const settings = usePreviewSettings();

  return (
    <main dir={settings.direction === "auto" ? undefined : settings.direction}>
      <PreviewLocalizationControls settings={settings} />
      <output data-testid="preview-copy">{translate("appPicker.title", { extension: "spreadsheet" })}</output>
      <button type="button" onClick={() => void settings.reset()}>
        Reset settings
      </button>
    </main>
  );
}

describe("PreviewLocalizationControls", () => {
  afterEach(async () => {
    cleanup();
    setPreviewTextExpansion(false);
    await setLocale("en");
  });

  it("offers bundled locales and switches translated preview text", async () => {
    expect(getAvailableLanguages()).toEqual(expect.arrayContaining(["en", "en-XA", "de", "ja", "zh-Hans"]));

    render(<PreviewSettingsHarness />);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "de" } });

    await waitFor(() => {
      expect(getCurrentLanguage()).toBe("de");
      expect(screen.getByTestId("preview-copy").textContent).not.toContain("Choose an app");
    });

    expect(document.documentElement.lang).toBe("de");
  });

  it("sets an RTL layout override and expands translated words", async () => {
    render(<PreviewSettingsHarness />);
    const main = screen.getByRole("main");
    const originalCopy = screen.getByTestId("preview-copy").textContent;

    fireEvent.change(screen.getByLabelText("Direction"), { target: { value: "rtl" } });
    expect(main).toHaveAttribute("dir", "rtl");

    fireEvent.change(screen.getByLabelText("Text length"), { target: { value: "expanded" } });
    await waitFor(() => {
      expect(screen.getByTestId("preview-copy").textContent).not.toBe(originalCopy);
    });

    expect(screen.getByTestId("preview-copy").textContent).toMatch(/spreadsheett+/);
  });

  it("resets the language and mock data controls", async () => {
    render(<PreviewSettingsHarness />);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "ja" } });
    fireEvent.change(screen.getByLabelText("Mock data"), { target: { value: "long" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset settings" }));

    await waitFor(() => {
      expect(getCurrentLanguage()).toBe("en");
      expect(screen.getByLabelText("Mock data")).toHaveValue("standard");
    });
  });
});
