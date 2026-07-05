import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { buildTeamStatusProjection, type ProjectedWorker } from "./status-projection.ts";
import type { TeamRun } from "./types.ts";

const TEAM_WIDGET_VISIBLE_WORKERS = 3;

export function isTerminalStatus(status: TeamRun["status"]): boolean {
    return status === "succeeded" || status === "degraded" || status === "failed";
}

export function durationLabel(seconds: number | undefined): string {
    if (seconds === undefined) return "--";
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export function statusGlyph(worker: Pick<ProjectedWorker, "status" | "stale">): { glyph: string; color: "accent" | "success" | "error" | "warning" | "dim" | "muted" } {
    if (worker.stale) return { glyph: "◌", color: "dim" };
    if (worker.status === "running") return { glyph: "●", color: "accent" };
    if (worker.status === "succeeded") return { glyph: "✓", color: "success" };
    if (worker.status === "failed") return { glyph: "✗", color: "error" };
    if (worker.status === "skipped") return { glyph: "⊘", color: "muted" };
    return { glyph: "•", color: "warning" };
}

export function fitVisible(text: string, width: number): string {
    return truncateToWidth(text, width, "…");
}

export function padVisible(text: string, width: number): string {
    return `${fitVisible(text, width)}${" ".repeat(Math.max(0, width - visibleWidth(fitVisible(text, width))))}`;
}

export function compactModelName(model: string | undefined): string {
    if (!model) return "unassigned";
    return model.split("/").at(-1) ?? model;
}

export function compactModelThinking(worker: ProjectedWorker, width: number): string {
    const suffix = worker.thinkingLevel ? `:${worker.thinkingLevel}` : "";
    return `${fitVisible(compactModelName(worker.model), Math.max(1, width - visibleWidth(suffix)))}${suffix}`;
}

export function workerCompactLine(worker: ProjectedWorker, theme: Theme): string {
    const glyph = statusGlyph(worker);
    const title = padVisible(worker.title, 18);
    const model = padVisible(compactModelThinking(worker, 16), 16);
    const signal = worker.status === "running" ? `·${durationLabel(worker.signalAgeSeconds)}` : "";
    const exit = worker.status === "failed" ? ` exit:${worker.exitCode ?? "?"}` : "";
    const activity = worker.status === "running" && worker.activity ? ` ${worker.activity.replace(/^tool:/, "")}` : "";
    const report = worker.status === "running" && worker.lastReportPreview ? ` report:${fitVisible(worker.lastReportPreview, 48)}` : "";
    return `${theme.fg(glyph.color, glyph.glyph)} ${title} ${theme.fg("dim", model)} ${durationLabel(worker.elapsedSeconds)} ${theme.fg("dim", signal)}${theme.fg(worker.status === "failed" ? "error" : "dim", `${exit}${activity}${report}`)}`.trimEnd();
}

export function teamCountSummary(run: TeamRun, theme?: Theme): string {
    const projection = buildTeamStatusProjection(run, []);
    const { counts } = projection;
    const paint = (color: "accent" | "success" | "error" | "warning" | "muted" | "dim", text: string) =>
        theme ? theme.fg(color, text) : text;
    const parts = [
        `${counts.total} workers`,
        `${paint("success", "✓")} ${counts.succeeded}`,
        `${paint("accent", "●")} ${counts.active}`,
        `${paint("error", "✗")} ${counts.failed}`,
    ];
    if (counts.skipped) parts.push(`${paint("muted", "⊘")} ${counts.skipped}`);
    if (counts.stale) parts.push(`${paint("warning", "stale")} ${counts.stale}`);
    return parts.join(" · ");
}

export function compactTeamLine(run: TeamRun, theme: Theme): string {
    const statusColor = run.status === "failed" ? "error" : run.status === "degraded" ? "warning" : isTerminalStatus(run.status) ? "success" : "accent";
    return `${theme.fg("toolTitle", theme.bold("team"))} ${theme.fg(statusColor, run.status)} ${theme.fg("dim", run.playbookId)} · ${teamCountSummary(run, theme)}`;
}

export function truncatedLines(lines: string[]): Component {
    return {
        render(width: number) {
            return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
        },
        invalidate() {},
    };
}

export function teamWidgetLines(run: TeamRun, theme: Theme): string[] {
    const projection = buildTeamStatusProjection(run, []);
    const shown = projection.workers.slice(0, TEAM_WIDGET_VISIBLE_WORKERS);
    const more = Math.max(0, projection.workers.length - shown.length);
    const lines = [compactTeamLine(run, theme), ...shown.map((worker) => workerCompactLine(worker, theme))];
    if (more > 0) lines.push(theme.fg("dim", `… ${more} more worker(s)`));
    return lines;
}

export function teamWidget(run: TeamRun, theme: Theme): Component {
    return truncatedLines(teamWidgetLines(run, theme));
}

export function renderTeamDetails(run: TeamRun, theme: Theme): Component {
    const projection = buildTeamStatusProjection(run, []);
    const lines = [compactTeamLine(run, theme)];
    for (const worker of projection.workers) {
        const output = worker.outputKind ? ` output:${worker.outputKind}` : "";
        const report = worker.lastReportPreview ? ` report:${worker.lastReportPreview}` : "";
        const error = worker.errorReason ? ` error:${worker.errorReason}` : "";
        lines.push(`${workerCompactLine(worker, theme)}${output}${report}${error}`);
    }
    return truncatedLines(lines);
}

export function renderTeamCompact(run: TeamRun, options: { expanded: boolean; isPartial: boolean }, theme: Theme): Component {
    if (options.expanded) return renderTeamDetails(run, theme);
    const hint = options.isPartial ? "" : ` ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
    return truncatedLines([`${compactTeamLine(run, theme)}${hint}`]);
}

export function renderPlainResult(text: string): Component {
    return truncatedLines(text.split("\n"));
}
