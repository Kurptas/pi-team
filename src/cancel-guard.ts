import type { TeamRun } from "./types.ts";

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
                `execution this round and produces NO new evidence. If a worker looks stale, confirm it is ` +
                `genuinely stuck (live:stuck across MULTIPLE polls, not a first-poll silence while it composes ` +
                `a long answer) before canceling. To proceed, call again with confirm:true.`,
        };
    }
    return { ok: true };
}
