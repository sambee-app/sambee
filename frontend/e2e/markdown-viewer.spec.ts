import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEMO_CONNECTION_ID = "85610f49-ab40-4d96-8750-ddab3e8e8764";
const DEMO_PATH = "note.md";
const DEMO_DIRECTORY = "Reports";
const DEMO_ARCHIVE = "sample.zip";

const LINE_BREAK_MARKDOWN = "alpha\n\n| Col 1 | Col 2 |\n| --- | --- |\n| A1 | B1 |\n| A2 | B2 |\n\nomega\n";
const SEARCH_MARKDOWN = "alpha\n\n| Col 1 | Col 2 |\n| --- | --- |\n| alpha | B1 |\n| A2 | alpha |\n\nomega alpha\n";
const WRAPPED_SELECTION_MARKDOWN = [
  "- **TestOps:** Ongoing improvement of the TestOps integration testing framework, initially to be used with uberAgent, ",
  "but potentially valuable to other teams as well.",
].join("");
const LONG_UNWRAPPED_LINE = "long unwrapped editor content ".repeat(200);
const CURSOR_EDGE_TOLERANCE_PX = 2;
const SCROLLED_SELECTION_MARKDOWN = [
  ...Array.from({ length: 120 }, (_, index) => `Filler line ${index + 1}`),
  WRAPPED_SELECTION_MARKDOWN,
].join("\n");

interface MockMarkdownViewerApiOptions {
  initialMarkdown: string;
  includeDirectory?: boolean;
  includeZip?: boolean;
  existingFilePaths?: readonly string[];
  onTransferStream?: (route: Route) => Promise<void>;
  onUploadBody?: (body: string, setCurrentMarkdown: (markdown: string) => void) => void;
}

async function fulfillJson(route: Route, json: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
}

