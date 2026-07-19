import { structuredOutputInstruction } from "./structured-output.ts";
import type {
    GeneratedTeamBlueprint,
    ModelCapabilityDimension,
    PlannedRole,
    Playbook,
    PlaybookRound,
    RoleSpec,
    TeamInput,
    TeamInputRole,
    TeamPlan,
    TeamPlanPolicy,
    TeamResources,
} from "./types.ts";

const GENERATED_PLAYBOOK_ID = "generated-blueprint";
const NO_CAPABILITY_NEEDS: ModelCapabilityDimension[] = [];

function slug(value: string, fallback: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || fallback;
}

export function selectPlaybook(input: TeamInput, playbooks: Playbook[]): Playbook | undefined {
    if (input.playbook) return playbooks.find((playbook) => playbook.id === input.playbook);
    return playbooks.find((playbook) => playbook.id === "research-roundtable") ?? playbooks[0];
}

function defaultPolicy(playbook: Playbook): TeamPlanPolicy {
    return {
        rationale: playbook.description,
        strategy: playbook.body.trim() || playbook.description,
        evidencePolicy: "Workers should separate cited evidence, inference, confidence, and missing information.",
        modelPolicy: "Use configured models that are objectively available; keep soft health observations visible.",
        synthesisPolicy: "The lead uses worker outputs as inputs and keeps final judgment outside the extension.",
        progressMilestones: playbook.rounds.map((round) => `${round.name}: ${round.goal ?? round.type}`),
        stopCriteria: "All planned rounds have returned a status and the run log is persisted.",
    };
}

