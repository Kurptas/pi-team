import type { CaptainAttentionAlert } from "./captain-attention.ts";

interface PendingCaptainNotification {
    cwd: string;
    runId: string;
    text: string;
    alerts: CaptainAttentionAlert[];
}

/** Hold attention while the captain is busy, then validate the exact episode. */
export function createCaptainNotificationQueue(options: {
    isCurrent: (cwd: string, runId: string, alerts: CaptainAttentionAlert[]) => Promise<boolean>;
    render: (runId: string, alerts: CaptainAttentionAlert[]) => string;
    send: (text: string) => void;
    onDropped?: (runId: string, roleIds: string[]) => Promise<void>;
}) {
    let agentActive = false;
    let awaitingIdleBoundary = false;
    const pending = new Map<string, PendingCaptainNotification>();

    const roleIds = (notification: PendingCaptainNotification) =>
        [...new Set(notification.alerts.map((alert) => alert.roleId))];

    const flushIfIdle = async (): Promise<void> => {
        if (agentActive) return;
        awaitingIdleBoundary = false;
        for (const [runId, notification] of pending) {
            const current = await options.isCurrent(notification.cwd, runId, notification.alerts);
            if (pending.get(runId) !== notification) continue;
            if (agentActive || awaitingIdleBoundary) return;
            if (!current) {
                pending.delete(runId);
                await options.onDropped?.(runId, roleIds(notification));
                continue;
            }
            try {
                options.send(notification.text);
                pending.delete(runId);
            } catch {
                // Keep it pending for the next idle boundary.
            }
            return;
        }
    };

    const enqueue = (cwd: string, runId: string, alerts: CaptainAttentionAlert[]): void => {
        const existing = pending.get(runId);
        const combined = existing ? [...existing.alerts, ...alerts] : alerts;
        const unique = [...new Map(combined.map((alert) => [
            `${alert.roleId}:${alert.reason}:${alert.communicationAt ?? ""}:${alert.requestRef ?? ""}:${alert.requestStage ?? ""}:${alert.pendingCancelAt ?? ""}`,
            alert,
        ])).values()];
        pending.set(runId, { cwd, runId, alerts: unique, text: options.render(runId, unique) });
        if (!agentActive && !awaitingIdleBoundary) void flushIfIdle().catch(() => undefined);
    };

    const invalidate = (runId: string): string[] => {
        const notification = pending.get(runId);
        if (!notification) return [];
        pending.delete(runId);
        return roleIds(notification);
    };

    const drain = (): Array<{ runId: string; roleIds: string[] }> => {
        const drained = [...pending.values()].map((notification) => ({
            runId: notification.runId,
            roleIds: roleIds(notification),
        }));
        pending.clear();
        return drained;
    };

    return {
        enqueue,
        invalidate,
        drain,
        agentStarted: () => { agentActive = true; awaitingIdleBoundary = false; },
        agentEnded: () => { agentActive = false; awaitingIdleBoundary = true; },
        flushIfIdle,
        pendingCount: () => pending.size,
    };
}