async function mockMarkdownViewerApi(page: Page, { initialMarkdown, includeDirectory, includeZip, existingFilePaths, onTransferStream, onUploadBody }: MockMarkdownViewerApiOptions): Promise<void> {
  let currentMarkdown = initialMarkdown;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname.endsWith("/auth/config")) {
      await fulfillJson(route, { sign_in_mode: "none", oidc: null });
      return;
    }

    if (pathname.endsWith("/logs/config")) {
      await fulfillJson(route, {
        logging_enabled: false,
        logging_level: "WARNING",
        tracing_enabled: false,
        tracing_level: "ERROR",
        tracing_components: [],
      });
      return;
    }

    if (pathname.endsWith("/auth/me")) {
      await fulfillJson(route, {
        id: "user-1",
        username: "demo-admin",
        role: "admin",
        is_active: true,
      });
      return;
    }

    if (pathname.endsWith("/auth/me/settings") && request.method() === "GET") {
      await fulfillJson(route, {
        appearance: { theme_id: "sambee-light", custom_themes: [] },
        localization: { language: "browser", regional_locale: "browser" },
        browser: {
          quick_nav_include_dot_directories: false,
          quick_bar_shortcut_hint_visibility: "auto",
          file_browser_view_mode: "list",
          pane_mode: "single",
          selected_connection_id: null,
          viewer_associations: {},
        },
        text_editor: { max_file_size_bytes: 52428800, word_wrap_enabled: null },
      });
      return;
    }

    if (pathname.endsWith("/auth/me/settings") && request.method() === "PUT") {
      await fulfillJson(route, {
        appearance: { theme_id: "sambee-light", custom_themes: [] },
        localization: { language: "browser", regional_locale: "browser" },
        browser: {
          quick_nav_include_dot_directories: false,
          quick_bar_shortcut_hint_visibility: "auto",
          file_browser_view_mode: "list",
          pane_mode: "single",
          selected_connection_id: null,
          viewer_associations: {},
        },
        text_editor: { max_file_size_bytes: 52428800, word_wrap_enabled: null },
      });
      return;
    }

    if (pathname.endsWith("/version")) {
      await fulfillJson(route, {
        version: "0.8.0-test",
        build_time: "2026-04-12T12:00:00Z",
        git_commit: "deadbeef",
      });
      return;
    }

    if (pathname.endsWith("/connections")) {
      await fulfillJson(route, [
        {
          id: DEMO_CONNECTION_ID,
          name: "Demo",
          slug: "demo",
          type: "smb",
          host: "demo.local",
          port: 445,
          share_name: "data",
          username: "demo\\tester",
          path_prefix: "\\Demo",
          scope: "private",
          access_mode: "read_write",
          can_manage: true,
          created_at: "2026-02-13T20:22:41.779354",
          updated_at: "2026-04-12T10:15:47.930127",
        },
      ]);
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/list`) {
      await fulfillJson(route, {
        path: "/",
        items: [
          {
            name: DEMO_PATH,
            path: DEMO_PATH,
            type: "file",
            is_readable: true,
            size: currentMarkdown.length,
            mime_type: "text/markdown",
            modified_at: "2026-04-12T12:00:00Z",
          },
          ...(includeDirectory
            ? [{ name: DEMO_DIRECTORY, path: DEMO_DIRECTORY, type: "directory", is_readable: true, modified_at: "2026-04-12T12:00:00Z" }]
            : []),
          ...(includeZip
            ? [{ name: DEMO_ARCHIVE, path: DEMO_ARCHIVE, type: "file", size: 512, is_readable: true, modified_at: "2026-04-12T12:00:00Z" }]
            : []),
        ],
      });
      return;
    }

    if (pathname === "/api/archive/v2/inspection/directory" && includeZip) {
      await fulfillJson(route, {
        archive: { path: DEMO_ARCHIVE, size: 512 },
        path: "",
        items: [
          { name: "member.txt", path: "member.txt", type: "file", size: 6, state: "readable", is_hidden: false },
          { name: DEMO_DIRECTORY, path: DEMO_DIRECTORY, type: "directory", state: "readable", is_hidden: false },
        ],
        next_cursor: null,
        page_size: 100,
      });
      return;
    }

    if (
      pathname === `/api/browse/${DEMO_CONNECTION_ID}/info` &&
      (existingFilePaths?.includes(url.searchParams.get("path") ?? "") || (includeZip && url.searchParams.get("path") === DEMO_ARCHIVE))
    ) {
      const path = url.searchParams.get("path")!;
      await fulfillJson(route, { name: path, path, type: "file", size: path === DEMO_ARCHIVE ? 512 : 5, is_readable: true, modified_at: "2026-04-12T12:00:00Z" });
      return;
    }

    if (pathname === `/api/viewer/${DEMO_CONNECTION_ID}/file`) {
      await route.fulfill({
        status: 200,
        contentType: "text/markdown; charset=utf-8",
        body: currentMarkdown,
      });
      return;
    }

    if (pathname === "/api/viewer/download-intents" && request.method() === "POST") {
      await fulfillJson(route, { url: "/api/viewer/download-intents/test-ticket" });
      return;
    }

    if (pathname === "/api/viewer/download-intents/test-ticket") {
      await route.fulfill({ status: 200, headers: { "Content-Disposition": 'attachment; filename="download.txt"' }, body: "download" });
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/lock` && request.method() === "POST") {
      await fulfillJson(route, {
        lock_id: "lock-1",
        file_path: DEMO_PATH,
        locked_by: "demo-admin",
        locked_at: "2026-04-12T12:00:00Z",
         lock_capability: "test-lock-capability",
         operation_id: "test-operation-1",
      });
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/lock/heartbeat` && request.method() === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/lock` && request.method() === "DELETE") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/upload` && request.method() === "POST") {
      const uploadBody = request.postDataBuffer()?.toString("utf8") ?? "";
      onUploadBody?.(uploadBody, (markdown) => {
        currentMarkdown = markdown;
      });

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ path: DEMO_PATH }),
      });
      return;
    }

    if (pathname === `/api/browse/${DEMO_CONNECTION_ID}/transfer-stream` && request.method() === "POST" && onTransferStream) {
      await onTransferStream(route);
      return;
    }

    await fulfillJson(route, { detail: `Unhandled mocked route: ${request.method()} ${pathname}` }, 404);
  });
}

async function openMarkdownViewer(page: Page): Promise<void> {
  await page.goto("/browse/smb/demo");
  await page.getByRole("button", { name: `File: ${DEMO_PATH}` }).click();
}

async function serveProductionAssets(page: Page): Promise<void> {
  const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
  await page.route("http://localhost:3000/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) return route.fallback();
    const path = request.isNavigationRequest() ? resolve(dist, "index.html") : resolve(dist, `.${pathname}`);
    if (!path.startsWith(`${dist}${sep}`)) return route.abort();
    const contentTypes: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
    try {
      await route.fulfill({ body: await readFile(path), contentType: contentTypes[extname(path)] ?? "application/octet-stream" });
    } catch {
      await route.fulfill({ status: 404, body: "Production asset not found" });
    }
  });
}

async function captureViewerScheduling(page: Page, testInfo: TestInfo, action: () => Promise<void>): Promise<void> {
  if (process.env.SAMBEE_E2E_TRACE !== "1" || testInfo.project.name !== "chromium") return action();
  if (process.env.SAMBEE_E2E_MEMORY === "1") throw new Error("Run scheduling traces separately from controlled-GC memory trials");
  const session = await page.context().newCDPSession(page);
  let started = false;
  try {
    await session.send("Tracing.start", { categories: "-*,devtools.timeline,v8,blink.user_timing,toplevel,renderer.scheduler,disabled-by-default-devtools.timeline.frame,disabled-by-default-v8.cpu_profiler", transferMode: "ReturnAsStream" });
    started = true;
    await page.evaluate(() => performance.mark("sambee:viewer-trace:start"));
    await action();
  } finally {
    try {
      if (started) {
        const completed = new Promise<{ stream?: string }>((resolve) => session.once("Tracing.tracingComplete", resolve));
        await session.send("Tracing.end");
        const { stream } = await completed;
        if (!stream) throw new Error("Viewer scheduling trace returned no readable stream");
        const chunks: string[] = [];
        try {
          for (;;) {
            const response = await session.send("IO.read", { handle: stream });
            chunks.push(response.base64Encoded ? Buffer.from(response.data, "base64").toString("utf8") : response.data);
            if (response.eof) break;
          }
        } finally {
          await session.send("IO.close", { handle: stream });
        }
        await testInfo.attach("viewer-scheduling-trace", { body: chunks.join(""), contentType: "application/json" });
      }
    } finally {
      await session.detach();
    }
  }
}

test.describe("production syntax publication", () => {
  const retainedRenderer = process.env.SAMBEE_E2E_RETAINED === "1";
  const collectMemory = process.env.SAMBEE_E2E_MEMORY === "1";
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  const fixtures = [
    { name: "dense", blocks: 1, lines: 6_000 },
    { name: "near-safeguard", blocks: 1, lines: 11_111 },
    { name: "many-blocks", blocks: 600, lines: 101 },
    { name: "long-line", blocks: 1, lines: 6_000 },
  ];
  const viewportRangeLimit = 4_000;

  test("native viewer contracts retain semantic text, keyboard selection, links and print content", async ({ page }, testInfo) => {
    const markdown = "# Viewer contract\n\nAlpha **bold** and *emphasis*.\n\n[External](https://example.org/contract) [Relative](child.md) [Hash](#tail) [Unsafe](javascript:alert(1))\n\n- [x] Complete\n- [ ] Pending\n\n| Name | Value |\n| --- | --- |\n| Alpha | beta |\n\n```javascript\nconst contract = 1;\nconsole.log(contract);\n```\n\n<script>globalThis.unsafePayload = true</script>\n\n## Tail\n\nOmega contract.\n";
    await serveProductionAssets(page);
    await mockMarkdownViewerApi(page, { initialMarkdown: markdown, existingFilePaths: [DEMO_PATH] });
    await page.goto("/browse/smb/demo");
    await page.getByRole("button", { name: "Later", exact: true }).click();
    await page.getByRole("button").filter({ hasText: /^note\.md$/ }).click();
    const root = page.locator('[data-markdown-search-root="true"]');
    await expect(root.getByRole("heading", { name: "Viewer contract", exact: true })).toBeVisible();
    if (retainedRenderer) await expect(root.locator('[data-markdown-retained-state="complete"]')).toBeVisible();
    await expect(root.getByRole("table")).toHaveCount(1);
    await expect(root.getByRole("checkbox", { checked: true })).toBeDisabled();
    await expect(root.getByRole("checkbox", { checked: false })).toBeDisabled();
    await expect(root.locator("pre code")).toHaveText("const contract = 1;\nconsole.log(contract);\n");
    await expect(root.getByRole("link", { name: "External", exact: true })).toHaveAttribute("href", "https://example.org/contract");
    await expect(root.getByRole("link", { name: "Relative", exact: true })).toHaveAttribute("href", "http://localhost:3000/browse/smb/child.md");
    await expect(root.getByRole("link", { name: "Hash", exact: true })).toHaveAttribute("href", "#tail");
    await expect(root.getByText("Unsafe", { exact: true })).not.toHaveAttribute("href");
    await expect(root.locator("script")).toHaveCount(0);
    expect(await page.evaluate(() => "unsafePayload" in globalThis)).toBe(false);
    const viewport = root.locator("..");
    await expect(viewport).toBeFocused();
    await viewport.focus();
    await page.keyboard.press("Tab");
    await expect(root.getByRole("link", { name: "External", exact: true })).toBeFocused();
    const text = await root.innerText();
    await viewport.focus();
    await page.keyboard.press("Control+a");
    const selectAll = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selectAll).toContain("Viewer contract");
    expect(selectAll).toContain("Omega contract.");
    const selectedCode = await root.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("pre code")!);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.addEventListener("copy", () => { document.documentElement.dataset.contractCopy = window.getSelection()?.toString() ?? ""; }, { once: true });
      return window.getSelection()?.toString() ?? "";
    });
    expect(selectedCode.trimEnd()).toBe("const contract = 1;\nconsole.log(contract);");
    await page.keyboard.press("Control+c");
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.contractCopy)).toBe(selectedCode);
    const selectedNode = await root.locator("pre code").evaluateHandle((element) => element.firstChild);
    await root.locator("pre code").evaluate((element) => (element as HTMLElement).style.setProperty("--sambee-syntax-keyword", "rgb(1, 2, 3)"));
    await expect.poll(() => root.locator("pre code").evaluate((element) => {
      const name = [...CSS.highlights.keys()].find((name) => /^markdown-(?:syntax|retained)-/.test(name) && name.endsWith("-keyword"));
      return name ? getComputedStyle(element, `::highlight(${name})`).color : null;
    })).toBe("rgb(1, 2, 3)");
    expect(await root.locator("pre code").evaluate((element, node) => element.firstChild === node, selectedNode)).toBe(true);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selectedCode);
    await selectedNode.dispose();
    await root.locator("pre code").evaluate((element) => (element as HTMLElement).style.removeProperty("--sambee-syntax-keyword"));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const searchInput = page.getByPlaceholder("Search", { exact: true });
    await searchInput.fill("contract");
    await expect(page.getByText("1 / 4", { exact: true })).toBeVisible();
    await searchInput.press("Enter");
    await expect(page.getByText("2 / 4", { exact: true })).toBeVisible();
    await expect(searchInput).toBeFocused();
    const semantics = await root.ariaSnapshot();
    expect(semantics).toContain('heading "Viewer contract" [level=1]');
    expect(semantics).toContain('heading "Tail" [level=2]');
    expect(semantics).toContain("table:");
    if (testInfo.project.name === "chromium") {
      await page.emulateMedia({ media: "print" });
      await expect(root.getByRole("heading", { name: "Tail", exact: true })).toBeVisible();
      expect(await root.innerText()).toBe(text);
      const pdf = await page.pdf();
      expect(pdf.byteLength).toBeGreaterThan(1_000);
      await testInfo.attach("viewer-contract.pdf", { body: pdf, contentType: "application/pdf" });
    }
    await testInfo.attach("native-viewer-contracts.json", { body: JSON.stringify({ renderer: retainedRenderer ? "retained-test-only" : "react-markdown", text, selectAll, selectedCode, semantics, clipboardScope: "Trusted native copy event and exact selected text; OS clipboard payload and assistive-technology behavior remain manual gates." }, null, 2), contentType: "application/json" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(root).toHaveCount(0);
  });

  for (const width of [1543, 390]) {
    for (const fixture of fixtures) {
      test(`${fixture.name} at ${width}px preserves active search and selection`, async ({ page }, testInfo) => {
        test.setTimeout(90_000);
        const phases: { name: string; startTime: number; duration: number }[] = [];
        const phase = async (name: string, action: () => Promise<unknown>) => {
          const startTime = await page.evaluate(() => performance.now());
          await action();
          const endTime = await page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))));
          phases.push({ name, startTime, duration: endTime - startTime });
        };
        await page.setViewportSize({ width, height: 900 });
        await serveProductionAssets(page);
        await page.addInitScript(({ expectedBlocks }) => {
          const OriginalWorker = window.Worker;
          const pending: (() => void)[] = [];
          let held = true;
          let liveWorkers = 0;
          const longTasks: { startTime: number; duration: number }[] = [];
          const taskGaps: { startTime: number; duration: number }[] = [];
          const searchStages: { name: string; startTime: number; duration: number }[] = [];
          const syntaxStages: { name: string; startTime: number; duration: number }[] = [];
          const preparationStages: { name: string; startTime: number; duration: number }[] = [];
          const workerStages: { name: string; block: number; startTime: number; duration: number }[] = [];
          const navigationFrames: { action: string; startTime: number; duration: number; firstFrameMs: number }[] = [];
          const renderMilestones: { name: string; time: number }[] = [];
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              const resource = entry as PerformanceResourceTiming;
              if (/\/api\/viewer\/[^/]+\/file$/.test(new URL(resource.name).pathname)) {
                renderMilestones.push({ name: "source-response-end", time: resource.responseEnd });
              }
            }
          }).observe({ type: "resource", buffered: true });
          const initialCommit = new MutationObserver(() => {
            const root = document.querySelector('[data-markdown-search-root="true"]');
            if (root?.querySelectorAll("pre > code").length !== expectedBlocks) return;
            initialCommit.disconnect();
            renderMilestones.push({ name: "dom-commit-observed", time: performance.now() });
            requestAnimationFrame(() => {
              renderMilestones.push({ name: "first-frame", time: performance.now() });
              requestAnimationFrame(() => renderMilestones.push({ name: "second-frame", time: performance.now() }));
            });
          });
          initialCommit.observe(document, { childList: true, subtree: true });
          const keyboardFrames: { event: string; startTime: number; duration: number; firstFrameMs: number; eventAgeMs: number; value: string }[] = [];
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              if (entry.name.startsWith("sambee:preview-search:")) searchStages.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
              if (entry.name.startsWith("sambee:preview-syntax:")) syntaxStages.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
              if (entry.name.startsWith("sambee:preview-preparation:")) preparationStages.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
            }
          }).observe({ type: "measure", buffered: true });
          document.addEventListener("click", (event) => {
            const button = event.target instanceof Element ? event.target.closest("button") : null;
            const action = button?.getAttribute("aria-label");
            if (action !== "Next match" && action !== "Previous match") return;
            const startTime = performance.now();
            requestAnimationFrame(() => {
              const firstFrameMs = performance.now() - startTime;
              requestAnimationFrame(() => navigationFrames.push({ action, startTime, firstFrameMs, duration: performance.now() - startTime }));
            });
          }, true);
          for (const eventName of ["keydown", "input"]) {
            document.addEventListener(eventName, (event) => {
              const target = event.target;
              if (!(target instanceof HTMLInputElement) || target.placeholder !== "Search") return;
              const startTime = performance.now();
              const eventAgeMs = Math.max(0, startTime - event.timeStamp);
              const value = target.value;
              requestAnimationFrame(() => {
                const firstFrameMs = performance.now() - startTime;
                requestAnimationFrame(() => keyboardFrames.push({ event: eventName, startTime, firstFrameMs, eventAgeMs, duration: performance.now() - startTime, value }));
              });
            }, true);
          }
          const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
          if (longTasksSupported) {
            new PerformanceObserver((entries) => {
              for (const entry of entries.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration });
            }).observe({ type: "longtask", buffered: true });
          }
          let lastTask = performance.now();
          setInterval(() => {
            const now = performance.now();
            taskGaps.push({ startTime: lastTask, duration: now - lastTask });
            lastTask = now;
          }, 10);
          let heldNormalization = false;
          const pendingNormalization: (() => void)[] = [];
          let heldPublication = false;
          const pendingPublication: (() => void)[] = [];
          Object.assign(window, {
            syntaxResources: () => ({ liveWorkers, heldMessages: pending.length, heldNormalizationMessages: pendingNormalization.length, heldPublicationMessages: pendingPublication.length }),
            holdPublication: () => { heldPublication = true; },
            releasePublication: () => { heldPublication = false; for (const send of pendingPublication.splice(0)) send(); },
            holdNormalization: () => { heldNormalization = true; },
            releaseNormalization: () => { heldNormalization = false; for (const send of pendingNormalization.splice(0)) send(); },
            syntaxResponsiveness: () => ({ longTasksSupported, longTasks, taskGaps, searchStages, syntaxStages, preparationStages, workerStages, navigationFrames, renderMilestones, keyboardFrames, maximumTimerGapMs: Math.max(0, ...taskGaps.map((gap) => gap.duration)) }),
            holdSyntax: () => { held = true; },
            releaseSyntax: () => {
              held = false;
              for (const send of pending.splice(0)) send();
            },
          });
          window.Worker = class extends OriginalWorker {
            private disposed = false;
            private syntaxWorker: boolean;
            private documentWorker = false;
            private blocks = new Map<number, { source: number; final?: number; firstResult?: number }>();
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              this.syntaxWorker = String(url).includes("markdownSyntax.worker");
              liveWorkers += 1;
              this.addEventListener("message", (event) => {
                const response = event.data as { type?: string; block?: number };
                if (this.documentWorker && response.type === "complete") response.block = 0;
                if (response.block === undefined) return;
                const block = this.blocks.get(response.block);
                if (!block) return;
                const now = performance.now();
                if ((response.type === "ranges" || response.type === "complete") && block.firstResult === undefined) {
                  block.firstResult = now;
                  workerStages.push({ name: "final-source-to-first-result", block: response.block, startTime: block.final ?? block.source, duration: now - (block.final ?? block.source) });
                }
                if (response.type === "complete") {
                  workerStages.push({ name: "source-to-complete", block: response.block, startTime: block.source, duration: now - block.source });
                  this.blocks.delete(response.block);
                }
              });
            }
            terminate() {
              if (!this.disposed) liveWorkers -= 1;
              this.disposed = true;
              super.terminate();
            }
            postMessage(message: unknown, options?: StructuredSerializeOptions) {
              const kind = message as { type?: string; document?: boolean };
              if (kind.type === "prepare" && kind.document) this.documentWorker = true;
              const send = () => {
                if (this.disposed) return;
                const request = message as { type?: string; block?: number; final?: boolean };
                if ((this.syntaxWorker || this.documentWorker) && request.type === "source" && request.block !== undefined) {
                  const block = this.blocks.get(request.block) ?? { source: performance.now() };
                  if (request.final) block.final = performance.now();
                  this.blocks.set(request.block, block);
                }
                super.postMessage(message, options);
              };
              if (held && ((this.syntaxWorker && kind.type === "source") || (this.documentWorker && kind.type === "syntax-window"))) pending.push(send);
              else if (heldPublication && this.documentWorker && kind.type === "ack") pendingPublication.push(send);
              else if (heldNormalization && !this.syntaxWorker && !this.documentWorker && kind.type === "source") pendingNormalization.push(send);
              else send();
            }
          };
        }, { expectedBlocks: fixture.blocks });
        const text = fixture.name === "long-line" ? `${"let x=1; ".repeat(fixture.lines)}\n` : "let x=1;\n".repeat(fixture.lines);
        const markdown = Array.from({ length: fixture.blocks }, () => `\`\`\`js\n${text}\`\`\``).join("\n\n");
        await mockMarkdownViewerApi(page, { initialMarkdown: markdown });
        const started = Date.now();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        const heapSession = testInfo.project.name === "chromium" ? await page.context().newCDPSession(page) : null;
        await heapSession?.send("Performance.enable");
        if (collectMemory) await heapSession?.send("HeapProfiler.collectGarbage");
        const sampleHeap = async () => heapSession ? await heapSession.send("Runtime.getHeapUsage") : null;
        const sampleBrowserMetrics = async () => heapSession ? (await heapSession.send("Performance.getMetrics")).metrics.filter((metric) => ["LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "Nodes"].includes(metric.name)) : null;
        const browserMetrics = { beforeOpen: await sampleBrowserMetrics(), afterInitialRender: null as Awaited<ReturnType<typeof sampleBrowserMetrics>>, afterComplete: null as Awaited<ReturnType<typeof sampleBrowserMetrics>> };
        const memory = { scope: "Chromium renderer heap only; excludes worker heaps and aggregate native/DOM memory. Firefox unsupported. GC runs are separate from responsiveness trials.", controlledGC: collectMemory, browserMetrics, documentStats: null as { elements: number; textNodes: number; retained: unknown } | null, beforeOpen: await sampleHeap(), afterComplete: null as Awaited<ReturnType<typeof sampleHeap>>, afterClose: null as Awaited<ReturnType<typeof sampleHeap>>, afterCompleteGC: null as Awaited<ReturnType<typeof sampleHeap>>, afterCloseGC: null as Awaited<ReturnType<typeof sampleHeap>> };
        const root = page.locator('[data-markdown-search-root="true"]');
        await captureViewerScheduling(page, testInfo, async () => {
        await phase("initial-render-through-two-frames", async () => {
          await (width < 600
            ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })
            : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
          await expect(root.locator("pre > code")).toHaveCount(fixture.blocks);
          if (retainedRenderer) await expect(root.locator('[data-markdown-retained-state="complete"]')).toHaveCount(1);
        });
        const openMs = Date.now() - started;
        browserMetrics.afterInitialRender = await sampleBrowserMetrics();
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const searchControls = page.getByRole("button", { name: "Next match", exact: true }).locator("..");
        const searchStarted = Date.now();
        await phase("first-search-keyboard", async () => {
          await page.getByPlaceholder("Search", { exact: true }).pressSequentially("let x");
          await expect(searchControls.getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
          await expect.poll(() => page.evaluate(() => {
            const current = [...CSS.highlights.entries()].find(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current"));
            return current ? [...current[1]][0]?.toString() : null;
          })).toBe("let x");
        });
        const searchMs = Date.now() - searchStarted;
        const before = await root.evaluate((element) => {
          const code = element.querySelector("code")!;
          const node = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          Object.assign(window, { selectedSyntaxNode: node });
          return { selected: selection.toString(), text: element.textContent };
        });
        const publicationStarted = Date.now();
        await phase("syntax-release-with-active-search", async () => {
          await page.evaluate(() => (window as unknown as { releaseSyntax: () => void }).releaseSyntax());
          await expect.poll(() => page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => /^markdown-(?:syntax|retained)-/.test(name)).reduce((count, [, ranges]) => count + ranges.size, 0))).toBeGreaterThan(0);
        });
        const publicationMs = Date.now() - publicationStarted;
        const after = await root.evaluate((element) => ({
          text: element.textContent,
          selected: window.getSelection()!.toString(),
          retainedNode: element.contains((window as unknown as { selectedSyntaxNode: Node }).selectedSyntaxNode),
          ranges: [...CSS.highlights.entries()].filter(([name]) => /^markdown-(?:syntax|retained)-/.test(name)).reduce((count, [, ranges]) => count + ranges.size, 0),
          tokenSpans: element.querySelectorAll('[class*="sambee-syntax-"]').length,
          searchColors: [...CSS.highlights.keys()].filter((name) => name.startsWith("markdown-search-")).map((name) => ({
            name,
            background: getComputedStyle(element.querySelector("code")!, `::highlight(${name})`).backgroundColor,
          })),
        }));
        expect(after.text).toBe(before.text);
        expect(after.selected).toBe(before.selected);
        expect(after.retainedNode).toBe(true);
        expect(after.ranges).toBeLessThanOrEqual(viewportRangeLimit);
        expect(after.tokenSpans).toBe(0);
        expect(after.searchColors).toHaveLength(2);
        expect(new Set(after.searchColors.map((entry) => entry.background)).size).toBe(2);
        expect(after.searchColors.every((entry) => entry.background && entry.background !== "rgba(0, 0, 0, 0)")).toBe(true);
        await expect(root.locator("mark")).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("markdown-search-") && name.endsWith("-other")).reduce((count, [, ranges]) => count + ranges.size, 0))).toBeGreaterThan(0);
        expect(await page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("markdown-search-")).reduce((count, [, ranges]) => count + ranges.size, 0))).toBeLessThanOrEqual(1_001);
        await expect(searchControls.getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await phase("next-match", async () => {
          await page.getByRole("button", { name: "Next match", exact: true }).click();
          await expect(searchControls.getByText(`2 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
        });
        await phase("previous-match", async () => {
          await page.getByRole("button", { name: "Previous match", exact: true }).click();
          await expect(searchControls.getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
        });
        await phase("last-match-wrap", async () => {
          await page.getByRole("button", { name: "Previous match", exact: true }).click();
          await expect(searchControls.getByText(`${fixture.lines * fixture.blocks} / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
          const destination = await root.evaluate((element) => {
            const entry = [...CSS.highlights.entries()].find(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current"));
            const range = entry ? [...entry[1]][0] as Range : null;
            const rect = range?.getBoundingClientRect();
            const viewport = element.parentElement!.getBoundingClientRect();
            return { text: range?.toString(), visible: !!rect && rect.bottom >= viewport.top && rect.top <= viewport.bottom && rect.right >= viewport.left && rect.left <= viewport.right };
          });
          expect(destination).toEqual({ text: "let x", visible: true });
        });
        if (fixture.name === "long-line") {
          await expect.poll(() => page.evaluate(() => {
            const current = [...CSS.highlights.entries()].find(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current"));
            const active = current ? [...current[1]][0] as Range : null;
            if (!active) return false;
            return [...CSS.highlights.entries()].filter(([name]) => /^markdown-(?:syntax|retained)-/.test(name)).some(([, ranges]) => [...ranges].some((entry) => {
              const range = entry as Range;
                    return range.startContainer === active.startContainer && range.startOffset <= active.startOffset && range.endOffset > active.startOffset;
            }));
          })).toBe(true);
          expect(await page.evaluate(() => [...CSS.highlights.entries()].filter(([name]) => /^markdown-(?:syntax|retained)-/.test(name)).reduce((total, [, ranges]) => total + ranges.size, 0))).toBeLessThan(500);
        }
        await phase("scroll-with-active-search", async () => {
          await root.evaluate((element) => {
            const viewport = element.parentElement!;
            viewport.scrollTop = Math.max(0, viewport.scrollTop - viewport.clientHeight);
          });
          await expect(page.getByPlaceholder("Search", { exact: true })).toBeVisible();
        });
        await phase("changed-query", async () => {
          await page.getByPlaceholder("Search", { exact: true }).fill("x=1");
          await expect(searchControls.getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
          expect(await root.evaluate((element) => element.contains((window as unknown as { selectedSyntaxNode: Node }).selectedSyntaxNode))).toBe(true);
        });
        await phase("clear-query", async () => {
          await page.getByPlaceholder("Search", { exact: true }).fill("");
          await expect(root.locator("mark")).toHaveCount(0);
          expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((name) => name.startsWith("markdown-search-")).length)).toBe(0);
        });
        const responsiveness = await page.evaluate(() => (window as unknown as { syntaxResponsiveness: () => {
          searchStages: { name: string; startTime: number; duration: number }[];
          syntaxStages: { name: string; startTime: number; duration: number }[];
                  preparationStages: { name: string; startTime: number; duration: number }[];
          workerStages: { name: string; startTime: number; duration: number }[];
          navigationFrames: { action: string; startTime: number; duration: number; firstFrameMs: number }[];
          renderMilestones: { name: string; time: number }[];
          keyboardFrames: { event: string; startTime: number; duration: number; firstFrameMs: number; eventAgeMs: number; value: string }[];
        } }).syntaxResponsiveness());
        Object.assign(responsiveness, { measurementVersion: "scoped-controls-v2", traceRequested: process.env.SAMBEE_E2E_TRACE === "1", traceSupported: testInfo.project.name === "chromium" });
        for (const stage of ["capture", "matching", "presentation", "clear", "navigation-lookup", "navigation-publication", "navigation-geometry", "navigation-scroll"]) {
          expect(responsiveness.searchStages.some((entry) => entry.name === `sambee:preview-search:${stage}`)).toBe(true);
        }
        for (const stage of retainedRenderer ? [] : ["task", "viewport-geometry", "block-geometry", "mapping", "offset-geometry", "ranges", "publication"]) {
          expect(responsiveness.syntaxStages.some((entry) => entry.name === `sambee:preview-syntax:${stage}`)).toBe(true);
        }
        for (const stage of [
          "decode-elapsed",
          "load-normalization-elapsed",
          ...(retainedRenderer ? ["retained-document-complete"] : ["collection-walk", "render-parse", "render-transform", "hast-ready-to-layout-effect"]),
        ]) {
          expect(responsiveness.preparationStages.some((entry) => entry.name === `sambee:preview-preparation:${stage}`)).toBe(true);
        }
        expect(responsiveness.preparationStages.some((entry) => entry.name === "sambee:preview-preparation:collection-parse")).toBe(false);
        expect(responsiveness.workerStages.filter((entry) => entry.name === "source-to-complete")).toHaveLength(retainedRenderer ? 1 : fixture.blocks);
        expect(responsiveness.navigationFrames).toHaveLength(3);
        for (const milestone of ["source-response-end", "dom-commit-observed", "first-frame", "second-frame"]) {
          expect(responsiveness.renderMilestones.filter((entry) => entry.name === milestone)).toHaveLength(1);
        }
        expect(responsiveness.searchStages.filter((entry) => entry.name === "sambee:preview-search:capture")).toHaveLength(1);
        expect(responsiveness.searchStages.some((entry) => entry.name.endsWith(":markers") || entry.name.endsWith(":slices"))).toBe(false);
        expect(responsiveness.keyboardFrames.some((entry) => entry.event === "keydown")).toBe(true);
        expect(responsiveness.keyboardFrames.some((entry) => entry.event === "input" && entry.value === "let x")).toBe(true);
        for (const entry of [...responsiveness.keyboardFrames, ...responsiveness.navigationFrames]) {
          expect(Number.isFinite(entry.firstFrameMs) && entry.firstFrameMs >= 0 && entry.firstFrameMs <= entry.duration).toBe(true);
        }
        expect(responsiveness.keyboardFrames.every((entry) => Number.isFinite(entry.eventAgeMs) && entry.eventAgeMs >= 0)).toBe(true);
        memory.documentStats = await root.evaluate((element) => {
          const host = element.querySelector('[data-markdown-retained-root="true"]') as (HTMLElement & { retainedMarkdownStats?: () => unknown }) | null;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let textNodes = 0;
          while (walker.nextNode()) textNodes += 1;
          return { elements: element.querySelectorAll("*").length, textNodes, retained: host?.retainedMarkdownStats?.() ?? null };
        });
        if (retainedRenderer) {
          const stats = memory.documentStats.retained as { documentTimings: Record<string, number>; transportTimings: Record<string, number>; publicationRecords: number; batches: number; largestBatch: number; batchLimit: number; largestBatchUnits: number; batchUnitLimit: number; assemblyMs: number; largestAssemblyMs: number; frameWaitMs: number; viewportPaintMs: number; largestViewportPaintMs: number };
          expect(stats.documentTimings.records).toBe(stats.publicationRecords);
          expect(stats.documentTimings.batches).toBe(stats.batches);
          expect(stats.largestBatch).toBeLessThanOrEqual(stats.batchLimit);
          expect(stats.largestBatchUnits).toBeLessThanOrEqual(stats.batchUnitLimit);
          for (const duration of [...Object.values(stats.documentTimings), ...Object.values(stats.transportTimings), stats.assemblyMs, stats.largestAssemblyMs, stats.frameWaitMs, stats.viewportPaintMs, stats.largestViewportPaintMs]) {
            expect(Number.isFinite(duration) && duration >= 0).toBe(true);
          }
        }
        browserMetrics.afterComplete = await sampleBrowserMetrics();
        memory.afterComplete = await sampleHeap();
        await page.evaluate(() => Reflect.deleteProperty(window, "selectedSyntaxNode"));
        if (collectMemory) {
          await heapSession?.send("HeapProfiler.collectGarbage");
          memory.afterCompleteGC = await sampleHeap();
        }
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(root).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => [...CSS.highlights.keys()].filter((name) => /^markdown-(?:syntax|retained)-/.test(name)).length)).toBe(0);
        expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((name) => name.startsWith("markdown-search-")).length)).toBe(0);
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { liveWorkers: number } }).syntaxResources().liveWorkers)).toBe(0);
        memory.afterClose = await sampleHeap();
        if (collectMemory) {
          await heapSession?.send("HeapProfiler.collectGarbage");
          memory.afterCloseGC = await sampleHeap();
        }
        await heapSession?.detach();
        await page.evaluate(() => (window as unknown as { holdNormalization: () => void }).holdNormalization());
        await (width < 600
          ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })
          : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { heldNormalizationMessages: number } }).syntaxResources().heldNormalizationMessages)).toBeGreaterThan(0);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { liveWorkers: number } }).syntaxResources().liveWorkers)).toBe(0);
        await page.evaluate(() => (window as unknown as { releaseNormalization: () => void }).releaseNormalization());
        await expect(root).toHaveCount(0);
        await page.evaluate(() => (window as unknown as { holdSyntax: () => void }).holdSyntax());
        await (width < 600
          ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })
          : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { heldMessages: number } }).syntaxResources().heldMessages)).toBeGreaterThan(0);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { liveWorkers: number } }).syntaxResources().liveWorkers)).toBe(0);
        await page.evaluate(() => (window as unknown as { releaseSyntax: () => void }).releaseSyntax());
        await expect(root).toHaveCount(0);
        expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((name) => /^markdown-(?:syntax|retained)-/.test(name)).length)).toBe(0);
        if (retainedRenderer) {
          await page.evaluate(() => (window as unknown as { holdPublication: () => void }).holdPublication());
          await (width < 600 ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }) : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
          await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { heldPublicationMessages: number } }).syntaxResources().heldPublicationMessages)).toBeGreaterThan(0);
          await expect(root.locator('[data-markdown-retained-state="pending"]')).toHaveCount(1);
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResources: () => { liveWorkers: number } }).syntaxResources().liveWorkers)).toBe(0);
          await page.evaluate(() => (window as unknown as { releasePublication: () => void }).releasePublication());
          await expect(root).toHaveCount(0);
        }
        await testInfo.attach("publication-measurements", { body: JSON.stringify({ renderer: retainedRenderer ? "retained-test-only" : "react-markdown", fixture: fixture.name, width, openMs, searchMs, publicationMs, mountedRanges: after.ranges, phases, responsiveness, memory, timingScope: "Real viewer with production-built assets. Phases include Playwright synchronization and two frames. Search/syntax stages measure synchronous calls: geometry may force layout; publication does not include deferred paint. Load-normalization-elapsed and retained-document-complete include worker startup, transfer, parsing, acknowledgements, publication and scheduling; neither is main-thread CPU time. Default collection reuses the render tree and is included in render-transform time. Retained publication streams worker records without a second main-thread parse. Decode is asynchronous elapsed time. HAST-ready-to-layout-effect includes element construction, reconciliation, commit and scheduling, not isolated React CPU. Keyboard/navigation samples measure event-handler entry through two frames, not hardware input-to-visible-paint latency. Syntax worker round trips start after intentional holds and include transfer, scheduling, grammar loading and result acknowledgements, not isolated parser CPU.", }), contentType: "application/json", });
        });
      });
    }
  }
});

