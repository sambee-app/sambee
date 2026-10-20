import assert from "node:assert/strict";

const HOST_ENVELOPE_UNITS = { "dense-code": 24_000, paragraphs: 4_000, table: 2_400 };
const HOST_BUDGETS = { loadMs: 1_500, searchMs: 1_000, warmSearchMs: 100, navigationMs: 100, maximumTaskServiceGapMs: 50 };
const HOST_RENDERER_HEAP_BYTES = 64 * 1_024 * 1_024;
const HOST_SHUTDOWN_GROWTH_BYTES = 1_024 * 1_024;
const HOST_TRIALS = 3;

export function documentHostBudgetFailures(report) {
  const failures = [];
  for (const width of [1543, 390]) {
    for (const [fixture, units] of Object.entries(HOST_ENVELOPE_UNITS))
      for (let trial = 0; trial < HOST_TRIALS; trial += 1) {
        const entries = (report.scaling ?? []).filter(
          (entry) => entry.width === width && entry.fixture === fixture && entry.units === units && entry.trial === trial
        );
        const entry = entries[0];
        const label = `${report.browserName} ${width} ${fixture} ${units} trial ${trial}`;
        if (entries.length !== 1 || !entry?.measurement || entry.error) {
          failures.push(`${label}: missing/duplicate/failed trial${entry?.error ? `: ${entry.error}` : ""}`);
          continue;
        }
        for (const [metric, budget] of Object.entries(HOST_BUDGETS)) {
          const actual = entry.measurement[metric];
          if (!Number.isFinite(actual) || actual < 0 || actual > budget)
            failures.push(`${label}: ${metric}=${actual} exceeds ${budget} ms or is invalid`);
        }
        if (report.browserName === "chromium") {
          const bytes = entry.loadedRendererSnapshot?.usedSize;
          if (!Number.isFinite(bytes) || bytes < 0 || bytes > HOST_RENDERER_HEAP_BYTES)
            failures.push(`${label}: loaded renderer heap=${bytes} exceeds ${HOST_RENDERER_HEAP_BYTES} bytes or is unavailable`);
        }
      }
    if (report.browserName === "chromium") {
      const resource = (report.resources ?? []).find((entry) => entry.width === width && entry.supported);
      const samples = resource?.samples;
      if (samples?.length !== 6) failures.push(`${width}: six post-shutdown resource samples required`);
      else {
        const growth = samples.at(-1).usedSize - samples[1].usedSize;
        if (!Number.isFinite(growth) || growth > HOST_SHUTDOWN_GROWTH_BYTES)
          failures.push(`${width}: warmed shutdown heap growth=${growth} exceeds ${HOST_SHUTDOWN_GROWTH_BYTES} bytes or is unavailable`);
        for (const sample of samples)
          if (sample.owned.elements !== 0 || sample.owned.highlights !== 0 || sample.owned.liveWorkers !== 0)
            failures.push(`${width}: owned resources remain after cycle ${sample.cycle}`);
      }
    }
  }
  return failures;
}

