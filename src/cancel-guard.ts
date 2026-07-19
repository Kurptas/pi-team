import type { TeamRun, WorkerRun } from "./types.ts";

// Same normalization the planner uses to derive roleId from a raw id/title
// (planner.ts slug()). Kept in sync so a captain can cancel by the id they
// authored, the slugified roleId shown in team_status, or the worker title —
// without guessing the exact separator style. Control reliability > input
// pedantry: a cancel that fails on a separator mismatch undermines captain
// control at the moment it matters most.
function normalizeRoleKey(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
}

// Resolve a captain-supplied worker key to an actual worker. Tolerant by
// design: exact roleId first (fast path), then normalized roleId/title. The
// tolerant path must be UNIQUE; if two workers collapse to the same key, fail
// closed rather than canceling the wrong teammate.
export type ResolvedWorker =
    | { kind: "found"; worker: WorkerRun; matchedBy: "exact" | "roleId" | "title" }
    | { kind: "ambiguous"; candidates: Array<{ roleId: string; title: string }> }
    | { kind: "not_found" };

export function resolveWorkerByKey(workers: WorkerRun[], key: string): ResolvedWorker {
    const exact = workers.find((w) => w.roleId === key);
    if (exact) return { kind: "found", worker: exact, matchedBy: "exact" };
    const normalized = normalizeRoleKey(key);
    const matches = workers.filter(
        (w) => normalizeRoleKey(w.roleId) === normalized || normalizeRoleKey(w.title) === normalized,
    );
    if (matches.length === 1) {
        const worker = matches[0];
        const matchedBy = normalizeRoleKey(worker.roleId) === normalized ? "roleId" : "title";
        return { kind: "found", worker, matchedBy };
    }
    if (matches.length > 1) {
        return { kind: "ambiguous", candidates: matches.map((w) => ({ roleId: w.roleId, title: w.title })) };
    }
    return { kind: "not_found" };
}

export type CancelWorkerGuard =
    | { ok: true }
    | { ok: false; message: string; runningCount: number };

// Rigid-loop guard (2026-07-04 P1 rigid-loop roundtable). Canceling the LAST
// running worker ends all live execution this round and yields no new evidence
// — a high-loss, irreversible action. The tool does NOT judge whether the
// worker is worthless (that stays the captain's call); it only forces the
// captain to see the consequence and confirm. Any other running worker
// remaining → no guard (canceling one of many is routine).
export function guardCancelLastWorker(
    workers: Pick<TeamRun, "workers">["workers"],
    roleId: string,
    runId: string,
    confirmed: boolean,
): CancelWorkerGuard {
    const runningCount = workers.filter((w) => w.status === "running").length;
    // === 1, not <= 1: only guard when this genuinely IS the last running worker.
    // runningCount === 0 means nothing is running (target already ended / not
    // running), so "LAST running worker" would be a misleading message.
    // (2026-07-04: found by the SOP A/B observation — both reviewers flagged it.)
    if (runningCount === 1 && !confirmed) {
        return {
            ok: false,
            runningCount,
            message:
                `⚠ ${roleId} is the LAST running worker in run ${runId}. Canceling it ends all live ` +
                `execution this round and produces NO new evidence. Treat live:no-delta as corroborating ` +
                `evidence, not a stuck verdict; weigh communication age, pending requests, last tool, scope, ` +
                `and cost before canceling. To proceed, call again with confirm:true.`,
        };
    }
    return { ok: true };
}