test("edit sessions can reopen immediately after release", async ({ page }) => {
  await mockMarkdownViewerApi(page, { initialMarkdown: "Immediate re-entry\n" });
  await openMarkdownViewer(page);

  await page.evaluate(async ({ connectionId, path }) => {
    const modulePath = "/src/services/storageBackends.ts";
    const { SambeeSmbBackend } = await import(modulePath);
    const target = { kind: "smb", connectionId };
    const source = {
      target,
      path,
      resolvedTarget: {
        target,
        connection: { access_mode: "read_write" },
        capabilitySnapshot: { companion: { status: "unavailable" } },
      },
    };
    const backend = new SambeeSmbBackend();
    const first = await backend.editing.begin(source);
    if (first.kind !== "acquired") throw new Error("Expected the first edit session to be acquired");
    await first.session.release();
    const second = await backend.editing.begin(source);
    if (second.kind !== "acquired") throw new Error("Expected immediate edit-session re-entry to succeed");
    await second.session.release();
  }, { connectionId: DEMO_CONNECTION_ID, path: DEMO_PATH });

  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("sambee:edit-lock:")))).toEqual([]);
});

for (const reloadKind of ["browser", "update"] as const) {
  test(`${reloadKind} reload resumes the existing Markdown edit lock`, async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: "Reload recovery\n", existingFilePaths: [DEMO_PATH] });
    let acquisitions = 0;
    let heartbeats = 0;
    await page.route((url) => url.pathname === `/api/browse/${DEMO_CONNECTION_ID}/lock`, async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      acquisitions += 1;
      if (acquisitions > 1) {
        await fulfillJson(route, { detail: "File is locked for editing by demo-admin" }, 409);
        return;
      }
      await fulfillJson(route, {
        lock_id: "reload-lock",
        lock_capability: "reload-capability",
        operation_id: "reload-operation",
        file_path: DEMO_PATH,
        locked_by: "demo-admin",
        locked_at: "2026-10-19T12:00:00Z",
      });
    });
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/lock/heartbeat*`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        lock_id: "reload-lock",
        lock_capability: "reload-capability",
        operation_id: "reload-operation",
      });
      heartbeats += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await openMarkdownViewer(page);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveAttribute("contenteditable", "true");
    if (reloadKind === "browser") {
      await page.reload();
    } else {
      await Promise.all([page.waitForEvent("domcontentloaded"), page.evaluate(() => window.location.reload())]);
    }
    await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveAttribute("contenteditable", "true");
    await expect(page).toHaveURL(/mode=edit/);
    expect(acquisitions).toBe(1);
    expect(heartbeats).toBeGreaterThanOrEqual(1);
    await expect(page.getByText(/Unable to enter edit mode/)).toHaveCount(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).not.toHaveURL(/mode=edit/);
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("sambee:edit-lock:")))).toEqual([]);
  });
}

for (const layout of ["desktop", "compact"] as const) {
  test(`${layout} Ctrl+D downloads the focused file`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello" });
    await page.goto("/browse/smb/demo");
    await page.getByTestId("file-list-container").press("ArrowDown");
    await expect(page.getByRole("button", { name: `File: ${DEMO_PATH}` })).toHaveAttribute("data-selected", "true");
    const downloadRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/viewer/download-intents/test-ticket");
    await page.keyboard.press("Control+d");
    expect((await downloadRequest).method()).toBe("GET");
  });

  test(`${layout} Ctrl+D downloads the current selection as a ZIP`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeDirectory: true });
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/download-selection`, async (route) => {
      await fulfillJson(route, { detail: "Download intentionally blocked in E2E" }, 503);
    });
    await page.goto("/browse/smb/demo");
    await page.getByTestId("file-list-container").focus();
    await page.keyboard.press("Control+a");
    const downloadRequest = page.waitForRequest((request) =>
      request.url().endsWith(`/api/browse/${DEMO_CONNECTION_ID}/download-selection`)
    );
    await page.keyboard.press("Control+d");
    const request = await downloadRequest;
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual(expect.arrayContaining([DEMO_PATH, DEMO_DIRECTORY]));
  });

  test(`${layout} Ctrl+D downloads a focused ZIP member`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeZip: true });
    await page.goto("/browse/smb/demo");
    await page.getByRole("button", { name: `File: ${DEMO_ARCHIVE}` }).click();
    await page.getByTestId("file-list-container").press("ArrowDown");
    await expect(page.getByRole("button", { name: "File: member.txt" })).toHaveAttribute("data-selected", "true");
    const downloadRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/viewer/download-intents");
    await page.keyboard.press("Control+d");
    expect((await downloadRequest).postDataJSON()).toMatchObject({ path: DEMO_ARCHIVE, member_path: "member.txt" });
  });

  test(`${layout} Ctrl+D asks for a selection when the file list is empty of selections`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello" });
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/list**`, async (route) => {
      await fulfillJson(route, { path: "/", items: [] });
    });
    await page.goto("/browse/smb/demo");
    await page.getByTestId("file-list-container").focus();
    await page.keyboard.press("Control+d");
    await expect(page.getByText("Select one or more items to download.")).toBeVisible();
  });

  test(`${layout} file menu dispatches a physical download request`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello" });
    const downloadRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/viewer/download-intents");
    await page.goto("/browse/smb/demo");
    if (layout === "compact") {
      await page.getByRole("button", { name: `More actions for ${DEMO_PATH}` }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByRole("button", { name: `File: ${DEMO_PATH}` }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    }
    expect((await downloadRequest).postDataJSON()).toMatchObject({ path: DEMO_PATH });
  });

  test(`${layout} directory download requests a temporary ZIP without saving`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeDirectory: true });
    const downloadRequest = page.waitForRequest((request) =>
      request.url().endsWith(`/api/browse/${DEMO_CONNECTION_ID}/download-selection`)
    );
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/download-selection`, async (route) => {
      await fulfillJson(route, { detail: "Download intentionally blocked in E2E" }, 503);
    });
    await page.goto("/browse/smb/demo");
    if (layout === "compact") {
      await page.getByRole("button", { name: `More actions for ${DEMO_DIRECTORY}` }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByRole("button", { name: `Folder: ${DEMO_DIRECTORY}` }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    }
    const request = await downloadRequest;
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual([DEMO_DIRECTORY]);
  });

  test(`${layout} ZIP member directory download requests a temporary archive`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeZip: true });
    const downloadRequest = page.waitForRequest((request) =>
      request.url().endsWith(`/api/browse/${DEMO_CONNECTION_ID}/archive/download-selection`)
    );
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/archive/download-selection`, async (route) => {
      await fulfillJson(route, { detail: "Download intentionally blocked in E2E" }, 503);
    });
    await page.goto("/browse/smb/demo");
    await page.getByRole("button", { name: `File: ${DEMO_ARCHIVE}` }).click();
    if (layout === "compact") {
      await page.getByRole("button", { name: `More actions for ${DEMO_DIRECTORY}` }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByRole("button", { name: `Folder: ${DEMO_DIRECTORY}` }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    }
    const request = await downloadRequest;
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toEqual({ archive_path: DEMO_ARCHIVE, paths: [DEMO_DIRECTORY] });
  });

  test(`${layout} ZIP file member download requests original content`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeZip: true });
    const downloadRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/viewer/download-intents");
    await page.goto("/browse/smb/demo");
    await page.getByRole("button", { name: `File: ${DEMO_ARCHIVE}` }).click();
    if (layout === "compact") {
      await page.getByRole("button", { name: "More actions for member.txt" }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByTestId("file-list-container").press("ArrowDown");
      await expect(page.getByRole("button", { name: "File: member.txt" })).toHaveAttribute("data-selected", "true");
      await page.getByRole("button", { name: "Download" }).click();
    }
    const request = await downloadRequest;
    expect(request.postDataJSON()).toMatchObject({ path: DEMO_ARCHIVE, member_path: "member.txt" });
  });

  test(`${layout} directory ZIP preparation reports a size-limit failure`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeDirectory: true });
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/download-selection`, async (route) => {
      await responseGate;
      await fulfillJson(route, { detail: "temporary_archive_size_limit_exceeded" }, 413);
    });
    await page.goto("/browse/smb/demo");
    if (layout === "compact") {
      await page.getByRole("button", { name: `More actions for ${DEMO_DIRECTORY}` }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByRole("button", { name: `Folder: ${DEMO_DIRECTORY}` }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    }
    await expect(page.getByText("Preparing download")).toBeVisible();
    releaseResponse();
    await expect(page.getByText("The selected ZIP exceeds the temporary download size limit.")).toBeVisible();
  });

  test(`${layout} cancels directory ZIP preparation before any download response`, async ({ page }) => {
    if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
    await mockMarkdownViewerApi(page, { initialMarkdown: "hello", includeDirectory: true });
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(`**/api/browse/${DEMO_CONNECTION_ID}/download-selection`, async (route) => {
      await responseGate;
      await route.abort("failed").catch(() => undefined);
    });
    await page.goto("/browse/smb/demo");
    if (layout === "compact") {
      await page.getByRole("button", { name: `More actions for ${DEMO_DIRECTORY}` }).click();
      await page.getByRole("menuitem", { name: "Download" }).click();
    } else {
      await page.getByRole("button", { name: `Folder: ${DEMO_DIRECTORY}` }).click({ button: "right" });
      await page.getByRole("button", { name: "Download" }).click();
    }
    await expect(page.getByText("Preparing download")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    releaseResponse();
    await expect(page.getByText("Preparing download")).toBeHidden();
  });
}

