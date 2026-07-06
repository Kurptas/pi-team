import { staleThresholdMs } from "./runner.ts";
import type { TeamRun, WorkerRun } from "./types.ts";

const TEAM_STATUS_STALE_MS = staleThresholdMs();

function secondsSince(timestamp: number | undefined, now: number): number | undefined {
    return timestamp === undefined ? undefined : Math.max(0, Math.round((now - timestamp) / 1000));
}

function workerActivity(worker: WorkerRun): string {
    if (worker.lastTool) return `tool:${worker.lastTool}`;
    return worker.lastEvent ?? "starting";
}

export function buildTeamStatusProjection(
    run: TeamRun,
    mailboxMessages: { at: number; message: string }[],
    now = Date.now(),
) {
    const workers = (run.workers ?? []).map((worker) => {
        const signalAgeMs = worker.lastSignalAt === undefined ? undefined : Math.max(0, now - worker.lastSignalAt);
        const signalAgeSeconds = secondsSince(worker.lastSignalAt, now);
        const stale = worker.status === "running" && signalAgeMs !== undefined && signalAgeMs > TEAM_STATUS_STALE_MS;
        return {
            roleId: worker.roleId,
            title: worker.title,
            model: worker.model,
            thinkingLevel: worker.thinkingLevel,
            status: worker.status,
            elapsedSeconds:
                worker.startedAt === undefined
                    ? undefined
                    : Math.max(0, Math.round(((worker.endedAt ?? now) - worker.startedAt) / 1000)),
            signalAgeSeconds,
            stale,
            activity: workerActivity(worker),
            outputKind: worker.outputKind,
            timedOut: worker.timedOut === true,
            streamParseErrorCount: worker.streamParseErrorCount ?? 0,
            lastReportPreview: worker.lastReportPreview,
            lastCaptainMessagePreview: worker.lastCaptainMessagePreview,
            eventCount: worker.events?.length ?? 0,
            exitCode: worker.exitCode,
            exitSignal: worker.exitSignal,
            cancelRequestedAt: worker.cancelRequestedAt,
            cancelObservedAt: worker.cancelObservedAt,
            tools: worker.tools,
            activeTools: worker.activeTools,
            toolIsolationViolation: worker.toolIsolationViolation,
            requests: worker.requests ?? 0,
            tokens: worker.tokens ?? 0,
            costUsd: worker.costUsd ?? 0,
            errorReason: worker.errorReason,
            laneId: worker.laneId,
            delegationToken: worker.delegationToken,
        };
    });
    const activeWorkers = workers.filter((worker) => worker.status === "running");
    const evidenceWarnings = (run.events ?? [])
        .filter((event) => event.phase === "run-evidence-warning")
        .map((event) => event.message);
    return {
        runId: run.runId,
        status: run.status,
        playbookId: run.playbookId,
        counts: {
            total: workers.length,
            active: activeWorkers.length,
            succeeded: workers.filter((worker) => worker.status === "succeeded").length,
            failed: workers.filter((worker) => worker.status === "failed").length,
            degraded: workers.filter((worker) => worker.status === "degraded").length,
            skipped: workers.filter((worker) => worker.status === "skipped").length,
            stale: workers.filter((worker) => worker.stale).length,
            timedOut: workers.filter((worker) => worker.timedOut).length,
            parseErrors: workers.reduce((sum, worker) => sum + worker.streamParseErrorCount, 0),
            toolViolations: workers.filter((worker) => !!worker.toolIsolationViolation).length,
            requests: workers.reduce((sum, worker) => sum + worker.requests, 0),
            tokens: workers.reduce((sum, worker) => sum + worker.tokens, 0),
            costUsd: workers.reduce((sum, worker) => sum + worker.costUsd, 0),
        },
        mailbox: {
            file: run.mailboxFile,
            textFile: run.mailboxTextFile,
            messages: mailboxMessages.length,
            lastMessagePreview: mailboxMessages.at(-1)?.message,
        },
        cancelFile: run.cancelFile,
        evidenceWarnings,
        workers,
        modelHealth: (run.modelHealth ?? []).map((snapshot) => ({
            model: snapshot.model,
            status: snapshot.status,
            reason: snapshot.reason,
            latencyMs: snapshot.latencyMs,
        })),
        controls: run.status === "running" ? ["team_message", "team_cancel"] : [],
        stateWriteError: run.stateWriteError,
    };
}

export type TeamStatusProjection = ReturnType<typeof buildTeamStatusProjection>;
export type ProjectedWorker = TeamStatusProjection["workers"][number];
