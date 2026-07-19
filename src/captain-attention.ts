import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRun } from "./types.ts";

export const CAPTAIN_ATTENTION_INTERVAL_MS = 30_000;
export const CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS = 120_000;
export const CAPTAIN_ATTENTION_MIN_SILENCE_MS = CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS;
const CAPTAIN_ATTENTION_PUSH_LIMIT = 5;
const attentionWriteGlobal = globalThis as typeof globalThis & {
    __piTeamAttentionWriteQueues?: Map<string, Promise<void>>;
};
const attentionWriteQueues = attentionWriteGlobal.__piTeamAttentionWriteQueues
    ??= new Map<string, Promise<void>>();

export interface RoleAttentionState {
    communicationAt?: number;
    silenceAlerted: boolean;
    pendingRequestRef?: string;
    pendingRequestStage?: "queued" | "delivered";
    pendingAckAlerted: boolean;
    pendingCancelAt?: number;
    cancelAlerted: boolean;
    /** Captain observation/intervention opens a new timeout window. */
    rearmAt?: number;
}

export interface CaptainAttentionState {
    roles: Record<string, RoleAttentionState>;
}

export interface CaptainAttentionAlert {
    roleId: string;
    title: string;
    model?: string;
    reason: "communication_silence" | "request_delivery_pending" | "unacknowledged_request" | "cancel_pending";
    communicationAgeMs?: number;
    communicationAt?: number;
    requestRef?: string;
    requestStage?: "queued" | "delivered";
    requestAgeMs?: number;
    pendingCancelAt?: number;
    cancelAgeMs?: number;
}

export function emptyCaptainAttentionState(): CaptainAttentionState {
    return { roles: {} };
}

function latestAt(...values: Array<number | undefined>): number | undefined {
    const present = values.filter((value): value is number => value !== undefined);
    return present.length === 0 ? undefined : Math.max(...present);
}

function oldestPendingRequest(worker: TeamRun["workers"][number]) {
    const ledger = Object.values(worker.captainRequests ?? {})
        .filter((request) => request.ackedAt === undefined)
        .sort((a, b) => a.queuedAt - b.queuedAt);
    if (ledger.length > 0) return ledger[0];
    if (worker.lastCaptainMessageRef && worker.lastCaptainAckRef !== worker.lastCaptainMessageRef) return {
        requestRef: worker.lastCaptainMessageRef,
        queuedAt: worker.lastCaptainMessageAt ?? worker.startedAt ?? 0,
        deliveredAt: worker.lastCaptainDeliveredRef === worker.lastCaptainMessageRef
            ? worker.lastCaptainDeliveredAt
            : undefined,
    };
    return undefined;
}

/**
 * Detects communication/control debt, not execution inactivity. Each role is
 * independent. An episode alerts once until worker communication changes or a
 * captain observation explicitly re-arms an already-alerted role.
 */
