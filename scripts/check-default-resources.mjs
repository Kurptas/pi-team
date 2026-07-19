#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = path.join(root, "src", "defaults");
const failures = [];
const allowedCapabilities = new Set([
    "coding", "research", "fact_checking", "synthesis", "chinese_writing",
    "tool_use", "long_context", "speed", "cost_efficiency", "critical_review",
]);
const expectedRoles = new Set([
    "architect-reviewer", "code-path-tracer", "evidence-checker", "fix-validator", "implementer",
    "log-reader", "perspective-advocate", "reviewer", "risk-reviewer", "risk-skeptic",
    "scout", "synthesizer", "test-runner",
]);
const expectedPlaybooks = new Set([
    "code-review", "debug-triage", "implementation-review-gate", "multi-angle-review", "research-roundtable",
]);

function markdownFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) markdownFiles(file, out);
        else if (entry.isFile() && entry.name.endsWith(".md")) out.push(file);
    }
    return out;
}

function idsIn(dir) {
    return new Set(fs.readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
}

function sameSet(actual, expected) {
    return actual.size === expected.size && [...actual].every((item) => expected.has(item));
}

const roleDir = path.join(defaults, "roles");
const playbookDir = path.join(defaults, "playbooks");
const roles = idsIn(roleDir);
const playbooks = idsIn(playbookDir);
if (!sameSet(roles, expectedRoles)) failures.push(`role set mismatch: ${[...roles].sort().join(", ")}`);
if (!sameSet(playbooks, expectedPlaybooks)) failures.push(`playbook set mismatch: ${[...playbooks].sort().join(", ")}`);

for (const file of markdownFiles(defaults)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    if (/[\u3400-\u9fff]/.test(text)) failures.push(`${relative}: canonical runtime Markdown contains CJK text`);
    if (/^\s*-\s+[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*\s*$/im.test(text)) {
        failures.push(`${relative}: contains a concrete provider/model list item`);
    }
}

for (const roleId of roles) {
    const file = path.join(roleDir, `${roleId}.md`);
    const text = fs.readFileSync(file, "utf8");
    if (/^model_preferences\s*:/mi.test(text)) failures.push(`${roleId}: built-in roles must not declare model_preferences`);
    const match = text.match(/^capability_needs\s*:\s*\[([^\]]*)\]/mi);
    if (!match) {
        failures.push(`${roleId}: missing inline capability_needs`);
        continue;
    }
    const values = match[1].split(",").map((item) => item.trim()).filter(Boolean);
    if (values.length === 0) failures.push(`${roleId}: capability_needs is empty`);
    for (const value of values) if (!allowedCapabilities.has(value)) failures.push(`${roleId}: invalid capability ${value}`);
}

for (const playbookId of playbooks) {
    const file = path.join(playbookDir, `${playbookId}.md`);
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*roles\s*:\s*\[([^\]]*)\]/gmi)) {
        for (const roleId of match[1].split(",").map((item) => item.trim()).filter(Boolean)) {
            if (!roles.has(roleId)) failures.push(`${playbookId}: references missing role ${roleId}`);
        }
    }
}

for (const retired of ["model-recommendations.json", "model-capabilities.json", "captain-manual.md"]) {
    if (fs.existsSync(path.join(defaults, retired))) failures.push(`retired shipped default still exists: ${retired}`);
}
for (const source of ["src/planner.ts", "src/semantic-planner.ts", "src/model-selection.ts"]) {
    if (/[\u3400-\u9fff]/.test(fs.readFileSync(path.join(root, source), "utf8"))) {
        failures.push(`${source}: canonical runtime source contains CJK text`);
    }
}
const indexSource = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
if (indexSource.includes("QUICK_MODELS")) failures.push("src/index.ts: concrete quick-model defaults are forbidden");

if (failures.length > 0) {
    console.error("Default resource gate failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log(`Default resource gate passed: ${roles.size} model-neutral roles, ${playbooks.size} playbooks, English canonical prompts.`);
