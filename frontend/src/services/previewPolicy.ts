import { requiresServerImageConversion } from "../utils/FileTypeRegistry";
import type { StorageReadRequest, StorageRequestOptions } from "./storageContracts";

export const LOCAL_IMAGE_CONVERSION_UNAVAILABLE_MESSAGE =
  "This image format requires server-side conversion, which is unavailable for local drives. You can still download or open the original file locally.";
export const LOCAL_PDF_NORMALIZATION_UNAVAILABLE_MESSAGE =
  "PDF compatibility processing is unavailable for local drives. You can still download or open the original file locally.";
export const ARCHIVE_PREVIEW_SIZE_LIMIT_MESSAGE =
  "This archive member exceeds the inline preview size limit (5 MiB). Download or extract the member to open it.";

export class PreviewUnavailableError extends Error {
  readonly code = "preview_transformation_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PreviewUnavailableError";
  }
}

/** Reject only preview transformations that the raw-only local provider cannot perform. */
export function assertLocalPreviewSupported(path: string, request: StorageReadRequest, options?: StorageRequestOptions): void {
  if (options?.download || request.kind === "raw" || request.kind === "text") {
    return;
  }

  if (request.kind === "image" && requiresServerImageConversion(path)) {
    throw new PreviewUnavailableError(LOCAL_IMAGE_CONVERSION_UNAVAILABLE_MESSAGE);
  }

  if (request.kind === "pdf" && request.variant === "normalized") {
    throw new PreviewUnavailableError(LOCAL_PDF_NORMALIZATION_UNAVAILABLE_MESSAGE);
  }
}
