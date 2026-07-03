// Dynamic fanout (P2): pure data-shaping helpers that expand an upstream
// worker's validated structuredOutput array into N child roles. This module
// never spawns workers or makes captain decisions — the runner owns execution,
// and every truncation / skip is surfaced by the runner as an observable event.
// Extracted from runner.ts to keep that file under the size-gate limit.
import type { PlannedRole, TeamEvent, TeamPlan, WorkerRun } from "./types.ts";

/**
 * Resolve a JSON Pointer (RFC 6901 subset) against a value. Returns undefined
 * if any segment is missing. Supports the common `/a/b/0` shape.
 */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
    if (pointer === "") return value;
    if (!pointer.startsWith("/")) return undefined;
    return pointer
        .slice(1)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce<unknown>((current, part) => {
            if (current === undefined || current === null) return undefined;
            if (Array.isArray(current)) {
                if (!/^\d+$/.test(part)) return undefined;
                return current[Number(part)];
            }
            if (typeof current === "object") return (current as Record<string, unknown>)[part];
            return undefined;
        }, value);
}

function fanoutEmptyMode(round: TeamPlan["rounds"][number]): "skip" | "fail" {
    return round.fanout?.expand.onEmpty ?? "skip";
}

function fanoutKeyPart(value: unknown, fallback: number): string {
    const raw = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : String(fallback);
    return raw.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+|-+$/g, "") || String(fallback);
}

export function resolveFanoutItems(round: TeamPlan["rounds"][number], upstreamWorkers: WorkerRun[]): { items?: unknown[]; reason?: string; onEmpty: "skip" | "fail" } {
    const fanout = round.fanout;
    const onEmpty = fanoutEmptyMode(round);
    if (!fanout) return { reason: "fanout configuration is missing", onEmpty };
    const upstream = upstreamWorkers.find((worker) => worker.roleId === fanout.expand.fromRoleId);
    const source = upstream?.structuredOutput;
    const resolved = source === undefined ? undefined : resolveJsonPointer(source, fanout.expand.path);
    if (!upstream) return { reason: `upstream role '${fanout.expand.fromRoleId}' was not found`, onEmpty };
    if (source === undefined) return { reason: `upstream role '${fanout.expand.fromRoleId}' has no structuredOutput`, onEmpty };
    if (!Array.isArray(resolved)) return { reason: `path '${fanout.expand.path}' on upstream role '${fanout.expand.fromRoleId}' did not resolve to an array`, onEmpty };
    if (resolved.length === 0) return { reason: `path '${fanout.expand.path}' on upstream role '${fanout.expand.fromRoleId}' resolved to an empty array`, onEmpty };
    return { items: resolved, onEmpty };
}

/**
 * Pure planner for a fanout round. Decides whether to abort (skip/fail) or
 * dispatch, and pre-builds every observable event so the runner only owns
 * execution (worker dispatch + state mutation). No timestamps, no side effects.
 */
export type FanoutDispatchPlan =
    | { kind: "abort"; event: TeamEvent }
    | { kind: "dispatch"; roles: PlannedRole[]; preEvents: TeamEvent[]; collectEvent?: TeamEvent };

export function planFanoutDispatch(round: TeamPlan["rounds"][number], roundRoles: PlannedRole[], upstreamWorkers: WorkerRun[]): FanoutDispatchPlan {
    const fanout = round.fanout;
    const resolvedFanout = resolveFanoutItems(round, upstreamWorkers);
    const abort = (reason: string): FanoutDispatchPlan => ({
        kind: "abort",
        event: {
            phase: resolvedFanout.onEmpty === "fail" ? "fanout-round-failed" : "fanout-round-skipped",
            message: `${round.id} ${resolvedFanout.onEmpty === "fail" ? "failed" : "skipped"}: ${reason}`,
            isError: true,
        },
    });
    if (!fanout) return abort(resolvedFanout.reason ?? "fanout configuration is missing");
    if (roundRoles.length === 0) return abort("fanout template role is missing");
    if (!resolvedFanout.items) return abort(resolvedFanout.reason ?? "fanout source did not resolve to items");
    const materialized = materializeFanoutRoles({ ...round, roles: roundRoles }, resolvedFanout.items);
    const preEvents: TeamEvent[] = [];
    if (materialized.truncated) {
        preEvents.push({
            phase: "fanout-truncated",
            message: `${round.id} source array had ${materialized.originalCount} item(s); dispatching first ${materialized.roles.length} due to maxItems=${fanout.expand.maxItems}`,
            isError: true,
        });
    }
    preEvents.push({
        phase: "fanout-expanded",
        message: `${round.id} expanded ${materialized.roles.length} worker(s) from ${fanout.expand.fromRoleId}${roundRoles.length > 1 ? ` using first template role '${roundRoles[0]!.roleId}'` : ""}`,
        isError: roundRoles.length > 1,
    });
    const collectEvent: TeamEvent | undefined = fanout.collect?.as
        ? {
              phase: "fanout-collected",
              message: `${round.id} collected ${materialized.roles.length} child result(s) as '${fanout.collect.as}'`,
          }
        : undefined;
    return { kind: "dispatch", roles: materialized.roles, preEvents, collectEvent };
}

export function materializeFanoutRoles(round: TeamPlan["rounds"][number], items: unknown[]): { roles: PlannedRole[]; truncated: boolean; originalCount: number } {
    const fanout = round.fanout;
    if (!fanout || round.roles.length === 0) return { roles: [], truncated: false, originalCount: items.length };
    const maxItems = Math.max(0, fanout.expand.maxItems);
    const selectedItems = items.slice(0, maxItems);
    const template = round.roles[0]!;
    const itemName = fanout.expand.itemName ?? "item";
    const seenRoleIds = new Map<string, number>();
    const roles = selectedItems.map((item, index) => {
        const keyValue = fanout.expand.keyPath ? resolveJsonPointer(item, fanout.expand.keyPath) : undefined;
        const key = fanoutKeyPart(keyValue, index);
        const baseRoleId = `${template.roleId}-${key}`;
        const duplicateCount = seenRoleIds.get(baseRoleId) ?? 0;
        seenRoleIds.set(baseRoleId, duplicateCount + 1);
        const roleId = duplicateCount === 0 ? baseRoleId : `${baseRoleId}-${duplicateCount + 1}`;
        const itemJson = JSON.stringify(item, null, 2);
        return {
            ...template,
            roleId,
            title: `${template.title} [${key}]`,
            task: [
                "Fanout item context:",
                `- Source role: ${fanout.expand.fromRoleId}`,
                `- Source path: ${fanout.expand.path}`,
                `- ${itemName}:`,
                "```json",
                itemJson,
                "```",
                "",
                "Original task:",
                template.task,
            ].join("\n"),
        };
    });
    return { roles, truncated: items.length > selectedItems.length, originalCount: items.length };
}
