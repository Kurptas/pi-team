import type { Api, Model } from "@earendil-works/pi-ai";

export type ResourceSource = "project" | "user" | "default";

export type TeamMode = "research" | "roundtable" | "code" | "review" | "strategy";
export type FallbackPolicy = "task_first" | "strict" | "cheap_only";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type RoundType = "parallel" | "chain" | "single" | "fanout";

export type FanoutOnEmpty = "skip" | "fail";

export interface FanoutExpandConfig {
    /** Upstream role id whose validated structuredOutput provides the source array. */
    fromRoleId: string;
    /** JSON Pointer into the upstream structuredOutput. Must resolve to an array. */
    path: string;
    /** Optional JSON Pointer into each item used for stable child worker keys. Defaults to the item index. */
    keyPath?: string;
    /** Name used in the injected child-task item context. */
    itemName?: string;
    /** Hard safety limit. Source arrays longer than this are truncated with an observable event. */
    maxItems: number;
    /** Empty array behavior. Default: skip. */
    onEmpty?: FanoutOnEmpty;
}

export interface FanoutCollectConfig {
    /** Synthetic collector role id that stores the collected result array. */
    as: string;
}

export interface FanoutRoundConfig {
    expand: FanoutExpandConfig;
    collect?: FanoutCollectConfig;
}

export type WorkerStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type WorkerOutputKind = "empty" | "radio_only" | "substantive";

export type TeamRunStatus = "planning" | "probing" | "running" | "synthesizing" | "succeeded" | "degraded" | "failed";

export type ModelProbeStatus =
    | "probe_passed"
    | "probe_skipped"
    | "missing_auth"
    | "timeout"
    | "rate_limited"
    | "provider_error"
    | "model_rejected";

export interface TeamInput {
    task: string;
    playbook?: string;
    mode?: TeamMode;
    maxAgents?: number;
    probeModels?: boolean;
    outputContract?: "report" | "decision" | "findings" | "implementation_plan";
    /** Model fallback behavior when user/recommendation candidates are unavailable. Default: task_first. */
    fallbackPolicy?: FallbackPolicy;
    roles?: TeamInputRole[];
    background?: boolean;
}

export interface TeamInputRole {
    id?: string;
    title: string;
    capability?: string;
    capabilityNeeds?: ModelCapabilityDimension[];
    description?: string;
    systemPrompt?: string;
    tools?: string[];
    modelFit?: string;
    modelPreferences?: string[];
    /** Explicit role thinking level. Can also be expressed as modelPreferences entries like provider/model:high. */
    thinking?: ThinkingLevel;
    /** Optional dependency role ids for explicit chain/wave planning. */
    dependsOn?: string[];
    /** Optional downstream role ids; equivalent to target role depending on this role. */
    reportsTo?: string[];
    /** Optional SOP ids to inject into this worker's system prompt (e.g. ["code-review"]). */
    sop?: string[];
    /** Opt-in: persist this role's worker session so a later round with the same
     * roleId resumes the same conversation (context, tool history, reasoning)
     * instead of a cold restart. Default false = ephemeral in-memory session.
     * The captain owns this decision — the tool never auto-resumes. */
    resumable?: boolean;
}

export interface TeamInputRound {
    id: string;
    type: RoundType;
    roles: string[];
    goal?: string;
    fanout?: FanoutRoundConfig;
}

export interface GeneratedTeamBlueprint {
    title: string;
    rationale: string;
    strategy: string;
    roles: TeamInputRole[];
    rounds: TeamInputRound[];
    evidencePolicy: string;
    modelPolicy: string;
    synthesisPolicy: string;
    progressMilestones: string[];
    stopCriteria: string;
}

export interface TeamModel {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    cost: Model<Api>["cost"];
}

export type ModelCapabilityDimension =
    | "coding"
    | "research"
    | "fact_checking"
    | "synthesis"
    | "chinese_writing"
    | "tool_use"
    | "long_context"
    | "speed"
    | "cost_efficiency"
    | "critical_review";

export interface ModelCapabilityProfile {
    family: string;
    models: string[];
    aliases: string[];
    displayName: string;
    summary: string;
    strengths: string[];
    cautions: string[];
    recommendedRoles: string[];
    sources: string[];
}

export interface PlaybookRound {
    name: string;
    type: RoundType;
    roles: string[];
    goal?: string;
    fanout?: FanoutRoundConfig;
}

export interface Playbook {
    id: string;
    title: string;
    description: string;
    hints: string[];
    defaultMode: TeamMode;
    maxAgents: number;
    rounds: PlaybookRound[];
    outputContract: string;
    body: string;
    source: ResourceSource;
    filePath: string;
}

export interface RoleSpec {
    id: string;
    title: string;
    description: string;
    tools: string[];
    modelPreferences: string[];
    thinkingLevel?: ThinkingLevel;
    outputSchema: string;
    body: string;
    source: ResourceSource;
    filePath: string;
}

export interface TeamResources {
    playbooks: Playbook[];
    roles: RoleSpec[];
    diagnostics: string[];
}

