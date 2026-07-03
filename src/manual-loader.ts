// Manual loader (2026-07-04 项8 step 2). Reads role manuals and SOP files
// from src/defaults/manuals/ and prepares system-prompt injection content.
// Keeps raw file bytes out of the runner loop — only the derived injection
// string enters the worker session.
//
// Injection rules (C-scheme from design doc):
//   - auto-inject:true manuals matching the worker role are always prepended
//   - captain-specified sop:[] entries are appended after the base manual
//   - total injected content is soft-warned at 1100 tokens, hard-capped at 1600
//     (approximated as chars/4 to avoid a tiktoken dependency; see HARD_CAP_TOKENS)
//
// Token approximation: 1 token ≈ 4 chars (conservative for mixed CJK/Latin).
// This is intentionally imprecise — the point is to catch runaway injections,
// not to produce exact counts.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ManualFrontmatter {
    id: string;
    title: string;
    role: "captain" | "worker" | "both";
    "auto-inject": boolean;
    version: string;
    description?: string;
    "token-budget"?: number;
    "applies-to"?: string[];
}

export interface LoadedManual {
    frontmatter: ManualFrontmatter;
    body: string;
    /** Approximate token count (chars / 4). */
    approxTokens: number;
    filePath: string;
}

// Caps recalibrated 2026-07-04 for English manuals. The chars/4 estimator badly
// underestimated CJK (1 char ≈ 1-2 tokens counted as 0.25), so the old 800/600
// caps silently fit oversized Chinese manuals; English exposes real size. Budget
// target: always-on worker playbook (~400) + one relevant SOP (~600) must fit
// without a warning, and up to two SOPs must not be hard-dropped.
const HARD_CAP_TOKENS = 1600;
const SOFT_WARN_TOKENS = 1100;

/** Parse YAML frontmatter from a markdown file. Returns null if no frontmatter. */
function parseFrontmatter(content: string): { fm: Record<string, unknown>; body: string } | null {
    if (!content.startsWith("---")) return null;
    const end = content.indexOf("\n---", 3);
    if (end === -1) return null;
    const fmText = content.slice(3, end).trim();
    const body = content.slice(end + 4).trimStart();
    // Minimal YAML key:value parser — handles string, boolean, number, string arrays.
    const fm: Record<string, unknown> = {};
    for (const line of fmText.split("\n")) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (!m) continue;
        const [, key, raw] = m;
        if (raw === "true") fm[key] = true;
        else if (raw === "false") fm[key] = false;
        else if (/^\d+$/.test(raw)) fm[key] = parseInt(raw, 10);
        else if (raw.startsWith("[") && raw.endsWith("]")) {
            fm[key] = raw.slice(1, -1).split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
        } else fm[key] = raw.replace(/^['"]|['"]$/g, "");
    }
    return { fm, body };
}

function approxTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Load a single manual file. Returns null if the file is missing or unparseable. */
export function loadManual(filePath: string): LoadedManual | null {
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        return null;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;
    const fm = parsed.fm as unknown as ManualFrontmatter;
    if (!fm.id || !fm.role) return null;
    return { frontmatter: fm, body: parsed.body, approxTokens: approxTokens(parsed.body), filePath };
}

/** Build the system-prompt injection string for a worker role.
 *
 * @param defaultsDir  Path to the defaults directory (contains manuals/).
 * @param sopIds       SOP ids requested by the captain via role.sop.
 * @param warnings     Mutable array; push-appended when token budget is exceeded.
 */
export function buildWorkerInjection(
    defaultsDir: string | undefined,
    sopIds: string[] = [],
    warnings: string[] = [],
): string {
    if (!defaultsDir) return "";
    const manualsDir = path.join(defaultsDir, "manuals");
    const workerPlaybookPath = path.join(manualsDir, "worker", "01-worker-playbook.md");

    const parts: string[] = [];
    let totalTokens = 0;

    // 1. Auto-inject worker playbook
    const playbook = loadManual(workerPlaybookPath);
    if (playbook && playbook.frontmatter["auto-inject"] === true) {
        parts.push(playbook.body.trim());
        totalTokens += playbook.approxTokens;
    }

    // 2. Append captain-requested SOPs
    for (const sopId of sopIds) {
        const sopPath = path.join(manualsDir, "sop", `${sopId}.md`);
        const sop = loadManual(sopPath);
        if (!sop) {
            warnings.push(`SOP '${sopId}' not found at ${sopPath} — skipped`);
            continue;
        }
        const newTotal = totalTokens + sop.approxTokens;
        if (newTotal > HARD_CAP_TOKENS) {
            warnings.push(
                `SOP '${sopId}' skipped: injecting it would exceed the ${HARD_CAP_TOKENS}-token hard cap ` +
                `(current ~${totalTokens}, SOP ~${sop.approxTokens})`,
            );
            continue;
        }
        parts.push(`---\n${sop.body.trim()}`);
        totalTokens = newTotal;
    }

    // 3. Soft warn
    if (totalTokens > SOFT_WARN_TOKENS) {
        warnings.push(
            `Injected manual content is ~${totalTokens} tokens (soft limit: ${SOFT_WARN_TOKENS}). ` +
            `Consider trimming worker-playbook or SOP files.`,
        );
    }

    return parts.join("\n\n");
}
