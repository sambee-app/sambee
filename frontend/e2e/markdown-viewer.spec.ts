import { expect, test, type BrowserContext, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { replaceAll as nativeReplaceAll, SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoredTheme } from "../src/services/api";
import { editableDefinition } from "../src/theme/themeDefinition";
import { builtInThemes } from "../src/theme/themes";
import { MARKDOWN_HEADING_ID_PREFIX } from "../src/utils/markdownHeadingLinks";
import { SOURCE_SEARCH_CHUNK_UNITS } from "../src/components/Editor/sourceRegexSearchProtocol";
import { evaluateSourceResponsivenessBudgets, evaluateSourceTypingBudgets, evaluateViewerReadinessBudgets, evaluateViewerTimingBudgets, VIEWER_TIMING_TARGETS_MS, type ViewerTimingSamples } from "./viewer-performance-budgets";

const DEMO_CONNECTION_ID = "85610f49-ab40-4d96-8750-ddab3e8e8764";
const DEMO_PATH = "note.md";
const DEMO_DIRECTORY = "Reports";
const DEMO_ARCHIVE = "sample.zip";
const DENSE_SYNTAX_LINE_COUNT = 6_000;
const DENSE_EXPANSION_REPLACEMENT_UNITS = 128;
const DENSE_EXPANSION_OUTPUT_UNITS = 780_000;
const SOURCE_TYPING_PAYLOAD = "abcdefghijklmnopqrst0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst012345";
const SOURCE_TYPING_KEY_DELAY_MS = 10;
const PROSE_ENVELOPE_PARAGRAPHS = 4_000;
const TABLE_ENVELOPE_ROWS = 2_400;
const TABLE_EDIT_PAYLOAD = "table edit";
const TABLE_EDIT_CASES = [
  { name: "first", row: 1, action: "type" },
  { name: "middle", row: TABLE_ENVELOPE_ROWS / 2, action: "type" },
  { name: "last", row: TABLE_ENVELOPE_ROWS, action: "type" },
  { name: "line-break", row: TABLE_ENVELOPE_ROWS / 2, action: "line-break" },
  { name: "composition", row: TABLE_ENVELOPE_ROWS / 2, action: "composition" },
  { name: "close-flush", row: TABLE_ENVELOPE_ROWS / 2, action: "close" },
  { name: "composition-close", row: TABLE_ENVELOPE_ROWS / 2, action: "composition-close" },
] as const;
const SCROLL_PROBE_STEPS = 60;
const NOMINAL_60HZ_SCROLL_TARGETS_MS = { p95: 16.7, maximum: 33.3 } as const;
const THEME_STATE_LINE_COUNT = 60;
const THEME_STATE_SCROLL = { top: 180, left: 36 };
const MIN_TEXT_CONTRAST_RATIO = 4.5;
const CACHE_PROOF_ORIGIN = "http://localhost:3000";
const CACHE_PROOF_ASSET_MAX_AGE_SECONDS = 31_536_000;
const PRODUCTION_ASSET_CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const SYNTAX_PUBLICATION_FIXTURES = [
  { name: "dense", blocks: 1, lines: DENSE_SYNTAX_LINE_COUNT },
  { name: "near-safeguard", blocks: 1, lines: 11_111 },
  { name: "host-envelope", blocks: 4, lines: DENSE_SYNTAX_LINE_COUNT },
  { name: "many-blocks", blocks: 600, lines: 101 },
  { name: "long-line", blocks: 1, lines: 6_000 },
] as const;

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
  filePath?: string;
  additionalFilePaths?: readonly string[];
  themeId?: () => string;
  wordWrapEnabled?: boolean;
  userRole?: "user" | "admin";
  includeDirectory?: boolean;
  includeZip?: boolean;
  existingFilePaths?: readonly string[];
  onTransferStream?: (route: Route) => Promise<void>;
  onUploadBody?: (body: string, setCurrentMarkdown: (markdown: string) => void) => void;
}

type ViewerApiRoute = Pick<Route, "fulfill"> & {
  request(): Pick<ReturnType<Route["request"]>, "url" | "method" | "postDataBuffer">;
};

async function fulfillJson(route: ViewerApiRoute, json: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(json),
  });
}

async function mockMarkdownViewerApi(page: Page, options: MockMarkdownViewerApiOptions): Promise<void> {
  const handler = createMarkdownViewerApiHandler(options);
  await page.route("**/api/**", async route => {
    const request = route.request();
    if (options.onTransferStream && new URL(request.url()).pathname === `/api/browse/${DEMO_CONNECTION_ID}/transfer-stream` && request.method() === "POST") return options.onTransferStream(route);
    await handler(route);
  });
}

function createMarkdownViewerApiHandler({ initialMarkdown, filePath = DEMO_PATH, additionalFilePaths = [], themeId = () => "sambee-light", wordWrapEnabled, userRole = "admin", includeDirectory, includeZip, existingFilePaths, onUploadBody }: MockMarkdownViewerApiOptions): (route: ViewerApiRoute) => Promise<void> {
  let currentMarkdown = initialMarkdown;

  return async (route) => {
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
        role: userRole,
        is_active: true,
      });
      return;
    }

    if (pathname === "/api/auth/oidc/refresh" && request.method() === "POST") {
      await fulfillJson(route, { access_token: "ci-browser-token", token_type: "bearer", username: "demo-admin", user_id: "user-1", role: "admin" });
      return;
    }

    if (pathname === "/api/auth/account" && request.method() === "GET") {
      await fulfillJson(route, {
        id: "user-1", username: "demo-admin", role: userRole, is_active: true,
        must_change_password: false, expires_at: null, created_at: "2026-04-12T12:00:00Z",
        has_local_password: true, identity_source: "local", password_change_available: true,
        password_change_required: false, browser_session_management_available: false,
        oidc_provider_name: null, current_session: null,
      });
      return;
    }

    if (pathname === "/api/themes" && request.method() === "GET") {
      await fulfillJson(route, { themes: [], site_default_id: "sambee-light" });
      return;
    }

    if (pathname === "/api/browse/recent-files" && request.method() === "POST") {
      await fulfillJson(route, null);
      return;
    }

    if (pathname.endsWith("/auth/me/settings") && request.method() === "GET") {
      await fulfillJson(route, {
        appearance: { theme_id: themeId(), custom_themes: [] },
        localization: { language: "browser", regional_locale: "browser" },
        browser: {
          quick_nav_include_dot_directories: false,
          quick_bar_shortcut_hint_visibility: "auto",
          file_browser_view_mode: "list",
          pane_mode: "single",
          selected_connection_id: null,
          viewer_associations: {},
        },
        text_editor: { max_file_size_bytes: 52428800, word_wrap_enabled: wordWrapEnabled ?? null },
      });
      return;
    }

    if (pathname.endsWith("/auth/me/settings") && request.method() === "PUT") {
      await fulfillJson(route, {
        appearance: { theme_id: themeId(), custom_themes: [] },
        localization: { language: "browser", regional_locale: "browser" },
        browser: {
          quick_nav_include_dot_directories: false,
          quick_bar_shortcut_hint_visibility: "auto",
          file_browser_view_mode: "list",
          pane_mode: "single",
          selected_connection_id: null,
          viewer_associations: {},
        },
        text_editor: { max_file_size_bytes: 52428800, word_wrap_enabled: wordWrapEnabled ?? null },
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
          ...[filePath, ...additionalFilePaths].map((entryPath) => ({
            name: entryPath,
            path: entryPath,
            type: "file",
            is_readable: true,
            size: currentMarkdown.length,
            mime_type: entryPath.endsWith(".md") ? "text/markdown" : "text/plain",
            modified_at: "2026-04-12T12:00:00Z",
          })),
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
        file_path: filePath,
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
        body: JSON.stringify({ path: filePath }),
      });
      return;
    }

    await fulfillJson(route, { detail: `Unhandled mocked route: ${request.method()} ${pathname}` }, 404);
  };
}

