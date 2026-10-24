// agent-dream — idle-time memory consolidation for Oh My Pi (OMP)
//
// Runs the bundled dream skill pass when the session has been idle long
// enough AND the diary cooldown has elapsed. Manual trigger via /dream.
//
// /dream       — run the consolidation pass now (bypasses idle gate, not cooldown)
// /dream now   — same as /dream
// /dream status — idle time, cooldown state, last pass
// /dream diary — path of the DREAMS.md diary
//
// Idle detection: last user-visible activity (turn_end / agent_end / terminal
// input) arms a one-shot check via ctx.setTimeout. The check fires only when
// ctx.isIdle() is true; otherwise it re-arms. Never fires mid-turn.
//
// Cooldown: newest DREAMS.md entry timestamp must be older than
// minIntervalHours. Single session, so no lease/watermark machinery.
//
// Delivery: the pass is injected as a normal followUp turn carrying the
// SKILL.md procedure text. The skill body caps its own history scan and diary
// size. Prompt-cache prefix of the live session is not preserved for the pass
// itself — acceptable: the benefit lands in MEMORY.md / DREAMS.md for future
// sessions.
//
// AFK link: subscribes to the agent-afk shared-bus channel ("afk:changed").
// AFK engage counts as idle-start; AFK disengage re-arms the timer. Works with
// or without agent-afk loaded.
//
// Config: ~/.omp/agent/agent-dream.json (see dream-state.ts for schema).
// Diary: ~/Notes/dreams/DREAMS.md (newest-first, capped).

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	applyDreamReport,
	expandHome,
	humanSince,
	loadConfig,
	loadDreamState,
	readDreamReport,
	STATE_PATH,
	type DreamConfig,
	type DreamState,
} from "./dream-state.ts";
export const AFK_CHANNEL = "afk:changed";
const STATUS_KEY = "dream";
// Idle-timer handle from ctx.setTimeout; cleared via ctx.clearTimer.
const DEFAULT_LOG_FILE = join(homedir(), ".omp", "agent", "agent-dream.log");
let logFile = DEFAULT_LOG_FILE;
export function logFilePath(): string {
	return logFile;
}
export function log(msg: string): void {
	try {
		appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// best-effort logging only
	}
}

