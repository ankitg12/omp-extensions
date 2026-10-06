/**
 * model-shift-omp — switch the session model when a CEL rule matches.
 *
 * Rules live in `~/.omp/model-shift.yml` (override: OMP_MODEL_SHIFT_CONFIG). No file → inert.
 * Rules are evaluated in order at `agent_end` (between prompts, the moment a user would type
 * `/model`); the first matching, not-yet-fired rule switches the model. Each rule fires at most
 * once per session (one-way ratchet). A manual model change after an automatic one pauses the
 * engine for the rest of the session. Fired/paused state is persisted as `model-shift` custom
 * session entries, so it survives resume.
 *
 * Why `agent_end` and not `before_agent_start`: a model change refreshes the model-specific base
 * system prompt (session-tools.ts `syncAfterModelChange`), while `before_agent_start` runs after
 * that turn's base prompt was already prepared. Switching between prompts avoids the race.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Environment } from "@marcbachmann/cel-js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const ENTRY_TYPE = "model-shift";

export interface RuleConfig {
	name?: string;
	when: string;
	use: string;
	effort?: string;
}

export interface ShiftConfig {
	enabled: boolean;
	/** Agent kinds the engine acts in (`ctx.agent.kind`). Default: main only. */
	agents: string[];
	rules: RuleConfig[];
	logPath: string;
}

export interface CompiledRule {
	name: string;
	when: string;
	use: string;
	effort?: string;
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
}

export interface ShiftState {
	fired: Set<string>;
	paused: boolean;
	/** Model this extension last switched to; a different live model means a manual override. */
	lastProgrammatic?: string;
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
];

const DEFAULT_CONFIG_PATH = join(homedir(), ".omp", "model-shift.yml");
const DEFAULT_LOG_PATH = join(homedir(), ".omp", "logs", "model-shift.jsonl");

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
	return {
		enabled: obj.enabled !== false,
		agents: Array.isArray(obj.agents) ? obj.agents.map(String) : ["main"],
		rules: obj.rules as RuleConfig[],
		logPath: typeof obj.logPath === "string" ? obj.logPath : DEFAULT_LOG_PATH,
	};
}

/** Type-check every rule up front. Any invalid rule rejects the whole set: dropping one would silently change first-match order. */
export function compileRules(env: Environment, rules: RuleConfig[]): CompiledRule[] {
	const names = new Set<string>();
	return rules.map((rule, i) => {
		const label = rule?.name ?? `rule[${i}]`;
		if (!rule || typeof rule.when !== "string" || typeof rule.use !== "string") {
			throw new Error(`${label}: 'when' and 'use' must be strings`);
		}
		if (names.has(label)) throw new Error(`${label}: duplicate rule name`);
		names.add(label);
		const checked = env.check(rule.when) as { valid: boolean; type?: string; error?: Error };
		if (!checked.valid) throw new Error(`${label}: ${checked.error?.message.split("\n")[0] ?? "invalid expression"}`);
		if (checked.type !== "bool") throw new Error(`${label}: 'when' must be bool, got ${checked.type}`);
		return { name: label, when: rule.when, use: rule.use, effort: rule.effort };
	});
}

export type Decision =
	| { kind: "none" }
	| { kind: "switch"; rule: CompiledRule }
	| { kind: "error"; rule: CompiledRule; message: string };

/** First not-yet-fired rule whose expression is true. Runtime evaluation errors are reported, never thrown. */
export function decide(env: Environment, rules: CompiledRule[], vars: RuleVars, state: ShiftState): Decision {
	if (state.paused) return { kind: "none" };
	for (const rule of rules) {
		if (state.fired.has(rule.name)) continue;
		let result: unknown;
		try {
			result = env.evaluate(rule.when, vars as unknown as Record<string, unknown>);
		} catch (err) {
			return { kind: "error", rule, message: err instanceof Error ? err.message.split("\n")[0] : String(err) };
		}
		if (result === true) return { kind: "switch", rule };
	}
	return { kind: "none" };
}

// ---- metric readers over untyped session entries ----

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

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

export function branchTurns(branch: readonly unknown[]): number {
	return branch.filter(e => isRecord(e) && e.type === "message" && isRecord(e.message) && e.message.role === "user").length;
}

export function firstTimestamp(entries: readonly unknown[]): number | undefined {
	for (const e of entries) {
		if (!isRecord(e)) continue;
		const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : typeof e.timestamp === "number" ? e.timestamp : NaN;
		if (Number.isFinite(t)) return t;
	}
	return undefined;
}

/** Rebuild fired/paused state from persisted `model-shift` custom entries (resume support). */
export function restoreState(entries: readonly unknown[]): ShiftState {
	const state: ShiftState = { fired: new Set(), paused: false };
	for (const e of entries) {
		if (!isRecord(e) || e.type !== "custom" || e.customType !== ENTRY_TYPE || !isRecord(e.data)) continue;
		const d = e.data;
		if ((d.event === "switched" || d.event === "skipped") && typeof d.rule === "string") state.fired.add(d.rule);
		if (d.event === "switched" && typeof d.to === "string") state.lastProgrammatic = d.to;
		if (d.event === "paused") state.paused = true;
		if (d.event === "reset") {
			state.fired.clear();
			state.paused = false;
			state.lastProgrammatic = undefined;
		}
	}
	return state;
}

const modelKey = (m: { provider: string; id: string } | undefined): string => (m ? `${m.provider}/${m.id}` : "");

// ---- OMP glue ----

interface SessionCtx {
	sessionManager?: { getEntries?: () => readonly unknown[]; getBranch?: () => readonly unknown[] };
}

