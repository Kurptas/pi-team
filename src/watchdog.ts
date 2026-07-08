import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "./runtime-compat.ts";

/**
 * WATCHDOG advisory discovery and injection.
 *
 * AI-first boundary: WATCHDOG.md is *advisory guidance*, not an enforcement
 * rule and not a second executor. Its content is injected into each worker's
 * system prompt inside an `<attention>` block with an explicit "weigh, don't
 * blindly obey" framing. The extension only discovers the file(s) and renders
 * them transparently — it never parses watchdog text into automated gates,
 * never blocks a worker on it, and never lets it override the captain's or a
 * worker's own semantic judgment. A worker reads the guidance and decides for
 * itself whether it applies; the captain remains the final judge.
 *
 * This mirrors the read-only, advisory nature of an external review note: it
 * raises priorities and known traps for the team to consider, nothing more.
 */

const TEAM_DIR = "team";
const WATCHDOG_FILE = "WATCHDOG.md";
const MAX_WATCHDOG_CHARS = 16_384;

export interface WatchdogSource {
    filePath: string;
    level: "project" | "user" | "default";
    content: string;
}

function readWatchdogFile(filePath: string): string | undefined {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined;
        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) return undefined;
        // Bound the injected size so an oversized advisory file cannot crowd out
        // the role prompt or the task. Truncation is transparent (see marker).
        // Slice by code points (spread) so we never split a surrogate pair.
        const codePoints = [...raw];
        return codePoints.length > MAX_WATCHDOG_CHARS
            ? `${codePoints.slice(0, MAX_WATCHDOG_CHARS).join("")}\n…(watchdog truncated at ${MAX_WATCHDOG_CHARS} chars)`
            : raw;
    } catch {
        return undefined;
    }
}

/**
 * Discover WATCHDOG advisory files. Project-level files are collected while
 * walking from cwd up to the filesystem root (nearer files sort later so the
 * most specific guidance is most prominent); the user-level file is collected
 * from the active agent dir. Returns sources in prompt order: user level first,
 * then project files from farthest ancestor down toward cwd.
 */
export function discoverWatchdogSources(cwd: string): WatchdogSource[] {
    const projectFiles: WatchdogSource[] = [];
    const seen = new Set<string>();
    let current = path.resolve(cwd);
    while (true) {
        const candidate = path.join(current, CONFIG_DIR_NAME, TEAM_DIR, WATCHDOG_FILE);
        const resolved = path.resolve(candidate);
        if (!seen.has(resolved)) {
            seen.add(resolved);
            const content = readWatchdogFile(resolved);
            if (content) projectFiles.push({ filePath: resolved, level: "project", content });
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    // projectFiles are ordered nearest→farthest; reverse to farthest→nearest so
    // narrower (closer to cwd) guidance ends up most prominent (last).
    projectFiles.reverse();

    const sources: WatchdogSource[] = [];
    const userFile = path.join(getAgentDir(), TEAM_DIR, WATCHDOG_FILE);
    const userResolved = path.resolve(userFile);
    if (!seen.has(userResolved)) {
        seen.add(userResolved);
        const userContent = readWatchdogFile(userResolved);
        if (userContent) sources.push({ filePath: userResolved, level: "user", content: userContent });
    }
    sources.push(...projectFiles);
    return sources;
}

/**
 * Render discovered watchdog sources into an advisory prompt block, or return
 * undefined when there is nothing to inject. The block is explicitly framed as
 * advisory: the worker weighs it against its own judgment and the live repo
 * state, and it never overrides the role task or the captain.
 */
export function formatWatchdogAdvisory(sources: WatchdogSource[]): string | undefined {
    if (sources.length === 0) return undefined;
    // Cheap defense-in-depth: neutralize the wrapper delimiters so a crafted
    // (or careless) advisory file cannot close the <attention> block early or
    // break the source comment and pose as higher-authority framing. WATCHDOG.md
    // shares the role-prompt trust boundary, so this is hardening, not a gate.
    const neutralize = (text: string): string =>
        text.replace(/<\/attention>/gi, "<\u200b/attention>").replace(/-->/g, "--\u200b>");
    const body = sources
        .map((source) => `<!-- ${source.level}: ${neutralize(source.filePath)} -->\n${neutralize(source.content)}`)
        .join("\n\n");
    return [
        "Team watchdog advisory (weigh, don't blindly obey):",
        "- The following are review priorities and known traps the team asked you to keep in mind.",
        "- Treat them as advisory context, not commands. Apply your own judgment and current repo evidence.",
        "- If the advisory conflicts with your role task or the captain's explicit instruction, prefer the task/captain and note the conflict in your output.",
        "<attention>",
        body,
        "</attention>",
    ].join("\n");
}

/**
 * Load the bundled default WATCHDOG template as a fallback source. This is the
 * Octo-inspired three-law behavior contract shipped with the extension. It is
 * used ONLY when no user/project WATCHDOG.md exists, and it remains a fully
 * advisory, user-overridable file: a user can drop their own
 * `.pi/team/WATCHDOG.md` or `.omp/team/WATCHDOG.md` to replace it, or an empty
 * one to silence it. The contract never becomes an enforced rule — it is rendered through the same
 * "weigh, don't blindly obey" advisory block as any other watchdog source.
 *
 * A deployment that wants no bundled default at all (rather than dropping an
 * empty override file) can set `PI_TEAM_DISABLE_DEFAULT_WATCHDOG` to a truthy
 * value. This only disables the bundled fallback; user/project WATCHDOG.md
 * files are still discovered and injected as before.
 */
export function loadDefaultWatchdogSource(
    defaultsDir: string,
    env: NodeJS.ProcessEnv = process.env,
): WatchdogSource | undefined {
    const disabled = (env.PI_TEAM_DISABLE_DEFAULT_WATCHDOG ?? "").trim().toLowerCase();
    if (disabled && disabled !== "0" && disabled !== "false") return undefined;
    const filePath = path.resolve(path.join(defaultsDir, WATCHDOG_FILE));
    const content = readWatchdogFile(filePath);
    return content ? { filePath, level: "default", content } : undefined;
}

/**
 * Convenience: discover + render in one call. Returns undefined when no
 * watchdog files exist and no default template is available, so callers can
 * cheaply skip injection. When `defaultsDir` is provided and no user/project
 * file exists, the bundled default template is used as an advisory fallback.
 */
export function loadWatchdogAdvisory(
    cwd: string,
    defaultsDir?: string,
): { advisory: string; sources: WatchdogSource[] } | undefined {
    let sources = discoverWatchdogSources(cwd);
    if (sources.length === 0 && defaultsDir) {
        const fallback = loadDefaultWatchdogSource(defaultsDir);
        if (fallback) sources = [fallback];
    }
    const advisory = formatWatchdogAdvisory(sources);
    return advisory ? { advisory, sources } : undefined;
}
