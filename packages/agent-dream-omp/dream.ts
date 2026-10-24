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
	expandHome,
	humanSince,
	loadConfig,
	loadDreamState,
	STATE_PATH,
	type DreamConfig,
	type DreamState,
} from "./dream-state.ts";

export const AFK_CHANNEL = "afk:changed";
const STATUS_KEY = "dream";
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
	let idleTimer: NodeJS.Timeout | undefined;
	let unsubscribeInput: (() => void) | undefined;

	function saveState(): void {
		try {
			writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
		} catch (e) {
			log(`state write failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// Raw timers, same as agent-afk/session-reminder: re-armed on every turn,
	// cleared on session_shutdown. Docs describe ctx.setTimeout/clearTimer but
	// the installed SDK (16.1.16) types ExtensionContext without them.
	function armTimer(ctx: ExtensionContext): void {
		clear();
		try {
			idleTimer = setTimeout(() => {
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

	function clear(): void {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
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
		log(`pass #${state.totalPasses} injected (reason=${reason}) — state → ${STATE_PATH}`);
		pi.sendUserMessage(buildDreamPrompt(config.diaryPath), { deliverAs: "followUp" });
		ctx.ui.setStatus(STATUS_KEY, "");
		touch();
		armTimer(ctx);
	}

	function buildDreamPrompt(diaryPath: string): string {
		return `Run the dream skill pass now. Read the procedure at skill://dream/SKILL.md (bundled with the agent-dream extension) and follow it. Diary target: \`${diaryPath}\`. When done, reply with one line: sessions scanned, memories added, diary entry timestamp.`;
	}

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(log);
		logFile = expandHome(config.logPath);
		state = loadDreamState(log);
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

	pi.on("session_shutdown", () => {
		try {
			unsubscribeInput?.();
		} catch {
			// ignore
		}
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
