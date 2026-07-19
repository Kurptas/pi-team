// Worker liveness tracking (backlog 项9): distinguish "silent but progressing"
// from "no recorded delta". A worker composing a long single message fires no
// session events, so its signal age goes stale even though it may still be alive.
// Token/request/event deltas across observations are corroborating evidence only.
// This module never decides that a worker is stuck or changes execution.

export interface LivenessSnapshot {
    tokens: number;
    requests: number;
    eventCount: number;
    at: number;
}

export interface LivenessDelta {
    deltaTokens: number;
    deltaRequests: number;
    deltaEvents: number;
    sinceMs: number | undefined;
}

export type LivenessClass = "active" | "progressing" | "no_delta";

// runId -> roleId -> last-poll snapshot.
const livenessStore = new Map<string, Map<string, LivenessSnapshot>>();

/**
 * Record the current per-worker usage and return deltas vs the previous poll,
 * keyed by roleId. First poll for a worker yields zero deltas and undefined
 * sinceMs. After computing deltas, the stored snapshot is updated to the current
 * values so the next poll compares against this one.
 */
export function recordAndDiffLiveness(
    runId: string,
    workers: Array<{ roleId: string; tokens: number; requests: number; eventCount: number }>,
    now = Date.now(),
): Map<string, LivenessDelta> {
    let runSnapshots = livenessStore.get(runId);
    if (!runSnapshots) {
        runSnapshots = new Map<string, LivenessSnapshot>();
        livenessStore.set(runId, runSnapshots);
    }
    const deltas = new Map<string, LivenessDelta>();
    for (const worker of workers) {
        const prev = runSnapshots.get(worker.roleId);
        if (prev === undefined) {
            deltas.set(worker.roleId, {
                deltaTokens: 0,
                deltaRequests: 0,
                deltaEvents: 0,
                sinceMs: undefined,
            });
        } else {
            deltas.set(worker.roleId, {
                deltaTokens: worker.tokens - prev.tokens,
                deltaRequests: worker.requests - prev.requests,
                deltaEvents: worker.eventCount - prev.eventCount,
                sinceMs: Math.max(0, now - prev.at),
            });
        }
        runSnapshots.set(worker.roleId, {
            tokens: worker.tokens,
            requests: worker.requests,
            eventCount: worker.eventCount,
            at: now,
        });
    }
    return deltas;
}

/**
 * Classify liveness from the stale flag and per-poll deltas:
 * - not stale -> "active" (recent event signal, obviously alive)
 * - stale but any delta grew -> "progressing" (silent but advancing since last poll)
 * - stale and all deltas zero -> "no_delta" (factual signal, not a verdict)
 */
export function classifyLiveness(
    stale: boolean,
    deltaTokens: number,
    deltaRequests: number,
    deltaEvents: number,
): LivenessClass {
    if (!stale) return "active";
    if (deltaTokens > 0 || deltaRequests > 0 || deltaEvents > 0) return "progressing";
    return "no_delta";
}

/** Drop a run's snapshots. Call when a run terminates to avoid leaking state. */
export function clearLiveness(runId: string): void {
    livenessStore.delete(runId);
}

/**
 * Compact liveness tag for a running worker's team_status line, e.g.
 * " live:progressing(Δtok:1234,Δreq:1)", " live:no-delta(0/0 since 45s)",
 * " live:active", or " live:first-poll".
 */
export function formatLivenessTag(stale: boolean, diff: LivenessDelta | undefined): string {
    if (diff === undefined || diff.sinceMs === undefined) {
        // First observation has no comparison baseline.
        return " live:first-poll";
    }
    const dTok = diff.deltaTokens;
    const dReq = diff.deltaRequests;
    const dEvt = diff.deltaEvents;
    const state = classifyLiveness(stale, dTok, dReq, dEvt);
    if (state === "progressing") return ` live:progressing(\u0394tok:${dTok},\u0394req:${dReq})`;
    if (state === "no_delta") {
        const since = diff.sinceMs !== undefined ? Math.round(diff.sinceMs / 1000) : "?";
        return ` live:no-delta(0/0 since ${since}s)`;
    }
    return " live:active";
}