export async function runMarkdownDocumentProof(page, report, width) {
  await page.evaluate(() => {
    const OriginalWorker = window.Worker;
    window.documentWorkers = [];
    window.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        window.documentWorkers.push({ worker: this, terminated: false });
      }
      terminate() {
        window.documentWorkers.find((entry) => entry.worker === this).terminated = true;
        super.terminate();
      }
      postMessage(message, ...args) {
        if (message.type === "syntax-window" && window.pauseSyntaxWindow) {
          window.pausedSyntaxWorker = this;
          return;
        }
        if (message.type === "prepare") this.documentPreparation = message.document === true;
        if (this.documentPreparation && window.pauseDocumentPublication && message.type === "ack") {
          window.resumeDocumentPublication = () => super.postMessage(message, ...args);
          return;
        }
        super.postMessage(message, ...args);
      }
    };
  });
  const fixtures = [
    {
      name: "unicode-boundaries",
      source: `# Unicode boundaries\n\n${"x".repeat(2_047)}\u{1f30d}${"x".repeat(2_047)}e\u0301\n\n\`\`\`text\n${"x".repeat(2_047)}\u{1f30d}\t end\n\`\`\``,
    },
    { name: "empty", source: "" },
    { name: "unknown-language", source: "# Plain fallback\n\n```unknown-language-proof\nUnchanged source.\n```" },
    { name: "image", source: "# Image sizing\n\n![Visible fixture](/__markdown_preview_proof__/fixture.png)\n\nText after image." },
    {
      name: "mixed",
      source:
        "# Whole Markdown\n\n**Strong**, *emphasis*, ~~deleted~~ and [link](https://example.com). Unicode \u{1f30d} &amp; &copy;.\n\n> Nested quote\n>\n> - first\n>   - child\n\n- [x] done\n- [ ] pending\n\n| Left | Right |\n| :--- | ---: |\n| first<br>second | `inline` |\n\n```js\nlet x = 1;\n```\n\nFootnote[^note].\n\n[^note]: Offscreen footnote.\n\n<script>window.invalid=true</script>\n[unsafe](javascript:alert%281%29)",
    },
    { name: "dense-code", source: `# Dense code\n\n\`\`\`js\n${"let x=1;\n".repeat(6_000)}\`\`\`\n\nLast paragraph.` },
    {
      name: "large-paragraph",
      source: `# Large paragraph\n\n${"Text **strong** with \u{1f30d} and inline `code`. ".repeat(1_000)}\n\nEnd.`,
    },
    {
      name: "large-table",
      source: `# Large table\n\n| Number | Value |\n| --- | --- |\n${Array.from({ length: 800 }, (_, index) => `| ${index} | cell **${index}**<br>next |`).join("\n")}\n\nEnd.`,
    },
    { name: "long-line", source: `# Long line\n\n\`\`\`js\n// ${"x".repeat(60_000)}\n\`\`\`\n\nEnd.` },
  ];
  for (const fixture of fixtures) {
    await page.evaluate((source) => window.codePreviewPrototype.baselineDocument(source), fixture.source);
    await page.locator("[data-markdown-baseline] img").evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())));
    const expected = await page.evaluate(() => {
      const container = document.querySelector("[data-markdown-baseline]");
      const selection = window.getSelection();
      selection.selectAllChildren(container);
      const selected = selection.toString();
      selection.removeAllRanges();
      return {
        text: container.textContent,
        selected,
        height: container.scrollHeight,
        tags: [...container.querySelectorAll("h1,h2,p,table,tr,td,th,ul,ol,li,input,a,pre,code,br")].map((element) => element.tagName),
      };
    });
    await page.setViewportSize({ width: width === 390 ? 1543 : 390, height: 900 });
    expected.resizedHeight = await page.locator("[data-markdown-baseline]").evaluate((container) => container.scrollHeight);
    await page.setViewportSize({ width, height: 900 });
    const nativeFind = async (selector) =>
      page.locator(selector).evaluate((container) => {
        container.scrollTop = 0;
        window.getSelection().removeAllRanges();
        const found = window.find("Last paragraph.", false, false, true);
        const selection = window.getSelection();
        const rect = selection.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
        const viewport = container.getBoundingClientRect();
        const result = {
          found,
          selected: selection.toString(),
          visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom),
        };
        selection.removeAllRanges();
        return result;
      });
    const baselineFind = fixture.name === "dense-code" ? await nativeFind("[data-markdown-baseline]") : null;
    const timing = await page.evaluate(async (source) => {
      const start = performance.now();
      let previous = start;
      let maximumTaskServiceGapMs = 0;
      let timer;
      const probe = () => {
        const now = performance.now();
        maximumTaskServiceGapMs = Math.max(maximumTaskServiceGapMs, now - previous);
        previous = now;
        timer = setTimeout(probe, 0);
      };
      const longTasks = [];
      const longTaskObservationSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
      const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
      if (longTaskObservationSupported) observer.observe({ type: "longtask" });
      timer = setTimeout(probe, 0);
      try {
        await window.codePreviewPrototype.loadDocument(source);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        longTasks.push(...observer.takeRecords().map((entry) => entry.duration));
        maximumTaskServiceGapMs = Math.max(maximumTaskServiceGapMs, performance.now() - previous);
        return { loadToPaintMs: performance.now() - start, longTaskObservationSupported, longTasks, maximumTaskServiceGapMs };
      } finally {
        clearTimeout(timer);
        observer.disconnect();
      }
    }, fixture.source);
    await page.locator("[data-markdown-document] img").evaluateAll(async (images) => Promise.all(images.map((image) => image.decode())));
    const actual = await page.evaluate(() => {
      const container = document.querySelector("[data-markdown-document]");
      const selection = window.getSelection();
      selection.selectAllChildren(container);
      const selected = selection.toString();
      selection.removeAllRanges();
      return {
        stats: window.codePreviewPrototype.stats(),
        text: container.textContent,
        selected,
        height: container.scrollHeight,
        tags: [...container.querySelectorAll("h1,h2,p,table,tr,td,th,ul,ol,li,input,a,pre,code,br")].map((element) => element.tagName),
        unsafe: container.querySelector("script,[onclick],a[href^='javascript:']") !== null,
      };
    });
    assert.equal(actual.stats.complete, true);
    assert.equal(actual.stats.error, null);
    assert.equal(actual.text, expected.text, fixture.name);
    assert.equal(actual.selected, expected.selected, `${fixture.name}: native selection`);
    assert.deepEqual(actual.tags, expected.tags, fixture.name);
    assert.equal(actual.height, expected.height, `${fixture.name}: layout`);
    assert.equal(actual.unsafe, false);
    assert.ok(actual.stats.largestBatch <= actual.stats.batchLimit);
    assert.ok(actual.stats.highlightRanges <= 4_000);
    assert.equal(actual.stats.syntaxError, null);
    assert.ok(actual.stats.cachedSyntaxRanges <= actual.stats.syntaxCacheLimit);
    assert.ok(actual.stats.peakCachedSyntaxRanges <= actual.stats.syntaxCacheLimit);
    assert.ok(actual.stats.largestSyntaxPage <= actual.stats.syntaxPageLimit);
    if (fixture.name === "dense-code") {
      await page.waitForFunction(
        () => !window.codePreviewPrototype.stats().syntaxFetching && window.codePreviewPrototype.stats().highlightRanges > 0
      );
      const top = await page.evaluate(() => {
        const container = document.querySelector("[data-markdown-document]");
        const node = container.querySelector("code [data-document-fragment]").firstChild;
        window.syntaxSelectionNode = node;
        const range = new Range();
        range.setStart(node, 0);
        range.setEnd(node, 3);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const stats = window.codePreviewPrototype.stats();
        container.scrollTop = container.scrollHeight;
        return stats;
      });
      await page.waitForFunction(() => {
        const container = document.querySelector("[data-markdown-document]");
        const viewport = container.getBoundingClientRect();
        const highlight = CSS.highlights.get("document-keyword");
        return (
          !window.codePreviewPrototype.stats().syntaxFetching &&
          highlight &&
          [...highlight].some((range) => {
            const rect = range.getBoundingClientRect();
            return rect.bottom > viewport.top && rect.top < viewport.bottom;
          })
        );
      });
      const bottom = await page.evaluate(() => {
        const selection = window.getSelection();
        const stats = window.codePreviewPrototype.stats();
        const stable =
          selection.anchorNode === window.syntaxSelectionNode && selection.toString() === "let" && window.syntaxSelectionNode.isConnected;
        selection.removeAllRanges();
        window.syntaxSelectionNode = null;
        return { ...stats, stable };
      });
      assert.ok(top.workerSyntaxRanges > top.syntaxCacheLimit);
      assert.ok(bottom.peakCachedSyntaxRanges <= bottom.syntaxCacheLimit);
      assert.ok(bottom.largestSyntaxPage <= bottom.syntaxPageLimit);
      assert.equal(bottom.syntaxError, null);
      assert.equal(bottom.stable, true);
      assert.ok(bottom.syntaxPages > top.syntaxPages);
      report.interactions.push({ width, mode: "viewport-syntax", top, bottom });
      await page.evaluate(() => {
        window.pauseSyntaxWindow = true;
        document.querySelector("[data-markdown-document]").scrollTop = 0;
      });
      await page.waitForFunction(() => !!window.pausedSyntaxWorker);
      const syntaxFailure = await page.evaluate(async () => {
        const container = document.querySelector("[data-markdown-document]");
        const node = container.querySelector("code [data-document-fragment]").firstChild;
        const text = container.textContent;
        window.pausedSyntaxWorker.dispatchEvent(new Event("messageerror"));
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        window.pauseSyntaxWindow = false;
        window.pausedSyntaxWorker = null;
        return { stats: window.codePreviewPrototype.stats(), textRetained: container.textContent === text, nodeRetained: node.isConnected };
      });
      assert.match(syntaxFailure.stats.syntaxError, /could not be decoded/);
      assert.equal(syntaxFailure.stats.cachedSyntaxRanges, 0);
      assert.equal(syntaxFailure.textRetained, true);
      assert.equal(syntaxFailure.nodeRetained, true);
      report.interactions.push({ width, mode: "viewport-syntax-failure", ...syntaxFailure });
    }
    await page.setViewportSize({ width: width === 390 ? 1543 : 390, height: 900 });
    assert.equal(
      await page.locator("[data-markdown-document]").evaluate((container) => container.scrollHeight),
      expected.resizedHeight,
      `${fixture.name}: resized layout`
    );
    await page.setViewportSize({ width, height: 900 });
    if (baselineFind) {
      const actualFind = await nativeFind("[data-markdown-document]");
      assert.equal(actualFind.found, true);
      assert.equal(actualFind.selected, "Last paragraph.");
      assert.deepEqual(actualFind, baselineFind);
      report.interactions.push({ width, mode: "whole-markdown", nativeFind: actualFind });
      if (!actualFind.visible)
        report.blockers.push({
          width,
          nativeFindReveal:
            "Headless window.find selected but did not reveal in either canonical or prototype document; actual browser Find UI unverified",
        });
    }
    if (fixture.name === "dense-code") assert.ok(actual.stats.highlightRanges > 0);
    if (fixture.name === "unknown-language") assert.equal(actual.stats.fallbacks.length, 1);
    if (fixture.name === "image") {
      const image = await page.locator("[data-markdown-document] img").evaluate(async (element) => {
        const before = element.nextElementSibling?.getBoundingClientRect().top ?? element.getBoundingClientRect().bottom;
        element.style.width = "80px";
        element.style.height = "120px";
        await new Promise(requestAnimationFrame);
        return {
          loaded: element.naturalWidth > 0,
          resized: element.getBoundingClientRect().height === 120,
          before,
          after: element.getBoundingClientRect().bottom,
        };
      });
      assert.equal(image.loaded, true);
      assert.equal(image.resized, true);
      report.interactions.push({ width, mode: "whole-markdown", image });
    }
    if (fixture.name === "mixed") {
      const readingTree = await page.locator("[data-markdown-document]").ariaSnapshot();
      assert.ok(readingTree.includes("Whole Markdown"));
      assert.ok(readingTree.includes("Offscreen footnote"));
      await page.locator("[data-markdown-document] a[data-footnote-ref]").click();
      const targetVisible = await page.locator("[data-markdown-document] li[id^='user-content-fn-']").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const viewport = document.querySelector("[data-markdown-document]").getBoundingClientRect();
        return rect.bottom > viewport.top && rect.top < viewport.bottom;
      });
      assert.equal(targetVisible, true);
      const color = await page.evaluate(() => {
        document.getElementById("prototype").style.setProperty("--sambee-syntax-keyword", "#13579b");
        return getComputedStyle(document.getElementById("prototype"), "::highlight(document-keyword)").color;
      });
      assert.equal(color, "rgb(19, 87, 155)");
    }
    await page.emulateMedia({ media: "print" });
    const print = await page
      .locator("[data-markdown-document]")
      .evaluate((container) => ({ text: container.textContent, unclipped: container.clientHeight >= container.scrollHeight }));
    assert.equal(print.text, expected.text);
    assert.equal(print.unclipped, true);
    await page.emulateMedia({ media: "screen" });
    report.interactions.push({
      width,
      fixture: fixture.name,
      mode: "whole-markdown",
      exactText: true,
      exactSelection: true,
      equalHeight: true,
      ...actual.stats,
    });
    report.measurements.push({
      width,
      fixture: fixture.name,
      virtual: "whole-markdown",
      cache: "sequential-worker",
      mountedRows: actual.stats.mountedElements,
      mountedSpans: actual.stats.mountedSpans,
      preparationMs: null,
      workerPipelineWallMs: actual.stats.workerPipelineWallMs,
      indexingMs: null,
      publicationBatches: actual.stats.batches,
      ...timing,
    });
  }
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "document-input-probe";
    document.body.prepend(input);
    window.documentInputEvents = [];
    input.addEventListener("input", () => window.documentInputEvents.push(window.codePreviewPrototype.stats().complete));
    window.pauseDocumentPublication = true;
    window.documentOutcome = window.codePreviewPrototype
      .loadDocument(`# Pending document\n\n${"Paragraph **text** with Unicode \u{1f30d}.\n\n".repeat(4_000)}`)
      .then(
        () => "complete",
        (error) => error.name
      );
  });
  await page.waitForFunction(() => {
    const stats = window.codePreviewPrototype.stats();
    return stats.batches > 0 && !stats.complete;
  });
  await page.locator("#document-input-probe").pressSequentially("responsive");
  const partial = await page.evaluate(async () => {
    const container = document.querySelector("[data-markdown-document]");
    const text = container.querySelector("h1").firstChild;
    const selection = window.getSelection();
    const range = new Range();
    range.setStart(text, 0);
    range.setEnd(text, 7);
    selection.removeAllRanges();
    selection.addRange(range);
    const before = window.codePreviewPrototype.stats().batches;
    window.resumeDocumentPublication();
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const after = window.codePreviewPrototype.stats().batches;
    const stableSelection = selection.anchorNode === text && selection.focusNode === text && selection.toString() === "Pending";
    selection.removeAllRanges();
    const obsolete = window.documentOutcome;
    window.pauseDocumentPublication = false;
    await window.codePreviewPrototype.loadDocument("# Replacement\n\nLatest document.");
    const outcome = await obsolete;
    document.getElementById("document-input-probe").remove();
    return {
      before,
      after,
      stableSelection,
      inputEvents: window.documentInputEvents,
      outcome,
      oldTextDetached: !text.isConnected,
      text: document.querySelector("[data-markdown-document]").textContent,
    };
  });
  assert.ok(partial.after > partial.before);
  assert.equal(partial.stableSelection, true);
  assert.ok(partial.inputEvents.some((complete) => !complete));
  assert.equal(partial.outcome, "AbortError");
  assert.equal(partial.oldTextDetached, true);
  assert.equal(partial.text, "Replacement\nLatest document.");
  const rapid = await page.evaluate(async () => {
    const obsolete = window.codePreviewPrototype.loadDocument("# Obsolete").then(
      () => "complete",
      (error) => error.name
    );
    await window.codePreviewPrototype.loadDocument("# Current");
    return { outcome: await obsolete, text: document.querySelector("[data-markdown-document]").textContent };
  });
  assert.equal(rapid.outcome, "AbortError");
  assert.equal(rapid.text, "Current");
  await page.evaluate(() => {
    window.hiddenDocumentOutcome = window.codePreviewPrototype.loadDocument(
      `# Hidden document\n\n${"Paragraph **text**.\n\n".repeat(4_000)}`
    );
  });
  await page.waitForFunction(() => {
    const stats = window.codePreviewPrototype.stats();
    return stats.batches > 0 && !stats.complete;
  });
  const hidden = await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    try {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await window.hiddenDocumentOutcome;
      return {
        complete: window.codePreviewPrototype.stats().complete,
        text: document.querySelector("[data-markdown-document]").textContent,
      };
    } finally {
      if (descriptor) Object.defineProperty(document, "hidden", descriptor);
      else delete document.hidden;
    }
  });
  assert.equal(hidden.complete, true);
  assert.equal(hidden.text, `Hidden document\n${Array.from({ length: 4_000 }, () => "Paragraph text.").join("\n")}`);
  report.interactions.push({ width, mode: "whole-markdown", partial, rapid, hidden: { complete: hidden.complete } });
  await page.evaluate(() => {
    window.documentOutcome = window.codePreviewPrototype.loadDocument(`# Failure probe\n\n${"Paragraph **text**.\n\n".repeat(4_000)}`).then(
      () => "complete",
      (error) => error.message
    );
  });
  await page.waitForFunction(() => {
    const stats = window.codePreviewPrototype.stats();
    return stats.batches > 0 && !stats.complete;
  });
  const failure = await page.evaluate(async () => {
    const node = document.querySelector("[data-markdown-document] h1").firstChild;
    const before = document.querySelector("[data-markdown-document]").textContent;
    const latest = window.documentWorkers.at(-1);
    latest.worker.dispatchEvent(new Event("messageerror"));
    const outcome = await window.documentOutcome;
    const stats = window.codePreviewPrototype.stats();
    return {
      outcome,
      stats,
      terminated: latest.terminated,
      retainedText: document.querySelector("[data-markdown-document]").textContent === before,
      nodeStable: node.isConnected,
    };
  });
  assert.match(failure.outcome, /could not be decoded/);
  assert.equal(failure.stats.complete, false);
  assert.match(failure.stats.error, /could not be decoded/);
  assert.equal(failure.terminated, true);
  assert.equal(failure.retainedText, true);
  assert.equal(failure.nodeStable, true);
  await runDocumentSearchProof(page, report, width);
  await page.evaluate(() => window.codePreviewPrototype.loadDocument("# Recovered\n\nReadable again."));
  const cleanup = await page.evaluate(() => {
    const node = document.querySelector("[data-markdown-document] h1").firstChild;
    window.codePreviewPrototype.shutdownDocument();
    return {
      detached: !node.isConnected,
      text: document.querySelector("[data-markdown-document]").textContent,
      workersTerminated: window.documentWorkers.every((entry) => entry.terminated),
      highlights: [...CSS.highlights.keys()].filter((name) => name.startsWith("document-")).length,
    };
  });
  assert.equal(cleanup.detached, true);
  assert.equal(cleanup.text, "");
  assert.equal(cleanup.workersTerminated, true);
  assert.equal(cleanup.highlights, 0);
  report.interactions.push({ width, mode: "whole-markdown", failure, cleanup });
  if (process.env.SAMBEE_PREVIEW_PROOF_SCALE === "1") await runDocumentScalingProof(page, report, width);
  report.resources ??= [];
  if (report.browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("HeapProfiler.enable");
      const samples = [];
      for (let cycle = 0; cycle < 6; cycle += 1) {
        await page.evaluate(async (cycle) => {
          await window.codePreviewPrototype.loadDocument(
            `# Resource cycle ${cycle}\n\n\`\`\`js\n${"let x=1;\n".repeat(1_200)}\`\`\`\n\nEnd.`
          );
          await window.codePreviewPrototype.searchDocument("let x");
          await window.codePreviewPrototype.jumpDocument(1_199);
          window.codePreviewPrototype.shutdownDocument();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        }, cycle);
        await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage");
        const dom = await cdp.send("Memory.getDOMCounters");
        const owned = await page.evaluate(() => ({
          elements: document.querySelector("[data-markdown-document]").childElementCount,
          highlights: [...CSS.highlights.keys()].filter((name) => name.startsWith("document-")).length,
          liveWorkers: window.documentWorkers.filter((entry) => !entry.terminated).length,
        }));
        assert.equal(owned.elements, 0);
        assert.equal(owned.highlights, 0);
        assert.equal(owned.liveWorkers, 0);
        samples.push({ cycle, ...heap, ...dom, owned });
      }
      report.resources.push({
        width,
        supported: true,
        scope: "Chromium main-renderer heap/DOM after explicit GC; excludes worker/process memory and is not an accepted memory ceiling",
        samples,
      });
    } finally {
      await cdp.detach();
    }
  } else
    report.resources.push({
      width,
      supported: false,
      reason: "Chromium CDP heap and DOM counters are unavailable in this browser; no zero-memory claim",
    });
  await page.evaluate(
    (source) => window.codePreviewPrototype.loadDocument(source),
    fixtures.find((fixture) => fixture.name === "mixed").source
  );
}

