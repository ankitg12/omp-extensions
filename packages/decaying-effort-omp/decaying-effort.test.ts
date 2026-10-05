import { describe, expect, test } from "bun:test";
import decayingEffortExtension, { DEFAULT_SCHEDULE, type ConfiguredThinkingLevel } from "./decaying-effort.ts";

interface MockExtensionAPI {
	hooks: Map<string, Function[]>;
	commands: Map<string, { description?: string; handler: Function }>;
	currentThinkingLevel: ConfiguredThinkingLevel | undefined;
	notifications: { message: string; level: string }[];
	api: any;
}

function createMockAPI(initialLevel: ConfiguredThinkingLevel = "inherit"): MockExtensionAPI {
	const hooks = new Map<string, Function[]>();
	const commands = new Map<string, { description?: string; handler: Function }>();
	const notifications: { message: string; level: string }[] = [];
	let currentThinkingLevel: ConfiguredThinkingLevel | undefined = initialLevel;

	const api = {
		on(event: string, handler: Function) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
		registerCommand(name: string, def: { description?: string; handler: Function }) {
			commands.set(name, def);
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
		setThinkingLevel(level: ConfiguredThinkingLevel) {
			currentThinkingLevel = level;
		},
	};

	return {
		hooks,
		commands,
		get currentThinkingLevel() {
			return currentThinkingLevel;
		},
		set currentThinkingLevel(lvl) {
			currentThinkingLevel = lvl;
		},
		notifications,
		api,
	};
}

const mockCtx = (notifications: { message: string; level: string }[]) => ({
	ui: {
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
	},
});

describe("decaying-effort-omp", () => {
	test("defaults to max -> xhigh -> high -> medium -> auto schedule", async () => {
		const mock = createMockAPI();
		decayingEffortExtension(mock.api);

		const beforeAgentStart = mock.hooks.get("before_agent_start")?.[0];
		expect(beforeAgentStart).toBeDefined();

		const expected = ["max", "xhigh", "high", "medium", "auto", "auto"];
		for (const target of expected) {
			await beforeAgentStart?.({}, mockCtx(mock.notifications));
			expect(mock.currentThinkingLevel).toBe(target);
		}
	});

	test("respects manual user override", async () => {
		const mock = createMockAPI();
		decayingEffortExtension(mock.api);

		const beforeAgentStart = mock.hooks.get("before_agent_start")?.[0];

		// Turn 1 -> max
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("max");

		// User manually switches to "low"
		mock.currentThinkingLevel = "low";

		// Turn 2 should detect override and keep "low"
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("low");
	});

	test("slash command reset restores decay", async () => {
		const mock = createMockAPI();
		decayingEffortExtension(mock.api);

		const beforeAgentStart = mock.hooks.get("before_agent_start")?.[0];
		const cmd = mock.commands.get("effort-decay");

		// Turn 1 -> max, Turn 2 -> xhigh
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("xhigh");

		// User resets
		await cmd?.handler("reset", mockCtx(mock.notifications));

		// Next turn starts at max again
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("max");
	});

	test("custom schedule configuration", async () => {
		const mock = createMockAPI();
		decayingEffortExtension(mock.api);

		const beforeAgentStart = mock.hooks.get("before_agent_start")?.[0];
		const cmd = mock.commands.get("effort-decay");

		await cmd?.handler("schedule high,low", mockCtx(mock.notifications));

		// Turn 1 -> high
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("high");

		// Turn 2 -> low
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("low");

		// Turn 3 -> remains low
		await beforeAgentStart?.({}, mockCtx(mock.notifications));
		expect(mock.currentThinkingLevel).toBe("low");
	});
});
