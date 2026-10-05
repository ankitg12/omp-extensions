import { describe, expect, test } from "bun:test";
import decayingEffortExtension, { type ConfiguredThinkingLevel } from "./decaying-effort.ts";

describe("decaying-effort-omp clamping override bug", () => {
	test("reproduces false user override when model clamps level", async () => {
		let currentLevel: ConfiguredThinkingLevel = "medium";
		const hooks = new Map<string, Function[]>();
		const mockPi = {
			on(event: string, handler: Function) {
				const list = hooks.get(event) ?? [];
				list.push(handler);
				hooks.set(event, list);
			},
			registerCommand() {},
			getThinkingLevel() {
				return currentLevel;
			},
			setThinkingLevel(level: ConfiguredThinkingLevel) {
				// Simulates model clamping "max" or "xhigh" down to "high"
				if (level === "max" || level === "xhigh") {
					currentLevel = "high";
				} else {
					currentLevel = level;
				}
			},
		};

		decayingEffortExtension(mockPi as any);
		const beforeAgentStart = hooks.get("before_agent_start")?.[0];
		const ctx = { ui: { notify() {} } };

		// Turn 1: requests "max", model clamps to "high"
		await beforeAgentStart?.({}, ctx);
		expect(currentLevel).toBe("high");

		// Turn 2: requests "xhigh", model clamps to "high"
		await beforeAgentStart?.({}, ctx);
		expect(currentLevel).toBe("high");

		// Turn 3: requests "high", model keeps "high"
		await beforeAgentStart?.({}, ctx);
		expect(currentLevel).toBe("high");

		// Turn 4: requests "medium", model sets "medium"
		await beforeAgentStart?.({}, ctx);
		expect(currentLevel).toBe("medium");

		// Turn 5: requests "auto", model sets "auto"
		await beforeAgentStart?.({}, ctx);
		expect(currentLevel).toBe("auto");
	});
});
