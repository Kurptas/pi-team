import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { persistBlueprintArtifact } from "./blueprint-store.ts";
import { acknowledgeCaptainRequests, captainRequestSnapshot, captainRequestSteerText, deliverCaptainRequests } from "./captain-request-delivery.ts";
import { validateTeamPlanGraph } from "./plan-graph.ts";
import { initialQueue, newlySchedulableRounds, undispatchedRounds } from "./plan-schedule.ts";
import { validateSpawnRole } from "./spawn-validate.ts";
import { runModelDecisionWindow, type PendingModelDecision } from "./model-decision-window.ts";
import { buildHandoffDigest, writeHandoff } from "./handoff.ts";
import { dispatchRound, type RoundDispatchContext } from "./round-dispatcher.ts";
import { applyToolTierCeiling, formatToolTierDecision, resolveMaxToolTier } from "./tool-approval.ts";
import { loadWatchdogAdvisory } from "./watchdog.ts";
import { buildWorkerInjection } from "./manual-loader.ts";
import { resolveWorkerSessionManager, workerSessionId } from "./worker-session.ts";
export { resolveWorkerSessionManager, workerSessionId } from "./worker-session.ts";
import { findToolIsolationViolations, toolIsolationViolationMessage } from "./tool-isolation.ts";
import { workerSessionToolOptions } from "./runtime-compat.ts";
import { resolveThinkingCompatibility } from "./thinking-compat.ts";
import { recordRunWorkerHealth } from "./model-health-cache.ts";
import { writeWorkerArtifacts } from "./worker-artifacts.ts";
import { detectModelConvergence } from "./notify-gating.ts";
import { evaluateWorkerStructuredOutput } from "./structured-output.ts";
import {
    RADIO_REPORT_PREFIX,
    assistantText,
    buildFinalSummary,
    buildRunAbsorption,
    determineTeamRunOutcome,
    finalAssistantText,
    isRadioReport,
    workerExitStatus,
    workerFailureReason,
    workerOutputKind,
} from "./run-outcome.ts";
export {
    buildCaptainPreDelivery,
    buildFinalSummary,
    buildRunAbsorption,
    determineTeamRunOutcome,
    finalAssistantText,
    isRadioReport,
    roleWithPriorFindings,
    workerExitStatus,
    workerOutputKind,
    type PreDeliveryContext,
    type TeamRunOutcome,
} from "./run-outcome.ts";
import { budgetNotice, classifyBudgetState, requestBudget, salvageOutput, selectRetryModel, shouldRetryWorker, usageCostUsd, usageTokens } from "./worker-runtime.ts";
import {
    isTeamCancelRequested,
    isWorkerCancelRequested,
    finishDelegationLane,
    initDelegationLane,
    prepareTeamControl,
    readTeamMailbox,
    teamControlPaths,
    teamMailboxMessageAddressesRole,
    teamRunLogDir,
    writeTeamState,
} from "./control.ts";
import type {
    PlannedRole,
    PlannedRound,
    TeamEvent,
    TeamPlan,
    TeamRun,
    WorkerRun,
    WorkerStatus,
} from "./types.ts";
const MAX_CONCURRENCY = 4;
const WORKER_HEARTBEAT_MS = 5_000;
/** Override with PI_TEAM_STALE_THRESHOLD_MS (default 20s). Raise for slow-reasoning models. */
export function staleThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number.parseInt(env.PI_TEAM_STALE_THRESHOLD_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}
const WORKER_STALE_MS = staleThresholdMs();
const OUTPUT_PREVIEW_CHARS = 240;
// Maximum captain-spawned workers per run (A-1). Safeguard against unbounded
// growth. Override with PI_TEAM_MAX_SPAWNED_WORKERS.
function maxSpawnedWorkers(): number {
    const configured = Number.parseInt(process.env.PI_TEAM_MAX_SPAWNED_WORKERS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 10;
}
const CAPTAIN_MESSAGE_POLL_MS = 5_000;
// North-star: the tool is a channel, not a decision-maker. A worker exceeding
// this SOFT threshold is NOT stopped — the captain is notified and owns the
// call to team_cancel_worker or let it run. Multi-round / complex tasks often
// legitimately exceed it. (2026-07-03 no-tool-hard-interrupt.)
const DEFAULT_WORKER_SOFT_TIMEOUT_MS = 10 * 60_000;
// The ONE exception where the tool stops a worker on its own: a very high
// absolute ceiling that exists solely to prevent unbounded runaway cost when
// no captain is watching a background run. Normal tasks never reach it, and
// when it fires it reports loudly that the tool acted.
const ABSOLUTE_SAFETY_CEILING_MS = 60 * 60_000;
const NESTED_DELEGATION_TOOLS = new Set([
    "team",
    "team_status",
    "team_message",
    "team_cancel",
    "team_cancel_worker",
    "team_promote_blueprint",
    "subagent",
    "workflow",
    "Agent",
    "get_subagent_result",
    "steer_subagent",
]);
type TeamUpdate = (partial: AgentToolResult<TeamRun>) => void;
type WorkerUpdate = (worker: WorkerRun, event: TeamEvent) => void;
export interface TeamRunOptions {
    inheritedTools: string[];
    modelRegistry?: { find(provider: string, modelId: string): Model<import("@earendil-works/pi-ai").Api> | undefined };
    pendingModelDecision?: PendingModelDecision;
    modelDiversity?: { healthyModelCount: number; intendedDistinctModelCount: number };
    /** Extension defaults dir; used only to fall back to the bundled WATCHDOG template when no user/project file exists. */
    defaultsDir?: string;
}
export interface WorkerPromptContext {
    runId: string;
    role: PlannedRole;
    tools: string[];
    mailboxFile: string;
    mailboxTextFile: string;
    laneId?: string;
    delegationToken?: string;
    laneMailboxTextFile?: string;
    watchdogAdvisory?: string;
}
export interface QueuedStateWriter {
    queue(snapshot: TeamRun): void;
    flush(): Promise<string | undefined>;
    currentError(): string | undefined;
}
function textPreview(text: string): string {
    return text.replace(/\s+/g, " ").trim().slice(0, OUTPUT_PREVIEW_CHARS);
}
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function eventWithTimestamp(event: TeamEvent): TeamEvent {
    return { at: Date.now(), ...event };
}
function appendWorkerEvent(worker: WorkerRun, event: TeamEvent): void {
    worker.events = [...(worker.events ?? []), eventWithTimestamp(event)];
}
function updateRunWithEvent(run: TeamRun, event: TeamEvent): TeamRun {
    const stamped = eventWithTimestamp(event);
    return {
        ...run,
        lastEvent: stamped,
        events: [...(run.events ?? []), stamped],
    };
}
export function resolveWorkerTools(roleTools: string[], inheritedTools: string[]): string[] {
    const inherited = new Set(inheritedTools.map((t) => t.trim()));
    const role = new Set(roleTools.map((t) => t.trim()));
    const candidates = new Set<string>();
    if (roleTools.length === 0) {
        for (const tool of inherited) candidates.add(tool);
    } else {
        for (const tool of role) {
            if (inherited.has(tool)) candidates.add(tool);
        }
    }
    for (const tool of [...candidates]) {
        if (!tool || NESTED_DELEGATION_TOOLS.has(tool)) candidates.delete(tool);
    }
    return [...candidates].sort();
}
// Dedup roleId within a round: duplicate roleIds would share one
// workerSessionId + session dir and concurrently corrupt the same session
// JSONL, and collide as activeWorkers/roundCompleted Map keys.
export function dedupRoundRoles<T extends { roleId: string }>(roles: T[]): { roles: T[]; dropped: number } {
    const seen = new Set<string>();
    const deduped = roles.filter((role) => {
        if (seen.has(role.roleId)) return false;
        seen.add(role.roleId);
        return true;
    });
    return { roles: deduped, dropped: roles.length - deduped.length };
}
function workerSoftTimeoutMs(): number {
    const configured = Number.parseInt(process.env.PI_TEAM_WORKER_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WORKER_SOFT_TIMEOUT_MS;
}
function workerSafetyCeilingMs(): number {
    const configured = Number.parseInt(process.env.PI_TEAM_WORKER_SAFETY_CEILING_MS ?? "", 10);
    // The ceiling must always sit above the soft threshold so the captain gets
    // notified well before the tool would ever act on its own.
    const ceiling = Number.isFinite(configured) && configured > 0 ? configured : ABSOLUTE_SAFETY_CEILING_MS;
    return Math.max(ceiling, workerSoftTimeoutMs() + 1);
}
function progressText(run: TeamRun, event: TeamEvent): string {
    const running = run.workers.filter((worker) => worker.status === "running");
    const done = run.workers.filter((worker) => worker.status !== "running");
    const rows = running.map((worker) => {
        const now = Date.now();
        const elapsed = worker.startedAt === undefined ? "0s" : `${Math.round((now - worker.startedAt) / 1000)}s`;
        const signalAge =
            worker.lastSignalAt === undefined ? "no-signal" : `${Math.round((now - worker.lastSignalAt) / 1000)}s ago`;
        const state =
            worker.lastSignalAt !== undefined && now - worker.lastSignalAt > WORKER_STALE_MS ? "stale" : "active";
        const activity = worker.lastTool
            ? `tool=${worker.lastTool}`
            : worker.lastEvent
              ? `event=${worker.lastEvent}`
              : "event=starting";
        const report = worker.lastReportPreview ? `, report="${worker.lastReportPreview}"` : "";
        return `  - ${worker.title}: ${state} ${elapsed}, signal=${signalAge}, ${activity}${report}`;
    });
    return [
        `[team:${event.phase}] ${event.message}`,
        `progress: ${done.length}/${run.workers.length || done.length + running.length} done, ${running.length} running`,
        ...rows,
    ].join("\n");
}
function logUpdate(onUpdate: TeamUpdate | undefined, run: TeamRun, event: TeamEvent): TeamRun {
    const nextRun = updateRunWithEvent(run, event);
    onUpdate?.({
        content: [{ type: "text", text: progressText(nextRun, event) }],
        details: nextRun,
    });
    return nextRun;
}
function workerContextPrompt(context: WorkerPromptContext | undefined): string[] {
    if (!context) return [];
    return [
        "Worker runtime context:",
        `- Run id: ${context.runId}`,
        `- Role id: ${context.role.roleId}`,
        `- Role title: ${context.role.title}`,
        `- Requested/executed model: ${context.role.selectedModel ?? "(unassigned)"}`,
        `- Available tools: ${context.tools.join(", ") || "(none)"}`,
        `- Mailbox file (human-readable): ${context.mailboxTextFile}`,
        `- Mailbox file (jsonl): ${context.mailboxFile}`,
        "- To read captain messages, use the `read` tool on the human-readable mailbox file above (plain text, no shell needed).",
        "- Include the model and tools above in your final output when the task asks for actual runtime evidence.",
    ];
}
export function radioAcknowledgedRequestIds(text: string): string[] {
    return [...text.matchAll(/(?:^|[;\s,])ack\s*[:=]\s*([A-Za-z0-9._-]+)/gi)].map((match) => match[1]!);
}

export function workerRadioPrompt(systemPrompt: string, context?: WorkerPromptContext): string {
    return [
        systemPrompt,
        "",
        ...workerContextPrompt(context),
        ...(context?.watchdogAdvisory ? ["", context.watchdogAdvisory] : []),
        "",
        "Team radio protocol:",
        "- You are a teammate, not the captain. The main Agent is the captain.",
        "- Do not spawn subagents or start nested team runs.",
        "- Report progress to the captain in short assistant messages at meaningful milestones: started, source/tool selected, evidence found, blocked, final.",
        `- Start every progress report with "${RADIO_REPORT_PREFIX}" so the captain can distinguish radio updates from normal final output.`,
        "- Each progress report should include: status, current action, tool or URL when relevant, blocker if any, and next step.",
        "- Check for captain instructions by using the `read` tool on the human-readable mailbox file at meaningful milestones. Each captain block includes a request id and either a target role or broadcast marker.",
        `- Act on requests addressed to your role or marked broadcast. Acknowledge the newest addressed request in your next report using "${RADIO_REPORT_PREFIX} ack=<request-id>; status=..." before stating how you adjusted. A shell is not required.`,
        "- Final output must still follow the requested structured finding fields; unless the role/task explicitly asks for a long report, keep final output concise: result summary, key evidence refs, limitations/disagreements, confidence, and next questions.",
        "- When searching code or files, use the search tools available to you (`grep`/`find`/`ls` if present; otherwise use `bash` search commands such as `rg`/`find`). Exclude the team's own run artifacts under `.pi/team/` or `.omp/team/` — they are prior-run exhaust, not source evidence, and reading them wastes budget.",
    ].join("\n");
}
function resolveWorkerModel(selectedModel: string | undefined, modelRegistry: TeamRunOptions["modelRegistry"]): Model<import("@earendil-works/pi-ai").Api> | undefined {
    if (!selectedModel || !modelRegistry) return undefined;
    const firstSlash = selectedModel.indexOf("/");
    if (firstSlash === -1) return undefined;
    return modelRegistry.find(selectedModel.slice(0, firstSlash), selectedModel.slice(firstSlash + 1));
}
async function runWorker(
    cwd: string,
    runId: string,
    role: PlannedRole,
    tools: string[],
    onWorkerUpdate: WorkerUpdate,
    signal?: AbortSignal,
    lane?: { laneId: string; delegationToken: string },
    modelRegistry?: TeamRunOptions["modelRegistry"],
    watchdogAdvisory?: string,
    defaultsDir?: string,
): Promise<WorkerRun> {
    if (role.skipReason) {
        return {
            roleId: role.roleId,
            title: role.title,
            task: role.task,
            model: role.selectedModel,
            thinkingLevel: role.thinkingLevel,
            status: "skipped",
            output: "",
            tools,
            activeTools: [],
            errorReason: role.skipReason,
        };
    }
    const controlPaths = teamControlPaths(cwd, runId);
    const messages: Message[] = [];
    let wasAborted = false;
    let timedOut = false;
    let seenCaptainMessages = 0;
    const workerSessionIdStr = workerSessionId(runId, role.roleId);
    const workerModel = resolveWorkerModel(role.selectedModel, modelRegistry);
    const thinking = resolveThinkingCompatibility(role.thinkingLevel, workerModel);
    const effectiveRoutingReason = [role.routingReason, thinking.note].filter(Boolean).join("; ") || undefined;
    const budget = requestBudget();
    const runningWorker: WorkerRun = {
        roleId: role.roleId,
        title: role.title,
        task: role.task,
        model: role.selectedModel, thinkingLevel: thinking.effective, routingReason: effectiveRoutingReason,
        status: "running",
        output: "",
        tools,
        startedAt: Date.now(),
        lastSignalAt: Date.now(),
        lastEvent: "worker-start",
        requests: 0, tokens: 0, costUsd: 0,
        events: [],
    };
    const emitWorkerUpdate = (event: TeamEvent) => {
        appendWorkerEvent(runningWorker, event);
        onWorkerUpdate(
            { ...runningWorker },
            {
                ...event,
                roleId: role.roleId,
                model: role.selectedModel,
                status: runningWorker.status,
            },
        );
    };
    const workerAbortController = new AbortController();
    const abortWorker = () => {
        if (wasAborted) return;
        wasAborted = true;
        if (!runningWorker.cancelRequestedAt) runningWorker.cancelRequestedAt = Date.now();
        if (!runningWorker.cancelObservedAt) runningWorker.cancelObservedAt = Date.now();
        workerAbortController.abort();
        sessionDisposer?.();
    };
    let removeSignalAbortListener: (() => void) | undefined;
    // Wire incoming signal (foreground ESC, run-level cancel) to worker abort
    if (signal) {
        if (signal.aborted) abortWorker();
        else {
            signal.addEventListener("abort", abortWorker, { once: true });
            removeSignalAbortListener = () => signal.removeEventListener("abort", abortWorker);
        }
    }
    let sessionDisposer: (() => void) | undefined;
    let cleanupTimers: (() => void) | undefined;
    let captainPollPromise: Promise<void> | undefined;
    try {
        if (role.selectedModel && !workerModel) {
            throw new Error(`selected model '${role.selectedModel}' was not found in Pi model registry`);
        }
        const sessionAbortSignal = workerAbortController.signal;
        const sessionManager = await resolveWorkerSessionManager(cwd, runId, role);
        const sessionReady = createAgentSession({
            cwd,
            model: workerModel,
            thinkingLevel: thinking.effective,
            ...workerSessionToolOptions(tools),
            sessionManager,
        });
        const sessionPromise = sessionReady.then((result) => {
            if (sessionAbortSignal.aborted) {
                result.session.dispose();
                throw new DOMException("Worker aborted before session started", "AbortError");
            }
            return result;
        });
        const softTimeoutMs = workerSoftTimeoutMs();
        const safetyCeilingMs = workerSafetyCeilingMs();
        let softTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let safetyCeilingTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanupTimeout = () => {
            if (softTimeoutTimer) {
                clearTimeout(softTimeoutTimer);
                softTimeoutTimer = undefined;
            }
            if (safetyCeilingTimer) {
                clearTimeout(safetyCeilingTimer);
                safetyCeilingTimer = undefined;
            }
        };
        let captainTimer: ReturnType<typeof setInterval> | undefined;
        let primaryPromptStarted = false;
        let captainDeliveryClosed = false;
        let injectCaptainRequest: ((requestId: string, message: string) => Promise<boolean>) | undefined;
        const pollCaptainMessagesOnce = async () => {
            if (captainDeliveryClosed || !primaryPromptStarted) return;
            if (isTeamCancelRequested(cwd, runId) || isWorkerCancelRequested(cwd, runId, role.roleId)) {
                emitWorkerUpdate({
                    phase: "worker-cancel-requested",
                    message: `${role.title} received cancel request`,
                    isError: true,
                });
                abortWorker();
                return;
            }
            const messagesFromCaptain = (await readTeamMailbox(cwd, runId)).filter((msg) =>
                teamMailboxMessageAddressesRole(msg, role.roleId),
            );
            if (messagesFromCaptain.length <= seenCaptainMessages || !injectCaptainRequest) return;
            seenCaptainMessages = await deliverCaptainRequests({
                messages: messagesFromCaptain,
                seen: seenCaptainMessages,
                worker: runningWorker,
                inject: injectCaptainRequest,
                emit: emitWorkerUpdate,
            });
        };
        const pollCaptainMessages = () => {
            if (captainPollPromise) return captainPollPromise;
            const current = pollCaptainMessagesOnce();
            const tracked = current.finally(() => {
                if (captainPollPromise === tracked) captainPollPromise = undefined;
            });
            captainPollPromise = tracked;
            return tracked;
        };
        cleanupTimers = () => {
            captainDeliveryClosed = true;
            cleanupTimeout();
            if (captainTimer) clearInterval(captainTimer);
        };
        const { session } = await Promise.race([
            sessionPromise,
            new Promise<never>((_resolve, reject) => {
                const onAbort = () => reject(new DOMException("Worker aborted", "AbortError"));
                sessionAbortSignal.addEventListener("abort", onAbort, { once: true });
            }),
        ]);
        injectCaptainRequest = async (requestId, message) => {
            try {
                if (captainDeliveryClosed || !primaryPromptStarted) return false;
                await session.sendUserMessage(captainRequestSteerText(requestId, message), { deliverAs: "steer" });
                return !captainDeliveryClosed;
            } catch {
                return false;
            }
        };
        // Guard against double-dispose: the abort path and the finally block
        // can both fire on an aborted worker. Wrap so session.dispose() runs at
        // most once even if Pi's dispose is not idempotent.
        sessionDisposer = onceDisposer(() => session.dispose());
        const activeTools = session.getActiveToolNames();
        runningWorker.activeTools = activeTools;
        runningWorker.toolIsolationViolation = toolIsolationViolationMessage(findToolIsolationViolations(activeTools, tools));
        if (runningWorker.toolIsolationViolation) throw new Error(runningWorker.toolIsolationViolation);
        // --------------------------------------------------------------------
        // Event subscription
        // --------------------------------------------------------------------
        const unsubscribe = session.subscribe((event) => {
            runningWorker.lastSignalAt = Date.now();
            switch (event.type) {
                case "message_start":
                    primaryPromptStarted = true;
                    emitWorkerUpdate({
                        phase: "worker-message-start",
                        message: `${role.title} message started`,
                    });
                    break;
                case "message_end": {
                    const msg = event.message as Message;
                    messages.push(msg);
                    if (msg.role === "assistant") {
                        runningWorker.requests = (runningWorker.requests ?? 0) + 1;
                        runningWorker.tokens = (runningWorker.tokens ?? 0) + usageTokens(msg);
                        runningWorker.costUsd = (runningWorker.costUsd ?? 0) + usageCostUsd(msg);
                        const budgetState = classifyBudgetState(runningWorker.requests ?? 0, budget, runningWorker);
                        if (budgetState.reachedSoft) {
                            runningWorker.budgetNoticeSent = true;
                            void session.sendUserMessage(budgetNotice(runningWorker.requests ?? 0), { deliverAs: "steer" }).catch(() => {});
                            emitWorkerUpdate({
                                phase: "worker-budget-notice",
                                message: `${role.title} reached soft request budget (${runningWorker.requests}/${budget.soft})`,
                            });
                        }
                        if (budgetState.reachedHard) {
                            runningWorker.budgetExceeded = true;
                            emitWorkerUpdate({
                                phase: "worker-budget-exceeded",
                                message: `${role.title} passed the hard request budget (${runningWorker.requests}/${budget.hard}) and is STILL RUNNING. The tool will not stop it — captain decides: team_cancel_worker to stop, or let it finish.`,
                                isError: true,
                            });
                        }
                    }
                    const currentText = assistantText(msg);
                    const output = finalAssistantText(messages);
                    if (output) {
                        runningWorker.output = output;
                        runningWorker.lastOutputPreview = textPreview(output);
                    }
                    if (currentText && isRadioReport(currentText)) {
                        const reportAt = Math.max(Date.now(), (runningWorker.lastReportAt ?? 0) + 1);
                        runningWorker.lastReportAt = reportAt;
                        runningWorker.lastReportPreview = textPreview(currentText);
                        acknowledgeCaptainRequests(runningWorker, radioAcknowledgedRequestIds(currentText), reportAt);
                    }
                    runningWorker.lastEvent = "message_end";
                    emitWorkerUpdate({
                        phase: currentText && isRadioReport(currentText) ? "worker-radio-report" : "worker-message-end",
                        message:
                            currentText && isRadioReport(currentText)
                                ? `${role.title} reported to captain`
                                : `${role.title} assistant message ended`,
                        preview: currentText ? textPreview(currentText) : undefined,
                    });
                    break;
                }
                case "tool_execution_start": {
                    runningWorker.lastTool = event.toolName;
                    runningWorker.lastEvent = "tool_execution_start";
                    const violation = toolIsolationViolationMessage(findToolIsolationViolations([event.toolName], tools));
                    if (violation) {
                        // Record + notify the captain, but do NOT stop the worker.
                        // The worker's tool set is already locked down at session
                        // creation (workerSessionToolOptions), so a non-whitelisted
                        // tool physically cannot execute — aborting here would be
                        // the tool making a call that belongs to the captain.
                        // (2026-07-03 no-tool-hard-interrupt.)
                        runningWorker.toolIsolationViolation = violation;
                        emitWorkerUpdate({ phase: "worker-tool-isolation-violation", message: `${violation} (captain decides: team_cancel_worker or ignore — the tool did not stop the worker)`, toolName: event.toolName, isError: true });
                        break;
                    }
                    emitWorkerUpdate({
                        phase: "worker-tool",
                        message: `${role.title} tool_execution_start ${event.toolName}`,
                        toolName: event.toolName,
                    });
                    break;
                }
                case "tool_execution_end":
                    runningWorker.lastTool = event.toolName;
                    runningWorker.lastEvent = "tool_execution_end";
                    emitWorkerUpdate({
                        phase: "worker-tool",
                        message: `${role.title} tool_execution_end ${event.toolName}${event.isError ? " failed" : ""}`,
                        toolName: event.toolName,
                        isError: event.isError === true,
                    });
                    break;
                case "agent_end":
                    runningWorker.lastEvent = "agent_end";
                    break;
            }
        });
        // SOFT threshold: the tool does NOT stop the worker. It only flags the
        // run as long-running and notifies the captain, who owns the decision to
        // team_cancel_worker or let it continue. Multi-round / complex tasks
        // legitimately exceed this. (2026-07-03 no-tool-hard-interrupt.)
        softTimeoutTimer = setTimeout(() => {
            runningWorker.softTimeoutNoticeAt = Date.now();
            emitWorkerUpdate({
                phase: "worker-long-running",
                message: `${role.title} passed the soft timeout (${softTimeoutMs}ms) and is STILL RUNNING. The tool will not stop it — captain decides: team_cancel_worker to stop, or let it finish.`,
                isError: true,
            });
        }, softTimeoutMs);
        // ABSOLUTE safety ceiling: the ONE place the tool stops a worker on its
        // own, purely as a runaway-cost backstop when no captain is watching a
        // background run. It reports loudly that the TOOL — not the captain —
        // acted, so a legitimate long task can be re-dispatched.
        safetyCeilingTimer = setTimeout(() => {
            timedOut = true;
            runningWorker.timedOut = true;
            runningWorker.safetyCeilingHit = true;
            emitWorkerUpdate({
                phase: "worker-safety-ceiling",
                message: `${role.title} hit the absolute safety ceiling (${safetyCeilingMs}ms). The TOOL stopped it as a runaway-cost backstop, NOT a captain judgment — captain may re-dispatch if the work was legitimate.`,
                isError: true,
            });
            abortWorker();
        }, safetyCeilingMs);
        // --------------------------------------------------------------------
        // Build worker task message with system prompt + mailbox instructions
        // Inject worker-playbook (auto-inject:true) and any role-level SOPs.
        // (2026-07-04 项8 step2: manual-loader)
        // --------------------------------------------------------------------
        const manualWarnings: string[] = [];
        const manualPrefix = buildWorkerInjection(defaultsDir, role.sop, manualWarnings);
        for (const w of manualWarnings) {
            emitWorkerUpdate({ phase: "manual-injection-warning", message: w, isError: false });
        }
        const effectiveSystemPrompt = manualPrefix ? `${manualPrefix}\n\n---\n\n${role.systemPrompt}` : role.systemPrompt;
        const systemPrompt = workerRadioPrompt(effectiveSystemPrompt, {
            runId,
            role,
            tools,
            mailboxFile: controlPaths.mailboxFile,
            mailboxTextFile: controlPaths.mailboxTextFile,
            laneId: lane?.laneId,
            delegationToken: lane?.delegationToken,
            watchdogAdvisory,
        });
        const taskMessage = [
            `System instructions: ${systemPrompt}`,
            "",
            `Task: ${role.task}`,
            "",
            "Team mailbox (captain messages):",
            `- Run id: ${runId}`,
            `- Read this plain-text mailbox with the read tool: ${controlPaths.mailboxTextFile}`,
            `- Raw JSONL mailbox (optional, for tooling): ${controlPaths.mailboxFile}`,
            "- Open the plain-text mailbox with the read tool at meaningful milestones. It is empty until the captain sends something.",
            `- If the captain has left a request addressed to role ${role.roleId} or marked broadcast, acknowledge it in your next RADIO report using "${RADIO_REPORT_PREFIX} ack=<request-id>; status=..." and adjust within your role boundary.`,
        ].join("\n");
        // Start the primary task before mailbox steering so a pre-existing
        // request cannot trigger a turn without the worker task instructions.
        const workerPrompt = session.prompt(taskMessage);
        captainTimer = setInterval(() => { void pollCaptainMessages(); }, CAPTAIN_MESSAGE_POLL_MS);
        void pollCaptainMessages();
        await workerPrompt;
        // Wait for agent_end
        await new Promise<void>((resolve) => {
            const check = () => {
                if (runningWorker.lastEvent === "agent_end") {
                    sub();
                    resolve();
                } else if (sessionAbortSignal.aborted) {
                    resolve();
                }
            };
            const sub = session.subscribe(() => check());
            check();
            const onAbort = () => {
                sub();
                resolve();
            };
            sessionAbortSignal.addEventListener("abort", onAbort, { once: true });
        });
        // --------------------------------------------------------------------
        // Cleanup
        // --------------------------------------------------------------------
        cleanupTimers();
        await captainPollPromise?.catch(() => {});
        unsubscribe();
        if (sessionAbortSignal.aborted && !wasAborted) {
            wasAborted = true;
        }
        if (wasAborted && !runningWorker.cancelRequestedAt) {
            runningWorker.cancelRequestedAt = Date.now();
            runningWorker.cancelObservedAt = Date.now();
        }
        runningWorker.output = finalAssistantText(messages) || runningWorker.output;
        const output = salvageOutput(runningWorker);
        const outputKind = workerOutputKind(output);
        // Advisory structured-output check: extract + validate JSON against the
        // role's declared schema. Never gates status — a failure only annotates
        // the WorkerRun so the captain can see it. Keys are omitted (not set to
        // undefined) to satisfy exactOptionalPropertyTypes when spread below.
        const structured = evaluateWorkerStructuredOutput(role.outputSchema, output);
        const exitCode = wasAborted ? 130 : 0;
        const status: WorkerStatus = runningWorker.budgetExceeded ? "degraded" : workerExitStatus(exitCode, output, wasAborted, timedOut);
        return {
            roleId: role.roleId,
            title: role.title,
            task: role.task,
            model: role.selectedModel, thinkingLevel: runningWorker.thinkingLevel,
            routingReason: runningWorker.routingReason, modelFallbackKeys: role.modelFallbackKeys,
            status,
            output,
            tools,
            activeTools: runningWorker.activeTools,
            toolIsolationViolation: runningWorker.toolIsolationViolation,
            startedAt: runningWorker.startedAt,
            endedAt: Date.now(),
            lastEvent: runningWorker.lastEvent,
            lastTool: runningWorker.lastTool,
            lastSignalAt: runningWorker.lastSignalAt,
            lastReportAt: runningWorker.lastReportAt,
            lastReportPreview: runningWorker.lastReportPreview,
            ...captainRequestSnapshot(runningWorker),
            lastOutputPreview: output ? textPreview(output) : undefined,
            outputKind,
            ...structured,
            timedOut,
            requests: runningWorker.requests,
            tokens: runningWorker.tokens,
            costUsd: runningWorker.costUsd,
            budgetNoticeSent: runningWorker.budgetNoticeSent,
            budgetExceeded: runningWorker.budgetExceeded,
            sessionId: workerSessionIdStr,
            exitCode: runningWorker.exitCode ?? exitCode,
            exitSignal: runningWorker.exitSignal,
            cancelRequestedAt: runningWorker.cancelRequestedAt,
            cancelObservedAt: runningWorker.cancelObservedAt,
            events: runningWorker.events,
            errorReason: status !== "succeeded"
                ? workerFailureReason({ wasAborted, timedOut, budgetExceeded: runningWorker.budgetExceeded, outputKind, exitCode, stderr: "" })
                : undefined,
        };
    } catch (error) {
        cleanupTimers?.();
        const message = error instanceof Error ? error.message : String(error);
        if ((error instanceof Error && error.name === "AbortError") || message.includes("aborted")) {
            wasAborted = true;
        }
        const caughtOutput = salvageOutput(runningWorker);
        const caughtOutputKind = workerOutputKind(caughtOutput);
        const caughtStructured = evaluateWorkerStructuredOutput(role.outputSchema, caughtOutput);
        const caughtStatus: WorkerStatus = runningWorker.budgetExceeded ? "degraded" : workerExitStatus(wasAborted ? 130 : 1, caughtOutput, wasAborted, timedOut);
        return {
            roleId: role.roleId,
            title: role.title,
            task: role.task,
            model: role.selectedModel, thinkingLevel: runningWorker.thinkingLevel,
            routingReason: runningWorker.routingReason, modelFallbackKeys: role.modelFallbackKeys,
            status: caughtStatus,
            output: caughtOutput,
            tools,
            activeTools: runningWorker.activeTools,
            toolIsolationViolation: runningWorker.toolIsolationViolation,
            startedAt: runningWorker.startedAt,
            endedAt: Date.now(),
            lastEvent: runningWorker.lastEvent,
            lastTool: runningWorker.lastTool,
            lastSignalAt: runningWorker.lastSignalAt,
            lastReportAt: runningWorker.lastReportAt,
            lastReportPreview: runningWorker.lastReportPreview,
            ...captainRequestSnapshot(runningWorker),
            lastOutputPreview: caughtOutput ? textPreview(caughtOutput) : undefined,
            outputKind: caughtOutputKind,
            ...caughtStructured,
            timedOut,
            requests: runningWorker.requests,
            tokens: runningWorker.tokens,
            costUsd: runningWorker.costUsd,
            budgetNoticeSent: runningWorker.budgetNoticeSent,
            budgetExceeded: runningWorker.budgetExceeded,
            sessionId: workerSessionIdStr,
            exitCode: wasAborted ? 130 : 1,
            cancelRequestedAt: runningWorker.cancelRequestedAt,
            cancelObservedAt: wasAborted ? Date.now() : runningWorker.cancelObservedAt,
            events: runningWorker.events,
            errorReason: caughtStatus !== "succeeded"
                ? runningWorker.budgetExceeded
                    ? "worker exceeded request budget"
                    : wasAborted
                      ? "aborted"
                      : message
                : undefined,
        };
    } finally {
        cleanupTimers?.();
        await captainPollPromise?.catch(() => {});
        removeSignalAbortListener?.();
        sessionDisposer?.();
    }
}
// Runs a disposer at most once (called from both abort path and finally; dispose may not be idempotent).
export function onceDisposer(dispose: () => void): () => void {
    let disposed = false;
    return () => { if (!disposed) { disposed = true; dispose(); } };
}
export async function mapWithConcurrency<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const workers = new Array(workerCount).fill(undefined).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length) return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}
async function persistRunLog(cwd: string, run: TeamRun): Promise<TeamRun> {
    try {
        const logDir = teamRunLogDir(cwd);
        await fs.promises.mkdir(logDir, { recursive: true });
        const logFile = path.join(logDir, `${run.runId}.json`);
        const nextRun = { ...run, logFile };
        await fs.promises.writeFile(logFile, `${JSON.stringify(nextRun, null, 2)}\n`, "utf-8");
        // Durable handoff copy alongside the JSON log. The run-log dir is the
        // independent persistent surface (the active dir is not reaped today,
        // but this copy survives regardless of active-dir lifecycle). Best-
        // effort, never blocks log persistence or the terminal outcome.
        await fs.promises
            .writeFile(path.join(logDir, `${run.runId}.handoff.md`), buildHandoffDigest(nextRun), "utf-8")
            .catch(() => {});
        return nextRun;
    } catch (error) {
        return updateRunWithEvent(run, {
            phase: "log-persist-failed",
            message: `failed to persist team run log: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
        });
    }
}
export function createQueuedStateWriter(writeSnapshot: (snapshot: TeamRun) => Promise<void>): QueuedStateWriter {
    let stateWrite = Promise.resolve();
    let stateWriteError: string | undefined;
    const cleanSnapshot = (snapshot: TeamRun): TeamRun => {
        const { stateWriteError: _stateWriteError, ...rest } = snapshot;
        // Deep-copy workers[] so queued snapshots aren't mutated by later
        // Object.assign(runningWorker, ...) before the write flushes.
        return {
            ...rest,
            workers: rest.workers?.map((w) => ({ ...w })),
        };
    };
    return {
        queue(snapshot: TeamRun): void {
            const snapshotToWrite = cleanSnapshot(snapshot);
            stateWrite = stateWrite.then(async () => {
                try {
                    await writeSnapshot(snapshotToWrite);
                    stateWriteError = undefined;
                } catch (error) {
                    stateWriteError = `failed to write team state: ${errorMessage(error)}`;
                }
            });
        },
        async flush(): Promise<string | undefined> {
            await stateWrite;
            return stateWriteError;
        },
        currentError(): string | undefined {
            return stateWriteError;
        },
    };
}

export async function runTeamPlan(
    cwd: string,
    plan: TeamPlan,
    run: TeamRun,
    options: TeamRunOptions,
    signal?: AbortSignal,
    onUpdate?: TeamUpdate,
): Promise<TeamRun> {
    const workers: WorkerRun[] = [];
    const activeWorkers = new Map<string, WorkerRun>();
    // Workers that finished in the current parallel round but are not yet pushed
    // into `workers` (push happens after the whole round). Without this, another
    // worker's heartbeat would write a snapshot that omits already-finished peers
    // and the observed total would shrink mid-round.
    const roundCompleted = new Map<string, WorkerRun>();
    const visibleWorkers = (): WorkerRun[] => [...workers, ...roundCompleted.values(), ...activeWorkers.values()];
    let currentRun: TeamRun = await prepareTeamControl(cwd, { ...run, status: "running", workers });
    try {
        const persistedBlueprint = await persistBlueprintArtifact(cwd, plan, currentRun);
        currentRun = {
            ...currentRun,
            blueprintId: persistedBlueprint.artifact.blueprintId,
            blueprintFile: persistedBlueprint.filePath,
        };
    } catch (error) {
        currentRun = updateRunWithEvent(currentRun, {
            phase: "blueprint-artifact-failed",
            message: `failed to persist blueprint artifact: ${errorMessage(error)}`,
            isError: true,
        });
    }
    await writeTeamState(cwd, currentRun);
    const stateWriter = createQueuedStateWriter((snapshot) => writeTeamState(cwd, snapshot));
    const updateAndPersist = (event: TeamEvent, nextRun: TeamRun = currentRun): TeamRun => {
        const updated = logUpdate(onUpdate, nextRun, event);
        currentRun = updated;
        stateWriter.queue(updated);
        return updated;
    };
    currentRun = updateAndPersist({
        phase: "run-start",
        message: `running playbook ${plan.playbook.id}: ${plan.policy.rationale}`,
        status: currentRun.status,
    });
    currentRun = updateAndPersist({
        phase: "run-policy",
        message: `strategy=${plan.policy.strategy} evidence=${plan.policy.evidencePolicy}`,
        status: currentRun.status,
    });
    // Discover advisory WATCHDOG guidance once per run and inject it into every
    // worker prompt. Advisory only — workers weigh it, the captain stays final
    // judge. Emit an observability event so the captain can see it is in effect.
    const watchdog = loadWatchdogAdvisory(cwd, options.defaultsDir);
    const watchdogAdvisory = watchdog?.advisory;
    if (watchdog) {
        currentRun = updateAndPersist({
            phase: "watchdog-advisory",
            message: `watchdog advisory active (${watchdog.sources.length} file(s): ${watchdog.sources.map((s) => `${s.level}:${s.filePath}`).join(", ")}); injected as advisory into worker prompts`,
            status: currentRun.status,
        });
    }
    // User-set tool-tier ceiling (default exec = no restriction). Recorded once
    // per run so the captain can see whether worker tool risk is being capped.
    const maxToolTier = resolveMaxToolTier();
    if (maxToolTier !== "exec") {
        currentRun = updateAndPersist({
            phase: "tool-tier-policy",
            message: `tool tier ceiling=${maxToolTier}; tools above this tier are dropped from worker whitelists before dispatch`,
            status: currentRun.status,
        });
    }
    const graphValidation = validateTeamPlanGraph(plan);
    currentRun = { ...currentRun, planGraph: graphValidation };
    for (const warning of graphValidation.warnings) {
        currentRun = updateAndPersist({ phase: "plan-graph-warning", message: warning, isError: true });
    }
    for (const error of graphValidation.errors) {
        currentRun = updateAndPersist({ phase: "plan-graph-invalid", message: error, isError: true });
    }
    if (graphValidation.errors.length > 0) {
        const failedRun: TeamRun = {
            ...currentRun,
            status: "failed",
            workers: [],
            finalSummary: `Team plan graph invalid:\n${graphValidation.errors.map((error) => `- ${error}`).join("\n")}`,
            ...buildRunAbsorption([]),
        };
        const persistedRun = await persistRunLog(cwd, failedRun);
        stateWriter.queue(persistedRun);
        await stateWriter.flush();
        return persistedRun;
    }
    const pending = options.pendingModelDecision;
    if (pending) await runModelDecisionWindow(
        plan,
        pending,
        async () => (await readTeamMailbox(cwd, currentRun.runId)).filter((message) => !message.system).map((message) => message.message),
        (event) => { currentRun = updateAndPersist(event); },
        signal,
    );
    if (pending && options.modelDiversity) {
        const assignedModels = plan.rounds.flatMap((round) => round.roles).map((role) => role.selectedModel)
            .filter((model): model is string => Boolean(model));
        const { healthyModelCount, intendedDistinctModelCount } = options.modelDiversity;
        const notice = detectModelConvergence(assignedModels, healthyModelCount, intendedDistinctModelCount);
        if (notice) currentRun = updateAndPersist({ phase: "run-evidence-warning", message: notice, isError: true });
    }
    const runRole = async (role: PlannedRole): Promise<WorkerRun> => {
        const resolvedTools = resolveWorkerTools(role.tools, options.inheritedTools);
        // Transparent user-set ceiling; captain still owns semantic tool choice.
        const tierDecision = applyToolTierCeiling(resolvedTools, maxToolTier);
        const tools = tierDecision.allowed;
        const tierSummary = formatToolTierDecision(role.title, tierDecision);
        if (tierSummary) {
            currentRun = updateAndPersist({
                phase: "tool-tier-ceiling",
                message: tierSummary,
                roleId: role.roleId,
                isError: true,
            });
        }
        if (role.tools.length > 0 && tools.length === 0) {
            // Distinguish the proximate cause: when the whitelist left tools but
            // the user's tier ceiling dropped them all, say so explicitly rather
            // than blaming "whitelist enforcement" (the errorReason is canonical;
            // a reader should not have to correlate the tier-ceiling event).
            const tierEmptied = resolvedTools.length > 0 && tierDecision.blocked.length > 0;
            const skipReason = tierEmptied
                ? `role requested tools [${role.tools.join(", ")}] but all exceed the tool tier ceiling (${maxToolTier})`
                : `role requested tools [${role.tools.join(", ")}] but none are available after whitelist enforcement`;
            const skipped: WorkerRun = {
                roleId: role.roleId,
                title: role.title,
                task: role.task,
                model: role.selectedModel, routingReason: role.routingReason, modelFallbackKeys: role.modelFallbackKeys,
                status: "skipped",
                output: "",
                tools: [],
                errorReason: skipReason,
            };
            currentRun = updateAndPersist(
                {
                    phase: "worker-skipped",
                    message: `${role.title} skipped: ${tierEmptied ? `all tools exceed tier ceiling ${maxToolTier}` : "no usable tools after whitelist enforcement"}`,
                    roleId: role.roleId,
                    model: role.selectedModel,
                    status: "skipped",
                },
                { ...currentRun, workers: visibleWorkers() },
            );
            return writeWorkerArtifacts(cwd, currentRun.runId, skipped);
        }
        const lane = await initDelegationLane(cwd, currentRun.runId, role.roleId, role.title);
        currentRun.delegationLanes = [...(currentRun.delegationLanes ?? []), lane];
        const runningWorker: WorkerRun = {
            roleId: role.roleId,
            title: role.title,
            task: role.task,
            model: role.selectedModel, routingReason: role.routingReason, modelFallbackKeys: role.modelFallbackKeys,
            status: "running",
            output: "",
            tools,
            laneId: lane.laneId,
            delegationToken: lane.delegationToken,
            startedAt: Date.now(),
            lastSignalAt: Date.now(),
            lastEvent: "worker-start",
            events: [],
        };
        activeWorkers.set(role.roleId, runningWorker);
        const heartbeat = () => {
            const elapsedSeconds = Math.max(
                0,
                Math.round((Date.now() - (runningWorker.startedAt ?? Date.now())) / 1000),
            );
            const activity = runningWorker.lastTool
                ? `last tool ${runningWorker.lastTool}`
                : `last event ${runningWorker.lastEvent ?? "starting"}`;
            currentRun = updateAndPersist(
                {
                    phase: "worker-heartbeat",
                    message: `${role.title} running ${elapsedSeconds}s, ${activity}`,
                    roleId: role.roleId,
                    model: role.selectedModel,
                    status: "running",
                },
                { ...currentRun, workers: visibleWorkers() },
            );
        };
        currentRun = updateAndPersist(
            {
                phase: "worker-start",
                message: `${role.title} started; capability=${role.capability ?? role.description}; needs=${role.capabilityNeeds.join(",") || "none"}; modelFit=${role.modelFit ?? "not specified"}; thinking-requested=${role.thinkingLevel ?? "provider-default"}; routing=${role.routingReason ?? "not recorded"}; tools=${tools.join(",") || "(none)"}`,
                roleId: role.roleId,
                model: role.selectedModel,
                status: "running",
            },
            { ...currentRun, workers: visibleWorkers() },
        );
        heartbeat();
        const heartbeatTimer = setInterval(heartbeat, WORKER_HEARTBEAT_MS);
        try {
            let attemptRole = role;
            const attempts: NonNullable<WorkerRun["modelAttempts"]> = [];
            const priorAttemptEvents: TeamEvent[] = [];
            while (true) {
                const result = await runWorker(
                    cwd,
                    currentRun.runId,
                    attemptRole,
                    tools,
                    (worker, event) => {
                        Object.assign(runningWorker, worker);
                        runningWorker.events = [...priorAttemptEvents, ...(worker.events ?? [])];
                        activeWorkers.set(role.roleId, runningWorker);
                        currentRun = updateAndPersist(event, { ...currentRun, workers: visibleWorkers() });
                    },
                    signal,
                    { laneId: lane.laneId, delegationToken: lane.delegationToken },
                    options.modelRegistry,
                    watchdogAdvisory,
                    options.defaultsDir,
                );
                currentRun = recordRunWorkerHealth(currentRun, result);
                attempts.push({ model: attemptRole.selectedModel, status: result.status, errorReason: result.errorReason });
                const nextModel = selectRetryModel(attempts.map((attempt) => attempt.model), attemptRole.modelFallbackKeys);
                if (!shouldRetryWorker(result) || !nextModel) {
                    const finalResult = await writeWorkerArtifacts(cwd, currentRun.runId, {
                        ...result, events: [...priorAttemptEvents, ...(result.events ?? [])], modelAttempts: attempts,
                    });
                    finishDelegationLane(lane, finalResult);
                    activeWorkers.set(role.roleId, finalResult);
                    currentRun = updateAndPersist(
                        {
                            phase: "worker-end",
                            message: `${role.title} ${finalResult.status}${finalResult.lastTool ? `, last tool ${finalResult.lastTool}` : ""}`,
                            roleId: role.roleId,
                            model: finalResult.model,
                            status: finalResult.status,
                        },
                        { ...currentRun, workers: visibleWorkers() },
                    );
                    return finalResult;
                }
                priorAttemptEvents.push(...(result.events ?? []));
                currentRun = updateAndPersist(
                    {
                        phase: "worker-model-retry",
                        message: `${role.title} retrying with fallback model ${nextModel} after ${result.errorReason ?? result.status}`,
                        roleId: role.roleId,
                        model: nextModel,
                        status: "running",
                    },
                    { ...currentRun, workers: visibleWorkers() },
                );
                attemptRole = { ...attemptRole, selectedModel: nextModel };
            }
        } finally {
            clearInterval(heartbeatTimer);
        }
    };

    const dispatchCtx: RoundDispatchContext = { runRole, workers, activeWorkers, roundCompleted, visibleWorkers, updateAndPersist, maxConcurrency: MAX_CONCURRENCY };
    // (2026-07-03 A-2): dependency-graph-based scheduling via pure helpers in
    // plan-schedule.ts (unit-tested for chain/diamond/parallel). A round runs
    // only when EVERY blocker of EVERY role has completed.
    const completedRoleIds = new Set<string>();
    const dispatchedRoundIds = new Set<string>();
    const taskQueue: PlannedRound[] = initialQueue(plan);
    let spawnedWorkerCount = 0;
    // Known roleIds (planned + already spawned): a spawned worker MUST NOT reuse
    // one, or it would satisfy a planned blocker through completedRoleIds and
    // corrupt dependency state the plan never declared. (2026-07-03 A-2 MAJOR#2.)
    const knownRoleIds = new Set<string>(plan.rounds.flatMap((r) => r.roles.map((role) => role.roleId)));
    const seedQueue = () => {
        const queuedRoundIds = new Set(taskQueue.map((t) => t.id));
        for (const round of newlySchedulableRounds(plan, completedRoleIds, dispatchedRoundIds, queuedRoundIds)) {
            taskQueue.push(round);
        }
    };
    while (taskQueue.length > 0 || activeWorkers.size > 0) {
        const spawnMessages = (await readTeamMailbox(cwd, currentRun.runId)).filter((msg) => msg.message.startsWith('{"action":"spawn_worker"'));
        for (const msg of spawnMessages) {
            const raw = JSON.parse(msg.message) as unknown as { action: string; role?: Partial<PlannedRole> };
            const decision = validateSpawnRole(raw, knownRoleIds, spawnedWorkerCount, maxSpawnedWorkers());
            if (!decision.ok) { currentRun = updateAndPersist({ phase: "spawn-rejected", message: `team_spawn_worker rejected: ${decision.reason}`, isError: true }); continue; }
            const r = decision.role;
            knownRoleIds.add(r.roleId);
            taskQueue.push({ id: `spawned-${r.roleId}`, type: "single", roles: [r], goal: "captain-spawned worker" });
            spawnedWorkerCount += 1;
            currentRun = updateAndPersist({ phase: "spawn-accepted", message: `team_spawn_worker added ${r.roleId} (${r.title})`, isError: true });
        }
        if (taskQueue.length > 0) {
            const next = taskQueue.shift()!;
            dispatchedRoundIds.add(next.id);
            await dispatchRound(next, dispatchCtx);
            // MINOR fix (2026-07-03): only SUCCEEDED roles satisfy downstream
            // blockers. A failed/skipped upstream must NOT unblock its dependents
            // (they depend on its output). MAJOR#1 fix: seed after EVERY round so
            // newly unblocked rounds enqueue immediately instead of waiting for the
            // whole queue to drain (data-dependency-driven, not wave-serialized).
            for (const w of workers) if (w.status === "succeeded" || (w.status === "degraded" && w.outputKind === "substantive")) completedRoleIds.add(w.roleId);
            if (plan.blockedBy) seedQueue();
        } else if (activeWorkers.size > 0) await new Promise((r) => setTimeout(r, CAPTAIN_MESSAGE_POLL_MS));
    }
    // Any rounds left undispatched had an unmet dependency (upstream failed or was
    // skipped, so it never unblocked them). Surface them so the captain sees why
    // — not silently dropped. (2026-07-03 A-2 MINOR: success-gated deps.)
    const skippedRounds = plan.blockedBy ? undispatchedRounds(plan, dispatchedRoundIds) : [];
    for (const round of skippedRounds) {
        currentRun = updateAndPersist({ phase: "round-skipped-unmet-deps", message: `round '${round.id}' not dispatched: upstream dependency did not succeed`, isError: true });
    }

    const outcome = determineTeamRunOutcome(workers, skippedRounds.length);
    for (const warning of outcome.warnings) {
        currentRun = updateAndPersist({
            phase: "run-evidence-warning",
            message: warning,
            isError: true,
        });
    }
    const completedRun: TeamRun = {
        ...currentRun,
        status: outcome.status,
        workers,
        finalSummary: buildFinalSummary(workers, outcome, {
            parallelRounds: plan.rounds.filter((round) => round.type === "parallel").length,
        }),
        ...buildRunAbsorption(workers),
        stateWriteError: stateWriter.currentError(),
    };
    const persistedRun = await persistRunLog(cwd, completedRun);
    // Factual handoff digest in the active dir for immediate captain resume.
    // Best-effort: a failed write never changes the run's terminal outcome.
    const handoffFile = await writeHandoff(cwd, persistedRun);
    const finalRun = updateAndPersist(
        {
            phase: "run-log",
            message: `team run log saved to ${persistedRun.logFile ?? "(not saved)"}${handoffFile ? `; handoff ${handoffFile}` : ""}`,
            status: persistedRun.status,
        },
        persistedRun,
    );
    const finalStateWriteError = await stateWriter.flush();
    // Clean per-role session files on every terminal outcome (not only success):
    // they are an internal cross-round resume mechanism, not a documented debug
    // artifact (the run log already persists output/events/stderr/sessionId).
    // Retaining only on failure caused unbounded accumulation with no TTL.
    // Set PI_TEAM_KEEP_SESSIONS=1 to retain sessions for deep debugging.
    if (!process.env.PI_TEAM_KEEP_SESSIONS) {
        const sessionsDir = path.join(teamControlPaths(cwd, run.runId).activeDir, "sessions");
        await fs.promises.rm(sessionsDir, { recursive: true, force: true }).catch(() => {});
    }
    return finalStateWriteError ? { ...finalRun, stateWriteError: finalStateWriteError } : finalRun;
}
