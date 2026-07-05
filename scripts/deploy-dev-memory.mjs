#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = path.join(repoRoot, "project-support", "dev-memory-extension", "index.ts");
const targetFile = path.join(repoRoot, ".pi", "extensions", "dev-memory.ts");

async function deploy() {
	await fs.copyFile(sourceFile, targetFile);
	console.log("已部署到 .pi/extensions/dev-memory.ts，请 /reload 生效");
}

deploy().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
