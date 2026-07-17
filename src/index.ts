import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { promoteBlueprintArtifact } from "./blueprint-store.ts";
import { loadModelCapabilityProfiles } from "./capabilities.ts";
import { appendTeamMessage, listTeamRunIds, markTeamObserved, prepareTeamControl, readTeamMailbox, readTeamObservation, readTeamState, requestTeamCancel, requestWorkerCancel, writeTeamState } from "./control.ts";
import { buildHandoffDigest, readHandoff } from "./handoff.ts";
import { loadTeamResources } from "./loader.ts";
import { loadManual } from "./manual-loader.ts";
import { probePlan } from "./plan-probe.ts";
import { routeTeamPlan, toTeamModels } from "./model-router.ts";
import { parseModelPreference } from "./model-selector.ts";
import { createTeamPlan } from "./planner.ts";
import { createCliProbe, createInProcessProbe } from "./prober.ts";
import { runTeamPlan, type TeamRunOptions } from "./runner.ts";
import { createSemanticPlan } from "./semantic-planner.ts";
import type { TeamEvent, TeamInput, TeamModel, TeamRun, WorkerRun, PlannedRole } from "./types.ts";
import { clearLiveness, formatLivenessTag, recordAndDiffLiveness } from "./worker-liveness.ts";
import { guardCancelLastWorker, resolveWorkerByKey } from "./cancel-guard.ts";
import { TeamParams, TeamRunParams, TeamMessageParams, TeamCancelParams, TeamPromoteBlueprintParams, TeamCancelWorkerParams } from "./tool-params.ts";
import { buildTeamStatusProjection } from "./status-projection.ts";
export { buildTeamStatusProjection } from "./status-projection.ts";
import {
    captainAttentionPush, startCaptainAttentionMonitor, type CaptainAttentionMonitorHandle,
} from "./captain-attention.ts";
import { isTerminalStatus, teamCountSummary, teamWidget, teamWidgetLines, truncatedLines, renderTeamCompact, renderPlainResult } from "./status-render.ts";
export { teamWidgetLines } from "./status-render.ts";

const baseDir = dirname(fileURLToPath(import.meta.url));
const defaultsDir = join(baseDir, "defaults");
// Decision-window timeout (PI_TEAM_DECISION_WINDOW_MS, default 15s).
const DEFAULT_DECISION_WINDOW_MS = 15_000;
export function decisionWindowMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt(env.PI_TEAM_DECISION_WINDOW_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DECISION_WINDOW_MS;
}

export function backgroundNextAction(hasPendingModelDecision: boolean): "captain_model_decision" | "await_completion_push" {
    return hasPendingModelDecision ? "captain_model_decision" : "await_completion_push";
}

function compactRoutingReason(reason: string | undefined): string | undefined {
    if (!reason) return undefined;
    const policy = reason.match(/policy=([^;]+)/)?.[1]?.trim();
    const via = reason.match(/selected via ([^;|]+)/)?.[1]?.trim();
    const degraded = reason.includes("⚠️") ? "; degraded-pref" : "";
    const compact = [policy ? `policy=${policy}` : undefined, via ? `via=${via}` : undefined].filter(Boolean).join("; ");
    return compact ? `${compact}${degraded}` : reason;
}

const TEAM_WIDGET_KEY = "pi-team-workers";
const TEAM_STATUS_KEY = "pi-team-status";

