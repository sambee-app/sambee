import { useCallback, useEffect } from "react";

/** Keep the document filename in the tab title and omit its extension for PDF printing. */
export function useViewerDocumentTitle(filename: string): () => void {
  const extensionIndex = filename.lastIndexOf(".");
  const printTitle = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = filename;
    const beforePrint = () => {
      if (document.title === filename) document.title = printTitle;
    };
    const afterPrint = () => {
      if (document.title === printTitle) document.title = filename;
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      if (document.title === filename || document.title === printTitle) document.title = previousTitle;
    };
  }, [filename, printTitle]);

  return useCallback(() => {
    const previousTitle = document.title;
    document.title = printTitle;
    try {
      window.print();
    } catch (error) {
      if (document.title === printTitle) document.title = previousTitle;
      throw error;
    }
  }, [printTitle]);
}