async function createCacheableViewerProxy(options: MockMarkdownViewerApiOptions) {
  const handler = createMarkdownViewerApiHandler(options);
  const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
  const requests: string[] = [];
  const errors: string[] = [];
  const uploads: { body: Buffer; contentType: string }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", CACHE_PROOF_ORIGIN);
      if (url.origin !== CACHE_PROOF_ORIGIN) {
        response.writeHead(403).end("Only the approved demo origin is supported");
        return;
      }
      requests.push(url.pathname);
      if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (url.pathname.endsWith("/upload") && request.method === "POST") {
          uploads.push({ body, contentType: request.headers["content-type"] ?? "" });
        }
        await handler({
          request: () => ({ url: () => url.href, method: () => request.method ?? "GET", postDataBuffer: () => body }),
          fulfill: async (result = {}) => {
            if (result.path || result.response) throw new Error("Cache proxy fixtures require an explicit body");
            const headers = { ...result.headers, "Cache-Control": "no-store", ...(result.contentType ? { "Content-Type": result.contentType } : {}) };
            response.writeHead(result.status ?? 200, headers);
            response.end(result.json === undefined ? result.body : JSON.stringify(result.json));
          },
        });
        return;
      }
      const path = url.pathname === "/browse/smb/demo" ? resolve(dist, "index.html") : resolve(dist, `.${url.pathname}`);
      if (!path.startsWith(`${dist}${sep}`)) {
        response.writeHead(403).end("Asset path is outside the production build");
        return;
      }
      try {
        const body = await readFile(path);
        response.writeHead(200, { "Content-Type": PRODUCTION_ASSET_CONTENT_TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": extname(path) === ".html" ? "no-store" : `public, max-age=${CACHE_PROOF_ASSET_MAX_AGE_SECONDS}, immutable` });
        response.end(body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        response.writeHead(404).end("Production asset not found");
      }
    })().catch(error => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end("Cache proof server failed; inspect its recorded errors");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cache proof proxy has no TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`, requests, errors, uploads,
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

async function openMarkdownViewer(page: Page): Promise<void> {
  await page.goto("/browse/smb/demo");
  await page.getByRole("button", { name: `File: ${DEMO_PATH}` }).click();
}

async function serveProductionAssets(page: Page, transformJavaScript?: (source: string, pathname: string) => string): Promise<void> {
  const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
  await page.route("http://localhost:3000/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) return route.fallback();
    const path = request.isNavigationRequest() ? resolve(dist, "index.html") : resolve(dist, `.${pathname}`);
    if (!path.startsWith(`${dist}${sep}`)) return route.abort();
    try {
      const body = await readFile(path);
      await route.fulfill({ body: transformJavaScript && extname(path) === ".js" ? transformJavaScript(body.toString("utf8"), pathname) : body, contentType: PRODUCTION_ASSET_CONTENT_TYPES[extname(path)] ?? "application/octet-stream" });
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

test.describe("production bundle loading", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");

  for (const width of [1543, 390]) {
    test(`loads settings categories at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await serveProductionAssets(page);
      await mockMarkdownViewerApi(page, { initialMarkdown: "# Preview\n" });
      await page.goto("/browse/smb/demo");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      if (width === 390) await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await page.getByText("Account", { exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your identity", exact: true })).toBeVisible();
      await page.goBack();
      await page.getByText("Account", { exact: true }).click();
      await expect(page.getByRole("heading", { name: "Your identity", exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test.describe("production shared syntax correctness", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  const fixtures = [
    { label: "js", filename: "sample.js", code: 'obj.key = [true, null, /x/, "\\n"];' },
    { label: "ts", filename: "sample.ts", code: 'const greet = (value: string): string => value; // end' },
    { label: "py", filename: "sample.py", code: 'print(True, None) # end' },
    { label: "sql", filename: "sample.sql", code: "SELECT count(*) FROM users WHERE id = 1; -- end" },
    { label: "sh", filename: "sample.sh", code: 'echo "hello" # end' },
    { label: "ps1", filename: "sample.ps1", code: '$sites = Get-Content $siteUrlFile; # end' },
    { label: "json", filename: "sample.json", code: '{"enabled": true, "value": null}' },
    { label: "c", filename: "sample.c", code: '#include <stdio.h> // end' },
    { label: "mssql", filename: null, code: "SELECT TOP 1 [account] FROM [users] WHERE [id] = @id; -- end" },
    { label: "mariadb", filename: null, code: "SELECT `account` FROM `users` LIMIT 1; # end" },
  ];
  const editorTokens = (editor: Locator, text: string) => editor.locator(".cm-line").evaluateAll((lines, source) => {
    const line = lines.find((element) => element.textContent === source);
    if (!line) return [];
    return [...line.querySelectorAll<HTMLElement>('span[class*="sambee-syntax-"]')].flatMap((span) => {
      const prefix = document.createRange();
      prefix.setStart(line, 0);
      prefix.setEnd(span, 0);
      const from = prefix.toString().length;
      return [...span.classList].filter((name) => name.startsWith("sambee-syntax-")).map((name) => ({
        from, to: from + (span.textContent?.length ?? 0), text: span.textContent ?? "", category: name.slice("sambee-syntax-".length),
      }));
    }).sort((left, right) => left.from - right.from || left.category.localeCompare(right.category));
  }, text);

  for (const width of [1543, 390]) {
    for (const fixture of fixtures) {
      test(`${fixture.label} across application surfaces at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await serveProductionAssets(page);
        let native: Awaited<ReturnType<typeof editorTokens>> | undefined;
        if (fixture.filename) {
          await mockMarkdownViewerApi(page, { initialMarkdown: fixture.code, filePath: fixture.filename, additionalFilePaths: [DEMO_PATH], existingFilePaths: [fixture.filename, DEMO_PATH] });
          await page.goto("/browse/smb/demo");
          await page.getByRole("button", { name: "Later", exact: true }).click();
          await page.getByRole("button").filter({ has: page.getByText(fixture.filename, { exact: true }) }).click();
          const editor = page.locator(".sambee-text-editor");
          await expect(editor.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
          await expect.poll(async () => (await editorTokens(editor, fixture.code)).length).toBeGreaterThan(0);
          native = await editorTokens(editor, fixture.code);
          await page.getByRole("button", { name: "Edit", exact: true }).click();
          await expect(editor.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
          await expect.poll(() => editorTokens(editor, fixture.code)).toEqual(native);
          await page.getByRole("button", { name: "Close", exact: true }).click();
        }

        const markdown = `# Source\n\nPlain paragraph\n\n\`\`\`${fixture.label}\n${fixture.code}\n\`\`\`\n\n\`\`\`unknown-fence\n*not prose*\n\`\`\`\n`;
        await mockMarkdownViewerApi(page, { initialMarkdown: markdown, existingFilePaths: [DEMO_PATH] });
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button").filter({ has: page.getByText(DEMO_PATH, { exact: true }) }).click();
        const root = page.locator('[data-markdown-search-root="true"]');
        const code = root.locator("pre code").first();
        await expect(code).toHaveText(`${fixture.code}\n`);
        const node = await code.evaluateHandle((element) => element.firstChild);
        const previewTokens = () => code.evaluate((element) => [...CSS.highlights].flatMap(([name, highlight]) => {
          if (!/^markdown-syntax-\d+-/.test(name)) return [];
          return [...highlight].filter((range) => element.contains(range.startContainer)).map((range) => ({
            from: range.startOffset, to: range.endOffset, text: range.toString(), category: name.replace(/^markdown-syntax-\d+-/, ""),
          }));
        }).sort((left, right) => left.from - right.from || left.category.localeCompare(right.category)));
        await expect.poll(async () => (await previewTokens()).length).toBeGreaterThan(0);
        const preview = await previewTokens();
        await code.evaluate((element) => { const pre = element.closest("pre")!; pre.scrollLeft = pre.scrollWidth; });
        await expect.poll(async () => Math.max(...(await previewTokens()).map((token) => token.to))).toBe(fixture.code.length);
        preview.push(...await previewTokens());
        expect(await code.evaluate((element, original) => element.firstChild === original, node)).toBe(true);
        await node.dispose();
        expect(await root.locator("pre code").last().evaluate((element) => [...CSS.highlights.values()].some((highlight) =>
          [...highlight].some((range) => element.contains(range.startContainer))))).toBe(false);
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const source = page.getByRole("textbox", { name: "Markdown editor" });
        await expect(source).toHaveAttribute("contenteditable", "true");
        await expect.poll(async () => (await editorTokens(source, fixture.code)).some((token) => token.to === fixture.code.length)).toBe(true);
        const expected = await editorTokens(source, fixture.code);
        const requiredCategories: Record<string, string[]> = {
          js: ["property", "boolean", "null", "regexp", "escape"],
          py: ["boolean", "null"], sh: ["builtin"], ps1: ["builtin", "identifier"],
          json: ["property", "boolean", "null"], c: ["metadata"],
        };
        expect(expected.map(token => token.category)).toEqual(expect.arrayContaining(requiredCategories[fixture.label] ?? []));
        if (native) expect(expected).toEqual(native);
        for (const fragment of preview) {
          expect(expected.some((token) => token.category === fragment.category && token.from <= fragment.from && token.to >= fragment.to)).toBe(true);
          expect(fragment.text).toBe(fixture.code.slice(fragment.from, fragment.to));
        }
        for (const token of expected) {
          let covered = token.from;
          for (const fragment of preview.filter((fragment) => fragment.category === token.category && fragment.to > token.from && fragment.from < token.to).sort((left, right) => left.from - right.from)) {
            expect(fragment.from).toBeLessThanOrEqual(covered);
            covered = Math.max(covered, fragment.to);
          }
          expect(covered).toBe(token.to);
        }
        await expect(source.locator(".sambee-syntax-heading").filter({ hasText: "Source" })).toHaveText(" Source");
        expect(await editorTokens(source, "Plain paragraph")).toEqual([]);
        expect(await editorTokens(source, "*not prose*")).toEqual([]);
        await page.getByRole("button", { name: "Close", exact: true }).click();
      });
    }
  }
});

test.describe("production nested syntax failures", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  for (const width of [1543, 390]) {
    for (const phase of ["load", "start", "advance", "pending-load"] as const) {
      for (const failedFirst of [true, false]) {
        test(`${phase}, failed first ${failedFirst}, at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          let injectFailure = true;
          const pendingMarker = "Injected pending Python grammar load";
          let pendingLoad = false;
          page.on("console", message => { if (message.text() === pendingMarker) pendingLoad = true; });
          await serveProductionAssets(page, (source, pathname) => injectFailure ? `${source}\n
import * as syntaxFaultModule from ${JSON.stringify(pathname)};
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope && typeof syntaxFaultModule.python === "function") {
  if (${JSON.stringify(phase)} === "pending-load") {
    console.debug(${JSON.stringify(pendingMarker)});
    await new Promise(() => {});
  }
  const parser = syntaxFaultModule.python().language.parser;
  const originalStart = parser.startParse;
  if (${JSON.stringify(phase)} === "load") throw new Error("Injected Python grammar load failure");
  parser.startParse = function (...args) {
    this.startParse = originalStart;
    if (${JSON.stringify(phase)} === "start") throw new Error("Injected Python parser startup failure");
    const partial = originalStart.apply(this, args);
    partial.advance = () => { throw new Error("Injected Python parser advance failure"); };
    return partial;
  };
}` : source);
          const failed = "def failed(): pass";
          const sibling = "const sibling = 1;";
          const healthy = "def healthy(): pass";
          const failedFence = `\`\`\`python\n${failed}\n\`\`\``;
          const healthyFence = `\`\`\`js\n${sibling}\n\`\`\``;
          let nested = `# Healthy heading\n\n${(failedFirst ? [failedFence, healthyFence] : [healthyFence, failedFence]).join("\n\n")}\n\n\`\`\`python\n${healthy}\n\`\`\``;
          for (const size of [4, 5, 6]) nested = `${"`".repeat(size)}markdown\n${nested}\n${"`".repeat(size)}`;
          const markdown = `\`\`\`\`\`\`\`markdown\n${nested}\n\`\`\`\`\`\`\`\n\n\`\`\`js\nconst independent = 1;\n\`\`\``;
          await mockMarkdownViewerApi(page, { initialMarkdown: markdown });
          await page.goto("/browse/smb/demo");
          await page.getByRole("button", { name: "Later", exact: true }).click();
          const open = () => page.getByRole("button").filter({ has: page.getByText(DEMO_PATH, { exact: true }) }).click();
          await open();
          const root = page.locator('[data-markdown-search-root="true"]');
          const code = root.locator("pre code").first();
          await expect(code).toHaveText(`${nested}\n`);
          const original = await code.evaluateHandle(element => element.firstChild);
          const tokens = () => code.evaluate(element => [...CSS.highlights].flatMap(([name, highlight]) => {
            if (!/^markdown-syntax-\d+-/.test(name)) return [];
            return [...highlight].filter(range => element.contains(range.startContainer)).map(range => ({ from: range.startOffset, to: range.endOffset, text: range.toString(), category: name.replace(/^markdown-syntax-\d+-/, "") }));
          }));
          const from = nested.indexOf(failed);
          if (phase === "pending-load") {
            await expect.poll(() => pendingLoad).toBe(true);
            expect(page.workers()).toHaveLength(1);
          } else {
            await expect.poll(tokens).toEqual(expect.arrayContaining([
              expect.objectContaining({ text: " Healthy heading", category: "heading" }),
              expect.objectContaining({ from: nested.indexOf(sibling), text: "const", category: "keyword" }),
            ]));
            expect((await tokens()).some(token => token.from < from + failed.length && token.to > from)).toBe(false);
            if (phase !== "load") expect(await tokens()).toEqual(expect.arrayContaining([expect.objectContaining({ from: nested.indexOf(healthy), text: "def", category: "keyword" })]));
            await expect.poll(() => root.locator("pre code").last().evaluate(element => [...CSS.highlights].some(([name, highlight]) => name.endsWith("-keyword") && [...highlight].some(range => element.contains(range.startContainer) && range.toString() === "const")))).toBe(true);
          }
          expect(await code.evaluate((element, original) => element.firstChild === original, original)).toBe(true);
          await original.dispose();
          await page.getByRole("button", { name: "Search", exact: true }).click();
          await page.getByPlaceholder("Search", { exact: true }).fill(failed);
          await expect(page.getByRole("button", { name: "Next match", exact: true }).locator("..").getByText("1 / 1", { exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await expect(root).toHaveCount(0);
          await expect.poll(() => page.workers().length).toBe(0);
          await expect.poll(() => page.evaluate(() => [...CSS.highlights.keys()].filter(name => name.startsWith("markdown-syntax-")).length)).toBe(0);
          injectFailure = false;
          await open();
          await expect(code).toHaveText(`${nested}\n`);
          await expect.poll(tokens).toEqual(expect.arrayContaining([expect.objectContaining({ from, text: "def", category: "keyword" })]));
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await expect(root).toHaveCount(0);
          await expect.poll(() => page.workers().length).toBe(0);
        });
      }
    }
    test(`nesting-depth safeguard preserves independent blocks at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await serveProductionAssets(page);
      let nested = "```js\nconst guarded = 1;\n```";
      for (const size of [4, 5, 6, 7]) nested = `${"`".repeat(size)}markdown\n${nested}\n${"`".repeat(size)}`;
      await mockMarkdownViewerApi(page, { initialMarkdown: `\`\`\`\`\`\`\`\`markdown\n${nested}\n\`\`\`\`\`\`\`\`\n\n\`\`\`js\nconst independent = 1;\n\`\`\`` });
      await page.goto("/browse/smb/demo");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      await page.getByRole("button").filter({ has: page.getByText(DEMO_PATH, { exact: true }) }).click();
      const root = page.locator('[data-markdown-search-root="true"]');
      const code = root.locator("pre code");
      await expect(code.first()).toHaveText(`${nested}\n`);
      await expect.poll(() => code.last().evaluate(element => [...CSS.highlights].some(([name, highlight]) => name.endsWith("-keyword") && [...highlight].some(range => element.contains(range.startContainer) && range.toString() === "const")))).toBe(true);
      expect(await code.first().evaluate(element => [...CSS.highlights.values()].some(highlight => [...highlight].some(range => element.contains(range.startContainer))))).toBe(false);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(root).toHaveCount(0);
      await expect.poll(() => page.workers().length).toBe(0);
      await expect.poll(() => page.evaluate(() => [...CSS.highlights.keys()].filter(name => name.startsWith("markdown-syntax-")).length)).toBe(0);
    });
  }
});

test.describe("production shared syntax theme identity", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  for (const width of [1543, 390]) {
    for (const kind of ["text", "markdown"] as const) {
    for (const editing of [false, true]) {
    test(`${kind} ${editing ? "edit" : "view"} live colors and browser state at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const grammarGate = "sambee-e2e-theme-grammar";
      const pendingContexts = new Set<string>();
      page.on("console", message => {
        if (message.text().startsWith(grammarGate)) pendingContexts.add(message.text().slice(grammarGate.length));
      });
      await serveProductionAssets(page, source => source.replace(/\.then\((\w+)=>\1\.javascript\(\)\)/g, `.then(async grammar => {
        const gate = new BroadcastChannel(${JSON.stringify(grammarGate)});
        await new Promise(resolve => {
          gate.onmessage = () => { gate.close(); resolve(); };
          console.debug(${JSON.stringify(grammarGate)} + (typeof document === "undefined" ? "worker" : "window"));
        });
        return grammar.javascript();
      })`));
      await page.addInitScript(() => {
        const OriginalWorker = window.Worker;
        const requests: string[] = [];
        const preparations: string[] = [];
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (/^sambee:preview-preparation:(?:render-parse|render-prepared-tree|render-transform|collection-walk)$/.test(entry.name)) preparations.push(entry.name);
          }
        }).observe({ entryTypes: ["measure"] });
        Object.assign(window, { themeWorkerRequests: requests, themePreparationStages: preparations });
        window.Worker = class extends OriginalWorker {
          postMessage(message: unknown, transfer?: Transferable[]) {
            requests.push(`${(message as { type?: string }).type}`);
            super.postMessage(message, transfer ?? []);
          }
        };
      });
      const code = Array.from({ length: THEME_STATE_LINE_COUNT }, (_, index) => `const alpha = "hello ${index} ${"wide ".repeat(100)}"; let beta = 1;`).join("\n");
      let themeId = "sambee-light";
      const custom = structuredClone(builtInThemes.find((theme) => theme.id === "sambee-dark")!);
      custom.id = "syntax-alpha";
      custom.name = "Syntax alpha";
      custom.components!.syntax!.keyword = "#c8f5d9bb";
      const themes = [...builtInThemes.filter((theme) => theme.id === "sambee-light" || theme.id === "sambee-dark"), custom];
      const filePath = kind === "text" ? "sample.js" : DEMO_PATH;
      const [version, gitCommit] = await Promise.all([
        readFile(new URL("../../VERSION", import.meta.url), "utf8"),
        readFile(new URL("../../GIT_COMMIT", import.meta.url), "utf8"),
      ]);
      const installThemeRoutes = async () => {
        await page.route("**/api/themes", (route) => fulfillJson(route, {
          site_default_id: "sambee-light",
          themes: [{ id: custom.id, definition: custom, scope: "user", version: 1 }],
        }));
        await page.route("**/api/version", (route) => fulfillJson(route, {
          version: version.trim(), git_commit: gitCommit.trim(), build_time: "2026-10-22T00:00:00Z",
        }));
      };
      await mockMarkdownViewerApi(page, {
        initialMarkdown: kind === "text" ? code : `\`\`\`js\n${code}\n\`\`\``, filePath,
        existingFilePaths: [filePath], themeId: () => themeId, wordWrapEnabled: false,
      });
      await installThemeRoutes();
      await page.addLocatorHandler(page.getByRole("dialog", { name: "Update available" }), async (dialog) => {
        await dialog.getByRole("button", { name: "Later", exact: true }).click();
      });
      await page.goto("/browse/smb/demo");
      const file = page.getByRole("button", { name: filePath, exact: true }).or(page.getByRole("button", { name: `File: ${filePath}`, exact: true }));
      await file.click();
      if (editing) await page.getByRole("button", { name: "Edit", exact: true }).click();

      const checkThemes = async (surface: Locator, preview: boolean) => {
        const hasSyntax = () => surface.evaluate((element, isPreview) => isPreview
          ? [...CSS.highlights].some(([name, highlight]) => name.endsWith("-keyword") && [...highlight].some((range) => element.contains(range.startContainer)))
          : !!element.querySelector(".sambee-syntax-keyword"), preview);
        await expect.poll(() => pendingContexts.has(preview ? "worker" : "window")).toBe(true);
        expect(await hasSyntax()).toBe(false);
        const searchInput = preview ? page.getByPlaceholder("Search", { exact: true }) : page.getByRole("textbox", { name: "Find", exact: true });
        if (!(await searchInput.isVisible())) await page.getByRole("button", { name: "Search", exact: true }).click();
        await searchInput.fill("const");
        const searchControls = preview ? page.getByRole("button", { name: "Next match", exact: true }).locator("..") : page.getByTestId("code-mirror-find-replace-popover");
        await expect(searchControls.getByText(new RegExp(`^[01] / ${THEME_STATE_LINE_COUNT}$`), { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Next match", exact: true }).click();
        await surface.focus();
        const editable = await surface.getAttribute("contenteditable") === "true";
        if (editable) {
          await surface.press("Control+Home");
          if (kind === "markdown") { await surface.press("ArrowDown"); await surface.press("Home"); }
          for (let index = 0; index < "const".length; index += 1) await surface.press("Shift+ArrowRight");
        }
        await surface.evaluate((element, { preview, editable }) => {
          if (!editable) {
            const range = document.createRange();
            const walker = document.createTreeWalker(element.querySelector(preview ? "code" : ".cm-line")!, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node && !node.textContent!.includes("const")) node = walker.nextNode();
            const from = node!.textContent!.indexOf("const");
            range.setStart(node!, from);
            range.setEnd(node!, from + "const".length);
            window.getSelection()!.removeAllRanges();
            window.getSelection()!.addRange(range);
          }
        }, { preview, editable });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await surface.evaluate((element, { preview, scroll }) => {
          const scroller = preview ? element.parentElement! : element.closest(".cm-scroller")!;
          scroller.scrollTop = scroll.top;
          let horizontal = preview ? element.querySelector("pre")! : scroller;
          while (horizontal.parentElement && horizontal.scrollWidth <= horizontal.clientWidth) horizontal = horizontal.parentElement;
          horizontal.scrollLeft = scroll.left;
        }, { preview, scroll: THEME_STATE_SCROLL });
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const browserState = () => surface.evaluate((element, preview) => {
          const selection = window.getSelection()!;
          const offset = (node: Node | null, offset: number) => {
            if (!node || !element.contains(node)) return null;
            const range = document.createRange();
            range.selectNodeContents(element);
            range.setEnd(node, offset);
            return range.toString().length;
          };
          const scroller = preview ? element.parentElement! : element.closest(".cm-scroller")!;
          let horizontal = preview ? element.querySelector("pre")! : scroller;
          while (horizontal.parentElement && horizontal.scrollWidth <= horizontal.clientWidth) horizontal = horizontal.parentElement;
          return {
            selected: selection.toString(), anchor: offset(selection.anchorNode, selection.anchorOffset), head: offset(selection.focusNode, selection.focusOffset),
            top: scroller.scrollTop, left: horizontal.scrollLeft,
            active: preview ? [...CSS.highlights].filter(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current")).flatMap(([, ranges]) => [...ranges].map(range => ({ text: range.toString(), from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset) })))
              : [...element.querySelectorAll(".cm-searchMatch-selected, .sambee-passive-search-match-selected")].map(match => ({ text: match.textContent })),
            requests: [...(window as unknown as { themeWorkerRequests: string[] }).themeWorkerRequests],
            renders: [...(window as unknown as { themePreparationStages: string[] }).themePreparationStages],
          };
        }, preview);
        const initialState = await browserState();
        expect(initialState.selected).toBe("const");
        expect(initialState.top).toBeGreaterThan(0);
        expect(initialState.left).toBeGreaterThan(0);
        expect(initialState.active).toHaveLength(1);
        const rootBeforeGrammar = await surface.elementHandle();
        const textBeforeGrammar = await surface.textContent();
        const previewNode = preview ? await surface.evaluateHandle(element => element.querySelector("code")!.firstChild) : undefined;
        await page.evaluate(channel => {
          const gate = new BroadcastChannel(channel);
          gate.postMessage("release");
          gate.close();
        }, grammarGate);
        await expect.poll(hasSyntax).toBe(true);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const afterGrammar = await browserState();
        await testInfo.attach("late-grammar-state.json", { body: JSON.stringify({ before: initialState, after: afterGrammar }), contentType: "application/json" });
        expect({ ...afterGrammar, requests: [] }).toEqual({ ...initialState, requests: [] });
        expect(afterGrammar.requests.filter(type => type === "start" || type === "source")).toEqual(initialState.requests.filter(type => type === "start" || type === "source"));
        expect(await surface.evaluate((element, original) => element === original, rootBeforeGrammar)).toBe(true);
        expect(await surface.textContent()).toBe(textBeforeGrammar);
        if (previewNode) {
          expect(await surface.evaluate((element, original) => element.querySelector("code")!.firstChild === original, previewNode)).toBe(true);
          await previewNode.dispose();
        }
        await rootBeforeGrammar?.dispose();
        const settledState = afterGrammar;
        const initialCount = await searchControls.textContent();
        const original = await surface.elementHandle();
        const text = await surface.textContent();
        const selector = preview ? "code" : ".cm-line";
        const node = await surface.evaluateHandle((element, selector) => element.querySelector(selector)!.firstChild, selector);
        const initialWorkers = page.workers();
        for (const theme of themes) {
          themeId = theme.id;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          const expected = theme.components!.syntax!.keyword;
          await expect.poll(() => surface.evaluate((element, { preview, expected }) => {
            const target = preview ? element.querySelector("code")! : [...element.querySelectorAll(".sambee-syntax-keyword")].find(token => !token.closest(".cm-searchMatch, .sambee-passive-search-match") && !token.querySelector(".cm-searchMatch, .sambee-passive-search-match"))!;
            const name = preview ? [...CSS.highlights].find(([name, highlight]) => name.endsWith("-keyword") && [...highlight].some((range) => target.contains(range.startContainer)))?.[0] : undefined;
            const reference = document.createElement("span");
            reference.style.color = expected;
            document.body.append(reference);
            const desired = getComputedStyle(reference).color;
            reference.remove();
            return getComputedStyle(target, name ? `::highlight(${name})` : null).color === desired;
          }, { preview, expected })).toBe(true);
          expect(await browserState()).toEqual(settledState);
          expect(await searchControls.textContent()).toBe(initialCount);
          const contrast = await surface.evaluate((element, preview) => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true })!;
            const parse = (color: string) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              return [...context.getImageData(0, 0, 1, 1).data].map((channel, index) => index === 3 ? channel / 255 : channel);
            };
            const over = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3])).concat(1);
            const background = (target: Element) => {
              const ancestors: Element[] = [];
              for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
              return ancestors.reduce((color, ancestor) => over(parse(getComputedStyle(ancestor).backgroundColor), color), [255, 255, 255, 1]);
            };
            const luminance = (color: number[]) => color.slice(0, 3).map(channel => channel / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
            const ratio = (foreground: number[], background: number[]) => {
              const values = [luminance(over(foreground, background)), luminance(background)].sort((first, second) => second - first);
              return (values[0] + 0.05) / (values[1] + 0.05);
            };
            const target = preview ? element.querySelector("code")! : [...element.querySelectorAll(".sambee-syntax-keyword")].find(token => !token.closest(".cm-searchMatch, .sambee-passive-search-match") && !token.querySelector(".cm-searchMatch, .sambee-passive-search-match"))!;
            const base = background(target);
            const results: { role: string; ratio: number }[] = [];
            const syntaxName = preview ? [...CSS.highlights.keys()].find(name => /^markdown-syntax-\d+-keyword$/.test(name)) : undefined;
            results.push({ role: "keyword", ratio: ratio(parse(getComputedStyle(target, syntaxName ? `::highlight(${syntaxName})` : null).color), base) });
            const searchTargets = preview
              ? [...CSS.highlights.keys()].filter(name => name.startsWith("markdown-search-")).map(name => ({ role: name.endsWith("-current") ? "current-search" : "other-search", target, style: getComputedStyle(target, `::highlight(${name})`) }))
              : [...element.querySelectorAll(".cm-searchMatch, .sambee-passive-search-match")].slice(0, 3).map(match => ({ role: match.className.includes("selected") ? "current-search" : "other-search", target: match, style: getComputedStyle(match) }));
            for (const match of searchTargets) {
              const backdrop = over(parse(match.style.backgroundColor), background(match.target.parentElement!));
              results.push({ role: match.role, ratio: ratio(parse(match.style.color), backdrop) });
            }
            const selected = element.querySelector(".sambee-editor-selection-range");
            const selectionTarget = selected ?? target;
            const selectionStyle = getComputedStyle(selectionTarget, selected ? null : "::selection");
            const selectionBackground = over(parse(selectionStyle.backgroundColor), background(selectionTarget.parentElement!));
            results.push({ role: "selection", ratio: ratio(parse(selectionStyle.color), selectionBackground) });
            return results;
          }, preview);
          await testInfo.attach(`${theme.id}-contrast.json`, { body: JSON.stringify({ kind, editing, width, contrast, state: await browserState() }), contentType: "application/json" });
          for (const sample of contrast) expect(sample.ratio, `${kind}/${preview ? "preview" : "source"}/${theme.id}/${sample.role}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST_RATIO);
          expect(await surface.evaluate((element, original) => element === original, original)).toBe(true);
          expect(await surface.evaluate((element, { node, selector }) => element.querySelector(selector)!.firstChild === node, { node, selector })).toBe(true);
          expect(await surface.textContent()).toBe(text);
          expect(page.workers()).toEqual(initialWorkers);
          expect(await surface.evaluate((element) => {
            const probe = document.createElement("span");
            probe.className = "sambee-syntax-keyword";
            probe.style.setProperty("--sambee-syntax-keyword", "rgb(225, 0, 102)");
            element.parentElement!.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          })).toBe("rgb(225, 0, 102)");
        }
        await node.dispose();
        await original?.dispose();
        if (preview) await page.getByRole("button", { name: "Close search", exact: true }).click();
        else {
          await searchControls.getByRole("button", { name: "Close", exact: true }).click();
          await expect(searchControls).toBeHidden();
        }
      };

      const preview = kind === "markdown" && !editing;
      const surface = preview ? page.locator('[data-markdown-search-root="true"]') : page.getByRole("textbox", { name: kind === "text" ? "Text editor" : "Markdown editor" });
      await checkThemes(surface, preview);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      if (editing) {
        await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();
      }
      await expect(surface).toHaveCount(0);
      await expect(page).toHaveURL("/browse/smb/demo");
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
      await expect(file).toBeVisible();
      await expect.poll(() => page.workers().length).toBe(0);
    });
    }
    }
  }
});

test.describe("production syntax theme dialog", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");

  async function openEditor(page: Page, width: number, mode: "light" | "dark", target: "user" | "site" | "built-in" = "user", isAdmin = true) {
    await page.setViewportSize({ width, height: width < 600 ? 600 : 900 });
    await serveProductionAssets(page);
    const selected: StoredTheme = {
      id: target === "site" ? "dialog-site" : "dialog-personal", scope: target === "site" ? "site" : "user", version: 3,
      definition: { ...editableDefinition(builtInThemes.find(theme => theme.mode === mode)!), name: "Dialog theme" },
    };
    const base = builtInThemes.find(theme => theme.mode === mode)!;
    const selectedId = target === "built-in" ? base.id : selected.id;
    const selectedName = target === "built-in" ? base.name : selected.definition.name;
    const storedThemes: StoredTheme[] = target === "built-in" ? [] : [selected];
    const writes: { method: string; path: string; body: unknown }[] = [];
    const settingsWrites: unknown[] = [];
    let nextFailure: { status: number; detail: string } | undefined;
    await mockMarkdownViewerApi(page, { initialMarkdown: "# Theme dialog fixture", themeId: () => selectedId, userRole: isAdmin ? "admin" : "user" });
    const [version, gitCommit] = await Promise.all([
      readFile(new URL("../../VERSION", import.meta.url), "utf8"),
      readFile(new URL("../../GIT_COMMIT", import.meta.url), "utf8"),
    ]);
    await page.route("**/api/version", route => fulfillJson(route, {
      version: version.trim(), git_commit: gitCommit.trim(), build_time: "2026-10-22T00:00:00Z",
    }));
    await page.route("**/api/auth/me/settings", async route => {
      if (route.request().method() !== "PUT") return route.fallback();
      const update = route.request().postDataJSON();
      if (update.field === "appearance.theme_id") settingsWrites.push(update);
      await route.fallback();
    });
    await page.route("**/api/themes**", async route => {
      const request = route.request();
      if (request.method() === "GET") return fulfillJson(route, { site_default_id: "sambee-light", themes: storedThemes });
      const body = request.postDataJSON();
      const path = new URL(request.url()).pathname;
      writes.push({ method: request.method(), path, body });
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = undefined;
        return fulfillJson(route, { detail: failure.detail }, failure.status);
      }
      if (request.method() === "POST" && path === "/api/themes") {
        const created: StoredTheme = { id: `dialog-copy-${writes.length}`, scope: body.scope, version: 1, definition: body.definition };
        storedThemes.push(created);
        return fulfillJson(route, created);
      }
      if (request.method() !== "PUT" || path !== `/api/themes/${selected.id}`) return fulfillJson(route, { detail: "Unexpected theme write" }, 400);
      selected.definition = body.definition;
      selected.version += 1;
      await fulfillJson(route, selected);
    });
    await page.addLocatorHandler(page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Update available", exact: true }) }), async dialog => {
      await dialog.getByRole("button", { name: "Later", exact: true }).click();
    });
    await page.goto("/browse/smb/demo");
    if (width < 600) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    if (width < 600) await page.getByRole("list").getByText("Appearance", { exact: true }).click();
    else await page.getByRole("listbox", { name: "Settings categories", exact: true }).getByText("Appearance", { exact: true }).click();
    const selectedRadio = page.getByText(target === "site" ? "Site themes" : target === "user" ? "Your themes" : "Built-in themes", { exact: true }).locator("..").getByRole("radio", { name: selectedName, exact: true });
    await expect(selectedRadio).toBeChecked();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: `Edit ${selectedName} (${target === "user" ? "personal" : target})`, exact: true }) });
    await expect(editor).toBeVisible();
    return { editor, selected, selectedName, selectedRadio, storedThemes, writes, settingsWrites,
      rejectNextWrite: (status: number, detail: string) => { nextFailure = { status, detail }; },
    };
  }

  for (const width of [1543, 390]) {
    for (const mode of ["light", "dark"] as const) {
    for (const target of ["user", "site"] as const) {
      test(`${target === "user" ? "personal" : "site"} ${mode} syntax cancel, validation and versioned save at ${width}px`, async ({ page }) => {
        const { editor, selected, selectedRadio, writes, settingsWrites } = await openEditor(page, width, mode, target, target === "site");
        const original = structuredClone(selected.definition);
        const expandSyntax = () => editor.getByRole("button", { name: "Syntax", exact: true }).click();
        await expandSyntax();
        await editor.getByRole("button", { name: "Choose Keyword color", exact: true }).click();
        await expect(page.locator(".react-colorful__alpha")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.locator(".react-colorful__alpha")).toHaveCount(0);
        const keyword = editor.getByRole("textbox", { name: "Keyword", exact: true });
        const punctuation = editor.getByRole("textbox", { name: "Punctuation", exact: true });
        await punctuation.scrollIntoViewIfNeeded();
        await expect(punctuation).toBeInViewport();
        const actions = await Promise.all(["Import", "Export", "Cancel", "Save copy", "Save"].map(async name => {
          const button = editor.getByRole("button", { name, exact: true });
          await expect(button).toBeInViewport();
          return (await button.boundingBox())!;
        }));
        const field = (await punctuation.boundingBox())!;
        expect(field.y + field.height).toBeLessThanOrEqual(Math.min(...actions.map(action => action.y)));
        await keyword.fill("#12345678");
        expect(writes).toEqual([]);
        expect(selected.definition).toEqual(original);
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(editor).toHaveCount(0);
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const name = editor.getByRole("textbox", { name: "Name", exact: true });
        await name.fill(" ");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect(name).toBeFocused();
        expect(writes).toEqual([]);
        await name.fill(original.name);
        await expandSyntax();
        await expect(keyword).toHaveValue(original.components!.syntax!.keyword);
        await keyword.fill("#bad");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect(keyword).toBeFocused();
        await expect(keyword).toHaveAttribute("aria-invalid", "true");
        expect(writes).toEqual([]);
        await keyword.fill("#12345678");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect(editor).toHaveCount(0);
        expect(writes).toEqual([{ method: "PUT", path: `/api/themes/${selected.id}`, body: {
          scope: target, version: 3,
          definition: { ...original, components: { ...original.components, syntax: { ...original.components!.syntax!, keyword: "#12345678" } } },
        } }]);
        expect(settingsWrites).toEqual([]);
        await expect(selectedRadio).toBeChecked();
      });
    }
    }
    for (const target of ["built-in", "site", "user"] as const) {
      for (const isAdmin of [false, true]) {
        test(`${isAdmin ? "admin" : "user"} ${target} syntax permissions and copy at ${width}px`, async ({ page }) => {
          const { editor, selected, selectedRadio, writes, settingsWrites } = await openEditor(page, width, "light", target, isAdmin);
          const original = target === "built-in" ? editableDefinition(builtInThemes[0]!) : structuredClone(selected.definition);
          const writable = target === "user" || (target === "site" && isAdmin);
          if (writable) await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
          else await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
          await editor.getByRole("button", { name: "Syntax", exact: true }).click();
          const keyword = editor.getByRole("textbox", { name: "Keyword", exact: true });
          await keyword.fill("#bad");
          await editor.getByRole("button", { name: "Core", exact: true }).click();
          await editor.getByRole("button", { name: "Save copy", exact: true }).click();
          await expect(page.getByRole("menuitem", { name: "Your themes", exact: true })).toBeVisible();
          if (isAdmin) await expect(page.getByRole("menuitem", { name: "Site themes", exact: true })).toBeVisible();
          else await expect(page.getByRole("menuitem", { name: "Site themes", exact: true })).toHaveCount(0);
          const destination = isAdmin ? "site" : "user";
          await page.getByRole("menuitem", { name: isAdmin ? "Site themes" : "Your themes", exact: true }).click();
          await expect(keyword).toBeFocused();
          await expect(keyword).toHaveAttribute("aria-invalid", "true");
          await expect(editor.getByRole("button", { name: "Syntax", exact: true })).toHaveAttribute("aria-expanded", "true");
          expect(writes).toEqual([]);
          await keyword.fill("#12345678");
          await editor.getByRole("button", { name: "Save copy", exact: true }).click();
          await page.keyboard.press("Escape");
          await expect(editor.getByRole("button", { name: "Save copy", exact: true })).toBeFocused();
          await expect(page.getByRole("menuitem", { name: "Your themes", exact: true })).toHaveCount(0);
          await expect(editor).toBeVisible();
          await editor.getByRole("button", { name: "Save copy", exact: true }).click();
          await page.getByRole("menuitem", { name: isAdmin ? "Site themes" : "Your themes", exact: true }).click();
          await expect(editor).toHaveCount(0);
          const copiedName = target === destination ? `${original.name} (copy)` : original.name;
          expect(writes).toEqual([{ method: "POST", path: "/api/themes", body: {
            scope: destination,
            definition: { ...original, name: copiedName, components: { ...original.components, syntax: { ...original.components!.syntax!, keyword: "#12345678" } } },
          } }]);
          expect(settingsWrites).toEqual([]);
          await expect(selectedRadio).toBeChecked();
          expect(selected.definition.components!.syntax).toEqual(original.components!.syntax);
        });
      }
    }
    for (const status of [403, 409]) {
      test(`${status} save rejection preserves syntax draft at ${width}px`, async ({ page }) => {
        const { editor, selected, writes, settingsWrites, rejectNextWrite } = await openEditor(page, width, "dark", status === 409 ? "site" : "user", status === 409);
        const original = structuredClone(selected);
        const detail = status === 409 ? "Theme changed in another tab. Refresh and try again." : "Theme permission changed. Refresh to check your access.";
        rejectNextWrite(status, detail);
        await editor.getByRole("button", { name: "Syntax", exact: true }).click();
        const keyword = editor.getByRole("textbox", { name: "Keyword", exact: true });
        await keyword.fill("#abcdef80");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await expect(editor.getByRole("alert")).toHaveText(detail);
        await expect(keyword).toHaveValue("#ABCDEF80");
        await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        expect(selected).toEqual(original);
        expect(writes).toEqual([{ method: "PUT", path: `/api/themes/${selected.id}`, body: {
          scope: original.scope, version: original.version,
          definition: { ...original.definition, components: { ...original.definition.components, syntax: { ...original.definition.components!.syntax!, keyword: "#ABCDEF80" } } },
        } }]);
        await editor.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(editor).toHaveCount(0);
        expect(writes).toHaveLength(1);
        expect(settingsWrites).toEqual([]);
      });
    }
  }
});

interface CiWorkerProbe {
  jobs: { kind: string; terminated: boolean; messages: string[] }[];
  errors: string[];
  held: boolean;
  release: () => void;
}

async function installCiWorkerProbe(page: Page, holdNormalization = false): Promise<void> {
  await page.addInitScript((holdNext) => {
    const probe: CiWorkerProbe = { jobs: [], errors: [], held: false, release: () => {} };
    Object.assign(window, { ciWorkerProbe: probe });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private job: CiWorkerProbe["jobs"][number];
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const path = String(url);
        this.job = { kind: path.includes("markdownCodePreparation.worker") ? "normalization" : path.includes("markdownSyntax.worker") ? "syntax" : path.includes("sourceRegexSearch.worker") ? "regex" : "other", terminated: false, messages: [] };
        probe.jobs.push(this.job);
        this.addEventListener("error", event => probe.errors.push(event.message));
        this.addEventListener("messageerror", () => probe.errors.push("Worker message could not be decoded"));
        this.addEventListener("message", event => {
          this.job.messages.push(event.data?.type);
          if (event.data?.type === "error") probe.errors.push(event.data.message);
          if (holdNext && this.job.kind === "normalization" && event.data?.type === "complete") {
            event.stopImmediatePropagation();
            holdNext = false;
            probe.held = true;
            probe.release = () => {
              probe.held = false;
              this.dispatchEvent(new MessageEvent("message", { data: event.data }));
            };
          }
        });
      }
      terminate() {
        this.job.terminated = true;
        super.terminate();
      }
    };
  }, holdNormalization);
}

const readCiProbe = (page: Page) => page.evaluate(() => {
  const probe = (window as typeof window & { ciWorkerProbe: CiWorkerProbe }).ciWorkerProbe;
  return { jobs: probe.jobs, errors: probe.errors, held: probe.held };
});

test.describe("production CI correctness", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires a normal production build");
  const markdown = "# CI preview\n\n[CI tail](#ci-tail)\n\nA &amp; B and &#x1F680;\n\n```javascript\nconst alpha = 1;\n```\n\n## CI tail\n\nLast paragraph.\n";

  for (const width of [1543, 390]) {
    for (const scenario of ["real workers", "native contracts", "edit and save", "cancel and reopen"] as const) {
      test(`CI ${scenario} at ${width}px`, async ({ browser }) => {
        const original = scenario === "edit and save" ? "one=1 two=2\n" : markdown;
        const proxy = await createCacheableViewerProxy({ initialMarkdown: original, existingFilePaths: [DEMO_PATH], wordWrapEnabled: false });
        let context: BrowserContext | undefined;
        try {
          context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          page.on("response", response => { if (new URL(response.url()).origin === CACHE_PROOF_ORIGIN && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
          await installCiWorkerProbe(page, scenario === "cancel and reopen");
          await page.goto("/browse/smb/demo");
          await page.getByRole("button", { name: "Later", exact: true }).click();
          const file = page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }));
          await file.click();
          const root = page.locator('[data-markdown-search-root="true"]');

          if (scenario === "cancel and reopen") {
            await expect.poll(async () => (await readCiProbe(page)).held).toBe(true);
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await expect.poll(async () => (await readCiProbe(page)).jobs.every(job => job.terminated)).toBe(true);
            await page.evaluate(() => (window as typeof window & { ciWorkerProbe: CiWorkerProbe }).ciWorkerProbe.release());
            await expect(root).toHaveCount(0);
            await file.click();
          }

          await expect(root).toBeVisible();
          if (scenario !== "edit and save") {
            await expect(root.locator("p").nth(1)).toHaveText("A & B and \u{1F680}");
            await expect(root.locator("pre code")).toHaveText("const alpha = 1;\n");
            await expect.poll(async () => (await readCiProbe(page)).jobs.some(job => job.kind === "syntax" && job.messages.includes("ranges") && job.messages.includes("complete"))).toBe(true);
            expect((await readCiProbe(page)).jobs.some(job => job.kind === "normalization" && job.messages.includes("normalized-source") && job.messages.includes("tree-chunk") && job.messages.includes("complete"))).toBe(true);
          }

          if (scenario === "native contracts") {
            const viewport = root.locator("..");
            await expect(viewport).toBeFocused();
            await page.keyboard.press("Tab");
            await expect(root.getByRole("link", { name: "CI tail", exact: true })).toBeFocused();
            await page.keyboard.press("Enter");
            await expect(root.getByRole("heading", { name: "CI tail", exact: true })).toHaveAttribute("id", "sambee-markdown-ci-tail");
            await viewport.focus();
            await page.keyboard.press("Control+a");
            const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
            expect(selected).toContain("const alpha = 1;");
            expect(selected).toContain("Last paragraph.");
            expect(await root.ariaSnapshot()).toContain('heading "CI preview" [level=1]');
            await page.getByRole("button", { name: "Search", exact: true }).click();
            await page.getByPlaceholder("Search", { exact: true }).fill("alpha");
            await expect(page.getByText("1 / 1", { exact: true })).toBeVisible();
          }

          if (scenario === "edit and save") {
            await enterMarkdownEditMode(page);
            const editor = page.getByRole("textbox", { name: "Markdown editor" });
            await editor.click();
            await page.keyboard.press("Control+h");
            const controls = page.getByRole("search");
            await controls.getByRole("button", { name: "Use regular expression", exact: true }).click();
            await controls.getByRole("textbox", { name: "Find", exact: true }).fill("(one|two)=(\\d)");
            await controls.getByRole("textbox", { name: "Replace", exact: true }).fill("$2:$1");
            await expect(controls.getByText("0 / 2", { exact: true })).toBeVisible();
            await page.mouse.move(0, 0);
            await expect(page.getByRole("tooltip")).toHaveCount(0);
            await controls.getByRole("button", { name: "Replace all", exact: true }).click();
            await expect(editor).toContainText("1:one 2:two");
            await controls.getByRole("button", { name: "Close", exact: true }).click();
            await editor.focus();
            await page.keyboard.press("Control+z");
            await expect(editor).toContainText("one=1 two=2");
            await page.keyboard.press("Control+Shift+Z");
            await expect(editor).toContainText("1:one 2:two");
            await page.getByRole("button", { name: "Save", exact: true }).click();
            await expect.poll(() => proxy.uploads.length).toBe(1);
            const upload = proxy.uploads[0];
            const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
            const files = [...form.values()].filter((value): value is File => typeof value !== "string");
            expect(files).toHaveLength(1);
            expect(await files[0].text()).toBe("1:one 2:two\n");
            expect((await readCiProbe(page)).jobs.some(job => job.kind === "regex" && job.messages.includes("complete"))).toBe(true);
            await page.getByRole("button", { name: "Close", exact: true }).click();
            await expect(editor).toHaveCount(0);
          }

          await page.getByRole("button", { name: "Close", exact: true }).click();
          await expect(root).toHaveCount(0);
          await expect.poll(async () => (await readCiProbe(page)).jobs.every(job => job.terminated)).toBe(true);
          expect((await readCiProbe(page)).errors).toEqual([]);
          expect(errors).toEqual([]);
          expect(proxy.errors).toEqual([]);
        } finally {
          try {
            await context?.close();
          } finally {
            await proxy.close();
          }
        }
      });
    }
  }
});

test.describe("development Markdown worker", () => {
  test.skip(process.env.SAMBEE_E2E_DEVELOPMENT !== "1", "Requires the development server and approved demo route");
  test("normalizes and renders entity text without DOM globals in the worker", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addLocatorHandler(page.getByRole("dialog", { name: "Update available" }), async (dialog) => {
      await dialog.getByRole("button", { name: "Later", exact: true }).click();
    });
    await mockMarkdownViewerApi(page, { initialMarkdown: "# Preview\n\nA &amp; B and &#x1F680;\n\n```js\nconst alpha = 1;\n```", existingFilePaths: [DEMO_PATH] });
    await page.goto("/browse/smb/demo");
    await page.getByRole("button").filter({ has: page.getByText(DEMO_PATH, { exact: true }) }).click();
    const root = page.locator('[data-markdown-search-root="true"]');
    await expect(root.getByRole("heading", { name: "Preview" })).toBeVisible();
    await expect(root.locator("p")).toHaveText("A & B and 🚀");
    await expect(root.locator("pre code")).toHaveText("const alpha = 1;\n");
    await expect(page.getByRole("alert").filter({ hasText: "Server is busy" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("production source regex containment", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  for (const width of [1543, 390]) {
    test(`native commands and stalled workers at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      await serveProductionAssets(page);
      await page.addInitScript(() => {
        const OriginalWorker = window.Worker;
        const state = { stall: "", observed: "", live: 0, requests: [] as string[], created: 0, sources: 0, navigations: 0, holdNavigation: false, held: false, release: null as (() => void) | null };
        Object.assign(window, { sourceRegexProbe: state });
        window.Worker = class extends OriginalWorker {
          private owned = false;
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.owned = String(url).includes("sourceRegexSearch.worker");
            if (this.owned) {
              state.live += 1;
              state.created += 1;
              this.addEventListener("message", (event) => {
                if (!state.holdNavigation || event.data.type !== "complete") return;
                event.stopImmediatePropagation();
                state.holdNavigation = false;
                state.held = true;
                state.release = () => {
                  state.held = false;
                  state.release = null;
                  this.dispatchEvent(new MessageEvent("message", { data: event.data }));
                };
              });
            }
          }
          postMessage(message: unknown, transfer?: Transferable[]) {
            const request = message as { type?: string; operation?: string; query?: { search: string } };
            if (this.owned && request.type === "source") state.sources += 1;
            if (this.owned && request.type === "navigate") state.navigations += 1;
            if (this.owned && request.type === "start") {
              state.requests.push(request.operation!);
              if (request.operation === state.stall) {
                state.observed = state.stall;
                state.stall = "";
                request.query!.search = "(a+)+$";
              }
            }
            super.postMessage(message, transfer ?? []);
          }
          terminate() {
            if (this.owned) { state.live -= 1; this.owned = false; }
            super.terminate();
          }
        };
      });
      const original = `one=1 two=2\n\n${"a".repeat(128)}!`;
      await mockMarkdownViewerApi(page, { initialMarkdown: original, existingFilePaths: [DEMO_PATH] });
      await page.goto("/browse/smb/demo");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      await (width < 600 ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }) : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "Markdown editor" });
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor.focus();
      await page.keyboard.press("Control+h");
      const controls = page.getByTestId("code-mirror-find-replace-popover");
      const find = controls.getByRole("textbox", { name: "Find", exact: true });
      const replace = controls.getByRole("textbox", { name: "Replace", exact: true });
      await controls.getByRole("button", { name: "Use regular expression", exact: true }).click();
      await find.fill("(one|two)=(\\d)");
      await expect(controls.getByText("0 / 2", { exact: true })).toBeVisible();
      await controls.getByRole("button", { name: "Next match", exact: true }).click();
      await expect(controls.getByText("1 / 2", { exact: true })).toBeVisible();
      await controls.getByRole("button", { name: "Next match", exact: true }).click();
      await expect(controls.getByText("2 / 2", { exact: true })).toBeVisible();
      await controls.getByRole("button", { name: "Previous match", exact: true }).click();
      await expect(controls.getByText("1 / 2", { exact: true })).toBeVisible();
      const beforeBurst = await page.evaluate(() => {
        const state = (window as unknown as { sourceRegexProbe: { holdNavigation: boolean; created: number; sources: number; navigations: number } }).sourceRegexProbe;
        state.holdNavigation = true;
        return { created: state.created, sources: state.sources, navigations: state.navigations };
      });
      await controls.getByRole("button", { name: "Next match", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { sourceRegexProbe: { held: boolean } }).sourceRegexProbe.held)).toBe(true);
      await controls.getByRole("button", { name: "Next match", exact: true }).click();
      await controls.getByRole("button", { name: "Previous match", exact: true }).click();
      await controls.getByRole("button", { name: "Next match", exact: true }).click();
      await page.evaluate(() => (window as unknown as { sourceRegexProbe: { release: (() => void) | null } }).sourceRegexProbe.release!());
      await expect.poll(() => page.evaluate(() => {
        const { live, created, sources, navigations } = (window as unknown as { sourceRegexProbe: { live: number; created: number; sources: number; navigations: number } }).sourceRegexProbe;
        return { live, created, sources, navigations };
      })).toEqual({ live: 0, created: beforeBurst.created + 1, sources: beforeBurst.sources + 1, navigations: beforeBurst.navigations + 3 });
      await expect(controls.getByText("1 / 2", { exact: true })).toBeVisible();
      await replace.fill("$2:$1");
      await expect(controls.getByText("1 / 2", { exact: true })).toBeVisible();
      await controls.getByRole("button", { name: "Replace current match", exact: true }).click();
      await expect(editor).toContainText("1:one two=2");
      await expect(controls.getByText("1 / 1", { exact: true })).toBeVisible();
      await controls.getByRole("button", { name: "Replace all", exact: true }).click();
      await expect(editor).toContainText("1:one 2:two");
      await editor.focus();
      await page.keyboard.press("Control+z");
      await expect(editor).toContainText("1:one two=2");
      await find.fill("a+");
      await expect(controls.getByText(/^[01] \/ 1$/)).toBeVisible();
      const measurements: { operation: string; keyboardMs: number }[] = [];
      for (const operation of ["count", "next", "previous", "replace-one", "replace-all"]) {
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await page.evaluate((operation) => {
          const state = (window as unknown as { sourceRegexProbe: { stall: string; observed: string } }).sourceRegexProbe;
          state.stall = operation; state.observed = "";
        }, operation);
        if (operation === "count") await find.fill("a{1,}");
        else await controls.getByRole("button", { name: { next: "Next match", previous: "Previous match", "replace-one": "Replace current match", "replace-all": "Replace all" }[operation]!, exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as unknown as { sourceRegexProbe: { observed: string } }).sourceRegexProbe.observed)).toBe(operation);
        await find.focus();
        const before = await find.evaluate((element: HTMLInputElement) => { element.setSelectionRange(element.value.length, element.value.length); return element.selectionStart; });
        const start = Date.now();
        await find.press("ArrowLeft");
        expect(await find.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(before! - 1);
        measurements.push({ operation, keyboardMs: Date.now() - start });
        await expect(controls.getByText("Loading...", { exact: true })).toBeVisible();
        await expect(controls.getByRole("alert")).toContainText("timed out");
        await expect(editor).toContainText("1:one two=2");
        await find.fill("a");
        await expect(controls.getByText(/^[0-9]+ \/ 128$/)).toBeVisible();
        await find.fill("a+");
        await expect(controls.getByText(/^[01] \/ 1$/)).toBeVisible();
      }
      await find.fill("(a+)+$");
      await expect(controls.getByText("Loading...", { exact: true })).toBeVisible();
      await find.press("ArrowLeft");
      await expect(controls.getByRole("alert")).toContainText("timed out");
      await find.fill("a+");
      await expect(controls.getByText(/^[01] \/ 1$/)).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as unknown as { sourceRegexProbe: { live: number } }).sourceRegexProbe.live)).toBe(0);
      const commit = await page.evaluate(() => performance.getEntriesByName("sambee:source-search:commit").map((entry) => ({ duration: entry.duration, detail: (entry as PerformanceMeasure).detail })));
      await testInfo.attach("source-regex-containment.json", { body: JSON.stringify({ width, measurements, commit, note: "Real viewer worker termination/restart and keyboard servicing; small-document commit samples, not large replace-all or hardware input-to-paint acceptance." }, null, 2), contentType: "application/json" });
    });
  }
});

