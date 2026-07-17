import type { TeamRun } from "./types.ts";

export const CAPTAIN_ATTENTION_INTERVAL_MS = 30_000;
export const CAPTAIN_ATTENTION_FROZEN_CHECKS = 4;
export const CAPTAIN_ATTENTION_MIN_SILENCE_MS = 120_000;

interface RoleAttentionState {
    tokens: number;
    requests: number;
    eventCount: number;
    frozenChecks: number;
    alerted: boolean;
}

export interface CaptainAttentionState {
    roles: Record<string, RoleAttentionState>;
}

export interface CaptainAttentionAlert {
    roleId: string;
    title: string;
    model?: string;
    frozenChecks: number;
    signalAgeMs?: number;
}

export function emptyCaptainAttentionState(): CaptainAttentionState {
    return { roles: {} };
}

/**
 * Runtime-side progress sampling for background runs. This produces factual
 * attention signals only: it never classifies a worker as dead or cancels it.
 */
export function evaluateCaptainAttention(
    run: TeamRun,
    previous: CaptainAttentionState,
    now = Date.now(),
    frozenChecksRequired = CAPTAIN_ATTENTION_FROZEN_CHECKS,
    minSilenceMs = CAPTAIN_ATTENTION_MIN_SILENCE_MS,
): { state: CaptainAttentionState; alerts: CaptainAttentionAlert[] } {
    const next: CaptainAttentionState = emptyCaptainAttentionState();
    const alerts: CaptainAttentionAlert[] = [];
    for (const worker of run.workers.filter((item) => item.status === "running")) {
        const current = {
            tokens: worker.tokens ?? 0,
            requests: worker.requests ?? 0,
            eventCount: worker.events?.length ?? 0,
        };
        const prior = previous.roles[worker.roleId];
        const progressed = prior !== undefined && (
            current.tokens > prior.tokens || current.requests > prior.requests || current.eventCount > prior.eventCount
        );
        const frozenChecks = prior === undefined || progressed ? 0 : prior.frozenChecks + 1;
        const signalAt = worker.lastSignalAt ?? worker.startedAt;
        const signalAgeMs = signalAt === undefined ? undefined : Math.max(0, now - signalAt);
        const shouldAlert = frozenChecks >= frozenChecksRequired
            && signalAgeMs !== undefined
            && signalAgeMs >= minSilenceMs
            && prior?.alerted !== true;
        next.roles[worker.roleId] = {
            ...current,
            frozenChecks,
            alerted: progressed ? false : (prior?.alerted === true || shouldAlert),
        };
        if (shouldAlert) alerts.push({
            roleId: worker.roleId,
            title: worker.title,
            model: worker.model,
            frozenChecks,
            signalAgeMs,
        });
    }
    return { state: next, alerts };
}

export interface CaptainAttentionMonitorHandle {
    tick(): Promise<void>;
    stop(): void;
}

export function startCaptainAttentionMonitor(options: {
    readRun: () => Promise<TeamRun | undefined>;
    isTerminal: (run: TeamRun) => boolean;
    isCanceled: () => boolean;
    onAttention: (alerts: CaptainAttentionAlert[]) => void | Promise<void>;
    intervalMs?: number;
    frozenChecksRequired?: number;
    minSilenceMs?: number;
    now?: () => number;
}): CaptainAttentionMonitorHandle {
    let state = emptyCaptainAttentionState();
    let checking = false;
    let stopped = false;
    const now = options.now ?? Date.now;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    };
    const tick = async () => {
        if (checking || stopped) return;
        checking = true;
        try {
            const current = await options.readRun();
            if (!current || options.isTerminal(current) || options.isCanceled()) {
                stop();
                return;
            }
            const previous = state;
            const evaluated = evaluateCaptainAttention(
                current, previous, now(), options.frozenChecksRequired, options.minSilenceMs,
            );
            if (evaluated.alerts.length === 0) {
                state = evaluated.state;
                return;
            }
            // Re-read before pushing so progress/terminal/cancel changes that raced
            // the first sample suppress a now-stale attention notification.
            const latest = await options.readRun();
            if (!latest || options.isTerminal(latest) || options.isCanceled()) {
                stop();
                return;
            }
            const confirmed = evaluateCaptainAttention(
                latest, previous, now(), options.frozenChecksRequired, options.minSilenceMs,
            );
            state = confirmed.state;
            if (confirmed.alerts.length > 0) await options.onAttention(confirmed.alerts);
        } catch {
            // Advisory monitoring must never affect worker execution.
        } finally {
            checking = false;
        }
    };
    const timer = setInterval(() => { void tick(); }, options.intervalMs ?? CAPTAIN_ATTENTION_INTERVAL_MS);
    timer.unref?.();
    return { tick, stop };
}

export function captainAttentionPush(runId: string, alerts: CaptainAttentionAlert[]): string {
    const workers = alerts.map((alert) => {
        const model = alert.model ? ` model=${alert.model}` : "";
        const silence = alert.signalAgeMs === undefined ? "unknown" : `${Math.round(alert.signalAgeMs / 1000)}s`;
        return `- ${alert.roleId} (${alert.title})${model}: no recorded token/request/event growth across ${alert.frozenChecks} runtime checks; last signal ${silence} ago`;
    }).join("\n");
    return [
        `[pi-team attention] Background run ${runId} may need captain inspection.`,
        workers,
        "No worker was canceled or rerouted. This is an evidence notification, not a stuck verdict.",
        `Next action: inspect once with team_status(runId=\"${runId}\"), then decide whether to wait, steer, or cancel. Do not repeatedly poll just to measure time.`,
    ].join("\n");
}
