import { profileForModel } from "./capabilities.ts";
import { parseConfiguredModelPreference } from "./model-selector.ts";
import type {
    FallbackPolicy,
    ModelCapabilityProfile,
    ModelHealthSnapshot,
    ModelProbeStatus,
    PlannedRole,
    TeamModel,
    ThinkingLevel,
} from "./types.ts";

export interface ConfiguredModel {
    key: string;
    provider: string;
    id: string;
    name: string;
}

export interface RoleModelCandidate {
    key: string;
    source: "user" | "metadata" | "fallback";
    warning?: string;
    /** A recent real worker, not a synthetic probe, produced a soft failure. */
    probeDegraded?: boolean;
    thinkingLevel?: ThinkingLevel;
    matchReason: string;
}

export interface RoleModelPlan {
    roleId: string;
    title: string;
    candidates: RoleModelCandidate[];
    failedUserPreferences: string[];
}

export interface ProbeSet {
    models: ConfiguredModel[];
    fallbackPolicy: FallbackPolicy;
    rolePlans?: RoleModelPlan[];
    warnings: string[];
}

function effectiveThinkingLevel(role: PlannedRole): ThinkingLevel | undefined {
    return role.thinkingLevel;
}

function totalCost(model: TeamModel | undefined): number | undefined {
    if (!model) return undefined;
    const total = model.cost.input + model.cost.output + model.cost.cacheRead + model.cost.cacheWrite;
    return Number.isFinite(total) && total > 0 ? total : undefined;
}

function runtimeModelFor(configured: ConfiguredModel, runtimeModels: TeamModel[]): TeamModel | undefined {
    return runtimeModels.find((model) => model.provider === configured.provider && model.id === configured.id);
}

function cheapRuntimeKeys(configured: ConfiguredModel[], runtimeModels: TeamModel[]): Set<string> {
    const priced = configured
        .map((model) => ({ key: model.key, cost: totalCost(runtimeModelFor(model, runtimeModels)) }))
        .filter((entry): entry is { key: string; cost: number } => entry.cost !== undefined)
        .sort((a, b) => a.cost - b.cost);
    if (priced.length === 0) return new Set();
    const cutoff = priced[Math.floor((priced.length - 1) / 2)]!.cost;
    return new Set(priced.filter((entry) => entry.cost <= cutoff).map((entry) => entry.key));
}

const REASONING_NEEDS = new Set(["coding", "research", "fact_checking", "synthesis", "critical_review"]);

function metadataScore(
    role: PlannedRole,
    configured: ConfiguredModel,
    runtimeModels: TeamModel[],
    profiles: ModelCapabilityProfile[],
): { score: number; reason: string } {
    const runtime = runtimeModelFor(configured, runtimeModels);
    const profile = runtime ? profileForModel(configured.key, configured.id, profiles) : undefined;
    const needs = role.capabilityNeeds;
    let score = 0;
    const evidence: string[] = [];

    const profileMatches = needs.filter((need) => profile?.capabilities.includes(need));
    if (profileMatches.length > 0) {
        score += profileMatches.length * 5;
        evidence.push(`local capability match=${profileMatches.join(",")}`);
    }

    if (runtime?.reasoning && needs.some((need) => REASONING_NEEDS.has(need))) {
        score += 2;
        evidence.push("reasoning-capable");
    }

    if (runtime && needs.includes("long_context")) {
        const maxContext = Math.max(...runtimeModels.map((model) => model.contextWindow || 0), 1);
        score += 4 * ((runtime.contextWindow ?? 0) / maxContext);
        evidence.push(`context=${runtime.contextWindow ?? "unknown"}`);
    }

    if (runtime && needs.includes("synthesis")) {
        const maxOutput = Math.max(...runtimeModels.map((model) => model.maxTokens || 0), 1);
        score += 2 * ((runtime.maxTokens ?? 0) / maxOutput);
        evidence.push(`maxTokens=${runtime.maxTokens ?? "unknown"}`);
    }

    if (needs.includes("cost_efficiency")) {
        const costs = runtimeModels.map(totalCost).filter((value): value is number => value !== undefined);
        const cost = totalCost(runtime);
        if (cost !== undefined && costs.length > 0) {
            const min = Math.min(...costs);
            const max = Math.max(...costs);
            score += max === min ? 2 : 4 * ((max - cost) / (max - min));
            evidence.push(`relativeCost=${cost.toFixed(4)}`);
        }
    }

    if (needs.includes("speed")) {
        // No static model-name guess. Runtime latency evidence is handled by the
        // health cache; without measured evidence, configured order is the tie-breaker.
        evidence.push("speed=unmeasured");
    }

    if (needs.length === 0) evidence.push("no capability tags");
    if (!runtime) evidence.push("runtime metadata unavailable");
    return { score, reason: evidence.join("; ") || "runtime metadata tie" };
}

