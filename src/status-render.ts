import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { buildTeamStatusProjection, type ProjectedWorker } from "./status-projection.ts";
import type { TeamRun } from "./types.ts";

const TEAM_WIDGET_VISIBLE_WORKERS = 4;

export function isTerminalStatus(status: TeamRun["status"]): boolean {
    return status === "succeeded" || status === "degraded" || status === "stopped" || status === "failed";
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
    if (worker.status === "degraded") return { glyph: "◐", color: "warning" };
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
    const glyph = worker.attentionDebt ? { glyph: "⚠", color: "warning" as const } : statusGlyph(worker);
    const title = padVisible(worker.title, 18);
    const model = padVisible(compactModelThinking(worker, 16), 16);
    const communication = worker.status === "running" ? `comm:${durationLabel(worker.communicationAgeSeconds)}` : "";
    const pendingDelivery = worker.status === "running" && worker.pendingDeliveryRef ? ` QUEUED:${fitVisible(worker.pendingDeliveryRef, 12)}` : "";
    const pendingAck = worker.status === "running" && worker.pendingAckRef ? ` AWAITING_ACK:${fitVisible(worker.pendingAckRef, 12)}` : "";
    const exit = worker.status === "failed" ? ` exit:${worker.exitCode ?? "?"}` : "";
    const activity = worker.status === "running" && worker.activity ? ` ${worker.activity.replace(/^tool:/, "")}` : "";
    const report = worker.status === "running" && worker.lastReportPreview ? ` report:${fitVisible(worker.lastReportPreview, 48)}` : "";
    return `${theme.fg(glyph.color, glyph.glyph)} ${title} ${theme.fg("dim", model)} ${durationLabel(worker.elapsedSeconds)} ${theme.fg("dim", communication)}${theme.fg(worker.status === "failed" ? "error" : pendingDelivery || pendingAck ? "warning" : "dim", `${pendingDelivery}${pendingAck}${exit}${activity}${report}`)}`.trimEnd();
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
    if (counts.degraded) parts.push(`${paint("warning", "◐")} ${counts.degraded} degraded`);
    if (counts.skipped) parts.push(`${paint("muted", "⊘")} ${counts.skipped}`);
    if (counts.attentionDebt) parts.push(`${paint("warning", "attention")} ${counts.attentionDebt}`);
    if (counts.stale) parts.push(`${paint("warning", "stale")} ${counts.stale}`);
    return parts.join(" · ");
}

export function teamPlanLabel(playbookId: string): string {
    return playbookId === "generated-blueprint" ? "custom-plan" : playbookId;
}

export function compactTeamLine(run: TeamRun, theme: Theme): string {
    const statusColor = run.status === "failed" ? "error" : run.status === "degraded" || run.status === "stopped" ? "warning" : isTerminalStatus(run.status) ? "success" : "accent";
    return `${theme.fg("toolTitle", theme.bold("team"))} ${theme.fg(statusColor, run.status)} ${theme.fg("dim", teamPlanLabel(run.playbookId))} · ${teamCountSummary(run, theme)}`;
}

export function truncatedLines(lines: string[]): Component {
    return {
        render(width: number) {
            return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
        },
        invalidate() {},
    };
}

export function orderProjectedWorkers(workers: ProjectedWorker[]): ProjectedWorker[] {
    const priority = (worker: ProjectedWorker) => worker.attentionDebt ? 0 : worker.status === "running" ? 1 : worker.status === "pending" ? 2 : worker.status === "failed" || worker.status === "degraded" ? 3 : 4;
    const debtAge = (worker: ProjectedWorker) => worker.cancelPendingAgeSeconds ?? worker.pendingDeliveryAgeSeconds ?? worker.pendingAckAgeSeconds ?? worker.communicationAgeSeconds ?? 0;
    return workers.map((worker, index) => ({ worker, index }))
        .sort((a, b) => priority(a.worker) - priority(b.worker) || debtAge(b.worker) - debtAge(a.worker) || a.index - b.index)
        .map(({ worker }) => worker);
}

export function teamWidgetLines(run: TeamRun, theme: Theme): string[] {
    const projection = buildTeamStatusProjection(run, []);
    const ordered = orderProjectedWorkers(projection.workers);
    const shown = ordered.slice(0, TEAM_WIDGET_VISIBLE_WORKERS);
    const hidden = ordered.slice(shown.length);
    const lines = [compactTeamLine(run, theme), ...shown.map((worker) => workerCompactLine(worker, theme))];
    if (hidden.length > 0) {
        const active = hidden.filter((worker) => worker.status === "running");
        const pending = hidden.filter((worker) => worker.status === "pending");
        const debt = hidden.filter((worker) => worker.attentionDebt);
        const debtLabel = debt.length > 0 ? `; attention:${debt.length} [${debt.map((worker) => worker.roleId).join(", ")}]` : "";
        const activeLabel = active.length > 0 ? `; ${active.length} active: ${active.map((worker) => worker.roleId).join(", ")}` : "";
        const pendingLabel = pending.length > 0 ? `; ${pending.length} pending: ${pending.map((worker) => worker.roleId).join(", ")}` : "";
        lines.push(theme.fg(debt.length > 0 ? "warning" : "dim", `… ${hidden.length} more worker(s)${activeLabel}${pendingLabel}${debtLabel}`));
    }
    return lines;
}

export function teamWidget(run: TeamRun, theme: Theme): Component {
    return truncatedLines(teamWidgetLines(run, theme));
}

export function renderTeamDetails(run: TeamRun, theme: Theme): Component {
    const projection = buildTeamStatusProjection(run, []);
    const lines = [compactTeamLine(run, theme)];
    for (const worker of orderProjectedWorkers(projection.workers)) {
        const output = worker.outputKind ? ` output:${worker.outputKind}` : "";
        const route = worker.routingReason ? ` route:${fitVisible(worker.routingReason, 96)}` : "";
        const summary = worker.status !== "running" && worker.factualPreview ? ` summary:${worker.factualPreview}` : "";
        const report = worker.lastReportPreview ? ` report:${worker.lastReportPreview}` : "";
        const error = worker.errorReason ? ` error:${worker.errorReason}` : "";
        lines.push(`${workerCompactLine(worker, theme)}${output}${route}${summary}${report}${error}`);
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
