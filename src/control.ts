import * as fs from "node:fs";
import * as path from "node:path";
import type { DelegationLaneState, TeamRun } from "./types.ts";

export interface TeamControlPaths {
    activeDir: string;
    mailboxFile: string;
    mailboxTextFile: string;
    cancelFile: string;
    stateFile: string;
}

export interface TeamMailboxMessage {
    at: number;
    runId: string;
    message: string;
    messageRef?: string;
    targetLaneId?: string;
    targetRoleId?: string;
    delegationToken?: string;
    broadcast?: boolean;
    /**
     * System-origin messages (e.g. the model decision-window notice) are
     * written for the captain/runner to read, but are NOT captain instructions
     * to workers. They are kept out of the worker-visible plain-text mailbox so
     * a worker never mistakes extension bookkeeping for a captain directive.
     */
    system?: boolean;
}

export function teamBaseDir(cwd: string): string {
    return path.join(cwd, ".pi", "team");
}

export function teamRunLogDir(cwd: string): string {
    return path.join(teamBaseDir(cwd), "runs");
}

export function teamActiveDir(cwd: string): string {
    return path.join(teamBaseDir(cwd), "active");
}

export function teamControlPaths(cwd: string, runId: string): TeamControlPaths {
    const activeDir = path.join(teamActiveDir(cwd), runId);
    return {
        activeDir,
        mailboxFile: path.join(activeDir, "mailbox.jsonl"),
        mailboxTextFile: path.join(activeDir, "mailbox.txt"),
        cancelFile: path.join(activeDir, "cancel.json"),
        stateFile: path.join(activeDir, "state.json"),
    };
}

export async function prepareTeamControl(cwd: string, run: TeamRun): Promise<TeamRun> {
    const paths = teamControlPaths(cwd, run.runId);
    await fs.promises.mkdir(paths.activeDir, { recursive: true });
    await fs.promises.writeFile(paths.mailboxFile, "", { flag: "a", encoding: "utf-8" });
    // Plain-text mirror so workers can read captain messages with the `read`
    // tool alone (no bash/JSON parsing required).
    await fs.promises.writeFile(
        paths.mailboxTextFile,
        "Captain messages for this run appear below, newest last. Empty means no captain message yet.\n",
        { flag: "a", encoding: "utf-8" },
    );
    return {
        ...run,
        activeDir: paths.activeDir,
        mailboxFile: paths.mailboxFile,
        mailboxTextFile: paths.mailboxTextFile,
        cancelFile: paths.cancelFile,
    };
}

export async function initDelegationLane(
    cwd: string,
    runId: string,
    roleId: string,
    title: string,
): Promise<DelegationLaneState> {
    const paths = teamControlPaths(cwd, runId);
    const laneId = `${roleId}-${Date.now()}`;
    const delegationToken = crypto.randomUUID();
    const laneDir = path.join(paths.activeDir, "lanes");
    await fs.promises.mkdir(laneDir, { recursive: true });
    const laneMailboxFile = path.join(laneDir, `${laneId}.txt`);
    await fs.promises.writeFile(
        laneMailboxFile,
        `Lane mailbox for ${title} (role ${roleId})\nRun: ${runId}\nLane: ${laneId}\nToken: ${delegationToken}\n\nCaptain messages appear below, newest last.\n`,
        { flag: "a", encoding: "utf-8" },
    );
    return {
        runId,
        laneId,
        delegationToken,
        roleId,
        workerKey: title,
        status: "active",
        visibleMessageRefs: [],
        ackedMessageRefs: [],
        invalidAckRefs: [],
        ackState: "none",
        createdAt: Date.now(),
    };
}

export async function writeTeamState(cwd: string, run: TeamRun): Promise<void> {
    const paths = teamControlPaths(cwd, run.runId);
    await fs.promises.mkdir(paths.activeDir, { recursive: true });
    const tmpFile = `${paths.stateFile}.tmp`;
    await fs.promises.writeFile(tmpFile, `${JSON.stringify(run, null, 2)}\n`, "utf-8");
    await fs.promises.rename(tmpFile, paths.stateFile);
}

