import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import ErrorBoundary from "../ErrorBoundary";

function ThrowingComponent(): never {
  throw new Error("Boom");
}

function suppressExpectedRenderCrashNoise(message: string): () => void {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const combinedMessage = args.map((value) => (value instanceof Error ? value.message : String(value))).join(" ");

    if (combinedMessage.includes(message)) {
      return;
    }
  });

  const handleWindowError = (event: ErrorEvent) => {
    if (event.error instanceof Error && event.error.message === message) {
      event.preventDefault();
    }
  };

  window.addEventListener("error", handleWindowError);

  return () => {
    window.removeEventListener("error", handleWindowError);
    consoleErrorSpy.mockRestore();
  };
}

describe("ErrorBoundary", () => {
  let restoreCrashNoiseSuppression: (() => void) | null = null;

  beforeEach(() => {
    restoreCrashNoiseSuppression = suppressExpectedRenderCrashNoise("Boom");
  });

  afterEach(async () => {
    restoreCrashNoiseSuppression?.();
    restoreCrashNoiseSuppression = null;
    await setLocale("en");
  });

  it("renders the default fallback UI", () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred. The error has been logged.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload Page" })).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
  });

  it("uses translated fallback strings", async () => {
    await setLocale("en-XA");

    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText("[Šóḿéťħíńğ ŵéńť ŵŕóńğ]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[Ťŕý Åğåíń]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[Ŕéĺóåď Ṕåğé]" })).toBeInTheDocument();
  });
});
