// agent-afk — AFK toggle for Oh My Pi (OMP)
//
// Engages/disengages autonomous mode via command OR automatic session-local
// inactivity detection.
//
// /afk        — enter AFK mode: inject AFK prompt to agent, show status indicator
// /back       — return from AFK: notify agent, clear status indicator
// /afk-status — show current engagement state (manual or auto)
//
// Auto-detection: tracks the last raw terminal keystroke in THIS session via
// ctx.ui.onTerminalInput — no desktop-wide signal (ActivityWatch, window focus)
// is used, so switching to a different OMP session/window does not affect this
// session's state either way: it only reacts to input typed into ITS OWN
// terminal, AND only while the agent itself is idle (a multi-turn agent run in
// progress does not count toward the debounce -- the user may be watching the
// screen with hands off the keyboard). After no input for debounceMs (default
// 2min) while the agent is idle, auto-engages via the SAME path as /afk; the
// next keystroke in this session auto-disengages via the SAME path as /back.
// Purely additive — /afk and /back keep working exactly as before, and manual
// engagement is never auto-disengaged by anything other than actual typing in
// this session (auto-disengage only fires if auto-engage was what armed it).
// Config: ~/.omp/agent/agent-afk.json (see afk-state.ts for schema/defaults).
//
// AFK notes are saved per-session at ~/Notes/afk-notes/<session-id>.md
// so they accumulate across AFK invocations and are never clobbered.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig } from "./afk-state";

function getNoteTarget(sessionId: string): { relativePath: string; fullPath: string; dirPath: string } {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	const ym = `${yyyy}-${mm}`;
	const filename = `${yyyy}-${mm}-${dd}_${sessionId}.md`;
	const dirPath = join(homedir(), "Notes", "afk-notes", ym);
	const fullPath = join(dirPath, filename);
	const relativePath = `~/Notes/afk-notes/${ym}/${filename}`;
	return { relativePath, fullPath, dirPath };
}

function buildAfkPrompt(noteFile: string): string {
	return `\
The user is AFK. Switch to autonomous mode with these constraints:

**AUTONOMOUS MODE RULES:**
- Blast radius: LOW only — edits, reads, local commits are fine. No \`git push\`, no external API calls that create/delete resources, no messages to other humans.
- Work from the current todo list (\`~/Notes/todo.md\` + session context) — pick the next actionable P1/P2 item that doesn't require user input.
- If stuck or needing a decision: append a note to \`${noteFile}\` under a \`## Stuck\` heading and stop. Do NOT loop trying variants.
- When done or stopping: append a brief summary to \`${noteFile}\` under a \`## Done <timestamp>\` heading — what was completed, what's next.

**BEFORE STARTING:**
1. Run \`python3 ~/tools/logseq-goals.py read\` — know today's goals in priority order (Logseq journal)
2. Read \`~/Notes/todo.md\` — pick the highest-priority actionable item
3. State out loud: "AFK mode: working on [X]. Will stop if [condition]."

**WHAT TO WORK ON (priority order):**
1. Any in-progress task from the current session
2. Next P1 item in todo.md that requires no user input
3. Notes cleanup / housekeeping (safe, reversible, always useful)

**WHAT NOT TO DO:**
- Ask clarifying questions (user is away)
- Push to remote git
- Open PRs or send messages
- Make irreversible changes without a git commit safety net
- Keep running if stuck — stop and log it

Proceed now. No need to ask for permission — that's the point.`;
}

const BACK_PROMPT = `User is back. Exit AFK autonomous mode. Stop current work at the next clean checkpoint. Wait for the user's next explicit instruction.`;

const STATUS_KEY = "afk";

