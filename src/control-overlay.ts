import {
    readTeamMailbox,
    readTeamState,
    readWorkerCancelRequest,
    teamMailboxMessageAddressesRole,
} from "./control.ts";
import type { TeamRun } from "./types.ts";

/** Merge durable mailbox/cancel control state into a read-only run projection. */
export async function readTeamRunWithControlOverlay(cwd: string, runId: string): Promise<TeamRun | undefined> {
    const run = await readTeamState(cwd, runId);
    if (!run) return undefined;
    const mailbox = await readTeamMailbox(cwd, runId);
    const workers = await Promise.all(run.workers.map(async (worker) => {
        if (worker.status !== "running") return worker;
        const addressed = mailbox.filter((message) =>
            teamMailboxMessageAddressesRole(message, worker.roleId) && message.messageRef !== undefined,
        );
        const captainRequests = { ...(worker.captainRequests ?? {}) };
        for (const message of addressed) captainRequests[message.messageRef!] = {
            ...captainRequests[message.messageRef!],
            requestRef: message.messageRef!,
            queuedAt: message.at,
            preview: message.message.slice(0, 240),
        };
        const latestMessage = addressed.at(-1);
        const withMessage = latestMessage
            ? {
                ...worker,
                captainRequests,
                lastCaptainMessageAt: latestMessage.at,
                lastCaptainMessageRef: latestMessage.messageRef,
                lastCaptainMessagePreview: latestMessage.message.slice(0, 240),
            }
            : worker;
        if (withMessage.cancelObservedAt !== undefined) return withMessage;
        const cancel = await readWorkerCancelRequest(cwd, runId, worker.roleId);
        return cancel ? { ...withMessage, cancelRequestedAt: withMessage.cancelRequestedAt ?? cancel.at } : withMessage;
    }));
    return { ...run, workers };
}