test("Markdown viewer API fixtures preserve transfer-stream request handling", async ({ page }) => {
  let receivedBody: string | undefined;
  await mockMarkdownViewerApi(page, {
    initialMarkdown: "hello",
    onTransferStream: async route => {
      const request = route.request();
      expect(await request.headerValue("content-type")).toBe("application/octet-stream");
      receivedBody = request.postDataBuffer()?.toString("utf8");
      await fulfillJson(route, { status: "completed" });
    },
  });
  await page.goto("http://localhost:3000/browse/smb/demo");
  const result = await page.evaluate(async connectionId => {
    const response = await fetch(`/api/browse/${connectionId}/transfer-stream?path=fixture.txt`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "fixture body",
    });
    return { status: response.status, body: await response.json() };
  }, DEMO_CONNECTION_ID);
  expect(receivedBody).toBe("fixture body");
  expect(result).toEqual({ status: 200, body: { status: "completed" } });
});

test.describe("production syntax readiness", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  test.beforeAll(() => {
    if (process.env.SAMBEE_E2E_MEMORY === "1" || process.env.SAMBEE_E2E_TRACE === "1") throw new Error("Readiness acceptance must run without forced GC or diagnostic tracing.");
  });
  for (const width of [1543, 390]) {
    for (const fixture of SYNTAX_PUBLICATION_FIXTURES) {
    test(`unheld ${fixture.name} readiness at ${width}px`, async ({ page: defaultPage, browser }, testInfo) => {
      const longLine = fixture.name === "long-line";
      const line = longLine ? "let x=1; " : "let x=1;\n";
      const text = `${line.repeat(fixture.lines)}${longLine ? "\n" : ""}`;
      const markdown = Array.from({ length: fixture.blocks }, () => `\`\`\`js\n${text}\`\`\``).join("\n\n");
      const cacheProxy = process.env.SAMBEE_E2E_HTTP_CACHE === "1" ? await createCacheableViewerProxy({ initialMarkdown: markdown }) : undefined;
      let cacheContext: BrowserContext | undefined;
      try {
      cacheContext = cacheProxy ? await browser.newContext({ proxy: { server: cacheProxy.url, bypass: "<-loopback>" }, serviceWorkers: "block" }) : undefined;
      const page = cacheContext ? await cacheContext.newPage() : defaultPage;
      await page.setViewportSize({ width, height: 900 });
      if (!cacheProxy) await serveProductionAssets(page);
      await page.addInitScript(({ line, text: expectedText, lines, blocks, longLine, filename }) => {
        const metrics: Record<string, number> = {};
        const outcomes: { block: number; reason?: string }[] = [];
        const syntaxWorkerUrls: string[] = [];
        let openedAt: number | undefined;
        let firstBlockPreparedAt: number | undefined;
        let preparedAt: number | undefined;
        let expected: { from: number; to: number; category: string }[] | undefined;
        const scheduled = new Set<string>();
        const afterFrames = (metric: string) => {
          if (scheduled.has(metric)) return;
          scheduled.add(metric);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            metrics[metric] = performance.now() - openedAt!;
          }));
        };
        document.addEventListener("click", (event) => {
          const button = event.target instanceof Element ? event.target.closest("button") : null;
          if (!(button?.getAttribute("aria-label") === `File: ${filename}` || button?.textContent?.trim() === filename)) return;
          for (const key of Object.keys(metrics)) delete metrics[key];
          outcomes.length = 0;
          scheduled.clear();
          expected = undefined;
          firstBlockPreparedAt = undefined;
          preparedAt = undefined;
          openedAt = performance.now();
          const inspect = () => {
            const root = document.querySelector<HTMLElement>('[data-markdown-search-root="true"]');
            const codes = root?.querySelectorAll("pre > code");
            const code = codes?.[0];
            const search = document.querySelector<HTMLButtonElement>('button[aria-label="Search"]');
            if (codes?.length === blocks && [...codes].every(element => element.textContent === expectedText) && search && !search.disabled) {
              afterFrames("firstUsableText");
              if (!expected) {
                expected = [];
                const bounds = root!.parentElement!.getBoundingClientRect();
                const preBounds = code.closest("pre")!.getBoundingClientRect();
                const left = Math.max(bounds.left, preBounds.left);
                const right = Math.min(bounds.right, preBounds.right);
                const node = code.firstChild!;
                const tokens = [[0, 3, "keyword"], [4, 5, "identifier"], [5, 6, "operator"], [6, 7, "number"], [7, 8, "punctuation"]] as const;
                for (let index = 0; index < lines; index += 1) {
                  const from = index * line.length;
                  const range = new Range();
                  range.setStart(node, from);
                  range.setEnd(node, from + line.length - 1);
                  const rect = range.getBoundingClientRect();
                  if (rect.top >= bounds.bottom) break;
                  if (longLine && rect.left >= right) break;
                  if (rect.top < bounds.top || rect.bottom > bounds.bottom) continue;
                  for (const [start, end, category] of tokens) {
                    if (!longLine) {
                      expected.push({ from: from + start, to: from + end, category });
                      continue;
                    }
                    for (let offset = from + start; offset < from + end; offset += 1) {
                      range.setStart(node, offset);
                      range.setEnd(node, offset + 1);
                      const character = range.getBoundingClientRect();
                      if (character.left >= left && character.right <= right) expected.push({ from: offset, to: offset + 1, category });
                    }
                  }
                }
              }
              const published = new Map<string, Range[]>();
              for (const [name, ranges] of CSS.highlights) {
                const match = /^markdown-syntax-\d+-(.+)$/.exec(name);
                if (match) published.set(match[1], [...ranges] as Range[]);
              }
              const completeWindow = expected.length > 0 && expected.every(token => (published.get(token.category) ?? []).some(range =>
                range.startContainer === code.firstChild && range.endContainer === code.firstChild && range.startOffset <= token.from && range.endOffset >= token.to));
              if (completeWindow) {
                afterFrames("firstVisibleSyntax");
                if (outcomes.length === blocks) afterFrames("fullSyntaxPreparation");
              }
            }
            if (Object.keys(metrics).length < 3) requestAnimationFrame(inspect);
          };
          requestAnimationFrame(inspect);
        }, true);
        const OriginalWorker = window.Worker;
        window.Worker = class extends OriginalWorker {
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            if (String(url).includes("markdownSyntax.worker")) {
              syntaxWorkerUrls.push(String(url));
              this.addEventListener("message", (event) => {
              const response = event.data as { type?: string; block: number; reason?: string };
              if (response.type === "complete") {
                outcomes.push({ block: response.block, reason: response.reason });
                firstBlockPreparedAt ??= performance.now();
                preparedAt = performance.now();
              }
              });
            }
          }
        };
        Object.assign(window, { syntaxReadiness: () => ({ metrics, outcomes, syntaxWorkerUrls: [...syntaxWorkerUrls], expectedVisibleTokens: expected?.length ?? 0, workerFirstBlockMs: firstBlockPreparedAt === undefined || openedAt === undefined ? null : firstBlockPreparedAt - openedAt, workerResultsMs: preparedAt === undefined || openedAt === undefined ? null : preparedAt - openedAt }) });
      }, { line, text, lines: fixture.lines, blocks: fixture.blocks, longLine, filename: DEMO_PATH });
      if (!cacheProxy) await mockMarkdownViewerApi(page, { initialMarkdown: markdown });
      await page.goto("http://localhost:3000/browse/smb/demo");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      let coldSyntaxRequests: string[] = [];
      for (const cycle of cacheProxy ? [0, 1] : [0]) {
      const beforeOpen = cacheProxy?.requests.length ?? 0;
      await (width < 600 ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }) : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
      const sample = () => page.evaluate(() => (window as unknown as { syntaxReadiness: () => { metrics: Record<string, number>; outcomes: { block: number; reason?: string }[]; syntaxWorkerUrls: string[]; expectedVisibleTokens: number; workerFirstBlockMs: number | null; workerResultsMs: number | null } }).syntaxReadiness());
      await expect.poll(async () => Object.keys((await sample()).metrics).length).toBe(3);
      const report = await sample();
      const budget = evaluateViewerReadinessBudgets(report.metrics);
      const networkAssets = cacheProxy?.requests.slice(beforeOpen).filter(path => path.endsWith(".js")) ?? [];
      if (cacheProxy && cycle === 0) coldSyntaxRequests = networkAssets;
      expect(report.expectedVisibleTokens).toBeGreaterThan(0);
      expect(report.outcomes).toEqual(Array.from({ length: fixture.blocks }, (_, block) => ({ block, reason: undefined })));
      expect(Object.values(report.metrics).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
      const root = page.locator('[data-markdown-search-root="true"]');
      expect(await root.locator("pre > code").evaluateAll((elements, expected) => elements.every(element => element.textContent === expected), text)).toBe(true);
      expect(await root.locator("pre > code").first().evaluate(element => {
        const range = new Range();
        range.setStart(element.firstChild!, 0);
        range.setEnd(element.firstChild!, 8);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return window.getSelection()?.toString();
      })).toBe(line.trimEnd());
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.getByPlaceholder("Search", { exact: true }).fill("let x");
      await expect(page.getByRole("button", { name: "Next match", exact: true }).locator("..").getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
      await testInfo.attach("syntax-readiness.json", { body: JSON.stringify({ fixture: fixture.name, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, surface: "markdown-preview", cacheState: cacheProxy ? cycle === 0 ? "cold" : "warm-http-fresh-workers" : "routed-no-cache", ...report, budget, enforced: true, networkAssets, coldSyntaxRequests, cacheCondition: cacheProxy ? cycle === 0 ? "Fresh context and fresh syntax worker; ordinary HTTP with an initially empty browser cache, no preloading or request routing." : "Same page after close and zero live workers; fresh syntax worker with browser HTTP cache populated only by the measured first open." : "Fresh context and worker; routed assets disable normal HTTP caching. No cold/warm-cache acceptance claim.", scope: "Unheld file-open through exact text/control readiness and initial visible token coverage plus two frames. Functional selection/search follow timing, not hardware input/paint. Approved readiness limits enforced; no resource or full-rollout acceptance." }, null, 2), contentType: "application/json" });
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(root).toHaveCount(0);
      await expect.poll(() => page.workers().length).toBe(0);
      await expect.poll(() => page.evaluate(() => [...CSS.highlights.keys()].filter(name => name.startsWith("markdown-syntax-")).length)).toBe(0);
      expect.soft(budget.status, JSON.stringify({ cacheState: cacheProxy ? cycle === 0 ? "cold" : "warm-http-fresh-workers" : "routed-no-cache", failures: budget.metrics.filter(metric => metric.status !== "pass") })).toBe("pass");
      expect(report.syntaxWorkerUrls).toHaveLength(cycle + 1);
      if (cacheProxy) {
        expect(cacheProxy.errors).toEqual([]);
        if (cycle === 0) {
          expect(coldSyntaxRequests).toContain(new URL(report.syntaxWorkerUrls[0]).pathname);
          expect(coldSyntaxRequests.length).toBeGreaterThan(1);
        } else {
          expect(report.syntaxWorkerUrls[1]).toBe(report.syntaxWorkerUrls[0]);
          expect(networkAssets.filter(path => coldSyntaxRequests.includes(path))).toEqual([]);
        }
      }
      }
      } finally {
        try { await cacheContext?.close(); } finally { await cacheProxy?.close(); }
      }
    });
    }
  }
});