export function isTeamCancelRequested(cwd: string, runId: string): boolean {
    return fs.existsSync(teamControlPaths(cwd, runId).cancelFile);
}

export async function requestTeamCancel(cwd: string, runId: string, reason: string): Promise<TeamControlPaths> {
    const paths = teamControlPaths(cwd, runId);
    await fs.promises.mkdir(paths.activeDir, { recursive: true });
    await fs.promises.writeFile(
        paths.cancelFile,
        `${JSON.stringify({ at: Date.now(), runId, reason }, null, 2)}\n`,
        "utf-8",
    );
    return paths;
}

export async function requestWorkerCancel(
    cwd: string,
    runId: string,
    roleId: string,
    reason: string,
): Promise<string> {
    const paths = teamControlPaths(cwd, runId);
    await fs.promises.mkdir(paths.activeDir, { recursive: true });
    const workerCancelFile = path.join(paths.activeDir, `cancel-${roleId.replace(/[^a-z0-9_-]/gi, "_")}.json`);
    await fs.promises.writeFile(
        workerCancelFile,
        `${JSON.stringify({ at: Date.now(), runId, roleId, reason }, null, 2)}\n`,
        "utf-8",
    );
    return workerCancelFile;
}

export function isWorkerCancelRequested(cwd: string, runId: string, roleId: string): boolean {
    const paths = teamControlPaths(cwd, runId);
    const workerCancelFile = path.join(paths.activeDir, `cancel-${roleId.replace(/[^a-z0-9_-]/gi, "_")}.json`);
    return fs.existsSync(workerCancelFile);
}

export async function appendTeamMessage(
    cwd: string,
    runId: string,
    message: string,
    options: { system?: boolean } = {},
): Promise<TeamControlPaths> {
    const paths = teamControlPaths(cwd, runId);
    await fs.promises.mkdir(paths.activeDir, { recursive: true });
    const at = Date.now();
    const messageRef = crypto.randomUUID();
    const entry: TeamMailboxMessage = { at, runId, message, messageRef, broadcast: true, system: options.system };
    await fs.promises.appendFile(paths.mailboxFile, `${JSON.stringify(entry)}\n`, "utf-8");
    // Human-readable mirror: one timestamped block per message, readable with
    // the `read` tool alone. System messages stay out of the worker-visible
    // mirror so workers never read extension bookkeeping as captain directives.
    if (!options.system) {
        const stamp = new Date(at).toISOString();
        await fs.promises.appendFile(
            paths.mailboxTextFile,
            `\n[captain @ ${stamp}]\n${message}\n`,
            "utf-8",
        );
    }
    return paths;
}

export async function readTeamMailbox(cwd: string, runId: string): Promise<TeamMailboxMessage[]> {
    const paths = teamControlPaths(cwd, runId);
    let raw = "";
    try {
        raw = await fs.promises.readFile(paths.mailboxFile, "utf-8");
    } catch {
        return [];
    }
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try {
                const parsed = JSON.parse(line) as TeamMailboxMessage;
                return typeof parsed.message === "string" ? parsed : undefined;
            } catch {
                return undefined;
            }
        })
        .filter((message): message is TeamMailboxMessage => message !== undefined);
}

export async function readTeamState(cwd: string, runId: string): Promise<TeamRun | undefined> {
    const paths = teamControlPaths(cwd, runId);
    try {
        return JSON.parse(await fs.promises.readFile(paths.stateFile, "utf-8")) as TeamRun;
    } catch {
        try {
            return JSON.parse(
                await fs.promises.readFile(path.join(teamRunLogDir(cwd), `${runId}.json`), "utf-8"),
            ) as TeamRun;
        } catch {
            return undefined;
        }
    }
}

export async function listTeamRunIds(cwd: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const dir of [teamActiveDir(cwd), teamRunLogDir(cwd)]) {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) ids.add(entry.name);
            if (entry.isFile() && entry.name.endsWith(".json")) ids.add(entry.name.slice(0, -".json".length));
        }
    }
    return [...ids].sort();
}
