import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const METHODS = new Set(["title", "set_title", "tooltip", "set_tooltip", "message"]);
const MENU_ARGUMENTS = new Map([
  ["new", 1],
  ["with_id", 2],
]);
const IGNORE = /^\s*\/\/ localization-lint-ignore: \S.*$/;

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i++;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unterminated block comment");
      continue;
    }
    const raw = source.slice(i).match(/^(?:br|r)(#*)"/);
    if (raw) {
      const endMarker = `"${raw[1]}`;
      const end = source.indexOf(endMarker, i + raw[0].length);
      if (end < 0) throw new Error("Unterminated raw string");
      tokens.push({ value: "string", offset: i });
      i = end + endMarker.length;
      continue;
    }
    if (source[i] === '"' || (source[i] === "b" && source[i + 1] === '"')) {
      const start = i;
      if (source[i] === "b") i++;
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      if (i >= source.length) throw new Error("Unterminated string");
      i++;
      tokens.push({ value: "string", offset: start });
      continue;
    }
    const character = source.slice(i).match(/^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'/u);
    if (character) {
      i += character[0].length;
      continue;
    }
    const identifier = source.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (identifier) {
      tokens.push({ value: identifier[0], offset: i });
      i += identifier[0].length;
      continue;
    }
    tokens.push({ value: source[i], offset: i });
    i++;
  }
  return tokens;
}

function argument(tokens, open, index) {
  const stack = [];
  let current = 0;
  let first = open + 1;
  for (let i = first; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (!stack.length && (value === "," || value === ")")) {
      if (current === index) return tokens[first];
      if (value === ")") return undefined;
      current++;
      first = i + 1;
    } else if (value === "(" || value === "[" || value === "{") {
      stack.push(value);
    } else if (value === ")" || value === "]" || value === "}") {
      if (!stack.length) return undefined;
      stack.pop();
    }
  }
  return undefined;
}

export function findNativeUiLiterals(source) {
  const tokens = tokenize(source);
  const lines = source.split("\n");
  const findings = [];
  for (let i = 0; i < tokens.length; i++) {
    let literal;
    if (tokens[i].value === "." && METHODS.has(tokens[i + 1]?.value) && tokens[i + 2]?.value === "(") {
      literal = argument(tokens, i + 2, 0);
      if (tokens[i + 1].value === "set_tooltip" && tokens[i + 3]?.value === "Some" && tokens[i + 4]?.value === "(") {
        literal = argument(tokens, i + 4, 0);
      }
    } else if (
      tokens[i].value === "MenuItem" &&
      tokens[i + 1]?.value === ":" &&
      tokens[i + 2]?.value === ":" &&
      MENU_ARGUMENTS.has(tokens[i + 3]?.value) &&
      tokens[i + 4]?.value === "("
    ) {
      literal = argument(tokens, i + 4, MENU_ARGUMENTS.get(tokens[i + 3].value));
    }
    if (literal?.value !== "string") continue;
    const line = source.slice(0, tokens[i].offset).split("\n").length;
    if (!IGNORE.test(lines[line - 2] ?? "")) findings.push(line);
  }
  return findings;
}

function rustFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.isFile() && entry.name.endsWith(".rs") ? [path] : [];
  });
}

function main() {
  const root = fileURLToPath(new URL("../companion/src-tauri/src/", import.meta.url));
  let failed = false;
  for (const file of rustFiles(root)) {
    for (const line of findNativeUiLiterals(readFileSync(file, "utf8"))) {
      console.error(`${file}:${line}: use a native translation for this UI text`);
      failed = true;
    }
  }
  return Number(failed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