export function selectModelsToProbe(
    roles: PlannedRole[],
    configured: ConfiguredModel[],
    fallbackPolicy: FallbackPolicy = "task_first",
    directDispatch = false,
    runtimeModels: TeamModel[] = [],
    profiles: ModelCapabilityProfile[] = [],
): ProbeSet {
    const warnings: string[] = [];
    const configuredSet = new Set(configured.map((model) => model.key));
    const cheapKeys = cheapRuntimeKeys(configured, runtimeModels);
    const providerUse = new Map<string, number>();
    const rolePlans: RoleModelPlan[] = [];

    if (directDispatch) {
        warnings.push("direct-dispatch: the captain specified each role's primary model; only primaries are probed and backups remain lazy.");
    }

    for (const role of roles) {
        const candidates: RoleModelCandidate[] = [];
        const added = new Set<string>();
        const failedUserPreferences: string[] = [];

        for (const preference of role.modelPreferences) {
            const parsed = parseConfiguredModelPreference(
                preference,
                (model) => configuredSet.has(model) || configured.some((item) => item.id === model),
            );
            const model = configured.find((item) => item.key === parsed.model) ?? configured.find((item) => item.id === parsed.model);
            if (!model) {
                failedUserPreferences.push(preference);
                continue;
            }
            const thinkingLevel = effectiveThinkingLevel(role) ?? parsed.thinkingLevel;
            candidates.push({
                key: model.key,
                source: "user",
                thinkingLevel,
                matchReason: thinkingLevel ? `captain preference; thinking=${thinkingLevel}` : "captain preference",
            });
            added.add(model.key);
        }

        const blockedByStrictPolicy = fallbackPolicy === "strict"
            && role.modelPreferences.length > 0
            && failedUserPreferences.length > 0
            && candidates.length === 0;
        const automaticPool = fallbackPolicy === "cheap_only"
            ? configured.filter((model) => cheapKeys.has(model.key))
            : configured;
        if (fallbackPolicy === "cheap_only" && automaticPool.length === 0 && !blockedByStrictPolicy) {
            warnings.push(`${role.title}: cheap_only found no models with usable runtime cost metadata; no name-based cost guess was made.`);
        }

        const allowAutomaticCandidates = !blockedByStrictPolicy
            && !(fallbackPolicy === "strict" && role.modelPreferences.length > 0);
        if (allowAutomaticCandidates) {
            const ranked = automaticPool
                .filter((model) => !added.has(model.key))
                .map((model, index) => ({
                    model,
                    index,
                    ...metadataScore(role, model, runtimeModels, profiles),
                }))
                .sort((a, b) =>
                    b.score - a.score
                    || (providerUse.get(a.model.provider) ?? 0) - (providerUse.get(b.model.provider) ?? 0)
                    || a.index - b.index,
                );
            const addRankedCandidate = (rankedModel: (typeof ranked)[number]): void => {
                if (candidates.length >= 3 || added.has(rankedModel.model.key)) return;
                candidates.push({
                    key: rankedModel.model.key,
                    source: candidates.length === 0 && role.modelPreferences.length === 0 ? "metadata" : "fallback",
                    thinkingLevel: effectiveThinkingLevel(role),
                    matchReason: `${fallbackPolicy === "cheap_only" ? "runtime-cost pool" : "runtime metadata"}; score=${rankedModel.score.toFixed(2)}; ${rankedModel.reason}`,
                });
                added.add(rankedModel.model.key);
            };

            // Establish the primary first, then reserve remaining candidate
            // slots for the same model id through other providers/channels.
            if (candidates.length === 0 && ranked[0]) addRankedCandidate(ranked[0]);
            const primaryModel = candidates[0]
                ? configured.find((model) => model.key === candidates[0]!.key)
                : undefined;
            if (primaryModel) {
                for (const rankedModel of ranked) {
                    if (candidates.length >= 3) break;
                    if (rankedModel.model.id === primaryModel.id && rankedModel.model.provider !== primaryModel.provider) {
                        addRankedCandidate(rankedModel);
                    }
                }
            }
            for (const rankedModel of ranked) {
                if (candidates.length >= 3) break;
                addRankedCandidate(rankedModel);
            }
        }

        const primary = candidates[0];
        const primaryModel = primary ? configured.find((model) => model.key === primary.key) : undefined;
        if (primaryModel) providerUse.set(primaryModel.provider, (providerUse.get(primaryModel.provider) ?? 0) + 1);
        rolePlans.push({ roleId: role.roleId, title: role.title, candidates, failedUserPreferences });
    }

    const primaryKeys = new Set(rolePlans.map((plan) => plan.candidates[0]?.key).filter((key): key is string => Boolean(key)));
    return {
        models: configured.filter((model) => primaryKeys.has(model.key)),
        fallbackPolicy,
        rolePlans,
        warnings,
    };
}

