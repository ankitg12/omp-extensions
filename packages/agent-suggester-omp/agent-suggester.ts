// agent-suggester — periodic reorientation nudges for Oh My Pi (OMP)
//
// Injects a single high-signal question/quote at configurable intervals
// to break cognitive loops and shift perspective. No retrospection, no
// activity summary — just a nudge that invites a 30-second pause.
//
// Config: ~/.omp/agent/agent-suggester.json
// {
//   "intervalMs": 600000,
//   "clockAlign": false,
//   "picker": "random",
//   "skipIfIdle": true,
//   "wrapWith": "🔄 **Suggestion** ...\n\n{item}\n\n*...*",
//   "items": [
//     "Are you solving the right problem, or optimizing the wrong one?",
//     "~/path/to/custom-mantra.md"
//   ],
//   "debug": false
// }
//
// Commands:
//   /suggester-pause  — pause for this session
//   /suggester-resume — resume after pause
//   /suggester-now    — fire immediately (followUp delivery)

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SuggesterConfig {
	/** ms between nudges. Default: 600000 (10min). */
	intervalMs: number;
	/**
	 * false (default): session-relative — fires intervalMs after session start,
	 *   then every intervalMs from last fire.
	 * true: wall-clock alignment like agent-retro — fires at :00, :10, :20, etc.
	 */
	clockAlign: boolean;
	/** "random" (default) | "rotate" — sequential round-robin, resets per session */
	picker: "random" | "rotate";
	/** Skip fire when no tool calls in segment. Default: true. */
	skipIfIdle: boolean;
	/** Template; {item} is replaced with the selected nudge. */
	wrapWith: string;
	/** Inline strings or ~/path (YAML frontmatter stripped). */
	items: string[];
	debug: boolean;
}

const DEFAULT_WRAP =
	"🔄 **Suggestion** — a 30-second pause invited\n\n{item}\n\n" +
	"*If this shifts something, say so and we'll adjust. Otherwise continue — no analysis needed.*";

const CONFIG_PATH = join(homedir(), ".omp", "agent", "agent-suggester.json");

