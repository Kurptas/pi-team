import { spawn } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { modelKey } from "./model-router.ts";
import { piInvocation } from "./pi-invocation.ts";
import type { ModelHealthSnapshot, TeamModel } from "./types.ts";

export type ProbeModel = (model: TeamModel, signal?: AbortSignal) => Promise<ModelHealthSnapshot>;

function classifyProbeFailure(message: string): ModelHealthSnapshot["status"] {
    const lower = message.toLowerCase();
    if (lower.includes("api key") || lower.includes("auth") || lower.includes("login")) return "missing_auth";
    if (lower.includes("rate") || lower.includes("429")) return "rate_limited";
    if (lower.includes("model") && (lower.includes("not found") || lower.includes("invalid"))) return "model_rejected";
    return "provider_error";
}

// Cold-starting a Pi subprocess on Windows (spawn + module load + first token)
// can exceed 20s even for a healthy model, which then gets mis-flagged as
// `timeout` and triggers needless fallback + decision windows. Default to 45s
// and allow an env override for slower machines.
export function defaultProbeTimeoutMs(): number {
    const configured = Number.parseInt(process.env.PI_TEAM_PROBE_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
}

export function createCliProbe(timeoutMs = defaultProbeTimeoutMs()): ProbeModel {
    return async (model, signal) => {
        const startedAt = Date.now();
        const key = modelKey(model);
        return await new Promise<ModelHealthSnapshot>((resolve) => {
            const invocation = piInvocation([
                "--mode",
                "json",
                "-p",
                "--no-session",
                "--model",
                key,
                "Return exactly: OK",
            ]);
            const proc = spawn(invocation.command, invocation.args, {
                stdio: ["ignore", "pipe", "pipe"],
                shell: false,
            });
            let stdout = "";
            let stderr = "";
            let settled = false;

            const finish = (snapshot: Omit<ModelHealthSnapshot, "latencyMs" | "checkedAt">) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ ...snapshot, latencyMs: Date.now() - startedAt, checkedAt: Date.now() });
            };

            const timeout = setTimeout(() => {
                proc.kill("SIGTERM");
                finish({
                    model: key,
                    provider: model.provider,
                    status: "timeout",
                    reason: `probe exceeded ${timeoutMs}ms`,
                });
            }, timeoutMs);

            proc.stdout.on("data", (data) => {
                stdout += data.toString();
            });
            proc.stderr.on("data", (data) => {
                stderr += data.toString();
            });
            proc.on("error", (error) => {
                finish({ model: key, provider: model.provider, status: "provider_error", reason: error.message });
            });
            proc.on("close", (code) => {
                if (settled) return;
                if (code === 0 && stdout.includes("OK")) {
                    finish({ model: key, provider: model.provider, status: "probe_passed" });
                    return;
                }
                const reason = stderr || stdout || `probe exited with code ${code ?? "unknown"}`;
                finish({ model: key, provider: model.provider, status: classifyProbeFailure(reason), reason });
            });

            const abort = () => {
                proc.kill("SIGTERM");
                finish({ model: key, provider: model.provider, status: "timeout", reason: "probe aborted" });
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
        });
    };
}

