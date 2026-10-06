/**
 * session-governor-omp — one CEL policy engine for the session: switch model, set effort, and
 * prune context. OMP owns the mechanisms (setModel, the `context` hook); this file owns policy.
 *
 * Rules live in `~/.omp/governor.yml` (override: OMP_GOVERNOR_CONFIG). Rules are evaluated in
 * order at `agent_end` (between prompts, the moment a user would type `/model`); the first
 * matching, not-yet-fired rule acts. A rule may switch the model (`use`), latch a new epoch cut
 * for context pruning (`prune: true`), or both — doing both at one boundary costs one cold cache
 * instead of two. Each rule fires at most once per session unless `repeat: true` (prune-only
 * rules). A manual model change after an automatic one pauses the engine for the session.
 * State is persisted as `session-governor` custom entries (legacy `model-shift` entries are
 * still read), so it survives resume. Pruning is wire-only: see ../model-switch-prune-omp/prune.ts.
 * Pruning the previous model's turns on a switch is NOT policy and does not live here: it is the
 * always-on model-switch-prune-omp extension. This file only applies rule-latched epoch cuts.
 *
 * Native compaction triggers on max(billed tokens, stored-history estimate) and runs before the
 * extension `agent_end`. Wire-only pruning lowers only the billed number, so keep the native
 * `compaction.thresholdTokens` above the governor's prune thresholds (a safety net only).
 *
 * Why `agent_end` and not `before_agent_start`: a model change refreshes the model-specific base
 * system prompt (session-tools.ts `syncAfterModelChange`), while `before_agent_start` runs after
 * that turn's base prompt was already prepared. Switching between prompts avoids the race.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Environment } from "@marcbachmann/cel-js";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "./guards.ts";
import { progressReports, progressStats } from "../agent-progress-tool-omp/progress.ts";
import { EPOCH_SHAPE, type ElideShape, emptyStats, type PruneStats, pruneBeforeCut } from "../model-switch-prune-omp/prune.ts";

export const ENTRY_TYPE = "session-governor";
/** Entry type written by model-shift-omp before the merge; read for resume compatibility. */
export const LEGACY_ENTRY_TYPE = "model-shift";
/** Shared-bus channel published by agent-afk-omp. */
export const AFK_CHANNEL = "afk:changed";

type EvalCtx = ExtensionContext;

export interface RuleConfig {
	name?: string;
	when: string;
	use?: string;
	effort?: string;
	/** Restore the previous model when `when` turns false again; the rule then re-arms. */
	revert?: boolean;
	/** Latch a new epoch cut: elide tool results older than the current exchange. */
	prune?: boolean;
	/** Prune-only rules: stay armed after firing. Guard with `turns_since_prune` to avoid cache thrash. */
	repeat?: boolean;
}

export interface ShiftConfig {
	enabled: boolean;
	/** Agent kinds the engine acts in (`ctx.agent.kind`). Default: main only. */
	agents: string[];
	rules: RuleConfig[];
	logPath: string;
	epochShape: ElideShape;
	/** Log per-request prune stats when they change. */
	debug: boolean;
}

export interface CompiledRule {
	name: string;
	when: string;
	use?: string;
	effort?: string;
	revert: boolean;
	prune: boolean;
	repeat: boolean;
}

/** Values exposed to rule expressions. Integers are BigInt per CEL `int`. */
export interface RuleVars {
	cost: number;
	tokens: bigint;
	context_window: bigint;
	context_pct: number;
	turns: bigint;
	elapsed_min: number;
	model: string;
	agent: string;
	afk: boolean;
	turns_since_prune: bigint;
	blocked_streak: bigint;
	attempts_on_goal: bigint;
}

export interface ShiftState {
	fired: Set<string>;
	paused: boolean;
	/** The revert rule currently in effect and the model to restore. While set, no other rule fires. */
	applied?: { rule: string; from: string; effort?: string };
	/** Model this extension last switched to; a different live model means a manual override. */
	lastProgrammatic?: string;
	/** Latched epoch cut; tool results older than `cutTs` are elided on the wire. */
	cut?: { rule: string; cutTs: number };
	/** Effort selector this extension last set; a different live selector means a manual override. */
	lastEffort?: string;
	/** A manual effort change pauses effort-only rules; model and prune rules keep running. */
	effortPaused?: boolean;
}

