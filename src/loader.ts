import * as fs from "node:fs";
import * as path from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "./model-selector.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "./runtime-compat.ts";
import type { FanoutOnEmpty, FanoutRoundConfig, Playbook, PlaybookRound, ResourceSource, RoleSpec, TeamMode, TeamResources } from "./types.ts";
const parseFrontmatter = piCodingAgent.parseFrontmatter;

interface PlaybookFrontmatter extends Record<string, unknown> {
    id?: string;
    title?: string;
    description?: string;
    triggers?: unknown;
    hints?: unknown;
    default_mode?: string;
    max_agents?: unknown;
    rounds?: unknown;
    output_contract?: string;
}

interface RoleFrontmatter extends Record<string, unknown> {
    id?: string;
    title?: string;
    description?: string;
    tools?: unknown;
    model_preferences?: unknown;
    thinking?: string;
    thinking_level?: string;
    output_schema?: string;
}

interface ResourceDir {
    dir: string;
    source: ResourceSource;
}

const TEAM_DIR = "team";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    if (typeof value === "string") {
        return value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function numberValue(value: unknown, fallback: number): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
}

function modeValue(value: unknown): TeamMode {
    const mode = typeof value === "string" ? value : "";
    if (mode === "roundtable" || mode === "code" || mode === "review" || mode === "strategy") return mode;
    return "research";
}

function roundType(value: unknown): PlaybookRound["type"] {
    if (value === "chain" || value === "single" || value === "fanout") return value;
    return "parallel";
}

function fanoutOnEmpty(value: unknown): FanoutOnEmpty | undefined {
    return value === "fail" || value === "skip" ? value : undefined;
}

function parseFanout(value: unknown): FanoutRoundConfig | undefined {
    if (!isRecord(value) || !isRecord(value.expand)) return undefined;
    const fromRoleId = typeof value.expand.fromRoleId === "string" ? value.expand.fromRoleId.trim() : "";
    const path = typeof value.expand.path === "string" ? value.expand.path.trim() : "";
    const maxItems = numberValue(value.expand.maxItems, 0);
    if (!fromRoleId || !path || maxItems <= 0) return undefined;
    const keyPath = typeof value.expand.keyPath === "string" && value.expand.keyPath.trim() ? value.expand.keyPath.trim() : undefined;
    const itemName = typeof value.expand.itemName === "string" && value.expand.itemName.trim() ? value.expand.itemName.trim() : undefined;
    const collectAs = isRecord(value.collect) && typeof value.collect.as === "string" && value.collect.as.trim() ? value.collect.as.trim() : undefined;
    return {
        expand: {
            fromRoleId,
            path,
            ...(keyPath ? { keyPath } : {}),
            ...(itemName ? { itemName } : {}),
            maxItems,
            ...(fanoutOnEmpty(value.expand.onEmpty) ? { onEmpty: fanoutOnEmpty(value.expand.onEmpty) } : {}),
        },
        ...(collectAs ? { collect: { as: collectAs } } : {}),
    };
}

function findNearestProjectTeamDir(cwd: string): string | undefined {
    let current = cwd;
    while (true) {
        const candidate = path.join(current, CONFIG_DIR_NAME, TEAM_DIR);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function resourceDirs(cwd: string, defaultsDir: string, childDir: "playbooks" | "roles"): ResourceDir[] {
    const dirs: ResourceDir[] = [];
    const projectTeamDir = findNearestProjectTeamDir(cwd);
    if (projectTeamDir) dirs.push({ dir: path.join(projectTeamDir, childDir), source: "project" });
    dirs.push({ dir: path.join(getAgentDir(), TEAM_DIR, childDir), source: "user" });
    dirs.push({ dir: path.join(defaultsDir, childDir), source: "default" });
    return dirs;
}
function readMarkdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
        .map((entry) => path.join(dir, entry.name))
        .sort((a, b) => a.localeCompare(b));
}

function parseRounds(value: unknown): PlaybookRound[] {
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord).map((round, index) => ({
        name: typeof round.name === "string" && round.name.trim() ? round.name.trim() : `round-${index + 1}`,
        type: roundType(round.type),
        roles: stringList(round.roles),
        ...(typeof round.goal === "string" && round.goal.trim() ? { goal: round.goal.trim() } : {}),
        ...(parseFanout(round.fanout) ? { fanout: parseFanout(round.fanout) } : {}),
    }));
}

