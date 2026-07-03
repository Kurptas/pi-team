#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(repoRoot, "src");
const agentDir = path.join(os.homedir(), ".pi", "agent");
const targetDir = path.join(agentDir, "extensions", "team");
const disabledDir = path.join(agentDir, "extensions-disabled");
const settingsFile = path.join(agentDir, "settings.json");

function stamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        "-",
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join("");
}

function isPackageReferenceToRepo(entry) {
    const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : undefined;
    if (!source) return false;
    if (/^(npm:|git:|https?:|ssh:|git@)/i.test(source)) return false;
    return path.resolve(source) === repoRoot;
}

async function removeLocalPackageReference() {
    try {
        const raw = await fs.readFile(settingsFile, "utf8");
        const settings = JSON.parse(raw);
        if (!Array.isArray(settings.packages)) return 0;
        const before = settings.packages.length;
        settings.packages = settings.packages.filter((entry) => !isPackageReferenceToRepo(entry));
        const removed = before - settings.packages.length;
        if (removed > 0) {
            await fs.writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
        }
        return removed;
    } catch (error) {
        if (error && error.code === "ENOENT") return 0;
        throw error;
    }
}

async function deploy() {
    await fs.access(path.join(sourceDir, "index.ts"));
    const removedPackageRefs = await removeLocalPackageReference();
    await fs.mkdir(disabledDir, { recursive: true });
    try {
        await fs.access(targetDir);
        const backupDir = path.join(disabledDir, `team-${stamp()}`);
        await fs.rename(targetDir, backupDir);
        console.log(`Backed up existing global team extension: ${backupDir}`);
    } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
    console.log(`Deployed pi-team global extension: ${targetDir}`);
    if (removedPackageRefs > 0) {
        console.log(`Removed ${removedPackageRefs} local package reference(s) to avoid tool conflicts.`);
    }
    console.log("Run /reload in Pi to activate the deployed extension.");
}

deploy().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
