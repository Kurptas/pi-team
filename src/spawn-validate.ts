import type { PlannedRole } from "./types.ts";

export type SpawnDecision =
    | { ok: true; role: PlannedRole }
    | { ok: false; reason: string };

// Pure validation for a captain-spawned worker (2026-07-03 A-1/A-2). Extracted
// from the runner loop so collision + shape rules are unit-testable. Rejects:
//   - malformed payload (missing roleId/title)
//   - roleId that collides with a planned or already-spawned role — reusing one
//     would satisfy a planned blocker through completedRoleIds and corrupt
//     dependency state the plan never declared.
//   - spawn count already at the ceiling
export function validateSpawnRole(
    raw: { role?: Partial<PlannedRole> } | undefined,
    knownRoleIds: ReadonlySet<string>,
    spawnedCount: number,
    maxSpawned: number,
): SpawnDecision {
    if (spawnedCount >= maxSpawned) return { ok: false, reason: `max spawned workers reached (${maxSpawned})` };
    const role = raw?.role;
    if (!role?.roleId || !role.title) return { ok: false, reason: "spawn payload missing roleId or title" };
    if (knownRoleIds.has(role.roleId)) return { ok: false, reason: `roleId '${role.roleId}' collides with an existing role` };
    return {
        ok: true,
        role: {
            roleId: role.roleId,
            title: role.title,
            description: role.description ?? role.title,
            capabilityNeeds: role.capabilityNeeds ?? [],
            task: role.task ?? "",
            tools: role.tools ?? [],
            systemPrompt: role.systemPrompt ?? role.title,
            modelPreferences: role.modelPreferences ?? [],
        },
    };
}
