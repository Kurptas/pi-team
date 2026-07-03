/**
 * Tool approval tiers for team workers.
 *
 * AI-first boundary: this module classifies tools by a *transparent static
 * map* (read / write / exec) and applies a *user-set ceiling*. It never makes a
 * semantic judgment about whether a given tool "should" be used for a task —
 * that decision belongs to the captain (who authors role.tools) and the worker
 * (which decides how to use what it was granted). The only behavior here is:
 *
 *   1. classify each tool by a documented, overridable tier map, and
 *   2. when the user explicitly sets a risk ceiling, drop tools above it from
 *      the worker whitelist BEFORE dispatch, transparently (the run emits an
 *      event listing what was dropped and why).
 *
 * The default ceiling is `exec` — i.e. no restriction, identical to current
 * behavior — so this is opt-in. Workers run headless and cannot prompt a human,
 * so a ceiling is the team analogue of the parent-task approval boundary: a
 * coarse, observable cap, not a per-call interactive gate.
 */

export type ToolTier = "read" | "write" | "exec";

const TIER_ORDER: Record<ToolTier, number> = { read: 0, write: 1, exec: 2 };

/**
 * Default tier classification for tools the team commonly inherits. Unknown
 * tools fall through to `exec` — the documented safe default for anything we
 * cannot positively classify as read-only or a bounded write.
 */
const DEFAULT_TOOL_TIERS: Record<string, ToolTier> = {
    read: "read",
    grep: "read",
    find: "read",
    ls: "read",
    edit: "write",
    write: "write",
    bash: "exec",
};

/**
 * The documented set of *capability tools* the role whitelist exists to gate:
 * tools that read the filesystem, mutate it, execute code/shell, or spawn other
 * agents/processes. Membership here is the structural boundary for tool
 * isolation — see `findToolIsolationViolations`.
 *
 * This set is intentionally the union of the escalation surface across BOTH
 * runtimes (Pi and omp), not just the tools Pi ships, so the boundary stays
 * robust if a runtime force-activates an execution-capable builtin. It is a
 * static, transparent, overridable map — never a semantic judgment about
 * whether a tool "should" be used.
 *
 * Tools OUTSIDE this set — image generation, speech, LSP, todo, memory/skill
 * management, web/BM25 search, reporting/yield helpers, etc. — are
 * framework-injected auxiliaries. omp force-activates some of them regardless
 * of the enable-list (they are registered as custom tools, which bypass the
 * `toolNames` allowlist by design; see omp `docs/sdk.md`). Treating their
 * presence as a whitelist violation would be whack-a-mole and wrong: they are
 * not the capability-escalation surface the whitelist guards.
 */
export const CAPABILITY_TOOL_NAMES: ReadonlySet<string> = new Set([
    // Filesystem read surface
    "read",
    "grep",
    "find",
    "ls",
    "glob",
    // Filesystem mutation surface
    "edit",
    "write",
    "ast_edit",
    // Code / shell execution surface
    "bash",
    "eval",
    "ssh",
    // Network / external mutation + subagent/process spawning surface
    "browser",
    "github",
    "task",
    "job",
]);

/**
 * Classify a single tool. Unknown tools are `exec` (safe default). A caller may
 * pass an override map (e.g. parsed from user config) that wins over defaults.
 */
export function classifyToolTier(tool: string, overrides?: Record<string, ToolTier>): ToolTier {
    const name = tool.trim();
    if (overrides && name in overrides) return overrides[name]!;
    return DEFAULT_TOOL_TIERS[name] ?? "exec";
}

export function isToolTier(value: unknown): value is ToolTier {
    return value === "read" || value === "write" || value === "exec";
}

/**
 * Resolve the user-configured maximum tool tier. Reads `PI_TEAM_MAX_TOOL_TIER`
 * (read | write | exec); anything else — including unset — yields `exec`, i.e.
 * no restriction. This keeps the feature opt-in and the default behavior
 * identical to before.
 */
export function resolveMaxToolTier(env: NodeJS.ProcessEnv = process.env): ToolTier {
    const raw = env.PI_TEAM_MAX_TOOL_TIER?.trim().toLowerCase();
    return isToolTier(raw) ? raw : "exec";
}

export interface ToolTierDecision {
    /** Tools at or below the ceiling — what the worker is actually granted. */
    allowed: string[];
    /** Tools dropped because they exceed the ceiling, with their tier. */
    blocked: Array<{ tool: string; tier: ToolTier }>;
    /** Tier of every input tool, for observability. */
    tiers: Array<{ tool: string; tier: ToolTier }>;
    maxTier: ToolTier;
}

/**
 * Apply the tier ceiling to a worker's resolved tool whitelist. Pure function:
 * given the tools and a ceiling, return the allowed subset plus a transparent
 * record of what was dropped. With the default `exec` ceiling nothing is
 * dropped, so callers can cheaply detect "no change".
 */
export function applyToolTierCeiling(
    tools: string[],
    maxTier: ToolTier,
    overrides?: Record<string, ToolTier>,
): ToolTierDecision {
    const ceiling = TIER_ORDER[maxTier];
    const allowed: string[] = [];
    const blocked: Array<{ tool: string; tier: ToolTier }> = [];
    const tiers: Array<{ tool: string; tier: ToolTier }> = [];
    for (const tool of tools) {
        const tier = classifyToolTier(tool, overrides);
        tiers.push({ tool, tier });
        if (TIER_ORDER[tier] <= ceiling) allowed.push(tool);
        else blocked.push({ tool, tier });
    }
    return { allowed, blocked, tiers, maxTier };
}

/**
 * One-line human-readable summary of a tier decision for run observability.
 * Returns undefined when the ceiling dropped nothing (so callers can skip an
 * event in the common no-op case).
 */
export function formatToolTierDecision(roleTitle: string, decision: ToolTierDecision): string | undefined {
    if (decision.blocked.length === 0) return undefined;
    const blocked = decision.blocked.map((b) => `${b.tool}(${b.tier})`).join(", ");
    const kept = decision.allowed.join(", ") || "(none)";
    return `${roleTitle}: tool tier ceiling=${decision.maxTier} dropped ${blocked}; granted ${kept}`;
}
