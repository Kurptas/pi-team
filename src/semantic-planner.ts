import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { piInvocation } from "./pi-invocation.ts";
import { isModelCapabilityDimension } from "./types.ts";
import type {
    GeneratedTeamBlueprint,
    ModelCapabilityDimension,
    ModelCapabilityProfile,
    FanoutOnEmpty,
    FanoutRoundConfig,
    RoundType,
    TeamInput,
    TeamInputRole,
    TeamInputRound,
} from "./types.ts";

interface SemanticPlanJson {
    title?: unknown;
    rationale?: unknown;
    strategy?: unknown;
    roles?: unknown;
    rounds?: unknown;
    evidencePolicy?: unknown;
    modelPolicy?: unknown;
    synthesisPolicy?: unknown;
    progressMilestones?: unknown;
    stopCriteria?: unknown;
}

const CORE_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);
function finalAssistantText(messages: Message[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role !== "assistant") continue;
        const text = message.content.find((part) => part.type === "text");
        if (text?.type === "text") return text.text;
    }
    return "";
}

function extractJson(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return text.trim();
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function text(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function stableId(value: unknown, fallback: string): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
    const slug = raw
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "");
    return slug || fallback;
}

function sanitizeTools(tools: unknown, inheritedTools: string[]): string[] {
    const allowed = new Set([...CORE_TOOLS, ...inheritedTools]);
    return stringList(tools).filter((tool) => allowed.has(tool));
}

function capabilityNeeds(value: unknown): ModelCapabilityDimension[] {
    return stringList(value).filter((item): item is ModelCapabilityDimension => isModelCapabilityDimension(item));
}

function parseRole(role: Record<string, unknown>, index: number, inheritedTools: string[]): TeamInputRole | undefined {
    const title = text(role.title, "");
    if (!title) return undefined;
    return {
        id: stableId(role.id, `role-${index + 1}`),
        title,
        capability: text(role.capability, ""),
        capabilityNeeds: capabilityNeeds(role.capabilityNeeds),
        description: text(role.description, ""),
        systemPrompt: text(role.systemPrompt, ""),
        tools: sanitizeTools(role.tools, inheritedTools),
        modelFit: text(role.modelFit, ""),
        // Semantic planning describes capabilities; it must not invent concrete
        // provider/model keys. Only captain/user/project input may do that.
        modelPreferences: [],
    };
}

function fanoutOnEmpty(value: unknown): FanoutOnEmpty | undefined {
    return value === "fail" || value === "skip" ? value : undefined;
}

function parseFanout(value: unknown, roleIds: Set<string>): FanoutRoundConfig | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fanout = value as Record<string, unknown>;
    const expand = fanout.expand;
    if (!expand || typeof expand !== "object" || Array.isArray(expand)) return undefined;
    const expandRecord = expand as Record<string, unknown>;
    const fromRoleId = stableId(expandRecord.fromRoleId, "");
    const path = text(expandRecord.path, "");
    const maxItems = numberValue(expandRecord.maxItems, 0);
    if (!fromRoleId || !roleIds.has(fromRoleId) || !path || maxItems <= 0) return undefined;
    const keyPath = text(expandRecord.keyPath, "");
    const itemName = text(expandRecord.itemName, "");
    const collect = fanout.collect;
    const collectAs = collect && typeof collect === "object" && !Array.isArray(collect)
        ? text((collect as Record<string, unknown>).as, "")
        : "";
    return {
        expand: {
            fromRoleId,
            path,
            ...(keyPath ? { keyPath } : {}),
            ...(itemName ? { itemName } : {}),
            maxItems,
            ...(fanoutOnEmpty(expandRecord.onEmpty) ? { onEmpty: fanoutOnEmpty(expandRecord.onEmpty) } : {}),
        },
        ...(collectAs ? { collect: { as: stableId(collectAs, collectAs) } } : {}),
    };
}