export function evaluateCaptainAttention(
    run: TeamRun,
    previous: CaptainAttentionState,
    now = Date.now(),
    communicationTimeoutMs = CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS,
): { state: CaptainAttentionState; alerts: CaptainAttentionAlert[] } {
    const next = emptyCaptainAttentionState();
    const alerts: CaptainAttentionAlert[] = [];

    for (const worker of run.workers.filter((item) => item.status === "running")) {
        const prior = previous.roles[worker.roleId];
        const communicationAt = worker.lastReportAt ?? worker.startedAt;
        const sameCommunicationEpisode = prior?.communicationAt === communicationAt;
        const rearmAt = prior?.rearmAt;
        const communicationAnchor = latestAt(communicationAt, rearmAt);
        const communicationAgeMs = communicationAnchor === undefined ? undefined : Math.max(0, now - communicationAnchor);

        const pendingRequest = oldestPendingRequest(worker);
        const pendingRequestRef = pendingRequest?.requestRef;
        const requestDelivered = pendingRequest?.deliveredAt !== undefined;
        const pendingRequestStage = pendingRequestRef === undefined ? undefined : requestDelivered ? "delivered" : "queued";
        const sameRequestEpisode = prior?.pendingRequestRef === pendingRequestRef
            && prior?.pendingRequestStage === pendingRequestStage;
        const requestAnchor = pendingRequest === undefined
            ? undefined
            : latestAt(requestDelivered ? pendingRequest.deliveredAt : pendingRequest.queuedAt, rearmAt);
        const requestAgeMs = requestAnchor === undefined ? undefined : Math.max(0, now - requestAnchor);

        const pendingCancelAt = worker.cancelRequestedAt !== undefined && worker.cancelObservedAt === undefined
            ? worker.cancelRequestedAt
            : undefined;
        const sameCancelEpisode = prior?.pendingCancelAt === pendingCancelAt;
        const cancelAnchor = pendingCancelAt === undefined ? undefined : latestAt(pendingCancelAt, rearmAt);
        const cancelAgeMs = cancelAnchor === undefined ? undefined : Math.max(0, now - cancelAnchor);

        const cancelAlert = pendingCancelAt !== undefined
            && cancelAgeMs !== undefined
            && cancelAgeMs >= communicationTimeoutMs
            && !(sameCancelEpisode && prior?.cancelAlerted === true);
        const pendingAckAlert = pendingCancelAt === undefined
            && pendingRequestRef !== undefined
            && requestAgeMs !== undefined
            && requestAgeMs >= communicationTimeoutMs
            && !(sameRequestEpisode && prior?.pendingAckAlerted === true);
        const silenceAlert = pendingCancelAt === undefined
            && pendingRequestRef === undefined
            && communicationAgeMs !== undefined
            && communicationAgeMs >= communicationTimeoutMs
            && !(sameCommunicationEpisode && prior?.silenceAlerted === true);

        next.roles[worker.roleId] = {
            communicationAt,
            silenceAlerted: sameCommunicationEpisode ? (prior?.silenceAlerted === true || silenceAlert) : silenceAlert,
            pendingRequestRef,
            pendingRequestStage,
            pendingAckAlerted: pendingRequestRef === undefined
                ? false
                : sameRequestEpisode ? (prior?.pendingAckAlerted === true || pendingAckAlert) : pendingAckAlert,
            pendingCancelAt,
            cancelAlerted: pendingCancelAt === undefined
                ? false
                : sameCancelEpisode ? (prior?.cancelAlerted === true || cancelAlert) : cancelAlert,
            rearmAt,
        };

        if (cancelAlert) {
            alerts.push({ roleId: worker.roleId, title: worker.title, model: worker.model, reason: "cancel_pending", pendingCancelAt, cancelAgeMs });
        } else if (pendingAckAlert) {
            alerts.push({
                roleId: worker.roleId, title: worker.title, model: worker.model,
                reason: requestDelivered ? "unacknowledged_request" : "request_delivery_pending",
                communicationAgeMs, requestRef: pendingRequestRef, requestStage: pendingRequestStage, requestAgeMs,
            });
        } else if (silenceAlert) {
            alerts.push({
                roleId: worker.roleId, title: worker.title, model: worker.model,
                reason: "communication_silence", communicationAt, communicationAgeMs,
            });
        }
    }

    return { state: next, alerts };
}

export function isCaptainAttentionAlertCurrent(run: TeamRun, alert: CaptainAttentionAlert): boolean {
    const worker = run.workers.find((item) => item.roleId === alert.roleId && item.status === "running");
    if (!worker) return false;
    const pendingCancelAt = worker.cancelRequestedAt !== undefined && worker.cancelObservedAt === undefined
        ? worker.cancelRequestedAt : undefined;
    const pendingRequest = oldestPendingRequest(worker);
    if (alert.reason === "cancel_pending") return pendingCancelAt === alert.pendingCancelAt;
    if (alert.reason === "request_delivery_pending" || alert.reason === "unacknowledged_request") {
        const stage = pendingRequest === undefined ? undefined : pendingRequest.deliveredAt === undefined ? "queued" : "delivered";
        return pendingCancelAt === undefined && pendingRequest?.requestRef === alert.requestRef && stage === alert.requestStage;
    }
    return pendingCancelAt === undefined
        && pendingRequest === undefined
        && (worker.lastReportAt ?? worker.startedAt) === alert.communicationAt;
}

/** Re-arm only roles that have already produced an attention notification. */
export function rearmCaptainAttention(
    state: CaptainAttentionState,
    roleIds: string[],
    at = Date.now(),
): CaptainAttentionState {
    const targets = new Set(roleIds);
    const roles = Object.fromEntries(Object.entries(state.roles).map(([roleId, role]) => {
        if (!targets.has(roleId) || (!role.silenceAlerted && !role.pendingAckAlerted && !role.cancelAlerted)) {
            return [roleId, role];
        }
        return [roleId, {
            ...role,
            silenceAlerted: false,
            pendingAckAlerted: false,
            cancelAlerted: false,
            rearmAt: at,
        }];
    }));
    return { roles };
}

