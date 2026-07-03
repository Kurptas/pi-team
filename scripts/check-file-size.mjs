#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_SRC_LINES = 1200;
const MAX_TEST_LINES = 2000;
const ROOTS = ["src", "test"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".json"]);
const EXCLUDED_PARTS = new Set(["node_modules", "dist", ".git", ".pi"]);

function extensionOf(file) {
  const index = file.lastIndexOf(".");
  return index === -1 ? "" : file.slice(index);
}

function shouldSkip(path) {
  return path.split(/[\\/]+/).some((part) => EXCLUDED_PARTS.has(part));
}

function collectFiles(dir, files = []) {
  if (shouldSkip(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (shouldSkip(fullPath)) continue;
    const stats = statSync(fullPath);
    if (stats.isDirectory()) collectFiles(fullPath, files);
    else if (EXTENSIONS.has(extensionOf(entry))) files.push(fullPath);
  }
  return files;
}

const violations = [];
for (const root of ROOTS) {
  for (const file of collectFiles(root)) {
    const lineCount = readFileSync(file, "utf8").split(/\r?\n/).length;
    const maxLines = root === "src" ? MAX_SRC_LINES : MAX_TEST_LINES;
    if (lineCount > maxLines) violations.push({ file, lineCount, max: maxLines });
  }
}

if (violations.length > 0) {
  console.error(`File size gate failed: ${violations.length} file(s) exceed limits.`);
  for (const violation of violations) console.error(`${violation.lineCount}/${violation.max}	${violation.file}`);
  process.exit(1);
}

const totalMax = ROOTS.includes("src") ? `${MAX_SRC_LINES}` : "";
console.log(`File size gate passed: no src file exceeds ${MAX_SRC_LINES} lines, no test file exceeds ${MAX_TEST_LINES} lines.`);
