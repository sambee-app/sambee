type TextMeasurer = (text: string) => number;

const ELLIPSIS = "...";

function splitGraphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), ({ segment }) => segment);
  }

  const graphemes: string[] = [];
  let joinNext = false;
  let regionalIndicatorCount = 0;
  for (const character of Array.from(value)) {
    const joinsPrevious = /\p{Mark}|[\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]|\u200D/u.test(character) || joinNext;
    const isRegionalIndicator = /\p{Regional_Indicator}/u.test(character);
    if (joinsPrevious || (isRegionalIndicator && regionalIndicatorCount % 2 === 1)) {
      graphemes[graphemes.length - 1] = `${graphemes.at(-1) ?? ""}${character}`;
    } else {
      graphemes.push(character);
    }
    joinNext = character === "\u200D";
    regionalIndicatorCount = isRegionalIndicator ? regionalIndicatorCount + 1 : 0;
  }
  return graphemes;
}

/** Truncate text to a grapheme-safe character budget for breadcrumb labels. */
export function truncateTextByGrapheme(value: string, maxGraphemes: number): string {
  const graphemes = splitGraphemes(value);
  if (graphemes.length <= maxGraphemes) return value;
  if (maxGraphemes <= 1) return "…";
  return `${graphemes.slice(0, maxGraphemes - 1).join("")}…`;
}

function shortenTextFromStart(text: string, availableWidth: number, measureText: TextMeasurer): string {
  if (availableWidth <= 0 || measureText(text) <= availableWidth) {
    return text;
  }

  const graphemes = splitGraphemes(text);
  let low = 0;
  let high = graphemes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (measureText(`${ELLIPSIS}${graphemes.slice(middle).join("")}`) <= availableWidth) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return `${ELLIPSIS}${graphemes.slice(low).join("")}`;
}

/** Preserve the start and extension of a filename while abbreviating its middle. */
export function abbreviateFileName(value: string, availableWidth: number, measureText: TextMeasurer): string {
  if (availableWidth <= 0 || measureText(value) <= availableWidth) {
    return value;
  }

  const extensionIndex = value.lastIndexOf(".");
  const extension = extensionIndex > 0 ? value.slice(extensionIndex) : "";
  const stem = extension ? value.slice(0, extensionIndex) : value;
  const stemGraphemes = splitGraphemes(stem);
  const preservedSuffix = extension.startsWith(".") ? extension.slice(1) : extension;

  if (measureText(`${ELLIPSIS}${preservedSuffix}`) > availableWidth) {
    return shortenTextFromStart(`${ELLIPSIS}${preservedSuffix}`, availableWidth, measureText);
  }

  let low = 0;
  let high = stemGraphemes.length;
  while (low < high) {
    const prefixLength = Math.ceil((low + high + 1) / 2);
    const candidate = `${stemGraphemes.slice(0, prefixLength).join("")}${ELLIPSIS}${preservedSuffix}`;
    if (measureText(candidate) <= availableWidth) {
      low = prefixLength;
    } else {
      high = prefixLength - 1;
    }
  }

  return `${stemGraphemes.slice(0, low).join("")}${ELLIPSIS}${preservedSuffix}`;
}

/** Preserve the connection/root prefix and basename while collapsing ancestor directories to fit. */
export function abbreviatePath(path: string, availableWidth: number, measureText: TextMeasurer): string {
  if (availableWidth <= 0 || measureText(path) <= availableWidth) {
    return path;
  }

  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const prefixedRoot = path.match(/^([^/\\]+):[ \t]*[\\/]/)?.[0];
  const root = prefixedRoot ?? (path.startsWith(separator) ? separator : "");
  const segments = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  const basename = segments.pop();
  if (!basename) {
    return path;
  }

  const abbreviatedBasename = (includeAncestorIndicator: boolean) => {
    const text = includeAncestorIndicator ? `${ELLIPSIS}${basename}` : basename;
    if (!prefixedRoot || measureText(prefixedRoot) >= availableWidth) {
      return includeAncestorIndicator
        ? shortenTextFromStart(text, availableWidth, measureText)
        : abbreviateFileName(text, availableWidth, measureText);
    }
    const remainingWidth = availableWidth - measureText(prefixedRoot);
    return `${prefixedRoot}${includeAncestorIndicator ? shortenTextFromStart(text, remainingWidth, measureText) : abbreviateFileName(text, remainingWidth, measureText)}`;
  };

  if (segments.length === 0) {
    return abbreviatedBasename(false);
  }

  if (measureText(basename) > availableWidth) {
    return abbreviatedBasename(true);
  }

  const prefix = `${root}${ELLIPSIS}${separator}`;
  let shortened = `${prefix}${basename}`;
  if (measureText(shortened) > availableWidth) {
    return abbreviatedBasename(true);
  }

  while (segments.length > 0) {
    const candidate = `${prefix}${segments.at(-1)}${separator}${shortened.slice(prefix.length)}`;
    if (measureText(candidate) > availableWidth) {
      break;
    }
    shortened = candidate;
    segments.pop();
  }

  return shortened;
}