/** Release a notification that was queued but never shown to the captain. */
export function releaseCaptainAttention(state: CaptainAttentionState, roleIds: string[]): CaptainAttentionState {
    const targets = new Set(roleIds);
    const roles = Object.fromEntries(Object.entries(state.roles).map(([roleId, role]) => targets.has(roleId)
        ? [roleId, { ...role, silenceAlerted: false, pendingAckAlerted: false, cancelAlerted: false }]
        : [roleId, role]));
    return { roles };
}

export async function readCaptainAttentionState(file: string): Promise<CaptainAttentionState | undefined> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(file, "utf-8")) as CaptainAttentionState;
        return parsed && typeof parsed.roles === "object" ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function retryDelay(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
}

async function replaceAttentionStateFile(
    tmp: string,
    file: string,
    shouldCommit: () => boolean,
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!shouldCommit()) return;
        try {
            await fs.promises.rename(tmp, file);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "EPERM" && code !== "EEXIST") throw error;
            if (!shouldCommit()) return;
            try {
                await fs.promises.rm(file, { force: true });
                if (!shouldCommit()) return;
                await fs.promises.rename(tmp, file);
                return;
            } catch (replaceError) {
                lastError = replaceError;
                const replaceCode = (replaceError as NodeJS.ErrnoException).code;
                if (replaceCode !== "EPERM" && replaceCode !== "EEXIST") throw replaceError;
                await retryDelay(attempt);
            }
        }
    }
    throw lastError;
}

export async function writeCaptainAttentionState(
    file: string,
    state: CaptainAttentionState,
    shouldCommit: () => boolean = () => true,
): Promise<void> {
    const key = path.resolve(file);
    const previous = attentionWriteQueues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
            await replaceAttentionStateFile(tmp, file, shouldCommit);
        } finally {
            await fs.promises.rm(tmp, { force: true }).catch(() => {});
        }
    });
    attentionWriteQueues.set(key, operation);
    try {
        await operation;
    } finally {
        if (attentionWriteQueues.get(key) === operation) attentionWriteQueues.delete(key);
    }
}

export interface CaptainAttentionMonitorHandle {
    tick(): Promise<void>;
    stop(): void;
    rearm(roleIds: string[], at?: number): Promise<void>;
    release(roleIds: string[]): Promise<void>;
}

export function startCaptainAttentionMonitor(options: {
    readRun: () => Promise<TeamRun | undefined>;
    isTerminal: (run: TeamRun) => boolean;
    isCanceled: () => boolean;
    onAttention: (alerts: CaptainAttentionAlert[]) => void | Promise<void>;
    stateFile?: string;
    intervalMs?: number;
    communicationTimeoutMs?: number;
    now?: () => number;
}): CaptainAttentionMonitorHandle {
    let state = emptyCaptainAttentionState();
    let loaded = false;
    let stopped = false;
    let generation = 0;
    let serial = Promise.resolve();
    const now = options.now ?? Date.now;

    const ensureLoaded = async () => {
        if (loaded) return;
        loaded = true;
        if (options.stateFile) state = await readCaptainAttentionState(options.stateFile) ?? state;
    };
    const persist = async (snapshot: CaptainAttentionState, operationGeneration: number) => {
        if (!options.stateFile) return;
        try {
            await writeCaptainAttentionState(
                options.stateFile,
                snapshot,
                () => !stopped && generation === operationGeneration,
            );
        } catch { /* advisory only */ }
    };
    const enqueue = (operation: () => Promise<void>) => {
        const result = serial.then(operation, operation);
        serial = result.catch(() => {});
        return result;
    };
    const stop = () => {
        if (stopped) return;
        stopped = true;
        generation += 1;
        clearInterval(timer);
    };
    const tick = () => enqueue(async () => {
        if (stopped) return;
        const operationGeneration = generation;
        await ensureLoaded();
        if (stopped || generation !== operationGeneration) return;
        try {
            const current = await options.readRun();
            if (!current || options.isTerminal(current) || options.isCanceled()) {
                stop();
                return;
            }
            const previous = state;
            const evaluated = evaluateCaptainAttention(current, previous, now(), options.communicationTimeoutMs);
            if (evaluated.alerts.length === 0) {
                state = evaluated.state;
                await persist(state, operationGeneration);
                return;
            }
            const latest = await options.readRun();
            if (!latest || options.isTerminal(latest) || options.isCanceled()) {
                stop();
                return;
            }
            const confirmed = evaluateCaptainAttention(latest, previous, now(), options.communicationTimeoutMs);
            if (confirmed.alerts.length > 0) await options.onAttention(confirmed.alerts);
            if (stopped || generation !== operationGeneration) return;
            state = confirmed.state;
            await persist(state, operationGeneration);
        } catch {
            // Advisory monitoring must never affect worker execution.
        }
    });
    const rearm = (roleIds: string[], at = now()) => enqueue(async () => {
        if (stopped) return;
        const operationGeneration = generation;
        await ensureLoaded();
        if (stopped || generation !== operationGeneration) return;
        state = rearmCaptainAttention(state, roleIds, at);
        await persist(state, operationGeneration);
    });
    const release = (roleIds: string[]) => enqueue(async () => {
        if (stopped) return;
        const operationGeneration = generation;
        await ensureLoaded();
        if (stopped || generation !== operationGeneration) return;
        state = releaseCaptainAttention(state, roleIds);
        await persist(state, operationGeneration);
    });
    const timer = setInterval(() => { void tick(); }, options.intervalMs ?? CAPTAIN_ATTENTION_INTERVAL_MS);
    timer.unref?.();
    return { tick, stop, rearm, release };
}

