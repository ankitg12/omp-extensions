import { describe, expect, test } from "bun:test";
import { type ProgressStatus, progressReports, progressStats } from "./progress.ts";

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
