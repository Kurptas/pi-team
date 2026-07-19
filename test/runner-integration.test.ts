import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionHarness = vi.hoisted(() => ({
    behaviors: {} as Record<string, Array<{ error?: string; output?: string; toolName?: string; toolError?: boolean; promptDelayMs?: number }>>,
    calls: [] as string[],
    sentUserMessages: [] as Array<{ key: string; content: string; deliverAs?: string }>,
    timeline: [] as string[],
    onCreate: undefined as undefined | ((key: string) => void),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
    return {
        ...actual,
        createAgentSession: vi.fn(async (options: { model?: { provider?: string; id?: string } }) => {
            const key = `${options.model?.provider}/${options.model?.id}`;
            sessionHarness.calls.push(key);
            sessionHarness.onCreate?.(key);
            const behavior = sessionHarness.behaviors[key]?.shift() ?? { output: `${key} OK` };
            if (behavior.error) throw new Error(behavior.error);
            const listeners = new Set<(event: any) => void>();
            const session = {
                getActiveToolNames: () => ["read"],
                subscribe(listener: (event: any) => void) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                async prompt() {
                    sessionHarness.timeline.push(`prompt-start:${key}`);
                    for (const listener of [...listeners]) listener({ type: "message_start" });
                    if (behavior.promptDelayMs) await new Promise((resolve) => setTimeout(resolve, behavior.promptDelayMs));
                    if (behavior.toolName) {
                        for (const listener of [...listeners]) listener({ type: "tool_execution_start", toolName: behavior.toolName });
                        for (const listener of [...listeners]) listener({
                            type: "tool_execution_end", toolName: behavior.toolName, isError: behavior.toolError === true,
                        });
                    }
                    const message = {
                        role: "assistant",
                        content: [{ type: "text", text: behavior.output ?? "OK" }],
                        api: "openai-completions",
                        provider: options.model?.provider ?? "test",
                        model: options.model?.id ?? "test",
                        stopReason: "stop",
                        timestamp: Date.now(),
                        usage: {
                            input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
                            totalTokens: 2,
                            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                        },
                    };
                    for (const listener of [...listeners]) listener({ type: "message_end", message });
                    for (const listener of [...listeners]) listener({ type: "agent_end", messages: [message] });
                },
                async sendUserMessage(content: unknown, sendOptions?: { deliverAs?: string }) {
                    sessionHarness.timeline.push(`captain-delivery:${key}`);
                    sessionHarness.sentUserMessages.push({ key, content: String(content), deliverAs: sendOptions?.deliverAs });
                },
                dispose() {},
            };
            return { session } as any;
        }),
    };
});

import { appendTeamMessage, prepareTeamControl } from "../src/control.ts";
import { clearModelHealthCache, freshModelHealth, recordModelHealth } from "../src/model-health-cache.ts";
import { runTeamPlan } from "../src/runner.ts";
import { buildTeamStatusProjection } from "../src/status-projection.ts";
import type { PlannedRole, TeamPlan, TeamRun } from "../src/types.ts";

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-runner-integration-"));
    tempDirs.push(dir);
    return dir;
}

