import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./types.ts";

// Pi's semantic scale, used only for nearest-level ordering. Provider values
// are arbitrary strings supplied by thinkingLevelMap (for example high→max).
const PI_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

type ThinkingModel = Pick<Model<Api>, "reasoning" | "thinkingLevelMap">;

export interface ThinkingResolution {
    requested?: ThinkingLevel;
    effective?: ThinkingLevel;
    transportValue?: string;
    note?: string;
}

function supportedLevels(model: ThinkingModel): ThinkingLevel[] {
    if (!model.reasoning) return [];
    const map = model.thinkingLevelMap;
    return PI_THINKING_LEVELS.filter((level) => {
        const mapped = map?.[level];
        if (mapped === null) return false;
        // Edge levels vary most across OpenAI-compatible gateways. Treat them
        // as supported only when the model metadata explicitly says how to
        // transport them. low/medium/high remain the conservative common set.
        if (level === "minimal" || level === "xhigh") return mapped !== undefined;
        return true;
    });
}

function nearestSupported(requested: ThinkingLevel, supported: ThinkingLevel[]): ThinkingLevel | undefined {
    if (supported.includes(requested)) return requested;
    const requestedIndex = PI_THINKING_LEVELS.indexOf(requested);
    for (let index = requestedIndex; index < PI_THINKING_LEVELS.length; index += 1) {
        const candidate = PI_THINKING_LEVELS[index];
        if (supported.includes(candidate)) return candidate;
    }
    for (let index = requestedIndex - 1; index >= 0; index -= 1) {
        const candidate = PI_THINKING_LEVELS[index];
        if (supported.includes(candidate)) return candidate;
    }
    // No compatible semantic level: omit thinking and let the provider use
    // its own default. Never invent an "off" or "default" transport value.
    return undefined;
}

/**
 * Resolve a captain-requested thinking level against model metadata.
 *
 * No provider/model names are inspected. thinkingLevelMap is the source of
 * truth; when metadata is absent, minimal/xhigh are conservatively clamped to
 * the nearest common level instead of being sent blindly to a custom gateway.
 */
export function resolveThinkingCompatibility(
    requested: ThinkingLevel | undefined,
    model: ThinkingModel | undefined,
): ThinkingResolution {
    if (requested === undefined) return {};
    if (model === undefined) return { requested, effective: requested };
    const supported = supportedLevels(model);
    const effective = nearestSupported(requested, supported);
    const mapped = effective === undefined ? undefined : model.thinkingLevelMap?.[effective];
    const transportValue = typeof mapped === "string" ? mapped : undefined;
    const adjusted = effective !== requested || (transportValue !== undefined && transportValue !== effective);
    return {
        requested,
        effective,
        transportValue,
        note: adjusted
            ? `thinking requested=${requested}; effective=${effective ?? "provider-default"}${transportValue ? `; transport=${transportValue}` : ""}`
            : undefined,
    };
}
