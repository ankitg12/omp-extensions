import { describe, expect, test } from "bun:test";
import { blockRanges, type Entry, estimateShake, PLACEHOLDER_TOKENS } from "./estimate";
import { label, severity } from "./shake-meter";

let seq = 0;
const call = (id: string, name: string, args: Record<string, unknown> = {}): Entry => ({
	type: "message",
	id: `e${seq++}`,
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id: string, toolName: string, chars: number, extra: Record<string, unknown> = {}): Entry => ({
	type: "message",
	id: `e${seq++}`,
	message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: "x".repeat(chars) }], ...extra },
});
const user = (text: string): Entry => ({ type: "message", id: `e${seq++}`, message: { role: "user", content: text } });
/** 20k chars = 5k tokens of recent text, enough to fill the 4k protect window. */
const tail = (): Entry => user("y".repeat(20_000));

describe("estimateShake", () => {
	test("counts old tool results, minus one placeholder each", () => {
		const e = estimateShake([call("a", "bash"), result("a", "bash", 40_000), tail()]);
		expect(e).toEqual({ tokens: 10_000 - PLACEHOLDER_TOKENS, toolResults: 1, blocks: 0 });
	});
	test("leaves results inside the newest 4k tokens", () => {
		expect(estimateShake([call("a", "bash"), result("a", "bash", 40_000)]).toolResults).toBe(0);
	});
	test("assistant thinking and signature fill the protect window (13:21 regression)", () => {
		const thinking: Entry = {
			type: "message",
			id: `e${seq++}`,
			message: { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(10_000), thinkingSignature: "s".repeat(10_000) }] },
		};
		expect(estimateShake([call("a", "bash"), result("a", "bash", 4_000), thinking]).toolResults).toBe(1);
	});
	test("useless results are eligible even inside the window", () => {
		expect(estimateShake([call("a", "bash"), result("a", "bash", 400, { useless: true })]).toolResults).toBe(1);
	});
	test("skips already-shaken results, skill tool, and skill:// reads", () => {
		const e = estimateShake([
			call("a", "bash"),
			result("a", "bash", 4_000, { prunedAt: 1 }),
			call("b", "skill"),
			result("b", "skill", 4_000),
			call("c", "read", { path: "skill://x" }),
			result("c", "read", 4_000),
			call("d", "read", { path: "/etc/hosts" }),
			result("d", "read", 4_000),
			tail(),
		]);
		expect(e.toolResults).toBe(1);
	});
	test("ignores entries before the latest compaction boundary", () => {
		const old = result("a", "bash", 40_000);
		const kept = user("kept");
		const e = estimateShake([call("a", "bash"), old, { type: "compaction", firstKeptEntryId: kept.id }, kept, tail()]);
		expect(e.toolResults).toBe(0);
	});
	test("counts large fenced blocks in old user text, not small ones", () => {
		const big = `intro\n\`\`\`\n${"z".repeat(2_000)}\n\`\`\`\nend`;
		const small = `\`\`\`\n${"z".repeat(100)}\n\`\`\``;
		expect(estimateShake([user(big), tail()]).blocks).toBe(1);
		expect(estimateShake([user(small), tail()]).blocks).toBe(0);
	});
});

describe("blockRanges", () => {
	test("outermost XML only, nested tags folded", () => {
		const text = "<a>\n<b>\nx\n</b>\n</a>";
		expect(blockRanges(text)).toEqual([{ start: 0, end: text.length }]);
	});
	test("indented XML open tag is not a block", () => {
		expect(blockRanges("  <a>\nx\n</a>")).toEqual([]);
	});
});

describe("display", () => {
	test("label and severity thresholds", () => {
		expect(label(999)).toBe("\uf0c4 <1k shakeable");
		expect(label(21_960)).toBe("\uf0c4 ~22k shakeable");
		expect([severity(9_999), severity(10_000), severity(25_000)]).toEqual(["dim", "warning", "error"]);
	});
});