function loadPlaybook(filePath: string, source: ResourceSource, diagnostics: string[]): Playbook | undefined {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter<PlaybookFrontmatter>(raw);
        if (!frontmatter.id || !frontmatter.title || !frontmatter.description) {
            diagnostics.push(`Skipped playbook without id/title/description: ${filePath}`);
            return undefined;
        }
        const rounds = parseRounds(frontmatter.rounds);
        return {
            id: frontmatter.id,
            title: frontmatter.title,
            description: frontmatter.description,
            hints:
                stringList(frontmatter.hints).length > 0
                    ? stringList(frontmatter.hints)
                    : stringList(frontmatter.triggers),
            defaultMode: modeValue(frontmatter.default_mode),
            maxAgents: Math.max(1, numberValue(frontmatter.max_agents, 4)),
            rounds,
            outputContract: frontmatter.output_contract ?? "findings",
            body,
            source,
            filePath,
        };
    } catch (error) {
        diagnostics.push(`Failed to load playbook ${filePath}: ${String(error)}`);
        return undefined;
    }
}

function loadRole(filePath: string, source: ResourceSource, diagnostics: string[]): RoleSpec | undefined {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter<RoleFrontmatter>(raw);
        if (!frontmatter.id || !frontmatter.title || !frontmatter.description) {
            diagnostics.push(`Skipped role without id/title/description: ${filePath}`);
            return undefined;
        }
        const thinking = frontmatter.thinking_level ?? frontmatter.thinking;
        if (thinking !== undefined && !isThinkingLevel(thinking)) {
            diagnostics.push(`Ignored invalid thinking level for role ${frontmatter.id}: ${thinking}`);
        }
        return {
            id: frontmatter.id,
            title: frontmatter.title,
            description: frontmatter.description,
            tools: stringList(frontmatter.tools),
            modelPreferences: stringList(frontmatter.model_preferences),
            thinkingLevel: isThinkingLevel(thinking) ? thinking : undefined,
            outputSchema: frontmatter.output_schema ?? "worker_finding",
            body,
            source,
            filePath,
        };
    } catch (error) {
        diagnostics.push(`Failed to load role ${filePath}: ${String(error)}`);
        return undefined;
    }
}

function collectById<T extends { id: string; source: ResourceSource }>(items: T[]): T[] {
    const byId = new Map<string, T>();
    for (const source of ["default", "user", "project"] satisfies ResourceSource[]) {
        for (const item of items) {
            if (item.source === source) byId.set(item.id, item);
        }
    }
    return Array.from(byId.values());
}

export function loadTeamResources(cwd: string, defaultsDir: string): TeamResources {
    const diagnostics: string[] = [];
    const playbooks = resourceDirs(cwd, defaultsDir, "playbooks").flatMap(({ dir, source }) =>
        readMarkdownFiles(dir)
            .map((filePath) => loadPlaybook(filePath, source, diagnostics))
            .filter((item): item is Playbook => item !== undefined),
    );
    const roles = resourceDirs(cwd, defaultsDir, "roles").flatMap(({ dir, source }) =>
        readMarkdownFiles(dir)
            .map((filePath) => loadRole(filePath, source, diagnostics))
            .filter((item): item is RoleSpec => item !== undefined),
    );
    return {
        playbooks: collectById(playbooks),
        roles: collectById(roles),
        diagnostics,
    };
}