/** True for a rule whose only action is setting effort (the decaying-effort schedule). */
export const isEffortOnly = (r: { use?: string; prune: boolean; effort?: string }): boolean =>
	r.use === undefined && !r.prune && r.effort !== undefined;

/**
 * The effort the user (or this extension) *selected*, not the level OMP resolved it to.
 * With `auto`, OMP re-resolves the level per prompt, so the resolved level is not stable.
 * OMP records the selector as `configured` on each `thinking_level_change` entry.
 */
export function configuredEffort(entries: readonly unknown[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (!isRecord(e) || e.type !== "thinking_level_change") continue;
		return typeof e.configured === "string" ? e.configured : undefined;
	}
	return undefined;
}

export const VARIABLES: ReadonlyArray<[keyof RuleVars, string, string]> = [
	["cost", "double", "Session spend in USD (assistant + task subagent usage)"],
	["tokens", "int", "Current context tokens"],
	["context_window", "int", "Current model context window"],
	["context_pct", "double", "Context used, 0-100"],
	["turns", "int", "User prompts so far in this branch"],
	["elapsed_min", "double", "Minutes since the first session entry"],
	["model", "string", "Current model as provider/id"],
	["agent", "string", "Agent kind: main | sub"],
	["afk", "bool", "AFK mode engaged (agent-afk-omp `afk:changed`)"],
	["turns_since_prune", "int", "User prompts since the last epoch cut (all prompts if none)"],
	["blocked_streak", "int", "Agent `progress` reports of `blocked` in a row (reset by progress/done)"],
	["attempts_on_goal", "int", "Agent `progress` reports since the last `done`, any status"],
];

const DEFAULT_CONFIG_PATH = join(homedir(), ".omp", "governor.yml");
const DEFAULT_LOG_PATH = join(homedir(), ".omp", "logs", "governor.jsonl");

export function createEnvironment(): Environment {
	let env = new Environment();
	for (const [name, type, description] of VARIABLES) env = env.registerVariable(name, type, { description });
	return env;
}

