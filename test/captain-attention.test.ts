import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
    CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS,
    captainAttentionPush,
    emptyCaptainAttentionState,
    evaluateCaptainAttention,
    isCaptainAttentionAlertCurrent,
    readCaptainAttentionState,
    rearmCaptainAttention,
    releaseCaptainAttention,
    startCaptainAttentionMonitor,
    writeCaptainAttentionState,
    type CaptainAttentionState,
} from "../src/captain-attention.ts";
import type { TeamRun, WorkerRun } from "../src/types.ts";

function worker(overrides: Partial<WorkerRun> = {}): WorkerRun {
    return {
        roleId: "reviewer", title: "Reviewer", task: "review", model: "p/m",
        status: "running", output: "", outputKind: "empty", tools: [],
        startedAt: 0, lastSignalAt: 0, tokens: 0, requests: 0, events: [],
        ...overrides,
    };
}

function run(currentWorker: WorkerRun): TeamRun {
    return {
        runId: "team_attention", playbookId: "review", task: "review", status: "running",
        createdAt: 0, updatedAt: 0, workers: [currentWorker], modelHealth: [],
    } as TeamRun;
}

function sample(state: CaptainAttentionState, currentWorker: WorkerRun, now: number) {
    return evaluateCaptainAttention(run(currentWorker), state, now, CAPTAIN_ATTENTION_COMMUNICATION_TIMEOUT_MS);
}

