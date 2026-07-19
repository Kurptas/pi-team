import type { Api, Model } from "@earendil-works/pi-ai";
import { profileForModel } from "./capabilities.ts";
import type { ResolvedProbeResult } from "./model-selection.ts";
import type { ModelCapabilityProfile, ModelHealthSnapshot, PlannedRole, TeamModel, TeamPlan } from "./types.ts";

export function modelKey(model: Pick<TeamModel, "provider" | "id">): string {
    return `${model.provider}/${model.id}`;
}

function matchesPreference(model: TeamModel, preference: string): boolean {
    const key = modelKey(model);
    return preference === key || preference === model.id || key.includes(preference);
}

function healthByModel(health: ModelHealthSnapshot[]): Map<string, ModelHealthSnapshot> {
    return new Map(health.map((snapshot) => [snapshot.model, snapshot]));
}

// Only models with objectively dead auth or rejected by the provider are
// excluded from routing.  Timeout / provider_error / probe_skipped are
// treated as "unproven" and remain selectable — the captain decides whether
// to use them with the risk visible in the routing reason.
function isObjectivelyUnavailable(snapshot: ModelHealthSnapshot | undefined): boolean {
    return snapshot?.status === "missing_auth" || snapshot?.status === "model_rejected";
}

export function selectModelForRole(
    role: PlannedRole,
    models: TeamModel[],
    health: ModelHealthSnapshot[],
    usedProviders: Set<string>,
): { model?: TeamModel; fallbackReason?: string; fallbackCandidates?: string[] } {
    if (models.length === 0) return { fallbackReason: "no configured model available" };
    const healthMap = healthByModel(health);
    const selectableModels = models.filter((model) => !isObjectivelyUnavailable(healthMap.get(modelKey(model))));
    if (selectableModels.length === 0) return { fallbackReason: "all configured models are objectively unavailable" };

    const preferredModels = role.modelPreferences.flatMap((preference) =>
        selectableModels.filter((model) => matchesPreference(model, preference)),
    );
    const selected =
        preferredModels.find((model) => !usedProviders.has(model.provider)) ??
        preferredModels[0] ??
        selectableModels.find((model) => !usedProviders.has(model.provider)) ??
        selectableModels[0];
    if (!selected) return { fallbackReason: "no model selected" };
    const preferredKeys = new Set(role.modelPreferences);
    const selectedKey = modelKey(selected);
    const usedFallback =
        role.modelPreferences.length > 0 &&
        !preferredKeys.has(selectedKey) &&
        !role.modelPreferences.includes(selected.id) &&
        !role.modelPreferences.some((preference) => selectedKey.includes(preference));
    return {
        model: selected,
        fallbackReason: usedFallback ? `preferred models unavailable; selected ${selectedKey}` : undefined,
        fallbackCandidates: selectableModels
            .filter((model) => modelKey(model) !== selectedKey)
            .map((model) => modelKey(model))
            .slice(0, 3),
    };
}

function routingReason(role: PlannedRole, model: TeamModel | undefined, profiles: ModelCapabilityProfile[]): string {
    if (!model) return "no model selected";
    const profile = profileForModel(modelKey(model), model.id, profiles);
    const preferenceNote =
        role.modelPreferences.length > 0
            ? `lead preference ${role.modelPreferences.join(", ")}`
            : "no lead model preference supplied";
    const runtimeFacts = `reasoning=${model.reasoning}; context=${model.contextWindow ?? "unknown"}; maxTokens=${model.maxTokens ?? "unknown"}`;
    if (!profile) return `selected ${modelKey(model)}; ${preferenceNote}; ${runtimeFacts}; no local capability facts matched; lead remains final judge`;
    const needs = role.capabilityNeeds.length > 0 ? role.capabilityNeeds.join(", ") : "no role capability tags";
    const strengths = profile.strengths.length > 0 ? `strengths=${profile.strengths.join(", ")}` : "strengths=(none)";
    const cautions = profile.cautions.length > 0 ? `cautions=${profile.cautions.join(", ")}` : "cautions=(none)";
    return `selected ${modelKey(model)}; ${preferenceNote}; capability facts from ${profile.displayName}: requested=${needs}; ${strengths}; ${cautions}; lead remains final judge`;
}

export function routeTeamPlan(
    plan: TeamPlan,
    models: TeamModel[],
    health: ModelHealthSnapshot[],
    profiles: ModelCapabilityProfile[] = [],
    resolvedProbe?: ResolvedProbeResult,
): TeamPlan {
    const selectionMap = new Map(
        (resolvedProbe?.rolePlans ?? []).map((rp) => [rp.roleId, rp]),
    );
    const rounds = plan.rounds.map((round) => {
        const usedProviders = new Set<string>();
        const roles = round.roles.map((role) => {
            // If we have a resolved probe result for this role, use it directly
            const resolved = selectionMap.get(role.roleId);
            if (resolved && resolved.selectedModel) {
                const [provider] = resolved.selectedModel.split("/");
                usedProviders.add(provider);
                return {
                    ...role,
                    selectedModel: resolved.selectedModel,
                    thinkingLevel: resolved.selectedThinkingLevel ?? role.thinkingLevel,
                    modelFallbackKeys: resolved.fallbackModels,
                    routingReason: resolved.routingReason,
                    policyReason: resolved.policyReason,
                };
            }

            // If the productized probe/selection path resolved this role, respect
            // that human/captain-facing policy result. Do not let the legacy
            // broad fallback silently replace a strict or cheap_only decision.
            if (resolved) {
                const policyNotes = [resolved.policyReason, resolved.warnings.join("; ")].filter(Boolean).join("; ");
                return {
                    ...role,
                    fallbackReason: policyNotes || undefined,
                    thinkingLevel: resolved.selectedThinkingLevel ?? role.thinkingLevel,
                    routingReason: resolved.routingReason,
                    policyReason: resolved.policyReason,
                    skipReason: resolved.selectedModel ? undefined : (policyNotes || "no selected model"),
                };
            }

            // Legacy path
            const selected = selectModelForRole(role, models, health, usedProviders);
            if (selected.model) {
                usedProviders.add(selected.model.provider);
                return {
                    ...role,
                    selectedModel: modelKey(selected.model),
                    fallbackReason: selected.fallbackReason,
                    modelFallbackKeys: selected.fallbackCandidates,
                    routingReason: routingReason(role, selected.model, profiles),
                };
            }
            return {
                ...role,
                fallbackReason: selected.fallbackReason,
                routingReason: routingReason(role, undefined, profiles),
            };
        });
        return { ...round, roles };
    });
    return { ...plan, rounds };
}

export function toTeamModels(models: Model<Api>[]): TeamModel[] {
    return models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
    }));
}