/** Load config. Returns `undefined` when the file does not exist (engine inert). Throws on malformed content. */
export function loadConfig(path: string): ShiftConfig | undefined {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8");
	const raw: unknown = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
	if (!raw || typeof raw !== "object") throw new Error(`${path}: expected a mapping at top level`);
	const obj = raw as Record<string, unknown>;
	if (!Array.isArray(obj.rules)) throw new Error(`${path}: 'rules' must be a list`);
	const prune = (obj.prune && typeof obj.prune === "object" ? obj.prune : {}) as Record<string, unknown>;
	if (prune.foreign !== undefined) {
		throw new Error(`${path}: prune.foreign moved to model-switch-prune-omp (~/.omp/agent/model-switch-prune.json "mode"); remove it here`);
	}
	const epochShape = { ...EPOCH_SHAPE };
	for (const key of ["minChars", "headChars", "tailChars"] as const) {
		const v = prune[key];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${path}: prune.${key} must be a non-negative integer`);
		epochShape[key] = v;
	}
	if (epochShape.headChars + epochShape.tailChars >= epochShape.minChars) {
		throw new Error(`${path}: prune.headChars + prune.tailChars must be below prune.minChars, or nothing is saved`);
	}
	return {
		enabled: obj.enabled !== false,
		agents: Array.isArray(obj.agents) ? obj.agents.map(String) : ["main"],
		rules: obj.rules as RuleConfig[],
		logPath: typeof obj.logPath === "string" ? obj.logPath : DEFAULT_LOG_PATH,
		epochShape,
		debug: obj.debug === true,
	};
}

/** Type-check every rule up front. Any invalid rule rejects the whole set: dropping one would silently change first-match order. */
export function compileRules(env: Environment, rules: RuleConfig[]): CompiledRule[] {
	const names = new Set<string>();
	return rules.map((rule, i) => {
		const label = rule?.name ?? `rule[${i}]`;
		if (!rule || typeof rule.when !== "string") throw new Error(`${label}: 'when' must be a string`);
		if (rule.use !== undefined && typeof rule.use !== "string") throw new Error(`${label}: 'use' must be a string`);
		const prune = rule.prune === true;
		if (rule.effort !== undefined && typeof rule.effort !== "string") throw new Error(`${label}: 'effort' must be a string`);
		if (rule.use === undefined && !prune && rule.effort === undefined) throw new Error(`${label}: needs 'use', 'effort', or 'prune: true'`);
		if (rule.use === undefined && rule.revert) throw new Error(`${label}: 'revert' needs 'use'`);
		if (rule.repeat && (rule.use !== undefined || rule.effort !== undefined)) throw new Error(`${label}: 'repeat' applies to prune-only rules`);
		if (rule.revert && prune) throw new Error(`${label}: 'revert' and 'prune' cannot be combined`);
		if (names.has(label)) throw new Error(`${label}: duplicate rule name`);
		names.add(label);
		const checked = env.check(rule.when) as { valid: boolean; type?: string; error?: Error };
		if (!checked.valid) throw new Error(`${label}: ${checked.error?.message.split("\n")[0] ?? "invalid expression"}`);
		if (checked.type !== "bool") throw new Error(`${label}: 'when' must be bool, got ${checked.type}`);
		return { name: label, when: rule.when, use: rule.use, effort: rule.effort, revert: rule.revert === true, prune, repeat: rule.repeat === true };
	});
}

export type Decision =
	| { kind: "none" }
	| { kind: "switch"; rule: CompiledRule }
	| { kind: "revert"; rule: string; to: string }
	| { kind: "error"; rule: CompiledRule; message: string };

function evaluateRule(env: Environment, rule: CompiledRule, vars: RuleVars): { ok: true; value: boolean } | { ok: false; message: string } {
	try {
		return { ok: true, value: env.evaluate(rule.when, vars as unknown as Record<string, unknown>) === true };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message.split("\n")[0] : String(err) };
	}
}

/**
 * While a revert rule is applied, only that rule is considered: when its expression turns false
 * (or errors, or the rule was removed from config) the previous model is restored. Otherwise the
 * first not-yet-fired rule whose expression is true switches. Runtime errors are reported, never thrown.
 */
export function decide(env: Environment, rules: CompiledRule[], vars: RuleVars, state: ShiftState): Decision {
	// A manual model change pauses model rules only; effort and prune rules keep running.
	if (state.applied && !state.paused) {
		const rule = rules.find(r => r.name === state.applied?.rule);
		const result = rule ? evaluateRule(env, rule, vars) : { ok: true as const, value: false };
		if (result.ok && result.value) return { kind: "none" };
		return { kind: "revert", rule: state.applied.rule, to: state.applied.from };
	}
	for (const rule of rules) {
		if (state.fired.has(rule.name)) continue;
		if (state.effortPaused && isEffortOnly(rule)) continue;
		if (state.paused && rule.use !== undefined) continue;
		const result = evaluateRule(env, rule, vars);
		if (!result.ok) return { kind: "error", rule, message: result.message };
		if (result.value) return { kind: "switch", rule };
	}
	return { kind: "none" };
}

// ---- metric readers over untyped session entries ----

function usageCost(usage: unknown): number {
	if (!isRecord(usage) || !isRecord(usage.cost)) return 0;
	const total = usage.cost.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/** Same accounting as agent-cost-guard-omp: assistant usage plus `task` subagent usage. */
export function branchCost(branch: readonly unknown[]): number {
	let spent = 0;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const m = entry.message;
		if (m.role === "assistant") spent += usageCost(m.usage);
		if (m.role === "toolResult" && m.toolName === "task" && isRecord(m.details)) spent += usageCost(m.details.usage);
	}
	return spent;
}

/** Timestamps of user prompts in branch order. */
export function userTimestamps(branch: readonly unknown[]): number[] {
	const out: number[] = [];
	for (const e of branch) {
		if (!isRecord(e) || e.type !== "message" || !isRecord(e.message) || e.message.role !== "user") continue;
		out.push(typeof e.message.timestamp === "number" ? e.message.timestamp : Number.NaN);
	}
	return out;
}

export function branchTurns(branch: readonly unknown[]): number {
	return userTimestamps(branch).length;
}

export function firstTimestamp(entries: readonly unknown[]): number | undefined {
	for (const e of entries) {
		if (!isRecord(e)) continue;
		const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : typeof e.timestamp === "number" ? e.timestamp : NaN;
		if (Number.isFinite(t)) return t;
	}
	return undefined;
}

/** Rebuild fired/paused/cut state from persisted governor (and legacy model-shift) entries (resume support). */
export function restoreState(entries: readonly unknown[]): ShiftState {
	const state: ShiftState = { fired: new Set(), paused: false };
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom" || (e.customType !== ENTRY_TYPE && e.customType !== LEGACY_ENTRY_TYPE) || !isRecord(e.data)) continue;
		const d = e.data;
		const rule = typeof d.rule === "string" ? d.rule : undefined;
		if (d.event === "skipped" && rule) state.fired.add(rule);
		if (d.event === "switched" && rule) {
			if (d.revert === true && typeof d.from === "string") {
				state.applied = { rule, from: d.from, effort: typeof d.previousEffort === "string" ? d.previousEffort : undefined };
			} else state.fired.add(rule);
			if (typeof d.to === "string") state.lastProgrammatic = d.to;
			if (typeof d.effortSet === "string") state.lastEffort = d.effortSet;
		}
		if (d.event === "effort" && rule) {
			state.fired.add(rule);
			if (typeof d.effortSet === "string") state.lastEffort = d.effortSet;
		}
		if (d.event === "effort-paused") state.effortPaused = true;
		if (d.event === "pruned" && rule && typeof d.cutTs === "number") {
			state.cut = { rule, cutTs: d.cutTs };
			if (d.repeat !== true) state.fired.add(rule);
		}
		if (d.event === "reverted") {
			state.applied = undefined;
			if (typeof d.to === "string") state.lastProgrammatic = d.to;
		}
		if (d.event === "paused") state.paused = true;
		// `reset` re-arms rules; the latched cut stays, because un-pruning would also cost a cold cache.
		if (d.event === "reset") {
			state.fired.clear();
			state.paused = false;
			state.applied = undefined;
			state.lastProgrammatic = undefined;
			state.lastEffort = undefined;
			state.effortPaused = false;
		}
	}
	return state;
}

const modelKey = (m: { provider: string; id: string } | undefined): string => (m ? `${m.provider}/${m.id}` : "");

// ---- OMP glue ----

interface SessionCtx {
	sessionManager?: { getEntries?: () => readonly unknown[]; getBranch?: () => readonly unknown[] };
}

export default function sessionGovernorExtension(pi: ExtensionAPI) {
	const configPath = process.env.OMP_GOVERNOR_CONFIG ?? DEFAULT_CONFIG_PATH;
	const env = createEnvironment();
	let config: ShiftConfig | undefined;
	let rules: CompiledRule[] = [];
	let loadError: string | undefined;
	let state: ShiftState = { fired: new Set(), paused: false };
	let startedAt = Date.now();
	/** AFK flag from agent-afk-omp's `afk:changed`; in-memory only, so a resumed session starts not-AFK. */
	let afk = false;
	/** Latest handler context; the shared-bus listener has none of its own. */
	let lastCtx: EvalCtx | undefined;
	/** Serialises evaluations so an AFK event and an agent_end never switch concurrently. */
	let chain: Promise<void> = Promise.resolve();
	/** Stats of the most recent pruned request, for `/governor` and change-only debug logging. */
	let lastPrune: (PruneStats & { model: string }) | undefined;
	let lastPruneKey = "";

	function log(event: string, details: Record<string, unknown> = {}): void {
		const path = process.env.OMP_GOVERNOR_LOG ?? config?.logPath ?? DEFAULT_LOG_PATH;
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...details })}\n`);
		} catch {
			/* logging must never break a session */
		}
	}

	function reload(): void {
		config = undefined;
		rules = [];
		loadError = undefined;
		try {
			config = loadConfig(configPath);
			if (config) rules = compileRules(env, config.rules);
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
			rules = [];
		}
	}

	function record(data: Record<string, unknown>): void {
		pi.appendEntry(ENTRY_TYPE, data);
		log(String(data.event), data);
	}

	function collectVars(ctx: EvalCtx): RuleVars {
		const sm = (ctx as unknown as SessionCtx).sessionManager;
		const branch = sm?.getBranch?.() ?? [];
		const usage = ctx.getContextUsage();
		const model = ctx.model;
		const prompts = userTimestamps(branch);
		const cutTs = state.cut?.cutTs;
		const progress = progressStats(progressReports(branch));
		return {
			blocked_streak: BigInt(progress.blocked_streak),
			attempts_on_goal: BigInt(progress.attempts_on_goal),
			turns_since_prune: BigInt(cutTs === undefined ? prompts.length : prompts.filter(t => t > cutTs).length),
			cost: branchCost(branch),
			tokens: BigInt(Math.round(usage?.tokens ?? 0)),
			context_window: BigInt(Math.round(usage?.contextWindow ?? model?.contextWindow ?? 0)),
			context_pct: usage?.percent ?? 0,
			turns: BigInt(branchTurns(branch)),
			elapsed_min: (Date.now() - startedAt) / 60_000,
			model: modelKey(model),
			agent: ctx.agent?.kind ?? "main",
			afk,
		};
	}

	const onSession = (reason: string, ctx: SessionCtx) => {
		reload();
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		state = restoreState(entries);
		startedAt = firstTimestamp(entries) ?? Date.now();
		log("session", { reason, configPath, configured: !!config, rules: rules.length, loadError, fired: [...state.fired], paused: state.paused });
	};

	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
		onSession("start", ctx as unknown as SessionCtx);
		if (loadError) ctx.ui.notify(`[governor] Config rejected, engine disabled: ${loadError}`, "error");
	});
	pi.on("session_switch", (_e, ctx) => {
		lastCtx = ctx;
		afk = false;
		onSession("switch", ctx as unknown as SessionCtx);
	});

	/** Queue an evaluation; returns when this one has finished. */
	function schedule(ctx: EvalCtx, trigger: string): Promise<void> {
		chain = chain.then(() => evaluate(ctx, trigger)).catch(err => log("error", { trigger, message: String(err) }));
		return chain;
	}

	pi.on("agent_end", async (_e, ctx) => {
		lastCtx = ctx;
		await schedule(ctx, "agent_end");
	});

	pi.events.on(AFK_CHANNEL, data => {
		if (!isRecord(data) || typeof data.active !== "boolean") return;
		afk = data.active;
		log("afk", { active: afk });
		// Switch before agent-afk-omp sends its AFK/back prompt, but never mid-turn.
		if (lastCtx?.isIdle() && typeof data.waitUntil === "function") data.waitUntil(schedule(lastCtx, afk ? "afk-on" : "afk-off"));
	});

	async function evaluate(ctx: EvalCtx, trigger: string): Promise<void> {
		if (!config?.enabled || rules.length === 0) return;
		if (!config.agents.includes(ctx.agent?.kind ?? "main")) return;

		const current = modelKey(ctx.model);
		if (!state.paused && state.lastProgrammatic && current !== state.lastProgrammatic) {
			state.paused = true;
			record({ event: "paused", expected: state.lastProgrammatic, current });
			ctx.ui.notify(`[governor] Manual model change to ${current} detected; model rules paused for this session (effort and prune rules stay armed).`, "info");
			return;
		}
		const effortNow = (): string => configuredEffort((ctx as unknown as SessionCtx).sessionManager?.getEntries?.() ?? []) ?? String(pi.getThinkingLevel() ?? "inherit");
		if (state.lastEffort && !state.effortPaused && effortNow() !== state.lastEffort) {
			state.effortPaused = true;
			record({ event: "effort-paused", expected: state.lastEffort, current: effortNow() });
			ctx.ui.notify(`[governor] Manual effort change to ${effortNow()} detected; effort-only rules paused for this session.`, "info");
		}

		const vars = collectVars(ctx);
		const decision = decide(env, rules, vars, state);
		if (decision.kind === "none") return;
		const snapshot = { trigger, cost: Number(vars.cost.toFixed(4)), tokens: Number(vars.tokens), turns: Number(vars.turns), afk };
		const sessionBranch = (ctx as unknown as SessionCtx).sessionManager?.getBranch?.() ?? [];

		if (decision.kind === "revert") {
			const back = ctx.models.resolve(decision.to);
			const applied = state.applied;
			state.applied = undefined;
			if (!back || !(await pi.setModel(back))) {
				// Cannot restore: stay put and stop automating, rather than guess another model.
				state.paused = true;
				record({ event: "paused", reason: "revert-failed", rule: decision.rule, target: decision.to, ...snapshot });
				ctx.ui.notify(`[governor] Could not restore ${decision.to}; automatic switching paused.`, "warning");
				return;
			}
			if (applied?.effort) {
				pi.setThinkingLevel(applied.effort as Parameters<typeof pi.setThinkingLevel>[0]);
				state.lastEffort = effortNow();
			}
			state.lastProgrammatic = modelKey(ctx.models.current() ?? back);
			record({ event: "reverted", rule: decision.rule, from: current, to: state.lastProgrammatic, effort: applied?.effort, effortSet: applied?.effort ? state.lastEffort : undefined, ...snapshot });
			ctx.ui.notify(`[governor] Rule '${decision.rule}' no longer holds: ${current} → ${state.lastProgrammatic}. Next prompt starts with a cold cache.`, "info");
			return;
		}
		const { rule } = decision;

		if (decision.kind === "error") {
			state.fired.add(rule.name);
			record({ event: "skipped", rule: rule.name, reason: "eval-error", message: decision.message, ...snapshot });
			ctx.ui.notify(`[governor] Rule '${rule.name}' failed to evaluate (${decision.message}); rule disabled.`, "warning");
			return;
		}

		const skip = (reason: string, message: string) => {
			state.fired.add(rule.name);
			record({ event: "skipped", rule: rule.name, reason, target: rule.use, ...snapshot });
			ctx.ui.notify(`[governor] Rule '${rule.name}' matched but ${message}; rule disabled.`, "warning");
		};

		// Prune-only rule: latch the cut and stop. A rule with `use` prunes after a successful switch.
		const latchCut = (): void => {
			// The cut is the start of the exchange that just ended: everything before it is older.
			const cutTs = userTimestamps(sessionBranch).filter(Number.isFinite).at(-1);
			if (cutTs === undefined || (state.cut && cutTs <= state.cut.cutTs)) {
				if (!rule.repeat) state.fired.add(rule.name);
				record({ event: "skipped", rule: rule.name, reason: "cut-not-advanced", ...snapshot });
				return;
			}
			state.cut = { rule: rule.name, cutTs };
			if (!rule.repeat) state.fired.add(rule.name);
			record({ event: "pruned", rule: rule.name, cutTs, repeat: rule.repeat, ...snapshot });
			ctx.ui.notify(
				`[governor] Rule '${rule.name}' (${rule.when}) matched at ${vars.tokens} tokens: tool results before this exchange are now elided on the wire. Next prompt starts with a cold cache.`,
				"info",
			);
		};
		if (rule.use === undefined) {
			if (rule.effort && !state.effortPaused) {
				pi.setThinkingLevel(rule.effort as Parameters<typeof pi.setThinkingLevel>[0]);
				state.lastEffort = effortNow();
				if (!rule.prune) state.fired.add(rule.name);
				record({ event: "effort", rule: rule.name, effort: rule.effort, effortSet: state.lastEffort, ...snapshot });
				const clamped = state.lastEffort !== rule.effort ? ` (clamped to ${state.lastEffort})` : "";
				ctx.ui.notify(`[governor] Rule '${rule.name}' (${rule.when}): effort → ${rule.effort}${clamped}.`, "info");
			} else if (!rule.prune) state.fired.add(rule.name);
			if (rule.prune) latchCut();
			return;
		}

		const target = ctx.models.resolve(rule.use);
		if (!target) return skip("unresolved", `'${rule.use}' does not resolve to an available model`);
		const to = modelKey(target);
		if (to === current) {
			// Already there: the rule's intent is satisfied; mark it so it does not re-evaluate.
			state.fired.add(rule.name);
			record({ event: "skipped", rule: rule.name, reason: "already-current", target: to, ...snapshot });
			return;
		}
		if (target.contextWindow > 0 && Number(vars.tokens) >= target.contextWindow) {
			return skip("context-too-small", `${to} window (${target.contextWindow}) is below current context (${vars.tokens})`);
		}

		const previousEffort = pi.getThinkingLevel();
		const ok = await pi.setModel(target);
		if (!ok) return skip("no-credentials", `no API key for ${to}`);
		if (rule.effort) {
			pi.setThinkingLevel(rule.effort as Parameters<typeof pi.setThinkingLevel>[0]);
			state.lastEffort = effortNow();
		}
		if (rule.revert) state.applied = { rule: rule.name, from: current, effort: rule.effort ? previousEffort : undefined };
		else state.fired.add(rule.name);
		state.lastProgrammatic = modelKey(ctx.models.current() ?? target);
		record({ event: "switched", rule: rule.name, from: current, to: state.lastProgrammatic, effort: rule.effort, effortSet: rule.effort ? state.lastEffort : undefined, revert: rule.revert, previousEffort: state.applied?.effort, ...snapshot });
		ctx.ui.notify(
			`[governor] Rule '${rule.name}' (${rule.when}) matched at $${vars.cost.toFixed(2)}, ${vars.tokens} tokens: ${current} → ${state.lastProgrammatic}${rule.effort ? ` @ ${rule.effort}` : ""}. Next prompt starts with a cold cache.`,
			"info",
		);
		// Same boundary as the switch, so the prune costs no extra cold cache.
		if (rule.prune) latchCut();
	}

	// Wire-only epoch pruning: only after a rule latched a cut. Runs in every agent kind.
	pi.on("context", (event, ctx) => {
		if (!state.cut || (config && !config.enabled)) return;
		const stats = emptyStats();
		const messages = pruneBeforeCut(event.messages, state.cut.cutTs, config?.epochShape, stats);
		if (messages === event.messages) return;
		lastPrune = { ...stats, model: modelKey(ctx.model) };
		const key = JSON.stringify(lastPrune);
		if (config?.debug && key !== lastPruneKey) log("context", lastPrune);
		lastPruneKey = key;
		return { messages };
	});

	pi.registerCommand("governor", {
		description: "Show governor rules, live variables, and pruning; `reset` re-arms all rules, `reload` re-reads config",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "reload") {
				reload();
				ctx.ui.notify(loadError ? `[governor] Config rejected: ${loadError}` : `[governor] Reloaded ${rules.length} rule(s) from ${configPath}`, loadError ? "error" : "info");
				return;
			}
			if (sub === "reset") {
				state = { fired: new Set(), paused: false, cut: state.cut, effortPaused: false };
				record({ event: "reset" });
				ctx.ui.notify("[governor] All rules re-armed; pause cleared (the epoch cut stays).", "info");
				return;
			}
			const vars = collectVars(ctx as never);
			const lines = [
				`governor: ${loadError ? `DISABLED (${loadError})` : !config ? `inert (no ${configPath})` : !config.enabled ? "disabled in config" : state.paused ? `armed; model rules paused (manual /model)${state.effortPaused ? ", effort rules paused (manual effort)" : ""}` : state.effortPaused ? "armed; effort rules paused (manual effort)" : "armed"}`,
				`vars: cost=$${vars.cost.toFixed(4)} tokens=${vars.tokens}/${vars.context_window} (${vars.context_pct.toFixed(1)}%) turns=${vars.turns} elapsed_min=${vars.elapsed_min.toFixed(1)} model=${vars.model} agent=${vars.agent} turns_since_prune=${vars.turns_since_prune} blocked_streak=${vars.blocked_streak} attempts_on_goal=${vars.attempts_on_goal}`,
				`prune: cut=${state.cut ? `${new Date(state.cut.cutTs).toISOString()} (rule ${state.cut.rule})` : "none"}`,
				lastPrune
					? `last pruned request (${lastPrune.model}): ${lastPrune.charsBefore - lastPrune.charsAfter} chars saved (~${Math.round((lastPrune.charsBefore - lastPrune.charsAfter) / 4)} tokens est.), epoch elided=${lastPrune.epochElided} (model-switch pruning: model-switch-prune-omp)`
					: "last pruned request: none this process",
				...rules.map(r => {
					let now = "?";
					try {
						now = String(env.evaluate(r.when, vars as unknown as Record<string, unknown>));
					} catch (err) {
						now = `error: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
					}
					return `  ${state.fired.has(r.name) ? "✓ fired" : "· armed"}  ${r.name}: when ${r.when} → ${r.use ?? (r.prune ? "prune" : "effort")}${r.effort ? ` @ ${r.effort}` : ""}  [now: ${now}]`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
