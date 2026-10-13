import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Subagents have no terminal input, so idle detection would auto-engage AFK and inject
// an AFK prompt into the subagent. Detection must arm only in kinds listed in `agents`.
const home = mkdtempSync(join(tmpdir(), "agent-afk-kind-"));
mock.module("os", () => ({ homedir: () => home }));

// Dynamic import so the os mock is in place before the config path is computed.
const { default: agentAfk } = await import("../agent-afk.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;
const realSetInterval = globalThis.setInterval;
afterEach(() => {
	globalThis.setInterval = realSetInterval;
});

function load(): { handlers: Record<string, Handler[]>; armed: () => number; inputHooks: () => number } {
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		setLabel: () => undefined,
		on: (event: string, handler: Handler) => {
			handlers[event] = [...(handlers[event] ?? []), handler];
		},
		registerCommand: () => undefined,
		sendUserMessage: () => undefined,
		events: { emit: () => undefined, on: () => undefined },
	};
	agentAfk(pi as never);
	let count = 0;
	globalThis.setInterval = (() => {
		count++;
		return realSetInterval(() => undefined, 1_000_000);
	}) as unknown as typeof setInterval;
	let hooks = 0;
	handlers.__ui = [
		() => ({
			onTerminalInput: () => {
				hooks++;
				return () => undefined;
			},
		}),
	];
	return { handlers, armed: () => count, inputHooks: () => hooks };
}

function ctx(kind: "main" | "sub", handlers: Record<string, Handler[]>): unknown {
	return { agent: { kind, depth: kind === "main" ? 0 : 1 }, hasUI: kind === "main", ui: handlers.__ui?.[0]?.({}, {}) };
}

test("subagent session arms no AFK detection", async () => {
	const { handlers, armed, inputHooks } = load();
	await handlers.session_start?.[0]?.({}, ctx("sub", handlers));
	expect(armed()).toBe(0);
	expect(inputHooks()).toBe(0);
	await handlers.session_shutdown?.[0]?.({}, {});
});

test("main session arms AFK detection", async () => {
	const { handlers, armed, inputHooks } = load();
	await handlers.session_start?.[0]?.({}, ctx("main", handlers));
	expect(armed()).toBe(1);
	expect(inputHooks()).toBe(1);
	await handlers.session_shutdown?.[0]?.({}, {});
});