export default function agentAfk(pi: ExtensionAPI) {
	pi.setLabel("Agent AFK");

	const LOG_FILE = join(homedir(), ".omp", "agent", "agent-afk.log");
	function log(msg: string): void {
		try {
			appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
		} catch {
			// best-effort logging only
		}
	}
	const config = loadConfig(log);
	const debug = config.debug ? log : (_msg: string) => { };

	let afkActive = false;
	// Tracks whether the CURRENT engagement was auto-triggered, so auto-detection
	// never silently disengages a manual /afk session it didn't start, and a manual
	// /back always fully resets auto-detection's debounce window too.
	let autoEngaged = false;
	let lastInputAt = Date.now();
	// Multi-turn agent work (tool calls, streaming) does not count as AFK time even
	// with zero keystrokes -- the user may be watching the screen. The debounce
	// clock only accumulates once the agent is idle and actually waiting on input.
	let agentBusy = false;
	let checkTimer: NodeJS.Timeout | undefined;
	let unsubscribeInput: (() => void) | undefined;

	function engage(ctx: ExtensionContext, viaAuto: boolean): void {
		if (afkActive) return;
		afkActive = true;
		autoEngaged = viaAuto;
		const sessionId = (ctx.sessionManager?.getLeafId?.() ?? "unknown-session").slice(0, 8);
		const { relativePath, dirPath } = getNoteTarget(sessionId);
		try {
			mkdirSync(dirPath, { recursive: true });
		} catch {
			// best-effort directory creation
		}
		ctx.ui.setStatus(STATUS_KEY, viaAuto ? "AFK 🔴 auto" : "AFK 🔴");
		ctx.ui.notify(`[afk] engaged${viaAuto ? " (auto)" : ""} — notes → ${relativePath}`, "info");
		pi.sendUserMessage(buildAfkPrompt(relativePath), { deliverAs: "followUp" });
	}

	function disengage(ctx: ExtensionContext): void {
		// Always send — afkActive is in-memory and resets on session restart,
		// so /back in a resumed session would silently fail with a guard.
		afkActive = false;
		autoEngaged = false;
		ctx.ui.setStatus(STATUS_KEY, "");
		ctx.ui.notify("[afk] disengaged — welcome back", "info");
		pi.sendUserMessage(BACK_PROMPT, { deliverAs: "followUp" });
	}

	function checkInactivity(ctx: ExtensionContext): void {
		if (agentBusy) return; // agent mid-turn — user may be watching, don't count this as idle time
		const elapsed = Date.now() - lastInputAt;
		if (!afkActive && elapsed >= config.debounceMs) {
			debug(`checkInactivity: auto-engaging after ${Math.round(elapsed / 1000)}s idle with no input, agent not busy`);
			engage(ctx, true);
		}
	}

	function armSession(ctx: ExtensionContext): void {
		lastInputAt = Date.now();
		agentBusy = false;
		unsubscribeInput?.();
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			lastInputAt = Date.now();
			if (afkActive && autoEngaged) {
				debug("onTerminalInput: auto-disengaging (input resumed in this session)");
				disengage(ctx);
			}
			return undefined; // observe only, never consume/replace input
		});
		clearInterval(checkTimer);
		checkTimer = setInterval(() => checkInactivity(ctx), config.checkIntervalMs);
		debug(`session armed (check every ${config.checkIntervalMs}ms, debounce ${config.debounceMs}ms)`);
	}

	pi.on("session_start", (_event, ctx) => armSession(ctx));
	pi.on("session_switch", (_event, ctx) => armSession(ctx));
	pi.on("session_shutdown", () => {
		clearInterval(checkTimer);
		unsubscribeInput?.();
	});
	pi.on("agent_start", () => {
		agentBusy = true;
	});
	pi.on("agent_end", () => {
		agentBusy = false;
		// Agent just handed control back — the "waiting on you" clock starts now,
		// not from whenever the last keystroke happened to be (which may have been
		// long before a lengthy multi-turn run started).
		lastInputAt = Date.now();
	});

	pi.registerCommand("afk", {
		description: "Enter AFK autonomous mode — agent works unattended until /back",
		handler: async (_args, ctx) => {
			if (afkActive) {
				ctx.ui.notify("[afk] already active — use /back to return", "info");
				return;
			}
			engage(ctx, false);
		},
	});

	pi.registerCommand("back", {
		description: "Return from AFK — disengage autonomous mode",
		handler: async (_args, ctx) => disengage(ctx),
	});

	pi.registerCommand("afk-status", {
		description: "Show AFK engagement state",
		handler: async (_args, ctx) => {
			const state = afkActive ? `engaged${autoEngaged ? " (auto)" : " (manual)"}` : "disengaged";
			const idleFor = `, idle for ${Math.round((Date.now() - lastInputAt) / 1000)}s`;
			ctx.ui.notify(`[afk] ${state}${idleFor}`, "info");
		},
	});
}
