import type { ModelHealthSnapshot, TeamRun, WorkerRun } from "./types.ts";

interface CachedHealth {
    snapshot: ModelHealthSnapshot;
    source: "probe" | "worker";
    expiresAt: number;
}

const cache = new Map<string, CachedHealth>();
const WORKER_SUCCESS_TTL_MS = 10 * 60_000;
const PROBE_PASS_TTL_MS = 2 * 60_000;
const HARD_FAIL_TTL_MS = 2 * 60_000;
const SOFT_FAIL_TTL_MS = 30_000;

function ttlFor(snapshot: ModelHealthSnapshot, source: CachedHealth["source"]): number {
    if (source === "worker" && snapshot.status === "probe_passed") return WORKER_SUCCESS_TTL_MS;
    if (snapshot.status === "probe_passed") return PROBE_PASS_TTL_MS;
    if (snapshot.status === "missing_auth" || snapshot.status === "model_rejected") return HARD_FAIL_TTL_MS;
    return SOFT_FAIL_TTL_MS;
}

export function recordModelHealth(
    snapshot: ModelHealthSnapshot,
    source: CachedHealth["source"] = "probe",
    now = Date.now(),
): void {
    const existing = cache.get(snapshot.model);
    // Real work outranks synthetic probes for its full freshness window,
    // including races where a probe returns a few milliseconds later.
    if (source === "probe" && existing?.source === "worker" && existing.expiresAt > now) return;
    cache.set(snapshot.model, {
        snapshot: { ...snapshot, evidenceSource: source, checkedAt: now },
        source,
        expiresAt: now + ttlFor(snapshot, source),
    });
}

export function freshModelHealth(modelKeys: Iterable<string>, now = Date.now()): ModelHealthSnapshot[] {
    const snapshots: ModelHealthSnapshot[] = [];
    for (const key of modelKeys) {
        const cached = cache.get(key);
        if (!cached) continue;
        if (cached.expiresAt <= now) {
            cache.delete(key);
            continue;
        }
        snapshots.push({ ...cached.snapshot });
    }
    return snapshots;
}

export function recordWorkerModelOutcome(worker: WorkerRun, now = Date.now()): ModelHealthSnapshot | undefined {
    if (!worker.model || worker.status === "pending" || worker.status === "running" || worker.status === "skipped") return undefined;
    const slash = worker.model.indexOf("/");
    const provider = slash > 0 ? worker.model.slice(0, slash) : "unknown";
    const substantive = worker.outputKind === "substantive" || worker.output.trim().length > 0;
    let status: ModelHealthSnapshot["status"] | undefined;
    let reason: string;
    if ((worker.status === "succeeded" || worker.status === "degraded") && substantive) {
        status = "probe_passed";
        reason = "recent worker produced substantive output";
    } else {
        const error = (worker.errorReason ?? "").toLowerCase();
        if (worker.cancelObservedAt || /abort|cancel/.test(error) || worker.toolIsolationViolation) return undefined;
        if (/tool isolation|whitelist|tier ceiling|session manager|failed to persist|manual injection/.test(error)) return undefined;
        status = worker.timedOut
            ? "timeout"
            : /api key|auth|login|401/.test(error)
              ? "missing_auth"
              : /model.*(not found|invalid|rejected)/.test(error)
                ? "model_rejected"
                : /rate|429/.test(error)
                  ? "rate_limited"
                  : !error || /provider|http|5\d\d|network|connection|socket|econn|api|empty|no output|no assistant text/.test(error)
                    ? "provider_error"
                    : undefined;
        if (!status) return undefined;
        reason = `recent worker failure: ${worker.errorReason ?? worker.status}`;
    }
    const snapshot: ModelHealthSnapshot = {
        model: worker.model, provider, status, evidenceSource: "worker",
        latencyMs: Math.max(0, (worker.endedAt ?? now) - (worker.startedAt ?? now)),
        reason, checkedAt: now,
    };
    recordModelHealth(snapshot, "worker", now);
    return snapshot;
}

export function recordRunWorkerHealth(run: TeamRun, worker: WorkerRun, now = Date.now()): TeamRun {
    const snapshot = recordWorkerModelOutcome(worker, now);
    if (!snapshot) return run;
    return { ...run, modelHealth: [...run.modelHealth.filter((item) => item.model !== snapshot.model), snapshot] };
}

export function clearModelHealthCache(): void {
    cache.clear();
}