function loadConfig(log: (msg: string) => void): SuggesterConfig | null {
	if (!existsSync(CONFIG_PATH)) {
		log("config: no agent-suggester.json found — extension idle");
		return null;
	}
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

		if (!Array.isArray(raw.items) || raw.items.length === 0) {
			log("config: 'items' must be a non-empty array — extension idle");
			return null;
		}
		if (raw.items.some((x: unknown) => typeof x !== "string" || !x)) {
			log("config: 'items' contains invalid entries — extension idle");
			return null;
		}

		const intervalMs = typeof raw.intervalMs === "number" && raw.intervalMs > 0
			? raw.intervalMs
			: 600_000;
		const clockAlign = raw.clockAlign === true;
		const picker: "random" | "rotate" = raw.picker === "rotate" ? "rotate" : "random";
		const skipIfIdle = raw.skipIfIdle !== false; // default true
		const wrapWith = typeof raw.wrapWith === "string" && raw.wrapWith
			? raw.wrapWith
			: DEFAULT_WRAP;
		const debug = raw.debug === true;

		return { intervalMs, clockAlign, picker, skipIfIdle, wrapWith, items: raw.items as string[], debug };
	} catch (e: any) {
		log(`config: parse error — ${e.message}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Scheduling helpers
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 86_400_000;

function nextBoundary(intervalMs: number): number {
	if (intervalMs >= ONE_DAY_MS) {
		// Local midnight so daily intervals align to user's timezone.
		const d = new Date();
		d.setDate(d.getDate() + 1);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	// Align to local clock boundaries, not UTC epoch multiples.
	// e.g. IST (UTC+5:30): UTC epoch multiples of 1hr fall at :30 IST, not :00.
	const tzOffsetMs = -new Date().getTimezoneOffset() * 60_000;
	const localNow = Date.now() + tzOffsetMs;
	return Math.ceil(localNow / intervalMs) * intervalMs - tzOffsetMs;
}

function resolveItem(raw: string): string {
	if (!raw.startsWith("~/")) return raw;
	const resolved = raw.replace(/^~/, homedir());
	if (existsSync(resolved)) {
		return readFileSync(resolved, "utf8")
			.replace(/^---[\s\S]*?---\n*/, "") // strip YAML frontmatter
			.trim();
	}
	return raw; // file not found — return as-is so caller sees the bad path
}

function fmtTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function agentSuggester(pi: ExtensionAPI) {
	pi.setLabel("Agent Suggester");

	const LOG_FILE = join(homedir(), ".omp", "agent", "agent-suggester.log");
	function log(msg: string): void {
		const ts = new Date().toISOString();
		try { appendFileSync(LOG_FILE, `${ts} ${msg}\n`); } catch { }
	}

	const config = loadConfig(log);
	const dbg = config?.debug ? log : (_msg: string) => { };

	if (!config) {
		// loadConfig already logged the reason
		return;
	}

	dbg(
		`loaded: ${config.items.length} items, intervalMs=${config.intervalMs}, ` +
		`clockAlign=${config.clockAlign}, picker=${config.picker}, skipIfIdle=${config.skipIfIdle}`
	);

	// ── State ─────────────────────────────────────────────────────────────────
	let paused = false;
	let toolCallCount = 0;       // tool calls since last fire (for skipIfIdle gate)
	let rotationIndex = 0;       // for "rotate" picker; resets each session
	let timer: ReturnType<typeof setTimeout> | null = null;
	let nudgeJustFired = false;   // set in fire(); consumed in before_agent_start
	let savedDraft = "";      // editor text stashed across the nudge turn
	let cachedUI: any = null;    // UI ref so fire() can capture draft before sendUserMessage clears it

	// ── Scheduling ─────────────────────────────────────────────────────────────

	function scheduleNext(): void {
		if (timer) clearTimeout(timer);
		let delay: number;
		if (config.clockAlign) {
			const boundary = nextBoundary(config.intervalMs);
			delay = Math.max(0, boundary - Date.now());
			dbg(`scheduleNext: clockAlign → next at ${fmtTime(boundary)} (in ${Math.round(delay / 60_000)}min)`);
		} else {
			delay = config.intervalMs;
			dbg(`scheduleNext: session-relative → in ${Math.round(delay / 60_000)}min`);
		}
		timer = setTimeout(fire, delay);
	}

	function fire(): void {
		if (paused) {
			dbg("fire: skipped (paused)");
			scheduleNext();
			return;
		}
		if (config.skipIfIdle && toolCallCount === 0) {
			dbg("fire: skipped (no tool calls since last fire — idle segment)");
			scheduleNext();
			return;
		}

		const callsInSegment = toolCallCount;
		toolCallCount = 0; // reset counter for next segment

		try {
			let raw: string;
			if (config.picker === "rotate") {
				const idx = rotationIndex % config.items.length;
				raw = config.items[idx];
				dbg(`fire: rotate → [${idx}] ${raw.slice(0, 80)}`);
				rotationIndex++;
			} else {
				const idx = Math.floor(Math.random() * config.items.length);
				raw = config.items[idx];
				dbg(`fire: random → [${idx}] ${raw.slice(0, 80)}`);
			}

			const item = resolveItem(raw);
			const message = config.wrapWith.replace("{item}", item);

			nudgeJustFired = true;
			if (cachedUI) { savedDraft = cachedUI.getEditorText(); dbg(`editor draft pre-saved (${savedDraft.length} chars)`); }
			pi.sendUserMessage(message, { deliverAs: "steer" });
			log(`fired: ${callsInSegment} tool calls in segment | item[0:80]: ${raw.slice(0, 80)}`);
		} catch (e: any) {
			nudgeJustFired = false;
			log(`fire error: ${e.message}`);
		}

		scheduleNext();
	}

	// ── Hooks ──────────────────────────────────────────────────────────────────

	// Count tool calls per segment for the skipIfIdle gate.
	pi.on("tool_call", () => {
		toolCallCount++;
	});

	// Cache UI ref so fire() can read the draft before sendUserMessage clears the editor.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) cachedUI = ctx.ui;
		if (!nudgeJustFired) return;
		nudgeJustFired = false;
		// Draft already captured in fire() before sendUserMessage.
	});

	// Restore the editor buffer once the nudge turn finishes.
	pi.on("agent_end", (_event, ctx) => {
		if (!savedDraft || !ctx.hasUI) return;
		ctx.ui.setEditorText(savedDraft);
		dbg(`editor draft restored (${savedDraft.length} chars)`);
		savedDraft = "";
	});

	// Sleep wakeup detector: setInterval freezes during sleep but Date.now() jumps.
	// If the real-time delta between ticks exceeds 2× the poll interval,
	// we woke from sleep and must reschedule the stale timer.
	const SLEEP_POLL_MS = 10_000;
	let lastTick = Date.now();
	const sleepWatcher = setInterval(() => {
		const now = Date.now();
		if (now - lastTick > SLEEP_POLL_MS * 2) {
			dbg(`wakeup detected (${Math.round((now - lastTick) / 1000)}s gap) — rescheduling`);
			scheduleNext();
		}
		lastTick = now;
	}, SLEEP_POLL_MS);

	pi.on("session_start", () => {
		toolCallCount = 0;
		rotationIndex = 0;
		log("session_start — armed timer");
		scheduleNext();
	});

	pi.on("session_shutdown", () => {
		dbg("session_shutdown — clearing timer");
		clearInterval(sleepWatcher);
		if (timer) clearTimeout(timer);
		timer = null;
	});

	// ── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("suggester-pause", {
		description: "Pause all suggestions for this session",
		handler: (_args, ctx) => {
			paused = true;
			ctx.ui.notify("Suggestions paused for this session", "info");
			log("paused by user");
		},
	});

	pi.registerCommand("suggester-resume", {
		description: "Resume suggestions after /suggester-pause",
		handler: (_args, ctx) => {
			paused = false;
			ctx.ui.notify("Suggestions resumed", "info");
			log("resumed by user");
		},
	});

	pi.registerCommand("suggester-now", {
		description: "Fire a suggestion immediately (bypasses timer and idle check)",
		handler: (_args, _ctx) => {
			let raw: string;
			if (config.picker === "rotate") {
				const idx = rotationIndex % config.items.length;
				raw = config.items[idx];
				dbg(`suggester-now: rotate → [${idx}]`);
				rotationIndex++;
			} else {
				const idx = Math.floor(Math.random() * config.items.length);
				raw = config.items[idx];
				dbg(`suggester-now: random → [${idx}]`);
			}
			const item = resolveItem(raw);
			const message = config.wrapWith.replace("{item}", item);
			// "followUp" fires right after this command turn ends — no wait for next input.
			pi.sendUserMessage(message, { deliverAs: "steer" });
			log(`suggester-now fired: ${raw.slice(0, 80)}`);
		},
	});
}
