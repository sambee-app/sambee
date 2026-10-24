import type { SyntaxRange } from "./syntaxHighlighting";

export const CODE_PREVIEW_FRAGMENT_MAX_UNITS = 2_048;
export const CODE_PREVIEW_FRAGMENT_MAX_LINES = 16;
export const CODE_PREVIEW_SCAN_MAX_UNITS = 16_384;
export const CODE_PREVIEW_STEP_MAX_OPERATIONS = 512;

export interface CodePreviewFragment {
  from: number;
  to: number;
  firstRange: number;
  rangeEnd: number;
  oversizedLine: boolean;
}

export interface CodePreviewModel {
  text: string;
  ranges: readonly SyntaxRange[];
  fragments: readonly CodePreviewFragment[];
}

/** Code-only P1 prototype; oversized lines require a separate horizontal layout strategy. */
export function createCodePreviewModel(text: string, ranges: readonly SyntaxRange[]): CodePreviewModel {
  const steps = codePreviewModelSteps(text, ranges);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export async function createCodePreviewModelAsync(
  text: string,
  ranges: readonly SyntaxRange[],
  options: { yieldTask: () => Promise<void>; signal?: AbortSignal }
): Promise<CodePreviewModel> {
  options.signal?.throwIfAborted();
  const steps = codePreviewModelSteps(text, ranges);
  let step = steps.next();
  while (!step.done) {
    await options.yieldTask();
    options.signal?.throwIfAborted();
    step = steps.next();
  }
  return step.value;
}

function* codePreviewModelSteps(text: string, ranges: readonly SyntaxRange[]): Generator<void, CodePreviewModel> {
  let operations = 0;
  let scannedUnits = 0;
  const checkpoint = (units = 0): boolean => {
    operations += 1;
    scannedUnits += units;
    if (operations < CODE_PREVIEW_STEP_MAX_OPERATIONS && scannedUnits < CODE_PREVIEW_SCAN_MAX_UNITS) return false;
    operations = 0;
    scannedUnits = 0;
    return true;
  };
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      !Number.isInteger(range.from) ||
      !Number.isInteger(range.to) ||
      range.from < previousEnd ||
      range.to <= range.from ||
      range.to > text.length
    ) {
      throw new RangeError("Code preview requires ordered, non-overlapping, in-bounds token ranges");
    }
    previousEnd = range.to;
    if (checkpoint()) yield;
  }

  const fragments: CodePreviewFragment[] = [];
  let from = 0;
  let lineStart = 0;
  let lines = 0;
  let firstRange = 0;
  let rangeEnd = 0;
  function* append(to: number, oversizedLine = false): Generator<void, void> {
    while (firstRange < ranges.length && ranges[firstRange]!.to <= from) {
      firstRange += 1;
      if (checkpoint()) yield;
    }
    rangeEnd = Math.max(firstRange, rangeEnd);
    while (rangeEnd < ranges.length && ranges[rangeEnd]!.from < to) {
      rangeEnd += 1;
      if (checkpoint()) yield;
    }
    fragments.push({ from, to, firstRange, rangeEnd, oversizedLine });
    from = to;
    lines = 0;
    if (checkpoint()) yield;
  }

  let scanPosition = 0;
  while (lineStart < text.length) {
    const scanEnd = Math.min(text.length, scanPosition + CODE_PREVIEW_SCAN_MAX_UNITS - scannedUnits);
    const newline = text.slice(scanPosition, scanEnd).indexOf("\n");
    const lineEnd = newline === -1 ? scanEnd : scanPosition + newline + 1;
    if (checkpoint(lineEnd - scanPosition)) yield;
    scanPosition = lineEnd;
    if (newline === -1 && scanEnd < text.length) continue;
    if (lineEnd - lineStart > CODE_PREVIEW_FRAGMENT_MAX_UNITS) {
      if (from < lineStart) yield* append(lineStart);
      yield* append(lineEnd, true);
    } else {
      if (lineEnd - from > CODE_PREVIEW_FRAGMENT_MAX_UNITS) yield* append(lineStart);
      lines += 1;
      if (lines === CODE_PREVIEW_FRAGMENT_MAX_LINES) yield* append(lineEnd);
    }
    lineStart = lineEnd;
  }
  if (from < text.length) yield* append(text.length);
  return { text, ranges, fragments };
}

export function findCodePreviewFragment(model: CodePreviewModel, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= model.text.length) return null;
  let low = 0;
  let high = model.fragments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (model.fragments[middle]!.to <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}
