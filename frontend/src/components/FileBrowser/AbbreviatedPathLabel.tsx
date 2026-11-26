import { Box, type Theme, Typography } from "@mui/material";
import type { SystemStyleObject } from "@mui/system";
import { visuallyHidden } from "@mui/utils";
import { useLayoutEffect, useRef, useState } from "react";
import { abbreviatePath } from "../../utils/pathDisplay";

export function AbbreviatedPathLabel({
  path,
  variant = "inherit",
  sx,
}: {
  path: string;
  variant?: "inherit" | "body2";
  sx?: SystemStyleObject<Theme>;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [displayPath, setDisplayPath] = useState(path);

  useLayoutEffect(() => {
    const label = labelRef.current;
    const measurement = measureRef.current;
    if (!label || !measurement) return;

    const updatePath = () => {
      const measureText = (text: string) => {
        measurement.textContent = text;
        return measurement.getBoundingClientRect().width;
      };
      setDisplayPath(abbreviatePath(path, label.clientWidth, measureText));
    };

    updatePath();
    const observer = new ResizeObserver(updatePath);
    observer.observe(label);
    return () => observer.disconnect();
  }, [path]);

  const shortened = displayPath !== path;
  return (
    <Typography
      ref={labelRef}
      component="bdi"
      variant={variant}
      dir="auto"
      title={path}
      sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...sx }}
    >
      <span aria-hidden={shortened || undefined}>{displayPath}</span>
      {shortened && (
        <Box component="span" sx={visuallyHidden}>
          {path}
        </Box>
      )}
      <Box
        ref={measureRef}
        aria-hidden
        component="span"
        sx={{ insetInlineStart: 0, position: "fixed", visibility: "hidden", whiteSpace: "nowrap" }}
      />
    </Typography>
  );
}
