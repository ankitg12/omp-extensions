import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import decayingEffortExtension, { type ConfiguredThinkingLevel } from "./decaying-effort.ts";

type Handler = (event: unknown, ctx: MockCtx) => Promise<void> | void;
type CommandHandler = (args: string, ctx: MockCtx) => Promise<void> | void;

interface ThinkingEntry {
	type: "thinking_level_change";
	thinkingLevel: string;
	configured: string | null;
}

interface MockCtx {
	ui: { notify(message: string, level: string): void };
	sessionManager: { getEntries(): readonly unknown[] };
}

/**
 * Mirrors real OMP semantics (runtime-init.ts / model-controls.ts):
 * - `getThinkingLevel()` returns the RESOLVED level, never "auto".
 * - every change appends a `thinking_level_change` entry carrying `configured` (the selector).
 * - with "auto" selected, the auto-thinking judge re-resolves per prompt without changing `configured`.
 */
function createMockOmp(maxLevel?: ConfiguredThinkingLevel) {
	const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const hooks = new Map<string, Handler[]>();
	const commands = new Map<string, { description?: string; handler: CommandHandler }>();
	const notifications: string[] = [];
	const entries: ThinkingEntry[] = [{ type: "thinking_level_change", thinkingLevel: "low", configured: null }];
	let configured: string = "inherit";
	let resolved = "low";

	const record = () => entries.push({ type: "thinking_level_change", thinkingLevel: resolved, configured });

	const api = {
		on(event: string, handler: Handler) {
			hooks.set(event, [...(hooks.get(event) ?? []), handler]);
		},
		registerCommand(name: string, def: { description?: string; handler: CommandHandler }) {
			commands.set(name, def);
		},
		getThinkingLevel: () => resolved,
		setThinkingLevel(level: string) {
			if (level === "auto") {
				configured = "auto";
				resolved = "low"; // provisional resolution, like real OMP
			} else {
				configured = maxLevel && order.indexOf(level) > order.indexOf(maxLevel) ? maxLevel : level;
				resolved = configured;
			}
			record();
		},
	};

	const ctx: MockCtx = {
		ui: { notify: message => void notifications.push(message) },
		sessionManager: { getEntries: () => entries },
	};

	return {
		api: api as unknown as ExtensionAPI, // structural test double of the slice the extension uses
		notifications,
		ctx,
		get configured() {
			return configured;
		},
		/** OMP's auto-thinking judge picks a level for this prompt; the selector stays "auto". */
		autoJudge(level: string) {
			resolved = level;
			record();
		},
		/** The user picks a level via Shift+Tab / selector. */
		userSelects(level: string) {
			configured = level;
			resolved = level;
			record();
		},
		turn: () => hooks.get("before_agent_start")![0]!({}, ctx),
		command: (args: string) => commands.get("effort-decay")!.handler(args, ctx),
	};
}

const overrideNotices = (n: string[]) => n.filter(m => m.includes("Manual override detected"));

describe("decaying-effort-omp", () => {
	test("defaults to max -> xhigh -> high -> medium -> auto schedule", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		for (const target of ["max", "xhigh", "high", "medium", "auto", "auto"]) {
			await omp.turn();
			expect(omp.configured).toBe(target);
		}
	});

	test("respects manual user override", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		await omp.turn();
		expect(omp.configured).toBe("max");
		omp.userSelects("low");
		await omp.turn();
		expect(omp.configured).toBe("low");
		expect(overrideNotices(omp.notifications)).toHaveLength(1);
	});

	// Regression: session 01a10f66 (2026-10-06) — the auto judge re-resolved low -> high and
	// the extension reported a manual override on every subsequent turn.
	test("auto-thinking judge re-resolution is not a manual override", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		for (let i = 0; i < 5; i++) await omp.turn(); // reaches "auto"
		expect(omp.configured).toBe("auto");
		for (const judged of ["high", "low", "high"]) {
			omp.autoJudge(judged);
			await omp.turn();
			expect(omp.configured).toBe("auto");
		}
		expect(overrideNotices(omp.notifications)).toHaveLength(0);
	});

	test("model ceiling clamp is not a manual override", async () => {
		const omp = createMockOmp("high");
		decayingEffortExtension(omp.api);
		await omp.turn(); // max -> clamped high
		await omp.turn(); // xhigh -> clamped high
		expect(omp.configured).toBe("high");
		expect(omp.notifications.some(m => m.includes("clamped from max"))).toBe(true);
		expect(overrideNotices(omp.notifications)).toHaveLength(0);
	});

	test("override is announced once, not every turn", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		for (let i = 0; i < 5; i++) await omp.turn();
		omp.userSelects("high");
		for (let i = 0; i < 4; i++) await omp.turn();
		expect(omp.configured).toBe("high");
		expect(overrideNotices(omp.notifications)).toHaveLength(1);
	});

	test("slash command reset restores decay", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		await omp.turn();
		await omp.turn();
		expect(omp.configured).toBe("xhigh");
		await omp.command("reset");
		await omp.turn();
		expect(omp.configured).toBe("max");
	});

	test("custom schedule configuration", async () => {
		const omp = createMockOmp();
		decayingEffortExtension(omp.api);
		await omp.command("schedule high,low");
		for (const target of ["high", "low", "low"]) {
			await omp.turn();
			expect(omp.configured).toBe(target);
		}
	});
});
