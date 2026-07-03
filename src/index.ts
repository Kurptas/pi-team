import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promoteBlueprintArtifact } from "./blueprint-store.ts";
import { loadModelCapabilityProfiles } from "./capabilities.ts";
import { appendTeamMessage, listTeamRunIds, prepareTeamControl, readTeamMailbox, readTeamState, requestTeamCancel, requestWorkerCancel, writeTeamState } from "./control.ts";
import { buildHandoffDigest, readHandoff } from "./handoff.ts";
import { loadTeamResources } from "./loader.ts";
import { loadManual } from "./manual-loader.ts";
import { resolveProbeResults, selectModelsToProbe } from "./model-selection.ts";
import { probePlan } from "./plan-probe.ts";
import { routeTeamPlan, toTeamModels } from "./model-router.ts";
import { createTeamPlan } from "./planner.ts";
import { createCliProbe, createInProcessProbe, probeModels } from "./prober.ts";
import { runTeamPlan, staleThresholdMs, type TeamRunOptions } from "./runner.ts";
import { createSemanticPlan } from "./semantic-planner.ts";
import type { TeamEvent, TeamInput, TeamModel, TeamRun, WorkerRun, PlannedRole } from "./types.ts";
import { clearLiveness, formatLivenessTag, recordAndDiffLiveness } from "./worker-liveness.ts";
import { guardCancelLastWorker } from "./cancel-guard.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(baseDir, "defaults");
// Stale threshold (PI_TEAM_STALE_THRESHOLD_MS, default 20s).
const TEAM_STATUS_STALE_MS = staleThresholdMs();
// Decision-window timeout (PI_TEAM_DECISION_WINDOW_MS, default 15s).
const DEFAULT_DECISION_WINDOW_MS = 15_000;
export function decisionWindowMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt(env.PI_TEAM_DECISION_WINDOW_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DECISION_WINDOW_MS;
}
const TEAM_WIDGET_KEY = "pi-team-workers";
const TEAM_STATUS_KEY = "pi-team-status";
const TEAM_WIDGET_VISIBLE_WORKERS = 3;

const TeamParams = Type.Object({
    task: Type.String({ description: "Task for the team to complete" }),
    playbook: Type.Optional(Type.String({ description: "Playbook id, such as etf-research or code-review" })),
    mode: Type.Optional(Type.String({ description: "Task mode: research, roundtable, code, review, strategy" })),
    maxAgents: Type.Optional(Type.Number({ description: "Maximum number of worker roles to run" })),
    probeModels: Type.Optional(Type.Boolean({ description: "Run live model probes before dispatch. Default: true" })),
    outputContract: Type.Optional(Type.String({ description: "Output contract hint" })),
    fallbackPolicy: Type.Optional(
        Type.Union([
            Type.Literal("task_first"),
            Type.Literal("strict"),
            Type.Literal("cheap_only"),
        ], { description: "Model fallback behavior: task_first (default), strict (do not auto-fallback beyond explicit/recommended candidates), or cheap_only (fallback only to low-cost/fast models)." }),
    ),
    roles: Type.Optional(
        Type.Array(
            Type.Object({
                id: Type.Optional(Type.String({ description: "Stable role id for generated playbooks" })),
                title: Type.String({ description: "Task-specific role title" }),
                capability: Type.Optional(Type.String({ description: "Role capability profile" })),
                capabilityNeeds: Type.Optional(
                    Type.Array(Type.String({ description: "Capability tags needed by this role" })),
                ),
                description: Type.Optional(Type.String({ description: "Role responsibility and boundary" })),
                systemPrompt: Type.Optional(Type.String({ description: "Role-specific system prompt" })),
                tools: Type.Optional(Type.Array(Type.String({ description: "Tools this role should use" }))),
                modelFit: Type.Optional(Type.String({ description: "What model qualities fit this role" })),
                thinking: Type.Optional(
                    Type.Union([
                        Type.Literal("off"),
                        Type.Literal("minimal"),
                        Type.Literal("low"),
                        Type.Literal("medium"),
                        Type.Literal("high"),
                        Type.Literal("xhigh"),
                    ], { description: "Explicit thinking level for this role. You can also append it to a model preference, e.g. provider/model:high." }),
                ),
                modelPreferences: Type.Optional(
                    Type.Array(Type.String({ description: "Preferred provider/model keys; may include :thinking suffix, e.g. provider/model:high" })),
                ),
                dependsOn: Type.Optional(
                    Type.Array(Type.String({ description: "Role ids that must finish before this role starts" })),
                ),
                reportsTo: Type.Optional(
                    Type.Array(Type.String({ description: "Role ids that should run after this role" })),
                ),
                sop: Type.Optional(
                    Type.Array(Type.String({ description: "SOP ids to inject into this worker's system prompt (e.g. [\"code-review\", \"research\"]). Files live in defaults/manuals/sop/<id>.md." })),
                ),
                resumable: Type.Optional(Type.Boolean({ description: "When true, this role's worker session persists to disk and the SAME roleId in a later round resumes with full prior context instead of starting fresh. Default false (in-memory, wiped after the run). Opt-in for multi-round 'same teammate continues' work." })),
            }),
            { description: "Task-specific roles designed by the lead agent when built-in playbooks are too generic" },
        ),
    ),
    background: Type.Optional(
        Type.Boolean({ description: "Run the team in the background. Default: true. When true, team returns immediately with a runId so the captain can observe with team_status and control with team_message/team_cancel_worker. When false, blocks until the team finishes (ESC cancels the run)." }),
    ),
});

const backgroundRunControllers = new Map<string, AbortController>();
// Runs the captain explicitly canceled. Their background Promise still settles
// Canceled runs: captain asked to cancel, suppress completion push.
// Observed runs: captain polled via team_status, no push unless failed.
const captainCanceledRuns = new Set<string>();
const observedRuns = new Set<string>();

const TeamRunParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
});

const TeamMessageParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    message: Type.String({ description: "Captain message for active workers" }),
});

const TeamCancelParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    reason: Type.Optional(Type.String({ description: "Reason shown in the cancel marker" })),
});

const TeamPromoteBlueprintParams = Type.Object({
    blueprintId: Type.Optional(Type.String({ description: "Generated blueprint id. Defaults to the run blueprint id." })),
    runId: Type.Optional(Type.String({ description: "Team run id to read blueprint id from when blueprintId is omitted." })),
    captainNote: Type.String({ description: "Captain judgment for why this generated blueprint is worth reusing." }),
});

const TeamCancelWorkerParams = Type.Object({
    runId: Type.Optional(Type.String({ description: "Team run id. Defaults to the latest known run." })),
    roleId: Type.String({ description: "Worker role id to cancel." }),
    reason: Type.Optional(Type.String({ description: "Reason for canceling this specific worker." })),
    confirm: Type.Optional(Type.Boolean({ description: "Required (true) to cancel the LAST running worker — ends all live execution, no new evidence this round. Not needed when other workers remain." })),
});

