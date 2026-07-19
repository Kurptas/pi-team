// Plan→probe orchestration (2026-07-03 项6 探测顺序方案B).
// Extracted from index.ts to keep that file under the size-gate limit.
// The revision loop (re-plan with unavailableModels) stays in index.ts so
// the createSemanticPlan/createTeamPlan closure is not threaded through here.
import { selectModelsToProbe, resolveProbeResults, type ConfiguredModel, type ProbeSet, type ResolvedProbeResult } from "./model-selection.ts";
import { probeModels, type ProbeModel } from "./prober.ts";
import { freshModelHealth, recordModelHealth } from "./model-health-cache.ts";
import type { FallbackPolicy, ModelCapabilityProfile, ModelHealthSnapshot, PlannedRole, TeamModel, TeamPlan } from "./types.ts";

export interface ProbeResult {
    probeSet: ProbeSet;
    modelHealth: ModelHealthSnapshot[];
    resolved: ResolvedProbeResult;
    deadBlueprintModels: string[]; // recent worker-failed or hard-failed blueprint models
}

export async function probePlan(
    plan: TeamPlan,
    configuredModels: ConfiguredModel[],
    availableModels: TeamModel[],
    fallbackPolicy: FallbackPolicy,
    directDispatch: boolean,
    probe: ProbeModel,
    signal?: AbortSignal,
    useHealthCache = true,
    capabilityProfiles: ModelCapabilityProfile[] = [],
): Promise<ProbeResult> {
    const allRoles: PlannedRole[] = plan.rounds.flatMap((round) => round.roles);
    const probeSet = selectModelsToProbe(
        allRoles, configuredModels, fallbackPolicy, directDispatch, availableModels, capabilityProfiles,
    );

    const targetKeys = probeSet.models.map((model) => model.key);
    const candidateKeys = new Set((probeSet.rolePlans ?? []).flatMap((role) => role.candidates.map((candidate) => candidate.key)));
    const cachedHealth = useHealthCache ? freshModelHealth(candidateKeys) : [];
    const cachedKeys = new Set(cachedHealth.map((snapshot) => snapshot.model));
    const candidatesToProbe = availableModels.filter((model) =>
        targetKeys.includes(`${model.provider}/${model.id}`) && !cachedKeys.has(`${model.provider}/${model.id}`),
    );
    const rawProbeHealth: ModelHealthSnapshot[] =
        candidatesToProbe.length === 0 ? [] : await probeModels(candidatesToProbe, probe, signal);
    const probedHealth = rawProbeHealth.map((snapshot) => ({ ...snapshot, evidenceSource: "probe" as const }));
    if (useHealthCache) for (const snapshot of probedHealth) recordModelHealth(snapshot);
    const modelHealth = [...cachedHealth, ...probedHealth];

    const resolved = resolveProbeResults(probeSet, modelHealth);
    // Only hard failures or recent real-worker failures become unavailable constraints.
    const dead = new Set<string>();
    for (const rolePlan of resolved.rolePlans) {
        for (const pref of rolePlan.failedUserPreferences) dead.add(pref);
        for (const deg of rolePlan.degradedUserPreferences) dead.add(deg);
        for (const hard of rolePlan.hardFailedModels) dead.add(hard);
    }
    return { probeSet, modelHealth, resolved, deadBlueprintModels: [...dead] };
}