async function runDocumentScalingProof(page, report, width) {
  const fixtures = [
    ...[1, 4, 12].map((blocks) => ({
      name: "dense-code",
      units: blocks * 6_000,
      query: "let x",
      expected: blocks * 6_000,
      source: Array.from({ length: blocks }, (_, index) => `## Code ${index}\n\n\`\`\`js\n${"let x=1;\n".repeat(6_000)}\`\`\``).join(
        "\n\n"
      ),
    })),
    ...[1_000, 4_000, 8_000].map((paragraphs) => ({
      name: "paragraphs",
      units: paragraphs,
      query: "strong",
      expected: paragraphs,
      source: `# Paragraphs\n\n${"Text **strong** and inline `code`.\n\n".repeat(paragraphs)}`,
    })),
    ...[800, 2_400, 4_800].map((rows) => ({
      name: "table",
      units: rows,
      query: "cell",
      expected: rows,
      source: `# Table\n\n| Number | Value |\n| --- | --- |\n${Array.from({ length: rows }, (_, index) => `| ${index} | cell **${index}**<br>next |`).join("\n")}`,
    })),
  ];
  report.scaling ??= [];
  const cdp = report.browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  try {
    for (const fixture of fixtures.filter(
      (fixture) => process.env.SAMBEE_PREVIEW_PROOF_BUDGETS !== "1" || fixture.units === HOST_ENVELOPE_UNITS[fixture.name]
    ))
      for (let trial = 0; trial < 3; trial += 1) {
        try {
          const measurement = await page.evaluate(
            async ({ source, query, ordinal }) => {
              window.codePreviewPrototype.shutdownDocument();
              const start = performance.now();
              let previous = start;
              let maximumTaskServiceGapMs = 0;
              const timer = setInterval(() => {
                const now = performance.now();
                maximumTaskServiceGapMs = Math.max(maximumTaskServiceGapMs, now - previous);
                previous = now;
              }, 0);
              try {
                await window.codePreviewPrototype.loadDocument(source);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                const loadMs = performance.now() - start;
                const searchStart = performance.now();
                const result = await window.codePreviewPrototype.searchDocument(query);
                const searchMs = performance.now() - searchStart;
                const warmStart = performance.now();
                const warm = await window.codePreviewPrototype.searchDocument(query.toUpperCase());
                const warmSearchMs = performance.now() - warmStart;
                if (warm.count !== result.count) throw new Error("Warm-index query changed the exact match count");
                const jumpStart = performance.now();
                const jump = await window.codePreviewPrototype.jumpDocument(ordinal);
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                const navigationMs = performance.now() - jumpStart;
                maximumTaskServiceGapMs = Math.max(maximumTaskServiceGapMs, performance.now() - previous);
                return {
                  loadMs,
                  searchMs,
                  warmSearchMs,
                  navigationMs,
                  maximumTaskServiceGapMs,
                  exactCount: result.count,
                  pending: jump.pending,
                  ...window.codePreviewPrototype.stats(),
                };
              } finally {
                clearInterval(timer);
              }
            },
            { source: fixture.source, query: fixture.query, ordinal: fixture.expected - 1 }
          );
          assert.equal(measurement.exactCount, fixture.expected);
          assert.equal(measurement.pending, false);
          assert.equal(measurement.syntaxError, null);
          assert.ok(measurement.peakCachedSyntaxRanges <= measurement.syntaxCacheLimit);
          const heap = cdp ? await cdp.send("Runtime.getHeapUsage") : null;
          const dom = cdp ? await cdp.send("Memory.getDOMCounters") : null;
          report.scaling.push({
            width,
            fixture: fixture.name,
            units: fixture.units,
            sourceUnits: fixture.source.length,
            trial,
            workerCache: "cold",
            measurement,
            loadedRendererSnapshot: cdp ? { ...heap, ...dom } : null,
            memoryScope: "Loaded main-renderer snapshot only; not peak allocation or worker/native/process memory",
          });
        } catch (error) {
          const failure = {
            width,
            fixture: fixture.name,
            units: fixture.units,
            sourceUnits: fixture.source.length,
            trial,
            error: error instanceof Error ? error.message : String(error),
          };
          report.scaling.push(failure);
          report.blockers.push({ ...failure, scope: "Exploratory scaling failure; this size is not accepted as supported" });
        }
      }
  } finally {
    await page.evaluate(() => window.codePreviewPrototype.shutdownDocument());
    if (cdp) await cdp.detach();
  }
}