for (const layout of ["desktop", "compact"] as const) {
test(`${layout} Ctrl+U opens the upload picker for the active folder`, async ({ page }) => {
  if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    onTransferStream: async (route) => {
      await fulfillJson(route, { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } });
    },
  });
  await page.goto("/browse/smb/demo");
  await page.getByTestId("file-list-container").focus();
  const fileChooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Control+u");
  await (await fileChooser).setFiles({ name: "shortcut.txt", mimeType: "text/plain", buffer: Buffer.from("shortcut") });
  await expect(page.getByText("Uploaded 1 file")).toBeVisible();
});

test(`${layout} upload picker publishes two files in order`, async ({ page }) => {
  if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
  const uploadedPaths: string[] = [];
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    onTransferStream: async (route) => {
      const request = route.request();
      uploadedPaths.push(new URL(request.url()).searchParams.get("path") ?? "");
      expect(await request.headerValue("content-type")).toBe("application/octet-stream");
      await fulfillJson(route, { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } });
    },
  });
  await page.goto("/browse/smb/demo");
  const fileChooser = page.waitForEvent("filechooser");
  if (layout === "compact") {
    await page.getByRole("button", { name: "Create new item" }).click();
    await page.getByRole("menuitem", { name: "Upload" }).click();
  } else {
    await page.getByRole("button", { name: "Upload" }).click();
  }
  await (await fileChooser).setFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  await expect(page.getByText("Uploaded 2 files")).toBeVisible();
  expect(uploadedPaths).toEqual(["first.txt", "second.txt"]);
  await expect(page.getByText("Uploaded 2 files")).toBeHidden({ timeout: 8_000 });
});