describe("captain attention monitor", () => {
    it("alerts when effective communication exceeds two minutes, regardless of execution activity", () => {
        let state = emptyCaptainAttentionState();
        const busy = worker({ tokens: 100_000, requests: 20, lastSignalAt: 119_999 });
        let result = sample(state, busy, 119_999);
        expect(result.alerts).toEqual([]);
        state = result.state;

        result = sample(state, worker({ tokens: 200_000, requests: 40, lastSignalAt: 120_000 }), 120_000);
        expect(result.alerts).toEqual([
            expect.objectContaining({ roleId: "reviewer", reason: "communication_silence", communicationAgeMs: 120_000 }),
        ]);
    });

    it("alerts once per silence episode and resets only after new effective communication", () => {
        let result = sample(emptyCaptainAttentionState(), worker(), 120_000);
        expect(result.alerts).toHaveLength(1);
        expect(sample(result.state, worker({ tokens: 999 }), 300_000).alerts).toEqual([]);

        result = sample(result.state, worker({ lastReportAt: 300_000, lastReportPreview: "RADIO: progress" }), 300_000);
        expect(result.alerts).toEqual([]);
        result = sample(result.state, worker({ lastReportAt: 300_000, lastReportPreview: "RADIO: progress" }), 420_000);
        expect(result.alerts).toEqual([
            expect.objectContaining({ reason: "communication_silence", communicationAgeMs: 120_000 }),
        ]);
    });

    it("opens exactly one new two-minute window when captain observes an alerted worker", () => {
        const first = sample(emptyCaptainAttentionState(), worker(), 120_000);
        expect(first.alerts).toHaveLength(1);
        const rearmed = rearmCaptainAttention(first.state, ["reviewer"], 120_000);
        expect(sample(rearmed, worker(), 239_999).alerts).toEqual([]);
        const second = sample(rearmed, worker(), 240_000);
        expect(second.alerts).toEqual([expect.objectContaining({ reason: "communication_silence" })]);
        expect(sample(second.state, worker(), 500_000).alerts).toEqual([]);
    });

    it("does not re-arm a worker that has not already surfaced attention", () => {
        const baseline = sample(emptyCaptainAttentionState(), worker({ lastReportAt: 30_000 }), 30_000);
        const rearmed = rearmCaptainAttention(baseline.state, ["reviewer"], 30_000);
        expect(rearmed.roles.reviewer?.rearmAt).toBeUndefined();
        expect(sample(rearmed, worker({ lastReportAt: 30_000 }), 150_000).alerts).toHaveLength(1);
    });

    it("validates the exact communication episode before delayed delivery", () => {
        const first = sample(emptyCaptainAttentionState(), worker(), 120_000);
        const alert = first.alerts[0]!;
        expect(isCaptainAttentionAlertCurrent(run(worker()), alert)).toBe(true);
        expect(isCaptainAttentionAlertCurrent(run(worker({ lastReportAt: 120_001 })), alert)).toBe(false);
        expect(isCaptainAttentionAlertCurrent(run(worker({ status: "succeeded" })), alert)).toBe(false);
    });

    it("releases an alert that was queued but never delivered", () => {
        const first = sample(emptyCaptainAttentionState(), worker(), 120_000);
        const released = releaseCaptainAttention(first.state, ["reviewer"]);
        expect(released.roles.reviewer?.silenceAlerted).toBe(false);
        expect(released.roles.reviewer?.rearmAt).toBeUndefined();
        expect(sample(released, worker(), 120_001).alerts).toHaveLength(1);
    });

    it("persists attention episodes across monitor reloads", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-attention-"));
        const file = path.join(dir, "attention-state.json");
        const alerted = sample(emptyCaptainAttentionState(), worker(), 120_000).state;
        await writeCaptainAttentionState(file, alerted);
        const restored = await readCaptainAttentionState(file);
        expect(restored).toEqual(alerted);
        expect(sample(restored!, worker(), 300_000).alerts).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("keeps concurrent persistence writes isolated with unique temp files", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-attention-race-"));
        const file = path.join(dir, "attention-state.json");
        const a = { roles: { a: { communicationAt: 1, silenceAlerted: true, pendingAckAlerted: false, cancelAlerted: false } } };
        const b = { roles: { b: { communicationAt: 2, silenceAlerted: false, pendingAckAlerted: true, cancelAlerted: false } } };
        await Promise.all([writeCaptainAttentionState(file, a), writeCaptainAttentionState(file, b)]);
        expect([a, b]).toContainEqual(await readCaptainAttentionState(file));
        expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("distinguishes a queued request that has not reached the worker session", () => {
        const queued = worker({ lastCaptainMessageAt: 10_000, lastCaptainMessageRef: "req-queued" });
        const result = sample(emptyCaptainAttentionState(), queued, 130_000);
        expect(result.alerts).toEqual([
            expect.objectContaining({ reason: "request_delivery_pending", requestRef: "req-queued", requestAgeMs: 120_000 }),
        ]);
    });

    it("opens a new episode when a queued request becomes delivered", () => {
        const queued = worker({ captainRequests: {
            "req-stage": { requestRef: "req-stage", queuedAt: 10_000 },
        } });
        const first = sample(emptyCaptainAttentionState(), queued, 130_000);
        expect(first.alerts).toEqual([expect.objectContaining({ reason: "request_delivery_pending" })]);
        expect(isCaptainAttentionAlertCurrent(run(queued), first.alerts[0]!)).toBe(true);
        const delivered = worker({ captainRequests: {
            "req-stage": { requestRef: "req-stage", queuedAt: 10_000, deliveredAt: 140_000 },
        } });
        expect(isCaptainAttentionAlertCurrent(run(delivered), first.alerts[0]!)).toBe(false);
        expect(sample(first.state, delivered, 260_000).alerts).toEqual([
            expect.objectContaining({ reason: "unacknowledged_request", requestRef: "req-stage" }),
        ]);
    });

    it("alerts once when a delivered captain request has not been acknowledged", () => {
        const pending = worker({
            lastReportAt: 100_000,
            lastCaptainMessageAt: 100_000,
            lastCaptainMessageRef: "req-1",
            lastCaptainDeliveredAt: 110_000,
            lastCaptainDeliveredRef: "req-1",
        });
        let result = sample(emptyCaptainAttentionState(), pending, 230_000);
        expect(result.alerts).toEqual([
            expect.objectContaining({ reason: "unacknowledged_request", requestRef: "req-1", requestAgeMs: 120_000 }),
        ]);
        expect(sample(result.state, pending, 400_000).alerts).toEqual([]);

        const acknowledged = worker({
            lastReportAt: 240_000,
            lastCaptainMessageAt: 100_000,
            lastCaptainMessageRef: "req-1",
            lastCaptainDeliveredAt: 110_000,
            lastCaptainDeliveredRef: "req-1",
            lastCaptainAckAt: 240_000,
            lastCaptainAckRef: "req-1",
        });
        result = sample(result.state, acknowledged, 240_000);
        expect(result.alerts).toEqual([]);
    });

    it("does not let a newer acknowledged request hide an older unresolved request", () => {
        const pending = worker({ captainRequests: {
            old: { requestRef: "old", queuedAt: 1_000, deliveredAt: 2_000 },
            newer: { requestRef: "newer", queuedAt: 3_000, deliveredAt: 4_000, ackedAt: 5_000 },
        }, lastCaptainAckRef: "newer", lastCaptainAckAt: 5_000 });
        expect(sample(emptyCaptainAttentionState(), pending, 122_000).alerts).toEqual([
            expect.objectContaining({ reason: "unacknowledged_request", requestRef: "old" }),
        ]);
    });

    it("opens a new acknowledgment episode for a new captain request", () => {
        const first = worker({ lastCaptainMessageAt: 0, lastCaptainMessageRef: "req-1" });
        let result = sample(emptyCaptainAttentionState(), first, 120_000);
        expect(result.alerts).toHaveLength(1);
        const second = worker({ lastCaptainMessageAt: 130_000, lastCaptainMessageRef: "req-2" });
        result = sample(result.state, second, 250_000);
        expect(result.alerts).toEqual([expect.objectContaining({ requestRef: "req-2" })]);
    });

    it("surfaces a cooperative cancel request that remains unobserved", () => {
        const pending = worker({ cancelRequestedAt: 10_000 });
        const result = sample(emptyCaptainAttentionState(), pending, 130_000);
        expect(result.alerts).toEqual([
            expect.objectContaining({ reason: "cancel_pending", cancelAgeMs: 120_000 }),
        ]);
        expect(isCaptainAttentionAlertCurrent(run(pending), result.alerts[0]!)).toBe(true);
        expect(isCaptainAttentionAlertCurrent(run(worker({ cancelRequestedAt: 10_000, cancelObservedAt: 20_000 })), result.alerts[0]!)).toBe(false);
        expect(sample(result.state, pending, 300_000).alerts).toEqual([]);
    });

    it("drops terminal workers from monitor state", () => {
        const initial = sample(emptyCaptainAttentionState(), worker(), 30_000).state;
        const result = evaluateCaptainAttention(run(worker({ status: "succeeded" })), initial, 60_000);
        expect(result).toEqual({ state: { roles: {} }, alerts: [] });
    });

    it("suppresses a raced RADIO update and stops on cancel", async () => {
        let current = run(worker());
        let now = 120_000;
        let canceled = false;
        let reads = 0;
        let queuedReads: TeamRun[] = [];
        const pushed: string[][] = [];
        const monitor = startCaptainAttentionMonitor({
            readRun: async () => {
                reads += 1;
                return queuedReads.shift() ?? current;
            },
            isTerminal: (value) => value.status !== "running",
            isCanceled: () => canceled,
            onAttention: (alerts) => { pushed.push(alerts.map((alert) => alert.roleId)); },
            intervalMs: 1_000_000,
            communicationTimeoutMs: 120_000,
            now: () => now,
        });

        const progressed = run(worker({ lastReportAt: now, lastReportPreview: "RADIO: still working" }));
        queuedReads = [current, progressed];
        await monitor.tick();
        expect(pushed).toEqual([]);

        current = progressed;
        now = 240_000;
        await monitor.tick();
        expect(pushed).toEqual([["reviewer"]]);
        now = 360_000;
        await monitor.tick();
        expect(pushed).toHaveLength(1);

        canceled = true;
        await monitor.tick();
        const readsAtStop = reads;
        await monitor.tick();
        expect(reads).toBe(readsAtStop);
    });

    it("retries attention delivery after the notification callback fails", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-attention-delivery-"));
        const file = path.join(dir, "attention-state.json");
        let attempts = 0;
        const monitor = startCaptainAttentionMonitor({
            readRun: async () => run(worker()),
            isTerminal: () => false,
            isCanceled: () => false,
            onAttention: () => {
                attempts += 1;
                if (attempts === 1) throw new Error("delivery failed");
            },
            stateFile: file,
            intervalMs: 1_000_000,
            communicationTimeoutMs: 120_000,
            now: () => 120_000,
        });
        await monitor.tick();
        expect(attempts).toBe(1);
        await monitor.tick();
        expect(attempts).toBe(2);
        await monitor.tick();
        expect(attempts).toBe(2);
        monitor.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("caps and prioritizes aggregated multi-worker attention output", () => {
        const alerts = Array.from({ length: 7 }, (_, index) => ({
            roleId: `role-${index}`, title: `Role ${index}`, reason: index === 6 ? "unacknowledged_request" as const : "communication_silence" as const,
            requestRef: index === 6 ? "req-priority" : undefined,
            requestAgeMs: index === 6 ? 121_000 : undefined,
            communicationAgeMs: 120_000 + index,
        }));
        const text = captainAttentionPush("team_many", alerts);
        expect(text).toContain("req-priority");
        expect(text).toContain("+2 more worker(s)");
        expect(text).not.toContain("role-0 (Role 0)");
    });

    it("frames attention as a one-shot evidence reminder rather than a decision", () => {
        const text = captainAttentionPush("team_attention", [{
            roleId: "reviewer", title: "Reviewer", model: "p/m",
            reason: "unacknowledged_request", requestRef: "req-1", requestAgeMs: 120_000,
        }]);
        expect(text).toContain("has no worker ACK after 120s");
        expect(text).toContain("notified once");
        expect(text).toContain("No worker was canceled or rerouted");
        expect(text).toContain("does not make that judgment");
    });
});
