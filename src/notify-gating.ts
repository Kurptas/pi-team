// Notification / push gating helpers (2026-07-04, extracted from index.ts to
// keep that file under the size gate). All pure functions — no side effects,
// no I/O — so they are independently unit-testable. index.ts re-exports them
// so existing callers and tests keep their import path.

// Background push: deliverAs followUp so the captain's next turn wakes.
export function completionPush(runId: string, status: string, workerSummary: string): string {
    return [
        `[pi-team] Background team run ${runId} finished with status: ${status}.`,
        workerSummary,
        `You are still the captain. Inspect it with team_status(runId="${runId}") and wrap up: judge whether the evidence satisfies the task, decide if another pass is needed, and deliver the final answer.`,
    ].join("\n");
}

// completionPush gating (2026-07-04 P0 fix): a TERMINAL transition
// (succeeded/degraded/failed) always pushes; only an explicit captain cancel
// suppresses. Previously `!wasObserved` ate successful/degraded pushes after a
// single team_status poll — the captain forgets to keep polling (real incident).
// `_wasObserved` retained in the signature for callers but no longer gates.
export function shouldPushCompletion(wasCanceled: boolean, _wasObserved: boolean, status: string): boolean {
    if (wasCanceled) return false;
    return status === "succeeded" || status === "degraded" || status === "failed";
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