test(`${layout} upload reports a failed file and continues the queue`, async ({ page }) => {
  if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
  const uploadedPaths: string[] = [];
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    onTransferStream: async (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? "";
      uploadedPaths.push(path);
      if (path === "first.txt") {
        await fulfillJson(route, { detail: "Temporary server error" }, 503);
      } else {
        await fulfillJson(route, { status: "completed", replaced: false, effects: { source: "unchanged", destination: "mutated" } });
      }
    },
  });
  await page.goto("/browse/smb/demo");
  const fileChooser = page.waitForEvent("filechooser");
  if (layout === "compact") {
    await page.getByRole("button", { name: "Create new item" }).click();
    await page.getByRole("menuitem", { name: "Upload" }).click();
  } else {
    await page.getByRole("button", { name: "Upload" }).click();
  }
  await (await fileChooser).setFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  await expect(page.getByText("Uploaded 1 file · 1 failed")).toBeVisible();
  expect(uploadedPaths).toEqual(["first.txt", "second.txt"]);
});

test(`${layout} upload resolves a conflict before publishing the next file`, async ({ page }) => {
  if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
  const attempts: string[] = [];
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    existingFilePaths: ["first.txt"],
    onTransferStream: async (route) => {
      const url = new URL(route.request().url());
      const path = url.searchParams.get("path") ?? "";
      const policy = url.searchParams.get("target_resolution_policy") ?? "";
      attempts.push(`${path}:${policy}`);
      if (path === "first.txt" && policy === "ask") {
        await fulfillJson(route, { detail: "Destination already exists" }, 409);
      } else {
        await fulfillJson(route, { status: "completed", replaced: policy === "replace", effects: { source: "unchanged", destination: "mutated" }, });
      }
    },
  });
  await page.goto("/browse/smb/demo");
  const fileChooser = page.waitForEvent("filechooser");
  if (layout === "compact") {
    await page.getByRole("button", { name: "Create new item" }).click();
    await page.getByRole("menuitem", { name: "Upload" }).click();
  } else {
    await page.getByRole("button", { name: "Upload" }).click();
  }
  await (await fileChooser).setFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  await page.getByRole("radio", { name: "Overwrite", exact: true }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Uploaded 2 files")).toBeVisible();
  expect(attempts).toEqual(["first.txt:ask", "first.txt:replace", "second.txt:ask"]);
});

