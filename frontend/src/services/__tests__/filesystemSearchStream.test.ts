import { describe, expect, it, vi } from "vitest";
import contract from "../../../../shared/filesystem-search/contract.json";
import fixtures from "../../../../shared/filesystem-search/stream-fixtures.json";
import { consumeFilesystemSearchStream } from "../filesystemSearchStream";

const encoder = new TextEncoder();

function streamOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

describe("file-system search stream", () => {
  it("publishes shared records incrementally, including split UTF-8 characters", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const received = vi.fn();
    const result = consumeFilesystemSearchStream(stream, received);
    if (!controller) throw new Error("Missing test stream controller");
    controller.enqueue(line(fixtures.stream[0]));
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));

    const batch = encoder.encode(`${JSON.stringify(fixtures.stream[1]).replaceAll("report.pdf", "résumé.pdf")}\n`);
    const split = batch.indexOf(0xc3) + 1;
    expect(split).toBeGreaterThan(1);
    controller.enqueue(batch.subarray(0, split));
    controller.enqueue(batch.subarray(split));
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(2));
    expect(received.mock.calls[1]?.[0]).toMatchObject({
      type: "batch",
      results: [{ entry: { name: "résumé.pdf" } }, { entry: { is_readable: false, archive_entry_state: "blocked" } }],
    });

    controller.enqueue(line(fixtures.stream[2]));
    controller.close();
    await expect(result).resolves.toMatchObject({ type: "terminal", reason: "partial_coverage", counts: { matches: 2 } });
    expect(received).toHaveBeenCalledTimes(3);
  });

  it("keeps delivered results and reports a disconnect without a terminal record", async () => {
    const received = vi.fn();
    const result = consumeFilesystemSearchStream(streamOf(line(fixtures.stream[0]), line(fixtures.stream[1])), received);
    await expect(result).rejects.toMatchObject({ code: "incomplete" });
    expect(received).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["batch before start", [fixtures.stream[1]]],
    ["duplicate start", [fixtures.stream[0], fixtures.stream[0]]],
    ["record after terminal", [...fixtures.stream, fixtures.stream[1]]],
    [
      "invalid terminal count",
      [fixtures.stream[0], { type: "terminal", reason: "complete", counts: { matches: 1, scanned_directories: 0, skipped: 0 }, skips: [] }],
    ],
    [
      "invalid target",
      [
        fixtures.stream[0],
        {
          type: "batch",
          results: [
            {
              entry: { name: "x", path: "x", type: "file", is_hidden: false, is_readable: true },
              target: { kind: "physical", path: "../outside" },
            },
          ],
        },
      ],
    ],
    [
      "mismatched target and metadata",
      [
        fixtures.stream[0],
        {
          type: "batch",
          results: [
            {
              entry: { name: "x", path: "x", type: "file", is_hidden: false, is_readable: true },
              target: { kind: "physical", path: "other" },
            },
          ],
        },
      ],
    ],
  ])("rejects %s", async (_description, records) => {
    await expect(consumeFilesystemSearchStream(streamOf(...records.map(line)), vi.fn())).rejects.toThrow("invalid data");
  });

  it("rejects an oversized record before the stream ends", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(contract.limits.stream_record_bytes + 1).fill(65));
      },
      cancel,
    });
    await expect(consumeFilesystemSearchStream(stream, vi.fn())).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports the original error when the response stream fails", async () => {
    const networkError = new TypeError("network error");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line(fixtures.stream[0]));
        controller.error(networkError);
      },
    });
    await expect(consumeFilesystemSearchStream(stream, vi.fn())).rejects.toBe(networkError);
  });

  it("closes the response when a consumer fails", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(line(fixtures.stream[0]));
      },
      cancel,
    });
    await expect(
      consumeFilesystemSearchStream(stream, () => {
        throw new Error("Consumer stopped");
      })
    ).rejects.toThrow("Consumer stopped");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
