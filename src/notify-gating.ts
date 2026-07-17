// Notification / push gating helpers (2026-07-04, extracted from index.ts to
// keep that file under the size gate). All pure functions — no side effects,
// no I/O — so they are independently unit-testable. index.ts re-exports them
// so existing callers and tests keep their import path.

// Background push: deliverAs followUp so the captain's next turn wakes.
export function completionPush(runId: string, status: string, workerSummary: string): string {
    return [
        `[pi-team auto] Background team run ${runId} finished with status: ${status}.`,
        workerSummary,
        `You are still the captain. Inspect it with team_status(runId="${runId}") and wrap up: judge whether the evidence satisfies the task, decide if another pass is needed, and deliver the final answer.`,
    ].join("\n");
}

// completionPush gating (2026-07-04/08): polling a RUNNING background run
// must not swallow its terminal reminder (captains often forget to keep
// polling). But once the captain has already observed the TERMINAL state via
// team_status, a second success/degraded follow-up is duplicate noise. Failed
// terminal states still push unless explicitly canceled.
export function shouldPushCompletion(
    wasCanceled: boolean,
    status: string,
    wasTerminalObserved = false,
): boolean {
    if (wasCanceled) return false;
    if (status === "failed") return true;
    if (wasTerminalObserved) return false;
    return status === "succeeded" || status === "degraded";
}

export function completionPushDelayMs(options: {
    wasObserved: boolean;
    lastObservedAt?: number;
    now: number;
    shortGraceMs: number;
    watchedGraceMs: number;
    recentObservationMs: number;
}): number {
    const { wasObserved, lastObservedAt, now, shortGraceMs, watchedGraceMs, recentObservationMs } = options;
    const recentlyObserved = lastObservedAt !== undefined && now - lastObservedAt < recentObservationMs;
    return wasObserved || recentlyObserved ? watchedGraceMs : shortGraceMs;
}

// Model diversity loss: compare assigned diversity with the maximum diversity
// possible from role count and healthy models. This catches partial collapse
// (for example 4 requested roles routed to only 2 models), not only 4→1.
export function detectModelConvergence(
    assignedModels: string[],
    healthyModelCount: number,
    intendedDistinctModelCount = healthyModelCount,
): string | undefined {
    if (assignedModels.length <= 1) return undefined;
    const distinct = new Set(assignedModels);
    const possibleDistinct = Math.min(assignedModels.length, Math.max(healthyModelCount, intendedDistinctModelCount));
    if (distinct.size >= possibleDistinct) return undefined;
    return (
        `\u26a0 Model diversity reduced: ${assignedModels.length} worker(s) use ${distinct.size} distinct model(s) ` +
        `against a target of ${possibleDistinct} healthy/requested model(s). ` +
        `Review fallback routing before dispatch if independent model perspectives matter.`
    );
}
