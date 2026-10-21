import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox } from "playwright";
import { build } from "vite";

const FRONTEND = fileURLToPath(new URL("..", import.meta.url));
const APPROVED_URL = "http://localhost:3000/browse/smb/demo";
const ASSET_PREFIX = "/__draft_checkpoint_proof__/";
const HOST_TASK_LIMIT_MS = 50;
const output = await mkdtemp(resolve(tmpdir(), "sambee-draft-checkpoint-proof-"));
const reports = [];

try {
  await build({
    root: FRONTEND,
    configFile: false,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: output,
      emptyOutDir: true,
      minify: true,
      lib: {
        entry: {
          checkpoint: resolve(FRONTEND, "src/services/draftCheckpoint.ts"),
          recovery: resolve(FRONTEND, "src/services/draftRecovery.ts"),
          identity: resolve(FRONTEND, "src/services/authSession.ts"),
          state: fileURLToPath(import.meta.resolve("@codemirror/state")),
        },
        formats: ["es"],
        fileName: (_format, name) => `${name}.js`,
      },
    },
  });
  for (const [browserName, browserType] of Object.entries({ chromium, firefox })) {
    const browser = await browserType.launch({ headless: true });
    try {
      for (const width of [1543, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(`**${ASSET_PREFIX}**`, async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const path = resolve(output, decodeURIComponent(pathname.slice(ASSET_PREFIX.length)));
          if (!path.startsWith(`${output}${sep}`)) return route.abort();
          try {
            await route.fulfill({ body: await readFile(path), contentType: "text/javascript" });
          } catch {
            await route.abort();
          }
        });
        await page.route(APPROVED_URL, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: '<!doctype html><html lang="en"><title>P1 checkpoint proof</title><input id="input" aria-label="Input probe"></html>',
          })
        );
        await page.goto(APPROVED_URL);
        for (const [fixture, source] of [
          ["code", "let x=1;\n".repeat(24_000)],
          ["paragraph-source", "A **formatted** paragraph of text.\n\n".repeat(4_000)],
          ["table-source", "| first cell | second cell |\n".repeat(2_400)],
        ]) {
          const measurement = await page.evaluate(
            async ({ source, prefix }) => {
              const { Text } = await import(`${prefix}state.js`);
              const { authSession } = await import(`${prefix}identity.js`);
              const { createDraftCheckpointController, DRAFT_CHECKPOINT_START_MS, DRAFT_CHECKPOINT_LAG_MS, DRAFT_TRANSITION_FLUSH_MS } =
                await import(`${prefix}checkpoint.js`);
              const { loadDraft } = await import(`${prefix}recovery.js`);
              authSession.setAuthenticated({ access_token: "proof-only", token_type: "bearer", user_id: "checkpoint-proof" }, false);
              sessionStorage.clear();
              const controller = createDraftCheckpointController("demo", "/checkpoint.md", "markdown");
              let doc = Text.of(source.split("\n"));
              let serializedRevision = null;
              const edits = [];
              const serializations = [];
              const acknowledgements = [];
              const writes = [];
              const gaps = [];
              let lastTask = performance.now();
              const heartbeat = setInterval(() => {
                const now = performance.now();
                gaps.push(now - lastTask);
                lastTask = now;
              }, 0);
              const original = Storage.prototype.setItem;
              Storage.prototype.setItem = function (key, value) {
                const start = performance.now();
                original.call(this, key, value);
                const completed = performance.now();
                writes.push(completed - start);
                acknowledgements.push({ revision: serializedRevision, at: completed });
              };
              try {
                for (let revision = 1; revision <= 20; revision += 1) {
                  doc = doc.replace(doc.length, doc.length, Text.of(["x"]));
                  const captured = doc;
                  edits.push({ revision, at: performance.now() });
                  controller.request(revision, async () => {
                    const start = performance.now();
                    const content = captured.toString();
                    serializedRevision = revision;
                    serializations.push({ revision, at: start, ms: performance.now() - start });
                    return { baseline: source, content };
                  });
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
                const flushStart = performance.now();
                const outcome = await controller.flush();
                const flushMs = performance.now() - flushStart;
                const lags = edits.map((edit) => {
                  const stored = acknowledgements.find((ack) => ack.revision >= edit.revision);
                  if (!stored) throw new Error("An edited revision was not acknowledged");
                  return stored.at - edit.at;
                });
                const firstStartMs = serializations[0].at - edits[0].at;
                return {
                  outcome,
                  sourceUnits: source.length,
                  exactContent: loadDraft("demo", "/checkpoint.md", "markdown")?.content === `${source}${"x".repeat(20)}`,
                  serializationCount: serializations.length,
                  firstStartMs,
                  maxLagMs: Math.max(...lags),
                  flushMs,
                  maxSerializationMs: Math.max(...serializations.map((entry) => entry.ms)),
                  maxStorageMs: Math.max(...writes),
                  maxSnapshotToStorageMs: Math.max(
                    ...acknowledgements.map((ack) => ack.at - serializations.find((entry) => entry.revision === ack.revision).at)
                  ),
                  maxTimerGapMs: Math.max(0, ...gaps),
                  targets: { start: DRAFT_CHECKPOINT_START_MS, lag: DRAFT_CHECKPOINT_LAG_MS, flush: DRAFT_TRANSITION_FLUSH_MS },
                };
              } finally {
                Storage.prototype.setItem = original;
                clearInterval(heartbeat);
                controller.dispose();
                authSession.clear();
              }
            },
            { source, prefix: ASSET_PREFIX }
          );
          assert.deepEqual(measurement.outcome, { saved: true, revision: 20 });
          assert.equal(measurement.exactContent, true);
          assert.ok(measurement.serializationCount < 20, "Do not serialize each edit");
          assert.ok(measurement.firstStartMs <= measurement.targets.start, "Checkpoint start exceeded approved target");
          assert.ok(measurement.maxLagMs <= measurement.targets.lag, "Checkpoint lag exceeded approved target");
          assert.ok(measurement.flushMs <= measurement.targets.flush, "Transition flush exceeded approved target");
          assert.ok(measurement.maxSerializationMs <= HOST_TASK_LIMIT_MS, "Serialization task exceeded interaction ceiling");
          assert.ok(measurement.maxStorageMs <= HOST_TASK_LIMIT_MS, "Storage task exceeded interaction ceiling");
          assert.ok(
            measurement.maxSnapshotToStorageMs <= HOST_TASK_LIMIT_MS,
            "Snapshot preparation and storage exceeded interaction ceiling"
          );
          assert.ok(measurement.maxTimerGapMs <= HOST_TASK_LIMIT_MS, "Scheduling responsiveness proxy exceeded ceiling");
          reports.push({ browserName, browser: browser.version(), width, fixture, ...measurement });
        }

        const lifecycleSource = "let x=1;\n".repeat(24_000);
        for (const lifecycle of ["late-completion", "reload"]) {
          await page.evaluate(
            async ({ prefix, source }) => {
              const { authSession } = await import(`${prefix}identity.js`);
              const { Text } = await import(`${prefix}state.js`);
              const { createDraftCheckpointController } = await import(`${prefix}checkpoint.js`);
              const { createDraftCheckpointSession } = await import(`${prefix}recovery.js`);
              authSession.setAuthenticated({ access_token: "proof-only", token_type: "bearer", user_id: "checkpoint-proof" }, false);
              sessionStorage.clear();
              const controller = createDraftCheckpointController("demo", "/lifecycle.md", "markdown");
              let doc = Text.of(source.split("\n"));
              let release;
              const deferred = new Promise((resolve) => {
                release = resolve;
              });
              controller.request(1, () => deferred);
              const flush = controller.flush();
              document.querySelector("#input").oninput = () => {
                doc = doc.replace(doc.length, doc.length, Text.of(["x"]));
              };
              window.checkpointLifecycleProof = { controller, release, flush, result: null };
              window.addEventListener(
                "pagehide",
                () => {
                  const start = performance.now();
                  const session = createDraftCheckpointSession("demo", "/lifecycle.md", "markdown");
                  try {
                    const result = session.commit(session.capture(2), source, doc.toString());
                    window.checkpointLifecycleProof.result = { ...result, ms: performance.now() - start };
                  } finally {
                    session.dispose();
                  }
                },
                { once: true }
              );
              await Promise.resolve();
            },
            { prefix: ASSET_PREFIX, source: lifecycleSource }
          );
          await page.locator("#input").press("x");
          if (lifecycle === "late-completion") {
            const result = await page.evaluate(
              async ({ prefix }) => {
                window.dispatchEvent(new PageTransitionEvent("pagehide"));
                const proof = window.checkpointLifecycleProof;
                proof.release({ baseline: "saved", content: "obsolete async edit" });
                const late = await proof.flush;
                const { loadDraft } = await import(`${prefix}recovery.js`);
                const recovered = loadDraft("demo", "/lifecycle.md", "markdown");
                proof.controller.dispose();
                return { latest: proof.result, late, content: recovered?.content };
              },
              { prefix: ASSET_PREFIX }
            );
            assert.equal(result.latest.saved, true);
            assert.ok(result.latest.ms <= HOST_TASK_LIMIT_MS);
            assert.deepEqual(result.late, { saved: false, revision: 1, reason: "stale-checkpoint" });
            assert.equal(result.content, `${lifecycleSource}x`);
            reports.push({
              browserName,
              width,
              fixture: "synchronous-lifecycle",
              sourceUnits: lifecycleSource.length,
              snapshotAndStorageMs: result.latest.ms,
            });
          } else {
            await page.reload();
            const recovered = await page.evaluate(
              async ({ prefix }) => {
                const { authSession } = await import(`${prefix}identity.js`);
                authSession.setAuthenticated({ access_token: "proof-only", token_type: "bearer", user_id: "checkpoint-proof" }, false);
                const { loadDraft } = await import(`${prefix}recovery.js`);
                return loadDraft("demo", "/lifecycle.md", "markdown")?.content;
              },
              { prefix: ASSET_PREFIX }
            );
            assert.equal(recovered, `${lifecycleSource}x`);
          }
        }
        assert.deepEqual(errors, []);
        await page.close();
        console.log(
          `${browserName} width=${width}: sustained-edit checkpoints, pending-snapshot keyboard input, synchronous lifecycle, late-result rejection and real reload passed`
        );
      }
    } finally {
      await browser.close();
    }
  }
  console.log(JSON.stringify({ kind: "P1 recovery boundary proof, NOT integrated editor acceptance", measurements: reports }, null, 2));
} finally {
  await rm(output, { recursive: true, force: true });
}
