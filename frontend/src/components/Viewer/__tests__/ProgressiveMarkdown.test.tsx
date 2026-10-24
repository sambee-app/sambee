import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it, vi } from "vitest";
import { rehypeMarkdownHeadingLinks } from "../../../utils/markdownHeadingLinks";
import {
  PROGRESSIVE_MARKDOWN_FRAME_BATCHES,
  PROGRESSIVE_MARKDOWN_FRAME_MS,
  PROGRESSIVE_MARKDOWN_MIN_UNITS,
  ProgressiveMarkdown,
} from "../ProgressiveMarkdown";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe("progressive rendered Markdown", () => {
  it("keeps ordinary documents immediate", () => {
    const ready = vi.fn();
    const result = render(
      <ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>
        # Small
      </ProgressiveMarkdown>
    );
    expect(result.container.querySelector("h1")?.textContent).toBe("Small");
    expect(result.container.querySelector("[aria-busy]")).toBeNull();
    expect(ready).toHaveBeenCalledOnce();
  });

  it("appends a whole-document transform without replacing earlier nodes", async () => {
    const ready = vi.fn();
    const failed = vi.fn();
    const transformed = vi.fn();
    const observeTransform = () => transformed;
    const source = `# Repeat\n\n[Reference][last]\n\n${"A formatted **paragraph**.\n\n".repeat(2_000)}# Repeat\n\n[last]: https://example.com\n`;
    expect(source.length).toBeGreaterThan(PROGRESSIVE_MARKDOWN_MIN_UNITS);
    const result = render(
      <ProgressiveMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeMarkdownHeadingLinks, observeTransform]}
        onReady={ready}
        onFailure={failed}
      >
        {source}
      </ProgressiveMarkdown>
    );
    const heading = result.container.querySelector("h1");
    expect(heading?.id).toBe("sambee-markdown-repeat");
    expect(result.container.querySelector("a")?.href).toBe("https://example.com/");
    expect(result.container.querySelectorAll("p").length).toBeLessThan(2_001);
    await waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(result.container.querySelector("h1")).toBe(heading);
    expect(result.container.querySelectorAll("p")).toHaveLength(2_001);
    expect(result.container.querySelectorAll("h1")[1]?.id).toBe("sambee-markdown-repeat-1");
    expect(failed).not.toHaveBeenCalled();
    expect(transformed).toHaveBeenCalledOnce();
  });

  it("yields at the initial viewport fill then uses the time budget below it", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ready = vi.fn();
    let now: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const result = render(
        <ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>
          {"paragraph\n\n".repeat(5_000)}
        </ProgressiveMarkdown>
      );
      const count = () => result.container.querySelectorAll("p").length;
      const initialCount = count();
      let frameStartCount = initialCount;
      const bounds = vi.fn(() => ({ height: (count() - initialCount) * window.innerHeight }));
      Object.defineProperty(result.container.firstElementChild, "getBoundingClientRect", { value: bounds });
      now = vi
        .spyOn(performance, "now")
        .mockImplementation(() => ((count() - frameStartCount) / initialCount) * (PROGRESSIVE_MARKDOWN_FRAME_MS / 2));
      await act(async () => frames.shift()!(0));
      const firstAppend = count() - initialCount;
      expect(firstAppend).toBeGreaterThan(0);
      expect(ready).not.toHaveBeenCalled();
      const filledCount = count();
      frameStartCount = filledCount;
      await act(async () => frames.shift()!(0));
      expect(count() - filledCount).toBeGreaterThan(firstAppend);
      expect(count()).toBeLessThan(5_000);
      expect(bounds).toHaveBeenCalledTimes(2);
      expect(ready).not.toHaveBeenCalled();
      const boundedCount = count();
      now.mockReturnValue(0);
      await act(async () => frames.shift()!(0));
      expect(count() - boundedCount).toBe(firstAppend * PROGRESSIVE_MARKDOWN_FRAME_BATCHES);
      expect(count()).toBeLessThan(5_000);
      expect(ready).not.toHaveBeenCalled();
      result.unmount();
    } finally {
      now?.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("delays feedback and cancels an obsolete source generation", async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ready = vi.fn();
    try {
      const result = render(
        <ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>
          {"a paragraph\n\n".repeat(5_000)}
        </ProgressiveMarkdown>
      );
      expect(result.queryByRole("status")).toBeNull();
      act(() => vi.advanceTimersByTime(199));
      expect(result.queryByRole("status")).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(result.getByRole("status").getAttribute("aria-label")).toBe("app.loading");
      result.rerender(
        <ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>
          # New source
        </ProgressiveMarkdown>
      );
      await act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
      expect(result.container.textContent).toBe("New source");
      expect(ready).toHaveBeenCalledOnce();
      expect(result.queryByRole("status")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("subdivides one large code block and cancels on unmount", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ready = vi.fn();
    const code = "a line of code\n".repeat(5_000);
    try {
      const result = render(<ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>{`\`\`\`txt\n${code}\`\`\``}</ProgressiveMarkdown>);
      expect(result.container.querySelectorAll("pre")).toHaveLength(1);
      expect(result.container.querySelector("code")?.textContent?.length).toBeLessThan(code.length);
      result.unmount();
      await act(async () => {
        for (const callback of callbacks.splice(0)) callback(0);
      });
      expect(ready).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("finishes in a hidden tab without waiting for animation frames", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const frame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", frame);
    const ready = vi.fn();
    try {
      const result = render(
        <ProgressiveMarkdown onReady={ready} onFailure={vi.fn()}>
          {"hidden paragraph\n\n".repeat(4_000)}
        </ProgressiveMarkdown>
      );
      await waitFor(() => expect(ready).toHaveBeenCalledOnce());
      expect(result.container.querySelectorAll("p")).toHaveLength(4_000);
      expect(frame).not.toHaveBeenCalled();
      result.unmount();
    } finally {
      hidden.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("restarts safely when the same source receives a new rendering configuration", async () => {
    const source = "a **formatted** paragraph\n\n".repeat(2_000);
    const pending = vi.fn();
    const ready = vi.fn();
    const failed = vi.fn();
    const result = render(
      <ProgressiveMarkdown remarkPlugins={[remarkGfm]} onPending={pending} onReady={ready} onFailure={failed}>
        {source}
      </ProgressiveMarkdown>
    );
    await waitFor(() => expect(ready).toHaveBeenCalledOnce());
    result.rerender(
      <ProgressiveMarkdown remarkPlugins={[remarkGfm]} onPending={pending} onReady={ready} onFailure={failed}>
        {source}
      </ProgressiveMarkdown>
    );
    expect(result.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(result.container.querySelectorAll("p").length).toBeLessThan(2_000);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
    expect(pending).toHaveBeenCalledTimes(2);
    expect(result.container.querySelectorAll("p")).toHaveLength(2_000);
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a failed append without scheduling success afterward", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const ready = vi.fn();
    const failed = vi.fn();
    const failure = new Error("Unable to read publication bounds");
    try {
      const result = render(
        <ProgressiveMarkdown onReady={ready} onFailure={failed}>
          {"paragraph\n\n".repeat(5_000)}
        </ProgressiveMarkdown>
      );
      Object.defineProperty(result.container.firstElementChild, "getBoundingClientRect", {
        value: () => {
          throw failure;
        },
      });
      await act(async () => {
        for (const callback of frames.splice(0)) callback(0);
      });
      expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(ready).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
      result.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves a single large native table and complete code text under Strict Mode", async () => {
    const rows = Array.from({ length: 2_400 }, (_, index) => `| ${index} | **row ${index}** |`).join("\n");
    const code = `${"x".repeat(8_191)}\u{1f600}${"next\n".repeat(10_000)}`;
    const source = `| Key | Value |\n| --- | --- |\n${rows}\n\n\`\`\`txt\n${code}\`\`\`\n\n<script>unsafe()</script>`;
    const ready = vi.fn();
    const failed = vi.fn();
    const result = render(
      <StrictMode>
        <ProgressiveMarkdown remarkPlugins={[remarkGfm]} onReady={ready} onFailure={failed}>
          {source}
        </ProgressiveMarkdown>
      </StrictMode>
    );
    expect(result.container.querySelectorAll("tbody tr").length).toBeLessThan(2_400);
    await waitFor(() => expect(ready).toHaveBeenCalledOnce(), { timeout: 10_000 });
    const expected = render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>);
    expect(result.container.querySelectorAll("table")).toHaveLength(1);
    expect(result.container.querySelectorAll("tbody tr")).toHaveLength(2_400);
    expect(result.container.querySelectorAll("pre")).toHaveLength(1);
    expect(result.container.querySelector("code")?.textContent).toBe(code);
    expect(result.container.querySelector("script")).toBeNull();
    expect(result.container.textContent).toBe(expected.container.textContent);
    expect(failed).not.toHaveBeenCalled();
  }, 15_000);
});