function probeIsHardFail(status: ModelProbeStatus | undefined): boolean {
    return status === "missing_auth" || status === "model_rejected";
}

function probeIsDegraded(status: ModelProbeStatus | undefined): boolean {
    return status === "timeout" || status === "rate_limited" || status === "provider_error";
}

function probeWarning(
    status: ModelProbeStatus | undefined,
    reason?: string,
    source: ModelHealthSnapshot["evidenceSource"] = "probe",
): string | undefined {
    if (status === undefined) return "not probed (lazy fallback)";
    if (status === "probe_passed") return undefined;
    if (status === "probe_skipped") return "not probed";
    const label = source === "worker" ? "recent worker" : "probe";
    if (status === "timeout") return `${label} timeout`;
    if (status === "provider_error") return `${label} error: ${reason?.slice(0, 60) ?? ""}`;
    if (status === "rate_limited") return `${label} rate limited`;
    return `${label} status: ${status}`;
}

export interface ResolvedRolePlan {
    roleId: string;
    title: string;
    selectedModel?: string;
    selectedThinkingLevel?: ThinkingLevel;
    fallbackModels: string[];
    failedUserPreferences: string[];
    degradedUserPreferences: string[];
    routingReason: string;
    hardFailedModels: string[];
    warnings: string[];
    policyReason?: string;
}

export interface ResolvedProbeResult {
    rolePlans: ResolvedRolePlan[];
    fallbackPolicy: FallbackPolicy;
    warnings: string[];
}

