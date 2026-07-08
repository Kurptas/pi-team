import { readFileSync } from "node:fs";
import { join } from "node:path";
import { taskThinkingLevel } from "./coding-thinking.ts";
import { parseConfiguredModelPreference } from "./model-selector.ts";
import type { FallbackPolicy, ModelHealthSnapshot, ModelProbeStatus, PlannedRole, ThinkingLevel } from "./types.ts";

// ---------------------------------------------------------------------------
// Recommendation data
// ---------------------------------------------------------------------------

interface RecommendationEntry {
    rank: number;
    key: string;
    roles: string[];
    strength: string;
    speed: "fastest" | "fast" | "medium" | "slow";
    costTier: "budget" | "efficient" | "standard" | "premium";
}

interface RecommendationsDoc {
    generatedAt: string;
    version: string;
    recommendations: RecommendationEntry[];
}

const RECOMMENDATION_MAX_AGE_DAYS = 15;

function loadRecommendations(defaultsDir: string): RecommendationsDoc | null {
    try {
        return JSON.parse(readFileSync(join(defaultsDir, "model-recommendations.json"), "utf-8")) as RecommendationsDoc;
    } catch {
        return null;
    }
}

function recommendationAgeDays(doc: RecommendationsDoc): number {
    const generated = new Date(doc.generatedAt).getTime();
    if (Number.isNaN(generated)) return Number.POSITIVE_INFINITY;
    return (Date.now() - generated) / (1000 * 60 * 60 * 24);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfiguredModel {
    key: string;
    provider: string;
    id: string;
    name: string;
}

export interface RoleModelCandidate {
    key: string;
    source: "recommendation" | "user" | "user_default" | "fallback";
    recommendationRank?: number;
    strength?: string;
    speed?: string;
    costTier?: string;
    warning?: string;
    /** True only for genuine availability degradation (timeout / rate_limited /
     * provider_error). probe_skipped is NOT degraded — it is unproven, and must
     * stay in the healthy tier so we never re-rank a captain choice on a
     * non-availability signal. */
    probeDegraded?: boolean;
    thinkingLevel?: ThinkingLevel;
    matchReason: string;
}

export interface RoleModelPlan {
    roleId: string;
    title: string;
    candidates: RoleModelCandidate[];
    /** User-specified models that aren't configured or are hard-unavailable */
    failedUserPreferences: string[];
}

export interface ProbeSet {
    /** Models to probe, deduplicated by key */
    models: ConfiguredModel[];
    fallbackPolicy: FallbackPolicy;
    /** Per-role candidate lists (only filled after probe) */
    rolePlans?: RoleModelPlan[];
    recommendationAgeDays: number;
    recommendationStale: boolean;
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Step 1: progressive model selection — user → recommendation → fallback
// ---------------------------------------------------------------------------

// AI-first guardrail: cheap_only uses explicit recommendation metadata only;
// it never guesses cost/quality from model-name keywords.
function isCheapRecommendation(entry: RecommendationEntry): boolean {
    return (entry.costTier === "budget" || entry.costTier === "efficient") && entry.speed !== "slow";
}

function cheapRecommendationKeys(doc: RecommendationsDoc | null): Set<string> {
    return new Set((doc?.recommendations ?? []).filter(isCheapRecommendation).map((entry) => entry.key));
}

// Resolve the effective thinking level for a candidate, applying per-model
// recommended thinking levels for coding roles.
function effectiveThinkingLevel(role: PlannedRole, modelKey: string): ThinkingLevel | undefined {
    if (role.capabilityNeeds.includes("coding")) {
        return taskThinkingLevel(modelKey, "coding") ?? role.thinkingLevel;
    }
    return role.thinkingLevel;
}

export function selectModelsToProbe(
    roles: PlannedRole[],
    configured: ConfiguredModel[],
    defaultsDir: string,
    fallbackPolicy: FallbackPolicy = "task_first",
    directDispatch = false,
): ProbeSet {
    const recommendations = loadRecommendations(defaultsDir);
    const ageDays = recommendations ? recommendationAgeDays(recommendations) : Number.POSITIVE_INFINITY;
    const stale = ageDays > RECOMMENDATION_MAX_AGE_DAYS;
    const warnings: string[] = [];

    if (stale && recommendations) {
        warnings.push(
            `推荐数据已过期 ${Math.round(ageDays)} 天(>${RECOMMENDATION_MAX_AGE_DAYS}天限制)，已跳过推荐数据，直接使用配置模型。建议 captain 联网搜索最新模型排名。`,
        );
    }

    const configuredSet = new Set(configured.map((m) => m.key));
    const cheapKeys = stale ? new Set<string>() : cheapRecommendationKeys(recommendations);
    const rolePlans: RoleModelPlan[] = [];
    if (fallbackPolicy === "cheap_only" && stale && recommendations) {
        warnings.push("cheap_only fallbackPolicy 不使用过期推荐元数据判断低成本模型；等待 captain/用户显式选择或更新推荐表。");
    }
    if (directDispatch) {
        warnings.push("direct-dispatch 直通档：captain 已为每个 role 明确指定模型，仅探测这些指定模型是否存活，跳过推荐表/fallback 候选扩展。");
    }

    for (const role of roles) {
        const candidates: RoleModelCandidate[] = [];
        const added = new Set<string>();
        const failedUserPreferences: string[] = [];

        // ---- Level 1: user preferences ----
        for (const pref of role.modelPreferences) {
            const parsed = parseConfiguredModelPreference(pref, (model) => configuredSet.has(model) || configured.some((m) => m.id === model));
            if (!configuredSet.has(parsed.model) && !configured.some((m) => m.id === parsed.model)) {
                failedUserPreferences.push(pref);
                continue;
            }
            const model = configured.find((m) => m.key === parsed.model) ?? configured.find((m) => m.id === parsed.model);
            if (!model) continue;
            candidates.push({ key: model.key, source: "user", thinkingLevel: parsed.thinkingLevel ?? effectiveThinkingLevel(role, model.key), matchReason: parsed.thinkingLevel ? `用户指定偏好; thinking=${parsed.thinkingLevel}` : "用户指定偏好" });
            added.add(model.key);
        }


        const blockedByStrictPolicy = fallbackPolicy === "strict" && role.modelPreferences.length > 0 && failedUserPreferences.length > 0 && candidates.length === 0;
        // For non-strict policies we always want at least one healthy backup
        // candidate so a probe-failed top pick (timeout/rate_limit/provider_error)
        // does not get dispatched blind. strict keeps exact user/recommendation
        // candidates only (no arbitrary substitution).
        const wantBackup = fallbackPolicy !== "strict";
        const MIN_CANDIDATES = 3;

        // ---- Level 2: recommendation table ----
        // Runs when there is no primary candidate, OR (non-strict) to top up
        // healthy backups behind a user preference. Direct-dispatch skips this:
        // the captain fully specified per-role models, so we probe ONLY those
        // (no recommendation/fallback expansion) — a channel confirming the
        // captain's exact choices is alive, not a re-selection.
        if (!directDispatch && !blockedByStrictPolicy && !stale && recommendations && (candidates.length === 0 || wantBackup)) {
            const recs = recommendations.recommendations
                .filter((entry) => entry.roles.includes(role.roleId))
                .filter((entry) => configuredSet.has(entry.key))
                .filter((entry) => fallbackPolicy !== "cheap_only" || isCheapRecommendation(entry))
                .sort((a, b) => a.rank - b.rank);

            for (const rec of recs.slice(0, 5)) {
                if (candidates.length >= MIN_CANDIDATES) break;
                if (added.has(rec.key)) continue;
                candidates.push({
                    key: rec.key,
                    source: "recommendation",
                    recommendationRank: rec.rank,
                    strength: rec.strength,
                    speed: rec.speed,
                    costTier: rec.costTier,
                    thinkingLevel: effectiveThinkingLevel(role, rec.key),
                    matchReason: [`推荐#${rec.rank}`, rec.strength, `速度:${rec.speed}`, `成本:${rec.costTier}`, effectiveThinkingLevel(role, rec.key) ? `thinking=${effectiveThinkingLevel(role, rec.key)}` : "", stale ? "(数据已过期)" : ""].filter(Boolean).join("; "),
                });
                added.add(rec.key);
            }
        }

        // ---- Level 2.5: configured default only when no recommendation matched ----
        // The original design is: captain explicit preference > fresh recommendation
        // metadata > configured default/fallback. Do NOT let configured[0] bypass
        // the model capability/recommendation document when that document is fresh
        // and role-matched. If nothing matched (or recommendations are stale/missing),
        // expose that fact in the reason and fall back to configured order.
        if (candidates.length === 0 && role.modelPreferences.length === 0 && configured.length > 0 && fallbackPolicy !== "cheap_only") {
            const defaultModel = configured[0]!;
            candidates.push({
                key: defaultModel.key,
                source: "user_default",
                thinkingLevel: effectiveThinkingLevel(role, defaultModel.key),
                matchReason: recommendations && !stale
                    ? "配置默认模型（无角色匹配的推荐元数据）"
                    : "配置默认模型（推荐数据缺失或过期）",
            });
            added.add(defaultModel.key);
        }

        // ---- Level 3: fallback — fills remaining slots up to MIN_CANDIDATES ----
        // Skipped under direct-dispatch for the same reason as Level 2.
        if (!directDispatch && fallbackPolicy !== "strict" && candidates.length < MIN_CANDIDATES) {
            const fallbackModels = fallbackPolicy === "cheap_only"
                ? configured.filter((model) => cheapKeys.has(model.key))
                : configured;
            if (fallbackPolicy === "cheap_only" && fallbackModels.length === 0 && candidates.length === 0) {
                warnings.push(`${role.title}: cheap_only fallbackPolicy 没有显式低成本/快速元数据匹配，未用关键词猜测模型成本。`);
            }
            for (const model of fallbackModels) {
                if (candidates.length >= MIN_CANDIDATES) break;
                if (added.has(model.key)) continue;
                candidates.push({ key: model.key, source: "fallback", thinkingLevel: effectiveThinkingLevel(role, model.key), matchReason: [fallbackPolicy === "cheap_only" ? "cheap_only 策略低成本降级" : "无推荐匹配，从配置中选取", effectiveThinkingLevel(role, model.key) ? `thinking=${effectiveThinkingLevel(role, model.key)}` : ""].filter(Boolean).join("; ") });
                added.add(model.key);
            }
        }

        rolePlans.push({ roleId: role.roleId, title: role.title, candidates, failedUserPreferences });
    }

    // Deduplicate: only probe models that actually appear in any role's candidate list
    const allCandidateKeys = new Set(rolePlans.flatMap((p) => p.candidates.map((c) => c.key)));
    const modelsToProbe = configured.filter((m) => allCandidateKeys.has(m.key));

    return {
        models: modelsToProbe,
        fallbackPolicy,
        rolePlans,
        recommendationAgeDays: ageDays,
        recommendationStale: stale,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Step 2: after probe, filter candidates to working models
// ---------------------------------------------------------------------------

function probeIsHardFail(status: ModelProbeStatus | undefined): boolean {
    return status === "missing_auth" || status === "model_rejected";
}

// Genuine availability degradation that should sink a candidate below healthy
// peers. probe_skipped is NOT degraded (it is "unproven", not "unavailable")
// and must stay in the healthy tier per the routing contract.
function probeIsDegraded(status: ModelProbeStatus | undefined): boolean {
    return status === "timeout" || status === "rate_limited" || status === "provider_error";
}

function probeWarning(status: ModelProbeStatus | undefined, reason?: string): string | undefined {
    if (!status || status === "probe_passed") return undefined;
    if (status === "probe_skipped") return "未探测";
    if (status === "timeout") return `探测超时`;
    if (status === "provider_error") return `探测错误: ${reason?.slice(0, 60) ?? ""}`;
    return `探测状态: ${status}`;
}

export interface ResolvedRolePlan {
    roleId: string;
    title: string;
    selectedModel?: string;
    selectedThinkingLevel?: ThinkingLevel;
    fallbackModels: string[];
    failedUserPreferences: string[];
    /**
     * Configured user-preference models that probe-degraded and were demoted
     * below a healthy backup. Surfaced so the caller can route them through the
     * captain decision window instead of silently substituting an explicit
     * choice on a soft probe signal.
     */
    degradedUserPreferences: string[];
    routingReason: string;
    /** Models excluded because probe failed (missing_auth/model_rejected) */
    hardFailedModels: string[];
    warnings: string[];
    policyReason?: string;
}

export interface ResolvedProbeResult {
    rolePlans: ResolvedRolePlan[];
    fallbackPolicy: FallbackPolicy;
    recommendationAgeDays: number;
    recommendationStale: boolean;
    warnings: string[];
}

export function resolveProbeResults(
    probeSet: ProbeSet,
    health: ModelHealthSnapshot[],
): ResolvedProbeResult {
    const healthMap = new Map(health.map((h) => [h.model, h]));
    const warnings = [...probeSet.warnings];
    if (probeSet.fallbackPolicy === "strict") warnings.push("fallbackPolicy=strict：不会使用配置模型自动降级。");
    if (probeSet.fallbackPolicy === "cheap_only") warnings.push("fallbackPolicy=cheap_only：自动降级仅限低成本/快速模型。");

    const rolePlans: ResolvedRolePlan[] = (probeSet.rolePlans ?? []).map((plan) => {
        const hardFailedModels: string[] = [];
        const workingCandidates: RoleModelCandidate[] = [];
        const roleWarnings: string[] = [];

        for (const candidate of plan.candidates) {
            const snapshot = healthMap.get(candidate.key);
            if (probeIsHardFail(snapshot?.status)) {
                hardFailedModels.push(candidate.key);
                roleWarnings.push(
                    `${candidate.key} ${snapshot?.status === "missing_auth" ? "缺少API密钥" : "被提供商拒绝"}`,
                );
                continue;
            }
            const pw = probeWarning(snapshot?.status, snapshot?.reason);
            workingCandidates.push({
                ...candidate,
                warning: pw,
                probeDegraded: probeIsDegraded(snapshot?.status),
                matchReason: pw ? `${candidate.matchReason} (⚠️ ${pw})` : candidate.matchReason,
            });
        }

        // Sort: probe health is an availability gate that outranks preference
        // order. Only a genuinely degraded candidate (timeout / rate_limited /
        // provider_error) is demoted; probe_passed AND probe_skipped (unproven,
        // not unavailable) both stay in the healthy tier, so an auto-probed
        // model never silently outranks an unprobed one. Within the same health
        // tier we keep the intended preference order: explicit user choice >
        // fresh role recommendation > configured-order fallback > broad fallback.
        // This is an availability decision, not a quality judgment about which
        // model is "better" — the captain still owns that.
        workingCandidates.sort((a, b) => {
            const healthRank = (c: RoleModelCandidate) => (c.probeDegraded ? 1 : 0);
            const h = healthRank(a) - healthRank(b);
            if (h !== 0) return h;
            const sourceOrder = { user: 0, recommendation: 1, user_default: 2, fallback: 3 };
            const s = sourceOrder[a.source] - sourceOrder[b.source];
            if (s !== 0) return s;
            return (a.recommendationRank ?? 99) - (b.recommendationRank ?? 99);
        });

        const selectedCandidate = workingCandidates[0];
        const selectedModel = selectedCandidate?.key;
        const selectedThinkingLevel = selectedCandidate?.thinkingLevel;
        const fallbackModels = workingCandidates.slice(1, 4).map((c) => c.key);

        // A configured user preference that probe-degraded and got demoted below
        // a healthy backup is a *silent substitution* of an explicit choice. We
        // surface those keys so the caller can route them through the captain
        // decision window instead of auto-substituting — the captain may insist
        // on the degraded model or accept the backup. (If the selected model IS
        // the degraded user candidate, no substitution happened.)
        const degradedUserPreferences = workingCandidates
            .filter((c) => (c.source === "user" || c.source === "user_default") && c.probeDegraded && c.key !== selectedModel)
            .map((c) => c.key);

        if (workingCandidates.length === 0) {
            roleWarnings.push("无可用模型");
            if (plan.failedUserPreferences.length > 0) {
                roleWarnings.push(`用户指定模型不可用: ${plan.failedUserPreferences.join(", ")}`);
            }
        } else if (selectedCandidate?.warning) {
            // Every candidate is probe-degraded; we still dispatch the best one
            // but flag that no probe-healthy model was available for the role.
            roleWarnings.push(
                `所有候选模型探测均未通过，已选择 ${selectedCandidate.key}（${selectedCandidate.warning}）；captain 可改派或重试`,
            );
        }

        if (plan.failedUserPreferences.length > 0) {
            warnings.push(
                `${plan.title}: 用户指定模型未配置或不可用: ${plan.failedUserPreferences.join(", ")}${selectedModel ? ` → 使用 ${selectedModel}` : "，无替代"}`,
            );
        }

        const policyReason = selectedModel
            ? `policy=${probeSet.fallbackPolicy}; selected via ${selectedCandidate?.source ?? "unknown"}${selectedThinkingLevel ? `; thinking=${selectedThinkingLevel}` : ""}; captain remains final judge`
            : probeSet.fallbackPolicy === "strict" && plan.failedUserPreferences.length > 0
              ? `policy=strict; user preference unavailable (${plan.failedUserPreferences.join(", ")}); no automatic substitution`
              : probeSet.fallbackPolicy === "cheap_only"
                ? "policy=cheap_only; no explicit low-cost/fast metadata matched or all candidates failed; no keyword guessing"
                : `policy=${probeSet.fallbackPolicy}; no working candidate selected`;

        const routingReason = selectedModel
            ? [
                  policyReason,
                  workingCandidates
                      .slice(0, 3)
                      .map((c) => `${c.source === "recommendation" ? `推荐#${c.recommendationRank ?? "?"}` : c.source === "user_default" ? "默认模型" : c.source}: ${c.key}${c.warning ? ` (⚠️)` : ""}`)
                      .join(" | "),
              ].join("; ")
            : hardFailedModels.length > 0
              ? `${policyReason}; 全部排除: ${hardFailedModels.join(", ")}`
              : `${policyReason}; 无可用模型`;

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
        if (plan.warnings.length > 0) {
            warnings.push(`${plan.title}: ${plan.warnings.join("; ")}`);
        }
    }

    return {
        rolePlans,
        fallbackPolicy: probeSet.fallbackPolicy,
        recommendationAgeDays: probeSet.recommendationAgeDays,
        recommendationStale: probeSet.recommendationStale,
        warnings,
    };
}
