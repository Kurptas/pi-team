import { describe, expect, it } from "vitest";
import { resolveThinkingCompatibility } from "../src/thinking-compat.ts";

function reasoningModel(thinkingLevelMap?: Record<string, string | null>) {
    return { reasoning: true, thinkingLevelMap } as any;
}

describe("thinking compatibility", () => {
    it("uses conservative common levels when custom model metadata is absent", () => {
        expect(resolveThinkingCompatibility("minimal", reasoningModel())).toMatchObject({
            requested: "minimal", effective: "low",
        });
        expect(resolveThinkingCompatibility("xhigh", reasoningModel())).toMatchObject({
            requested: "xhigh", effective: "high",
        });
        expect(resolveThinkingCompatibility("medium", reasoningModel())).toEqual({
            requested: "medium", effective: "medium", transportValue: undefined, note: undefined,
        });
    });

    it("uses arbitrary provider transport values declared by thinkingLevelMap", () => {
        expect(resolveThinkingCompatibility("minimal", reasoningModel({ minimal: "low" }))).toMatchObject({
            requested: "minimal", effective: "minimal", transportValue: "low",
        });
        expect(resolveThinkingCompatibility("xhigh", reasoningModel({ xhigh: "max" }))).toMatchObject({
            requested: "xhigh", effective: "xhigh", transportValue: "max",
        });
    });

    it("clamps null levels and omits thinking when no semantic level is supported", () => {
        expect(resolveThinkingCompatibility("minimal", reasoningModel({ minimal: null }))).toMatchObject({
            requested: "minimal", effective: "low",
        });
        const none = { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null };
        expect(resolveThinkingCompatibility("high", reasoningModel(none))).toMatchObject({
            requested: "high", effective: undefined,
            note: "thinking requested=high; effective=provider-default",
        });
    });

    it("omits thinking when no level was requested or the model is non-reasoning", () => {
        expect(resolveThinkingCompatibility(undefined, reasoningModel())).toEqual({});
        expect(resolveThinkingCompatibility("high", { reasoning: false } as any)).toMatchObject({
            requested: "high", effective: undefined,
        });
    });

    it("preserves the request when model metadata is unavailable", () => {
        expect(resolveThinkingCompatibility("low", undefined)).toEqual({ requested: "low", effective: "low" });
    });
});
