import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { ELIDE_MIN_CHARS, loadConfig, pruneForeignHistory, type PruneStats } from "./model-switch-prune.ts";

const OPUS = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" };
const FLASH = { api: "openai-completions", provider: "amd", id: "gemini-flash" };
const BIG = (tag: string) => `${tag}HEAD${"x".repeat(ELIDE_MIN_CHARS * 2)}${tag}TAIL`;

function turn(model: typeof OPUS, id: string, text: string, extra: unknown[] = []) {
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
		{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }, ...extra], isError: false, timestamp: 2 },
	];
}
const stats = (): PruneStats => ({ foreignCalls: 0, foreignResults: 0, kept: 0, elided: 0, dropped: 0, charsBefore: 0, charsAfter: 0 });

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

test("config falls back safely and context hook wires through", async () => {
	const dir = mkdtempSync(join(tmpdir(), "msp-"));
	try {
		const cfg = join(dir, "c.json");
		expect(loadConfig(cfg)).toEqual({ mode: "elide", debug: false });
		writeFileSync(cfg, JSON.stringify({ mode: "bogus" }));
		expect(loadConfig(cfg)).toEqual({ mode: "elide", debug: false });
		const log = join(dir, "l.log");
		writeFileSync(cfg, JSON.stringify({ mode: "elide", debug: true }));
		let handler: ((e: unknown, c: unknown) => unknown) | undefined;
		extension({ on: (_n: string, fn: never) => (handler = fn) } as never, { configPath: cfg, debugLogPath: log });
		const messages = [...turn(OPUS, "a", BIG("A")), ...turn(OPUS, "b", "s"), ...turn(OPUS, "c", "s")];
		const res = handler?.({ messages }, { model: FLASH }) as { messages: unknown[] } | undefined;
		expect(JSON.stringify(res?.messages)).toContain("[elided");
		expect(JSON.stringify(res?.messages)).not.toContain("toolCall");
		expect(handler?.({ messages }, { model: undefined })).toBeUndefined();
		const rec = JSON.parse(readFileSync(log, "utf8").trim());
		expect(rec.elided).toBe(1);
		expect(JSON.stringify(rec)).not.toContain("HEAD");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
