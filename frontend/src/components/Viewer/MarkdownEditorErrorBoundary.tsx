import { Alert, Box, Button, Typography } from "@mui/material";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface MarkdownEditorErrorBoundaryProps {
  children: ReactNode;
  title: string;
  description: string;
  retryLabel: string;
  returnToPreviewLabel: string;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  onRetry: () => void;
  onReturnToPreview: () => void;
}

interface MarkdownEditorErrorBoundaryState {
  error: Error | null;
}

class MarkdownEditorErrorBoundary extends Component<MarkdownEditorErrorBoundaryProps, MarkdownEditorErrorBoundaryState> {
  constructor(props: MarkdownEditorErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): MarkdownEditorErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.props.onError?.(error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onRetry();
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, py: 2 }}>
        <Alert severity="error">
          <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 600 }}>
            {this.props.title}
          </Typography>
          <Typography variant="body2">{this.props.description}</Typography>
        </Alert>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          <Button variant="contained" onClick={this.handleRetry}>
            {this.props.retryLabel}
          </Button>
          <Button variant="outlined" onClick={this.props.onReturnToPreview}>
            {this.props.returnToPreviewLabel}
          </Button>
        </Box>
      </Box>
    );
  }
}

export default MarkdownEditorErrorBoundary;
