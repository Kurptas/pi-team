import { describe, expect, it } from "vitest";
import { applyRoleModelOverrides, collectCaptainModelDecision, parseRoleModelOverrides } from "../src/model-decision.ts";
import type { TeamPlan } from "../src/types.ts";

const roles = [
    { roleId: "ux", preferences: ["grok/grok"] },
    { roleId: "synthesis", preferences: ["openai/gpt"] },
];
const models = ["grok/grok", "openai/gpt", "qwen/qwen"];

describe("role-specific model decisions", () => {
    it("parses independent role=model overrides without collapsing roles", () => {
        const out = parseRoleModelOverrides("ux=qwen/qwen synthesis=openai/gpt", roles, models);
        expect([...out]).toEqual([["ux", "qwen/qwen"], ["synthesis", "openai/gpt"]]);
    });

    it("ignores bare model keys when multiple roles are affected", () => {
        expect(parseRoleModelOverrides("qwen/qwen", roles, models).size).toBe(0);
    });

    it("accepts a bare model key when only one role is affected", () => {
        const out = parseRoleModelOverrides("please use qwen/qwen", [roles[0]], models);
        expect([...out]).toEqual([["ux", "qwen/qwen"]]);
    });

    it("reports unconfigured role-specific model keys", () => {
        const out = parseRoleModelOverrides("ux=unknown/model", roles, models);
        expect(out.size).toBe(0);
        expect(out.rejected).toEqual([{ roleId: "ux", model: "unknown/model", reason: "model_not_configured" }]);
    });

    it("reports an unconfigured bare key when one role is affected", () => {
        const out = parseRoleModelOverrides("please use unknown/model", [roles[0]], models);
        expect(out.rejected).toEqual([{ roleId: "ux", model: "unknown/model", reason: "model_not_configured" }]);
    });

    it("rejects a bare model when multiple roles require explicit mapping", () => {
        const out = parseRoleModelOverrides("qwen/qwen", roles, models);
        expect(out.rejected).toEqual([{ roleId: "*", model: "qwen/qwen", reason: "role_required" }]);
    });

    it("rejects malformed model keys", () => {
        const out = parseRoleModelOverrides("ux=qwen3.6-plus", roles, models);
        expect(out.rejected).toEqual([{ roleId: "ux", model: "qwen3.6-plus", reason: "invalid_model_key" }]);
    });

    it("rejects assignments to roles outside the decision window", () => {
        const out = parseRoleModelOverrides("unknown=qwen/qwen", roles, models);
        expect(out.rejected).toEqual([{ roleId: "unknown", model: "qwen/qwen", reason: "role_not_affected" }]);
    });

    it("merges role overrides across separate captain messages and deduplicates rejections", () => {
        const reported = new Set<string>();
        const out = collectCaptainModelDecision([
            "ux=qwen/qwen", "synthesis=openai/gpt", "unknown=bad/model", "unknown=bad/model",
        ], roles, models, reported);
        expect([...out.overrides!]).toEqual([["ux", "qwen/qwen"], ["synthesis", "openai/gpt"]]);
        expect(out.rejectionMessages).toHaveLength(1);
    });

    it("matches exact model keys rather than overlapping substrings", () => {
        const configured = ["openai/gpt-5", "openai/gpt-5.4"];
        const out = parseRoleModelOverrides("ux=openai/gpt-5.4", [roles[0]], configured);
        expect([...out]).toEqual([["ux", "openai/gpt-5.4"]]);
    });

    it("clears stale strict-policy skip state when an override is applied", () => {
        const plan = {
            rounds: [{ id: "r1", type: "parallel", roles: [{
                roleId: "ux", title: "UX", task: "review", capabilityNeeds: [], modelPreferences: [],
                selectedModel: undefined, skipReason: "strict policy exhausted", fallbackReason: "no candidate",
            }] }],
        } as unknown as TeamPlan;
        expect(applyRoleModelOverrides(plan, new Map([["ux", "qwen/qwen"]]))).toBe(1);
        expect(plan.rounds[0]!.roles[0]).toMatchObject({
            selectedModel: "qwen/qwen", skipReason: undefined, fallbackReason: undefined,
            policyReason: "captain role-specific model override",
        });
    });
});
