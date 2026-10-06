import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchCost,
	branchTurns,
	compileRules,
	configuredEffort,
	createEnvironment,
	decide,
	ENTRY_TYPE,
	loadConfig,
	restoreState,
	type RuleVars,
	type ShiftState,
} from "./governor.ts";

const env = createEnvironment();
const vars = (over: Partial<RuleVars> = {}): RuleVars => ({
	turns_since_prune: 3n,
	blocked_streak: 0n,
	attempts_on_goal: 0n,
	cost: 0.5,
	tokens: 20_000n,
	context_window: 200_000n,
	context_pct: 10,
	turns: 3n,
	elapsed_min: 5,
	model: "anthropic/claude-opus-5.5",
	agent: "main",
	afk: false,
	...over,
});
const fresh = (): ShiftState => ({ fired: new Set(), paused: false });

describe("compileRules", () => {
	test("accepts int literal against double variable", () => {
		expect(compileRules(env, [{ when: "cost > 1", use: "x" }])).toHaveLength(1);
	});
	test("rejects unknown variable at load time", () => {
		expect(() => compileRules(env, [{ name: "typo", when: "costt > 1", use: "x" }])).toThrow(/typo/);
	});
	test("rejects non-bool expression", () => {
		expect(() => compileRules(env, [{ when: "cost", use: "x" }])).toThrow(/must be bool, got double/);
	});
	test("requires at least one of use or prune", () => {
		expect(() => compileRules(env, [{ when: "true" } as never])).toThrow(/needs 'use', 'effort', or 'prune: true'/);
	});
	test("accepts effort-only rule; rejects revert or repeat on it", () => {
		expect(compileRules(env, [{ when: "turns >= 1", effort: "high" }])).toHaveLength(1);
		expect(() => compileRules(env, [{ when: "afk", effort: "low", revert: true }])).toThrow(/'revert' needs 'use'/);
		expect(() => compileRules(env, [{ when: "true", effort: "low", repeat: true }])).toThrow(/repeat/);
	});
	test("accepts prune-only rule", () => {
		expect(compileRules(env, [{ when: "tokens > 100000", prune: true }])).toHaveLength(1);
	});
	test("rejects duplicate rule names", () => {
		expect(() => compileRules(env, [{ name: "a", when: "true", use: "x" }, { name: "a", when: "true", use: "y" }])).toThrow(/duplicate/);
	});
});

describe("decide", () => {
	const rules = compileRules(env, [
		{ name: "budget", when: 'cost > 1.0 && model.startsWith("anthropic/claude-opus")', use: "sonnet" },
		{ name: "big", when: "tokens > 100000", use: "haiku" },
	]);
	test("no rule matches below thresholds", () => {
		expect(decide(env, rules, vars(), fresh()).kind).toBe("none");
	});
	test("first match wins in order", () => {
		const d = decide(env, rules, vars({ cost: 1.2, tokens: 150_000n }), fresh());
		expect(d.kind === "switch" && d.rule.name).toBe("budget");
	});
	test("fired rules are skipped (one-way ratchet)", () => {
		const s = fresh();
		s.fired.add("budget");
		const d = decide(env, rules, vars({ cost: 1.2, tokens: 150_000n }), s);
		expect(d.kind === "switch" && d.rule.name).toBe("big");
	});
	test("paused engine never decides", () => {
		expect(decide(env, rules, vars({ cost: 9 }), { ...fresh(), paused: true }).kind).toBe("none");
	});
	test("runtime error is reported, not thrown", () => {
		const r = compileRules(env, [{ name: "div", when: "1 / (turns - turns) > 0", use: "x" }]);
		expect(decide(env, r, vars(), fresh()).kind).toBe("error");
	});
});

