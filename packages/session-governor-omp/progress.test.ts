import { describe, expect, test } from "bun:test";
import { compileRules, createEnvironment, decide, type RuleVars, type ShiftState } from "./governor.ts";
import { type ProgressStatus, progressReports, progressStats } from "./progress.ts";

// Same shape as a real OMP session entry (verified against a .jsonl session file).
const call = (status: string, goal = "inbound ssh", name = "progress") => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id: "t", name, arguments: { goal, status, evidence: "x" } }] },
});
const stats = (...s: ProgressStatus[]) => progressStats(progressReports(s.map(x => call(x))));

describe("progressReports", () => {
	test("reads progress tool calls only; ignores other tools, users, bad status", () => {
		const branch = [
			call("blocked"),
			call("blocked", "g", "bash"),
			call("nonsense"),
			{ type: "message", message: { role: "user", content: [{ type: "toolCall", name: "progress", arguments: { status: "done" } }] } },
			{ type: "custom" },
			call("progress"),
		];
		expect(progressReports(branch).map(r => r.status)).toEqual(["blocked", "progress"]);
	});
});

describe("progressStats", () => {
	test("empty branch", () => expect(stats()).toEqual({ blocked_streak: 0, attempts_on_goal: 0, goal: undefined, last: undefined }));
	test("blocked streak counts the tail only", () => {
		expect(stats("blocked", "progress", "blocked", "blocked").blocked_streak).toBe(2);
		expect(stats("blocked", "blocked", "progress").blocked_streak).toBe(0);
	});
	test("a new goal resets both counters", () => {
		const s = progressStats(progressReports([call("blocked", "ssh"), call("blocked", "ssh"), call("progress", "Write  README "), call("progress", "write readme")]));
		expect(s).toMatchObject({ blocked_streak: 0, attempts_on_goal: 2, goal: "write readme" });
		const b = progressStats(progressReports([call("blocked", "ssh"), call("blocked", "readme")]));
		expect(b.blocked_streak).toBe(1);
	});
	test("attempts_on_goal counts every report since done (catches false 'progress')", () => {
		expect(stats("done", "progress", "progress", "blocked", "progress").attempts_on_goal).toBe(4);
		expect(stats("progress", "done").attempts_on_goal).toBe(0);
	});
});

describe("stuck escalation rule (2026-10-05 SSH outage replay shape)", () => {
	const env = createEnvironment();
	const rules = compileRules(env, [
		{ name: "stuck-escalate", when: 'blocked_streak >= 3 || attempts_on_goal >= 6', use: "@slow", effort: "high" },
	]);
	const base: RuleVars = {
		cost: 0.5, tokens: 20_000n, context_window: 200_000n, context_pct: 10, turns: 5n, elapsed_min: 30,
		model: "amd-gemini/gemini-3.8-flash", agent: "main", afk: false, turns_since_prune: 5n,
		blocked_streak: 0n, attempts_on_goal: 0n,
	};
	const fresh = (): ShiftState => ({ fired: new Set(), paused: false });
	test("fires on three blocked in a row", () => {
		const s = stats("progress", "blocked", "blocked", "blocked");
		const d = decide(env, rules, { ...base, blocked_streak: BigInt(s.blocked_streak), attempts_on_goal: BigInt(s.attempts_on_goal) }, fresh());
		expect(d.kind === "switch" && d.rule.name).toBe("stuck-escalate");
	});
	test("fires on six reports without done, even when the model claims progress", () => {
		const s = stats("progress", "progress", "blocked", "progress", "progress", "progress");
		const d = decide(env, rules, { ...base, blocked_streak: BigInt(s.blocked_streak), attempts_on_goal: BigInt(s.attempts_on_goal) }, fresh());
		expect(d.kind === "switch" && d.rule.name).toBe("stuck-escalate");
	});
	test("does not fire on steady progress that ends in done", () => {
		const s = stats("progress", "blocked", "progress", "done");
		expect(decide(env, rules, { ...base, blocked_streak: BigInt(s.blocked_streak), attempts_on_goal: BigInt(s.attempts_on_goal) }, fresh()).kind).toBe("none");
	});
});
