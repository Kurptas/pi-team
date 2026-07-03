// Worker session identity + persistence resolution. Extracted from runner.ts
// to keep that file under the size-gate limit. Pure helpers: they never spawn
// workers or make captain decisions — the runner owns execution.
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { teamControlPaths } from "./control.ts";
import type { PlannedRole } from "./types.ts";

export function workerSessionId(runId: string, roleId: string): string {
    const safeRunId = runId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+|-+$/g, "") || "run";
    const safeRoleId = roleId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+|-+$/g, "") || "role";
    return `team-${safeRunId}-${safeRoleId}`;
}

// Resolve the SessionManager for a worker (2026-07-03 项2 worker 会话恢复).
// Default: inMemory (阅后即焚) — unchanged behavior. When the role opts in via
// `resumable`, the session persists under the run's sessions dir keyed by the
// stable workerSessionId, so the SAME roleId in a LATER ROUND OF THE SAME RUN
// (e.g. a chain round revisiting the role) resumes its own prior context instead
// of restarting cold. Scope is within-run only: the run's sessions dir is wiped
// on terminal outcome (runner.ts, unless PI_TEAM_KEEP_SESSIONS=1), so this does
// NOT carry context across separate team() calls. Continuation is the CAPTAIN's
// editorial decision (role config), never the tool auto-reusing state.
// Persistence is best-effort: any failure falls back to inMemory so a worker
// never fails to launch just because its session file could not be opened.
//
// (2026-07-03 bugfix): switched from guessed filename existsSync to SessionManager.list
// by id, because real filename has timestamp prefix (2026-07-03T..._${id}.jsonl).
export async function resolveWorkerSessionManager(cwd: string, runId: string, role: PlannedRole): Promise<SessionManager> {
    if (!role.resumable) return SessionManager.inMemory(cwd);
    const sessionsDir = path.join(teamControlPaths(cwd, runId).activeDir, "sessions");
    const sessionId = workerSessionId(runId, role.roleId);
    try {
        fs.mkdirSync(sessionsDir, { recursive: true });
        // Find existing session by id (not by guessed filename — real name has timestamp prefix)
        const listed = await SessionManager.list(cwd, sessionsDir);
        const existing = listed.find((s) => s.id === sessionId);
        if (existing) return SessionManager.open(existing.path, sessionsDir);
        return SessionManager.create(cwd, sessionsDir, { id: sessionId });
    } catch {
        // Persistence unavailable (permissions, corrupt file, etc.): fall back to
        // inMemory so the worker still runs — it just loses cross-round resume.
        return SessionManager.inMemory(cwd);
    }
}
