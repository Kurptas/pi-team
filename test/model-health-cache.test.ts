import { beforeEach, describe, expect, it } from "vitest";
import { clearModelHealthCache, freshModelHealth, recordModelHealth, recordWorkerModelOutcome } from "../src/model-health-cache.ts";
import type { ModelHealthSnapshot, WorkerRun } from "../src/types.ts";

function snapshot(status: ModelHealthSnapshot["status"], checkedAt = 1_000): ModelHealthSnapshot {
    return { model: "provider/model", provider: "provider", status, latencyMs: 10, checkedAt };
}

describe("model health cache", () => {
    beforeEach(() => clearModelHealthCache());

    it("reuses a recent probe result and expires it", () => {
        recordModelHealth(snapshot("probe_passed"), "probe", 1_000);
        expect(freshModelHealth(["provider/model"], 2_000)[0]).toMatchObject({ evidenceSource: "probe" });
        expect(freshModelHealth(["provider/model"], 122_000)).toHaveLength(0);
    });

    it("keeps recent real worker success over a soft probe failure", () => {
        const worker = {
            roleId: "r", title: "R", task: "t", model: "provider/model",
            status: "succeeded", output: "evidence", outputKind: "substantive",
            tools: [], startedAt: 1_000, endedAt: 2_000,
        } as WorkerRun;
        recordWorkerModelOutcome(worker, 2_000);
        recordModelHealth(snapshot("timeout"), "probe", 3_000);
        expect(freshModelHealth(["provider/model"], 4_000)[0]).toMatchObject({
            status: "probe_passed", evidenceSource: "worker", reason: "recent worker produced substantive output",
        });
    });

    it("does not cache skipped workers as model health evidence", () => {
        recordWorkerModelOutcome({
            roleId: "r", title: "R", task: "t", status: "skipped",
            model: "provider/model", output: "", outputKind: "empty", tools: [],
        } as WorkerRun, 1_000);
        expect(freshModelHealth(["provider/model"], 2_000)).toEqual([]);
    });

    it("does not poison health on captain cancellation or local tool-policy failure", () => {
        recordModelHealth(snapshot("probe_passed"), "probe", 1_000);
        expect(recordWorkerModelOutcome({
            roleId: "r", title: "R", task: "t", model: "provider/model", status: "failed",
            output: "", outputKind: "empty", tools: [], errorReason: "aborted", cancelObservedAt: 2_000,
        } as WorkerRun, 2_000)).toBeUndefined();
        expect(recordWorkerModelOutcome({
            roleId: "r", title: "R", task: "t", model: "provider/model", status: "failed",
            output: "", outputKind: "empty", tools: [], errorReason: "tool isolation violation",
            toolIsolationViolation: "active tools exceed role whitelist",
        } as WorkerRun, 2_500)).toBeUndefined();
        expect(freshModelHealth(["provider/model"], 3_000)[0]).toMatchObject({
            status: "probe_passed", evidenceSource: "probe",
        });
    });

    it("replaces a cached probe pass with a real worker failure", () => {
        recordModelHealth(snapshot("probe_passed"), "probe", 1_000);
        recordWorkerModelOutcome({
            roleId: "r", title: "R", task: "t", model: "provider/model",
            status: "failed", output: "", outputKind: "empty", tools: [],
            errorReason: "provider returned 502", startedAt: 1_500, endedAt: 2_000,
        } as WorkerRun, 2_000);
        recordModelHealth(snapshot("probe_passed", 2_500), "probe", 2_500);
        expect(freshModelHealth(["provider/model"], 3_000)[0]).toMatchObject({
            status: "provider_error", evidenceSource: "worker", reason: "recent worker failure: provider returned 502",
        });
    });
});
