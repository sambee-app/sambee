import { Box, Tooltip } from "@mui/material";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { abbreviateFileName, abbreviatePath } from "../../utils/pathDisplay";

export type DialogOperationIdentifierKind = "fileName" | "path";

interface DialogIdentifierDisplayProps {
  value: string;
  kind: DialogOperationIdentifierKind;
  testId?: string;
  appearance?: "code" | "text";
}

function measureText(element: HTMLElement, value: string): number {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return value.length;
  const style = getComputedStyle(element);
  context.font = `${style.fontStyle} ${style.fontVariant} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
  return context.measureText(value).width;
}

export function DialogIdentifierDisplay({ value, kind, testId, appearance = "code" }: DialogIdentifierDisplayProps) {
  const valueRef = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = valueRef.current;
    if (!element) return;
    const updateWidth = () => setAvailableWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document.fonts) return;
    void document.fonts.ready.then(() => {
      const element = valueRef.current;
      if (element) setAvailableWidth(element.clientWidth);
    });
  }, []);

  const displayValue =
    availableWidth === null || availableWidth <= 0
      ? value
      : kind === "fileName"
        ? abbreviateFileName(value, availableWidth, (text) => measureText(valueRef.current!, text))
        : abbreviatePath(value, availableWidth, (text) => measureText(valueRef.current!, text));
  const isShortened = displayValue !== value;
  const identifier = (
    <Box component="bdi" data-testid={testId} dir="auto" aria-label={value} sx={{ display: "block", maxWidth: "100%", minWidth: 0 }}>
      <Box
        component={appearance === "text" ? "span" : "code"}
        ref={valueRef}
        sx={{
          color: appearance === "text" ? "inherit" : "text.primary",
          display: "block",
          fontFamily: appearance === "text" ? "inherit" : "monospace",
          fontSize: appearance === "text" ? "inherit" : "0.875em",
          maxWidth: "100%",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {displayValue}
      </Box>
    </Box>
  );

  return (
    <Tooltip title={isShortened ? value : ""} disableFocusListener disableTouchListener>
      {identifier}
    </Tooltip>
  );
}
