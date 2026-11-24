import { beforeEach, expect, onTestFinished } from "vitest";

beforeEach(() => {
  const consoleError = console.error;
  const consoleWarn = console.warn;
  const unexpectedWarnings: string[] = [];
  const captureWarnings =
    (output: typeof console.error) =>
    (...args: unknown[]) => {
      const message = args.map(String).join(" ");
      unexpectedWarnings.push(message);
      output(...args);
    };
  console.error = captureWarnings(consoleError);
  console.warn = captureWarnings(consoleWarn);
  onTestFinished(() => {
    try {
      expect(
        unexpectedWarnings,
        "Unexpected console.warn or console.error output. Fix its cause or explicitly mock and assert an expected diagnostic in this test."
      ).toEqual([]);
    } finally {
      console.error = consoleError;
      console.warn = consoleWarn;
    }
  });
});

if (typeof window !== "undefined" && typeof document !== "undefined") {
  await import("./setup-dom");
}
