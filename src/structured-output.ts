import { Compile } from "typebox/compile";

// ---------------------------------------------------------------------------
// Structured output (P1) — JSON Schema validation for worker findings.
//
// Design stance (pi-team north star): schema validation is INFORMATION for the
// captain, never a hard gate. This module only extracts + validates + reports.
// It never fails a worker, discards worker text, or triggers a retry — those
// are captain judgments. The runner attaches the result to WorkerRun so the
// captain (and later synthesis / dynamic fanout) can consume it.
//
// We run IN-PROCESS (createAgentSession, no child process), so unlike
// pi-subagents we cannot pass a schema via env or capture a structured_output
// tool call through a temp file. Instead we take the worker's final assistant
// text and extract a trailing JSON block. Only the validation core is borrowed
// from pi-subagents (typebox/compile); the env/subprocess machinery is not.
// ---------------------------------------------------------------------------

/** A JSON Schema is just an object here; typebox/compile accepts plain JSON Schema. */
export type JsonSchemaObject = Record<string, unknown>;

interface CompiledJsonSchema {
    Check(value: unknown): boolean;
    Errors(value: unknown): Iterable<{ instancePath?: string; message?: string }>;
}

/**
 * The canonical `worker_finding` schema. Mirrors the fields the planner already
 * asks every worker for (result_summary / evidence_refs / confidence /
 * disagreements / next_questions).
 *
 * Deliberately lenient: `additionalProperties: true` so a worker can add richer
 * structure without being marked invalid, and the array/string types are the
 * loosest that still make the shape machine-consumable. Tightening these would
 * turn the advisory signal into a de-facto gate, which is the captain's call,
 * not the extension's.
 */
export const WORKER_FINDING_SCHEMA: JsonSchemaObject = {
    type: "object",
    properties: {
        result_summary: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        confidence: { type: "string" },
        disagreements: { type: "array", items: { type: "string" } },
        next_questions: { type: "array", items: { type: "string" } },
    },
    required: ["result_summary", "evidence_refs", "confidence", "disagreements", "next_questions"],
    additionalProperties: true,
};

/** Named schema registry. `outputSchema: "worker_finding"` resolves here. */
export const OUTPUT_SCHEMA_REGISTRY: Readonly<Record<string, JsonSchemaObject>> = {
    worker_finding: WORKER_FINDING_SCHEMA,
};

export type SchemaResolution =
    | { kind: "none" }
    | { kind: "schema"; schema: JsonSchemaObject; source: "registry" | "inline" }
    | { kind: "unresolved"; message: string };

function isSchemaObject(value: unknown): value is JsonSchemaObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve a role's `outputSchema` reference to an actual JSON Schema object.
 *
 * Accepts three forms:
 * - empty/undefined  -> `{ kind: "none" }` (role declared no schema)
 * - a registered name (e.g. "worker_finding") -> registry schema
 * - an inline JSON Schema string -> parsed object
 *
 * An unknown bare name or unparseable string is `{ kind: "unresolved" }`. That
 * is a role-configuration signal for the captain, not a worker failure.
 */
export function resolveOutputSchema(ref: string | undefined): SchemaResolution {
    const trimmed = (ref ?? "").trim();
    if (!trimmed) return { kind: "none" };
    const registered = OUTPUT_SCHEMA_REGISTRY[trimmed];
    if (registered) return { kind: "schema", schema: registered, source: "registry" };
    // Only attempt JSON parsing when it looks like an inline object, so a simple
    // typo'd name ("worker_findng") is reported as unresolved rather than as a
    // confusing JSON parse error.
    if (trimmed.startsWith("{")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isSchemaObject(parsed)) return { kind: "schema", schema: parsed, source: "inline" };
            return { kind: "unresolved", message: "inline outputSchema is not a JSON object" };
        } catch (error) {
            return { kind: "unresolved", message: `invalid inline outputSchema JSON: ${errorText(error)}` };
        }
    }
    return { kind: "unresolved", message: `unknown outputSchema name "${trimmed}"` };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Walk forward from an opening brace at `start`, respecting string literals and
 * escapes, and return the balanced `{...}` substring (or undefined if never
 * balanced). String-aware so braces inside JSON string values don't confuse the
 * depth counter.
 */
function balancedObjectSlice(text: string, start: number): string | undefined {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === "{") {
            depth++;
        } else if (ch === "}") {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return undefined;
}

