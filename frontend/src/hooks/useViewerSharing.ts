import { useEffect, useRef, useState } from "react";
import { useNativeSharing } from "../components/Sharing/useNativeSharing";
import type { ShareSource } from "../utils/nativeShare";

interface ViewerSharingOptions {
  entryPoint: string;
  identity: string;
  enabled: boolean;
  file?: File | null;
  loadFile?: (signal: AbortSignal) => Promise<File>;
  source?: ShareSource;
}

export function useViewerSharing({ entryPoint, identity, enabled, file, loadFile, source = "saved-file" }: ViewerSharingOptions) {
  const native = useNativeSharing(entryPoint, source);
  const [prepared, setPrepared] = useState<{
    identity: string;
    loader: typeof loadFile;
    sourceFile: typeof file;
    attempt: number;
    file: File;
  } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const preparedFile =
    prepared?.identity === identity && prepared.loader === loadFile && prepared.sourceFile === file && prepared.attempt === attempt
      ? prepared.file
      : null;
  const failureRef = useRef(native.preparationFailed);
  const clearRef = useRef(native.clearFailure);
  failureRef.current = native.preparationFailed;
  clearRef.current = native.clearFailure;

  // biome-ignore lint/correctness/useExhaustiveDependencies: retain failure evidence across action visibility changes, but not resource replacement or retry.
  useEffect(() => {
    clearRef.current();
  }, [identity, loadFile, file, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: completion must not restart preparation; availability changes reuse valid prepared bytes.
  useEffect(() => {
    const controller = new AbortController();
    if (!preparedFile) setPrepared(null);
    setPreparing(false);
    if (enabled && loadFile && !file && !preparedFile) {
      setPreparing(true);
      void loadFile(controller.signal)
        .then((nextFile) => {
          if (!controller.signal.aborted) setPrepared({ identity, loader: loadFile, sourceFile: file, attempt, file: nextFile });
        })
        .catch(() => {
          if (!controller.signal.aborted) failureRef.current({}, () => setAttempt((value) => value + 1));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreparing(false);
        });
    }
    return () => {
      controller.abort();
    };
  }, [enabled, identity, loadFile, file, attempt]);

  const readyFile = enabled ? (file ?? preparedFile) : null;
  const shareFile = () => {
    if (readyFile) void native.invoke({ file: readyFile, title: readyFile.name });
  };
  const shareText = (text: string | (() => string)) => {
    try {
      void native.invoke({ text: typeof text === "function" ? text() : text });
    } catch {
      native.preparationFailed({ text: "" });
    }
  };
  return { ...native, shareFile, shareText, ready: Boolean(readyFile), preparing };
}
