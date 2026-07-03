import * as os from "node:os";
import * as path from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

/**
 * Cross-runtime boundary between Pi and omp (a Pi fork).
 *
 * Both runtimes expose the same extension surface, but they differ on two
 * config-root symbols:
 *
 * - `getAgentDir`: Pi exports it; omp also re-exports it (via `@oh-my-pi/pi-utils`),
 *   so on omp we call omp's own implementation and get the correct profile-aware
 *   `~/.omp/agent`. The hand-written fallback below is defensive only.
 * - `CONFIG_DIR_NAME`: Pi exports it (`.pi`); omp does NOT export it, so on omp we
 *   fall back to `.omp`.
 *
 * Keeping this logic in one module avoids duplicating the same shim across every
 * consumer (loader.ts, watchdog.ts, ...).
 */
const _piAgent = piCodingAgent as unknown as { CONFIG_DIR_NAME?: unknown; getAgentDir?: unknown };

/** Project-local config directory name: `.pi` on Pi, `.omp` on omp. */
export const CONFIG_DIR_NAME: string =
    typeof _piAgent.CONFIG_DIR_NAME === "string" ? _piAgent.CONFIG_DIR_NAME : ".omp";

/** Resolve the user-level agent config directory (`~/.pi/agent` or `~/.omp/agent`). */
export function getAgentDir(): string {
    if (typeof _piAgent.getAgentDir === "function") {
        const agent = _piAgent as unknown as { getAgentDir(): string };
        return agent.getAgentDir();
    }
    const customDir = process.env.PI_CODING_AGENT_DIR ?? process.env.OMP_CODING_AGENT_DIR;
    if (customDir) return customDir;
    const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
    if (profile) return path.join(os.homedir(), ".omp", "profiles", profile, "agent");
    return path.join(os.homedir(), ".omp", "agent");
}

/**
 * Build the cross-runtime `createAgentSession` tool options for an isolated worker.
 *
 * Pi and omp diverge on how a session's enabled tools are constrained:
 * - Pi honors `tools: string[]` as a strict enable-list; unknown fields are ignored.
 * - omp renamed the enable-list to `toolNames: string[]`, defaults LSP on
 *   (`enableLsp: true`), and force-activates extension-registered tools regardless
 *   of the enable-list.
 *
 * We send BOTH field names plus two omp-only guards. Each runtime ignores the
 * fields it does not know, so one object satisfies both:
 * - `tools` / `toolNames`: the role whitelist, under each runtime's field name.
 * - `enableLsp: false`: keeps omp from attaching LSP tools the role never requested.
 * - `disableExtensionDiscovery: true`: keeps omp from loading the team extension
 *   (or any other) into the isolated worker — matching Pi's sandboxed worker
 *   surface and preventing recursive team spawning.
 */
export function workerSessionToolOptions(tools: string[]): Record<string, unknown> {
    return {
        tools,
        toolNames: tools,
        enableLsp: false,
        disableExtensionDiscovery: true,
    };
}
