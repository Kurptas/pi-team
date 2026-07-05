// Plan→probe orchestration (2026-07-03 项6 探测顺序方案B).
// Extracted from index.ts to keep that file under the size-gate limit.
// The revision loop (re-plan with unavailableModels) stays in index.ts so
// the createSemanticPlan/createTeamPlan closure is not threaded through here.
import { selectModelsToProbe, resolveProbeResults, type ConfiguredModel, type ProbeSet, type ResolvedProbeResult } from "./model-selection.ts";
import { probeModels, type ProbeModel } from "./prober.ts";
import type { FallbackPolicy, ModelHealthSnapshot, PlannedRole, TeamModel, TeamPlan } from "./types.ts";

export interface ProbeResult {
    probeSet: ProbeSet;
    modelHealth: ModelHealthSnapshot[];
    resolved: ResolvedProbeResult;
    deadBlueprintModels: string[]; // probe-degraded or hard-failed models from the blueprint
}

export async function probePlan(
    plan: TeamPlan,
    configuredModels: ConfiguredModel[],
    availableModels: TeamModel[],
    defaultsDir: string,
    fallbackPolicy: FallbackPolicy,
    directDispatch: boolean,
    probe: ProbeModel,
    signal?: AbortSignal,
): Promise<ProbeResult> {
    const allRoles: PlannedRole[] = plan.rounds.flatMap((round) => round.roles);
    const probeSet = selectModelsToProbe(allRoles, configuredModels, defaultsDir, fallbackPolicy, directDispatch);

    const candidatesToProbe = availableModels.filter((m) =>
        probeSet.models.some((pm) => pm.key === `${m.provider}/${m.id}`),
    );
    const modelHealth: ModelHealthSnapshot[] =
        candidatesToProbe.length === 0
            ? []
            : await probeModels(candidatesToProbe, probe, signal);

    const resolved = resolveProbeResults(probeSet, modelHealth);
    // Collect blueprint-suggested models that are now known-dead so the caller
    // can pass them back to the semantic-planner as unavailable constraints (方案B).
    const dead = new Set<string>();
    for (const rolePlan of resolved.rolePlans) {
        for (const pref of rolePlan.failedUserPreferences) dead.add(pref);
        for (const deg of rolePlan.degradedUserPreferences) dead.add(deg);
        for (const hard of rolePlan.hardFailedModels) dead.add(hard);
    }
    return { probeSet, modelHealth, resolved, deadBlueprintModels: [...dead] };
}
