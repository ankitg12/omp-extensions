import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import governor, { loadConfig, restoreState } from "./governor.ts";

interface Entry {
	type: string;
	model?: string;
	role?: string;
	resolvedModelIsFallback?: boolean;
	message?: { role: string; timestamp: number };
	customType?: string;
	data?: unknown;
}
interface Message {
	role: string;
	timestamp: number;
	content: { type: string; text: string }[];
}
interface Scenario {
	entries: Entry[];
	messages: Message[];
	current: { provider: string; id: string };
	agent: { kind: string };
	notices: string[];
	run(): Message[] | undefined;
}

async function withScenario(config: string, check: (scenario: Scenario) => void | Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "governor-switch-"));
	const previousConfig = process.env.OMP_GOVERNOR_CONFIG;
	const previousLog = process.env.OMP_GOVERNOR_LOG;
	try {
		const path = join(dir, "governor.yml");
		writeFileSync(path, config);
		process.env.OMP_GOVERNOR_CONFIG = path;
		process.env.OMP_GOVERNOR_LOG = join(dir, "log.jsonl");
		const handlers: Record<string, (event: object, ctx: object) => unknown> = {};
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", timestamp: 100 } },
			{ type: "message", message: { role: "user", timestamp: 300 } },
		];
		const messages: Message[] = [
			{ role: "toolResult", timestamp: 200, content: [{ type: "text", text: "older ".repeat(100) }] },
			{ role: "toolResult", timestamp: 400, content: [{ type: "text", text: "recent ".repeat(100) }] },
		];
		const current = { provider: "provider", id: "one" };
		const notices: string[] = [];
		const ctx = { model: current, agent: { kind: "main" }, sessionManager: { getEntries: () => entries, getBranch: () => entries }, ui: { notify: (message: string) => notices.push(message) } };
		const pi = {
			on: (name: string, handler: (event: object, context: object) => unknown) => { handlers[name] = handler; },
			events: { on: () => {} }, registerCommand: () => {},
			appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		};
		governor(pi as never);
		await handlers.session_start({}, ctx);
		await check({ entries, messages, current, agent: ctx.agent, notices, run: () => {
			const result = handlers.context({ messages }, ctx) as { messages?: Message[] } | undefined;
			return result?.messages;
		} });
	} finally {
		if (previousConfig === undefined) delete process.env.OMP_GOVERNOR_CONFIG;
		else process.env.OMP_GOVERNOR_CONFIG = previousConfig;
		if (previousLog === undefined) delete process.env.OMP_GOVERNOR_LOG;
		else process.env.OMP_GOVERNOR_LOG = previousLog;
		rmSync(dir, { recursive: true, force: true });
	}
}

const enabled = "pruneOnModelSwitch: true\nprune:\n  style: aggressive\nrules: []\n";

test("confirmed model switch prunes older results on wire and keeps latest exchange", async () => {
	await withScenario(enabled, s => {
		s.entries.push({ type: "model_change", model: "provider/two", role: "sonnet" });
		s.current.id = "two";
		const out = s.run();
		expect(out?.[0].content[0].text).toContain("[elided");
		expect(out?.[1]).toEqual(s.messages[1]);
		expect(s.messages[0].content[0].text).not.toContain("[elided");
		expect(s.notices).toHaveLength(1);
		expect(restoreState(s.entries).cut).toEqual({ rule: "model-switch", cutTs: 300 });
		s.run();
		expect(s.notices).toHaveLength(1);
	});
});

test("switch pruning is off by default", async () => {
	await withScenario("prune:\n  style: aggressive\nrules: []\n", s => {
		s.entries.push({ type: "model_change", model: "provider/two" });
		s.current.id = "two";
		expect(s.run()).toBeUndefined();
		expect(s.notices).toEqual([]);
	});
});

test("fallback and missing model change do not trigger switch pruning", async () => {
	for (const role of ["fallback", "prewalk", "missing"]) {
		await withScenario(enabled, s => {
			if (role !== "missing") s.entries.push({ type: "model_change", model: "provider/two", role });
			s.current.id = "two";
			expect(s.run()).toBeUndefined();
			expect(s.notices).toEqual([]);
		});
	}
});

test("does not prune in a subagent or on resolved fallback", async () => {
	await withScenario(enabled, s => {
		s.agent.kind = "sub";
		s.entries.push({ type: "model_change", model: "provider/two" });
		s.current.id = "two";
		expect(s.run()).toBeUndefined();
	});
	await withScenario(enabled, s => {
		s.entries.push({ type: "model_change", model: "provider/two", resolvedModelIsFallback: true });
		s.current.id = "two";
		expect(s.run()).toBeUndefined();
	});
});

test("invalid switch policy is rejected", () => {
	const dir = mkdtempSync(join(tmpdir(), "governor-switch-config-"));
	try {
		const path = join(dir, "governor.yml");
		writeFileSync(path, 'pruneOnModelSwitch: "yes"\n');
		expect(() => loadConfig(path)).toThrow(/must be a boolean/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
