import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchCost,
	branchTurns,
	compileRules,
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
	cost: 0.5,
	tokens: 20_000n,
	context_window: 200_000n,
	context_pct: 10,
	turns: 3n,
	elapsed_min: 5,
	model: "amd-claude/claude-opus-5.5",
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
		expect(() => compileRules(env, [{ when: "true" } as never])).toThrow(/needs 'use' .* or 'prune: true'/);
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
		{ name: "budget", when: 'cost > 1.0 && model.startsWith("amd-claude/claude-opus")', use: "sonnet" },
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
		writeFileSync(p, `rules:\n  - name: budget\n    when: 'cost > 1 && model.startsWith("amd-claude/claude-opus")'\n    use: '@smol'\n`);
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
