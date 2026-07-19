import type { TeamMailboxMessage } from "./control.ts";
import type { TeamEvent, WorkerRun } from "./types.ts";

function preview(value: string): string {
    return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

export function acknowledgeCaptainRequests(worker: WorkerRun, requestRefs: string[], at: number): void {
    for (const requestRef of requestRefs) {
        worker.captainRequests ??= {};
        const request = worker.captainRequests[requestRef] ??= {
            requestRef,
            queuedAt: worker.lastCaptainMessageRef === requestRef ? worker.lastCaptainMessageAt ?? at : at,
            deliveredAt: at,
        };
        request.deliveredAt ??= at;
        request.ackedAt = at;
    }
    if (requestRefs.length === 0) return;
    worker.lastCaptainDeliveredAt ??= at;
    worker.lastCaptainDeliveredRef = requestRefs.at(-1);
    worker.lastCaptainAckAt = at;
    worker.lastCaptainAckRef = requestRefs.at(-1);
}

export function captainRequestSnapshot(worker: WorkerRun): Partial<WorkerRun> {
    return {
        lastCaptainMessageAt: worker.lastCaptainMessageAt,
        lastCaptainMessageRef: worker.lastCaptainMessageRef,
        lastCaptainMessagePreview: worker.lastCaptainMessagePreview,
        lastCaptainDeliveredAt: worker.lastCaptainDeliveredAt,
        lastCaptainDeliveredRef: worker.lastCaptainDeliveredRef,
        lastCaptainAckAt: worker.lastCaptainAckAt,
        lastCaptainAckRef: worker.lastCaptainAckRef,
        captainRequests: worker.captainRequests,
    };
}

export function captainRequestSteerText(requestId: string, message: string): string {
    return [
        `Captain request ${requestId}:`,
        message,
        `Acknowledge immediately in your next RADIO report as: RADIO: ack=${requestId}; status=received; ...`,
        "Then adjust within your role boundary. This is captain steering, not permission to broaden scope.",
    ].join("\n");
}

/** Deliver each unseen addressed request once, in mailbox order. */
export async function deliverCaptainRequests(options: {
    messages: TeamMailboxMessage[];
    seen: number;
    worker: WorkerRun;
    inject: (requestId: string, message: string) => Promise<boolean>;
    emit: (event: TeamEvent) => void;
    now?: () => number;
}): Promise<number> {
    let seen = options.seen;
    const now = options.now ?? Date.now;
    for (let index = seen; index < options.messages.length; index += 1) {
        const request = options.messages[index]!;
        const requestId = request.messageRef ?? `legacy-${request.at}`;
        options.worker.lastCaptainMessageAt = request.at;
        options.worker.lastCaptainMessageRef = request.messageRef;
        options.worker.lastCaptainMessagePreview = preview(request.message);
        options.worker.captainRequests ??= {};
        options.worker.captainRequests[requestId] = {
            ...options.worker.captainRequests[requestId],
            requestRef: requestId,
            queuedAt: request.at,
            preview: preview(request.message),
        };
        options.emit({
            phase: "captain-message-available",
            message: `${options.worker.title} has captain request ${requestId} available`,
            preview: preview(request.message),
        });
        if (!await options.inject(requestId, request.message)) return seen;
        seen = index + 1;
        options.worker.lastCaptainDeliveredAt = now();
        options.worker.lastCaptainDeliveredRef = request.messageRef;
        options.worker.captainRequests[requestId]!.deliveredAt = options.worker.lastCaptainDeliveredAt;
        options.emit({
            phase: "captain-message-delivered",
            message: `${options.worker.title} received captain request ${requestId} in its session`,
            preview: preview(request.message),
        });
    }
    return seen;
}
