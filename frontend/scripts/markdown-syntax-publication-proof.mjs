import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const APPROVED_URL = "http://localhost:3000/browse/smb/demo";
const PREFIX = "/__syntax_publication_proof__/";
const output = await mkdtemp(resolve(tmpdir(), "sambee-live-syntax-"));
let browser;
try {
  await build({
    root: FRONTEND,
    configFile: resolve(FRONTEND, "vite.config.ts"),
    base: PREFIX,
    logLevel: "warn",
    build: {
      outDir: output,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          publication: resolve(FRONTEND, "src/utils/markdownSyntaxPublication.ts"),
          preparation: resolve(FRONTEND, "src/utils/markdownSyntaxWorker.ts"),
          parser: resolve(FRONTEND, "src/utils/codeMirrorHighlightingCore.ts"),
        },
        preserveEntrySignatures: "strict",
        output: { entryFileNames: "[name].js" },
      },
    },
  });
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (const width of [1543, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`**${PREFIX}**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const path = resolve(output, decodeURIComponent(pathname.slice(PREFIX.length)));
      if (!path.startsWith(`${output}${sep}`)) return route.abort();
      await route.fulfill({ body: await readFile(path), contentType: extname(path) === ".css" ? "text/css" : "text/javascript" });
    });
    await page.route(APPROVED_URL, (route) => route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}#host{height:800px;overflow:auto;--sambee-syntax-keyword:#c00000}pre{white-space:pre-wrap;font:14px/20px monospace;margin:0}::selection{background:#aaccff}</style><div id="host"></div></html>',
    }));
    await page.goto(APPROVED_URL);
    const samples = await page.evaluate(async ({ prefix }) => {
      const { prepareMarkdownSyntax } = await import(`${prefix}preparation.js`);
      const { createStaticHighlighter } = await import(`${prefix}parser.js`);
      const { publishMarkdownSyntax, MAX_VIEWPORT_SYNTAX_RANGES } = await import(`${prefix}publication.js`);
      const host = document.getElementById("host");
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const samples = [];
      for (const lines of [6000, 11000]) {
        const text = "let x=1;\n".repeat(lines);
        const requests = [{ text, label: "js" }];
        const started = performance.now();
        const results = await prepareMarkdownSyntax(requests, new AbortController().signal);
        const preparationMs = performance.now() - started;
        const direct = await createStaticHighlighter((message) => { throw new Error(message); }).prepare(requests);
        if (JSON.stringify(results) !== JSON.stringify(direct)) throw new Error("Production worker/parser parity failed");
        const ranges = results[0].ranges;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        pre.append(code);
        host.replaceChildren(pre);
        const baselineStart = performance.now();
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const range of ranges) {
          if (range.from > offset) fragment.append(document.createTextNode(text.slice(offset, range.from)));
          const span = document.createElement("span");
          span.className = range.categories.map((category) => `sambee-syntax-${category}`).join(" ");
          span.textContent = text.slice(range.from, range.to);
          fragment.append(span);
          offset = range.to;
        }
        fragment.append(document.createTextNode(text.slice(offset) + "\n"));
        code.replaceChildren(fragment);
        const baselineDomMs = performance.now() - baselineStart;
        const baselineHeight = host.scrollHeight;
        const baselineSpans = code.querySelectorAll("span").length;
        code.textContent = `${text}\n`;
        const node = code.firstChild;
        const selection = document.getSelection();
        const selected = document.createRange();
        selected.setStart(node, 0);
        selected.setEnd(node, 3);
        selection.removeAllRanges();
        selection.addRange(selected);
        const controller = new AbortController();
        const publicationStart = performance.now();
        publishMarkdownSyntax(host, host, { requests, results }, controller.signal);
        await frame();
        await frame();
        const publicationWallMs = performance.now() - publicationStart;
        const decorations = () => [...CSS.highlights.entries()].filter(([name]) => name.startsWith("markdown-syntax-"));
        const mountedRanges = decorations().reduce((sum, [, ranges]) => sum + ranges.size, 0);
        const keywordName = decorations().find(([name]) => name.endsWith("-keyword"))[0];
        const lightColor = getComputedStyle(code, `::highlight(${keywordName})`).color;
        host.style.setProperty("--sambee-syntax-keyword", "#ff8800");
        const darkColor = getComputedStyle(code, `::highlight(${keywordName})`).color;
        if (lightColor === darkColor) throw new Error("Syntax colors did not follow theme variables");
        if (code.textContent !== `${text}\n` || code.firstChild !== node || selection.toString() !== "let") throw new Error("Syntax publication changed text or selection");
        if (host.scrollHeight !== baselineHeight) throw new Error("Syntax publication changed document geometry");
        if (mountedRanges <= 0 || mountedRanges > MAX_VIEWPORT_SYNTAX_RANGES || code.children.length) throw new Error("Invalid viewport syntax work bound");
        selection.removeAllRanges();
        host.scrollTop = host.scrollHeight;
        host.dispatchEvent(new Event("scroll"));
        await frame();
        await frame();
        const finalRanges = decorations().flatMap(([, ranges]) => [...ranges]);
        if (!finalRanges.length || !finalRanges.some((range) => range.startOffset > text.length / 2)) throw new Error("End-of-document syntax was not published");
        controller.abort();
        if (decorations().length) throw new Error("Cancelled syntax ranges survived disposal");
        samples.push({ sourceUnits: text.length, preparationMs, baselineDomMs, baselineSpans, publicationWallMs, mountedRanges, lightColor, darkColor });
        host.scrollTop = 0;
        host.style.setProperty("--sambee-syntax-keyword", "#c00000");
      }
      const parityRequests = [{text: "name: value\n", label: "yml"}, {text: '# Heading\n\n```py\nprint("🌍")\n```', label: "md"}];
      const parity = await prepareMarkdownSyntax(parityRequests, new AbortController().signal);
      const direct = await createStaticHighlighter((message) => { throw new Error(message); }).prepare(parityRequests);
      if (JSON.stringify(parity) !== JSON.stringify(direct) || parity.some((result) => !("ranges" in result))) throw new Error("Production alias/nested parser parity failed");
      return samples;
    }, { prefix: PREFIX });
    assert.deepEqual(errors, []);
    results.push({ width, samples });
    await page.close();
  }
  console.log(JSON.stringify({ kind: "Production live syntax publication slice; not whole-viewer or physical-device acceptance", browser: browser.version(), results }, null, 2));
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