test.describe("production native Markdown constraints", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  const lineCount = 120;
  const longLine = `const nativeLongLine = "${"horizontal native content ".repeat(240)}NATIVE_LONG_END";`;
  const fixtures = [
    { name: "multiline", code: Array.from({ length: lineCount }, (_, index) => `const nativeLine${index} = ${index};`).join("\n"), fence: "javascript" },
    { name: "long-line", code: longLine, fence: "javascript" },
    { name: "nested", code: "## Nested native heading\n\nNested native paragraph.\n\n```javascript\nconst nestedNative = 42;\n```\n\nNested native tail.", fence: "markdown" },
  ];
  for (const width of [1543, 390]) {
    for (const fixture of fixtures) {
      test(`${fixture.name} selection, clipboard, focus and output at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await serveProductionAssets(page);
        const markdown = `# Native constraints\n\n[Native tail](#native-tail)\n\nNATIVE_SELECTION_START\n\n\`\`\`\`${fixture.fence}\n${fixture.code}\n\`\`\`\`\n\nNATIVE_SELECTION_END\n\n${Array.from({ length: lineCount }, (_, index) => `Native spacer ${index}.\n`).join("\n")}\n## Native tail\n\nNATIVE_FIND_TAIL\n`;
        await mockMarkdownViewerApi(page, { initialMarkdown: markdown, wordWrapEnabled: false });
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await (width < 600 ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }) : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
        const root = page.locator('[data-markdown-search-root="true"]');
        const viewport = root.locator("..");
        const code = root.locator("pre > code");
        await expect(code).toHaveText(`${fixture.code}\n`);
        const renderedText = await root.innerText();
        await expect(viewport).toBeFocused();
        await page.keyboard.press("Tab");
        const link = root.getByRole("link", { name: "Native tail", exact: true });
        await expect(link).toBeFocused();
        const previewNode = await root.elementHandle();
        const routeBefore = new URL(page.url());
        await page.keyboard.press("Enter");
        const target = root.getByRole("heading", { name: "Native tail", exact: true });
        await expect(target).toHaveAttribute("id", `${MARKDOWN_HEADING_ID_PREFIX}native-tail`);
        await expect(target).toBeInViewport();
        expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(routeBefore.pathname + routeBefore.search);
        expect(await root.evaluate((element, original) => element === original, previewNode)).toBe(true);
        await previewNode?.dispose();
        await viewport.focus();
        await page.keyboard.press("Control+Home");
        await page.keyboard.press("Control+a");
        const selectAll = await page.evaluate(() => window.getSelection()?.toString() ?? "");
        expect(selectAll).toContain("NATIVE_SELECTION_START");
        expect(selectAll).toContain(fixture.code);
        expect(selectAll).toContain("NATIVE_FIND_TAIL");
        const selected = await root.evaluate(element => {
          const paragraphs = [...element.querySelectorAll("p")];
          const start = paragraphs.find(paragraph => paragraph.textContent === "NATIVE_SELECTION_START")!;
          const end = paragraphs.find(paragraph => paragraph.textContent === "NATIVE_SELECTION_END")!;
          const range = new Range();
          range.setStart(start.firstChild!, 0);
          range.setEnd(end.firstChild!, end.textContent!.length);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          return window.getSelection()?.toString() ?? "";
        });
        expect(selected).toContain(fixture.code);
        expect(selected.startsWith("NATIVE_SELECTION_START")).toBe(true);
        expect(selected.endsWith("NATIVE_SELECTION_END")).toBe(true);
        await page.keyboard.press("Control+c");
        await viewport.evaluate(element => {
          const target = document.createElement("textarea");
          target.setAttribute("aria-label", "Native clipboard probe");
          Object.assign(target.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px" });
          element.append(target);
          target.focus({ preventScroll: true });
        });
        await page.keyboard.press("Control+v");
        const clipboard = page.getByRole("textbox", { name: "Native clipboard probe", exact: true });
        await expect(clipboard).toHaveValue(selected);
        await clipboard.evaluate(element => element.remove());
        await viewport.focus();
        await page.keyboard.press("Control+Home");
        await expect(root.getByRole("heading", { name: "Native constraints", exact: true })).toBeInViewport();
        const find = await page.evaluate(() => {
          window.getSelection()?.removeAllRanges();
          return (window as Window & { find: (text: string) => boolean }).find("NATIVE_FIND_TAIL");
        });
        expect(find).toBe(true);
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("NATIVE_FIND_TAIL");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const findReveal = await root.evaluate(element => {
          const target = [...element.querySelectorAll("p")].find(paragraph => paragraph.textContent === "NATIVE_FIND_TAIL")!;
          const bounds = target.getBoundingClientRect();
          const viewport = element.parentElement!.getBoundingClientRect();
          return { target: bounds.toJSON(), viewport: viewport.toJSON(), scrollTop: element.parentElement!.scrollTop, revealed: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom };
        });
        await testInfo.attach("native-find-reveal.json", { body: JSON.stringify(findReveal, null, 2), contentType: "application/json" });
        if (testInfo.project.name === "firefox") {
          expect.soft(findReveal.revealed, "Firefox window.find must reveal the complete match inside the content viewport").toBe(true);
          await expect.soft(root.getByText("NATIVE_FIND_TAIL", { exact: true })).toBeInViewport();
        }
        if (testInfo.project.name === "chromium") {
          const screenState = () => root.evaluate(element => ({
            text: element.textContent,
            selection: window.getSelection()?.toString(),
            top: element.parentElement!.scrollTop,
            left: element.querySelector("pre")!.scrollLeft,
          }));
          const beforePrint = await screenState();
          const pdf = await page.pdf({ printBackground: true });
          await testInfo.attach(`native-${fixture.name}-${width}.pdf`, { body: pdf, contentType: "application/pdf" });
          await expect.poll(screenState).toEqual(beforePrint);
        }
        await testInfo.attach("native-constraints.json", { body: JSON.stringify({ fixture: fixture.name, width, engine: testInfo.project.name, renderedText, selectAll, selected, headingTargetRevealed: true, findReveal, findRevealRequired: testInfo.project.name === "firefox", clipboard: "Trusted keyboard copy and paste into a temporary textarea; exact payload checked.", find: "window.find exact selection is required in both engines; reveal is required in Firefox and diagnostic-only in Chromium. Actual browser Find remains separate manual evidence.", print: testInfo.project.name === "chromium" ? "Real headless PDF attached; run scripts.check_native_markdown_pdf separately. PDF generation is not a print acceptance pass." : "Firefox print/PDF remains a manual gate." }, null, 2), contentType: "application/json" });
      });
    }
  }
});