function parseRounds(rounds: unknown, roleIds: Set<string>): TeamInputRound[] {
    if (!Array.isArray(rounds)) return [];
    return rounds
        .filter((round): round is Record<string, unknown> => typeof round === "object" && round !== null)
        .map((round, index) => {
            const type: RoundType = round.type === "chain" || round.type === "single" || round.type === "fanout" ? round.type : "parallel";
            const roles = stringList(round.roles).filter((roleId) => roleIds.has(stableId(roleId, roleId)));
            return {
                id: stableId(round.id, `round-${index + 1}`),
                type,
                roles,
                goal: text(round.goal, ""),
                ...(parseFanout(round.fanout, roleIds) ? { fanout: parseFanout(round.fanout, roleIds) } : {}),
            };
        })
        .filter((round) => round.roles.length > 0);
}

export function parseSemanticPlan(
    source: string,
    inheritedTools: string[],
    maxAgents: number,
): GeneratedTeamBlueprint | undefined {
    let parsed: SemanticPlanJson;
    try {
        parsed = JSON.parse(extractJson(source)) as SemanticPlanJson;
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed.roles)) return undefined;
    const roles = parsed.roles
        .filter((role): role is Record<string, unknown> => typeof role === "object" && role !== null)
        .map((role, index) => parseRole(role, index, inheritedTools))
        .filter((role): role is TeamInputRole => role !== undefined)
        .slice(0, maxAgents);
    if (roles.length === 0) return undefined;
    const roleIds = new Set(roles.map((role) => role.id ?? ""));
    const rounds = parseRounds(parsed.rounds, roleIds);
    return {
        title: text(parsed.title, "Dynamic team blueprint"),
        rationale: text(parsed.rationale, "semantic plan generated"),
        strategy: text(
            parsed.strategy,
            "Run the planned worker roles, observe their progress, and hand findings to the lead.",
        ),
        roles,
        rounds:
            rounds.length > 0
                ? rounds
                : [
                      {
                          id: "collect",
                          type: "parallel",
                          roles: roles.map((role) => role.id ?? "").filter(Boolean),
                          goal: "Collect task-specific findings.",
                      },
                  ],
        evidencePolicy: text(parsed.evidencePolicy, "Workers separate evidence, inference, confidence, and gaps."),
        modelPolicy: text(parsed.modelPolicy, "Use available configured models according to role capability needs."),
        synthesisPolicy: text(parsed.synthesisPolicy, "The lead synthesizes findings and makes the final judgment."),
        progressMilestones: stringList(parsed.progressMilestones),
        stopCriteria: text(parsed.stopCriteria, "All planned rounds complete and observable outputs are returned."),
    };
}

function capabilityFacts(profiles: ModelCapabilityProfile[]): string {
    if (profiles.length === 0) return "(none)";
    return profiles
        .map((profile) =>
            [
                `- ${profile.displayName}`,
                `  family: ${profile.family}`,
                `  models: ${profile.models.join(", ")}`,
                `  aliases: ${profile.aliases.join(", ")}`,
                `  capabilities: ${profile.capabilities.join(", ")}`,
                `  strengths: ${profile.strengths.join(", ")}`,
                `  cautions: ${profile.cautions.join(", ")}`,
            ].join("\n"),
        )
        .join("\n");
}

