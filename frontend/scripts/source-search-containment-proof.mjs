import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { executeSourceSearchProof } from "./prototypes/sourceSearchContainment.worker.mjs";

const OPERATION_TIMEOUT_MS = 2_000;
const STALLED_OPERATION_TIMEOUT_MS = 200;
const HEARTBEAT_MS = 10;
const OPERATIONS = ["count", "active-range", "visible-matches", "next", "previous", "replace-one", "replace-all"];

if (!isMainThread) {
  parentPort.on("message", (request) => {
    try {
      parentPort.postMessage({ result: executeSourceSearchProof(request) });
    } catch (error) {
      parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  async function run(request, timeout = OPERATION_TIMEOUT_MS) {
    const worker = new Worker(new URL(import.meta.url));
    let heartbeats = 0;
    let ready = false;
    let settled = false;
    let timer;
    const heartbeat = setInterval(() => (heartbeats += 1), HEARTBEAT_MS);
    try {
      return await new Promise((resolve, reject) => {
        const deadline = () => {
          clearTimeout(timer);
          timer = setTimeout(
            () => {
              settled = true;
              reject(Object.assign(new Error("Source-search proof deadline exceeded"), { code: "PROOF_TIMEOUT", ready, heartbeats }));
            },
            ready ? timeout : OPERATION_TIMEOUT_MS
          );
        };
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (!settled) reject(new Error(`Source-search worker exited before a result (${code})`));
        });
        worker.on("message", (message) => {
          if (settled) return;
          if (message.ready) {
            ready = true;
            heartbeats = 0;
            deadline();
            worker.postMessage(request);
          } else {
            settled = true;
            if (message.error) reject(new Error(message.error));
            else resolve(message.result);
          }
        });
        deadline();
      });
    } finally {
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      await worker.terminate();
    }
  }

  const normal = { source: "one=1 two=2", query: "(one|two)=(\\d)", replace: "$2:$1" };
  const expected = new Map();
  for (const operation of OPERATIONS) {
    const result = await run({ ...normal, operation, selection: operation === "replace-one" ? { anchor: 0, head: 5 } : undefined });
    expected.set(operation, result);
    if (["count", "active-range", "visible-matches"].includes(operation)) assert.equal(result.count, 2);
    if (operation === "next") assert.deepEqual(result.selection, { from: 0, to: 5 });
    if (operation === "previous") assert.deepEqual(result.selection, { from: 6, to: 11 });
    if (operation === "replace-one") assert.equal(result.content, "1:one two=2");
    if (operation === "replace-all") {
      assert.equal(result.content, "1:one 2:two");
      assert.equal(result.edits, 1);
      assert.equal(result.undone, true);
      assert.equal(result.undoContent, normal.source);
    }
    await assert.rejects(
      run({ operation, source: `${"a".repeat(128)}!`, query: "(a+)+$", replace: "replacement" }, STALLED_OPERATION_TIMEOUT_MS),
      (error) => error.code === "PROOF_TIMEOUT" && error.ready && error.heartbeats > 0
    );
    const retry = await run({ ...normal, operation: "count" });
    assert.equal(retry.count, 2);
    console.log(`${operation}: native matching/command passed; stalled worker terminated; host serviced timers; fresh-worker retry passed`);
  }
  await assert.rejects(run({ ...normal, operation: "count", query: "(" }), /Invalid source-search expression/);
  const zeroWidth = await run({ operation: "replace-all", source: "aa", query: "(?=a)", replace: "x" });
  assert.equal(zeroWidth.content, "xaxa");
  assert.equal(zeroWidth.undoContent, "aa");
  console.log(
    "P1 Node-worker feasibility proof passed. Not browser/editor integration, replacement-transfer bounds, or product timeout acceptance."
  );

  if (process.env.SAMBEE_SOURCE_SEARCH_PROOF_BROWSER) {
    const { chromium, firefox } = await import("playwright");
    const { build } = await import("vite");
    const browsers = { chromium, firefox };
    const names = process.env.SAMBEE_SOURCE_SEARCH_PROOF_BROWSER.split(",");
    assert.ok(
      names.every((name) => Object.keys(browsers).includes(name)),
      "Unsupported proof browser"
    );
    const output = await mkdtemp(resolve(tmpdir(), "sambee-source-search-proof-"));
    const approvedUrl = "http://localhost:3000/browse/smb/demo";
    const workerUrl = "/__source_search_proof__/worker.js";
    const browserDeadlineMs = 500;
    try {
      await build({
        configFile: false,
        root: fileURLToPath(new URL("..", import.meta.url)),
        logLevel: "warn",
        build: {
          outDir: output,
          emptyOutDir: true,
          minify: true,
          rollupOptions: {
            input: fileURLToPath(new URL("./prototypes/sourceSearchContainment.worker.mjs", import.meta.url)),
            output: { entryFileNames: "worker.js", codeSplitting: false },
          },
        },
      });
      const workerBody = await readFile(resolve(output, "worker.js"));
      for (const name of names) {
        const browser = await browsers[name].launch({ headless: true });
        try {
          for (const width of [1543, 390]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.route(`**${workerUrl}`, (route) => route.fulfill({ body: workerBody, contentType: "text/javascript" }));
            await page.route(approvedUrl, (route) =>
              route.fulfill({
                contentType: "text/html",
                body: '<!doctype html><html lang="en"><title>P1 source-search proof</title><input aria-label="Input probe" id="input"></html>',
              })
            );
            await page.goto(approvedUrl);
            const runBrowser = async (request, { stall = false, cancel = false } = {}) => {
              await page.evaluate(
                async ({ request, workerUrl, timeout, startupTimeout }) => {
                  window.sourceSearchProofResult = null;
                  await new Promise((resolveStarted, rejectStarted) => {
                    const worker = new Worker(workerUrl, { type: "module" });
                    let ready = false;
                    let settled = false;
                    const finish = (result) => {
                      if (settled) return;
                      settled = true;
                      clearTimeout(timer);
                      worker.terminate();
                      window.sourceSearchProofResult = result;
                      window.cancelSourceSearchProof = null;
                      if (!ready) rejectStarted(new Error("Source-search browser worker failed to start"));
                    };
                    let timer = setTimeout(() => finish({ startupTimeout: true }), startupTimeout);
                    window.cancelSourceSearchProof = () => finish({ cancelled: true });
                    worker.onerror = (event) => {
                      event.preventDefault();
                      finish({ error: event.message });
                    };
                    worker.addEventListener("messageerror", () => finish({ error: "Worker response decode failed" }));
                    worker.onmessage = (event) => {
                      if (settled) return;
                      if (event.data.ready) {
                        ready = true;
                        clearTimeout(timer);
                        timer = setTimeout(() => finish({ timedOut: true }), timeout);
                        worker.postMessage(request);
                        resolveStarted();
                      } else finish(event.data);
                    };
                  });
                },
                {
                  request,
                  workerUrl,
                  timeout: stall || cancel ? browserDeadlineMs : OPERATION_TIMEOUT_MS,
                  startupTimeout: OPERATION_TIMEOUT_MS,
                }
              );
              if (stall || cancel) {
                const input = page.locator("#input");
                const before = await input.inputValue();
                await input.press("x");
                const serviced = await page.evaluate(() => ({
                  text: document.querySelector("#input").value,
                  pending: window.sourceSearchProofResult === null,
                }));
                assert.equal(serviced.text, `${before}x`);
                assert.equal(serviced.pending, true, "Keyboard input must be serviced before worker timeout/cancellation");
                if (cancel) await page.evaluate(() => window.cancelSourceSearchProof());
              }
              await page.waitForFunction(() => window.sourceSearchProofResult !== null);
              return page.evaluate(() => window.sourceSearchProofResult);
            };
            for (const operation of OPERATIONS) {
              const request = { ...normal, operation, selection: operation === "replace-one" ? { anchor: 0, head: 5 } : undefined };
              const baseline = await runBrowser(request);
              assert.deepEqual(baseline.result, expected.get(operation));
              const pathological = { operation, source: `${"a".repeat(128)}!`, query: "(a+)+$", replace: "replacement" };
              assert.deepEqual(await runBrowser(pathological, { stall: true }), { timedOut: true });
              const retry = await runBrowser(request);
              assert.deepEqual(retry.result, expected.get(operation));
              assert.deepEqual(await runBrowser(pathological, { cancel: true }), { cancelled: true });
            }
            const invalid = await runBrowser({ ...normal, operation: "count", query: "(" });
            assert.match(invalid.error, /Invalid source-search expression/);
            const zeroWidthResult = await runBrowser({ operation: "replace-all", source: "aa", query: "(?=a)", replace: "x" });
            assert.deepEqual(zeroWidthResult.result, zeroWidth);
            assert.deepEqual(errors, []);
            console.log(
              `${name} ${browser.version()} width=${width}: all seven native/proxy paths, keyboard-during-stall, timeout, cancellation, restart, capture expansion and undo checks passed`
            );
            await page.close();
          }
        } finally {
          await browser.close();
        }
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
}