test.describe("production Markdown printing", () => {
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  const lineCount = 120;
  const fixtures = [
    { name: "multiline", code: Array.from({ length: lineCount }, (_, index) => `const printLine${index} = ${index};`).join("\n"), fence: "javascript" },
    { name: "long-line", code: `const printLongLine = "${"printable horizontal content ".repeat(240)}PRINT_LONG_END";`, fence: "javascript" },
    { name: "nested", code: "## Printed nested heading\n\nNested printed paragraph.\n\n```javascript\nconst nestedPrint = 42;\n```\n\nNested printed tail.", fence: "markdown" },
  ];
  for (const width of [1543, 390]) {
    for (const mode of ["light", "dark"] as const) {
      for (const fixture of fixtures) {
        test(`${fixture.name} ${mode} complete output and state at ${width}px`, async ({ page }, testInfo) => {
          await page.setViewportSize({ width, height: 900 });
          await serveProductionAssets(page);
          const markdown = `# Printed document\n\nPRINT_DOCUMENT_START\n\n![Printed image](/icons/icon-180.png)\n\n\`\`\`\`${fixture.fence}\n${fixture.code}\n\`\`\`\`\n\n| Printed column | Printed value |\n| --- | --- |\n| PRINT_TABLE_START | ${"LongTableCell".repeat(30)} |\n| PRINT_TABLE_END | Complete table |\n\n${Array.from({ length: lineCount }, (_, index) => `Printed paragraph ${index}.\n`).join("\n")}\n## Printed tail\n\nPRINT_DOCUMENT_END\n`;
          await mockMarkdownViewerApi(page, { initialMarkdown: markdown, themeId: () => `sambee-${mode}`, wordWrapEnabled: false });
          await page.goto("/browse/smb/demo");
          await page.getByRole("button", { name: "Later", exact: true }).click();
          await (width < 600 ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }) : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
          const root = page.locator('[data-markdown-search-root="true"]');
          await expect(root.getByRole("heading", { name: "Printed document", exact: true })).toBeVisible();
          await expect(root.locator("pre > code")).toHaveText(`${fixture.code}\n`);
          await expect.poll(() => root.getByRole("img", { name: "Printed image", exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          await page.evaluate(() => document.fonts.ready);
          await page.evaluate(() => {
            Object.assign(window, { printCalls: 0 });
            window.print = () => { (window as unknown as { printCalls: number }).printCalls += 1; };
          });
          const printButton = page.getByRole("button", { name: "Print", exact: true });
          await expect(printButton).toHaveAttribute("title", "Print / Save as PDF");
          await printButton.click();
          expect(await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls)).toBe(1);
          const renderedText = await root.innerText();
          await page.emulateMedia({ media: "print" });
          await expect(root).toHaveCSS("color", "rgb(0, 0, 0)");
          await expect(root).toHaveCSS("background-color", "rgb(255, 255, 255)");
          await expect(root.locator("pre > code")).toHaveCSS("color", "rgb(0, 0, 0)");
          await expect(root.locator("pre > code")).toHaveCSS("white-space", "pre-wrap");
          await expect(root.locator("pre > code")).toHaveCSS("min-width", "0px");
          await expect(root.locator("pre")).toHaveCSS("overflow", "visible");
          await expect(printButton).not.toBeVisible();
          expect(await root.locator("pre, table, img").evaluateAll(elements => elements.every(element => element.getBoundingClientRect().width <= element.closest('[data-markdown-search-root]')!.getBoundingClientRect().width))).toBe(true);
          await page.emulateMedia({ media: null });
          await root.getByText("PRINT_DOCUMENT_END", { exact: true }).scrollIntoViewIfNeeded();
          const node = await root.elementHandle();
          await root.locator("pre").evaluate(element => { element.scrollLeft = element.scrollWidth; });
          await root.getByText("PRINT_DOCUMENT_END", { exact: true }).evaluate(element => {
            const range = new Range();
            range.selectNodeContents(element);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
          });
          const screenState = () => root.evaluate(element => ({ text: element.textContent, selection: window.getSelection()?.toString(), top: element.parentElement!.scrollTop, left: element.querySelector("pre")!.scrollLeft, url: location.href }));
          const beforePrint = await screenState();
          expect(beforePrint.top).toBeGreaterThan(0);
          if (testInfo.project.name === "chromium") {
            const pdf = await page.pdf({ printBackground: false, format: "A4", margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } });
            await testInfo.attach(`print-${fixture.name}-${mode}-${width}.pdf`, { body: pdf, contentType: "application/pdf" });
          }
          await expect.poll(screenState).toEqual(beforePrint);
          expect(await root.evaluate((element, original) => element === original, node)).toBe(true);
          await node?.dispose();
          await testInfo.attach("markdown-print.json", { body: JSON.stringify({ fixture: fixture.name, width, mode, engine: testInfo.project.name, renderedText, requiresImages: true, scope: testInfo.project.name === "chromium" ? "Real browser PDF; inspect text and visual output separately." : "Print CSS and state restoration only; actual Firefox print output remains a manual check." }, null, 2), contentType: "application/json" });
        });
      }
    }
  }
});

test.describe("production syntax publication", () => {
  const collectMemory = process.env.SAMBEE_E2E_MEMORY === "1";
  const enforceBudgets = process.env.SAMBEE_E2E_BUDGETS === "1";
  const diagnostic = collectMemory || process.env.SAMBEE_E2E_TRACE === "1";
  test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the production build and approved demo route");
  test.beforeAll(() => {
    if (enforceBudgets && diagnostic) throw new Error("Timing budget acceptance must run without forced GC or diagnostic tracing.");
  });
  const fixtures = SYNTAX_PUBLICATION_FIXTURES;
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
    await expect(root.getByRole("table")).toHaveCount(1);
    await expect(root.getByRole("checkbox", { checked: true })).toBeDisabled();
    await expect(root.getByRole("checkbox", { checked: false })).toBeDisabled();
    await expect(root.locator("pre code")).toHaveText("const contract = 1;\nconsole.log(contract);\n");
    await expect(root.getByRole("link", { name: "External", exact: true })).toHaveAttribute("href", "https://example.org/contract");
    await expect(root.getByRole("link", { name: "Relative", exact: true })).toHaveAttribute("href", "http://localhost:3000/browse/smb/child.md");
    const expectedHeadingId = "sambee-markdown-tail";
    await expect(root.getByRole("heading", { name: "Tail", exact: true })).toHaveAttribute("id", expectedHeadingId);
    await expect(root.getByRole("link", { name: "Hash", exact: true })).toHaveAttribute("href", `#${expectedHeadingId}`);
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
      try {
        await expect(root.getByRole("heading", { name: "Tail", exact: true })).toBeVisible();
        expect(await root.innerText()).toBe(text);
        const pdf = await page.pdf();
        expect(pdf.byteLength).toBeGreaterThan(1_000);
        await testInfo.attach("viewer-contract.pdf", { body: pdf, contentType: "application/pdf" });
      } finally {
        await page.emulateMedia({ media: null });
      }
    }
    await testInfo.attach("native-viewer-contracts.json", { body: JSON.stringify({ renderer: "react-markdown", text, selectAll, selectedCode, semantics, clipboardScope: "Trusted native copy event and exact selected text; OS clipboard payload and assistive-technology behavior remain manual gates." }, null, 2), contentType: "application/json" });
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
        await page.addInitScript(({ expectedBlocks, expectedMatches, filename }) => {
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
          const timingSamples: ViewerTimingSamples = {};
          let openedAt: number | undefined;
          let navigationClicks = 0;
          const measureExactResult = (metric: "firstExactSearch" | "changedQuery" | "lastMatchNavigation", query: string, ordinal: number) => {
            const started = performance.now();
            const inspect = () => {
              const next = document.querySelector('button[aria-label="Next match"]');
              const count = next?.parentElement?.textContent?.replace(/\s/g, "") ?? "";
              const current = [...CSS.highlights.entries()].find(([name]) => name.startsWith("markdown-search-") && name.endsWith("-current"));
              const active = current ? [...current[1]][0] as Range | undefined : undefined;
              if (count.includes(`${ordinal}/${expectedMatches}`) && active?.toString() === query) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  timingSamples[metric] = performance.now() - started;
                }));
              } else requestAnimationFrame(inspect);
            };
            requestAnimationFrame(inspect);
          };
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
              requestAnimationFrame(() => {
                const completed = performance.now();
                renderMilestones.push({ name: "second-frame", time: completed });
                if (openedAt !== undefined) timingSamples.documentCompletion = completed - openedAt;
              });
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
            if (openedAt === undefined && (action === `File: ${filename}` || button?.textContent?.trim() === filename)) openedAt = performance.now();
            if (action !== "Next match" && action !== "Previous match") return;
            navigationClicks += 1;
            if (navigationClicks === 3) measureExactResult("lastMatchNavigation", "let x", expectedMatches);
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
              if (eventName === "input" && value === "l") measureExactResult("firstExactSearch", value, 1);
              if (eventName === "input" && value === "x=1") measureExactResult("changedQuery", value, 1);
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
          Object.assign(window, {
            syntaxResources: () => ({ liveWorkers, heldMessages: pending.length, heldNormalizationMessages: pendingNormalization.length }),
            holdNormalization: () => { heldNormalization = true; },
            releaseNormalization: () => { heldNormalization = false; for (const send of pendingNormalization.splice(0)) send(); },
            syntaxResponsiveness: () => {
              const viewerGaps = taskGaps.filter((gap) => openedAt !== undefined && gap.startTime + gap.duration >= openedAt);
              return { longTasksSupported, longTasks, taskGaps: viewerGaps, searchStages, syntaxStages, preparationStages, workerStages, navigationFrames, renderMilestones, keyboardFrames, timingSamples: { ...timingSamples, maximumTimerGap: viewerGaps.length ? Math.max(...viewerGaps.map((gap) => gap.duration)) : null } };
            },
            holdSyntax: () => { held = true; },
            releaseSyntax: () => {
              held = false;
              for (const send of pending.splice(0)) send();
            },
          });
          window.Worker = class extends OriginalWorker {
            private disposed = false;
            private syntaxWorker: boolean;
            private blocks = new Map<number, { source: number; final?: number; firstResult?: number }>();
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              this.syntaxWorker = String(url).includes("markdownSyntax.worker");
              liveWorkers += 1;
              this.addEventListener("message", (event) => {
                const response = event.data as { type?: string; block?: number };
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
              const kind = message as { type?: string };
              const send = () => {
                if (this.disposed) return;
                const request = message as { type?: string; block?: number; final?: boolean };
                if (this.syntaxWorker && request.type === "source" && request.block !== undefined) {
                  const block = this.blocks.get(request.block) ?? { source: performance.now() };
                  if (request.final) block.final = performance.now();
                  this.blocks.set(request.block, block);
                }
                super.postMessage(message, options);
              };
              if (held && this.syntaxWorker && kind.type === "source") pending.push(send);
              else if (heldNormalization && !this.syntaxWorker && kind.type === "source") pendingNormalization.push(send);
              else send();
            }
          };
        }, { expectedBlocks: fixture.blocks, expectedMatches: fixture.lines * fixture.blocks, filename: DEMO_PATH });
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
        const memory = { scope: "Chromium renderer heap only; excludes worker heaps and aggregate native/DOM memory. Firefox unsupported. GC runs are separate from responsiveness trials.", controlledGC: collectMemory, browserMetrics, documentStats: null as { elements: number; textNodes: number } | null, beforeOpen: await sampleHeap(), afterComplete: null as Awaited<ReturnType<typeof sampleHeap>>, afterClose: null as Awaited<ReturnType<typeof sampleHeap>>, afterCompleteGC: null as Awaited<ReturnType<typeof sampleHeap>>, afterCloseGC: null as Awaited<ReturnType<typeof sampleHeap>> };
        const root = page.locator('[data-markdown-search-root="true"]');
        await captureViewerScheduling(page, testInfo, async () => {
        await phase("initial-render-through-two-frames", async () => {
          await (width < 600
            ? page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })
            : page.getByRole("button").filter({ hasText: /^note\.md$/ })).click();
          await expect(root.locator("pre > code")).toHaveCount(fixture.blocks);
        });
        const openMs = Date.now() - started;
        browserMetrics.afterInitialRender = await sampleBrowserMetrics();
        await page.getByRole("button", { name: "Search", exact: true }).click();
        const searchControls = page.getByRole("button", { name: "Next match", exact: true }).locator("..");
        const searchStarted = Date.now();
        await phase("first-search-keyboard", async () => {
          await page.getByPlaceholder("Search", { exact: true }).pressSequentially("l");
          await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResponsiveness: () => { timingSamples: ViewerTimingSamples } }).syntaxResponsiveness().timingSamples.firstExactSearch)).toBeGreaterThanOrEqual(0);
          await page.getByPlaceholder("Search", { exact: true }).pressSequentially("et x");
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
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResponsiveness: () => { timingSamples: ViewerTimingSamples } }).syntaxResponsiveness().timingSamples.lastMatchNavigation)).toBeGreaterThanOrEqual(0);
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
          if (fixture.name === "many-blocks") {
            const scrolling = await root.evaluate(async (element) => {
              const viewport = element.parentElement!;
              const initialScroll = viewport.scrollTop;
              const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const visible = (pattern: RegExp) => [...CSS.highlights.entries()]
                .filter(([name]) => pattern.test(name))
                .some(([, ranges]) => [...ranges].some((entry) => {
                  const rect = (entry as Range).getBoundingClientRect();
                  const bounds = viewport.getBoundingClientRect();
                  return rect.bottom > bounds.top && rect.top < bounds.bottom;
                }));
              const painted = () => visible(/^markdown-(?:syntax|retained)-/) && visible(/^markdown-search-.*-other$/);
              let ready = painted();
              for (let attempt = 0; !ready && attempt < 10; attempt += 1) {
                await frame();
                ready = painted();
              }
              let searchFrames = 0;
              let syntaxFrames = 0;
              for (let index = 0; index < 60; index += 1) {
                viewport.scrollTop = initialScroll + (index % 2) * 8;
                await frame();
                if (visible(/^markdown-search-.*-other$/)) searchFrames += 1;
                if (visible(/^markdown-(?:syntax|retained)-/)) syntaxFrames += 1;
              }
              return { ready, searchFrames, syntaxFrames };
            });
            await testInfo.attach("continuous-scroll", { body: JSON.stringify({ renderer: "react-markdown", ...scrolling }), contentType: "application/json" });
            expect(scrolling.ready).toBe(true);
            expect(scrolling.searchFrames).toBe(60);
            expect(scrolling.syntaxFrames).toBe(60);
          }
        });
        await phase("changed-query", async () => {
          await page.getByPlaceholder("Search", { exact: true }).fill("x=1");
          await expect(searchControls.getByText(`1 / ${fixture.lines * fixture.blocks}`, { exact: true })).toBeVisible();
          expect(await root.evaluate((element) => element.contains((window as unknown as { selectedSyntaxNode: Node }).selectedSyntaxNode))).toBe(true);
        });
        await expect.poll(() => page.evaluate(() => (window as unknown as { syntaxResponsiveness: () => { timingSamples: ViewerTimingSamples } }).syntaxResponsiveness().timingSamples.changedQuery)).toBeGreaterThanOrEqual(0);
        await phase("clear-query", async () => {
          await page.getByPlaceholder("Search", { exact: true }).fill("");
          await expect(root.locator("mark")).toHaveCount(0);
          expect(await page.evaluate(() => [...CSS.highlights.keys()].filter((name) => name.startsWith("markdown-search-")).length)).toBe(0);
        });
        const responsiveness = await page.evaluate(() => (window as unknown as { syntaxResponsiveness: () => {
          timingSamples: ViewerTimingSamples;
          taskGaps: { startTime: number; duration: number }[];
          longTasksSupported: boolean;
          longTasks: { startTime: number; duration: number }[];
          searchStages: { name: string; startTime: number; duration: number }[];
          syntaxStages: { name: string; startTime: number; duration: number }[];
                  preparationStages: { name: string; startTime: number; duration: number }[];
          workerStages: { name: string; startTime: number; duration: number }[];
          navigationFrames: { action: string; startTime: number; duration: number; firstFrameMs: number }[];
          renderMilestones: { name: string; time: number }[];
          keyboardFrames: { event: string; startTime: number; duration: number; firstFrameMs: number; eventAgeMs: number; value: string }[];
        } }).syntaxResponsiveness());
        const budgetReport = evaluateViewerTimingBudgets(responsiveness.timingSamples, diagnostic);
        Object.assign(responsiveness, { measurementVersion: "scoped-controls-v2", traceRequested: process.env.SAMBEE_E2E_TRACE === "1", traceSupported: testInfo.project.name === "chromium" });
        for (const stage of ["capture", "matching", "presentation", "clear", "navigation-lookup", "navigation-publication", "navigation-geometry", "navigation-scroll"]) {
          expect(responsiveness.searchStages.some((entry) => entry.name === `sambee:preview-search:${stage}`)).toBe(true);
        }
        for (const stage of ["task", "viewport-geometry", "block-geometry", "mapping", "offset-geometry", "ranges", "publication"]) {
          expect(responsiveness.syntaxStages.some((entry) => entry.name === `sambee:preview-syntax:${stage}`)).toBe(true);
        }
        for (const stage of [
          "decode-elapsed",
          "load-normalization-elapsed",
          "collection-walk", "render-prepared-tree", "render-transform", "hast-ready-to-layout-effect",
        ]) {
          expect(responsiveness.preparationStages.some((entry) => entry.name === `sambee:preview-preparation:${stage}`)).toBe(true);
        }
        expect(responsiveness.preparationStages.some((entry) => entry.name === "sambee:preview-preparation:collection-parse")).toBe(false);
        expect(responsiveness.preparationStages.some((entry) => entry.name === "sambee:preview-preparation:render-parse")).toBe(false);
        expect(responsiveness.workerStages.filter((entry) => entry.name === "source-to-complete")).toHaveLength(fixture.blocks);
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
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          let textNodes = 0;
          while (walker.nextNode()) textNodes += 1;
          return { elements: element.querySelectorAll("*").length, textNodes };
        });
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
        await testInfo.attach("publication-measurements", { body: JSON.stringify({ renderer: "react-markdown", fixture: fixture.name, width, openMs, searchMs, publicationMs, mountedRanges: after.ranges, phases, responsiveness, memory, timingScope: "Real viewer with production-built assets. Phases include Playwright synchronization and two frames. Search/syntax stages measure synchronous calls: geometry may force layout; publication does not include deferred paint. Load-normalization-elapsed includes worker startup, transfer, parsing, acknowledgements and scheduling, not main-thread CPU time. Collection reuses the render tree and is included in render-transform time. Decode is asynchronous elapsed time. HAST-ready-to-layout-effect includes element construction, reconciliation, commit and scheduling, not isolated React CPU. Keyboard/navigation samples measure event-handler entry through two frames, not hardware input-to-visible-paint latency. Syntax worker round trips start after intentional holds and include transfer, scheduling, grammar loading and result acknowledgements, not isolated parser CPU.", }), contentType: "application/json", });
        await testInfo.attach("viewer-timing-budgets.json", { body: JSON.stringify({ renderer: "react-markdown", fixture: fixture.name, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, enforced: enforceBudgets, measurementVersion: "browser-action-boundaries-v1", scope: "Text load from file click through two frames; first exact query from its first input event, and warm query/navigation from their input/click events through exact count/highlight readiness and two frames. Timer gaps cover the viewer window, not hardware latency or CPU attribution. Syntax is deliberately held for the existing active-search test; load completion excludes syntax preparation. This subset is not full rollout acceptance.", ...budgetReport }, null, 2), contentType: "application/json" });
        expect(budgetReport.metrics.filter((metric) => metric.status === "invalid"), "Required timing measurements must be present and valid").toEqual([]);
        if (enforceBudgets) expect(budgetReport.status, JSON.stringify(budgetReport.metrics.filter((metric) => metric.status !== "pass"))).toBe("pass");
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