function model(key: string): any {
    const [provider, id] = key.split("/");
    return {
        provider, id, name: key, api: "openai-completions", reasoning: true,
        input: ["text"], contextWindow: 16_000, maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

function registry(keys: string[]) {
    const models = new Map(keys.map((key) => [key, model(key)]));
    return { find: (provider: string, id: string) => models.get(`${provider}/${id}`) };
}

function role(roleId: string, overrides: Partial<PlannedRole> = {}): PlannedRole {
    return {
        roleId, title: roleId.toUpperCase(), description: `${roleId} role`, capabilityNeeds: [],
        task: `${roleId} task`, tools: ["read"], systemPrompt: "Return concise output.",
        modelPreferences: [],
        ...overrides,
    };
}

function plan(roles: PlannedRole[]): TeamPlan {
    return {
        objective: "runner integration",
        playbook: {
            id: "integration", title: "Integration", description: "Integration", hints: [],
            defaultMode: "review", maxAgents: roles.length, rounds: [], outputContract: "",
            body: "", source: "default", filePath: "integration",
        },
        policy: {
            rationale: "test", strategy: "test", evidencePolicy: "test", modelPolicy: "test",
            synthesisPolicy: "test", progressMilestones: [], stopCriteria: "done",
        },
        synthesis: { task: "captain decides", requiredSections: [] },
        rounds: [{ id: "r1", type: "parallel", roles }],
    };
}

function run(runId: string): TeamRun {
    return {
        runId, task: "runner integration", playbookId: "integration",
        fallbackPolicy: "strict", status: "planning", modelHealth: [], workers: [],
    };
}

beforeEach(() => {
    clearModelHealthCache();
    sessionHarness.calls.length = 0;
    sessionHarness.sentUserMessages.length = 0;
    sessionHarness.timeline.length = 0;
    sessionHarness.behaviors = {};
    sessionHarness.onCreate = undefined;
});

afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("runTeamPlan model-preparation integration", () => {
    it("applies a mailbox override before dispatch, clears strict skip state, and warns after diversity collapse", async () => {
        const cwd = tempDir();
        const initial = run("team_decision_integration");
        const skippedRole = role("b", {
            modelPreferences: ["p/missing"], skipReason: "strict policy exhausted",
            fallbackReason: "no candidate", policyReason: "strict",
        });
        const teamPlan = plan([
            role("a", { selectedModel: "p/a", thinkingLevel: "minimal", modelPreferences: ["p/a"] }),
            skippedRole,
        ]);
        const prepared = await prepareTeamControl(cwd, initial);
        await appendTeamMessage(cwd, initial.runId, "b=p/a");

        const result = await runTeamPlan(cwd, teamPlan, prepared, {
            inheritedTools: ["read"], modelRegistry: registry(["p/a"]),
            pendingModelDecision: {
                failedPrefs: ["p/missing"], affectedRoles: [{ roleId: "b", preferences: ["p/missing"] }],
                configuredKeys: ["p/a"], windowMs: 2_000, policy: "strict",
            },
            modelDiversity: { healthyModelCount: 2, intendedDistinctModelCount: 2 },
        });

        expect(result.status).toBe("succeeded");
        expect(result.workers).toHaveLength(2);
        expect(result.workers.every((worker) => worker.status === "succeeded" && worker.model === "p/a")).toBe(true);
        expect(result.delegationLanes?.map((lane) => lane.status)).toEqual(["succeeded", "succeeded"]);
        expect(skippedRole).toMatchObject({
            selectedModel: "p/a", skipReason: undefined, fallbackReason: undefined,
            policyReason: "captain role-specific model override",
        });
        expect(result.events?.some((event) => event.phase === "model-decision-window-override")).toBe(true);
        expect(result.events?.some((event) => event.phase === "run-evidence-warning" && event.message.includes("Model diversity reduced"))).toBe(true);
        expect(result.events?.find((event) => event.phase === "worker-start" && event.roleId === "a")?.message)
            .toContain("thinking-requested=minimal");
        expect(result.workers.find((worker) => worker.roleId === "a")?.thinkingLevel).toBe("low");
    });

    it("reports an invalid override, then times out with the strict role still skipped", async () => {
        const cwd = tempDir();
        const initial = run("team_rejected_override_integration");
        const skippedRole = role("blocked", {
            modelPreferences: ["p/missing"], skipReason: "strict policy exhausted",
        });
        const prepared = await prepareTeamControl(cwd, initial);
        await appendTeamMessage(cwd, initial.runId, "blocked=p/unknown");

        const result = await runTeamPlan(cwd, plan([skippedRole]), prepared, {
            inheritedTools: ["read"], modelRegistry: registry(["p/fallback"]),
            pendingModelDecision: {
                failedPrefs: ["p/missing"], affectedRoles: [{ roleId: "blocked", preferences: ["p/missing"] }],
                configuredKeys: ["p/fallback"], windowMs: 100, policy: "strict",
            },
        });

        expect(result.workers[0]).toMatchObject({ status: "skipped", errorReason: "strict policy exhausted" });
        expect(sessionHarness.calls).toEqual([]);
        expect(result.events?.filter((event) => event.phase === "model-decision-window-rejected" && event.message.includes("blocked=p/unknown"))).toHaveLength(1);
        expect(result.events?.some((event) => event.phase === "model-decision-window-timeout" && event.message.includes("strict policy skips"))).toBe(true);
    });

    it("accumulates role overrides sent in separate mailbox messages", async () => {
        const cwd = tempDir();
        const initial = run("team_partial_overrides_integration");
        const teamPlan = plan([
            role("a", { modelPreferences: ["p/missing-a"], skipReason: "strict a" }),
            role("b", { modelPreferences: ["p/missing-b"], skipReason: "strict b" }),
        ]);
        const prepared = await prepareTeamControl(cwd, initial);
        await appendTeamMessage(cwd, initial.runId, "a=p/a");
        let sentSecond = false;
        let secondWrite: Promise<unknown> | undefined;
        const result = await runTeamPlan(cwd, teamPlan, prepared, {
            inheritedTools: ["read"], modelRegistry: registry(["p/a", "p/b"]),
            pendingModelDecision: {
                failedPrefs: ["p/missing-a", "p/missing-b"],
                affectedRoles: [{ roleId: "a", preferences: ["p/missing-a"] }, { roleId: "b", preferences: ["p/missing-b"] }],
                configuredKeys: ["p/a", "p/b"], windowMs: 2_000, policy: "strict",
            },
        }, undefined, (partial) => {
            const state = partial.details as TeamRun | undefined;
            if (!sentSecond && state?.lastEvent?.phase === "model-decision-window-override") {
                sentSecond = true;
                secondWrite = appendTeamMessage(cwd, initial.runId, "b=p/b");
            }
        });
        await secondWrite;

        expect(result.workers.map((worker) => [worker.roleId, worker.model, worker.status])).toEqual([
            ["a", "p/a", "succeeded"], ["b", "p/b", "succeeded"],
        ]);
        expect(result.events?.filter((event) => event.phase === "model-decision-window-override")).toHaveLength(2);
        expect(result.events?.some((event) => event.phase === "model-decision-window-timeout")).toBe(false);
    });

    it("actively injects a targeted captain request into only the addressed worker session", async () => {
        const cwd = tempDir();
        const initial = run("team_targeted_delivery_integration");
        const prepared = await prepareTeamControl(cwd, initial);
        const request = await appendTeamMessage(cwd, initial.runId, "finish now", { targetRoleId: "a" });
        sessionHarness.behaviors["p/a"] = [{ output: "a done", promptDelayMs: 30 }];
        sessionHarness.behaviors["p/b"] = [{ output: "b done", promptDelayMs: 30 }];

        const result = await runTeamPlan(cwd, plan([
            role("a", { selectedModel: "p/a" }), role("b", { selectedModel: "p/b" }),
        ]), prepared, {
            inheritedTools: ["read"], modelRegistry: registry(["p/a", "p/b"]),
        });

        const deliveries = sessionHarness.sentUserMessages.filter((message) => message.content.includes(`Captain request ${request.requestId}:`));
        expect(deliveries).toEqual([expect.objectContaining({ key: "p/a", deliverAs: "steer" })]);
        expect(sessionHarness.timeline.indexOf("prompt-start:p/a")).toBeLessThan(sessionHarness.timeline.indexOf("captain-delivery:p/a"));
        expect(result.workers.find((worker) => worker.roleId === "a")).toMatchObject({
            lastCaptainMessageRef: request.requestId,
            lastCaptainDeliveredRef: request.requestId,
        });
        expect(result.workers.find((worker) => worker.roleId === "b")?.lastCaptainMessageRef).toBeUndefined();
    });

    it("preserves an ACK emitted before mailbox polling creates the request ledger", async () => {
        const cwd = tempDir();
        const initial = run("team_early_ack_integration");
        const prepared = await prepareTeamControl(cwd, initial);
        const request = await appendTeamMessage(cwd, initial.runId, "ack this", { targetRoleId: "a" });
        sessionHarness.behaviors["p/a"] = [{ output: `RADIO: ack=${request.requestId}; status=received\nresult_summary: done` }];
        const result = await runTeamPlan(cwd, plan([role("a", { selectedModel: "p/a" })]), prepared, {
            inheritedTools: ["read"], modelRegistry: registry(["p/a"]),
        });
        expect(result.workers[0]?.captainRequests?.[request.requestId]).toMatchObject({
            requestRef: request.requestId,
            ackedAt: expect.any(Number),
        });
    });

    it("dispatches the selected auto-fallback after a task-first decision timeout", async () => {
        const cwd = tempDir();
        const fallback = "p/fallback";
        const result = await runTeamPlan(cwd, plan([role("fallback", {
            selectedModel: fallback, modelPreferences: ["p/missing"], fallbackReason: "soft preference unavailable",
        })]), run("team_fallback_timeout_integration"), {
            inheritedTools: ["read"], modelRegistry: registry([fallback]),
            pendingModelDecision: {
                failedPrefs: ["p/missing"], affectedRoles: [{ roleId: "fallback", preferences: ["p/missing"] }],
                configuredKeys: [fallback], windowMs: 0, policy: "task_first",
            },
        });

        expect(result.workers[0]).toMatchObject({ model: fallback, status: "succeeded" });
        expect(result.events?.some((event) => event.phase === "model-decision-window-timeout" && event.message.includes("auto-fallback"))).toBe(true);
    });

    it("records a failed primary attempt before a successful lazy fallback retry", async () => {
        const cwd = tempDir();
        const primary = "p/primary";
        const fallback = "p/fallback";
        sessionHarness.behaviors[primary] = [{ output: "", toolName: "read", toolError: true }];
        sessionHarness.behaviors[fallback] = [{ output: "fallback succeeded", toolName: "read" }];
        let primaryHealthWhenFallbackStarted: string | undefined;
        sessionHarness.onCreate = (key) => {
            if (key === fallback) primaryHealthWhenFallbackStarted = freshModelHealth([primary])[0]?.status;
        };
        recordModelHealth({
            model: primary, provider: "p", status: "probe_passed", latencyMs: 1, checkedAt: Date.now(),
        });
        const teamPlan = plan([role("retry", {
            selectedModel: primary, modelPreferences: [primary], modelFallbackKeys: [fallback],
        })]);

        const result = await runTeamPlan(cwd, teamPlan, run("team_retry_integration"), {
            inheritedTools: ["read"], modelRegistry: registry([primary, fallback]),
        });

        expect(result.status).toBe("succeeded");
        expect(sessionHarness.calls).toEqual([primary, fallback]);
        expect(primaryHealthWhenFallbackStarted).toBe("provider_error");
        expect(result.workers[0]).toMatchObject({ model: fallback, status: "succeeded" });
        expect(result.delegationLanes?.[0]?.status).toBe("succeeded");
        expect(result.workers[0]?.modelAttempts).toEqual([
            expect.objectContaining({ model: primary, status: "failed" }),
            expect.objectContaining({ model: fallback, status: "succeeded" }),
        ]);
        expect(result.workers[0]?.events?.filter((event) => event.phase === "worker-tool" && event.message.includes("tool_execution_start"))).toHaveLength(2);
        expect(result.workers[0]?.events?.filter((event) => event.phase === "worker-tool" && event.isError)).toHaveLength(1);
        expect(buildTeamStatusProjection(result, []).workers[0]).toMatchObject({ toolCallCount: 2, toolErrorCount: 1 });
        expect(freshModelHealth([primary])[0]).toMatchObject({
            model: primary, status: "provider_error", evidenceSource: "worker",
        });
        expect(result.modelHealth).toEqual(expect.arrayContaining([
            expect.objectContaining({ model: primary, status: "provider_error", evidenceSource: "worker" }),
            expect.objectContaining({ model: fallback, status: "probe_passed", evidenceSource: "worker" }),
        ]));
    });
});