describe("effort schedule (decaying-effort port)", () => {
	const rules = compileRules(env, [
		{ name: "e1", when: "turns >= 1", effort: "xhigh" },
		{ name: "e2", when: "turns >= 2", effort: "high" },
		{ name: "budget", when: "cost > 1", use: "sonnet" },
	]);
	test("steps one level per evaluation in rule order", () => {
		const s = fresh();
		const d1 = decide(env, rules, vars({ turns: 2n }), s);
		expect(d1.kind === "switch" && d1.rule.name).toBe("e1");
		s.fired.add("e1");
		const d2 = decide(env, rules, vars({ turns: 2n }), s);
		expect(d2.kind === "switch" && d2.rule.name).toBe("e2");
	});
	test("manual /model pause skips model rules but not effort or prune rules", () => {
		const r = compileRules(env, [
			{ name: "budget", when: "cost > 1", use: "sonnet" },
			{ name: "cut", when: "tokens > 10", prune: true, repeat: true },
			{ name: "e", when: "turns >= 1", effort: "auto" },
		]);
		const s = { ...fresh(), paused: true };
		const d1 = decide(env, r, vars({ cost: 2, tokens: 20n, turns: 1n }), s);
		expect(d1.kind === "switch" && d1.rule.name).toBe("cut");
		const d2 = decide(env, r, vars({ cost: 2, tokens: 5n, turns: 1n }), s);
		expect(d2.kind === "switch" && d2.rule.name).toBe("e");
	});
	test("manual /model pause does not revert an applied rule", () => {
		const r = compileRules(env, [{ name: "away", when: "afk", use: "@smol", revert: true }]);
		const s = { ...fresh(), paused: true, applied: { rule: "away", from: "p/opus" } };
		expect(decide(env, r, vars({ afk: false }), s).kind).toBe("none");
	});
	test("effortPaused skips effort-only rules but not model rules", () => {
		const s = { ...fresh(), effortPaused: true };
		const d = decide(env, rules, vars({ turns: 2n, cost: 2 }), s);
		expect(d.kind === "switch" && d.rule.name).toBe("budget");
	});
	test("restoreState replays effort, effort-paused, reset", () => {
		const e = (data: object) => ({ type: "custom", customType: ENTRY_TYPE, data });
		const s = restoreState([e({ event: "effort", rule: "e1", effort: "xhigh", effortSet: "high" }), e({ event: "effort-paused" })]);
		expect(s.fired.has("e1")).toBe(true);
		expect(s.lastEffort).toBe("high");
		expect(s.effortPaused).toBe(true);
		const r = restoreState([e({ event: "effort", rule: "e1", effortSet: "high" }), e({ event: "reset" })]);
		expect(r.effortPaused).toBe(false);
		expect(r.lastEffort).toBeUndefined();
	});
	test("configuredEffort reads the latest thinking_level_change selector", () => {
		expect(configuredEffort([{ type: "thinking_level_change", configured: "auto" }, { type: "message" }])).toBe("auto");
		expect(configuredEffort([{ type: "thinking_level_change" }])).toBeUndefined();
		expect(configuredEffort([])).toBeUndefined();
	});
});

describe("revert rules", () => {
	const rules = compileRules(env, [
		{ name: "away", when: "afk", use: "@smol", revert: true },
		{ name: "budget", when: "cost > 1", use: "sonnet" },
	]);
	test("afk true → switch; rule not ratcheted", () => {
		const d = decide(env, rules, vars({ afk: true }), fresh());
		expect(d.kind === "switch" && d.rule.revert).toBe(true);
	});
	test("while applied and still true → none, even if another rule matches", () => {
		const s = { ...fresh(), applied: { rule: "away", from: "p/opus" } };
		expect(decide(env, rules, vars({ afk: true, cost: 5 }), s).kind).toBe("none");
	});
	test("condition false → revert to original model", () => {
		const s = { ...fresh(), applied: { rule: "away", from: "p/opus" } };
		expect(decide(env, rules, vars({ afk: false }), s)).toEqual({ kind: "revert", rule: "away", to: "p/opus" });
	});
	test("applied rule removed from config → revert", () => {
		const s = { ...fresh(), applied: { rule: "gone", from: "p/opus" } };
		expect(decide(env, rules, vars({ afk: true }), s).kind).toBe("revert");
	});
	test("restoreState: switched(revert) → applied; reverted → cleared and re-armed", () => {
		const e = (data: object) => ({ type: "custom", customType: ENTRY_TYPE, data });
		const on = restoreState([e({ event: "switched", rule: "away", revert: true, from: "p/opus", to: "p/smol", previousEffort: "high" })]);
		expect(on.applied).toEqual({ rule: "away", from: "p/opus", effort: "high" });
		expect(on.fired.has("away")).toBe(false);
		const off = restoreState([
			e({ event: "switched", rule: "away", revert: true, from: "p/opus", to: "p/smol" }),
			e({ event: "reverted", rule: "away", to: "p/opus" }),
		]);
		expect(off.applied).toBeUndefined();
		expect(off.lastProgrammatic).toBe("p/opus");
	});
});