interface SourceResponsivenessProbe {
  measures: { name: string; startTime: number; duration: number; detail: Record<string, unknown> }[];
  jobs: { url: string; ranges: number; rangeBatches: number; changeChunks: number; changeUnits: number; maximumChunkUnits: number; terminated: boolean }[];
  timerGaps: number[];
  completionMs: number | null;
  stop: () => void;
}

interface SourceTypingProbe {
  inputs: { key: string; trusted: boolean; at: number; firstFrameMs: number | null; twoFrameMs: number | null }[];
  measures: { name: string; startTime: number; duration: number; detail: { revision?: number; documentUnits: number } }[];
  gaps: number[];
  longTasks: { startTime: number; duration: number }[];
  longTasksSupported: boolean;
  stop: () => void;
}

for (const width of [1543, 390]) {
  test(`production progressive Markdown loading cancellation at ${width}px`, async ({ browser }, testInfo) => {
    test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
    const source = Array.from({ length: PROSE_ENVELOPE_PARAGRAPHS }, (_, index) => `Paragraph ${index + 1}: **formatted** needle and [link](https://example.com/).`).join("\n\n");
    const proxy = await createCacheableViewerProxy({ initialMarkdown: source });
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
      const page = await context.newPage();
      await page.goto("/browse/smb/demo");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      await page.evaluate(() => {
        const nativeFrame = window.requestAnimationFrame.bind(window);
        const held: FrameRequestCallback[] = [];
        const probe = { hold: true, held, release: () => { probe.hold = false; for (const callback of held.splice(0)) nativeFrame(callback); } };
        (window as typeof window & { progressiveProbe: typeof probe }).progressiveProbe = probe;
        window.requestAnimationFrame = (callback) => nativeFrame((time) => {
          const stage = document.querySelector('[data-markdown-publication="loading"]');
          const viewport = document.querySelector('[data-testid="markdown-viewer-content"]');
          if (probe.hold && stage && viewport && stage.getBoundingClientRect().height >= viewport.clientHeight * 2) held.push(callback);
          else callback(time);
        });
      });
      const file = page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true }));
      await file.click();
      await page.waitForFunction(() => (window as typeof window & { progressiveProbe: { held: unknown[] } }).progressiveProbe.held.length > 0, undefined, { polling: 25 });
      const preview = page.locator('[data-markdown-search-root="true"]');
      expect(await preview.locator("p").count()).toBeLessThan(PROSE_ENVELOPE_PARAGRAPHS);
      await expect(page.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Print", exact: true })).toBeDisabled();
      await expect(page.getByRole("status", { name: "Loading...", exact: true })).toBeVisible();
      await expect(page.getByRole("status", { name: "Loading...", exact: true }).getByRole("progressbar")).toBeInViewport({ ratio: 1 });
      await testInfo.attach("progressive-loading", { body: await page.screenshot(), contentType: "image/png" });
      await page.emulateMedia({ media: "print" });
      await expect(preview).toBeHidden();
      await expect(page.getByText("The document is still loading. Close the print dialog and try again when loading finishes.", { exact: true })).toBeVisible();
      await page.emulateMedia({ media: null });
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await page.evaluate(() => (window as typeof window & { progressiveProbe: { release: () => void } }).progressiveProbe.release());
      await file.click();
      await expect(page.locator('[data-markdown-publication="complete"]')).toBeVisible();
      await expect(preview.locator("p")).toHaveCount(PROSE_ENVELOPE_PARAGRAPHS);
      await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
      await expect(page.getByRole("status", { name: "Loading...", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      expect(proxy.errors).toEqual([]);
    } finally {
      await context?.close();
      await proxy.close();
    }
  });
}

for (const width of [1543, 390]) {
  for (const fixture of ["prose", "table"] as const) {
    test(`production prose table responsiveness ${fixture} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const profiling = process.env.SAMBEE_E2E_TRACE === "1";
      test.skip(profiling && testInfo.project.name !== "chromium", "Load CPU profiling requires Chromium CDP");
      if (process.env.SAMBEE_E2E_MEMORY === "1" || (profiling && process.env.SAMBEE_E2E_BUDGETS === "1")) throw new Error("Document/scroll timing must run separately from GC and profiling");
      const paragraphs = Array.from({ length: PROSE_ENVELOPE_PARAGRAPHS }, (_, index) => `Paragraph ${index + 1}: **formatted** needle and [link](https://example.com/).`);
      const rows = Array.from({ length: TABLE_ENVELOPE_ROWS }, (_, index) => `| ${index + 1} | row ${index + 1} needle |`);
      const source = fixture === "prose" ? `${paragraphs.join("\n\n")}\n` : `| Key | Value |\n| --- | --- |\n${rows.join("\n")}\n`;
      const expectedBlocks = fixture === "prose" ? paragraphs.map((_, index) => `Paragraph ${index + 1}: formatted needle and link.`) : ["Key", "Value", ...rows.flatMap((_, index) => [`${index + 1}`, `row ${index + 1} needle`])];
      const expectedItems = fixture === "prose" ? PROSE_ENVELOPE_PARAGRAPHS : TABLE_ENVELOPE_ROWS;
      const proxy = await createCacheableViewerProxy({ initialMarkdown: source });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        const page = await context.newPage();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.evaluate(({ fixture, expectedItems, profiling }) => {
          const probe = { openAt: null as number | null, completedMs: null as number | null, firstViewportMs: null as number | null, firstViewportItems: null as number | null, maximumTimerGap: 0, stop: () => {} };
          (window as typeof window & { proseTableProbe: typeof probe }).proseTableProbe = probe;
          let previousTick: number | undefined;
          let completing = false;
          document.addEventListener("click", () => { probe.openAt = performance.now(); previousTick = probe.openAt; if (profiling) performance.mark("sambee:viewer-load:start"); }, { once: true, capture: true });
          const timer = setInterval(() => {
            if (previousTick === undefined || probe.completedMs !== null) return;
            const now = performance.now();
            probe.maximumTimerGap = Math.max(probe.maximumTimerGap, now - previousTick);
            previousTick = now;
          }, 0);
          const observer = new MutationObserver(() => {
            const root = document.querySelector('[data-markdown-search-root="true"]');
            if (!root || completing || probe.openAt === null) return;
            const count = root.querySelectorAll(fixture === "prose" ? "p" : "tbody tr").length;
            const viewport = root.parentElement;
            if (probe.firstViewportMs === null && viewport && root.getBoundingClientRect().height >= viewport.clientHeight * 2) {
              probe.firstViewportMs = performance.now() - probe.openAt;
              probe.firstViewportItems = count;
            }
            if (count !== expectedItems) return;
            completing = true;
            requestAnimationFrame(() => requestAnimationFrame(() => { probe.completedMs = performance.now() - (probe.openAt as number); if (profiling) performance.mark("sambee:viewer-load:complete"); }));
          });
          observer.observe(document.body, { childList: true, subtree: true });
          probe.stop = () => { observer.disconnect(); clearInterval(timer); };
        }, { fixture, expectedItems, profiling });
        const profiler = profiling ? await context.newCDPSession(page) : undefined;
        const traceEvents: unknown[] = [];
        if (profiler) {
          profiler.on("Tracing.dataCollected", event => traceEvents.push(...event.value));
          await profiler.send("Profiler.enable");
          await profiler.send("Profiler.start");
          await profiler.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,v8", transferMode: "ReportEvents" });
        }
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await page.waitForFunction(() => (window as typeof window & { proseTableProbe: { completedMs: number | null } }).proseTableProbe.completedMs !== null);
        if (profiler) {
          const profile = await profiler.send("Profiler.stop");
          const tracingComplete = new Promise<void>(resolve => profiler.once("Tracing.tracingComplete", () => resolve()));
          await profiler.send("Tracing.end");
          await tracingComplete;
          expect(profile.profile.samples?.length ?? 0).toBeGreaterThan(0);
          expect(traceEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "sambee:viewer-load:start", ph: "I" }),
            expect.objectContaining({ name: "sambee:viewer-load:complete", ph: "I" }),
          ]));
          await testInfo.attach("viewer-load-cpu-profile", { contentType: "application/json", body: JSON.stringify(profile) });
          await testInfo.attach("viewer-load-timeline", { contentType: "application/json", body: JSON.stringify({ traceEvents }) });
          await profiler.detach();
        }
        const load = await page.evaluate(() => {
          const probe = (window as typeof window & { proseTableProbe: { completedMs: number; firstViewportMs: number | null; firstViewportItems: number | null; maximumTimerGap: number; stop: () => void } }).proseTableProbe;
          probe.stop();
          return { documentCompletion: probe.completedMs, maximumTimerGap: probe.maximumTimerGap, firstViewportMs: probe.firstViewportMs, firstViewportItems: probe.firstViewportItems };
        });
        const preview = page.locator('[data-markdown-search-root="true"]');
        const initialRenderedText = await preview.textContent();
        expect(await preview.locator(fixture === "prose" ? "p" : "th, td").allTextContents()).toEqual(expectedBlocks);
        await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
        const scrolling = await preview.evaluate(async (root, steps) => {
          const scroller = root.parentElement;
          if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) throw new Error("Expected a scrollable full document");
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const nodes: Node[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
          const intervals: number[] = [];
          const offsets: number[] = [];
          const start = performance.now();
          let previous: number | undefined;
          await new Promise<void>(resolve => {
            const frame = (now: number) => {
              if (previous !== undefined) intervals.push(now - previous);
              if (offsets.length === steps) { resolve(); return; }
              previous = now;
              scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * offsets.length / (steps - 1);
              offsets.push(scroller.scrollTop);
              requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          const after = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          const unchanged = nodes.every(node => after.nextNode() === node) && after.nextNode() === null;
          const selection = window.getSelection();
          if (!selection || !nodes.length) throw new Error("Expected native selectable document text");
          const range = document.createRange();
          range.selectNodeContents(root);
          selection.removeAllRanges();
          selection.addRange(range);
          const selected = selection.toString();
          selection.removeAllRanges();
          return { intervals, offsets, elapsedMs: performance.now() - start, unchangedTextNodes: unchanged, sameRoot: document.querySelector('[data-markdown-search-root="true"]') === root, selectedText: selected, physicalRefreshHz: null };
        }, SCROLL_PROBE_STEPS);
        const intervals = [...scrolling.intervals].sort((left, right) => left - right);
        const p95 = intervals[Math.ceil(intervals.length * 0.95) - 1];
        const frameProxy = { p95, maximumMs: Math.max(...intervals), nominal60HzP95TargetMs: NOMINAL_60HZ_SCROLL_TARGETS_MS.p95, nominal60HzMaximumTargetMs: NOMINAL_60HZ_SCROLL_TARGETS_MS.maximum, status: "diagnostic", physicalRefreshHz: null, p95ExceedsNominal: p95 > NOMINAL_60HZ_SCROLL_TARGETS_MS.p95 };
        const budgets = { status: profiling ? "diagnostic" : load.documentCompletion <= VIEWER_TIMING_TARGETS_MS.documentCompletion && load.maximumTimerGap <= VIEWER_TIMING_TARGETS_MS.maximumTimerGap ? "pass" : "fail", documentCompletion: { observedMs: load.documentCompletion, targetMs: VIEWER_TIMING_TARGETS_MS.documentCompletion }, maximumTimerGap: { observedMs: load.maximumTimerGap, targetMs: VIEWER_TIMING_TARGETS_MS.maximumTimerGap } };
        await testInfo.attach("prose-table-responsiveness", { contentType: "application/json", body: JSON.stringify({ fixture, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, browserVersion: browser.version(), sourceUnits: source.length, expectedItems, load, budgets, scrolling: { ...scrolling, selectedText: undefined }, frameProxy, enforced: process.env.SAMBEE_E2E_BUDGETS === "1", limitations: ["Programmatic main-thread scroll and rAF intervals, not wheel/touch/compositor smoothness or hardware paint", "Physical refresh rate and power mode unverified; no physical 60 Hz acceptance", "No eligible fenced syntax in these fixtures; syntax readiness is not applicable", "No application/native CPU attribution is inferred from interval or timer gaps"] }) });
        expect(scrolling.sameRoot && scrolling.unchangedTextNodes).toBe(true);
        expect(scrolling.offsets).toHaveLength(SCROLL_PROBE_STEPS);
        expect(scrolling.offsets[0]).toBe(0);
        expect(scrolling.offsets.at(-1)).toBeGreaterThan(0);
        expect(intervals).toHaveLength(SCROLL_PROBE_STEPS);
        expect(intervals.every(value => Number.isFinite(value) && value > 0)).toBe(true);
        expect(scrolling.selectedText).toContain(fixture === "prose" ? "Paragraph 1: formatted needle and link." : "row 1 needle");
        expect(scrolling.selectedText).toContain(fixture === "prose" ? `Paragraph ${expectedItems}: formatted needle and link.` : `row ${expectedItems} needle`);
        expect(await preview.textContent()).toBe(initialRenderedText);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(preview).toHaveCount(0);
        expect(proxy.errors).toEqual([]);
        expect(Number.isFinite(load.documentCompletion) && load.documentCompletion >= 0).toBe(true);
        expect(Number.isFinite(load.maximumTimerGap) && load.maximumTimerGap >= 0).toBe(true);
        if (process.env.SAMBEE_E2E_BUDGETS === "1") expect(budgets.status, JSON.stringify(budgets)).toBe("pass");
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
  }
}

for (const width of [1543, 390]) {
  for (const fixture of ["dense", "long-line"] as const) {
    test(`production source typing ${fixture} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      if (process.env.SAMBEE_E2E_MEMORY === "1" || process.env.SAMBEE_E2E_TRACE === "1") throw new Error("Typing timing must run separately from GC and profiling");
      const initialMarkdown = `abc 123;${fixture === "dense" ? "\n" : " "}`.repeat(DENSE_SYNTAX_LINE_COUNT);
      const proxy = await createCacheableViewerProxy({ initialMarkdown, wordWrapEnabled: false });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        const page = await context.newPage();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditMode(page);
        const editor = page.getByRole("textbox", { name: "Markdown editor" });
        await editor.click();
        await page.keyboard.press("Control+End");
        await editor.evaluate(async element => {
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const probe: SourceTypingProbe = { inputs: [], measures: [], gaps: [], longTasks: [], longTasksSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"), stop: () => {} };
          (window as typeof window & { sourceTypingProbe: SourceTypingProbe }).sourceTypingProbe = probe;
          let previousTick: number | undefined;
          const timer = setInterval(() => {
            if (previousTick === undefined) return;
            const now = performance.now();
            probe.gaps.push(now - previousTick);
            previousTick = now;
          }, 0);
          const keydown = (event: Event) => {
            if (!(event instanceof KeyboardEvent) || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
            const sample = { key: event.key, trusted: event.isTrusted, at: performance.now(), firstFrameMs: null as number | null, twoFrameMs: null as number | null };
            previousTick ??= sample.at;
            probe.inputs.push(sample);
            requestAnimationFrame(() => {
              sample.firstFrameMs = performance.now() - sample.at;
              requestAnimationFrame(() => { sample.twoFrameMs = performance.now() - sample.at; });
            });
          };
          element.addEventListener("keydown", keydown, true);
          const measures = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              if (!entry.name.startsWith("sambee:source-editor:")) continue;
              const measure = entry as PerformanceMeasure;
              probe.measures.push({ name: measure.name, startTime: measure.startTime, duration: measure.duration, detail: measure.detail });
            }
          });
          measures.observe({ type: "measure" });
          const longTasks = probe.longTasksSupported ? new PerformanceObserver(list => {
            for (const entry of list.getEntries()) probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }) : undefined;
          longTasks?.observe({ type: "longtask" });
          probe.stop = () => { clearInterval(timer); measures.disconnect(); longTasks?.disconnect(); element.removeEventListener("keydown", keydown, true); };
        });
        await page.keyboard.type(SOURCE_TYPING_PAYLOAD, { delay: SOURCE_TYPING_KEY_DELAY_MS });
        await page.waitForFunction(expected => {
          const probe = (window as typeof window & { sourceTypingProbe: SourceTypingProbe }).sourceTypingProbe;
          return probe.inputs.length === expected && probe.inputs.every(sample => sample.twoFrameMs !== null) && probe.measures.filter(entry => entry.name === "sambee:source-editor:publish").length === expected;
        }, SOURCE_TYPING_PAYLOAD.length);
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        const evidence = await page.evaluate(() => {
          const probe = (window as typeof window & { sourceTypingProbe: SourceTypingProbe }).sourceTypingProbe;
          probe.stop();
          return { inputs: probe.inputs, measures: probe.measures, gaps: probe.gaps, longTasks: probe.longTasks, longTasksSupported: probe.longTasksSupported };
        });
        const frames = evidence.inputs.map(sample => sample.twoFrameMs ?? Number.NaN).sort((left, right) => left - right);
        const maximumStage = (name: string) => { const stages = evidence.measures.filter(entry => entry.name === name); return stages.length ? Math.max(...stages.map(entry => entry.duration)) : null; };
        const budgets = evaluateSourceTypingBudgets({ keyboardTwoFrameP95: frames[Math.ceil(frames.length * 0.95) - 1], maximumTimerGap: evidence.gaps.length ? Math.max(...evidence.gaps) : null, serialization: maximumStage("sambee:source-editor:serialize"), synchronousPublication: maximumStage("sambee:source-editor:publish") });
        await testInfo.attach("source-typing", { contentType: "application/json", body: JSON.stringify({ fixture, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, browserVersion: browser.version(), sourceUnits: initialMarkdown.length, inputCount: SOURCE_TYPING_PAYLOAD.length, keyDelayMs: SOURCE_TYPING_KEY_DELAY_MS, evidence, budgets, enforced: process.env.SAMBEE_E2E_BUDGETS === "1", limitations: ["Browser keydown-to-two-frame scheduling proxy, not hardware input or physical paint", "Long Task entries are whole-renderer observations, not isolated application CPU attribution", "Missing Long Tasks support is unmeasured, not a pass"] }) });
        expect(evidence.inputs.map(sample => sample.key).join("")).toBe(SOURCE_TYPING_PAYLOAD);
        expect(evidence.inputs.every(sample => sample.trusted)).toBe(true);
        for (const name of ["serialize", "publish", "normalize", "parent-update"]) {
          const stages = evidence.measures.filter(entry => entry.name === `sambee:source-editor:${name}`);
          expect(stages).toHaveLength(SOURCE_TYPING_PAYLOAD.length);
          expect(stages.map(entry => entry.detail.documentUnits)).toEqual(Array.from({ length: SOURCE_TYPING_PAYLOAD.length }, (_, index) => initialMarkdown.length + index + 1));
        }
        expect(budgets.metrics.filter(metric => metric.status === "invalid")).toEqual([]);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => proxy.uploads.length).toBe(1);
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        expect(await files[0].text()).toBe(`${initialMarkdown}${SOURCE_TYPING_PAYLOAD}`);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        expect(proxy.errors).toEqual([]);
        if (process.env.SAMBEE_E2E_BUDGETS === "1") expect(budgets.status, JSON.stringify(budgets)).toBe("pass");
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
  }
}

const SOURCE_REGEX_PARITY_FIXTURES = [
  { name: "zero-length", source: "alpha beta\nalpha\n", query: "(?=alpha)", replacement: "!", caseSensitive: false, wholeWord: false },
  { name: "case-sensitive", source: "Alpha alpha ALPHA alphabet alpha2\nalpha\n", query: "alpha", replacement: "done", caseSensitive: true, wholeWord: false },
  { name: "whole-word", source: "Alpha alpha alphabet alpha2 _alpha alpha_\nalpha\n", query: "alpha", replacement: "done", caseSensitive: false, wholeWord: true },
  { name: "large-output", source: "alpha\ntail\n", query: "alpha", replacement: "x".repeat(SOURCE_SEARCH_CHUNK_UNITS * 2 + 1), caseSensitive: false, wholeWord: false },
] as const;

function nativeSourceRegexOutcome(fixture: typeof SOURCE_REGEX_PARITY_FIXTURES[number]) {
  const query = new SearchQuery({ search: fixture.query, replace: fixture.replacement, regexp: true, literal: true, caseSensitive: fixture.caseSensitive, wholeWord: fixture.wholeWord });
  let state = EditorState.create({ doc: fixture.source, extensions: [search()] });
  state = state.update({ effects: setSearchQuery.of(query) }).state;
  const cursor = query.getCursor(state);
  let count = 0;
  for (let match = cursor.next(); !match.done; match = cursor.next()) count += 1;
  nativeReplaceAll({ get state() { return state; }, plugin: () => null, dispatch: (spec: TransactionSpec) => { state = state.update(spec).state; } } as unknown as EditorView);
  return { count, output: state.doc.toString() };
}

for (const width of [1543, 390]) {
  for (const fixture of SOURCE_REGEX_PARITY_FIXTURES) {
    test(`production source regex parity ${fixture.name} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const expected = nativeSourceRegexOutcome(fixture);
      expect(expected.count).toBeGreaterThan(0);
      expect(expected.output).not.toBe(fixture.source);
      const proxy = await createCacheableViewerProxy({ initialMarkdown: fixture.source, wordWrapEnabled: false });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        await context.addInitScript(() => {
          const jobs: { url: string; terminated: boolean; changeChunks: number; continuedChunks: number; maximumChunkUnits: number; insertedUnits: number }[] = [];
          (window as typeof window & { sourceParityJobs: typeof jobs }).sourceParityJobs = jobs;
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            private job: typeof jobs[number];
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              this.job = { url: String(url), terminated: false, changeChunks: 0, continuedChunks: 0, maximumChunkUnits: 0, insertedUnits: 0 };
              jobs.push(this.job);
              this.addEventListener("message", event => {
                const message = event.data;
                if (message?.type !== "change") return;
                this.job.changeChunks += 1;
                this.job.continuedChunks += Number(message.continued);
                this.job.insertedUnits += message.insert.length;
                this.job.maximumChunkUnits = Math.max(this.job.maximumChunkUnits, message.insert.length);
              });
            }
            terminate() { this.job.terminated = true; super.terminate(); }
          };
        });
        const page = await context.newPage();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditMode(page);
        await page.getByRole("textbox", { name: "Markdown editor" }).click();
        await page.keyboard.press("Control+h");
        const controls = page.getByRole("search");
        await controls.getByRole("button", { name: "Use regular expression", exact: true }).click();
        if (fixture.caseSensitive) await controls.getByRole("button", { name: "Match case", exact: true }).click();
        if (fixture.wholeWord) await controls.getByRole("button", { name: "Match whole word", exact: true }).click();
        await controls.getByRole("textbox", { name: "Find", exact: true }).fill(fixture.query);
        await controls.getByRole("textbox", { name: "Replace", exact: true }).fill(fixture.replacement);
        await expect(controls.getByText(`0 / ${expected.count}`, { exact: true })).toBeVisible();
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await controls.getByRole("button", { name: "Replace all", exact: true }).click();
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        await expect(controls.getByRole("alert")).toHaveCount(0);
        await controls.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => proxy.uploads.length).toBe(1);
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        expect(await files[0].text()).toBe(expected.output);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { sourceParityJobs: { terminated: boolean }[] }).sourceParityJobs.filter(job => !job.terminated).length)).toBe(0);
        const jobs = await page.evaluate(() => (window as typeof window & { sourceParityJobs: unknown[] }).sourceParityJobs);
        const replacements = (jobs as { changeChunks: number; continuedChunks: number; maximumChunkUnits: number; insertedUnits: number }[]).filter(job => job.changeChunks > 0);
        expect(replacements).toHaveLength(1);
        expect(replacements[0].maximumChunkUnits).toBeLessThanOrEqual(SOURCE_SEARCH_CHUNK_UNITS);
        if (fixture.name === "large-output") {
          expect(replacements[0].changeChunks).toBe(3);
          expect(replacements[0].continuedChunks).toBe(2);
          expect(replacements[0].insertedUnits).toBe(fixture.replacement.length);
        }
        await testInfo.attach("source-regex-parity", { contentType: "application/json", body: JSON.stringify({ fixture: fixture.name, width, count: expected.count, sourceUnits: fixture.source.length, outputUnits: expected.output.length, jobs, policy: "Functional parity with native CodeMirror commands; not timing or memory acceptance" }) });
        expect(proxy.errors).toEqual([]);
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
  }
}

