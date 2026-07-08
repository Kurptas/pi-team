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
    _wasObserved: boolean,
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

// Single-model convergence: when multiple parallel roles route to the same
// model, the run loses its multi-model perspective. Flag it only when >1 role
// assigned AND another healthy model existed to diversify to — otherwise
// convergence was forced by hardware availability, not a planning miss.
// (2026-07-02 single-model-convergence fix #3; 2026-07-03 项5 suppression.)
export function detectModelConvergence(assignedModels: string[], healthyModelCount: number): string | undefined {
    if (assignedModels.length <= 1) return undefined;
    const distinct = new Set(assignedModels);
    if (distinct.size !== 1 || healthyModelCount <= 1) return undefined;
    return (
        `\u26a0 Model convergence: all ${assignedModels.length} worker(s) routed to ${[...distinct][0]} ` +
        `despite ${healthyModelCount} healthy models available \u2014 multi-model perspective is lost. ` +
        `Consider overriding a role's model or re-planning if diverse viewpoints matter.`
    );
}
