import { expect, test } from "bun:test";
import { EPOCH_SHAPE, emptyStats, FOREIGN_SHAPE, pruneBeforeCut, pruneForeignHistory } from "./prune.ts";

const ELIDE_MIN_CHARS = FOREIGN_SHAPE.minChars;

const OPUS = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { api: "openai-completions", provider: "amd", id: "gemini-flash" };
const BIG = (tag: string) => `${tag}HEAD${"x".repeat(ELIDE_MIN_CHARS * 2)}${tag}TAIL`;

function turn(model: typeof OPUS, id: string, text: string, extra: unknown[] = [], ts = 2) {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text: "narration" }, { type: "toolCall", id, name: "bash", arguments: {} }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "toolUse",
			usage: {},
			timestamp: 1,
		},
		{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }, ...extra], isError: false, timestamp: ts },
	];
}
const stats = emptyStats;

test("native history is returned by identity (never modified)", () => {
	const messages = [...turn(OPUS, "a", BIG("A")), ...turn(OPUS, "b", BIG("B"))] as never[];
	expect(pruneForeignHistory(messages, OPUS)).toBe(messages);
});

test("after a switch, old foreign results are elided and the 2 most recent stay whole", () => {
	const messages = [...turn(OPUS, "a", BIG("A")), ...turn(OPUS, "b", BIG("B")), ...turn(OPUS, "c", BIG("C"))] as never[];
	const s = stats();
	const out = pruneForeignHistory(messages, FLASH, "elide", s);
	const text = JSON.stringify(out);
	expect(s.elided).toBe(1);
	expect(s.kept).toBe(2);
	expect(text).toContain("ATAIL");
	expect(text).toContain("[elided");
	expect(text.split("[elided").length).toBe(2);
	expect(text.length).toBeLessThan(JSON.stringify(messages).length - ELIDE_MIN_CHARS);
	expect(text).toContain(`BHEAD${"x".repeat(ELIDE_MIN_CHARS * 2)}BTAIL`);
	expect(s.charsAfter).toBeLessThan(s.charsBefore);
});

test("foreign tool calls are removed but assistant prose survives", () => {
	const out = pruneForeignHistory(turn(OPUS, "a", "small") as never[], FLASH);
	expect(JSON.stringify(out)).not.toContain("toolCall");
	expect(JSON.stringify(out)).toContain("narration");
});

test("drop mode removes foreign results including images", () => {
	const img = { type: "image", data: "AAAA", mimeType: "image/png" };
	const out = pruneForeignHistory(turn(OPUS, "a", "gone", [img]) as never[], FLASH, "drop");
	expect(JSON.stringify(out)).not.toContain("gone");
	expect(JSON.stringify(out)).not.toContain("AAAA");
});

test("input array is not mutated (disk/session history intact)", () => {
	const messages = [...turn(OPUS, "a", BIG("A")), ...turn(OPUS, "b", "s"), ...turn(OPUS, "c", "s")] as never[];
	const before = JSON.stringify(messages);
	pruneForeignHistory(messages, FLASH);
	expect(JSON.stringify(messages)).toBe(before);
});

test("pruning is stable across requests: appending turns does not change the pruned prefix", () => {
	const base = [...turn(OPUS, "a", BIG("A")), ...turn(OPUS, "b", BIG("B")), ...turn(OPUS, "c", BIG("C"))] as never[];
	const first = JSON.stringify(pruneForeignHistory(base, FLASH));
	const grown = [...base, ...turn(FLASH, "n1", BIG("N")), ...turn(FLASH, "n2", BIG("M"))] as never[];
	const second = pruneForeignHistory(grown, FLASH);
	expect(JSON.stringify(second).startsWith(first.slice(0, -1))).toBe(true);
});

test("epoch cut elides only results older than the cut, keeping calls and structure", () => {
	const messages = [...turn(OPUS, "a", BIG("A"), [], 10), ...turn(OPUS, "b", BIG("B"), [], 30)] as never[];
	const s = stats();
	const out = pruneBeforeCut(messages, 20, EPOCH_SHAPE, s);
	const text = JSON.stringify(out);
	expect(s.epochElided).toBe(1);
	expect(text).toContain("ATAIL");
	expect(text).toContain(`BHEAD${"x".repeat(ELIDE_MIN_CHARS * 2)}BTAIL`);
	// 2 assistant turns, each containing a toolCall
	const calls = out.filter(m => typeof m === "object" && m !== null && "role" in m && m.role === "assistant");
	expect(calls).toHaveLength(2);
	expect(out).toHaveLength(messages.length);
});

test("epoch cut returns input by identity when nothing qualifies", () => {
	const messages = [...turn(OPUS, "a", "small", [], 10), ...turn(OPUS, "b", BIG("B"), [], 30)] as never[];
	expect(pruneBeforeCut(messages, 20)).toBe(messages);
});

test("a latched cut keeps the pruned prefix byte-identical as the session grows (cache-stable)", () => {
	const base = [...turn(OPUS, "a", BIG("A"), [], 10), ...turn(OPUS, "b", BIG("B"), [], 30)] as never[];
	const first = JSON.stringify(pruneBeforeCut(base, 20));
	const grown = [...base, ...turn(OPUS, "c", BIG("C"), [], 40), ...turn(OPUS, "d", BIG("D"), [], 50)] as never[];
	expect(JSON.stringify(pruneBeforeCut(grown, 20)).startsWith(first.slice(0, -1))).toBe(true);
});

test("epoch and foreign passes compose", () => {
	const messages = [...turn(OPUS, "a", BIG("A"), [], 10), ...turn(OPUS, "b", BIG("B"), [], 11), ...turn(OPUS, "c", BIG("C"), [], 12), ...turn(FLASH, "d", BIG("D"), [], 13)] as never[];
	const s = stats();
	const out = pruneForeignHistory(pruneBeforeCut(messages, 13, EPOCH_SHAPE, s), FLASH, "elide", s);
	expect(s.epochElided).toBe(3);
	expect(JSON.stringify(out)).toContain(`DHEAD${"x".repeat(ELIDE_MIN_CHARS * 2)}DTAIL`);
	expect(s.charsAfter).toBeLessThan(s.charsBefore);
});
