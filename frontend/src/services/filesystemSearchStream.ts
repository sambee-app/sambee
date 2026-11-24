import contract from "../../../shared/filesystem-search/contract.json";
import { type FileInfo, FileType } from "../types";
import type {
  FilesystemSearchClientError,
  FilesystemSearchItem,
  FilesystemSearchRecord,
  FilesystemSearchSkipReason,
} from "./filesystemSearchContract";

type SearchTerminal = Extract<FilesystemSearchRecord, { type: "terminal" }>;

/** The message is for logs. The UI shows the translated text for `code`. */
export class SearchStreamError extends Error {
  constructor(
    readonly code: FilesystemSearchClientError,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SearchStreamError";
  }
}

const INVALID_DATA_MESSAGE = "Search returned invalid data. Check the source connection and start a new search.";

function invalidStream(): never {
  throw new SearchStreamError("invalid_data", INVALID_DATA_MESSAGE);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonnegativeInteger(value) && value > 0;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return invalidStream();
  return value;
}

function parseEntry(value: unknown): FileInfo {
  if (
    !isObject(value) ||
    typeof value["name"] !== "string" ||
    typeof value["path"] !== "string" ||
    (value["type"] !== FileType.FILE && value["type"] !== FileType.DIRECTORY) ||
    typeof value["is_readable"] !== "boolean" ||
    typeof value["is_hidden"] !== "boolean"
  ) {
    return invalidStream();
  }
  const size = value["size"];
  if (size !== undefined && size !== null && !nonnegativeInteger(size)) return invalidStream();
  const state = value["archive_entry_state"];
  if (state !== undefined && state !== null && state !== "readable" && state !== "blocked" && state !== "unavailable") {
    return invalidStream();
  }
  return {
    name: value["name"],
    path: value["path"],
    type: value["type"],
    is_readable: value["is_readable"],
    is_hidden: value["is_hidden"],
    size: size == null ? undefined : size,
    mime_type: optionalString(value["mime_type"]),
    created_at: optionalString(value["created_at"]),
    modified_at: optionalString(value["modified_at"]),
    archive_entry_state: state == null ? undefined : state,
  };
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    value.split("/").every((component) => component !== "" && component !== "." && component !== "..")
  );
}

function parseItem(value: unknown): FilesystemSearchItem {
  if (!isObject(value) || !isObject(value["target"])) return invalidStream();
  const entry = parseEntry(value["entry"]);
  const target = value["target"];
  if (target["kind"] === "physical" && validPath(target["path"])) {
    if (value["archive_state"] != null || entry.path !== target["path"] || entry.name !== target["path"].split("/").at(-1)) {
      return invalidStream();
    }
    return { entry, target: { kind: "physical", path: target["path"] } };
  }
  if (target["kind"] === "archive" && validPath(target["archive_path"]) && validPath(target["member_path"])) {
    const state = value["archive_state"];
    if (
      (state !== "readable" && state !== "blocked" && state !== "unavailable") ||
      entry.is_readable !== (state === "readable") ||
      entry.path !== target["member_path"] ||
      entry.name !== target["member_path"].split("/").at(-1)
    ) {
      return invalidStream();
    }
    return {
      entry: { ...entry, archive_entry_state: state },
      target: { kind: "archive", archive_path: target["archive_path"], member_path: target["member_path"] },
      archive_state: state,
    };
  }
  return invalidStream();
}

function skipReason(value: unknown): value is FilesystemSearchSkipReason {
  return (
    value === "unreadable_directory" ||
    value === "unsafe_name" ||
    value === "archive_too_large" ||
    value === "archive_unreadable" ||
    value === "queue_limit"
  );
}