export interface PlannedRole {
    roleId: string;
    title: string;
    description: string;
    capability?: string;
    capabilityNeeds: ModelCapabilityDimension[];
    task: string;
    tools: string[];
    systemPrompt: string;
    modelFit?: string;
    modelPreferences: string[];
    /** Role's declared output schema reference (registry name or inline JSON Schema). Advisory validation only. */
    outputSchema?: string;
    selectedModel?: string;
    thinkingLevel?: ThinkingLevel;
    fallbackReason?: string;
    routingReason?: string;
    policyReason?: string;
    skipReason?: string;
    /** Fallback model keys (passed probe) — tried if primary worker fails before producing usable output. */
    modelFallbackKeys?: string[];
    /** Optional explicit dependency role ids. Current executor requires dependencies to finish in earlier rounds. */
    dependsOn?: string[];
    /** Optional downstream role ids; validated like dependency references for now. */
    reportsTo?: string[];
    /** Optional SOP ids to inject into this worker's system prompt (e.g. ["code-review", "research"]). */
    sop?: string[];
    /** Opt-in: persist this role's worker session for same-roleId cross-round
     * resume. Threaded from TeamInputRole.resumable. Default false = ephemeral. */
    resumable?: boolean;
}

export interface PlannedRound {
    id: string;
    type: RoundType;
    goal?: string;
    roles: PlannedRole[];
    fanout?: FanoutRoundConfig;
}

export interface TeamPlanPolicy {
    rationale: string;
    strategy: string;
    evidencePolicy: string;
    modelPolicy: string;
    synthesisPolicy: string;
    progressMilestones: string[];
    stopCriteria: string;
}

export interface TeamPlan {
    objective: string;
    playbook: Playbook;
    rounds: PlannedRound[];
    policy: TeamPlanPolicy;
    synthesis: {
        task: string;
        requiredSections: string[];
        selectedModel?: string;
    };
    /** Bidirectional dependency graph spanning all rounds.
     * roleId → set of roleIds it depends on (upstream blockers for this role). */
    readonly blockedBy?: Map<string, Set<string>>;
    /** Bidirectional dependency graph spanning all rounds.
     * roleId → set of roleIds it unblocks (downstream dependents of this role). */
    readonly blocks?: Map<string, Set<string>>;
}

export interface ModelHealthSnapshot {
    model: string;
    provider: string;
    status: ModelProbeStatus;
    latencyMs: number;
    reason?: string;
    checkedAt: number;
}

export interface WorkerRun {
    roleId: string;
    title: string;
    task: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    status: WorkerStatus;
    output: string;
    tools?: string[];
    activeTools?: string[];
    toolIsolationViolation?: string;
    startedAt?: number;
    endedAt?: number;
    lastEvent?: string;
    lastTool?: string;
    lastSignalAt?: number;
    lastReportAt?: number;
    lastReportPreview?: string;
    lastCaptainMessageAt?: number;
    lastCaptainMessagePreview?: string;
    lastOutputPreview?: string;
    outputKind?: WorkerOutputKind;
    /**
     * P1 structured output. When the role declares an `outputSchema`, the runner
     * extracts a trailing JSON object from the worker's final text and validates
     * it. Advisory INFORMATION for the captain, never a gate: a validation
     * failure does not fail the worker or discard its text.
     */
    structuredOutput?: unknown;
    /** Advisory note when structured output was not extracted or failed validation. */
    structuredOutputError?: string;
    timedOut?: boolean;
    /** Set when the worker passed the SOFT timeout: the tool notified the captain but did NOT stop it. Advisory only. */
    softTimeoutNoticeAt?: number;
    /** Set only when the absolute safety ceiling fired — the one case the tool stopped a worker on its own (runaway-cost backstop, not a captain judgment). */
    safetyCeilingHit?: boolean;
    sessionId?: string;
    streamParseErrorCount?: number;
    lastStreamParseErrorPreview?: string;
    stderrTail?: string;
    events?: TeamEvent[];
    errorReason?: string;
    exitCode?: number | null;
    exitSignal?: string | null;
    cancelRequestedAt?: number;
    cancelObservedAt?: number;
    requests?: number;
    tokens?: number;
    costUsd?: number;
    budgetNoticeSent?: boolean;
    budgetExceeded?: boolean;
    modelAttempts?: { model?: string; status: WorkerStatus; errorReason?: string }[];
    outputFile?: string;
    eventFile?: string;
    laneId?: string;
    delegationToken?: string;
}

export interface TeamRun {
    runId: string;
    task: string;
    playbookId: string;
    status: TeamRunStatus;
    modelHealth: ModelHealthSnapshot[];
    workers: WorkerRun[];
    fallbackPolicy?: FallbackPolicy;
    finalSummary?: string;
    logFile?: string;
    blueprintId?: string;
    blueprintFile?: string;
    activeDir?: string;
    mailboxFile?: string;
    mailboxTextFile?: string;
    cancelFile?: string;
    events?: TeamEvent[];
    lastEvent?: TeamEvent;
    stateWriteError?: string;
    resultAvailability?: "empty" | "radio_only" | "partial" | "substantive";
    evidenceCompleteness?: {
        hasEvidenceRefs: boolean;
        hasLimitations: boolean;
        hasConfidence: boolean;
        hasOpenQuestions: boolean;
    };
    captainAbsorptionPrompt?: string;
    delegationLanes?: DelegationLaneState[];
    planGraph?: {
        errors: string[];
        warnings: string[];
    };
}

export interface DelegationLaneState {
    runId: string;
    laneId: string;
    delegationToken: string;
    roleId: string;
    workerKey: string;
    status: "active" | "succeeded" | "failed" | "skipped" | "cancelled";
    visibleMessageRefs: string[];
    ackedMessageRefs: string[];
    invalidAckRefs: string[];
    ackState: "none" | "partial" | "complete" | "expired" | "invalid";
    createdAt: number;
    expiresAt?: number;
}

export interface TeamEvent {
    phase: string;
    message: string;
    at?: number;
    roleId?: string;
    model?: string;
    status?: string;
    toolName?: string;
    isError?: boolean;
    preview?: string;
}
