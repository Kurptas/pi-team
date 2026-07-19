import { CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS } from "./captain-attention.ts";
import { staleThresholdMs } from "./runner.ts";
import type { TeamRun, WorkerRun } from "./types.ts";
import { workerFactualPreview } from "./worker-preview.ts";

const TEAM_STATUS_STALE_MS = staleThresholdMs();

function secondsSince(timestamp: number | undefined, now: number): number | undefined {
    return timestamp === undefined ? undefined : Math.max(0, Math.round((now - timestamp) / 1000));
}

function latestTimestamp(...values: Array<number | undefined>): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : Math.max(...present);
}

function workerActivity(worker: WorkerRun): string {
    if (worker.lastTool) return `tool:${worker.lastTool}`;
    return worker.lastEvent ?? "starting";
}

export function buildTeamStatusProjection(
    run: TeamRun,
    mailboxMessages: { at: number; message: string }[],
    now = Date.now(),
    attentionState = run.attentionState,
) {
    const workers = (run.workers ?? []).map((worker) => {
        const toolEvents = (worker.events ?? []).filter((event) => event.phase === "worker-tool");
        const signalAgeMs = worker.lastSignalAt === undefined ? undefined : Math.max(0, now - worker.lastSignalAt);
        const signalAgeSeconds = secondsSince(worker.lastSignalAt, now);
        const rearmAt = attentionState?.roles[worker.roleId]?.rearmAt;
        const communicationAt = latestTimestamp(worker.lastReportAt ?? worker.startedAt, rearmAt);
        const communicationAgeSeconds = secondsSince(communicationAt, now);
        let requestStates = Object.values(worker.captainRequests ?? {});
        if (requestStates.length === 0 && worker.lastCaptainMessageRef) requestStates = [{
            requestRef: worker.lastCaptainMessageRef,
            queuedAt: worker.lastCaptainMessageAt ?? worker.startedAt ?? 0,
            deliveredAt: worker.lastCaptainDeliveredRef === worker.lastCaptainMessageRef ? worker.lastCaptainDeliveredAt : undefined,
            ackedAt: worker.lastCaptainAckRef === worker.lastCaptainMessageRef ? worker.lastCaptainAckAt : undefined,
        }];
        const pendingRequest = requestStates.filter((request) => request.ackedAt === undefined).sort((a, b) => a.queuedAt - b.queuedAt)[0];
        const pendingRequestRef = pendingRequest?.requestRef;
        const requestDelivered = pendingRequest?.deliveredAt !== undefined;
        const requestAnchor = pendingRequest
            ? latestTimestamp(requestDelivered ? pendingRequest.deliveredAt : pendingRequest.queuedAt, rearmAt)
            : undefined;
        const pendingDeliveryRef = pendingRequestRef && !requestDelivered ? pendingRequestRef : undefined;
        const pendingAckRef = pendingRequestRef && requestDelivered ? pendingRequestRef : undefined;
        const pendingRequestAgeSeconds = secondsSince(requestAnchor, now);
        const pendingAckAgeSeconds = pendingAckRef ? pendingRequestAgeSeconds : undefined;
        const pendingDeliveryAgeSeconds = pendingDeliveryRef ? pendingRequestAgeSeconds : undefined;
        const cancelPendingAgeSeconds = worker.cancelRequestedAt !== undefined && worker.cancelObservedAt === undefined
            ? secondsSince(latestTimestamp(worker.cancelRequestedAt, rearmAt), now)
            : undefined;
        const attentionDebt = worker.status === "running" && (
            (cancelPendingAgeSeconds ?? 0) * 1_000 >= CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS
            || (pendingRequestAgeSeconds ?? 0) * 1_000 >= CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS
            || (pendingRequestRef === undefined && (communicationAgeSeconds ?? 0) * 1_000 >= CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS)
        );
        const stale = worker.status === "running" && signalAgeMs !== undefined && signalAgeMs > TEAM_STATUS_STALE_MS;
        return {
            roleId: worker.roleId,
            title: worker.title,
            model: worker.model,
            thinkingLevel: worker.thinkingLevel,
            status: worker.status,
            routingReason: worker.routingReason,
            modelFallbackKeys: worker.modelFallbackKeys,
            elapsedSeconds:
                worker.startedAt === undefined
                    ? undefined
                    : Math.max(0, Math.round(((worker.endedAt ?? now) - worker.startedAt) / 1000)),
            signalAgeSeconds,
            communicationAgeSeconds,
            pendingRequestRef,
            pendingDeliveryRef,
            pendingDeliveryAgeSeconds,
            pendingAckRef,
            pendingAckAgeSeconds,
            cancelPendingAgeSeconds,
            rearmAt,
            attentionDebt,
            stale,
            activity: workerActivity(worker),
            outputKind: worker.outputKind,
            factualPreview: workerFactualPreview(worker),
            timedOut: worker.timedOut === true,
            streamParseErrorCount: worker.streamParseErrorCount ?? 0,
            lastReportPreview: worker.lastReportPreview,
            lastCaptainMessagePreview: worker.lastCaptainMessagePreview,
            captainRequestStates: requestStates,
            eventCount: worker.events?.length ?? 0,
            exitCode: worker.exitCode,
            exitSignal: worker.exitSignal,
            cancelRequestedAt: worker.cancelRequestedAt,
            cancelObservedAt: worker.cancelObservedAt,
            tools: worker.tools,
            activeTools: worker.activeTools,
            toolIsolationViolation: worker.toolIsolationViolation,
            toolCallCount: toolEvents.filter((event) => event.message.includes("tool_execution_start")).length,
            toolErrorCount: toolEvents.filter((event) => event.isError === true).length,
            requests: worker.requests ?? 0,
            tokens: worker.tokens ?? 0,
            costUsd: worker.costUsd ?? 0,
            errorReason: worker.errorReason,
            laneId: worker.laneId,
            delegationToken: worker.delegationToken,
        };
    });
    const activeWorkers = workers.filter((worker) => worker.status === "running");
    const ackGroupMap = new Map<string, {
        requestRef: string;
        total: number;
        delivered: number;
        acked: number;
        deliveredRoleIds: string[];
        ackedRoleIds: string[];
        pendingDeliveryRoleIds: string[];
        pendingAckRoleIds: string[];
        terminalWithoutAckRoleIds: string[];
    }>();
    for (const worker of workers) for (const request of worker.captainRequestStates) {
        const group = ackGroupMap.get(request.requestRef) ?? {
            requestRef: request.requestRef, total: 0, delivered: 0, acked: 0,
            deliveredRoleIds: [], ackedRoleIds: [], pendingDeliveryRoleIds: [], pendingAckRoleIds: [], terminalWithoutAckRoleIds: [],
        };
        group.total += 1;
        if (request.deliveredAt !== undefined || request.ackedAt !== undefined) {
            group.delivered += 1;
            group.deliveredRoleIds.push(worker.roleId);
        }
        if (request.ackedAt !== undefined) {
            group.acked += 1;
            group.ackedRoleIds.push(worker.roleId);
        } else if (worker.status === "succeeded" || worker.status === "failed" || worker.status === "degraded" || worker.status === "skipped") {
            group.terminalWithoutAckRoleIds.push(worker.roleId);
        } else if (request.deliveredAt !== undefined) group.pendingAckRoleIds.push(worker.roleId);
        else group.pendingDeliveryRoleIds.push(worker.roleId);
        ackGroupMap.set(request.requestRef, group);
    }
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
            attentionDebt: workers.filter((worker) => worker.attentionDebt).length,
            timedOut: workers.filter((worker) => worker.timedOut).length,
            parseErrors: workers.reduce((sum, worker) => sum + worker.streamParseErrorCount, 0),
            toolViolations: workers.filter((worker) => !!worker.toolIsolationViolation).length,
            toolCalls: workers.reduce((sum, worker) => sum + worker.toolCallCount, 0),
            toolErrors: workers.reduce((sum, worker) => sum + worker.toolErrorCount, 0),
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
        ackGroups: [...ackGroupMap.values()],
        workers,
        modelHealth: (run.modelHealth ?? []).map((snapshot) => ({
            model: snapshot.model,
            status: snapshot.status,
            evidenceSource: snapshot.evidenceSource,
            reason: snapshot.reason,
            latencyMs: snapshot.latencyMs,
        })),
        controls: run.status === "running"
            ? ["team_message", "team_cancel_worker", "team_spawn_worker", "team_cancel"]
            : run.status === "planning" || run.status === "probing" || run.status === "synthesizing"
              ? ["team_cancel"]
              : ["team_handoff", "team_promote_blueprint"],
        stateWriteError: run.stateWriteError,
    };
}

export type TeamStatusProjection = ReturnType<typeof buildTeamStatusProjection>;
export type ProjectedWorker = TeamStatusProjection["workers"][number];