for (const width of [1543, 390]) {
  for (const fault of ["startup", "crash", "decode", "timeout", "delivery-cancel"] as const) {
    test(`production source regex lifecycle ${fault} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const initialMarkdown = "abc 123;\n".repeat(DENSE_SYNTAX_LINE_COUNT);
      const proxy = await createCacheableViewerProxy({ initialMarkdown, wordWrapEnabled: false });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        await context.addInitScript((fault) => {
          const probe = { injected: 0, deliveredChanges: 0, jobs: [] as { sourceSearch: boolean; terminated: boolean }[], replay: () => {} };
          (window as typeof window & { sourceLifecycleProbe: typeof probe }).sourceLifecycleProbe = probe;
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            private job: typeof probe.jobs[number];
            constructor(url: string | URL, options?: WorkerOptions) {
              const sourceSearch = String(url).includes("sourceRegexSearch.worker");
              if (sourceSearch && fault === "startup" && probe.injected === 0) {
                probe.injected += 1;
                throw new Error("Injected source-search construction failure");
              }
              super(url, options);
              this.job = { sourceSearch, terminated: false };
              probe.jobs.push(this.job);
              this.addEventListener("message", event => {
                if (!sourceSearch || probe.injected > 0) return;
                if (fault === "delivery-cancel") {
                  if (event.data?.type !== "change") return;
                  if (probe.deliveredChanges++ === 0) return;
                  event.stopImmediatePropagation();
                  probe.injected += 1;
                  const stale = event.data;
                  probe.replay = () => {
                    this.dispatchEvent(new MessageEvent("message", { data: stale }));
                    this.dispatchEvent(new MessageEvent("message", { data: { type: "complete", announcements: [], userEvent: "input.replace.all" } }));
                  };
                } else if (event.data?.type === "ready") {
                  event.stopImmediatePropagation();
                  probe.injected += 1;
                  if (fault === "crash") this.dispatchEvent(new ErrorEvent("error", { message: "Injected source-search execution failure", cancelable: true }));
                  if (fault === "decode") this.dispatchEvent(new MessageEvent("messageerror"));
                }
              }, { capture: true });
            }
            terminate() { this.job.terminated = true; super.terminate(); }
          };
        }, fault);
        const page = await context.newPage();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditMode(page);
        const editor = page.getByRole("textbox", { name: "Markdown editor" });
        await editor.click();
        await page.keyboard.press("Control+h");
        const controls = page.getByRole("search");
        await controls.getByRole("button", { name: "Use regular expression", exact: true }).click();
        await controls.getByRole("textbox", { name: "Find", exact: true }).fill("abc (123)");
        if (fault === "delivery-cancel") {
          await controls.getByRole("textbox", { name: "Replace", exact: true }).fill("replaced-$1");
          await expect(controls.getByText(`0 / ${DENSE_SYNTAX_LINE_COUNT}`, { exact: true })).toBeVisible();
          await page.mouse.move(0, 0);
          await expect(page.getByRole("tooltip")).toHaveCount(0);
          await controls.getByRole("button", { name: "Replace all", exact: true }).click();
          await page.waitForFunction(() => (window as typeof window & { sourceLifecycleProbe: { injected: number } }).sourceLifecycleProbe.injected === 1);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
        } else {
          const messages = { startup: /requires a working dedicated worker/, crash: /worker failed/, decode: /could not be decoded/, timeout: /did not start/ };
          await expect(controls.getByRole("alert")).toContainText(messages[fault]);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
          await page.mouse.move(0, 0);
          await expect(page.getByRole("tooltip")).toHaveCount(0);
          await controls.getByRole("button", { name: "Next match", exact: true }).click();
          await expect(controls.getByText(new RegExp(`^\\d+ / ${DENSE_SYNTAX_LINE_COUNT}$`))).toBeVisible();
          await expect(controls.getByRole("alert")).toHaveCount(0);
        }
        await editor.focus();
        await page.keyboard.press("Control+End");
        await page.keyboard.type("!");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        if (fault === "delivery-cancel") await page.evaluate(() => (window as typeof window & { sourceLifecycleProbe: { replay: () => void } }).sourceLifecycleProbe.replay());
        await controls.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => proxy.uploads.length).toBe(1);
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        expect(await files[0].text()).toBe(`${initialMarkdown}!`);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { sourceLifecycleProbe: { jobs: { terminated: boolean }[] } }).sourceLifecycleProbe.jobs.filter(job => !job.terminated).length)).toBe(0);
        const evidence = await page.evaluate(() => {
          const probe = (window as typeof window & { sourceLifecycleProbe: { injected: number; deliveredChanges: number; jobs: { sourceSearch: boolean; terminated: boolean }[] } }).sourceLifecycleProbe;
          return { injected: probe.injected, deliveredChanges: probe.deliveredChanges, jobs: probe.jobs };
        });
        expect(evidence.injected).toBe(1);
        expect(evidence.jobs.filter(job => job.sourceSearch).length).toBeGreaterThan(1);
        if (fault === "delivery-cancel") expect(evidence.deliveredChanges).toBe(2);
        await testInfo.attach("source-regex-lifecycle", { contentType: "application/json", body: JSON.stringify({ fault, width, evidence, policy: "Test-only constructor/event/ready-message injection; functional recovery and stale-delivery rejection, not timing or memory acceptance" }) });
        expect(proxy.errors).toEqual([]);
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
  }
}

interface ReplacementFeedbackProbe {
  hold: boolean;
  additions: number;
  frames: { width: number; height: number; original: boolean; animation: string }[];
  release: () => void;
}

for (const width of [1543, 390]) {
  for (const regexp of [false, true]) {
    test(`production replacement feedback ${regexp ? "regex keyboard" : "literal toolbar"} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const initialMarkdown = `${"abc 123;\n".repeat(DENSE_SYNTAX_LINE_COUNT)}tail`;
      const replacement = "x".repeat(DENSE_EXPANSION_REPLACEMENT_UNITS);
      const expected = `${`${replacement};\n`.repeat(DENSE_SYNTAX_LINE_COUNT)}tail`;
      const proxy = await createCacheableViewerProxy({ initialMarkdown, wordWrapEnabled: false });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        await context.addInitScript(() => {
          const nativeFrame = window.requestAnimationFrame.bind(window);
          const held: FrameRequestCallback[] = [];
          const probe: ReplacementFeedbackProbe = { hold: false, additions: 0, frames: [], release: () => {
            probe.hold = false;
            for (const callback of held.splice(0)) nativeFrame(callback);
          } };
          (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe = probe;
          window.requestAnimationFrame = callback => nativeFrame(time => {
            if (probe.hold && document.querySelector(".sambee-source-replacement-feedback")) held.push(callback);
            else callback(time);
          });
          new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (!(node instanceof HTMLElement) || !node.matches(".sambee-source-replacement-feedback")) continue;
              probe.additions += 1;
              nativeFrame(() => {
                const rect = node.getBoundingClientRect();
                probe.frames.push({ width: rect.width, height: rect.height, original: Boolean(document.querySelector(".cm-content")?.textContent?.includes("abc 123")), animation: node.querySelector("span")?.getAnimations()[0]?.playState ?? "unavailable" });
              });
            }
          }).observe(document, { childList: true, subtree: true });
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditMode(page);
        const editor = page.getByRole("textbox", { name: "Markdown editor" });
        await editor.click();
        await page.keyboard.press("Control+h");
        const controls = page.getByRole("search");
        if (regexp) await controls.getByRole("button", { name: "Use regular expression", exact: true }).click();
        const find = controls.getByRole("textbox", { name: "Find", exact: true });
        const replace = controls.getByRole("textbox", { name: "Replace", exact: true });
        await find.fill("tail");
        await replace.fill("done");
        await expect(controls.getByText(/^[01] \/ 1$/)).toBeVisible();
        await page.mouse.move(0, 0);
        await controls.getByRole("button", { name: "Replace all", exact: true }).click();
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        expect(await page.evaluate(() => (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe.additions)).toBe(0);
        await editor.focus();
        await page.keyboard.press("Control+z");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
        await find.fill("abc 123");
        await replace.fill(replacement);
        await expect(controls.getByText(`0 / ${DENSE_SYNTAX_LINE_COUNT}`, { exact: true })).toBeVisible();
        await page.evaluate(() => { (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe.hold = true; });
        if (regexp) { await replace.focus(); await replace.press("Control+Alt+Enter"); }
        else await controls.getByRole("button", { name: "Replace all", exact: true }).click();
        const feedback = page.locator(".sambee-source-replacement-feedback");
        await expect(feedback).toBeVisible();
        await expect(feedback).toHaveAttribute("role", "status");
        await expect(editor).toHaveAttribute("aria-busy", "true");
        await expect.poll(() => page.evaluate(() => (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe.frames.length)).toBeGreaterThan(0);
        await testInfo.attach("replacement-feedback.png", { body: await page.screenshot(), contentType: "image/png" });
        const frames = await page.evaluate(() => (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe.frames);
        expect(frames.every(frame => frame.width > 0 && frame.height > 0 && frame.original && frame.animation === "running")).toBe(true);
        await page.evaluate(() => (window as typeof window & { replacementFeedbackProbe: ReplacementFeedbackProbe }).replacementFeedbackProbe.release());
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        await expect(feedback).toHaveCount(0);
        await expect(editor).not.toHaveAttribute("aria-busy");
        await editor.focus();
        await page.keyboard.press("Control+z");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
        await page.keyboard.press("Control+Shift+Z");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        await controls.getByRole("button", { name: "Close", exact: true }).click();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => proxy.uploads.length).toBe(1);
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        expect(await files[0].text()).toBe(expected);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(editor).toHaveCount(0);
        await expect(feedback).toHaveCount(0);
        expect(errors).toEqual([]);
        expect(proxy.errors).toEqual([]);
        await testInfo.attach("replacement-feedback", { contentType: "application/json", body: JSON.stringify({ width, regexp, frames, exactSaveUnits: expected.length, policy: "Functional feedback/paint and atomic-history check with held animation frames; not timing acceptance." }) });
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
  }
}

for (const width of [1543, 390]) {
  for (const fixture of ["dense", "long-line"] as const) {
    for (const expansion of [false, true]) {
    test(`production source ${expansion ? "dense expansion" : "responsiveness"} ${fixture} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const profiling = process.env.SAMBEE_E2E_TRACE === "1";
      const memoryMode = process.env.SAMBEE_E2E_MEMORY === "1";
      const diagnostic = profiling || memoryMode;
      test.skip(diagnostic && testInfo.project.name !== "chromium", "Source memory/CPU diagnostics require Chromium CDP");
      if ((memoryMode && profiling) || (diagnostic && process.env.SAMBEE_E2E_BUDGETS === "1")) throw new Error("Source timing, GC and tracing must run separately");
      const initialMarkdown = `abc 123;${fixture === "dense" ? "\n" : " "}`.repeat(DENSE_SYNTAX_LINE_COUNT);
      const replacement = expansion ? "x".repeat(DENSE_EXPANSION_REPLACEMENT_UNITS) : "replaced-$1";
      const expectedMarkdown = initialMarkdown.replace(/abc (123)/g, replacement);
      if (expansion) {
        expect(initialMarkdown).toHaveLength(54_000);
        expect(expectedMarkdown).toHaveLength(DENSE_EXPANSION_OUTPUT_UNITS);
      }
      const proxy = await createCacheableViewerProxy({ initialMarkdown, wordWrapEnabled: false });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        await context.addInitScript(() => {
          const probe: SourceResponsivenessProbe = { measures: [], jobs: [], timerGaps: [], completionMs: null, stop: () => {} };
          (window as typeof window & { sourceResponsivenessProbe: SourceResponsivenessProbe }).sourceResponsivenessProbe = probe;
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            private job: SourceResponsivenessProbe["jobs"][number];
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              this.job = { url: String(url), ranges: 0, rangeBatches: 0, changeChunks: 0, changeUnits: 0, maximumChunkUnits: 0, terminated: false };
              probe.jobs.push(this.job);
              this.addEventListener("message", event => {
                const message = event.data;
                if (message?.type === "ranges") { this.job.ranges += message.ranges.length; this.job.rangeBatches += 1; }
                if (message?.type === "change") { this.job.changeChunks += 1; this.job.changeUnits += message.insert.length; this.job.maximumChunkUnits = Math.max(this.job.maximumChunkUnits, message.insert.length); }
              });
            }
            terminate() { this.job.terminated = true; super.terminate(); }
          };
          let commandStart: number | undefined;
          let previousTick: number | undefined;
          const timer = window.setInterval(() => {
            if (commandStart === undefined || probe.completionMs !== null) return;
            const now = performance.now();
            if (previousTick !== undefined) probe.timerGaps.push(now - previousTick);
            previousTick = now;
          }, 0);
          document.addEventListener("click", event => {
            if (!(event.target instanceof Element) || !event.target.closest('button[aria-label="Replace all"]')) return;
            commandStart = performance.now();
            previousTick = commandStart;
          }, true);
          const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
              if (!entry.name.startsWith("sambee:source-")) continue;
              const measure = entry as PerformanceMeasure;
              probe.measures.push({ name: measure.name, startTime: measure.startTime, duration: measure.duration, detail: measure.detail });
              if (measure.name === "sambee:source-search:commit" && measure.detail.operation === "replace-all") {
                const start = commandStart;
                if (start === undefined) continue;
                const observeParentUpdate = () => {
                  if (!document.querySelector('[role="status"][aria-label="Unsaved changes"]')) {
                    requestAnimationFrame(observeParentUpdate);
                    return;
                  }
                  requestAnimationFrame(() => requestAnimationFrame(() => { probe.completionMs = performance.now() - start; }));
                };
                requestAnimationFrame(observeParentUpdate);
              }
            }
          });
          observer.observe({ type: "measure" });
          probe.stop = () => { observer.disconnect(); clearInterval(timer); };
        });
        const page = await context.newPage();
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        const memorySession = memoryMode ? await context.newCDPSession(page) : undefined;
        const memorySamples: { stage: string; usedSize: number; totalSize: number }[] = [];
        const sampleMemory = async (stage: string) => {
          if (!memorySession) return;
          await memorySession.send("HeapProfiler.collectGarbage");
          const heap = await memorySession.send("Runtime.getHeapUsage");
          memorySamples.push({ stage, usedSize: heap.usedSize, totalSize: heap.totalSize });
        };
        await sampleMemory("pre-open");
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditMode(page);
        const editor = page.getByRole("textbox", { name: "Markdown editor" });
        await editor.click();
        await page.keyboard.press("Control+h");
        const search = page.getByRole("search");
        await search.getByRole("button", { name: "Use regular expression", exact: true }).click();
        await search.getByRole("textbox", { name: "Find", exact: true }).fill("abc (123)");
        await search.getByRole("textbox", { name: "Replace", exact: true }).fill(replacement);
        await expect(search.getByText(`0 / ${DENSE_SYNTAX_LINE_COUNT}`, { exact: true })).toBeVisible();
        await sampleMemory("counted-results");
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const profiler = profiling ? await context.newCDPSession(page) : undefined;
        if (profiler) {
          await profiler.send("Profiler.enable");
          await profiler.send("Profiler.start");
        }
        await search.getByRole("button", { name: "Replace all", exact: true }).click();
        await page.waitForFunction(() => (window as typeof window & { sourceResponsivenessProbe: SourceResponsivenessProbe }).sourceResponsivenessProbe.completionMs !== null);
        await expect(search.getByText("0 / 0", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
        await sampleMemory("post-replacement");
        const evidence = await page.evaluate(() => {
          const probe = (window as typeof window & { sourceResponsivenessProbe: SourceResponsivenessProbe }).sourceResponsivenessProbe;
          probe.stop();
          return { measures: probe.measures, jobs: probe.jobs, completionMs: probe.completionMs, maximumTimerGap: probe.timerGaps.length ? Math.max(...probe.timerGaps) : null };
        });
        if (profiler) {
          const profile = await profiler.send("Profiler.stop");
          await testInfo.attach("source-dispatch-cpu-profile", { contentType: "application/json", body: JSON.stringify(profile) });
          await profiler.detach();
        }
        const commit = evidence.measures.filter(entry => entry.name === "sambee:source-search:commit" && entry.detail.operation === "replace-all");
        const serialization = evidence.measures.filter(entry => entry.name === "sambee:source-editor:serialize");
        const publication = evidence.measures.filter(entry => entry.name === "sambee:source-editor:publish");
        const budgets = evaluateSourceResponsivenessBudgets({ atomicCommit: commit[0]?.duration, serialization: serialization[0]?.duration, synchronousPublication: publication[0]?.duration, maximumTimerGap: evidence.maximumTimerGap }, diagnostic);
        await testInfo.attach("source-responsiveness", { contentType: "application/json", body: JSON.stringify({ fixture, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, operation: expansion ? "dense-expansion" : "original", surface: "markdown-source", cacheState: "fresh-context/fresh-workers", sourceUnits: initialMarkdown.length, outputUnits: expectedMarkdown.length, evidence, budgets, enforced: process.env.SAMBEE_E2E_BUDGETS === "1", command: `SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production source ${expansion ? "dense expansion" : "responsiveness"}' --workers=1 --repeat-each=3 --reporter=json`, limitations: ["Two animation frames are a scheduling proxy, not hardware paint or isolated React CPU", "Transfer counts are not retained/peak heap measurements", "Synchronous publication includes normalization and the parent callback, not deferred React work"] }) });
        expect(commit).toHaveLength(1);
        expect(serialization).toHaveLength(1);
        expect(publication).toHaveLength(1);
        expect(evidence.measures.filter(entry => entry.name === "sambee:source-editor:normalize")).toHaveLength(1);
        expect(evidence.measures.filter(entry => entry.name === "sambee:source-editor:parent-update")).toHaveLength(1);
        expect(budgets.metrics.filter(metric => metric.status === "invalid")).toEqual([]);
        expect(commit[0].detail).toMatchObject({ documentUnits: initialMarkdown.length, changes: DENSE_SYNTAX_LINE_COUNT });
        expect(serialization[0].detail.documentUnits).toBe(expectedMarkdown.length);
        expect(evidence.jobs.some(job => job.ranges === DENSE_SYNTAX_LINE_COUNT && job.rangeBatches > 1)).toBe(true);
        const replacementJobs = evidence.jobs.filter(job => job.changeChunks > 0);
        expect(replacementJobs).toHaveLength(1);
        expect(replacementJobs[0].changeUnits).toBe((expansion ? DENSE_EXPANSION_REPLACEMENT_UNITS : "replaced-123".length) * DENSE_SYNTAX_LINE_COUNT);
        expect(replacementJobs[0].maximumChunkUnits).toBeLessThanOrEqual(SOURCE_SEARCH_CHUNK_UNITS);
        await search.getByRole("button", { name: "Close", exact: true }).click();
        await editor.focus();
        await page.keyboard.press("Control+z");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
        await page.keyboard.press("Control+h");
        await search.getByRole("textbox", { name: "Find", exact: true }).fill("abc (123)");
        await expect(search.getByText(`0 / ${DENSE_SYNTAX_LINE_COUNT}`, { exact: true })).toBeVisible();
        await search.getByRole("button", { name: "Close", exact: true }).click();
        await editor.focus();
        await page.keyboard.press("Control+Shift+z");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => proxy.uploads.length).toBe(1);
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        expect(await files[0].text()).toBe(expectedMarkdown);
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => (window as typeof window & { sourceResponsivenessProbe: SourceResponsivenessProbe }).sourceResponsivenessProbe.jobs.filter(job => !job.terminated).length)).toBe(0);
        await sampleMemory("post-close");
        if (memorySession) {
          const loadedRendererHeapCeilingBytes = 64 * 1024 * 1024;
          await testInfo.attach("source-renderer-memory", { contentType: "application/json", body: JSON.stringify({ fixture, width, browserVersion: browser.version(), method: "Chromium CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage at named boundaries", samples: memorySamples, loadedRendererHeapCeilingBytes, limitations: ["Observed post-GC renderer heap, not peak/worker/native/private-process memory", "Counted-results includes the whole loaded viewer, not isolated match-range bytes", "One close isn't six warmed close/reopen growth acceptance"] }) });
          expect(memorySamples.map(sample => sample.stage)).toEqual(["pre-open", "counted-results", "post-replacement", "post-close"]);
          for (const sample of memorySamples) expect(Number.isFinite(sample.usedSize) && sample.usedSize > 0).toBe(true);
          for (const sample of memorySamples.filter(sample => sample.stage === "counted-results" || sample.stage === "post-replacement")) expect(sample.usedSize).toBeLessThanOrEqual(loadedRendererHeapCeilingBytes);
          await memorySession.detach();
        }
        expect(proxy.errors).toEqual([]);
        if (process.env.SAMBEE_E2E_BUDGETS === "1") expect(budgets.status, JSON.stringify(budgets)).toBe("pass");
      } finally {
        await context?.close();
        await proxy.close();
      }
    });
    }
  }
}

