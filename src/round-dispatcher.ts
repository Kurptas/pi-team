// Round dispatcher (A-1 refactoring). Extracted from runner.ts to keep
// that file under the size-gate limit. Pure executor: dispatches a single
// PlannedRound (parallel / fanout / single / chain) using the provided
// context. The runner owns the while-loop and the spawn mailbox polling.
import { planFanoutDispatch } from "./fanout.ts";
import { roleWithPriorFindings } from "./run-outcome.ts";
import { dedupRoundRoles, mapWithConcurrency } from "./runner.ts";
import type { PlannedRole, PlannedRound, TeamEvent, WorkerRun } from "./types.ts";

export interface RoundDispatchContext {
    runRole: (role: PlannedRole) => Promise<WorkerRun>;
    workers: WorkerRun[];
    activeWorkers: Map<string, WorkerRun>;
    roundCompleted: Map<string, WorkerRun>;
    visibleWorkers: () => WorkerRun[];
    updateAndPersist: (event: TeamEvent, nextRun?: any) => any;
    maxConcurrency: number;
}

export async function dispatchRound(round: PlannedRound, ctx: RoundDispatchContext): Promise<WorkerRun[]> {
    const { roles: roundRoles, dropped: droppedDuplicates } = dedupRoundRoles(round.roles);
    ctx.updateAndPersist({ phase: "round-start", message: `${round.id} (${round.type}) with ${roundRoles.length} role(s): ${round.goal ?? "no round goal"}${droppedDuplicates > 0 ? ` (dropped ${droppedDuplicates} duplicate roleId(s))` : ""}`, isError: droppedDuplicates > 0 });
    if (round.type === "parallel") {
        ctx.roundCompleted.clear();
        const roundWorkers = await mapWithConcurrency(roundRoles, ctx.maxConcurrency, async (role: PlannedRole) => {
            const result = await ctx.runRole(role);
            ctx.activeWorkers.delete(role.roleId);
            ctx.roundCompleted.set(role.roleId, result);
            ctx.updateAndPersist({ phase: "round-progress", message: `${ctx.roundCompleted.size} worker(s) completed`, roleId: role.roleId, model: role.selectedModel, status: result.status });
            return result;
        });
        ctx.workers.push(...roundWorkers);
        ctx.roundCompleted.clear();
        ctx.updateAndPersist({ phase: "round-end", message: `${round.id} completed` });
        return roundWorkers;
    }
    if (round.type === "fanout") {
        const dispatch = planFanoutDispatch(round, roundRoles, ctx.workers);
        if (dispatch.kind === "abort") { ctx.updateAndPersist(dispatch.event); ctx.updateAndPersist({ phase: "round-end", message: `${round.id} completed` }); return []; }
        for (const preEvent of dispatch.preEvents) ctx.updateAndPersist(preEvent);
        ctx.roundCompleted.clear();
        const fanoutWorkers = await mapWithConcurrency(dispatch.roles, ctx.maxConcurrency, async (role: PlannedRole) => {
            const result = await ctx.runRole(roleWithPriorFindings(role, ctx.workers));
            ctx.activeWorkers.delete(role.roleId);
            ctx.roundCompleted.set(role.roleId, result);
            ctx.updateAndPersist({ phase: "round-progress", message: `${ctx.roundCompleted.size} fanout worker(s) completed`, roleId: role.roleId, model: role.selectedModel, status: result.status });
            return result;
        });
        ctx.workers.push(...fanoutWorkers);
        ctx.roundCompleted.clear();
        if (dispatch.collectEvent) ctx.updateAndPersist(dispatch.collectEvent);
        ctx.updateAndPersist({ phase: "round-end", message: `${round.id} completed` });
        return fanoutWorkers;
    }
    const roundWorkers: WorkerRun[] = [];
    for (const role of roundRoles) {
        const result = await ctx.runRole(roleWithPriorFindings(role, ctx.workers));
        ctx.activeWorkers.delete(role.roleId);
        ctx.workers.push(result);
        roundWorkers.push(result);
        ctx.updateAndPersist({ phase: "round-progress", message: `${ctx.workers.length} worker(s) completed`, roleId: role.roleId, model: role.selectedModel, status: result.status });
    }
    ctx.updateAndPersist({ phase: "round-end", message: `${round.id} completed` });
    return roundWorkers;
}
