import type { Message } from "@earendil-works/pi-ai";
import type { WorkerRun } from "./types.ts";

const OUTPUT_PREVIEW_CHARS = 240;
const DEFAULT_WORKER_SOFT_REQUEST_BUDGET = 18;
const DEFAULT_WORKER_HARD_REQUEST_BUDGET = 27;

function textPreview(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, OUTPUT_PREVIEW_CHARS);
}

export function requestBudget(): { soft: number; hard: number } {
    const soft = Number.parseInt(process.env.PI_TEAM_WORKER_SOFT_REQUEST_BUDGET ?? "", 10);
    const hard = Number.parseInt(process.env.PI_TEAM_WORKER_HARD_REQUEST_BUDGET ?? "", 10);
    const softBudget = Number.isFinite(soft) && soft > 0 ? soft : DEFAULT_WORKER_SOFT_REQUEST_BUDGET;
    const hardBudget = Number.isFinite(hard) && hard > 0 ? hard : Math.max(DEFAULT_WORKER_HARD_REQUEST_BUDGET, softBudget + 1);
    return { soft: softBudget, hard: Math.max(hardBudget, softBudget + 1) };
}

export function usageTokens(message: Message): number {
    const usage = (message as unknown as { usage?: Record<string, unknown> }).usage;
    if (!usage) return 0;
    const total = usage.totalTokens ?? usage.total_tokens ?? usage.total;
    if (typeof total === "number") return total;
    return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.reasoningTokens]
        .filter((value): value is number => typeof value === "number")
        .reduce((sum, value) => sum + value, 0);
}

function finiteNonNegative(value: unknown): number | undefined {
    const numberValue = typeof value === "string" && value.trim() ? Number(value) : value;
    return typeof numberValue === "number" && Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

export function usageCostUsd(message: Message): number {
    const usage = (message as unknown as { usage?: { cost?: unknown; costUsd?: unknown; cost_usd?: unknown } }).usage;
    if (!usage) return 0;
    const flat = finiteNonNegative(usage.costUsd) ?? finiteNonNegative(usage.cost_usd) ?? finiteNonNegative(usage.cost);
    if (flat !== undefined) return flat;
    if (usage.cost && typeof usage.cost === "object") {
        const cost = usage.cost as Record<string, unknown>;
        const total = finiteNonNegative(cost.total);
        if (total !== undefined) return total;
        return Object.values(cost).reduce<number>((sum, value) => sum + (finiteNonNegative(value) ?? 0), 0);
    }
    return 0;
}

export function budgetNotice(requests: number): string {
    return `[team budget notice] You have used ${requests} assistant responses in this worker run. Finish the current step and return your final structured findings now.`;
}

export function salvageOutput(worker: WorkerRun): string {
    const existing = worker.output.trim();
    if (existing) return existing;
    const last = worker.lastOutputPreview || worker.lastReportPreview;
    if (!last || (!worker.timedOut && !worker.cancelRequestedAt && !worker.budgetExceeded)) return "";
    return `[cancelled after ${worker.requests ?? 0} req, ${worker.tokens ?? 0} tok — last activity: "${textPreview(last)}"]`;
}

export function shouldRetryWorker(worker: WorkerRun): boolean {
    return worker.status === "failed" && !worker.timedOut && worker.outputKind !== "substantive" && worker.errorReason !== "aborted";
}

/**
 * Pure budget classification for a worker that has just recorded `requests`
 * assistant responses. Separated from runWorker so the soft-notice / hard-abort
 * thresholds are unit-testable without a live session.
 * - `reachedSoft`: at/above the soft budget and the steer notice not yet sent.
 * - `reachedHard`: at/above the hard budget and not already marked exceeded.
 * These are factual threshold signals, not quality judgments.
 */
export function classifyBudgetState(
    requests: number,
    budget: { soft: number; hard: number },
    state: { budgetNoticeSent?: boolean; budgetExceeded?: boolean },
): { reachedSoft: boolean; reachedHard: boolean } {
    return {
        reachedSoft: !state.budgetNoticeSent && requests >= budget.soft,
        reachedHard: !state.budgetExceeded && requests >= budget.hard,
    };
}

/**
 * Pure next-model selection for the fallback retry loop. Given the models
 * already attempted and the role's ordered fallback keys, return the first
 * untried fallback, or undefined when none remain. The actual decision to retry
 * combines this with shouldRetryWorker(result); kept pure so the
 * provider-failure fallback path is unit-testable without spawning workers.
 */
export function selectRetryModel(
    attemptedModels: Array<string | undefined>,
    fallbackKeys: string[] | undefined,
): string | undefined {
    if (!fallbackKeys || fallbackKeys.length === 0) return undefined;
    const tried = new Set(attemptedModels.filter((model): model is string => Boolean(model)));
    return fallbackKeys.find((model) => !tried.has(model));
}