function parseRecord(value: unknown): FilesystemSearchRecord {
  if (!isObject(value)) return invalidStream();
  if (value["type"] === "start") {
    const limits = value["limits"];
    if (
      value["version"] !== 1 ||
      typeof value["request_id"] !== "string" ||
      value["request_id"].length === 0 ||
      !isObject(limits) ||
      !positiveInteger(limits["max_seconds"]) ||
      !positiveInteger(limits["max_results"])
    ) {
      return invalidStream();
    }
    return {
      type: "start",
      version: 1,
      request_id: value["request_id"],
      limits: { max_seconds: limits["max_seconds"], max_results: limits["max_results"] },
    };
  }
  if (value["type"] === "batch") {
    const results = value["results"];
    if (!Array.isArray(results) || results.length > contract.limits.result_batch_items) return invalidStream();
    return { type: "batch", results: results.map(parseItem) };
  }
  if (value["type"] === "terminal") {
    const reason = value["reason"];
    const counts = value["counts"];
    const skips = value["skips"];
    if (
      (reason !== "complete" &&
        reason !== "partial_coverage" &&
        reason !== "time_limit" &&
        reason !== "result_limit" &&
        reason !== "source_failure") ||
      !isObject(counts) ||
      !nonnegativeInteger(counts["matches"]) ||
      !nonnegativeInteger(counts["scanned_directories"]) ||
      !nonnegativeInteger(counts["skipped"]) ||
      !Array.isArray(skips) ||
      skips.length > contract.limits.skip_reason_types
    ) {
      return invalidStream();
    }
    return {
      type: "terminal",
      reason,
      counts: { matches: counts["matches"], scanned_directories: counts["scanned_directories"], skipped: counts["skipped"] },
      skips: skips.map((skip: unknown) => {
        if (!isObject(skip) || !skipReason(skip["reason"]) || !positiveInteger(skip["count"])) return invalidStream();
        return { reason: skip["reason"], count: skip["count"] };
      }),
    };
  }
  return invalidStream();
}

/**
 * Consume one NDJSON response. A missing terminal record is an interruption,
 * not a successful empty search.
 */
export async function consumeFilesystemSearchStream(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: FilesystemSearchRecord) => void | Promise<void>
): Promise<SearchTerminal> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = new Uint8Array(0);
  let recordBytes = 0;
  let started = false;
  let terminal: SearchTerminal | undefined;
  let maximumResults = 0;
  let receivedResults = 0;

  const append = (fragment: Uint8Array) => {
    const nextSize = recordBytes + fragment.byteLength;
    if (nextSize > contract.limits.stream_record_bytes) {
      throw new SearchStreamError("response_too_large", "A search response is too large. Check the source and start a new search.");
    }
    if (nextSize > buffer.byteLength) {
      const enlarged = new Uint8Array(Math.min(contract.limits.stream_record_bytes, Math.max(buffer.byteLength * 2, nextSize)));
      enlarged.set(buffer.subarray(0, recordBytes));
      buffer = enlarged;
    }
    buffer.set(fragment, recordBytes);
    recordBytes = nextSize;
  };

  const publish = async () => {
    if (recordBytes === 0) return invalidStream();
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(buffer.subarray(0, recordBytes)));
    } catch (error) {
      throw new SearchStreamError("invalid_data", INVALID_DATA_MESSAGE, { cause: error });
    }
    recordBytes = 0;
    const record = parseRecord(value);
    if (terminal || (record.type === "start") === started) return invalidStream();
    if (record.type === "start") {
      started = true;
      maximumResults = record.limits.max_results;
    } else if (record.type === "batch") {
      receivedResults += record.results.length;
      if (receivedResults > maximumResults) return invalidStream();
    } else {
      if (record.counts.matches !== receivedResults) return invalidStream();
      terminal = record;
    }
    await onRecord(record);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let position = 0; position < value.length; position += 1) {
        if (value[position] !== 10) continue;
        append(value.subarray(start, position));
        await publish();
        start = position + 1;
      }
      append(value.subarray(start));
    }
    if (recordBytes > 0) await publish();
    if (!terminal) {
      throw new SearchStreamError("incomplete", "Search was interrupted before it finished. Start a new search to try again.");
    }
    return terminal;
  } catch (error) {
    // An errored stream rejects cancel() with its stored error. Report the original failure.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
