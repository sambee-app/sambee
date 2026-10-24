import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const frontendRoot = resolve(process.cwd());
const protectedSourceRoots = ["src/components/FileBrowser", "src/components/Viewer", "src/pages/FileBrowser"];
const protectedSourceFiles = ["src/pages/FileBrowser.tsx", "src/hooks/useCachedImageGallery.ts"];
const approvedRawTransportOwners = new Set([
  "src/pages/FileBrowser/archiveExtractionExecution.ts",
  "src/pages/FileBrowser/contentProviders.ts",
]);
const privateListingLoaderNames = new Set([
  "loadFiles",
  "loadPhysicalDirectory",
  "forceReloadCurrentDirectory",
  "prepareDirectoryTransition",
]);

async function collectSourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(path, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(entryPath);
      return /(?<!\.test)\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
    })
  );
  return nested.flat();
}

function isForbiddenTransportSpecifier(sourceFilePath: string, specifier: string): boolean {
  const resolvedSpecifier = specifier.startsWith(".") ? relative(frontendRoot, resolve(dirname(sourceFilePath), specifier)) : specifier;
  const normalizedSpecifier = resolvedSpecifier
    .replace(/\\/g, "/")
    .replace(/\.(?:ts|tsx|js|jsx)$/, "")
    .replace(/\/index$/, "");
  return (
    /(?:^|\/)(?:src\/)?services\/(?:api|companion)$/.test(normalizedSpecifier) ||
    /^@\/services\/(?:api|companion)$/.test(normalizedSpecifier)
  );
}

function findForbiddenTransportImports(sourceFilePath: string, ast: unknown): string[] {
  const forbiddenImports: string[] = [];
  const visited = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const node = value as Record<string, unknown>;
    const type = node["type"];
    const source = node["source"] as Record<string, unknown> | undefined;
    const firstArgument = (node["arguments"] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    const typeImportArgument = node["argument"] as Record<string, unknown> | undefined;
    const moduleSpecifier =
      typeof source?.["value"] === "string"
        ? source["value"]
        : type === "CallExpression" &&
            (node["callee"] as Record<string, unknown> | undefined)?.["type"] === "Import" &&
            typeof firstArgument?.["value"] === "string"
          ? firstArgument["value"]
          : type === "CallExpression" &&
              (node["callee"] as Record<string, unknown> | undefined)?.["name"] === "require" &&
              typeof firstArgument?.["value"] === "string"
            ? firstArgument["value"]
            : type === "TSImportType" && typeof typeImportArgument?.["value"] === "string"
              ? typeImportArgument["value"]
              : null;
    if (typeof moduleSpecifier === "string" && isForbiddenTransportSpecifier(sourceFilePath, moduleSpecifier)) {
      forbiddenImports.push(`${sourceFilePath}: ${moduleSpecifier}`);
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return forbiddenImports;
}

function getPropertyName(node: Record<string, unknown>): string | null {
  const key = node["key"] as Record<string, unknown> | undefined;
  if (key?.["type"] === "Identifier" && typeof key["name"] === "string") return key["name"];
  if (key?.["type"] === "StringLiteral" && typeof key["value"] === "string") return key["value"];
  return null;
}

function findForbiddenListingLoaderAccess(sourceFilePath: string, ast: unknown): string[] {
  const violations: string[] = [];
  const visited = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const node = value as Record<string, unknown>;
    const type = node["type"];
    const property = node["property"] as Record<string, unknown> | undefined;
    const propertyName = getPropertyName(node);
    const memberName = property?.["type"] === "Identifier" && typeof property["name"] === "string" ? property["name"] : null;
    if (
      (type === "MemberExpression" || type === "OptionalMemberExpression") &&
      !node["computed"] &&
      memberName !== null &&
      privateListingLoaderNames.has(memberName)
    ) {
      violations.push(`${sourceFilePath}: ${memberName}`);
    }
    if (
      (type === "ObjectProperty" || type === "Property" || type === "TSPropertySignature" || type === "ExportSpecifier") &&
      propertyName
    ) {
      if (privateListingLoaderNames.has(propertyName)) {
        violations.push(`${sourceFilePath}: ${propertyName}`);
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(ast);
  return violations;
}

describe("content operation boundary", () => {
  it("keeps viewer and File Browser UI outside raw physical transports", async () => {
    const rootFiles = await Promise.all(protectedSourceRoots.map((path) => collectSourceFiles(resolve(frontendRoot, path))));
    const files = [...rootFiles.flat(), ...protectedSourceFiles.map((path) => resolve(frontendRoot, path))];
    const violations = (
      await Promise.all(
        files.map(async (filePath) => {
          const workspacePath = relative(frontendRoot, filePath).replace(/\\/g, "/");
          if (approvedRawTransportOwners.has(workspacePath)) return [];
          const source = await readFile(filePath, "utf8");
          const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
          return findForbiddenTransportImports(filePath, ast);
        })
      )
    ).flat();

    expect(violations).toEqual([]);
  });

  it("keeps physical listing implementation private to the pane hook", async () => {
    const rootFiles = await Promise.all(protectedSourceRoots.map((path) => collectSourceFiles(resolve(frontendRoot, path))));
    const files = [...rootFiles.flat(), ...protectedSourceFiles.map((path) => resolve(frontendRoot, path))].filter(
      (filePath) => relative(frontendRoot, filePath).replace(/\\/g, "/") !== "src/pages/FileBrowser/useFileBrowserPane.ts"
    );
    files.push(resolve(frontendRoot, "src/pages/FileBrowser/types.ts"));
    const violations = (
      await Promise.all(
        files.map(async (filePath) => {
          const source = await readFile(filePath, "utf8");
          const ast = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
          return findForbiddenListingLoaderAccess(filePath, ast);
        })
      )
    ).flat();

    expect(violations).toEqual([]);
  });
});
