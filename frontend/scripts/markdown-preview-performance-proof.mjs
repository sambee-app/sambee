import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";
import { build } from "vite";
import { documentHostBudgetFailures, runMarkdownDocumentProof } from "./markdown-document-performance-proof.mjs";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const APPROVED_URL = "http://localhost:3000/browse/smb/demo";
const ASSET_PREFIX = "/__markdown_preview_proof__/";
const MAX_MOUNTED_ROWS = 40;
const MAX_MOUNTED_SPANS = 4_000;
const NATIVE_FIND_TARGET = "sambee-native-find-target";
const RENDER_MODES = {
  full: false,
  virtual: true,
  "retained-text": "retained-text",
  "retained-text-worker": "retained-text-worker",
  "retained-text-worker-progressive": "retained-text-worker-progressive",
};
const BROWSERS = { chromium, firefox };
const browserName = process.env.SAMBEE_PREVIEW_PROOF_BROWSER ?? "chromium";
assert.ok(Object.keys(BROWSERS).includes(browserName), "Unknown proof browser");
const modeNames = (process.env.SAMBEE_PREVIEW_PROOF_MODES ?? "full,virtual,retained-text").split(",");
assert.ok(modeNames.length > 0 && modeNames.every((name) => Object.keys(RENDER_MODES).includes(name)), "Unknown proof rendering mode");
const output = await mkdtemp(resolve(tmpdir(), "sambee-preview-proof-"));
const documentProof = process.env.SAMBEE_PREVIEW_PROOF_DOCUMENT === "1";
const budgetProof = process.env.SAMBEE_PREVIEW_PROOF_BUDGETS === "1";
assert.ok(
  !budgetProof || (documentProof && process.env.SAMBEE_PREVIEW_PROOF_SCALE === "1"),
  "Host budgets require whole-document scaling mode"
);
let browser;
const failures = [];
const report = {
  kind: "P1 production-built code-only prototype; NOT live-viewer acceptance",
  modes: modeNames,
  browserName,
  measurements: [],
  interactions: [],
  blockers: [],
};