function alertAge(alert: CaptainAttentionAlert): number {
    return alert.cancelAgeMs ?? alert.requestAgeMs ?? alert.communicationAgeMs ?? 0;
}

export function captainAttentionPush(runId: string, alerts: CaptainAttentionAlert[]): string {
    const ordered = [...alerts].sort((a, b) => {
        const priority = (reason: CaptainAttentionAlert["reason"]) => reason === "cancel_pending" ? 0 : reason === "request_delivery_pending" ? 1 : reason === "unacknowledged_request" ? 2 : 3;
        return priority(a.reason) - priority(b.reason) || alertAge(b) - alertAge(a);
    });
    const shown = ordered.slice(0, CAPTAIN_ATTENTION_PUSH_LIMIT);
    const workers = shown.map((alert) => {
        const model = alert.model ? ` model=${alert.model}` : "";
        if (alert.reason === "cancel_pending") {
            const age = alert.cancelAgeMs === undefined ? "unknown" : `${Math.round(alert.cancelAgeMs / 1000)}s`;
            return `- ${alert.roleId} (${alert.title})${model}: cancel request has not been observed after ${age}`;
        }
        if (alert.reason === "request_delivery_pending") {
            const age = alert.requestAgeMs === undefined ? "unknown" : `${Math.round(alert.requestAgeMs / 1000)}s`;
            return `- ${alert.roleId} (${alert.title})${model}: captain request ${alert.requestRef ?? "(unknown)"} has not reached the worker session after ${age}`;
        }
        if (alert.reason === "unacknowledged_request") {
            const age = alert.requestAgeMs === undefined ? "unknown" : `${Math.round(alert.requestAgeMs / 1000)}s`;
            return `- ${alert.roleId} (${alert.title})${model}: delivered captain request ${alert.requestRef ?? "(unknown)"} has no worker ACK after ${age}`;
        }
        const age = alert.communicationAgeMs === undefined ? "unknown" : `${Math.round(alert.communicationAgeMs / 1000)}s`;
        return `- ${alert.roleId} (${alert.title})${model}: no effective worker-to-captain communication for ${age}`;
    });
    if (ordered.length > shown.length) workers.push(`- … +${ordered.length - shown.length} more worker(s) need attention`);
    return [
        `[pi-team attention] Background run ${runId} may need captain inspection (${ordered.length} worker(s)).`,
        workers.join("\n"),
        "This episode is notified once. If the captain observes or intervenes, a new two-minute observation window opens only for affected alerted workers.",
        "No worker was canceled or rerouted. The extension records communication debt; it does not make that judgment. The captain decides whether to wait, steer, or cancel.",
        `Next action: inspect once with team_status(runId="${runId}"). Do not poll as a timer.`,
    ].join("\n");
}
