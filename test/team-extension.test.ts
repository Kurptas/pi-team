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
import {
	appendTeamMessage,
	isTeamCancelRequested,
	listTeamRunIds,
	readTeamMailbox,
	readTeamState,
	requestTeamCancel,
	teamControlPaths,
	teamRunLogDir,
	writeTeamState,
} from "../src/control.ts";
import { buildTeamStatusProjection, refreshTeamModelRegistry } from "../src/index.ts";
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
			"code-review-2plus1",
			"continuity-check",
			"debug-triage",
			"etf-research",
			"implementation-review-gate",
			"multi-angle-cheap-review",
			"research-roundtable",
		]);
		expect(resources.roles.map((role) => role.id)).toContain("bull");
		expect(resources.roles.map((role) => role.id)).toContain("research-scout");
		expect(resources.roles.map((role) => role.id)).toContain("fact-checker");
		expect(resources.roles.map((role) => role.id)).toContain("architect-reviewer");
		expect(resources.roles.map((role) => role.id)).toContain("risk-reviewer");
		expect(resources.roles.map((role) => role.id)).toContain("implementer");
		expect(resources.roles.map((role) => role.id)).toContain("test-runner");
		expect(resources.roles.map((role) => role.id)).toContain("log-reader");
		expect(resources.roles.map((role) => role.id)).toContain("code-path-tracer");
		expect(resources.roles.map((role) => role.id)).toContain("fix-validator");
		expect(resources.roles.length).toBeGreaterThanOrEqual(18);
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
	it("loads continuity-check playbook with cross-round role reuse", () => {
		const resources = loadTeamResources(teamExtensionDir, defaultsDir);
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
		expect(plannerSource).toContain("主 Agent 是队长");
		expect(researchPlaybook).toContain("主 Agent 是本次任务队长");
		expect(researchPlaybook).toContain("最终建议由队长裁决");
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
				selectedModel: "ai-glm/glm-5.2",
			},
		});
		expect(prompt).toContain("Worker runtime context");
		expect(prompt).toContain("Run id: team_test");
		expect(prompt).toContain("Role id: source-reader");
		expect(prompt).toContain("Requested/executed model: ai-glm/glm-5.2");
		expect(prompt).toContain("Available tools: web_search, fetch_content");
		expect(prompt).toContain("Mailbox file (human-readable):");
		expect(prompt).toContain("read` tool");
	});

	it("distinguishes explicit radio reports from normal assistant output", () => {
		expect(isRadioReport("RADIO: status=started")).toBe(true);
		expect(isRadioReport("  RADIO: status=blocked")).toBe(true);
		expect(isRadioReport("Final answer without radio prefix")).toBe(false);
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

	it("uses an ETF playbook when the lead explicitly requests it", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const playbook = selectPlaybook({ task: "组队调研 QQQ", playbook: "etf-research" }, resources.playbooks);
		expect(playbook?.id).toBe("etf-research");

		const plan = createTeamPlan({ task: "组队调研 QQQ", playbook: "etf-research" }, resources);
		expect(plan.playbook.id).toBe("etf-research");
		expect(plan.rounds[0]?.type).toBe("parallel");
		expect(plan.rounds[0]?.roles.map((role) => role.roleId)).toEqual(["bull", "bear", "fact-checker"]);
	});

	it("uses the generic research playbook as a non-semantic fallback", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const playbook = selectPlaybook({ task: "组队调研任意主题" }, resources.playbooks);
		expect(playbook?.id).toBe("research-roundtable");
		const plan = createTeamPlan({ task: "组队调研任意主题" }, resources);
		expect(plan.rounds[0]?.roles.map((role) => role.roleId)).toEqual([
			"research-scout",
			"perspective-advocate",
			"risk-skeptic",
			"evidence-checker",
		]);
	});

	it("honors explicit playbook selection", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const playbook = selectPlaybook(
			{ task: "调研卓越工程师校企联合培养的制度阻力", playbook: "etf-research" },
			resources.playbooks,
		);
		expect(playbook?.id).toBe("etf-research");
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
						modelPreferences: ["ai-glm/glm-5.2"],
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
				model: "deepseek/deepseek-v4-pro",
				routingReason: "policy=task_first; selected via recommendation; captain remains final judge",
				modelFallbackKeys: ["deepseek/deepseek-v4-flash"],
				outputFile: "/artifacts/reviewer.md",
			},
		], { status: "succeeded", warnings: [] });
		expect(summary).toContain("Worker evidence digest");
		expect(summary).toContain("Route: policy=task_first");
		expect(summary).toContain("Fallbacks: deepseek/deepseek-v4-flash");
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
			warnings: ["1 worker(s) skipped or aborted"],
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

	it("writes captain mailbox messages and cancel requests for active team runs", async () => {
		await appendTeamMessage(tempDir, "team_test", "请先核查官方来源。");
		const messages = await readTeamMailbox(tempDir, "team_test");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message).toBe("请先核查官方来源。");
		expect(await listTeamRunIds(tempDir)).toContain("team_test");
		expect(isTeamCancelRequested(tempDir, "team_test")).toBe(false);
		await requestTeamCancel(tempDir, "team_test", "队长取消");
		expect(isTeamCancelRequested(tempDir, "team_test")).toBe(true);
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

	it("routes roles only to models that passed live probe", () => {
		const resources = loadTeamResources(tempDir, defaultsDir);
		const plan = createTeamPlan({ task: "组队调研 QQQ", playbook: "etf-research" }, resources);
		const gpt = testModel("0u0o-codex", "gpt-5.5", true);
		const glm = testModel("ai-glm", "glm-5.2", true);
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
		expect(firstRole?.selectedModel).toBe("0u0o-codex/gpt-5.5");
		expect(firstRole?.fallbackReason).toBeUndefined();
	});

	it("loads model-family capability profiles for different providers", () => {
		const profiles = loadModelCapabilityProfiles(defaultsDir);
		const gpt = profileForModel("openai/gpt-5", "gpt-5", profiles);
		const channelGpt = profileForModel("0u0o-codex/gpt-5.5", "gpt-5.5", profiles);
		expect(gpt?.family).toBe("gpt-5-family");
		expect(channelGpt?.family).toBe("gpt-5-family");
		expect(gpt?.strengths).toContain("agentic coding");
	});

	it("uses capability profiles as routing evidence without replacing lead preference", () => {
		const gpt = testModel("0u0o-codex", "gpt-5.5", true);
		const glm = testModel("ai-glm", "glm-5.2", true);
		const role: PlannedRole = {
			roleId: "source-reader",
			title: "Source reader",
			description: "Read sources",
			capabilityNeeds: ["research", "tool_use", "speed"],
			task: "Read sources",
			tools: ["web_search"],
			systemPrompt: "Read sources",
			modelPreferences: ["0u0o-codex/gpt-5.5"],
		};
		const routed = selectModelForRole(role, [gpt, glm], [passed(gpt), passed(glm)], new Set());
		expect(routed.model?.provider).toBe("0u0o-codex");
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
			[gpt, glm],
			[passed(gpt), passed(glm)],
			loadModelCapabilityProfiles(defaultsDir),
		);
		expect(routed.model?.id).toBe("gpt-5.5");
		expect(plan.rounds[0]?.roles[0]?.routingReason).toContain("lead preference 0u0o-codex/gpt-5.5");
		expect(plan.rounds[0]?.roles[0]?.routingReason).toContain("lead remains final judge");
	});

	it("keeps timeout probes as lead-observed status without blocking dispatch", () => {
		const model = testModel("openai", "gpt-5", true);
		const role = {
			roleId: "reviewer",
			title: "Reviewer",
			description: "Review the result",
			capabilityNeeds: [],
			task: "Review",
			tools: ["read"],
			systemPrompt: "Review",
			modelPreferences: ["openai/gpt-5"],
		};
		const result = selectModelForRole(
			role,
			[model],
			[
				{
					model: "openai/gpt-5",
					provider: "openai",
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
		const gpt = testModel("0u0o-codex", "gpt-5.5", true);
		const glm = testModel("ai-glm", "glm-5.2", true);
		const role: PlannedRole = {
			roleId: "researcher",
			title: "Researcher",
			description: "Research",
			capabilityNeeds: ["research"],
			task: "Research",
			tools: ["web_search"],
			systemPrompt: "Research",
			modelPreferences: ["0u0o-codex/gpt-5.5"],
		};
		const result = selectModelForRole(
			role,
			[gpt, glm],
			[
				{
					model: "0u0o-codex/gpt-5.5",
					provider: "0u0o-codex",
					status: "missing_auth",
					latencyMs: 10,
					checkedAt: 1,
				},
				passed(glm),
			],
			new Set(),
		);
		expect(result.model?.provider).toBe("ai-glm");
		expect(result.fallbackReason).toContain("preferred models unavailable");
	});

	it("avoids objectively unavailable models", () => {
		const model = testModel("openai", "gpt-5", true);
		const role = {
			roleId: "reviewer",
			title: "Reviewer",
			description: "Review the result",
			capabilityNeeds: [],
			task: "Review",
			tools: ["read"],
			systemPrompt: "Review",
			modelPreferences: ["openai/gpt-5"],
		};
		const result = selectModelForRole(
			role,
			[model],
			[
				{
					model: "openai/gpt-5",
					provider: "openai",
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
					{ model: "provider/model", provider: "provider", status: "probe_passed", latencyMs: 10, checkedAt: 1 },
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

		expect(projection.counts).toMatchObject({ total: 2, active: 1, succeeded: 1, stale: 1, parseErrors: 2, toolViolations: 1, requests: 3, tokens: 150, costUsd: 0.03 });
		expect(projection.workers[0]?.activeTools).toEqual(["read"]);
		expect(projection.workers[1]?.toolIsolationViolation).toContain("bash");
		expect(projection.mailbox.lastMessagePreview).toBe("check source");
		expect(projection.evidenceWarnings).toEqual(["1 worker(s) had malformed event stream lines"]);
		expect(projection.controls).toEqual(["team_message", "team_cancel"]);
	});

	it("renders team tool progress compactly with expandable worker details", () => {
		const result = registerTeamExtension();
		const team = result.tools.get("team");
		expect(team?.promptSnippet).toContain("Dispatch");
		expect(team?.promptGuidelines.join("\n")).toContain("Use team when");

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
					model: "provider/claude-sonnet",
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
					model: "provider/deepseek",
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
		expect(content.text).toContain("state write: failed to write team state: disk full");
		expect(content.text).toContain("workers: total:0 active:0 succeeded:0 failed:0 degraded:0 skipped:0 stale:0");
		expect((status.details as TeamRun).stateWriteError).toBe("failed to write team state: disk full");
		expect((status.details as any).statusProjection.stateWriteError).toBe("failed to write team state: disk full");
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
});