function roleTask(objective: string, playbook: Playbook, role: RoleSpec, roundGoal?: string): string {
    // Append the machine-consumable JSON instruction only when the role's
    // outputSchema actually resolves to a schema. Advisory: the worker still
    // owns its prose finding; the JSON block is an additional structured summary
    // the captain / synthesis / dynamic fanout can consume.
    const structuredInstruction = structuredOutputInstruction(role.outputSchema);
    return [
        `Objective: ${objective}`,
        `Playbook: ${playbook.title} (${playbook.id})`,
        `Role: ${role.title} (${role.id})`,
        role.description ? `Role boundary: ${role.description}` : undefined,
        roundGoal ? `Round goal: ${roundGoal}` : undefined,
        "",
        "Use your role prompt and return a concise structured finding.",
        "Required fields: result_summary, evidence_refs, confidence, disagreements, next_questions.",
        ...(structuredInstruction ? ["", structuredInstruction] : []),
    ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
}

function plannedRole(objective: string, playbook: Playbook, role: RoleSpec, roundGoal?: string): PlannedRole {
    return {
        roleId: role.id,
        title: role.title,
        description: role.description,
        capabilityNeeds: role.capabilityNeeds,
        task: roleTask(objective, playbook, role, roundGoal),
        tools: role.tools,
        systemPrompt: role.body,
        modelPreferences: role.modelPreferences,
        outputSchema: role.outputSchema,
        thinkingLevel: role.thinkingLevel,
    };
}

function roleCapabilityNeeds(role: TeamInputRole | undefined): ModelCapabilityDimension[] {
    return role?.capabilityNeeds ?? NO_CAPABILITY_NEEDS;
}

const REVIEW_MODES = new Set(["review", "code"]);

function roleFromInput(role: TeamInputRole, index: number, mode?: string): RoleSpec {
    const title = role.title.trim();
    const id = role.id?.trim() ? slug(role.id, `role-${index + 1}`) : `custom-${slug(title, `role-${index + 1}`)}`;
    const capability = role.capability?.trim();
    const description = role.description?.trim() || capability || `Task-specific role: ${title}`;
    const modelFit = role.modelFit?.trim();
    const defaultTools = ["read", "write", "bash"];
    return {
        id,
        title,
        description,
        tools: role.tools ?? defaultTools,
        capabilityNeeds: role.capabilityNeeds ?? NO_CAPABILITY_NEEDS,
        modelPreferences: role.modelPreferences ?? [],
        thinkingLevel: role.thinking ?? (REVIEW_MODES.has(mode ?? "") ? "high" : undefined),
        outputSchema: "worker_finding",
        body:
            role.systemPrompt?.trim() ||
            [
                `You are the ${title}.`,
                capability ? `Core capability: ${capability}` : undefined,
                description,
                role.capabilityNeeds?.length ? `Capability needs: ${role.capabilityNeeds.join(", ")}` : undefined,
                modelFit ? `Model-fit considerations: ${modelFit}` : undefined,
                "",
                "Stay within this role boundary and return verifiable, mergeable structured findings.",
                "State evidence sources, reasoning, confidence, disagreements, and questions that still need verification.",
                "Write the output in the user's language unless the task requires otherwise.",
            ]
                .filter((line): line is string => line !== undefined)
                .join("\n"),
        source: "project",
        filePath: "(generated)",
    };
}

function inputRoleId(role: TeamInputRole, index: number): string {
    const title = role.title.trim();
    return role.id?.trim() ? slug(role.id, `role-${index + 1}`) : `custom-${slug(title, `role-${index + 1}`)}`;
}

function generatedRoleRounds(input: TeamInput, blueprint: GeneratedTeamBlueprint | undefined, roles: RoleSpec[]): PlaybookRound[] {
    if (blueprint?.rounds) {
        return blueprint.rounds
            .map((round) => ({ name: round.id, type: round.type, roles: round.roles, goal: round.goal, fanout: round.fanout }))
            .filter((round) => round.roles.length > 0);
    }
    const sourceRoles = input.roles ?? [];
    const hasDependencies = sourceRoles.some((role) => (role.dependsOn?.length ?? 0) > 0 || (role.reportsTo?.length ?? 0) > 0);
    if (!hasDependencies) return [{ name: "collect", type: "parallel", roles: roles.map((role) => role.id) }];

    const roleIds = sourceRoles.map(inputRoleId);
    const known = new Set(roleIds);
    const deps = new Map(roleIds.map((id) => [id, new Set<string>()]));
    sourceRoles.forEach((role, index) => {
        const id = roleIds[index];
        for (const dep of role.dependsOn ?? []) if (known.has(dep)) deps.get(id)?.add(dep);
        for (const target of role.reportsTo ?? []) if (known.has(target)) deps.get(target)?.add(id);
    });

    const rounds: PlaybookRound[] = [];
    const completed = new Set<string>();
    const remaining = new Set(roleIds);
    while (remaining.size > 0) {
        const wave = [...remaining].filter((id) => [...(deps.get(id) ?? [])].every((dep) => completed.has(dep)));
        if (wave.length === 0) break;
        for (const id of wave) {
            remaining.delete(id);
            completed.add(id);
        }
        rounds.push({ name: `wave-${rounds.length + 1}`, type: wave.length === 1 ? "single" : "parallel", roles: wave });
    }
    return rounds.length > 0 ? rounds : [{ name: "collect", type: "parallel", roles: roles.map((role) => role.id) }];
}

function generatedPlaybook(
    input: TeamInput,
    blueprint: GeneratedTeamBlueprint | undefined,
    roles: RoleSpec[],
): Playbook {
    return {
        id: GENERATED_PLAYBOOK_ID,
        title: blueprint?.title.trim() || "Dynamic team blueprint",
        description: blueprint?.rationale.trim() || "A task-specific collaboration blueprint generated for the lead captain",
        hints: [],
        defaultMode: input.mode ?? "research",
        maxAgents: Math.max(1, input.maxAgents ?? roles.length),
        rounds: generatedRoleRounds(input, blueprint, roles),
        outputContract: input.outputContract ?? "findings",
        body: blueprint?.strategy.trim() || "The lead captain generated this collaboration plan; the extension handles dispatch, communication, observation, and recording.",
        source: "project",
        filePath: "(generated)",
    };
}

export function createTeamPlan(
    input: TeamInput,
    resources: TeamResources,
    blueprint?: GeneratedTeamBlueprint,
): TeamPlan {
    const inputRoles: TeamInputRole[] = blueprint?.roles ?? input.roles ?? [];
    const generatedRoles = inputRoles.map((r, i) => roleFromInput(r, i, input.mode)).filter((role) => role.title.trim()) ?? [];
    const playbook =
        generatedRoles.length > 0
            ? generatedPlaybook(input, blueprint, generatedRoles)
            : selectPlaybook(input, resources.playbooks);
    if (!playbook) throw new Error("No team playbook available.");

    const rolesById = new Map([...resources.roles, ...generatedRoles].map((role) => [role.id, role]));
    const maxAgents = Math.max(1, Math.min(input.maxAgents ?? playbook.maxAgents, playbook.maxAgents));
    const rounds = playbook.rounds.map((round) => {
        const roles = round.roles
            .map((roleId) => rolesById.get(roleId))
            .filter((role): role is RoleSpec => role !== undefined)
            .slice(0, maxAgents)
            .map((role) => {
                const planned = plannedRole(input.task, playbook, role, round.goal);
                const sourceRole = inputRoles.find((item) => {
                    const id = item.id?.trim() ? slug(item.id, "") : "";
                    return id === role.id || role.id === `custom-${slug(item.title, "")}`;
                });
                return {
                    ...planned,
                    capability: sourceRole?.capability?.trim(),
                    capabilityNeeds: sourceRole ? roleCapabilityNeeds(sourceRole) : planned.capabilityNeeds,
                    modelFit: sourceRole?.modelFit?.trim(),
                    thinkingLevel: planned.thinkingLevel ?? (REVIEW_MODES.has(input.mode ?? "") ? "high" : undefined),
                    dependsOn: sourceRole?.dependsOn,
                    reportsTo: sourceRole?.reportsTo,
                    sop: sourceRole?.sop,
                    resumable: sourceRole?.resumable,
                };
            });
        return { id: round.name, type: round.type, goal: round.goal, roles, fanout: round.fanout };
    });
    const activeRounds = rounds.filter((round) => round.roles.length > 0);

    if (activeRounds.length === 0) throw new Error(`Playbook "${playbook.id}" has no loadable roles.`);

    // Build bidirectional dependency graph spanning all rounds (metadata only — does NOT affect scheduling).
    const blockedBy = new Map<string, Set<string>>();
    const blocks = new Map<string, Set<string>>();
    for (const round of activeRounds) {
        for (const role of round.roles) {
            // dependsOn: this role waits for these → it is blocked by them
            for (const dep of role.dependsOn ?? []) {
                if (!blockedBy.has(role.roleId)) blockedBy.set(role.roleId, new Set());
                blockedBy.get(role.roleId)!.add(dep);
                if (!blocks.has(dep)) blocks.set(dep, new Set());
                blocks.get(dep)!.add(role.roleId);
            }
            // reportsTo: these roles wait for this one → they are blocked by this role
            for (const target of role.reportsTo ?? []) {
                if (!blockedBy.has(target)) blockedBy.set(target, new Set());
                blockedBy.get(target)!.add(role.roleId);
                if (!blocks.has(role.roleId)) blocks.set(role.roleId, new Set());
                blocks.get(role.roleId)!.add(target);
            }
        }
    }

    const policy: TeamPlanPolicy = blueprint
        ? {
              rationale: blueprint.rationale,
              strategy: blueprint.strategy,
              evidencePolicy: blueprint.evidencePolicy,
              modelPolicy: blueprint.modelPolicy,
              synthesisPolicy: blueprint.synthesisPolicy,
              progressMilestones: blueprint.progressMilestones,
              stopCriteria: blueprint.stopCriteria,
          }
        : defaultPolicy(playbook);

    return {
        objective: input.task,
        playbook,
        rounds: activeRounds,
        policy,
        blockedBy: blockedBy.size > 0 ? blockedBy : undefined,
        blocks: blocks.size > 0 ? blocks : undefined,
        synthesis: {
            task: [
                `Synthesize the team findings for: ${input.task}`,
                `Strategy: ${policy.strategy}`,
                `Evidence policy: ${policy.evidencePolicy}`,
                `Synthesis policy: ${policy.synthesisPolicy}`,
                "Use role outputs, identify disagreements, state confidence, and name missing evidence.",
            ].join("\n"),
            requiredSections: ["Decision", "Role findings", "Disagreements", "Evidence", "Confidence"],
        },
    };
}
