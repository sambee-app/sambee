import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { ciWorkerCount } from "./scripts/ci-test-policy.mjs";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    server: {
      deps: {
        inline: ["react-pdf"],
      },
    },
    css: true,
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    // Enable parallel file execution for better performance
    // Uses threads by default with fileParallelism enabled
    fileParallelism: true,
    maxWorkers: process.env["SAMBEE_TEST_CI"] === "1" ? ciWorkerCount(availableParallelism(), totalmem()) : undefined,
    // Maximum number of concurrent test files
    maxConcurrency: 5,
    // Timeout for each test (default is 5000ms)
    testTimeout: 10000,
    env: {
      VITE_API_URL: "http://localhost:3000/api",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      exclude: ["node_modules/", "src/test/", "**/*.d.ts", "**/*.config.*", "**/dist/", "src/vite-env.d.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" },
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
});
