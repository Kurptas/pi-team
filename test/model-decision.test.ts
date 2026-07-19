import { describe, expect, it } from "vitest";
import { applyRoleModelOverrides, collectCaptainModelDecision, parseRoleModelOverrides } from "../src/model-decision.ts";
import type { TeamPlan } from "../src/types.ts";

const roles = [
    { roleId: "ux", preferences: ["provider-c/model-c"] },
    { roleId: "synthesis", preferences: ["provider-a/model-a"] },
];
const models = ["provider-c/model-c", "provider-a/model-a", "provider-b/model-b"];

describe("role-specific model decisions", () => {
    it("parses independent role=model overrides without collapsing roles", () => {
        const out = parseRoleModelOverrides("ux=provider-b/model-b synthesis=provider-a/model-a", roles, models);
        expect([...out]).toEqual([["ux", "provider-b/model-b"], ["synthesis", "provider-a/model-a"]]);
    });

    it("ignores bare model keys when multiple roles are affected", () => {
        expect(parseRoleModelOverrides("provider-b/model-b", roles, models).size).toBe(0);
    });

    it("accepts a bare model key when only one role is affected", () => {
        const out = parseRoleModelOverrides("please use provider-b/model-b", [roles[0]], models);
        expect([...out]).toEqual([["ux", "provider-b/model-b"]]);
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
        const out = parseRoleModelOverrides("provider-b/model-b", roles, models);
        expect(out.rejected).toEqual([{ roleId: "*", model: "provider-b/model-b", reason: "role_required" }]);
    });

    it("rejects malformed model keys", () => {
        const out = parseRoleModelOverrides("ux=model-b-plus", roles, models);
        expect(out.rejected).toEqual([{ roleId: "ux", model: "model-b-plus", reason: "invalid_model_key" }]);
    });

    it("rejects assignments to roles outside the decision window", () => {
        const out = parseRoleModelOverrides("unknown=provider-b/model-b", roles, models);
        expect(out.rejected).toEqual([{ roleId: "unknown", model: "provider-b/model-b", reason: "role_not_affected" }]);
    });

    it("merges role overrides across separate captain messages and deduplicates rejections", () => {
        const reported = new Set<string>();
        const out = collectCaptainModelDecision([
            "ux=provider-b/model-b", "synthesis=provider-a/model-a", "unknown=bad/model", "unknown=bad/model",
        ], roles, models, reported);
        expect([...out.overrides!]).toEqual([["ux", "provider-b/model-b"], ["synthesis", "provider-a/model-a"]]);
        expect(out.rejectionMessages).toHaveLength(1);
    });

    it("matches exact model keys rather than overlapping substrings", () => {
        const configured = ["provider-a/model-a-v1", "provider-a/model-a-v2"];
        const out = parseRoleModelOverrides("ux=provider-a/model-a-v2", [roles[0]], configured);
        expect([...out]).toEqual([["ux", "provider-a/model-a-v2"]]);
    });

    it("clears stale strict-policy skip state when an override is applied", () => {
        const plan = {
            rounds: [{ id: "r1", type: "parallel", roles: [{
                roleId: "ux", title: "UX", task: "review", capabilityNeeds: [], modelPreferences: [],
                selectedModel: undefined, skipReason: "strict policy exhausted", fallbackReason: "no candidate",
            }] }],
        } as unknown as TeamPlan;
        expect(applyRoleModelOverrides(plan, new Map([["ux", "provider-b/model-b"]]))).toBe(1);
        expect(plan.rounds[0]!.roles[0]).toMatchObject({
            selectedModel: "provider-b/model-b", skipReason: undefined, fallbackReason: undefined,
            policyReason: "captain role-specific model override",
        });
    });
});
