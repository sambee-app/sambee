import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { executeSourceSearchProof } from "./prototypes/sourceSearchContainment.worker.mjs";

const OPERATION_TIMEOUT_MS = 2_000;
const STALLED_OPERATION_TIMEOUT_MS = 200;
const HEARTBEAT_MS = 10;
const NATIVE_ATOMIC_MATCH_COUNT = 6_000;
const NATIVE_ATOMIC_EXPANSION_UNITS = 128;
const NATIVE_ATOMIC_MATCH = "abc 123";
const NATIVE_TABLE_ROWS = 2_400;
const NATIVE_TABLE_ROW = NATIVE_TABLE_ROWS / 2;
const NATIVE_TABLE_PAYLOAD = "table edit";
const NATIVE_TABLE_KEY_DELAY_MS = 10;
const NATIVE_TABLE_TIMEOUT_MS = 15_000;
const NATIVE_TABLE_VIEWPORT = { width: 1543, height: 900 };
const NATIVE_TABLE_OUTER_NEWLINE_UNITS = 2;
const NATIVE_TABLE_INPUT_PERCENTILE = 0.95;
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
} else if (process.argv.includes("--native-table") || process.argv.includes("--native-atomic")) {
  const { build } = await import("vite");
  const { chromium, firefox } = await import("playwright");
  const nativeTable = process.argv.includes("--native-table");
  const profiling = nativeTable && process.env.SAMBEE_E2E_TRACE === "1";
  const reportPrefix = nativeTable ? process.env.SAMBEE_NATIVE_TABLE_REPORT : undefined;
  assert.ok(
    !nativeTable || (process.env.SAMBEE_E2E_BUDGETS !== "1" && process.env.SAMBEE_E2E_MEMORY !== "1"),
    "Native table diagnostics cannot enforce product budgets or combine with controlled GC"
  );
  assert.ok(!profiling || reportPrefix, "Native table profiling requires SAMBEE_NATIVE_TABLE_REPORT");
  assert.ok(
    !profiling || (process.env.MOZ_PROFILER_STARTUP === "1" && process.env.MOZ_PROFILER_SHUTDOWN),
    "Native Firefox profiling requires startup profiler configuration and a shutdown profile path"
  );
  const entry = "native-atomic-reproduction.js";
  const moduleSource = nativeTable
    ? `
    import { EditorState } from '@codemirror/state';
    import { EditorView, keymap } from '@codemirror/view';
    import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
    import { markdown } from '@codemirror/lang-markdown';
    import { forceParsing } from '@codemirror/language';
    import { GFM } from '@lezer/markdown';
    import { markdownTables } from 'codemirror-markdown-tables';
    const rows = Array.from({ length: ${NATIVE_TABLE_ROWS} }, (_, index) => '| ' + (index + 1) + ' | row ' + (index + 1) + ' needle |');
    const source = '| Key | Value |\\n| --- | --- |\\n' + rows.join('\\n') + '\\n';
    let recording = false;
    let previous;
    let inputAt;
    const inputs = [], gaps = [], transactions = [];
    const root = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc: source, extensions: [
        history(), keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ extensions: [GFM] }),
        markdownTables({ selectionType: 'codemirror', handlePosition: 'inside', lineWrapping: 'wrap',
          extensions: [keymap.of(defaultKeymap)], globalKeyBindings: historyKeymap })
      ] }),
      dispatchTransactions(batch, view) {
        if (!recording) { view.update(batch); return; }
        const startedAt = performance.now();
        for (const transaction of batch) void transaction.state;
        const stateReadyAt = performance.now();
        view.update(batch);
        const updatedAt = performance.now();
        for (const transaction of batch) if (transaction.docChanged) {
          let removedUnits = 0, insertedUnits = 0, changeCount = 0;
          transaction.changes.iterChanges((from, to, _fromB, _toB, text) => {
            removedUnits += to - from; insertedUnits += text.length; changeCount += 1;
          });
          transactions.push({ stateApplyMs: stateReadyAt - startedAt, viewUpdateMs: updatedAt - stateReadyAt,
            inputToRootMs: inputAt === undefined ? null : startedAt - inputAt,
            beforeUnits: transaction.startState.doc.length, afterUnits: transaction.newDoc.length,
            removedUnits, insertedUnits, changeCount });
        }
      }
    });
    if (!forceParsing(root, root.state.doc.length, ${NATIVE_TABLE_TIMEOUT_MS})) throw Error('Native table syntax did not finish parsing');
    const beforeInput = event => {
      if (!recording || !root.dom.contains(event.target)) return;
      const start = performance.now();
      inputAt = start;
      previous ??= start;
      requestAnimationFrame(() => requestAnimationFrame(() => inputs.push(performance.now() - start)));
    };
    document.addEventListener('beforeinput', beforeInput, true);
    const timer = setInterval(() => {
      if (!recording || previous === undefined) return;
      const now = performance.now(); gaps.push(now - previous); previous = now;
    }, 0);
    window.nativeTable = {
      start() { performance.mark('sambee:native-table:input-start'); recording = true; },
      source() { return root.state.doc.toString(); },
      async stop() {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        performance.mark('sambee:native-table:input-end');
        recording = false;
        return { sourceUnits: source.length, inputs, gaps, transactions };
      },
      dispose() { recording = false; clearInterval(timer); document.removeEventListener('beforeinput', beforeInput, true); root.destroy(); }
    };
  `
    : `
    import { EditorState, Text } from '@codemirror/state';
    window.nativeAtomic = (separator, expansion) => {
      const match = ${JSON.stringify(NATIVE_ATOMIC_MATCH)};
      const matchCount = ${NATIVE_ATOMIC_MATCH_COUNT};
      const unit = match + ';' + separator;
      const source = unit.repeat(matchCount);
      const insert = expansion ? 'x'.repeat(${NATIVE_ATOMIC_EXPANSION_UNITS}) : 'replaced-123';
      const state = EditorState.create({ doc: source });
      const specs = Array.from({ length: matchCount }, (_, index) => ({ from: index * unit.length, to: index * unit.length + match.length, insert }));
      const prepareAt = performance.now();
      const changes = state.changes(specs);
      const preparedMs = performance.now() - prepareAt;
      const start = performance.now();
      const result = changes.apply(state.doc);
      const applyMs = performance.now() - start;
      const assemblyAt = performance.now();
      const parts = [];
      let offset = 0;
      changes.iterChanges((from, to, _fromB, _toB, text) => {
        parts.push(state.doc.sliceString(offset, from), text.toString());
        offset = to;
      });
      parts.push(state.doc.sliceString(offset));
      const assembled = Text.of(parts.join('').split('\\n'));
      const assemblyMs = performance.now() - assemblyAt;
      const expected = (insert + ';' + separator).repeat(matchCount);
      if (result.toString() !== expected || assembled.toString() !== expected || !assembled.eq(result)) throw Error('Native/assembled output mismatch');
      if (changes.invert(state.doc).apply(result).toString() !== source) throw Error('Native inverse mismatch');
      return { sourceUnits: source.length, outputUnits: result.length, changeCount: specs.length, preparedMs, applyMs, assemblyMs };
    };
  `;
  const result = await build({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    plugins: [
      {
        name: "native-atomic-reproduction",
        resolveId: (id) => (id.endsWith(entry) ? resolve(fileURLToPath(new URL("..", import.meta.url)), entry) : undefined),
        load: (id) => (id.endsWith(entry) ? moduleSource : undefined),
      },
    ],
    build: { write: false, minify: !nativeTable, lib: { entry, name: "NativeAtomic", formats: ["iife"] } },
  });
  const output = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk");
  assert.ok(output, "Native atomic reproduction must build a runnable chunk");
  if (reportPrefix) await writeFile(`${reportPrefix}.bundle.js`, output.code);
  for (const [engine, browserType] of Object.entries({ chromium, firefox })) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage(nativeTable ? { viewport: NATIVE_TABLE_VIEWPORT } : undefined);
      const approvedUrl = "http://localhost:3000/browse/smb/demo";
      await page.route(approvedUrl, (route) =>
        route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Native atomic diagnostic</title></html>' })
      );
      await page.goto(approvedUrl);
      await page.addScriptTag({ content: output.code });
      if (nativeTable) {
        page.setDefaultTimeout(NATIVE_TABLE_TIMEOUT_MS);
        const errors = [];
        let profileSession;
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          const cell = page.locator(".tbl-data-cell .tbl-cell-view").nth((NATIVE_TABLE_ROW - 1) * 2);
          await cell.click();
          const nested = page.locator(".tbl-cell-editor .cm-content");
          await nested.waitFor({ state: "visible" });
          await nested.focus();
          await page.keyboard.press("End");
          if (profiling && engine === "chromium") {
            profileSession = await page.context().newCDPSession(page);
            await profileSession.send("Profiler.enable");
            await profileSession.send("Profiler.start");
          }
          await page.evaluate(() => window.nativeTable.start());
          await page.keyboard.press("Shift+Enter");
          await page.keyboard.type(NATIVE_TABLE_PAYLOAD, { delay: NATIVE_TABLE_KEY_DELAY_MS });
          const sample = await page.evaluate(() => window.nativeTable.stop());
          if (profileSession) {
            const { profile } = await profileSession.send("Profiler.stop");
            await writeFile(`${reportPrefix}.${engine}.profile.json`, JSON.stringify(profile));
            await profileSession.detach();
            profileSession = undefined;
          }
          const saved = await page.evaluate(() => window.nativeTable.source());
          const keyWidth = String(NATIVE_TABLE_ROW).length + "<br>".length + NATIVE_TABLE_PAYLOAD.length;
          const valueWidth = `row ${NATIVE_TABLE_ROWS} needle`.length;
          const expectedRows = Array.from({ length: NATIVE_TABLE_ROWS }, (_, index) => {
            const key = `${index + 1}${index + 1 === NATIVE_TABLE_ROW ? `<br>${NATIVE_TABLE_PAYLOAD}` : ""}`;
            return `| ${key.padEnd(keyWidth)} | ${`row ${index + 1} needle`.padEnd(valueWidth)} |`;
          });
          const expected = `\n| ${"Key".padEnd(keyWidth)} | ${"Value".padEnd(valueWidth)} |\n| ${"-".repeat(keyWidth)} | ${"-".repeat(valueWidth)} |\n${expectedRows.join("\n")}\n`;
          assert.equal(saved, expected, "Native table must publish the exact formatted document");
          assert.ok(sample.inputs.length >= NATIVE_TABLE_PAYLOAD.length, "Every typed character must produce an input sample");
          assert.ok(
            sample.inputs.every(Number.isFinite) && sample.gaps.length > 0 && sample.gaps.every(Number.isFinite),
            "Native timing samples must be present and finite"
          );
          assert.ok(sample.transactions.length > 0, "Native typing must publish root transactions");
          for (const transaction of sample.transactions) {
            assert.equal(transaction.changeCount, 1, "Native table edits must remain atomic");
            assert.equal(
              transaction.removedUnits,
              transaction.beforeUnits - NATIVE_TABLE_OUTER_NEWLINE_UNITS,
              "Native cell edits replace the full source table"
            );
            assert.equal(
              transaction.insertedUnits,
              transaction.afterUnits - NATIVE_TABLE_OUTER_NEWLINE_UNITS,
              "Native replacement must contain the complete updated table"
            );
          }
          await page.keyboard.press("Control+z");
          assert.notEqual(await page.evaluate(() => window.nativeTable.source()), expected, "Native undo must change the document");
          await page.keyboard.press("Control+Shift+Z");
          await page.waitForFunction((expected) => window.nativeTable.source() === expected, expected);
          const sortedInputs = [...sample.inputs].sort((left, right) => left - right);
          const evidence = {
            engine,
            browserVersion: browser.version(),
            viewport: NATIVE_TABLE_VIEWPORT,
            rows: NATIVE_TABLE_ROWS,
            row: NATIVE_TABLE_ROW,
            diagnostic: true,
            profiling,
            payload: NATIVE_TABLE_PAYLOAD,
            keyboardTwoFrameP95: sortedInputs[Math.ceil(sortedInputs.length * NATIVE_TABLE_INPUT_PERCENTILE) - 1],
            maximumTimerGap: Math.max(...sample.gaps),
            outputUnits: saved.length,
            ...sample,
            scope:
              "Diagnostic unminified public CodeMirror/markdownTables only, after activation; no React, application callbacks, normalization, Save or workers. Explicit transaction.state materialization separates state application from view.update; elapsed stages are not pure CPU or product timing acceptance. Exact native output and undo/redo required.",
          };
          if (reportPrefix) await writeFile(`${reportPrefix}.${engine}.json`, JSON.stringify(evidence));
          console.log(JSON.stringify(evidence));
          assert.deepEqual(errors, [], "Native table diagnostic must have no page errors");
        } finally {
          if (profileSession) await profileSession.detach();
          await page.evaluate(() => window.nativeTable.dispose());
        }
        assert.equal(await page.locator(".cm-editor").count(), 0, "Native editor must dispose");
        continue;
      }
      for (const separator of ["\n", " "])
        for (const expansion of [false, true]) {
          const sample = await page.evaluate(({ separator, expansion }) => window.nativeAtomic(separator, expansion), {
            separator,
            expansion,
          });
          console.log(
            JSON.stringify({
              engine,
              browserVersion: browser.version(),
              fixture: separator === "\n" ? "dense" : "long-line",
              operation: expansion ? "dense-expansion" : "original",
              scope:
                "Diagnostic native ChangeSet application and isolated span-assembly candidate; no production patch, EditorView, React, worker or DOM. Not timing acceptance or a mapping/history implementation.",
              ...sample,
            })
          );
        }
    } finally {
      await browser.close();
    }
  }
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