const backgroundRunControllers = new Map<string, AbortController>();
// Runs the captain explicitly canceled. Their background Promise still settles
// Canceled runs: captain asked to cancel, suppress completion push.
// Observed runs: captain polled via team_status, no push unless failed.
const captainCanceledRuns = new Set<string>();
const observedRuns = new Set<string>();
const terminalObservedRuns = new Set<string>();
// (2026-07-05 B4) Timestamp each background run so we can reap module-level
// state if its Promise never settles (model API deadlock, hung session,
// orphaned process). Normal cleanup still happens in .then()/.catch(); this is
// a bounded-memory backstop only. Entries older than the reap horizon (well past
// the 1h runaway ceiling) are dropped when the next run starts.
const backgroundRunStartedAt = new Map<string, number>();
const backgroundAttentionMonitors = new Map<string, CaptainAttentionMonitorHandle>();
function stopBackgroundAttentionMonitor(runId: string): void {
    backgroundAttentionMonitors.get(runId)?.stop();
    backgroundAttentionMonitors.delete(runId);
}
const STALE_RUN_REAP_MS = 2 * 60 * 60 * 1000;
const TERMINAL_PUSH_GRACE_MS = 750;
const WATCHED_RUN_PUSH_GRACE_MS = 10_000;
const RECENT_OBSERVATION_MS = 30_000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function reapStaleRunState(now: number): void {
    for (const [runId, startedAt] of backgroundRunStartedAt) {
        if (now - startedAt < STALE_RUN_REAP_MS) continue;
        backgroundRunControllers.delete(runId);
        captainCanceledRuns.delete(runId);
        observedRuns.delete(runId);
        terminalObservedRuns.delete(runId);
        clearLiveness(runId);
        stopBackgroundAttentionMonitor(runId);
        backgroundRunStartedAt.delete(runId);
    }
}

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
import { completionPush, completionPushDelayMs, detectModelConvergence, shouldPushCompletion } from "./notify-gating.ts";
export { completionPush, completionPushDelayMs, detectModelConvergence, shouldPushCompletion } from "./notify-gating.ts";

// (2026-07-05 B6) Collision-resistant run id: Date.now alone is not unique for
// two team() calls in the same millisecond. A collision would let one run's
// background Promise delete the other's AbortController (un-abortable) or
// inherit its canceled flag. Use a process-local monotonic counter plus random
// suffix so same-millisecond bursts stay unique. Exported for tests.
let runIdCounter = 0;
export function generateRunId(): string {
    runIdCounter = (runIdCounter + 1) % 0x1000000;
    return `team_${Date.now().toString(36)}${runIdCounter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 8)}`;
}

export function shouldDirectModelDispatch(input: TeamInput, hasSemanticPlan: boolean): boolean {
    return !hasSemanticPlan && (input.roles?.length ?? 0) > 0 &&
        (input.roles ?? []).every((role) => (role.modelPreferences?.length ?? 0) > 0);
}

