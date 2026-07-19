import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "./runtime-compat.ts";
import { isModelCapabilityDimension } from "./types.ts";
import type { ModelCapabilityDimension, ModelCapabilityProfile } from "./types.ts";

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
    const capabilities = stringList(value.capabilities)
        .filter((item): item is ModelCapabilityDimension => isModelCapabilityDimension(item));
    return {
        family: value.family.trim(),
        models: stringList(value.models),
        aliases: stringList(value.aliases),
        capabilities,
        displayName:
            typeof value.displayName === "string" && value.displayName.trim()
                ? value.displayName.trim()
                : value.family.trim(),
        summary: typeof value.summary === "string" ? value.summary.trim() : "",
        strengths: stringList(value.strengths),
        cautions: stringList(value.cautions),
        sources: stringList(value.sources),
    };
}

function readProfiles(filePath: string): ModelCapabilityProfile[] {
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

/**
 * Load optional model facts from local configuration. The package ships no
 * concrete model catalog; users and projects may describe their own configured
 * keys without publishing those aliases in pi-team defaults.
 */
export function loadModelCapabilityProfiles(cwd?: string): ModelCapabilityProfile[] {
    const files: string[] = [];
    const userFile = path.join(getAgentDir(), "team", "model-capabilities.json");
    if (fs.existsSync(userFile)) files.push(userFile);

    if (cwd) {
        const projectFiles: string[] = [];
        let current = path.resolve(cwd);
        while (true) {
            const candidate = path.join(current, CONFIG_DIR_NAME, "team", "model-capabilities.json");
            if (fs.existsSync(candidate)) projectFiles.push(candidate);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        files.push(...projectFiles.reverse());
    }

    const byFamily = new Map<string, ModelCapabilityProfile>();
    for (const filePath of [...new Set(files.map((file) => path.resolve(file)))]) {
        for (const profile of readProfiles(filePath)) byFamily.set(profile.family, profile);
    }
    return [...byFamily.values()];
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
        const candidates = [profile.family, ...profile.models, ...profile.aliases].map(normalize).filter(Boolean);
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
