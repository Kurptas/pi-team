import * as fs from "node:fs";
import * as path from "node:path";
import { teamControlPaths } from "./control.ts";
import type { TeamEvent, WorkerRun } from "./types.ts";

function safeFilePart(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[.-]+|-+$/g, "") || "worker";
}

export function workerArtifactPaths(cwd: string, runId: string, roleId: string): { outputFile: string; eventFile: string } {
    const dir = path.join(teamControlPaths(cwd, runId).activeDir, "artifacts", "workers");
    const safeRole = safeFilePart(roleId);
    return {
        outputFile: path.join(dir, `${safeRole}.md`),
        eventFile: path.join(dir, `${safeRole}.events.jsonl`),
    };
}

function artifactMarkdown(worker: WorkerRun): string {
    return [
        `# Worker ${worker.title} (${worker.roleId})`,
        "",
        `Status: ${worker.status}`,
        `Model: ${worker.model ?? "(unassigned)"}`,
        worker.routingReason ? `Routing: ${worker.routingReason}` : undefined,
        worker.modelFallbackKeys && worker.modelFallbackKeys.length > 0 ? `Fallback models: ${worker.modelFallbackKeys.join(", ")}` : undefined,
        `Tools: ${worker.tools?.join(", ") || "(none)"}`,
        worker.errorReason ? `Error: ${worker.errorReason}` : undefined,
        worker.requests !== undefined ? `Requests: ${worker.requests}` : undefined,
        worker.tokens !== undefined ? `Tokens: ${worker.tokens}` : undefined,
        "",
        "## Output",
        "",
        worker.output.trim() || "(no output)",
    ].filter((line): line is string => line !== undefined).join("\n");
}

export async function writeWorkerArtifacts(cwd: string, runId: string, worker: WorkerRun): Promise<WorkerRun> {
    const paths = workerArtifactPaths(cwd, runId, worker.roleId);
    try {
        await fs.promises.mkdir(path.dirname(paths.outputFile), { recursive: true });
        await fs.promises.writeFile(paths.outputFile, `${artifactMarkdown(worker)}\n`, "utf-8");
        const events = (worker.events ?? []) as TeamEvent[];
        await fs.promises.writeFile(paths.eventFile, events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""), "utf-8");
        return { ...worker, outputFile: paths.outputFile, eventFile: paths.eventFile };
    } catch {
        // Artifacts are best-effort supplements (the WorkerRun already lives in
        // state.json + the run log). A disk-full / permission / AV-lock failure
        // must not kill the run or the other completed workers in this round.
        // Return the worker without artifact paths to honestly signal no file.
        return { ...worker };
    }
}
