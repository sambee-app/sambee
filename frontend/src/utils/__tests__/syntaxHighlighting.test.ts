import { languages } from "@codemirror/language-data";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../../services/logger";
import {
  codeMirrorHighlighting,
  loadNativeLanguage,
  MAX_STATIC_BLOCK_LENGTH,
  nativeSyntaxHighlighting,
  resolveFence,
  resolveFilename,
  yieldHighlightingTask,
} from "../codeMirrorHighlighting";

describe("shared syntax highlighting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("resolves exact aliases and filenames without guessing extensions", () => {
    expect(resolveFence("JS")).toEqual(resolveFilename("example.js"));
    expect(resolveFence("py")).toEqual(resolveFilename("example.py"));
    expect(resolveFence("unknown-fence")).toEqual({ reason: "unknown-language" });
    expect(resolveFence("text")).toEqual({ reason: "plain-text" });
  });

  it.each([
    ["mssql", "ms sql"],
    ["mariadb", "mariadb sql"],
  ])("resolves %s to its registered dialect rather than generic SQL", (label, language) => {
    expect(resolveFence(label)).toEqual({ language });
    expect(resolveFence(` ${label.toUpperCase()} title=example `)).toEqual({ language });
    expect(resolveFence(`${label}-unknown`)).toEqual({ reason: "unknown-language" });
    expect(resolveFilename("example.sql")).toEqual({ language: "sql" });
  });

  it.each(["javascript", "typescript", "python", "sql", "shell"])("produces ordered application ranges for %s", async (label) => {
    const text = label === "python" ? 'def greet():\n  return "hello 🌍"' : "let x = 1; // hello 🌍\n";
    const [result] = await codeMirrorHighlighting.prepare([{ text, label }]);
    expect(result).toHaveProperty("ranges");
    if (!result || !("ranges" in result)) return;
    let previous = 0;
    for (const range of result.ranges) {
      expect(range.from).toBeGreaterThanOrEqual(previous);
      expect(range.to).toBeGreaterThan(range.from);
      expect(range.to).toBeLessThanOrEqual(text.length);
      expect(range.categories.length).toBeGreaterThan(0);
      previous = range.to;
    }
    expect(result.ranges.length).toBeGreaterThan(0);
  });

  it("settles independent fallback outcomes", async () => {
    expect(
      await codeMirrorHighlighting.prepare([
        { text: "x", label: "unknown-fence" },
        { text: "x" },
        { text: "x".repeat(MAX_STATIC_BLOCK_LENGTH + 1), label: "javascript" },
        { text: "const x=1", label: "js" },
      ])
    ).toEqual([{ reason: "unknown-language" }, { reason: "plain-text" }, { reason: "block-too-large" }, { ranges: expect.any(Array) }]);
  });

  it.each([
    ["powershell", "$sites = Get-Content $siteUrlFile;", "Get-Content", "builtin"],
    ["shell", 'echo "$HOME"', "echo", "builtin"],
    ["javascript", "const result = obj.value;", "value", "property"],
    ["json", '{"enabled": true}', '"enabled"', "property"],
    ["javascript", "const enabled = true;", "true", "boolean"],
    ["python", "enabled = True", "True", "boolean"],
    ["json", '{"value": null}', "null", "null"],
    ["python", "value = None", "None", "null"],
    ["javascript", "const pattern = /foo+/g;", "/foo+/g", "regexp"],
    ["javascript", 'const text = "a\\nb";', "\\n", "escape"],
    ["python", "@decorator\ndef greet(): pass", "@", "metadata"],
    ["c", "#include <stdio.h>", "#include", "metadata"],
  ])("preserves shared %s tags for %s", async (label, text, token, category) => {
    const fence = `\`\`\`${label}\n${text}\n\`\`\``;
    const [result, nested] = await codeMirrorHighlighting.prepare([
      { text, label },
      { text: fence, label: "markdown" },
    ]);
    if (!result || !("ranges" in result)) throw new Error("Missing syntax ranges");
    const from = text.indexOf(token);
    expect(result.ranges).toContainEqual({ from, to: from + token.length, categories: [category] });
    if (!nested || !("ranges" in nested)) throw new Error("Missing nested syntax ranges");
    const nestedFrom = fence.indexOf(text) + from;
    expect(nested.ranges).toContainEqual({ from: nestedFrom, to: nestedFrom + token.length, categories: [category] });
    const resolved = resolveFence(label);
    if (!("language" in resolved)) throw new Error("Missing test language");
    const support = await loadNativeLanguage(resolved.language);
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [support, nativeSyntaxHighlighting] }) });
    try {
      expect([...view.contentDOM.querySelectorAll(`.sambee-syntax-${category}`)].map((span) => span.textContent)).toContain(token);
      expect(view.state.doc.toString()).toBe(text);
    } finally {
      view.destroy();
    }
  });

  it("rejects cancellation without publishing partial results", async () => {
    const controller = new AbortController();
    const request = codeMirrorHighlighting.prepare([{ text: "let x=1", label: "js" }], controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("settles nested Markdown fences identically on cold and warm loads", async () => {
    const blocks = [{ text: '```python\ndef greet():\n  return "hello"\n```', label: "markdown" }];
    const cold = await codeMirrorHighlighting.prepare(blocks);
    const warm = await codeMirrorHighlighting.prepare(blocks);
    expect(cold).toEqual(warm);
    expect(cold[0]).toMatchObject({ ranges: expect.arrayContaining([expect.objectContaining({ categories: ["keyword"] })]) });
  });

  it("settles different repeated nested Markdown configurations", async () => {
    const text = "~~~~markdown\n```python\ndef first(): pass\n```\n~~~~\n\n~~~~markdown\n```javascript\nconst second=1;\n```\n~~~~";
    const [result] = await codeMirrorHighlighting.prepare([{ text, label: "markdown" }]);
    expect(result).toHaveProperty("ranges");
    if (!result || !("ranges" in result)) return;
    const keywords = result.ranges.filter((range) => range.categories.includes("keyword")).map((range) => text.slice(range.from, range.to));
    expect(keywords).toContain("def");
    expect(keywords).toContain("const");
  });

  it.each([true, false])("isolates a nested grammar loading failure with failed fence first: %s", async (failedFirst) => {
    const description = languages.find((language) => language.name === "Python")!;
    const support = await description.load();
    const load = vi.spyOn(description, "load").mockRejectedValue(new Error("Grammar unavailable"));
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failedCode = "PRIVATE_SOURCE";
    const failedFence = `\`\`\`python\n${failedCode}\n\`\`\``;
    const successfulFence = "```javascript\nconst sibling = 1;\n```";
    const fences = failedFirst ? [failedFence, successfulFence] : [successfulFence, failedFence];
    const text = `# Heading\n\n${fences.join("\n\n")}`;
    const results = await codeMirrorHighlighting.prepare([
      { text, label: "markdown" },
      { text: "const independent = 1;", label: "js" },
    ]);
    const result = results[0];
    if (!result || !("ranges" in result)) throw new Error("Missing enclosing Markdown ranges");
    expect(result.ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categories: ["heading"] }),
        expect.objectContaining({ from: text.indexOf("const sibling"), categories: ["keyword"] }),
      ])
    );
    const failedFrom = text.indexOf(failedCode);
    expect(result.ranges.some((range) => range.from < failedFrom + failedCode.length && range.to > failedFrom)).toBe(false);
    expect(results[1]).toHaveProperty("ranges");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toEqual({ language: "python", operation: "load" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(failedCode);
    load.mockResolvedValue(support);
    const [recovered] = await codeMirrorHighlighting.prepare([{ text: "```python\ndef recovered(): pass\n```", label: "markdown" }]);
    expect(recovered).toMatchObject({ ranges: expect.arrayContaining([expect.objectContaining({ categories: ["keyword"] })]) });
  });

  it("preserves cancellation when a nested grammar rejects after abort", async () => {
    const description = languages.find((language) => language.name === "Python")!;
    const support = await description.load();
    let rejectLoad!: (error: Error) => void;
    const pendingLoad = new Promise<typeof support>((_resolve, reject) => {
      rejectLoad = reject;
    });
    const load = vi.spyOn(description, "load").mockReturnValue(pendingLoad);
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const request = codeMirrorHighlighting.prepare([{ text: "```python\ndef pending(): pass\n```", label: "markdown" }], controller.signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    rejectLoad(new Error("Late grammar failure"));
    await Promise.resolve();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    { failedFirst: true, phase: "start" },
    { failedFirst: false, phase: "start" },
    { failedFirst: true, phase: "advance" },
    { failedFirst: false, phase: "advance" },
  ])("isolates a nested grammar parsing failure ($phase, failed first: $failedFirst)", async ({ failedFirst, phase }) => {
    const description = languages.find((language) => language.name === "Python")!;
    const support = await description.load();
    const startParse = support.language.parser.startParse.bind(support.language.parser);
    const parse = vi.spyOn(support.language.parser, "startParse").mockImplementation((...args) => {
      if (phase === "start") throw new Error("Parser unavailable");
      const partial = startParse(...args);
      vi.spyOn(partial, "advance").mockImplementation(() => {
        throw new Error("Parser advance failed");
      });
      return partial;
    });
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failedCode = "PRIVATE_SOURCE";
    const failedFence = `\`\`\`python\n${failedCode}\n\`\`\``;
    const successfulFence = "```javascript\nconst sibling = 1;\n```";
    const fences = failedFirst ? [failedFence, successfulFence] : [successfulFence, failedFence];
    const text = `# Heading\n\n${fences.join("\n\n")}`;
    const [result, independent] = await codeMirrorHighlighting.prepare([
      { text, label: "markdown" },
      { text: "const independent = 1;", label: "js" },
    ]);
    if (!result || !("ranges" in result)) throw new Error("Missing enclosing Markdown ranges");
    expect(result.ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categories: ["heading"] }),
        expect.objectContaining({ from: text.indexOf("const sibling"), categories: ["keyword"] }),
      ])
    );
    const failedFrom = text.indexOf(failedCode);
    expect(result.ranges.some((range) => range.from < failedFrom + failedCode.length && range.to > failedFrom)).toBe(false);
    expect(independent).toHaveProperty("ranges");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toEqual({ language: "python", operation: "parse" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(failedCode);
    parse.mockRestore();
    const [recovered] = await codeMirrorHighlighting.prepare([{ text: "```python\ndef recovered(): pass\n```", label: "markdown" }]);
    expect(recovered).toMatchObject({ ranges: expect.arrayContaining([expect.objectContaining({ categories: ["keyword"] })]) });
  });

  it("does not poison later fences using the same grammar after one parse fails", async () => {
    const description = languages.find((language) => language.name === "Python")!;
    const support = await description.load();
    vi.spyOn(support.language.parser, "startParse").mockImplementationOnce(() => {
      throw new Error("First fence failed");
    });
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const text = "# Heading\n\n```python\nPRIVATE_SOURCE\n```\n\n```python\ndef sibling(): pass\n```";
    const [result] = await codeMirrorHighlighting.prepare([{ text, label: "markdown" }]);
    if (!result || !("ranges" in result)) throw new Error("Missing enclosing Markdown ranges");
    expect(result.ranges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categories: ["heading"] }),
        expect.objectContaining({ from: text.indexOf("def sibling"), categories: ["keyword"] }),
      ])
    );
  });

  it("does not turn cancellation during a nested parse into plain-text success", async () => {
    const description = languages.find((language) => language.name === "Python")!;
    const support = await description.load();
    const controller = new AbortController();
    vi.spyOn(support.language.parser, "startParse").mockImplementation(() => {
      controller.abort();
      throw new Error("Parser interrupted");
    });
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    await expect(
      codeMirrorHighlighting.prepare([{ text: "```python\ndef pending(): pass\n```", label: "markdown" }], controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(log).not.toHaveBeenCalled();
  });

  it("scopes Markdown structure to markers and leaves unknown code and prose neutral", async () => {
    const text =
      '# Heading\n\nPlain paragraph\n\n*emphasis* **strong** ~~strike~~\n\n- item\n\n> quote\n\n[link](https://example.com) ![alt](image.png)\n\n`inline`\n\n---\n\n```js\nconst x="code";\n```\n\n```unknown\n*not prose*\n```';
    const [result] = await codeMirrorHighlighting.prepare([{ text, label: "markdown" }]);
    if (!result || !("ranges" in result)) throw new Error("Missing Markdown ranges");
    const tokens = result.ranges.map((range) => ({ text: text.slice(range.from, range.to), categories: range.categories }));
    for (const [value, category] of [
      [" Heading", "heading"],
      ["emphasis", "emphasis"],
      ["strong", "strong"],
      ["strike", "strikethrough"],
      ["-", "structure"],
      [">", "structure"],
      ["link", "link"],
      ["inline", "inlineCode"],
      ["---", "structure"],
      ["js", "structure"],
      ["const", "keyword"],
      ['"code"', "string"],
    ]) {
      expect(tokens).toContainEqual({ text: value, categories: expect.arrayContaining([category]) });
    }
    for (const neutral of ["Plain paragraph", " item", " quote", "*not prose*"]) {
      const from = text.indexOf(neutral);
      expect(result.ranges.some((range) => range.from < from + neutral.length && range.to > from)).toBe(false);
    }
  });

  it("counts Markdown levels independently of embedded code", async () => {
    const nest = (text: string, length: number) => `${"`".repeat(length)}markdown\n${text}\n${"`".repeat(length)}`;
    const base = "```javascript\nconst x=1;\n```";
    const atLimit = nest(nest(nest(base, 4), 5), 6);
    const aboveLimit = nest(atLimit, 7);
    const results = await codeMirrorHighlighting.prepare([
      { text: atLimit, label: "markdown" },
      { text: aboveLimit, label: "markdown" },
    ]);
    expect(results[0]).toHaveProperty("ranges");
    expect(results[1]).toEqual({ reason: "nesting-depth" });
  });

  it.each([
    ["javascript", "function greet(x) { return x + 1; } // end"],
    ["typescript", "const greet = (x: string): string => x;"],
    ["python", 'def greet(x):\n  return "hello" # end'],
    ["sql", "SELECT count(*) FROM users WHERE id = 1;"],
    ["mssql", "SELECT TOP 1 [account] FROM [users] WHERE [id] = @id; -- end"],
    ["mariadb", "SELECT `account` FROM `users` LIMIT 1; # end"],
    ["shell", 'echo "hello" # end'],
    ["powershell", "$sites = Get-Content $siteUrlFile;"],
    ["javascript", 'obj.value = [true, null, /foo+/g, "a\\nb"];'],
    ["json", '{"enabled": true, "value": null}'],
    ["c", "#include <stdio.h>"],
  ])("emits the same native and static classes for %s", async (label, text) => {
    const resolved = resolveFence(label);
    if (!("language" in resolved)) throw new Error("Missing test language");
    const support = await loadNativeLanguage(resolved.language);
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions: [support, nativeSyntaxHighlighting] }) });
    try {
      const [result] = await codeMirrorHighlighting.prepare([{ text, label }]);
      if (!result || !("ranges" in result)) throw new Error("Missing token ranges");
      const nativeTokens = Array.from(view.contentDOM.querySelectorAll("span[class*='sambee-syntax-']"), (span) => ({
        text: span.textContent,
        classes: span.className,
      }));
      const staticTokens = result.ranges.map((range) => ({
        text: text.slice(range.from, range.to),
        classes: range.categories.map((category) => `sambee-syntax-${category}`).join(" "),
      }));
      expect(nativeTokens).toEqual(staticTokens);
    } finally {
      view.destroy();
    }
  });

  it("yields a browser task for every block even with warm grammars and no aggregate cutoff", async () => {
    const taskYield = vi.fn(async () => {});
    vi.stubGlobal("scheduler", { yield: taskYield });
    const text = `//${"x".repeat(900)}`;
    const blocks = Array.from({ length: 600 }, () => ({ text, label: "js" }));
    expect(blocks.reduce((sum, block) => sum + block.text.length, 0)).toBeGreaterThan(500_000);
    const results = await codeMirrorHighlighting.prepare(blocks);
    expect(results).toHaveLength(600);
    expect(results.every((result) => "ranges" in result)).toBe(true);
    expect(taskYield).toHaveBeenCalledTimes(600);
  });

  it("uses timer tasks when scheduler.yield is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("scheduler", undefined);
    let finished = false;
    const task = yieldHighlightingTask().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    await vi.runAllTimersAsync();
    await task;
    expect(finished).toBe(true);
  });

  it("aborts a shared grammar wait promptly while a new request can reuse it", async () => {
    vi.stubGlobal("scheduler", { yield: async () => {} });
    const description = languages.find((language) => language.name === "JavaScript")!;
    const support = await description.load();
    let finish!: (value: typeof support) => void;
    const sharedLoad = new Promise<typeof support>((resolve) => {
      finish = resolve;
    });
    const load = vi.spyOn(description, "load").mockReturnValue(sharedLoad);
    const controller = new AbortController();
    const obsolete = codeMirrorHighlighting.prepare([{ text: "let x=1", label: "js" }], controller.signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    const current = codeMirrorHighlighting.prepare([{ text: "let x=2", label: "js" }]);
    finish(support);
    expect((await current)[0]).toHaveProperty("ranges");
  });

  it("does not start guarded grammar work and tests the exact size boundary", async () => {
    vi.stubGlobal("scheduler", { yield: async () => {} });
    const description = languages.find((language) => language.name === "JavaScript")!;
    const load = vi.spyOn(description, "load");
    expect(await codeMirrorHighlighting.prepare([{ text: " ".repeat(MAX_STATIC_BLOCK_LENGTH + 1), label: "js" }])).toEqual([
      { reason: "block-too-large" },
    ]);
    expect(load).not.toHaveBeenCalled();
    const results = await codeMirrorHighlighting.prepare(
      [MAX_STATIC_BLOCK_LENGTH - 1, MAX_STATIC_BLOCK_LENGTH].map((length) => ({ text: `//${"x".repeat(length - 2)}`, label: "js" }))
    );
    expect(results.every((result) => "ranges" in result)).toBe(true);
  });

  it("settles loading failures independently and logs context without source text", async () => {
    const description = languages.find((language) => language.name === "JavaScript")!;
    vi.spyOn(description, "load").mockRejectedValueOnce(new Error("Grammar unavailable"));
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    const results = await codeMirrorHighlighting.prepare([
      { text: "PRIVATE_SOURCE", label: "js" },
      { text: "def greet(): pass", label: "py" },
    ]);
    expect(results[0]).toEqual({ reason: "loading-failure" });
    expect(results[1]).toHaveProperty("ranges");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toEqual({ language: "javascript", operation: "load" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_SOURCE");
  });
});