export function resolveProbeResults(probeSet: ProbeSet, health: ModelHealthSnapshot[]): ResolvedProbeResult {
    const healthMap = new Map(health.map((snapshot) => [snapshot.model, snapshot]));
    const warnings = [...probeSet.warnings];
    if (probeSet.fallbackPolicy === "strict") warnings.push("fallbackPolicy=strict: configured models are not substituted for unavailable explicit preferences.");
    if (probeSet.fallbackPolicy === "cheap_only") warnings.push("fallbackPolicy=cheap_only: automatic fallback is limited by runtime cost metadata.");

    const rolePlans: ResolvedRolePlan[] = (probeSet.rolePlans ?? []).map((plan) => {
        const hardFailedModels: string[] = [];
        const strictWorkerFailedPreferences: string[] = [];
        const workingCandidates: RoleModelCandidate[] = [];
        const roleWarnings: string[] = [];

        for (const candidate of plan.candidates) {
            const snapshot = healthMap.get(candidate.key);
            if (probeIsHardFail(snapshot?.status)) {
                hardFailedModels.push(candidate.key);
                roleWarnings.push(`${candidate.key} ${snapshot?.status === "missing_auth" ? "is missing authentication" : "was rejected by the provider"}`);
                continue;
            }
            const warning = probeWarning(snapshot?.status, snapshot?.reason, snapshot?.evidenceSource);
            const workerDegraded = probeIsDegraded(snapshot?.status) && snapshot?.evidenceSource === "worker";
            if (probeSet.fallbackPolicy === "strict" && candidate.source === "user" && workerDegraded) {
                strictWorkerFailedPreferences.push(candidate.key);
                roleWarnings.push(`${candidate.key} has a recent real-worker failure; strict policy requires captain override or skip`);
                continue;
            }
            workingCandidates.push({
                ...candidate,
                warning,
                probeDegraded: workerDegraded,
                matchReason: warning ? `${candidate.matchReason} (warning: ${warning})` : candidate.matchReason,
            });
        }

        workingCandidates.sort((a, b) => {
            const healthDifference = Number(a.probeDegraded === true) - Number(b.probeDegraded === true);
            if (healthDifference !== 0) return healthDifference;
            const sourceOrder = { user: 0, metadata: 1, fallback: 2 };
            return sourceOrder[a.source] - sourceOrder[b.source];
        });

        const selectedCandidate = workingCandidates[0];
        const selectedModel = selectedCandidate?.key;
        const selectedThinkingLevel = selectedCandidate?.thinkingLevel;
        const fallbackModels = workingCandidates.slice(1, 4).map((candidate) => candidate.key);
        const degradedUserPreferences = strictWorkerFailedPreferences.length > 0 && selectedCandidate?.source !== "user"
            ? strictWorkerFailedPreferences
            : workingCandidates
                .filter((candidate) => candidate.source === "user" && candidate.probeDegraded && candidate.key !== selectedModel)
                .map((candidate) => candidate.key);

        if (workingCandidates.length === 0) {
            roleWarnings.push("no selectable model");
            if (plan.failedUserPreferences.length > 0) {
                roleWarnings.push(`captain preferences unavailable: ${plan.failedUserPreferences.join(", ")}`);
            }
        } else if (selectedCandidate?.probeDegraded && selectedCandidate.warning) {
            roleWarnings.push(`all candidates have recent worker failures; still selecting ${selectedCandidate.key} (${selectedCandidate.warning}) for captain review`);
        }

        if (plan.failedUserPreferences.length > 0) {
            warnings.push(`${plan.title}: captain preference not configured or unavailable: ${plan.failedUserPreferences.join(", ")}${selectedModel ? `; candidate=${selectedModel}` : "; no substitute"}`);
        }

        const policyReason = selectedModel
            ? `policy=${probeSet.fallbackPolicy}; selected via ${selectedCandidate?.source ?? "unknown"}${selectedThinkingLevel ? `; thinking=${selectedThinkingLevel}` : ""}; captain remains final judge`
            : probeSet.fallbackPolicy === "strict" && plan.failedUserPreferences.length > 0
              ? `policy=strict; captain preference unavailable (${plan.failedUserPreferences.join(", ")}); no automatic substitution`
              : probeSet.fallbackPolicy === "strict" && strictWorkerFailedPreferences.length > 0
                ? `policy=strict; explicit preference has a recent real-worker failure (${strictWorkerFailedPreferences.join(", ")}); captain override required`
                : probeSet.fallbackPolicy === "cheap_only"
                ? "policy=cheap_only; no runtime-cost candidate available; no model-name guessing"
                : `policy=${probeSet.fallbackPolicy}; no candidate selected`;

        const routingReason = selectedModel
            ? [
                  policyReason,
                  workingCandidates.slice(0, 3)
                      .map((candidate) => `${candidate.source}: ${candidate.key}${candidate.warning ? ` (warning: ${candidate.warning})` : ""}`)
                      .join(" | "),
              ].join("; ")
            : hardFailedModels.length > 0
              ? `${policyReason}; excluded=${hardFailedModels.join(", ")}`
              : `${policyReason}; no selectable model`;

        return {
            roleId: plan.roleId,
            title: plan.title,
            selectedModel,
            selectedThinkingLevel,
            fallbackModels,
            failedUserPreferences: plan.failedUserPreferences,
            degradedUserPreferences,
            routingReason,
            policyReason,
            hardFailedModels,
            warnings: roleWarnings,
        };
    });

    for (const plan of rolePlans) {
        if (plan.warnings.length > 0) warnings.push(`${plan.title}: ${plan.warnings.join("; ")}`);
    }
    return {
        rolePlans,
        fallbackPolicy: probeSet.fallbackPolicy,
        warnings,
    };
}