function makeRun(task: string, playbookId: string, fallbackPolicy?: TeamInput["fallbackPolicy"]): TeamRun {
    return {
        runId: generateRunId(),
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

function safeRunId(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

async function resolveRunId(cwd: string, requestedRunId: string | undefined): Promise<string | undefined> {
    if (requestedRunId?.trim()) {
        const runId = requestedRunId.trim();
        return safeRunId(runId) ? runId : undefined;
    }
    const runIds = await listTeamRunIds(cwd);
    return runIds.filter((runId) => safeRunId(runId)).at(-1);
}

export function refreshTeamModelRegistry(ctx: Pick<ExtensionContext, "modelRegistry">): void {
    // Pi exposes authStorage; Oh My Pi may only expose the public registry API.
    // Refresh auth opportunistically without requiring a runtime-internal field.
    const registry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
        authStorage?: { reload?: () => void };
    };
    registry.authStorage?.reload?.();
    registry.refresh();
}


type TeamToolUpdate = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[3];

let sessionUi: ExtensionUIContext | undefined;
let sessionMode: ExtensionContext["mode"] | undefined;
const activeTeamRunIds = new Set<string>();


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
    const startBackgroundAttentionMonitor = (cwd: string, runId: string): void => {
        stopBackgroundAttentionMonitor(runId);
        backgroundAttentionMonitors.set(runId, startCaptainAttentionMonitor({
            readRun: () => readTeamState(cwd, runId),
            isTerminal: (run) => isTerminalStatus(run.status),
            isCanceled: () => captainCanceledRuns.has(runId),
            onAttention: (alerts) => {
                pi.sendUserMessage(captainAttentionPush(runId, alerts), { deliverAs: "followUp" });
            },
        }));
    };

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

    // ── 手动挡：一键切模型 ──
    // Ctrl+1~4 直连常用模型，替代 Ctrl+P 翻页
    const QUICK_MODELS: { key: KeyId; provider: string; modelId: string; label: string }[] = [
        { key: "alt+1", provider: "ai-genesis-claude", modelId: "claude-opus-4-8", label: "Claude Opus 4.8" },
        { key: "alt+2", provider: "openai-codex", modelId: "gpt-5.5", label: "GPT 5.5" },
        { key: "alt+3", provider: "deepseek", modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
        { key: "alt+4", provider: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek Flash" },
    ];
    for (const qm of QUICK_MODELS) {
        pi.registerShortcut(qm.key, {
            description: `Switch model to ${qm.label}`,
            handler: async (ctx) => {
                const model = ctx.modelRegistry?.find(qm.provider, qm.modelId);
                if (!model) {
                    ctx.ui.notify(`${qm.label}: model not found`, "warning");
                    return;
                }
                const ok = await pi.setModel(model);
                ctx.ui.notify(ok ? `→ ${qm.label}` : `${qm.label}: no API key`, ok ? "info" : "warning");
            },
        });
    }

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
            "Run a lightweight multi-agent team. BEFORE calling, read captain manual.\n\nCAPTAIN RULES: (1) Workers default to bash+read+write — use ls/find/grep to discover files, never guess paths. (2) Use thinking:\"high\" for review/code/analysis; stale ≠ stuck, 60-120s deep-thinking silence is NORMAL. (3) Background runs are push-first — do not poll a normally progressing run. (4) Cancel only after sustained frozen evidence. (5) You own synthesis — workers provide evidence, not the verdict.\n\nLoads Markdown playbooks/roles or lead-designed roles, dispatches Pi subprocess workers, returns findings for lead synthesis.",
        promptSnippet: "Dispatch a small AI team and return captain-ready findings.",
        promptGuidelines: [
            "Use team when the task benefits from independent research, review, implementation checks, or multiple model perspectives.",
            "Background runs are push-first: after the initial dispatch result, end the turn and wait for a completion or captain-attention follow-up. Do not poll a normally progressing run.",
            "Use team_message only to add material constraints, corrections, or priorities for workers in an active team run.",
            "Use team_status once after a completion/attention push, an explicit user request, or immediately before a control decision; attention notifications never auto-cancel workers.",
            "BEFORE dispatching: verify workers have bash/read/write. Set thinking:\"high\" for review/code/analysis. stale ≠ stuck (60-120s silence normal).",
            "Cancel only after a runtime attention signal plus corroborating frozen/off-track/runaway evidence. Do NOT outsource synthesis to workers — captain owns the final verdict.",
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
            const directDispatch = shouldDirectModelDispatch(input, semanticPlan !== undefined);
            const probe = input.probeModels === false
                ? ((model: TeamModel) => Promise.resolve({ model: `${model.provider}/${model.id}`, provider: model.provider, status: "probe_skipped" as const, latencyMs: 0, reason: "probeModels=false", checkedAt: Date.now() }))
                : process.env.PI_TEAM_PROBE_USE_CLI === "1" ? createCliProbe() : createInProcessProbe(ctx.modelRegistry, ctx.cwd);

            let result = await probePlan(plan, configuredModels, availableModels, defaultsDir, fallbackPolicy, directDispatch, probe, signal, input.probeModels !== false);
            let deadBlueprint = result.deadBlueprintModels;
            let currentPlan = plan;

            // Revision pass (方案B): if the semantic-planner suggested models that
            // came back dead, give it a second chance with hard unavailableModel constraints.
            // One pass only — no iterative ping-pong. (2026-07-03 项6.)
            if (semanticPlan && deadBlueprint.length > 0) {
                const revised = await createSemanticPlan(ctx.cwd, input, inheritedTools, capabilityProfiles, signal, deadBlueprint);
                if (revised) {
                    currentPlan = createTeamPlan({ ...input, roles: revised.roles }, resources, revised);
                    result = await probePlan(currentPlan, configuredModels, availableModels, defaultsDir, fallbackPolicy, directDispatch, probe, signal, input.probeModels !== false);
                }
            }
            const { probeSet, modelHealth: health, resolved } = result;

            run = { ...run, status: "probing" };
            run = logUpdate(teamUpdate, run, {
                phase: "model-observe-start",
                message: `selected ${probeSet.models.length}/${availableModels.length} relevant model(s) to probe across ${currentPlan.rounds.flatMap((r) => r.roles).length} role(s); fallbackPolicy=${fallbackPolicy}` +
                    (directDispatch ? "; direct-dispatch (captain fully specified — probing only chosen models as liveness check)" : "") +
                    (semanticPlan && deadBlueprint.length > 0 ? `; blueprint revision: ${deadBlueprint.length} unavailable model(s) → replanned` : "") +
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
            const intendedDistinctModelCount = new Set(
                currentPlan.rounds.flatMap((round) => round.roles)
                    .map((role) => role.modelPreferences[0])
                    .filter((preference): preference is string => Boolean(preference))
                    .map((preference) => parseModelPreference(preference).model),
            ).size;
            const convergenceNotice = detectModelConvergence(assignedModels, healthyModelCount, intendedDistinctModelCount);

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
                        ? `unavailable/recent-worker-failed: ${prefList.join(", ")}`
                        : `unavailable: ${prefList.join(", ")}`;
                    const affectedRoles = resolved.rolePlans
                        .map((rolePlan) => ({
                            roleId: rolePlan.roleId,
                            preferences: [...new Set([...rolePlan.failedUserPreferences, ...rolePlan.degradedUserPreferences])],
                        }))
                        .filter((role) => role.preferences.length > 0);
                    pendingModelDecision = {
                        failedPrefs: prefList,
                        affectedRoles,
                        configuredKeys,
                        windowMs,
                        policy: fallbackPolicy,
                    };
                    const overrideHint = affectedRoles.length === 1
                        ? `<model key> or ${affectedRoles[0].roleId}=<model key>`
                        : affectedRoles.map((role) => `${role.roleId}=<model key>`).join(" ");
                    decisionNotice =
                        `[!] Model decision window (~${Math.round(windowMs / 1000)}s): your model preference(s) ${cause}. ` +
                        `Reply with team_message(runId="${run.runId}", "${overrideHint}") to override by role. ${afterTimeout}`;
                    if (prepared.mailboxTextFile) {
                        await appendTeamMessage(ctx.cwd, run.runId,
                            `[pi-team decision window] User-specified model(s) ${cause}. ` +
                            `Available: ${configuredKeys.join(", ")}. ` +
                            `Reply with roleId=modelKey to override individual roles. ${afterTimeout} Waiting ~${Math.round(windowMs / 1000)}s.`,
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
                backgroundRunStartedAt.set(run.runId, Date.now());
                startBackgroundAttentionMonitor(ctx.cwd, run.runId);
                reapStaleRunState(Date.now());
                const detachedRun = { ...prepared, workers: [] as WorkerRun[] };
                const backgroundUpdate = teamUpdateSink(undefined);
                runTeamPlan(ctx.cwd, routedPlan, detachedRun, {
                    inheritedTools, modelRegistry: ctx.modelRegistry, pendingModelDecision, defaultsDir,
                    modelDiversity: { healthyModelCount, intendedDistinctModelCount },
                }, runController.signal, backgroundUpdate)
                    .then(async (finalRun) => {
                        backgroundRunControllers.delete(run.runId);
                        backgroundRunStartedAt.delete(run.runId);
                        stopBackgroundAttentionMonitor(run.runId);
                        const wasCanceled = captainCanceledRuns.has(run.runId);
                        if (wasCanceled) captainCanceledRuns.delete(run.runId);
                        clearTeamUi(finalRun.runId);
                        clearLiveness(finalRun.runId);
                        const priorState = await readTeamState(ctx.cwd, finalRun.runId);
                        const finalRunWithObservations = {
                            ...finalRun,
                            lastObservedAt: finalRun.lastObservedAt ?? priorState?.lastObservedAt,
                            terminalObservedAt: finalRun.terminalObservedAt ?? priorState?.terminalObservedAt,
                        };
                        await writeTeamState(ctx.cwd, finalRunWithObservations);
                        // If the captain is actively watching via team_status,
                        // delay the follow-up longer than the tiny race grace so
                        // a terminal poll can persist terminalObservedAt before a
                        // queued follow-up is injected into the conversation.
                        // Observation also lives in a small sidecar file because
                        // background completion and team_status may run in
                        // different extension/module instances; an in-memory Set
                        // alone cannot cover that timing.
                        const observation = await readTeamObservation(ctx.cwd, finalRun.runId);
                        const wasObserved = observedRuns.has(finalRun.runId) || observation !== undefined;
                        await delay(
                            completionPushDelayMs({
                                wasObserved,
                                lastObservedAt: finalRunWithObservations.lastObservedAt ?? observation?.lastObservedAt,
                                now: Date.now(),
                                shortGraceMs: TERMINAL_PUSH_GRACE_MS,
                                watchedGraceMs: WATCHED_RUN_PUSH_GRACE_MS,
                                recentObservationMs: RECENT_OBSERVATION_MS,
                            }),
                        );
                        const latestObservation = await readTeamObservation(ctx.cwd, finalRun.runId);
                        const latestState = await readTeamState(ctx.cwd, finalRun.runId);
                        const wasTerminalObserved =
                            terminalObservedRuns.has(finalRun.runId) || latestObservation?.terminalObservedAt !== undefined || latestState?.terminalObservedAt !== undefined;
                        observedRuns.delete(finalRun.runId);
                        terminalObservedRuns.delete(finalRun.runId);
                        if (!shouldPushCompletion(wasCanceled, finalRun.status, wasTerminalObserved)) return;
                        const summary = finalRun.finalSummary
                            ? finalRun.finalSummary.split(/\r?\n/).slice(0, 3).join("\n")
                            : `${finalRun.workers.length} worker(s) completed.`;
                        pi.sendUserMessage(completionPush(finalRun.runId, finalRun.status, summary), { deliverAs: "followUp" });
                    })
                    .catch(async (error) => {
                        backgroundRunControllers.delete(run.runId);
                        backgroundRunStartedAt.delete(run.runId);
                        stopBackgroundAttentionMonitor(run.runId);
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
                        observedRuns.delete(errorRun.runId);
                        terminalObservedRuns.delete(errorRun.runId);
                        if (!shouldPushCompletion(wasCanceled, "failed")) return;
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
                                ...(!pendingModelDecision && convergenceNotice ? [convergenceNotice, ""] : []),
                                `Inspect after a completion/attention push: team_status(runId="${run.runId}")`,
                                `Control: team_message / team_cancel_worker(runId="${run.runId}")`,
                                `Cancel: team_cancel(runId="${run.runId}")`,
                                "",
                                "IMPORTANT: You are still the captain. The team is running in background now.",
                                pendingModelDecision
                                    ? "Next action: send a valid role-specific model decision or allow the bounded decision window to expire."
                                    : "Next action: await_completion_push. End this turn; do not poll just to measure time.",
                                "The runtime will send a captain-attention follow-up after sustained recorded silence; it never auto-cancels workers.",
                            ].join("\n"),
                        },
                    ],
                    details: {
                        runId: run.runId, activeDir: prepared.activeDir, status: "running",
                        nextAction: backgroundNextAction(pendingModelDecision !== undefined),
                    },
                };
            }

            run = await runTeamPlan(ctx.cwd, routedPlan, run, {
                inheritedTools, modelRegistry: ctx.modelRegistry, defaultsDir,
                modelDiversity: { healthyModelCount, intendedDistinctModelCount },
            }, signal, teamUpdate);
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
            "Use team_status once after a completion/attention push, an explicit user request, or immediately before a control decision; do not use it as a timer.",
            "Use team_status to inspect worker failures, sustained-silence evidence, mailbox messages, and model health before deciding next action.",
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
            let run = await readTeamState(ctx.cwd, runId);
            if (!run) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                    details: undefined,
                    isError: true,
                };
            }
            // Mark run as observed so background completion can distinguish
            // mid-run polling from already-seen terminal state.
            observedRuns.add(runId);
            const observedAt = Date.now();
            const terminal = isTerminalStatus(run.status);
            await markTeamObserved(ctx.cwd, runId, { terminal, now: observedAt });
            // Avoid rewriting a running state snapshot just to record observation:
            // worker subprocesses may be writing fresh events concurrently. The
            // sidecar observation file is enough while the run is active.
            // Once terminal, no workers are writing, so persisting observation on
            // the run state itself is safe for handoff/status visibility.
            if (terminal) {
                terminalObservedRuns.add(runId);
                const shouldPersistObservation = run.terminalObservedAt === undefined || run.lastObservedAt === undefined;
                if (shouldPersistObservation) {
                    run = { ...run, lastObservedAt: observedAt, terminalObservedAt: run.terminalObservedAt ?? observedAt };
                    await writeTeamState(ctx.cwd, run);
                }
                const ui = ctx.hasUI ? ctx.ui : sessionUi;
                clearTeamUi(run.runId, ui);
                clearLiveness(run.runId);
            }
            const mailboxMessages = run.mailboxFile ? await readTeamMailbox(ctx.cwd, run.runId) : [];
            const projection = buildTeamStatusProjection(run, mailboxMessages);
            const liveness = recordAndDiffLiveness(run.runId, projection.workers.map((w) => ({ roleId: w.roleId, tokens: w.tokens, requests: w.requests, eventCount: w.eventCount }))); // 项9: diff usage vs prior poll -> "progressing" vs "frozen"
            const health = projection.modelHealth
                .map((snapshot) => `${snapshot.model}:${snapshot.status}/${snapshot.evidenceSource ?? "unknown"}`).join(", ");
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
                    const toolCounts = ` toolCalls:${worker.toolCallCount}${worker.toolErrorCount > 0 ? ` toolErrors:${worker.toolErrorCount}` : ""}`;
                    const output = worker.outputKind ? ` output:${worker.outputKind}` : "";
                    const route = worker.routingReason ? ` route:${compactRoutingReason(worker.routingReason)}` : "";
                    const fallback = worker.modelFallbackKeys && worker.modelFallbackKeys.length > 0 ? ` fallback:[${worker.modelFallbackKeys.slice(0, 3).join(",")}]` : "";
                    const summary = worker.status !== "running" && worker.factualPreview ? ` summary:${worker.factualPreview}` : "";
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
                        worker.status === "succeeded" || worker.status === "failed" || worker.status === "degraded"
                            ? ` exit:${worker.exitCode ?? "?"}${worker.exitSignal ? `/${worker.exitSignal}` : ""}`
                            : "";
                    const toolSummary =
                        worker.tools && worker.tools.length > 0 ? ` tools:[${worker.tools.slice(0, 3).join(",")}${worker.tools.length > 3 ? "..." : ""}]` : "";
                    const activeToolSummary = worker.activeTools ? ` activeTools:[${worker.activeTools.slice(0, 3).join(",")}${worker.activeTools.length > 3 ? "..." : ""}]` : "";
                    const isolation = worker.toolIsolationViolation ? ` isolation:${worker.toolIsolationViolation}` : "";
                    const lane = worker.laneId ? ` lane:${worker.laneId.slice(0, 12)}…${worker.laneId.slice(-4)}` : "";
                    const roleTag = worker.roleId ? ` [${worker.roleId}]` : "";
                    const live = worker.status === "running" ? ` ${formatLivenessTag(worker.stale, liveness.get(worker.roleId))}` : "";
                    return `${worker.status}${stale}${roleTag} ${worker.title} ${model}${thinking} ${elapsed} ${signal} ${worker.activity} events:${worker.eventCount}${toolCounts}${usage}${output}${route}${fallback}${summary}${report}${captain}${cancelStatus}${exitInfo}${toolSummary}${activeToolSummary}${isolation}${lane}${live}`;
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
                            `workers: total:${projection.counts.total} active:${projection.counts.active} succeeded:${projection.counts.succeeded} failed:${projection.counts.failed} degraded:${projection.counts.degraded} skipped:${projection.counts.skipped} stale:${projection.counts.stale}`,
                            `signals: timedOut:${projection.counts.timedOut} parseErrors:${projection.counts.parseErrors} toolViolations:${projection.counts.toolViolations} toolCalls:${projection.counts.toolCalls} toolErrors:${projection.counts.toolErrors}`,
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
                                ? `lanes: total:${run.delegationLanes.length} active:${run.delegationLanes.filter((l) => l.status === "active").length} succeeded:${run.delegationLanes.filter((l) => l.status === "succeeded").length} failed:${run.delegationLanes.filter((l) => l.status === "failed").length} skipped:${run.delegationLanes.filter((l) => l.status === "skipped").length} cancelled:${run.delegationLanes.filter((l) => l.status === "cancelled").length} ackComplete:${run.delegationLanes.filter((l) => l.ackState === "complete").length}`
                                : undefined,
                            `model health: ${health || "(none recorded)"}`,
                            projection.counts.stale > 0
                                ? `note: stale is not stuck — long composition can be silent. The runtime sends one attention follow-up only after sustained no-growth checks; do not repeatedly poll to measure time. Only cancel with corroborating frozen/runaway evidence.`
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
                    content: [
                        {
                            type: "text",
                            text:
                                `Team run ${runId} is already ${run.status}; there are no active workers to message. ` +
                                `This can happen in a timing race if workers finished between your last team_status poll and this control message. ` +
                                `Check team_status before steering when the status may have changed.`,
                        },
                    ],
                    details: { runId, status: run.status, activeWorkers: 0 },
                    isError: true,
                };
            }
            const paths = await appendTeamMessage(ctx.cwd, runId, params.message);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Captain message written for ${runId}: ${paths.mailboxFile}. ` +
                            `This is cooperative steering, not an interrupt: a worker only sees it at its next decision point (after its current tool call finishes), so obedience is not immediate and is not guaranteed. ` +
                            `For a hard stop of a specific worker, use team_cancel_worker.`,
                    },
                ],
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
            const resolution = resolveWorkerByKey(run.workers, roleId);
            if (resolution.kind === "ambiguous") {
                const candidates = resolution.candidates.map((candidate) => `${candidate.roleId} (${candidate.title})`).join(", ");
                return {
                    content: [{ type: "text", text: `Worker key ${roleId} is ambiguous in run ${runId}. Use an exact roleId: ${candidates}` }],
                    details: { runId, roleId, candidates: resolution.candidates },
                    isError: true,
                };
            }
            if (resolution.kind === "not_found") {
                return {
                    content: [{ type: "text", text: `Worker ${roleId} was not found in run ${runId}. Use team_status to list active roleIds.` }],
                    details: { runId, roleId },
                    isError: true,
                };
            }
            const worker = resolution.worker;
            // Continue with the worker's ACTUAL roleId, not the captain's input
            // spelling — the cancel file, guard message, and result must key off
            // the real id so the worker-side cancel check finds it.
            const resolvedRoleId = worker.roleId;
            if (worker.status !== "running") {
                return {
                    content: [{ type: "text", text: `Worker ${resolvedRoleId} in run ${runId} is already ${worker.status}.` }],
                    details: { runId, roleId: resolvedRoleId, status: worker.status },
                    isError: true,
                };
            }
            const reason = params.reason?.trim() || "captain canceled this worker";
            const guard = guardCancelLastWorker(run.workers, resolvedRoleId, runId, params.confirm === true); // P1 rigid-loop guard
            if (!guard.ok) return { content: [{ type: "text", text: guard.message }], details: { runId, roleId: resolvedRoleId, runningCount: guard.runningCount, needsConfirm: true }, isError: true };
            const cancelFile = await requestWorkerCancel(ctx.cwd, runId, resolvedRoleId, reason);
            const matchNote = resolvedRoleId !== roleId ? ` (matched your input "${roleId}" to roleId "${resolvedRoleId}")` : "";
            // Factual signal (not a gate, not a second confirm): if no worker has
            // completed AND no other worker is still running, this cancel leaves
            // the run with zero completed teammate output. State it so the
            // captain cannot deliver a solo answer while unaware it is a
            // fallback, not a team result. The judgment stays the captain's.
            const anyCompleted = run.workers.some((w) => w.status === "succeeded" || w.status === "degraded");
            const otherRunning = run.workers.some((w) => w.roleId !== resolvedRoleId && w.status === "running");
            const fallbackNote = !anyCompleted && !otherRunning
                ? ` This cancel will leave the run with no completed teammate output. If you deliver now, it is a captain fallback, not a team result — say so to the user.`
                : "";
            return {
                content: [{ type: "text", text: `Cancel requested for worker ${resolvedRoleId} in run ${runId}${matchNote}: ${cancelFile}. Cooperative stop: the worker ends after its current tool call finishes.${fallbackNote}` }],
                details: { runId, roleId: resolvedRoleId, cancelFile, reason },
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
            const roleId = params.roleId.trim();
            const title = params.title.trim();
            const task = params.task.trim();
            if (!roleId || !title || !task) {
                return {
                    content: [{ type: "text", text: "roleId, title, and task must be non-empty to request a worker spawn." }],
                    details: { runId, roleId },
                    isError: true,
                };
            }
            const role: PlannedRole = { roleId, title, description: title, capabilityNeeds: [], task, tools: params.tools ?? [], systemPrompt: `Spawned: ${title}`, modelPreferences: params.modelPreferences ?? [] };
            await appendTeamMessage(ctx.cwd, runId, JSON.stringify({ action: "spawn_worker", role, at: Date.now() }), { system: true });
            return { content: [{ type: "text", text: `Worker ${role.roleId} (${role.title}) spawn requested into run ${runId}. Use team_status to confirm spawn-accepted or spawn-rejected.` }], details: { runId } };
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
            const run = await readTeamState(ctx.cwd, runId);
            if (!run) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} was not found.` }],
                    details: { runId },
                    isError: true,
                };
            }
            const terminalStatuses = new Set(["succeeded", "failed", "degraded", "stopped"]);
            if (terminalStatuses.has(run.status)) {
                return {
                    content: [{ type: "text", text: `Team run ${runId} is already ${run.status}. No cancel needed — the run has already finished.` }],
                    details: { runId, status: run.status },
                };
            }
            // Note: "canceled" is not a TeamRunStatus — captain-canceled runs are "stopped",
            // already covered by terminalStatuses above. No separate canceled check needed.
            const reason = params.reason?.trim() || "captain requested cancellation";
            captainCanceledRuns.add(runId);
            stopBackgroundAttentionMonitor(runId);
            let paths: Awaited<ReturnType<typeof requestTeamCancel>>;
            try {
                paths = await requestTeamCancel(ctx.cwd, runId, reason);
            } catch (error) {
                captainCanceledRuns.delete(runId);
                if (backgroundRunControllers.has(runId)) startBackgroundAttentionMonitor(ctx.cwd, runId);
                throw error;
            }
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