export default function modelShiftExtension(pi: ExtensionAPI) {
	const configPath = process.env.OMP_MODEL_SHIFT_CONFIG ?? DEFAULT_CONFIG_PATH;
	const env = createEnvironment();
	let config: ShiftConfig | undefined;
	let rules: CompiledRule[] = [];
	let loadError: string | undefined;
	let state: ShiftState = { fired: new Set(), paused: false };
	let startedAt = Date.now();

	function log(event: string, details: Record<string, unknown> = {}): void {
		const path = config?.logPath ?? DEFAULT_LOG_PATH;
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

	function collectVars(ctx: Parameters<Parameters<typeof pi.on<"agent_end">>[1]>[1]): RuleVars {
		const sm = (ctx as unknown as SessionCtx).sessionManager;
		const branch = sm?.getBranch?.() ?? [];
		const usage = ctx.getContextUsage();
		const model = ctx.model;
		return {
			cost: branchCost(branch),
			tokens: BigInt(Math.round(usage?.tokens ?? 0)),
			context_window: BigInt(Math.round(usage?.contextWindow ?? model?.contextWindow ?? 0)),
			context_pct: usage?.percent ?? 0,
			turns: BigInt(branchTurns(branch)),
			elapsed_min: (Date.now() - startedAt) / 60_000,
			model: modelKey(model),
			agent: ctx.agent?.kind ?? "main",
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
		onSession("start", ctx as unknown as SessionCtx);
		if (loadError) ctx.ui.notify(`[model-shift] Config rejected, engine disabled: ${loadError}`, "error");
	});
	pi.on("session_switch", (_e, ctx) => onSession("switch", ctx as unknown as SessionCtx));

	pi.on("agent_end", async (_e, ctx) => {
		if (!config?.enabled || rules.length === 0 || state.paused) return;
		if (!config.agents.includes(ctx.agent?.kind ?? "main")) return;

		const current = modelKey(ctx.model);
		if (state.lastProgrammatic && current !== state.lastProgrammatic) {
			state.paused = true;
			record({ event: "paused", expected: state.lastProgrammatic, current });
			ctx.ui.notify(`[model-shift] Manual model change to ${current} detected; automatic switching paused for this session.`, "info");
			return;
		}

		const vars = collectVars(ctx);
		const decision = decide(env, rules, vars, state);
		if (decision.kind === "none") return;
		const { rule } = decision;
		const snapshot = { cost: Number(vars.cost.toFixed(4)), tokens: Number(vars.tokens), turns: Number(vars.turns) };

		if (decision.kind === "error") {
			state.fired.add(rule.name);
			record({ event: "skipped", rule: rule.name, reason: "eval-error", message: decision.message, ...snapshot });
			ctx.ui.notify(`[model-shift] Rule '${rule.name}' failed to evaluate (${decision.message}); rule disabled.`, "warning");
			return;
		}

		const skip = (reason: string, message: string) => {
			state.fired.add(rule.name);
			record({ event: "skipped", rule: rule.name, reason, target: rule.use, ...snapshot });
			ctx.ui.notify(`[model-shift] Rule '${rule.name}' matched but ${message}; rule disabled.`, "warning");
		};

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

		const ok = await pi.setModel(target);
		if (!ok) return skip("no-credentials", `no API key for ${to}`);
		if (rule.effort) pi.setThinkingLevel(rule.effort as Parameters<typeof pi.setThinkingLevel>[0]);
		state.fired.add(rule.name);
		state.lastProgrammatic = modelKey(ctx.models.current() ?? target);
		record({ event: "switched", rule: rule.name, from: current, to: state.lastProgrammatic, effort: rule.effort, ...snapshot });
		ctx.ui.notify(
			`[model-shift] Rule '${rule.name}' (${rule.when}) matched at $${vars.cost.toFixed(2)}, ${vars.tokens} tokens: ${current} → ${state.lastProgrammatic}${rule.effort ? ` @ ${rule.effort}` : ""}. Next prompt starts with a cold cache.`,
			"info",
		);
	});

	pi.registerCommand("model-shift", {
		description: "Show model-shift rules and live variables; `reset` re-arms all rules, `reload` re-reads config",
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "reload") {
				reload();
				ctx.ui.notify(loadError ? `[model-shift] Config rejected: ${loadError}` : `[model-shift] Reloaded ${rules.length} rule(s) from ${configPath}`, loadError ? "error" : "info");
				return;
			}
			if (sub === "reset") {
				state = { fired: new Set(), paused: false };
				record({ event: "reset" });
				ctx.ui.notify("[model-shift] All rules re-armed; pause cleared.", "info");
				return;
			}
			const vars = collectVars(ctx as never);
			const lines = [
				`model-shift: ${loadError ? `DISABLED (${loadError})` : !config ? `inert (no ${configPath})` : !config.enabled ? "disabled in config" : state.paused ? "paused (manual override)" : "armed"}`,
				`vars: cost=$${vars.cost.toFixed(4)} tokens=${vars.tokens}/${vars.context_window} (${vars.context_pct.toFixed(1)}%) turns=${vars.turns} elapsed_min=${vars.elapsed_min.toFixed(1)} model=${vars.model} agent=${vars.agent}`,
				...rules.map(r => {
					let now = "?";
					try {
						now = String(env.evaluate(r.when, vars as unknown as Record<string, unknown>));
					} catch (err) {
						now = `error: ${err instanceof Error ? err.message.split("\n")[0] : err}`;
					}
					return `  ${state.fired.has(r.name) ? "✓ fired" : "· armed"}  ${r.name}: when ${r.when} → ${r.use}${r.effort ? ` @ ${r.effort}` : ""}  [now: ${now}]`;
				}),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
