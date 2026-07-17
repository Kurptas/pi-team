import { describe, expect, it } from "vitest";
import {
    CAPTAIN_ATTENTION_FROZEN_CHECKS,
    CAPTAIN_ATTENTION_INTERVAL_MS,
    CAPTAIN_ATTENTION_MIN_SILENCE_MS,
    captainAttentionPush,
    emptyCaptainAttentionState,
    evaluateCaptainAttention,
    startCaptainAttentionMonitor,
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
    return evaluateCaptainAttention(
        run(currentWorker), state, now,
        CAPTAIN_ATTENTION_FROZEN_CHECKS, CAPTAIN_ATTENTION_MIN_SILENCE_MS,
    );
}

describe("captain attention monitor", () => {
    it("alerts only after the production sustained-silence thresholds", () => {
        let state = emptyCaptainAttentionState();
        const alertTick = Math.max(
            CAPTAIN_ATTENTION_FROZEN_CHECKS + 1,
            Math.ceil(CAPTAIN_ATTENTION_MIN_SILENCE_MS / CAPTAIN_ATTENTION_INTERVAL_MS),
        );
        for (let tick = 1; tick < alertTick; tick += 1) {
            const result = sample(state, worker(), tick * CAPTAIN_ATTENTION_INTERVAL_MS);
            state = result.state;
            expect(result.alerts).toEqual([]);
        }
        const now = alertTick * CAPTAIN_ATTENTION_INTERVAL_MS;
        const result = sample(state, worker(), now);
        expect(result.alerts).toEqual([
            expect.objectContaining({ roleId: "reviewer", frozenChecks: alertTick - 1, signalAgeMs: now }),
        ]);
    });

    it("deduplicates alerts until recorded progress resumes", () => {
        let state = emptyCaptainAttentionState();
        let now = 0;
        let alerts = [] as ReturnType<typeof sample>["alerts"];
        while (alerts.length === 0) {
            now += CAPTAIN_ATTENTION_INTERVAL_MS;
            const result = sample(state, worker(), now);
            state = result.state;
            alerts = result.alerts;
        }
        expect(sample(state, worker(), now + CAPTAIN_ATTENTION_INTERVAL_MS).alerts).toEqual([]);

        now += CAPTAIN_ATTENTION_INTERVAL_MS;
        const progressed = worker({ tokens: 10, lastSignalAt: now });
        let result = sample(state, progressed, now);
        expect(result.alerts).toEqual([]);
        state = result.state;
        alerts = [];
        while (alerts.length === 0) {
            now += CAPTAIN_ATTENTION_INTERVAL_MS;
            result = sample(state, progressed, now);
            state = result.state;
            alerts = result.alerts;
        }
        expect(alerts).toHaveLength(1);
    });

    it("drops terminal workers from monitor state", () => {
        const initial = sample(emptyCaptainAttentionState(), worker(), 30_000).state;
        const result = evaluateCaptainAttention(run(worker({ status: "succeeded" })), initial, 60_000);
        expect(result).toEqual({ state: { roles: {} }, alerts: [] });
    });

    it("suppresses a raced progress update, deduplicates pushes, and stops on cancel", async () => {
        let current = run(worker());
        let now = 0;
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
            frozenChecksRequired: 1,
            minSilenceMs: 0,
            now: () => now,
        });
        await monitor.tick(); // baseline

        now = 1;
        const progressed = run(worker({ tokens: 1, lastSignalAt: 1 }));
        queuedReads = [current, progressed];
        await monitor.tick();
        expect(pushed).toEqual([]);

        current = progressed;
        now = 2;
        await monitor.tick();
        expect(pushed).toEqual([["reviewer"]]);
        now = 3;
        await monitor.tick();
        expect(pushed).toHaveLength(1);

        canceled = true;
        await monitor.tick();
        const readsAtStop = reads;
        await monitor.tick();
        expect(reads).toBe(readsAtStop);
    });

    it("stops monitoring when the persisted run is terminal", async () => {
        let reads = 0;
        let current: TeamRun = { ...run(worker({ status: "succeeded" })), status: "succeeded" };
        const monitor = startCaptainAttentionMonitor({
            readRun: async () => { reads += 1; return current; },
            isTerminal: (value) => value.status !== "running",
            isCanceled: () => false,
            onAttention: () => { throw new Error("must not push"); },
            intervalMs: 1_000_000,
        });
        await monitor.tick();
        current = run(worker());
        await monitor.tick();
        expect(reads).toBe(1);
    });

    it("frames attention as evidence rather than cancellation", () => {
        const text = captainAttentionPush("team_attention", [{
            roleId: "reviewer", title: "Reviewer", model: "p/m", frozenChecks: 4, signalAgeMs: 150_000,
        }]);
        expect(text).toContain("No worker was canceled or rerouted");
        expect(text).toContain("not a stuck verdict");
        expect(text).toContain("Do not repeatedly poll");
    });
});
