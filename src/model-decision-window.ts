import { applyRoleModelOverrides, collectCaptainModelDecision, type AffectedModelRole } from "./model-decision.ts";
import type { FallbackPolicy, TeamEvent, TeamPlan } from "./types.ts";

export interface PendingModelDecision {
    failedPrefs: string[];
    affectedRoles: AffectedModelRole[];
    configuredKeys: string[];
    windowMs: number;
    policy?: FallbackPolicy;
}

export async function runModelDecisionWindow(
    plan: TeamPlan,
    pending: PendingModelDecision,
    readCaptainMessages: () => Promise<string[]>,
    onEvent: (event: TeamEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const deadlineAt = Date.now() + pending.windowMs;
    onEvent({
        phase: "model-decision-window-start",
        message: `user preference(s) unavailable: ${pending.failedPrefs.join(", ")}; captain may override via team_message before ${new Date(deadlineAt).toISOString()}. ${pending.policy === "strict" ? "On timeout, strict policy skips the affected role(s) (no substitution)." : "Auto-fallback applies on timeout."}`,
    });
    const reportedRejected = new Set<string>();
    const appliedModels = new Map<string, string>();
    while (Date.now() < deadlineAt && !signal?.aborted) {
        const parsed = collectCaptainModelDecision(
            await readCaptainMessages(), pending.affectedRoles, pending.configuredKeys, reportedRejected,
        );
        for (const message of parsed.rejectionMessages) {
            onEvent({ phase: "model-decision-window-rejected", message, isError: true });
        }
        if (parsed.overrides) {
            const changed = new Map([...parsed.overrides].filter(([roleId, model]) => appliedModels.get(roleId) !== model));
            if (changed.size > 0) {
                applyRoleModelOverrides(plan, changed);
                for (const [roleId, model] of changed) appliedModels.set(roleId, model);
                onEvent({
                    phase: "model-decision-window-override",
                    message: `captain applied ${changed.size} role-specific model override(s): ${[...changed].map(([roleId, model]) => `${roleId}=${model}`).join(", ")}`,
                });
            }
            if (pending.affectedRoles.every((role) => appliedModels.has(role.roleId))) break;
        }
        const remainingMs = Math.max(0, deadlineAt - Date.now());
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remainingMs)));
    }
    const unresolved = pending.affectedRoles.filter((role) => !appliedModels.has(role.roleId)).map((role) => role.roleId);
    if (signal?.aborted || unresolved.length > 0) {
        onEvent({
            phase: "model-decision-window-timeout",
            message: signal?.aborted
                ? "decision window aborted; no further captain override applied"
                : pending.policy === "strict"
                  ? `decision window expired; strict policy skips unresolved role(s): ${unresolved.join(", ")}`
                  : `decision window expired; auto-fallback proceeds for unresolved role(s): ${unresolved.join(", ")}`,
        });
    }
}
