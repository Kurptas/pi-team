import { Type } from "typebox";

/**
 * TypeBox parameter schemas for the team extension's tools.
 *
 * Pure schema declarations with zero coupling to the extension factory,
 * module state, or the `pi` object — extracted from index.ts so the entry
 * file stays focused on wiring. Import these where registerTool() needs them.
 */

export const TeamParams = Type.Object({
    task: Type.String({ description: "Task for the team to complete" }),
    playbook: Type.Optional(Type.String({ description: "Playbook id, such as etf-research or code-review" })),
    mode: Type.Optional(Type.String({ description: "Task mode: research, roundtable, code, review, strategy" })),
    maxAgents: Type.Optional(Type.Number({ description: "Maximum number of worker roles to run" })),
    probeModels: Type.Optional(Type.Boolean({ description: "Run live model probes before dispatch. Default: true" })),
    outputContract: Type.Optional(Type.String({ description: "Output contract hint" })),
    fallbackPolicy: Type.Optional(
        Type.Union([
            Type.Literal("task_first"),
            Type.Literal("strict"),
            Type.Literal("cheap_only"),
        ], { description: "Model fallback behavior: task_first (default), strict (do not auto-fallback beyond explicit/recommended candidates), or cheap_only (fallback only to low-cost/fast models)." }),
    ),
    roles: Type.Optional(
        Type.Array(
            Type.Object({
                id: Type.Optional(Type.String({ description: "Stable role id for generated playbooks" })),
                title: Type.String({ description: "Task-specific role title" }),
                capability: Type.Optional(Type.String({ description: "Role capability profile" })),
                capabilityNeeds: Type.Optional(
                    Type.Array(Type.String({ description: "Capability tags needed by this role" })),
                ),
                description: Type.Optional(Type.String({ description: "Role responsibility and boundary" })),
                systemPrompt: Type.Optional(Type.String({ description: "Role-specific system prompt" })),
                tools: Type.Optional(Type.Array(Type.String({ description: "Tools this role should use" }))),
                modelFit: Type.Optional(Type.String({ description: "What model qualities fit this role" })),
                thinking: Type.Optional(
                    Type.Union([
                        Type.Literal("off"),
                        Type.Literal("minimal"),
                        Type.Literal("low"),
                        Type.Literal("medium"),
                        Type.Literal("high"),
                        Type.Literal("xhigh"),
                    ], { description: "Explicit thinking level for this role. You can also append it to a model preference, e.g. provider/model:high." }),
                ),
                modelPreferences: Type.Optional(
                    Type.Array(Type.String({ description: "Preferred provider/model keys; may include :thinking suffix, e.g. provider/model:high" })),
                ),
                dependsOn: Type.Optional(
                    Type.Array(Type.String({ description: "Role ids that must finish before this role starts" })),
                ),
                reportsTo: Type.Optional(
                    Type.Array(Type.String({ description: "Role ids that should run after this role" })),
                ),
                sop: Type.Optional(
                    Type.Array(Type.String({ description: "SOP ids to inject into this worker's system prompt (e.g. [\"code-review\", \"research\"]). Files live in defaults/manuals/sop/<id>.md." })),
                ),
                resumable: Type.Optional(Type.Boolean({ description: "When true, this role's worker session persists to disk and the SAME roleId in a later round resumes with full prior context instead of starting fresh. Default false (in-memory, wiped after the run). Opt-in for multi-round 'same teammate continues' work." })),
            }),
            { description: "Task-specific roles designed by the lead agent when built-in playbooks are too generic" },
        ),
    ),
    background: Type.Optional(
        Type.Boolean({ description: "Run the team in the background. Default: true. When true, team returns immediately with a runId so the captain can observe with team_status and control with team_message/team_cancel_worker. When false, blocks until the team finishes (ESC cancels the run)." }),
    ),
});

export const TeamRunParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
});

export const TeamMessageParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    message: Type.String({ description: "Captain message for active workers" }),
});

export const TeamCancelParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    reason: Type.Optional(Type.String({ description: "Reason shown in the cancel marker" })),
});

export const TeamPromoteBlueprintParams = Type.Object({
    blueprintId: Type.Optional(Type.String({ description: "Generated blueprint id. Defaults to the run blueprint id." })),
    runId: Type.Optional(Type.String({ description: "Team run id to read blueprint id from when blueprintId is omitted." })),
    captainNote: Type.String({ description: "Captain judgment for why this generated blueprint is worth reusing." }),
});

export const TeamCancelWorkerParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    roleId: Type.String({ description: "Worker role id to cancel." }),
    reason: Type.Optional(Type.String({ description: "Reason for canceling this specific worker." })),
    confirm: Type.Optional(Type.Boolean({ description: "Required (true) to cancel the LAST running worker — ends all live execution, no new evidence this round. Not needed when other workers remain." })),
});
