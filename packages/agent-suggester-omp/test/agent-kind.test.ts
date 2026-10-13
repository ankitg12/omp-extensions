import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Subagents get every extension rebound to their own session (`ctx.agent.kind === "sub"`).
// Suggestions are for the human watching the main agent; subagents must stay quiet.
const home = mkdtempSync(join(tmpdir(), "agent-suggester-kind-"));
mkdirSync(join(home, ".omp", "agent"), { recursive: true });
writeFileSync(join(home, ".omp", "agent", "agent-suggester.json"), JSON.stringify({ items: ["x"] }));
mock.module("os", () => ({ homedir: () => home }));

// Dynamic import so the os mock is in place before CONFIG_PATH is computed.
const { default: agentSuggester } = await import("../agent-suggester.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
});

function load(): { handlers: Record<string, Handler[]>; scheduled: () => number } {
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		setLabel: () => undefined,
		on: (event: string, handler: Handler) => {
			handlers[event] = [...(handlers[event] ?? []), handler];
		},
		registerCommand: () => undefined,
		sendUserMessage: () => undefined,
	};
	agentSuggester(pi as never);
	let count = 0;
	globalThis.setTimeout = (() => {
		count++;
		return realSetTimeout(() => undefined, 0);
	}) as unknown as typeof setTimeout;
	return { handlers, scheduled: () => count };
}

test("subagent session arms no suggestion timer", async () => {
	const { handlers, scheduled } = load();
	await handlers.session_start?.[0]?.({}, { agent: { kind: "sub", depth: 1 }, hasUI: false });
	expect(scheduled()).toBe(0);
	await handlers.session_shutdown?.[0]?.({}, {});
});

test("main session arms the suggestion timer", async () => {
	const { handlers, scheduled } = load();
	await handlers.session_start?.[0]?.({}, { agent: { kind: "main", depth: 0 }, hasUI: false });
	expect(scheduled()).toBe(1);
	await handlers.session_shutdown?.[0]?.({}, {});
});
