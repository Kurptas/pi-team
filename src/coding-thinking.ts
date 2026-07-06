import type { ThinkingLevel } from "./types.ts";

/**
 * Recommended thinking level for coding tasks by model key.
 * Returns undefined for non-coding or unknown models (no override).
 *
 * Research-backed (2026-07-03):
 * - deepseek-v4-pro: medium (sufficient for most coding; high for architecture)
 * - claude-opus-4-7/4-8: high (Anthropic recommends higher effort for coding)
 * - gpt-5.4/5.5: medium (default)
 * - qwen3.6-plus: medium
 * - glm-5.2: medium
 * - deepseek-v4-flash: off (flash models don't need thinking overhead)
 *
 * For review/analysis tasks, every model is bumped one tier: flash→medium, pro→high.
 */
export function taskThinkingLevel(modelKey: string, mode: "coding" | "review"): ThinkingLevel | undefined {
    const lower = modelKey.toLowerCase();

    if (mode === "coding") {
        if (lower.includes("deepseek-v4-flash")) return "off";
        if (lower.includes("deepseek-v4-pro") && !lower.includes("flash")) return "medium";
        if (lower.includes("claude-opus-4-7") || lower.includes("claude-opus-4-8")) return "high";
        if (/(?:^|\/)gpt-5\.[45](?!-)/i.test(lower)) return "medium";
        if (lower.includes("qwen3.6-plus")) return "medium";
        if (lower.includes("glm-5.2")) return "medium";
        return undefined;
    }

    // Review/analysis: bump one tier relative to coding baseline
    if (lower.includes("deepseek-v4-flash")) return "medium";
    if (lower.includes("deepseek-v4-pro") && !lower.includes("flash")) return "high";
    if (lower.includes("claude-opus-4-7") || lower.includes("claude-opus-4-8")) return "high";
    if (/(?:^|\/)gpt-5\.[45](?!-)/i.test(lower)) return "high";
    if (lower.includes("qwen3.6-plus")) return "medium";
    if (lower.includes("glm-5.2")) return "medium";
    return undefined;
}

/**
 * @deprecated Use taskThinkingLevel(modelKey, "coding") instead.
 */
export function codingThinkingLevel(modelKey: string): ThinkingLevel | undefined {
    return taskThinkingLevel(modelKey, "coding");
}
