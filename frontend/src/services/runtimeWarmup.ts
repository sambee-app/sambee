let warmupScheduled = false;
const IS_TEST_ENVIRONMENT =
  import.meta.env["VITEST"] === true ||
  import.meta.env.MODE === "test" ||
  (typeof globalThis !== "undefined" && ("describe" in globalThis || "it" in globalThis || "test" in globalThis));

async function warmRuntimeModules(): Promise<void> {
  await Promise.allSettled([
    import("../components/Viewer/ImageViewer"),
    import("../components/Viewer/MarkdownRichEditor"),
    import("../components/Viewer/MarkdownViewer"),
    import("../components/Viewer/PDFViewer"),
    import("../components/Viewer/TextEditor"),
    import("./authConfig"),
    import("./loggingConfig"),
  ]);
}

export function scheduleRuntimeWarmup(): void {
  if (IS_TEST_ENVIRONMENT) {
    return;
  }

  if (warmupScheduled) {
    return;
  }

  warmupScheduled = true;

  const runWarmup = () => {
    void warmRuntimeModules();
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(
      () => {
        runWarmup();
      },
      { timeout: 2_000 }
    );
    return;
  }

  window.setTimeout(runWarmup, 1_000);
}

export function resetRuntimeWarmupForTests(): void {
  warmupScheduled = false;
}