function teamInstruction(task: string): string {
    return [
        "Use the team tool to complete this request.",
        "You are the team captain for this task: plan the work, dispatch teammates, inspect progress, check whether the returned evidence satisfies the task, decide whether another pass is needed, and make the final judgment yourself.",
        `Task: ${task}`,
    ].join("\n");
}

// completionPush / shouldPushCompletion / detectModelConvergence are pure
// helpers extracted to notify-gating.ts (size gate). Re-exported here so
// existing callers and tests keep their import path.
import { completionPush, detectModelConvergence, shouldPushCompletion } from "./notify-gating.ts";
export { completionPush, detectModelConvergence, shouldPushCompletion } from "./notify-gating.ts";

function makeRun(task: string, playbookId: string, fallbackPolicy?: TeamInput["fallbackPolicy"]): TeamRun {
    return {
        runId: `team_${Date.now().toString(36)}`,
        task,
        playbookId,
        fallbackPolicy,
        status: "planning",
        modelHealth: [],
        workers: [],
    };
}

function inheritedTeamTools(pi: ExtensionAPI): string[] {
    return pi
        .getActiveTools()
        .map((tool) => tool.trim())
        .filter((tool) => tool && tool !== "team");
}

async function resolveRunId(cwd: string, requestedRunId: string | undefined): Promise<string | undefined> {
    if (requestedRunId?.trim()) return requestedRunId.trim();
    const runIds = await listTeamRunIds(cwd);
    return runIds.at(-1);
}

export function refreshTeamModelRegistry(ctx: Pick<ExtensionContext, "modelRegistry">): void {
    ctx.modelRegistry.authStorage.reload();
    ctx.modelRegistry.refresh();
}

function secondsSince(timestamp: number | undefined, now: number): number | undefined {
    return timestamp === undefined ? undefined : Math.max(0, Math.round((now - timestamp) / 1000));
}

function workerActivity(worker: WorkerRun): string {
    if (worker.lastTool) return `tool:${worker.lastTool}`;
    return worker.lastEvent ?? "starting";
}

export function buildTeamStatusProjection(
    run: TeamRun,
    mailboxMessages: { at: number; message: string }[],
    now = Date.now(),
) {
    const workers = (run.workers ?? []).map((worker) => {
        const signalAgeMs = worker.lastSignalAt === undefined ? undefined : Math.max(0, now - worker.lastSignalAt);
        const signalAgeSeconds = secondsSince(worker.lastSignalAt, now);
        const stale = worker.status === "running" && signalAgeMs !== undefined && signalAgeMs > TEAM_STATUS_STALE_MS;
        return {
            roleId: worker.roleId,
            title: worker.title,
            model: worker.model,
            thinkingLevel: worker.thinkingLevel,
            status: worker.status,
            elapsedSeconds:
                worker.startedAt === undefined
                    ? undefined
                    : Math.max(0, Math.round(((worker.endedAt ?? now) - worker.startedAt) / 1000)),
            signalAgeSeconds,
            stale,
            activity: workerActivity(worker),
            outputKind: worker.outputKind,
            timedOut: worker.timedOut === true,
            streamParseErrorCount: worker.streamParseErrorCount ?? 0,
            lastReportPreview: worker.lastReportPreview,
            lastCaptainMessagePreview: worker.lastCaptainMessagePreview,
            eventCount: worker.events?.length ?? 0,
            exitCode: worker.exitCode,
            exitSignal: worker.exitSignal,
            cancelRequestedAt: worker.cancelRequestedAt,
            cancelObservedAt: worker.cancelObservedAt,
            tools: worker.tools,
            activeTools: worker.activeTools,
            toolIsolationViolation: worker.toolIsolationViolation,
            requests: worker.requests ?? 0,
            tokens: worker.tokens ?? 0,
            costUsd: worker.costUsd ?? 0,
            errorReason: worker.errorReason,
            laneId: worker.laneId,
            delegationToken: worker.delegationToken,
        };
    });
    const activeWorkers = workers.filter((worker) => worker.status === "running");
    const evidenceWarnings = (run.events ?? [])
        .filter((event) => event.phase === "run-evidence-warning")
        .map((event) => event.message);
    return {
        runId: run.runId,
        status: run.status,
        playbookId: run.playbookId,
        counts: {
            total: workers.length,
            active: activeWorkers.length,
            succeeded: workers.filter((worker) => worker.status === "succeeded").length,
            failed: workers.filter((worker) => worker.status === "failed").length,
            skipped: workers.filter((worker) => worker.status === "skipped").length,
            stale: workers.filter((worker) => worker.stale).length,
            timedOut: workers.filter((worker) => worker.timedOut).length,
            parseErrors: workers.reduce((sum, worker) => sum + worker.streamParseErrorCount, 0),
            toolViolations: workers.filter((worker) => !!worker.toolIsolationViolation).length,
            requests: workers.reduce((sum, worker) => sum + worker.requests, 0),
            tokens: workers.reduce((sum, worker) => sum + worker.tokens, 0),
            costUsd: workers.reduce((sum, worker) => sum + worker.costUsd, 0),
        },
        mailbox: {
            file: run.mailboxFile,
            textFile: run.mailboxTextFile,
            messages: mailboxMessages.length,
            lastMessagePreview: mailboxMessages.at(-1)?.message,
        },
        cancelFile: run.cancelFile,
        evidenceWarnings,
        workers,
        modelHealth: (run.modelHealth ?? []).map((snapshot) => ({
            model: snapshot.model,
            status: snapshot.status,
            reason: snapshot.reason,
            latencyMs: snapshot.latencyMs,
        })),
        controls: run.status === "running" ? ["team_message", "team_cancel"] : [],
        stateWriteError: run.stateWriteError,
    };
}

type TeamStatusProjection = ReturnType<typeof buildTeamStatusProjection>;
type ProjectedWorker = TeamStatusProjection["workers"][number];
type TeamToolUpdate = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[3];

let sessionUi: ExtensionUIContext | undefined;
let sessionMode: ExtensionContext["mode"] | undefined;
const activeTeamRunIds = new Set<string>();

function isTerminalStatus(status: TeamRun["status"]): boolean {
    return status === "succeeded" || status === "degraded" || status === "failed";
}