async function runDocumentSearchProof(page, report, width) {
  await page.evaluate(() =>
    window.codePreviewPrototype.loadDocument(
      `# Search target\n\nA **bold** word. Next.\n\nOther paragraph.\n\n${"Repeated needle.\n\n".repeat(1_200)}\n\`\`\`text\n${"x".repeat(2_047)}\u{1f30d} edge\n\`\`\`\n\nWord word sword\n\n${"a".repeat(128)}!`
    )
  );
  const search = await page.evaluate(async () => {
    const api = window.codePreviewPrototype;
    const container = document.querySelector("[data-markdown-document]");
    const text = container.querySelector("h1").firstChild;
    const selection = window.getSelection();
    const range = new Range();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    selection.removeAllRanges();
    selection.addRange(range);
    const cases = [];
    for (const [query, options] of [
      ["bold word", {}],
      ["bold\\s+word", { regexp: true }],
      ["Next.\nOther", {}],
      ["\u{1f30d} edge", {}],
      ["word", { wholeWord: true }],
      ["Word", { wholeWord: true, caseSensitive: true }],
      ["(?=word)", { regexp: true }],
      ["", {}],
    ]) {
      const result = await api.searchDocument(query, options);
      const highlight = CSS.highlights.get("document-search")?.values().next().value;
      cases.push({ query, count: result.count, text: highlight?.toString() ?? null, cached: result.matches.length });
    }
    const workersBefore = window.documentWorkers.length;
    const result = await api.searchDocument("needle");
    const last = await api.jumpDocument(1_199);
    const active = api.stats().activeMatch;
    const highlight = CSS.highlights.get("document-search").values().next().value;
    const rect = highlight.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    const lastVisible = rect.bottom > viewport.top && rect.top < viewport.bottom;
    const lateWindow = api.stats().search.cachedMatches;
    await api.jumpDocument(1_198);
    await api.jumpDocument(0);
    const stableSelection = selection.anchorNode === text && selection.focusNode === text && selection.toString() === "Search";
    selection.removeAllRanges();
    return {
      cases,
      count: result.count,
      windowSize: result.matches.length,
      last,
      active,
      lastVisible,
      lateWindow,
      reusedIndex: window.documentWorkers.length === workersBefore,
      stableSelection,
    };
  });
  assert.deepEqual(
    search.cases.map((result) => result.count),
    [1, 1, 1, 1, 3, 1, 4, 0]
  );
  assert.equal(search.cases[0].text, "bold word");
  assert.equal(search.cases[3].text, "\u{1f30d} edge");
  assert.equal(search.count, 1_200);
  assert.equal(search.windowSize, 64);
  assert.equal(search.last.pending, false);
  assert.equal(search.active.ordinal, 1_199);
  assert.equal(search.lastVisible, true);
  assert.ok(search.lateWindow <= 64);
  assert.equal(search.reusedIndex, true);
  assert.equal(search.stableSelection, true);
  const invalid = await page.evaluate(async () => {
    try {
      await window.codePreviewPrototype.searchDocument("[", { regexp: true });
      return null;
    } catch (error) {
      return { error: error.message, stats: window.codePreviewPrototype.stats().search };
    }
  });
  assert.match(invalid.error, /Invalid document search expression/);
  assert.equal(invalid.stats.complete, false);
  assert.equal(invalid.stats.count, null);
  const supersession = await page.evaluate(async () => {
    const obsolete = window.codePreviewPrototype.searchDocument("needle").then(
      () => "complete",
      (error) => error.name
    );
    const latest = await window.codePreviewPrototype.searchDocument("bold word");
    return { obsolete: await obsolete, count: latest.count, text: CSS.highlights.get("document-search").values().next().value.toString() };
  });
  assert.equal(supersession.obsolete, "AbortError");
  assert.equal(supersession.count, 1);
  assert.equal(supersession.text, "bold word");
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "regex-input-probe";
    document.body.prepend(input);
    window.regexInputStates = [];
    input.addEventListener("input", () => window.regexInputStates.push(window.codePreviewPrototype.stats().search.complete));
    const start = performance.now();
    window.regexOutcome = null;
    window.codePreviewPrototype.searchDocument("(a+)+$", { regexp: true }).then(
      () => {
        window.regexOutcome = { unexpected: true };
      },
      (error) => {
        window.regexOutcome = {
          error: error.message,
          elapsedMs: performance.now() - start,
          terminated: window.documentWorkers.at(-1).terminated,
        };
      }
    );
  });
  await page.locator("#regex-input-probe").pressSequentially("responsive");
  await page.waitForFunction(() => window.regexOutcome !== null);
  const deadline = await page.evaluate(async () => {
    const result = window.regexOutcome;
    const stats = window.codePreviewPrototype.stats().search;
    const inputServiced = window.regexInputStates.some((complete) => !complete);
    document.getElementById("regex-input-probe").remove();
    const recovered = await window.codePreviewPrototype.searchDocument("needle");
    return { ...result, stats, inputServiced, recoveredCount: recovered.count };
  });
  assert.match(deadline.error, /deadline; worker terminated/);
  assert.equal(deadline.terminated, true);
  assert.equal(deadline.stats.count, null);
  assert.equal(deadline.stats.complete, false);
  assert.equal(deadline.inputServiced, true);
  assert.equal(deadline.recoveredCount, 1_200);
  await page.evaluate(() => {
    window.pauseDocumentPublication = true;
    window.pendingDocumentLoad = window.codePreviewPrototype
      .loadDocument(`# Partial search\n\n${"Paragraph **text**.\n\n".repeat(1_500)}\n\nUnpublished-target.`)
      .then(
        () => "complete",
        (error) => error.name
      );
  });
  await page.waitForFunction(() => !!window.resumeDocumentPublication && window.codePreviewPrototype.stats().batches > 0);
  const pending = await page.evaluate(async () => {
    const api = window.codePreviewPrototype;
    const count = (await api.searchDocument("Unpublished-target")).count;
    const navigation = await api.jumpDocument(0);
    const before = { ...api.stats().activeMatch };
    window.pauseDocumentPublication = false;
    window.resumeDocumentPublication();
    window.resumeDocumentPublication = null;
    const outcome = await window.pendingDocumentLoad;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const range = CSS.highlights.get("document-search").values().next().value;
    const rect = range.getBoundingClientRect();
    const viewport = document.querySelector("[data-markdown-document]").getBoundingClientRect();
    return {
      count,
      navigation,
      before,
      outcome,
      after: api.stats().activeMatch,
      text: range.toString(),
      visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
    };
  });
  assert.equal(pending.count, 1);
  assert.equal(pending.navigation.pending, true);
  assert.equal(pending.before.pending, true);
  assert.equal(pending.outcome, "complete");
  assert.equal(pending.after.pending, false);
  assert.equal(pending.text, "Unpublished-target");
  assert.equal(pending.visible, true);
  const shutdown = await page.evaluate(async () => {
    const obsolete = window.codePreviewPrototype.searchDocument("Paragraph").then(
      () => "complete",
      (error) => error.name
    );
    window.codePreviewPrototype.shutdownDocument();
    return {
      outcome: await obsolete,
      highlights: [...CSS.highlights.keys()].filter((name) => name.startsWith("document-")).length,
      workersTerminated: window.documentWorkers.every((entry) => entry.terminated),
    };
  });
  assert.equal(shutdown.outcome, "AbortError");
  assert.equal(shutdown.highlights, 0);
  assert.equal(shutdown.workersTerminated, true);
  report.interactions.push({ width, mode: "whole-markdown-search", search, invalid, supersession, deadline, pending, shutdown });
}