function plannerPrompt(input: TeamInput, inheritedTools: string[], profiles: ModelCapabilityProfile[], unavailableModels: string[] = []): string {
    const maxAgents = Math.max(1, Math.min(input.maxAgents ?? 4, 5));
    const unavailableLine = unavailableModels.length > 0
        ? ["", "Runtime health has marked these configured models unavailable:", unavailableModels.map((key) => `- ${key}`).join("\n")].join("\n")
        : "";
    return [
        "You are the semantic planner for the Pi team extension. Design a lightweight multi-agent blueprint for the lead captain.",
        "The lead captain owns progress, inspection, follow-up dispatch, and final judgment. The extension provides dispatch, communication, observation, and evidence transport.",
        "",
        "Return JSON only. Do not return Markdown, explanation, or code fences.",
        "",
        "JSON schema:",
        "{",
        '  "title": "short blueprint title",',
        '  "rationale": "why these roles and rounds fit the task",',
        '  "strategy": "how each round produces input for the next",',
        '  "roles": [',
        "    {",
        '      "id": "stable-role-id",',
        '      "title": "role title",',
        '      "capability": "role capability",',
        '      "capabilityNeeds": ["coding|research|fact_checking|synthesis|chinese_writing|tool_use|long_context|speed|cost_efficiency|critical_review"],',
        '      "description": "responsibility and boundary",',
        '      "systemPrompt": "English canonical worker instruction; require output in the user language",',
        '      "tools": ["choose only from available tools"],',
        '      "modelFit": "model-neutral capability and workload considerations"',
        "    }",
        "  ],",
        '  "rounds": [',
        '    { "id": "stable-round-id", "type": "parallel|chain|single|fanout", "roles": ["stable-role-id"], "goal": "round goal", "fanout": { "expand": { "fromRoleId": "upstream-role-id", "path": "/items", "maxItems": 20, "onEmpty": "skip|fail" }, "collect": { "as": "collected-role-id" } } }',
        "  ],",
        '  "evidencePolicy": "requirements for evidence, sources, limitations, and inference boundaries",',
        '  "modelPolicy": "capability requirements; never invent concrete provider/model keys",',
        '  "synthesisPolicy": "how the captain should merge evidence and resolve disagreements",',
        '  "progressMilestones": ["captain-observable milestone"],',
        '  "stopCriteria": "when evidence is sufficient to return control to the captain"',
        "}",
        "",
        `Maximum roles: ${maxAgents}`,
        `Available tools: ${inheritedTools.join(",") || "(none)"}`,
        `Task mode: ${input.mode ?? "auto"}`,
        `Output contract: ${input.outputContract ?? "findings"}`,
        "",
        "Optional user/project capability facts (runtime health is evaluated separately):",
        capabilityFacts(profiles),
        unavailableLine,
        "",
        "Choose capabilityNeeds only from the schema dimensions. Do not emit modelPreferences or name a provider/model.",
        "Describe model fit through capabilities, workload density, context needs, speed, and cost sensitivity.",
        "Use role diversity for independent perspectives. Model/provider diversity is a runtime routing concern, not something to guess from labels.",
        "A single configured model may serve multiple roles when no viable alternative exists.",
        "Make progressMilestones useful for the captain's Plan-Do-Check-Act decisions.",
        "Choose the workflow, role count, abstraction level, and rounds from the task semantics. Keep role names reusable unless the task needs a specific verification target.",
        "Treat the extension as a communication, control, and observation channel; completion and final judgment belong to the lead captain.",
        "Every systemPrompt must require workers to report actual tool use, access failures, evidence, uncertainty, and limitations, and to write in the user's language unless the task requires otherwise.",
        "",
        `User task:\n${input.task}`,
    ].join("\n");
}

export async function createSemanticPlan(
    cwd: string,
    input: TeamInput,
    inheritedTools: string[],
    profiles: ModelCapabilityProfile[],
    signal?: AbortSignal,
    unavailableModels: string[] = [],
): Promise<GeneratedTeamBlueprint | undefined> {
    const messages: Message[] = [];
    const args = [
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-extensions",
        "--tools",
        "read",
        plannerPrompt(input, inheritedTools, profiles, unavailableModels),
    ];
    return await new Promise<GeneratedTeamBlueprint | undefined>((resolve) => {
        const invocation = piInvocation(args);
        const proc = spawn(invocation.command, invocation.args, {
            cwd,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let buffer = "";
        const processLine = (line: string) => {
            if (!line.trim()) return;
            let event: unknown;
            try {
                event = JSON.parse(line);
            } catch {
                return;
            }
            if (typeof event !== "object" || event === null) return;
            if ("type" in event && event.type === "message_end" && "message" in event) {
                messages.push(event.message as Message);
            }
        };
        proc.stdout.on("data", (data) => {
            buffer += data.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
        });
        proc.on("error", () => resolve(undefined));
        proc.on("close", () => {
            if (buffer.trim()) processLine(buffer);
            resolve(parseSemanticPlan(finalAssistantText(messages), inheritedTools, Math.max(1, input.maxAgents ?? 4)));
        });
        const abort = () => {
            proc.kill("SIGTERM");
            resolve(undefined);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
    });
}
