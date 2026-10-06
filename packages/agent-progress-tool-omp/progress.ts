/**
 * Agent self-reported progress sensor. Pure analysis functions and data contracts.
 *
 * The agent calls the `progress` tool once per turn, before its final reply.
 * Other extensions and analysis tools (session-governor-omp, daylog, agentsview)
 * read progress entries from the session branch.
 */

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
		if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
		const entry = e as Record<string, unknown>;
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (typeof msg !== "object" || msg === null || Array.isArray(msg)) continue;
		const message = msg as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
			const p = part as Record<string, unknown>;
			if (p.type !== "toolCall" || p.name !== PROGRESS_TOOL) continue;
			const a = p.arguments;
			if (typeof a !== "object" || a === null || Array.isArray(a)) continue;
			const args = a as Record<string, unknown>;
			if (!isStatus(args.status)) continue;
			out.push({ goal: String(args.goal ?? ""), status: args.status, evidence: String(args.evidence ?? "") });
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