for (const width of [1543, 390]) {
  for (const fixture of TABLE_EDIT_CASES) {
    test(`production large table editing ${fixture.name} at ${width}px`, async ({ browser }, testInfo) => {
      test.skip(process.env.SAMBEE_E2E_PRODUCTION !== "1", "Requires the normal production build");
      const profiling = process.env.SAMBEE_E2E_TRACE === "1";
      if (process.env.SAMBEE_E2E_MEMORY === "1" || (profiling && process.env.SAMBEE_E2E_BUDGETS === "1")) throw new Error("Table editing timing must run separately from GC and profiling");
      if (profiling && testInfo.project.name !== "chromium" && (process.env.MOZ_PROFILER_STARTUP !== "1" || !process.env.MOZ_PROFILER_SHUTDOWN)) throw new Error("Firefox table diagnostics require native startup profiling and a shutdown profile path");
      const startedAt = performance.now();
      const lifecycle: { stage: string; elapsedMs: number }[] = [];
      const recordStage = (stage: string) => lifecycle.push({ stage, elapsedMs: performance.now() - startedAt });
      const pageErrors: string[] = [];
      const rows = Array.from({ length: TABLE_ENVELOPE_ROWS }, (_, index) => `| ${index + 1} | row ${index + 1} needle |`);
      const source = `| Key | Value |\n| --- | --- |\n${rows.join("\n")}\n`;
      const cellWidth = Math.max(String(TABLE_ENVELOPE_ROWS).length, String(fixture.row).length + (fixture.action === "line-break" ? "<br>".length : 0) + TABLE_EDIT_PAYLOAD.length);
      const valueWidth = `row ${TABLE_ENVELOPE_ROWS} needle`.length;
      const expectedRows = rows.map((_, index) => {
        const value = `${index + 1}${index + 1 === fixture.row ? `${fixture.action === "line-break" ? "<br>" : ""}${TABLE_EDIT_PAYLOAD}` : ""}`;
        return `| ${value.padEnd(cellWidth)} | ${`row ${index + 1} needle`.padEnd(valueWidth)} |`;
      });
      const expected = `\n| ${"Key".padEnd(cellWidth)} | ${"Value".padEnd(valueWidth)} |\n| ${"-".repeat(cellWidth)} | ${"-".repeat(valueWidth)} |\n${expectedRows.join("\n")}\n`.replace("<br>", "<br />");
      const proxy = await createCacheableViewerProxy({ initialMarkdown: source });
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block", proxy: { server: proxy.url, bypass: "<-loopback>" } });
        const page = await context.newPage();
        page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
        const markPhase = async (phase: string) => {
          if (profiling) await page.evaluate(name => performance.mark(`sambee:table-phase:${name}`), phase);
        };
        await page.goto("/browse/smb/demo");
        await page.getByRole("button", { name: "Later", exact: true }).click();
        await page.getByRole("button", { name: DEMO_PATH, exact: true }).or(page.getByRole("button", { name: `File: ${DEMO_PATH}`, exact: true })).click();
        await enterMarkdownEditModeWithTable(page);
        await expect(page.locator(".tbl-data-cell")).toHaveCount(TABLE_ENVELOPE_ROWS * 2);
        const cell = page.locator(".tbl-data-cell .tbl-cell-view").nth((fixture.row - 1) * 2);
        const nested = await activateCellEditor(cell);
        await expect(nested).toHaveText(String(fixture.row));
        await page.keyboard.press("End");
        recordStage("cell-ready");
        await page.evaluate(() => {
          const probe = { content: document.activeElement, measures: [] as { name: string; duration: number; startTime: number; detail: unknown }[], inputs: [] as number[], gaps: [] as number[], events: [] as { type: string; phase: string; contentId: number | null; connected: boolean; trusted: boolean; key?: string; data?: string | null; inputType?: string; isComposing?: boolean; text: string | null; nested: boolean; prevented: boolean; activeText: string | null; selectionText: string | null }[], stop: () => {} };
          (window as typeof window & { tableEditProbe: typeof probe }).tableEditProbe = probe;
          let previous: number | undefined;
          const input = () => {
            const start = performance.now();
            previous ??= start;
            requestAnimationFrame(() => requestAnimationFrame(() => probe.inputs.push(performance.now() - start)));
          };
          document.addEventListener("beforeinput", input, true);
          const contentIds = new WeakMap<Element, number>();
          let nextContentId = 0;
          const observeInput = (event: Event) => {
            if (!(event.target instanceof Element) || probe.events.length >= 256) return;
            const content = event.target.closest(".cm-content");
            if (content && !contentIds.has(content)) contentIds.set(content, ++nextContentId);
            const record = (phase: string) => {
              if (probe.events.length >= 256) return;
              const selection = document.getSelection();
              probe.events.push({ type: event.type, phase, contentId: content ? contentIds.get(content) ?? null : null, connected: content?.isConnected ?? false, trusted: event.isTrusted, key: event instanceof KeyboardEvent ? event.key : undefined, data: event instanceof InputEvent || event instanceof CompositionEvent ? event.data : undefined, inputType: event instanceof InputEvent ? event.inputType : undefined, isComposing: event instanceof InputEvent ? event.isComposing : undefined, text: content?.closest(".tbl-cell-editor") ? content.textContent : null, nested: Boolean(content?.closest(".tbl-cell-editor")), prevented: event.defaultPrevented, activeText: document.activeElement?.closest(".tbl-cell-editor")?.textContent ?? null, selectionText: selection?.anchorNode?.textContent ?? null });
            };
            record("capture");
            queueMicrotask(() => record("after-event"));
          };
          const eventTypes = ["keydown", "beforeinput", "input", "compositionstart", "compositionend", "focusin", "focusout"];
          for (const type of eventTypes) document.addEventListener(type, observeInput, true);
          const timer = setInterval(() => {
            if (previous === undefined) return;
            const now = performance.now();
            probe.gaps.push(now - previous);
            previous = now;
          }, 0);
          const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) if (entry.name.startsWith("sambee:source-editor:") || entry.name.startsWith("sambee:edit-preparation:")) probe.measures.push({ name: entry.name, duration: entry.duration, startTime: entry.startTime, detail: entry instanceof PerformanceMeasure ? entry.detail : null });
          });
          observer.observe({ type: "measure" });
          probe.stop = () => { observer.disconnect(); clearInterval(timer); document.removeEventListener("beforeinput", input, true); for (const type of eventTypes) document.removeEventListener(type, observeInput, true); };
        });
        await captureViewerScheduling(page, testInfo, async () => {
        await markPhase("typing-start");
        let compositionMethod: string | null = null;
        const composing = fixture.action === "composition" || fixture.action === "composition-close";
        const saveOnClose = fixture.action === "close" || fixture.action === "composition-close";
          if (fixture.action === "line-break") await page.keyboard.press("Shift+Enter");
          if (composing && testInfo.project.name === "chromium") {
            compositionMethod = "Chromium CDP composition and commit with untrusted composition-end event; not physical IME";
            const session = await context.newCDPSession(page);
            try {
              await session.send("Input.imeSetComposition", { text: TABLE_EDIT_PAYLOAD, selectionStart: TABLE_EDIT_PAYLOAD.length, selectionEnd: TABLE_EDIT_PAYLOAD.length });
              await session.send("Input.insertText", { text: TABLE_EDIT_PAYLOAD });
            } finally { await session.detach(); }
          } else if (composing) {
            compositionMethod = "Firefox browser composition from Playwright text insertion; not physical IME acceptance";
            await page.keyboard.insertText(TABLE_EDIT_PAYLOAD);
          } else await page.keyboard.type(TABLE_EDIT_PAYLOAD, { delay: SOURCE_TYPING_KEY_DELAY_MS });
        recordStage("input-complete");
        await markPhase("typing-complete");
        await expect(nested).toBeFocused();
        await markPhase("save-start");
        if (saveOnClose) {
          await page.getByRole("button", { name: "Close", exact: true }).click();
          await page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Unsaved changes", exact: true }) }).getByRole("button", { name: "Save", exact: true }).click();
        } else await page.getByRole("button", { name: "Save", exact: true }).click();
        recordStage("save-clicked");
        await testInfo.attach("large-table-input", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => (window as typeof window & { tableEditProbe: { events: unknown[] } }).tableEditProbe.events)) });
        await expect.poll(() => proxy.uploads.length).toBe(1);
        if (composing) {
          const compositionEvents = await page.evaluate(() => (window as typeof window & { tableEditProbe: { events: { type: string; trusted: boolean; phase: string; isComposing?: boolean }[] } }).tableEditProbe.events.filter(event => event.phase === "capture"));
          expect(compositionEvents.some(event => event.type === "compositionstart" && event.trusted)).toBe(true);
          expect(compositionEvents.some(event => event.type === "beforeinput" && event.isComposing && event.trusted)).toBe(true);
          expect(compositionEvents.some(event => event.type === "compositionend" && (event.trusted || testInfo.project.name === "chromium")), JSON.stringify(compositionEvents)).toBe(true);
        }
        const upload = proxy.uploads[0];
        const form = await new Response(upload.body, { headers: { "Content-Type": upload.contentType } }).formData();
        const files = [...form.values()].filter((value): value is File => typeof value !== "string");
        expect(files).toHaveLength(1);
        const saved = await files[0].text();
        await testInfo.attach("large-table-save.txt", { contentType: "text/plain", body: saved });
        expect(saved === expected, `Exact canonical Save mismatch: expected ${expected.length} units, received ${saved.length}`).toBe(true);
        recordStage("save-verified");
        await markPhase("save-verified");
        const evidence = await page.evaluate(async () => {
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const probe = (window as typeof window & { tableEditProbe: { content: Element | null; measures: { name: string; duration: number }[]; inputs: number[]; gaps: number[]; stop: () => void } }).tableEditProbe;
          probe.stop();
          return { measures: probe.measures, inputs: probe.inputs, gaps: probe.gaps, retainedCell: probe.content?.isConnected ?? false, cellFocused: document.activeElement === probe.content };
        });
        const frames = [...evidence.inputs].sort((left, right) => left - right);
        const maximumStage = (name: string) => { const stages = evidence.measures.filter(entry => entry.name === name); return stages.length ? Math.max(...stages.map(entry => entry.duration)) : null; };
        const budgets = evaluateSourceTypingBudgets({ keyboardTwoFrameP95: frames[Math.ceil(frames.length * 0.95) - 1], maximumTimerGap: evidence.gaps.length ? Math.max(...evidence.gaps) : null, serialization: maximumStage("sambee:source-editor:serialize"), synchronousPublication: maximumStage("sambee:source-editor:publish") });
        await testInfo.attach("large-table-editing", { contentType: "application/json", body: JSON.stringify({ fixture: fixture.name, row: fixture.row, rows: TABLE_ENVELOPE_ROWS, width, engine: testInfo.project.name, trial: testInfo.repeatEachIndex, surface: "markdown-table", cacheState: "fresh-context/fresh-workers", sourceUnits: source.length, outputUnits: expected.length, payload: TABLE_EDIT_PAYLOAD, compositionMethod, saveOnClose, evidence, budgets, diagnostic: profiling, enforced: process.env.SAMBEE_E2E_BUDGETS === "1", limitations: ["Beforeinput-to-two-frame scheduling proxy, not physical input/paint", "Final native dispatch is not independently attributed", "Physical IME remains a separate gate"] }) });
        for (const stage of ["serialize", "publish", "normalize", "parent-update"]) expect(evidence.measures.some(entry => entry.name === `sambee:source-editor:${stage}`)).toBe(true);
        expect(budgets.metrics.filter(metric => metric.status === "invalid")).toEqual([]);
        if (!saveOnClose) {
          expect(evidence.retainedCell).toBe(true);
          expect(evidence.cellFocused).toBe(true);
        }
        if (saveOnClose) await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        recordStage("before-clean-check");
        await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
        if (fixture.action === "line-break") {
          const savedCellText = await nested.textContent();
          const renderedCellText = `${fixture.row}\n${TABLE_EDIT_PAYLOAD}`;
          await page.keyboard.type("!");
          await expect(nested).toHaveText(`${savedCellText}!`);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
          await page.keyboard.press("Control+z");
          await expect(cell).toHaveText(renderedCellText);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
          await page.keyboard.press("Control+Shift+Z");
          await expect(cell).toHaveText(`${renderedCellText}!`);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toBeVisible();
          await page.keyboard.press("Control+z");
          await expect(cell).toHaveText(renderedCellText);
          await expect(page.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
          recordStage("post-save-history-verified");
        }
        recordStage("before-close");
        await markPhase("close-start");
        await page.getByRole("button", { name: "Close", exact: true }).click();
        recordStage("close-clicked");
        await expect(page.getByRole("textbox", { name: "Markdown editor" })).toHaveCount(0);
        await expect.poll(() => page.workers().length).toBe(0);
        recordStage("closed");
        await markPhase("closed");
        expect(pageErrors).toEqual([]);
        expect(proxy.errors).toEqual([]);
        if (process.env.SAMBEE_E2E_BUDGETS === "1") expect(budgets.status, JSON.stringify(budgets)).toBe("pass");
        });
      } finally {
        await testInfo.attach("large-table-lifecycle", { contentType: "application/json", body: JSON.stringify({ lifecycle, pageErrors }) });
        await context?.close();
        await proxy.close();
      }
    });
  }
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
