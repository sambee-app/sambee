import { createStaticHighlighter, MAX_STATIC_BLOCK_LENGTH } from "./codeMirrorHighlightingCore";
import {
  SYNTAX_RESULT_PAGE_RANGES,
  SYNTAX_SOURCE_CHUNK_UNITS,
  type SyntaxWorkerRequest,
  type SyntaxWorkerResponse,
} from "./markdownSyntaxWorkerProtocol";

function send(message: SyntaxWorkerResponse): void {
  postMessage(message);
}

const highlighter = createStaticHighlighter((message, context, component, failure) => {
  send({ type: "diagnostic", message, context, component, error: failure?.message });
});
let parts: string[] = [];
let length = 0;
let block = 0;
let busy = false;
let acknowledge: (() => void) | null = null;

async function receive(message: SyntaxWorkerRequest): Promise<void> {
  if (message.type === "ack") {
    const resolve = acknowledge;
    acknowledge = null;
    if (!resolve) throw new Error("Unexpected syntax result acknowledgement");
    resolve();
    return;
  }
  if (busy || message.block !== block || message.text.length > SYNTAX_SOURCE_CHUNK_UNITS) {
    throw new Error("Invalid syntax source sequence or chunk size");
  }
  parts.push(message.text);
  length += message.text.length;
  if (length > MAX_STATIC_BLOCK_LENGTH) throw new Error("Syntax source exceeded the parser block limit");
  if (!message.final) {
    send({ type: "source-ack" });
    return;
  }
  busy = true;
  const text = parts.join("");
  parts = [];
  length = 0;
  const [result] = await highlighter.prepare([{ text, label: message.label }]);
  if (!result) throw new Error("Syntax preparation returned no result");
  if ("ranges" in result) {
    for (let offset = 0; offset < result.ranges.length; offset += SYNTAX_RESULT_PAGE_RANGES) {
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
        send({ type: "ranges", block, ranges: result.ranges.slice(offset, offset + SYNTAX_RESULT_PAGE_RANGES) });
      });
    }
  }
  const completed = block++;
  busy = false;
  send({ type: "complete", block: completed, reason: "reason" in result ? result.reason : undefined });
}

globalThis.onmessage = (event: MessageEvent<SyntaxWorkerRequest>) => {
  void receive(event.data).catch((error: unknown) => {
    send({ type: "error", message: error instanceof Error ? error.message : "Syntax worker preparation failed" });
  });
};
