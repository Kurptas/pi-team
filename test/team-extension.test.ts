import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildBlueprintArtifact,
	persistBlueprintArtifact,
	promoteBlueprintArtifact,
	safeBlueprintId,
} from "../src/blueprint-store.ts";
import { loadModelCapabilityProfiles, profileForModel } from "../src/capabilities.ts";
import { readCaptainAttentionState, writeCaptainAttentionState } from "../src/captain-attention.ts";
import {
	appendTeamMessage,
	isTeamCancelRequested,
	listTeamRunIds,
	readTeamMailbox,
	readTeamState,
	requestTeamCancel,
	requestWorkerCancel,
	teamControlPaths,
	teamMailboxMessageAddressesRole,
	teamRunLogDir,
	writeTeamState,
} from "../src/control.ts";
import { backgroundNextAction, buildTeamStatusProjection, orderProjectedWorkers, readTeamRunWithControlOverlay, refreshTeamModelRegistry, teamWidgetLines } from "../src/index.ts";
import { loadTeamResources } from "../src/loader.ts";
import { modelKey, routeTeamPlan, selectModelForRole } from "../src/model-router.ts";
import { createTeamPlan, selectPlaybook } from "../src/planner.ts";
import {
	buildCaptainPreDelivery,
	buildFinalSummary,
	buildRunAbsorption,
	createQueuedStateWriter,
	dedupRoundRoles,
	determineTeamRunOutcome,
	finalAssistantText,
	isRadioReport,
	radioAcknowledgedRequestIds,
	roleWithPriorFindings,
	resolveWorkerTools,
	workerExitStatus,
	workerOutputKind,
	workerRadioPrompt,
	workerSessionId,
} from "../src/runner.ts";
import { parseSemanticPlan } from "../src/semantic-planner.ts";
import { piInvocation } from "../src/pi-invocation.ts";
import teamExtension from "../src/index.ts";
import type { ModelHealthSnapshot, PlannedRole, TeamModel, TeamRun, WorkerRun } from "../src/types.ts";
type RegisteredTool = { name: string; definition: any };
type RegisteredCommand = { name: string; definition: any };
function registerTeamExtension() {
	const tools = new Map<string, RegisteredTool["definition"]>();
	const commands = new Map<string, RegisteredCommand["definition"]>();
	const providers = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const pi = {
		on(event: string, handler: any) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		sendUserMessage() {},
		registerTool(definition: any) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition);
		},
		registerShortcut() {},
		setModel() {
			return Promise.resolve(true);
		},
		registerProvider(name: string, definition: any) {
			providers.set(name, definition);
		},
		getAllTools() {
			return [];
		},
		getActiveTools() {
			return [];
		},
	} as any;
	teamExtension(pi);
	return { tools, commands, providers, handlers };
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const teamExtensionDir = path.join(repoRoot, "src");
const defaultsDir = path.join(teamExtensionDir, "defaults");
function testModel(provider: string, id: string, reasoning = false): TeamModel {
	return {
		provider,
		id,
		name: id,
		reasoning,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	};
}
function passed(model: TeamModel): ModelHealthSnapshot {
	return {
		model: modelKey(model),
		provider: model.provider,
		status: "probe_passed",
		latencyMs: 10,
		checkedAt: 1,
	};
}
describe("team extension", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-test-"));
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});
	it("loads default playbooks and roles", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		expect(resources.playbooks.map((playbook) => playbook.id).sort()).toEqual([
			"code-review",
			"debug-triage",
			"implementation-review-gate",
			"multi-angle-review",
			"research-roundtable",
		]);
		expect(resources.roles.map((role) => role.id)).toContain("scout");
		expect(resources.roles.map((role) => role.id)).toContain("evidence-checker");
		expect(resources.roles.map((role) => role.id)).toContain("architect-reviewer");
		expect(resources.roles.map((role) => role.id)).toContain("risk-reviewer");
		expect(resources.roles.map((role) => role.id)).toContain("implementer");
		expect(resources.roles.map((role) => role.id)).toContain("test-runner");
		expect(resources.roles.map((role) => role.id)).toContain("log-reader");
		expect(resources.roles.map((role) => role.id)).toContain("code-path-tracer");
		expect(resources.roles.map((role) => role.id)).toContain("fix-validator");
		expect(resources.roles).toHaveLength(13);
		expect(resources.roles.every((role) => role.modelPreferences.length === 0)).toBe(true);
		expect(resources.roles.every((role) => role.capabilityNeeds.length > 0)).toBe(true);
		expect(resources.roles.find((role) => role.id === "reviewer")?.capabilityNeeds).toEqual([
			"coding", "long_context", "critical_review",
		]);
		const reviewPlan = createTeamPlan({ task: "review", playbook: "code-review" }, resources);
		expect(reviewPlan.rounds.flatMap((round) => round.roles).find((role) => role.roleId === "reviewer")?.capabilityNeeds)
			.toEqual(["coding", "long_context", "critical_review"]);
		const gate = resources.playbooks.find((playbook) => playbook.id === "implementation-review-gate");
		expect(gate?.rounds.map((round) => `${round.name}:${round.type}:${round.roles.join(",")}`)).toEqual([
			"implement:chain:implementer",
			"test:chain:test-runner",
			"review:chain:reviewer",
		]);
		expect(gate?.maxAgents).toBe(3);
		const triage = resources.playbooks.find((playbook) => playbook.id === "debug-triage");
		expect(triage?.rounds.map((round) => `${round.name}:${round.type}:${round.roles.join(",")}`)).toEqual([
			"analyze-logs:chain:log-reader",
			"trace-path:chain:code-path-tracer",
			"validate-fix:chain:fix-validator",
		]);
		expect(triage?.maxAgents).toBe(3);
		expect(resources.diagnostics).toEqual([]);
	});
	it("loads the internal continuity fixture without shipping it as a default", () => {
		const fixtureDefaults = path.join(repoRoot, "test", "fixtures", "defaults");
		const resources = loadTeamResources(teamExtensionDir, fixtureDefaults);
		const cc = resources.playbooks.find((playbook) => playbook.id === "continuity-check");
		expect(cc).toBeDefined();
		expect(cc?.rounds.length).toBe(2);
		expect(cc?.rounds[0]?.roles).toEqual(["continuity-recorder"]);
		expect(cc?.rounds[1]?.roles).toContain("continuity-recorder");
		expect(cc?.rounds[1]?.roles).toContain("continuity-auditor");
		expect(cc?.maxAgents).toBe(2);
	});
	it("documents the main agent as captain in prompts and playbooks", () => {
		const indexSource = fs.readFileSync(path.join(teamExtensionDir, "index.ts"), "utf-8");
		const plannerSource = fs.readFileSync(path.join(teamExtensionDir, "semantic-planner.ts"), "utf-8");
		const researchPlaybook = fs.readFileSync(path.join(defaultsDir, "playbooks", "research-roundtable.md"), "utf-8");
		expect(indexSource).toContain("You are the team captain");
		expect(indexSource).toContain("Plan-Do-Check-Act");
		expect(indexSource).toContain("model capability facts");
		expect(indexSource).not.toContain("model capability scores");
		expect(indexSource).toContain("Captain instruction");
		expect(plannerSource).toContain("The lead captain owns progress");
		expect(researchPlaybook).toContain("The captain");
		expect(researchPlaybook).toContain("owns the final recommendation");
	});
	it("loads playbook hints with legacy triggers fallback for captain-visible metadata only", () => {
		const projectPlaybooks = path.join(tempDir, ".pi/team/playbooks");
		fs.mkdirSync(projectPlaybooks, { recursive: true });
		fs.writeFileSync(
			path.join(projectPlaybooks, "legacy.md"),
			[
				"---",
				"id: legacy",
				"title: Legacy Playbook",
				"description: legacy trigger fallback",
				"triggers:",
				"  - old keyword",
				"---",
				"Legacy body",
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(projectPlaybooks, "modern.md"),
			[
				"---",
				"id: modern",
				"title: Modern Playbook",
				"description: hints win over triggers",
				"hints:",
				"  - captain-visible hint",
				"triggers:",
				"  - legacy keyword",
				"---",
				"Modern body",
			].join("\n"),
		);
		const resources = loadTeamResources(tempDir, defaultsDir);
		expect(resources.playbooks.find((playbook) => playbook.id === "legacy")?.hints).toEqual(["old keyword"]);
		expect(resources.playbooks.find((playbook) => playbook.id === "modern")?.hints).toEqual(["captain-visible hint"]);
	});

	it("adds a worker radio protocol without allowing nested team dispatch", () => {
		const prompt = workerRadioPrompt("Role prompt");
		expect(prompt).toContain("Team radio protocol");
		expect(prompt).toContain("Report progress to the captain");
		expect(prompt).toContain("RADIO:");
		expect(prompt).toContain("ack=<request-id>");
		expect(prompt).toContain("Do not spawn subagents or start nested team runs");
		expect(prompt).toContain("keep final output concise");
	});

	it("injects worker runtime context so teammates can report model, tools, and mailbox", () => {
		const prompt = workerRadioPrompt("Role prompt", {
			runId: "team_test",
			tools: ["web_search", "fetch_content"],
			mailboxFile: path.join(tempDir, ".pi/team/active/team_test/mailbox.jsonl"),
			mailboxTextFile: path.join(tempDir, ".pi/team/active/team_test/mailbox.txt"),
			role: {
				roleId: "source-reader",
				title: "Source reader",
				description: "Read official sources",
				capabilityNeeds: ["research", "tool_use"],
				task: "Read sources",
				tools: ["web_search"],
				systemPrompt: "Read sources",
				modelPreferences: [],
				selectedModel: "provider-f/model-f",
			},
		});
		expect(prompt).toContain("Worker runtime context");
		expect(prompt).toContain("Run id: team_test");
		expect(prompt).toContain("Role id: source-reader");
		expect(prompt).toContain("Requested/executed model: provider-f/model-f");
		expect(prompt).toContain("Available tools: web_search, fetch_content");
		expect(prompt).toContain("Mailbox file (human-readable):");
		expect(prompt).toContain("read` tool");
	});

	it("distinguishes explicit radio reports and parses captain request acknowledgments", () => {
		expect(isRadioReport("RADIO: status=started")).toBe(true);
		expect(isRadioReport("  RADIO: status=blocked")).toBe(true);
		expect(isRadioReport("Final answer without radio prefix")).toBe(false);
		expect(radioAcknowledgedRequestIds("RADIO: ack=req-123; status=received")).toEqual(["req-123"]);
		expect(radioAcknowledgedRequestIds("RADIO: status=working")).toEqual([]);
	});

	it("lets project roles override default roles", () => {
		const projectRoles = path.join(tempDir, ".pi/team/roles");
		fs.mkdirSync(projectRoles, { recursive: true });
		fs.writeFileSync(
			path.join(projectRoles, "bull.md"),
			[
				"---",
				"id: bull",
				"title: 项目多头",
				"description: project override",
				"tools: read",
				"---",
				"",
				"Project role body",
			].join("\n"),
		);

		const resources = loadTeamResources(tempDir, defaultsDir);
		const bull = resources.roles.find((role) => role.id === "bull");
		expect(bull?.title).toBe("项目多头");
		expect(bull?.source).toBe("project");
		expect(bull?.body).toBe("Project role body");
	});

	it("skips invalid role files without breaking discovery", () => {
		const projectRoles = path.join(tempDir, ".pi/team/roles");
		fs.mkdirSync(projectRoles, { recursive: true });
		fs.writeFileSync(
			path.join(projectRoles, "bad.md"),
			["---", "id: bad", "---", "", "Missing title and description"].join("\n"),
		);
		const resources = loadTeamResources(tempDir, defaultsDir);
		expect(resources.diagnostics.filter((d) => d.includes("bad")).length).toBeGreaterThan(0);
	});

	it("surfaces invalid thinking level in role diagnostics", () => {
		const projectRoles = path.join(tempDir, ".pi/team/roles");
		fs.mkdirSync(projectRoles, { recursive: true });
		fs.writeFileSync(
			path.join(projectRoles, "overthinker.md"),
			["---", "id: overthinker", "title: Thinker", "description: overthinker", "thinking: ultra", "---", "", "Body"].join("\n"),
		);
		const resources = loadTeamResources(tempDir, defaultsDir);
		expect(resources.diagnostics.filter((d) => d.includes("Ignored invalid thinking level")).length).toBeGreaterThan(0);
	});

	it("stable sorts playbooks and roles for deterministic discovery", () => {
		const a1 = loadTeamResources(tempDir, defaultsDir).playbooks.map((p) => p.id).join(",");
		const a2 = loadTeamResources(tempDir, defaultsDir).playbooks.map((p) => p.id).join(",");
		expect(a1).toBe(a2);
	});

	it("fails visibly when an explicit retired or unknown playbook is requested", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		expect(selectPlaybook({ task: "research QQQ", playbook: "etf-research" }, resources.playbooks)).toBeUndefined();
		expect(() => createTeamPlan({ task: "research QQQ", playbook: "etf-research" }, resources)).toThrow("No team playbook available");
	});

	it("uses the generic research playbook as a non-semantic fallback", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const playbook = selectPlaybook({ task: "组队调研任意主题" }, resources.playbooks);
		expect(playbook?.id).toBe("research-roundtable");
		const plan = createTeamPlan({ task: "组队调研任意主题" }, resources);
		expect(plan.rounds[0]?.roles.map((role) => role.roleId)).toEqual([
			"scout",
			"perspective-advocate",
			"risk-skeptic",
			"evidence-checker",
		]);
	});

	it("honors explicit playbook selection", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const playbook = selectPlaybook(
			{ task: "review implementation trade-offs", playbook: "multi-angle-review" },
			resources.playbooks,
		);
		expect(playbook?.id).toBe("multi-angle-review");
	});

	it("uses lead-designed roles as a generated roundtable", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const plan = createTeamPlan(
			{
				task: "调研一个新产品方向",
				roles: [
					{ title: "用户研究员", description: "分析目标用户和使用场景" },
					{ title: "商业分析师", description: "分析商业价值和落地成本" },
				],
			},
			resources,
		);
		expect(plan.playbook.id).toBe("generated-blueprint");
		expect(plan.rounds[0]?.roles.map((role) => role.title)).toEqual(["用户研究员", "商业分析师"]);
		expect(plan.rounds[0]?.roles[0]?.systemPrompt).toContain("分析目标用户和使用场景");
	});

	it("builds and persists a traceable blueprint artifact from the actual team plan", async () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const plan = createTeamPlan({ task: "review team extension", playbook: "code-review" }, resources);
		const run: TeamRun = {
			runId: "team_artifact",
			task: "review team extension",
			playbookId: plan.playbook.id,
			status: "running",
			modelHealth: [],
			workers: [],
		};
		const artifact = buildBlueprintArtifact(plan, run, 123);

		expect(artifact).toMatchObject({
			blueprintId: "team_artifact-code-review",
			runId: "team_artifact",
			task: "review team extension",
			playbookId: "code-review",
			playbookTitle: plan.playbook.title,
			source: "generated",
			status: "draft",
			createdAt: 123,
			policy: plan.policy,
			outputContract: plan.playbook.outputContract,
			captainRationale: plan.policy.rationale,
		});
		expect(artifact.roles.length).toBeGreaterThan(0);
		expect(artifact.rounds.map((round) => round.roles).flat().length).toBeGreaterThan(0);

		const persisted = await persistBlueprintArtifact(tempDir, plan, run);
		const raw = fs.readFileSync(persisted.filePath, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toMatchObject({
			blueprintId: "team_artifact-code-review",
			runId: "team_artifact",
			status: "draft",
			source: "generated",
		});
		expect(path.relative(tempDir, persisted.filePath)).toContain(path.join(".pi", "team", "blueprints", "generated"));

		const promoted = await promoteBlueprintArtifact(tempDir, artifact.blueprintId, "captain judged reusable", 456);
		expect(path.relative(tempDir, promoted.filePath)).toContain(path.join(".pi", "team", "blueprints", "promoted"));
		expect(promoted.artifact).toMatchObject({
			blueprintId: artifact.blueprintId,
			source: "promoted",
			status: "promoted",
			promotedFromBlueprintId: artifact.blueprintId,
			promotedFromRunId: "team_artifact",
			promotedAt: 456,
			captainNote: "captain judged reusable",
		});
	});

	it("sanitizes blueprint artifact ids for file names", () => {
		expect(safeBlueprintId("..")).toBe("blueprint");
		expect(safeBlueprintId(" Team /../../ Weird.Id ")).toBe("team-weird-id");
		expect(safeBlueprintId("---")).toBe("blueprint");
	});

	it("parses a full semantic blueprint with policies, rounds, and model fit", () => {
		const blueprint = parseSemanticPlan(
			JSON.stringify({
				title: "Python 发布状态轻量验证",
				rationale: "用少量角色验证网络访问和事实边界",
				strategy: "先访问官方来源，再核查版本事实，最后交给主 Agent 汇总",
				roles: [
					{
						id: "official-source-reader",
						title: "官方来源读取员",
						capability: "读取官方网页并摘取事实",
						capabilityNeeds: ["research", "tool_use", "speed"],
						description: "访问 Python 官方来源",
						systemPrompt: "读取官方来源，报告 URL 和访问结果。",
						tools: ["web_search", "fetch_content", "team"],
						modelFit: "适合执行稳定、工具调用清楚的模型",
						modelPreferences: ["provider-f/model-f"],
					},
					{
						id: "evidence-synthesizer",
						title: "证据综合员",
						capability: "把事实压缩成短报告",
						description: "整合访问结果",
						systemPrompt: "综合已有事实，标出限制。",
						tools: ["read"],
						modelFit: "适合长上下文和综合能力强的模型",
					},
				],
				rounds: [
					{
						id: "collect-official-sources",
						type: "parallel",
						roles: ["official-source-reader"],
						goal: "拿到官方 URL 和关键事实",
					},
					{
						id: "synthesize-evidence",
						type: "single",
						roles: ["evidence-synthesizer"],
						goal: "形成简短中文结论",
					},
				],
				evidencePolicy: "只把成功访问的 URL 当证据",
				modelPolicy: "工具调用角色优先稳定模型",
				synthesisPolicy: "汇总保留访问失败限制",
				progressMilestones: ["来源访问", "事实核查", "汇总"],
				stopCriteria: "两轮均产生可读输出",
			}),
			["web_search", "fetch_content"],
			4,
		);

		expect(blueprint?.title).toBe("Python 发布状态轻量验证");
		expect(blueprint?.roles[0]?.id).toBe("official-source-reader");
		expect(blueprint?.roles[0]?.tools).toEqual(["web_search", "fetch_content"]);
		expect(blueprint?.roles[0]?.capabilityNeeds).toEqual(["research", "tool_use", "speed"]);
		expect(blueprint?.roles[0]?.modelFit).toContain("工具调用");
		expect(blueprint?.roles[0]?.modelPreferences).toEqual([]);
		expect(blueprint?.rounds.map((round) => round.id)).toEqual(["collect-official-sources", "synthesize-evidence"]);
		expect(blueprint?.evidencePolicy).toContain("URL");
	});

	it("turns a semantic blueprint into executable rounds and carries policies", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const blueprint = parseSemanticPlan(
			JSON.stringify({
				title: "动态技术调研",
				rationale: "按任务语义生成蓝本",
				strategy: "先检索，再综合",
				roles: [
					{
						id: "source-reader",
						title: "来源读取员",
						capability: "访问资料",
						capabilityNeeds: ["research", "tool_use"],
						description: "读取来源",
						systemPrompt: "读取来源。",
						tools: ["web_search"],
						modelFit: "工具稳定性",
					},
					{
						id: "synthesizer",
						title: "综合员",
						capability: "综合判断",
						description: "综合资料",
						systemPrompt: "综合输出。",
						tools: ["read"],
						modelFit: "综合推理",
					},
				],
				rounds: [
					{ id: "collect", type: "parallel", roles: ["source-reader"], goal: "读取来源" },
					{ id: "synthesize", type: "single", roles: ["synthesizer"], goal: "综合输出" },
				],
				evidencePolicy: "证据策略",
				modelPolicy: "模型策略",
				synthesisPolicy: "综合策略",
				progressMilestones: ["读取", "综合"],
				stopCriteria: "完成两轮",
			}),
			["web_search"],
			4,
		);
		expect(blueprint).toBeDefined();

		const plan = createTeamPlan({ task: "调研 Python 3.14", roles: blueprint?.roles }, resources, blueprint);

		expect(plan.playbook.id).toBe("generated-blueprint");
		expect(plan.rounds.map((round) => `${round.id}:${round.type}:${round.goal}`)).toEqual([
			"collect:parallel:读取来源",
			"synthesize:single:综合输出",
		]);
		expect(plan.rounds[0]?.roles[0]?.roleId).toBe("source-reader");
		expect(plan.rounds[0]?.roles[0]?.capability).toBe("访问资料");
		expect(plan.rounds[0]?.roles[0]?.capabilityNeeds).toEqual(["research", "tool_use"]);
		expect(plan.rounds[0]?.roles[0]?.modelFit).toBe("工具稳定性");
		expect(plan.policy.strategy).toBe("先检索，再综合");
		expect(plan.policy.progressMilestones).toEqual(["读取", "综合"]);
		expect(plan.synthesis.task).toContain("综合策略");
	});

	it("places a mandatory captain pre-delivery checklist before worker outputs when workers fail", () => {
		const workers: WorkerRun[] = [
			{
				roleId: "a",
				title: "Succeeded Worker",
				task: "A",
				status: "succeeded",
				output: "ok",
			},
			{
				roleId: "b",
				title: "Failed Worker",
				task: "B",
				status: "skipped",
				output: "",
				errorReason: "aborted",
			},
		];
		const outcome = { status: "degraded" as const, warnings: [] };
		const checklist = buildCaptainPreDelivery(workers, outcome);

		expect(checklist).toContain("DEGRADED");
		expect(checklist).toContain("Failed Worker");
		expect(checklist).toContain("aborted");
		expect(checklist).toContain("Action required");
		expect(checklist).toContain("Succeeded Worker");
	});

	it("labels captain-stopped runs as partial evidence, not ordinary failure", () => {
		const workers: WorkerRun[] = [
			{
				roleId: "risk",
				title: "Risk Analyst",
				task: "Find risks",
				status: "skipped",
				output: "RADIO: found partial risks",
				outputKind: "radio_only",
				errorReason: "aborted",
				cancelObservedAt: 123,
			},
		];
		const checklist = buildCaptainPreDelivery(workers, { status: "stopped", warnings: [] });
		expect(checklist).toContain("CAPTAIN-STOPPED");
		expect(checklist).toContain("partial teammate evidence");
		expect(checklist).toContain("was stopped before a final teammate memo");
		expect(checklist).toContain("tell the user this perspective was captain-stopped");
	});

	it("builds a foreground digest without dumping full worker output", () => {
		const longOutput = "detailed evidence ".repeat(80);
		const summary = buildFinalSummary([
			{
				roleId: "reviewer",
				title: "Reviewer",
				task: "Review",
				status: "succeeded",
				output: longOutput,
				lastOutputPreview: "short factual preview",
				model: "provider-b/model-b-pro",
				routingReason: "policy=task_first; selected via metadata; captain remains final judge",
				modelFallbackKeys: ["provider-b/model-b"],
				outputFile: "/artifacts/reviewer.md",
			},
		], { status: "succeeded", warnings: [] });
		expect(summary).toContain("Worker evidence digest");
		expect(summary).toContain("Route: policy=task_first");
		expect(summary).toContain("Fallbacks: provider-b/model-b");
		expect(summary).toContain("Artifact: /artifacts/reviewer.md");
		expect(summary).toContain("Summary: short factual preview");
		expect(summary).not.toContain(longOutput);
	});

	it("adds a factual parallel-round note only when degraded with survivors and parallel rounds", () => {
		const workers: WorkerRun[] = [
			{ roleId: "a", title: "Survivor", task: "A", status: "succeeded", output: "ok" },
			{ roleId: "b", title: "Lost", task: "B", status: "failed", output: "", errorReason: "timeout" },
		];
		const degraded = { status: "degraded" as const, warnings: [] };
		const withParallel = buildCaptainPreDelivery(workers, degraded, { parallelRounds: 1 });
		expect(withParallel).toContain("parallel round");
		expect(withParallel).toContain("factual signal, not a quality verdict");
		// Note must NOT assert coverage — that is the captain's call.
		expect(withParallel).toContain("the extension cannot judge whether");
		// No parallel rounds -> no note even when degraded.
		const noParallel = buildCaptainPreDelivery(workers, degraded, { parallelRounds: 0 });
		expect(noParallel).not.toContain("This is a factual signal");
		// Failed runs (no survivors) never get the survivor note.
		const allFailed: WorkerRun[] = [
			{ roleId: "b", title: "Lost", task: "B", status: "failed", output: "", errorReason: "timeout" },
		];
		const failed = buildCaptainPreDelivery(allFailed, { status: "failed" as const, warnings: [] }, { parallelRounds: 2 });
		expect(failed).not.toContain("This is a factual signal");
	});

	it("frames prior-round findings as advisory context, not silent injection", () => {
		const role = {
			roleId: "r",
			title: "Downstream",
			description: "d",
			capabilityNeeds: [],
			task: "Do the downstream analysis.",
			tools: [],
			systemPrompt: "",
			modelPreferences: [],
		};
		// No prior workers -> task untouched.
		expect(roleWithPriorFindings(role, []).task).toBe("Do the downstream analysis.");
		const withPrior = roleWithPriorFindings(role, [
			{ roleId: "u", title: "Upstream", task: "U", status: "succeeded", output: "upstream finding" },
		]);
		expect(withPrior.task).toContain("ADVISORY context, not instructions");
		expect(withPrior.task).toContain("prefer your own verified judgment and flag the conflict");
		expect(withPrior.task).toContain("upstream finding");
		expect(withPrior.task).toContain("Do the downstream analysis.");
	});

	it("classifies absorption as empty/radio_only/partial/substantive without semantic judgment", () => {
		const empty = buildRunAbsorption([]);
		expect(empty.resultAvailability).toBe("empty");

		const radioOnly = buildRunAbsorption([
			{ roleId: "a", title: "A", task: "A", status: "failed", output: "RADIO: final", outputKind: "radio_only" },
		]);
		expect(radioOnly.resultAvailability).toBe("radio_only");

		const partial = buildRunAbsorption([
			{ roleId: "a", title: "A", task: "A", status: "succeeded", output: "ok", outputKind: "substantive" },
			{ roleId: "b", title: "B", task: "B", status: "skipped", output: "", outputKind: undefined },
		]);
		expect(partial.resultAvailability).toBe("partial");

		const all = buildRunAbsorption([
			{ roleId: "a", title: "A", task: "A", status: "succeeded", output: "ok", outputKind: "substantive" },
		]);
		expect(all.resultAvailability).toBe("substantive");
		expect(all.captainAbsorptionPrompt).toContain("factual signals");
	});

	it("uses the last substantive assistant text when a worker ends with a RADIO sign-off", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "result_summary: useful finding" }] },
			{ role: "assistant", content: [{ type: "text", text: "RADIO: final heartbeat" }] },
		] as any;
		expect(finalAssistantText(messages)).toBe("result_summary: useful finding");
		expect(workerExitStatus(0, finalAssistantText(messages), false)).toBe("succeeded");
	});

	it("treats aborted, timed-out, empty, and RADIO-only worker outputs as non-success", () => {
		expect(workerOutputKind("")).toBe("empty");
		expect(workerOutputKind("RADIO: started\nRADIO: final")).toBe("radio_only");
		expect(workerOutputKind("RADIO: evidence found\nresult_summary: usable finding")).toBe("substantive");
		expect(workerExitStatus(0, "final output", true)).toBe("skipped");
		expect(workerExitStatus(0, "final output", false, true)).toBe("failed");
		expect(workerExitStatus(0, "RADIO: final", false)).toBe("failed");
		expect(workerExitStatus(0, "final output", false)).toBe("succeeded");
		expect(workerExitStatus(1, "", false)).toBe("failed");
	});

	it("builds deterministic per-role session ids and sanitizes unsafe path chars", () => {
		expect(workerSessionId("team_abc", "reviewer")).toBe("team-team_abc-reviewer");
		expect(workerSessionId("team_abc", "reviewer")).toBe(workerSessionId("team_abc", "reviewer"));
		expect(workerSessionId("team_abc", "a/b")).toBe("team-team_abc-a_b");
		expect(workerSessionId("team_abc", "a:b")).toBe("team-team_abc-a_b");
		expect(workerSessionId("team_abc", "../evil")).toBe("team-team_abc-_evil");
		expect(workerSessionId("../bad", "role")).toBe("team-_bad-role");
		expect(workerSessionId("", "")).toBe("team-run-role");
	});

	it("dedups duplicate roleIds within a round to prevent shared-session corruption", () => {
		const first = dedupRoundRoles([
			{ roleId: "reviewer" },
			{ roleId: "reviewer" },
			{ roleId: "scout" },
		]);
		expect(first.roles.map((r) => r.roleId)).toEqual(["reviewer", "scout"]);
		expect(first.dropped).toBe(1);
		const none = dedupRoundRoles([{ roleId: "a" }, { roleId: "b" }]);
		expect(none.dropped).toBe(0);
	});

	it("classifies all-skipped, all-failed, empty, and partial-skipped team runs without false success", () => {
		expect(determineTeamRunOutcome([])).toEqual({
			status: "failed",
			warnings: ["no workers were planned or recorded"],
		});
		expect(
			determineTeamRunOutcome([
				{
					roleId: "a",
					title: "A",
					task: "A",
					status: "failed",
					output: "",
					errorReason: "exit code 1",
				},
			]),
		).toEqual({
			status: "failed",
			warnings: ["all workers failed; no usable teammate evidence"],
		});
		expect(
			determineTeamRunOutcome([
				{
					roleId: "a",
					title: "A",
					task: "A",
					status: "skipped",
					output: "",
					errorReason: "aborted",
				},
			]),
		).toEqual({
			status: "stopped",
			warnings: ["captain stopped all workers before final teammate outputs; only partial/RADIO evidence may be available"],
		});
		expect(
			determineTeamRunOutcome([
				{
					roleId: "a",
					title: "A",
					task: "A",
					status: "skipped",
					output: "",
					errorReason: "no healthy model",
				},
			]),
		).toEqual({
			status: "failed",
			warnings: ["all workers were skipped or aborted; no usable teammate evidence"],
		});
		expect(
			determineTeamRunOutcome([
				{ roleId: "a", title: "A", task: "A", status: "succeeded", output: "ok" },
				{ roleId: "b", title: "B", task: "B", status: "skipped", output: "", errorReason: "aborted" },
			]),
		).toEqual({
			status: "degraded",
			warnings: ["1 worker(s) captain-stopped before final teammate output"],
		});
		expect(
			determineTeamRunOutcome([
				{
					roleId: "a",
					title: "A",
					task: "A",
					status: "failed",
					output: "RADIO: final",
					outputKind: "radio_only",
					timedOut: true,
					streamParseErrorCount: 2,
					errorReason: "worker timed out",
				},
			]),
		).toEqual({
			status: "failed",
			warnings: [
				"1 worker(s) timed out",
				"1 worker(s) produced only RADIO progress reports",
				"1 worker(s) had malformed event stream lines",
				"all workers failed; no usable teammate evidence",
			],
		});
	});

	it("uses role tools as a hard whitelist and excludes delegation tools", () => {
		// Non-empty role.tools is a hard whitelist (intersection with inherited).
		expect(
			resolveWorkerTools(
				["read", "bash", "Agent", "steer_subagent", "team_cancel"],
				[
					"web_explore",
					"team",
					"team_status",
					"team_message",
					"read",
					"subagent",
					"workflow",
					"get_subagent_result",
				],
			),
		).toEqual(["read"]);
	});

	it("prevents read-only role from inheriting bash, edit, or write", () => {
		// A role with only read/grep/find must not receive bash/edit/write
		// even when inherited tools include them.
		expect(
			resolveWorkerTools(
				["read", "grep", "find"],
				["read", "grep", "find", "bash", "edit", "write", "ls"],
			),
		).toEqual(["find", "grep", "read"]);
	});

	it("returns empty array when role tools have no intersection with inherited", () => {
		// Non-empty role.tools with zero overlap should return [].
		// The caller must skip the worker, not give it full default tools.
		expect(
			resolveWorkerTools(
				["agent", "team_cancel"],
				["read", "grep", "find", "bash"],
			),
		).toEqual([]);
	});

	it("falls back to inherited tools when role declares no tools", () => {
		// Empty role.tools inherits all captain tools (backward compatible).
		expect(
			resolveWorkerTools(
				[],
				["read", "grep", "find", "bash", "edit", "write"],
			),
		).toEqual(["bash", "edit", "find", "grep", "read", "write"]);
	});

	it("resolves pi command path from current script, node/bun runtime, or fallback", () => {
		// piInvocation always returns { command, args }.
		const result = piInvocation(["--mode", "json"]);
		expect(result).toHaveProperty("command");
		expect(result).toHaveProperty("args");
		expect(result.args).toContain("--mode");
		expect(result.args).toContain("json");
		expect(typeof result.command).toBe("string");
	});

	it("writes request-addressable captain mailbox messages and cancel requests for active team runs", async () => {
		const written = await appendTeamMessage(tempDir, "team_test", "请先核查官方来源。");
		const messages = await readTeamMailbox(tempDir, "team_test");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toBe("请先核查官方来源。");
		expect(messages[0]?.messageRef).toBe(written.requestId);
		const mirror = fs.readFileSync(teamControlPaths(tempDir, "team_test").mailboxTextFile, "utf-8");
		expect(mirror).toContain(`request=${written.requestId}`);
		expect(await listTeamRunIds(tempDir)).toContain("team_test");
		expect(isTeamCancelRequested(tempDir, "team_test")).toBe(false);
		await requestTeamCancel(tempDir, "team_test", "队长取消");
		expect(isTeamCancelRequested(tempDir, "team_test")).toBe(true);
	});

	it("writes targeted requests without creating broadcast ACK debt", async () => {
		const written = await appendTeamMessage(tempDir, "team_target", "focus now", { targetRoleId: "reviewer-a" });
		const messages = await readTeamMailbox(tempDir, "team_target");
		expect(messages[0]).toMatchObject({
			messageRef: written.requestId, targetRoleId: "reviewer-a", broadcast: false,
		});
		expect(teamMailboxMessageAddressesRole(messages[0]!, "reviewer-a")).toBe(true);
		expect(teamMailboxMessageAddressesRole(messages[0]!, "reviewer-b")).toBe(false);
		const mirror = fs.readFileSync(teamControlPaths(tempDir, "team_target").mailboxTextFile, "utf-8");
		expect(mirror).toContain("target=reviewer-a");
	});

	it("team_message targets one active worker without creating debt for peers", async () => {
		const extension = registerTeamExtension();
		await writeTeamState(tempDir, {
			runId: "team_target_tool", task: "target", playbookId: "generated-blueprint", status: "running",
			modelHealth: [], events: [], workers: [
				{ roleId: "a", title: "A", task: "a", status: "running", output: "", startedAt: 1 },
				{ roleId: "b", title: "B", task: "b", status: "running", output: "", startedAt: 1 },
			],
		});
		const response = await extension.tools.get("team_message")!.execute(
			"message-target", { runId: "team_target_tool", roleId: "a", message: "focus" }, undefined, undefined, { cwd: tempDir } as any,
		);
		expect(response.isError).not.toBe(true);
		const messages = await readTeamMailbox(tempDir, "team_target_tool");
		expect(messages[0]).toMatchObject({ targetRoleId: "a", broadcast: false });
		const overlaid = await readTeamRunWithControlOverlay(tempDir, "team_target_tool");
		expect(overlaid?.workers[0]).toMatchObject({ lastCaptainMessageRef: messages[0]!.messageRef });
		expect(overlaid?.workers[1]?.lastCaptainMessageRef).toBeUndefined();
		await extension.handlers.get("session_shutdown")![0]({});
	});

	it("projects a persisted worker cancel request before the worker observes it", async () => {
		await writeTeamState(tempDir, {
			runId: "team_cancel_overlay", task: "cancel", playbookId: "generated-blueprint", status: "running",
			modelHealth: [], events: [], workers: [
				{ roleId: "a", title: "A", task: "a", status: "running", output: "", startedAt: 1 },
			],
		});
		await requestWorkerCancel(tempDir, "team_cancel_overlay", "a", "stop");
		const overlaid = await readTeamRunWithControlOverlay(tempDir, "team_cancel_overlay");
		expect(overlaid?.workers[0]?.cancelRequestedAt).toEqual(expect.any(Number));
		expect(overlaid?.workers[0]?.cancelObservedAt).toBeUndefined();
		const projection = buildTeamStatusProjection(overlaid!, [], Date.now() + 120_000);
		expect(projection.workers[0]).toMatchObject({ attentionDebt: true });
	});

	it("keeps system mailbox notices out of the worker-visible mirror", async () => {
		await appendTeamMessage(tempDir, "team_sys", "[pi-team decision window] system notice", { system: true });
		await appendTeamMessage(tempDir, "team_sys", "captain says hello");
		const messages = await readTeamMailbox(tempDir, "team_sys");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.system).toBe(true);
		expect(messages[1]?.system).toBeUndefined();
		const mirror = fs.readFileSync(teamControlPaths(tempDir, "team_sys").mailboxTextFile, "utf-8");
		expect(mirror).not.toContain("system notice");
		expect(mirror).toContain("captain says hello");
	});

	it("reads active team state and falls back to the persisted run log", async () => {
		const activeRun: TeamRun = {
			runId: "team_state",
			task: "review",
			playbookId: "generated-blueprint",
			status: "running",
			modelHealth: [],
			workers: [],
			events: [{ phase: "run-start", message: "started" }],
		};
		await writeTeamState(tempDir, activeRun);
		expect((await readTeamState(tempDir, "team_state"))?.status).toBe("running");

		const loggedRun: TeamRun = { ...activeRun, status: "succeeded", events: [{ phase: "run-log", message: "done" }] };
		fs.rmSync(path.join(tempDir, ".pi", "team", "active", "team_state", "state.json"));
		fs.mkdirSync(teamRunLogDir(tempDir), { recursive: true });
		fs.writeFileSync(path.join(teamRunLogDir(tempDir), "team_state.json"), `${JSON.stringify(loggedRun)}\n`);
		expect((await readTeamState(tempDir, "team_state"))?.status).toBe("succeeded");
	});

	it("refreshes auth and model registry before team routing", () => {
		const calls: string[] = [];
		refreshTeamModelRegistry({
			modelRegistry: {
				authStorage: { reload: () => calls.push("auth.reload") },
				refresh: () => calls.push("model.refresh"),
			},
		} as any);
		expect(calls).toEqual(["auth.reload", "model.refresh"]);
	});

	it("refreshes an Oh My Pi-style registry without authStorage", () => {
		const calls: string[] = [];
		expect(() => refreshTeamModelRegistry({
			modelRegistry: { refresh: () => calls.push("model.refresh") },
		} as any)).not.toThrow();
		expect(calls).toEqual(["model.refresh"]);
	});

	it("routes roles only to models that passed live probe", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const plan = createTeamPlan({ task: "research QQQ", playbook: "research-roundtable" }, resources);
		const gpt = testModel("provider-e", "model-e", true);
		const glm = testModel("provider-f", "model-f", true);
		const health: ModelHealthSnapshot[] = [
			passed(gpt),
			{
				model: modelKey(glm),
				provider: glm.provider,
				status: "provider_error",
				latencyMs: 10,
				checkedAt: 1,
				reason: "upstream failure",
			},
		];

		const routed = routeTeamPlan(plan, [gpt, glm], health);
		const firstRole = routed.rounds[0]?.roles[0];
		expect(firstRole?.selectedModel).toBe("provider-e/model-e");
		expect(firstRole?.fallbackReason).toBeUndefined();
	});

	it("loads concrete capability profiles only from user or project configuration", () => {
		expect(fs.existsSync(path.join(defaultsDir, "model-capabilities.json"))).toBe(false);
		const configDir = path.join(tempDir, ".pi", "team");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "model-capabilities.json"), JSON.stringify({ profiles: [{
			family: "local-review-family",
			models: ["provider-a/model-a"],
			aliases: ["model-a"],
			capabilities: ["coding", "critical_review"],
			strengths: ["project verified review behavior"],
		}] }));
		const profiles = loadModelCapabilityProfiles(tempDir);
		const profile = profileForModel("provider-a/model-a", "model-a", profiles);
		expect(profile).toMatchObject({
			family: "local-review-family", capabilities: ["coding", "critical_review"],
		});
	});

	it("uses local capability profiles as evidence without replacing captain preference", () => {
		const preferred = testModel("provider-a", "model-a", true);
		const alternative = testModel("provider-b", "model-b", true);
		const configDir = path.join(tempDir, ".pi", "team");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "model-capabilities.json"), JSON.stringify({ profiles: [{
			family: "local-research-family", models: ["provider-a/model-a"], aliases: [],
			capabilities: ["research", "tool_use"], strengths: ["locally verified research"],
		}] }));
		const role: PlannedRole = {
			roleId: "source-reader",
			title: "Source reader",
			description: "Read sources",
			capabilityNeeds: ["research", "tool_use", "speed"],
			task: "Read sources",
			tools: ["web_search"],
			systemPrompt: "Read sources",
			modelPreferences: ["provider-a/model-a"],
		};
		const routed = selectModelForRole(role, [preferred, alternative], [passed(preferred), passed(alternative)], new Set());
		expect(routed.model?.provider).toBe("provider-a");
		const plan = routeTeamPlan(
			{
				objective: "research",
				playbook: {
					id: "generated-blueprint",
					title: "Generated",
					description: "Generated",
					hints: [],
					defaultMode: "research",
					maxAgents: 2,
					rounds: [],
					outputContract: "findings",
					body: "",
					source: "project",
					filePath: "(generated)",
				},
				rounds: [{ id: "collect", type: "parallel", roles: [role] }],
				policy: {
					rationale: "r",
					strategy: "s",
					evidencePolicy: "e",
					modelPolicy: "m",
					synthesisPolicy: "s",
					progressMilestones: [],
					stopCriteria: "done",
				},
				synthesis: { task: "s", requiredSections: [] },
			},
			[preferred, alternative],
			[passed(preferred), passed(alternative)],
			loadModelCapabilityProfiles(tempDir),
		);
		expect(routed.model?.id).toBe("model-a");
		expect(plan.rounds[0]?.roles[0]?.routingReason).toContain("lead preference provider-a/model-a");
		expect(plan.rounds[0]?.roles[0]?.routingReason).toContain("lead remains final judge");
	});

	it("keeps timeout probes as lead-observed status without blocking dispatch", () => {
		const model = testModel("provider-x", "model-x", true);
		const role = {
			roleId: "reviewer",
			title: "Reviewer",
			description: "Review the result",
			capabilityNeeds: [],
			task: "Review",
			tools: ["read"],
			systemPrompt: "Review",
			modelPreferences: ["provider-x/model-x"],
		};
		const result = selectModelForRole(
			role,
			[model],
			[
				{
					model: "provider-x/model-x",
					provider: "provider-x",
					status: "timeout",
					latencyMs: 20_000,
					checkedAt: 1,
				},
			],
			new Set(),
		);
		expect(result.model).toBe(model);
		expect(result.fallbackReason).toBeUndefined();
	});

	it("uses availability facts to skip objectively unavailable preferred models", () => {
		const gpt = testModel("provider-e", "model-e", true);
		const glm = testModel("provider-f", "model-f", true);
		const role: PlannedRole = {
			roleId: "researcher",
			title: "Researcher",
			description: "Research",
			capabilityNeeds: ["research"],
			task: "Research",
			tools: ["web_search"],
			systemPrompt: "Research",
			modelPreferences: ["provider-e/model-e"],
		};
		const result = selectModelForRole(
			role,
			[gpt, glm],
			[
				{
					model: "provider-e/model-e",
					provider: "provider-e",
					status: "missing_auth",
					latencyMs: 10,
					checkedAt: 1,
				},
				passed(glm),
			],
			new Set(),
		);
		expect(result.model?.provider).toBe("provider-f");
		expect(result.fallbackReason).toContain("preferred models unavailable");
	});

	it("avoids objectively unavailable models", () => {
		const model = testModel("provider-x", "model-x", true);
		const role = {
			roleId: "reviewer",
			title: "Reviewer",
			description: "Review the result",
			capabilityNeeds: [],
			task: "Review",
			tools: ["read"],
			systemPrompt: "Review",
			modelPreferences: ["provider-x/model-x"],
		};
		const result = selectModelForRole(
			role,
			[model],
			[
				{
					model: "provider-x/model-x",
					provider: "provider-x",
					status: "missing_auth",
					latencyMs: 10,
					checkedAt: 1,
					reason: "missing key",
				},
			],
			new Set(),
		);
		expect(result.model).toBeUndefined();
		expect(result.fallbackReason).toBe("all configured models are objectively unavailable");
	});

	it("registers the Pi extension command and tools", () => {
		const result = registerTeamExtension();
		expect(result.commands.has("team")).toBe(true);
		expect(result.tools.has("team")).toBe(true);
		expect(result.tools.has("team_status")).toBe(true);
		expect(result.tools.has("team_message")).toBe(true);
		expect(result.tools.has("team_cancel")).toBe(true);
		expect(result.tools.has("team_promote_blueprint")).toBe(true);
		expect(result.tools.has("team_cancel_worker")).toBe(true);
		expect(result.handlers.get("agent_start")).toHaveLength(1);
		expect(result.handlers.get("agent_end")).toHaveLength(1);
	});

	it("clears queued state write errors after a later successful write", async () => {
		const writes: TeamRun[] = [];
		let calls = 0;
		const writer = createQueuedStateWriter(async (snapshot) => {
			calls += 1;
			if (calls === 1) throw new Error("disk full");
			writes.push(snapshot);
		});
		const failedSnapshot: TeamRun = {
			runId: "team_state_error",
			task: "first write fails",
			playbookId: "generated-blueprint",
			status: "running",
			modelHealth: [],
			workers: [],
			events: [],
		};
		writer.queue(failedSnapshot);
		writer.queue({
			...failedSnapshot,
			task: "later write succeeds",
			stateWriteError: "failed to write team state: stale error",
		});

		await expect(writer.flush()).resolves.toBeUndefined();
		expect(writes).toHaveLength(1);
		expect(writes[0]?.task).toBe("later write succeeds");
		expect(writes[0]?.stateWriteError).toBeUndefined();
		expect(writer.currentError()).toBeUndefined();
	});

	it("builds a captain-facing team status projection without choosing next actions", () => {
		const projection = buildTeamStatusProjection(
			{
				runId: "team_status_projection",
				task: "observe",
				playbookId: "generated-blueprint",
				status: "running",
				modelHealth: [
					{ model: "provider/model", provider: "provider", status: "probe_passed", evidenceSource: "probe", latencyMs: 10, checkedAt: 1 },
				],
				workers: [
					{
						roleId: "slow",
						title: "Slow Worker",
						task: "work",
						model: "provider/model",
						status: "running",
						output: "",
						startedAt: 1_000,
						lastSignalAt: 1_000,
						lastReportAt: 5_000,
						lastCaptainMessageAt: 9_000,
						lastCaptainMessageRef: "req-status",
						lastCaptainDeliveredAt: 10_000,
						lastCaptainDeliveredRef: "req-status",
						lastEvent: "worker-start",
						outputKind: "empty",
						tools: ["read"],
						activeTools: ["read"],
						streamParseErrorCount: 2,
						requests: 2,
						tokens: 100,
						costUsd: 0.01,
					},
					{
						roleId: "done",
						title: "Done Worker",
						task: "work",
						status: "succeeded",
						output: "result",
						startedAt: 1_000,
						endedAt: 5_000,
						lastTool: "read",
						outputKind: "substantive",
						activeTools: ["read", "bash"],
						toolIsolationViolation: "active tools exceed role whitelist: bash",
						events: [
							{ phase: "worker-tool", message: "Done Worker tool_execution_start read", toolName: "read" },
							{ phase: "worker-tool", message: "Done Worker tool_execution_end read failed", toolName: "read", isError: true },
						],
						requests: 1,
						tokens: 50,
						costUsd: 0.02,
					},
				],
				events: [{ phase: "run-evidence-warning", message: "1 worker(s) had malformed event stream lines" }],
			},
			[{ at: 4_000, message: "check source" }],
			30_000,
		);

		expect(projection.counts).toMatchObject({ total: 2, active: 1, succeeded: 1, stale: 1, parseErrors: 2, toolViolations: 1, toolCalls: 1, toolErrors: 1, requests: 3, tokens: 150, costUsd: 0.03 });
		expect(projection.workers[0]).toMatchObject({
			activeTools: ["read"], communicationAgeSeconds: 25,
			pendingAckRef: "req-status", pendingAckAgeSeconds: 20,
		});
		expect(projection.ackGroups).toEqual([expect.objectContaining({
			requestRef: "req-status", total: 1, delivered: 1, acked: 0,
			pendingAckRoleIds: ["slow"], pendingDeliveryRoleIds: [],
		})]);
		expect(projection.workers[1]).toMatchObject({ toolCallCount: 1, toolErrorCount: 1 });
		expect(projection.workers[1]?.toolIsolationViolation).toContain("bash");
		expect(projection.modelHealth[0]?.evidenceSource).toBe("probe");
		expect(projection.mailbox.lastMessagePreview).toBe("check source");
		expect(projection.evidenceWarnings).toEqual(["1 worker(s) had malformed event stream lines"]);
		expect(projection.controls).toEqual(["team_message", "team_cancel_worker", "team_spawn_worker", "team_cancel"]);
	});

	it("aggregates broadcast request delivery and ACK state across workers", () => {
		const makeWorker = (roleId: string, delivered: boolean, acked: boolean): WorkerRun => ({
			roleId, title: roleId, task: roleId, status: "running", output: "", startedAt: 0,
			lastCaptainMessageAt: 1_000, lastCaptainMessageRef: "req-broadcast",
			lastCaptainDeliveredAt: delivered ? 2_000 : undefined,
			lastCaptainDeliveredRef: delivered ? "req-broadcast" : undefined,
			lastCaptainAckAt: acked ? 3_000 : undefined,
			lastCaptainAckRef: acked ? "req-broadcast" : undefined,
		});
		const completedAck = { ...makeWorker("d", true, true), status: "succeeded" as const, output: "done", endedAt: 4_000 };
		const pendingDelivery = { ...makeWorker("e", false, false), status: "pending" as const };
		const run: TeamRun = {
			runId: "team_ack_group", task: "observe", playbookId: "generated-blueprint", status: "running",
			modelHealth: [], workers: [makeWorker("a", true, true), makeWorker("b", true, false), makeWorker("c", false, false), completedAck, pendingDelivery],
		};
		expect(buildTeamStatusProjection(run, [], 5_000).ackGroups).toEqual([{
			requestRef: "req-broadcast", total: 5, delivered: 3, acked: 2,
			deliveredRoleIds: ["a", "b", "d"], ackedRoleIds: ["a", "d"],
			pendingDeliveryRoleIds: ["c", "e"], pendingAckRoleIds: ["b"], terminalWithoutAckRoleIds: [],
		}]);
	});

	it("projects communication and request ages from the captain re-arm anchor", () => {
		const run: TeamRun = {
			runId: "team_rearm_projection", task: "observe", playbookId: "generated-blueprint", status: "running",
			modelHealth: [], workers: [{
				roleId: "a", title: "A", task: "a", status: "running", output: "", startedAt: 0,
				lastReportAt: 0, lastCaptainMessageAt: 0, lastCaptainMessageRef: "req-a",
				lastCaptainDeliveredAt: 0, lastCaptainDeliveredRef: "req-a",
			}], attentionState: { roles: {
				a: { communicationAt: 0, silenceAlerted: false, pendingRequestRef: "req-a", pendingAckAlerted: false, cancelAlerted: false, rearmAt: 25_000 },
			} },
		};
		const projection = buildTeamStatusProjection(run, [], 30_000);
		expect(projection.workers[0]).toMatchObject({
			communicationAgeSeconds: 5, pendingAckAgeSeconds: 5, attentionDebt: false, rearmAt: 25_000,
		});
	});

	it("projects controls for every run phase without treating synthesis as terminal", () => {
		const baseRun: TeamRun = {
			runId: "team_controls",
			task: "observe controls",
			playbookId: "generated-blueprint",
			status: "planning",
			modelHealth: [],
			workers: [],
			events: [],
		};
		for (const status of ["planning", "probing", "synthesizing"] as const) {
			expect(buildTeamStatusProjection({ ...baseRun, status }, []).controls).toEqual(["team_cancel"]);
		}
		expect(buildTeamStatusProjection({ ...baseRun, status: "running" }, []).controls).toEqual([
			"team_message", "team_cancel_worker", "team_spawn_worker", "team_cancel",
		]);
		for (const status of ["succeeded", "degraded", "stopped", "failed"] as const) {
			expect(buildTeamStatusProjection({ ...baseRun, status }, []).controls).toEqual([
				"team_handoff", "team_promote_blueprint",
			]);
		}
	});

	it("uses push-first next actions except during a model decision window", () => {
		expect(backgroundNextAction(false)).toBe("await_completion_push");
		expect(backgroundNextAction(true)).toBe("captain_model_decision");
	});

	it("renders team tool progress compactly with expandable worker details", () => {
		const result = registerTeamExtension();
		const team = result.tools.get("team");
		expect(team?.promptSnippet).toContain("Dispatch");
		expect(team?.promptGuidelines.join("\n")).toContain("push-first");
		expect(team?.promptGuidelines.join("\n")).toContain("Do not poll");
		expect(team?.promptGuidelines.join("\n")).not.toContain("frozen polls");
		expect(result.tools.get("team_status")?.promptGuidelines.join("\n")).toContain("do not use it as a timer");

		const run: TeamRun = {
			runId: "team_ui",
			task: "review output",
			playbookId: "code-review",
			status: "running",
			modelHealth: [],
			workers: [
				{
					roleId: "researcher",
					title: "Researcher",
					task: "find facts",
					model: "provider/model-y",
					status: "running",
					output: "",
					startedAt: 1_000,
					lastSignalAt: Date.now(),
					lastTool: "read",
				},
				{
					roleId: "reviewer",
					title: "Reviewer",
					task: "check facts",
					model: "provider/provider-b",
					status: "succeeded",
					output: "ok",
					startedAt: 1_000,
					endedAt: 3_000,
				},
			],
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		const compact = team!.renderResult(
			{ content: [{ type: "text", text: "unused" }], details: run },
			{ expanded: false, isPartial: true },
			theme,
			{} as any,
		).render(50);
		expect(compact).toHaveLength(1);
		expect(compact[0]).toContain("2 workers");
		expect(compact[0]).not.toContain("Researcher");
		expect(compact.every((line: string) => visibleWidth(line) <= 50)).toBe(true);

		const expanded = team!.renderResult(
			{ content: [{ type: "text", text: "unused" }], details: run },
			{ expanded: true, isPartial: false },
			theme,
			{} as any,
		).render(80);
		expect(expanded.join("\n")).toContain("Researcher");
		expect(expanded.join("\n")).toContain("Reviewer");
	});

	it("shows progressing and pending workers before every terminal worker", () => {
		const makeWorker = (roleId: string, status: WorkerRun["status"]): WorkerRun => ({
			roleId, title: roleId, task: roleId, status, output: status === "running" || status === "pending" ? "" : "done", startedAt: 1,
		});
		const run: TeamRun = {
			runId: "team_progress_first", task: "observe", playbookId: "generated-blueprint", status: "running", modelHealth: [],
			workers: [makeWorker("failed-source", "failed"), makeWorker("done-source", "succeeded"), makeWorker("running", "running"), makeWorker("pending", "pending")],
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		const lines = teamWidgetLines(run, theme);
		const expectedOrder = ["running", "pending", "failed-source", "done-source"];
		expect(lines[0]).toContain("custom-plan");
		expect(lines[0]).not.toContain("generated-blueprint");
		expect(lines.slice(1).map((line) => expectedOrder.find((id) => line.includes(id)))).toEqual(expectedOrder);
		expect(orderProjectedWorkers(buildTeamStatusProjection(run, []).workers).map((worker) => worker.roleId)).toEqual(expectedOrder);
	});

	it("distinguishes degraded workers from pending and counts them in compact TUI", () => {
		const run: TeamRun = {
			runId: "team_degraded_glyph", task: "x", playbookId: "p", status: "degraded", modelHealth: [],
			workers: [{ roleId: "partial", title: "partial", task: "x", status: "degraded", output: "partial evidence" }],
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		const lines = teamWidgetLines(run, theme);
		expect(lines[0]).toContain("◐ 1 degraded");
		expect(lines[1]).toContain("◐");
	});

	it("labels delivered but unacknowledged requests as awaiting ACK", () => {
		const run: TeamRun = {
			runId: "team_awaiting_ack", task: "x", playbookId: "p", status: "running", modelHealth: [],
			workers: [{
				roleId: "reviewer", title: "reviewer", task: "x", status: "running", output: "", startedAt: 1,
				lastCaptainMessageRef: "req-1", lastCaptainMessageAt: 2, lastCaptainDeliveredRef: "req-1", lastCaptainDeliveredAt: 3,
			}],
		};
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		const line = teamWidgetLines(run, theme)[1];
		expect(line).toContain("AWAITING_ACK:req-1");
		expect(line).not.toContain(" ACK:req-1");
	});

	it("names hidden pending workers in compact TUI overflow", () => {
		const workers: WorkerRun[] = ["a", "b", "c", "d"].map((roleId) => ({
			roleId, title: roleId, task: roleId, status: "running", output: "", startedAt: 1,
		}));
		workers.push({ roleId: "pending-e", title: "pending-e", task: "e", status: "pending", output: "" });
		const run: TeamRun = { runId: "team_pending_overflow", task: "x", playbookId: "p", status: "running", modelHealth: [], workers };
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		expect(teamWidgetLines(run, theme).at(-1)).toContain("1 pending: pending-e");
	});

	it("cleans session-scoped team widget and status on shutdown", async () => {
		const result = registerTeamExtension();
		const calls: Array<[string, string, unknown]> = [];
		const ui = {
			setWidget(key: string, content: unknown) {
				calls.push(["widget", key, content]);
			},
			setStatus(key: string, content: unknown) {
				calls.push(["status", key, content]);
			},
		};
		await result.handlers.get("session_start")![0]({}, { hasUI: true, ui });
		await result.handlers.get("session_shutdown")![0]({});
		expect(calls).toContainEqual(["widget", "pi-team-workers", undefined]);
		expect(calls).toContainEqual(["status", "pi-team-status", undefined]);
	});

	it("shows state write errors in team_status", async () => {
		const result = registerTeamExtension();
		const teamStatus = result.tools.get("team_status");
		expect(teamStatus).toBeDefined();
		await writeTeamState(tempDir, {
			runId: "team_state_error",
			task: "observe state write error",
			playbookId: "generated-blueprint",
			status: "degraded",
			modelHealth: [],
			workers: [],
			events: [],
			stateWriteError: "failed to write team state: disk full",
		});

		const status = await teamStatus!.execute("tool-call-1", { runId: "team_state_error" }, undefined, undefined, {
			cwd: tempDir,
		} as any);
		const content = status.content[0];
		expect(content?.type).toBe("text");
		if (content?.type !== "text") throw new Error("expected text content");
		expect(content.text).toContain("state write error: failed to write team state: disk full");
		expect(content.text).toContain("plan: custom-plan (task-specific roles)");
		expect(content.text).not.toContain("fallback policy: task_first");
		expect(content.text).not.toContain("mailbox text:");
		expect(content.text).toContain("workers: total:0 active:0 succeeded:0 failed:0 degraded:0 skipped:0 stale:0");
		expect((status.details as TeamRun).stateWriteError).toBe("failed to write team state: disk full");
		expect((status.details as any).statusProjection.stateWriteError).toBe("failed to write team state: disk full");
	});

	it("keeps default team_status focused on control evidence", async () => {
		const result = registerTeamExtension();
		const teamStatus = result.tools.get("team_status");
		await writeTeamState(tempDir, {
			runId: "team_short_status", task: "observe", playbookId: "generated-blueprint", status: "degraded", modelHealth: [], events: [],
			workers: [{
				roleId: "reviewer", title: "Reviewer", task: "review", status: "degraded", model: "provider/model",
				output: "partial evidence", outputKind: "radio_only", errorReason: "budget ended the worker",
				startedAt: 1, endedAt: 2_001, requests: 4, tokens: 900, tools: ["read", "bash"], activeTools: ["read"],
				laneId: "lane-internal", delegationToken: "secret-internal", events: [{ phase: "tool", message: "tool_execution_start" }],
			}],
		});
		const status = await teamStatus!.execute("short", { runId: "team_short_status" }, undefined, undefined, { cwd: tempDir } as any);
		const text = status.content[0]?.text ?? "";
		expect(text).toContain("degraded [reviewer] Reviewer provider/model elapsed:2s ended");
		expect(text).toContain("output:radio_only");
		expect(text).not.toContain("preview:partial evidence");
		expect(text).toContain("error:budget ended the worker");
		expect(text).not.toContain("toolCalls:");
		expect(text).not.toContain("events:");
		expect(text).not.toContain(" activeTools:");
		expect(text).not.toContain(" lane:");
		expect(text).not.toContain(" req:");
		expect(text).not.toContain(" tok:");
	});

	it("self-heals a stuck status line when team_status observes a terminal run", async () => {
		const result = registerTeamExtension();
		const teamStatus = result.tools.get("team_status");
		expect(teamStatus).toBeDefined();
		const calls: Array<[string, string, unknown]> = [];
		const ui = {
			setWidget(key: string, content: unknown) {
				calls.push(["widget", key, content]);
			},
			setStatus(key: string, content: unknown) {
				calls.push(["status", key, content]);
			},
		};
		await writeTeamState(tempDir, {
			runId: "team_terminal_heal",
			task: "observe terminal run",
			playbookId: "generated-blueprint",
			status: "succeeded",
			modelHealth: [],
			workers: [],
			events: [],
		});
		await teamStatus!.execute("tool-call-heal", { runId: "team_terminal_heal" }, undefined, undefined, {
			cwd: tempDir,
			hasUI: true,
			ui,
		} as any);
		// Terminal observation must clear both the per-run widget and status keys.
		expect(calls).toContainEqual(["widget", "pi-team-workers:team_terminal_heal", undefined]);
		expect(calls).toContainEqual(["status", "pi-team-status:team_terminal_heal", undefined]);
	});

	it("renders pre-observation attention evidence before rearming the next window", async () => {
		const result = registerTeamExtension();
		const teamStatus = result.tools.get("team_status");
		const now = Date.now();
		const cancelRequestedAt = now - 130_000;
		await writeTeamState(tempDir, {
			runId: "team_pre_rearm", task: "observe", playbookId: "generated-blueprint", status: "running", modelHealth: [], events: [],
			workers: [{
				roleId: "reviewer", title: "Reviewer", task: "review", status: "running", output: "", model: "provider/model",
				startedAt: now - 140_000, lastReportAt: now - 130_000, lastSignalAt: now, cancelRequestedAt,
				requests: 2, tokens: 100, costUsd: 0.25, lastTool: "read", activeTools: ["read"], tools: ["read"],
			}],
		});
		const attentionFile = teamControlPaths(tempDir, "team_pre_rearm").attentionFile;
		await writeCaptainAttentionState(attentionFile, { roles: {
			reviewer: { communicationAt: now - 130_000, silenceAlerted: false, pendingAckAlerted: false, pendingCancelAt: cancelRequestedAt, cancelAlerted: true },
		} });
		const status = await teamStatus!.execute("pre-rearm", { runId: "team_pre_rearm" }, undefined, undefined, { cwd: tempDir } as any);
		const text = status.content[0]?.text ?? "";
		expect(text).toContain("attention:1");
		expect(text).toMatch(/cancel:requested\/13\ds/);
		expect(text).toContain("tool:read req:2 tok:100 cost:$0.2500");
		const rearmed = await readCaptainAttentionState(attentionFile);
		expect(rearmed?.roles.reviewer?.cancelAlerted).toBe(false);
		expect(rearmed?.roles.reviewer?.rearmAt).toBeDefined();
	});

	it("does not touch the UI when team_status observes a running run", async () => {
		const result = registerTeamExtension();
		const teamStatus = result.tools.get("team_status");
		const calls: Array<[string, string, unknown]> = [];
		const ui = {
			setWidget(key: string, content: unknown) {
				calls.push(["widget", key, content]);
			},
			setStatus(key: string, content: unknown) {
				calls.push(["status", key, content]);
			},
		};
		await writeTeamState(tempDir, {
			runId: "team_running_noheal",
			task: "observe running run",
			playbookId: "generated-blueprint",
			status: "running",
			modelHealth: [],
			workers: [],
			events: [],
		});
		await teamStatus!.execute("tool-call-noheal", { runId: "team_running_noheal" }, undefined, undefined, {
			cwd: tempDir,
			hasUI: true,
			ui,
		} as any);
		expect(calls).toHaveLength(0);
	});

	it("rejects team_cancel for a terminal or invalid run without writing a cancel file", async () => {
		const result = registerTeamExtension();
		const teamCancel = result.tools.get("team_cancel");
		await writeTeamState(tempDir, {
			runId: "team_terminal_cancel",
			task: "already done",
			playbookId: "generated-blueprint",
			status: "succeeded",
			modelHealth: [],
			workers: [],
			events: [],
		});
		const terminal = await teamCancel!.execute("cancel-terminal", { runId: "team_terminal_cancel" }, undefined, undefined, { cwd: tempDir } as any);
		expect(terminal.content[0]?.text).toContain("already succeeded");
		expect(isTeamCancelRequested(tempDir, "team_terminal_cancel")).toBe(false);

		const invalid = await teamCancel!.execute("cancel-invalid", { runId: "../escape" }, undefined, undefined, { cwd: tempDir } as any);
		expect(invalid.isError).toBe(true);
		expect(invalid.content[0]?.text).toBe("No team run found.");
	});

	it("queues a valid spawn request but rejects empty spawn fields immediately", async () => {
		const result = registerTeamExtension();
		const spawn = result.tools.get("team_spawn_worker");
		await writeTeamState(tempDir, {
			runId: "team_spawn_request",
			task: "spawn",
			playbookId: "generated-blueprint",
			status: "running",
			modelHealth: [],
			workers: [],
			events: [],
		});
		const invalid = await spawn!.execute("spawn-empty", { runId: "team_spawn_request", roleId: " ", title: "Reviewer", task: "Review" }, undefined, undefined, { cwd: tempDir } as any);
		expect(invalid.isError).toBe(true);
		expect(await readTeamMailbox(tempDir, "team_spawn_request")).toHaveLength(0);

		const queued = await spawn!.execute("spawn-valid", { runId: "team_spawn_request", roleId: "reviewer", title: "Reviewer", task: "Review" }, undefined, undefined, { cwd: tempDir } as any);
		expect(queued.content[0]?.text).toContain("spawn requested");
		expect(queued.content[0]?.text).toContain("spawn-accepted or spawn-rejected");
		expect(await readTeamMailbox(tempDir, "team_spawn_request")).toHaveLength(1);
	});

	it("reports ambiguous team_cancel_worker keys with exact candidates", async () => {
		const result = registerTeamExtension();
		const cancelWorker = result.tools.get("team_cancel_worker");
		const worker = (roleId: string): WorkerRun => ({
			roleId,
			title: "Reviewer",
			task: "review",
			status: "running",
			output: "",
			tools: [],
		});
		await writeTeamState(tempDir, {
			runId: "team_ambiguous_cancel",
			task: "cancel",
			playbookId: "generated-blueprint",
			status: "running",
			modelHealth: [],
			workers: [worker("reviewer-a"), worker("reviewer-b")],
			events: [],
		});
		const out = await cancelWorker!.execute("cancel-ambiguous", { runId: "team_ambiguous_cancel", roleId: "reviewer" }, undefined, undefined, { cwd: tempDir } as any);
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toContain("is ambiguous");
		expect(out.content[0]?.text).toContain("reviewer-a (Reviewer)");
		expect(out.content[0]?.text).toContain("reviewer-b (Reviewer)");
	});
});
