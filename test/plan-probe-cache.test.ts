import { beforeEach, describe, expect, it } from "vitest";
import { clearModelHealthCache, recordModelHealth } from "../src/model-health-cache.ts";
import { probePlan } from "../src/plan-probe.ts";
import type { ConfiguredModel } from "../src/model-selection.ts";
import type { TeamModel, TeamPlan } from "../src/types.ts";

const configured: ConfiguredModel[] = [{ key: "provider/model", provider: "provider", id: "model", name: "Model" }];
const available: TeamModel[] = [{ provider: "provider", id: "model", name: "Model", reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
const plan: TeamPlan = {
    objective: "test",
    playbook: { id: "p", title: "P", description: "P", hints: [], defaultMode: "review", maxAgents: 1, rounds: [], outputContract: "", body: "", source: "default", filePath: "p" },
    policy: { rationale: "r", strategy: "s", evidencePolicy: "e", modelPolicy: "m", synthesisPolicy: "s", progressMilestones: [], stopCriteria: "done" },
    synthesis: { task: "s", requiredSections: [] },
    rounds: [{ id: "r", type: "single", roles: [{ roleId: "r", title: "R", description: "R", capabilityNeeds: [], task: "t", tools: [], systemPrompt: "s", modelPreferences: ["provider/model"] }] }],
};

describe("probe plan health cache", () => {
    beforeEach(() => clearModelHealthCache());

    it("skips the network probe when recent health exists", async () => {
        recordModelHealth({ model: "provider/model", provider: "provider", status: "probe_passed", latencyMs: 1, checkedAt: Date.now() });
        let calls = 0;
        const result = await probePlan(plan, configured, available, "strict", true, async () => {
            calls += 1;
            throw new Error("should not probe");
        });
        expect(calls).toBe(0);
        expect(result.modelHealth[0]).toMatchObject({ status: "probe_passed", evidenceSource: "probe" });
    });

    it("probes only explicit primaries across dependent rounds", async () => {
        const models: ConfiguredModel[] = [
            ...configured,
            { key: "provider/merge", provider: "provider", id: "merge", name: "Merge" },
        ];
        const teamModels: TeamModel[] = [
            ...available,
            { provider: "provider", id: "merge", name: "Merge", reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ];
        const dependent = structuredClone(plan);
        dependent.rounds = [
            { id: "evidence", type: "single", roles: [{ ...dependent.rounds[0]!.roles[0]!, roleId: "evidence", modelPreferences: ["provider/model"] }] },
            { id: "merge", type: "single", roles: [{ ...dependent.rounds[0]!.roles[0]!, roleId: "merge", modelPreferences: ["provider/merge"], dependsOn: ["evidence"] }] },
        ];
        const calls: string[] = [];
        const result = await probePlan(dependent, models, teamModels, "task_first", true, async (model) => {
            calls.push(`${model.provider}/${model.id}`);
            return { model: `${model.provider}/${model.id}`, provider: model.provider, status: "probe_passed", latencyMs: 1, checkedAt: Date.now() };
        });
        expect(calls.sort()).toEqual(["provider/merge", "provider/model"]);
        expect(result.probeSet.rolePlans!.every((role) => role.candidates.length > 1)).toBe(true);
    });

    it("removes a lazy fallback with a cached hard failure without probing it", async () => {
        const models: ConfiguredModel[] = [
            ...configured,
            { key: "provider/fallback", provider: "provider", id: "fallback", name: "Fallback" },
        ];
        const teamModels: TeamModel[] = [
            ...available,
            { provider: "provider", id: "fallback", name: "Fallback", reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ];
        recordModelHealth({
            model: "provider/fallback", provider: "provider", status: "model_rejected",
            latencyMs: 1, checkedAt: Date.now(), reason: "model not found",
        });
        const calls: string[] = [];
        const result = await probePlan(plan, models, teamModels, "task_first", true, async (model) => {
            calls.push(`${model.provider}/${model.id}`);
            return { model: `${model.provider}/${model.id}`, provider: model.provider, status: "probe_passed", latencyMs: 1, checkedAt: Date.now() };
        });
        expect(calls).toEqual(["provider/model"]);
        expect(result.resolved.rolePlans[0]!.hardFailedModels).toContain("provider/fallback");
        expect(result.resolved.rolePlans[0]!.fallbackModels).not.toContain("provider/fallback");
    });

    it("honors cache bypass when probeModels is disabled", async () => {
        recordModelHealth({ model: "provider/model", provider: "provider", status: "probe_passed", latencyMs: 1, checkedAt: Date.now() });
        let calls = 0;
        const result = await probePlan(plan, configured, available, "strict", true, async (model) => {
            calls += 1;
            return { model: `${model.provider}/${model.id}`, provider: model.provider, status: "probe_skipped", latencyMs: 0, checkedAt: Date.now() };
        }, undefined, false);
        expect(calls).toBe(1);
        expect(result.modelHealth[0]).toMatchObject({ status: "probe_skipped", evidenceSource: "probe" });
    });
});
