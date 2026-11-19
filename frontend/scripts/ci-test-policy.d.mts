export const CI_MAX_WORKERS: number;
export const CI_WORKER_MEMORY_BYTES: number;
export const CI_RESERVED_MEMORY_BYTES: number;
export const CI_BROWSER_ENGINES: readonly string[];
export const CI_BROWSER_WIDTHS: readonly number[];
export const CI_PRODUCTION_SCENARIOS: readonly string[];
export const CI_MARKDOWN_PRINT_MODES: readonly ["light", "dark"];
export const CI_DEVELOPMENT_SCENARIO: string;

export interface BrowserCase {
  engine: string | undefined;
  title: string | undefined;
  status: string | undefined;
  attempts: number;
}

export function ciWorkerCount(cpuCount: number, memoryBytes: number): number;
export function markdownPrintCaseTitle(mode: (typeof CI_MARKDOWN_PRINT_MODES)[number]): string;
export function expectedBrowserCases(mode: string): string[];
export function validateBrowserCases(mode: string, cases: readonly BrowserCase[]): string[];
