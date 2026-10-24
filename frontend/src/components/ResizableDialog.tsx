import { Box, type SxProps, type Theme } from "@mui/material";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

export const RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX = 32;

const RESIZE_GRIP_LINE_WIDTHS_PX = [5, 9, 13];

export interface ResizableDialogSize {
  width: number;
  height: number;
}

export interface ResizableDialogViewport {
  width: number;
  height: number;
}

export interface ResizableDialogConfig {
  storageKey: string;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
}

interface ResizeSession {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  size: ResizableDialogSize;
  preferredSize: ResizableDialogSize | null;
}

export interface ResizableDialogHandleProps {
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

function getViewportSize(): ResizableDialogViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function isResizableDialogSize(value: unknown): value is ResizableDialogSize {
  if (typeof value !== "object" || value === null || !("width" in value) || !("height" in value)) {
    return false;
  }

  const { width, height } = value;
  return (
    typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  );
}

function clampDimension(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, Math.min(minimum, maximum)), maximum);
}

/** Get the largest dialog size that preserves standard viewport gutters. */
export function getResizableDialogMaximumSize(config: ResizableDialogConfig, viewport: ResizableDialogViewport): ResizableDialogSize {
  return {
    width: Math.max(0, Math.min(config.maxWidth, viewport.width - RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2)),
    height: Math.max(0, viewport.height - RESIZABLE_DIALOG_VIEWPORT_GUTTER_PX * 2),
  };
}

/** Clamp a saved dialog size to the current viewport and its usable minimum. */
export function clampResizableDialogSize(
  config: ResizableDialogConfig,
  preferredSize: ResizableDialogSize,
  viewport: ResizableDialogViewport
): ResizableDialogSize {
  const maximumSize = getResizableDialogMaximumSize(config, viewport);

  return {
    width: clampDimension(preferredSize.width, config.minWidth, maximumSize.width),
    height: clampDimension(preferredSize.height, config.minHeight, maximumSize.height),
  };
}

/** Read a persisted dialog size, ignoring invalid or unavailable storage. */
export function readResizableDialogSize(storageKey: string): ResizableDialogSize | null {
  try {
    const storedSize = window.localStorage.getItem(storageKey);
    if (!storedSize) {
      return null;
    }

    const parsedSize: unknown = JSON.parse(storedSize);
    return isResizableDialogSize(parsedSize) ? parsedSize : null;
  } catch {
    return null;
  }
}

/** Persist a dialog size when browser storage is available. */
export function writeResizableDialogSize(storageKey: string, size: ResizableDialogSize): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(size));
  } catch {
    // Dialog resizing remains functional when browser storage is unavailable.
  }
}

/** Manage persisted size and centered bottom-right resize behavior for a dialog paper. */
export function useResizableDialogSize(config: ResizableDialogConfig) {
  const [preferredSize, setPreferredSize] = useState<ResizableDialogSize | null>(() => readResizableDialogSize(config.storageKey));
  const [viewportSize, setViewportSize] = useState<ResizableDialogViewport>(getViewportSize);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);

  useEffect(() => {
    const handleViewportResize = () => {
      setViewportSize(getViewportSize());
    };

    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  const getResizedSize = useCallback(
    (clientX: number, clientY: number, resizeSession: ResizeSession) => {
      // MUI centers the paper, so each pointer delta changes both dialog edges.
      return clampResizableDialogSize(
        config,
        {
          width: resizeSession.size.width + (clientX - resizeSession.pointerX) * 2,
          height: resizeSession.size.height + (clientY - resizeSession.pointerY) * 2,
        },
        viewportSize
      );
    },
    [config, viewportSize]
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const paper = paperRef.current ?? event.currentTarget.closest<HTMLElement>('[role="dialog"]');
      const paperBounds = paper?.getBoundingClientRect();
      if (!paperBounds) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeSessionRef.current = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        size: { width: paperBounds.width, height: paperBounds.height },
        preferredSize,
      };
    },
    [preferredSize]
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = resizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      setPreferredSize(getResizedSize(event.clientX, event.clientY, resizeSession));
    },
    [getResizedSize]
  );

  const handleResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = resizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      const size = getResizedSize(event.clientX, event.clientY, resizeSession);
      setPreferredSize(size);
      writeResizableDialogSize(config.storageKey, size);
      resizeSessionRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    [config.storageKey, getResizedSize]
  );

  const handleResizePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeSession = resizeSessionRef.current;
    if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
      return;
    }

    setPreferredSize(resizeSession.preferredSize);
    resizeSessionRef.current = null;
  }, []);

  return {
    displayedSize: preferredSize ? clampResizableDialogSize(config, preferredSize, viewportSize) : null,
    paperRef,
    resizeHandleProps: {
      onPointerCancel: handleResizePointerCancel,
      onPointerDown: handleResizePointerDown,
      onPointerMove: handleResizePointerMove,
      onPointerUp: handleResizePointerUp,
    } satisfies ResizableDialogHandleProps,
  };
}

/** Bottom-right visual grip and pointer target shared by resizable dialogs. */
export function ResizableDialogHandle({
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  sx,
  testId,
}: ResizableDialogHandleProps & { sx?: SxProps<Theme>; testId?: string }) {
  return (
    <Box
      aria-hidden="true"
      data-testid={testId}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      sx={[
        {
          alignItems: "flex-end",
          bottom: 0,
          cursor: "nwse-resize",
          display: "flex",
          height: 24,
          justifyContent: "flex-end",
          position: "absolute",
          right: 0,
          touchAction: "none",
          userSelect: "none",
          width: 24,
          zIndex: 1,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <Box sx={{ bottom: 4, height: 14, position: "absolute", right: 4, width: 14 }}>
        {RESIZE_GRIP_LINE_WIDTHS_PX.map((width, index) => (
          <Box
            key={width}
            sx={{
              bgcolor: "text.secondary",
              bottom: index * 4,
              height: 1.5,
              opacity: 0.55,
              position: "absolute",
              right: 0,
              transform: "rotate(-45deg)",
              transformOrigin: "right center",
              width,
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
