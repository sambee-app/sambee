import { version } from "../../package.json";
import { getFileTypeByExtension, getFileTypeByMime } from "./FileTypeRegistry";

export type NativeShareResult = "shared" | "cancelled" | "unsupported";
export type ShareSource = "displayed-resource" | "displayed-original" | "displayed-derivative" | "saved-file";
export interface ShareDiagnostic {
  version: string;
  browser: string;
  platform: string;
  secureContext: boolean;
  shareAvailable: boolean;
  preflight: "not-required" | "unavailable" | "thrown" | "accepted" | "rejected";
  preflightError?: string;
  invoked: boolean;
  activation: boolean | "unknown";
  fields: string[];
  attachments: { type: string; size: number }[];
  reason: string;
}
type ShareConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

export interface ShareOptions {
  file?: File;
  files?: readonly File[];
  title?: string;
  text?: string;
  url?: string;
  onDiagnostic?: (diagnostic: ShareDiagnostic) => void;
}

type ShareNavigator = Navigator & {
  share?: (data?: ShareData) => Promise<void>;
  canShare?: (data?: ShareData) => boolean;
  connection?: ShareConnection;
};

const SAFE_SHARE_ERROR_NAMES = new Set(["NotAllowedError", "InvalidStateError", "TypeError", "DataError", "SecurityError", "AbortError"]);

function safeShareErrorName(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "unknown";
  return SAFE_SHARE_ERROR_NAMES.has(name) ? name : "unknown";
}

function getShareNavigator(): ShareNavigator | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return navigator as ShareNavigator;
}

export function supportsNativeShare(): boolean {
  return typeof getShareNavigator()?.share === "function";
}
export function shouldWarmNativeSharePayload(): boolean {
  const connection = getShareNavigator()?.connection;
  if (!connection) {
    return true;
  }

  if (connection.saveData) {
    return false;
  }

  return !["slow-2g", "2g", "3g"].includes(connection.effectiveType ?? "");
}

const GENERIC_SHARE_MIME_TYPE = "application/octet-stream";

export function createShareFile(blob: Blob, filename: string, mimeType?: string): File {
  const fileType =
    [blob.type, mimeType, getFileTypeByExtension(filename)?.mimeTypes[0]]
      .map((candidate) => candidate?.split(";")[0]?.trim().toLowerCase())
      .find((candidate) => candidate && candidate !== GENERIC_SHARE_MIME_TYPE) || GENERIC_SHARE_MIME_TYPE;
  return new File([blob], filename, { type: fileType });
}

export function createDisplayedShareFile(blob: Blob, filename: string): File {
  const file = createShareFile(blob, filename);
  const format = getFileTypeByMime(file.type);
  const extension = format?.extensions[0];
  if (extension && !format.extensions.some((candidate) => filename.toLowerCase().endsWith(candidate))) {
    const stem = filename.lastIndexOf(".") > 0 ? filename.slice(0, filename.lastIndexOf(".")) : filename;
    return new File([file], `${stem}${extension}`, { type: file.type });
  }
  return file;
}

export function createShareDiagnostic(options: ShareOptions = {}): ShareDiagnostic {
  const shareNavigator = getShareNavigator();
  const attachments = options.files ? [...options.files] : options.file ? [options.file] : [];
  const browserTokens = shareNavigator?.userAgent?.match(/(?:Firefox|Chrome|Chromium|Version|Safari|Edg|Android|OS)\/[\d._]+/g);
  return {
    version,
    browser: browserTokens?.join(" ") || "unknown",
    platform:
      shareNavigator?.userAgent?.match(/Android [\d.]+|(?:iPhone )?OS [\d_]+|Windows NT [\d.]+|Mac OS X [\d_]+|Linux/)?.[0] ?? "unknown",
    secureContext: globalThis.isSecureContext === true,
    shareAvailable: typeof shareNavigator?.share === "function",
    preflight: attachments.length ? "unavailable" : "not-required",
    invoked: false,
    activation: shareNavigator?.userActivation?.isActive ?? "unknown",
    fields: [],
    attachments: attachments.map((attachment) => ({
      type: getFileTypeByMime(attachment.type) ? attachment.type : "unknown",
      size: attachment.size,
    })),
    reason: "not-invoked",
  };
}

export async function shareNativeContent({ file, files, title, text, url, onDiagnostic }: ShareOptions): Promise<NativeShareResult> {
  const shareNavigator = getShareNavigator();
  const diagnostic = createShareDiagnostic({ file, files });
  const report = (reason: string) => onDiagnostic?.({ ...diagnostic, reason });
  if (!shareNavigator?.share) {
    report("api-unavailable");
    return "unsupported";
  }

  const shareData: ShareData = {};
  const shareFiles = files ? [...files] : file ? [file] : [];
  let canShareFile: boolean | undefined;
  if (shareFiles.length > 0 && typeof shareNavigator.canShare === "function") {
    try {
      canShareFile = shareNavigator.canShare({ files: shareFiles });
      diagnostic.preflight = canShareFile ? "accepted" : "rejected";
    } catch (error) {
      diagnostic.preflight = "thrown";
      diagnostic.preflightError = safeShareErrorName(error);
    }
  }

  if (shareFiles.length > 0 && canShareFile === false) {
    report("payload-unsupported");
    return "unsupported";
  }

  if (shareFiles.length > 0) {
    shareData.files = shareFiles;
  }

  if (title && (shareFiles.length === 0 || canShareFile === true)) {
    shareData.title = title;
  }

  if (text && shareFiles.length === 0) {
    shareData.text = text;
  }

  if (url && shareFiles.length === 0) {
    shareData.url = url;
  }

  if (!shareData.files && !shareData.title && !shareData.text && !shareData.url) {
    report("empty-payload");
    return "unsupported";
  }

  try {
    diagnostic.fields = Object.keys(shareData);
    diagnostic.activation = shareNavigator.userActivation?.isActive ?? "unknown";
    diagnostic.invoked = true;
    await shareNavigator.share(shareData);
    report("api-completed");
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      report("cancelled");
      return "cancelled";
    }
    const errorName = safeShareErrorName(error);
    report(errorName === "unknown" ? "share-rejected" : errorName);
    throw error;
  }
}
