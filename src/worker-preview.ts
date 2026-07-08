import { isRadioReport, workerOutputKind } from "./run-outcome.ts";
import type { WorkerRun } from "./types.ts";

const DEFAULT_FACTUAL_PREVIEW_CHARS = 280;

function compactWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
    const normalized = compactWhitespace(text);
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function objectStringField(value: unknown, field: string): string | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue : undefined;
}

function structuredSummary(worker: WorkerRun): string | undefined {
    return objectStringField(worker.structuredOutput, "result_summary")
        ?? objectStringField(worker.structuredOutput, "summary");
}

function prosePreviewSource(output: string): string {
    return output
        .replace(/```(?:json)?\s*[\s\S]*?```/gi, " ")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !isRadioReport(line))
        .join(" ");
}

/**
 * Short factual worker preview for status/handoff surfaces.
 *
 * This is intentionally non-semantic: it does not compare workers, infer
 * agreement, score evidence, or suggest next actions. It only exposes a compact
 * snippet of data the worker already produced, prioritizing validated
 * structured summaries when present.
 */
export function workerFactualPreview(worker: WorkerRun, maxChars = DEFAULT_FACTUAL_PREVIEW_CHARS): string | undefined {
    const summary = structuredSummary(worker);
    if (summary) return truncate(summary, maxChars);

    const output = worker.output.trim();
    if (!output) return undefined;
    if ((worker.outputKind ?? workerOutputKind(output)) === "radio_only") return undefined;

    const prose = prosePreviewSource(output);
    return prose ? truncate(prose, maxChars) : undefined;
}