test(`${layout} upload cancellation stops the queue and reports an uncertain current file`, async ({ page }) => {
  if (layout === "compact") await page.setViewportSize({ width: 390, height: 780 });
  const attempts: string[] = [];
  let releaseResponse: () => void = () => undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    onTransferStream: async (route) => {
      attempts.push(new URL(route.request().url()).searchParams.get("path") ?? "");
      await responseGate;
      await route.abort("failed").catch(() => undefined);
    },
  });
  await page.goto("/browse/smb/demo");
  const firstUpload = page.waitForRequest((request) => request.url().includes(`/api/browse/${DEMO_CONNECTION_ID}/transfer-stream`));
  const fileChooser = page.waitForEvent("filechooser");
  if (layout === "compact") {
    await page.getByRole("button", { name: "Create new item" }).click();
    await page.getByRole("menuitem", { name: "Upload" }).click();
  } else {
    await page.getByRole("button", { name: "Upload" }).click();
  }
  await (await fileChooser).setFiles([
    { name: "first.txt", mimeType: "text/plain", buffer: Buffer.from("first") },
    { name: "second.txt", mimeType: "text/plain", buffer: Buffer.from("second") },
  ]);
  await firstUpload;
  await expect(page.getByText(/Uploading first\.txt \(1\/2\) · (?:0 B|5 B) \/ 5 B/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  releaseResponse();
  await expect(page.getByText("Uploaded 0 files · 1 outcome uncertain, 1 cancelled")).toBeVisible();
  expect(attempts).toEqual(["first.txt"]);
});
}