function tryParseObject(candidate: string): JsonSchemaObject | undefined {
    try {
        const parsed: unknown = JSON.parse(candidate.trim());
        return isSchemaObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extract the trailing JSON object from free-form worker text.
 *
 * Workers are asked to end with a ```json code block, so fenced blocks are
 * tried first (last one wins — it is the worker's final answer). If there is no
 * usable fenced block, fall back to the last balanced top-level `{...}` in the
 * text. Returns the parsed object, or undefined if nothing JSON-like is found.
 *
 * Only objects are returned; a bare array or scalar is ignored because the
 * worker_finding contract (and structured findings generally) is an object.
 */
export function extractJsonObject(text: string): JsonSchemaObject | undefined {
    if (!text.trim()) return undefined;
    const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "");
    for (let i = fenced.length - 1; i >= 0; i--) {
        const parsed = tryParseObject(fenced[i]);
        if (parsed !== undefined) return parsed;
    }
    // No fenced object: scan for the last balanced {...} that parses as an object.
    for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] !== "{") continue;
        const slice = balancedObjectSlice(text, i);
        if (slice === undefined) continue;
        const parsed = tryParseObject(slice);
        if (parsed !== undefined) return parsed;
    }
    return undefined;
}

/**
 * Validate a value against a JSON Schema using typebox/compile. Borrowed from
 * pi-subagents' `validateStructuredOutputValue` (validation core only). Returns
 * a compact, human/captain-readable error list on failure.
 */
export function validateStructuredOutputValue(
    schema: JsonSchemaObject,
    value: unknown,
): { status: "valid" } | { status: "invalid"; message: string } {
    let validator: CompiledJsonSchema;
    try {
        validator = (Compile as (schema: unknown) => CompiledJsonSchema)(schema);
    } catch (error) {
        return { status: "invalid", message: `invalid outputSchema: ${errorText(error)}` };
    }
    if (validator.Check(value)) return { status: "valid" };
    const errors = [...validator.Errors(value)].slice(0, 8).map((error) => {
        const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
        return `${pathText}: ${error.message ?? "invalid"}`;
    });
    return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}

/** The advisory structured-output fields attached to a WorkerRun. */
export interface StructuredOutputResult {
    /** The parsed object, present whenever a JSON object was extracted (even if invalid). */
    structuredOutput?: unknown;
    /** A human/captain-readable note when extraction or validation did not fully succeed. */
    structuredOutputError?: string;
}

/**
 * End-to-end evaluation for a worker: resolve the role's schema, extract JSON
 * from the worker's final text, validate, and report.
 *
 * Never throws and never signals failure to the caller: the return shape only
 * ever carries an object and/or an advisory message. Keys are omitted (not set
 * to undefined) so the result composes with exactOptionalPropertyTypes.
 *
 * Behavior:
 * - No schema declared -> `{}` (feature is opt-in per role).
 * - Empty worker text  -> `{}` (emptiness is already reported via outputKind;
 *   adding a schema error here would be noise on aborted/empty workers).
 * - Schema unresolved   -> `{ structuredOutputError }` (role-config signal).
 * - No JSON found       -> `{ structuredOutputError }`.
 * - Invalid JSON value  -> `{ structuredOutput, structuredOutputError }` (keep
 *   the parsed object so the captain can still inspect it).
 * - Valid               -> `{ structuredOutput }`.
 */
export function evaluateWorkerStructuredOutput(ref: string | undefined, text: string): StructuredOutputResult {
    const resolution = resolveOutputSchema(ref);
    if (resolution.kind === "none") return {};
    if (!text.trim()) return {};
    if (resolution.kind === "unresolved") {
        return { structuredOutputError: `outputSchema not applied: ${resolution.message}` };
    }
    const extracted = extractJsonObject(text);
    if (extracted === undefined) {
        return {
            structuredOutputError:
                "no JSON object found in worker output; expected a trailing ```json block matching the declared schema",
        };
    }
    const validation = validateStructuredOutputValue(resolution.schema, extracted);
    if (validation.status === "invalid") {
        return { structuredOutput: extracted, structuredOutputError: `schema validation failed: ${validation.message}` };
    }
    return { structuredOutput: extracted };
}

/**
 * Prompt fragment appended to a worker task when its role declares a resolvable
 * outputSchema. Instructs the worker to end with a JSON block. Advisory in tone:
 * the worker still owns its full text answer; the JSON is an additional
 * machine-consumable summary, not a replacement.
 */
export function structuredOutputInstruction(ref: string | undefined): string | undefined {
    const resolution = resolveOutputSchema(ref);
    if (resolution.kind !== "schema") return undefined;
    return [
        "Structured output (for machine consumption by the captain):",
        "- After your normal findings, end your final message with a single fenced JSON block:",
        "  ```json",
        "  { ... }",
        "  ```",
        "- The JSON object must include these fields:",
        "  - result_summary (string)",
        "  - evidence_refs (array of strings)",
        "  - confidence (string)",
        "  - disagreements (array of strings)",
        "  - next_questions (array of strings)",
        "- Keep your prose findings too; the JSON is an additional structured summary, not a replacement.",
    ].join("\n");
}