/** Idle gate + cooldown check, then inject the skill pass. Returns a short status string. */
export default function agentDream(pi: ExtensionAPI) {
	pi.setLabel("Agent Dream");

	let config: DreamConfig = loadConfig(log);
	let state: DreamState = loadDreamState(log);
	let lastActivityAt = Date.now();
	let idleTimer: Parameters<ExtensionContext["clearTimer"]>[0] | undefined;
	let unsubscribeInput: (() => void) | undefined;

	function saveState(): void {
		try {
			writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
		} catch (e) {
			log(`state write failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

// Managed timers (ctx.setTimeout/clearTimer, SDK >=17.0.2): unref'd, throws
// contained via the extension error channel, auto-cleared on shutdown.
// The clear() in armTimer + session_shutdown is belt-and-braces.
	function armTimer(ctx: ExtensionContext): void {
		clear(ctx);
		try {
			idleTimer = ctx.setTimeout(() => {
				try {
					onIdleTimeout(ctx);
				} catch (e) {
					log(`idle check failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			}, config.idleMs);
			if (config.debug) log(`armed idle check in ${Math.round(config.idleMs / 1000)}s`);
		} catch (e) {
			log(`armTimer failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	function clear(ctx?: ExtensionContext): void {
		if (idleTimer !== undefined) {
			try {
				if (ctx !== undefined) ctx.clearTimer(idleTimer);
			} catch {
				// already fired or session tearing down — ignore
			}
			idleTimer = undefined;
		}
	}

	function touch(): void {
		lastActivityAt = Date.now();
	}

	function onIdleTimeout(ctx: ExtensionContext): void {
		idleTimer = undefined;
		if (!ctx.isIdle()) {
			if (config.debug) log("idle check: not idle, re-arming");
			armTimer(ctx);
			return;
		}
		void runPass(ctx, "idle");
	}

	async function runPass(ctx: ExtensionContext, reason: "idle" | "manual" | "afk"): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("[dream] session busy — pass deferred, timer re-armed", "info");
			armTimer(ctx);
			return;
		}
		const diaryPath = expandHome(config.diaryPath);
		let cooldownOk = true;
		if (existsSync(diaryPath)) {
			try {
				const head = readFileSync(diaryPath, "utf8").slice(0, 2000);
				const m = head.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
				if (m) {
					const ageMs = Date.now() - new Date(m[1]).getTime();
					if (ageMs < config.minIntervalMs) {
						cooldownOk = false;
						if (config.debug) log(`cooldown: last entry ${m[1]} is ${Math.round(ageMs / 60000)}min old`);
					}
				}
			} catch (e) {
				log(`diary read failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (!cooldownOk && reason !== "manual") {
			if (config.debug) log("cooldown active, re-arming");
			armTimer(ctx);
			return;
		}
		if (!config.enabled) {
			log("pass skipped — enabled=false in agent-dream.json");
			ctx.ui.notify("[dream] disabled in config — pass skipped", "info");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "💤 dreaming");
		ctx.ui.notify(`[dream] consolidation pass (${reason}) — diary → ${config.diaryPath}`, "info");
		log(`pass started (reason=${reason})`);
		state.lastPassAt = new Date().toISOString();
		state.lastReason = reason;
		state.lastSessions = null;
		state.lastMemories = null;
		state.lastDiaryEntry = null;
		state.totalPasses += 1;
		saveState();
		pi.sendMessage({ customType: "dream-pass", content: buildDreamPrompt(config, expandHome(config.reportPath)), display: true }, { triggerTurn: true, deliverAs: "nextTurn" });
		ctx.ui.setStatus(STATUS_KEY, "");
		touch();
		armTimer(ctx);
	}

	function dreamScriptsDir(): string {
		// dream-index / dream-diary live next to this extension file.
		try {
			const here = new URL(import.meta.url).pathname;
			return here.slice(0, here.lastIndexOf("/"));
		} catch {
			return join(homedir(), "repos", "github.com", "ankitg12", "omp-extensions", "packages", "agent-dream-omp");
		}
	}

	function buildDreamPrompt(cfg: DreamConfig, reportPath: string): string {
		const dir = dreamScriptsDir();
		const memTarget = cfg.memoryFile && cfg.memoryFile.length > 0
			? `Append to the per-project memory file \`${cfg.memoryFile}\` (create parent dirs if missing).`
			: `No memory file configured: write durable lessons ONLY to the diary entry (section "## durable"). Do not invent a memory path.`;
		return `Run the dream memory-consolidation pass NOW. This is your current task — do not acknowledge and wait, execute it immediately with file tools. Budget: ~15 tool calls; report partial rather than grinding.

Diary target: \`${cfg.diaryPath}\`. Memory target: ${memTarget}

## Procedure
1. Index: run \`${dir}/dream-index --max ${cfg.maxSessions}\`. Take sessions newer than the newest \`## <ISO>\` heading in the diary (if no diary yet, take the newest ${cfg.maxSessions}). Skip the live session's own file. STOP after this step if no session is newer than the diary — write a skipped report.
2. Extract: read each session's tail (last ~200 lines). Note durable signal ONLY — explicit user preferences, stable account/project facts, tool quirks confirmed by outcome, user corrections of your behavior, constraints the user stated. Each needs a source. NEVER extract: security exceptions, access grants, auth bypasses, credentials, one-time secrets, transient states, uncertain facts, anything expiring under 7 days. When in doubt, discard. STOP scanning after ${cfg.maxSessions} sessions or earlier if two consecutive sessions yield zero new signal.
3. Consolidate: one short entry per lesson (what + when + session id), at most ${cfg.maxMemoriesPerPass}, highest-signal first. Dedupe — update in place, never double.
4. Diary: write the entry body (≤ ${cfg.maxDiaryEntryLines} lines: sessions scanned, new memories one line each, or skipped reason) to a temp file, then run \`${dir}/dream-diary --diary "${cfg.diaryPath}" --max ${cfg.maxDiaryEntries} --entry-file <tmp>\`. It prints the entry timestamp.
5. Report: write JSON \`{"sessions": <n>, "memories": <k>, "diaryEntry": "<ISO or null>", "at": "<now ISO>"}\` to \`${reportPath}\`, then reply with exactly one line: sessions scanned, memories added, diary entry timestamp.`;
	}

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(log);
		logFile = expandHome(config.logPath);
		state = loadDreamState(log);
		const report = readDreamReport(expandHome(config.reportPath), log);
		if (report !== null) {
			const before = state.lastSessions;
			state = applyDreamReport(state, report);
			if (state.lastSessions !== before) {
				saveState();
				log(`report folded: ${report.sessions} sessions, ${report.memories} memories, diary ${report.diaryEntry ?? "none"}`);
			}
		}
		try {
			unsubscribeInput = ctx.ui.onTerminalInput(() => {
				touch();
				armTimer(ctx);
				return undefined;
			});
		} catch {
			// no terminal UI (headless/RPC) — turn events alone drive the clock
		}
		armTimer(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			unsubscribeInput?.();
		} catch {
			// ignore
		}
		clear(ctx);
	});

	// Any completed turn means activity: reset the idle clock.
	pi.on("turn_end", (_event, ctx) => {
		touch();
		armTimer(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		touch();
		armTimer(ctx);
	});

	// AFK engage counts as idle-start; disengage (user back) re-arms.
	try {
		pi.on("afk:changed" as never, (event: unknown, ctx: ExtensionContext) => {
			const active = event !== null && typeof event === "object" && "active" in event ? event.active : undefined;
			if (active === true) {
				touch();
				if (config.debug) log("afk engaged — idle clock started");
			} else if (active === false) {
				touch();
				armTimer(ctx);
				if (config.debug) log("afk disengaged — timer re-armed");
			}
		});
	} catch {
		// bus channel unavailable — idle timer works standalone
	}

	pi.registerCommand("dream", {
		description: "Memory consolidation — /dream now|status|diary",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "status" || sub === "") {
				const idleFor = Math.round((Date.now() - lastActivityAt) / 1000);
				ctx.ui.notify(
					`[dream] idle for ${idleFor}s (threshold ${Math.round(config.idleMs / 1000)}s), cooldown ${Math.round(config.minIntervalMs / 3600000)}h, diary ${config.diaryPath}, ${config.enabled ? "enabled" : "disabled"}`,
					"info",
				);
				if (sub === "") await runPass(ctx, "manual");
				return;
			}
			if (sub === "now") {
				await runPass(ctx, "manual");
				return;
			}
			if (sub === "diary") {
				ctx.ui.notify(`[dream] diary → ${config.diaryPath}`, "info");
				return;
			}
			ctx.ui.notify("[dream] usage: /dream [now|status|diary]", "info");
		},
	});
}