async function enterMarkdownEditMode(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Markdown editor" }).waitFor();
}

async function enterMarkdownEditModeWithTable(page: Page): Promise<void> {
  await enterMarkdownEditMode(page);
  await page.locator(".tbl-table-widget").first().waitFor();
}

async function activateCellEditor(cellLocator: Locator): Promise<Locator> {
  await cellLocator.click();

  const cellRoot = cellLocator.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' tbl-cell ')][1]"
  );
  const nestedEditor = cellRoot.locator(".tbl-cell-editor .cm-content[role='textbox']");

  try {
    await nestedEditor.waitFor({ state: "visible", timeout: 1000 });
  } catch {
    await cellLocator.click();
    await nestedEditor.waitFor({ state: "visible" });
  }

  await nestedEditor.click();

  return nestedEditor;
}

async function getActiveCursorViewportPosition(editorRoot: Locator): Promise<{ position: "bottom" | "other" | "top" } | null> {
  return editorRoot.evaluate((root, edgeTolerance) => {
    const activeLine = root.querySelector(".cm-activeLine");
    const scroller = root.querySelector(".cm-scroller");

    if (!(activeLine instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      return null;
    }

    const activeLineRect = activeLine.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const activeLineIsFullyVisible =
      activeLineRect.top >= scrollerRect.top - edgeTolerance && activeLineRect.bottom <= scrollerRect.bottom + edgeTolerance;

    if (activeLineIsFullyVisible && activeLineRect.top <= scrollerRect.top + activeLineRect.height + edgeTolerance) {
      return { position: "top" as const };
    }

    if (activeLineIsFullyVisible && activeLineRect.bottom >= scrollerRect.bottom - activeLineRect.height - edgeTolerance) {
      return { position: "bottom" as const };
    }

    return { position: "other" as const };
  }, CURSOR_EDGE_TOLERANCE_PX);
}

async function getActiveLineScrollState(editorRoot: Locator): Promise<{ activeLineText: string; scrollTop: number } | null> {
  return editorRoot.evaluate((root) => {
    const activeLine = root.querySelector(".cm-activeLine");
    const scroller = root.querySelector(".cm-scroller");

    if (!(activeLine instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      return null;
    }

    return {
      activeLineText: activeLine.textContent ?? "",
      scrollTop: scroller.scrollTop,
    };
  });
}

async function setCaretToCellEnd(cellEditorLocator: Locator): Promise<void> {
  await cellEditorLocator.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Expected table cell editable to be an HTMLElement");
    }

    const selection = window.getSelection();

    if (!selection) {
      throw new Error("Expected a DOM selection");
    }

    selection.removeAllRanges();

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return (node.textContent?.length ?? 0) > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    let targetNode = walker.nextNode();
    let currentNode = targetNode;

    while (currentNode) {
      targetNode = currentNode;
      currentNode = walker.nextNode();
    }

    if (!(targetNode instanceof Text)) {
      throw new Error("Expected the table cell editable to contain text");
    }

    const range = document.createRange();
    range.setStart(targetNode, targetNode.textContent?.length ?? 0);
    range.collapse(true);
    selection.addRange(range);
    element.focus();
  });
}

test.describe("markdown viewer table editing", () => {
  test("saves Shift+Enter table-cell edits as canonical br tags and reopens cleanly", async ({ page }) => {
    const expectedSavedMarkdown = "alpha\n\n| Col 1 | Col 2 |\n| --- | --- |\n| A1<br />bar | B1 |\n| A2 | B2 |\n\nomega\n";
    const uploadBodies: string[] = [];

    await mockMarkdownViewerApi(page, {
      initialMarkdown: LINE_BREAK_MARKDOWN,
      onUploadBody: (body, setCurrentMarkdown) => {
        uploadBodies.push(body);
        setCurrentMarkdown(expectedSavedMarkdown);
      },
    });

    await openMarkdownViewer(page);
    await enterMarkdownEditModeWithTable(page);
    const targetCell = page.locator(".tbl-data-cell .tbl-cell-view").first();
    await targetCell.waitFor();
    const activeCellEditor = await activateCellEditor(targetCell);
    await setCaretToCellEnd(activeCellEditor);

    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("bar");
    await page.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => uploadBodies.length).toBe(1);
    expect(uploadBodies[0]).toContain("A1<br />bar");
    expect(uploadBodies[0]).not.toContain("A1&#10;bar");

    await page.reload();
    await openMarkdownViewer(page);
    await expect(page.getByRole("cell", { name: /A1\s+bar/ })).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  });

  test("keeps root-document search results and Mod-g navigation active while a table cell editor is focused", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: SEARCH_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditModeWithTable(page);
    const targetCell = page.locator(".tbl-data-cell .tbl-cell-view").first();
    await targetCell.waitFor();
    await activateCellEditor(targetCell);

    await page.getByRole("button", { name: "Search" }).click();
    await page.getByPlaceholder("Search").fill("alpha");

    await expect(page.getByText("0 / 4")).toBeVisible();

    await page.getByRole("button", { name: "Next match" }).click();
    await expect(page.getByText(/current match\..*on line 6\./)).toBeVisible();
    await expect(page.getByText("3 / 4")).toBeVisible();

    await page.getByRole("button", { name: "Previous match" }).click();
    await expect(page.getByText(/current match\..*on line 5\./)).toBeVisible();
    await expect(page.getByText("2 / 4")).toBeVisible();
  });
});