describe("session readers", () => {
	const msg = (message: object) => ({ type: "message", message });
	const branch = [
		msg({ role: "user" }),
		msg({ role: "assistant", usage: { cost: { total: 0.25 } } }),
		msg({ role: "toolResult", toolName: "task", details: { usage: { cost: { total: 0.5 } } } }),
		msg({ role: "toolResult", toolName: "read", details: { usage: { cost: { total: 99 } } } }),
		msg({ role: "user" }),
		{ type: "thinking_level_change" },
	];
	test("cost counts assistant + task subagent only", () => expect(branchCost(branch)).toBeCloseTo(0.75));
	test("turns counts user messages", () => expect(branchTurns(branch)).toBe(2));

	test("restoreState replays switched, paused, reset", () => {
		const e = (data: object) => ({ type: "custom", customType: ENTRY_TYPE, data });
		const s = restoreState([
			e({ event: "switched", rule: "budget", to: "p/sonnet" }),
			e({ event: "skipped", rule: "big" }),
			e({ event: "paused" }),
		]);
		expect([...s.fired]).toEqual(["budget", "big"]);
		expect(s.paused).toBe(true);
		expect(s.lastProgrammatic).toBe("p/sonnet");
		const r = restoreState([e({ event: "switched", rule: "budget", to: "p/sonnet" }), e({ event: "reset" })]);
		expect(r.fired.size).toBe(0);
		expect(r.lastProgrammatic).toBeUndefined();
	});

	test("restoreState replays pruned cut and legacy model-shift entries", () => {
		const g = (data: object) => ({ type: "custom", customType: ENTRY_TYPE, data });
		const m = (data: object) => ({ type: "custom", customType: "model-shift", data });
		const s = restoreState([
			m({ event: "switched", rule: "legacy-rule", to: "p/sonnet" }),
			g({ event: "pruned", rule: "epoch-rule", cutTs: 12345 }),
		]);
		expect(s.lastProgrammatic).toBe("p/sonnet");
		expect(s.cut).toEqual({ rule: "epoch-rule", cutTs: 12345 });
		expect(s.fired.has("epoch-rule")).toBe(true);
	});
});

describe("loadConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "governor-"));
	test("missing file → inert", () => expect(loadConfig(join(dir, "nope.yml"))).toBeUndefined());
	test("YAML with CEL quoting parses", () => {
		const p = join(dir, "c.yml");
		writeFileSync(p, `rules:\n  - name: budget\n    when: 'cost > 1 && model.startsWith("anthropic/claude-opus")'\n    use: '@smol'\n`);
		const c = loadConfig(p)!;
		expect(c.enabled).toBe(true);
		expect(c.agents).toEqual(["main"]);
		expect(compileRules(env, c.rules)[0].use).toBe("@smol");
	});
	test("rules must be a list", () => {
		const p = join(dir, "bad.yml");
		writeFileSync(p, "rules: nope\n");
		expect(() => loadConfig(p)).toThrow(/list/);
	});
});