// The in-process probe reuses the already-loaded Pi runtime instead of spawning
// a fresh `pi` CLI subprocess. Skipping subprocess cold-start (spawn + module
// load + first token, which can exceed 20s on Windows) makes a healthy model
// respond in well under a second, so this timeout defaults far lower than the
// CLI probe's 45s. Override with PI_TEAM_INPROCESS_PROBE_TIMEOUT_MS.
export function defaultInProcessProbeTimeoutMs(): number {
    const configured = Number.parseInt(process.env.PI_TEAM_INPROCESS_PROBE_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

// Minimal structural view of an agent session — just what the probe touches.
// Kept local so the probe can be exercised with a fake session in tests.
interface ProbeSession {
    subscribe(listener: (event: { type: string }) => void): () => void;
    prompt(text: string): Promise<void>;
    dispose(): unknown;
}

type ProbeSessionFactory = (options: {
    cwd: string;
    model: Model<Api>;
    thinkingLevel: "medium";
    noTools: "all";
    sessionManager: ReturnType<typeof SessionManager.inMemory>;
}) => Promise<{ session: ProbeSession; assistantText: () => string }>;

// Default factory: create a real in-process agent session with no tools, and
// derive assistant text from the messages carried on the terminal `agent_end`
// event (mirrors runner.ts's finalAssistantText behavior for the last turn).
const defaultProbeSessionFactory: ProbeSessionFactory = async (options) => {
    let lastAssistantText = "";
    const { session } = await createAgentSession({
        cwd: options.cwd,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        noTools: options.noTools,
        sessionManager: options.sessionManager,
    });
    const wrapped: ProbeSession = {
        subscribe: (listener) =>
            session.subscribe((event) => {
                if (event.type === "message_end") {
                    const message = (event as { message?: unknown }).message as
                        | { role?: string; content?: Array<{ type?: string; text?: string }> }
                        | undefined;
                    if (message?.role === "assistant") {
                        const text = message.content?.find((part) => part.type === "text");
                        if (text?.type === "text" && typeof text.text === "string") lastAssistantText = text.text;
                    }
                }
                listener({ type: event.type });
            }),
        prompt: (text) => session.prompt(text),
        dispose: () => session.dispose(),
    };
    return { session: wrapped, assistantText: () => lastAssistantText };
};

/**
 * In-process probe: verifies a model responds by running a tiny no-tool agent
 * turn on the already-loaded Pi runtime, avoiding CLI subprocess cold-start.
 *
 * A probe ALWAYS resolves a snapshot (never rejects). The optional final
 * `sessionFactory` parameter exists purely for testability — it lets tests
 * inject a fake session (assistant text + agent_end) without a live model or
 * network. Production callers omit it and get the real agent session.
 */
export function createInProcessProbe(
    modelRegistry: { find(provider: string, modelId: string): Model<Api> | undefined },
    cwd: string,
    timeoutMs = defaultInProcessProbeTimeoutMs(),
    sessionFactory: ProbeSessionFactory = defaultProbeSessionFactory,
): ProbeModel {
    return async (model, signal) => {
        const startedAt = Date.now();
        const key = modelKey(model);
        const finish = (snapshot: Omit<ModelHealthSnapshot, "latencyMs" | "checkedAt">): ModelHealthSnapshot => ({
            ...snapshot,
            latencyMs: Date.now() - startedAt,
            checkedAt: Date.now(),
        });

        const resolved = modelRegistry.find(model.provider, model.id);
        if (!resolved) {
            return finish({
                model: key,
                provider: model.provider,
                status: "model_rejected",
                reason: "model not found in registry",
            });
        }

        let session: ProbeSession | undefined;
        try {
            const created = await sessionFactory({
                cwd,
                model: resolved,
                thinkingLevel: "medium",
                noTools: "all",
                sessionManager: SessionManager.inMemory(cwd),
            });
            session = created.session;
            const activeSession = session;

            return await new Promise<ModelHealthSnapshot>((resolve) => {
                let settled = false;
                const settle = (snapshot: Omit<ModelHealthSnapshot, "latencyMs" | "checkedAt">) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    unsubscribe();
                    if (signal) signal.removeEventListener("abort", abort);
                    void Promise.resolve(activeSession.dispose()).catch(() => {});
                    resolve(finish(snapshot));
                };

                const timeout = setTimeout(() => {
                    settle({
                        model: key,
                        provider: model.provider,
                        status: "timeout",
                        reason: `probe exceeded ${timeoutMs}ms`,
                    });
                }, timeoutMs);

                const abort = () => {
                    settle({ model: key, provider: model.provider, status: "timeout", reason: "probe aborted" });
                };

                const unsubscribe = activeSession.subscribe((event) => {
                    if (event.type !== "agent_end") return;
                    const output = created.assistantText();
                    if (output.includes("OK")) {
                        settle({ model: key, provider: model.provider, status: "probe_passed" });
                        return;
                    }
                    settle({
                        model: key,
                        provider: model.provider,
                        status: "provider_error",
                        reason: output ? "probe produced unexpected output" : "probe produced no output",
                    });
                });

                if (signal?.aborted) {
                    abort();
                    return;
                }
                signal?.addEventListener("abort", abort, { once: true });

                activeSession.prompt("Return exactly: OK").catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    settle({ model: key, provider: model.provider, status: classifyProbeFailure(message), reason: message });
                });
            });
        } catch (error) {
            if (session) void Promise.resolve(session.dispose()).catch(() => {});
            const message = error instanceof Error ? error.message : String(error);
            return finish({ model: key, provider: model.provider, status: classifyProbeFailure(message), reason: message });
        }
    };
}

export async function probeModels(
    models: TeamModel[],
    probeModel: ProbeModel,
    signal?: AbortSignal,
): Promise<ModelHealthSnapshot[]> {
    // Probe in batches of 4 to avoid overwhelming the system with parallel Pi subprocesses.
    const results: ModelHealthSnapshot[] = [];
    const concurrency = 4;
    for (let i = 0; i < models.length; i += concurrency) {
        const batch = models.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map((model) => probeModel(model, signal)));
        results.push(...batchResults);
    }
    return results;
}