try {
  browser = await BROWSERS[browserName].launch({ headless: true });
  report.browser = browser.version();
  await build({
    base: ASSET_PREFIX,
    resolve: { conditions: ["worker", "module", "browser", "production"] },
    worker: {
      format: "es",
      plugins: () => [
        {
          name: "preview-worker-diagnostics",
          enforce: "pre",
          resolveId(source, importer) {
            if (source === "../services/logger" && importer?.endsWith("/utils/codeMirrorHighlighting.ts")) {
              return resolve(FRONTEND, "scripts/prototypes/markdownCodePreparation.worker.ts");
            }
          },
        },
      ],
    },
    root: FRONTEND,
    configFile: resolve(FRONTEND, "vite.config.ts"),
    logLevel: "warn",
    build: {
      sourcemap: true,
      outDir: output,
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        input: resolve(FRONTEND, "scripts/prototypes/markdownCodePreview.tsx"),
        output: { entryFileNames: "entry.js", manualChunks: undefined },
      },
    },
  });
  for (const width of [1543, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route(`**${ASSET_PREFIX}**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === `${ASSET_PREFIX}fixture.png`)
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aoykAAAAASUVORK5CYII=", "base64"),
        });
      const path = resolve(output, decodeURIComponent(pathname.slice(ASSET_PREFIX.length)));
      if (!path.startsWith(`${output}${sep}`)) return route.abort();
      try {
        await route.fulfill({ body: await readFile(path), contentType: extname(path) === ".css" ? "text/css" : "text/javascript" });
      } catch {
        failures.push(`Prototype asset missing: ${pathname}`);
        await route.abort();
      }
    });
    await page.route(APPROVED_URL, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>P1 code preview proof</title><body><main id="prototype"></main><script type="module" src="${ASSET_PREFIX}entry.js"></script></body></html>`,
      })
    );
    await page.goto(APPROVED_URL);
    await page.waitForFunction(() => Boolean(window.codePreviewPrototype));
    if (documentProof) {
      report.kind = "P1 production-built whole-Markdown prototype; NOT live-viewer acceptance";
      await runMarkdownDocumentProof(page, report, width);
      await page.screenshot({ path: resolve(output, `document-${width}.png`) });
      await page.close();
      continue;
    }
    const fixtures = [
      { name: "dense", blocks: ["let x=1;\n".repeat(6_000)] },
      { name: "near-safeguard", blocks: ["let x=1;\n".repeat(11_111)] },
      { name: "many-blocks", blocks: Array.from({ length: 600 }, () => "let x=1;\n".repeat(101)) },
      {
        name: "whitespace",
        blocks: ["let x = '\u{1f30d}';\t  // preserve  spaces\n".repeat(37), `${" \t\n\nlet x = 2;\r\n".repeat(25)}end`],
      },
    ];
    for (const fixture of fixtures) {
      for (const modeName of modeNames) {
        const virtual = RENDER_MODES[modeName];
        await page.goto(APPROVED_URL);
        await page.waitForFunction(() => Boolean(window.codePreviewPrototype));
        for (const cache of ["cold", "cached"]) {
          const measurement = await page.evaluate(
            async ({ blocks, virtual }) => {
              const start = performance.now();
              const longTasks = [];
              const taskServiceGaps = [];
              let lastTaskAt = start;
              let taskProbeTimer;
              const probeTask = () => {
                const now = performance.now();
                taskServiceGaps.push(now - lastTaskAt);
                lastTaskAt = now;
                taskProbeTimer = setTimeout(probeTask, 0);
              };
              taskProbeTimer = setTimeout(probeTask, 0);
              const longTaskObservationSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
              const observer = new PerformanceObserver((list) => {
                longTasks.push(...list.getEntries().map((entry) => entry.duration));
              });
              if (longTaskObservationSupported) observer.observe({ type: "longtask", buffered: false });
              await window.codePreviewPrototype.load(blocks, virtual);
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
              longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
              observer.disconnect();
              clearTimeout(taskProbeTimer);
              taskServiceGaps.push(performance.now() - lastTaskAt);
              return {
                ...window.codePreviewPrototype.stats(),
                loadToPaintMs: performance.now() - start,
                longTasks,
                longTaskObservationSupported,
                taskServiceProbeCount: taskServiceGaps.length,
                maximumTaskServiceGapMs: Math.max(...taskServiceGaps),
              };
            },
            { blocks: fixture.blocks, virtual }
          );
          assert.equal(measurement.sourceUnits, fixture.blocks.join("").length);
          assert.equal(measurement.matchCount, fixture.blocks.join("").split("let x").length - 1);
          assert.equal(measurement.oversizedLines, 0);
          if (virtual === true) {
            assert.ok(measurement.mountedRows > 0 && measurement.mountedRows <= MAX_MOUNTED_ROWS, JSON.stringify(measurement));
            assert.ok(measurement.mountedSpans <= MAX_MOUNTED_SPANS, JSON.stringify(measurement));
            assert.ok(measurement.mountedTextUnits < measurement.sourceUnits);
          } else {
            assert.equal(measurement.mountedTextUnits, measurement.sourceUnits);
          }
          if (typeof virtual === "string") {
            assert.equal(measurement.execution, virtual.startsWith("retained-text-worker") ? "worker" : "main-thread");
            assert.equal(measurement.preparationComplete, true);
            assert.equal(measurement.searchComplete, true);
            if (virtual === "retained-text-worker-progressive" && fixture.name !== "whitespace") {
              assert.ok(measurement.sourceIndexingYields > 0);
            }
            if (virtual.startsWith("retained-text-worker")) {
              assert.equal(measurement.sourceUnitsSent, measurement.sourceUnits);
              assert.equal(
                measurement.sourceChunks,
                fixture.blocks.reduce((count, text) => count + Math.max(1, Math.ceil(text.length / measurement.sourceChunkLimit)), 0)
              );
              assert.ok(measurement.largestSourceChunkUnits <= measurement.sourceChunkLimit);
              assert.ok(measurement.transferChunks > 0);
              assert.ok(measurement.largestChunkItems > 0 && measurement.largestChunkItems <= measurement.transferChunkLimit);
            }
            assert.equal(measurement.publicationComplete, true);
            assert.equal(measurement.publishedRows, measurement.totalRows);
            assert.ok(measurement.largestPublicationBatch <= measurement.publicationBatchLimit);
            assert.equal(measurement.publicationBatches, Math.max(1, Math.ceil(measurement.totalRows / measurement.publicationBatchLimit)));
          }
          const jumps = [];
          if (virtual) {
            for (const ordinal of [measurement.matchCount - 1, 0, Math.floor(measurement.matchCount / 2)]) {
              const start = performance.now();
              await page.evaluate((target) => window.codePreviewPrototype.jump(target), ordinal);
              await page.waitForFunction((target) => {
                const stats = window.codePreviewPrototype.stats();
                return stats.active === target && stats.activeMounted;
              }, ordinal);
              const stats = await page.evaluate(() => window.codePreviewPrototype.stats());
              if (virtual === true) assert.ok(stats.mountedRows <= MAX_MOUNTED_ROWS, JSON.stringify(stats));
              else {
                assert.ok(stats.decoratedRows <= MAX_MOUNTED_ROWS, JSON.stringify(stats));
                assert.ok(stats.highlightRanges <= MAX_MOUNTED_SPANS, JSON.stringify(stats));
              }
              jumps.push({ ordinal, commandToObservedMs: performance.now() - start });
            }
            await page.setViewportSize({ width: width === 390 ? 1543 : 390, height: 900 });
            await page.waitForFunction(() => window.codePreviewPrototype.stats().activeMounted);
            await page.setViewportSize({ width, height: 900 });
            const nativeSelection = await page.evaluate((blocks) => {
              const selection = window.getSelection();
              const container = document.querySelector("[data-prototype-scroll]");
              const candidateHeight = container.scrollHeight;
              selection.selectAllChildren(container);
              const text = selection.toString();
              const baseline = document.createElement("div");
              for (const block of blocks) {
                const pre = document.createElement("pre");
                pre.style.margin = "0";
                pre.style.whiteSpace = "pre-wrap";
                pre.style.overflowWrap = "anywhere";
                pre.style.fontSize = "14px";
                pre.style.lineHeight = "20px";
                pre.textContent = block;
                baseline.append(pre);
              }
              document.body.append(baseline);
              baseline.style.width = `${container.clientWidth}px`;
              const baselineHeight = baseline.getBoundingClientRect().height;
              selection.selectAllChildren(baseline);
              const expected = selection.toString();
              selection.removeAllRanges();
              baseline.remove();
              let uncontainedSelection = null;
              if (text !== expected && container.hasAttribute("data-retained-text")) {
                const style = document.createElement("style");
                style.textContent = "[data-retained-text] pre{content-visibility:visible!important}";
                document.head.append(style);
                selection.selectAllChildren(container);
                uncontainedSelection = { units: selection.toString().length, exact: selection.toString() === expected };
                selection.removeAllRanges();
                style.remove();
              }
              return {
                units: text.length,
                baselineUnits: expected.length,
                exact: text === expected,
                exactDomText: container.textContent === blocks.join(""),
                uncontainedSelection,
                candidateHeight,
                baselineHeight,
              };
            }, fixture.blocks);
            report.interactions.push({
              fixture: fixture.name,
              width,
              mode: modeName,
              nativeSelection,
              modelUnits: measurement.sourceUnits,
            });
            if (typeof virtual === "string") {
              assert.equal(nativeSelection.exact, true, JSON.stringify(nativeSelection));
              assert.equal(nativeSelection.exactDomText, true);
              assert.equal(nativeSelection.candidateHeight, Math.max(480, nativeSelection.baselineHeight));
              if (fixture.name !== "whitespace") {
                const expectedHeight = fixture.blocks.join("").split("\n").length - 1;
                assert.equal(nativeSelection.candidateHeight, Math.max(480, expectedHeight * 20));
              }
            }
          }
          report.measurements.push({ fixture: fixture.name, width, virtual, cache, ...measurement, jumps });
        }
      }
    }
    for (const retainedMode of modeNames.filter((name) => typeof RENDER_MODES[name] === "string")) {
      if (retainedMode === "retained-text-worker-progressive") {
        const indexingSupersession = await page.evaluate(async (mode) => {
          const nativePostMessage = Worker.prototype.postMessage;
          const workerJobs = [];
          Worker.prototype.postMessage = function (message, ...args) {
            if (message.type === "prepare") workerJobs.push(message.generation);
            return nativePostMessage.call(this, message, ...args);
          };
          try {
            const obsolete = window.codePreviewPrototype.load(["let x=0;\n".repeat(6_000)], mode).then(
              () => "complete",
              (error) => error.name
            );
            await window.codePreviewPrototype.load(["let x=1;\n"], mode);
            return {
              obsolete: await obsolete,
              workerJobs,
              stats: window.codePreviewPrototype.stats(),
              text: document.querySelector("[data-retained-text]").textContent,
            };
          } finally {
            Worker.prototype.postMessage = nativePostMessage;
          }
        }, retainedMode);
        assert.equal(indexingSupersession.obsolete, "AbortError");
        assert.deepEqual(indexingSupersession.workerJobs, [indexingSupersession.stats.generation]);
        assert.equal(indexingSupersession.text, "let x=1;\n");
        report.interactions.push({ width, mode: retainedMode, indexingSupersession });
        await page.evaluate(
          ({ blocks, mode }) => {
            const nativePostMessage = Worker.prototype.postMessage;
            Worker.prototype.postMessage = function (message, ...args) {
              if (message.type === "run") {
                window.releaseProgressiveWorker = () => {
                  Worker.prototype.postMessage = nativePostMessage;
                  nativePostMessage.call(this, message, ...args);
                };
                return;
              }
              return nativePostMessage.call(this, message, ...args);
            };
            const input = document.createElement("input");
            input.id = "progressive-input-probe";
            document.body.prepend(input);
            window.progressiveInputEvents = [];
            input.addEventListener("input", () =>
              window.progressiveInputEvents.push(window.codePreviewPrototype.stats().preparationComplete)
            );
            window.progressiveOutcome = window.codePreviewPrototype.load(blocks, mode).then(
              () => "complete",
              (error) => error.name
            );
          },
          { blocks: fixtures.find((fixture) => fixture.name === "many-blocks").blocks, mode: retainedMode }
        );
        await page.waitForFunction(
          () =>
            window.releaseProgressiveWorker &&
            window.codePreviewPrototype.stats().publishedRows > 0 &&
            !window.codePreviewPrototype.stats().preparationComplete
        );
        await page.locator("#progressive-input-probe").pressSequentially("responsive");
        const beforePreparation = await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const firstText = document.querySelector("[data-retained-text] [data-index]").firstChild;
          const selection = window.getSelection();
          const range = new Range();
          range.setStart(firstText, 0);
          range.setEnd(firstText, 5);
          selection.removeAllRanges();
          selection.addRange(range);
          window.progressiveFirstText = firstText;
          let pendingSearch;
          try {
            window.codePreviewPrototype.jump(0);
          } catch (error) {
            pendingSearch = error.message;
          }
          return {
            ...window.codePreviewPrototype.stats(),
            pendingSearch,
            inputEvents: window.progressiveInputEvents,
            inputValue: document.getElementById("progressive-input-probe").value,
          };
        });
        assert.equal(beforePreparation.preparationComplete, false);
        assert.equal(beforePreparation.searchComplete, false);
        assert.ok(beforePreparation.mountedTextUnits > 0);
        assert.match(beforePreparation.pendingSearch, /search preparation is pending/);
        assert.equal(beforePreparation.inputValue, "responsive");
        assert.ok(beforePreparation.inputEvents.length > 0 && beforePreparation.inputEvents.every((complete) => !complete));
        const afterPreparation = await page.evaluate(async () => {
          window.releaseProgressiveWorker();
          const outcome = await window.progressiveOutcome;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const firstText = window.progressiveFirstText;
          const selection = window.getSelection();
          const result = {
            ...window.codePreviewPrototype.stats(),
            outcome,
            textNodeStable: document.querySelector("[data-retained-text] [data-index]").firstChild === firstText,
            selectionStable: selection.anchorNode === firstText && selection.focusNode === firstText && selection.toString() === "let x",
            exactText: document.querySelector("[data-retained-text]").textContent === "let x=1;\n".repeat(600 * 101),
          };
          selection.removeAllRanges();
          document.getElementById("progressive-input-probe").remove();
          delete window.progressiveFirstText;
          delete window.releaseProgressiveWorker;
          return result;
        });
        assert.equal(afterPreparation.outcome, "complete");
        assert.equal(afterPreparation.preparationComplete, true);
        assert.equal(afterPreparation.searchComplete, true);
        assert.equal(afterPreparation.textNodeStable, true);
        assert.equal(afterPreparation.selectionStable, true);
        assert.equal(afterPreparation.exactText, true);
        assert.equal(afterPreparation.matchCount, 600 * 101);
        assert.ok(afterPreparation.highlightRanges > 0);
        report.interactions.push({ width, mode: retainedMode, beforePreparation, afterPreparation });

        const progressiveFailure = await page.evaluate(async (mode) => {
          const nativePostMessage = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (message, ...args) {
            if (message.type === "run") {
              Worker.prototype.postMessage = nativePostMessage;
              queueMicrotask(() => this.dispatchEvent(new ErrorEvent("error", { message: "proof progressive failure", cancelable: true })));
              return;
            }
            return nativePostMessage.call(this, message, ...args);
          };
          try {
            let outcome;
            try {
              await window.codePreviewPrototype.load(["let x=7;\n"], mode);
              outcome = "unexpected success";
            } catch (error) {
              outcome = error.message;
            }
            return {
              outcome,
              stats: window.codePreviewPrototype.stats(),
              text: document.querySelector("[data-retained-text]").textContent,
            };
          } finally {
            Worker.prototype.postMessage = nativePostMessage;
          }
        }, retainedMode);
        assert.match(progressiveFailure.outcome, /proof progressive failure/);
        assert.match(progressiveFailure.stats.preparationError, /proof progressive failure/);
        assert.equal(progressiveFailure.stats.preparationComplete, false);
        assert.equal(progressiveFailure.stats.searchComplete, false);
        assert.equal(progressiveFailure.stats.publicationComplete, true);
        assert.equal(progressiveFailure.text, "let x=7;\n");

        await page.evaluate((mode) => {
          const nativePostMessage = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (message, ...args) {
            if (message.type === "run") {
              Worker.prototype.postMessage = nativePostMessage;
              const listener = this.onmessage;
              window.deliverObsoleteProgressiveResult = () =>
                listener.call(
                  this,
                  new MessageEvent("message", {
                    data: { type: "complete", generation: message.generation, preparationMs: 0, indexingMs: 0 },
                  })
                );
              return;
            }
            return nativePostMessage.call(this, message, ...args);
          };
          window.obsoleteProgressiveOutcome = window.codePreviewPrototype.load(["let x=8;\n".repeat(6_000)], mode).then(
            () => "complete",
            (error) => error.name
          );
        }, retainedMode);
        await page.waitForFunction(
          () =>
            window.deliverObsoleteProgressiveResult &&
            !window.codePreviewPrototype.stats().preparationComplete &&
            window.codePreviewPrototype.stats().publishedRows > 0
        );
        const progressiveSupersession = await page.evaluate(async (mode) => {
          const firstText = document.querySelector("[data-retained-text] [data-index]").firstChild;
          const obsoleteGeneration = window.codePreviewPrototype.stats().generation;
          await window.codePreviewPrototype.load(["let x=9;\n"], mode);
          const outcome = await window.obsoleteProgressiveOutcome;
          window.deliverObsoleteProgressiveResult();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          delete window.deliverObsoleteProgressiveResult;
          return {
            outcome,
            obsoleteGeneration,
            stats: window.codePreviewPrototype.stats(),
            oldTextDetached: !firstText.isConnected,
            text: document.querySelector("[data-retained-text]").textContent,
          };
        }, retainedMode);
        assert.equal(progressiveSupersession.outcome, "AbortError");
        assert.ok(progressiveSupersession.stats.generation > progressiveSupersession.obsoleteGeneration);
        assert.equal(progressiveSupersession.stats.preparationComplete, true);
        assert.equal(progressiveSupersession.stats.preparationError, null);
        assert.equal(progressiveSupersession.oldTextDetached, true);
        assert.equal(progressiveSupersession.text, "let x=9;\n");
        report.interactions.push({ width, mode: retainedMode, progressiveFailure, progressiveSupersession });
      } else {
        await page.evaluate(
          ({ blocks, mode }) => {
            const input = document.createElement("input");
            input.id = "publication-input-probe";
            document.body.prepend(input);
            window.publicationInputEvents = [];
            input.addEventListener("input", () => {
              const stats = window.codePreviewPrototype.stats();
              window.publicationInputEvents.push({
                complete: stats.publicationComplete,
                publishedRows: stats.publishedRows,
                value: input.value,
              });
            });
            window.publicationOutcome = window.codePreviewPrototype.load(blocks, mode).then(
              () => ({ status: "complete" }),
              (error) => ({ status: error.name })
            );
          },
          { blocks: fixtures.find((fixture) => fixture.name === "many-blocks").blocks, mode: retainedMode }
        );
        await page.waitForFunction(() => {
          const stats = window.codePreviewPrototype.stats();
          return stats.totalRows === 4200 && stats.publishedRows > 0 && !stats.publicationComplete;
        });
        const selectionDuringPublication = await page.evaluate(async () => {
          const firstText = document.querySelector("[data-retained-text] [data-index]").firstChild;
          const selection = window.getSelection();
          const range = new Range();
          range.setStart(firstText, 0);
          range.setEnd(firstText, 5);
          selection.removeAllRanges();
          selection.addRange(range);
          const before = window.codePreviewPrototype.stats().publishedRows;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const after = window.codePreviewPrototype.stats().publishedRows;
          const result = {
            before,
            after,
            firstTextStable: document.querySelector("[data-retained-text] [data-index]").firstChild === firstText,
            anchorStable: selection.anchorNode === firstText,
            focusStable: selection.focusNode === firstText,
            selected: selection.toString(),
          };
          selection.removeAllRanges();
          return result;
        });
        assert.ok(selectionDuringPublication.after > selectionDuringPublication.before);
        assert.equal(selectionDuringPublication.firstTextStable, true);
        assert.equal(selectionDuringPublication.anchorStable, true);
        assert.equal(selectionDuringPublication.focusStable, true);
        assert.equal(selectionDuringPublication.selected, "let x");
        report.interactions.push({ width, mode: retainedMode, selectionDuringPublication });
        const pendingJump = await page.evaluate(() => {
          const target = Math.floor(window.codePreviewPrototype.stats().matchCount / 2);
          const supersededTarget = window.codePreviewPrototype.stats().matchCount - 1;
          const superseded = window.codePreviewPrototype.jump(supersededTarget);
          const result = window.codePreviewPrototype.jump(target);
          const stats = window.codePreviewPrototype.stats();
          return {
            target,
            supersededTarget,
            supersededPending: superseded.pending,
            pending: result.pending,
            pendingMatch: stats.pendingMatch,
            activeMounted: stats.activeMounted,
            publicationBatchesAtRequest: stats.publicationBatches,
          };
        });
        assert.equal(pendingJump.supersededPending, true);
        assert.equal(pendingJump.pending, true);
        assert.equal(pendingJump.pendingMatch, pendingJump.target);
        assert.equal(pendingJump.activeMounted, false);
        await page.waitForFunction((target) => {
          const stats = window.codePreviewPrototype.stats();
          return stats.active === target && stats.pendingMatch === null && stats.activeMounted;
        }, pendingJump.target);
        const priorityReveal = await page.evaluate(async () => {
          const stats = window.codePreviewPrototype.stats();
          const container = document.querySelector("[data-retained-text]");
          const element = container.querySelector(`[data-index="${stats.activeRow}"]`);
          const rect = element.getBoundingClientRect();
          const viewport = container.getBoundingClientRect();
          const textNode = element.firstChild;
          const selection = window.getSelection();
          const range = new Range();
          range.setStart(textNode, 0);
          range.setEnd(textNode, 5);
          selection.removeAllRanges();
          selection.addRange(range);
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const result = {
            publicationCompleteAtReveal: stats.publicationComplete,
            publishedRowsAtReveal: stats.publishedRows,
            publicationBatchesAtReveal: stats.publicationBatches,
            totalRows: stats.totalRows,
            targetVisible: rect.bottom > viewport.top && rect.top < viewport.bottom,
            destinationTextStable: element.firstChild === textNode,
            destinationSelectionStable:
              selection.anchorNode === textNode && selection.focusNode === textNode && selection.toString() === "let x",
            publishedRowsAfterSelection: window.codePreviewPrototype.stats().publishedRows,
          };
          selection.removeAllRanges();
          return result;
        });
        assert.equal(priorityReveal.publicationCompleteAtReveal, false);
        assert.ok(priorityReveal.publishedRowsAtReveal < priorityReveal.totalRows);
        assert.equal(priorityReveal.targetVisible, true);
        assert.equal(priorityReveal.destinationTextStable, true);
        assert.equal(priorityReveal.destinationSelectionStable, true);
        assert.ok(priorityReveal.publishedRowsAfterSelection > priorityReveal.publishedRowsAtReveal);
        await page.locator("#publication-input-probe").pressSequentially("responsive");
        const publicationInput = await page.evaluate(async () => {
          const outcome = await window.publicationOutcome;
          const events = window.publicationInputEvents;
          const stats = window.codePreviewPrototype.stats();
          document.getElementById("publication-input-probe").remove();
          return { outcome, events, publicationBatches: stats.publicationBatches, publicationComplete: stats.publicationComplete };
        });
        assert.equal(publicationInput.outcome.status, "complete");
        assert.equal(publicationInput.publicationComplete, true);
        assert.ok(
          publicationInput.events.some((event) => !event.complete),
          JSON.stringify(publicationInput)
        );
        assert.equal(publicationInput.events.at(-1).value, "responsive");
        await page.waitForFunction((target) => {
          const stats = window.codePreviewPrototype.stats();
          return stats.active === target && stats.pendingMatch === null && stats.activeMounted;
        }, pendingJump.target);
        const priorityCompletion = await page.evaluate(() => {
          const stats = window.codePreviewPrototype.stats();
          const container = document.querySelector("[data-retained-text]");
          const indices = [...container.querySelectorAll("[data-index]")].map((element) => Number(element.dataset.index));
          const target = container.querySelector(`[data-index="${stats.activeRow}"]`).getBoundingClientRect();
          const viewport = container.getBoundingClientRect();
          return {
            priorityPublishedRows: stats.priorityPublishedRows,
            exactOrder: indices.every((index, position) => index === position),
            exactText: container.textContent === "let x=1;\n".repeat(600 * 101),
            targetVisible: target.bottom > viewport.top && target.top < viewport.bottom,
          };
        });
        assert.ok(priorityCompletion.priorityPublishedRows > 0);
        assert.equal(priorityCompletion.exactOrder, true);
        assert.equal(priorityCompletion.exactText, true);
        assert.equal(priorityCompletion.targetVisible, true);
        report.interactions.push({
          width,
          mode: retainedMode,
          pendingJump,
          pendingJumpRevealed: true,
          priorityReveal,
          priorityCompletion,
        });
        report.interactions.push({ width, mode: retainedMode, publicationInput });

        const previousGeneration = await page.evaluate((mode) => {
          const previous = window.codePreviewPrototype.stats().generation;
          window.obsoletePublication = window.codePreviewPrototype.load(["let x=1;\n".repeat(11_111)], mode).then(
            () => ({ status: "complete" }),
            (error) => ({ status: error.name })
          );
          return previous;
        }, retainedMode);
        await page.waitForFunction((previous) => {
          const stats = window.codePreviewPrototype.stats();
          return stats.generation > previous && stats.publishedRows > 0 && !stats.publicationComplete;
        }, previousGeneration);
        const cancelledPublication = await page.evaluate(async (mode) => {
          const firstText = document.querySelector("[data-retained-text] [data-index]").firstChild;
          const obsoleteGeneration = window.codePreviewPrototype.stats().generation;
          await window.codePreviewPrototype.load(["let x=2;\n"], mode);
          const obsolete = await window.obsoletePublication;
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          return {
            obsolete,
            oldTextDetached: !firstText.isConnected,
            generation: window.codePreviewPrototype.stats().generation,
            obsoleteGeneration,
            text: document.querySelector("[data-retained-text]").textContent,
            publicationComplete: window.codePreviewPrototype.stats().publicationComplete,
          };
        }, retainedMode);
        assert.equal(cancelledPublication.obsolete.status, "AbortError");
        assert.equal(cancelledPublication.oldTextDetached, true);
        assert.ok(cancelledPublication.generation > cancelledPublication.obsoleteGeneration);
        assert.equal(cancelledPublication.text, "let x=2;\n");
        assert.equal(cancelledPublication.publicationComplete, true);
        report.interactions.push({ width, mode: retainedMode, cancelledPublication });

        const cancelledPreparation = await page.evaluate(async (mode) => {
          const obsolete = window.codePreviewPrototype.load(["let x=3;\n"], mode).then(
            () => ({ status: "complete" }),
            (error) => ({ status: error.name })
          );
          await window.codePreviewPrototype.load(["let x=4;\n"], mode);
          return {
            obsolete: await obsolete,
            text: document.querySelector("[data-retained-text]").textContent,
            publicationComplete: window.codePreviewPrototype.stats().publicationComplete,
          };
        }, retainedMode);
        assert.equal(cancelledPreparation.obsolete.status, "AbortError");
        assert.equal(cancelledPreparation.text, "let x=4;\n");
        assert.equal(cancelledPreparation.publicationComplete, true);
        report.interactions.push({ width, mode: retainedMode, cancelledPreparation });

        if (retainedMode === "retained-text-worker") {
          const workerRecovery = await page.evaluate(async (mode) => {
            const NativeWorker = window.Worker;
            const nativeTerminate = NativeWorker.prototype.terminate;
            const nativePostMessage = NativeWorker.prototype.postMessage;
            let sourceChunksSent = 0;
            let firstSourceUnits = 0;
            let notifyTransferStarted;
            const transferStarted = new Promise((resolve) => {
              notifyTransferStarted = resolve;
            });
            NativeWorker.prototype.postMessage = function (message, ...args) {
              const result = nativePostMessage.call(this, message, ...args);
              if (message.type === "source") {
                sourceChunksSent += 1;
                firstSourceUnits ||= message.text.length;
                notifyTransferStarted();
              }
              return result;
            };
            let terminations = 0;
            const outcomes = [];
            NativeWorker.prototype.terminate = function () {
              terminations += 1;
              return nativeTerminate.call(this);
            };
            const outcome = async () => {
              try {
                await window.codePreviewPrototype.load(["let x=5;\n"], mode);
                return "unexpected success";
              } catch (error) {
                return error.message;
              }
            };
            try {
              const obsolete = window.codePreviewPrototype.load(["let x=3;\n".repeat(11_111)], mode).catch((error) => error.name);
              await Promise.race([
                transferStarted,
                obsolete.then(() => {
                  throw new Error("Obsolete preparation settled before the transfer-cancellation probe");
                }),
              ]);
              const sourceChunksAtCancellation = sourceChunksSent;
              await window.codePreviewPrototype.load(["stable view\n"], "retained-text");
              const cancellation = await obsolete;
              const stableText = document.querySelector("[data-retained-text]").firstChild;
              window.Worker = undefined;
              outcomes.push(await outcome());
              window.Worker = class {
                constructor() {
                  throw new Error("proof constructor failure");
                }
              };
              outcomes.push(await outcome());
              window.Worker = class extends NativeWorker {
                constructor(...args) {
                  super(...args);
                  queueMicrotask(() => this.dispatchEvent(new ErrorEvent("error", { message: "proof worker crash", cancelable: true })));
                }
              };
              outcomes.push(await outcome());
              window.Worker = class extends NativeWorker {
                constructor(...args) {
                  super(...args);
                  queueMicrotask(() => this.dispatchEvent(new Event("messageerror")));
                }
              };
              outcomes.push(await outcome());
              const stableViewPreserved =
                stableText.isConnected && document.querySelector("[data-retained-text]").textContent === "stable view\n";
              window.Worker = NativeWorker;
              await window.codePreviewPrototype.load(["let x=6;\n"], mode);
              return {
                cancellation,
                sourceChunksAtCancellation,
                firstSourceUnits,
                outcomes,
                terminations,
                stableViewPreserved,
                text: document.querySelector("[data-retained-text]").textContent,
              };
            } finally {
              window.Worker = NativeWorker;
              NativeWorker.prototype.terminate = nativeTerminate;
              NativeWorker.prototype.postMessage = nativePostMessage;
            }
          }, retainedMode);
          report.interactions.push({ width, mode: retainedMode, workerRecovery });
          assert.equal(workerRecovery.cancellation, "AbortError");
          assert.equal(workerRecovery.sourceChunksAtCancellation, 1);
          assert.ok(workerRecovery.firstSourceUnits > 0);
          assert.ok(workerRecovery.terminations >= 3, JSON.stringify(workerRecovery));
          assert.match(workerRecovery.outcomes[0], /unavailable; no main-thread fallback/);
          assert.equal(workerRecovery.outcomes[1], "proof constructor failure");
          assert.match(workerRecovery.outcomes[2], /proof worker crash/);
          assert.match(workerRecovery.outcomes[3], /could not be decoded/);
          assert.equal(workerRecovery.stableViewPreserved, true);
          assert.equal(workerRecovery.text, "let x=6;\n");

          const sourceBoundaryParity = await page.evaluate(async (mode) => {
            const limit = window.codePreviewPrototype.stats().sourceChunkLimit;
            const paddingLine = "// filler\n";
            const padding = (units) => paddingLine.repeat(Math.floor(units / paddingLine.length)) + " ".repeat(units % paddingLine.length);
            let source = `${padding(limit - 1 - "// ".length)}// \u{1f30d}\r\n`;
            source += `${padding(2 * limit - 2 - source.length)}let x = 1;\r\n`;
            source += `${padding(3 * limit - 1 - source.length)}\r\n// end\n`;
            const blocks = ["", source, "", "let x = 2;\n", ""];
            await window.codePreviewPrototype.load(blocks, "retained-text");
            const expected = window.codePreviewPrototype.inspect();
            await window.codePreviewPrototype.load(blocks, mode);
            const actual = window.codePreviewPrototype.inspect();
            const stats = window.codePreviewPrototype.stats();
            const result = {
              exactModels: JSON.stringify(actual.models) === JSON.stringify(expected.models),
              exactMatches: JSON.stringify(actual.matches) === JSON.stringify(expected.matches),
              exactDomText: document.querySelector("[data-retained-text]").textContent === blocks.join(""),
              surrogateSplit: source.charCodeAt(limit - 1) === 0xd83c && source.charCodeAt(limit) === 0xdf0d,
              querySplit: source.slice(2 * limit - 2, 2 * limit + 3) === "let x",
              crlfSplit: source.slice(3 * limit - 1, 3 * limit + 1) === "\r\n",
              chunks: stats.sourceChunks,
              expectedChunks: blocks.reduce((count, text) => count + Math.max(1, Math.ceil(text.length / limit)), 0),
            };
            await window.codePreviewPrototype.load([], mode);
            const empty = window.codePreviewPrototype.inspect();
            const emptyStats = window.codePreviewPrototype.stats();
            result.emptyDocument =
              empty.models.length === 0 &&
              empty.matches.length === 0 &&
              emptyStats.sourceChunks === 0 &&
              emptyStats.publicationComplete &&
              document.querySelector("[data-retained-text]").textContent === "";
            return result;
          }, retainedMode);
          report.interactions.push({ width, mode: retainedMode, sourceBoundaryParity });
          for (const property of [
            "exactModels",
            "exactMatches",
            "exactDomText",
            "surrogateSplit",
            "querySplit",
            "crlfSplit",
            "emptyDocument",
          ]) {
            assert.equal(sourceBoundaryParity[property], true, JSON.stringify(sourceBoundaryParity));
          }
          assert.equal(sourceBoundaryParity.chunks, sourceBoundaryParity.expectedChunks);
        }
      }
      const interactionBlocks = [
        `${"let x=1;\n".repeat(6_000)}// ${NATIVE_FIND_TARGET}\n`,
        `${"let x=1; // wrapped text with tabs\tand Unicode \u{1f30d} ".repeat(20)}\n`.repeat(30),
      ];
      await page.evaluate(({ blocks, mode }) => window.codePreviewPrototype.load(blocks, mode), {
        blocks: interactionBlocks,
        mode: retainedMode,
      });
      await page.waitForFunction(() => window.codePreviewPrototype.stats().decoratedRows > 0);
      const interaction = await page.evaluate(async (target) => {
        const container = document.querySelector("[data-prototype-scroll]");
        const root = document.getElementById("prototype");
        const firstText = container.querySelector("[data-index]").firstChild;
        const selection = window.getSelection();
        const range = new Range();
        range.setStart(firstText, 0);
        range.setEnd(firstText, 5);
        selection.removeAllRanges();
        selection.addRange(range);
        const anchor = selection.anchorNode;
        const focus = selection.focusNode;
        const selected = selection.toString();
        root.style.setProperty("--sambee-syntax-keyword", "#13579b");
        container.scrollTop = container.scrollHeight;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const selectionStable = selection.anchorNode === anchor && selection.focusNode === focus && selection.toString() === selected;
        const textNodeStable = container.querySelector("[data-index]").firstChild === firstText;
        const keywordColor = getComputedStyle(root, "::highlight(preview-keyword)").color;
        selection.removeAllRanges();
        container.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const findStart = performance.now();
        const found = window.find(target, false, false, true);
        const findMs = performance.now() - findStart;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const nativeFindSelection = selection.toString();
        const findRange = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        const viewport = container.getBoundingClientRect();
        const findVisible = Boolean(findRange && findRange.bottom > viewport.top && findRange.top < viewport.bottom);
        selection.removeAllRanges();
        const baselineStyle = document.createElement("style");
        baselineStyle.textContent = "[data-retained-text] pre{content-visibility:visible!important}";
        document.head.append(baselineStyle);
        container.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const baselineFound = window.find(target, false, false, true);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const baselineRange = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        const baselineVisible = Boolean(baselineRange && baselineRange.bottom > viewport.top && baselineRange.top < viewport.bottom);
        selection.removeAllRanges();
        baselineStyle.remove();
        return {
          selectionStable,
          textNodeStable,
          keywordColor,
          found,
          nativeFindSelection,
          findVisible,
          findMs,
          baselineFound,
          baselineVisible,
        };
      }, NATIVE_FIND_TARGET);
      assert.equal(interaction.selectionStable, true);
      assert.equal(interaction.textNodeStable, true);
      assert.equal(interaction.keywordColor, "rgb(19, 87, 155)");
      assert.equal(interaction.found, true);
      assert.equal(interaction.nativeFindSelection, NATIVE_FIND_TARGET);
      assert.equal(interaction.baselineFound, true);
      assert.equal(interaction.findVisible, interaction.baselineVisible, JSON.stringify(interaction));
      if (!interaction.findVisible)
        report.blockers.push({
          width,
          nativeFindReveal: "Unverified: headless window.find selected but did not scroll in either contained or uncontained text",
        });
      const anchor = page.locator("[data-retained-text] [data-index]").last();
      await anchor.evaluate((element) => {
        element.id = "prototype-last-fragment";
      });
      await page.evaluate(() => {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        window.location.hash = "prototype-last-fragment";
      });
      await page.waitForFunction(() => {
        const last = document.getElementById("prototype-last-fragment").getBoundingClientRect();
        const viewport = document.querySelector("[data-retained-text]").getBoundingClientRect();
        return last.bottom > viewport.top && last.top < viewport.bottom;
      });
      await page.emulateMedia({ media: "print" });
      const print = await page.evaluate(() => {
        const container = document.querySelector("[data-retained-text]");
        return {
          text: container.textContent,
          overflow: getComputedStyle(container).overflow,
          allFragmentsVisible: [...container.querySelectorAll("[data-index]")].every(
            (element) => getComputedStyle(element).contentVisibility === "visible"
          ),
          unclipped: container.clientHeight >= container.scrollHeight,
        };
      });
      assert.equal(print.text, interactionBlocks.join(""));
      assert.equal(print.overflow, "visible");
      assert.equal(print.allFragmentsVisible, true);
      assert.equal(print.unclipped, true);
      await page.emulateMedia({ media: "screen" });
      const readingTree = await page.locator("[data-retained-text]").ariaSnapshot();
      assert.ok(readingTree.includes(NATIVE_FIND_TARGET));
      report.interactions.push({
        width,
        mode: retainedMode,
        ...interaction,
        hashAnchorVisible: true,
        accessibilityTreeIncludesOffscreenTarget: true,
        printLayout: { exactText: true, unclipped: true },
      });
    }
    await page.screenshot({ path: resolve(output, `preview-${width}.png`) });
    if (modeNames.some((name) => typeof RENDER_MODES[name] === "string")) {
      const cleanup = await page.evaluate(async () => {
        const oldText = document.querySelector("[data-retained-text] [data-index]").firstChild;
        await window.codePreviewPrototype.load([], true);
        return {
          detachedOldText: !oldText.isConnected,
          remainingHighlightSets: [...CSS.highlights.keys()].filter((name) => name.startsWith("preview-")).length,
        };
      });
      assert.equal(cleanup.detachedOldText, true);
      assert.equal(cleanup.remainingHighlightSets, 0);
      report.interactions.push({ width, mode: "retained-text", cleanup });
    }
    await page.close();
  }
  assert.deepEqual(failures, []);
  if (budgetProof) {
    report.hostBudgetFailures = documentHostBudgetFailures(report);
    assert.deepEqual(report.hostBudgetFailures, [], "Approved provisional development-host budget gate failed; P1 remains open");
    report.hostBudgetsPassed = true;
  }
  report.blockers.push(
    "Retained-text with lightweight off-screen text DOM is the approved architecture direction; acceptance is not complete. Whole-Markdown search and regex deadline probes do not establish arbitrary-structure/layout or aggregate memory bounds, reference-device budgets, actual browser Find UI/assistive-technology behavior, production recovery policy, replacement behavior, or an accepted search latency envelope. P1 remains open."
  );
  if (process.env.SAMBEE_KEEP_PREVIEW_PROOF === "1") {
    report.artifacts = output;
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  }
  console.log(report.kind);
  console.table(
    report.measurements.map((measurement) => ({
      fixture: measurement.fixture,
      width: measurement.width,
      virtual: measurement.virtual,
      cache: measurement.cache,
      rows: measurement.mountedRows,
      spans: measurement.mountedSpans,
      batches: measurement.publicationBatches,
      prepareMs: measurement.preparationMs?.toFixed(1) ?? "included in pipeline",
      pipelineMs: measurement.workerPipelineWallMs?.toFixed(1) ?? "n/a",
      indexMs: measurement.indexingMs?.toFixed(1) ?? "included in pipeline",
      loadToPaintMs: measurement.loadToPaintMs.toFixed(1),
      longestTaskMs: measurement.longTaskObservationSupported ? Math.max(0, ...measurement.longTasks) : "unavailable",
      maxTaskGapMs: measurement.maximumTaskServiceGapMs.toFixed(1),
    }))
  );
  console.log(
    "P1 interaction gate: OPEN. Provisional host targets are approved; physical devices, large-structure failures, total memory, native Find/accessibility and production acceptance remain."
  );
  if (report.artifacts) console.log(`Evidence: ${report.artifacts}`);
  if (report.scaling)
    console.log(
      `Scaling: ${report.scaling.length} trials; ${report.scaling.filter((entry) => entry.error).length} explicit failures; provisional host budget gate ${report.hostBudgetsPassed ? "PASSED (not P1 acceptance)" : "not enabled"}`
    );
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
  if (process.env.SAMBEE_KEEP_PREVIEW_PROOF === "1") {
    report.artifacts = output;
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.error(`Failed proof evidence: ${output}`);
  }
  throw error;
} finally {
  await browser?.close();
  if (process.env.SAMBEE_KEEP_PREVIEW_PROOF !== "1") await rm(output, { recursive: true, force: true });
}
