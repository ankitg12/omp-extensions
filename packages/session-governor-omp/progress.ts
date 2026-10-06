/**
 * Agent self-reported progress (stuck detection).
 *
 * The agent calls the `progress` tool once per turn, before its final reply. The governor
 * derives counters from those tool calls in the session branch, so the counters survive
 * resume and follow branch switches without extra persisted state.
 */

import { isRecord } from "./guards.ts";

export const PROGRESS_TOOL = "progress";

export const PROGRESS_STATUSES = ["progress", "blocked", "done"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

export interface ProgressReport {
	goal: string;
	status: ProgressStatus;
	evidence: string;
}

export interface ProgressStats {
	/** `blocked` reports in a row on the current goal; any other status or a new goal resets it. */
	blocked_streak: number;
	/** Reports on the current goal since its last `done`, whatever their status (catches a model that believes it is progressing). */
	attempts_on_goal: number;
	/** Goal of the latest report. */
	goal?: string;
	last?: ProgressStatus;
}

export const PROGRESS_DESCRIPTION = [
	"Report your progress toward the user's current goal. Call this exactly once per turn, after your work and before your final reply.",
	"status=progress: this turn moved the goal forward, and `evidence` shows it.",
	"status=blocked: this turn did not move the goal forward (the fix did not work, the same error came back, or you do not know the cause).",
	"status=done: the goal is met and verified.",
	"Be honest: `blocked` is not a failure. Repeated `blocked` reports bring in a stronger model to help.",
	"goal: one line, keep the same text while the goal is the same. evidence: one raw output line, not a summary.",
].join(" ");

const isStatus = (v: unknown): v is ProgressStatus => typeof v === "string" && (PROGRESS_STATUSES as readonly string[]).includes(v);

/** `progress` tool calls from assistant messages, in branch order. Calls with an invalid status are ignored. */
export function progressReports(branch: readonly unknown[]): ProgressReport[] {
	const out: ProgressReport[] = [];
	for (const e of branch) {
		if (!isRecord(e) || e.type !== "message" || !isRecord(e.message) || e.message.role !== "assistant") continue;
		const content = e.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isRecord(part) || part.type !== "toolCall" || part.name !== PROGRESS_TOOL || !isRecord(part.arguments)) continue;
			const a = part.arguments;
			if (!isStatus(a.status)) continue;
			out.push({ goal: String(a.goal ?? ""), status: a.status, evidence: String(a.evidence ?? "") });
		}
	}
	return out;
}

/** Goals compare case- and space-insensitively, so small rewording of the same line still counts as one goal. */
const goalKey = (goal: string): string => goal.trim().toLowerCase().replace(/\s+/g, " ");

export function progressStats(reports: readonly ProgressReport[]): ProgressStats {
	const last = reports.at(-1);
	const key = last ? goalKey(last.goal) : "";
	const onGoal = (r: ProgressReport) => goalKey(r.goal) === key;
	let blocked_streak = 0;
	for (let i = reports.length - 1; i >= 0 && onGoal(reports[i]) && reports[i].status === "blocked"; i--) blocked_streak++;
	let attempts_on_goal = 0;
	for (let i = reports.length - 1; i >= 0 && onGoal(reports[i]) && reports[i].status !== "done"; i--) attempts_on_goal++;
	return { blocked_streak, attempts_on_goal, goal: last?.goal, last: last?.status };
}
