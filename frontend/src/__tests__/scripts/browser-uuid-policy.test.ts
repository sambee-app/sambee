import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  isBindingElement,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

const RESTRICTED_MEMBER = "randomUUID";
const SOURCE_ROOTS = ["frontend/src", "companion/src", "shared"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const FORBIDDEN_EXAMPLES = [
  "crypto.randomUUID()",
  "window.crypto.randomUUID()",
  "globalThis.crypto.randomUUID()",
  "crypto?.randomUUID?.()",
  'crypto["randomUUID"]()',
  "crypto[`randomUUID`]()",
  "const { randomUUID: makeId } = crypto",
  'const { "randomUUID": makeId } = crypto',
  'const { ["randomUUID"]: makeId } = crypto',
  "const { randomUUID } = crypto",
  "const makeId = crypto.randomUUID",
  "const provider = crypto; provider.randomUUID()",
  "crypto.random\\u0055UID()",
];

function isRestrictedName(node: Node | undefined): boolean {
  if (!node) return false;
  if (isComputedPropertyName(node)) return isRestrictedName(node.expression);
  return (isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && node.text === RESTRICTED_MEMBER;
}

function findRestrictedAccess(root: Node): Node[] {
  const violations: Node[] = [];
  const visit = (node: Node): void => {
    if (
      (isPropertyAccessExpression(node) && isRestrictedName(node.name)) ||
      (isElementAccessExpression(node) && isRestrictedName(node.argumentExpression)) ||
      (isBindingElement(node) && isRestrictedName(node.propertyName ?? node.name))
    ) {
      violations.push(node);
    }
    node.forEachChild(visit);
  };
  visit(root);
  return violations;
}

describe("browser UUID source policy", () => {
  it("rejects secure-context UUID access in maintained browser source", () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const files = SOURCE_ROOTS.flatMap((directory) =>
      readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && SOURCE_EXTENSION.test(entry.name))
        .map((entry) => resolve(entry.parentPath, entry.name))
    );
    expect(files.length).toBeGreaterThan(0);
    const fixture = resolve(root, "frontend/src/__tests__/scripts/uuid-policy-fixture.ts");
    const fixtureText = FORBIDDEN_EXAMPLES.map((example) => `{ ${example}; }`).join("\n");
    const compiler = new API({
      fs: {
        fileExists: (file) => (file === fixture ? true : undefined),
        readFile: (file) => (file === fixture ? fixtureText : undefined),
      },
    });
    try {
      using snapshot = compiler.updateSnapshot({ openFiles: [...files, fixture] });
      const fixtureSource = snapshot.getDefaultProjectForFile(fixture)?.program.getSourceFile(fixture);
      expect(fixtureSource, "The policy examples must be parsed").toBeDefined();
      expect(fixtureSource?.statements).toHaveLength(FORBIDDEN_EXAMPLES.length);
      for (const [index, statement] of (fixtureSource?.statements ?? []).entries()) {
        expect(findRestrictedAccess(statement), FORBIDDEN_EXAMPLES[index]).toHaveLength(1);
      }

      const violations: string[] = [];
      for (const file of files) {
        const source = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);
        if (!source) throw new Error(`Cannot check UUID access in ${relative(root, file)}: no syntax tree was returned.`);
        for (const node of findRestrictedAccess(source)) {
          violations.push(`${relative(root, file)} at offset ${node.getStart(source)}: use randomUuid() instead.`);
        }
      }
      expect(violations, "Browser code must use the HTTP-compatible randomUuid() helper").toEqual([]);
    } finally {
      compiler.close();
    }
  });
});
