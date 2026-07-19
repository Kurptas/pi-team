import { describe, expect, it } from "vitest";
import { createCaptainNotificationQueue } from "../src/captain-notification.ts";
import { startCaptainAttentionMonitor, type CaptainAttentionAlert } from "../src/captain-attention.ts";
import type { TeamRun } from "../src/types.ts";

const alert = (roleId = "reviewer"): CaptainAttentionAlert => ({
    roleId,
    title: roleId,
    reason: "communication_silence",
    communicationAt: 1,
    communicationAgeMs: 120_000,
});
const render = (_runId: string, alerts: CaptainAttentionAlert[]) => alerts.map((item) => item.roleId).join(",");

describe("captain notification queue", () => {
    it("does not block while the captain is busy and drops a stale episode at idle", async () => {
        let current = true;
        const sent: string[] = [];
        const dropped: string[][] = [];
        const queue = createCaptainNotificationQueue({
            isCurrent: async () => current,
            render,
            send: (text) => { sent.push(text); },
            onDropped: async (_runId, roleIds) => { dropped.push(roleIds); },
        });
        queue.agentStarted();
        queue.enqueue("cwd", "run", [alert()]);
        expect(queue.pendingCount()).toBe(1);
        current = false;
        queue.agentEnded();
        await queue.flushIfIdle();
        expect(sent).toEqual([]);
        expect(dropped).toEqual([["reviewer"]]);
        expect(queue.pendingCount()).toBe(0);
    });

    it("sends one still-current notification after the idle boundary", async () => {
        const sent: string[] = [];
        const queue = createCaptainNotificationQueue({ isCurrent: async () => true, render, send: (text) => { sent.push(text); } });
        queue.agentStarted();
        queue.enqueue("cwd", "run", [alert()]);
        expect(sent).toEqual([]);
        queue.agentEnded();
        await queue.flushIfIdle();
        expect(sent).toEqual(["reviewer"]);
    });

    it("merges role alerts, invalidates observations, and drains reload state", () => {
        const queue = createCaptainNotificationQueue({ isCurrent: async () => true, render, send: () => {} });
        queue.agentStarted();
        queue.enqueue("cwd", "one", [alert("a")]);
        queue.enqueue("cwd", "one", [alert("b")]);
        queue.enqueue("cwd", "two", [alert("c")]);
        expect(queue.invalidate("one")).toEqual(["a", "b"]);
        expect(queue.drain()).toEqual([{ runId: "two", roleIds: ["c"] }]);
        expect(queue.pendingCount()).toBe(0);
    });

    it("does not send when observation invalidates an in-flight validation", async () => {
        let finishValidation!: (value: boolean) => void;
        const validation = new Promise<boolean>((resolve) => { finishValidation = resolve; });
        const sent: string[] = [];
        const queue = createCaptainNotificationQueue({ isCurrent: async () => validation, render, send: (text) => { sent.push(text); } });
        queue.agentStarted();
        queue.enqueue("cwd", "run", [alert()]);
        queue.agentEnded();
        const flushing = queue.flushIfIdle();
        expect(queue.invalidate("run")).toEqual(["reviewer"]);
        finishValidation(true);
        await flushing;
        expect(sent).toEqual([]);
    });

    it("does not send when a new captain turn starts during validation", async () => {
        let finishValidation!: (value: boolean) => void;
        const validation = new Promise<boolean>((resolve) => { finishValidation = resolve; });
        const sent: string[] = [];
        const queue = createCaptainNotificationQueue({ isCurrent: async () => validation, render, send: (text) => { sent.push(text); } });
        queue.agentStarted();
        queue.enqueue("cwd", "run", [alert()]);
        queue.agentEnded();
        const flushing = queue.flushIfIdle();
        queue.agentStarted();
        finishValidation(true);
        await flushing;
        expect(sent).toEqual([]);
        expect(queue.pendingCount()).toBe(1);
    });

    it("does not block monitor rearm while delivery waits for captain idle", async () => {
        const currentRun = {
            runId: "run", task: "review", playbookId: "review", status: "running", modelHealth: [],
            workers: [{ roleId: "reviewer", title: "Reviewer", task: "review", status: "running", output: "", tools: [], startedAt: 0 }],
        } as TeamRun;
        const queue = createCaptainNotificationQueue({ isCurrent: async () => true, render, send: () => {} });
        queue.agentStarted();
        const monitor = startCaptainAttentionMonitor({
            readRun: async () => currentRun,
            isTerminal: () => false,
            isCanceled: () => false,
            now: () => 10,
            communicationTimeoutMs: 1,
            intervalMs: 60_000,
            onAttention: (alerts) => { queue.enqueue("cwd", "run", alerts); },
        });
        await monitor.tick();
        expect(queue.pendingCount()).toBe(1);
        await monitor.rearm(["reviewer"], 10);
        monitor.stop();
    });

    it("keeps a notification pending when delivery throws", async () => {
        const queue = createCaptainNotificationQueue({
            isCurrent: async () => true,
            render,
            send: () => { throw new Error("send failed"); },
        });
        queue.agentStarted();
        queue.enqueue("cwd", "run", [alert()]);
        queue.agentEnded();
        await queue.flushIfIdle();
        expect(queue.pendingCount()).toBe(1);
    });
});
