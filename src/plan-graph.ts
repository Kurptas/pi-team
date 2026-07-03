import type { PlannedRole, TeamPlan } from "./types.ts";

export interface PlanGraphValidation {
    errors: string[];
    warnings: string[];
}

// dependsOn and reportsTo are OPPOSITE directions and must not be conflated:
//   role.dependsOn = [X]  → role waits for X   → X must be in an EARLIER round; cycle edge role→X
//   role.reportsTo = [Y]  → Y waits for role   → Y must be in a LATER round;   cycle edge Y→role
// Conflating them (treating reportsTo like dependsOn) wrongly rejects every
// normal `builder reportsTo reviewer` plan, because the reviewer is correctly
// scheduled LATER, not earlier. (2026-07-03 A-2 review: CRITICAL fix.)

export function validateTeamPlanGraph(plan: TeamPlan): PlanGraphValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (plan.rounds.length === 0) errors.push("team plan has no rounds");

    const roundIds = new Set<string>();
    const roleFirstRound = new Map<string, number>();
    const graph = new Map<string, Set<string>>();

    plan.rounds.forEach((round, roundIndex) => {
        if (roundIds.has(round.id)) warnings.push(`duplicate round id '${round.id}'`);
        roundIds.add(round.id);
        const inRound = new Set<string>();
        for (const role of round.roles) {
            if (inRound.has(role.roleId)) warnings.push(`duplicate role '${role.roleId}' inside round '${round.id}'`);
            inRound.add(role.roleId);
            if (!roleFirstRound.has(role.roleId)) roleFirstRound.set(role.roleId, roundIndex);
            if (!graph.has(role.roleId)) graph.set(role.roleId, new Set());
        }
    });

    for (const round of plan.rounds) {
        for (const role of round.roles) {
            // dependsOn: this role waits for `dep` → dep must be in an earlier round.
            for (const dep of role.dependsOn ?? []) {
                if (!roleFirstRound.has(dep)) {
                    errors.push(`role '${role.roleId}' references unknown dependency '${dep}'`);
                    continue;
                }
                graph.get(role.roleId)?.add(dep);
                if (roleFirstRound.get(dep)! >= roleFirstRound.get(role.roleId)!) {
                    errors.push(`role '${role.roleId}' depends on '${dep}' which is not in an earlier round`);
                }
            }
            // reportsTo: `target` waits for this role → target must be in a LATER round.
            // Cycle edge is target→role (target depends on role), the reverse of dependsOn.
            for (const target of role.reportsTo ?? []) {
                if (!roleFirstRound.has(target)) {
                    errors.push(`role '${role.roleId}' references unknown reportsTo target '${target}'`);
                    continue;
                }
                graph.get(target)?.add(role.roleId);
                if (roleFirstRound.get(target)! <= roleFirstRound.get(role.roleId)!) {
                    errors.push(`role '${role.roleId}' reportsTo '${target}' which is not in a later round`);
                }
            }
        }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (roleId: string, stack: string[]): void => {
        if (visited.has(roleId)) return;
        if (visiting.has(roleId)) {
            errors.push(`cycle detected in role dependencies: ${[...stack, roleId].join(" -> ")}`);
            return;
        }
        visiting.add(roleId);
        for (const dep of graph.get(roleId) ?? []) visit(dep, [...stack, roleId]);
        visiting.delete(roleId);
        visited.add(roleId);
    };
    for (const roleId of graph.keys()) visit(roleId, []);

    return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