function durationLabel(seconds: number | undefined): string {
    if (seconds === undefined) return "--";
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function statusGlyph(worker: Pick<ProjectedWorker, "status" | "stale">): { glyph: string; color: "accent" | "success" | "error" | "warning" | "dim" | "muted" } {
    if (worker.stale) return { glyph: "◌", color: "dim" };
    if (worker.status === "running") return { glyph: "●", color: "accent" };
    if (worker.status === "succeeded") return { glyph: "✓", color: "success" };
    if (worker.status === "failed") return { glyph: "✗", color: "error" };
    if (worker.status === "skipped") return { glyph: "⊘", color: "muted" };
    return { glyph: "•", color: "warning" };
}

function fitVisible(text: string, width: number): string {
    return truncateToWidth(text, width, "…");
}

function padVisible(text: string, width: number): string {
    return `${fitVisible(text, width)}${" ".repeat(Math.max(0, width - visibleWidth(fitVisible(text, width))))}`;
}

function compactModelName(model: string | undefined): string {
    if (!model) return "unassigned";
    return model.split("/").at(-1) ?? model;
}

function compactModelThinking(worker: ProjectedWorker, width: number): string {
    const suffix = worker.thinkingLevel ? `:${worker.thinkingLevel}` : "";
    return `${fitVisible(compactModelName(worker.model), Math.max(1, width - visibleWidth(suffix)))}${suffix}`;
}

function workerCompactLine(worker: ProjectedWorker, theme: Theme): string {
    const glyph = statusGlyph(worker);
    const title = padVisible(worker.title, 18);
    const model = padVisible(compactModelThinking(worker, 16), 16);
    const signal = worker.status === "running" ? `·${durationLabel(worker.signalAgeSeconds)}` : "";
    const exit = worker.status === "failed" ? ` exit:${worker.exitCode ?? "?"}` : "";
    const activity = worker.status === "running" && worker.activity ? ` ${worker.activity.replace(/^tool:/, "")}` : "";
    const report = worker.status === "running" && worker.lastReportPreview ? ` report:${fitVisible(worker.lastReportPreview, 48)}` : "";
    return `${theme.fg(glyph.color, glyph.glyph)} ${title} ${theme.fg("dim", model)} ${durationLabel(worker.elapsedSeconds)} ${theme.fg("dim", signal)}${theme.fg(worker.status === "failed" ? "error" : "dim", `${exit}${activity}${report}`)}`.trimEnd();
}

function teamCountSummary(run: TeamRun, theme?: Theme): string {
    const projection = buildTeamStatusProjection(run, []);
    const { counts } = projection;
    const paint = (color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string) =>
        theme ? theme.fg(color, text) : text;
    const parts = [
        `${counts.total} workers`,
        `${paint("success", "✓")} ${counts.succeeded}`,
        `${paint("accent", "●")} ${counts.active}`,
        `${paint("error", "✗")} ${counts.failed}`,
    ];
    if (counts.skipped) parts.push(`${paint("muted", "⊘")} ${counts.skipped}`);
    if (counts.stale) parts.push(`${paint("warning", "stale")} ${counts.stale}`);
    return parts.join(" · ");
}

function compactTeamLine(run: TeamRun, theme: Theme): string {
    const statusColor = run.status === "failed" ? "error" : run.status === "degraded" ? "warning" : isTerminalStatus(run.status) ? "success" : "accent";
    return `${theme.fg("toolTitle", theme.bold("team"))} ${theme.fg(statusColor, run.status)} ${theme.fg("dim", run.playbookId)} · ${teamCountSummary(run, theme)}`;
}

function truncatedLines(lines: string[]): Component {
    return {
        render(width: number) {
            return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
        },
        invalidate() {},
    };
}

export function teamWidgetLines(run: TeamRun, theme: Theme): string[] {
    const projection = buildTeamStatusProjection(run, []);
    const shown = projection.workers.slice(0, TEAM_WIDGET_VISIBLE_WORKERS);
    const more = Math.max(0, projection.workers.length - shown.length);
    const lines = [compactTeamLine(run, theme), ...shown.map((worker) => workerCompactLine(worker, theme))];
    if (more > 0) lines.push(theme.fg("dim", `… ${more} more worker(s)`));
    return lines;
}

function teamWidget(run: TeamRun, theme: Theme): Component {
    return truncatedLines(teamWidgetLines(run, theme));
}

function teamWidgetKey(runId: string): string {
    return `${TEAM_WIDGET_KEY}:${runId}`;
}

function teamStatusKey(runId: string): string {
    return `${TEAM_STATUS_KEY}:${runId}`;
}

function clearTeamUi(runId?: string, ui = sessionUi): void {
    if (!ui) return;
    const ids = runId ? [runId] : [...activeTeamRunIds];
    for (const id of ids) {
        ui.setWidget(teamWidgetKey(id), undefined);
        ui.setStatus(teamStatusKey(id), undefined);
        activeTeamRunIds.delete(id);
    }
    if (!runId) {
        ui.setWidget(TEAM_WIDGET_KEY, undefined);
        ui.setStatus(TEAM_STATUS_KEY, undefined);
    }
}

function updateTeamUi(run: TeamRun, ctx?: Pick<ExtensionContext, "hasUI" | "ui" | "mode">): void {
    const ui = ctx?.hasUI ? ctx.ui : sessionUi;
    const mode = ctx?.hasUI ? ctx.mode : sessionMode;
    if (!ui) return;
    if (isTerminalStatus(run.status)) {
        clearTeamUi(run.runId, ui);
        return;
    }
    activeTeamRunIds.add(run.runId);
    ui.setStatus(teamStatusKey(run.runId), `team · ${run.status} · ${teamCountSummary(run)}`);
    if (mode === "tui") {
        ui.setWidget(teamWidgetKey(run.runId), (_tui, theme) => teamWidget(run, theme), { placement: "belowEditor" });
    } else if (mode === "rpc") {
        ui.setWidget(teamWidgetKey(run.runId), teamWidgetLines(run, { fg: (_color, text) => text, bold: (text) => text } as Theme), { placement: "belowEditor" });
    }
}

function teamUpdateSink(onUpdate: TeamToolUpdate | undefined, ctx?: Pick<ExtensionContext, "hasUI" | "ui" | "mode">): TeamToolUpdate {
    return (partial) => {
        if (partial.details) updateTeamUi(partial.details as TeamRun, ctx);
        onUpdate?.(partial);
    };
}

function renderTeamDetails(run: TeamRun, theme: Theme): Component {
    const projection = buildTeamStatusProjection(run, []);
    const lines = [compactTeamLine(run, theme)];
    for (const worker of projection.workers) {
        const output = worker.outputKind ? ` output:${worker.outputKind}` : "";
        const report = worker.lastReportPreview ? ` report:${worker.lastReportPreview}` : "";
        const error = worker.errorReason ? ` error:${worker.errorReason}` : "";
        lines.push(`${workerCompactLine(worker, theme)}${output}${report}${error}`);
    }
    return truncatedLines(lines);
}

function renderTeamCompact(run: TeamRun, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Component {
    if (options.expanded) return renderTeamDetails(run, theme);
    const hint = options.isPartial ? "" : ` ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
    return truncatedLines([`${compactTeamLine(run, theme)}${hint}`]);
}

function renderPlainResult(text: string): Component {
    return truncatedLines(text.split("\n"));
}

function logUpdate(
    onUpdate: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[3],
    run: TeamRun,
    event: TeamEvent,
): TeamRun {
    const stamped = { at: Date.now(), ...event };
    const nextRun = {
        ...run,
        lastEvent: stamped,
        events: [...(run.events ?? []), stamped],
    };
    onUpdate?.({
        content: [{ type: "text", text: `[team:${event.phase}] ${event.message}` }],
        details: nextRun,
    });
    return nextRun;
}

export default function teamExtension(pi: ExtensionAPI) {
    pi.registerCommand("team", {
        description: "Run a lightweight multi-agent team from Markdown playbooks and roles",
        handler: async (args, ctx) => {
            const task = args.trim();
            if (!task) {
                ctx.ui.notify("Usage: /team <task>", "warning");
                return;
            }
            pi.sendUserMessage(teamInstruction(task));
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        sessionUi = ctx.hasUI ? ctx.ui : undefined;
        sessionMode = ctx.hasUI ? ctx.mode : undefined;
    });

    pi.on("session_shutdown", async () => {
        clearTeamUi();
        sessionUi = undefined;
        sessionMode = undefined;
    });

    pi.on("before_agent_start", async (event) => {
        // Load the captain manual from the manuals/ tree (frontmatter stripped by
        // loadManual). Falls back to the legacy flat file if the new path is absent.
        const loaded = loadManual(join(defaultsDir, "manuals", "captain", "01-captain-manual.md"));
        const manual = loaded ? loaded.body.trim() : readFileSync(join(defaultsDir, "captain-manual.md"), "utf-8");
        return {
            systemPrompt: `${event.systemPrompt}

Team captain contract: when you use the \`team\` tool, you are the captain for the whole task. The tool is a communication, dispatch, evidence, and observation channel. You own the plan, role design, model preference choices, progress inspection, evidence check, conflict handling, follow-up dispatch decision, and final answer. Use a Plan-Do-Check-Act loop: plan the team, run it, inspect model health and worker outputs, then decide whether to synthesize, ask another pass, change roles, use other tools, or report limitations. Treat model capability facts (strengths, cautions, recommended roles, and context notes) as inputs for your judgment. Treat model health probe results as current channel availability. Make the final judgment yourself and explain material gaps or failed workers.\n\n${manual}`,
        };
    });

    pi.registerTool({
        name: "team",
        label: "Team",
        description:
            "Run a lightweight multi-agent team. Loads Markdown playbooks/roles or lead-designed roles, observes candidate model health, dispatches Pi subprocess workers, and returns findings for lead synthesis.",
        promptSnippet: "Dispatch a small AI team and return captain-ready findings.",
        promptGuidelines: [
            "Use team when the task benefits from independent research, review, implementation checks, or multiple model perspectives.",
            "After dispatching a team, use team_status periodically to check worker progress, detect stalled/failed workers, and decide whether to intervene.",
            "Use team_message only to add material constraints, corrections, or priorities for workers in an active team run.",
            "If a worker shows no progress after 30+ seconds or output is empty, call team_status to inspect and consider team_cancel_worker if it appears stuck.",
        ],
        parameters: TeamParams,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
            const input = params as TeamInput;
            const teamUpdate = teamUpdateSink(onUpdate, ctx);
            const resources = loadTeamResources(ctx.cwd, defaultsDir);
            const capabilityProfiles = loadModelCapabilityProfiles(defaultsDir);
            const inheritedTools = inheritedTeamTools(pi);
            const semanticPlan =
                !input.playbook && !input.roles
                    ? await createSemanticPlan(ctx.cwd, input, inheritedTools, capabilityProfiles, signal)
                    : undefined;
            const plannedInput = semanticPlan ? { ...input, roles: semanticPlan.roles } : input;
            const plan = createTeamPlan(plannedInput, resources, semanticPlan);
            const fallbackPolicy = input.fallbackPolicy ?? "task_first";
            let run = makeRun(input.task, plan.playbook.id, fallbackPolicy);

            // Blueprint review by a separate model was removed (2026-07-03
            // north-star): the blueprint is the CAPTAIN's own org design. The
            // captain (main agent) authored it via semantic-planner and reviews
            // and revises it directly — outsourcing that judgment to another
            // model both inverts "captain owns judgment" and dragged in an
            // unprobed model with a hard-timeout abort. Captain reviews it itself.
            run = logUpdate(teamUpdate, run, {
                phase: "planning",
                message: semanticPlan
                    ? `semantic blueprint ${plan.playbook.id}: ${semanticPlan.rationale}`
                    : `selected playbook ${plan.playbook.id} with ${plan.rounds.length} round(s)`,
                status: run.status,
            });
            run = logUpdate(teamUpdate, run, {
                phase: "blueprint-strategy",
                message: plan.policy.strategy,
                status: run.status,
            });
            run = logUpdate(teamUpdate, run, {
                phase: "blueprint-policy",
                message: `evidence=${plan.policy.evidencePolicy} model=${plan.policy.modelPolicy} synthesis=${plan.policy.synthesisPolicy}`,
                status: run.status,
            });
            run = logUpdate(teamUpdate, run, {
                phase: "tool-inheritance",
                message: `inherited ${inheritedTools.length} active tool(s): ${inheritedTools.join(",") || "(none)"}`,
                status: run.status,
            });

            refreshTeamModelRegistry(ctx);
            const availableModels = toTeamModels(ctx.modelRegistry.getAvailable());
            const configuredModels = availableModels.map((m) => ({
                key: `${m.provider}/${m.id}`,
                provider: m.provider,
                id: m.id,
                name: m.name,
            }));

            // Step 1: probe the plan's role-model recommendations (2026-07-03 项6 方案B).
            // probePlan wraps select → probe → resolve into a single call and
            // returns deadBlueprintModels so the semantic-planner can do ONE
            // revision pass with unavailableModels as hard constraints.
            const directDispatch =
                !semanticPlan &&
                (input.roles?.length ?? 0) > 0 &&
                (input.roles ?? []).every(
                    (role) =>
                        (role.modelPreferences?.length ?? 0) > 0 &&
                        (role.dependsOn?.length ?? 0) === 0 &&
                        (role.reportsTo?.length ?? 0) === 0,
                );
            const probe = input.probeModels === false
                ? ((model: TeamModel) => Promise.resolve({ model: `${model.provider}/${model.id}`, provider: model.provider, status: "probe_skipped" as const, latencyMs: 0, reason: "probeModels=false", checkedAt: Date.now() }))
                : process.env.PI_TEAM_PROBE_USE_CLI === "1" ? createCliProbe() : createInProcessProbe(ctx.modelRegistry, ctx.cwd);

            let result = await probePlan(plan, configuredModels, availableModels, defaultsDir, fallbackPolicy, directDispatch, probe, signal);
            let deadBlueprint = result.deadBlueprintModels;
            let currentPlan = plan;

            // Revision pass (方案B): if the semantic-planner suggested models that
            // came back dead, give it a second chance with hard unavailableModel constraints.
            // One pass only — no iterative ping-pong. (2026-07-03 项6.)
            if (semanticPlan && deadBlueprint.length > 0) {
                const revised = await createSemanticPlan(ctx.cwd, input, inheritedTools, capabilityProfiles, signal, deadBlueprint);
                if (revised) {
                    currentPlan = createTeamPlan({ ...input, roles: revised.roles }, resources, revised);
                    result = await probePlan(currentPlan, configuredModels, availableModels, defaultsDir, fallbackPolicy, directDispatch, probe, signal);
                }
            }
            const { probeSet, modelHealth: health, resolved } = result;

            run = { ...run, status: "probing" };
            run = logUpdate(teamUpdate, run, {
                phase: "model-observe-start",
                message: `selected ${probeSet.models.length}/${availableModels.length} relevant model(s) to probe across ${currentPlan.rounds.flatMap((r) => r.roles).length} role(s); fallbackPolicy=${fallbackPolicy}` +
                    (directDispatch ? "; direct-dispatch (captain fully specified — probing only chosen models as liveness check)" : "") +
                    (deadBlueprint.length > 0 ? `; blueprint revision: ${deadBlueprint.length} unavailable model(s) → replanned` : "") +
                    (probeSet.recommendationStale ? `; recommendation data stale (${Math.round(probeSet.recommendationAgeDays)}d)` : "") +
                    (probeSet.warnings.length > 0 ? `; ${probeSet.warnings.join(" | ")}` : ""),
                status: run.status,
            });

            run = { ...run, modelHealth: health };
            run = logUpdate(teamUpdate, run, {
                phase: "model-observe-end",
                message: health.map((snapshot) => `${snapshot.model}:${snapshot.status}`).join(", ") +
                    (resolved.warnings.length > 0 ? ` | ${resolved.warnings.join(" | ")}` : ""),
                status: run.status,
            });

            const routedPlan = routeTeamPlan(currentPlan, availableModels, health, capabilityProfiles, resolved);
            run = logUpdate(teamUpdate, run, {
                phase: "dispatch-ready",
                message: routedPlan.rounds
                    .flatMap((round) =>
                        round.roles.map(
                            (role) =>
                                `${role.roleId}->${role.selectedModel ?? "unassigned"} (${role.routingReason ?? "no routing reason"})`,
                        ),
                    )
                    .join(", "),
            });

            // Single-model convergence check: when every routed role across the
            // whole plan (all rounds, not just parallel ones) lands on the same
            // model despite other healthy models being available, the run loses
            // its multi-model perspective. Surface it so the captain can decide
            // whether to intervene. (2026-07-02 single-model-convergence: fix #3.)
            const assignedModels = routedPlan.rounds
                .flatMap((round) => round.roles)
                .map((r) => r.selectedModel)
                .filter((m): m is string => Boolean(m));
            const healthyModelCount = health.filter((h) => h.status === "probe_passed" || h.status === "probe_skipped").length;
            const convergenceNotice = detectModelConvergence(assignedModels, healthyModelCount);

            if (input.background !== false) {
                const prepared = await prepareTeamControl(ctx.cwd, run);
                const failedPrefs = resolved.rolePlans.filter((rp) => rp.failedUserPreferences.length > 0);
                const degradedPrefs = resolved.rolePlans.filter((rp) => rp.degradedUserPreferences.length > 0);
                let pendingModelDecision: TeamRunOptions["pendingModelDecision"];
                let decisionNotice: string | undefined;
                // The decision window exists to protect a CAPTAIN's explicit
                // model choice from silent substitution. Blueprint prefs are LLM
                // guesses (semanticPlan authored them), not captain intent, and
                // frequently name unconfigured keys; opening a window for them
                // stalls every auto-planned run for no captain benefit.
                // (2026-07-02 fallback-gaps: Bug#2.) So: only captain-authored
                // preferences (no semanticPlan) open the window; blueprint pref
                // misses are surfaced as a warning and auto-fallback proceeds.
                const captainAuthoredPrefs = !semanticPlan;
                const anyPrefMiss = failedPrefs.length > 0 || degradedPrefs.length > 0;
                if (captainAuthoredPrefs && anyPrefMiss) {
                    const unavailable = failedPrefs.flatMap((rp) => rp.failedUserPreferences);
                    const degraded = degradedPrefs.flatMap((rp) => rp.degradedUserPreferences);
                    const prefList = [...new Set([...unavailable, ...degraded])];
                    const configuredKeys = configuredModels.map((cm) => cm.key);
                    const windowMs = decisionWindowMs();
                    const afterTimeout =
                        fallbackPolicy === "strict"
                            ? "On timeout, affected role(s) stay UNASSIGNED and will be skipped (strict: no automatic substitution)."
                            : "On timeout, auto-fallback to a healthy model proceeds.";
                    const cause = degraded.length > 0
                        ? `unavailable/probe-degraded: ${prefList.join(", ")}`
                        : `unavailable: ${prefList.join(", ")}`;
                    pendingModelDecision = {
                        failedPrefs: prefList,
                        configuredKeys,
                        deadlineAt: Date.now() + windowMs,
                        policy: fallbackPolicy,
                    };
                    decisionNotice =
                        `[!] Model decision window (~${Math.round(windowMs / 1000)}s): your model preference(s) ${cause}. ` +
                        `Reply with team_message(runId="${run.runId}", "<model key>") to override. ${afterTimeout}`;
                    if (prepared.mailboxTextFile) {
                        await appendTeamMessage(ctx.cwd, run.runId,
                            `[pi-team decision window] User-specified model(s) ${cause}. ` +
                            `Available: ${configuredKeys.slice(0, 5).join(", ")}${configuredKeys.length > 5 ? "..." : ""}. ` +
                            `Reply with a model key to override. ${afterTimeout} Waiting ~${Math.round(windowMs / 1000)}s.`,
                            { system: true },
                        );
                    }
                } else if (!captainAuthoredPrefs && anyPrefMiss) {
                    const unavailable = failedPrefs.flatMap((rp) => rp.failedUserPreferences);
                    const degraded = degradedPrefs.flatMap((rp) => rp.degradedUserPreferences);
                    const prefList = [...new Set([...unavailable, ...degraded])];
                    decisionNotice =
                        `Note: blueprint-suggested model(s) ${prefList.join(", ")} unavailable/degraded; ` +
                        `auto-fallback to a healthy model applied (planner suggestions, not your explicit choice — no window opened).`;
                    run = logUpdate(teamUpdate, run, {
                        phase: "blueprint-model-fallback",
                        message: `blueprint model preference(s) unavailable: ${prefList.join(", ")}; auto-fallback applied`,
                        status: run.status,
                    });
                }
                await writeTeamState(ctx.cwd, prepared);
                const runController = new AbortController();
                backgroundRunControllers.set(run.runId, runController);
                const detachedRun = { ...prepared, workers: [] as WorkerRun[] };
                const backgroundUpdate = teamUpdateSink(undefined);
                runTeamPlan(ctx.cwd, routedPlan, detachedRun, { inheritedTools, modelRegistry: ctx.modelRegistry, pendingModelDecision, defaultsDir }, runController.signal, backgroundUpdate)
                    .then(async (finalRun) => {
                        backgroundRunControllers.delete(run.runId);
                        const wasCanceled = captainCanceledRuns.has(run.runId);
                        if (wasCanceled) captainCanceledRuns.delete(run.runId);
                        clearTeamUi(finalRun.runId);
                        clearLiveness(finalRun.runId);
                        await writeTeamState(ctx.cwd, finalRun);
                        // Completion-push gating (2026-07-03 项7): canceled runs
                        // never push; a run the captain already observed via
                        // team_status does not push (noise) unless it failed.
                        const wasObserved = observedRuns.has(finalRun.runId);
                        observedRuns.delete(finalRun.runId);
                        if (!shouldPushCompletion(wasCanceled, wasObserved, finalRun.status)) return;
                        const summary = finalRun.finalSummary
                            ? finalRun.finalSummary.split(/\r?\n/).slice(0, 3).join("\n")
                            : `${finalRun.workers.length} worker(s) completed.`;
                        pi.sendUserMessage(completionPush(finalRun.runId, finalRun.status, summary), { deliverAs: "followUp" });
                    })
                    .catch(async (error) => {
                        backgroundRunControllers.delete(run.runId);
                        const wasCanceled = captainCanceledRuns.has(run.runId);
                        if (wasCanceled) captainCanceledRuns.delete(run.runId);
                        const errorRun: TeamRun = {
                            ...prepared,
                            status: "failed",
                            stateWriteError: String(error),
                            workers: [],
                        };
                        clearTeamUi(errorRun.runId);
                        clearLiveness(errorRun.runId);
                        await writeTeamState(ctx.cwd, errorRun);
                        // Same gate as the success callback (one push policy).
                        // "failed" always pushes unless canceled. (2026-07-03 项7 M1.)
                        const wasObserved = observedRuns.has(errorRun.runId);
                        observedRuns.delete(errorRun.runId);
                        if (!shouldPushCompletion(wasCanceled, wasObserved, "failed")) return;
                        pi.sendUserMessage(completionPush(errorRun.runId, "failed", `Run crashed: ${String(error).slice(0, 200)}`), { deliverAs: "followUp" });
                    });
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `Team run ${run.runId} started in background (${plan.playbook.title}).`,
                                // Surface the model decision window / auto-fallback notice at the
                                // top of the captain-visible result, not just buried in the mailbox.
                                // (2026-07-02 fallback-gaps: gap A.)
                                ...(decisionNotice ? [decisionNotice, ""] : []),
                                ...(convergenceNotice ? [convergenceNotice, ""] : []),
                                `Observe: team_status(runId="${run.runId}")`,
                                `Control: team_message / team_cancel_worker(runId="${run.runId}")`,
                                `Cancel: team_cancel(runId="${run.runId}")`,
                                "",
                                "IMPORTANT: You are still the captain. The team is running in background now.",
                                "Do NOT just wait — use team_status periodically to check progress.",
                                "If workers are stalled, empty, or failed — intervene with team_cancel_worker or team_message.",
                            ].join("\n"),
                        },
                    ],
                    details: { runId: run.runId, activeDir: prepared.activeDir, status: "running" },
                };
            }

            run = await runTeamPlan(ctx.cwd, routedPlan, run, { inheritedTools, modelRegistry: ctx.modelRegistry, defaultsDir }, signal, teamUpdate);
            clearLiveness(run.runId); // M1: foreground run also needs cleanup
            pi.appendEntry("team-run", run);

            const diagnostics =
                resources.diagnostics.length > 0 ? `\n\nDiagnostics:\n${resources.diagnostics.join("\n")}` : "";
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `Team run ${run.status}: ${plan.playbook.title}`,
                            "",
                            run.finalSummary ?? "(no worker output)",
                            "",
                            ...(convergenceNotice ? [convergenceNotice, ""] : []),
                            "Captain instruction: you remain responsible for the task. Inspect model health, worker outputs, evidence refs, disagreements, failed roles, and routing reasons. Decide whether the task is complete, whether another pass is needed, and what final answer is justified.",
                            diagnostics,
                        ].join("\n"),
                    },
                ],
                details: run,
                isError: run.status === "failed",
            };
        },
        renderCall(args, theme) {
            const task = typeof args.task === "string" ? args.task : "(missing task)";
            return truncatedLines([`${theme.fg("toolTitle", theme.bold("team"))} ${theme.fg("accent", "▶ Dispatching")} ${theme.fg("dim", task)}`]);
        },
        renderResult(result, options, theme) {
            const run = result.details as TeamRun | undefined;
            if (run?.workers) return renderTeamCompact(run, options, theme);
            const text = result.content[0];
            return renderPlainResult(text?.type === "text" ? text.text : "(no output)");
        },
    });

    pi.registerTool({
        name: "team_status",
        label: "Team Status",
        description:
            "Observe a team run from the captain side. Reads the latest active or persisted team state with worker events and mailbox path.",
        promptSnippet: "Observe current or latest team run status without re-dispatching workers.",
        promptGuidelines: [
            "Use team_status before final synthesis when a team run is still active or was started in background.",
            "Use team_status to inspect worker failures, stale workers, mailbox messages, and model health before deciding next action.",
        ],
        parameters: TeamRunParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) {
                return {
                    content: [{ type: "text", text: "No team run found." }],
                    details: undefined,
                    isError: true,
                };
            }
            const run = await readTeamState(ctx.cwd, runId);
            if (!run) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                    details: undefined,
                    isError: true,
                };
            }
            // Mark run as observed so background completion skips the push (noise — captain is watching; failed runs still push).
            observedRuns.add(runId);
            // Self-heal a stuck status line when the run reached terminal before the poll.
            if (isTerminalStatus(run.status)) {
                const ui = ctx.hasUI ? ctx.ui : sessionUi;
                clearTeamUi(run.runId, ui);
                clearLiveness(run.runId);
            }
            const mailboxMessages = run.mailboxFile ? await readTeamMailbox(ctx.cwd, run.runId) : [];
            const projection = buildTeamStatusProjection(run, mailboxMessages);
            const liveness = recordAndDiffLiveness(run.runId, projection.workers.map((w) => ({ roleId: w.roleId, tokens: w.tokens, requests: w.requests, eventCount: w.eventCount }))); // 项9: diff usage vs prior poll -> "progressing" vs "frozen"
            const health = projection.modelHealth.map((snapshot) => `${snapshot.model}:${snapshot.status}`).join(", ");
            const workers = projection.workers
                .map((worker) => {
                    const model = worker.model ?? "(unassigned)";
                    const thinking = worker.thinkingLevel ? ` thinking:${worker.thinkingLevel}` : "";
                    const elapsed =
                        worker.elapsedSeconds === undefined ? "elapsed:n/a" : `elapsed:${worker.elapsedSeconds}s`;
                    const signal =
                        worker.status !== "running"
                            ? "ended"
                            : worker.signalAgeSeconds === undefined
                              ? "signal:n/a"
                              : `signal:${worker.signalAgeSeconds}s`;
                    const stale = worker.stale ? " stale" : "";
                    const usage = ` req:${worker.requests} tok:${worker.tokens}${worker.costUsd > 0 ? ` cost:$${worker.costUsd.toFixed(4)}` : ""}`;
                    const output = worker.outputKind ? ` output:${worker.outputKind}` : "";
                    const report = worker.lastReportPreview ? ` report:${worker.lastReportPreview}` : "";
                    const captain = worker.lastCaptainMessagePreview
                        ? ` captain:${worker.lastCaptainMessagePreview}`
                        : "";
                    const cancelStatus =
                        worker.cancelRequestedAt === undefined
                            ? ""
                            : worker.cancelObservedAt === undefined
                              ? " cancel:requested"
                              : " cancel:observed";
                    const exitInfo =
                        worker.status === "succeeded" || worker.status === "failed"
                            ? ` exit:${worker.exitCode ?? "?"}${worker.exitSignal ? `/${worker.exitSignal}` : ""}`
                            : "";
                    const toolSummary =
                        worker.tools && worker.tools.length > 0 ? ` tools:[${worker.tools.slice(0, 3).join(",")}${worker.tools.length > 3 ? "..." : ""}]` : "";
                    const activeToolSummary = worker.activeTools ? ` activeTools:[${worker.activeTools.slice(0, 3).join(",")}${worker.activeTools.length > 3 ? "..." : ""}]` : "";
                    const isolation = worker.toolIsolationViolation ? ` isolation:${worker.toolIsolationViolation}` : "";
                    const lane = worker.laneId ? ` lane:${worker.laneId.slice(-6)}` : "";
                    const roleTag = worker.roleId ? ` [${worker.roleId}]` : "";
                    const live = worker.status === "running" ? ` ${formatLivenessTag(worker.stale, liveness.get(worker.roleId))}` : "";
                    return `${worker.status}${stale}${roleTag} ${worker.title} ${model}${thinking} ${elapsed} ${signal} ${worker.activity} events:${worker.eventCount}${usage}${output}${report}${captain}${cancelStatus}${exitInfo}${toolSummary}${activeToolSummary}${isolation}${lane}${live}`;
                })
                .join("\n");
            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `Team run ${run.runId}: ${run.status}`,
                            `playbook: ${run.playbookId}`,
                            `fallback policy: ${run.fallbackPolicy ?? "task_first"}`,
                            `workers: total:${projection.counts.total} active:${projection.counts.active} succeeded:${projection.counts.succeeded} failed:${projection.counts.failed} skipped:${projection.counts.skipped} stale:${projection.counts.stale}`,
                            `signals: timedOut:${projection.counts.timedOut} parseErrors:${projection.counts.parseErrors} toolViolations:${projection.counts.toolViolations}`,
                            `usage: req:${projection.counts.requests} tok:${projection.counts.tokens}${projection.counts.costUsd > 0 ? ` cost:$${projection.counts.costUsd.toFixed(4)}` : " cost:(none recorded)"}`,
                            `mailbox: ${projection.mailbox.file ?? "(none)"} messages:${projection.mailbox.messages}`,
                            `mailbox text: ${run.mailboxTextFile ?? "(none)"}`,
                            projection.mailbox.lastMessagePreview
                                ? `mailbox last: ${projection.mailbox.lastMessagePreview}`
                                : undefined,
                            `cancel: ${projection.cancelFile ?? "(none)"}`,
                            `events: ${(run.events ?? []).length}`,
                            `state write: ${projection.stateWriteError ?? "ok"}`,
                            `controls: ${projection.controls.join(", ") || "(none)"}`,
                            `evidence warnings: ${projection.evidenceWarnings.length > 0 ? projection.evidenceWarnings.join(" | ") : "(none)"}`,
                            run.delegationLanes && run.delegationLanes.length > 0
                                ? `lanes: total:${run.delegationLanes.length} complete:${run.delegationLanes.filter((l) => l.ackState === "complete").length} partial:${run.delegationLanes.filter((l) => l.ackState === "partial").length} expired:${run.delegationLanes.filter((l) => l.ackState === "expired").length} invalid:${run.delegationLanes.filter((l) => l.ackState === "invalid").length}`
                                : undefined,
                            `model health: ${health || "(none recorded)"}`,
                            projection.counts.stale > 0
                                ? `note: stale is not stuck — a worker composing a long answer is silent. Check live:progressing (usage grew since last poll) vs live:stuck (frozen). Only cancel genuinely stuck/frozen/runaway-cost workers.`
                                : undefined,
                            workers || "(no workers)",
                        ]
                            .filter((line): line is string => line !== undefined)
                            .join("\n"),
                    },
                ],
                details: { ...run, mailboxMessages, statusProjection: projection },
            };
        },
        renderResult(result, options, theme) {
            const run = result.details as TeamRun | undefined;
            if (run?.workers) return renderTeamCompact(run, options, theme);
            const text = result.content[0];
            return renderPlainResult(text?.type === "text" ? text.text : "(no output)");
        },
    });

    pi.registerTool({
        name: "team_message",
        label: "Team Message",
        description:
            "Send a captain message to an active team run mailbox. Workers can observe it through their radio protocol and mailbox path.",
        promptSnippet: "Send a captain steering message to workers in an active team run.",
        promptGuidelines: [
            "Use team_message only to add material constraints, corrections, or priorities for workers in an active team run.",
        ],
        parameters: TeamMessageParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) {
                return {
                    content: [{ type: "text", text: "No team run found." }],
                    details: undefined,
                    isError: true,
                };
            }
            const run = await readTeamState(ctx.cwd, runId);
            if (!run) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                    details: { runId },
                    isError: true,
                };
            }
            if (run.status !== "running") {
                return {
                    content: [{ type: "text", text: `Team run ${runId} is ${run.status}; there are no active workers to message.` }],
                    details: { runId, status: run.status },
                    isError: true,
                };
            }
            const paths = await appendTeamMessage(ctx.cwd, runId, params.message);
            return {
                content: [{ type: "text", text: `Captain message written for ${runId}: ${paths.mailboxFile}` }],
                details: { runId, mailboxFile: paths.mailboxFile, message: params.message },
            };
        },
    });

    pi.registerTool({
        name: "team_promote_blueprint",
        label: "Team Promote Blueprint",
        description:
            "Promote a generated team blueprint into the promoted blueprint store. This records the captain's explicit judgment; it does not auto-select or dispatch the blueprint.",
        parameters: TeamPromoteBlueprintParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const resolvedRunId = params.runId ? await resolveRunId(ctx.cwd, params.runId) : undefined;
            const run = resolvedRunId ? await readTeamState(ctx.cwd, resolvedRunId) : undefined;
            const blueprintId = params.blueprintId?.trim() || run?.blueprintId;
            if (!blueprintId) {
                return {
                    content: [{ type: "text", text: "No generated blueprint id found to promote." }],
                    details: { runId: resolvedRunId },
                    isError: true,
                };
            }
            const captainNote = params.captainNote?.trim() ?? "";
            if (!captainNote) {
                return {
                    content: [{ type: "text", text: "captainNote is required to promote a blueprint." }],
                    details: { blueprintId },
                    isError: true,
                };
            }
            try {
                const promoted = await promoteBlueprintArtifact(ctx.cwd, blueprintId, captainNote);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Promoted blueprint ${promoted.artifact.blueprintId}: ${promoted.filePath}`,
                        },
                    ],
                    details: promoted,
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: `Failed to promote blueprint ${blueprintId}: ${String(error)}` }],
                    details: { blueprintId },
                    isError: true,
                };
            }
        },
    });

    pi.registerTool({
        name: "team_cancel_worker",
        label: "Team Cancel Worker",
        description:
            "Cancel a single worker in an active team run without canceling other workers. Semantics and consequences remain the captain's judgment.",
        promptSnippet: "Request cooperative cancellation of one worker in an active team run.",
        promptGuidelines: [
            "Use team_cancel_worker when one active worker is stale, off-track, too expensive, or no longer needed; cancellation is cooperative.",
        ],
        parameters: TeamCancelWorkerParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) {
                return {
                    content: [{ type: "text", text: "No team run found." }],
                    details: undefined,
                    isError: true,
                };
            }
            const roleId = params.roleId.trim();
            if (!roleId) {
                return {
                    content: [{ type: "text", text: "roleId is required to cancel a specific worker." }],
                    details: undefined,
                    isError: true,
                };
            }
            const run = await readTeamState(ctx.cwd, runId);
            if (!run) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                    details: { runId, roleId },
                    isError: true,
                };
            }
            const worker = run.workers.find((item) => item.roleId === roleId);
            if (!worker) {
                return {
                    content: [{ type: "text", text: `Worker ${roleId} was not found in run ${runId}. Use team_status to list active roleIds.` }],
                    details: { runId, roleId },
                    isError: true,
                };
            }
            if (worker.status !== "running") {
                return {
                    content: [{ type: "text", text: `Worker ${roleId} in run ${runId} is already ${worker.status}.` }],
                    details: { runId, roleId, status: worker.status },
                    isError: true,
                };
            }
            const reason = params.reason?.trim() || "captain canceled this worker";
            const guard = guardCancelLastWorker(run.workers, roleId, runId, params.confirm === true); // P1 rigid-loop guard
            if (!guard.ok) return { content: [{ type: "text", text: guard.message }], details: { runId, roleId, runningCount: guard.runningCount, needsConfirm: true }, isError: true };
            const cancelFile = await requestWorkerCancel(ctx.cwd, runId, roleId, reason);
            return {
                content: [{ type: "text", text: `Cancel requested for worker ${roleId} in run ${runId}: ${cancelFile}` }],
                details: { runId, roleId, cancelFile, reason },
            };
        },
    });

    pi.registerTool({
        name: "team_spawn_worker", label: "Team Spawn Worker",
        description: "Spawn a new worker into a running team. The captain decides — the tool never auto-spawns.",
        promptSnippet: "Spawn a new worker role into an active team run.",
        promptGuidelines: [
            "Use team_spawn_worker to add a new role mid-run (e.g. 'we need a specialist for this sub-problem'). Max spawned = 10 (PI_TEAM_MAX_SPAWNED_WORKERS).",
        ],
        parameters: Type.Object({
            runId: Type.Optional(Type.String({ description: "Team run id. Defaults to latest." })),
            roleId: Type.String({ description: "Stable role id" }),
            title: Type.String({ description: "Worker title" }),
            task: Type.String({ description: "Worker task instructions" }),
            modelPreferences: Type.Optional(Type.Array(Type.String({ description: "Model preferences" }))),
            tools: Type.Optional(Type.Array(Type.String({ description: "Tool names" }))),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) return { content: [{ type: "text", text: "No team run found." }], details: undefined, isError: true };
            const run = await readTeamState(ctx.cwd, runId);
            if (!run) return { content: [{ type: "text", text: `Run ${runId} not found.` }], details: { runId }, isError: true };
            if (run.status !== "running") return { content: [{ type: "text", text: `Run ${runId} is ${run.status}.` }], details: { runId }, isError: true };
            const role: PlannedRole = { roleId: params.roleId.trim(), title: params.title.trim(), description: params.title.trim(), capabilityNeeds: [], task: params.task.trim(), tools: params.tools ?? [], systemPrompt: `Spawned: ${params.title}`, modelPreferences: params.modelPreferences ?? [] };
            await appendTeamMessage(ctx.cwd, runId, JSON.stringify({ action: "spawn_worker", role, at: Date.now() }), { system: true });
            return { content: [{ type: "text", text: `Worker ${role.roleId} (${role.title}) spawned into run ${runId}.` }], details: { runId } };
        },
    });

    pi.registerTool({
        name: "team_cancel",
        label: "Team Cancel",
        description: "Request cancellation for an active team run without making semantic task judgments.",
        promptSnippet: "Request cooperative cancellation of an active team run.",
        promptGuidelines: [
            "Use team_cancel when the whole active team run should stop; cancellation is cooperative and final judgment remains with the captain.",
        ],
        parameters: TeamCancelParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) {
                return {
                    content: [{ type: "text", text: "No team run found." }],
                    details: undefined,
                    isError: true,
                };
            }
            const reason = params.reason?.trim() || "captain requested cancellation";
            const paths = await requestTeamCancel(ctx.cwd, runId, reason);
            // Cancel is an explicit captain intent, so respond in the UI right
            // away rather than waiting for the background run's Promise to settle.
            // Without this, a run canceled during probing / the decision window
            // leaves a zombie "probing · 0 workers" widget pinned in the status
            // bar (its clearTeamUi only ran on Promise settlement, which could be
            // delayed or raced by a subsequent run's updateTeamUi).
            // (2026-07-02 cancel-ui-leak.)
            backgroundRunControllers.get(runId)?.abort();
            clearTeamUi(runId, ctx.hasUI ? ctx.ui : sessionUi);
            clearLiveness(runId);
            captainCanceledRuns.add(runId);
            return {
                content: [{ type: "text", text: `Cancel requested for ${runId}: ${paths.cancelFile}` }],
                details: { runId, cancelFile: paths.cancelFile, reason },
            };
        },
    });

    pi.registerTool({
        name: "team_handoff",
        label: "Team Handoff",
        description:
            "Read a factual handoff digest for a finished or active team run so a new captain session can resume. The digest aggregates recorded facts (status, models, output kinds, usage, artifact pointers); the captain forms the semantic verdict.",
        promptSnippet: "Resume a prior team run by reading its factual handoff digest.",
        promptGuidelines: [
            "Use team_handoff to pick up a previous run's context in a new session before deciding whether to re-dispatch or synthesize.",
            "The digest is factual only — read the per-worker artifact files it points at and form your own judgment about evidence sufficiency.",
        ],
        parameters: TeamRunParams,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const runId = await resolveRunId(ctx.cwd, params.runId);
            if (!runId) {
                return {
                    content: [{ type: "text", text: "No team run found." }],
                    details: undefined,
                    isError: true,
                };
            }
            // Prefer the persisted digest; fall back to rebuilding from run state
            // so runs created before this feature (or still active) still resume.
            let digest = await readHandoff(ctx.cwd, runId);
            let source: "persisted" | "rebuilt" = "persisted";
            if (!digest) {
                const run = await readTeamState(ctx.cwd, runId);
                if (!run) {
                    return {
                        content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                        details: undefined,
                        isError: true,
                    };
                }
                digest = buildHandoffDigest(run);
                source = "rebuilt";
            }
            return {
                content: [{ type: "text", text: digest }],
                details: { runId, source },
            };
        },
    });
}
