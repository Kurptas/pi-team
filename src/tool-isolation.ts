import { CAPABILITY_TOOL_NAMES } from "./tool-approval.ts";

/**
 * Find tools active in a worker session that escape the role whitelist AND are
 * capability tools (filesystem read/write, shell/eval/ssh execution, subagent
 * spawning) — the escalation surface the whitelist exists to gate.
 *
 * Auxiliary tools outside {@link CAPABILITY_TOOL_NAMES} (image/speech/skill
 * management, MCP, LSP, extension helpers) are NOT flagged: some runtimes
 * (notably omp) force-activate them regardless of the enable-list, so treating
 * their presence as a violation would be whack-a-mole and semantically wrong —
 * they are not the capability-escalation surface. On Pi, whose strict
 * enable-list yields no such extras, this filter is inert (active ⊆ allowed).
 */
export function findToolIsolationViolations(activeTools: string[], allowedTools: string[]): string[] {
    const allowed = new Set(allowedTools);
    return activeTools.filter((tool) => CAPABILITY_TOOL_NAMES.has(tool) && !allowed.has(tool));
}

export function toolIsolationViolationMessage(unexpectedTools: string[]): string | undefined {
    return unexpectedTools.length > 0
        ? `active tools exceed role whitelist: ${unexpectedTools.join(", ")}`
        : undefined;
}
