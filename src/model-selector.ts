import type { ThinkingLevel } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface ParsedModelPreference {
    model: string;
    thinkingLevel?: ThinkingLevel;
}

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
    return !!value && THINKING_LEVELS.has(value as ThinkingLevel);
}

export function parseModelPreference(preference: string): ParsedModelPreference {
    const trimmed = preference.trim();
    const colon = trimmed.lastIndexOf(":");
    if (colon <= 0) return { model: trimmed };
    const suffix = trimmed.slice(colon + 1).trim();
    if (!isThinkingLevel(suffix)) return { model: trimmed };
    return {
        model: trimmed.slice(0, colon).trim(),
        thinkingLevel: suffix,
    };
}

export function parseConfiguredModelPreference(
    preference: string,
    isConfigured: (model: string) => boolean,
): ParsedModelPreference {
    const trimmed = preference.trim();
    if (isConfigured(trimmed)) return { model: trimmed };
    const parsed = parseModelPreference(trimmed);
    if (parsed.thinkingLevel && isConfigured(parsed.model)) return parsed;
    return { model: trimmed };
}
