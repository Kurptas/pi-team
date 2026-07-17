import type { TeamPlan } from "./types.ts";

export interface AffectedModelRole {
    roleId: string;
    preferences: string[];
}

export interface RejectedModelOverride {
    roleId: string;
    model: string;
    reason: "model_not_configured" | "invalid_model_key" | "role_not_affected" | "role_required";
}

export type ParsedRoleModelOverrides = Map<string, string> & { rejected: RejectedModelOverride[] };

/**
 * Parse role-specific captain overrides from a team_message.
 * Syntax: roleId=provider/model. Multiple pairs may appear in one message.
 * A bare model key is accepted only when exactly one role is affected.
 */
export function parseRoleModelOverrides(
    message: string,
    affectedRoles: AffectedModelRole[],
    configuredKeys: string[],
): ParsedRoleModelOverrides {
    const overrides = new Map<string, string>() as ParsedRoleModelOverrides;
    overrides.rejected = [];
    const configured = new Set(configuredKeys);
    const affected = new Set(affectedRoles.map((role) => role.roleId));
    const tokens = message.trim().split(/\s+/).filter(Boolean);
    let sawAssignment = false;
    for (const token of tokens) {
        const assignment = token.match(/^([^=\s]+)=([^=\s]+)$/);
        if (!assignment) continue;
        sawAssignment = true;
        const [, roleId, chosen] = assignment;
        if (!affected.has(roleId)) overrides.rejected.push({ roleId, model: chosen, reason: "role_not_affected" });
        else if (!chosen.includes("/")) overrides.rejected.push({ roleId, model: chosen, reason: "invalid_model_key" });
        else if (!configured.has(chosen)) overrides.rejected.push({ roleId, model: chosen, reason: "model_not_configured" });
        else overrides.set(roleId, chosen);
    }
    if (!sawAssignment) {
        const bare = tokens.find((token) => token.includes("/") && !token.includes("="));
        if (bare && affectedRoles.length === 1) {
            if (configured.has(bare)) overrides.set(affectedRoles[0].roleId, bare);
            else overrides.rejected.push({ roleId: affectedRoles[0].roleId, model: bare, reason: "model_not_configured" });
        } else if (bare) overrides.rejected.push({ roleId: "*", model: bare, reason: "role_required" });
    }
    return overrides;
}

export function collectCaptainModelDecision(
    messages: string[],
    affectedRoles: AffectedModelRole[],
    configuredKeys: string[],
    reportedRejected: Set<string>,
): { overrides?: ParsedRoleModelOverrides; rejectionMessages: string[] } {
    const parsed = messages.map((message) => parseRoleModelOverrides(message, affectedRoles, configuredKeys));
    const merged = new Map<string, string>() as ParsedRoleModelOverrides;
    merged.rejected = [];
    const rejectionMessages: string[] = [];
    for (const result of parsed) {
        for (const [roleId, model] of result) merged.set(roleId, model);
        for (const rejected of result.rejected) {
            const key = `${rejected.reason}:${rejected.roleId}=${rejected.model}`;
            if (reportedRejected.has(key)) continue;
            reportedRejected.add(key);
            const reason = rejected.reason === "model_not_configured"
                ? "model is not configured"
                : rejected.reason === "invalid_model_key"
                  ? "model key must use provider/model format"
                  : rejected.reason === "role_not_affected"
                    ? "role is not awaiting a model decision"
                    : "multiple roles are affected; roleId=modelKey is required";
            rejectionMessages.push(`captain override rejected: ${rejected.roleId}=${rejected.model}; ${reason}.`);
        }
    }
    return { overrides: merged.size > 0 ? merged : undefined, rejectionMessages };
}

export function applyRoleModelOverrides(plan: TeamPlan, overrides: Map<string, string>): number {
    let applied = 0;
    for (const round of plan.rounds) {
        for (const role of round.roles) {
            const chosen = overrides.get(role.roleId);
            if (!chosen) continue;
            role.selectedModel = chosen;
            role.skipReason = undefined;
            role.fallbackReason = undefined;
            role.policyReason = "captain role-specific model override";
            role.routingReason = `captain override: ${role.roleId}=${chosen}`;
            applied += 1;
        }
    }
    return applied;
}
