import type { PlannedRound, TeamPlan } from "./types.ts";

// Dependency-graph scheduling helpers (2026-07-03 A-2). Extracted from the
// runner main loop as PURE functions so the chain/parallel/diamond scheduling
// behavior is unit-testable. The runner owns the mutable queue + execution; it
// consults these predicates to decide dispatch order. A round is dispatchable
// only when EVERY blocker of EVERY role in it has completed — checking "the
// role's own blockedBy set is fully satisfied", NOT "the role itself has no
// blockers" (an earlier inversion deadlocked chains and re-queued roots).

/** True when every blocker of every role in the round has completed. */
export function roundDepsSatisfied(
    plan: Pick<TeamPlan, "blockedBy">,
    round: PlannedRound,
    completedRoleIds: ReadonlySet<string>,
): boolean {
    return round.roles.every((role) => {
        const deps = plan.blockedBy?.get(role.roleId);
        return !deps || [...deps].every((d) => completedRoleIds.has(d));
    });
}

/** Rounds to seed the initial queue: no dependency graph → all rounds in order;
 * otherwise only rounds whose blockers are already satisfied (empty at start). */
export function initialQueue(plan: Pick<TeamPlan, "blockedBy" | "rounds">): PlannedRound[] {
    if (!plan.blockedBy) return [...plan.rounds];
    const empty = new Set<string>();
    return plan.rounds.filter((r) => roundDepsSatisfied(plan, r, empty));
}

/** Rounds newly dispatchable after some roles completed: dependency satisfied,
 * not already dispatched, not already queued. Returns rounds to append. */
export function newlySchedulableRounds(
    plan: Pick<TeamPlan, "blockedBy" | "rounds">,
    completedRoleIds: ReadonlySet<string>,
    dispatchedRoundIds: ReadonlySet<string>,
    queuedRoundIds: ReadonlySet<string>,
): PlannedRound[] {
    if (!plan.blockedBy) return [];
    const out: PlannedRound[] = [];
    for (const round of plan.rounds) {
        if (dispatchedRoundIds.has(round.id)) continue;
        if (queuedRoundIds.has(round.id)) continue;
        if (roundDepsSatisfied(plan, round, completedRoleIds)) out.push(round);
    }
    return out;
}

/** Rounds never dispatched because a blocker never satisfied — e.g. an upstream
 * role failed/was skipped, so its downstream dependency is unmet. The runner
 * treats "completed" as "succeeded" (MINOR fix): a failed upstream does NOT
 * unblock downstream, which then stays here. Reported for captain visibility
 * rather than silently dropped. (2026-07-03 A-2 MINOR: success-gated deps.) */
export function undispatchedRounds(
    plan: Pick<TeamPlan, "blockedBy" | "rounds">,
    dispatchedRoundIds: ReadonlySet<string>,
): PlannedRound[] {
    return plan.rounds.filter((r) => !dispatchedRoundIds.has(r.id));
}
