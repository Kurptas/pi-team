import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelCapabilityProfile } from "./types.ts";

interface CapabilityFile {
    profiles?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseProfile(value: unknown): ModelCapabilityProfile | undefined {
    if (!isRecord(value) || typeof value.family !== "string" || !value.family.trim()) return undefined;
    const models = stringList(value.models);
    return {
        family: value.family.trim(),
        models,
        aliases: stringList(value.aliases),
        displayName:
            typeof value.displayName === "string" && value.displayName.trim()
                ? value.displayName.trim()
                : value.family.trim(),
        summary: typeof value.summary === "string" ? value.summary.trim() : "",
        strengths: stringList(value.strengths),
        cautions: stringList(value.cautions),
        recommendedRoles: stringList(value.recommendedRoles),
        sources: stringList(value.sources),
    };
}

export function loadModelCapabilityProfiles(defaultsDir: string): ModelCapabilityProfile[] {
    const filePath = path.join(defaultsDir, "model-capabilities.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as CapabilityFile;
        if (!Array.isArray(parsed.profiles)) return [];
        return parsed.profiles
            .map(parseProfile)
            .filter((profile): profile is ModelCapabilityProfile => profile !== undefined);
    } catch {
        return [];
    }
}

function normalize(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function profileForModel(
    modelKey: string,
    modelId: string,
    profiles: ModelCapabilityProfile[],
): ModelCapabilityProfile | undefined {
    const normalizedKey = normalize(modelKey);
    const normalizedId = normalize(modelId);
    return profiles.find((profile) => {
        const candidates = [profile.family, ...profile.models, ...profile.aliases].map(normalize);
        return candidates.some(
            (candidate) =>
                candidate === normalizedKey ||
                candidate === normalizedId ||
                normalizedKey.includes(candidate) ||
                normalizedId.includes(candidate) ||
                candidate.includes(normalizedId),
        );
    });
}
