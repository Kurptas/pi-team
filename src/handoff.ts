import * as fs from "node:fs";
import * as path from "node:path";
import { teamControlPaths, teamRunLogDir } from "./control.ts";
import type { TeamRun, WorkerRun } from "./types.ts";

/**
 * Handoff digest — a *factual* run summary for durable resume / handoff.
 *
 * AI-first boundary: this module never synthesizes a semantic verdict about
 * what the run "means" or whether the evidence is sufficient. It aggregates
 * recorded facts (status, model, output kind, usage, artifact pointers) and
 * hands them to a captain — human or agent — who owns the semantic judgment.
 * The captain reads the per-worker artifact files for full output; the digest
 * only points at them.
 */

export function handoffPath(cwd: string, runId: string): string {
    return path.join(teamControlPaths(cwd, runId).activeDir, "handoff.md");
}

function workerLine(worker: WorkerRun): string {
    const model = worker.model ?? "(unassigned)";
    const kind = worker.outputKind ?? "n/a";
    const usage = `req:${worker.requests ?? 0} tok:${worker.tokens ?? 0}${(worker.costUsd ?? 0) > 0 ? ` cost:$${(worker.costUsd ?? 0).toFixed(4)}` : ""}`;
    const reason = worker.errorReason ? ` — ${worker.errorReason}` : "";
    const artifact = worker.outputFile ? `\n  - output: ${worker.outputFile}` : "";
    return `- **${worker.title}** (${worker.roleId}): ${worker.status} [${kind}] · ${model} · ${usage}${reason}${artifact}`;
}

/**
 * Build a factual handoff digest. Pure function: no I/O, no semantic judgment.
 * Counts are derived from recorded worker status fields only.
 */
export function buildHandoffDigest(run: TeamRun): string {
    const workers = run.workers ?? [];
    const counts = {
        total: workers.length,
        succeeded: workers.filter((w) => w.status === "succeeded").length,
        failed: workers.filter((w) => w.status === "failed").length,
        degraded: workers.filter((w) => w.status === "degraded").length,
        skipped: workers.filter((w) => w.status === "skipped").length,
    };
    const warnings = [
        ...(run.planGraph?.warnings ?? []),
        ...(run.planGraph?.errors ?? []).map((e) => `graph error: ${e}`),
    ];
    const lanes = run.delegationLanes ?? [];
    const lines: string[] = [
        `# Team Handoff — ${run.runId}`,
        "",
        `Status: ${run.status}`,
        `Playbook: ${run.playbookId}`,
        `Fallback policy: ${run.fallbackPolicy ?? "task_first"}`,
        `Result availability: ${run.resultAvailability ?? "n/a"}`,
        "",
        "## Task",
        "",
        run.task.trim() || "(no task recorded)",
        "",
        "## Workers",
        "",
        counts.total > 0
            ? `Counts: total:${counts.total} succeeded:${counts.succeeded} failed:${counts.failed} degraded:${counts.degraded} skipped:${counts.skipped}`
            : "(no workers recorded)",
        "",
        ...workers.map(workerLine),
        "",
        "## Evidence signals (facts, not verdict)",
        "",
        run.evidenceCompleteness
            ? `- evidenceRefs:${run.evidenceCompleteness.hasEvidenceRefs} limitations:${run.evidenceCompleteness.hasLimitations} confidence:${run.evidenceCompleteness.hasConfidence} openQuestions:${run.evidenceCompleteness.hasOpenQuestions}`
            : "- (no evidence completeness recorded)",
        warnings.length > 0 ? `- warnings: ${warnings.join(" | ")}` : "- warnings: (none)",
        lanes.length > 0
            ? `- delegation lanes: ${lanes.length} (complete:${lanes.filter((l) => l.ackState === "complete").length} partial:${lanes.filter((l) => l.ackState === "partial").length})`
            : "- delegation lanes: (none)",
        "",
        "## Captain next step",
        "",
        "This digest is factual only. To resume, read the per-worker artifact",
        "files above for full output, then form your own semantic judgment about",
        "whether the evidence is sufficient or another pass is needed.",
        run.logFile ? `\nFull run log: ${run.logFile}` : "",
    ];
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Write the handoff digest to the run's active dir. Returns the path written,
 * or undefined if the write failed (handoff is best-effort and never blocks a
 * run's terminal outcome).
 */
export async function writeHandoff(cwd: string, run: TeamRun): Promise<string | undefined> {
    try {
        const target = handoffPath(cwd, run.runId);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, buildHandoffDigest(run), "utf-8");
        return target;
    } catch {
        return undefined;
    }
}

/**
 * Read a previously written handoff digest. Falls back to undefined when no
 * digest exists (e.g. an old run from before this feature, or a run that never
 * reached a terminal state). The caller can then rebuild from run state.
 */
export async function readHandoff(cwd: string, runId: string): Promise<string | undefined> {
    const candidates = [
        handoffPath(cwd, runId),
        path.join(teamRunLogDir(cwd), `${runId}.handoff.md`),
    ];
    for (const candidate of candidates) {
        try {
            return await fs.promises.readFile(candidate, "utf-8");
        } catch {
            // try next candidate
        }
    }
    return undefined;
}