test.describe("markdown editor selection", () => {
  test("toggles word wrapping with Alt+Z", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: WRAPPED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    await expect(editor).toHaveClass(/cm-lineWrapping/);

    await editor.click();
    await page.keyboard.press("Alt+Z");
    await expect(editor).not.toHaveClass(/cm-lineWrapping/);

    await page.keyboard.press("Alt+Z");
    await expect(editor).toHaveClass(/cm-lineWrapping/);
  });

  test("keeps the caret at the document end after toggling word wrap", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: WRAPPED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Alt+Z");

    // Wait past the persistence cooldown and its settings-response render.
    await page.waitForTimeout(500);
    await page.keyboard.type("!");

    await expect(editor).toContainText("well.!");
  });

  test("keeps the end caret visible after the word-wrap settings response", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: SCROLLED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Alt+Z");

    // Wait past the persistence cooldown and its settings-response render.
    await page.waitForTimeout(500);

    await expect.poll(() =>
      editor.evaluate((content) => {
        const editorRoot = content.closest(".cm-editor");
        const scroller = editorRoot?.querySelector(".cm-scroller");
        const cursor = editorRoot?.querySelector(".cm-cursor");

        if (!(scroller instanceof HTMLElement) || !(cursor instanceof HTMLElement)) {
          return false;
        }

        const scrollerRect = scroller.getBoundingClientRect();
        const cursorRect = cursor.getBoundingClientRect();
        return cursorRect.top >= scrollerRect.top && cursorRect.bottom <= scrollerRect.bottom;
      })
    ).toBe(true);
  });

  test("keeps the right gutter visible at the end of an unwrapped long line", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: LONG_UNWRAPPED_LINE });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    await editor.click();
    await page.keyboard.press("Alt+Z");
    await page.keyboard.press("Control+End");

    await expect.poll(() =>
      editor.evaluate((content) => {
        const editorRoot = content.closest(".cm-editor");
        const scroller = editorRoot?.querySelector(".cm-scroller");
        const cursor = editorRoot?.querySelector(".cm-cursor");

        if (!(scroller instanceof HTMLElement) || !(cursor instanceof HTMLElement)) {
          return null;
        }

        const inset = Number.parseFloat(getComputedStyle(content).getPropertyValue("--sambee-codemirror-editor-horizontal-inset"));
        const scrollerRect = scroller.getBoundingClientRect();
        const cursorRect = cursor.getBoundingClientRect();
        return cursorRect.right <= scrollerRect.right - inset + 1;
      })
    ).toBe(true);
  });

  test("does not add artificial vertical space after a short document", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: "Short document" });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });

    await expect.poll(() =>
      editor.evaluate((content) => {
        const scroller = content.closest(".cm-editor")?.querySelector(".cm-scroller");

        if (!(scroller instanceof HTMLElement)) {
          return null;
        }

        return {
          hasInlineBottomPadding: content.style.paddingBottom.length > 0,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      })
    ).toEqual({ hasInlineBottomPadding: false, scrollHeight: expect.any(Number), clientHeight: expect.any(Number) });

    await expect(editor.evaluate((content) => {
      const scroller = content.closest(".cm-editor")?.querySelector(".cm-scroller");
      return scroller instanceof HTMLElement && scroller.scrollHeight === scroller.clientHeight;
    })).resolves.toBe(true);
  });

  test("keeps the cursor on a viewport edge while scrolling a wrapped editor with Ctrl+Arrow keys", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: SCROLLED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    const editorRoot = page.locator(".sambee-markdown-editor .cm-editor");
    const scroller = editorRoot.locator(".cm-scroller");
    await editor.click();

    await scroller.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      element.dispatchEvent(new Event("scroll"));
    });

    const scrollerBox = await scroller.boundingBox();

    if (!scrollerBox) {
      throw new Error("Expected Markdown editor scroller to be visible");
    }

    await page.mouse.click(scrollerBox.x + 80, scrollerBox.y + 8);
    const beforeScrollDown = await getActiveLineScrollState(editorRoot);

    if (!beforeScrollDown) {
      throw new Error("Expected an active line before scrolling down");
    }

    await page.keyboard.press("Control+ArrowDown");
    await page.keyboard.press("Control+ArrowDown");

    await expect.poll(() => getActiveLineScrollState(editorRoot)).not.toEqual(beforeScrollDown);
    const afterScrollDown = await getActiveLineScrollState(editorRoot);

    expect(afterScrollDown?.scrollTop).toBeGreaterThan(beforeScrollDown.scrollTop);
    expect(afterScrollDown?.activeLineText).not.toBe(beforeScrollDown.activeLineText);

    await expect.poll(() => getActiveCursorViewportPosition(editorRoot)).toEqual({ position: "top" });

    await scroller.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      element.dispatchEvent(new Event("scroll"));
    });

    await page.mouse.click(scrollerBox.x + 80, scrollerBox.y + scrollerBox.height - 8);
    const beforeScrollUp = await getActiveLineScrollState(editorRoot);

    if (!beforeScrollUp) {
      throw new Error("Expected an active line before scrolling up");
    }

    await page.keyboard.press("Control+ArrowUp");
    await page.keyboard.press("Control+ArrowUp");

    await expect.poll(() => getActiveLineScrollState(editorRoot)).not.toEqual(beforeScrollUp);
    const afterScrollUp = await getActiveLineScrollState(editorRoot);

    expect(afterScrollUp?.scrollTop).toBeLessThan(beforeScrollUp.scrollTop);
    expect(afterScrollUp?.activeLineText).not.toBe(beforeScrollUp.activeLineText);

    await expect.poll(() => getActiveCursorViewportPosition(editorRoot)).toEqual({ position: "bottom" });
  });

  test("keeps empty editor lines at the normal line height", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: "First line\n\nSecond line" });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    const editorRoot = page.locator(".sambee-markdown-editor .cm-editor");

    await expect.poll(() =>
      editor.evaluate((content) => {
        const lines = Array.from(content.querySelectorAll(".cm-line"));
        const nonEmptyLine = lines.find((line) => line.textContent === "First line");
        const emptyLine = lines.find((line) => line.textContent === "");

        if (!(nonEmptyLine instanceof HTMLElement) || !(emptyLine instanceof HTMLElement)) {
          return null;
        }

        return {
          emptyLineHeight: emptyLine.getBoundingClientRect().height,
          normalLineHeight: nonEmptyLine.getBoundingClientRect().height,
          emptyLineSpacer: getComputedStyle(emptyLine, "::after").content,
        };
      })
    ).toEqual({ emptyLineHeight: expect.any(Number), normalLineHeight: expect.any(Number), emptyLineSpacer: "none" });

    await expect(editor.evaluate((content) => {
      const lines = Array.from(content.querySelectorAll(".cm-line"));
      const nonEmptyLine = lines.find((line) => line.textContent === "First line");
      const emptyLine = lines.find((line) => line.textContent === "");
      return (
        nonEmptyLine instanceof HTMLElement &&
        emptyLine instanceof HTMLElement &&
        Math.abs(emptyLine.getBoundingClientRect().height - nonEmptyLine.getBoundingClientRect().height) < 1
      );
    })).resolves.toBe(true);

    await editor.click();
    await page.keyboard.press("Control+A");
    await expect(editor.evaluate((content) => {
      const line = content.querySelector(".cm-line");
      return line ? getComputedStyle(line, "::selection").backgroundColor : null;
    })).resolves.toBe("rgba(0, 0, 0, 0)");
    await expect(editorRoot.locator(".cm-layer .sambee-editor-selection-range").first()).toHaveCSS(
      "background-color",
      "rgb(241, 216, 200)"
    );
    await expect(editor.evaluate((content) => {
      const editorRoot = content.closest(".cm-editor");
      const emptyLine = Array.from(content.querySelectorAll(".cm-line")).find((line) => line.textContent === "");
      const markers = Array.from(editorRoot?.querySelectorAll(".sambee-editor-selection-range") ?? []);

      if (!(emptyLine instanceof HTMLElement) || markers.length === 0) {
        return false;
      }

      const lineRect = emptyLine.getBoundingClientRect();
      return markers.some((marker) => {
        const markerRect = marker.getBoundingClientRect();
        return Math.abs(markerRect.top - lineRect.top) < 0.1 && Math.abs(markerRect.bottom - lineRect.bottom) < 0.1;
      });
    })).resolves.toBe(true);
  });

  test("renders a character-tight wrapped selection", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: WRAPPED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    const editorRoot = page.locator(".sambee-markdown-editor .cm-editor");
    await editor.click();
    await page.keyboard.press("Control+A");

    await expect(page.locator(".cm-selectionLayer")).toHaveCount(1);
    await expect(page.locator(".sambee-editor-selection-layer")).toHaveCount(1);
    await expect(editorRoot.locator(".cm-content .sambee-editor-selection-range").first()).toBeVisible();
    await expect(editorRoot.locator(".cm-cursor-primary")).toBeVisible();
    await expect(editorRoot.locator(".cm-selectionBackground").first()).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(editorRoot.locator(".cm-activeLine")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(editor.evaluate((content) => {
      const line = content.querySelector(".cm-line");
      return line ? getComputedStyle(line, "::selection").backgroundColor : null;
    })).resolves.toBe("rgba(0, 0, 0, 0)");
    await expect(editorRoot.evaluate((root) => {
      const marker = root.querySelector(".cm-content .sambee-editor-selection-range");

      if (!(marker instanceof HTMLElement)) {
        return false;
      }

      const fragments = Array.from(marker.getClientRects());
      return fragments.length > 1 && fragments.slice(1).every((fragment, index) => fragment.top <= fragments[index].bottom);
    })).resolves.toBe(true);
    await expect(editor).toHaveScreenshot("wrapped-selection.png");

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+Shift+ArrowLeft");
    await expect(editorRoot.locator(".cm-content .sambee-editor-selection-range").first()).toBeVisible();
    await expect(editor).toHaveScreenshot("single-line-selection.png");

    await page.keyboard.press("ArrowRight");
    await page.keyboard.type("!");
    await expect(editor).toContainText("well.!");
  });

  test("keeps a selection visible after scrolling", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: SCROLLED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    const editorRoot = page.locator(".sambee-markdown-editor .cm-editor");
    const scroller = editorRoot.locator(".cm-scroller");
    await editor.click();
    await page.keyboard.press("Control+End");
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.keyboard.press("Control+Shift+ArrowLeft");

    const selectionInsideViewport = await editorRoot.evaluate((root) => {
      const selection = root.querySelector(".cm-content .sambee-editor-selection-range");
      const scrollContainer = root.querySelector(".cm-scroller");

      if (!(selection instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) {
        return false;
      }

      const scrollerRect = scrollContainer.getBoundingClientRect();
      const selectionRect = selection.getBoundingClientRect();
      return selectionRect.top >= scrollerRect.top && selectionRect.bottom <= scrollerRect.bottom;
    });

    expect(selectionInsideViewport).toBe(true);
  });

  test("keeps a document-spanning selection visible at the scroll viewport", async ({ page }) => {
    await mockMarkdownViewerApi(page, { initialMarkdown: SCROLLED_SELECTION_MARKDOWN });

    await openMarkdownViewer(page);
    await enterMarkdownEditMode(page);

    const editor = page.getByRole("textbox", { name: "Markdown editor" });
    const editorRoot = page.locator(".sambee-markdown-editor .cm-editor");
    const scroller = editorRoot.locator(".cm-scroller");

    await editor.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Control+Shift+End");

    await scroller.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      element.dispatchEvent(new Event("scroll"));
    });

    await expect.poll(() =>
      editorRoot.evaluate((root) => {
        const selection = root.querySelector(".cm-content .sambee-editor-selection-range");
        const activeLine = root.querySelector(".cm-activeLine");
        const scrollContainer = root.querySelector(".cm-scroller");

        if (!(selection instanceof HTMLElement) || !(activeLine instanceof HTMLElement) || !(scrollContainer instanceof HTMLElement)) {
          return null;
        }

        const scrollRect = scrollContainer.getBoundingClientRect();
        const viewportCenterY = scrollRect.top + scrollRect.height / 2;
        const selectionRect = Array.from(root.querySelectorAll(".cm-content .sambee-editor-selection-range")).find((marker) => {
          const markerRect = marker.getBoundingClientRect();
          return markerRect.top <= viewportCenterY && markerRect.bottom >= viewportCenterY;
        });

        if (!(selectionRect instanceof HTMLElement)) {
          return null;
        }

        return {
          coversViewportCenter: true,
          activeLineBackground: getComputedStyle(activeLine).backgroundColor,
        };
      })
    ).toEqual({ coversViewportCenter: true, activeLineBackground: "rgba(0, 0, 0, 0)" });
  });
});
