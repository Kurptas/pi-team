import * as fs from "node:fs";
import * as path from "node:path";
import { teamBaseDir } from "./control.ts";
import type { TeamPlan, TeamRun } from "./types.ts";

export interface TeamBlueprintArtifact {
    blueprintId: string;
    runId: string;
    task: string;
    playbookId: string;
    playbookTitle: string;
    source: "generated";
    status: "draft";
    createdAt: number;
    roles: Array<{
        roleId: string;
        title: string;
        description: string;
        capability?: string;
        capabilityNeeds: string[];
        tools: string[];
        modelPreferences: string[];
        modelFit?: string;
    }>;
    rounds: Array<{
        id: string;
        type: string;
        goal?: string;
        roles: string[];
    }>;
    policy: TeamPlan["policy"];
    outputContract: string;
    captainRationale: string;
}

export interface PromotedBlueprintArtifact extends Omit<TeamBlueprintArtifact, "source" | "status"> {
    source: "promoted";
    status: "promoted";
    promotedFromBlueprintId: string;
    promotedFromRunId: string;
    promotedAt: number;
    captainNote: string;
}

export interface PersistedBlueprintArtifact {
    artifact: TeamBlueprintArtifact;
    filePath: string;
}

export interface PersistedPromotedBlueprintArtifact {
    artifact: PromotedBlueprintArtifact;
    filePath: string;
}

export function safeBlueprintId(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return normalized || "blueprint";
}

export function buildBlueprintArtifact(plan: TeamPlan, run: TeamRun, createdAt = Date.now()): TeamBlueprintArtifact {
    return {
        blueprintId: safeBlueprintId(`${run.runId}-${plan.playbook.id}`),
        runId: run.runId,
        task: run.task,
        playbookId: plan.playbook.id,
        playbookTitle: plan.playbook.title,
        source: "generated",
        status: "draft",
        createdAt,
        roles: plan.rounds.flatMap((round) =>
            round.roles.map((role) => ({
                roleId: role.roleId,
                title: role.title,
                description: role.description,
                capability: role.capability,
                capabilityNeeds: role.capabilityNeeds,
                tools: role.tools,
                modelPreferences: role.modelPreferences,
                modelFit: role.modelFit,
            })),
        ),
        rounds: plan.rounds.map((round) => ({
            id: round.id,
            type: round.type,
            goal: round.goal,
            roles: round.roles.map((role) => role.roleId),
        })),
        policy: plan.policy,
        outputContract: plan.playbook.outputContract,
        captainRationale: plan.policy.rationale,
    };
}

async function writeArtifactFile<T>(dir: string, id: string, artifact: T): Promise<string> {
    await fs.promises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${safeBlueprintId(id)}.json`);
    await fs.promises.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
    });
    return filePath;
}

function generatedBlueprintDir(cwd: string): string {
    return path.join(teamBaseDir(cwd), "blueprints", "generated");
}

function promotedBlueprintDir(cwd: string): string {
    return path.join(teamBaseDir(cwd), "blueprints", "promoted");
}

export async function persistBlueprintArtifact(cwd: string, plan: TeamPlan, run: TeamRun): Promise<PersistedBlueprintArtifact> {
    const artifact = buildBlueprintArtifact(plan, run);
    const filePath = await writeArtifactFile(generatedBlueprintDir(cwd), artifact.blueprintId, artifact);
    return { artifact, filePath };
}

export async function readGeneratedBlueprintArtifact(cwd: string, blueprintId: string): Promise<TeamBlueprintArtifact> {
    const safeId = safeBlueprintId(blueprintId);
    const filePath = path.join(generatedBlueprintDir(cwd), `${safeId}.json`);
    return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as TeamBlueprintArtifact;
}

export async function promoteBlueprintArtifact(
    cwd: string,
    blueprintId: string,
    captainNote: string,
    promotedAt = Date.now(),
): Promise<PersistedPromotedBlueprintArtifact> {
    if (!captainNote.trim()) throw new Error("captainNote is required for blueprint promotion");
    const generated = await readGeneratedBlueprintArtifact(cwd, blueprintId);
    const promoted: PromotedBlueprintArtifact = {
        ...generated,
        source: "promoted",
        status: "promoted",
        promotedFromBlueprintId: generated.blueprintId,
        promotedFromRunId: generated.runId,
        promotedAt,
        captainNote,
    };
    const filePath = await writeArtifactFile(promotedBlueprintDir(cwd), promoted.blueprintId, promoted);
    return { artifact: promoted, filePath };
}
