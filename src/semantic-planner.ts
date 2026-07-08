import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { piInvocation } from "./pi-invocation.ts";
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
const CAPABILITY_DIMENSIONS = new Set<ModelCapabilityDimension>([
    "coding",
    "research",
    "fact_checking",
    "synthesis",
    "chinese_writing",
    "tool_use",
    "long_context",
    "speed",
    "cost_efficiency",
    "critical_review",
]);

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
    return stringList(value).filter((item): item is ModelCapabilityDimension =>
        CAPABILITY_DIMENSIONS.has(item as ModelCapabilityDimension),
    );
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
        modelPreferences: stringList(role.modelPreferences),
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
        title: text(parsed.title, "动态协作蓝本"),
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
                `  strengths: ${profile.strengths.join(", ")}`,
                `  recommendedRoles: ${profile.recommendedRoles.join(", ")}`,
                `  cautions: ${profile.cautions.join(", ")}`,
            ].join("\n"),
        )
        .join("\n");
}

function plannerPrompt(input: TeamInput, inheritedTools: string[], profiles: ModelCapabilityProfile[], unavailableModels: string[] = []): string {
    const maxAgents = Math.max(1, Math.min(input.maxAgents ?? 4, 5));
    const unavailableLine =
        unavailableModels.length > 0
            ? [
                  "",
                  "运行前 probe 已确认以下模型此刻不可用（超时/拒绝/鉴权失败），不要在 modelPreferences 里指定它们，改用其他健康模型：",
                  unavailableModels.map((key) => `- ${key}`).join("\n"),
              ].join("\n")
            : "";
    return [
        "你是 Pi team 扩展的语义规划器。你的任务是给主 Agent 队长生成一次轻量、多 Agent 协作蓝本。",
        "主 Agent 是队长，负责推动、检查、二次调度和最终裁决；team 扩展负责派发、通信、观测和证据返回。",
        "",
        "只输出 JSON，不要输出 Markdown、解释或代码块。",
        "",
        "JSON schema:",
        "{",
        '  "title": "这次协作蓝本的短标题",',
        '  "rationale": "为什么这样分工",',
        '  "strategy": "整体执行流程，说明每一轮如何产生下一轮输入",',
        '  "roles": [',
        "    {",
        '      "id": "stable-role-id",',
        '      "title": "角色名",',
        '      "capability": "这个角色需要的能力",',
        '      "capabilityNeeds": ["coding|research|fact_checking|synthesis|chinese_writing|tool_use|long_context|speed|cost_efficiency|critical_review"],',
        '      "description": "角色边界和负责事项",',
        '      "systemPrompt": "给这个 worker 的中文系统提示",',
        '      "tools": ["从可用工具里选择"],',
        '      "modelFit": "什么类型的模型适合这个角色，以及原因",',
        '      "modelPreferences": []',
        "    }",
        "  ],",
        '  "rounds": [',
        '    { "id": "stable-round-id", "type": "parallel|chain|single|fanout", "roles": ["stable-role-id"], "goal": "本轮目标", "fanout": { "expand": { "fromRoleId": "upstream-role-id", "path": "/items", "maxItems": 20, "onEmpty": "skip|fail" }, "collect": { "as": "collected-role-id" } } }',
        "  ],",
        '  "evidencePolicy": "证据、来源、限制和推理边界的要求",',
        '  "modelPolicy": "模型分配原则，说明哪些能力适合哪些角色",',
        '  "synthesisPolicy": "最终汇总和分歧处理方式",',
        '  "progressMilestones": ["用户可理解的阶段进展"],',
        '  "stopCriteria": "本次协作何时可以交还给主 Agent"',
        "}",
        "",
        `最多角色数: ${maxAgents}`,
        `可用工具: ${inheritedTools.join(",") || "(none)"}`,
        `任务模式: ${input.mode ?? "auto"}`,
        `输出要求: ${input.outputContract ?? "findings"}`,
        "",
        "模型能力事实（仅供队长规划参考，供应商/渠道可用性由运行前 probe 单独判断）:",
        capabilityFacts(profiles),
        unavailableLine,
        "",
        "capabilityNeeds 只能从 schema 列出的维度中选择，用来帮助路由选择合适模型。",
        "modelPreferences 由你根据任务、角色和模型能力事实填写；扩展只执行你的偏好并过滤客观不可用模型。",
        "视角多样性：当多个角色是并行的独立视角（如多方评审、多角度论证），倾向为它们指定不同的模型或 provider，避免全部落到同一模型而丧失多模型视角；除非某角色确有唯一最适配的模型。",
        "当只有唯一可用模型时，单一模型承担多个角色是可以接受的——无需多样性焦虑。",
        "模型选择优先级：用户/captain 显式 modelPreferences 永远优先；未指定时才参考 fresh model-recommendations 与 capability facts；无匹配或推荐过期时回退 configured order。不要臆测不可验证的模型强弱。",
        "progressMilestones 要服务于队长的 Plan-Do-Check-Act 推进，让队长能判断是否需要补查、换角色或汇总。",
        "请依据用户任务的语义自行决定流程、角色数、角色抽象层级和轮次。角色名体现可复用的能力和责任；当用户任务要求单点核验时，角色名可以指向具体核验对象。",
        "把扩展视为通信、控制和观测通道；最终判断、完成度判断和责任归主 Agent 队长。",
        "每个 systemPrompt 要求 worker 说明实际使用的工具、访问是否成功、关键证据和限制。",
        "",
        `用户任务:\n${input.task}`,
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
